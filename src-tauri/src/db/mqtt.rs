//! MQTT 连接管理：基于 rumqttc 的常驻客户端，负责连接、订阅、发布与消息缓冲。
//!
//! 前端按 `mqtt_messages` 增量轮询（seq 递增），避免为每条消息建立事件通道。
use crate::config::{Connection, MqttConfig};
use rumqttc::{
    AsyncClient, Event as EventV3, LastWill, MqttOptions, Packet as PacketV3, QoS, TlsConfiguration,
    Transport,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
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
    /// MQTT 5 用户属性（3.1.1 恒为空）
    pub user_properties: Vec<(String, String)>,
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

fn record(
    state: &Arc<Mutex<ClientState>>,
    topic: String,
    payload: Vec<u8>,
    qos: u8,
    retain: bool,
    sent: bool,
    user_properties: Vec<(String, String)>,
) {
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
        user_properties,
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

/// 显式勾选「跳过证书校验」时使用的空校验器，仅由用户配置触发，不做默认行为
#[derive(Debug)]
struct NoCertVerifier;

impl ServerCertVerifier for NoCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        use SignatureScheme::*;
        vec![
            RSA_PKCS1_SHA256,
            RSA_PKCS1_SHA384,
            RSA_PKCS1_SHA512,
            ECDSA_NISTP256_SHA256,
            ECDSA_NISTP384_SHA384,
            ECDSA_NISTP521_SHA512,
            RSA_PSS_SHA256,
            RSA_PSS_SHA384,
            RSA_PSS_SHA512,
            ED25519,
        ]
    }
}

/// 跳过校验的 TLS 传输（mqtts / wss 共用），显式指定 ring Provider 避免全局默认未安装时 panic
fn insecure_transport(is_ws: bool) -> Transport {
    let config = ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .expect("rustls 默认协议版本配置失败")
    .dangerous()
    .with_custom_certificate_verifier(Arc::new(NoCertVerifier))
    .with_no_client_auth();
    let tls = TlsConfiguration::Rustls(Arc::new(config));
    if is_ws {
        Transport::wss_with_config(tls)
    } else {
        Transport::tls_with_config(tls)
    }
}

