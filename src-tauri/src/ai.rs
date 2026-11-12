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
            // Responses 接口用 instructions 承载 system，input 只放对话消息。
            let instructions = messages.iter().filter(|m| m.role == "system")
                .map(|m| m.content.as_str()).collect::<Vec<_>>().join("\n\n");
            let input: Vec<_> = messages.iter().filter(|m| m.role != "system").map(|m| serde_json::json!({
                "role": m.role,
                "content": m.content,
            })).collect();
            let mut body = serde_json::json!({
                "model": model.model,
                "input": input,
                "stream": stream,
            });
            if !instructions.is_empty() {
                body["instructions"] = serde_json::json!(instructions);
            }
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

// ---------------------------------------------------------------------------
// Agent 模式：后端只负责「决策」，实际执行与循环由前端驱动
// ---------------------------------------------------------------------------

/// 一步已执行的命令及回填给模型的结果。
#[derive(Serialize, Deserialize, Clone)]
pub struct AgentStep {
    pub command: String,
    #[serde(default)]
    pub output: String,
}

/// 一轮 Agent 决策的入参。
#[derive(Deserialize)]
pub struct AgentInput {
    pub goal: String,
    #[serde(default)]
    pub steps: Vec<AgentStep>,
    /// 当前连接 / 库 / 表等环境说明，由前端组装
    #[serde(default)]
    pub context: String,
    /// mysql | postgres | redis | elasticsearch 等
    #[serde(default)]
    pub db_type: String,
    /// 本轮还能执行多少条命令；快用完时提示模型收尾
    #[serde(default)]
    pub remaining_steps: Option<u32>,
}

/// 决策结果：给出一条命令或宣告结束。
#[derive(Serialize)]
pub struct AgentStepResult {
    /// run | done
    pub action: String,
    pub thought: Option<String>,
    pub command: Option<String>,
    pub summary: Option<String>,
    /// 是否需要用户确认后才能执行（写 / 改 / 删除 / DDL 等）
    pub requires_auth: bool,
    pub auth_reason: Option<String>,
    /// 是否属于高风险破坏性操作（前端额外弹窗二次确认）
    pub danger: bool,
    pub danger_reason: Option<String>,
    /// 模型原始回复，便于排查解析问题
    pub raw: String,
}

struct AgentAction {
    action: String,
    thought: Option<String>,
    command: Option<String>,
    summary: Option<String>,
}

/// 执行一轮 Agent 决策：组装提示词 → 请求模型 → 解析 JSON 动作 → 判定授权级别。
pub async fn agent_step(model: &ModelConfig, input: &AgentInput) -> Result<AgentStepResult, String> {
    if input.goal.trim().is_empty() {
        return Err("请先填写目标".to_string());
    }
    let messages = [
        ChatMessage {
            role: "system".to_string(),
            content: agent_system_prompt(&input.db_type),
        },
        ChatMessage {
            role: "user".to_string(),
            content: agent_user_prompt(input),
        },
    ];
    let raw = chat_once(model, &messages).await?;
    let action = parse_agent_action(&raw)?;
    let verdict = match action.command.as_deref() {
        Some(cmd) => classify_command(&input.db_type, cmd),
        None => Verdict::safe(),
    };
    Ok(AgentStepResult {
        action: action.action,
        thought: action.thought,
        command: action.command,
        summary: action.summary,
        requires_auth: verdict.requires_auth,
        auth_reason: verdict.reason,
        danger: verdict.danger,
        danger_reason: if verdict.danger { verdict.danger_reason } else { None },
        raw,
    })
}

/// 非流式请求一次模型，返回完整文本。
async fn chat_once(model: &ModelConfig, messages: &[ChatMessage]) -> Result<String, String> {
    if model.base_url.trim().is_empty() || model.model.trim().is_empty() {
        return Err("请先在设置中完善 AI 模型的接口地址与模型 ID".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| "无法创建 AI 请求".to_string())?;
    let (request, body) = build_request(&client, model, messages, false);
    let resp = request
        .json(&body)
        .send()
        .await
        .map_err(|_| "请求 AI 接口失败，请检查地址与网络连接".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("AI 接口返回 HTTP {}", resp.status()));
    }
    let value: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| "AI 接口返回的内容不是有效 JSON".to_string())?;
    if value.get("error").is_some() || value["type"] == "error" {
        return Err("AI 接口返回错误".to_string());
    }
    let text = response_text(&model.protocol, &value);
    if text.trim().is_empty() {
        return Err("AI 未返回有效内容".to_string());
    }
    Ok(text)
}

