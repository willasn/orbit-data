import { create } from "zustand";
import { api } from "./api";
import { driverOf } from "./db/drivers";
import { resolveEditSource } from "./db/resultEdit";
import type {
  AgentStep,
  AppConfig,
  CellValue,
  ChatMessage,
  ChatSession,
  Connection,
  DbTree,
  QueryResult,
  RowUpdate,
  SessionInfo,
  Tab,
} from "./types";

const connectionEpochs = new Map<string, number>();
/** 同一连接并发触发连接时复用同一次握手（双击打开消息工作区会同时触发选中与打开） */
const pendingConnects = new Map<string, Promise<void>>();
let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${idSeq++}`;

/** 单轮 Agent 最多自动执行的步数；只是安全网，正常靠模型返回 done 收尾 */
const MAX_AGENT_STEPS = 40;
/** 同一条命令连续出现几次判定为原地打转 */
const REPEAT_LIMIT = 3;
/** 连续失败几条命令后暂停，交回用户判断环境 */
const FAIL_STREAK_LIMIT = 3;

/** 每个会话的 Agent 循环状态（循环在前端跑，后端只做决策） */
interface AgentRun {
  goal: string;
  modelId: string;
  conn: Connection | null;
  database: string;
  context: string;
  /** 本轮消息在会话中的起始下标：只回填这一轮产生的步骤 */
  startIndex: number;
  steps: number;
  lastCommand: string;
  repeat: number;
  failStreak: number;
  stopped: boolean;
  busy: boolean;
}

const agentRuns = new Map<string, AgentRun>();

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
    ).map((s) => ({
      ...s,
      title: s.messages.find((m) => m.role === "user")?.content ?? s.title,
      streaming: false,
      messages: s.messages.map((m) => ({
        ...m,
        // 未完成的步骤在重新打开时视为已中断，避免显示无法点击的确认按钮
        status: m.status === "thinking" || m.status === "running" || m.status === "pending"
          ? "stopped" : m.status,
        result: undefined,
      })),
    }));
  } catch {
    return [];
  }
}

function saveChats(sessions: ChatSession[]) {
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify(sessions.map((s) => ({
      id: s.id, title: s.title, modelId: s.modelId, pinned: s.pinned,
      messages: s.messages
        .filter((m) => (m.role === "user" || m.role === "assistant") && (m.content || m.command))
        .map((m) => ({
          role: m.role, content: m.content, stopped: m.stopped,
          command: m.command, commandKind: m.commandKind,
          status: m.status, authReason: m.authReason, danger: m.danger,
          // 输出只保留摘要，避免结果集把本地存储撑爆
          output: m.output ? m.output.slice(0, 4000) : undefined,
          outputMeta: m.outputMeta, canContinue: m.canContinue,
        })),
    }))));
  } catch {
    // 本地存储不可用或空间不足时，当前会话仍可继续使用。
  }
}

/** 结果单元格转文本（用于回填给模型） */
function cellText(value: CellValue): string {
  return value === null ? "NULL" : String(value);
}

/** 查询结果转成紧凑文本，作为下一步决策的依据 */
function formatQueryOutput(result: QueryResult, maxRows = 20): string {
  const rows = result.rows.slice(0, maxRows);
  const lines = [
    `返回 ${result.row_count} 行，耗时 ${result.duration_ms} ms`,
    result.columns.join(" | "),
  ];
  rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${row.map(cellText).join(" | ")}`);
  });
  if (result.row_count > rows.length) lines.push(`…仅展示前 ${rows.length} 行`);
  return lines.join("\n");
}

