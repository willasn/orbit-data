import { useEffect, useRef, useState } from "react";
import { Ban, FilePlus2, History, Play, Trash2, WandSparkles } from "lucide-react";
import { useStore } from "../store";
import { driverOf } from "../db/drivers";
import { KIND_LABEL, collectSuggestions, filterSuggestions, wordBeforeCaret } from "../db/sqlCompletion";
import type { Suggestion } from "../db/sqlCompletion";
import { flushDrafts, getDraft, historyOf, pushHistory, removeHistoryEntry, saveDraft } from "../db/sqlEditorStorage";
import type { SqlHistoryEntry } from "../db/sqlEditorStorage";

/** 补全弹层宽度，用于右侧边界收拢（与 styles.css 中 .sql-completion 保持一致） */
const COMPLETION_WIDTH = 300;

interface CompletionState {
  items: Suggestion[];
  index: number;
  /** 触发补全时的候选词起始下标 */
  start: number;
  left: number;
  top: number;
}

/** 历史列表的时间展示：月-日 时:分 */
function formatHistoryTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 用镜像节点测量光标在 textarea 中的坐标（相对右侧面板，按软换行后的实际位置） */
function caretPoint(ta: HTMLTextAreaElement, panel: HTMLElement, text: string, index: number) {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "anywhere";
  mirror.style.fontFamily = cs.fontFamily;
  mirror.style.fontSize = cs.fontSize;
  mirror.style.fontWeight = cs.fontWeight;
  mirror.style.fontStyle = cs.fontStyle;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.padding = cs.padding;
  mirror.style.border = "0";
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.textContent = text.slice(0, index);
  const marker = document.createElement("span");
  // 只取光标所在行的剩余内容，避免后续换行影响测量
  marker.textContent = text.slice(index).split("\n")[0] || "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const x = marker.offsetLeft;
  const y = marker.offsetTop;
  document.body.removeChild(mirror);
  const lineHeight = parseFloat(cs.lineHeight) || 18;
  const taRect = ta.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  return {
    left: taRect.left - panelRect.left + x - ta.scrollLeft,
    top: taRect.top - panelRect.top + y - ta.scrollTop + lineHeight,
  };
}

/**
 * 按 textarea 实际宽度计算每个逻辑行（软换行后）的像素高度，
 * 供左侧行号逐行对齐；换行规则与 textarea 的 pre-wrap / anywhere 保持一致。
 */
