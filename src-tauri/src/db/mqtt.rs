//! MQTT 连接管理：基于 rumqttc 的常驻客户端，负责连接、订阅、发布与消息缓冲。
//!
//! 前端按 `mqtt_messages` 增量轮询（seq 递增），避免为每条消息建立事件通道。
use crate::config::{Connection, MqttConfig};
use rumqttc::{AsyncClient, Event as EventV3, LastWill, MqttOptions, Packet as PacketV3, QoS, Transport};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::task::JoinHandle;

const MESSAGE_LIMIT: usize = 2000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct MqttManager {
    clients: Mutex<HashMap<String, ClientEntry>>,
}

struct ClientEntry {
    client: ClientHandle,
    state: Arc<Mutex<ClientState>>,
    task: JoinHandle<()>,
}

enum ClientHandle {
    V3(AsyncClient),
    V5(rumqttc::v5::AsyncClient),
}

struct ClientState {
    connected: bool,
    error: String,
    messages: VecDeque<MqttMessage>,
    seq: u64,
}

impl Default for ClientState {
    fn default() -> Self {
        Self { connected: false, error: String::new(), messages: VecDeque::new(), seq: 0 }
    }
}

#[derive(serde::Serialize, Clone)]
pub struct MqttMessage {
    pub seq: u64,
    pub topic: String,
    /// UTF-8 文本（非法字节以替换符显示）
    pub payload: String,
    /// 原始字节的小写 hex，便于查看二进制消息
    pub payload_hex: String,
    pub size: usize,
    pub qos: u8,
    pub retain: bool,
    /// true = 本客户端发布，false = 从 Broker 收到
    pub sent: bool,
    pub ts: u64,
}

