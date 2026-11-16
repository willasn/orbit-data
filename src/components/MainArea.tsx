import { Fragment, useEffect, useRef, useState } from "react";
import { Bot, Code2, History, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useStore } from "../store";
import type { ChatSession, DropZone, PaneLeaf, PaneNode, PaneSplit, Tab } from "../types";
import { allHistory, clearHistory as clearSqlHistory, removeHistoryEntry } from "../db/sqlEditorStorage";
import type { SqlHistoryEntry } from "../db/sqlEditorStorage";
import { ChatView, ResultPanel } from "./ChatView";
import SqlEditorPanel from "./SqlEditorPanel";
import KafkaWorkspace from "./KafkaWorkspace";
import MqttWorkspace from "./MqttWorkspace";
import StorageWorkspace from "./StorageWorkspace";

const TAB_MIME = "application/x-orbit-tab";
/** WebKit 下 dataTransfer 读取不稳定，拖拽期间以模块变量兜底 */
let draggingTabId: string | null = null;

/**
 * 中间主面板：布局树 + 多子面板。
 * 会话、查询结果、SQL 编辑器都以标签页形式存在，可通过拖拽标签左右 / 上下分屏。
 */
export default function MainArea() {
  const layout = useStore((s) => s.layout);
  const sqlExpanded = useStore((s) => s.sqlExpanded);
  return (
    <div className="main-area">
      <LayoutNodeView node={layout} />
      {sqlExpanded && <SqlEditorModal />}
    </div>
  );
}

function LayoutNodeView({ node }: { node: PaneNode }) {
  if (node.type === "leaf") return <LeafPane leaf={node} />;
  return <SplitView split={node} />;
}

