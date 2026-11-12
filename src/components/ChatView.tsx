import { useEffect, useRef, useState } from "react";
import {
  Send, Square, Copy, Play, Sparkles, Bot, History, Plus, Trash2, Check, Pin, PinOff,
  Loader2, CircleCheck, CircleX, CircleAlert, SkipForward, ExternalLink, ChevronRight,
} from "lucide-react";
import { getActiveSession, useStore } from "../store";
import { driverOf } from "../db/drivers";
import type { ChatMessage, QueryResult, Tab } from "../types";
import DataGrid from "./DataGrid";
import Chart from "./Chart";
import KafkaWorkspace from "./KafkaWorkspace";
import MqttWorkspace from "./MqttWorkspace";
import StorageWorkspace from "./StorageWorkspace";

const SUGGESTIONS = [
  { icon: "📝", label: "生成查询 SQL", prompt: "帮我查询当前数据库中所有表的行数,并按行数倒序排列" },
  { icon: "📊", label: "数据分析", prompt: "分析一下表中的数据分布情况,给出关键统计信息" },
  { icon: "🔧", label: "优化建议", prompt: "检查一下当前数据库的表结构设计,给出优化建议" },
  { icon: "🧭", label: "字段解释", prompt: "解释一下当前选中表各个字段的含义和用途" },
];

