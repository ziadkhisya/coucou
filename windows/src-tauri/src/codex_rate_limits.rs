//! Read account usage from the authenticated local Codex app-server.
//! Failures are intentionally quiet and never affect Codex hook execution.

use std::{collections::HashMap, process::Stdio, time::{Duration, SystemTime, UNIX_EPOCH}};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{io::{AsyncBufReadExt, AsyncWriteExt, BufReader}, process::Command, sync::watch, time::{Instant, sleep_until}};

use crate::log;

const ACTIVE_POLL: Duration = Duration::from_secs(25);
const QUIET_POLL: Duration = Duration::from_secs(180);
const RELIABLE_NOTIFICATION_AGE: Duration = Duration::from_secs(60);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UsageDemand {
    pub expanded: bool,
    pub active: bool,
    refresh_sequence: u64,
}

#[derive(Clone)]
pub struct UsageController {
    sender: watch::Sender<UsageDemand>,
}

impl Default for UsageController {
    fn default() -> Self {
        let (sender, _) = watch::channel(UsageDemand::default());
        Self { sender }
    }
}

impl UsageController {
    pub fn set_demand(&self, expanded: bool, active: bool) {
        self.sender.send_modify(|demand| {
            demand.expanded = expanded;
            demand.active = active;
        });
    }

    pub fn refresh(&self) {
        self.sender.send_modify(|demand| demand.refresh_sequence = demand.refresh_sequence.wrapping_add(1));
    }

    fn subscribe(&self) -> watch::Receiver<UsageDemand> { self.sender.subscribe() }
}

pub fn start(app: AppHandle) {
    let controller = app.state::<UsageController>().inner().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = run_session(&app, controller.subscribe()).await {
                log::line(format!("Codex usage unavailable: {error}"));
                let _ = app.emit("codex-rate-limits", json!({"kind":"unavailable","receivedAt":now_ms()}));
            }
            tokio::time::sleep(Duration::from_secs(20)).await;
        }
    });
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

async fn send(input: &mut tokio::process::ChildStdin, value: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    input.write_all(&bytes).await.map_err(|e| e.to_string())?;
    input.flush().await.map_err(|e| e.to_string())
}

async fn next_json(lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>) -> Result<Value, String> {
    loop {
        let line = lines.next_line().await.map_err(|e| e.to_string())?
            .ok_or_else(|| "Codex app-server closed its output".to_string())?;
        if let Ok(value) = serde_json::from_str::<Value>(&line) { return Ok(value); }
    }
}