function measureLineHeights(ta: HTMLTextAreaElement): number[] {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "anywhere";
  mirror.style.fontFamily = cs.fontFamily;
  mirror.style.fontSize = cs.fontSize;
  mirror.style.fontWeight = cs.fontWeight;
  mirror.style.fontStyle = cs.fontStyle;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.padding = cs.padding;
  mirror.style.border = "0";
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${ta.clientWidth}px`;
  for (const line of ta.value.split("\n")) {
    const row = document.createElement("div");
    row.textContent = line || " ";
    mirror.appendChild(row);
  }
  document.body.appendChild(mirror);
  const heights = Array.from(mirror.children).map((el) => (el as HTMLElement).offsetHeight);
  document.body.removeChild(mirror);
  return heights;
}

/** 极简 SQL 格式化:关键字大写 + 主要子句换行 */
function formatSql(sql: string): string {
  const keywords = [
    "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT",
    "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "JOIN", "UNION ALL", "UNION", "VALUES",
  ];
  let out = sql.replace(/\s+/g, " ");
  out = out.replace(/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE|DROP TABLE)\b/gi, (m) => m.toUpperCase());
  for (const kw of keywords) {
    out = out.replace(new RegExp(`\\s+${kw}\\s+`, "gi"), `\n${kw} `);
  }
  return out.trim();
}

export default function SqlEditorPanel({ disabled = false }: { disabled?: boolean }) {
  const {
    config,
    activeConnId,
    dbTree,
    selectDatabase,
    selectTable,
    showToast,
    editorSql,
    setEditorSql,
    runSql,
    rightWidth,
    askConfirm,
  } = useStore();

  const conn = config?.connections.find((c) => c.id === activeConnId) ?? null;
  const tree = dbTree[activeConnId];
  const [lineCount, setLineCount] = useState(1);
  /** 每个逻辑行软换行后的像素高度，用于行号对齐 */
  const [lineHeights, setLineHeights] = useState<number[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<SqlHistoryEntry[]>([]);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const completionSeq = useRef(0);
  /** 已加载草稿的连接 id（避免同一连接反复覆盖编辑内容） */
  const loadedDraftConn = useRef<string | null>(null);

  const isRedis = conn?.db_type === "redis";
  const isSearch = !!conn && driverOf(conn.db_type).caps.mapping;
  const isSql = !!conn && driverOf(conn.db_type).caps.sql;

  useEffect(() => {
    setLineCount(editorSql.split("\n").length);
  }, [editorSql]);

  // 切换连接 / 类型时丢弃未返回的补全请求与弹层，避免串到别的库
  useEffect(() => {
    completionSeq.current += 1;
    setCompletion(null);
  }, [activeConnId, conn?.db_type]);

  // 切换连接时先落盘旧草稿，再恢复该连接自己的草稿
  useEffect(() => {
    if (!conn) return;
    if (loadedDraftConn.current === conn.id) return;
    flushDrafts();
    loadedDraftConn.current = conn.id;
    setEditorSql(getDraft(conn.id) ?? "");
    setHistoryOpen(false);
  }, [conn?.id]);

  // 任何来源的编辑（输入、格式化、历史载入、右键模板）都同步进草稿
  useEffect(() => {
    if (conn && loadedDraftConn.current === conn.id) saveDraft(conn.id, editorSql);
  }, [editorSql, conn?.id]);

  // 软换行后逐行测量高度，保证行号与文本行对齐
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    setLineHeights(measureLineHeights(ta));
  }, [editorSql, rightWidth, disabled, conn?.id]);

  // 关闭窗口 / 卸载前落盘
  useEffect(() => {
    window.addEventListener("beforeunload", flushDrafts);
    return () => {
      window.removeEventListener("beforeunload", flushDrafts);
      flushDrafts();
    };
  }, []);

  // 历史弹层：点击面板其他区域关闭
  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (historyRef.current?.contains(target) || actionsRef.current?.contains(target)) return;
      setHistoryOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [historyOpen]);

  /** 打开补全：拉取当前连接的真实元数据后按候选词过滤 */
  const requestCompletion = (value: string, caret: number, force = false) => {
    if (!conn || !driverOf(conn.db_type).caps.sql) {
      setCompletion(null);
      return;
    }
    const { word, start } = wordBeforeCaret(value, caret);
    if (!force && word.length < 2) {
      setCompletion(null);
      return;
    }
    const seq = ++completionSeq.current;
    const tree = useStore.getState().dbTree[conn.id];
    void collectSuggestions({
      conn,
      currentDb: tree?.selectedDb || conn.database,
      databases: tree?.databases ?? null,
      tables: tree?.tables ?? null,
      tablesDb: tree?.tablesDb ?? "",
      columns: tree?.columns ?? null,
      columnsTable: tree?.columnsTable ?? "",
      selectedTable: tree?.selectedTable ?? "",
      sql: value,
    }).then((all) => {
      if (seq !== completionSeq.current) return;
      const items = filterSuggestions(all, word);
      const ta = taRef.current;
      const panel = panelRef.current;
      if (!items.length || !ta || !panel) {
        setCompletion(null);
        return;
      }
      const point = caretPoint(ta, panel, value, start);
      const left = Math.max(8, Math.min(point.left, panel.clientWidth - COMPLETION_WIDTH - 8));
      setCompletion({ items, index: 0, start, left, top: point.top });
    });
  };

  const acceptCompletion = (item: Suggestion) => {
    const ta = taRef.current;
    if (!ta || !completion) return;
    const caret = Math.max(ta.selectionStart, completion.start);
    const next = editorSql.slice(0, completion.start) + item.label + editorSql.slice(caret);
    setEditorSql(next);
    setCompletion(null);
    const pos = completion.start + item.label.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  /** 新建：当前内容非空且与最近一条历史不同则归档，然后清空编辑器 */
  const handleNewSql = () => {
    if (!conn) return;
    if (editorSql.trim()) pushHistory(conn.id, conn.name, editorSql);
    setCompletion(null);
    setEditorSql("");
    setHistoryOpen(false);
  };

  const toggleHistory = () => {
    if (!conn) return;
    if (!historyOpen) setHistory(historyOf(conn.id));
    setHistoryOpen((open) => !open);
  };

  const loadHistoryEntry = (entry: SqlHistoryEntry) => {
    setEditorSql(entry.sql);
    setHistoryOpen(false);
  };

  const deleteHistoryEntry = async (entry: SqlHistoryEntry) => {
    if (!conn) return;
    const ok = await askConfirm({
      title: "删除历史记录",
      message: "确定删除这条 SQL 历史？此操作不可撤销。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    setHistory(removeHistoryEntry(conn.id, entry.at));
  };

  const formatEditor = () => {
    if (!isSearch) {
      setEditorSql(formatSql(editorSql));
      return;
    }
    try {
      const text = editorSql.trim();
      if (text.startsWith("{")) setEditorSql(JSON.stringify(JSON.parse(text), null, 2));
      else {
        const split = text.indexOf("\n");
        if (split >= 0) setEditorSql(`${text.slice(0, split)}\n${JSON.stringify(JSON.parse(text.slice(split + 1)), null, 2)}`);
      }
    } catch {
      showToast("JSON 格式无效，无法格式化");
    }
  };

  // 专属工作区（MQTT / Kafka 等）不使用右侧 SQL 编辑器，整块置灰提示
  if (disabled) {
    return (
      <div className="sql-panel sql-panel-disabled" style={{ width: rightWidth }} aria-disabled="true">
        <div className="panel-header"><span>SQL 编辑器</span></div>
        <div className="sql-panel-disabled-body">
          <Ban size={24} />
          <p>当前页面不使用右侧面板</p>
        </div>
      </div>
    );
  }

  if (!conn) {
    return (
      <div className="sql-panel" style={{ width: rightWidth }}>
        <div className="panel-header"><span>SQL 编辑器</span></div>
        <div className="empty-hint center">选择左侧连接后即可编辑并运行 SQL</div>
      </div>
    );
  }

  if (driverOf(conn.db_type).caps.messaging) {
    return <div className="sql-panel" style={{ width: rightWidth }}>
      <div className="panel-header"><span>消息中间件</span><span className="header-badge">{conn.name}</span></div>
      <div className="empty-hint center">
        <p>消息读取、监听、生产和管理操作在消息工作区完成。</p>
        <button className="btn primary" onClick={() => void useStore.getState().openMessaging(conn.id, tree?.selectedTable || undefined)}>打开消息工作区</button>
        <p>浏览不加入业务消费组，不提交 Offset。消息正文不会自动发送给 AI。</p>
      </div>
    </div>;
  }

  return (
    <div className="sql-panel" style={{ width: rightWidth }} ref={panelRef}>
      <div className="panel-header">
        <span>{isSearch ? "ES 查询控制台" : isRedis ? "Redis 控制台" : "SQL 编辑器"}</span>
        <div className="sql-header-right">
          <span className="header-badge">{conn.name}</span>
          {isSql && (
            <div className="sql-header-actions" ref={actionsRef}>
              <button className="icon-btn" title="新建" aria-label="新建 SQL" onClick={handleNewSql}>
                <FilePlus2 size={14} />
              </button>
              <button
                className={`icon-btn${historyOpen ? " active" : ""}`}
                title="历史"
                aria-label="SQL 历史"
                aria-expanded={historyOpen}
                onClick={toggleHistory}
              >
                <History size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="sql-toolbar">
        {isSearch ? (
          <select className="db-select" value={tree?.selectedTable || conn.database}
            onChange={(e) => {
              if (!e.target.value) void useStore.getState().selectChatContext(conn.id, "");
              else if (tree?.selectedTable !== e.target.value) void selectTable(conn.id, "", e.target.value);
            }}>
            <option value="">选择索引（REST 请求可省略）…</option>
            {[...new Set([...(tree?.tables ?? []).map((t) => t.name), ...(conn.database ? [conn.database] : [])])].map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        ) : !isRedis ? (
          <select
            className="db-select"
            value={tree?.selectedDb || conn.database}
            onChange={(e) => selectDatabase(conn.id, e.target.value)}
          >
            <option value="">选择数据库…</option>
            {(tree?.databases ?? (conn.database ? [conn.database] : [])).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        ) : (
          <span className="header-badge">Redis 命令模式</span>
        )}
        <div className="sql-toolbar-actions">
          <button className="btn primary" onClick={() => runSql(editorSql)}>
            <Play size={13} /> 运行
          </button>
          {!isRedis && (
            <button className="btn" onClick={formatEditor}>
              <WandSparkles size={13} /> 格式化
            </button>
          )}
        </div>
      </div>

      <div className="sql-editor">
        <div className="line-numbers" ref={gutterRef}>
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} style={lineHeights[i] ? { height: lineHeights[i] } : undefined}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={taRef}
          value={editorSql}
          onChange={(e) => {
            const value = e.target.value;
            setEditorSql(value);
            requestCompletion(value, e.target.selectionStart);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              runSql(editorSql);
              return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key === " ") {
              e.preventDefault();
              requestCompletion(editorSql, e.currentTarget.selectionStart, true);
              return;
            }
            if (!completion) return;
            const size = completion.items.length;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCompletion({ ...completion, index: (completion.index + 1) % size });
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCompletion({ ...completion, index: (completion.index - 1 + size) % size });
            } else if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              acceptCompletion(completion.items[completion.index]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setCompletion(null);
            } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
              setCompletion(null);
            }
          }}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
            setCompletion(null);
          }}
          onBlur={() => setCompletion(null)}
          spellCheck={false}
          placeholder={isSearch ? 'POST /example-index/_search\n{ "query": { "match_all": {} }, "size": 20 }\n（只读查询，⌘+Enter 运行）' : isRedis ? "例如: GET mykey" : "SELECT * FROM …  (⌘+Enter 运行)"}
        />
      </div>

      {completion && (
        <div className="sql-completion" style={{ left: completion.left, top: completion.top }} role="listbox" aria-label="SQL 补全候选"
          onMouseDown={(e) => e.preventDefault()}>
          {completion.items.map((item, i) => (
            <div
              key={`${item.kind}-${item.label}-${item.detail ?? ""}-${i}`}
              role="option"
              aria-selected={i === completion.index}
              className={`sql-completion-item${i === completion.index ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                acceptCompletion(item);
              }}
              onMouseEnter={() => setCompletion((prev) => (prev ? { ...prev, index: i } : prev))}
            >
              <span className="sql-completion-kind">{KIND_LABEL[item.kind]}</span>
              <span className="sql-completion-label">{item.label}</span>
              {item.detail && <span className="sql-completion-detail">{item.detail}</span>}
            </div>
          ))}
        </div>
      )}

      {historyOpen && isSql && (
        <div className="sql-history" ref={historyRef} role="dialog" aria-label="SQL 历史">
          <div className="sql-history-head">
            <span>SQL 历史 · {conn.name}</span>
            <span>{history.length} 条</span>
          </div>
          {history.length === 0 ? (
            <div className="sql-history-empty">暂无历史。「新建」时会把当前内容存入历史。</div>
          ) : (
            history.map((entry, i) => (
              <div
                key={`${entry.at}-${i}`}
                className="sql-history-item"
                title={entry.sql}
                onClick={() => loadHistoryEntry(entry)}
              >
                <div className="sql-history-meta">
                  <span className="sql-history-time">{formatHistoryTime(entry.at)}</span>
                  <span className="sql-history-preview">{entry.sql.replace(/\s+/g, " ").trim().slice(0, 120)}</span>
                </div>
                <button
                  type="button"
                  className="icon-btn danger sql-history-del"
                  title="删除"
                  aria-label="删除这条历史"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteHistoryEntry(entry);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