export default function MainArea() {
  const { tabs, activeTabId, setActiveTab, closeTab, newChat, clearChat, openChatTab, toggleChatPin, deleteChat, sessions, askConfirm } = useStore();
  const config = useStore((s) => s.config);
  const [showHistory, setShowHistory] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeSession = activeTab?.kind === "chat" ? sessions.find((s) => s.id === activeTab.sessionId) : undefined;
  const sortedSessions = [...sessions].reverse().sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const sortedTabs = [...tabs].sort((a, b) =>
    Number(b.kind === "chat" && !!sessions.find((s) => s.id === b.sessionId)?.pinned) -
    Number(a.kind === "chat" && !!sessions.find((s) => s.id === a.sessionId)?.pinned));
  const confirmClearChat = async () => {
    const session = activeSession;
    if (!session) return;
    const ok = await askConfirm({
      title: "清空当前会话",
      message: "将删除当前会话的全部消息，此操作不可撤销。",
      confirmText: "清空",
      danger: true,
    });
    if (ok) clearChat(session.id);
  };
  const confirmDeleteChat = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    setContextMenu(null);
    if (!session) return;
    const ok = await askConfirm({
      title: "删除会话",
      message: `确定删除会话「${session.title}」？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (ok) deleteChat(session.id);
  };
  // 切换到专属工作区时收起历史会话侧栏（其入口按钮已隐藏）
  useEffect(() => {
    if (activeTab?.kind !== "chat") setShowHistory(false);
  }, [activeTab?.kind]);
  const openSessionMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ sessionId, x: Math.max(4, Math.min(e.clientX, window.innerWidth - 156)),
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - 92)) });
  };

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => setContextMenu(null);
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [contextMenu]);

  return (
    <div className="main-area">
      <div className="tab-bar">
        <div className="tab-strip">
          {sortedTabs.map((t) => (
            <div
              key={t.id}
              className={`tab${activeTabId === t.id ? " active" : ""}`}
              onClick={() => setActiveTab(t.id)}
              onContextMenu={t.kind === "chat" ? (e) => openSessionMenu(e, t.sessionId) : undefined}
              title={t.title}
            >
              {t.kind === "chat" ? (sessions.find((s) => s.id === t.sessionId)?.pinned
                ? <Pin size={13} /> : <Bot size={13} />) : <span className="tab-dot" />}
              <span className="tab-title">{t.title}</span>
              <button className="tab-close" title="关闭标签" aria-label="关闭标签"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}>
                ×
              </button>
            </div>
          ))}
          <button className="tab-action tab-new" title="新建会话" aria-label="新建会话" onClick={newChat}><Plus size={16} /></button>
        </div>
        {/* 专属工作区（MQTT / Kafka 等）不显示会话相关操作 */}
        {activeTab?.kind === "chat" && (
          <div className="tab-actions">
            <button className={`tab-action${showHistory ? " active" : ""}`} title="历史会话"
              aria-label="历史会话" onClick={() => setShowHistory((open) => !open)} aria-expanded={showHistory}>
              <History size={16} />
            </button>
            <button className="tab-action danger" title="清空当前会话" aria-label="清空当前会话"
              disabled={!activeSession?.messages.length || activeSession.streaming}
              onClick={() => void confirmClearChat()}><Trash2 size={16} /></button>
          </div>
        )}
      </div>

      <div className="chat-workspace">
        {showHistory && (
          <aside className="chat-history" aria-label="历史会话">
            <div className="history-heading"><span>历史会话</span><span>{sessions.length}</span></div>
            <div className="history-list">
              {sortedSessions.map((s) => (
                <button key={s.id}
                  className={`history-item${activeTab?.kind === "chat" && activeTab.sessionId === s.id ? " active" : ""}`}
                  onClick={() => { openChatTab(s.id); setShowHistory(false); }}
                  onContextMenu={(e) => openSessionMenu(e, s.id)}
                  title={s.title}>
                  {s.pinned ? <Pin size={14} /> : <Bot size={14} />}
                  <span>{s.title}</span>
                </button>
              ))}
            </div>
          </aside>
        )}
        <div className="tab-content">
          {activeTab?.kind === "chat" ? (
            <ChatView key={activeTab.sessionId} sessionId={activeTab.sessionId} />
          ) : activeTab?.kind === "result" ? (
            <ResultPanel tab={activeTab} />
          ) : activeTab?.kind === "messaging" ? (
            config?.connections.find((c) => c.id === activeTab.connId)?.db_type === "mqtt"
              ? <MqttWorkspace key={activeTab.id} connId={activeTab.connId} />
              : <KafkaWorkspace key={activeTab.id} connId={activeTab.connId} initialTopic={activeTab.topic} />
          ) : activeTab?.kind === "storage" ? (
            <StorageWorkspace key={activeTab.id} connId={activeTab.connId} initialBucket={activeTab.bucket} />
          ) : (
            <div className="empty-hint center">暂无打开的标签页</div>
          )}
        </div>
      </div>
      {contextMenu && sessions.some((s) => s.id === contextMenu.sessionId) && (
        <div className="session-menu" style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()} role="menu">
          <button role="menuitem" onClick={() => { toggleChatPin(contextMenu.sessionId); setContextMenu(null); }}>
            {sessions.find((s) => s.id === contextMenu.sessionId)?.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {sessions.find((s) => s.id === contextMenu.sessionId)?.pinned ? "取消置顶" : "置顶会话"}
          </button>
          <button role="menuitem" className="danger"
            disabled={sessions.find((s) => s.id === contextMenu.sessionId)?.streaming}
            onClick={() => void confirmDeleteChat(contextMenu.sessionId)}>
            <Trash2 size={14} />删除会话</button>
        </div>
      )}
    </div>
  );
}

function ResultPanel({ tab }: { tab: Extract<Tab, { kind: "result" }> }) {
  const { resultView, setResultView } = useStore();
  const { result } = tab;
  return (
    <div className="result-panel">
      <div className="result-subtabs">
        <button className={resultView === "table" ? "active" : ""} onClick={() => setResultView("table")}>
          结果
        </button>
        <button className={resultView === "chart" ? "active" : ""} onClick={() => setResultView("chart")}>
          可视化
        </button>
      </div>
      <div className="result-body">
        {resultView === "table" ? <DataGrid result={result} tab={tab} /> : <Chart result={result} />}
      </div>
    </div>
  );
}

function ChatView({ sessionId }: { sessionId: string }) {
  const { sendChat, stopChat, editorSql, setEditorSql, runSql, config, activeConnId, dbTree, selectChatContext, selectChatModel, resumeAgent } = useStore();
  const session = getActiveSession(useStore());
  const [input, setInput] = useState("");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** 输入法组合状态(部分浏览器 Enter 选词时 isComposing 已为 false) */
  const composing = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages]);

  const doSend = () => {
    const text = input.trim();
    if (!text || session?.streaming) return;
    setInput("");
    sendChat(text);
  };

  const conn = config?.connections.find((c) => c.id === activeConnId);
  const driver = conn ? driverOf(conn.db_type) : null;
  const tree = dbTree[activeConnId];
  const models = config?.models ?? [];
  const model = models.find((m) => m.id === session?.modelId)
    ?? models.find((m) => m.id === config?.active_model_id)
    ?? models[0];
  const databases = tree?.databases ?? [];
  const tables = tree && (!driver?.caps.databases || (tree.selectedDb && tree.tablesDb === tree.selectedDb)) ? tree.tables ?? [] : [];

  return (
    <div className="chat-view">
      <div className="chat-messages">
        {!session || session.messages.length === 0 ? (
          <div className="chat-welcome">
            <div className="welcome-badge">
              <Sparkles size={16} /> AI 对话
            </div>
            <h2>用对话操作你的数据</h2>
            <p>AI 会自己执行只读查询、查看结果并继续下一步,直到完成任务。写入、修改、删除等操作会先停下来等你确认。</p>
            <div className="suggestion-grid">
              {SUGGESTIONS.map((s) => (
                <button key={s.label} className="suggestion-card" onClick={() => setInput(s.prompt)}>
                  <span className="sug-icon">{s.icon}</span>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          session.messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}${m.command ? " agent" : ""}`}>
              {m.role === "assistant" && (
                <div className="msg-avatar">
                  <Sparkles size={13} />
                </div>
              )}
              <div className="msg-body">
                {m.role === "user" ? (
                  <div className="msg-user-bubble">{m.content}</div>
                ) : m.command ? (
                  <AgentStepCard msg={m} sessionId={sessionId} index={i} />
                ) : (
                  <div className={`msg-assistant-bubble${m.status === "error" ? " error" : ""}`}>
                    {m.content ? (
                      m.status === "thinking"
                        ? <span className="msg-thinking"><Loader2 className="spin" size={12} /> {m.content}</span>
                        : <MarkdownLite text={m.content} onRunSql={(sql) => runSql(sql)} />
                    ) : (
                      <span className="msg-thinking">
                        <Loader2 className="spin" size={12} />
                        {m.status === "stopped" ? "已停止" : "正在思考…"}
                      </span>
                    )}
                  </div>
                )}
                {m.role === "assistant" && m.stopped && (
                  <span className="msg-stopped">已中断</span>
                )}
                {m.role === "assistant" && m.canContinue && (
                  <div className="agent-step-actions">
                    <button className="btn primary" onClick={() => resumeAgent(sessionId)}>
                      <Play size={11} /> 继续执行
                    </button>
                  </div>
                )}
                {m.role === "user" && (
                  <button className="msg-copy" aria-label="复制此问题" title="复制此问题"
                    onClick={() => {
                      void navigator.clipboard.writeText(m.content).then(() => {
                        setCopiedIndex(i);
                        setTimeout(() => setCopiedIndex(null), 1500);
                      });
                    }}>
                    {copiedIndex === i ? <Check size={12} /> : <Copy size={12} />}
                    {copiedIndex === i ? "已复制" : "复制"}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-wrap">
        <div className="chat-context">
          <label>连接:
            <select aria-label="选择连接" value={conn?.id ?? ""} onChange={(e) => void selectChatContext(e.target.value)}>
              <option value="" disabled>未选择</option>
              {config?.connections.map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {driverOf(c.db_type).label}</option>
              ))}
            </select>
          </label>
          {conn && driver?.caps.databases && (
            <label>{driver.dbLabel}:
              <select aria-label={`选择${driver.dbLabel}`} value={tree?.selectedDb ?? ""}
                onChange={(e) => void selectChatContext(conn.id, e.target.value)}>
                <option value="">{tree?.loading === "databases" ? "加载中…" : conn.database ? `默认 (${conn.database})` : `整个连接`}</option>
                {databases.map((db) => <option key={db} value={db}>{db}</option>)}
              </select>
            </label>
          )}
          {conn && driver?.caps.tables && tree && (!driver.caps.databases || tree.selectedDb) && (
            <label>{driver.tableLabel}:
              <select aria-label={`选择${driver.tableLabel}`} value={tree.selectedTable}
                onChange={(e) => void selectChatContext(conn.id, tree.selectedDb, e.target.value)}>
                <option value="">{tree.loading === "tables" ? "加载中…" : `全部${driver.tableLabel}`}</option>
                {tables.map((table) => <option key={table.name} value={table.name}>{table.name}</option>)}
              </select>
            </label>
          )}
          <label>模型:
            <select aria-label="选择模型" value={model?.id ?? ""}
              onChange={(e) => selectChatModel(sessionId, e.target.value)} disabled={session?.streaming}>
              <option value="" disabled>未配置模型</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          {editorSql && <span>编辑器有内容</span>}
        </div>
        <div className="chat-input-row">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={(e) => {
              // 输入法组合中(含用 Enter 选词)不发送,交由 IME 处理
              if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                doSend();
              }
            }}
            placeholder="描述你的目标,AI 会自动查询、查看结果并继续执行…(Enter 发送,Shift+Enter 换行)"
            rows={2}
          />
          <button
            className={`send-btn${session?.streaming ? " stop" : ""}`}
            title={session?.streaming ? "停止生成" : "发送"}
            aria-label={session?.streaming ? "停止生成" : "发送"}
            onClick={() => (session?.streaming ? stopChat() : doSend())}
            disabled={!session?.streaming && !input.trim()}
          >
            {session?.streaming ? <Square size={15} /> : <Send size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Agent 执行步骤：思考 + 命令 + 输出 + 确认按钮，全部内联在同一条消息流里 */
function AgentStepCard({ msg, sessionId, index }: { msg: ChatMessage; sessionId: string; index: number }) {
  const approveAgentStep = useStore((s) => s.approveAgentStep);
  const skipAgentStep = useStore((s) => s.skipAgentStep);
  const resumeAgent = useStore((s) => s.resumeAgent);
  const openResult = useStore((s) => s.openResult);
  const [copied, setCopied] = useState(false);
  const status = msg.status ?? "done";
  const kindLabel = msg.commandKind === "redis" ? "Redis" : msg.commandKind === "elasticsearch" ? "Elasticsearch" : "SQL";
  const statusText: Record<string, string> = {
    thinking: "思考中",
    pending: "等待确认",
    running: "执行中",
    done: "已完成",
    error: "执行失败",
    skipped: "已跳过",
    stopped: "已暂停",
  };
  const icon = status === "running" || status === "thinking"
    ? <Loader2 className="spin" size={13} />
    : status === "done" ? <CircleCheck size={13} />
      : status === "error" ? <CircleX size={13} />
        : status === "skipped" ? <SkipForward size={13} />
          : <CircleAlert size={13} />;

  return (
    <div className={`agent-step ${status}${msg.danger ? " danger" : ""}`}>
      <div className="agent-step-head">
        <span className="agent-step-icon">{icon}</span>
        <span className="agent-step-label">{kindLabel}</span>
        <span className="agent-step-status">{statusText[status] ?? status}</span>
        {msg.outputMeta && status !== "pending" && <span className="agent-step-meta">{msg.outputMeta}</span>}
      </div>

      {msg.content && <div className="agent-thought">{msg.content}</div>}

      <div className="agent-command">
        <div className="agent-command-head">
          <span>{kindLabel}</span>
          <button
            onClick={() => {
              if (!msg.command) return;
              void navigator.clipboard.writeText(msg.command).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <pre><code>{msg.command}</code></pre>
      </div>

      {status === "pending" && (
        <div className="agent-confirm">
          <div className="agent-confirm-text">
            <CircleAlert size={13} />
            <span>
              {msg.danger ? "高风险操作：" : "需要确认："}
              {msg.authReason || "该操作会修改数据或结构"}
            </span>
          </div>
          <div className="agent-actions">
            <button className={`btn primary${msg.danger ? " danger" : ""}`}
              onClick={() => void approveAgentStep(sessionId, index)}>
              <Play size={11} /> 执行
            </button>
            <button className="btn" onClick={() => skipAgentStep(sessionId, index)}>
              <SkipForward size={11} /> 跳过
            </button>
          </div>
        </div>
      )}

      {status === "running" && (
        <div className="agent-hint"><Loader2 className="spin" size={11} /> 正在执行…</div>
      )}
      {status === "skipped" && <div className="agent-hint">已跳过这条命令，让 AI 换一种方式继续。</div>}

      {msg.output && (status === "done" || status === "error" || status === "stopped") && (
        <details className="agent-output" open={status === "error"}>
          <summary>
            <ChevronRight size={11} />
            {status === "error" ? "执行失败" : "查看输出"}
            {msg.outputMeta && status !== "error" ? ` · ${msg.outputMeta}` : ""}
          </summary>
          {msg.result && status === "done" && msg.result.columns.length > 0
            ? <AgentResultPreview result={msg.result} />
            : <pre>{msg.output}</pre>}
        </details>
      )}

      {(msg.result || msg.canContinue) && (
        <div className="agent-step-actions">
          {msg.result && (
            <button className="btn" onClick={() => openResult(msg.result!, "AI 查询结果")}>
              <ExternalLink size={11} /> 在结果页查看
            </button>
          )}
          {msg.canContinue && (
            <button className="btn primary" onClick={() => resumeAgent(sessionId)}>
              <Play size={11} /> 继续执行
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 结果页之外的内联结果预览：最多 8 行，保持整页可读 */
function AgentResultPreview({ result }: { result: QueryResult }) {
  const rows = result.rows.slice(0, 8);
  return (
    <div className="agent-table-wrap">
      <table className="agent-table">
        <thead>
          <tr>{result.columns.map((col, i) => <th key={i}>{col}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} title={cell === null ? "NULL" : String(cell)}>
                  {cell === null ? <span className="agent-null">NULL</span> : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.row_count > rows.length && (
        <div className="agent-table-more">仅展示前 {rows.length} 行，共 {result.row_count} 行</div>
      )}
    </div>
  );
}

/** 轻量 Markdown 渲染:代码块 + 行内代码 + 粗体 */
export function MarkdownLite({ text, onRunSql }: { text: string; onRunSql?: (sql: string) => void }) {
  if (!text) return null;
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) nodes.push(<InlineMarkdown key={`t${i}`} text={parts[i]} />);
    if (i + 2 < parts.length) {
      const lang = parts[i + 1] || "text";
      const code = (parts[i + 2] ?? "").replace(/\n$/, "");
      nodes.push(
        <CodeBlock key={`c${i}`} lang={lang} code={code} onRunSql={onRunSql} />
      );
    }
  }
  return <div className="md">{nodes}</div>;
}

function InlineMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const html = line
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(/`([^`]+)`/g, "<code>$1</code>");
        return <p key={i} dangerouslySetInnerHTML={{ __html: html || "&nbsp;" }} />;
      })}
    </>
  );
}

function CodeBlock({ lang, code, onRunSql }: { lang: string; code: string; onRunSql?: (sql: string) => void }) {
  const [copied, setCopied] = useState(false);
  const config = useStore((s) => s.config);
  const activeConnId = useStore((s) => s.activeConnId);
  const conn = config?.connections.find((c) => c.id === activeConnId);
  const isSearch = !!conn && driverOf(conn.db_type).caps.mapping;
  const runnable = !conn || !driverOf(conn.db_type).caps.messaging
    ? (isSearch ? /^elasticsearch$/i.test(lang) : /^(sql|redis|mysql|postgres)$/i.test(lang)) && onRunSql : false;
  return (
    <div className="code-block">
      <div className="code-header">
        <span className="code-lang">{lang}</span>
        <div className="code-actions">
          {runnable && (
            <button
              onClick={() => onRunSql?.(code)}
            >
              <Play size={11} /> 运行
            </button>
          )}
          <button
            onClick={() => {
              navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Copy size={11} /> {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
