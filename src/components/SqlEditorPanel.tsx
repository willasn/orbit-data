import { useEffect, useMemo, useRef, useState } from "react";
import { Ban, Play, Save, WandSparkles, Trash2 } from "lucide-react";
import { useStore } from "../store";
import DataGrid from "./DataGrid";
import Chart from "./Chart";
import { driverOf } from "../db/drivers";

const SAVE_KEY = "orbit-data.saved-queries";

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
    resultView,
    setResultView,
    rightWidth,
  } = useStore();

  const conn = config?.connections.find((c) => c.id === activeConnId) ?? null;
  const tree = dbTree[activeConnId];
  const [lineCount, setLineCount] = useState(1);
  const [saved, setSaved] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(SAVE_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const taRef = useRef<HTMLTextAreaElement>(null);

  const isRedis = conn?.db_type === "redis";
  const isSearch = !!conn && driverOf(conn.db_type).caps.mapping;

  useEffect(() => {
    setLineCount(editorSql.split("\n").length);
  }, [editorSql]);

  const activeResult = useMemo(() => {
    const { tabs, activeTabId } = useStore.getState();
    const t = tabs.find((x) => x.id === activeTabId);
    return t?.kind === "result" ? t.result : null;
  }, [resultView, activeConnId, editorSql]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div className="sql-panel" style={{ width: rightWidth }}>
      <div className="panel-header">
        <span>{isSearch ? "ES 查询控制台" : isRedis ? "Redis 控制台" : "SQL 编辑器"}</span>
        <span className="header-badge">{conn.name}</span>
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
      </div>

      <div className="sql-editor">
        <div className="line-numbers">
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={taRef}
          value={editorSql}
          onChange={(e) => setEditorSql(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              runSql(editorSql);
            }
          }}
          spellCheck={false}
          placeholder={isSearch ? 'POST /example-index/_search\n{ "query": { "match_all": {} }, "size": 20 }\n（只读查询，⌘+Enter 运行）' : isRedis ? "例如: GET mykey" : "SELECT * FROM …  (⌘+Enter 运行)"}
        />
      </div>

      <div className="sql-actions">
        <button className="btn primary" onClick={() => runSql(editorSql)}>
          <Play size={13} /> 运行
        </button>
        {!isRedis && (
          <button className="btn" onClick={() => {
            if (!isSearch) { setEditorSql(formatSql(editorSql)); return; }
            try {
              const text = editorSql.trim();
              if (text.startsWith("{")) setEditorSql(JSON.stringify(JSON.parse(text), null, 2));
              else {
                const split = text.indexOf("\n");
                if (split >= 0) setEditorSql(`${text.slice(0, split)}\n${JSON.stringify(JSON.parse(text.slice(split + 1)), null, 2)}`);
              }
            } catch { showToast("JSON 格式无效，无法格式化"); }
          }}>
            <WandSparkles size={13} /> 格式化
          </button>
        )}
        <button
          className="btn"
          onClick={() => {
            const next = [...saved, editorSql].filter((s) => s.trim());
            setSaved(next);
            localStorage.setItem(SAVE_KEY, JSON.stringify(next.slice(-20)));
          }}
        >
          <Save size={13} /> 保存
        </button>
      </div>

      {saved.length > 0 && (
        <div className="saved-queries">
          <div className="saved-header">
            <span>已保存 ({saved.length})</span>
            <button
              className="icon-btn danger"
              title="清空"
              onClick={() => {
                setSaved([]);
                localStorage.removeItem(SAVE_KEY);
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
          {[...saved].reverse().slice(0, 5).map((s, i) => (
            <div key={i} className="saved-item" onClick={() => setEditorSql(s)}>
              {s.length > 40 ? s.slice(0, 40) + "…" : s}
            </div>
          ))}
        </div>
      )}

      <div className="sql-result">
        <div className="result-subtabs">
          <button className={resultView === "table" ? "active" : ""} onClick={() => setResultView("table")}>
            结果
          </button>
          <button className={resultView === "chart" ? "active" : ""} onClick={() => setResultView("chart")}>
            可视化
          </button>
        </div>
        <div className="result-body">
          {activeResult ? (
            resultView === "table" ? <DataGrid result={activeResult} /> : <Chart result={activeResult} />
          ) : (
            <div className="empty-hint center">运行 SQL 后在此查看结果</div>
          )}
        </div>
      </div>
    </div>
  );
}
