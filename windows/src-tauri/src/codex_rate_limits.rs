//! Read account usage from the authenticated local Codex app-server.
//! Failures are intentionally quiet and never affect Codex hook execution.

use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::log;

const REFRESH: Duration = Duration::from_secs(90);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(error) = run_session(&app).await {
                log::line(format!("Codex usage unavailable: {error}"));
                let _ = app.emit("codex-rate-limits", json!({ "kind": "unavailable" }));
            }
            tokio::time::sleep(REFRESH).await;
        }
    });
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

async fn run_session(app: &AppHandle) -> Result<(), String> {
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
    let mut request_id = 2_u64;
    send(&mut input, json!({"jsonrpc":"2.0","id":request_id,"method":"account/rateLimits/read","params":{
        "supportsLunaReserve":false,"excludeResetCreditDetails":true
    }})).await?;
    let mut refresh = tokio::time::interval(REFRESH);
    refresh.tick().await;
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line.map_err(|e| e.to_string())? else { return Err("Codex app-server disconnected".into()) };
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                if message.get("id") == Some(&json!(request_id)) {
                    if message.get("error").is_some() { return Err("Codex rate-limit read was rejected".into()); }
                    if let Some(result) = message.get("result") {
                        let _ = app.emit("codex-rate-limits", json!({"kind":"snapshot","payload":result}));
                    }
                } else if message.get("method").and_then(Value::as_str) == Some("account/rateLimits/updated") {
                    let _ = app.emit("codex-rate-limits", json!({"kind":"updated","payload":message.get("params").cloned().unwrap_or(Value::Null)}));
                }
            }
            _ = refresh.tick() => {
                request_id += 1;
                send(&mut input, json!({"jsonrpc":"2.0","id":request_id,"method":"account/rateLimits/read","params":{
                    "supportsLunaReserve":false,"excludeResetCreditDetails":true
                }})).await?;
            }
        }
    }
}