function SplitView({ split }: { split: PaneSplit }) {
  const resizeSplit = useStore((s) => s.resizeSplit);
  const containerRef = useRef<HTMLDivElement>(null);

  const startDrag = (e: React.PointerEvent, index: number) => {
    const el = containerRef.current;
    if (!el) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const total = split.dir === "row" ? rect.width : rect.height;
    if (total <= 0) return;
    const startPos = split.dir === "row" ? e.clientX : e.clientY;
    const base = [...split.sizes];

    const onMove = (ev: PointerEvent) => {
      const delta = ((split.dir === "row" ? ev.clientX : ev.clientY) - startPos) / total;
      let a = base[index - 1] + delta;
      let b = base[index] - delta;
      const min = 0.18;
      if (a < min) {
        b -= min - a;
        a = min;
      }
      if (b < min) {
        a -= min - b;
        b = min;
      }
      if (a < min || b < min) return;
      const next = [...base];
      next[index - 1] = a;
      next[index] = b;
      resizeSplit(split.id, next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = split.dir === "row" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div ref={containerRef} className={`pane-split ${split.dir}`}>
      {split.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 && (
            <div
              className={`pane-splitter ${split.dir}`}
              role="separator"
              aria-orientation={split.dir === "row" ? "vertical" : "horizontal"}
              onPointerDown={(e) => startDrag(e, index)}
            />
          )}
          <div
            className="pane-cell"
            style={{ flexGrow: split.sizes[index] ?? 1, flexBasis: 0 }}
          >
            <LayoutNodeView node={child} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function LeafPane({ leaf }: { leaf: PaneLeaf }) {
  const tabs = useStore((s) => s.tabs);
  const sessions = useStore((s) => s.sessions);
  const config = useStore((s) => s.config);
  const isActivePane = useStore((s) => s.activePaneId === leaf.id);
  const setPaneActive = useStore((s) => s.setPaneActive);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const newChat = useStore((s) => s.newChat);
  const openChatTab = useStore((s) => s.openChatTab);
  const toggleChatPin = useStore((s) => s.toggleChatPin);
  const renameChat = useStore((s) => s.renameChat);
  const deleteChat = useStore((s) => s.deleteChat);
  const clearAllChats = useStore((s) => s.clearAllChats);
  const clearChat = useStore((s) => s.clearChat);
  const askConfirm = useStore((s) => s.askConfirm);
  const askText = useStore((s) => s.askText);
  const moveTab = useStore((s) => s.moveTab);
  const showToast = useStore((s) => s.showToast);

  const [showHistory, setShowHistory] = useState(false);
  const [sqlHistory, setSqlHistory] = useState<SqlHistoryEntry[]>([]);
  const [dropZone, setDropZone] = useState<DropZone | null>(null);
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ tabId: string; value: string } | null>(null);

  const leafTabs = leaf.tabIds
    .map((id) => tabs.find((t) => t.id === id))
    .filter((t): t is Tab => !!t);
  const activeTab = leafTabs.find((t) => t.id === leaf.activeTabId) ?? leafTabs[leafTabs.length - 1];
  const activeSession = activeTab?.kind === "chat"
    ? sessions.find((s) => s.id === activeTab.sessionId)
    : undefined;
  // 空会话（新建后未提问）不进入历史会话列表
  const historySessions = sessions.filter((s) => s.messages.length > 0);
  const sortedSessions = [...historySessions]
    .reverse()
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));

  useEffect(() => {
    if (showHistory) setSqlHistory(allHistory());
  }, [showHistory]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
      window.removeEventListener("keydown", dismiss);
    };
  }, [menu]);

  const focusPane = () => {
    if (!isActivePane) setPaneActive(leaf.id);
  };

  const confirmDeleteChat = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    setMenu(null);
    if (!session) return;
    const ok = await askConfirm({
      title: "删除会话",
      message: `确定删除会话「${session.title}」？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (ok) deleteChat(session.id);
  };

  const renameSession = async (sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    setMenu(null);
    if (!session) return;
    const name = await askText({
      title: "重命名会话",
      message: "输入新的会话名称",
      value: session.title,
      confirmText: "保存",
    });
    if (name?.trim()) renameChat(session.id, name.trim());
  };

  /** 清空「历史会话」面板：会话与历史 SQL 一并删除，保留一个空白新对话 */
  const clearAllHistory = async () => {
    if (!historySessions.length && !sqlHistory.length) return;
    const ok = await askConfirm({
      title: "清空全部历史会话",
      message: "将删除所有历史对话与历史 SQL 记录，此操作不可撤销。",
      confirmText: "全部清空",
      danger: true,
    });
    if (!ok) return;
    clearAllChats();
    clearSqlHistory();
    setSqlHistory([]);
  };

  const confirmClearChat = async () => {
    if (!activeSession) return;
    const ok = await askConfirm({
      title: "清空当前会话",
      message: "将删除当前会话的全部消息，此操作不可撤销。",
      confirmText: "清空",
      danger: true,
    });
    if (ok) clearChat(activeSession.id);
  };

  const openSessionMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      sessionId,
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - 156)),
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - 140)),
    });
  };

  /** 历史 SQL 会话：带出连接 / 库 / 表后填入编辑器 */
  const restoreSqlSession = async (entry: SqlHistoryEntry) => {
    setShowHistory(false);
    if (!config?.connections.some((c) => c.id === entry.connId)) {
      showToast("该历史 SQL 对应的连接已不存在");
      return;
    }
    await useStore.getState().selectChatContext(entry.connId, entry.database ?? "", entry.table ?? "");
    useStore.getState().setEditorSql(entry.sql);
    // SQL 输入内嵌在会话面板里：切回会话标签即可带着 SQL 继续编辑 / 执行
    const chatTab = useStore.getState().tabs.find((t) => t.kind === "chat");
    if (chatTab) useStore.getState().setActiveTab(chatTab.id);
    showToast("已载入历史 SQL 会话");
  };

  const deleteSqlSession = async (entry: SqlHistoryEntry) => {
    const ok = await askConfirm({
      title: "删除历史 SQL",
      message: "确定删除这条历史 SQL 会话？此操作不可撤销。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    removeHistoryEntry(entry.connId, entry.at);
    setSqlHistory(allHistory());
  };

  const sessionMeta = (session: ChatSession) => {
    const ctx = session.context;
    if (!ctx) return "";
    const conn = config?.connections.find((c) => c.id === ctx.connId);
    return [conn?.name ?? "已删除连接", ctx.database, ctx.table].filter(Boolean).join(" · ");
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!draggingTabId && !e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / Math.max(rect.width, 1);
    const y = (e.clientY - rect.top) / Math.max(rect.height, 1);
    const zone: DropZone = x < 0.22 ? "left" : x > 0.78 ? "right"
      : y < 0.22 ? "up" : y > 0.78 ? "down" : "center";
    setDropZone(zone);
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const tabId = draggingTabId || e.dataTransfer.getData(TAB_MIME);
    if (!tabId) return;
    e.preventDefault();
    moveTab(tabId, leaf.id, dropZone ?? "center");
    draggingTabId = null;
    setDropZone(null);
  };

  return (
    <div
      className={`pane-leaf${isActivePane ? " active" : ""}`}
      onMouseDown={focusPane}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropZone(null);
      }}
      onDrop={onDrop}
    >
      <div className="tab-bar">
        <div className="tab-strip">
          {leafTabs.map((t) => (
            <div
              key={t.id}
              className={`tab${activeTab?.id === t.id ? " active" : ""}`}
              draggable={renaming?.tabId !== t.id}
              title={t.title}
              onClick={() => {
                focusPane();
                setActiveTab(t.id);
              }}
              onContextMenu={t.kind === "chat" ? (e) => openSessionMenu(e, t.sessionId) : undefined}
              onDragStart={(e) => {
                draggingTabId = t.id;
                e.dataTransfer.setData(TAB_MIME, t.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                draggingTabId = null;
                setDropZone(null);
              }}
            >
              {t.kind === "chat" ? (
                sessions.find((s) => s.id === t.sessionId)?.pinned
                  ? <Pin size={13} />
                  : <Bot size={13} />
              ) : t.kind === "sql" ? (
                <Code2 size={13} />
              ) : (
                <span className="tab-dot" />
              )}
              {renaming?.tabId === t.id ? (
                <input
                  className="tab-rename"
                  autoFocus
                  value={renaming.value}
                  onChange={(e) => setRenaming({ tabId: t.id, value: e.target.value })}
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onBlur={() => {
                    const value = renaming.value.trim();
                    if (value && t.kind === "chat") renameChat(t.sessionId, value);
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const value = renaming.value.trim();
                      if (value && t.kind === "chat") renameChat(t.sessionId, value);
                      setRenaming(null);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setRenaming(null);
                    }
                  }}
                />
              ) : (
                <span
                  className="tab-title"
                  title={t.kind === "chat" ? `${t.title}（双击重命名）` : t.title}
                  onDoubleClick={(e) => {
                    if (t.kind !== "chat") return;
                    e.stopPropagation();
                    setRenaming({ tabId: t.id, value: t.title });
                  }}
                >
                  {t.title}
                </span>
              )}
              <button
                className="tab-close"
                title="关闭标签"
                aria-label="关闭标签"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="tab-action tab-new"
            title="新建会话"
            aria-label="新建会话"
            onClick={(e) => {
              e.stopPropagation();
              focusPane();
              newChat();
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="tab-actions">
          <button
            className={`tab-action${showHistory ? " active" : ""}`}
            title="历史会话"
            aria-label="历史会话"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((open) => !open)}
          >
            <History size={16} />
          </button>
          <button
            className="tab-action danger"
            title="清空当前会话"
            aria-label="清空当前会话"
            disabled={!activeSession?.messages.length || activeSession.streaming}
            onClick={() => void confirmClearChat()}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="chat-workspace">
        <div className="tab-content">
          {activeTab?.kind === "chat" ? (
            <ChatView key={activeTab.sessionId} sessionId={activeTab.sessionId} />
          ) : activeTab?.kind === "result" ? (
            <ResultPanel tab={activeTab} />
          ) : activeTab?.kind === "sql" ? (
            <SqlEditorPanel mode="pane" />
          ) : activeTab?.kind === "messaging" ? (
            config?.connections.find((c) => c.id === activeTab.connId)?.db_type === "mqtt" ? (
              <MqttWorkspace key={activeTab.id} connId={activeTab.connId} />
            ) : (
              <KafkaWorkspace key={activeTab.id} connId={activeTab.connId} initialTopic={activeTab.topic} />
            )
          ) : activeTab?.kind === "storage" ? (
            <StorageWorkspace key={activeTab.id} connId={activeTab.connId} initialBucket={activeTab.bucket} />
          ) : (
            <div className="pane-empty">
              <button className="btn" onClick={newChat}>新建会话</button>
            </div>
          )}
        </div>

        {showHistory && (
          <aside className="chat-history" aria-label="历史会话">
            <div className="history-heading">
              <span>历史会话</span>
              <span className="history-heading-actions">
                <span className="history-count">{historySessions.length}</span>
                <button
                  className="history-clear"
                  title="清空全部历史会话"
                  aria-label="清空全部历史会话"
                  disabled={!historySessions.length && !sqlHistory.length}
                  onClick={() => void clearAllHistory()}
                >
                  <Trash2 size={12} />
                  <span>全部清空</span>
                </button>
              </span>
            </div>
            <div className="history-list">
              {sortedSessions.map((s) => (
                <button
                  key={s.id}
                  className={`history-item${activeTab?.kind === "chat" && activeTab.sessionId === s.id ? " active" : ""}`}
                  title={`${s.title}（右键重命名 / 删除）`}
                  onClick={() => {
                    openChatTab(s.id);
                    setShowHistory(false);
                  }}
                  onContextMenu={(e) => openSessionMenu(e, s.id)}
                >
                  {s.pinned ? <Pin size={14} /> : <Bot size={14} />}
                  <span className="history-item-body">
                    <span className="history-item-title">{s.title}</span>
                    {sessionMeta(s) && <span className="history-item-meta">{sessionMeta(s)}</span>}
                  </span>
                  <span
                    className="history-item-del"
                    role="button"
                    aria-label={`删除会话 ${s.title}`}
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      void confirmDeleteChat(s.id);
                    }}
                  >
                    <Trash2 size={12} />
                  </span>
                </button>
              ))}
              {sqlHistory.length > 0 && (
                <>
                  <div className="history-subheading">SQL 会话 · {sqlHistory.length}</div>
                  {sqlHistory.map((entry) => (
                    <button
                      key={`${entry.connId}-${entry.at}`}
                      className="history-item sql"
                      title={entry.sql}
                      onClick={() => void restoreSqlSession(entry)}
                    >
                      <Code2 size={14} />
                      <span className="history-item-body">
                        <span className="history-item-title">
                          {entry.sql.replace(/\s+/g, " ").trim().slice(0, 60) || "空 SQL"}
                        </span>
                        <span className="history-item-meta">
                          {[entry.connName, entry.database, entry.table].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <span
                        className="history-item-del"
                        role="button"
                        aria-label="删除该历史 SQL"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteSqlSession(entry);
                        }}
                      >
                        <Trash2 size={12} />
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      {dropZone && <div className={`drop-overlay ${dropZone}`} aria-hidden="true" />}

      {menu && sessions.some((s) => s.id === menu.sessionId) && (
        <div
          className="session-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            role="menuitem"
            onClick={() => void renameSession(menu.sessionId)}
          >
            <Pencil size={14} />重命名
          </button>
          <button
            role="menuitem"
            onClick={() => {
              toggleChatPin(menu.sessionId);
              setMenu(null);
            }}
          >
            {sessions.find((s) => s.id === menu.sessionId)?.pinned
              ? <PinOff size={14} />
              : <Pin size={14} />}
            {sessions.find((s) => s.id === menu.sessionId)?.pinned ? "取消置顶" : "置顶会话"}
          </button>
          <button
            role="menuitem"
            className="danger"
            disabled={sessions.find((s) => s.id === menu.sessionId)?.streaming}
            onClick={() => void confirmDeleteChat(menu.sessionId)}
          >
            <Trash2 size={14} />删除会话
          </button>
        </div>
      )}
    </div>
  );
}

/** SQL 编辑器放大弹窗 */
function SqlEditorModal() {
  const setSqlExpanded = useStore((s) => s.setSqlExpanded);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSqlExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSqlExpanded]);

  return (
    <div
      className="sql-modal"
      role="dialog"
      aria-modal="true"
      aria-label="SQL 编辑器"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setSqlExpanded(false);
      }}
    >
      <div className="sql-modal-panel">
        <SqlEditorPanel mode="modal" />
      </div>
    </div>
  );
}