fn build_transport(cfg: &MqttConfig) -> Result<Transport, String> {
    let ca = read_optional(&cfg.ca_file)?;
    let cert = read_optional(&cfg.client_cert_file)?;
    let key = read_optional(&cfg.client_key_file)?;
    let client_auth = if !cert.is_empty() && !key.is_empty() { Some((cert, key)) } else { None };
    match cfg.protocol.as_str() {
        "mqtts" => Ok(if cfg.insecure_skip_verify {
            insecure_transport(false)
        } else if ca.is_empty() {
            Transport::tls_with_default_config()
        } else {
            Transport::tls(ca, client_auth, None)
        }),
        "ws" => Ok(Transport::ws()),
        "wss" => Ok(if cfg.insecure_skip_verify {
            insecure_transport(true)
        } else if ca.is_empty() {
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

    /// MQTT 5 订阅选项（no_local / retain_as_published / retain_handling）在 3.1.1 下忽略
    pub async fn subscribe(
        &self,
        conn_id: &str,
        topic: &str,
        qos: u8,
        no_local: bool,
        retain_as_published: bool,
        retain_handling: u8,
    ) -> Result<(), String> {
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
            ClientHandle::V5(c) => {
                let has_options = no_local || retain_as_published || retain_handling != 0;
                if !has_options {
                    return c.subscribe(topic, qos_of_v5(qos)).await.map_err(|e| format!("订阅失败: {e}"));
                }
                use rumqttc::v5::mqttbytes::v5::{Filter, RetainForwardRule};
                let filter = Filter {
                    path: topic.to_string(),
                    qos: qos_of_v5(qos),
                    nolocal: no_local,
                    preserve_retain: retain_as_published,
                    retain_forward_rule: match retain_handling {
                        1 => RetainForwardRule::OnNewSubscribe,
                        2 => RetainForwardRule::Never,
                        _ => RetainForwardRule::OnEverySubscribe,
                    },
                };
                c.subscribe_many(vec![filter]).await.map_err(|e| format!("订阅失败: {e}"))
            }
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

    /// user_properties 仅 MQTT 5 生效，3.1.1 下忽略
    pub async fn publish(
        &self,
        conn_id: &str,
        topic: &str,
        qos: u8,
        retain: bool,
        payload: &str,
        format: &str,
        user_properties: Vec<(String, String)>,
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
            ClientHandle::V5(c) => {
                if user_properties.is_empty() {
                    c.publish(topic.clone(), qos_of_v5(qos), retain, bytes.clone())
                        .await
                        .map_err(|e| format!("发布失败: {e}"))?;
                } else {
                    let props = rumqttc::v5::mqttbytes::v5::PublishProperties {
                        user_properties: user_properties.clone(),
                        ..Default::default()
                    };
                    c.publish_with_properties(topic.clone(), qos_of_v5(qos), retain, bytes.clone(), props)
                        .await
                        .map_err(|e| format!("发布失败: {e}"))?;
                }
            }
        }
        if let Ok(state) = self.state_of(conn_id) {
            record(&state, topic, bytes, qos, retain, true, user_properties);
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
    /// 可选变量：ORBIT_MQTT_TEST_PROTOCOL（mqtt | mqtts）、ORBIT_MQTT_TEST_INSECURE（1 跳过证书校验）
    fn test_conn(version: &str) -> Option<Connection> {
        // 测试入口不经过 run()，需手动安装 rustls 默认 Provider（mqtts 建连依赖）
        let _ = rustls::crypto::ring::default_provider().install_default();
        let host = std::env::var("ORBIT_MQTT_TEST_HOST").ok()?.trim().to_string();
        if host.is_empty() {
            return None;
        }
        let port = std::env::var("ORBIT_MQTT_TEST_PORT").ok()?.parse::<u16>().ok()?;
        let protocol = std::env::var("ORBIT_MQTT_TEST_PROTOCOL").unwrap_or_else(|_| "mqtt".into());
        let insecure =
            matches!(std::env::var("ORBIT_MQTT_TEST_INSECURE").as_deref(), Ok("1") | Ok("true"));
        Some(Connection {
            id: format!("test-{version}-{}", now_ms()),
            name: "mqtt-test".into(),
            db_type: "mqtt".into(),
            host,
            port,
            username: std::env::var("ORBIT_MQTT_TEST_USERNAME").unwrap_or_default(),
            password: std::env::var("ORBIT_MQTT_TEST_PASSWORD").unwrap_or_default(),
            mqtt: Some(MqttConfig {
                protocol,
                insecure_skip_verify: insecure,
                mqtt_version: version.into(),
                clean_start: true,
                keep_alive_secs: 30,
                connection_timeout_secs: 5,
                client_id: format!("orbit-data-test-{version}-{}-{}", now_ms(), std::process::id()),
                ..Default::default()
            }),
            ..Default::default()
        })
    }

    /// 轮询消息缓冲，等待满足条件且来自 Broker 的消息（最长约 6 秒）
    async fn wait_recv(
        manager: &MqttManager,
        conn_id: &str,
        pred: impl Fn(&MqttMessage) -> bool,
    ) -> bool {
        for _ in 0..60 {
            if let Ok(page) = manager.page(conn_id, 0) {
                if page.messages.iter().any(|m| !m.sent && pred(m)) {
                    return true;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
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
        manager.subscribe(&conn.id, &topic, 1, false, false, 0).await.expect("订阅失败");
        tokio::time::sleep(Duration::from_millis(200)).await;

        manager
            .publish(&conn.id, &topic, 1, false, "hello-orbit", "plaintext", Vec::new())
            .await
            .expect("发布失败");

        let received = wait_recv(&manager, &conn.id, |m| {
            m.topic == topic && m.payload == "hello-orbit"
        })
        .await;
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

    /// QoS 0/1/2 发布订阅矩阵：订阅 QoS 2，逐级发布并核对收到的 QoS
    #[tokio::test]
    async fn qos_matrix() {
        let Some(conn) = test_conn("5.0") else { return; };
        let manager = MqttManager::default();
        connect(&manager, &conn).await.expect("连接失败");
        let base = format!("orbit-data/test/qos/{}", now_ms());
        manager.subscribe(&conn.id, &format!("{base}/#"), 2, false, false, 0).await.expect("订阅失败");
        tokio::time::sleep(Duration::from_millis(200)).await;
        for q in [0u8, 1, 2] {
            let topic = format!("{base}/q{q}");
            let payload = format!("qos-{q}");
            manager.publish(&conn.id, &topic, q, false, &payload, "plaintext", Vec::new()).await.expect("发布失败");
            let got = wait_recv(&manager, &conn.id, |m| m.topic == topic && m.payload == payload).await;
            assert!(got, "QoS {q} 未收到消息（topic={topic}）");
        }
        manager.disconnect(&conn.id);
    }

    /// Retain：先发布保留消息，再新建订阅应立刻收到 Broker 缓存的副本
    #[tokio::test]
    async fn retain_delivery() {
        let Some(conn) = test_conn("5.0") else { return; };
        let manager = MqttManager::default();
        connect(&manager, &conn).await.expect("连接失败");
        let topic = format!("orbit-data/test/retain/{}", now_ms());
        manager
            .publish(&conn.id, &topic, 1, true, "retained-hello", "plaintext", Vec::new())
            .await
            .expect("发布失败");
        tokio::time::sleep(Duration::from_millis(300)).await;
        manager.subscribe(&conn.id, &topic, 1, false, false, 0).await.expect("订阅失败");
        let got = wait_recv(&manager, &conn.id, |m| {
            m.topic == topic && m.payload == "retained-hello" && m.retain
        })
        .await;
        assert!(got, "未收到 Retain 消息（topic={topic}）");
        manager.disconnect(&conn.id);
    }

    /// 通配符订阅：单层 + 与多层 #
    #[tokio::test]
    async fn wildcard_subscription() {
        let Some(conn) = test_conn("5.0") else { return; };
        let manager = MqttManager::default();
        connect(&manager, &conn).await.expect("连接失败");
        let base = format!("orbit-data/test/wild/{}", now_ms());
        manager.subscribe(&conn.id, &format!("{base}/+/single"), 1, false, false, 0).await.expect("订阅失败");
        manager.subscribe(&conn.id, &format!("{base}/deep/#"), 1, false, false, 0).await.expect("订阅失败");
        tokio::time::sleep(Duration::from_millis(200)).await;
        manager
            .publish(&conn.id, &format!("{base}/a/single"), 1, false, "w1", "plaintext", Vec::new())
            .await
            .expect("发布失败");
        manager
            .publish(&conn.id, &format!("{base}/deep/x/y"), 1, false, "w2", "plaintext", Vec::new())
            .await
            .expect("发布失败");
        let w1 = wait_recv(&manager, &conn.id, |m| m.payload == "w1").await;
        let w2 = wait_recv(&manager, &conn.id, |m| m.payload == "w2").await;
        assert!(w1, "单层通配符 + 未命中");
        assert!(w2, "多层通配符 # 未命中");
        manager.disconnect(&conn.id);
    }

    /// 取消订阅后不再收到新消息
    #[tokio::test]
    async fn unsubscribe_stops() {
        let Some(conn) = test_conn("5.0") else { return; };
        let manager = MqttManager::default();
        connect(&manager, &conn).await.expect("连接失败");
        let topic = format!("orbit-data/test/unsub/{}", now_ms());
        manager.subscribe(&conn.id, &topic, 1, false, false, 0).await.expect("订阅失败");
        tokio::time::sleep(Duration::from_millis(200)).await;
        manager.publish(&conn.id, &topic, 1, false, "before-unsub", "plaintext", Vec::new()).await.expect("发布失败");
        assert!(wait_recv(&manager, &conn.id, |m| m.payload == "before-unsub").await, "取消订阅前未收到");
        manager.unsubscribe(&conn.id, &topic).await.expect("取消订阅失败");
        tokio::time::sleep(Duration::from_millis(300)).await;
        manager.publish(&conn.id, &topic, 1, false, "after-unsub", "plaintext", Vec::new()).await.expect("发布失败");
        tokio::time::sleep(Duration::from_millis(800)).await;
        let page = manager.page(&conn.id, 0).expect("读取消息失败");
        let leaked = page.messages.iter().any(|m| !m.sent && m.payload == "after-unsub");
        assert!(!leaked, "取消订阅后仍收到消息");
        manager.disconnect(&conn.id);
    }

    /// Base64 / Hex 编码发布：Broker 收到的字节应与解码结果一致
    #[tokio::test]
    async fn payload_formats() {
        let Some(conn) = test_conn("5.0") else { return; };
        let manager = MqttManager::default();
        connect(&manager, &conn).await.expect("连接失败");
        let topic = format!("orbit-data/test/fmt/{}", now_ms());
        manager.subscribe(&conn.id, &topic, 1, false, false, 0).await.expect("订阅失败");
        tokio::time::sleep(Duration::from_millis(200)).await;
        manager
            .publish(&conn.id, &topic, 1, false, "aGVsbG8tdGVzdA==", "base64", Vec::new())
            .await
            .expect("Base64 发布失败");
        manager
            .publish(&conn.id, &topic, 1, false, "4845582d6279746573", "hex", Vec::new())
            .await
            .expect("Hex 发布失败");
        let b64 = wait_recv(&manager, &conn.id, |m| m.payload == "hello-test").await;
        let hex = wait_recv(&manager, &conn.id, |m| m.payload == "HEX-bytes").await;
        assert!(b64, "Base64 解码内容未收到");
        assert!(hex, "Hex 解码内容未收到");
        manager.disconnect(&conn.id);
    }

    /// 遗嘱消息：客户端未正常 DISCONNECT 直接断开时，Broker 应发布遗嘱
    #[tokio::test]
    async fn will_message_fires() {
        let Some(mut conn) = test_conn("3.1.1") else { return; };
        let manager = MqttManager::default();
        connect(&manager, &conn).await.expect("订阅端连接失败");
        let sub_id = conn.id.clone();
        let will_topic = format!("orbit-data/test/will/{}", now_ms());
        manager.subscribe(&sub_id, &will_topic, 1, false, false, 0).await.expect("订阅失败");
        tokio::time::sleep(Duration::from_millis(200)).await;

        // 遗嘱端：独立客户端，配置遗嘱后不发送 DISCONNECT 直接丢弃连接
        let mut will_cfg = conn.mqtt.clone().unwrap();
        will_cfg.client_id = format!("orbit-data-will-{}", now_ms());
        will_cfg.will_topic = will_topic.clone();
        will_cfg.will_payload = "goodbye".into();
        will_cfg.will_qos = 1;
        conn.id = "will-pub".into();
        let opts = v3_options(&conn, &will_cfg).expect("遗嘱端参数失败");
        let (client, mut eventloop) = AsyncClient::new(opts, 16);
        let connected = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match eventloop.poll().await {
                    Ok(EventV3::Incoming(PacketV3::ConnAck(_))) => return true,
                    Ok(_) => {}
                    Err(_) => return false,
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(connected, "遗嘱端未能连接");
        drop(client);
        drop(eventloop);

        // 云 LB / NAT 可能延迟传播 FIN，放宽到 20 秒
        let mut got = false;
        for i in 0..200 {
            if let Ok(page) = manager.page(&sub_id, 0) {
                if page.messages.iter().any(|m| !m.sent && m.topic == will_topic && m.payload == "goodbye") {
                    got = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            if i % 100 == 99 {
                eprintln!("遗嘱等待中，已等 {} 秒", (i + 1) / 10);
            }
        }
        if !got {
            if let Ok(page) = manager.page(&sub_id, 0) {
                let seen: Vec<String> = page
                    .messages
                    .iter()
                    .map(|m| format!("{}<{}|sent={}>", m.topic, m.payload, m.sent))
                    .collect();
                eprintln!("遗嘱等待超时，当前缓冲: {seen:?}，error={}", page.error);
            }
        }
        assert!(got, "未收到遗嘱消息（topic={will_topic}）");
        manager.disconnect(&sub_id);
    }

    /// MQTT 5 持久会话参数：clean_start=false + session_expiry 能正常建连
    #[tokio::test]
    async fn session_expiry_connect() {
        let Some(mut conn) = test_conn("5.0") else { return; };
        let cfg = conn.mqtt.as_mut().unwrap();
        cfg.clean_start = false;
        cfg.session_expiry_secs = 60;
        cfg.client_id = format!("orbit-data-session-{}", std::process::id());
        let manager = MqttManager::default();
        let detail = connect(&manager, &conn).await.expect("持久会话连接失败");
        assert!(detail.contains("MQTT 5.0"), "连接信息异常: {detail}");
        manager.disconnect(&conn.id);
    }

    #[tokio::test]
    async fn connect_test_api() {
        let Some(conn) = test_conn("5.0") else { return; };
        let detail = test(&conn).await.expect("test_connection 失败");
        assert!(detail.contains("连接成功"), "返回信息异常: {detail}");
    }

    /// MQTT 5 用户属性：发布带属性，订阅端应收到相同属性
    #[tokio::test]
    async fn user_properties_roundtrip() {
        let Some(conn) = test_conn("5.0") else { return; };
        let manager = MqttManager::default();
        connect(&manager, &conn).await.expect("连接失败");
        let topic = format!("orbit-data/test/uprops/{}", now_ms());
        manager.subscribe(&conn.id, &topic, 1, false, false, 0).await.expect("订阅失败");
        tokio::time::sleep(Duration::from_millis(200)).await;
        let props = vec![
            ("device".to_string(), "sensor-1".to_string()),
            ("trace".to_string(), "t-42".to_string()),
        ];
        manager
            .publish(&conn.id, &topic, 1, false, "with-props", "plaintext", props.clone())
            .await
            .expect("发布失败");
        let got = wait_recv(&manager, &conn.id, |m| {
            m.topic == topic && m.payload == "with-props" && m.user_properties == props
        })
        .await;
        assert!(got, "未收到带用户属性的消息（topic={topic}）");
        manager.disconnect(&conn.id);
    }

    /// No Local：本客户端发布的消息不再回显给自己
    #[tokio::test]
    async fn no_local_option() {
        let Some(conn) = test_conn("5.0") else { return; };
        let manager = MqttManager::default();
        connect(&manager, &conn).await.expect("连接失败");
        let topic = format!("orbit-data/test/nolocal/{}", now_ms());
        manager.subscribe(&conn.id, &topic, 1, true, false, 0).await.expect("订阅失败");
        tokio::time::sleep(Duration::from_millis(200)).await;
        manager.publish(&conn.id, &topic, 1, false, "no-echo", "plaintext", Vec::new()).await.expect("发布失败");
        tokio::time::sleep(Duration::from_millis(800)).await;
        let page = manager.page(&conn.id, 0).expect("读取消息失败");
        let echoed = page.messages.iter().any(|m| !m.sent && m.topic == topic && m.payload == "no-echo");
        assert!(!echoed, "No Local 订阅仍收到本机发布的回显");
        manager.disconnect(&conn.id);
    }

    /// Retain Handling=Never：订阅已存在保留消息的主题时不投递缓存副本
    #[tokio::test]
    async fn retain_handling_never() {
        let Some(conn) = test_conn("5.0") else { return; };
        let manager = MqttManager::default();
        connect(&manager, &conn).await.expect("连接失败");
        let topic = format!("orbit-data/test/rhnever/{}", now_ms());
        manager.publish(&conn.id, &topic, 1, true, "cached-retained", "plaintext", Vec::new()).await.expect("发布失败");
        tokio::time::sleep(Duration::from_millis(300)).await;
        manager.subscribe(&conn.id, &topic, 1, false, false, 2).await.expect("订阅失败");
        tokio::time::sleep(Duration::from_millis(800)).await;
        let page = manager.page(&conn.id, 0).expect("读取消息失败");
        let delivered = page.messages.iter().any(|m| !m.sent && m.topic == topic);
        assert!(!delivered, "Retain Handling=Never 仍收到保留消息");
        manager.disconnect(&conn.id);
    }

    /// Retain As Published：带该选项的订阅可正常建立并收发
    #[tokio::test]
    async fn retain_as_published_option() {
        let Some(conn) = test_conn("5.0") else { return; };
        let manager = MqttManager::default();
        connect(&manager, &conn).await.expect("连接失败");
        let topic = format!("orbit-data/test/rap/{}", now_ms());
        manager.subscribe(&conn.id, &topic, 1, false, true, 0).await.expect("订阅失败");
        tokio::time::sleep(Duration::from_millis(200)).await;
        manager.publish(&conn.id, &topic, 1, false, "rap-hello", "plaintext", Vec::new()).await.expect("发布失败");
        let got = wait_recv(&manager, &conn.id, |m| m.topic == topic && m.payload == "rap-hello").await;
        assert!(got, "rap 订阅未收到消息（topic={topic}）");
        manager.disconnect(&conn.id);
    }

    #[test]
    fn payload_decode_units() {
        assert_eq!(from_hex("484558").unwrap(), b"HEX");
        assert_eq!(from_hex("48 45\n58").unwrap(), b"HEX");
        assert!(from_hex("484").is_err());
        assert!(from_hex("zz").is_err());
        assert_eq!(to_hex(b"HEX"), "484558");
        assert_eq!(decode_payload("aGVsbG8=", "base64").unwrap(), b"hello");
        assert!(decode_payload("!!", "base64").is_err());
        assert_eq!(decode_payload("plain", "plaintext").unwrap(), b"plain");
        assert_eq!(decode_payload("484558", "hex").unwrap(), b"HEX");
    }

    #[test]
    fn address_and_qos_units() {
        assert_eq!(clean_host("mqtts://127.0.0.1:1883/".strip_suffix(":1883/").unwrap()), "127.0.0.1");
        assert_eq!(clean_host("  mqtt://example.com  "), "example.com");
        let conn = Connection { host: "example.com".into(), port: 8083, ..Default::default() };
        let ws = MqttConfig { protocol: "ws".into(), path: "mqtt".into(), ..Default::default() };
        assert_eq!(broker_address(&conn, &ws).0, "ws://example.com:8083/mqtt");
        let plain = MqttConfig { protocol: "mqtt".into(), ..Default::default() };
        assert_eq!(broker_address(&conn, &plain), ("example.com".into(), 8083));
        for q in [0u8, 1, 2] {
            assert_eq!(qos_num(qos_of(q)), q);
            assert_eq!(qos_num_v5(qos_of_v5(q)), q);
        }
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
                record(&state, p.topic, p.payload.to_vec(), qos_num(p.qos), p.retain, false, Vec::new());
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
                let user_properties = p
                    .properties
                    .as_ref()
                    .map(|pr| pr.user_properties.clone())
                    .unwrap_or_default();
                record(&state, topic, p.payload.to_vec(), qos_num_v5(p.qos), p.retain, false, user_properties);
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