/// 从各协议的非流式响应里取出文本。
fn response_text(protocol: &ModelProtocol, value: &serde_json::Value) -> String {
    match protocol {
        ModelProtocol::Openai => value["choices"][0]["message"]["content"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_default(),
        ModelProtocol::OpenaiResponses => {
            if let Some(text) = value["output_text"].as_str() {
                return text.to_string();
            }
            value["output"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .flat_map(|item| item["content"].as_array().into_iter().flatten())
                        .filter_map(|part| part["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default()
        }
        ModelProtocol::Anthropic => value["content"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default(),
        ModelProtocol::Gemini => value["candidates"][0]["content"]["parts"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default(),
    }
}

fn agent_system_prompt(db_type: &str) -> String {
    let mut lines = vec![
        "你是 OrbitData 的数据库智能助手，可以直接在当前连接上逐步执行命令并读取执行结果。".to_string(),
        "你只能输出一个 JSON 对象，不要输出解释、Markdown 代码块或任何多余文字。".to_string(),
        "两种合法形式：".to_string(),
        r#"{"action":"run","thought":"一句话说明这一步要做什么","command":"一条可直接执行的命令"}"#.to_string(),
        r#"{"action":"done","thought":"可选","summary":"面向用户的最终结论，可用 Markdown"}"#.to_string(),
        "规则：".to_string(),
        "- 一次只给一条命令；系统执行后会把结果回填给你，再让你决定下一步。".to_string(),
        "- 只读查询会被直接执行；写入、修改、删除、DDL 等操作会先请求用户确认。".to_string(),
        "- 不要输出多条语句，不要依赖上一条命令的会话状态。".to_string(),
        "- 先查看上一步结果再决定下一步；目标达成或无法继续时立即返回 done。".to_string(),
        "- 不要重复执行已经成功执行过的命令。".to_string(),
        "- 查询尽量带 LIMIT，避免返回过多数据；命令必须完整，不要使用占位符。".to_string(),
    ];
    match db_type {
        "redis" => lines.push(
            "当前环境是 Redis：command 必须是单条 Redis 命令（例如 GET key、HGETALL hash），不要带 redis-cli 前缀。".to_string(),
        ),
        "elasticsearch" => lines.push(
            "当前环境是 Elasticsearch：command 第一行为 METHOD + 相对路径（如 POST /index/_search），下一行放 JSON DSL；只允许 _search、_count、_mapping、_settings、_cluster/health 等只读接口。".to_string(),
        ),
        "mysql" | "postgres" | "sqlserver" | "clickhouse" => {
            let label = match db_type {
                "mysql" => "MySQL",
                "postgres" => "PostgreSQL",
                "sqlserver" => "SQL Server",
                _ => "ClickHouse",
            };
            lines.push(format!("当前 SQL 方言：{label}，请使用该方言语法。"));
        }
        _ => {}
    }
    lines.join("\n")
}

fn agent_user_prompt(input: &AgentInput) -> String {
    let mut parts = Vec::new();
    if !input.context.trim().is_empty() {
        parts.push(format!("当前环境：\n{}", input.context.trim()));
    }
    parts.push(format!("目标：{}", input.goal.trim()));
    if input.steps.is_empty() {
        parts.push("已执行的步骤：暂无".to_string());
    } else {
        // 只回填最近若干步，避免长任务把上下文撑爆
        const KEEP: usize = 16;
        let start = input.steps.len().saturating_sub(KEEP);
        let mut lines = vec!["已执行的步骤：".to_string()];
        if start > 0 {
            lines.push(format!("（更早的 {start} 步已省略）"));
        }
        for (index, step) in input.steps.iter().enumerate().skip(start) {
            lines.push(format!("{}. $ {}", index + 1, step.command.trim()));
            lines.push(format!("   结果：{}", tail_text(&step.output, 1500)));
        }
        parts.push(lines.join("\n"));
    }
    parts.push("请给出下一步。".to_string());
    if let Some(remaining) = input.remaining_steps.filter(|n| *n <= 2) {
        parts.push(format!(
            "注意：本轮最多还能执行 {remaining} 条命令。若任务已基本完成，请优先返回 done 并总结；不要开启新的方向。"
        ));
    }
    parts.join("\n\n")
}

/// 只保留文本末尾若干字符：数据库结果通常结论在末尾。
fn tail_text(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.trim().chars().collect();
    if chars.len() <= max_chars {
        return chars.into_iter().collect();
    }
    let skipped = chars.len() - max_chars;
    format!("…（省略前 {skipped} 字符）\n{}", chars[skipped..].iter().collect::<String>())
}

/// 从模型回复中提取最后一个合法 JSON 动作，容忍 ```json 包裹与夹带文字。
fn parse_agent_action(raw: &str) -> Result<AgentAction, String> {
    let text = strip_code_fence(raw);
    for candidate in json_objects(text).into_iter().rev() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
            if let Some(action) = action_from_value(&value)? {
                return Ok(action);
            }
        }
    }
    let preview: String = raw.chars().take(300).collect();
    Err(format!("无法解析 AI 返回的动作，请重试。原始回复：{preview}"))
}

fn strip_code_fence(raw: &str) -> &str {
    let text = raw.trim();
    if !text.starts_with("```") {
        return text;
    }
    let body = text.trim_start_matches("```");
    let body = body.splitn(2, '\n').nth(1).unwrap_or("");
    body.trim_end().trim_end_matches("```").trim()
}

/// 扫描文本中所有顶层 JSON 对象片段。
fn json_objects(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut result = Vec::new();
    let mut start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match *byte {
            b'"' => in_string = true,
            b'{' => {
                if depth == 0 {
                    start = Some(index);
                }
                depth += 1;
            }
            b'}' if depth > 0 => {
                depth -= 1;
                if depth == 0 {
                    if let Some(from) = start.take() {
                        result.push(&text[from..=index]);
                    }
                }
            }
            _ => {}
        }
    }
    result
}

fn action_from_value(value: &serde_json::Value) -> Result<Option<AgentAction>, String> {
    let action = match value["action"].as_str() {
        Some(action) => action.trim().to_ascii_lowercase(),
        None => return Ok(None),
    };
    let thought = value["thought"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    match action.as_str() {
        "run" => {
            let command = value["command"].as_str().unwrap_or("").trim().to_string();
            if command.is_empty() {
                return Err("AI 返回了执行动作但没有命令".to_string());
            }
            Ok(Some(AgentAction { action, thought, command: Some(command), summary: None }))
        }
        "done" => {
            let summary = value["summary"].as_str().map(str::trim).filter(|s| !s.is_empty())
                .unwrap_or("任务已完成。").to_string();
            Ok(Some(AgentAction { action, thought, command: None, summary: Some(summary) }))
        }
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// 读写 / 危险操作判定
// ---------------------------------------------------------------------------

struct Verdict {
    requires_auth: bool,
    reason: Option<String>,
    danger: bool,
    danger_reason: Option<String>,
}

impl Verdict {
    fn safe() -> Self {
        Self { requires_auth: false, reason: None, danger: false, danger_reason: None }
    }
    fn auth(reason: &str) -> Self {
        Self { requires_auth: true, reason: Some(reason.to_string()), danger: false, danger_reason: None }
    }
    fn destructive(reason: &str) -> Self {
        Self {
            requires_auth: true,
            reason: Some(reason.to_string()),
            danger: true,
            danger_reason: Some(reason.to_string()),
        }
    }
}

fn classify_command(db_type: &str, command: &str) -> Verdict {
    match db_type {
        "redis" => classify_redis(command),
        "elasticsearch" => classify_es(command),
        _ => classify_sql(command),
    }
}

fn classify_sql(command: &str) -> Verdict {
    let up = strip_sql_comments(command).trim().to_ascii_uppercase();
    if up.is_empty() {
        return Verdict::auth("空命令");
    }
    let statements = up.trim_end_matches(';');
    let multi = statements.contains(';');

    let read_heads = ["SELECT", "SHOW", "DESC", "DESCRIBE", "EXPLAIN", "WITH", "PRAGMA"];
    let writes = ["INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "UPSERT"];
    let ddl = ["CREATE", "ALTER", "RENAME"];
    let drops = ["DROP", "TRUNCATE"];
    let others = ["GRANT", "REVOKE", "CALL", "EXEC", "EXECUTE", "SET", "USE", "COPY", "VACUUM", "ANALYZE", "OPTIMIZE", "KILL", "LOCK", "FLUSH"];

    let head = statements.trim().split_whitespace().next().unwrap_or("");
    let has_write = has_any_word(statements, &writes);
    let has_ddl = has_any_word(statements, &ddl);
    let has_drop = has_any_word(statements, &drops);

    if multi {
        return Verdict::auth("包含多条语句");
    }
    // SHOW CREATE TABLE / EXPLAIN DELETE 等只是查看元数据或执行计划，不会真正改动数据
    if ["SHOW", "DESC", "DESCRIBE", "EXPLAIN", "PRAGMA"].contains(&head) {
        return Verdict::safe();
    }
    if has_drop {
        return Verdict::destructive("删除或清空数据库对象");
    }
    if has_ddl && has_word(statements, "DROP") {
        return Verdict::destructive("修改表结构并删除字段或约束");
    }
    if (has_word(statements, "DELETE") || has_word(statements, "UPDATE")) && !has_word(statements, "WHERE") {
        return Verdict::destructive("无条件修改或删除全部数据");
    }
    if has_ddl {
        return Verdict::auth("修改表结构");
    }
    if has_write {
        return Verdict::auth("修改或删除数据");
    }
    if has_any_word(statements, &others) {
        return Verdict::auth("执行可能影响数据库状态的操作");
    }
    if read_heads.contains(&head) {
        return Verdict::safe();
    }
    Verdict::auth("执行未知类型的命令")
}

fn classify_redis(command: &str) -> Verdict {
    let first = command.trim().split_whitespace().next().unwrap_or("").to_ascii_uppercase();
    let reads = [
        "GET", "MGET", "STRLEN", "GETRANGE", "EXISTS", "TYPE", "TTL", "PTTL", "KEYS", "SCAN",
        "DBSIZE", "INFO", "PING", "ECHO", "HGET", "HMGET", "HGETALL", "HKEYS", "HVALS", "HLEN",
        "HEXISTS", "HSCAN", "LLEN", "LRANGE", "LINDEX", "LPOS", "SMEMBERS", "SCARD", "SISMEMBER",
        "SMISMEMBER", "SSCAN", "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZSCORE", "ZCARD", "ZCOUNT",
        "ZSCAN", "ZRANK", "ZREVRANK", "PFCOUNT", "XRANGE", "XREVRANGE", "XLEN", "XINFO",
    ];
    let destructive = ["FLUSHALL", "FLUSHDB"];
    let writes = [
        "SET", "SETEX", "PSETEX", "SETNX", "MSET", "MSETNX", "GETSET", "GETDEL", "INCR", "DECR",
        "INCRBY", "DECRBY", "APPEND", "SETRANGE", "EXPIRE", "PEXPIRE", "EXPIREAT", "PERSIST",
        "RENAME", "RENAMENX", "MOVE", "COPY", "RESTORE", "DEL", "UNLINK", "HSET", "HMSET", "HDEL",
        "HINCRBY", "LPUSH", "RPUSH", "LPOP", "RPOP", "LSET", "LREM", "LTRIM", "LINSERT", "SADD",
        "SREM", "SPOP", "ZADD", "ZREM", "ZINCRBY", "XADD", "XDEL", "XTRIM", "EVAL", "EVALSHA",
        "SCRIPT", "CONFIG", "CLIENT", "SHUTDOWN",
    ];
    if first.is_empty() {
        return Verdict::auth("空命令");
    }
    if destructive.contains(&first.as_str()) {
        return Verdict::destructive("清空整个 Redis 数据库");
    }
    if writes.contains(&first.as_str()) {
        return Verdict::auth("写入、修改或删除 Redis 数据");
    }
    if reads.contains(&first.as_str()) {
        return Verdict::safe();
    }
    Verdict::auth("执行未知或不常用的 Redis 命令")
}

fn classify_es(command: &str) -> Verdict {
    let mut lines = command.lines();
    let first_line = lines.next().unwrap_or("").trim();
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let path = parts.next().unwrap_or("");
    let lowered = path.to_ascii_lowercase();
    let has_body = lines.any(|line| !line.trim().is_empty());
    match method.as_str() {
        "GET" => Verdict::safe(),
        "POST" if lowered.contains("_search") || lowered.contains("_count") => Verdict::safe(),
        "DELETE" => Verdict::destructive("删除索引或文档"),
        "POST" | "PUT" | "PATCH" => {
            if has_body || lowered.contains("_bulk") || lowered.contains("_doc") || lowered.contains("_update") {
                Verdict::auth("写入数据或修改索引配置")
            } else {
                Verdict::auth("修改索引状态")
            }
        }
        _ => Verdict::auth("执行未知的 Elasticsearch 请求"),
    }
}

fn strip_sql_comments(sql: &str) -> String {
    let mut out = String::new();
    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '-' && chars.peek() == Some(&'-') {
            for next in chars.by_ref() {
                if next == '\n' {
                    break;
                }
            }
            out.push(' ');
        } else if ch == '/' && chars.peek() == Some(&'*') {
            chars.next();
            let mut prev = '\0';
            for next in chars.by_ref() {
                if prev == '*' && next == '/' {
                    break;
                }
                prev = next;
            }
            out.push(' ');
        } else {
            out.push(ch);
        }
    }
    out
}

fn is_word_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// 整词匹配（区分前后是否为字母数字下划线），避免 created_at 命中 CREATE。
fn has_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let needle = needle.as_bytes();
    if needle.is_empty() || bytes.len() < needle.len() {
        return false;
    }
    let mut index = 0;
    while index + needle.len() <= bytes.len() {
        if &bytes[index..index + needle.len()] == needle {
            let before_ok = index == 0 || !is_word_char(bytes[index - 1]);
            let after_ok = index + needle.len() == bytes.len() || !is_word_char(bytes[index + needle.len()]);
            if before_ok && after_ok {
                return true;
            }
        }
        index += 1;
    }
    false
}

fn has_any_word(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| has_word(haystack, needle))
}
