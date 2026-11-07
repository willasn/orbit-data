use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct KafkaConfig {
    pub bootstrap_servers: Vec<String>,
    pub security_protocol: String,
    pub sasl_mechanism: String,
    pub ssl_ca_location: String,
    pub ssl_certificate_location: String,
    pub ssl_key_location: String,
    pub client_id: String,
}

/// MQTT 连接参数（协议、会话、TLS 与遗嘱消息）
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct MqttConfig {
    /// mqtt | mqtts | ws | wss
    pub protocol: String,
    pub client_id: String,
    /// 5.0 | 3.1.1
    pub mqtt_version: String,
    pub keep_alive_secs: u16,
    pub clean_start: bool,
    pub session_expiry_secs: u32,
    pub connection_timeout_secs: u16,
    /// WebSocket 路径（仅 ws / wss）
    pub path: String,
    pub ca_file: String,
    pub client_cert_file: String,
    pub client_key_file: String,
    pub will_topic: String,
    pub will_payload: String,
    pub will_qos: u8,
    pub will_retain: bool,
}

/// 数据库连接配置
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Connection {
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// mysql | postgres | redis
    pub db_type: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// mysql/pg: 默认数据库; redis: 逻辑库编号(0-15)
    #[serde(default)]
    pub database: String,
    /// 展示用颜色(树节点圆点)
    #[serde(default)]
    pub color: String,
    /// 左栏分组名(空串表示未分组)
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub kafka: Option<KafkaConfig>,
    #[serde(default)]
    pub mqtt: Option<MqttConfig>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "snake_case")]
pub enum ModelProtocol {
    #[default]
    Openai,
    OpenaiResponses,
    Anthropic,
    Gemini,
}

/// 自定义 AI 模型配置;旧配置缺少协议时默认为 OpenAI 兼容
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ModelConfig {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub protocol: ModelProtocol,
    #[serde(default)]
    pub input_tokens: Option<u32>,
    #[serde(default)]
    pub output_tokens: Option<u32>,
    #[serde(default)]
    pub supports_images: bool,
}

/// Git 同步配置
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SyncConfig {
    #[serde(default)]
    pub repo_path: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub remote_url: String,
    #[serde(default)]
    pub auto_push: bool,
}

/// 应用总配置(持久化为 JSON)
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub models: Vec<ModelConfig>,
    #[serde(default)]
    pub active_model_id: String,
    #[serde(default)]
    pub sync: SyncConfig,
}

pub struct ConfigStore {
    path: Mutex<PathBuf>,
    write_lock: Mutex<()>,
}

impl ConfigStore {
    pub fn new(mut dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        dir.push("config.json");
        Self {
            path: Mutex::new(dir),
            write_lock: Mutex::new(()),
        }
    }

    pub fn read(&self) -> Result<AppConfig, String> {
        let p = self.path.lock().unwrap();
        match fs::read_to_string(&*p) {
            Ok(s) => serde_json::from_str(&s).map_err(|e| format!("配置解析失败: {e}")),
            Err(_) => Ok(AppConfig::default()),
        }
    }

    pub fn write(&self, cfg: &AppConfig) -> Result<(), String> {
        let _g = self.write_lock.lock().unwrap();
        let p = self.path.lock().unwrap();
        let s =
            serde_json::to_string_pretty(cfg).map_err(|e| format!("配置序列化失败: {e}"))?;
        fs::write(&*p, s).map_err(|e| format!("配置写入失败: {e}"))
    }
}
