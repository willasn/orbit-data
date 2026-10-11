import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Download, Loader2, Play, Radio, RefreshCw, Square } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { KafkaRequest as Request, KafkaTopic as Topic, KafkaTopicDetail as Detail, KafkaMessage as Message, KafkaReadResult as ReadResult, KafkaGroup as Group, KafkaGroupDetail as GroupDetail, KafkaBrokers as Brokers } from "../types";
import "./KafkaWorkspace.css";
const id = (m: Message) => `${m.topic}:${m.partition}:${m.offset}`;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const cacheByteLimit = 16 * 1024 * 1024;
const messageSizes = new WeakMap<Message, number>();
function messageBytes(message: Message) { let size = messageSizes.get(message); if (size === undefined) { size = new TextEncoder().encode(JSON.stringify(message)).byteLength; messageSizes.set(message, size); } return size; }
function boundedMessages(previous: Message[], incoming: Message[], count: number) {
  const seen = new Set(previous.map(id));
  const combined = [...previous, ...incoming.filter(message => { const key = id(message); if (seen.has(key)) return false; seen.add(key); return true; })];
  const retained: Message[] = []; let bytes = 0;
  for (let i = combined.length - 1; i >= 0 && retained.length < count; i--) { const size = messageBytes(combined[i]); if (size > cacheByteLimit) continue; if (bytes + size > cacheByteLimit) break; bytes += size; retained.push(combined[i]); }
  return { messages: retained.reverse(), trimmed: retained.length < combined.length };
}
function integer(s: string, min = 0) { const n = Number(s); if (!Number.isSafeInteger(n) || n < min) throw new Error(`请输入不小于 ${min} 的安全整数`); return n; }
function offsetInput(s: string) { const value = s.trim().replace(/^0+(?=\d)/, ""); if (!/^\d+$/.test(value) || value.length > 19 || (value.length === 19 && value > "9223372036854775807")) throw new Error("Offset 必须为非负 i64 十进制整数"); return value; }
function binaryInput(data: string, encoding: string) { if (encoding === "hex") { const hex = data.replace(/\s/g, ""); if (!/^(?:[a-fA-F0-9]{2})*$/.test(hex)) throw new Error("Hex 必须为完整字节，如 00 ff a1"); return { encoding: "hex", data: hex }; } return { encoding: "utf8", data }; }
function payload(text: string | null, hex: string | null | undefined, format: string): string {
  if (text === null && hex == null) return "NULL / tombstone";
  if (format === "hex") return hex ?? Array.from(new TextEncoder().encode(text ?? ""), b => b.toString(16).padStart(2, "0")).join(" ");
  if (format === "json") { try { return JSON.stringify(JSON.parse(text ?? ""), null, 2); } catch { return `非 JSON 内容\n${text ?? hex ?? ""}`; } }
  return text ?? `[二进制] ${hex ?? ""}`;
}