/** 拆 Redis 命令参数，保留引号内的空格 */
function splitRedisCommand(command: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens.map((token) => token.replace(/^["']|["']$/g, ""));
}

function buildAgentContext(
  conn: Connection | null,
  driver: ReturnType<typeof driverOf> | null,
  tree: DbTree | undefined,
  database: string,
): string {
  if (!conn || !driver) {
    return "当前未选择数据库连接。只能回答一般性问题；如果用户的目标需要查询数据，请提示其先在左侧选择连接。";
  }
  const parts = [`连接：${conn.name}（${driver.label}，${conn.host}:${conn.port}）`];
  if (driver.caps.databases && database) parts.push(`当前${driver.dbLabel}：${database}`);
  if (tree?.selectedTable) parts.push(`当前${driver.tableLabel}：${tree.selectedTable}`);
  if (tree?.selectedColumn) parts.push(`当前字段：${tree.selectedColumn}`);
  if (conn.db_type === "redis") parts.push("命令类型：单条 Redis 命令");
  else if (driver.caps.mapping) parts.push("命令类型：Elasticsearch 请求");
  else parts.push("命令类型：SQL");
  parts.push("只读查询会直接执行；写入、修改、删除等操作会先请用户确认。");
  return parts.join("\n");
}

/** 收集本轮已执行的步骤，回填给模型 */
function collectAgentSteps(messages: ChatMessage[], startIndex: number): AgentStep[] {
  return messages
    .slice(startIndex)
    .filter((m) => m.command)
    .map((m) => ({
      command: m.command as string,
      output: m.output || (m.status === "skipped" ? "（用户拒绝执行该命令）" : "（尚未执行）"),
    }));
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
  /** 提交结果集单元格修改（按主键生成 UPDATE），成功返回 true */
  commitResultEdits: (tabId: string, rows: RowUpdate[]) => Promise<boolean>;
  /** 提交后按原 SQL 重新取数刷新结果标签页 */
  refreshResultTab: (tabId: string) => Promise<void>;
  /** Redis 键内容预览：按值类型取数并以表格展示(string / hash / list / set / zset / stream) */
  inspectKey: (key: string) => Promise<void>;

  newChat: () => void;
  clearChat: (sessionId: string) => void;
  toggleChatPin: (sessionId: string) => void;
  deleteChat: (sessionId: string) => void;
  openMessaging: (connId: string, topic?: string) => Promise<void>;
  /** 打开对象存储工作区（同一连接复用同一个标签页） */
  openStorage: (connId: string, bucket?: string) => Promise<void>;
  openChatTab: (sessionId: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  sendChat: (text: string) => Promise<void>;
  /** 中断当前正在生成的回答(已生成内容保留) */
  stopChat: () => void;
  /** Agent 待确认步骤：授权并继续执行 */
  approveAgentStep: (sessionId: string, index: number) => Promise<void>;
  /** Agent 待确认步骤：跳过该命令并让模型换一条 */
  skipAgentStep: (sessionId: string, index: number) => void;
  /** 达到步数上限后继续执行 */
  resumeAgent: (sessionId: string) => void;
  /** 把查询结果打开到结果标签页 */
  openResult: (result: QueryResult, title?: string) => void;

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

/**
 * 结果集可编辑性判定：单表查询 + 主键都在结果中才打上 edit 标记，
 * 判定失败时保持只读，不打断查询结果的展示。
 */
async function hydrateResultEdit(
  set: SetFn,
  get: GetFn,
  tabId: string,
  conn: Connection,
  database: string,
  sql: string,
  result: QueryResult,
) {
  if (!driverOf(conn.db_type).caps.editRows) return;
  try {
    const edit = await resolveEditSource(conn, database, sql, result);
    if (!edit) return;
    if (!get().tabs.some((t) => t.id === tabId && t.kind === "result")) return;
    set({
      tabs: get().tabs.map((t) => (t.id === tabId && t.kind === "result" ? { ...t, edit } : t)),
    });
  } catch {
    /* 元数据不可用时保持只读 */
  }
}

// ---------------------------------------------------------------------------
// Agent 循环（前端驱动：后端只决策，执行与确认都在这里）
// ---------------------------------------------------------------------------

function patchSession(sessionId: string, updater: (session: ChatSession) => ChatSession): void {
  useStore.setState((state) => ({
    sessions: state.sessions.map((session) => (session.id === sessionId ? updater(session) : session)),
  }));
}

function patchMessage(sessionId: string, index: number, patch: Partial<ChatMessage>): void {
  patchSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message, i) => (i === index ? { ...message, ...patch } : message)),
  }));
}

function persistSessions(): void {
  saveChats(useStore.getState().sessions);
}

function setSessionStreaming(sessionId: string, streaming: boolean): void {
  patchSession(sessionId, (session) => ({ ...session, streaming }));
  persistSessions();
}

