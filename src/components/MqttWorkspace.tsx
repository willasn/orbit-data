import { useEffect, useMemo, useRef, useState } from "react";
import { Eraser, Plus, RefreshCw, Search, Send, Wifi, WifiOff, X } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { MqttConfig, MqttMessage } from "../types";
import "./MqttWorkspace.css";

interface Sub {
  topic: string;
  qos: number;
  color: string;
  enabled: boolean;
}

type Direction = "all" | "received" | "sent";
type PayloadFormat = "plaintext" | "json" | "base64" | "hex";
type ViewFormat = "auto" | "text" | "json" | "hex";

interface Draft {
  topic: string;
  qos: number;
  retain: boolean;
  format: PayloadFormat;
  payload: string;
}

const PALETTE = ["#ff8c42", "#3b82f6", "#22c55e", "#a855f7", "#ef4444", "#14b8a6", "#eab308", "#ec4899"];

const emptyDraft = (): Draft => ({ topic: "", qos: 0, retain: false, format: "plaintext", payload: "" });

const SUBS_KEY = (id: string) => `orbit-data.mqtt.subs.${id}`;
const DRAFT_KEY = (id: string) => `orbit-data.mqtt.draft.${id}`;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "null");
    return raw ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 本地存储不可用时仅影响记忆，不影响使用 */
  }
}

