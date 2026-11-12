/**
 * 结果集可编辑性判定：从 SQL 中解析出单表来源与列映射，再结合表主键列决定能否就地修改。
 *
 * 与 DataGrip 行为对齐：
 * - 只有「单表 SELECT、无 JOIN / UNION / 聚合 / DISTINCT」时允许编辑；
 * - 表必须存在主键，且主键列必须在结果集中（否则无法定位行）；
 * - 结果列通过别名映射回表列，表达式列不可编辑。
 */
import type { Connection, QueryResult, ResultEditSource } from "../types";
import { api } from "../api";
import { driverOf } from "./drivers";

interface ParsedSelect {
  table: string;
  /** 结果列名 -> 表列名 */
  columnMap: Record<string, string>;
}

const NON_EDITABLE = /\bJOIN\b|\bUNION\b|\bGROUP\s+BY\b|\bHAVING\b|\bDISTINCT\b|\bOVER\s*\(/i;
/** 表名后不是别名的关键字（避免把 WHERE 当成表别名） */
const ALIAS_STOP = /^(where|prewhere|order|group|having|limit|offset|fetch|for|settings|union|join|inner|left|right|full|on)$/i;

/** 去掉行 / 块注释与首尾空白、结尾分号 */
function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
}

/** 按顶层逗号拆分（忽略括号与引号内的逗号） */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** 找到顶层（括号外）关键字位置 */
function topLevelIndex(text: string, keyword: string): number {
  let depth = 0;
  let quote: string | null = null;
  const upper = text.toUpperCase();
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth === 0 && ch !== " " && ch !== "\n" && ch !== "\t") {
      // 词边界：前一个字符必须是空白 / 标点
      if (upper.startsWith(keyword, i)) {
        const before = i === 0 ? " " : text[i - 1];
        const after = text[i + keyword.length] ?? " ";
        if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) return i;
      }
    }
  }
  return -1;
}

/** 解析单表 SELECT；无法安全判定时返回 null */
export function parseSelectSource(sql: string, columns: string[]): ParsedSelect | null {
  const text = normalize(sql);
  if (!/^select\b/i.test(text)) return null;
  if (NON_EDITABLE.test(text)) return null;

  const fromAt = topLevelIndex(text, "FROM");
  if (fromAt < 0) return null;
  const selectList = text.slice(6, fromAt);
  if (!selectList.trim() || selectList.includes("(")) return null;

  const rest = text.slice(fromAt + 4).trim();
  const tableMatch = rest.match(/^([\w$`".\[\]]+)(?:\s+(?:as\s+)?([\w$`"]+))?/i);
  if (!tableMatch) return null;
  const rawTable = tableMatch[1];
  let alias = (tableMatch[2] ?? "").replace(/[`"]/g, "").toLowerCase();
  let consumed = tableMatch[0].length;
  // 表名后紧跟的是子句关键字而不是别名
  if (ALIAS_STOP.test(alias)) {
    alias = "";
    consumed = tableMatch[1].length;
  }
  const table = rawTable.replace(/[`"[\]]/g, "");
  const tail = rest.slice(consumed).trim();
  // 表名后只允许 WHERE / ORDER BY / LIMIT / OFFSET 之类子句
  if (tail && !/^(where|prewhere|order\s+by|limit|offset|fetch|for\s+update|settings)\b/i.test(tail)) return null;

  const items = splitTopLevel(selectList).map((item) => item.trim()).filter(Boolean);
  const columnMap: Record<string, string> = {};
  const lowerColumns = columns.map((c) => c.toLowerCase());

  for (const item of items) {
    // 支持 col / t.col / col AS x / t.col AS x / col x / *
    const star = item.match(/^(?:([\w$`"]+)\.)?\*$/);
    if (star) {
      const owner = (star[1] ?? "").replace(/[`"]/g, "").toLowerCase();
      if (owner && alias && owner !== alias) return null;
      columns.forEach((c) => {
        columnMap[c.toLowerCase()] = c;
      });
      continue;
    }
    const asMatch = item.match(/^([\w$`".]+)\s+as\s+([\w$`"]+)$/i);
    const bareMatch = asMatch ? null : item.match(/^([\w$`".]+)\s+([\w$`"]+)$/);
    const columnExpr = (asMatch ?? bareMatch)?.[1] ?? item;
    const display = (asMatch ?? bareMatch)?.[2]?.replace(/[`"]/g, "") ?? null;

    const exprMatch = columnExpr.match(/^(?:([\w$`"]+)\.)?([\w$`"]+)$/);
    if (!exprMatch) return null; // 表达式 / 函数列
    const owner = (exprMatch[1] ?? "").replace(/[`"]/g, "").toLowerCase();
    if (owner && alias && owner !== alias) return null;
    const column = exprMatch[2].replace(/[`"]/g, "");
    const key = (display ?? column).toLowerCase();
    // 仅登记结果集中确实存在的列
    if (lowerColumns.includes((display ?? column).toLowerCase())) {
      columnMap[key] = column;
    }
  }

  if (!Object.keys(columnMap).length) return null;
  return { table, columnMap };
}

/**
 * 计算某次查询结果的可编辑上下文；不满足条件返回 null（表格保持只读）。
 */
export async function resolveEditSource(
  conn: Connection,
  database: string,
  sql: string,
  result: QueryResult,
): Promise<ResultEditSource | null> {
  if (!driverOf(conn.db_type).caps.editRows || result.columns.length === 0) return null;
  const parsed = parseSelectSource(sql, result.columns);
  if (!parsed) return null;
  const columns = await api.listColumns(conn, database, parsed.table);
  const pkColumns = columns.filter((c) => c.key === "PRI").map((c) => c.name);
  if (!pkColumns.length) return null;

  const mapped = new Set(Object.values(parsed.columnMap).map((c) => c.toLowerCase()));
  if (!pkColumns.every((pk) => mapped.has(pk.toLowerCase()))) return null;

  return {
    connId: conn.id,
    database,
    sql,
    table: parsed.table,
    columnMap: parsed.columnMap,
    pkColumns,
  };
}