/** 保证消息流末尾有一个「思考中」占位气泡，返回它的下标 */
function ensureThinkingMessage(sessionId: string): number {
  const session = useStore.getState().sessions.find((s) => s.id === sessionId);
  if (!session) return -1;
  const lastIndex = session.messages.length - 1;
  const last = session.messages[lastIndex];
  if (last && last.role === "assistant" && !last.command && last.status === "thinking") return lastIndex;
  const nextIndex = session.messages.length;
  patchSession(sessionId, (s) => ({
    ...s,
    messages: [...s.messages, { role: "assistant", content: "", status: "thinking" }],
  }));
  return nextIndex;
}

/** 暂停本轮循环：把原因写回气泡，步数上限类暂停保留「继续执行」 */
function stopAgentRun(sessionId: string, index: number, note: string, canContinue: boolean): void {
  patchMessage(sessionId, index, { status: "stopped", content: note, canContinue });
  const run = agentRuns.get(sessionId);
  if (run) run.busy = false;
  if (!canContinue) agentRuns.delete(sessionId);
  setSessionStreaming(sessionId, false);
}

/** 在当前连接上执行一条 Agent 命令，并把结果写回气泡 */
async function executeAgentCommand(sessionId: string, index: number, run: AgentRun): Promise<boolean> {
  const message = useStore.getState().sessions.find((s) => s.id === sessionId)?.messages[index];
  const command = message?.command;
  if (!command) return false;
  patchMessage(sessionId, index, { status: "running" });

  if (!run.conn) {
    run.failStreak += 1;
    patchMessage(sessionId, index, {
      status: "error",
      output: "尚未选择数据库连接，无法执行命令。请先在左侧选择连接。",
    });
    persistSessions();
    if (run.failStreak >= FAIL_STREAK_LIMIT) {
      stopAgentRun(sessionId, index, "当前没有可用连接，已暂停。请选择连接后重新提问。", false);
      return false;
    }
    return true;
  }

  try {
    if (run.conn.db_type === "redis") {
      const text = await api.redisCommand(run.conn, splitRedisCommand(command));
      const output = (text || "").trim() || "（空结果）";
      patchMessage(sessionId, index, {
        status: "done",
        output: output.length > 8000 ? `${output.slice(0, 8000)}…` : output,
      });
    } else {
      const result = await api.runQuery(run.conn, run.database, command);
      patchMessage(sessionId, index, {
        status: "done",
        result,
        output: result.row_count === 0 ? "执行成功，但没有返回数据。" : formatQueryOutput(result),
        outputMeta: `${result.row_count} 行 · ${result.duration_ms} ms`,
      });
    }
    run.failStreak = 0;
  } catch (e) {
    run.failStreak += 1;
    patchMessage(sessionId, index, { status: "error", output: `执行失败：${e}` });
  }
  // 执行期间用户可能已停止：不要把结果写回已标记停止的气泡
  if (run.stopped || !agentRuns.has(sessionId)) return false;
  persistSessions();

  if (run.failStreak >= FAIL_STREAK_LIMIT) {
    stopAgentRun(
      sessionId,
      index,
      `连续 ${run.failStreak} 条命令执行失败，已暂停。请检查连接或补充信息后重新提问。`,
      false,
    );
    return false;
  }
  return true;
}