/** MQTT 通配符匹配：+ 单层，# 多层 */
function topicMatches(topic: string, filter: string): boolean {
  if (!filter) return true;
  const t = topic.split("/");
  const f = filter.split("/");
  for (let i = 0; i < f.length; i += 1) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return t.length === f.length;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function formatPayload(msg: MqttMessage, view: ViewFormat): string {
  if (view === "hex") return msg.payload_hex;
  if (view === "text") return msg.payload;
  try {
    const parsed: unknown = JSON.parse(msg.payload);
    if (view === "json" || (parsed !== null && typeof parsed === "object")) {
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    /* 非 JSON 时按原文显示 */
  }
  return msg.payload;
}

export function MqttWorkspace({ connId }: { connId: string }) {
  const connection = useStore((s) => s.config?.connections.find((c) => c.id === connId));
  const session = useStore((s) => s.connSessions[connId]);
  const connectDb = useStore((s) => s.connectDb);
  const disconnectDb = useStore((s) => s.disconnectDb);
  const showToast = useStore((s) => s.showToast);

  const cfg: MqttConfig = connection?.mqtt ?? {
    protocol: "mqtt", client_id: "", mqtt_version: "5.0", keep_alive_secs: 60,
    clean_start: true, session_expiry_secs: 0, connection_timeout_secs: 10, path: "/mqtt",
    ca_file: "", client_cert_file: "", client_key_file: "",
    will_topic: "", will_payload: "", will_qos: 0, will_retain: false,
  };

  const [subs, setSubs] = useState<Sub[]>(() => loadJson<Sub[]>(SUBS_KEY(connId), []));
  const [selected, setSelected] = useState("");
  const [messages, setMessages] = useState<MqttMessage[]>([]);
  const [status, setStatus] = useState({ connected: !!session, error: "" });
  const [direction, setDirection] = useState<Direction>("all");
  const [search, setSearch] = useState("");
  const [viewFormat, setViewFormat] = useState<ViewFormat>("auto");
  const [autoScroll, setAutoScroll] = useState(true);
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState<Draft>(() => ({ ...emptyDraft(), ...loadJson<Partial<Draft>>(DRAFT_KEY(connId), {}) }));
  const [sending, setSending] = useState(false);

  const [subOpen, setSubOpen] = useState(false);
  const [subTopic, setSubTopic] = useState("");
  const [subQos, setSubQos] = useState(0);

  const sinceRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const subscribedRef = useRef<Set<string>>(new Set());
  const subsRef = useRef(subs);
  const wasConnectedRef = useRef(!!session);

  useEffect(() => {
    subsRef.current = subs;
  }, [subs]);

  // 订阅列表与发布草稿按连接持久化
  useEffect(() => saveJson(SUBS_KEY(connId), subs), [connId, subs]);
  useEffect(() => saveJson(DRAFT_KEY(connId), draft), [connId, draft]);

  // 连接就绪后自动恢复启用的订阅（重连后也会重新订阅）
  useEffect(() => {
    if (!session) {
      subscribedRef.current.clear();
      setStatus({ connected: false, error: "" });
      return;
    }
    setStatus((s) => ({ ...s, connected: true }));
    subs.filter((s) => s.enabled && !subscribedRef.current.has(s.topic)).forEach((s) => {
      void api.mqttSubscribe(connId, s.topic, s.qos)
        .then(() => subscribedRef.current.add(s.topic))
        .catch((e) => showToast(`订阅 ${s.topic} 失败: ${e}`));
    });
  }, [connId, session, subs, showToast]);

  // 增量轮询消息（500ms），同时刷新连接状态
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const tick = async () => {
      try {
        const page = await api.mqttMessages(connId, sinceRef.current);
        if (!alive) return;
        sinceRef.current = page.last_seq;
        setStatus({ connected: page.connected, error: page.error });
        // 断线重连后 Broker 侧会话可能已重建，重新订阅启用中的主题
        if (!page.connected) {
          subscribedRef.current.clear();
        } else if (!wasConnectedRef.current) {
          subscribedRef.current.clear();
          subsRef.current.filter((s) => s.enabled).forEach((s) => {
            void api.mqttSubscribe(connId, s.topic, s.qos)
              .then(() => subscribedRef.current.add(s.topic))
              .catch((e) => showToast(`重新订阅 ${s.topic} 失败: ${e}`));
          });
        }
        wasConnectedRef.current = page.connected;
        if (page.reset) {
          setMessages(page.messages.slice(-1000));
        } else if (page.messages.length) {
          setMessages((prev) => [...prev, ...page.messages].slice(-1000));
        }
      } catch (e) {
        if (alive) setStatus({ connected: false, error: String(e) });
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [connId, session]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return messages.filter((m) => {
      if (direction === "received" && m.sent) return false;
      if (direction === "sent" && !m.sent) return false;
      if (selected && !topicMatches(m.topic, selected)) return false;
      if (term && !m.topic.toLowerCase().includes(term) && !m.payload.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [messages, direction, selected, search]);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  const addSubscription = async () => {
    const topics = subTopic.split(",").map((t) => t.trim()).filter(Boolean);
    if (!topics.length) {
      showToast("请输入订阅主题");
      return;
    }
    const next = [...subs];
    for (const topic of topics) {
      if (next.some((s) => s.topic === topic)) continue;
      next.push({ topic, qos: subQos, color: PALETTE[next.length % PALETTE.length], enabled: true });
      if (session) {
        try {
          await api.mqttSubscribe(connId, topic, subQos);
          subscribedRef.current.add(topic);
        } catch (e) {
          showToast(`订阅 ${topic} 失败: ${e}`);
        }
      }
    }
    setSubs(next);
    setSubTopic("");
    setSubOpen(false);
  };

  const removeSubscription = async (sub: Sub) => {
    setSubs((prev) => prev.filter((s) => s.topic !== sub.topic));
    subscribedRef.current.delete(sub.topic);
    if (selected === sub.topic) setSelected("");
    if (session) await api.mqttUnsubscribe(connId, sub.topic).catch((e) => showToast(`取消订阅失败: ${e}`));
  };

  const toggleSubscription = async (sub: Sub) => {
    const enabled = !sub.enabled;
    setSubs((prev) => prev.map((s) => (s.topic === sub.topic ? { ...s, enabled } : s)));
    if (!session) return;
    if (enabled) {
      await api.mqttSubscribe(connId, sub.topic, sub.qos)
        .then(() => subscribedRef.current.add(sub.topic))
        .catch((e) => showToast(`订阅失败: ${e}`));
    } else {
      subscribedRef.current.delete(sub.topic);
      await api.mqttUnsubscribe(connId, sub.topic).catch((e) => showToast(`取消订阅失败: ${e}`));
    }
  };

  const publish = async () => {
    if (!draft.topic.trim()) {
      showToast("请输入发布主题");
      return;
    }
    setSending(true);
    try {
      await api.mqttPublish(connId, draft.topic.trim(), draft.qos, draft.retain, draft.payload, draft.format);
      showToast("已发布");
    } catch (e) {
      showToast(`发布失败: ${e}`);
    } finally {
      setSending(false);
    }
  };

  const reconnect = async () => {
    setBusy(true);
    try {
      await disconnectDb(connId).catch(() => undefined);
      await connectDb(connId);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制");
    } catch {
      showToast("复制失败，请手动选择文本");
    }
  };

  if (!connection) return <div className="empty-hint center">连接不存在</div>;

  const connected = status.connected;

  return (
    <div className="mqtt-ws">
      <div className="mqtt-head">
        <div className="mqtt-title">
          <span className={`mqtt-dot${connected ? " on" : ""}`} />
          <span className="mqtt-name">{connection.name}</span>
          <span className="mqtt-meta">
            {cfg.protocol}://{connection.host}:{connection.port} · MQTT {cfg.mqtt_version}
            {cfg.client_id ? ` · ${cfg.client_id}` : ""}
          </span>
        </div>
        <div className="mqtt-head-actions">
          <button className="btn" disabled={busy || !session} onClick={() => void reconnect()} title="断开并重新连接">
            <RefreshCw size={13} /> {busy ? "重连中…" : "重连"}
          </button>
          <button className="btn" disabled={!session} onClick={() => void disconnectDb(connId)}>断开</button>
          <button className="btn" disabled={!connected} onClick={() => setSubOpen(true)}>
            <Plus size={13} /> 新建订阅
          </button>
        </div>
      </div>

      {!connected && (
        <div className="mqtt-banner">
          <WifiOff size={14} />
          <span>{status.error ? `连接异常：${status.error}` : "连接已断开，消息收发不可用。"}</span>
          <button className="btn" disabled={busy} onClick={() => void reconnect()}>重新连接</button>
        </div>
      )}

      <div className="mqtt-body">
        <aside className="mqtt-subs">
          <div className="mqtt-subs-head">
            <span>订阅 <b>{subs.length}</b></span>
            <button className="icon-btn" title="新建订阅" onClick={() => setSubOpen(true)}><Plus size={14} /></button>
          </div>
          <div className="mqtt-sub-list">
            {subs.length === 0 && <div className="mqtt-hint">还没有订阅，点击 + 添加主题</div>}
            {subs.map((sub) => (
              <div
                key={sub.topic}
                className={`mqtt-sub${selected === sub.topic ? " active" : ""}${sub.enabled ? "" : " disabled"}`}
                onClick={() => setSelected(selected === sub.topic ? "" : sub.topic)}
                title={`${sub.topic} · QoS ${sub.qos}`}
              >
                <span className="mqtt-sub-color" style={{ background: sub.color }} />
                <span className="mqtt-sub-topic">{sub.topic}</span>
                <span className="mqtt-qos">Q{sub.qos}</span>
                <button className="mqtt-mini" title={sub.enabled ? "禁用订阅" : "启用订阅"}
                  onClick={(e) => { e.stopPropagation(); void toggleSubscription(sub); }}>
                  {sub.enabled ? <Wifi size={12} /> : <WifiOff size={12} />}
                </button>
                <button className="mqtt-mini" title="删除订阅"
                  onClick={(e) => { e.stopPropagation(); void removeSubscription(sub); }}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          <div className="mqtt-hint">点击订阅筛选消息，再次点击取消</div>
        </aside>

        <section className="mqtt-main">
          <div className="mqtt-toolbar">
            <div className="mqtt-seg">
              {(["all", "received", "sent"] as const).map((d) => (
                <button key={d} className={direction === d ? "on" : ""} onClick={() => setDirection(d)}>
                  {d === "all" ? "全部" : d === "received" ? "接收" : "发送"}
                </button>
              ))}
            </div>
            <label className="mqtt-search">
              <Search size={13} />
              <input value={search} placeholder="搜索主题或内容" onChange={(e) => setSearch(e.target.value)} />
            </label>
            <select value={viewFormat} onChange={(e) => setViewFormat(e.target.value as ViewFormat)} title="显示格式">
              <option value="auto">自动</option>
              <option value="text">文本</option>
              <option value="json">JSON</option>
              <option value="hex">Hex</option>
            </select>
            <label className="mqtt-check">
              <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
              自动滚动
            </label>
            <span className="mqtt-count">{filtered.length} / {messages.length}</span>
            <button className="mqtt-mini wide" title="清空消息缓冲"
              onClick={() => {
                setMessages([]);
                if (session) void api.mqttClear(connId).catch((e) => showToast(`清空失败: ${e}`));
              }}>
              <Eraser size={13} /> 清空
            </button>
          </div>

          <div className="mqtt-messages" ref={listRef}>
            {filtered.length === 0 && (
              <div className="mqtt-empty">
                <Wifi size={20} />
                <span>暂无消息。订阅主题后，接收与发布的消息会显示在这里。</span>
              </div>
            )}
            {filtered.map((m) => (
              <div key={m.seq} className={`mqtt-msg${m.sent ? " sent" : ""}`}>
                <div className="mqtt-msg-head">
                  <span className={`mqtt-dir${m.sent ? " out" : ""}`}>{m.sent ? "↑" : "↓"}</span>
                  <span className="mqtt-msg-topic">{m.topic}</span>
                  <span className="mqtt-badge">QoS {m.qos}</span>
                  {m.retain && <span className="mqtt-badge retain">Retain</span>}
                  <span className="mqtt-msg-time">{formatTime(m.ts)}</span>
                  <span className="mqtt-msg-size">{m.size} B</span>
                  <button className="mqtt-mini" title="复制 Payload" onClick={() => void copy(m.payload)}>复制</button>
                </div>
                <pre className="mqtt-msg-payload">{formatPayload(m, viewFormat)}</pre>
              </div>
            ))}
          </div>

          <div className="mqtt-publish">
            <div className="mqtt-publish-row">
              <input className="mqtt-topic-input" value={draft.topic} placeholder="发布主题，例如 sensors/room1/temp"
                onChange={(e) => setDraft({ ...draft, topic: e.target.value })} list="mqtt-sub-topics" />
              <datalist id="mqtt-sub-topics">
                {subs.map((s) => <option key={s.topic} value={s.topic} />)}
              </datalist>
              <select value={draft.qos} onChange={(e) => setDraft({ ...draft, qos: Number(e.target.value) })}
                title="QoS">
                {[0, 1, 2].map((q) => <option key={q} value={q}>QoS {q}</option>)}
              </select>
              <label className="mqtt-check">
                <input type="checkbox" checked={draft.retain} onChange={(e) => setDraft({ ...draft, retain: e.target.checked })} />
                Retain
              </label>
              <select value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value as PayloadFormat })}
                title="Payload 格式">
                <option value="plaintext">Plaintext</option>
                <option value="json">JSON</option>
                <option value="base64">Base64</option>
                <option value="hex">Hex</option>
              </select>
              <button className="btn primary" disabled={sending || !connected} onClick={() => void publish()}>
                <Send size={13} /> {sending ? "发送中…" : "发送"}
              </button>
            </div>
            <textarea
              className="mqtt-payload-input"
              rows={4}
              value={draft.payload}
              placeholder="Payload（⌘/Ctrl + Enter 发送）"
              onChange={(e) => setDraft({ ...draft, payload: e.target.value })}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void publish();
                }
              }}
            />
          </div>
        </section>
      </div>

      {subOpen && (
        <div className="modal-mask" onClick={() => setSubOpen(false)}>
          <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
            <h3>新建订阅</h3>
            <div className="form-grid">
              <label>主题 *</label>
              <input
                value={subTopic}
                autoFocus
                placeholder="sensors/+/temp，多个主题用逗号分隔"
                onChange={(e) => setSubTopic(e.target.value)}
                onKeyDown={(e) => {
                  // 输入法组合中（含用 Enter 选词）不提交，交由 IME 处理
                  if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  void addSubscription();
                }}
              />
              <label>QoS</label>
              <select value={subQos} onChange={(e) => setSubQos(Number(e.target.value))}>
                {[0, 1, 2].map((q) => <option key={q} value={q}>QoS {q}</option>)}
              </select>
              <label>说明</label>
              <span className="mqtt-hint">支持 MQTT 通配符 + 与 #；取消勾选「启用」可临时停止接收。</span>
            </div>
            <div className="modal-actions">
              <div className="spacer" />
              <button className="btn" onClick={() => setSubOpen(false)}>取消</button>
              <button className="btn primary" onClick={() => void addSubscription()}>订阅</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default MqttWorkspace;
