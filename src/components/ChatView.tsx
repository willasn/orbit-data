import { useEffect, useRef, useState } from "react";
import {
  Send, Square, Copy, Play, Sparkles, Check, Loader2, CircleCheck, CircleX, CircleAlert,
  SkipForward, ExternalLink, ChevronRight, Code2, Maximize2,
} from "lucide-react";
import { useStore } from "../store";
import { driverOf } from "../db/drivers";
import { getDraft, saveDraft } from "../db/sqlEditorStorage";
import type { ChatMessage, QueryResult, Tab } from "../types";
import DataGrid from "./DataGrid";
import { SqlCompletionPopup } from "./SqlCompletionPopup";
import { useSqlCompletion } from "./useSqlCompletion";

export function ResultPanel({ tab }: { tab: Extract<Tab, { kind: "result" }> }) {
  return (
    <div className="result-panel">
      <div className="result-body">
        <DataGrid result={tab.result} tab={tab} />
      </div>
    </div>
  );
}

/** 已把草稿载入编辑器的连接（模块级：切换子面板重挂载时不重复覆盖） */
let draftLoadedConn: string | null = null;

export function ChatView({ sessionId }: { sessionId: string }) {
  const {
    sendChat, stopChat, runSql, config, activeConnId, dbTree, selectChatContext, selectChatModel,
    resumeAgent, editorSql, setEditorSql, setSqlExpanded, chatInputMode, setChatInputMode,
  } = useStore();
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const [input, setInput] = useState("");
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const inputWrapRef = useRef<HTMLDivElement>(null);
  /** 输入法组合状态(部分浏览器 Enter 选词时 isComposing 已为 false) */
  const composing = useRef(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages]);

  // 切换连接时把内嵌 SQL 框换成该连接自己的草稿（同一连接重挂载不重复载入）
  useEffect(() => {
    if (!activeConnId || draftLoadedConn === activeConnId) return;
    draftLoadedConn = activeConnId;
    setEditorSql(getDraft(activeConnId) ?? "");
  }, [activeConnId, setEditorSql]);

  // 内嵌 SQL 的编辑同步进草稿（与放大弹窗共用同一份）
  useEffect(() => {
    if (activeConnId && draftLoadedConn === activeConnId) saveDraft(activeConnId, editorSql);
  }, [editorSql, activeConnId]);

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
  /** 输入区模式：SQL 命令直接执行，Agent 模式交给 AI 规划 */
  const sqlMode = chatInputMode === "sql";
  const {
    completion, requestCompletion, acceptCompletion, handleCompletionKey, highlight, closeCompletion,
  } = useSqlCompletion({
    conn: conn ?? null,
    setValue: setEditorSql,
    textareaRef: inputRef,
    containerRef: inputWrapRef,
  });
  const inputValue = sqlMode ? editorSql : input;
  const setInputValue = sqlMode ? setEditorSql : setInput;
  const canSubmit = sqlMode ? !!conn && !!editorSql.trim() : !!input.trim();
  const submit = () => {
    if (sqlMode) {
      if (conn && editorSql.trim()) void runSql(editorSql);
      return;
    }
    doSend();
  };

  return (
    <div className="chat-view">
      <div className="chat-messages">
        {!session || session.messages.length === 0 ? (
          <div className="chat-empty" />
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

      <div className="chat-input-wrap" ref={inputWrapRef}>
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
          {!sqlMode && (
            <label>模型:
              <select aria-label="选择模型" value={model?.id ?? ""}
                onChange={(e) => selectChatModel(sessionId, e.target.value)} disabled={session?.streaming}>
                <option value="" disabled>未配置模型</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
          )}
        </div>
        {/* SQL 命令与 Agent 对话共用一个输入框，底部切换模式 */}
        <div className="chat-input-row">
          <textarea
            ref={inputRef}
            value={inputValue}
            spellCheck={!sqlMode}
            onChange={(e) => {
              const value = e.target.value;
              setInputValue(value);
              // SQL 模式：输入时实时给出关键字 / 库 / 表 / 列补全
              if (sqlMode) requestCompletion(value, e.target.selectionStart);
            }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={(e) => {
              // 输入法组合中(含用 Enter 选词)不发送,交由 IME 处理
              if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
              if (sqlMode) {
                // ⌘/Ctrl+Enter 始终执行，优先于补全确认
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                  return;
                }
                // 补全弹层打开时，方向键 / Enter / Tab / Esc 交给补全
                handleCompletionKey(e);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                doSend();
              }
            }}
            onScroll={closeCompletion}
            onBlur={closeCompletion}
            placeholder={sqlMode
              ? conn?.db_type === "redis"
                ? "输入 Redis 命令，如 GET your-key（⌘/Ctrl + Enter 执行）"
                : "输入 SQL 命令（⌘/Ctrl + Enter 执行，⌘/Ctrl + 空格 补全）"
              : "描述你的目标,AI 会自动查询、查看结果并继续执行…(Enter 发送,Shift+Enter 换行)"}
            rows={2}
          />
          <div className="chat-input-toolbar">
            <div className="chat-mode-switch" role="group" aria-label="输入模式">
              <button
                type="button"
                className={sqlMode ? "active" : ""}
                title="直接执行 SQL / Redis 命令"
                onClick={() => setChatInputMode("sql")}
              >
                <Code2 size={12} /> SQL 命令
              </button>
              <button
                type="button"
                className={sqlMode ? "" : "active"}
                title="交给 AI Agent 规划并执行"
                onClick={() => setChatInputMode("agent")}
              >
                <Sparkles size={12} /> Agent 模式
              </button>
            </div>
            {sqlMode && conn && (
              <span
                className="chat-mode-hint"
                title={[conn.name, tree?.selectedDb, tree?.selectedTable].filter(Boolean).join(" · ")}
              >
                {[conn.name, tree?.selectedDb, tree?.selectedTable].filter(Boolean).join(" · ")}
              </span>
            )}
            {sqlMode && (
              <button
                className="icon-btn"
                title="放大编辑"
                aria-label="放大编辑 SQL"
                onClick={() => setSqlExpanded(true)}
              >
                <Maximize2 size={13} />
              </button>
            )}
            <button
              className={`send-btn${!sqlMode && session?.streaming ? " stop" : ""}`}
              title={sqlMode ? "执行 (⌘/Ctrl + Enter)" : session?.streaming ? "停止生成" : "发送"}
              aria-label={sqlMode ? "执行" : session?.streaming ? "停止生成" : "发送"}
              onClick={() => {
                if (sqlMode) {
                  submit();
                  return;
                }
                if (session?.streaming) stopChat();
                else doSend();
              }}
              disabled={sqlMode ? !canSubmit : !session?.streaming && !canSubmit}
            >
              {sqlMode ? <Play size={15} /> : session?.streaming ? <Square size={15} /> : <Send size={15} />}
            </button>
          </div>
        </div>
        <SqlCompletionPopup
          completion={sqlMode ? completion : null}
          placement="above"
          onAccept={acceptCompletion}
          onHighlight={highlight}
        />
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
  const kindLabel = msg.commandKind === "redis" ? "Redis" : msg.commandKind === "elasticsearch" ? "Elasticsearch" : msg.commandKind === "milvus" ? "Milvus" : msg.commandKind === "mongodb" ? "MongoDB" : "SQL";
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
  const driver = conn ? driverOf(conn.db_type) : undefined;
  const runnable = !driver?.caps.messaging
    ? (driver?.queryLanguage ? lang.toLowerCase() === driver.queryLanguage : /^(sql|redis|mysql|postgres)$/i.test(lang)) && onRunSql : false;
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
