import { useEffect, useRef, useState } from "react";
import { FilePlus2, History, Maximize2, Minimize2, Play, Trash2, WandSparkles } from "lucide-react";
import { useStore } from "../store";
import { driverOf } from "../db/drivers";
import { flushDrafts, getDraft, historyOf, pushHistory, removeHistoryEntry, saveDraft } from "../db/sqlEditorStorage";
import type { SqlHistoryEntry } from "../db/sqlEditorStorage";
import { SqlCompletionPopup } from "./SqlCompletionPopup";
import { useSqlCompletion } from "./useSqlCompletion";

/** 历史列表的时间展示：月-日 时:分 */
function formatHistoryTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

/**
 * SQL 编辑器。
 * - mode="pane"：内嵌在中间面板的子面板里，可点击「放大」在弹窗中编辑
 * - mode="modal"：放大弹窗，复用同一份 SQL 与补全逻辑
 */
export default function SqlEditorPanel({ mode = "pane" }: { mode?: "pane" | "modal" }) {
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
    askConfirm,
    setSqlExpanded,
    selectChatContext,
  } = useStore();

  const conn = config?.connections.find((c) => c.id === activeConnId) ?? null;
  const tree = dbTree[activeConnId];
  const [lineCount, setLineCount] = useState(1);
  /** 每个逻辑行软换行后的像素高度，用于行号对齐 */
  const [lineHeights, setLineHeights] = useState<number[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<SqlHistoryEntry[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  /** 已加载草稿的连接 id（避免同一连接反复覆盖编辑内容） */
  const loadedDraftConn = useRef<string | null>(null);
  const {
    completion, requestCompletion, acceptCompletion, handleCompletionKey, highlight, closeCompletion, resetCompletion,
  } = useSqlCompletion({
    conn,
    setValue: setEditorSql,
    textareaRef: taRef,
    containerRef: panelRef,
  });

  const isRedis = conn?.db_type === "redis";
  const queryLanguage = conn ? driverOf(conn.db_type).queryLanguage : undefined;
  const isSearch = queryLanguage === "elasticsearch";
  const isMilvus = queryLanguage === "milvus";
  const isMongo = queryLanguage === "mongodb";
  const isSql = !!conn && driverOf(conn.db_type).caps.sql;

  useEffect(() => {
    setLineCount(editorSql.split("\n").length);
  }, [editorSql]);

  // 切换连接 / 类型时丢弃未返回的补全请求与弹层，避免串到别的库
  useEffect(() => {
    resetCompletion();
  }, [activeConnId, conn?.db_type]);

  // 切换连接时先落盘旧草稿，再恢复该连接自己的草稿（放大弹窗跟随当前 SQL，不重复加载）
  useEffect(() => {
    if (mode !== "pane" || !conn) return;
    if (loadedDraftConn.current === conn.id) return;
    flushDrafts();
    loadedDraftConn.current = conn.id;
    setEditorSql(getDraft(conn.id) ?? (isMilvus
      ? `POST /v2/vectordb/entities/query\n${JSON.stringify({ collectionName: "your_collection", filter: "", outputFields: ["*"], limit: 100 }, null, 2)}`
      : isMongo
        ? JSON.stringify({ find: "your_collection", filter: {}, limit: 20 }, null, 2)
        : ""));
    setHistoryOpen(false);
  }, [conn?.id, mode]);

  // 任何来源的编辑（输入、格式化、历史载入、右键模板）都同步进草稿
  useEffect(() => {
    if (mode === "pane" && conn && loadedDraftConn.current === conn.id) saveDraft(conn.id, editorSql);
  }, [editorSql, conn?.id, mode]);

  // 软换行后逐行测量高度，保证行号与文本行对齐；面板拖动改变宽度时重新测量
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    setLineHeights(measureLineHeights(ta));
    const ro = new ResizeObserver(() => setLineHeights(measureLineHeights(ta)));
    ro.observe(ta);
    return () => ro.disconnect();
  }, [editorSql, conn?.id, mode]);

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

  /** 新建：当前内容非空且与最近一条历史不同则归档，然后清空编辑器 */
  const handleNewSql = () => {
    if (!conn) return;
    if (editorSql.trim()) {
      pushHistory(conn.id, conn.name, editorSql, {
        database: tree?.selectedDb || conn.database || "",
        table: tree?.selectedTable ?? "",
        column: tree?.selectedColumn ?? "",
      });
    }
    closeCompletion();
    setEditorSql("");
    setHistoryOpen(false);
  };

  const toggleHistory = () => {
    if (!conn) return;
    if (!historyOpen) setHistory(historyOf(conn.id));
    setHistoryOpen((open) => !open);
  };

  const loadHistoryEntry = (entry: SqlHistoryEntry) => {
    // 带出归档时的库 / 表上下文
    if (entry.connId !== activeConnId || (entry.database && entry.database !== tree?.selectedDb)) {
      void selectChatContext(entry.connId, entry.database ?? "", entry.table ?? "");
    }
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
    if (isMongo) {
      // shell 写法（db.xxx.find…）不参与 JSON 格式化
      const text = editorSql.trim();
      if (!text.startsWith("{")) {
        showToast("JSON 命令以 { 开头，shell 写法不支持格式化");
        return;
      }
      try {
        setEditorSql(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        showToast("JSON 格式无效，无法格式化");
      }
      return;
    }
    if (!isSearch && !isMilvus) {
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

  if (!conn) {
    return (
      <div className={`sql-panel sql-panel-${mode}`} ref={panelRef}>
        <div className="panel-header"><span>SQL 编辑器</span></div>
        <div className="empty-hint center">选择左侧连接后即可编辑并运行</div>
      </div>
    );
  }

  if (driverOf(conn.db_type).caps.messaging) {
    return <div className={`sql-panel sql-panel-${mode}`} ref={panelRef}>
      <div className="panel-header"><span>消息中间件</span><span className="header-badge">{conn.name}</span></div>
      <div className="empty-hint center">
        <button className="btn primary" onClick={() => void useStore.getState().openMessaging(conn.id, tree?.selectedTable || undefined)}>打开消息工作区</button>
        <p>消息读取、监听、生产和管理操作在消息工作区完成；浏览不加入业务消费组，不提交 Offset。</p>
      </div>
    </div>;
  }

  return (
    <div className={`sql-panel sql-panel-${mode}`} ref={panelRef}>
      <div className="panel-header">
        <span>{isMilvus ? "Milvus 查询控制台" : isMongo ? "MongoDB 控制台" : isSearch ? "ES 查询控制台" : isRedis ? "Redis 控制台" : "SQL 编辑器"}</span>
        <div className="sql-header-right">
          <span className="header-badge">{conn.name}</span>
          <div className="sql-header-actions" ref={actionsRef}>
            {isSql && (
              <>
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
              </>
            )}
            <button
              className="icon-btn"
              title={mode === "pane" ? "放大编辑" : "退出放大"}
              aria-label={mode === "pane" ? "放大编辑" : "退出放大"}
              onClick={() => setSqlExpanded(mode === "pane")}
            >
              {mode === "pane" ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
            </button>
          </div>
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
            handleCompletionKey(e);
          }}
          onScroll={(e) => {
            if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
            closeCompletion();
          }}
          onBlur={closeCompletion}
          spellCheck={false}
          placeholder={isMilvus ? 'POST /v2/vectordb/entities/query\n{ "collectionName": "your_collection", "filter": "", "outputFields": ["*"], "limit": 100 }\n（⌘+Enter 运行）' : isMongo ? '{"find": "your_collection", "filter": {}, "limit": 20}\n或 db.your_collection.find({}).limit(20)\n（⌘+Enter 运行）' : isSearch ? 'POST /example-index/_search\n{ "query": { "match_all": {} }, "size": 20 }\n（只读查询，⌘+Enter 运行）' : isRedis ? "例如: GET mykey" : "SELECT * FROM …  (⌘+Enter 运行)"}
        />
      </div>

      <SqlCompletionPopup
        completion={completion}
        onAccept={acceptCompletion}
        onHighlight={highlight}
      />

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