async fn run_session(app: &AppHandle, mut demand: watch::Receiver<UsageDemand>) -> Result<(), String> {
    let executable = crate::codex::executable().ok_or_else(|| "Codex CLI executable not found".to_string())?;
    let mut child = Command::new(executable)
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW).kill_on_drop(true)
        .env_remove("CODEX_API_KEY").env_remove("OPENAI_API_KEY").spawn()
        .map_err(|e| format!("could not start Codex app-server: {e}"))?;
    let mut input = child.stdin.take().ok_or("missing app-server input")?;
    let stdout = child.stdout.take().ok_or("missing app-server output")?;
    let mut lines = BufReader::new(stdout).lines();
    send(&mut input, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "clientInfo":{"name":"coucou","title":"Coucou usage indicator","version":env!("CARGO_PKG_VERSION")},
        "capabilities":{"experimentalApi":true}
    }})).await?;
    loop {
        let message = next_json(&mut lines).await?;
        if message.get("id") == Some(&json!(1)) {
            if message.get("error").is_some() { return Err("Codex app-server rejected initialization".into()); }
            break;
        }
    }
    send(&mut input, json!({"jsonrpc":"2.0","method":"notifications/initialized","params":{}})).await?;

    let mut requests: HashMap<u64, u64> = HashMap::new();
    let mut request_id = 2_u64;
    let current_demand = *demand.borrow();
    let mut next_poll = Instant::now() + poll_interval(current_demand, None);
    let mut last_notification: Option<Instant> = None;
    let mut last_refresh_sequence = demand.borrow().refresh_sequence;
    let mut last_logged = (None, None);

    // Take the initial snapshot before waiting on the demand channel. The UI
    // reports its initial hidden/idle state as soon as it boots; handling that
    // message first must not accidentally defer the required startup read.
    let request_started_at = now_ms();
    send(&mut input, rate_limit_request(request_id)).await?;
    requests.insert(request_id, request_started_at);

    loop {
        let timer = sleep_until(next_poll);
        tokio::pin!(timer);
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line.map_err(|e| e.to_string())? else { return Err("Codex app-server disconnected".into()) };
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                let received_at = now_ms();
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(request_started_at) = requests.remove(&id) {
                        if message.get("error").is_some() {
                            log_rate_limit_error(id, request_started_at, received_at, message.get("error"));
                            continue;
                        }
                        if let Some(result) = message.get("result") {
                            let emitted_at = find_emitted_at(result);
                            log_usage_if_changed("snapshot", result, Some(id), Some(request_started_at), received_at, emitted_at.as_ref(), &mut last_logged);
                            let _ = app.emit("codex-rate-limits", json!({
                                "kind":"snapshot", "payload":result, "requestId":id,
                                "requestStartedAt":request_started_at, "receivedAt":received_at,
                                "emittedAt":emitted_at
                            }));
                        }
                    }
                } else if message.get("method").and_then(Value::as_str) == Some("account/rateLimits/updated") {
                    last_notification = Some(Instant::now());
                    let params = message.get("params").cloned().unwrap_or(Value::Null);
                    let emitted_at = find_emitted_at(&params);
                    log::line(format!("Codex rate-limit rolling update received; receivedAt={received_at}; emittedAt={}", emitted_at.as_ref().map_or_else(|| "unavailable".into(), Value::to_string)));
                    log_usage_if_changed("notification", &params, None, None, received_at, emitted_at.as_ref(), &mut last_logged);
                    let _ = app.emit("codex-rate-limits", json!({
                        "kind":"updated", "payload":params, "receivedAt":received_at,
                        "emittedAt":emitted_at
                    }));
                }
            }
            changed = demand.changed() => {
                if changed.is_err() { return Err("Coucou usage controller closed".into()); }
                let current = *demand.borrow_and_update();
                let refresh_requested = current.refresh_sequence != last_refresh_sequence;
                last_refresh_sequence = current.refresh_sequence;
                if refresh_requested {
                    request_id = request_id.wrapping_add(1);
                    let started_at = now_ms();
                    send(&mut input, rate_limit_request(request_id)).await?;
                    requests.insert(request_id, started_at);
                    next_poll = Instant::now() + poll_interval(current, last_notification);
                }
            }
            _ = &mut timer => {
                let current = *demand.borrow();
                request_id = request_id.wrapping_add(1);
                let started_at = now_ms();
                send(&mut input, rate_limit_request(request_id)).await?;
                requests.insert(request_id, started_at);
                // Bound memory if Codex leaves an old read unanswered.
                if requests.len() > 8 {
                    if let Some(oldest) = requests.keys().copied().min() { requests.remove(&oldest); }
                }
                next_poll = Instant::now() + poll_interval(current, last_notification);
            }
        }
    }
}

fn rate_limit_request(id: u64) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"account/rateLimits/read","params":{
        "supportsLunaReserve":false,"excludeResetCreditDetails":true
    }})
}

fn log_rate_limit_error(request_id: u64, request_started_at: u64, received_at: u64, error: Option<&Value>) {
    let code = error.and_then(|value| value.get("code")).and_then(Value::as_i64);
    let message = error.and_then(|value| value.get("message")).and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let category = rate_limit_error_category(&message);
    log::line(format!("Codex rate-limit snapshot request failed: requestId={request_id}, code={}, category={category}, requestStartedAt={request_started_at}, receivedAt={received_at}", code.map_or_else(|| "unavailable".into(), |value| value.to_string())));
}

fn rate_limit_error_category(message: &str) -> &'static str {
    if ["unauthorized", "authentication", "not authenticated", "sign in"].iter().any(|needle| message.contains(needle)) {
        "authentication"
    } else if ["rate limit", "quota"].iter().any(|needle| message.contains(needle)) {
        "rate_limit"
    } else if ["method not found", "unsupported", "not implemented"].iter().any(|needle| message.contains(needle)) {
        "unsupported"
    } else if ["timeout", "timed out"].iter().any(|needle| message.contains(needle)) {
        "timeout"
    } else if ["network", "connection", "socket"].iter().any(|needle| message.contains(needle)) {
        "connection"
    } else {
        "other"
    }
}

