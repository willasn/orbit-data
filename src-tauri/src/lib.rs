mod ai;
mod config;
mod db;
mod gitsync;
mod update;

use config::{AppConfig, ConfigStore, Connection, ModelConfig};
use tauri::ipc::Channel;
use tauri::Manager;

/// 简易唯一 ID(时间戳 + 计数,避免引入额外依赖)
fn uuid_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}{:x}", ts, n)
}

#[tauri::command]
fn get_config(state: tauri::State<ConfigStore>) -> Result<AppConfig, String> {
    state.read()
}

#[tauri::command]
fn save_connection(
    state: tauri::State<ConfigStore>,
    sessions: tauri::State<db::session::SessionStore>,
    mqtt: tauri::State<db::mqtt::MqttManager>,
    conn: Connection,
) -> Result<AppConfig, String> {
    let mut cfg = state.read()?;
    if conn.id.is_empty() {
        let mut c = conn;
        c.id = format!("conn-{}", uuid_like());
        cfg.connections.push(c);
    } else if let Some(existing) = cfg.connections.iter_mut().find(|c| c.id == conn.id) {
        sessions.remove(&conn.id);
        mqtt.disconnect(&conn.id);
        *existing = conn;
    }
    state.write(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn delete_connection(
    state: tauri::State<ConfigStore>,
    sessions: tauri::State<db::session::SessionStore>,
    mqtt: tauri::State<db::mqtt::MqttManager>,
    id: String,
) -> Result<AppConfig, String> {
    sessions.remove(&id);
    mqtt.disconnect(&id);
    let mut cfg = state.read()?;
    cfg.connections.retain(|c| c.id != id);
    state.write(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn save_model(state: tauri::State<ConfigStore>, model: ModelConfig) -> Result<AppConfig, String> {
    let mut cfg = state.read()?;
    if model.id.is_empty() {
        let mut m = model;
        m.id = format!("model-{}", uuid_like());
        if cfg.active_model_id.is_empty() {
            cfg.active_model_id = m.id.clone();
        }
        cfg.models.push(m);
    } else if let Some(existing) = cfg.models.iter_mut().find(|m| m.id == model.id) {
        *existing = model;
    }
    state.write(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn delete_model(state: tauri::State<ConfigStore>, id: String) -> Result<AppConfig, String> {
    let mut cfg = state.read()?;
    cfg.models.retain(|m| m.id != id);
    if cfg.active_model_id == id {
        cfg.active_model_id = cfg
            .models
            .first()
            .map(|m| m.id.clone())
            .unwrap_or_default();
    }
    state.write(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn set_active_model(state: tauri::State<ConfigStore>, id: String) -> Result<AppConfig, String> {
    let mut cfg = state.read()?;
    cfg.active_model_id = id;
    state.write(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
async fn test_connection(conn: Connection) -> Result<String, String> {
    db::test_connection(&conn).await
}

/// 建立连接（真实握手验证一次，成功则记录会话，左栏显示已连接）
#[tauri::command]
async fn connect_db(
    state: tauri::State<'_, db::session::SessionStore>,
    mqtt: tauri::State<'_, db::mqtt::MqttManager>,
    conn: Connection,
) -> Result<String, String> {
    // MQTT 需要保持常驻客户端以持续接收消息，不能只做一次握手测试
    let detail = if conn.db_type == "mqtt" {
        db::mqtt::connect(&mqtt, &conn).await?
    } else {
        db::test_connection(&conn).await?
    };
    let since_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    state.mark(
        &conn.id,
        db::session::SessionInfo {
            db_type: conn.db_type.clone(),
            detail: detail.clone(),
            since_ms,
        },
    );
    Ok(detail)
}

/// 断开连接（仅清除会话记录；再次操作会按需重连）
#[tauri::command]
fn disconnect_db(
    state: tauri::State<'_, db::session::SessionStore>,
    mqtt: tauri::State<'_, db::mqtt::MqttManager>,
    id: String,
) -> Result<(), String> {
    state.remove(&id);
    mqtt.disconnect(&id);
    Ok(())
}

/// 已连接会话快照：conn.id -> 会话信息
#[tauri::command]
fn connection_status(
    state: tauri::State<'_, db::session::SessionStore>,
) -> std::collections::HashMap<String, db::session::SessionInfo> {
    state.snapshot()
}

#[tauri::command]
async fn kafka_request(
    config: tauri::State<'_, ConfigStore>,
    sessions: tauri::State<'_, db::session::SessionStore>,
    conn_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let conn = config.read()?.connections.into_iter().find(|c| c.id == conn_id)
        .ok_or("连接不存在")?;
    if conn.db_type != "kafka" { return Err("该连接不支持 Kafka 操作".into()); }
    if !sessions.snapshot().contains_key(&conn_id) { return Err("连接已断开，请重新连接".into()); }
    db::kafka::request(conn, request).await
}

#[tauri::command]
async fn oss_request(
    config: tauri::State<'_, ConfigStore>,
    sessions: tauri::State<'_, db::session::SessionStore>,
    conn_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let conn = config.read()?.connections.into_iter().find(|c| c.id == conn_id)
        .ok_or("连接不存在")?;
    if conn.db_type != "aliyun_oss" { return Err("该连接不支持对象存储操作".into()); }
    if !sessions.snapshot().contains_key(&conn_id) { return Err("连接已断开，请重新连接".into()); }
    db::oss::request(&conn, request).await
}

/// 对象上传 / 下载：本地路径由系统文件对话框提供，后端流式读写
#[tauri::command]
async fn oss_transfer(
    config: tauri::State<'_, ConfigStore>,
    sessions: tauri::State<'_, db::session::SessionStore>,
    conn_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let conn = config.read()?.connections.into_iter().find(|c| c.id == conn_id)
        .ok_or("连接不存在")?;
    if conn.db_type != "aliyun_oss" { return Err("该连接不支持对象存储操作".into()); }
    if !sessions.snapshot().contains_key(&conn_id) { return Err("连接已断开，请重新连接".into()); }
    db::oss::transfer(&conn, request).await
}

#[tauri::command]
async fn mqtt_subscribe(
    mqtt: tauri::State<'_, db::mqtt::MqttManager>,
    conn_id: String,
    topic: String,
    qos: u8,
) -> Result<(), String> {
    mqtt.subscribe(&conn_id, &topic, qos).await
}

#[tauri::command]
async fn mqtt_unsubscribe(
    mqtt: tauri::State<'_, db::mqtt::MqttManager>,
    conn_id: String,
    topic: String,
) -> Result<(), String> {
    mqtt.unsubscribe(&conn_id, &topic).await
}

#[tauri::command]
async fn mqtt_publish(
    mqtt: tauri::State<'_, db::mqtt::MqttManager>,
    conn_id: String,
    topic: String,
    qos: u8,
    retain: bool,
    payload: String,
    format: String,
) -> Result<(), String> {
    mqtt.publish(&conn_id, &topic, qos, retain, &payload, &format).await
}

#[tauri::command]
fn mqtt_messages(
    mqtt: tauri::State<'_, db::mqtt::MqttManager>,
    conn_id: String,
    since: u64,
) -> Result<db::mqtt::MqttPage, String> {
    mqtt.page(&conn_id, since)
}

#[tauri::command]
fn mqtt_clear(
    mqtt: tauri::State<'_, db::mqtt::MqttManager>,
    conn_id: String,
) -> Result<(), String> {
    mqtt.clear(&conn_id)
}

#[tauri::command]
async fn list_databases(conn: Connection) -> Result<Vec<String>, String> {
    db::list_databases(&conn).await
}

#[tauri::command]
async fn list_tables(
    conn: Connection,
    database: String,
) -> Result<Vec<db::TableInfo>, String> {
    db::list_tables(&conn, &database).await
}

#[tauri::command]
async fn list_columns(
    conn: Connection,
    database: String,
    table: String,
) -> Result<Vec<db::ColumnInfo>, String> {
    db::list_columns(&conn, &database, &table).await
}

#[tauri::command]
async fn run_query(
    conn: Connection,
    database: String,
    sql: String,
    limit: Option<usize>,
) -> Result<db::QueryResult, String> {
    db::run_query(&conn, &database, &sql, limit.unwrap_or(500)).await
}

#[tauri::command]
async fn update_rows(
    conn: Connection,
    database: String,
    table: String,
    rows: Vec<db::RowUpdate>,
) -> Result<usize, String> {
    db::update_rows(&conn, &database, &table, &rows).await
}

#[tauri::command]
async fn redis_command(conn: Connection, args: Vec<String>) -> Result<String, String> {
    db::redis::command(&conn, &args).await
}

#[tauri::command]
async fn redis_key_view(conn: Connection, key: String) -> Result<db::redis::KeyView, String> {
    db::redis::inspect(&conn, &key).await
}

#[tauri::command]
async fn test_model(model: ModelConfig) -> Result<(), String> {
    ai::test_model(&model).await
}

#[tauri::command]
async fn ai_chat(
    state: tauri::State<'_, ConfigStore>,
    model_id: String,
    messages: Vec<ai::ChatMessage>,
    request_id: String,
    channel: Channel<serde_json::Value>,
) -> Result<(), String> {
    let cfg = state.read()?;
    let model = cfg
        .models
        .into_iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| "未找到指定的 AI 模型配置,请先在设置中添加".to_string())?;
    ai::chat_stream(&model, &messages, &channel, &request_id).await
}

/// 中断正在进行的 AI 流式回答
#[tauri::command]
fn ai_cancel(request_id: String) {
    ai::cancel(&request_id);
}

/// Agent 决策一步：不执行命令，只返回下一步动作与授权级别（循环由前端驱动）
#[tauri::command]
async fn ai_agent_step(
    state: tauri::State<'_, ConfigStore>,
    model_id: String,
    input: ai::AgentInput,
) -> Result<ai::AgentStepResult, String> {
    let cfg = state.read()?;
    let model = cfg
        .models
        .into_iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| "未找到指定的 AI 模型配置,请先在设置中添加".to_string())?;
    ai::agent_step(&model, &input).await
}

#[tauri::command]
fn save_sync_config(state: tauri::State<ConfigStore>, sync: config::SyncConfig) -> Result<AppConfig, String> {
    let mut cfg = state.read()?;
    cfg.sync = sync;
    state.write(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
fn sync_init(state: tauri::State<ConfigStore>) -> Result<String, String> {
    let cfg = state.read()?;
    gitsync::init(&cfg.sync)
}

#[tauri::command]
fn sync_commit(state: tauri::State<ConfigStore>, message: String) -> Result<String, String> {
    let cfg = state.read()?;
    gitsync::commit_and_push(&cfg, &cfg.sync, &message)
}

#[tauri::command]
fn sync_pull(state: tauri::State<ConfigStore>) -> Result<AppConfig, String> {
    let cfg = state.read()?;
    let imported = gitsync::pull(&cfg.sync)?;
    state.write(&imported)?;
    Ok(imported)
}

#[tauri::command]
fn sync_status(state: tauri::State<ConfigStore>) -> Result<String, String> {
    let cfg = state.read()?;
    gitsync::status(&cfg.sync)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 依赖图中 ring 与 aws-lc-rs 同时启用，不安装默认 Provider 时
    // rustls 的 ClientConfig::builder() 会 panic（MQTT 的 wss/mqtts 默认 TLS 配置会触发）
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        // 自动更新：更新源与公钥见 tauri.conf.json 的 plugins.updater
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 对象存储上传 / 下载：系统文件选择与保存对话框
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            app.manage(ConfigStore::new(dir));
            app.manage(db::session::SessionStore::default());
            app.manage(db::mqtt::MqttManager::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_connection,
            delete_connection,
            save_model,
            delete_model,
            set_active_model,
            test_connection,
            connect_db,
            disconnect_db,
            connection_status,
            kafka_request,
            oss_request,
            oss_transfer,
            mqtt_subscribe,
            mqtt_unsubscribe,
            mqtt_publish,
            mqtt_messages,
            mqtt_clear,
            list_databases,
            list_tables,
            list_columns,
            run_query,
            update_rows,
            redis_command,
            redis_key_view,
            test_model,
            ai_chat,
            ai_cancel,
            ai_agent_step,
            save_sync_config,
            sync_init,
            sync_commit,
            sync_pull,
            sync_status,
            update::update_check,
            update::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
