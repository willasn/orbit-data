/**
 * SQL 编辑器自动补全：关键字 + 当前连接的库 / 表 / 列。
 *
 * 元数据一律走后端已有的 list_databases / list_tables / list_columns，
 * 按当前连接与库实时拉取并做短时缓存；拉取失败时对应类别为空，不伪造候选。
 */

import { api } from "../api";
import type { ColumnInfo, Connection, TableInfo } from "../types";

export type SuggestionKind = "keyword" | "database" | "table" | "column";

export interface Suggestion {
  label: string;
  kind: SuggestionKind;
  /** 补充说明（列所属表等） */
  detail?: string;
}

export const KIND_LABEL: Record<SuggestionKind, string> = {
  keyword: "关键字",
  database: "库",
  table: "表",
  column: "列",
};

/** 通用 SQL 关键字与常用函数（方言差异部分由各数据库自行兼容） */
export const SQL_KEYWORDS: string[] = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET",
  "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "CROSS JOIN", "ON",
  "AS", "AND", "OR", "NOT", "NULL", "IS", "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE",
  "DISTINCT", "UNION", "UNION ALL", "INTERSECT", "EXCEPT", "WITH", "RECURSIVE",
  "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "REPLACE",
  "CREATE", "TABLE", "VIEW", "INDEX", "ALTER", "DROP", "TRUNCATE", "RENAME",
  "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "DEFAULT", "UNIQUE", "CONSTRAINT",
  "CASE", "WHEN", "THEN", "ELSE", "END", "CAST", "CONVERT",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF", "IFNULL",
  "NOW", "CURRENT_DATE", "CURRENT_TIMESTAMP", "DATE", "INTERVAL",
  "ASC", "DESC", "OVER", "PARTITION BY", "WINDOW",
  "EXPLAIN", "ANALYZE", "SHOW", "DESCRIBE", "USE",
  // ClickHouse / OLAP 常用
  "PREWHERE", "FINAL", "SAMPLE", "FORMAT", "SETTINGS", "ARRAY JOIN",
];

const WORD_CHAR = /[A-Za-z0-9_$]/;

/** 取光标前的标识符片段，返回片段与其起始下标 */
export function wordBeforeCaret(text: string, caret: number): { word: string; start: number } {
  let start = caret;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1;
  return { word: text.slice(start, caret), start };
}