/** 请求模型决策下一步：只读命令自动执行，写操作停下等待确认 */
async function driveAgentStep(sessionId: string): Promise<void> {
  const run = agentRuns.get(sessionId);
  if (!run || run.stopped || run.busy) return;
  const session = useStore.getState().sessions.find((s) => s.id === sessionId);
  if (!session) {
    agentRuns.delete(sessionId);
    return;
  }
  run.busy = true;
  const index = ensureThinkingMessage(sessionId);

  let result;
  try {
    result = await api.aiAgentStep(run.modelId, {
      goal: run.goal,
      steps: collectAgentSteps(useStore.getState().sessions
        .find((s) => s.id === sessionId)?.messages ?? [], run.startIndex),
      context: run.context,
      db_type: run.conn?.db_type ?? "",
      remaining_steps: Math.max(0, MAX_AGENT_STEPS - run.steps),
    });
  } catch (e) {
    run.busy = false;
    agentRuns.delete(sessionId);
    patchMessage(sessionId, index, {
      status: "error",
      content: `调用模型失败：${e}`,
      command: undefined,
    });
    setSessionStreaming(sessionId, false);
    return;
  }

  // 请求期间用户可能已停止或关闭了会话
  if (run.stopped || !agentRuns.has(sessionId)) {
    run.busy = false;
    return;
  }

  if (result.action === "done") {
    run.busy = false;
    agentRuns.delete(sessionId);
    patchMessage(sessionId, index, {
      content: result.summary || "任务完成。",
      status: undefined,
      canContinue: false,
    });
    setSessionStreaming(sessionId, false);
    return;
  }

  const command = (result.command ?? "").trim();
  if (!command) {
    run.busy = false;
    agentRuns.delete(sessionId);
    patchMessage(sessionId, index, { status: "error", content: "AI 未给出可执行命令，请补充说明后重试。" });
    setSessionStreaming(sessionId, false);
    return;
  }

  const kind: ChatMessage["commandKind"] = run.conn?.db_type === "redis"
    ? "redis"
    : run.conn && driverOf(run.conn.db_type).caps.mapping ? "elasticsearch" : "sql";

  run.steps += 1;
  if (command === run.lastCommand) run.repeat += 1;
  else {
    run.lastCommand = command;
    run.repeat = 1;
  }

  // 先做护栏判断：被拦下的命令不写入消息，避免被当成已执行的步骤
  if (run.steps > MAX_AGENT_STEPS) {
    stopAgentRun(
      sessionId,
      index,
      `已达到本轮 ${MAX_AGENT_STEPS} 步上限，这条命令未执行。可以点「继续执行」再给一轮步数。`,
      true,
    );
    return;
  }
  if (run.repeat >= REPEAT_LIMIT) {
    stopAgentRun(sessionId, index, "同一条命令连续出现多次，已暂停以免原地打转。", false);
    return;
  }

  patchMessage(sessionId, index, {
    content: result.thought || "",
    command,
    commandKind: kind,
    status: result.requires_auth ? "pending" : "running",
    authReason: result.auth_reason || "",
    danger: result.danger,
    canContinue: false,
  });

  // 写 / 改 / 删除等需要用户确认：停下，等待气泡上的「执行 / 跳过」
  if (result.requires_auth) {
    run.busy = false;
    setSessionStreaming(sessionId, false);
    return;
  }

  await executeAgentCommand(sessionId, index, run);
  run.busy = false;
  if (!run.stopped && agentRuns.has(sessionId)) void driveAgentStep(sessionId);
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
      const prevType = activeConn(get().config, conn.id)?.db_type ?? "";
      const needsReset = (t: string) => driverOf(t).caps.messaging || driverOf(t).caps.storage;
      if (conn.id && (needsReset(conn.db_type) || needsReset(prevType))) {
        get().tabs.filter((t) => t.kind !== "chat" && t.kind !== "result" && t.connId === conn.id)
          .forEach((t) => get().closeTab(t.id));
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
      get().tabs.filter((t) => t.kind !== "chat" && t.kind !== "result" && t.connId === id)
        .forEach((t) => get().closeTab(t.id));
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
    get().tabs.filter((t) => t.kind !== "chat" && t.kind !== "result" && t.connId === id)
      .forEach((t) => get().closeTab(t.id));
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
    if (driverOf(conn.db_type).caps.storage) {
      get().showToast("对象存储请使用 OSS 工作区；不执行 SQL 或 AI 生成的命令");
      await get().openStorage(conn.id, dbTree[conn.id]?.selectedDb || undefined);
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
      // 复用已存在的「查询结果」标签页，避免每次执行都堆一个新标签
      const existing = get().tabs.find((t) => t.kind === "result" && t.title === "查询结果");
      const tabId = existing?.id ?? nextId("result");
      const nextTab = { id: tabId, kind: "result" as const, title: "查询结果", result };
      set({
        tabs: existing
          ? get().tabs.map((t) => (t.id === tabId ? nextTab : t))
          : [...get().tabs, nextTab],
        activeTabId: tabId,
        resultView: "table",
        // 结果标签页在中栏展示：确保中栏处于查询视图，避免"执行了却看不到结果"
        view: "chat",
      });
      if (conn.db_type !== "redis") {
        void hydrateResultEdit(set, get, tabId, conn, database, sql, result);
      }
    } catch (e) {
      get().showToast(`执行失败: ${e}`);
    }
  },

  commitResultEdits: async (tabId, rows) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const source = tab?.kind === "result" ? tab.edit : undefined;
    if (!source) return false;
    const conn = activeConn(get().config, source.connId);
    if (!conn) {
      get().showToast("连接已不存在，无法提交修改");
      return false;
    }
    try {
      const affected = await api.updateRows(conn, source.database, source.table, rows);
      get().showToast(
        affected === 0
          ? "提交完成，但没有匹配到行（数据可能已被他人修改，已刷新结果）"
          : `已提交 ${affected} 行修改`,
      );
      await get().refreshResultTab(tabId);
      return true;
    } catch (e) {
      get().showToast(`提交失败: ${e}`);
      return false;
    }
  },

  refreshResultTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const source = tab?.kind === "result" ? tab.edit : undefined;
    if (!source) return;
    const conn = activeConn(get().config, source.connId);
    if (!conn) return;
    try {
      const result = await api.runQuery(conn, source.database, source.sql);
      set({
        tabs: get().tabs.map((t) =>
          t.id === tabId && t.kind === "result" ? { ...t, result } : t,
        ),
      });
      void hydrateResultEdit(set, get, tabId, conn, source.database, source.sql, result);
    } catch (e) {
      get().showToast(`刷新结果失败: ${e}`);
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
    const run = agentRuns.get(sessionId);
    if (run) {
      run.stopped = true;
      agentRuns.delete(sessionId);
    }
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
    const run = agentRuns.get(sessionId);
    if (run) {
      run.stopped = true;
      agentRuns.delete(sessionId);
    }
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

  openStorage: async (connId, bucket) => {
    const conn = activeConn(get().config, connId);
    if (!conn || !driverOf(conn.db_type).caps.storage) return;
    if (!get().connSessions[connId]) await get().connectDb(connId);
    if (!get().connSessions[connId] || !activeConn(get().config, connId)) return;
    const existing = get().tabs.find((t) => t.kind === "storage" && t.connId === connId);
    const id = existing?.id ?? nextId("storage");
    const target = bucket ?? (existing?.kind === "storage" ? existing.bucket : undefined) ?? conn.database ?? "";
    const title = `${driverOf(conn.db_type).label} · ${conn.name}`;
    set({
      tabs: existing
        ? get().tabs.map((t) => (t.id === id ? { ...t, bucket: target } : t))
        : [...get().tabs, { id, kind: "storage", connId, bucket: target, title }],
      activeTabId: id,
      activeConnId: connId,
      view: "chat",
    });
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
    set({ tabs, activeTabId, ...(nextTab && (nextTab.kind === "messaging" || nextTab.kind === "storage") ? { activeConnId: nextTab.connId } : {}) });
    if (get().tabs.length === 0) get().newChat();
  },

  setActiveTab: (activeTabId) => {
    const tab = get().tabs.find((t) => t.id === activeTabId);
    set({ activeTabId, view: "chat", ...(tab && (tab.kind === "messaging" || tab.kind === "storage") ? { activeConnId: tab.connId } : {}) });
  },

  sendChat: async (text) => {
    const { config, activeConnId, dbTree, sessions, tabs, activeTabId, connSessions } = get();
    if (!config) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    const sessionId = tab?.kind === "chat" ? tab.sessionId : undefined;
    const session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
    if (!sessionId || !session || session.streaming) return;

    const chosenModelId = session.modelId;
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
    const conn = activeConn(config, activeConnId) || null;
    const driver = conn ? driverOf(conn.db_type) : null;
    if (conn && driver && (driver.caps.messaging || driver.caps.storage)) {
      get().showToast(`${driver.label} 请使用专属工作区；AI 不会自动执行消息或对象存储操作`);
      return;
    }
    if (conn) {
      if (!connSessions[conn.id]) await get().connectDb(conn.id);
      if (!get().connSessions[conn.id]) return;
    }

    // 同一会话新一轮提问：先停掉上一轮未完成的循环
    const previous = agentRuns.get(sessionId);
    if (previous) previous.stopped = true;
    agentRuns.delete(sessionId);

    const tree = conn ? dbTree[conn.id] : undefined;
    const database = !conn || !driver
      ? ""
      : driver.caps.mapping
        ? tree?.selectedTable || conn.database
        : conn.db_type === "redis" ? "" : tree?.selectedDb || conn.database;
    const context = buildAgentContext(conn, driver, tree, database);
    const startIndex = session.messages.length + 1;

    set({
      sessions: get().sessions.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              title: s.messages.length === 0 ? text : s.title,
              // 上一轮未完成的步骤统一视为中断，避免留下点不动的确认按钮
              messages: [
                ...s.messages.map((m) =>
                  m.status === "pending" || m.status === "running" || m.status === "thinking"
                    ? { ...m, status: "stopped" as const, canContinue: false }
                    : m.canContinue ? { ...m, canContinue: false } : m),
                { role: "user", content: text },
              ],
              streaming: true,
            }
          : s
      ),
    });
    set({
      tabs: get().tabs.map((t) => t.kind === "chat" && t.sessionId === sessionId && session.messages.length === 0
        ? { ...t, title: text } : t),
    });
    saveChats(get().sessions);

    agentRuns.set(sessionId, {
      goal: text,
      modelId,
      conn,
      database,
      context,
      startIndex,
      steps: 0,
      lastCommand: "",
      repeat: 0,
      failStreak: 0,
      stopped: false,
      busy: false,
    });
    void driveAgentStep(sessionId);
  },

  stopChat: () => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === activeTabId);
    const sessionId = tab?.kind === "chat" ? tab.sessionId : undefined;
    if (!sessionId) return;
    const run = agentRuns.get(sessionId);
    if (run) {
      run.stopped = true;
      agentRuns.delete(sessionId);
    }
    patchSession(sessionId, (s) => ({
      ...s,
      streaming: false,
      messages: s.messages.map((m) => {
        if (m.status === "thinking" || m.status === "running" || m.status === "pending") {
          return {
            ...m,
            status: "stopped",
            canContinue: false,
            content: m.command ? m.content : (m.content || "已停止。"),
          };
        }
        return m;
      }),
    }));
    persistSessions();
  },

  approveAgentStep: async (sessionId, index) => {
    const run = agentRuns.get(sessionId);
    const message = get().sessions.find((s) => s.id === sessionId)?.messages[index];
    if (!run || !message || message.status !== "pending" || !message.command) return;
    if (message.danger) {
      const ok = await get().askConfirm({
        title: "确认执行危险操作",
        message: `AI 准备执行：\n\n${message.command}\n\n${message.authReason || "该操作可能造成不可恢复的影响"}。确认继续？`,
        confirmText: "执行",
        danger: true,
      });
      if (!ok) return;
    }
    // 弹窗期间用户可能已发起新问题或停止本轮
    if (run.stopped || !agentRuns.has(sessionId)) return;
    const latest = get().sessions.find((s) => s.id === sessionId)?.messages[index];
    if (!latest || latest.status !== "pending") return;
    run.busy = false;
    setSessionStreaming(sessionId, true);
    const ok = await executeAgentCommand(sessionId, index, run);
    if (ok && !run.stopped && agentRuns.has(sessionId)) void driveAgentStep(sessionId);
  },

  skipAgentStep: (sessionId, index) => {
    const run = agentRuns.get(sessionId);
    if (!run) return;
    patchMessage(sessionId, index, {
      status: "skipped",
      authReason: "",
      canContinue: false,
      output: "（用户拒绝执行该命令）",
    });
    persistSessions();
    if (run.stopped) return;
    setSessionStreaming(sessionId, true);
    void driveAgentStep(sessionId);
  },

  resumeAgent: (sessionId) => {
    const run = agentRuns.get(sessionId);
    if (!run || run.busy) return;
    // 只允许继续最近一条提示；旧消息上的按钮不应驱动新的循环
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session?.messages[session.messages.length - 1]?.canContinue) return;
    run.steps = 0;
    run.lastCommand = "";
    run.repeat = 0;
    run.failStreak = 0;
    run.stopped = false;
    run.busy = false;
    patchSession(sessionId, (s) => ({
      ...s,
      streaming: true,
      messages: s.messages.map((m) => (m.canContinue ? { ...m, canContinue: false } : m)),
    }));
    persistSessions();
    void driveAgentStep(sessionId);
  },

  openResult: (result, title = "查询结果") => {
    const tabId = nextId("result");
    set({
      tabs: [...get().tabs, { id: tabId, kind: "result", title, result }],
      activeTabId: tabId,
      resultView: "table",
      view: "chat",
    });
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
