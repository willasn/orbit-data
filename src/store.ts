import { create } from "zustand";
import { api, type ChatEvent } from "./api";
import { driverOf } from "./db/drivers";
import type {
  AppConfig,
  ChatMessage,
  ChatSession,
  Connection,
  DbTree,
  QueryResult,
  SessionInfo,
  Tab,
} from "./types";

const connectionEpochs = new Map<string, number>();
/** 同一连接并发触发连接时复用同一次握手（双击打开消息工作区会同时触发选中与打开） */
const pendingConnects = new Map<string, Promise<void>>();
let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${idSeq++}`;

/** 当前正在进行(未被中断)的 AI 请求 ID；用于丢弃已停止请求的后续事件 */
let activeRequestId: string | null = null;
/** 当前请求所属会话(切换标签后仍能中断正确的会话) */
let activeRequestSession: string | null = null;

const PANE_KEY = "orbit-data.pane-widths";
const DEFAULT_PANES = { leftWidth: 264, rightWidth: 372 };
const GROUP_KEY = "orbit-data.group-collapsed";
const CHAT_KEY = "orbit-data.chat-sessions";

function loadChats(): ChatSession[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CHAT_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((s): s is ChatSession =>
      s !== null && typeof s === "object" && typeof s.id === "string" &&
      typeof s.title === "string" && Array.isArray(s.messages) &&
      s.messages.every((m: unknown) => m !== null && typeof m === "object" &&
        "role" in m && (m.role === "user" || m.role === "assistant") &&
        "content" in m && typeof m.content === "string")
    ).map((s) => ({ ...s, title: s.messages.find((m) => m.role === "user")?.content ?? s.title, streaming: false }));
  } catch {
    return [];
  }
}

function saveChats(sessions: ChatSession[]) {
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify(sessions.map((s) => ({
      id: s.id, title: s.title, modelId: s.modelId, pinned: s.pinned,
      messages: s.messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content),
    }))));
  } catch {
    // 本地存储不可用或空间不足时，当前会话仍可继续使用。
  }
}

/** 左栏分组折叠状态(本地记忆,与连接配置解耦) */
function loadGroups(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(GROUP_KEY) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** 左右栏宽度(拖动分隔条调整,本地记忆) */
function loadPanes(): { leftWidth: number; rightWidth: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(PANE_KEY) ?? "{}");
    return {
      leftWidth: typeof raw.leftWidth === "number" ? raw.leftWidth : DEFAULT_PANES.leftWidth,
      rightWidth: typeof raw.rightWidth === "number" ? raw.rightWidth : DEFAULT_PANES.rightWidth,
    };
  } catch {
    return { ...DEFAULT_PANES };
  }
}

/** 应用内输入 / 确认弹窗的参数（macOS 的 WKWebView 不弹 window.prompt，统一走这里） */
export interface AskOptions {
  title: string;
  message?: string;
  /** 输入框初始值（仅 kind = "text"） */
  value?: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  confirmText?: string;
  /** 危险操作：输入必须与该值完全一致才能确认 */
  expect?: string;
  danger?: boolean;
}

export interface AskState extends AskOptions {
  kind: "text" | "confirm";
  value: string;
  /** 确认时回传输入值，取消 / 关闭回传 null */
  resolve: (value: string | null) => void;
}

interface Store {
  config: AppConfig | null;
  view: "chat" | "settings";
  showLeft: boolean;
  showRight: boolean;
  leftWidth: number;
  rightWidth: number;
  dialogOpen: false | "new" | Connection;
  createTarget: null | { connId: string; kind: "database" | "table" | "key"; database?: string };
  /** 当前打开的输入 / 确认弹窗（同一时刻只有一个） */
  ask: AskState | null;

  activeConnId: string;
  dbTree: Record<string, DbTree>;
  /** 已建立的连接会话:conn.id -> 会话信息(连接 / 断开) */
  connSessions: Record<string, SessionInfo>;
  /** 左栏分组名 -> 是否折叠 */
  collapsedGroups: Record<string, boolean>;

  sessions: ChatSession[];
  tabs: Tab[];
  activeTabId: string;

  editorSql: string;
  resultView: "table" | "chart";
  toast: string;

  init: () => Promise<void>;
  showToast: (msg: string) => void;
  setView: (v: "chat" | "settings") => void;
  togglePanel: (side: "left" | "right") => void;
  setPaneWidth: (side: "left" | "right", width: number) => void;
  openDialog: (conn?: Connection) => void;
  closeDialog: () => void;
  openCreate: (target: NonNullable<Store["createTarget"]>) => void;
  closeCreate: () => void;
  /** 输入类弹窗：确认返回输入内容，取消返回 null */
  askText: (opts: AskOptions) => Promise<string | null>;
  /** 确认类弹窗：确认返回 true，取消返回 false */
  askConfirm: (opts: AskOptions) => Promise<boolean>;
  resolveAsk: (value: string | null) => void;
  setEditorSql: (sql: string) => void;
  setResultView: (v: "table" | "chart") => void;

  saveConnection: (conn: Connection) => Promise<void>;
  removeConnection: (id: string) => Promise<void>;
  connectDb: (id: string) => Promise<void>;
  disconnectDb: (id: string) => Promise<void>;
  toggleGroup: (group: string) => void;
  selectConnection: (id: string) => Promise<void>;
  toggleConnection: (id: string) => Promise<void>;
  refreshConnection: (id: string) => Promise<void>;
  selectDatabase: (connId: string, db: string) => Promise<void>;
  refreshTables: (connId: string, db: string) => Promise<void>;
  selectTable: (connId: string, db: string, table: string) => Promise<void>;
  selectChatContext: (connId: string, db?: string, table?: string, column?: string) => Promise<void>;
  selectChatModel: (sessionId: string, modelId: string) => void;

  runSql: (sql: string) => Promise<void>;
  /** Redis 键内容预览：按值类型取数并以表格展示(string / hash / list / set / zset / stream) */
  inspectKey: (key: string) => Promise<void>;

  newChat: () => void;
  clearChat: (sessionId: string) => void;
  toggleChatPin: (sessionId: string) => void;
  deleteChat: (sessionId: string) => void;
  openMessaging: (connId: string, topic?: string) => Promise<void>;
  openChatTab: (sessionId: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  sendChat: (text: string) => Promise<void>;
  /** 中断当前正在生成的回答(已生成内容保留) */
  stopChat: () => void;

  toastTimer: ReturnType<typeof setTimeout> | null;
}

const emptyTree = (): DbTree => ({
  expanded: false,
  databases: null,
  selectedDb: "",
  tables: null,
  tablesDb: "",
  selectedTable: "",
  selectedColumn: "",
  columns: null,
  columnsTable: "",
  loading: "",
  error: "",
  errorLevel: "",
});

type SetFn = (partial: Partial<Store>) => void;
type GetFn = () => Store;

/** 局部更新某条连接的对象树(以最新 state 为基准,避免并发请求互相覆盖) */
function patchTree(set: SetFn, get: GetFn, connId: string, patch: Partial<DbTree>) {
  const tree = get().dbTree[connId] ?? emptyTree();
  set({ dbTree: { ...get().dbTree, [connId]: { ...tree, ...patch } } });
}

function activeConn(config: AppConfig | null, connId: string): Connection | null {
  if (!config) return null;
  return config.connections.find((c) => c.id === connId) ?? null;
}

export const useStore = create<Store>((set, get) => ({
  config: null,
  view: "chat",
  showLeft: true,
  showRight: true,
  ...loadPanes(),
  dialogOpen: false,
  createTarget: null,
  ask: null,
  activeConnId: "",
  dbTree: {},
  connSessions: {},
  collapsedGroups: loadGroups(),
  sessions: [],
  tabs: [],
  activeTabId: "",
  editorSql: "",
  resultView: "table",
  toast: "",
  toastTimer: null,

  init: async () => {
    const config = await api.getConfig();
    set({ config });
    // 同步后端已建立的连接会话(后端重启后会话表为空,这里按实际情况刷新)
    try {
      set({ connSessions: await api.connectionStatus() });
    } catch {
      /* 忽略:状态不可用时不阻塞启动 */
    }
    if (get().tabs.length === 0) {
      const history = loadChats();
      const session = history[history.length - 1] ?? {
        id: nextId("chat"), title: "新对话", messages: [], streaming: false,
      };
      set({
        sessions: history.length ? history : [session],
        tabs: [{ id: `tab-${session.id}`, kind: "chat", sessionId: session.id, title: session.title }],
        activeTabId: `tab-${session.id}`,
      });
    }
  },

  showToast: (msg) => {
    const t = get().toastTimer;
    if (t) clearTimeout(t);
    set({ toast: msg, toastTimer: setTimeout(() => set({ toast: "" }), 4000) });
  },

  setView: (view) => set({ view }),
  togglePanel: (side) =>
    set(side === "left" ? { showLeft: !get().showLeft } : { showRight: !get().showRight }),
  setPaneWidth: (side, width) => {
    const w = Math.round(width);
    set(side === "left" ? { leftWidth: w } : { rightWidth: w });
    try {
      localStorage.setItem(
        PANE_KEY,
        JSON.stringify({ leftWidth: get().leftWidth, rightWidth: get().rightWidth }),
      );
    } catch {
      /* 忽略存储失败 */
    }
  },
  openDialog: (conn) => set({ dialogOpen: conn ?? "new" }),
  closeDialog: () => set({ dialogOpen: false }),
  openCreate: (createTarget) => set({ createTarget }),
  closeCreate: () => set({ createTarget: null }),
  askText: (opts) =>
    new Promise<string | null>((resolve) => {
      set({ ask: { ...opts, kind: "text", value: opts.value ?? "", resolve } });
    }),
  askConfirm: (opts) =>
    new Promise<boolean>((resolve) => {
      set({
        ask: {
          ...opts,
          kind: "confirm",
          value: "",
          resolve: (value) => resolve(value !== null),
        },
      });
    }),
  resolveAsk: (value) => {
    const ask = get().ask;
    if (!ask) return;
    set({ ask: null });
    ask.resolve(value);
  },
  setEditorSql: (sql) => set({ editorSql: sql }),
  setResultView: (resultView) => set({ resultView }),

  saveConnection: async (conn) => {
    try {
      const config = await api.saveConnection(conn);
      if (conn.id && (driverOf(conn.db_type).caps.messaging ||
        driverOf(activeConn(get().config, conn.id)?.db_type ?? "").caps.messaging)) {
        get().tabs.filter((t) => t.kind === "messaging" && t.connId === conn.id).forEach((t) => get().closeTab(t.id));
        await get().disconnectDb(conn.id);
      }
      set({ config, dialogOpen: false });
      get().showToast("连接已保存");
    } catch (e) {
      get().showToast(`保存失败: ${e}`);
    }
  },

  removeConnection: async (id) => {
    try {
      const config = await api.deleteConnection(id);
      connectionEpochs.set(id, (connectionEpochs.get(id) ?? 0) + 1);
      get().tabs.filter((t) => t.kind === "messaging" && t.connId === id).forEach((t) => get().closeTab(t.id));
      const dbTree = { ...get().dbTree };
      delete dbTree[id];
      const connSessions = { ...get().connSessions };
      delete connSessions[id];
      set({
        config,
        dbTree,
        connSessions,
        activeConnId: get().activeConnId === id ? "" : get().activeConnId,
      });
      await api.disconnectDb(id).catch(() => undefined);
      get().showToast("连接已删除");
    } catch (e) {
      get().showToast(`删除失败: ${e}`);
    }
  },

  /** 建立连接:真实握手验证一次,成功后左栏显示「已连接」 */
  connectDb: async (id) => {
    const running = pendingConnects.get(id);
    if (running) return running;
    const task = (async () => {
      const conn = activeConn(get().config, id);
      if (!conn) return;
      const epoch = (connectionEpochs.get(id) ?? 0) + 1;
      connectionEpochs.set(id, epoch);
      try {
        const detail = await api.connectDb(conn);
        if (connectionEpochs.get(id) !== epoch || activeConn(get().config, id) !== conn) return;
        set({
          connSessions: {
            ...get().connSessions,
            [id]: { db_type: conn.db_type, detail, since_ms: Date.now() },
          },
        });
        get().showToast(`已连接 ${conn.name}`);
      } catch (e) {
        if (connectionEpochs.get(id) !== epoch || activeConn(get().config, id) !== conn) return;
        const connSessions = { ...get().connSessions };
        delete connSessions[id];
        set({ connSessions });
        get().showToast(`连接失败: ${e}`);
      }
    })();
    pendingConnects.set(id, task);
    try {
      await task;
    } finally {
      pendingConnects.delete(id);
    }
  },

  /** 断开连接:清除会话并丢弃该连接已缓存的元数据(树保留展开态,再次展开会重连) */
  disconnectDb: async (id) => {
    const conn = activeConn(get().config, id);
    connectionEpochs.set(id, (connectionEpochs.get(id) ?? 0) + 1);
    // 等待进行中的握手结束，避免断开后又被握手结果重新建连
    const pending = pendingConnects.get(id);
    if (pending) await pending.catch(() => undefined);
    get().tabs.filter((t) => t.kind === "messaging" && t.connId === id).forEach((t) => get().closeTab(t.id));
    const connSessions = { ...get().connSessions };
    delete connSessions[id];
    const tree = get().dbTree[id];
    set({
      connSessions,
      dbTree: tree
        ? { ...get().dbTree, [id]: emptyTree() }
        : get().dbTree,
    });
    await api.disconnectDb(id).catch(() => undefined);
    get().showToast(conn ? `已断开 ${conn.name}` : "已断开");
  },

  /** 折叠 / 展开左栏分组(状态存本地) */
  toggleGroup: (group) => {
    const collapsed = { ...get().collapsedGroups };
    if (collapsed[group]) delete collapsed[group];
    else collapsed[group] = true;
    set({ collapsedGroups: collapsed });
    try {
      localStorage.setItem(GROUP_KEY, JSON.stringify(collapsed));
    } catch {
      /* 忽略存储失败 */
    }
  },

  /** 选中并展开连接(幂等:已展开时不会收起,右键菜单等场景复用) */
  selectConnection: async (id) => {
    const { config, dbTree } = get();
    if (!config) return;
    const conn = config.connections.find((c) => c.id === id);
    if (!conn) return;
    const tree = dbTree[id] ?? emptyTree();
    set({
      activeConnId: id,
      dbTree: { ...dbTree, [id]: { ...tree, expanded: true, error: "", errorLevel: "" } },
    });
    if (tree.databases != null) return;
    patchTree(set, get, id, { loading: "databases" });
    try {
      if (!get().connSessions[id]) await get().connectDb(id);
      if (!get().connSessions[id]) {
        patchTree(set, get, id, { loading: "", error: "连接失败", errorLevel: "databases" });
        return;
      }
      if (!driverOf(conn.db_type).caps.databases) {
        const tables = await api.listTables(conn, "");
        patchTree(set, get, id, { databases: [], tables, tablesDb: "", loading: "", error: "", errorLevel: "" });
      } else {
        const databases = await api.listDatabases(conn);
        patchTree(set, get, id, { databases, loading: "", error: "", errorLevel: "" });
      }
    } catch (e) {
      const msg = `加载数据库列表失败: ${e}`;
      patchTree(set, get, id, { loading: "", error: msg, errorLevel: "databases" });
      get().showToast(msg);
    }
  },

  /** 左栏点击连接行:已展开则收起(保留选中与缓存),未展开则选中并加载 */
  toggleConnection: async (id) => {
    const tree = get().dbTree[id];
    if (tree?.expanded) {
      set({ activeConnId: id, dbTree: { ...get().dbTree, [id]: { ...tree, expanded: false } } });
      return;
    }
    await get().selectConnection(id);
  },

  /** 右键「刷新元数据」：丢弃缓存的库/表/列,重新拉取并恢复展开状态 */
  refreshConnection: async (id) => {
    const db = get().dbTree[id]?.selectedDb ?? "";
    set({ dbTree: { ...get().dbTree, [id]: { ...emptyTree(), expanded: true } } });
    await get().selectConnection(id);
    if (db) await get().selectDatabase(id, db);
  },

  selectDatabase: async (connId, db) => {
    const { config } = get();
    const conn = config?.connections.find((c) => c.id === connId);
    if (!conn) return;
    const tree = get().dbTree[connId] ?? emptyTree();
    // 命中缓存时直接展开,不再请求
    const cached = tree.tablesDb === db ? tree.tables : null;
    const collapsing = tree.selectedDb === db && cached != null;
    patchTree(set, get, connId, {
      selectedDb: collapsing ? "" : db,
      tables: cached,
      tablesDb: cached ? db : "",
      selectedTable: "",
      selectedColumn: "",
      columns: null,
      columnsTable: "",
      loading: "",
      error: "",
      errorLevel: "",
    });
    if (collapsing || cached != null) return;
    patchTree(set, get, connId, { loading: "tables" });
    try {
      const tables = await api.listTables(conn, db);
      patchTree(set, get, connId, { tables, tablesDb: db, loading: "", error: "", errorLevel: "" });
    } catch (e) {
      const msg = `加载表列表失败: ${e}`;
      patchTree(set, get, connId, { loading: "", error: msg, errorLevel: "tables" });
      get().showToast(msg);
    }
  },

  /** 右键「刷新表 / 键列表」：丢弃该库的表缓存并重新拉取(不受折叠缓存影响) */
  refreshTables: async (connId, db) => {
    const { config } = get();
    const conn = config?.connections.find((c) => c.id === connId);
    if (!conn) return;
    patchTree(set, get, connId, {
      selectedDb: db,
      tables: null,
      tablesDb: "",
      selectedTable: "",
      selectedColumn: "",
      columns: null,
      columnsTable: "",
      loading: "tables",
      error: "",
      errorLevel: "",
    });
    try {
      const tables = await api.listTables(conn, db);
      patchTree(set, get, connId, { tables, tablesDb: db, loading: "", error: "", errorLevel: "" });
    } catch (e) {
      const msg = `加载表列表失败: ${e}`;
      patchTree(set, get, connId, { loading: "", error: msg, errorLevel: "tables" });
      get().showToast(msg);
    }
  },

  selectTable: async (connId, db, table) => {
    const { config } = get();
    const conn = config?.connections.find((c) => c.id === connId);
    if (!conn) return;
    const tree = get().dbTree[connId] ?? emptyTree();
    const cached = tree.columnsTable === table ? tree.columns : null;
    const collapsing = tree.selectedTable === table && cached != null;
    patchTree(set, get, connId, {
      selectedTable: collapsing ? "" : table,
      selectedColumn: "",
      columns: cached,
      columnsTable: cached ? table : "",
      loading: "",
      error: "",
      errorLevel: "",
    });
    if (collapsing || cached != null || !driverOf(conn.db_type).caps.columns) return;
    patchTree(set, get, connId, { loading: "columns" });
    try {
      const columns = await api.listColumns(conn, db, table);
      patchTree(set, get, connId, { columns, columnsTable: table, loading: "", error: "", errorLevel: "" });
    } catch (e) {
      const msg = `加载列信息失败: ${e}`;
      patchTree(set, get, connId, { loading: "", error: msg, errorLevel: "columns" });
      get().showToast(msg);
    }
  },

  selectChatContext: async (connId, db, table, column) => {
    const conn = activeConn(get().config, connId);
    if (!conn) return;
    const tree = get().dbTree[connId];
    if (get().activeConnId !== connId || !tree?.expanded || tree.databases === null) {
      await get().selectConnection(connId);
    }
    if (!db && driverOf(conn.db_type).caps.databases) {
      patchTree(set, get, connId, { selectedDb: "", selectedTable: "", selectedColumn: "" });
      return;
    }
    if (driverOf(conn.db_type).caps.databases && get().dbTree[connId]?.selectedDb !== db) await get().selectDatabase(connId, db ?? "");
    if (!table) {
      patchTree(set, get, connId, { selectedTable: "", selectedColumn: "" });
      return;
    }
    if (get().dbTree[connId]?.selectedTable !== table) await get().selectTable(connId, db ?? "", table);
    patchTree(set, get, connId, { selectedColumn: column ?? "" });
  },

  selectChatModel: (sessionId, modelId) => {
    if (!get().config?.models.some((model) => model.id === modelId)) return;
    const sessions = get().sessions.map((session) =>
      session.id === sessionId ? { ...session, modelId } : session
    );
    set({ sessions });
    saveChats(sessions);
  },

  runSql: async (sql) => {
    const { config, activeConnId, dbTree } = get();
    const conn = activeConn(config, activeConnId);
    if (!conn) {
      get().showToast("请先在左侧选择一个数据库连接");
      return;
    }
    if (driverOf(conn.db_type).caps.messaging) {
      get().showToast("Kafka 请使用消息工作区；不执行 SQL 或 AI 生成的命令");
      await get().openMessaging(conn.id, dbTree[conn.id]?.selectedTable || undefined);
      return;
    }
    // 断开状态下执行:先自动重连(失败时 connectDb 已提示)
    if (!get().connSessions[conn.id]) await get().connectDb(conn.id);
    if (!get().connSessions[conn.id]) return;
    const database = driverOf(conn.db_type).caps.mapping
      ? dbTree[activeConnId]?.selectedTable || conn.database
      : conn.db_type === "redis" ? "" : dbTree[activeConnId]?.selectedDb || conn.database;
    set({ editorSql: sql });
    try {
      const result =
        conn.db_type === "redis"
          ? redisTextResult(await api.redisCommand(conn, sql.trim().split(/\s+/)))
          : await api.runQuery(conn, database, sql);
      const tabId = nextId("result");
      set({
        tabs: [
          ...get().tabs,
          { id: tabId, kind: "result", title: "查询结果", result },
        ],
        activeTabId: tabId,
        resultView: "table",
        // 结果标签页在中栏展示：确保中栏处于查询视图，避免"执行了却看不到结果"
        view: "chat",
      });
    } catch (e) {
      get().showToast(`执行失败: ${e}`);
    }
  },

  inspectKey: async (key) => {
    const { config, activeConnId } = get();
    const conn = activeConn(config, activeConnId);
    if (!conn) {
      get().showToast("请先在左侧选择一个数据库连接");
      return;
    }
    if (!get().connSessions[conn.id]) await get().connectDb(conn.id);
    if (!get().connSessions[conn.id]) return;
    try {
      const view = await api.redisKeyView(conn, key);
      const typeLabel = REDIS_TYPE_LABEL[view.key_type] ?? view.key_type;
      const result: QueryResult = {
        columns: view.columns,
        rows: view.rows,
        row_count: view.rows.length,
        duration_ms: 0,
        meta: `${view.key} · ${typeLabel} · ${ttlText(view.ttl)}${
          view.truncated ? ` · 仅显示前 ${view.rows.length} 项` : ""
        }`,
      };
      const tabId = nextId("result");
      set({
        tabs: [...get().tabs, { id: tabId, kind: "result", title: key, result }],
        activeTabId: tabId,
        resultView: "table",
        view: "chat",
      });
    } catch (e) {
      get().showToast(`读取键失败: ${e}`);
    }
  },

  newChat: () => {
    const session: ChatSession = {
      id: nextId("chat"),
      title: "新对话",
      messages: [],
      streaming: false,
    };
    const sessions = [...get().sessions, session];
    set({
      sessions,
      tabs: [
        ...get().tabs,
        { id: `tab-${session.id}`, kind: "chat", sessionId: session.id, title: session.title },
      ],
      activeTabId: `tab-${session.id}`,
      view: "chat",
    });
    saveChats(sessions);
  },

  clearChat: (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session || session.streaming) return;
    const sessions = get().sessions.map((s) => s.id === sessionId
      ? { ...s, title: "新对话", messages: [] } : s);
    set({ sessions, tabs: get().tabs.map((t) => t.kind === "chat" && t.sessionId === sessionId
      ? { ...t, title: "新对话" } : t) });
    saveChats(sessions);
  },

  toggleChatPin: (sessionId) => {
    if (!get().sessions.some((s) => s.id === sessionId)) return;
    const sessions = get().sessions.map((s) => s.id === sessionId ? { ...s, pinned: !s.pinned } : s);
    set({ sessions });
    saveChats(sessions);
  },

  deleteChat: (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session || session.streaming) return;
    const sessions = get().sessions.filter((s) => s.id !== sessionId);
    const tabs = get().tabs.filter((t) => t.kind !== "chat" || t.sessionId !== sessionId);
    const activeTabId = tabs.some((t) => t.id === get().activeTabId)
      ? get().activeTabId : tabs[tabs.length - 1]?.id ?? "";
    set({ sessions, tabs, activeTabId });
    saveChats(sessions);
    if (!tabs.length) get().newChat();
  },

  openMessaging: async (connId, topic) => {
    const conn = activeConn(get().config, connId);
    if (!conn || !driverOf(conn.db_type).caps.messaging) return;
    if (!get().connSessions[connId]) await get().connectDb(connId);
    if (!get().connSessions[connId] || !activeConn(get().config, connId)) return;
    const existing = get().tabs.find((t) => t.kind === "messaging" && t.connId === connId && t.topic === topic);
    const id = existing?.id ?? nextId("messaging");
    const label = driverOf(conn.db_type).label;
    set({ tabs: existing ? get().tabs : [...get().tabs, { id, kind: "messaging", connId, topic,
      title: topic ? `${label} · ${topic}` : `${label} · ${conn.name}` }], activeTabId: id, activeConnId: connId, view: "chat" });
  },

  openChatTab: (sessionId) => {
    if (!get().sessions.some((s) => s.id === sessionId)) return;
    const tab = get().tabs.find((t) => t.kind === "chat" && t.sessionId === sessionId);
    if (tab) {
      set({ activeTabId: tab.id, view: "chat" });
    } else {
      const session = get().sessions.find((s) => s.id === sessionId)!;
      const id = `tab-${sessionId}`;
      set({ tabs: [...get().tabs, { id, kind: "chat", sessionId, title: session.title }],
        activeTabId: id, view: "chat" });
    }
  },

  closeTab: (tabId) => {
    let { tabs, activeTabId } = get();
    tabs = tabs.filter((t) => t.id !== tabId);
    if (activeTabId === tabId) {
      activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : "";
    }
    const nextTab = tabs.find((t) => t.id === activeTabId);
    set({ tabs, activeTabId, ...(nextTab?.kind === "messaging" ? { activeConnId: nextTab.connId } : {}) });
    if (get().tabs.length === 0) get().newChat();
  },

  setActiveTab: (activeTabId) => {
    const tab = get().tabs.find((t) => t.id === activeTabId);
    set({ activeTabId, view: "chat", ...(tab?.kind === "messaging" ? { activeConnId: tab.connId } : {}) });
  },

  sendChat: async (text) => {
    const { config, activeConnId, dbTree, sessions, tabs, activeTabId } = get();
    if (!config) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    const sessionId = tab?.kind === "chat" ? tab.sessionId : undefined;
    if (!sessionId || sessions.find((s) => s.id === sessionId)?.streaming) return;
    const chosenModelId = sessions.find((s) => s.id === sessionId)?.modelId;
    const modelId = config.models.some((m) => m.id === chosenModelId)
      ? chosenModelId!
      : config.models.some((m) => m.id === config.active_model_id)
        ? config.active_model_id
        : config.models[0]?.id;
    if (!modelId) {
      get().showToast("请先在设置中配置 AI 模型");
      set({ view: "settings" });
      return;
    }
    const conn = activeConn(config, activeConnId);

    const userMsg: ChatMessage = { role: "user", content: text };
    const assistantMsg: ChatMessage = { role: "assistant", content: "" };
    const requestId = nextId("req");
    activeRequestId = requestId;
    activeRequestSession = sessionId;

    set({
      sessions: sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              title: s.messages.length === 0 ? text : s.title,
              messages: [...s.messages, userMsg, assistantMsg],
              streaming: true,
            }
          : s
      ),
    });

    set({ tabs: get().tabs.map((t) => t.kind === "chat" && t.sessionId === sessionId &&
      sessions.find((s) => s.id === sessionId)?.messages.length === 0
      ? { ...t, title: text } : t) });
    saveChats(get().sessions);
    const history: ChatMessage[] = [
      ...sessions.find((s) => s.id === sessionId)!.messages.filter((m) => m.content),
      userMsg,
    ].map((m) => ({ role: m.role, content: m.content }));

    const sysParts: string[] = [
      "你是 OrbitData,一个 AI 原生的数据管理助手。回答简洁、专业,使用中文。",
      "需要查询时,用 ```sql 代码块给出 SQL;如果是 Redis,给出 redis 命令(用 ```redis 代码块)。需要生成数据或脚本时，将完整结果放在同一条回复中，不要拆分成多条回答。",
    ];
    if (conn) {
      const tree = dbTree[conn.id];
      const driver = driverOf(conn.db_type);
      const db = driver.caps.databases ? tree?.selectedDb || conn.database : "";
      sysParts.push(
        `当前连接: ${conn.name}(${driver.label}${driver.caps.messaging ? "" : `, ${conn.host}:${conn.port}`})` +
          (db ? `,当前${driver.dbLabel}: ${db}` : "") +
          (tree?.selectedTable ? `,当前${driver.tableLabel}: ${tree.selectedTable}` : "") +
          (tree?.selectedColumn ? `,当前字段: ${tree.selectedColumn}` : "") + "。"
      );
      if (driver.caps.messaging) sysParts.push(`当前为 ${driver.label} 消息中间件，不支持 SQL。仅解释配置与排障建议；消息正文不会自动提供。发布消息、删除 Topic 和重置消费位点必须在消息工作区由用户显式确认，不得自动执行。`);
      if (driver.caps.sql) sysParts.push(`生成 SQL 时请使用 ${driver.label} 语法。`);
      if (driver.caps.mapping) sysParts.push("当前为 Elasticsearch。不要生成 SQL；使用 ```elasticsearch 代码块，第一行为 GET 或 POST 加相对路径（例如 POST /example-index/_search），下一行放 JSON DSL。仅支持 _search、_count、_mapping、_settings、_cluster/health 和 _cat 只读接口；禁止生成写操作或认证信息。");
    }

    const messages: ChatMessage[] = [
      { role: "system", content: sysParts.join("\n") },
      ...history,
    ];

    const appendDelta = (delta: string) => {
      set({
        sessions: get().sessions.map((s) => {
          if (s.id !== sessionId) return s;
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last?.role === "assistant") {
            msgs[msgs.length - 1] = { ...last, content: last.content + delta };
          }
          return { ...s, messages: msgs };
        }),
      });
    };

    /** 结束流式状态；stopped 为 true 时给最后一条回答打上中断标记 */
    const finish = (stopped: boolean) => {
      const sessions = get().sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (stopped && last?.role === "assistant") {
          msgs[msgs.length - 1] = { ...last, stopped: true };
        }
        return { ...s, messages: msgs, streaming: false };
      });
      set({ sessions });
      saveChats(sessions);
    };

    const onEvent = (ev: ChatEvent) => {
      if (requestId !== activeRequestId) return;
      if (ev.type === "delta" && ev.text) appendDelta(ev.text);
      if (ev.type === "done") {
        activeRequestId = null;
        activeRequestSession = null;
        finish(ev.cancelled === true);
      }
    };

    try {
      await api.aiChat(modelId, messages, requestId, onEvent);
    } catch (e) {
      if (requestId === activeRequestId) appendDelta(`\n\n> [错误] ${e}`);
    } finally {
      if (activeRequestId === requestId) {
        activeRequestId = null;
        activeRequestSession = null;
      }
      finish(false);
    }
  },

  stopChat: () => {
    const requestId = activeRequestId;
    if (!requestId) return;
    activeRequestId = null;
    void api.aiCancel(requestId).catch(() => undefined);
    const sessionId = activeRequestSession;
    activeRequestSession = null;
    if (!sessionId) return;
    const sessions = get().sessions.map((s) => {
      if (s.id !== sessionId) return s;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant") msgs[msgs.length - 1] = { ...last, stopped: true };
      return { ...s, messages: msgs, streaming: false };
    });
    set({ sessions });
    saveChats(sessions);
  },
}));

/** Redis 键类型 -> 中文标签 */
const REDIS_TYPE_LABEL: Record<string, string> = {
  string: "字符串",
  list: "列表",
  set: "集合",
  zset: "有序集合",
  hash: "哈希",
  stream: "流",
  none: "键不存在",
};

/** TTL -1 永久 / -2 不存在 / 其余为剩余秒数 */
function ttlText(ttl: number): string {
  if (ttl === -1) return "永久";
  if (ttl === -2) return "无 TTL";
  return `${ttl}s 后过期`;
}

/** Redis 命令输出按行拆成结果行：避免整段文本挤在一格被截断成一长串 */
function redisTextResult(text: string): QueryResult {
  const lines = text.split("\n");
  return {
    columns: ["输出"],
    rows: lines.map((line) => [line]),
    row_count: lines.length,
    duration_ms: 0,
  };
}

export function getActiveSession(state: Store): ChatSession | null {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (tab?.kind !== "chat") return null;
  return state.sessions.find((s) => s.id === tab.sessionId) ?? null;
}

export function getResultTab(state: Store): (Tab & { kind: "result"; result: QueryResult }) | null {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (tab?.kind !== "result") return null;
  return tab as Tab & { kind: "result"; result: QueryResult };
}
