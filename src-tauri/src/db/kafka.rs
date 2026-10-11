use super::TableInfo;
use crate::config::Connection;
use rdkafka::admin::{
    AdminClient, AdminOptions, NewPartitions, NewTopic, ResourceSpecifier, TopicReplication,
};
use rdkafka::bindings as sys;
use rdkafka::client::ClientContext;
use rdkafka::consumer::{BaseConsumer, Consumer, ConsumerContext};
use rdkafka::message::{Header, Headers, OwnedHeaders};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::{ClientConfig, Message, Offset, TopicPartitionList};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    ffi::{CStr, CString},
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(8);
const BYTE_LIMIT: usize = 10 * 1024 * 1024;
#[derive(Clone)]
struct QuietContext;
impl ClientContext for QuietContext {
    fn log(&self, _: rdkafka::config::RDKafkaLogLevel, _: &str, _: &str) {}
    fn error(&self, _: rdkafka::error::KafkaError, _: &str) {}
}
impl ConsumerContext for QuietContext {}
type Browser = BaseConsumer<QuietContext>;
fn err(e: impl std::fmt::Display) -> String {
    format!("Kafka 操作失败：{e}")
}
fn config(c: &Connection, group: Option<&str>) -> Result<ClientConfig, String> {
    let k = c.kafka.as_ref().ok_or("缺少 Kafka 连接配置")?;
    let servers: Vec<&str> = k
        .bootstrap_servers
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if servers.is_empty()
        || servers.len() > 32
        || servers
            .iter()
            .any(|s| s.contains(['\n', '\r']) || s.contains("://") || s.contains('@'))
    {
        return Err("Bootstrap Servers 必须为 host:port 地址列表，不接受 URL 或内嵌凭据".into());
    }
    let protocol = if k.security_protocol.is_empty() {
        "PLAINTEXT"
    } else {
        &k.security_protocol
    };
    if !["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"].contains(&protocol) {
        return Err("不支持的安全协议".into());
    }
    let mut cfg = ClientConfig::new();
    cfg.set("bootstrap.servers", servers.join(","))
        .set("security.protocol", protocol)
        .set(
            "client.id",
            if k.client_id.is_empty() {
                "orbit-data"
            } else {
                &k.client_id
            },
        )
        .set("socket.timeout.ms", "8000")
        .set("socket.connection.setup.timeout.ms", "8000")
        .set("allow.auto.create.topics", "false")
        .set("log_level", "0");
    if protocol.starts_with("SASL") {
        if !["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"].contains(&k.sasl_mechanism.as_str()) {
            return Err("仅支持 PLAIN 和 SCRAM SASL".into());
        }
        cfg.set("sasl.mechanism", &k.sasl_mechanism)
            .set("sasl.username", &c.username)
            .set("sasl.password", &c.password);
    }
    if protocol.contains("SSL") {
        for (name, value) in [
            ("ssl.ca.location", &k.ssl_ca_location),
            ("ssl.certificate.location", &k.ssl_certificate_location),
            ("ssl.key.location", &k.ssl_key_location),
        ] {
            if !value.is_empty() {
                cfg.set(name, value);
            }
        }
    }
    if let Some(g) = group {
        cfg.set("group.id", g)
            .set("enable.auto.commit", "false")
            .set("enable.auto.offset.store", "false")
            .set("auto.offset.reset", "error")
            .set("enable.partition.eof", "true")
            .set("isolation.level", "read_committed");
    }
    Ok(cfg)
}
fn browser(c: &Connection) -> Result<Browser, String> {
    config(c, Some("orbit-data-readonly-browser"))?
        .create_with_context(QuietContext)
        .map_err(|_| "无法创建 Kafka 客户端，请检查认证与证书配置".into())
}
fn field<'a>(r: &'a Value, key: &str) -> Result<&'a str, String> {
    r[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少参数 {key}"))
}
fn decimal(v: &Value) -> Result<i64, String> {
    let n = if let Some(s) = v.as_str() {
        s.parse::<i64>().map_err(|_| "位点必须是 i64 十进制整数")?
    } else {
        v.as_i64().ok_or("参数必须为整数")?
    };
    if n < 0 {
        return Err("位点必须非负".into());
    }
    Ok(n)
}
fn topic_name(r: &Value) -> Result<&str, String> {
    let name = field(r, "topic")?;
    if name.len() > 249
        || name == "."
        || name == ".."
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err("Topic 名称不合法".into());
    }
    Ok(name)
}
fn confirmed(r: &Value, target: &str) -> Result<(), String> {
    if r["confirm"].as_str() != Some(target) {
        return Err("操作需要确认目标名称".into());
    }
    Ok(())
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|v| format!("{v:02x}")).collect()
}
fn decoded(b: Option<&[u8]>) -> (Option<String>, Option<String>) {
    match b {
        Some(b) => (std::str::from_utf8(b).ok().map(str::to_owned), Some(hex(b))),
        None => (None, None),
    }
}
fn bytes(v: &Value) -> Result<Option<Vec<u8>>, String> {
    if v.is_null() {
        return Ok(None);
    }
    if let Some(s) = v.as_str() {
        return Ok(Some(s.as_bytes().to_vec()));
    }
    let data = v["data"].as_str().ok_or("消息数据必须是字符串")?;
    match v["encoding"].as_str().unwrap_or("utf8") {
        "utf8" => Ok(Some(data.as_bytes().to_vec())),
        "hex" => {
            if data.len() % 2 != 0 || !data.is_ascii() {
                return Err("Hex 必须是完整字节".into());
            }
            let b: Result<Vec<u8>, _> = data
                .as_bytes()
                .chunks(2)
                .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap_or(""), 16))
                .collect();
            b.map(Some).map_err(|_| "Hex 数据不合法".into())
        }
        _ => Err("不支持的数据编码".into()),
    }
}
fn metadata(c: &Browser) -> Result<Value, String> {
    let m = c.fetch_metadata(None, TIMEOUT).map_err(err)?;
    let topics: Vec<Value> = m.topics().iter().filter(|t| t.error().is_none()).map(|t| json!({"name":t.name(),"partitions":t.partitions().len(),"is_internal":t.name().starts_with("__")})).collect();
    let brokers: Vec<Value> = m
        .brokers()
        .iter()
        .map(|b| json!({"id":b.id(),"host":b.host(),"port":b.port()}))
        .collect();
    let controller = unsafe { sys::rd_kafka_controllerid(c.client().native_ptr(), 1000) };
    Ok(
        json!({"topics":topics,"brokers":brokers,"controller_id":if controller < 0 { None } else { Some(controller) }}),
    )
}
fn partitions(c: &Browser, topic: &str) -> Result<Vec<i32>, String> {
    let m = c.fetch_metadata(Some(topic), TIMEOUT).map_err(err)?;
    let t = m
        .topics()
        .iter()
        .find(|t| t.name() == topic)
        .ok_or("Topic 不存在")?;
    if let Some(e) = t.error() {
        return Err(err(format!("{e:?}")));
    }
    Ok(t.partitions().iter().map(|p| p.id()).collect())
}
fn read(c: &Connection, r: &Value) -> Result<Value, String> {
    let topic = topic_name(r)?;
    let consumer = browser(c)?;
    let all = partitions(&consumer, topic)?;
    let selected: Vec<i32> = if let Some(ps) = r["partitions"].as_array() {
        if ps.is_empty() {
            return Err("至少选择一个分区".into());
        }
        ps.iter()
            .map(|p| {
                p.as_i64()
                    .and_then(|p| i32::try_from(p).ok())
                    .filter(|p| all.contains(p))
                    .ok_or_else(|| "分区不存在".to_string())
            })
            .collect::<Result<_, _>>()?
    } else {
        all
    };
    if selected.len() > 256 {
        return Err("单次最多读取 256 个分区，请指定分区".into());
    }
    let limit = r["limit"].as_u64().unwrap_or(100);
    if !(1..=500).contains(&limit) {
        return Err("读取条数必须为 1–500".into());
    }
    let wait = r["timeout_ms"].as_u64().unwrap_or(1000).clamp(100, 5000);
    let start = r["start"].as_str().unwrap_or("recent");
    let mut assignment = TopicPartitionList::new();
    let mut cursors = BTreeMap::<String, String>::new();
    for p in selected {
        let (low, high) = consumer.fetch_watermarks(topic, p, TIMEOUT).map_err(err)?;
        let pos = if let Some(v) = r["offsets"].get(p.to_string()) {
            decimal(v)?
        } else {
            match start {
                "earliest" => low,
                "latest" => high,
                "recent" => high
                    .saturating_sub(r["recent"].as_u64().unwrap_or(limit).min(500) as i64)
                    .max(low),
                "offset" => decimal(&r["offset"])?,
                "timestamp" => {
                    let mut times = TopicPartitionList::new();
                    times
                        .add_partition_offset(topic, p, Offset::Offset(decimal(&r["timestamp"])?))
                        .map_err(err)?;
                    let found = consumer.offsets_for_times(times, TIMEOUT).map_err(err)?;
                    match found.find_partition(topic, p).map(|p| p.offset()) {
                        Some(Offset::Offset(n)) if n >= 0 => n,
                        _ => high,
                    }
                }
                _ => return Err("不支持的起始位置".into()),
            }
        };
        if pos < low || pos > high {
            return Err(format!(
                "分区 {p} 的 Offset 超出保留范围 [{low}, {high}]，请重新选择起点"
            ));
        }
        assignment
            .add_partition_offset(topic, p, Offset::Offset(pos))
            .map_err(err)?;
        cursors.insert(p.to_string(), pos.to_string());
    }
    consumer.assign(&assignment).map_err(err)?;
    let deadline = Instant::now() + Duration::from_millis(wait);
    let mut messages = Vec::new();
    let mut size = 0;
    let mut truncated = false;
    while Instant::now() < deadline && messages.len() < limit as usize {
        match consumer.poll(Duration::from_millis(100)) {
            Some(Ok(m)) => {
                let headers_size = m
                    .headers()
                    .map(|h| {
                        (0..h.count())
                            .map(|i| {
                                let h = h.get(i);
                                h.key.len() + h.value.map_or(0, |b| b.len())
                            })
                            .sum::<usize>()
                    })
                    .unwrap_or(0);
                let message_size = m.key().map_or(0, |b| b.len())
                    + m.payload().map_or(0, |b| b.len())
                    + headers_size;
                if message_size > BYTE_LIMIT {
                    return Err("消息超过 10 MiB 安全上限；请调整读取范围".into());
                }
                if size + message_size > BYTE_LIMIT {
                    truncated = true;
                    break;
                }
                size += message_size;
                let (key, key_hex) = decoded(m.key());
                let (value, value_hex) = decoded(m.payload());
                let headers: Vec<Value> = m
                    .headers()
                    .map(|h| {
                        (0..h.count())
                            .map(|i| {
                                let h = h.get(i);
                                let (v, x) = decoded(h.value);
                                json!({"key":h.key,"value":v,"value_hex":x})
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                messages.push(json!({"topic":m.topic(),"partition":m.partition(),"offset":m.offset().to_string(),"timestamp":m.timestamp().to_millis(),"key":key,"key_hex":key_hex,"value":value,"value_hex":value_hex,"headers":headers}));
                cursors.insert(
                    m.partition().to_string(),
                    m.offset().saturating_add(1).to_string(),
                );
            }
            Some(Err(rdkafka::error::KafkaError::PartitionEOF(p))) => {
                if let Ok(position) = consumer.position() {
                    if let Some(Offset::Offset(n)) =
                        position.find_partition(topic, p).map(|p| p.offset())
                    {
                        if n >= 0 {
                            let current = cursors
                                .get(&p.to_string())
                                .and_then(|s| s.parse::<i64>().ok())
                                .unwrap_or(n);
                            cursors.insert(p.to_string(), current.max(n).to_string());
                        }
                    }
                }
            }
            Some(Err(e)) => return Err(err(e)),
            None => {}
        }
    }
    truncated |= messages.len() == limit as usize;
    Ok(json!({"messages":messages,"next_offsets":cursors,"truncated":truncated,"warnings":[]}))
}

fn group_detail(c: &Connection, group: &str) -> Result<Value, String> {
    let consumer: Browser = config(c, Some(group))?
        .create_with_context(QuietContext)
        .map_err(|_| "无法创建消费组只读客户端")?;
    let list = consumer
        .fetch_group_list(Some(group), TIMEOUT)
        .map_err(err)?;
    let g = list
        .groups()
        .iter()
        .find(|g| g.name() == group)
        .ok_or("消费组不存在")?;
    let members: Vec<Value> = g.members().iter().map(|m| json!({"id":m.id(),"client_id":m.client_id(),"client_host":m.client_host(),"assignment":m.assignment().map(hex)})).collect();
    let metadata = consumer.fetch_metadata(None, TIMEOUT).map_err(err)?;
    let mut tpl = TopicPartitionList::new();
    for t in metadata
        .topics()
        .iter()
        .filter(|t| !t.name().starts_with("__") && t.error().is_none())
    {
        for p in t.partitions() {
            tpl.add_partition(t.name(), p.id());
        }
    }
    if tpl.count() > 2048 {
        return Err("集群分区超过 2048，暂不支持全量消费组位点查询".into());
    }
    let committed = consumer.committed_offsets(tpl, TIMEOUT).map_err(err)?;
    let mut offsets = Vec::new();
    for p in committed.elements() {
        if let Offset::Offset(n) = p.offset() {
            if n < 0 {
                continue;
            }
            let (_, high) = consumer
                .fetch_watermarks(p.topic(), p.partition(), TIMEOUT)
                .map_err(err)?;
            offsets.push(json!({"topic":p.topic(),"partition":p.partition(),"offset":n.to_string(),"high":high.to_string(),"lag":high.saturating_sub(n).max(0).to_string()}));
        }
    }
    Ok(json!({"state":g.state(),"members":members,"offsets":offsets}))
}
fn cstring(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| "参数包含非法空字符".into())
}
unsafe fn ctext(p: *const std::os::raw::c_char) -> String {
    if p.is_null() {
        String::new()
    } else {
        CStr::from_ptr(p).to_string_lossy().into_owned()
    }
}
unsafe fn ffi_result(
    queue: *mut sys::rd_kafka_queue_t,
) -> Result<*mut sys::rd_kafka_event_t, String> {
    let event = sys::rd_kafka_queue_poll(queue, 10000);
    if event.is_null() {
        return Err("Kafka 管理请求超时；结果不确定，请刷新后确认再重试".into());
    }
    if sys::rd_kafka_event_error(event) != sys::rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR {
        let error = ctext(sys::rd_kafka_event_error_string(event));
        sys::rd_kafka_event_destroy(event);
        return Err(err(error));
    }
    Ok(event)
}
fn alter_config(c: &Connection, r: &Value) -> Result<Value, String> {
    let topic = topic_name(r)?;
    confirmed(r, topic)?;
    let changes = r["configs"].as_object().ok_or("配置必须是键值对象")?;
    if changes.is_empty() || changes.len() > 64 {
        return Err("配置项必须为 1–64 个".into());
    }
    let consumer = browser(c)?;
    let name = cstring(topic)?;
    unsafe {
        let resource = sys::rd_kafka_ConfigResource_new(
            sys::rd_kafka_ResourceType_t::RD_KAFKA_RESOURCE_TOPIC,
            name.as_ptr(),
        );
        if resource.is_null() {
            return Err("无法创建配置请求".into());
        }
        let prepared = (|| -> Result<(), String> {
            for (k, v) in changes {
                let key = cstring(k)?;
                let value = v.as_str().map(cstring).transpose()?;
                let op = if v.is_null() {
                    sys::rd_kafka_AlterConfigOpType_t::RD_KAFKA_ALTER_CONFIG_OP_TYPE_DELETE
                } else {
                    sys::rd_kafka_AlterConfigOpType_t::RD_KAFKA_ALTER_CONFIG_OP_TYPE_SET
                };
                if !v.is_null() && value.is_none() {
                    return Err("配置值必须为字符串或 null".into());
                }
                let error = sys::rd_kafka_ConfigResource_add_incremental_config(
                    resource,
                    key.as_ptr(),
                    op,
                    value.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()),
                );
                if !error.is_null() {
                    let e = ctext(sys::rd_kafka_error_string(error));
                    sys::rd_kafka_error_destroy(error);
                    return Err(err(e));
                }
            }
            Ok(())
        })();
        if let Err(e) = prepared {
            sys::rd_kafka_ConfigResource_destroy(resource);
            return Err(e);
        }
        let queue = sys::rd_kafka_queue_new(consumer.client().native_ptr());
        if queue.is_null() {
            sys::rd_kafka_ConfigResource_destroy(resource);
            return Err("无法创建管理队列".into());
        }
        let mut resources = [resource];
        sys::rd_kafka_IncrementalAlterConfigs(
            consumer.client().native_ptr(),
            resources.as_mut_ptr(),
            1,
            std::ptr::null(),
            queue,
        );
        sys::rd_kafka_ConfigResource_destroy(resource);
        let result = ffi_result(queue).and_then(|event| {
            let result = sys::rd_kafka_event_IncrementalAlterConfigs_result(event);
            let mut count = 0;
            let resources =
                sys::rd_kafka_IncrementalAlterConfigs_result_resources(result, &mut count);
            let mut failure = None;
            if resources.is_null() || count != 1 {
                failure = Some("配置请求返回结果不完整".into());
            } else {
                for resource in std::slice::from_raw_parts(resources, count) {
                    if sys::rd_kafka_ConfigResource_error(*resource)
                        != sys::rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR
                    {
                        failure = Some(err(ctext(sys::rd_kafka_ConfigResource_error_string(
                            *resource,
                        ))));
                    }
                }
            }
            sys::rd_kafka_event_destroy(event);
            failure.map_or(Ok(json!({"ok":true})), Err)
        });
        sys::rd_kafka_queue_destroy(queue);
        result
    }
}
fn reset_offsets(c: &Connection, r: &Value) -> Result<Value, String> {
    let group = field(r, "group_id")?;
    confirmed(r, group)?;
    let detail = group_detail(c, group)?;
    if !["Empty", "Dead"].contains(&detail["state"].as_str().unwrap_or(""))
        || detail["members"].as_array().map_or(true, |m| !m.is_empty())
    {
        return Err("只能重置无活跃成员的消费组；请先停止消费者".into());
    }
    let topic = topic_name(r)?;
    let ps = r["partitions"].as_array();
    let consumer = browser(c)?;
    let mut tpl = TopicPartitionList::new();
    let mut preview = Vec::new();
    for p in detail["offsets"].as_array().ok_or("缺少消费位点")? {
        if p["topic"].as_str() != Some(topic) {
            continue;
        }
        let partition = p["partition"].as_i64().ok_or("非法分区")? as i32;
        if ps.is_some_and(|ps| !ps.iter().any(|p| p.as_i64() == Some(partition as i64))) {
            continue;
        }
        let (low, high) = consumer
            .fetch_watermarks(topic, partition, TIMEOUT)
            .map_err(err)?;
        let n = match r["start"].as_str().unwrap_or("earliest") {
            "earliest" => low,
            "latest" => high,
            "offset" => decimal(&r["offset"])?,
            "timestamp" => {
                let mut times = TopicPartitionList::new();
                times
                    .add_partition_offset(
                        topic,
                        partition,
                        Offset::Offset(decimal(&r["timestamp"])?),
                    )
                    .map_err(err)?;
                let result = consumer.offsets_for_times(times, TIMEOUT).map_err(err)?;
                match result.find_partition(topic, partition).map(|p| p.offset()) {
                    Some(Offset::Offset(n)) if n >= 0 => n,
                    _ => high,
                }
            }
            _ => return Err("不支持的重置方式".into()),
        };
        if n < low || n > high {
            return Err("目标 Offset 超出保留范围".into());
        }
        tpl.add_partition_offset(topic, partition, Offset::Offset(n))
            .map_err(err)?;
        preview.push(json!({"topic":topic,"partition":partition,"offset":n.to_string()}));
    }
    if tpl.count() == 0 {
        return Err("所选范围没有已提交消费位点".into());
    }
    let group_name = cstring(group)?;
    unsafe {
        let request = sys::rd_kafka_AlterConsumerGroupOffsets_new(group_name.as_ptr(), tpl.ptr());
        if request.is_null() {
            return Err("无法创建位点重置请求".into());
        }
        let queue = sys::rd_kafka_queue_new(consumer.client().native_ptr());
        if queue.is_null() {
            sys::rd_kafka_AlterConsumerGroupOffsets_destroy(request);
            return Err("无法创建管理队列".into());
        }
        let mut requests = [request];
        sys::rd_kafka_AlterConsumerGroupOffsets(
            consumer.client().native_ptr(),
            requests.as_mut_ptr(),
            1,
            std::ptr::null(),
            queue,
        );
        sys::rd_kafka_AlterConsumerGroupOffsets_destroy(request);
        let result = ffi_result(queue).and_then(|event| {
            let result = sys::rd_kafka_event_AlterConsumerGroupOffsets_result(event);
            let mut count = 0;
            let groups = sys::rd_kafka_AlterConsumerGroupOffsets_result_groups(result, &mut count);
            let mut failure = None;
            if groups.is_null() || count != 1 {
                failure = Some("重置请求返回结果不完整".into());
            } else {
                for group in std::slice::from_raw_parts(groups, count) {
                    let error = sys::rd_kafka_group_result_error(*group);
                    if !error.is_null() {
                        failure = Some(err(ctext(sys::rd_kafka_error_string(error))));
                    }
                    let parts = sys::rd_kafka_group_result_partitions(*group);
                    if !parts.is_null() {
                        for p in
                            std::slice::from_raw_parts((*parts).elems, (*parts).cnt.max(0) as usize)
                        {
                            if p.err != sys::rd_kafka_resp_err_t::RD_KAFKA_RESP_ERR_NO_ERROR {
                                failure = Some(err(ctext(sys::rd_kafka_err2str(p.err))));
                            }
                        }
                    }
                }
            }
            sys::rd_kafka_event_destroy(event);
            failure.map_or(Ok(json!({"ok":true,"offsets":preview})), Err)
        });
        sys::rd_kafka_queue_destroy(queue);
        result
    }
}

pub async fn request(c: Connection, r: Value) -> Result<Value, String> {
    let secret = c.password.clone();
    request_inner(c, r).await.map_err(|e| {
        if secret.is_empty() {
            e
        } else {
            e.replace(&secret, "[REDACTED]")
        }
    })
}
async fn request_inner(c: Connection, r: Value) -> Result<Value, String> {
    let action = field(&r, "action")?.to_owned();
    if [
        "read",
        "group_detail",
        "group_offsets",
        "reset_offsets",
        "reset_group_offsets",
        "alter_config",
    ]
    .contains(&action.as_str())
    {
        return tokio::task::spawn_blocking(move || match action.as_str() {
            "read" => read(&c, &r),
            "group_detail" | "group_offsets" => group_detail(&c, field(&r, "group_id")?),
            "alter_config" => alter_config(&c, &r),
            _ => reset_offsets(&c, &r),
        })
        .await
        .map_err(|_| "Kafka 后台任务失败")?;
    }
    if action == "produce" {
        let topic = topic_name(&r)?;
        confirmed(&r, topic)?;
        let key = bytes(&r["key"])?;
        let value = bytes(&r["value"])?;
        let mut total = key.as_ref().map_or(0, Vec::len) + value.as_ref().map_or(0, Vec::len);
        let mut headers = OwnedHeaders::new();
        if let Some(hs) = r["headers"].as_array() {
            if hs.len() > 128 {
                return Err("最多 128 个 Header".into());
            }
            for h in hs {
                let name = field(h, "key")?;
                let data = bytes(&h["value"])?;
                total += name.len() + data.as_ref().map_or(0, Vec::len);
                headers = headers.insert(Header {
                    key: name,
                    value: data.as_deref(),
                });
            }
        }
        if total > BYTE_LIMIT {
            return Err("消息超过 10 MiB 上限".into());
        }
        let mut cfg = config(&c, None)?;
        cfg.set("acks", "all").set("message.timeout.ms", "10000");
        let producer: FutureProducer<QuietContext> = cfg
            .create_with_context(QuietContext)
            .map_err(|_| "无法创建消息生产者")?;
        let mut record: FutureRecord<'_, [u8], [u8]> = FutureRecord::to(topic).headers(headers);
        if let Some(k) = key.as_deref() {
            record = record.key(k);
        }
        if let Some(v) = value.as_deref() {
            record = record.payload(v);
        }
        if !r["partition"].is_null() {
            let p = r["partition"]
                .as_i64()
                .and_then(|p| i32::try_from(p).ok())
                .filter(|p| *p >= 0)
                .ok_or("分区不合法")?;
            record = record.partition(p);
        }
        let delivery = producer
            .send(record, TIMEOUT)
            .await
            .map_err(|(e, _)| err(e))?;
        return Ok(json!({"partition":delivery.partition,"offset":delivery.offset.to_string()}));
    }
    if [
        "create_topic",
        "delete_topic",
        "increase_partitions",
        "topic_detail",
        "topic_config",
        "delete_group",
    ]
    .contains(&action.as_str())
    {
        let admin: AdminClient<QuietContext> = config(&c, None)?
            .create_with_context(QuietContext)
            .map_err(|_| "无法创建管理客户端")?;
        let opts = AdminOptions::new()
            .request_timeout(Some(TIMEOUT))
            .operation_timeout(Some(TIMEOUT));
        match action.as_str() {
            "topic_detail" | "topic_config" => {
                let topic = topic_name(&r)?.to_owned();
                let resources = [ResourceSpecifier::Topic(&topic)];
                let results = admin
                    .describe_configs(&resources, &opts)
                    .await
                    .map_err(err)?;
                let resource = results
                    .into_iter()
                    .next()
                    .ok_or("缺少配置结果")?
                    .map_err(|e| err(format!("{e:?}")))?;
                let configs: Vec<Value> = resource.entries.into_iter().map(|e| json!({"name":e.name,"value":if e.is_sensitive {None} else {e.value},"is_read_only":e.is_read_only,"is_sensitive":e.is_sensitive,"source":format!("{:?}",e.source)})).collect();
                let partitions = tokio::task::spawn_blocking(move || {
                    let consumer = browser(&c)?; let metadata = consumer.fetch_metadata(Some(&topic), TIMEOUT).map_err(err)?;
                    let t = metadata.topics().iter().find(|t| t.name() == topic).ok_or("Topic 不存在")?;
                    if let Some(e) = t.error() { return Err(err(format!("{e:?}"))); }
                    if t.partitions().len() > 256 { return Err("Topic 详情最多支持 256 个分区".into()); }
                    let mut parts = Vec::new();
                    for p in t.partitions() { let (low, high) = consumer.fetch_watermarks(&topic, p.id(), TIMEOUT).map_err(err)?; parts.push(json!({"partition":p.id(),"leader":p.leader(),"replicas":p.replicas(),"isr":p.isr(),"low":low.to_string(),"high":high.to_string()})); }
                    Ok::<_, String>(parts)
                }).await.map_err(|_| "元数据任务失败")??;
                return Ok(json!({"partitions":partitions,"configs":configs}));
            }
            "create_topic" => {
                let topic = topic_name(&r)?;
                confirmed(&r, topic)?;
                let count = r["partitions"]
                    .as_i64()
                    .filter(|n| (1..=256).contains(n))
                    .ok_or("分区数必须为 1–256")? as i32;
                let replication = r["replication_factor"]
                    .as_i64()
                    .filter(|n| (1..=32).contains(n))
                    .ok_or("副本数必须为 1–32")? as i32;
                let t = NewTopic::new(topic, count, TopicReplication::Fixed(replication));
                for result in admin.create_topics(&[t], &opts).await.map_err(err)? {
                    result.map_err(|(_, e)| err(e))?;
                }
            }
            "delete_topic" => {
                let topic = topic_name(&r)?;
                confirmed(&r, topic)?;
                for result in admin.delete_topics(&[topic], &opts).await.map_err(err)? {
                    result.map_err(|(_, e)| err(e))?;
                }
            }
            "increase_partitions" => {
                let topic = topic_name(&r)?;
                confirmed(&r, topic)?;
                let count = r["partitions"]
                    .as_u64()
                    .filter(|n| (1..=256).contains(n))
                    .ok_or("分区数必须为 1–256")? as usize;
                let p = NewPartitions::new(topic, count);
                for result in admin.create_partitions(&[p], &opts).await.map_err(err)? {
                    result.map_err(|(_, e)| err(e))?;
                }
            }
            _ => {
                let group = field(&r, "group_id")?;
                confirmed(&r, group)?;
                for result in admin.delete_groups(&[group], &opts).await.map_err(err)? {
                    result.map_err(|(_, e)| err(e))?;
                }
            }
        }
        return Ok(json!({"ok":true}));
    }
    tokio::task::spawn_blocking(move || {
        let consumer = browser(&c)?;
        match action.as_str() {
            "metadata" | "list_topics" | "brokers" => metadata(&consumer),
            "groups" | "list_groups" => { let list = consumer.fetch_group_list(None, TIMEOUT).map_err(err)?; Ok(json!({"groups":list.groups().iter().map(|g| json!({"group_id":g.name(),"state":g.state(),"protocol_type":g.protocol_type()})).collect::<Vec<_>>()})) },
            _ => Err("不支持的 Kafka 操作".into()),
        }
    }).await.map_err(|_| "Kafka 元数据任务失败")?
}
pub async fn test(c: &Connection) -> Result<String, String> {
    let result = request(c.clone(), json!({"action":"metadata"})).await?;
    Ok(format!(
        "Kafka 元数据连接成功（{} 个 Broker）；消息读取和管理权限需单独验证",
        result["brokers"].as_array().map_or(0, Vec::len)
    ))
}
pub async fn tables(c: &Connection) -> Result<Vec<TableInfo>, String> {
    let result = request(c.clone(), json!({"action":"list_topics"})).await?;
    Ok(result["topics"]
        .as_array()
        .ok_or("缺少 Topic 列表")?
        .iter()
        .filter_map(|t| {
            t["name"].as_str().map(|name| TableInfo {
                name: name.into(),
                table_type: "topic".into(),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_null_empty_and_i64() {
        assert_eq!(bytes(&Value::Null).unwrap(), None);
        assert_eq!(
            bytes(&json!({"encoding":"hex","data":""})).unwrap(),
            Some(vec![])
        );
        assert_eq!(
            bytes(&json!({"encoding":"hex","data":"00ff"})).unwrap(),
            Some(vec![0, 255])
        );
        assert!(bytes(&json!({"encoding":"hex","data":"0"})).is_err());
        assert_eq!(decimal(&json!("9223372036854775807")).unwrap(), i64::MAX);
        assert!(decimal(&json!("9223372036854775808")).is_err());
        assert!(confirmed(&json!({}), "target").is_err());
    }
}
