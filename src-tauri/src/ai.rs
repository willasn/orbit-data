use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use crate::config::{ModelConfig, ModelProtocol};

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 用户主动中断的流式请求 ID；读取流时检测到即停止向前端继续推送。
static CANCELLED: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn lock_cancelled() -> std::sync::MutexGuard<'static, Vec<String>> {
    CANCELLED.lock().unwrap_or_else(|e| e.into_inner())
}

/// 请求中断指定的流式请求(幂等,可在请求尚未建立时提前调用)
pub fn cancel(request_id: &str) {
    if request_id.is_empty() {
        return;
    }
    let mut ids = lock_cancelled();
    if !ids.iter().any(|id| id == request_id) {
        ids.push(request_id.to_string());
    }
}

fn is_cancelled(request_id: &str) -> bool {
    !request_id.is_empty() && lock_cancelled().iter().any(|id| id == request_id)
}

fn clear_cancelled(request_id: &str) {
    if request_id.is_empty() {
        return;
    }
    lock_cancelled().retain(|id| id != request_id);
}

/// 按所选协议调用模型并流式返回文本(SSE)
pub async fn chat_stream(
    model: &ModelConfig,
    messages: &[ChatMessage],
    channel: &tauri::ipc::Channel<serde_json::Value>,
    request_id: &str,
) -> Result<(), String> {
    let result = stream_once(model, messages, channel, request_id).await;
    clear_cancelled(request_id);
    result
}

async fn stream_once(
    model: &ModelConfig,
    messages: &[ChatMessage],
    channel: &tauri::ipc::Channel<serde_json::Value>,
    request_id: &str,
) -> Result<(), String> {
    if is_cancelled(request_id) {
        return Ok(());
    }
    let client = reqwest::Client::new();
    let (request, body) = build_request(&client, model, messages, true);
    let resp = request.json(&body).send().await
        .map_err(|_| "请求 AI 接口失败，请检查地址与网络连接".to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        return Err(format!("AI 接口返回 HTTP {status}"));
    }
    if is_cancelled(request_id) {
        let _ = channel.send(serde_json::json!({"type": "done", "cancelled": true}));
        return Ok(());
    }

    let mut stream = resp.bytes_stream();
    let mut buf = Vec::new();
    let mut event = String::new();
    let mut data = String::new();
    while let Some(chunk) = stream.next().await {
        if is_cancelled(request_id) {
            let _ = channel.send(serde_json::json!({"type": "done", "cancelled": true}));
            return Ok(());
        }
        let bytes = chunk.map_err(|_| "读取 AI 流失败".to_string())?;
        buf.extend_from_slice(&bytes);
        while let Some(pos) = buf.iter().position(|byte| *byte == b'\n') {
            let line = String::from_utf8_lossy(&buf[..pos]).trim_end_matches('\r').to_string();
            buf.drain(..=pos);
            if line.is_empty() {
                if process_event(&model.protocol, &event, &data, channel)? {
                    return Ok(());
                }
                event.clear();
                data.clear();
            } else if let Some(value) = line.strip_prefix("event:") {
                event = value.trim().to_string();
            } else if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value.trim());
            }
            if is_cancelled(request_id) {
                let _ = channel.send(serde_json::json!({"type": "done", "cancelled": true}));
                return Ok(());
            }
        }
    }
    if !data.is_empty() {
        process_event(&model.protocol, &event, &data, channel)?;
    }
    let _ = channel.send(serde_json::json!({"type": "done"}));
    Ok(())
}

