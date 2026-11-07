import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import DbTypeIcon from "./DbTypeIcon";
import { defaultPortOf, driverOf } from "../db/drivers";
import type { Connection, KafkaConfig, MqttConfig } from "../types";

const DEFAULT_KAFKA: KafkaConfig = {
  bootstrap_servers: [], security_protocol: "PLAINTEXT", sasl_mechanism: "PLAIN",
  ssl_ca_location: "", ssl_certificate_location: "", ssl_key_location: "", client_id: "orbit-data",
};

const MQTT_PORTS: Record<MqttConfig["protocol"], number> = {
  mqtt: 1883, mqtts: 8883, ws: 8083, wss: 8084,
};

const newClientId = () => `orbit-data-${Math.random().toString(36).slice(2, 8)}`;

const DEFAULT_MQTT = (): MqttConfig => ({
  protocol: "mqtt", client_id: newClientId(), mqtt_version: "5.0",
  keep_alive_secs: 60, clean_start: true, session_expiry_secs: 0,
  connection_timeout_secs: 10, path: "/mqtt",
  ca_file: "", client_cert_file: "", client_key_file: "",
  will_topic: "", will_payload: "", will_qos: 0, will_retain: false,
});

const TYPE_META = [
  { key: "mysql", label: "MySQL", desc: "开源关系型数据库" },
  { key: "postgres", label: "PostgreSQL", desc: "高级开源关系型数据库" },
  { key: "sqlserver", label: "SQL Server", desc: "微软关系型数据库" },
  { key: "redis", label: "Redis", desc: "内存键值数据库" },
  { key: "elasticsearch", label: "Elasticsearch", desc: "全文检索与 JSON DSL 查询" },
  { key: "kafka", label: "Kafka", desc: "消息中间件 · Topic 与消费组" },
  { key: "mqtt", label: "MQTT", desc: "消息中间件 · 订阅与发布" },
] as const;

