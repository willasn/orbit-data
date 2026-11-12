import { useEffect, useState } from "react";
import { api } from "../api";
import { useStore } from "../store";
import DbTypeIcon from "./DbTypeIcon";
import { defaultPortOf, driverOf } from "../db/drivers";
import type { ClickHouseConfig, Connection, KafkaConfig, MqttConfig, OssConfig } from "../types";

const DEFAULT_OSS: OssConfig = { scheme: "https", sts_token: "" };

const DEFAULT_CLICKHOUSE: ClickHouseConfig = { scheme: "http" };

/** ClickHouse HTTP 端口：http 8123 / https 8443 */
const CLICKHOUSE_PORTS: Record<ClickHouseConfig["scheme"], number> = {
  http: 8123,
  https: 8443,
};

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

/** 各类型已落地的功能点，按功能维度聚合（依据 FEATURE.md 与 menuItems.ts 中非 planned 的条目维护） */
const TYPE_META = [
  {
    key: "mysql", label: "MySQL", desc: "开源关系型数据库",
    features: [
      { title: "查询与编辑", items: ["SQL 查询", "结果表格", "单元格编辑提交"] },
      { title: "结构管理", items: ["新建数据库", "新建表", "删除数据库"] },
      { title: "数据浏览", items: ["对象树（数据库 / 表 / 视图 / 字段）", "预览前 100 行", "行计数"] },
      { title: "查看与计划", items: ["查看结构", "查看 DDL", "执行计划（EXPLAIN）"] },
      { title: "辅助", items: ["SELECT 模板", "连接测试", "TLS / 跳过证书校验"] },
    ],
  },
  {
    key: "postgres", label: "PostgreSQL", desc: "高级开源关系型数据库",
    features: [
      { title: "查询与编辑", items: ["SQL 查询", "结果表格", "单元格编辑提交"] },
      { title: "结构管理", items: ["新建数据库", "新建表", "删除数据库"] },
      { title: "数据浏览", items: ["对象树（数据库 / Schema / 表 / 字段）", "预览前 100 行", "行计数"] },
      { title: "查看与计划", items: ["查看结构", "执行计划（EXPLAIN）"] },
      { title: "辅助", items: ["SELECT 模板", "连接测试", "TLS / 跳过证书校验"] },
    ],
  },
  {
    key: "sqlserver", label: "SQL Server", desc: "微软关系型数据库",
    features: [
      { title: "查询与编辑", items: ["SQL 查询（TOP n / [name] 转义）", "结果表格", "单元格编辑提交"] },
      { title: "结构管理", items: ["删除数据库"] },
      { title: "数据浏览", items: ["对象树（数据库 / 表 / 视图 / 字段）", "预览前 100 行", "行计数"] },
      { title: "查看与计划", items: ["查看结构（含主键与注释）", "执行计划（SHOWPLAN_ALL）"] },
      { title: "辅助", items: ["SELECT 模板", "连接测试", "TLS / 跳过证书校验"] },
    ],
  },
  {
    key: "clickhouse", label: "ClickHouse", desc: "列式 OLAP · 高性能分析查询",
    features: [
      { title: "查询与编辑", items: ["SQL 查询（HTTP 接口）", "结果表格", "单元格编辑（ALTER TABLE UPDATE）"] },
      { title: "结构管理", items: ["新建数据库", "建表设计器（Engine / 排序键 / 分区 / TTL）", "删除数据库"] },
      { title: "数据浏览", items: ["对象树（库 / 表 / 视图 / 物化视图 / 字典）", "预览前 100 行", "行计数"] },
      { title: "查看与计划", items: ["查看结构与 DDL", "执行计划（EXPLAIN）"] },
      { title: "辅助", items: ["SELECT 模板", "连接测试", "HTTPS 跳过证书校验"] },
    ],
  },
  {
    key: "redis", label: "Redis", desc: "内存键值数据库",
    features: [
      { title: "键浏览", items: ["SCAN 键列表", "逻辑库切换（db0–db15）", "键数量（DBSIZE）"] },
      { title: "键管理", items: ["新建键", "重命名", "持久化", "删除键", "清空当前逻辑库"] },
      { title: "值查看", items: ["string / hash / list / set / zset / stream"] },
      { title: "过期时间", items: ["TTL 查看", "设置过期"] },
      { title: "控制台", items: ["任意命令执行"] },
      { title: "辅助", items: ["连接测试", "TLS / 跳过证书校验"] },
    ],
  },
  {
    key: "elasticsearch", label: "Elasticsearch", desc: "全文检索与 JSON DSL 查询",
    features: [
      { title: "索引浏览", items: ["索引直挂连接", "Mapping 与 multi-fields", "Mapping / Settings 查看"] },
      { title: "文档", items: ["预览", "计数"] },
      { title: "查询", items: ["REST / JSON DSL 控制台", "JSON 格式化", "AI 生成请求并一键运行"] },
      { title: "连接", items: ["HTTP / HTTPS 切换", "跳过证书校验", "连接测试"] },
    ],
  },
  {
    key: "aliyun_oss", label: "阿里云 OSS", desc: "对象存储 · Bucket 与对象",
    features: [
      { title: "列表浏览", items: ["Bucket 切换", "分页", "对象详情", "列表缓存"] },
      { title: "列表搜索", items: ["名称前缀、时间区间、排序"] },
      { title: "对象操作", items: ["上传（多文件）、下载、删除"] },
      { title: "预览", items: ["图片、常见文本"] },
      { title: "分享", items: ["临时下载地址"] },
      { title: "连接", items: ["连接测试", "HTTPS 跳过证书校验"] },
    ],
  },
  {
    key: "kafka", label: "Kafka", desc: "消息中间件 · Topic 与消费组",
    features: [
      { title: "消息浏览", items: ["earliest / latest / offset / timestamp、text / hex"] },
      { title: "实时监听", items: ["有限时增量轮询"] },
      { title: "消息生产", items: ["headers", "tombstone"] },
      { title: "Topic 管理", items: ["创建、删除、增加分区、修改配置"] },
      { title: "消费组", items: ["列表与 lag", "重置位点"] },
      { title: "辅助", items: ["浏览结果 JSON 导出", "连接测试"] },
    ],
  },
  {
    key: "mqtt", label: "MQTT", desc: "消息中间件 · 订阅与发布",
    features: [
      { title: "订阅", items: ["批量主题、QoS、主题颜色、启用 / 禁用"] },
      { title: "消息收发", items: ["增量轮询、方向标识、QoS / Retain、JSON 美化、Text / JSON / Hex"] },
      { title: "消息筛选", items: ["主题通配符、方向、关键词"] },
      { title: "发布", items: ["QoS / Retain、Plaintext / JSON / Base64 / Hex"] },
      { title: "连接", items: ["TLS（CA / 客户端证书 / 私钥）、遗嘱消息、MQTT 5.0 / 3.1.1、WebSocket 路径、连接测试"] },
    ],
  },
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

  const activeMeta = TYPE_META.find((t) => t.key === form.db_type) ?? TYPE_META[0];
  const featureCount = activeMeta.features.reduce((n, g) => n + g.items.length, 0);

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
        ...(t === "aliyun_oss" ? { host: "oss-cn-hangzhou.aliyuncs.com", port: 443 } : {}),
        ...(f.db_type === "aliyun_oss" && t !== "aliyun_oss" && f.host.endsWith(".aliyuncs.com")
          ? { host: "127.0.0.1", username: "", password: "" }
          : {}),
        kafka: t === "kafka" ? f.kafka ?? { ...DEFAULT_KAFKA } : null,
        mqtt: t === "mqtt" ? f.mqtt ?? DEFAULT_MQTT() : null,
        oss: t === "aliyun_oss" ? f.oss ?? { ...DEFAULT_OSS } : null,
        clickhouse: t === "clickhouse" ? f.clickhouse ?? { ...DEFAULT_CLICKHOUSE } : null,
      };
    });
  };
  const isOss = form.db_type === "aliyun_oss";
  const isClickhouse = form.db_type === "clickhouse";
  const isEs = form.db_type === "elasticsearch";
  const oss = form.oss ?? DEFAULT_OSS;
  const clickhouse = form.clickhouse ?? DEFAULT_CLICKHOUSE;
  const messaging = driverOf(form.db_type).caps.messaging;
  const isKafka = form.db_type === "kafka";
  const isMqtt = form.db_type === "mqtt";
  /** Kafka / MQTT 有专用 TLS 配置，OSS / ClickHouse 已有协议选择，其余类型使用通用 TLS 开关 */
  const showTlsToggle = !isKafka && !isMqtt && !isOss && !isClickhouse;
  /** 未设置时沿用历史默认：ES / SQL Server 默认加密，其余默认明文 */
  const tlsEnabled = form.tls ?? (isEs || form.db_type === "sqlserver");
  const setTls = (enabled: boolean) => {
    setTestResult("");
    setForm({
      ...form,
      tls: enabled,
      ...(enabled ? {} : { tls_skip_verify: false }),
    });
  };
  const setSkipVerify = (skip: boolean) => {
    setTestResult("");
    setForm({ ...form, tls_skip_verify: skip });
  };
  const skipVerifyControl = (
    <>
      <label>证书校验</label>
      <label className="conn-check">
        <input type="checkbox" checked={!!form.tls_skip_verify}
          onChange={(e) => setSkipVerify(e.target.checked)} />
        跳过校验（自签证书或 IP 证书不匹配时勾选）
      </label>
    </>
  );
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
  const setOss = (patch: Partial<OssConfig>) => {
    setTestResult("");
    setForm((f) => ({ ...f, oss: { ...(f.oss ?? DEFAULT_OSS), ...patch } }));
  };
  const setClickHouseScheme = (next: ClickHouseConfig["scheme"]) => {
    setTestResult("");
    setForm((f) => ({
      ...f,
      // 仅当当前端口仍是 ClickHouse 默认端口时联动，避免覆盖用户手填端口
      port: [0, 8123, 8443].includes(f.port) ? CLICKHOUSE_PORTS[next] : f.port,
      clickhouse: { ...(f.clickhouse ?? DEFAULT_CLICKHOUSE), scheme: next },
    }));
  };

  const doTest = async () => {
    setTesting(true);
    setTestResult("正在测试连接（最多等待 5 秒）…");
    try {
      const res = await api.testConnection({
        ...form,
        kafka: isKafka ? { ...kafka, bootstrap_servers: kafka.bootstrap_servers.map((s) => s.trim()).filter(Boolean) } : null,
        mqtt: isMqtt ? mqtt : null,
        oss: isOss ? oss : null,
        clickhouse: isClickhouse ? clickhouse : null,
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
              ) : isOss ? (
                <>
                  <label>Endpoint（地域节点）*</label>
                  <input
                    value={form.host}
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                    placeholder="oss-cn-hangzhou.aliyuncs.com"
                  />
                  <label>端口</label>
                  <input
                    type="number"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                  />
                  <label>协议</label>
                  <select
                    value={oss.scheme}
                    onChange={(e) => setOss({ scheme: e.target.value as OssConfig["scheme"] })}
                  >
                    <option value="https">https</option>
                    <option value="http">http</option>
                  </select>
                  {oss.scheme === "https" && skipVerifyControl}
                  <label>AccessKey ID *</label>
                  <input
                    value={form.username}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    placeholder="建议使用仅有目标 Bucket 权限的 RAM 子账号"
                  />
                  <label>AccessKey Secret *</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                  <label>默认 Bucket</label>
                  <input
                    value={form.database}
                    onChange={(e) => setForm({ ...form, database: e.target.value })}
                    placeholder="可选，留空则列出账号下全部 Bucket"
                  />
                  <label>STS Token</label>
                  <input
                    type="password"
                    value={oss.sts_token}
                    onChange={(e) => setOss({ sts_token: e.target.value })}
                    placeholder="可选，使用临时凭据时填写"
                  />
                  <label>安全提示</label>
                  <span>凭据明文保存在本机配置中；Git 同步请使用私有仓库，且不要公开临时下载地址。</span>
                </>
              ) : isClickhouse ? (
                <>
                  <label>主机 *</label>
                  <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })}
                    placeholder="ck.example.com" />
                  <label>协议</label>
                  <select
                    value={clickhouse.scheme}
                    onChange={(e) => setClickHouseScheme(e.target.value as ClickHouseConfig["scheme"])}
                  >
                    <option value="http">http</option>
                    <option value="https">https</option>
                  </select>
                  {clickhouse.scheme === "https" && skipVerifyControl}
                  <label>端口 *</label>
                  <input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
                </>
              ) : <>
                <label>主机 *</label>
                <input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder={driverOf(form.db_type).caps.mapping ? "主机名或 http(s)://主机（默认 https）" : "主机名"} />
                <label>端口 *</label>
                <input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
                {showTlsToggle && (
                  <>
                    <label>TLS</label>
                    <label className="conn-check">
                      <input type="checkbox" checked={tlsEnabled}
                        onChange={(e) => setTls(e.target.checked)} />
                      {isEs ? "使用 HTTPS 加密连接" : "启用 TLS 加密连接"}
                    </label>
                    {tlsEnabled && skipVerifyControl}
                  </>
                )}
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
              {!messaging && !isOss && form.db_type !== "redis" && (
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

            <div className="modal-actions conn-form-actions">
              <button className="btn" disabled={testing} onClick={doTest}>
                {testing ? "测试中…" : "测试连接"}
              </button>
              <div className="spacer" />
              <button className="btn" onClick={closeDialog}>取消</button>
              <button
                className="btn primary"
                disabled={testing || !form.name.trim() || (isKafka ? !kafka.bootstrap_servers.some((s) => s.trim()) : !form.host || (isOss && (!form.username.trim() || !form.password)))}
                onClick={async () => {
                  await saveConnection({
                    ...form,
                    color: driverOf(form.db_type).color,
                    kafka: isKafka ? { ...kafka, bootstrap_servers: kafka.bootstrap_servers.map((s) => s.trim()).filter(Boolean) } : null,
                    mqtt: isMqtt ? mqtt : null,
                    oss: isOss ? oss : null,
                    clickhouse: isClickhouse ? clickhouse : null,
                  });
                }}
              >
                保存
              </button>
            </div>
          </div>

          <aside className="conn-features" aria-label={`${activeMeta.label} 已实现功能`}>
            <div className="conn-features-head">
              <span className="conn-features-title">已实现功能</span>
              <span className="conn-features-count">{featureCount}</span>
            </div>
            <ul className="conn-feature-list">
              {activeMeta.features.map((g) => (
                <li key={g.title}>
                  <span className="conn-feature-group-title">{g.title}</span>
                  <span className="conn-feature-group-items">{g.items.join("、")}</span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    </div>
  );
}
