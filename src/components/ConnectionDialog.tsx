import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import DbTypeIcon from "./DbTypeIcon";
import { defaultPortOf, driverOf } from "../db/drivers";
import type { Connection, KafkaConfig } from "../types";

const DEFAULT_KAFKA: KafkaConfig = {
  bootstrap_servers: [], security_protocol: "PLAINTEXT", sasl_mechanism: "PLAIN",
  ssl_ca_location: "", ssl_certificate_location: "", ssl_key_location: "", client_id: "orbit-data",
};

const TYPE_META = [
  { key: "mysql", label: "MySQL", desc: "开源关系型数据库" },
  { key: "postgres", label: "PostgreSQL", desc: "高级开源关系型数据库" },
  { key: "sqlserver", label: "SQL Server", desc: "微软关系型数据库" },
  { key: "redis", label: "Redis", desc: "内存键值数据库" },
  { key: "elasticsearch", label: "Elasticsearch", desc: "全文检索与 JSON DSL 查询" },
  { key: "kafka", label: "Kafka", desc: "消息中间件 · Topic 与消费组" },
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
    setForm((f) => f.db_type === t ? f : ({ ...f, db_type: t, port: defaultPortOf(t),
      ...(driverOf(t).caps.mapping || driverOf(t).caps.messaging ? { username: "", password: "", database: "" } : {}),
      kafka: driverOf(t).caps.messaging ? f.kafka ?? { ...DEFAULT_KAFKA } : null,
    }));
  };
  const messaging = driverOf(form.db_type).caps.messaging;
  const kafka = form.kafka ?? DEFAULT_KAFKA;
  const setKafka = (patch: Partial<KafkaConfig>) => {
    setTestResult("");
    setForm((f) => ({ ...f, kafka: { ...(f.kafka ?? DEFAULT_KAFKA), ...patch } }));
  };

  const doTest = async () => {
    setTesting(true);
    setTestResult("正在测试连接（最多等待 10 秒）…");
    try {
      const res = await api.testConnection({ ...form, kafka: messaging ? { ...kafka,
        bootstrap_servers: kafka.bootstrap_servers.map((s) => s.trim()).filter(Boolean) } : null });
      setTestResult(`✓ ${res}`);
    } catch (e) {
      setTestResult(`✗ ${e}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-mask" onClick={closeDialog}>
      <div className="modal conn-modal" onClick={(e) => e.stopPropagation()}>
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
              {messaging ? (
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
            disabled={testing || !form.name.trim() || (messaging ? !kafka.bootstrap_servers.some((s) => s.trim()) : !form.host)}
            onClick={async () => {
              await saveConnection({ ...form, color: driverOf(form.db_type).color,
                kafka: messaging ? { ...kafka, bootstrap_servers: kafka.bootstrap_servers.map((s) => s.trim()).filter(Boolean) } : null });
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