export default function ConnectionDialog() {
  const { dialogOpen, closeDialog, saveConnection, config } = useStore();
  const isNew = dialogOpen === "new";
  const editing = dialogOpen && dialogOpen !== "new" ? dialogOpen : null;
  const groups = [
    ...new Set((config?.connections ?? []).map((c) => c.group).filter(Boolean)),
  ];

  const [form, setForm] = useState<Connection>(() => ({
    id: "",
    name: "",
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    database: "",
    color: driverOf("mysql").color,
    group: "",
    ...(editing ?? {}),
  }));
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");

  useEffect(() => {
    setForm({
      id: "", name: "", db_type: "mysql", host: "127.0.0.1", port: 3306,
      username: "root", password: "", database: "", color: driverOf("mysql").color, group: "",
      ...(dialogOpen && dialogOpen !== "new" ? dialogOpen : {}),
    });
    setTestResult("");
  }, [dialogOpen]);

  if (!dialogOpen) return null;

  const setType = (t: Connection["db_type"]) => {
    setTestResult("");
    setForm((f) => {
      if (f.db_type === t) return f;
      // Kafka / ES 不需要用户名密码与默认库；MQTT 复用 username / password 做 Broker 认证
      const clearAuth = driverOf(t).caps.mapping || t === "kafka";
      return {
        ...f,
        db_type: t,
        port: defaultPortOf(t),
        ...(clearAuth ? { username: "", password: "", database: "" } : {}),
        ...(t === "mqtt" && f.host === "127.0.0.1" ? { host: "" } : {}),
        kafka: t === "kafka" ? f.kafka ?? { ...DEFAULT_KAFKA } : null,
        mqtt: t === "mqtt" ? f.mqtt ?? DEFAULT_MQTT() : null,
      };
    });
  };
  const messaging = driverOf(form.db_type).caps.messaging;
  const isKafka = form.db_type === "kafka";
  const isMqtt = form.db_type === "mqtt";
  const kafka = form.kafka ?? DEFAULT_KAFKA;
  const mqtt = form.mqtt ?? DEFAULT_MQTT();
  const setKafka = (patch: Partial<KafkaConfig>) => {
    setTestResult("");
    setForm((f) => ({ ...f, kafka: { ...(f.kafka ?? DEFAULT_KAFKA), ...patch } }));
  };
  const setMqtt = (patch: Partial<MqttConfig>) => {
    setTestResult("");
    setForm((f) => ({ ...f, mqtt: { ...(f.mqtt ?? DEFAULT_MQTT()), ...patch } }));
  };

  const doTest = async () => {
    setTesting(true);
    setTestResult("正在测试连接（最多等待 5 秒）…");
    try {
      const res = await api.testConnection({
        ...form,
        kafka: isKafka ? { ...kafka, bootstrap_servers: kafka.bootstrap_servers.map((s) => s.trim()).filter(Boolean) } : null,
        mqtt: isMqtt ? mqtt : null,
      });
      setTestResult(`✓ ${res}`);
    } catch (e) {
      setTestResult(`✗ ${e}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-mask" onClick={closeDialog}>
      <div className={`modal conn-modal${isMqtt ? " wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? "新建连接" : "编辑连接"}</h3>

        <div className="conn-dialog-body">
          <div className="conn-type-list">
            {TYPE_META.map((t) => (
              <button
                key={t.key}
                className={`type-item${form.db_type === t.key ? " active" : ""}`}
                onClick={() => setType(t.key)}
              >
                <span className="type-icon">
                  <DbTypeIcon type={t.key} size={16} />
                </span>
                <span className="type-texts">
                  <span className="type-name">{t.label}</span>
                  <span className="type-desc">{t.desc}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="conn-form">
            <div className="form-grid">
              <label>连接名称 *</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例如 MySQL(生产)"
              />
              {isKafka ? (
                <>
                  <label>Bootstrap Servers *</label>
                  <textarea rows={3} value={kafka.bootstrap_servers.join("\n")}
                    placeholder="broker.example.com:9092（每行一个地址）"
                    onChange={(e) => setKafka({ bootstrap_servers: e.target.value.split("\n") })} />
                  <label>安全协议</label>
                  <select value={kafka.security_protocol} onChange={(e) => setKafka({ security_protocol: e.target.value as KafkaConfig["security_protocol"] })}>
                    {["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"].map((p) => <option key={p}>{p}</option>)}
                  </select>
                  {kafka.security_protocol.startsWith("SASL") && <>
                    <label>SASL 机制</label>
                    <select value={kafka.sasl_mechanism} onChange={(e) => setKafka({ sasl_mechanism: e.target.value as KafkaConfig["sasl_mechanism"] })}>
                      {["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"].map((p) => <option key={p}>{p}</option>)}
                    </select>
                    <label>用户名</label><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                    <label>密码</label><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                  </>}
                  {kafka.security_protocol.includes("SSL") && <>
                    <label>CA 证书路径</label><input value={kafka.ssl_ca_location} placeholder="可选，留空使用系统信任证书" onChange={(e) => setKafka({ ssl_ca_location: e.target.value })} />
                    <label>客户端证书路径</label><input value={kafka.ssl_certificate_location} onChange={(e) => setKafka({ ssl_certificate_location: e.target.value })} />
                    <label>客户端私钥路径</label><input value={kafka.ssl_key_location} onChange={(e) => setKafka({ ssl_key_location: e.target.value })} />
                  </>}
                  <label>Client ID</label><input value={kafka.client_id} onChange={(e) => setKafka({ client_id: e.target.value })} />
                  <label>安全提示</label><span>配置含明文凭据；Git 同步请使用私有仓库。证书文件不会同步。</span>
                </>
              ) : <>
                <label>主机 *</label>
                <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder={driverOf(form.db_type).caps.mapping ? "主机名或 https://主机（证书需受信任）" : "主机名"} />
                <label>端口 *</label>
                <input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
              </>}
              {isMqtt && (
                <>
                  <label>协议</label>
                  <select
                    value={mqtt.protocol}
                    onChange={(e) => {
                      const protocol = e.target.value as MqttConfig["protocol"];
                      setMqtt({ protocol });
                      setForm((f) => ({ ...f, port: MQTT_PORTS[protocol] }));
                    }}
                  >
                    {(["mqtt", "mqtts", "ws", "wss"] as const).map((p) => (
                      <option key={p} value={p}>{p}://</option>
                    ))}
                  </select>
                  <label>MQTT 版本</label>
                  <select value={mqtt.mqtt_version} onChange={(e) => setMqtt({ mqtt_version: e.target.value as MqttConfig["mqtt_version"] })}>
                    <option value="5.0">5.0</option>
                    <option value="3.1.1">3.1.1</option>
                  </select>
                  <label>Client ID</label>
                  <input value={mqtt.client_id} placeholder="留空自动生成" onChange={(e) => setMqtt({ client_id: e.target.value })} />
                  <label>用户名</label>
                  <input value={form.username} placeholder="Broker 未开启认证可留空" onChange={(e) => setForm({ ...form, username: e.target.value })} />
                  <label>密码</label>
                  <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                  <label>Keep Alive</label>
                  <input type="number" min={5} value={mqtt.keep_alive_secs}
                    onChange={(e) => setMqtt({ keep_alive_secs: Number(e.target.value) })} />
                  <label>连接超时</label>
                  <input type="number" min={1} value={mqtt.connection_timeout_secs}
                    onChange={(e) => setMqtt({ connection_timeout_secs: Number(e.target.value) })} />
                  <label>Clean Start</label>
                  <label className="conn-check">
                    <input type="checkbox" checked={mqtt.clean_start}
                      onChange={(e) => setMqtt({ clean_start: e.target.checked })} />
                    每次连接建立新会话
                  </label>
                  {mqtt.mqtt_version === "5.0" && (
                    <>
                      <label>会话过期间隔</label>
                      <input type="number" min={0} value={mqtt.session_expiry_secs}
                        placeholder="秒，0 表示断开即结束"
                        onChange={(e) => setMqtt({ session_expiry_secs: Number(e.target.value) })} />
                    </>
                  )}
                  {(mqtt.protocol === "ws" || mqtt.protocol === "wss") && (
                    <>
                      <label>WebSocket 路径</label>
                      <input value={mqtt.path} placeholder="/mqtt" onChange={(e) => setMqtt({ path: e.target.value })} />
                    </>
                  )}
                  {(mqtt.protocol === "mqtts" || mqtt.protocol === "wss") && (
                    <>
                      <label>CA 证书</label>
                      <input value={mqtt.ca_file} placeholder="可选，留空使用系统信任证书"
                        onChange={(e) => setMqtt({ ca_file: e.target.value })} />
                      <label>客户端证书</label>
                      <input value={mqtt.client_cert_file} onChange={(e) => setMqtt({ client_cert_file: e.target.value })} />
                      <label>客户端私钥</label>
                      <input value={mqtt.client_key_file} onChange={(e) => setMqtt({ client_key_file: e.target.value })} />
                    </>
                  )}
                  <label>遗嘱 Topic</label>
                  <input value={mqtt.will_topic} placeholder="可选" onChange={(e) => setMqtt({ will_topic: e.target.value })} />
                  <label>遗嘱 Payload</label>
                  <textarea rows={2} value={mqtt.will_payload} onChange={(e) => setMqtt({ will_payload: e.target.value })} />
                  <label>遗嘱 QoS / Retain</label>
                  <span className="conn-inline">
                    <select value={mqtt.will_qos} onChange={(e) => setMqtt({ will_qos: Number(e.target.value) as MqttConfig["will_qos"] })}>
                      {[0, 1, 2].map((q) => <option key={q} value={q}>QoS {q}</option>)}
                    </select>
                    <label className="conn-check">
                      <input type="checkbox" checked={mqtt.will_retain}
                        onChange={(e) => setMqtt({ will_retain: e.target.checked })} />
                      Retain
                    </label>
                  </span>
                  <label>安全提示</label>
                  <span>配置含明文凭据；Git 同步请使用私有仓库。证书文件不会同步。</span>
                </>
              )}
              {!messaging && form.db_type !== "redis" && (
                <>
                  <label>用户名</label>
                  <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                  <label>密码</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                  <label>{driverOf(form.db_type).caps.mapping ? "默认索引" : "默认数据库"}</label>
                  <input
                    value={form.database}
                    onChange={(e) => setForm({ ...form, database: e.target.value })}
                    placeholder="可选"
                  />
                </>
              )}
              {form.db_type === "redis" && (
                <>
                  <label>密码</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder="无密码可留空"
                  />
                  <label>逻辑库编号</label>
                  <input
                    type="number"
                    min={0}
                    max={15}
                    value={form.database || "0"}
                    onChange={(e) => setForm({ ...form, database: e.target.value })}
                  />
                </>
              )}
              <label>分组</label>
              <input
                value={form.group}
                onChange={(e) => setForm({ ...form, group: e.target.value })}
                placeholder="可选,如 生产 / 测试"
                list="conn-group-options"
              />
              <datalist id="conn-group-options">
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>

            {testResult && <div className="test-result">{testResult}</div>}
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" disabled={testing} onClick={doTest}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          <div className="spacer" />
          <button className="btn" onClick={closeDialog}>取消</button>
          <button
            className="btn primary"
            disabled={testing || !form.name.trim() || (isKafka ? !kafka.bootstrap_servers.some((s) => s.trim()) : !form.host)}
            onClick={async () => {
              await saveConnection({
                ...form,
                color: driverOf(form.db_type).color,
                kafka: isKafka ? { ...kafka, bootstrap_servers: kafka.bootstrap_servers.map((s) => s.trim()).filter(Boolean) } : null,
                mqtt: isMqtt ? mqtt : null,
              });
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
