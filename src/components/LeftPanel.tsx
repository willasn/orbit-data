import { useEffect, useRef, useState } from "react";
import type { MouseEvent, RefObject } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Plus,
  Table2,
  KeyRound,
  Eye,
  Radio,
  Loader2,
  PanelLeft,
  PanelRight,
  Settings,
} from "lucide-react";
import { useStore } from "../store";
import { driverOf } from "../db/drivers";
import { buildMenu, type MenuCtx } from "../db/menuItems";
import ContextMenu from "./ContextMenu";

/** 每一层一次渲染的条目数(长列表按需渲染,滚动到底自动追加下一批) */
const PAGE_SIZE = 100;

export default function LeftPanel() {
  const {
    config,
    view,
    setView,
    showLeft,
    showRight,
    togglePanel,
    leftWidth,
    activeConnId,
    dbTree,
    connSessions,
    collapsedGroups,
    toggleGroup,
    toggleConnection,
    connectDb,
    disconnectDb,
    selectConnection,
    selectDatabase,
    selectTable,
    openDialog,
    openMessaging,
    openStorage,
  } = useStore();

  // 同组聚拢(组内保持配置顺序,未分组排最后)
  const ordered = [...(config?.connections ?? [])].sort((a, b) => {
    const ka = a.group ? `0${a.group}` : "1";
    const kb = b.group ? `0${b.group}` : "1";
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const listRef = useRef<HTMLDivElement>(null);
  // 各层级已渲染的条目数,key 形如 db:<conn> / t:<conn>:<db> / c:<conn>:<db>:<table>
  const [shown, setShown] = useState<Record<string, number>>({});

  // 右键菜单：连接级统一,库级 / 表级按大类,条目由能力位驱动(见 CONTEXT_MENU.md)
  const [menu, setMenu] = useState<{ x: number; y: number; ctx: MenuCtx } | null>(null);
  const openMenu = (e: MouseEvent, ctx: MenuCtx) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, ctx });
  };

  const limitOf = (key: string, total: number) => Math.min(shown[key] ?? PAGE_SIZE, total);
  const showMore = (key: string) =>
    setShown((s) => ({ ...s, [key]: (s[key] ?? PAGE_SIZE) + PAGE_SIZE }));

  const actions = (
    <>
      <button
        className={`footer-btn${showLeft ? " active" : ""}`}
        title={showLeft ? "收起左栏" : "展开左栏"}
        onClick={() => togglePanel("left")}
      >
        <PanelLeft size={15} />
      </button>
      <button
        className={`footer-btn${showRight ? " active" : ""}`}
        title={showRight ? "收起右栏" : "展开右栏"}
        onClick={() => togglePanel("right")}
      >
        <PanelRight size={15} />
      </button>
      <button
        className={`footer-btn${view === "settings" ? " active" : ""}`}
        title="设置"
        onClick={() => setView("settings")}
      >
        <Settings size={15} />
      </button>
    </>
  );

  if (!showLeft) {
    return (
      <div className="left-panel collapsed">
        <div className="panel-footer vertical">{actions}</div>
      </div>
    );
  }

  return (
    <div className="left-panel" style={{ width: leftWidth }}>
      <div className="panel-section grow">
        <div className="panel-header">
          <span>数据库连接</span>
          <button className="icon-btn" title="新建连接" onClick={() => openDialog()}>
            <Plus size={14} />
          </button>
        </div>
        <div className="conn-list" ref={listRef}>
          {ordered.map((c, i) => {
            const tree = dbTree[c.id];
            const expanded = tree?.expanded ?? false;
            const driver = driverOf(c.db_type);
            const loading = tree?.loading ?? "";
            const dbs = driver.caps.databases ? (tree?.databases ?? []) : (tree?.databases ? [""] : []);
            const dbLimit = limitOf(`db:${c.id}`, dbs.length);
            // 分组头只在该组第一项前渲染；分组折叠时组内其余项不渲染
            const groupStart = i === 0 || ordered[i - 1].group !== c.group;
            const collapsed = c.group ? collapsedGroups[c.group] ?? false : false;
            if (c.group && collapsed && !groupStart) return null;
            const session = connSessions[c.id];
            return (
              <div key={c.id} className={`conn-node${c.group ? " in-group" : ""}`}>
                {groupStart && c.group && (
                  <div className="group-row" onClick={() => toggleGroup(c.group)}>
                    {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    <Folder size={12} />
                    <span className="tree-label">{c.group}</span>
                    <span className="group-count">
                      {ordered.filter((x) => x.group === c.group).length}
                    </span>
                  </div>
                )}
                {(!c.group || !collapsed) && (
                <div
                  className={`conn-item${activeConnId === c.id ? " selected" : ""}${
                    c.group ? " in-group" : ""
                  }`}
                  onClick={() => toggleConnection(c.id)}
                  onDoubleClick={
                    driver.caps.messaging
                      ? () => void openMessaging(c.id)
                      : driver.caps.storage
                        ? () => void openStorage(c.id)
                        : undefined
                  }
                  onContextMenu={(e) =>
                    openMenu(e, { kind: "connection", conn: c, driver })
                  }
                >
                  {loading === "databases" ? (
                    <Loader2 size={13} className="spin" />
                  ) : expanded ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                  <div className="conn-info">
                    <div className="conn-title">
                      <div className="conn-name" title={c.name}>{c.name}</div>
                      <span className="conn-type" style={{ color: driver.color }} title={driver.label}>
                        {driver.label}
                      </span>
                    </div>
                    <div className="conn-host">
                      {c.db_type === "mqtt"
                        ? `${c.host}:${c.port}`
                        : driver.caps.storage
                          ? `${c.oss?.scheme ?? "https"}://${c.host}`
                          : driver.caps.messaging
                            ? (c.kafka?.bootstrap_servers ?? []).join(", ")
                            : `${c.host}:${c.port}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`conn-status${session ? " on" : ""}`}
                    title={session ? "断开连接" : "连接"}
                    aria-label={session ? `断开 ${c.name}` : `连接 ${c.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void (session ? disconnectDb(c.id) : connectDb(c.id));
                    }}
                  />
                </div>
                )}

                {expanded && !collapsed && (
                  <>
                    {loading === "databases" && (
                      <div className="tree-row indent1 tree-loading">
                        <Loader2 size={12} className="spin" />
                        <span>正在加载{driver.caps.databases ? driver.dbLabel : driver.tableLabel}…</span>
                      </div>
                    )}
                    {loading !== "databases" && tree?.errorLevel === "databases" && (
                      <div
                        className="tree-row indent1 tree-error"
                        title={tree.error}
                        onClick={() => selectConnection(c.id)}
                      >
                        <span>加载失败,点击重试</span>
                      </div>
                    )}
                    {loading !== "databases" && tree?.errorLevel !== "databases" && dbs.length === 0 && (
                      <div className="tree-row indent1 tree-loading">
                        {driver.caps.messaging
                          ? "双击连接打开消息工作区"
                          : driver.caps.storage
                            ? "双击连接打开对象存储工作区"
                            : "无数据库"}
                      </div>
                    )}

                    {dbs.slice(0, dbLimit).map((db) => {
                      const dbOpen = !driver.caps.databases || tree?.selectedDb === db;
                      const tables = dbOpen ? (tree?.tables ?? []) : [];
                      const tLimit = limitOf(`t:${c.id}:${db}`, tables.length);
                      const loadingTables = dbOpen && loading === "tables";
                      const dbError =
                        dbOpen && loading !== "tables" && tree?.errorLevel === "tables"
                          ? tree.error
                          : undefined;
                      return (
                        <div key={db}>
                          {driver.caps.databases && <div
                            className={`tree-row indent1${dbOpen ? " open" : ""}`}
                            onClick={() => {
                              selectDatabase(c.id, db);
                              // 对象存储：已打开工作区时，选中 Bucket 即同步，避免展示上一个 Bucket 的内容
                              const synced = useStore.getState().tabs
                                .some((t) => t.kind === "storage" && t.connId === c.id);
                              if (driver.caps.storage && synced) void openStorage(c.id, db);
                            }}
                            onDoubleClick={driver.caps.storage ? () => void openStorage(c.id, db) : undefined}
                            onContextMenu={(e) =>
                              openMenu(e, {
                                kind: "database",
                                conn: c,
                                driver,
                                database: db,
                              })
                            }
                          >
                            {loadingTables ? (
                              <Loader2 size={13} className="spin" />
                            ) : dbOpen ? (
                              <ChevronDown size={13} />
                            ) : (
                              <ChevronRight size={13} />
                            )}
                            <DatabaseIcon />
                            <span className="tree-label">
                              {db}
                              {loadingTables ? " · 正在加载中…" : ""}
                            </span>
                          </div>}

                          {dbOpen && (
                            <>
                              {loadingTables && (
                                <div className="tree-row indent2 tree-loading">
                                  <Loader2 size={12} className="spin" />
                                  <span>正在加载表…</span>
                                </div>
                              )}
                              {dbError && (
                                <div
                                  className="tree-row indent2 tree-error"
                                  title={dbError}
                                  onClick={() => selectDatabase(c.id, db)}
                                >
                                  <span>加载失败,点击重试</span>
                                </div>
                              )}
                              {!loadingTables && !dbError && tables.length === 0 && (
                                driver.caps.messaging ? (
                                  <div className={`tree-row indent${driver.caps.databases ? 2 : 1} tree-more`} onClick={() => void openMessaging(c.id)}>
                                    <Radio size={12} />
                                    <span>打开消息工作区</span>
                                  </div>
                                ) : driver.caps.storage ? (
                                  <div className={`tree-row indent${driver.caps.databases ? 2 : 1} tree-more`} onClick={() => void openStorage(c.id, db)}>
                                    <Radio size={12} />
                                    <span>打开对象存储工作区</span>
                                  </div>
                                ) : (
                                  <div className="tree-row indent2 tree-loading">无对象</div>
                                )
                              )}

                              {tables.slice(0, tLimit).map((t) => {
                                const tOpen = tree?.selectedTable === t.name;
                                const cols = tOpen ? (tree?.columns ?? []) : [];
                                const cLimit = limitOf(`c:${c.id}:${db}:${t.name}`, cols.length);
                                const loadingCols = tOpen && loading === "columns";
                                return (
                                  <div key={t.name}>
                                    <div
                                      className={`tree-row indent${driver.caps.databases ? 2 : 1}${tOpen ? " open" : ""}`}
                                      onClick={() => selectTable(c.id, db, t.name)}
                                      onDoubleClick={driver.caps.browseMessages ? () => void useStore.getState().openMessaging(c.id, t.name) : undefined}
                                      onContextMenu={(e) =>
                                        openMenu(e, {
                                          kind: "table",
                                          conn: c,
                                          driver,
                                          database: db,
                                          table: t.name,
                                          tableType: t.type,
                                        })
                                      }
                                    >
                                      {loadingCols ? (
                                        <Loader2 size={12} className="spin" />
                                      ) : driver.caps.messaging ? (
                                        <Radio size={12} />
                                      ) : t.type === "view" ? (
                                        <Eye size={12} />
                                      ) : t.type === "key" ? (
                                        <KeyRound size={12} />
                                      ) : (
                                        <Table2 size={12} />
                                      )}
                                      <span className="tree-label">
                                        {t.name}
                                        {loadingCols ? " · 正在加载中…" : ""}
                                      </span>
                                      {!loadingCols && <span className="tree-tag">{t.type}</span>}
                                    </div>

                                    {tOpen && (
                                      <>
                                        {loadingCols && (
                                          <div className="tree-row indent3 tree-loading">
                                            <Loader2 size={12} className="spin" />
                                            <span>正在加载字段…</span>
                                          </div>
                                        )}
                                        {loading !== "columns" && tree?.errorLevel === "columns" && (
                                          <div
                                            className="tree-row indent3 tree-error"
                                            title={tree.error}
                                            onClick={() => selectTable(c.id, db, t.name)}
                                          >
                                            <span>加载失败,点击重试</span>
                                          </div>
                                        )}
                                        {cols.slice(0, cLimit).map((col) => (
                                          <div
                                            className={`tree-row indent${driver.caps.databases ? 3 : 2} col-row`}
                                            key={col.name}
                                            onContextMenu={(e) =>
                                              openMenu(e, {
                                                kind: "column",
                                                conn: c,
                                                driver,
                                                database: db,
                                                table: t.name,
                                                column: col.name,
                                                dataType: col.data_type,
                                              })
                                            }
                                          >
                                            <span className="tree-label">{col.name}</span>
                                            <span className="tree-tag">{col.data_type}</span>
                                            {col.key === "PRI" && <span className="tree-tag key">PK</span>}
                                          </div>
                                        ))}
                                        {cols.length > cLimit && (
                                          <TreeMore
                                            indent={3}
                                            remaining={cols.length - cLimit}
                                            rootRef={listRef}
                                            onClick={() => showMore(`c:${c.id}:${db}:${t.name}`)}
                                          />
                                        )}
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                              {tables.length > tLimit && (
                                <TreeMore
                                  indent={2}
                                  remaining={tables.length - tLimit}
                                  rootRef={listRef}
                                  onClick={() => showMore(`t:${c.id}:${db}`)}
                                />
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                    {dbs.length > dbLimit && (
                      <TreeMore
                        indent={1}
                        remaining={dbs.length - dbLimit}
                        rootRef={listRef}
                        onClick={() => showMore(`db:${c.id}`)}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
          {ordered.length === 0 && (
            <div className="empty-hint">还没有连接,点击 + 新建</div>
          )}
        </div>
      </div>

      <div className="panel-footer">
        <div className="footer-status">
          <span className="status-dot ok" /> 已就绪
        </div>
        <div className="footer-actions">{actions}</div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={buildMenu(menu.ctx)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** 长列表末尾的「加载更多」:滚动进入视口时自动追加下一批,也可点击 */
function TreeMore({
  indent,
  remaining,
  rootRef,
  onClick,
}: {
  indent: 1 | 2 | 3;
  remaining: number;
  rootRef: RefObject<HTMLDivElement>;
  onClick: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onClick();
      },
      { root: rootRef.current, rootMargin: "160px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onClick, rootRef]);

  return (
    <div ref={ref} className={`tree-row indent${indent} tree-more`} onClick={onClick}>
      <ChevronDown size={12} />
      <span>加载更多（剩余 {remaining}）</span>
    </div>
  );
}

function DatabaseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}
