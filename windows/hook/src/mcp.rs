//! Small read-only MCP server that lets Codex publish semantic plan state.
//!
//! Coucou consumes the corresponding PreToolUse hook event. This tool itself
//! only acknowledges a validated plan and never depends on Coucou being open.

use serde_json::{json, Value};
use std::io::{BufRead, Write};

const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_STEPS: usize = 7;
const MAX_STEP_TEXT: usize = 240;

pub fn serve(mut input: impl BufRead, mut output: impl Write) {
    let mut line = Vec::new();
    loop {
        line.clear();
        match input.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) if line.len() > MAX_MESSAGE_BYTES => continue,
            Ok(_) => {}
        }

        let Ok(message) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").unwrap_or(&Value::Null);

        let result = match method {
            "initialize" => Some(json!({
                "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18"),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "coucou-progress", "title": "Coucou task progress", "version": env!("CARGO_PKG_VERSION") }
            })),
            "ping" => Some(json!({})),
            "tools/list" => Some(json!({ "tools": [update_plan_tool()] })),
            "tools/call" => Some(call_tool(params)),
            _ => None,
        };

        let response = match result {
            Some(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            None => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": "Method not found" }
            }),
        };
        if serde_json::to_writer(&mut output, &response).is_err() || output.write_all(b"\n").is_err() || output.flush().is_err() {
            break;
        }
    }
}

fn update_plan_tool() -> Value {
    json!({
        "name": "update_plan",
        "title": "Update Coucou task progress",
        "description": "Publish semantic progress to Coucou. At the start of meaningful work, set task_title to a concise 3-7 word description of the user's current objective and current_status to the present work phase. If the user gives a materially new objective later in the same session, publish the new task_title while keeping the project identity unchanged; do not rename for every implementation detail. Update current_status only when the work phase changes. For meaningful multi-step work, include 3-7 outcome-oriented steps, usually 3-7 words and under 60 characters, and update their statuses. For trivial work, send task_title/current_status without steps. Never use commands, tool names, paths, prompt text, or transient folder/session slugs as labels.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_title": { "type": "string", "minLength": 1, "maxLength": 96 },
                "current_status": { "type": "string", "minLength": 1, "maxLength": 120 },
                "steps": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_STEPS,
                    "items": {
                        "type": "object",
                        "properties": {
                            "text": { "type": "string", "minLength": 1, "maxLength": MAX_STEP_TEXT },
                            "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
                        },
                        "required": ["text", "status"],
                        "additionalProperties": false
                    }
                },
                "message": { "type": "string", "maxLength": MAX_STEP_TEXT }
            },
            "required": [],
            "additionalProperties": false
        },
        "annotations": {
            "title": "Update Coucou task progress",
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false
        }
    })
}

fn call_tool(params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    if name != "update_plan" {
        return json!({
            "content": [{ "type": "text", "text": "Unknown Coucou progress tool; continue the task without it." }],
            "isError": true
        });
    }

    let arguments = params.get("arguments").unwrap_or(&Value::Null);
    let valid_text = |key: &str, max: usize| arguments.get(key).is_some_and(|value| {
        value.as_str().is_some_and(|text| !text.trim().is_empty() && text.chars().count() <= max)
    });
    let steps = arguments.get("steps").and_then(Value::as_array);
    let valid_steps = steps.is_some_and(|steps| !steps.is_empty() && steps.len() <= MAX_STEPS && steps.iter().all(|step| {
            let text_ok = step.get("text").and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty() && text.chars().count() <= MAX_STEP_TEXT);
            let status_ok = matches!(step.get("status").and_then(Value::as_str),
                Some("pending" | "in_progress" | "inProgress" | "completed"));
            text_ok && status_ok
        }));
    let valid = valid_text("task_title", 96) || valid_text("current_status", 120) || valid_text("message", MAX_STEP_TEXT) || valid_steps;

    let text = if valid {
        "Semantic progress accepted; Coucou receives it through the Codex hook."
    } else {
        "Semantic progress was not published because its fields were empty or malformed; continue normally."
    };
    json!({ "content": [{ "type": "text", "text": text }] })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn announces_update_plan_tool_and_returns_mcp_response() {
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"update_plan\",\"arguments\":{\"steps\":[{\"text\":\"Review the task\",\"status\":\"in_progress\"}]}}}\n"
        );
        let mut output = Vec::new();
        serve(Cursor::new(input), &mut output);
        let responses: Vec<Value> = std::str::from_utf8(&output).unwrap()
            .lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(responses[0]["result"]["tools"][0]["name"], "update_plan");
        assert_eq!(responses[1]["result"]["content"][0]["text"],
            "Semantic progress accepted; Coucou receives it through the Codex hook.");
    }

    #[test]
    fn accepts_status_and_title_without_a_plan() {
        let response = call_tool(&json!({
            "name": "update_plan",
            "arguments": { "task_title": "Fix session naming", "current_status": "Tracing project metadata" }
        }));
        assert_eq!(response["content"][0]["text"],
            "Semantic progress accepted; Coucou receives it through the Codex hook.");
    }

    #[test]
    fn rejects_empty_semantic_update_without_breaking_the_server() {
        let response = call_tool(&json!({ "name": "update_plan", "arguments": {} }));
        assert_eq!(response["content"][0]["text"],
            "Semantic progress was not published because its fields were empty or malformed; continue normally.");
    }

    #[test]
    fn malformed_plan_call_is_nonfatal() {
        let response = call_tool(&json!({
            "name": "update_plan",
            "arguments": { "steps": [{ "text": "missing a status" }] }
        }));
        assert_eq!(response["isError"], Value::Null);
        assert!(response["content"][0]["text"].as_str().unwrap().contains("continue normally"));
    }
}