fn build_request(
    client: &reqwest::Client,
    model: &ModelConfig,
    messages: &[ChatMessage],
    stream: bool,
) -> (reqwest::RequestBuilder, serde_json::Value) {
    let base = model.base_url.trim_end_matches('/');
    let (request, body) = match model.protocol {
        ModelProtocol::Openai => {
            let mut body = serde_json::json!({
                "model": model.model,
                "messages": messages,
                "stream": stream,
            });
            if let Some(limit) = model.output_tokens.filter(|n| *n > 0) {
                body["max_tokens"] = serde_json::json!(limit);
            }
            (client.post(format!("{base}/chat/completions")).bearer_auth(&model.api_key), body)
        }
        ModelProtocol::OpenaiResponses => {
            let input: Vec<_> = messages.iter().map(|m| serde_json::json!({
                "role": m.role,
                "content": m.content,
            })).collect();
            let mut body = serde_json::json!({
                "model": model.model,
                "input": input,
                "stream": stream,
            });
            if let Some(limit) = model.output_tokens.filter(|n| *n > 0) {
                body["max_output_tokens"] = serde_json::json!(limit);
            }
            (client.post(format!("{base}/responses")).bearer_auth(&model.api_key), body)
        }
        ModelProtocol::Anthropic => {
            let system = messages.iter().filter(|m| m.role == "system")
                .map(|m| m.content.as_str()).collect::<Vec<_>>().join("\n\n");
            let conversation: Vec<_> = messages.iter().filter(|m| m.role != "system")
                .map(|m| serde_json::json!({"role": m.role, "content": m.content})).collect();
            let mut body = serde_json::json!({
                "model": model.model,
                "messages": conversation,
                "stream": stream,
                // Anthropic 要求 max_tokens 必填; 未设置时使用兼容默认值。
                "max_tokens": model.output_tokens.filter(|n| *n > 0).unwrap_or(4096),
            });
            if !system.is_empty() {
                body["system"] = serde_json::json!(system);
            }
            (client.post(format!("{base}/messages"))
                .header("x-api-key", &model.api_key)
                .header("anthropic-version", "2023-06-01"), body)
        }
        ModelProtocol::Gemini => {
            let system = messages.iter().filter(|m| m.role == "system")
                .map(|m| m.content.as_str()).collect::<Vec<_>>().join("\n\n");
            let contents: Vec<_> = messages.iter().filter(|m| m.role != "system")
                .map(|m| serde_json::json!({
                    "role": if m.role == "assistant" { "model" } else { "user" },
                    "parts": [{"text": m.content}],
                })).collect();
            let mut body = serde_json::json!({"contents": contents});
            if !system.is_empty() {
                body["systemInstruction"] = serde_json::json!({"parts": [{"text": system}]});
            }
            if let Some(limit) = model.output_tokens.filter(|n| *n > 0) {
                body["generationConfig"] = serde_json::json!({"maxOutputTokens": limit});
            }
            let action = if stream { "streamGenerateContent?alt=sse" } else { "generateContent" };
            (client.post(format!("{base}/models/{}:{action}", model.model))
                .header("x-goog-api-key", &model.api_key), body)
        }
    };
    (request, body)
}

/// 发送最小请求验证当前配置，不写入持久化配置
pub async fn test_model(model: &ModelConfig) -> Result<(), String> {
    if model.base_url.trim().is_empty() || model.model.trim().is_empty() {
        return Err("请先填写接口地址和模型 ID".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "无法创建测试请求".to_string())?;
    let messages = [ChatMessage { role: "user".to_string(), content: "Hi".to_string() }];
    let (request, mut body) = build_request(&client, model, &messages, false);
    match model.protocol {
        ModelProtocol::Openai | ModelProtocol::Anthropic => body["max_tokens"] = serde_json::json!(1),
        ModelProtocol::OpenaiResponses => {}
        ModelProtocol::Gemini => body["generationConfig"] = serde_json::json!({"maxOutputTokens": 1}),
    }
    let response = request.json(&body).send().await
        .map_err(|_| "测试请求失败，请检查接口地址与网络连接".to_string())?;
    if !response.status().is_success() {
        return Err(format!("模型测试失败：HTTP {}", response.status()));
    }
    let value: serde_json::Value = response.json().await
        .map_err(|_| "模型测试失败：响应不是有效 JSON".to_string())?;
    let valid = match model.protocol {
        ModelProtocol::Openai => value["choices"].as_array().is_some_and(|items| !items.is_empty()),
        ModelProtocol::OpenaiResponses => value["object"] == "response" && value["status"] == "completed"
            && value["output"].as_array().is_some_and(|items| !items.is_empty()),
        ModelProtocol::Anthropic => value["content"].as_array().is_some(),
        ModelProtocol::Gemini => value["candidates"].as_array().is_some_and(|items| !items.is_empty()),
    };
    if !valid || value.get("error").is_some() {
        return Err("模型测试失败：未收到有效的模型响应".to_string());
    }
    Ok(())
}

fn process_event(
    protocol: &ModelProtocol,
    event: &str,
    data: &str,
    channel: &tauri::ipc::Channel<serde_json::Value>,
) -> Result<bool, String> {
    if data == "[DONE]" {
        let _ = channel.send(serde_json::json!({"type": "done"}));
        return Ok(true);
    }
    if event == "error" {
        return Err("AI 接口返回流式错误".to_string());
    }
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
        if value.get("error").is_some() || value["type"] == "error" {
            return Err("AI 接口返回流式错误".to_string());
        }
        if matches!(protocol, ModelProtocol::OpenaiResponses)
            && (value["type"] == "response.failed" || value["type"] == "response.incomplete") {
            return Err("AI 接口返回未完成的响应".to_string());
        }
        let text = match protocol {
            ModelProtocol::Openai => value["choices"][0]["delta"]["content"].as_str(),
            ModelProtocol::OpenaiResponses if value["type"] == "response.output_text.delta" => value["delta"].as_str(),
            ModelProtocol::Anthropic if value["type"] == "content_block_delta" =>
                value["delta"]["text"].as_str(),
            ModelProtocol::Gemini => value["candidates"][0]["content"]["parts"][0]["text"].as_str(),
            _ => None,
        };
        if let Some(text) = text.filter(|text| !text.is_empty()) {
            let _ = channel.send(serde_json::json!({"type": "delta", "text": text}));
        }
    }
    Ok(false)
}