/** 从 SQL 中提取 FROM / JOIN / UPDATE / INTO 后的表名（含可选的 schema 前缀） */
export function referencedTables(sql: string): { db: string | null; table: string }[] {
  const pattern = /\b(?:from|join|update|into)\s+([`"\[]?[\w$]+[`"\]]?(?:\s*\.\s*[`"\[]?[\w$]+[`"\]]?)?)/gi;
  const out: { db: string | null; table: string }[] = [];
  const seen = new Set<string>();
  for (const match of sql.matchAll(pattern)) {
    const parts = match[1]
      .split(".")
      .map((part) => part.replace(/[`"[\]]/g, "").trim())
      .filter(Boolean);
    if (!parts.length) continue;
    const table = parts[parts.length - 1];
    const db = parts.length > 1 ? parts[parts.length - 2] : null;
    const key = `${db ?? ""}.${table}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ db, table });
  }
  return out;
}

const CACHE_TTL = 30_000;

interface Cached<T> {
  at: number;
  value: T;
}

const databaseCache = new Map<string, Cached<string[]>>();
const tableCache = new Map<string, Cached<TableInfo[]>>();
const columnCache = new Map<string, Cached<ColumnInfo[]>>();

function fresh<T>(entry: Cached<T> | undefined): T | null {
  if (!entry) return null;
  return Date.now() - entry.at < CACHE_TTL ? entry.value : null;
}

/** 拉取失败时返回空数组：补全只展示真实拿到的元数据 */
async function databasesOf(conn: Connection, loaded: string[] | null): Promise<string[]> {
  if (loaded) return loaded;
  const hit = fresh(databaseCache.get(conn.id));
  if (hit) return hit;
  try {
    const names = await api.listDatabases(conn);
    databaseCache.set(conn.id, { at: Date.now(), value: names });
    return names;
  } catch {
    return [];
  }
}

async function tablesOf(
  conn: Connection,
  db: string,
  loaded: TableInfo[] | null,
  loadedDb: string,
): Promise<TableInfo[]> {
  if (loaded && loadedDb === db) return loaded;
  const key = `${conn.id}\u0000${db}`;
  const hit = fresh(tableCache.get(key));
  if (hit) return hit;
  try {
    const tables = await api.listTables(conn, db);
    tableCache.set(key, { at: Date.now(), value: tables });
    return tables;
  } catch {
    return [];
  }
}

async function columnsOf(
  conn: Connection,
  db: string,
  table: string,
  loaded: ColumnInfo[] | null,
  loadedTable: string,
): Promise<ColumnInfo[]> {
  if (loaded && loadedTable.toLowerCase() === table.toLowerCase()) return loaded;
  const key = `${conn.id}\u0000${db}\u0000${table.toLowerCase()}`;
  const hit = fresh(columnCache.get(key));
  if (hit) return hit;
  try {
    const columns = await api.listColumns(conn, db, table);
    columnCache.set(key, { at: Date.now(), value: columns });
    return columns;
  } catch {
    return [];
  }
}

export interface CollectParams {
  conn: Connection;
  /** 当前选中的库（空串时回退到连接的默认库） */
  currentDb: string;
  databases: string[] | null;
  tables: TableInfo[] | null;
  tablesDb: string;
  columns: ColumnInfo[] | null;
  columnsTable: string;
  selectedTable: string;
  sql: string;
}

/** 汇总某次补全的全部候选：关键字 + 库 + 当前库的表 + 相关表的列 */
export async function collectSuggestions(params: CollectParams): Promise<Suggestion[]> {
  const { conn, currentDb, databases, tables, tablesDb, columns, columnsTable, selectedTable, sql } = params;
  const db = currentDb || conn.database || "";
  const out: Suggestion[] = SQL_KEYWORDS.map((label) => ({ label, kind: "keyword" }));

  const dbs = await databasesOf(conn, databases);
  for (const name of dbs) {
    out.push({ label: name, kind: "database" });
  }

  for (const table of await tablesOf(conn, db, tables, tablesDb)) {
    out.push({ label: table.name, kind: "table" });
  }

  // 列候选：当前选中表 + SQL 中引用到的表（最多 3 张，避免大量请求）
  const wanted: { db: string; table: string }[] = [];
  const push = (tableDb: string, table: string) => {
    if (!table) return;
    if (wanted.some((w) => w.table.toLowerCase() === table.toLowerCase())) return;
    wanted.push({ db: tableDb, table });
  };
  if (selectedTable) push(db, selectedTable);
  for (const ref of referencedTables(sql)) {
    if (wanted.length >= 3) break;
    // 前缀只有确实是库名时才当库用；PG 的 schema 前缀仍走当前库
    const refDb = ref.db && dbs.some((name) => name.toLowerCase() === ref.db!.toLowerCase()) ? ref.db : db;
    push(refDb, ref.table);
  }

  const columnSets = await Promise.all(
    wanted.map((w) => columnsOf(conn, w.db, w.table, columns, columnsTable).then((cols) => ({ w, cols }))),
  );
  for (const { w, cols } of columnSets) {
    for (const column of cols) {
      out.push({ label: column.name, kind: "column", detail: w.table });
    }
  }
  return out;
}

const KIND_ORDER: Record<SuggestionKind, number> = { column: 0, table: 1, database: 2, keyword: 3 };

/** 按前缀过滤并排序：前缀命中优先，其次列 / 表 / 库 / 关键字 */
export function filterSuggestions(all: Suggestion[], word: string, limit = 60): Suggestion[] {
  const prefix = word.toLowerCase();
  const seen = new Set<string>();
  const scored: { item: Suggestion; rank: number }[] = [];
  for (const item of all) {
    const label = item.label.toLowerCase();
    let rank: number;
    if (!prefix) rank = 2;
    else if (label.startsWith(prefix)) rank = 0;
    else if (label.includes(prefix)) rank = 1;
    else continue;
    const key = `${item.kind}\u0000${label}\u0000${item.detail ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ item, rank });
  }
  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
      a.item.label.localeCompare(b.item.label),
  );
  return scored.slice(0, limit).map((s) => s.item);
}
