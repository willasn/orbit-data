/**
 * SQL 编辑器草稿与历史（localStorage，与会话相同的本地持久化方式）。
 *
 * 约定：只保存 SQL 文本、时间与所属连接名称 / id，不保存主机、账号、密码等任何连接凭据。
 */

export interface SqlHistoryEntry {
  connId: string;
  connName: string;
  sql: string;
  /** 归档时间（毫秒时间戳） */
  at: number;
}

const DRAFTS_KEY = "orbit-data.sql-drafts";
const HISTORY_KEY = "orbit-data.sql-history";
/** 单个连接保留的历史条数 */
const MAX_PER_CONN = 30;
/** 全部连接合计上限，避免长期使用无限增长 */
const MAX_TOTAL = 300;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存储不可用时静默降级，不影响编辑 */
  }
}

let drafts: Record<string, string> | null = null;
let draftTimer: number | null = null;

/** 读取某连接的草稿；没有草稿时返回 undefined */
export function getDraft(connId: string): string | undefined {
  drafts ??= read<Record<string, string>>(DRAFTS_KEY, {});
  return drafts[connId];
}

/** 记录草稿：内存立即生效，落盘合并到 300ms 后 */
export function saveDraft(connId: string, sql: string) {
  drafts ??= read<Record<string, string>>(DRAFTS_KEY, {});
  if (drafts[connId] === sql) return;
  drafts[connId] = sql;
  if (draftTimer != null) window.clearTimeout(draftTimer);
  draftTimer = window.setTimeout(flushDrafts, 300);
}

/** 立即落盘（切换连接、关闭窗口前调用） */
export function flushDrafts() {
  if (draftTimer != null) {
    window.clearTimeout(draftTimer);
    draftTimer = null;
  }
  if (drafts) write(DRAFTS_KEY, drafts);
}

/** 某连接的历史，按时间倒序 */
export function historyOf(connId: string): SqlHistoryEntry[] {
  return read<SqlHistoryEntry[]>(HISTORY_KEY, []).filter((e) => e.connId === connId);
}

/**
 * 追加一条历史并返回该连接的最新列表。
 * 空内容不入库；与当前连接最近一条完全相同时跳过，避免重复归档。
 */
export function pushHistory(connId: string, connName: string, sql: string): SqlHistoryEntry[] {
  if (!sql.trim()) return historyOf(connId);
  const all = read<SqlHistoryEntry[]>(HISTORY_KEY, []);
  const latest = all.find((e) => e.connId === connId);
  if (latest?.sql === sql) return all.filter((e) => e.connId === connId);

  const perConn = new Map<string, number>();
  const list = [{ connId, connName, sql, at: Date.now() }, ...all]
    .filter((entry) => {
      const count = (perConn.get(entry.connId) ?? 0) + 1;
      perConn.set(entry.connId, count);
      return count <= MAX_PER_CONN;
    })
    .slice(0, MAX_TOTAL);
  write(HISTORY_KEY, list);
  return list.filter((e) => e.connId === connId);
}

/** 删除某连接下指定时间戳的一条历史，返回该连接的最新列表 */
export function removeHistoryEntry(connId: string, at: number): SqlHistoryEntry[] {
  const list = read<SqlHistoryEntry[]>(HISTORY_KEY, []).filter(
    (e) => !(e.connId === connId && e.at === at),
  );
  write(HISTORY_KEY, list);
  return list.filter((e) => e.connId === connId);
}