fn poll_interval(demand: UsageDemand, last_notification: Option<Instant>) -> Duration {
    if demand.active {
        if last_notification.is_some_and(|at| at.elapsed() <= RELIABLE_NOTIFICATION_AGE) {
            Duration::from_secs(90)
        } else {
            ACTIVE_POLL
        }
    } else {
        QUIET_POLL
    }
}

fn find_emitted_at(value: &Value) -> Option<Value> {
    let row = value.as_object()?;
    ["emittedAt", "updatedAt", "timestamp"].iter()
        .find_map(|key| row.get(*key).cloned())
}

fn window_by_duration<'a>(bucket: &'a Value, duration: u64) -> Option<&'a Value> {
    let row = bucket.as_object()?;
    let windows = row.get("windows").and_then(Value::as_array);
    if let Some(found) = windows.and_then(|list| list.iter().find(|window|
        window.get("windowDurationMins").and_then(Value::as_u64) == Some(duration))) { return Some(found); }
    ["primary", "secondary", "fiveHour", "weekly"].iter().find_map(|key| {
        row.get(*key).filter(|window| window.get("windowDurationMins").and_then(Value::as_u64) == Some(duration))
    })
}

fn usage_summary(value: &Value) -> (Option<u64>, Option<u64>) {
    let root = value.get("result").unwrap_or(value);
    let limits = root.get("rateLimitsByLimitId").and_then(|limits| limits.get("codex"))
        .or_else(|| root.get("rateLimits"));
    let used = |duration| window_by_duration(limits?, duration)?.get("usedPercent")?.as_u64();
    (used(300), used(10_080))
}

fn log_usage_if_changed(source: &str, value: &Value, request_id: Option<u64>, request_started_at: Option<u64>, received_at: u64, emitted_at: Option<&Value>, last: &mut (Option<u64>, Option<u64>)) {
    let (five, week) = usage_summary(value);
    let changed = (five, week) != *last;
    *last = (five, week);
    let root = value.get("result").unwrap_or(value);
    let limits = root.get("rateLimitsByLimitId").and_then(|limits| limits.get("codex"))
        .or_else(|| root.get("rateLimits"));
    let duration = |minutes, fallback| limits
        .and_then(|bucket| window_by_duration(bucket, minutes))
        .and_then(|window| window.get("windowDurationMins"))
        .and_then(Value::as_u64)
        .unwrap_or(fallback);
    let five_duration = duration(300, 300);
    let week_duration = duration(10_080, 10_080);
    // Every full read is logged with request provenance, even when its values are
    // unchanged. The sanitized fields let us distinguish stale/in-flight reads
    // from window mapping errors without persisting account identifiers/payloads.
    if changed || source == "snapshot" {
        log::line(format!("Codex usage {source}: 5h used={} duration={}m; week used={} duration={}m; requestId={}; requestStartedAt={}; receivedAt={received_at}; emittedAt={}",
        five.map_or_else(|| "—".into(), |n| format!("{n}%")), five_duration,
        week.map_or_else(|| "—".into(), |n| format!("{n}%")), week_duration,
        request_id.map_or_else(|| "notification".into(), |id| id.to_string()),
        request_started_at.map_or_else(|| "—".into(), |at| at.to_string()),
        emitted_at.map_or_else(|| "—".into(), Value::to_string)));
    }
}

#[cfg(test)]
mod tests {
    use super::rate_limit_error_category;

    #[test]
    fn classifies_rate_limit_read_errors_without_logging_raw_messages() {
        assert_eq!(rate_limit_error_category("account rate limit read was rejected"), "rate_limit");
        assert_eq!(rate_limit_error_category("method not found"), "unsupported");
        assert_eq!(rate_limit_error_category("not authenticated"), "authentication");
        assert_eq!(rate_limit_error_category("connection timed out"), "timeout");
        assert_eq!(rate_limit_error_category("unexpected failure"), "other");
    }
}