#[derive(serde::Serialize)]
pub struct MqttPage {
    pub messages: Vec<MqttMessage>,
    pub last_seq: u64,
    /// 缓冲已滚动，前端应清空现有列表后使用本页
    pub reset: bool,
    pub connected: bool,
    pub error: String,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn qos_of(v: u8) -> QoS {
    match v {
        1 => QoS::AtLeastOnce,
        2 => QoS::ExactlyOnce,
        _ => QoS::AtMostOnce,
    }
}

fn qos_of_v5(v: u8) -> rumqttc::v5::mqttbytes::QoS {
    use rumqttc::v5::mqttbytes::QoS as V5QoS;
    match v {
        1 => V5QoS::AtLeastOnce,
        2 => V5QoS::ExactlyOnce,
        _ => V5QoS::AtMostOnce,
    }
}

fn qos_num_v5(q: rumqttc::v5::mqttbytes::QoS) -> u8 {
    use rumqttc::v5::mqttbytes::QoS as V5QoS;
    match q {
        V5QoS::AtMostOnce => 0,
        V5QoS::AtLeastOnce => 1,
        V5QoS::ExactlyOnce => 2,
    }
}

fn qos_num(q: QoS) -> u8 {
    match q {
        QoS::AtMostOnce => 0,
        QoS::AtLeastOnce => 1,
        QoS::ExactlyOnce => 2,
    }
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

fn from_hex(text: &str) -> Result<Vec<u8>, String> {
    let cleaned: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if cleaned.len() % 2 != 0 {
        return Err("Hex 内容长度必须为偶数".into());
    }
    let mut out = Vec::with_capacity(cleaned.len() / 2);
    for pair in cleaned.chunks(2) {
        let s = std::str::from_utf8(pair).map_err(|_| "Hex 内容包含非法字符")?;
        out.push(u8::from_str_radix(s, 16).map_err(|_| "Hex 内容包含非法字符")?);
    }
    Ok(out)
}

fn decode_payload(text: &str, format: &str) -> Result<Vec<u8>, String> {
    match format {
        "hex" => from_hex(text),
        "base64" => {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(text.trim())
                .map_err(|e| format!("Base64 解码失败: {e}"))
        }
        _ => Ok(text.as_bytes().to_vec()),
    }
}

fn record(state: &Arc<Mutex<ClientState>>, topic: String, payload: Vec<u8>, qos: u8, retain: bool, sent: bool) {
    let mut st = state.lock().unwrap();
    st.seq += 1;
    let seq = st.seq;
    let msg = MqttMessage {
        seq,
        topic,
        payload: String::from_utf8_lossy(&payload).to_string(),
        payload_hex: to_hex(&payload),
        size: payload.len(),
        qos,
        retain,
        sent,
        ts: now_ms(),
    };
    if st.messages.len() >= MESSAGE_LIMIT {
        st.messages.pop_front();
    }
    st.messages.push_back(msg);
}

fn clean_host(host: &str) -> String {
    let h = host.trim();
    for prefix in ["mqtts://", "mqtt://", "wss://", "ws://"] {
        if let Some(rest) = h.strip_prefix(prefix) {
            return rest.trim_end_matches('/').to_string();
        }
    }
    h.trim_end_matches('/').to_string()
}

fn broker_address(conn: &Connection, cfg: &MqttConfig) -> (String, u16) {
    let host = clean_host(&conn.host);
    if cfg.protocol == "ws" || cfg.protocol == "wss" {
        let path = if cfg.path.trim().is_empty() { "/mqtt" } else { cfg.path.trim() };
        let path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
        (format!("{}://{}:{}{}", cfg.protocol, host, conn.port, path), conn.port)
    } else {
        (host, conn.port)
    }
}

fn read_optional(path: &str) -> Result<Vec<u8>, String> {
    if path.trim().is_empty() {
        return Ok(Vec::new());
    }
    std::fs::read(path.trim()).map_err(|e| format!("读取证书文件失败: {e}"))
}

fn build_transport(cfg: &MqttConfig) -> Result<Transport, String> {
    let ca = read_optional(&cfg.ca_file)?;
    let cert = read_optional(&cfg.client_cert_file)?;
    let key = read_optional(&cfg.client_key_file)?;
    let client_auth = if !cert.is_empty() && !key.is_empty() { Some((cert, key)) } else { None };
    match cfg.protocol.as_str() {
        "mqtts" => Ok(if ca.is_empty() {
            Transport::tls_with_default_config()
        } else {
            Transport::tls(ca, client_auth, None)
        }),
        "ws" => Ok(Transport::ws()),
        "wss" => Ok(if ca.is_empty() {
            Transport::wss_with_default_config()
        } else {
            Transport::wss(ca, client_auth, None)
        }),
        _ => Ok(Transport::tcp()),
    }
}

fn client_id(cfg: &MqttConfig) -> String {
    let id = cfg.client_id.trim();
    if id.is_empty() {
        format!("orbit-data-{}", now_ms())
    } else {
        id.to_string()
    }
}

fn v3_options(conn: &Connection, cfg: &MqttConfig) -> Result<MqttOptions, String> {
    let (host, port) = broker_address(conn, cfg);
    let mut opts = MqttOptions::new(client_id(cfg), host, port);
    opts.set_keep_alive(Duration::from_secs(cfg.keep_alive_secs.max(5) as u64));
    opts.set_clean_session(cfg.clean_start);
    opts.set_transport(build_transport(cfg)?);
    if !conn.username.trim().is_empty() {
        opts.set_credentials(conn.username.trim(), &conn.password);
    }
    if !cfg.will_topic.trim().is_empty() {
        opts.set_last_will(LastWill::new(
            cfg.will_topic.trim(),
            cfg.will_payload.as_bytes().to_vec(),
            qos_of(cfg.will_qos),
            cfg.will_retain,
        ));
    }
    Ok(opts)
}

fn v5_options(conn: &Connection, cfg: &MqttConfig) -> Result<rumqttc::v5::MqttOptions, String> {
    let (host, port) = broker_address(conn, cfg);
    let mut opts = rumqttc::v5::MqttOptions::new(client_id(cfg), host, port);
    opts.set_keep_alive(Duration::from_secs(cfg.keep_alive_secs.max(5) as u64));
    opts.set_clean_start(cfg.clean_start);
    opts.set_connection_timeout(cfg.connection_timeout_secs.max(1) as u64);
    opts.set_transport(build_transport(cfg)?);
    if !conn.username.trim().is_empty() {
        opts.set_credentials(conn.username.trim(), &conn.password);
    }
    if cfg.clean_start && cfg.session_expiry_secs > 0 {
        opts.set_session_expiry_interval(Some(cfg.session_expiry_secs));
    }
    if !cfg.will_topic.trim().is_empty() {
        opts.set_last_will(rumqttc::v5::mqttbytes::v5::LastWill::new(
            cfg.will_topic.trim(),
            cfg.will_payload.as_bytes().to_vec(),
            qos_of_v5(cfg.will_qos),
            cfg.will_retain,
            None,
        ));
    }
    Ok(opts)
}

fn config_of(conn: &Connection) -> MqttConfig {
    conn.mqtt.clone().unwrap_or_default()
}

enum Probe {
    Connected,
    Failed(String),
    Waiting,
}

/// 读取一次连接状态；锁在短作用域内释放，避免跨 await 持有
fn probe(state: &Arc<Mutex<ClientState>>) -> Probe {
    let st = state.lock().unwrap();
    if st.connected {
        Probe::Connected
    } else if st.error.is_empty() {
        Probe::Waiting
    } else {
        Probe::Failed(st.error.clone())
    }
}

/// 建立常驻连接：等待 CONNACK（最多 5 秒），成功后才计入会话。
pub async fn connect(manager: &MqttManager, conn: &Connection) -> Result<String, String> {
    manager.disconnect(&conn.id);
    let cfg = config_of(conn);
    let state = Arc::new(Mutex::new(ClientState::default()));

    let handle = if cfg.mqtt_version == "3.1.1" {
        let opts = v3_options(conn, &cfg)?;
        let (client, eventloop) = AsyncClient::new(opts, 128);
        let st = state.clone();
        let task = tokio::spawn(async move { poll_v3(eventloop, st).await });
        ClientEntry { client: ClientHandle::V3(client), state: state.clone(), task }
    } else {
        let opts = v5_options(conn, &cfg)?;
        let (client, eventloop) = rumqttc::v5::AsyncClient::new(opts, 128);
        let st = state.clone();
        let task = tokio::spawn(async move { poll_v5(eventloop, st).await });
        ClientEntry { client: ClientHandle::V5(client), state: state.clone(), task }
    };

    {
        let mut clients = manager.clients.lock().unwrap();
        clients.insert(conn.id.clone(), handle);
    }

    let detail = format!(
        "MQTT {} · {}://{}:{}",
        if cfg.mqtt_version == "3.1.1" { "3.1.1" } else { "5.0" },
        cfg.protocol,
        clean_host(&conn.host),
        conn.port
    );
    let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        match probe(&state) {
            Probe::Connected => return Ok(detail),
            Probe::Failed(err) => {
                manager.disconnect(&conn.id);
                return Err(err);
            }
            Probe::Waiting => {}
        }
        if tokio::time::Instant::now() >= deadline {
            manager.disconnect(&conn.id);
            return Err("连接超时：Broker 未返回 CONNACK，请检查主机、端口、认证与协议".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 连接测试：临时建立客户端，收到 CONNACK 即断开。
pub async fn test(conn: &Connection) -> Result<String, String> {
    let cfg = config_of(conn);
    let state = Arc::new(Mutex::new(ClientState::default()));
    let (handle, task) = if cfg.mqtt_version == "3.1.1" {
        let opts = v3_options(conn, &cfg)?;
        let (client, eventloop) = AsyncClient::new(opts, 16);
        let st = state.clone();
        let task = tokio::spawn(async move { poll_v3(eventloop, st).await });
        (ClientHandle::V3(client), task)
    } else {
        let opts = v5_options(conn, &cfg)?;
        let (client, eventloop) = rumqttc::v5::AsyncClient::new(opts, 16);
        let st = state.clone();
        let task = tokio::spawn(async move { poll_v5(eventloop, st).await });
        (ClientHandle::V5(client), task)
    };

    let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        match probe(&state) {
            Probe::Connected => {
                match &handle {
                    ClientHandle::V3(c) => { let _ = c.disconnect().await; }
                    ClientHandle::V5(c) => { let _ = c.disconnect().await; }
                }
                task.abort();
                return Ok(format!(
                    "MQTT {} 连接成功（{}://{}:{}）",
                    if cfg.mqtt_version == "3.1.1" { "3.1.1" } else { "5.0" },
                    cfg.protocol,
                    clean_host(&conn.host),
                    conn.port
                ));
            }
            Probe::Failed(err) => {
                task.abort();
                return Err(err);
            }
            Probe::Waiting => {}
        }
        if tokio::time::Instant::now() >= deadline {
            task.abort();
            return Err("连接超时：Broker 未返回 CONNACK（5 秒）".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

impl MqttManager {
    /// 断开并移除常驻客户端（同步，供命令与配置变更复用）。
    pub fn disconnect(&self, conn_id: &str) {
        let entry = self.clients.lock().unwrap().remove(conn_id);
        if let Some(entry) = entry {
            entry.task.abort();
            match entry.client {
                ClientHandle::V3(c) => { let _ = c.try_disconnect(); }
                ClientHandle::V5(c) => { let _ = c.try_disconnect(); }
            }
        }
    }

    fn state_of(&self, conn_id: &str) -> Result<Arc<Mutex<ClientState>>, String> {
        let clients = self.clients.lock().unwrap();
        clients
            .get(conn_id)
            .map(|e| e.state.clone())
            .ok_or("MQTT 未连接，请先连接再操作".into())
    }

    pub async fn subscribe(&self, conn_id: &str, topic: &str, qos: u8) -> Result<(), String> {
        let topic = topic.trim();
        if topic.is_empty() {
            return Err("订阅主题不能为空".into());
        }
        let client = {
            let clients = self.clients.lock().unwrap();
            match clients.get(conn_id) {
                Some(e) => match &e.client {
                    ClientHandle::V3(c) => ClientHandle::V3(c.clone()),
                    ClientHandle::V5(c) => ClientHandle::V5(c.clone()),
                },
                None => return Err("MQTT 未连接，请先连接再订阅".into()),
            }
        };
        match client {
            ClientHandle::V3(c) => c.subscribe(topic, qos_of(qos)).await.map_err(|e| format!("订阅失败: {e}")),
            ClientHandle::V5(c) => c.subscribe(topic, qos_of_v5(qos)).await.map_err(|e| format!("订阅失败: {e}")),
        }
    }

    pub async fn unsubscribe(&self, conn_id: &str, topic: &str) -> Result<(), String> {
        let client = {
            let clients = self.clients.lock().unwrap();
            match clients.get(conn_id) {
                Some(e) => match &e.client {
                    ClientHandle::V3(c) => ClientHandle::V3(c.clone()),
                    ClientHandle::V5(c) => ClientHandle::V5(c.clone()),
                },
                None => return Err("MQTT 未连接".into()),
            }
        };
        match client {
            ClientHandle::V3(c) => c.unsubscribe(topic).await.map_err(|e| format!("取消订阅失败: {e}")),
            ClientHandle::V5(c) => c.unsubscribe(topic).await.map_err(|e| format!("取消订阅失败: {e}")),
        }
    }

    pub async fn publish(
        &self,
        conn_id: &str,
        topic: &str,
        qos: u8,
        retain: bool,
        payload: &str,
        format: &str,
    ) -> Result<(), String> {
        let topic = topic.trim().to_string();
        if topic.is_empty() {
            return Err("发布主题不能为空".into());
        }
        let bytes = decode_payload(payload, format)?;
        let client = {
            let clients = self.clients.lock().unwrap();
            match clients.get(conn_id) {
                Some(e) => match &e.client {
                    ClientHandle::V3(c) => ClientHandle::V3(c.clone()),
                    ClientHandle::V5(c) => ClientHandle::V5(c.clone()),
                },
                None => return Err("MQTT 未连接，请先连接再发布".into()),
            }
        };
        match client {
            ClientHandle::V3(c) => c
                .publish(topic.clone(), qos_of(qos), retain, bytes.clone())
                .await
                .map_err(|e| format!("发布失败: {e}"))?,
            ClientHandle::V5(c) => c
                .publish(topic.clone(), qos_of_v5(qos), retain, bytes.clone())
                .await
                .map_err(|e| format!("发布失败: {e}"))?,
        }
        if let Ok(state) = self.state_of(conn_id) {
            record(&state, topic, bytes, qos, retain, true);
        }
        Ok(())
    }

    /// 清空消息缓冲（seq 保持递增，避免清空后又被旧消息填充）
    pub fn clear(&self, conn_id: &str) -> Result<(), String> {
        let state = self.state_of(conn_id)?;
        state.lock().unwrap().messages.clear();
        Ok(())
    }

    pub fn page(&self, conn_id: &str, since: u64) -> Result<MqttPage, String> {
        let state = self.state_of(conn_id)?;
        let st = state.lock().unwrap();
        let first_seq = st.messages.front().map(|m| m.seq).unwrap_or(0);
        let reset = since > st.seq || (first_seq > 0 && since + 1 < first_seq);
        let messages: Vec<MqttMessage> = if reset {
            st.messages.iter().cloned().collect()
        } else {
            st.messages.iter().filter(|m| m.seq > since).cloned().collect()
        };
        Ok(MqttPage {
            messages,
            last_seq: st.seq,
            reset,
            connected: st.connected,
            error: st.error.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 集成测试只从环境变量读取测试 Broker，避免把真实地址与凭据写入仓库。
    fn test_conn(version: &str) -> Option<Connection> {
        let host = std::env::var("ORBIT_MQTT_TEST_HOST").ok()?.trim().to_string();
        if host.is_empty() {
            return None;
        }
        let port = std::env::var("ORBIT_MQTT_TEST_PORT").ok()?.parse::<u16>().ok()?;
        Some(Connection {
            id: format!("test-{version}-{}", now_ms()),
            name: "mqtt-test".into(),
            db_type: "mqtt".into(),
            host,
            port,
            username: std::env::var("ORBIT_MQTT_TEST_USERNAME").unwrap_or_default(),
            password: std::env::var("ORBIT_MQTT_TEST_PASSWORD").unwrap_or_default(),
            mqtt: Some(MqttConfig {
                protocol: "mqtt".into(),
                mqtt_version: version.into(),
                clean_start: true,
                keep_alive_secs: 30,
                client_id: format!("orbit-data-test-{version}-{}-{}", now_ms(), std::process::id()),
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    async fn roundtrip(version: &str) {
        let Some(conn) = test_conn(version) else {
            eprintln!("未设置 ORBIT_MQTT_TEST_HOST，跳过 MQTT 集成测试");
            return;
        };
        let manager = MqttManager::default();
        let detail = connect(&manager, &conn).await.expect("连接失败");
        assert!(detail.contains("MQTT"), "连接信息异常: {detail}");

        let topic = format!("orbit-data/test/{version}/{}", now_ms());
        manager.subscribe(&conn.id, &topic, 1).await.expect("订阅失败");
        tokio::time::sleep(Duration::from_millis(200)).await;

        manager
            .publish(&conn.id, &topic, 1, false, "hello-orbit", "plaintext")
            .await
            .expect("发布失败");

        let mut received = false;
        for _ in 0..40 {
            let page = manager.page(&conn.id, 0).expect("读取消息失败");
            if page.messages.iter().any(|m| m.topic == topic && !m.sent && m.payload == "hello-orbit") {
                received = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(received, "未收到订阅消息（topic={topic}）");

        manager.unsubscribe(&conn.id, &topic).await.expect("取消订阅失败");
        manager.disconnect(&conn.id);
    }

    #[tokio::test]
    async fn mqtt5_roundtrip() {
        roundtrip("5.0").await;
    }

    #[tokio::test]
    async fn mqtt311_roundtrip() {
        roundtrip("3.1.1").await;
    }
}

async fn poll_v3(mut eventloop: rumqttc::EventLoop, state: Arc<Mutex<ClientState>>) {
    loop {
        match eventloop.poll().await {
            Ok(EventV3::Incoming(PacketV3::ConnAck(_))) => {
                let mut st = state.lock().unwrap();
                st.connected = true;
                st.error.clear();
            }
            Ok(EventV3::Incoming(PacketV3::Publish(p))) => {
                record(&state, p.topic, p.payload.to_vec(), qos_num(p.qos), p.retain, false);
            }
            Ok(EventV3::Incoming(PacketV3::Disconnect)) => {
                state.lock().unwrap().connected = false;
            }
            Ok(_) => {}
            Err(e) => {
                {
                    let mut st = state.lock().unwrap();
                    st.connected = false;
                    st.error = e.to_string();
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

async fn poll_v5(mut eventloop: rumqttc::v5::EventLoop, state: Arc<Mutex<ClientState>>) {
    loop {
        match eventloop.poll().await {
            Ok(rumqttc::v5::Event::Incoming(rumqttc::v5::mqttbytes::v5::Packet::ConnAck(_))) => {
                let mut st = state.lock().unwrap();
                st.connected = true;
                st.error.clear();
            }
            Ok(rumqttc::v5::Event::Incoming(rumqttc::v5::mqttbytes::v5::Packet::Publish(p))) => {
                let topic = String::from_utf8_lossy(&p.topic).to_string();
                record(&state, topic, p.payload.to_vec(), qos_num_v5(p.qos), p.retain, false);
            }
            Ok(rumqttc::v5::Event::Incoming(rumqttc::v5::mqttbytes::v5::Packet::Disconnect(_))) => {
                state.lock().unwrap().connected = false;
            }
            Ok(_) => {}
            Err(e) => {
                {
                    let mut st = state.lock().unwrap();
                    st.connected = false;
                    st.error = e.to_string();
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