export function KafkaWorkspace({ connId, initialTopic = "" }: { connId: string; initialTopic?: string }) {
  const connection = useStore(s => s.config?.connections.find(c => c.id === connId));
  const session = useStore(s => s.connSessions[connId]);
  const activeTab = useStore(s => s.activeTabId);
  const view = useStore(s => s.view);
  const dialog = useStore(s => s.dialogOpen);
  const [panel, setPanel] = useState("topics"), [section, setSection] = useState("messages");
  const [topics, setTopics] = useState<Topic[]>([]), [topic, setTopic] = useState(initialTopic);
  const [filter, setFilter] = useState(""), [hideInternal, setHideInternal] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [brokers, setBrokers] = useState<Brokers["brokers"]>([]);
  const [controller, setController] = useState<number | null>(null);
  const [groups, setGroups] = useState<Group[]>([]), [group, setGroup] = useState("");
  const [groupDetail, setGroupDetail] = useState<GroupDetail | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(0);
  const [reading, setReading] = useState(false), [live, setLive] = useState(false);
  const [mode, setMode] = useState("recent"), [partition, setPartition] = useState("all");
  const [limit, setLimit] = useState("100"), [position, setPosition] = useState("0"), [time, setTime] = useState("");
  const [cache, setCache] = useState(1000), [messages, setMessages] = useState<Message[]>([]);
  const [selected, setSelected] = useState<Message | null>(null), [format, setFormat] = useState("text");
  useEffect(() => { setSelected(current => current && messages.some(message => id(message) === id(current)) ? current : null); }, [messages]);
  const [key, setKey] = useState(""), [nullKey, setNullKey] = useState(true);
  const [value, setValue] = useState(""), [tombstone, setTombstone] = useState(false);
  const [producerPartition, setProducerPartition] = useState("auto"), [headers, setHeaders] = useState("[]");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newTopic, setNewTopic] = useState(""), [newPartitions, setNewPartitions] = useState("1"), [replication, setReplication] = useState("1"), [increase, setIncrease] = useState("2");
  const [resetMode, setResetMode] = useState("earliest"), [resetOffset, setResetOffset] = useState("0");
  const [resetTopic, setResetTopic] = useState(""), [resetPartition, setResetPartition] = useState("all"), [resetTime, setResetTime] = useState("");
  const [keyEncoding, setKeyEncoding] = useState("utf8"), [valueEncoding, setValueEncoding] = useState("utf8");
  const generation = useRef(0), epoch = useRef(0), inFlight = useRef(false), mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const topicRef = useRef(topic), groupRef = useRef(group); topicRef.current = topic; groupRef.current = group;
  const available = !!connection && !!session && view === "chat" && !(dialog && typeof dialog === "object" && dialog.id === connId);
  const stop = useCallback(() => { epoch.current++; if (timer.current) clearTimeout(timer.current); timer.current = null; if (mounted.current) { setLive(false); setReading(false); } }, []);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = useStore.subscribe((s, prev) => {
      const resourceChanged = s.config?.connections.find(c => c.id === connId) !== prev.config?.connections.find(c => c.id === connId) || s.connSessions[connId] !== prev.connSessions[connId];
      const suspended = s.view !== prev.view || (s.dialogOpen !== prev.dialogOpen && s.dialogOpen && typeof s.dialogOpen === "object" && s.dialogOpen.id === connId);
      if (resourceChanged || suspended) { generation.current++; stop(); }
      else if (s.activeTabId !== prev.activeTabId) stop();
    });
    return () => { mounted.current = false; generation.current++; stop(); unsubscribe(); };
  }, [connId, stop]);
  useEffect(() => { stop(); }, [panel, section, topic, group, partition, mode, limit, position, time, cache, activeTab, stop]);
  useEffect(() => { setTopic(initialTopic); }, [connId, initialTopic]);
  useEffect(() => { setTopics([]); setDetail(null); setMessages([]); setSelected(null); setGroups([]); setGroupDetail(null); setBrokers([]); setError(""); setNotice(""); }, [connId]);
  const request = useCallback(<T,>(r: Request): Promise<T> => {
    if (!available) return Promise.reject(new Error("连接已断开或正在编辑，请重新连接"));
    return api.kafkaRequest<T>(connId, r);
  }, [available, connId]);
  const run = useCallback(async <T,>(r: Request, apply: (data: T) => void | Promise<void>, guard?: () => boolean) => {
    const g = generation.current; setBusy(n => n + 1); setError("");
    try { const data = await request<T>(r); if (mounted.current && g === generation.current && (!guard || guard())) await apply(data); }
    catch (e) { if (mounted.current && g === generation.current) setError(errorText(e)); }
    finally { if (mounted.current) setBusy(n => Math.max(0, n - 1)); }
  }, [request]);
  const loadTopics = useCallback(() => run<{ topics: Topic[] }>({ action: "list_topics" }, r => { setTopics(r.topics); setTopic(t => t && r.topics.some(x => x.name === t) ? t : r.topics.find(x => !x.is_internal)?.name ?? ""); }), [run]);
  const loadDetail = useCallback(() => topic ? run<Detail>({ action: "topic_detail", topic }, r => { setDetail(r); setDraft({}); setIncrease(String(r.partitions.length + 1)); }, () => topicRef.current === topic) : Promise.resolve(), [topic, run]);
  const loadGroups = useCallback(() => run<{ groups: Group[] }>({ action: "list_groups" }, r => { setGroups(r.groups); setGroup(current => r.groups.some(g => g.group_id === current) ? current : ""); }), [run]);
  const loadGroup = useCallback(() => group ? run<GroupDetail>({ action: "group_detail", group_id: group }, setGroupDetail, () => groupRef.current === group) : Promise.resolve(), [group, run]);
  const loadBrokers = useCallback(() => run<Brokers>({ action: "brokers" }, r => { setBrokers(r.brokers); setController(r.controller_id); }), [run]);
  useEffect(() => { if (available) void loadTopics(); }, [available, connection, session, loadTopics]);
  useEffect(() => { setDetail(null); setMessages([]); setSelected(null); if (available && topic) void loadDetail(); }, [topic, available, connection, session, loadDetail]);
  useEffect(() => { setGroups([]); setBrokers([]); if (available && panel === "groups") void loadGroups(); if (available && panel === "brokers") void loadBrokers(); }, [available, connection, session, panel, loadGroups, loadBrokers]);
  useEffect(() => { setGroupDetail(null); setResetTopic(""); setResetPartition("all"); if (available && group) void loadGroup(); }, [group, available, connection, session, loadGroup]);
  async function confirm(title: string, target: string, warning: string, r: Request, after?: () => Promise<void>) {
    if (!available || !target) return; stop(); const g = generation.current, e = epoch.current;
    const entered = await useStore.getState().askText({ title, message: `${warning}\n请输入 ${target} 确认。`, expect: target, danger: true, confirmText: "确认执行" });
    if (entered === target && mounted.current && g === generation.current && e === epoch.current) await run<unknown>({ ...r, confirm: target }, async result => {
      if (r.action === "produce") {
        if (result && typeof result === "object" && "partition" in result && "offset" in result && typeof result.partition === "number" && typeof result.offset === "string") setNotice(`消息已交付：${target} / P${result.partition} / Offset ${result.offset}`);
        else setNotice("发送请求已返回，但缺少有效交付回执；请勿重复发送，先检查消息。");
      } else setNotice(`${title}成功`);
      if (after) await after();
    }, () => e === epoch.current);
  }
  function validate(action: () => void) { try { action(); } catch (e) { setError(errorText(e)); } }
  async function read(listen: boolean) {
    if (inFlight.current) { setNotice("上一批请求正在结束，请稍后再开始；停止后返回的数据会被丢弃。"); return; }
    if (!available || !topic) return; stop(); setError(""); setNotice(""); setMessages([]); setSelected(null);
    const e = epoch.current, g = generation.current; let initial: Request;
    try {
      const n = integer(limit, 1); if (n > 500) throw new Error("每批最多读取 500 条");
      initial = { action: "read", topic, partitions: partition === "all" ? undefined : [integer(partition)], start: listen ? "latest" : mode, limit: n, timeout_ms: 1000 };
      if (!listen && mode === "recent") initial.recent = n;
      if (!listen && mode === "offset") initial.offset = offsetInput(position);
      if (!listen && mode === "timestamp") { const ms = new Date(time).getTime(); if (!Number.isFinite(ms)) throw new Error("请选择有效时间"); initial.timestamp = String(ms); }
    } catch (err) { setError(errorText(err)); return; }
    setReading(true); setLive(listen);
    const valid = () => mounted.current && e === epoch.current && g === generation.current;
    let retained: Message[] = [];
    const poll = async (r: Request) => {
      if (!valid() || inFlight.current) return; inFlight.current = true;
      try {
        const data = await request<ReadResult>(r); if (!valid()) return;
        const bounded = boundedMessages(retained, data.messages, cache); retained = bounded.messages; setMessages(retained);
        const hints = [...(data.warnings ?? [])];
        if (data.truncated) hints.push("单批读取达到上限");
        if (bounded.trimmed) hints.push(`缓存已裁剪：最多 ${cache} 条 / 16 MiB，超大消息不保留`);
        if (hints.length) setNotice(hints.join("；"));
        if (listen) { if (!data.next_offsets || !Object.keys(data.next_offsets).length) throw new Error("未返回读取游标，监听已停止"); timer.current = setTimeout(() => { void poll({ ...initial, start: "offset", offsets: data.next_offsets }); }, 1500); }
        else setReading(false);
      } catch (err) { if (valid()) { setError(errorText(err)); stop(); } }
      finally { inFlight.current = false; }
    };
    await poll(initial);
  }
  async function copy(text: string) {
    const g = generation.current;
    try { await navigator.clipboard.writeText(text); if (mounted.current && g === generation.current) setNotice("已复制到剪贴板；内容可能含业务敏感数据，请谨慎分享。"); }
    catch (err) { if (mounted.current && g === generation.current) setError(`复制失败：${errorText(err)}`); }
  }
  async function exportMessages() {
    const g = generation.current, e = epoch.current;
    const approved = await useStore.getState().askConfirm({ title: "导出消息", message: "JSON 文件包含完整 Key、Value、Headers 和业务数据，可能包含敏感信息。请妥善保管，避免上传到不可信位置。", confirmText: "导出到本地" });
    if (!approved || !mounted.current || g !== generation.current || e !== epoch.current) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ topic, exported_at: new Date().toISOString(), messages }, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `kafka-${topic.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function produce() { validate(() => {
    const h: unknown = JSON.parse(headers);
    if (!Array.isArray(h) || !h.every(x => x && typeof x === "object" && typeof x.key === "string" && (typeof x.value === "string" || x.value === null))) throw new Error('Headers 格式应为 [{"key":"name","value":"text"}]');
    if (tombstone && nullKey) throw new Error("Tombstone 必须指定 Key");
    void confirm("发送消息", topic, "真实写入且无法撤回；tombstone 可能删除 compact 主题的对应 Key。", { action: "produce", topic, partition: producerPartition === "auto" ? undefined : integer(producerPartition), key: nullKey ? null : binaryInput(key, keyEncoding), value: tombstone ? null : binaryInput(value, valueEncoding), headers: h.map(x => ({ key: x.key, value: x.value === null ? null : binaryInput(x.value, "utf8") })) });
  }); }
  function resetGroup() { validate(() => {
    const targets = groupDetail?.offsets.filter(o => o.topic === resetTopic && (resetPartition === "all" || o.partition === integer(resetPartition))) ?? [];
    if (!targets.length) throw new Error("请选择消费组已提交位点中的 Topic 和分区");
    const ms = new Date(resetTime).getTime();
    if (resetMode === "timestamp" && !Number.isFinite(ms)) throw new Error("请选择有效重置时间");
    const destination = resetMode === "offset" ? offsetInput(resetOffset) : resetMode === "timestamp" ? resetTime : resetMode;
    void confirm("重置消费位点", group, `仅重置以下范围到 ${destination}：\n${targets.map(o => `${o.topic} / P${o.partition}（当前 ${o.offset ?? "未提交"}）`).join("\n")}\n可能重放或跳过消息。`, { action: "reset_group_offsets", group_id: group, topic: resetTopic, partitions: targets.map(o => o.partition), start: resetMode, offset: resetMode === "offset" ? offsetInput(resetOffset) : undefined, timestamp: resetMode === "timestamp" ? String(ms) : undefined }, loadGroup);
  }); }
  const resetTopics = [...new Set(groupDetail?.offsets.map(o => o.topic) ?? [])];
  const disabled = !available || busy > 0;
  const inactive = !!groupDetail && ["empty", "dead"].includes(groupDetail.state.toLowerCase()) && groupDetail.members.length === 0;
  const partitions = detail?.partitions ?? [];
  const partitionOptions = partitions.map(p => <option key={p.partition} value={p.partition}>分区 {p.partition}</option>);
  return <div className="kafka-workspace">
    <header className="kafka-header"><span className="kafka-logo"><Radio size={20} /></span><div className="kafka-heading"><h2>Kafka 工作区 <span className="kafka-badge">{connection?.name ?? "连接不存在"}</span></h2><p>主题 · 消息 · 集群 · 消费组</p></div><span className={`kafka-badge ${live ? "live" : ""}`}>{live ? "正在监听" : "不提交消费位点"}</span>{busy > 0 && <Loader2 size={14} className="kafka-spin" />}<button disabled={disabled} onClick={() => void (panel === "topics" ? loadTopics() : panel === "groups" ? loadGroups() : loadBrokers())}><RefreshCw size={13} />刷新</button></header>
    <nav className="kafka-nav">{[["topics", "Topics"], ["brokers", "Brokers"], ["groups", "消费组"]].map(([p, label]) => <button key={p} className={panel === p ? "active" : ""} onClick={() => setPanel(p)}>{label}</button>)}</nav>
    {!available && <div className="kafka-alert info">连接不可用或正在编辑。监听已停止，请从左栏重新连接。</div>}
    {error && <div className="kafka-alert" role="alert"><span>{error}</span><button onClick={() => setError("")} aria-label="关闭错误">×</button></div>}
    {notice && <div className="kafka-alert info" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示">×</button></div>}
    <div className="kafka-body">
      {panel === "topics" && <><aside className="kafka-sidebar"><div className="kafka-sidebar-top">主题目录 · {topics.length}</div><input aria-label="筛选主题" placeholder="搜索 topic…" value={filter} onChange={e => setFilter(e.target.value)} /><label className="kafka-check"><input type="checkbox" checked={hideInternal} onChange={e => setHideInternal(e.target.checked)} />隐藏内部主题</label><div className="kafka-topic-list">{topics.filter(t => (!hideInternal || !t.is_internal) && t.name.toLowerCase().includes(filter.toLowerCase())).map(t => <button key={t.name} className={topic === t.name ? "active" : ""} title={t.name} onClick={() => setTopic(t.name)}><span className="kafka-topic-name">{t.name}</span><span className="kafka-badge">{t.partitions}</span></button>)}</div><button onClick={() => setSection("manage")}>＋ 新建 / 管理</button></aside>
        <main className="kafka-main"><div className="kafka-topic-header"><div><h3>{topic || "选择 Topic"}</h3><p>{partitions.length} 个分区</p></div><button disabled={disabled || !topic} onClick={() => void loadDetail()}>刷新元数据</button></div><div className="kafka-subnav">{[["messages", "消息"], ["partitions", "分区"], ["config", "配置"], ["produce", "生产消息"], ["manage", "管理"]].map(([s, text]) => <button key={s} className={s === section ? "active" : ""} onClick={() => setSection(s)}>{text}</button>)}</div><div className="kafka-content">
          {section === "messages" && <><div className="kafka-toolbar"><select aria-label="读取起点" value={mode} disabled={reading} onChange={e => setMode(e.target.value)}><option value="recent">最近 N 条 / 分区</option><option value="earliest">最早可用</option><option value="latest">当前末尾（无历史）</option><option value="offset">指定 Offset</option><option value="timestamp">指定时间</option></select><select aria-label="读取分区" value={partition} disabled={reading} onChange={e => setPartition(e.target.value)}><option value="all">全部分区</option>{partitionOptions}</select><label>上限<input aria-label="批次上限" type="number" min="1" max="500" value={limit} disabled={reading} onChange={e => setLimit(e.target.value)} /></label>{mode === "offset" && <input aria-label="Offset" value={position} disabled={reading} onChange={e => setPosition(e.target.value)} />}{mode === "timestamp" && <input aria-label="时间" type="datetime-local" value={time} disabled={reading} style={{ width: 190 }} onChange={e => setTime(e.target.value)} />}<button className="primary" disabled={disabled || reading || !topic} onClick={() => void read(false)}><Play size={12} />读取</button>{reading ? <button className="danger" onClick={stop}><Square size={12} />停止{live ? "监听" : ""}</button> : <button disabled={disabled || !topic} onClick={() => void read(true)}><Activity size={12} />从现在监听</button>}</div><p className="kafka-note">最近 N 按每个分区末尾向前定位，单批总数有界；监听仅接收启动后的新消息。独立只读消费，不加入消费组、不提交 offset。消息不会自动发送给 AI。</p><div className="kafka-toolbar"><span className="kafka-note">{messages.length} 条本地消息 · 最大 16 MiB</span><span className="kafka-spacer" /><label>缓存<select value={cache} disabled={reading} onChange={e => setCache(Number(e.target.value))}><option value={500}>500 条</option><option value={1000}>1000 条</option></select></label><button disabled={reading || !messages.length} onClick={() => { setMessages([]); setSelected(null); }}>清空</button><button disabled={!messages.length} onClick={exportMessages}><Download size={12} />导出 JSON</button></div><div className="kafka-table-wrap"><table className="kafka-table"><thead><tr><th>分区</th><th>Offset</th><th>时间</th><th>Key</th><th>Value</th></tr></thead><tbody>{messages.map(m => <tr key={id(m)} className={`selectable ${selected && id(selected) === id(m) ? "selected" : ""}`} onClick={() => setSelected(m)} tabIndex={0} onKeyDown={e => { if (e.key === "Enter") setSelected(m); }}><td>{m.partition}</td><td>{m.offset}</td><td>{m.timestamp === null ? "—" : new Date(m.timestamp).toLocaleString()}</td><td>{m.key ?? (m.key_hex != null ? "[二进制]" : "NULL")}</td><td>{(m.value ?? (m.value_hex != null ? "[二进制]" : "tombstone")).slice(0, 220)}</td></tr>)}</tbody></table>{!messages.length && <div className="kafka-empty"><Radio size={22} />{reading ? "等待消息…" : "选择起点读取，或从现在监听"}</div>}</div>{selected && <div className="kafka-detail"><div className="kafka-detail-top"><span>P{selected.partition} / Offset {selected.offset}</span><button onClick={() => void copy(payload(selected.key, selected.key_hex, format))}>复制 Key</button><button onClick={() => void copy(payload(selected.value, selected.value_hex, format))}>复制 Value</button><button onClick={() => void copy(JSON.stringify(selected.headers, null, 2))}>复制 Headers</button><select aria-label="显示格式" value={format} onChange={e => setFormat(e.target.value)}><option value="text">Text</option><option value="hex">Hex</option><option value="json">JSON</option></select></div><div className="kafka-payload"><div><h4>Key</h4><pre>{payload(selected.key, selected.key_hex, format)}</pre></div><div><h4>Value</h4><pre>{payload(selected.value, selected.value_hex, format)}</pre></div></div><div className="kafka-headers">Headers · {selected.headers?.length ?? 0}{selected.headers?.map((h, i) => <div key={i}>{h.key}: {payload(h.value, h.value_hex, format)}</div>)}</div></div>}</>}
          {section === "partitions" && <><p className="kafka-note">High 是下一条可写入的 offset；当前可用消息范围为 [Low, High)。</p><div className="kafka-table-wrap"><table className="kafka-table"><thead><tr>{["分区", "Leader", "Replicas", "ISR", "Low", "High"].map(t => <th key={t}>{t}</th>)}</tr></thead><tbody>{partitions.map(p => <tr key={p.partition}><td>{p.partition}</td><td>{p.leader}</td><td>{p.replicas.join(", ")}</td><td>{p.isr.join(", ")}</td><td>{p.low ?? "—"}</td><td>{p.high ?? "—"}</td></tr>)}</tbody></table></div></>}
          {section === "config" && <><p className="kafka-note">只读及敏感配置不可修改。动态配置改动需手输 Topic 名确认。</p><div className="kafka-table-wrap"><table className="kafka-table"><thead><tr><th>名称</th><th>值</th><th>来源</th><th>权限</th></tr></thead><tbody>{detail?.configs.map(c => <tr key={c.name}><td>{c.name}</td><td>{c.is_sensitive ? "••••••" : c.is_read_only ? c.value ?? "NULL" : <input className="kafka-config-value" aria-label={c.name} disabled={disabled} value={draft[c.name] ?? c.value ?? ""} onChange={e => setDraft(d => ({ ...d, [c.name]: e.target.value }))} />}</td><td>{c.source ?? "—"}</td><td>{c.is_read_only || c.is_sensitive ? "只读" : "可修改"}</td></tr>)}</tbody></table></div><button className="danger" disabled={disabled || !topic || !Object.keys(draft).length} onClick={() => void confirm("修改主题配置", topic, "Retention 等设置可能导致历史消息丢失。", { action: "alter_config", topic, configs: draft }, loadDetail)}>确认保存修改</button></>}
          {section === "produce" && <div className="kafka-card"><h3>生产一条消息</h3><div className="kafka-form"><label>分区<select value={producerPartition} onChange={e => setProducerPartition(e.target.value)}><option value="auto">自动分区</option>{partitionOptions}</select></label><label className="kafka-check"><input type="checkbox" checked={tombstone} onChange={e => setTombstone(e.target.checked)} />Tombstone / Value = null</label><label className="wide">Key<select aria-label="Key 编码" value={keyEncoding} onChange={e => setKeyEncoding(e.target.value)}><option value="utf8">Text · UTF-8</option><option value="hex">Hex · 二进制</option></select><input disabled={nullKey} value={key} onChange={e => setKey(e.target.value)} /></label><label className="kafka-check wide"><input type="checkbox" checked={nullKey} onChange={e => setNullKey(e.target.checked)} />Key = null（与空字符串不同）</label><label className="wide">Value<select aria-label="Value 编码" value={valueEncoding} onChange={e => setValueEncoding(e.target.value)}><option value="utf8">Text · UTF-8</option><option value="hex">Hex · 二进制</option></select><textarea disabled={tombstone} value={value} onChange={e => setValue(e.target.value)} placeholder="文本或 JSON，不自动转换" /></label><label className="wide">Headers · JSON 数组<textarea value={headers} onChange={e => setHeaders(e.target.value)} placeholder={'[{"key":"name","value":"text"}]'} /></label></div><div className="kafka-actions"><button className="primary" disabled={disabled || !topic} onClick={produce}>确认后发送</button><span className="kafka-note kafka-warning">真实写入且无法撤回</span></div></div>}
          {section === "manage" && <><div className="kafka-card"><h3>新建 Topic</h3><div className="kafka-form"><label className="wide">名称<input value={newTopic} onChange={e => setNewTopic(e.target.value)} /></label><label>分区数<input type="number" min="1" value={newPartitions} onChange={e => setNewPartitions(e.target.value)} /></label><label>副本因子<input type="number" min="1" value={replication} onChange={e => setReplication(e.target.value)} /></label></div><div className="kafka-actions"><button disabled={disabled || !newTopic.trim()} onClick={() => validate(() => { void confirm("创建主题", newTopic.trim(), "将创建新的 Topic。", { action: "create_topic", topic: newTopic.trim(), partitions: integer(newPartitions, 1), replication_factor: integer(replication, 1) }, loadTopics); })}>确认创建</button></div></div>{topic && <><div className="kafka-card"><h3>增加分区 · {topic}</h3><div className="kafka-toolbar"><label>目标总分区数<input type="number" value={increase} onChange={e => setIncrease(e.target.value)} /></label><button disabled={disabled} onClick={() => validate(() => { void confirm("增加分区", topic, "分区只能增加，无法撤销；可能改变按 Key 分区的消息顺序。", { action: "increase_partitions", topic, partitions: integer(increase, partitions.length + 1) }, loadDetail); })}>确认增加</button></div></div><div className="kafka-card"><h3>删除 Topic</h3><p className="kafka-note kafka-warning">永久删除主题及全部消息，此操作无法恢复。</p><div className="kafka-actions"><button className="danger" disabled={disabled} onClick={() => void confirm("删除主题", topic, "主题及所有分区消息将永久删除。", { action: "delete_topic", topic }, loadTopics)}>删除 {topic}</button></div></div></>}</>}
        </div></main></>}
      {panel === "brokers" && <main className="kafka-main"><div className="kafka-topic-header"><div><h3>集群节点</h3><p>{brokers.length} 个 Broker · Controller {controller ?? "—"}</p></div></div><div className="kafka-content"><div className="kafka-table-wrap"><table className="kafka-table"><thead><tr><th>ID</th><th>Host</th><th>Port</th><th>角色</th></tr></thead><tbody>{brokers.map(b => <tr key={b.id}><td>{b.id}</td><td>{b.host}</td><td>{b.port}</td><td>{b.id === controller ? "Controller" : "Broker"}</td></tr>)}</tbody></table></div></div></main>}
      {panel === "groups" && <main className="kafka-main"><div className="kafka-topic-header"><div><h3>消费组</h3><p>浏览 committed offsets 与 lag；仅允许无成员的 inactive 组执行管理操作。</p></div></div><div className="kafka-content"><div className="kafka-table-wrap"><table className="kafka-table"><thead><tr><th>Group ID</th><th>状态</th><th>协议</th></tr></thead><tbody>{groups.map(g => <tr key={g.group_id} className={`selectable ${group === g.group_id ? "selected" : ""}`} onClick={() => setGroup(g.group_id)}><td>{g.group_id}</td><td>{g.state ?? "—"}</td><td>{g.protocol_type ?? "—"}</td></tr>)}</tbody></table>{!groups.length && <div className="kafka-empty">暂无消费组</div>}</div>{groupDetail && <><div className="kafka-toolbar"><strong>{group}</strong><span className="kafka-badge">{groupDetail.state}</span><span className="kafka-note">{groupDetail.members.length} 个成员</span><span className="kafka-spacer" /><button disabled={disabled} onClick={() => void loadGroup()}>刷新详情</button></div><div className="kafka-table-wrap"><table className="kafka-table"><thead><tr>{["Topic", "分区", "Committed", "High", "Lag"].map(t => <th key={t}>{t}</th>)}</tr></thead><tbody>{groupDetail.offsets.map(o => <tr key={`${o.topic}:${o.partition}`}><td>{o.topic}</td><td>{o.partition}</td><td>{o.offset ?? "未提交"}</td><td>{o.high}</td><td>{o.lag ?? "—"}</td></tr>)}</tbody></table></div>{groupDetail.members.length > 0 && <div className="kafka-table-wrap"><table className="kafka-table"><thead><tr><th>成员 ID</th><th>Client ID</th><th>Host</th><th>分配</th></tr></thead><tbody>{groupDetail.members.map(m => <tr key={m.id}><td>{m.id}</td><td>{m.client_id}</td><td>{m.client_host}</td><td title={JSON.stringify(m.assignment)}>{JSON.stringify(m.assignment ?? [])}</td></tr>)}</tbody></table></div>}<div className="kafka-card"><h3>消费组管理</h3><p className="kafka-note kafka-warning">重置会修改消费组提交位点，可能导致重放或跳过消息。删除会移除消费组记录。不活跃状态仍由后端再次校验。</p><div className="kafka-actions"><select aria-label="重置 Topic" value={resetTopic} onChange={e => { setResetTopic(e.target.value); setResetPartition("all"); }}><option value="">选择 Topic…</option>{resetTopics.map(t => <option key={t} value={t}>{t}</option>)}</select><select aria-label="重置分区" value={resetPartition} onChange={e => setResetPartition(e.target.value)}><option value="all">所选 Topic 全部分区</option>{groupDetail.offsets.filter(o => o.topic === resetTopic).map(o => <option key={o.partition} value={o.partition}>分区 {o.partition}</option>)}</select><select aria-label="重置目标" value={resetMode} onChange={e => setResetMode(e.target.value)}><option value="earliest">重置到最早</option><option value="latest">重置到末尾</option><option value="offset">指定 Offset</option><option value="timestamp">指定时间</option></select>{resetMode === "timestamp" && <input aria-label="重置时间" type="datetime-local" value={resetTime} onChange={e => setResetTime(e.target.value)} />}{resetMode === "offset" && <input aria-label="重置 offset" value={resetOffset} onChange={e => setResetOffset(e.target.value)} />}<button className="danger" disabled={disabled || !inactive || !resetTopic || !groupDetail.offsets.length} onClick={resetGroup}>确认重置</button><button className="danger" disabled={disabled || !inactive} onClick={() => void confirm("删除消费组", group, "将永久删除此消费组记录。", { action: "delete_group", group_id: group }, loadGroups)}>删除消费组</button>{!inactive && <span className="kafka-note">仅 Empty / Dead 且无成员时可操作</span>}</div></div></>}</div></main>}
    </div>
  </div>;
}
export default KafkaWorkspace;
