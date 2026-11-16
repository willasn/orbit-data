/**
 * 右键菜单条目定义 —— 见 CONTEXT_MENU.md
 *
 * - 连接级：统一一份，全类型共用（仅 caps.sql / caps.console / caps.localFile 三个开关）
 * - 库级 / 表级：按大类（DbKind）各一份
 * - 列级：统一一份 + 少量能力开关
 * - `planned: true` 表示设计已确定但功能未落地，菜单中灰显并标注「规划中」
 */
import { api } from "../api";
import { useStore } from "../store";
import { quoteIdent, type DriverMeta } from "./drivers";
import type { Connection } from "../types";

/* ────────────────── 上下文 ────────────────── */

interface BaseCtx {
  conn: Connection;
  driver: DriverMeta;
}

export interface ConnCtx extends BaseCtx {
  kind: "connection";
}
export interface DbCtx extends BaseCtx {
  kind: "database";
  database: string;
}
export interface TableCtx extends BaseCtx {
  kind: "table";
  database: string;
  table: string;
  tableType?: string;
}
export interface ColumnCtx extends BaseCtx {
  kind: "column";
  database: string;
  table: string;
  column: string;
  dataType?: string;
}
export type MenuCtx = ConnCtx | DbCtx | TableCtx | ColumnCtx;

/** 供 ContextMenu 渲染的扁平条目 */
export interface MenuEntry {
  id: string;
  label: string;
  hint?: string;
  planned?: boolean;
  danger?: boolean;
  sep?: boolean;
  run?: () => void;
}

interface Item<C> {
  id: string;
  label: string | ((c: C) => string);
  hint?: string | ((c: C) => string);
  when?: (c: C) => boolean;
  planned?: boolean;
  danger?: boolean;
  run?: (c: C) => void | Promise<void>;
}
type Items<C> = (Item<C> | { sep: true })[];

/* ────────────────── 通用动作 ────────────────── */

const st = () => useStore.getState();

function toast(msg: string) {
  st().showToast(msg);
}

/** 打开（或激活）中间面板里的 SQL 编辑器标签页 */
function showRight() {
  st().openSqlTab();
}

async function copyText(text: string, tip = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
    toast(tip);
  } catch {
    // WebView 未授权剪贴板时回退
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    toast(ok ? tip : "复制失败,请手动复制");
  }
}

/** 执行 SQL / 命令前，确保连接与库处于选中状态 */
async function prepare(c: DbCtx | TableCtx | ColumnCtx) {
  const s = st();
  if (s.activeConnId !== c.conn.id) await s.selectConnection(c.conn.id);
  if (c.database && st().dbTree[c.conn.id]?.selectedDb !== c.database) {
    await st().selectDatabase(c.conn.id, c.database);
  }
}

/** 重新拉取库列表（连接级刷新） */
function refreshConn(id: string) {
  return st().refreshConnection(id);
}

/** 重新拉取表 / 键列表（库级刷新） */
function refreshTables(c: { conn: Connection; database: string }) {
  return st().refreshTables(c.conn.id, c.database);
}

function ident(c: { conn: Connection }, name: string) {
  return quoteIdent(c.conn.db_type, name);
}

/** SQL Server 表级节点名可能是 schema.table（dbo 省略前缀），查询时需拆开 */
function splitQualified(name: string): [string, string] {
  const i = name.indexOf(".");
  return i > 0 && i < name.length - 1 ? [name.slice(0, i), name.slice(i + 1)] : ["dbo", name];
}

/** 拆分 schema.table，未带前缀时回落到指定默认 schema（PG 为 public，SQL Server 为 dbo） */
function splitSchema(name: string, fallback: string): [string, string] {
  const i = name.indexOf(".");
  return i > 0 && i < name.length - 1 ? [name.slice(0, i), name.slice(i + 1)] : [fallback, name];
}

/** 行数限制语法：SQL Server 用 TOP n（写在 SELECT 之后），其余方言用 LIMIT n（写在末尾） */
function limitSql(conn: Connection, n: number) {
  return conn.db_type === "sqlserver"
    ? { top: `TOP ${n} `, tail: "" }
    : { top: "", tail: `\nLIMIT ${n}` };
}

/** 已落地建表设计窗口的方言（其余类型只保留新建查询入口） */
function canCreateSqlObject(driver: DriverMeta) {
  return driver.createDialect === "mysql" ||
    driver.createDialect === "postgres" ||
    driver.createDialect === "clickhouse";
}

/** 建库 DDL（按方言） */
export function createDbSql(c: { conn: Connection }, db: string): string {
  const q = ident(c, db);
  switch (c.conn.db_type) {
    case "mysql":
    case "mariadb":
    case "tidb":
    case "oceanbase":
      return `CREATE DATABASE ${q} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;
    default:
      return `CREATE DATABASE ${q}`;
  }
}

/** 删库 DDL（按方言；Oracle 的库级是用户 / Schema） */
function dropDbSql(c: { conn: Connection }, db: string): string {
  if (c.conn.db_type === "oracle" || c.conn.db_type === "dm") {
    return `DROP USER ${ident(c, db)} CASCADE`;
  }
  return `DROP DATABASE ${ident(c, db)}`;
}

/** 新建库：连接级入口 */
function runCreateDb(c: BaseCtx) {
  st().openCreate({ connId: c.conn.id, kind: "database" });
}

/** 删除库：手输库名二次确认（危险操作） */
async function runDropDb(c: DbCtx) {
  const label = c.driver.dbLabel;
  const input = await st().askText({
    title: `删除${label}「${c.database}」`,
    message: "该操作不可撤销，请输入名称以确认。",
    placeholder: c.database,
    expect: c.database,
    confirmText: "删除",
    danger: true,
  });
  if (input === null) return;
  if (input !== c.database) {
    toast("名称不匹配,已取消");
    return;
  }
  try {
    await api.runQuery(c.conn, c.conn.database, dropDbSql(c, c.database));
    toast(`已删除${label}「${c.database}」`);
    await refreshConn(c.conn.id);
  } catch (e) {
    toast(`删除失败: ${e}`);
  }
}

function newQuerySql(c: { conn: Connection; driver: DriverMeta }, database: string) {
  const db = database || c.conn.database;
  const { top, tail } = limitSql(c.conn, 100);
  return (
    `-- ${c.conn.name}${db ? ` / ${db}` : ""}\n` +
    `SELECT ${top}* FROM ${db ? quoteIdent(c.conn.db_type, db) + "." : ""}<${c.driver.tableLabel}>${tail};`
  );
}

/** 查看对象结构的 SQL；当前类型无法表达时返回 null（菜单自动隐藏该条目） */
function structureSql(c: TableCtx): string | null {
  const t = ident(c, c.table);
  switch (c.conn.db_type) {
    case "mysql":
    case "mariadb":
    case "tidb":
    case "oceanbase":
      return `SHOW FULL COLUMNS FROM ${t}`;
    case "doris":
    case "starrocks":
    case "clickhouse":
      return `SHOW CREATE TABLE ${t}`;
    case "hive":
      return `DESCRIBE ${t}`;
    case "postgres":
    case "timescaledb": {
      const esc = (v: string) => v.replace(/'/g, "''");
      const [schema, name] = splitSchema(c.table, "public");
      return (
        `SELECT column_name, data_type, is_nullable, column_default\n` +
        `FROM information_schema.columns\n` +
        `WHERE table_schema = '${esc(schema)}' AND table_name = '${esc(name)}'\n` +
        `ORDER BY ordinal_position`
      );
    }
    case "sqlserver": {
      // SQL Server 的 information_schema 里 table_schema 是 schema（dbo），不是库名，需从限定名拆出
      const esc = (v: string) => v.replace(/'/g, "''");
      const [schema, name] = splitQualified(c.table);
      return (
        `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default\n` +
        `FROM INFORMATION_SCHEMA.COLUMNS\n` +
        `WHERE TABLE_SCHEMA = '${esc(schema)}' AND TABLE_NAME = '${esc(name)}'\n` +
        `ORDER BY ORDINAL_POSITION`
      );
    }
    case "sqlite": {
      // SQLite 无 information_schema，用 pragma 表值函数
      const esc = (v: string) => v.replace(/'/g, "''");
      return (
        `SELECT cid AS cid, name AS column_name, type AS data_type,\n` +
        `  CASE "notnull" WHEN 1 THEN 'NO' ELSE 'YES' END AS is_nullable,\n` +
        `  dflt_value AS column_default,\n` +
        `  CASE pk WHEN 0 THEN '' ELSE 'PRI' END AS column_key\n` +
        `FROM pragma_table_info('${esc(c.table)}')\n` +
        `ORDER BY cid`
      );
    }
    case "oracle":
    case "dm":
    case "trino":
    case "duckdb":
    case "tdengine":
    case "questdb": {
      const esc = (v: string) => v.replace(/'/g, "''");
      return (
        `SELECT column_name, data_type, is_nullable, column_default\n` +
        `FROM information_schema.columns\n` +
        `WHERE ${c.database ? `table_schema = '${esc(c.database)}' AND ` : ""}` +
        `table_name = '${esc(c.table)}'\n` +
        `ORDER BY ordinal_position`
      );
    }
    default:
      return null;
  }
}

/** 执行计划 SQL；SQL Server 无 EXPLAIN，改用 SHOWPLAN_ALL 返回估算计划 */
function explainSql(c: TableCtx): string {
  const t = ident(c, c.table);
  if (c.conn.db_type === "sqlserver") return `SET SHOWPLAN_ALL ON;\nSELECT * FROM ${t};`;
  return `EXPLAIN SELECT * FROM ${t}`;
}

/** 仅对支持直接查询建表语句的方言提供独立 DDL 入口 */
function ddlSql(c: TableCtx): string | null {
  const t = ident(c, c.table);
  switch (c.conn.db_type) {
    case "mysql":
    case "mariadb":
    case "tidb":
    case "oceanbase":
      return `SHOW CREATE ${c.tableType === "view" ? "VIEW" : "TABLE"} ${t}`;
    case "doris":
    case "starrocks":
    case "clickhouse":
      return `SHOW CREATE TABLE ${t}`;
    default:
      return null;
  }
}

/** 索引 / 约束信息 SQL；当前类型无法表达时返回 null（菜单自动隐藏） */
function indexSql(c: TableCtx): string | null {
  const t = ident(c, c.table);
  const esc = (v: string) => v.replace(/'/g, "''");
  switch (c.conn.db_type) {
    case "mysql":
    case "mariadb":
    case "tidb":
    case "oceanbase":
    case "doris":
    case "starrocks":
      return `SHOW INDEX FROM ${t}`;
    case "postgres":
    case "timescaledb": {
      const [schema, name] = splitSchema(c.table, "public");
      return (
        `SELECT indexname, indexdef\nFROM pg_indexes\n` +
        `WHERE schemaname = '${esc(schema)}' AND tablename = '${esc(name)}'\nORDER BY indexname`
      );
    }
    case "sqlserver": {
      const [schema, name] = splitQualified(c.table);
      return (
        `SELECT i.name AS index_name, i.type_desc, i.is_primary_key, i.is_unique, c.name AS column_name\n` +
        `FROM sys.indexes i\n` +
        `JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id\n` +
        `JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id\n` +
        `WHERE i.object_id = OBJECT_ID('${esc(schema)}.${esc(name)}')\n` +
        `ORDER BY i.name, ic.key_ordinal`
      );
    }
    case "oracle":
    case "dm":
      return (
        `SELECT i.index_name, i.uniqueness, c.column_name, c.column_position\n` +
        `FROM all_indexes i\n` +
        `JOIN all_ind_columns c ON c.index_owner = i.owner AND c.index_name = i.index_name\n` +
        `WHERE i.table_name = '${esc(c.table)}'` +
        (c.database ? ` AND i.owner = '${esc(c.database)}'` : "") +
        `\nORDER BY i.index_name, c.column_position`
      );
    case "sqlite":
      return `PRAGMA index_list(${t})`;
    case "duckdb":
      return `SELECT index_name, is_unique, is_primary, expressions FROM duckdb_indexes() WHERE table_name = '${esc(c.table)}'`;
    default:
      return null;
  }
}

/** 分区信息 SQL；当前类型无法表达时返回 null（菜单自动隐藏） */
function partitionSql(c: TableCtx): string | null {
  const t = ident(c, c.table);
  const esc = (v: string) => v.replace(/'/g, "''");
  switch (c.conn.db_type) {
    case "clickhouse":
      return (
        `SELECT partition, sum(rows) AS rows, formatReadableSize(sum(bytes_on_disk)) AS size_on_disk,\n` +
        `       count() AS parts, min(min_time) AS min_time, max(max_time) AS max_time\n` +
        `FROM system.parts\n` +
        `WHERE active AND database = '${esc(c.database)}' AND table = '${esc(c.table)}'\n` +
        `GROUP BY partition\nORDER BY partition`
      );
    case "doris":
    case "starrocks":
      return `SHOW PARTITIONS FROM ${t}`;
    case "hive":
      return `SHOW PARTITIONS ${t}`;
    default:
      return null;
  }
}

function hasVectorConsole(c: BaseCtx) {
  return c.driver.kind === "vector" && c.driver.caps.console;
}

/** MongoDB 控制台命令（JSON 形式，直接交给后端 run_query） */
function mongoCmd(command: Record<string, unknown>) {
  return JSON.stringify(command, null, 2);
}

async function runMongo(c: DbCtx | TableCtx | ColumnCtx, command: Record<string, unknown>) {
  await prepare(c);
  await st().runSql(mongoCmd(command));
}

async function mongoTemplate(c: DbCtx | TableCtx, command: Record<string, unknown>) {
  await prepare(c);
  showRight();
  st().setEditorSql(mongoCmd(command));
}

function vectorRequest(operation: string, body: Record<string, unknown>) {
  return `POST /v2/vectordb/${operation}\n${JSON.stringify(body, null, 2)}`;
}

function vectorBody(c: DbCtx | TableCtx | ColumnCtx) {
  return { dbName: c.database, ...("table" in c ? { collectionName: c.table } : {}) };
}

async function runVectorRead(c: DbCtx | TableCtx | ColumnCtx, operation: string, body = {}) {
  await prepare(c);
  await st().runSql(vectorRequest(operation, { ...vectorBody(c), ...body }));
}

async function vectorTemplate(c: TableCtx | ColumnCtx, operation: string, body: Record<string, unknown>) {
  await prepare(c);
  showRight();
  st().setEditorSql(vectorRequest(operation, { ...vectorBody(c), ...body }));
}

async function vectorSearchTemplate(c: TableCtx | ColumnCtx) {
  await prepare(c);
  let columns = st().dbTree[c.conn.id]?.columnsTable === c.table
    ? st().dbTree[c.conn.id]?.columns : null;
  if (!columns) {
    try {
      columns = await api.listColumns(c.conn, c.database, c.table);
    } catch {
      // 元数据不可用时仍可生成模板，由用户填写字段和真实向量。
    }
  }
  const field = "column" in c
    ? columns?.find((col) => col.name === c.column)
    : columns?.find((col) => /vector|^(100|101|102|103|104|105)(\D|$)/i.test(col.data_type));
  const dim = (field?.data_type ?? ("dataType" in c ? c.dataType : ""))?.match(/dim\s*=\s*(\d+)/i)?.[1];
  await vectorTemplate(c, "entities/search", {
    annsField: "column" in c ? c.column : field?.name ?? "your-vector-field",
    data: [[]], limit: 10, filter: "", outputFields: ["*"],
  });
  toast(`请将 data 中的空数组替换为真实查询向量${dim ? `（维度 ${dim}）` : "，并确认向量字段与维度"}，模板未执行`);
}

async function runVectorWrite(
  c: BaseCtx, database: string, operation: string, body: Record<string, unknown>, title: string,
  refresh?: () => Promise<void>, confirmed = false,
) {
  if (!confirmed && !await st().askConfirm({
    title, message: `将在连接「${c.conn.name}」执行 ${operation}，请确认目标和参数。`,
    confirmText: "执行", danger: true,
  })) return;
  try {
    await prepare({ ...c, kind: "database", database });
    await api.runQuery(c.conn, database, vectorRequest(operation, body));
    toast(`${title}成功`);
    await refresh?.();
  } catch (e) {
    toast(`${title}失败: ${e}`);
  }
}

async function createVectorDatabase(c: ConnCtx) {
  const input = await st().askText({ title: "新建向量数据库", placeholder: "数据库名称", confirmText: "下一步" });
  const name = input?.trim();
  if (!name) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name)) {
    toast("数据库名称须以字母或下划线开头，仅含字母、数字和下划线，最多 255 字符");
    return;
  }
  await runVectorWrite(c, "", "databases/create", { dbName: name }, "新建向量数据库", () => refreshConn(c.conn.id));
}

async function createVectorCollection(c: DbCtx) {
  const input = await st().askText({
    title: "新建 Collection", message: "输入 Quick Setup JSON；dimension 为正整数，metricType 可选 COSINE / L2 / IP，idType 可选 Int64 / VarChar。",
    value: JSON.stringify({ collectionName: "your_collection", dimension: 128, metricType: "COSINE", primaryFieldName: "id", idType: "Int64", autoID: true, vectorFieldName: "vector" }),
    confirmText: "下一步",
  });
  if (input === null) return;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求必须为 JSON 对象");
    body = parsed;
    if (typeof body.collectionName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(body.collectionName) ||
      !Number.isInteger(body.dimension) || Number(body.dimension) <= 0 ||
      !["COSINE", "L2", "IP"].includes(String(body.metricType)) ||
      !["Int64", "VarChar"].includes(String(body.idType)) || typeof body.autoID !== "boolean" ||
      typeof body.primaryFieldName !== "string" || !body.primaryFieldName.trim() ||
      typeof body.vectorFieldName !== "string" || !body.vectorFieldName.trim()) {
      throw new Error("请完整填写集合名称、正整数维度、度量类型、主键名称与类型、autoID 和向量字段名称");
    }
  } catch (e) {
    toast(`集合参数无效: ${e}`);
    return;
  }
  await runVectorWrite(c, c.database, "collections/create", { ...body, dbName: c.database }, "新建 Collection", () => refreshTables(c));
}

async function dropVectorObject(c: DbCtx | TableCtx) {
  const name = "table" in c ? c.table : c.database;
  const title = "table" in c ? "删除 Collection" : "删除向量数据库";
  const input = await st().askText({
    title: `${title}「${name}」`, message: "该操作不可撤销，请输入名称以确认。",
    placeholder: name, expect: name, confirmText: "删除", danger: true,
  });
  if (input === null) return;
  if (input !== name) { toast("名称不匹配,已取消"); return; }
  await runVectorWrite(c, c.database, "table" in c ? "collections/drop" : "databases/drop",
    vectorBody(c), title, () => "table" in c ? refreshTables(c) : refreshConn(c.conn.id), true);
}

/* ────────────────── 连接级（统一） ────────────────── */

const CONNECTION_ITEMS: Items<ConnCtx> = [
  { id: "conn.messaging", label: "打开消息工作区", when: (c) => c.driver.caps.messaging,
    run: (c) => st().openMessaging(c.conn.id) },
  { id: "conn.storage", label: "打开对象存储工作区", when: (c) => c.driver.caps.storage,
    run: (c) => st().openStorage(c.conn.id) },
  {
    id: "conn.newQuery",
    label: "新建查询",
    hint: "在右栏编辑器中打开",
    when: (c) => c.driver.caps.sql,
    run: async (c) => {
      await st().selectConnection(c.conn.id);
      showRight();
      const db = st().dbTree[c.conn.id]?.selectedDb || c.conn.database;
      st().setEditorSql(newQuerySql(c, db));
    },
  },
  {
    id: "conn.console",
    label: "打开控制台",
    hint: "命令行模式",
    when: (c) => c.driver.caps.console && !c.driver.caps.sql,
    run: async (c) => {
      await st().selectConnection(c.conn.id);
      showRight();
      st().setEditorSql(hasVectorConsole(c)
        ? vectorRequest("collections/list", { dbName: st().dbTree[c.conn.id]?.selectedDb || c.conn.database || "default" })
        : c.driver.kind === "doc"
        ? mongoCmd({ find: "your_collection", filter: {}, limit: 20 })
        : c.driver.caps.mapping ? "GET /_cluster/health" : "KEYS *");
    },
  },
  {
    id: "conn.createDb",
    label: (c) => `新建${c.driver.dbLabel}…`,
    hint: "CREATE DATABASE",
    when: (c) => c.driver.caps.sql && c.driver.caps.databases && c.driver.caps.write &&
      canCreateSqlObject(c.driver),
    run: runCreateDb,
  },
  { id: "conn.createVectorDb", label: "新建数据库…", when: (c) => hasVectorConsole(c) && c.driver.caps.databases && c.driver.caps.write, run: createVectorDatabase },
  { id: "conn.refresh", label: "刷新元数据", run: (c) => refreshConn(c.conn.id) },
  {
    id: "conn.connect",
    label: (c) => (st().connSessions[c.conn.id] ? "断开连接" : "连接"),
    hint: (c) =>
      st().connSessions[c.conn.id] ? st().connSessions[c.conn.id].detail : "建立连接并验证",
    run: async (c) => {
      if (st().connSessions[c.conn.id]) await st().disconnectDb(c.conn.id);
      else await st().connectDb(c.conn.id);
    },
  },
  { sep: true },
  { id: "conn.edit", label: "编辑连接…", run: (c) => st().openDialog(c.conn) },
  {
    id: "conn.rename",
    label: "重命名",
    run: async (c) => {
      const input = await st().askText({
        title: "重命名连接",
        value: c.conn.name,
        placeholder: c.conn.name,
        confirmText: "保存",
      });
      const name = input?.trim();
      if (!name || name === c.conn.name) return;
      await st().saveConnection({ ...c.conn, name });
    },
  },
  {
    id: "conn.duplicate",
    label: "复制为新建",
    hint: "同配置复制一条连接",
    run: async (c) => {
      await st().saveConnection({ ...c.conn, id: "", name: `${c.conn.name} 副本` });
    },
  },
  { sep: true },
  {
    id: "conn.test",
    label: (c) => (c.driver.caps.localFile ? "校验文件" : "测试连接"),
    run: async (c) => {
      try {
        toast(await api.testConnection(c.conn));
      } catch (e) {
        toast(`${c.driver.caps.localFile ? "校验" : "连接"}失败: ${e}`);
      }
    },
  },
  {
    id: "conn.copyAddr",
    label: (c) => (c.driver.caps.localFile ? "复制文件路径" : "复制地址（不含密码）"),
    run: (c) =>
      copyText(
        c.driver.caps.localFile
          ? c.conn.database
          : c.driver.caps.messaging
          ? (c.conn.kafka?.bootstrap_servers ?? []).join(", ")
          : c.driver.caps.storage
          ? `${c.conn.oss?.scheme ?? "https"}://${c.conn.host}${c.conn.database ? `（默认 Bucket: ${c.conn.database}）` : ""}`
          : `${c.conn.host}:${c.conn.port}`,
        "已复制（不含密码）"
      ),
  },
  {
    id: "conn.copyCtx",
    label: "复制为 AI 上下文",
    hint: "仅含类型与地址,不含密码",
    run: (c) =>
      copyText(
        c.driver.caps.localFile
          ? `${c.driver.label} 连接「${c.conn.name}」,文件: ${c.conn.database}`
          : c.driver.caps.messaging
          ? `${c.driver.label} 连接「${c.conn.name}」,Bootstrap Servers ${(c.conn.kafka?.bootstrap_servers ?? []).join(", ")}`
          : c.driver.caps.storage
          ? `${c.driver.label} 连接「${c.conn.name}」,Endpoint ${c.conn.host}${c.conn.database ? `,默认 Bucket ${c.conn.database}` : ""}`
          : `${c.driver.label} 连接「${c.conn.name}」,地址 ${c.conn.host}:${c.conn.port}${c.conn.database ? `,默认库 ${c.conn.database}` : ""}`,
        "已复制 AI 上下文"
      ),
  },
  { sep: true },
  { id: "conn.env", label: "环境标签（dev / test / prod）…", planned: true },
  {
    id: "conn.group",
    label: (c) => (c.conn.group ? `移动到分组…（当前:${c.conn.group}）` : "移动到分组…"),
    hint: "选择已有分组或移出分组",
    run: async (c) => {
      const groups = [...new Set((st().config?.connections ?? []).map((conn) => conn.group).filter(Boolean))].sort();
      const input = await st().askText({
        title: "移动到分组",
        message: groups.length ? "选择已有分组，选择「未分组」可移出分组。" : "暂无已有分组，可在新建或编辑连接时创建分组。",
        value: c.conn.group ?? "",
        options: [
          { value: "", label: "未分组（移出分组）" },
          ...groups.map((group) => ({ value: group, label: group })),
        ],
        confirmText: "保存",
      });
      if (input === null) return;
      const group = input;
      if (group === (c.conn.group ?? "")) return;
      await st().saveConnection({ ...c.conn, group });
      toast(group ? `已移动到分组「${group}」` : "已移出分组");
    },
  },
  { sep: true },
  {
    id: "conn.remove",
    label: "删除连接",
    danger: true,
    run: async (c) => {
      const ok = await st().askConfirm({
        title: "删除连接",
        message: `确定删除连接「${c.conn.name}」?该操作不可撤销。`,
        confirmText: "删除",
        danger: true,
      });
      if (ok) await st().removeConnection(c.conn.id);
    },
  },
];

/* ────────────────── 库级（按大类） ────────────────── */

/** 设为当前库（已是当前库时隐藏该条目,避免二次点击变成折叠） */
const USE_DB_ITEM: Item<DbCtx> = {
  id: "db.use",
  label: (c) => `设为当前${c.driver.dbLabel}`,
  when: (c) => st().dbTree[c.conn.id]?.selectedDb !== c.database,
  run: (c) => st().selectDatabase(c.conn.id, c.database),
};

const SQL_DB_ITEMS: Items<DbCtx> = [
  {
    id: "db.create",
    label: (c) => `新建${c.driver.tableLabel}…`,
    hint: "打开表设计窗口",
    when: (c) => c.driver.caps.sql && c.driver.caps.tables && c.driver.caps.write &&
      canCreateSqlObject(c.driver),
    run: (c) => st().openCreate({ connId: c.conn.id, kind: "table", database: c.database }),
  },
  { sep: true },
  USE_DB_ITEM,
  {
    id: "db.newQuery",
    label: "新建查询",
    run: async (c) => {
      await st().selectConnection(c.conn.id);
      if (st().dbTree[c.conn.id]?.selectedDb !== c.database) {
        await st().selectDatabase(c.conn.id, c.database);
      }
      showRight();
      st().setEditorSql(newQuerySql(c, c.database));
    },
  },
  { id: "db.refresh", label: (c) => `刷新${c.driver.tableLabel}列表`, run: refreshTables },
  { sep: true },
  { id: "db.search", label: "搜索表…", planned: true },
  { id: "db.stats", label: (c) => `${c.driver.dbLabel}概览`, hint: "表数 / 行数估算 / 占用", when: (c) => c.driver.caps.stats, planned: true },
  { id: "db.ddl", label: "导出库结构（DDL）", when: (c) => c.driver.caps.ddl, planned: true },
  { sep: true },
  { id: "db.partition", label: "分区 / 分片信息", when: (c) => c.driver.caps.partition, planned: true },
  { id: "db.mv", label: "物化视图", when: (c) => c.driver.caps.mv, planned: true },
  { sep: true },
  {
    id: "db.drop",
    label: (c) => `删除${c.driver.dbLabel}`,
    hint: "DROP DATABASE,需手输库名确认",
    when: (c) => c.driver.caps.write && c.driver.caps.databases,
    danger: true,
    run: runDropDb,
  },
];

const KV_DB_ITEMS: Items<DbCtx> = [
  // 常用写操作置顶：新建键
  {
    id: "db.newKey",
    label: "新建键…",
    hint: "输入键名、值及可选过期时间",
    when: (c) => c.driver.caps.write && c.driver.createDialect === "redis",
    run: (c) => st().openCreate({ connId: c.conn.id, kind: "key", database: c.database }),
  },
  { sep: true },
  { id: "db.select", label: "切换逻辑库", planned: true },
  { id: "db.refresh", label: "刷新键列表", run: refreshTables },
  {
    id: "db.dbsize",
    label: "键数量",
    when: (c) => c.driver.caps.stats,
    run: async (c) => {
      await prepare(c);
      await st().runSql("DBSIZE");
    },
  },
  { sep: true },
  { id: "db.scan", label: "扫描设置（pattern / count）", when: (c) => c.driver.caps.keyTypes, planned: true },
  { id: "db.group", label: "按分隔符分组显示", when: (c) => c.driver.caps.keyTypes, planned: true },
  { sep: true },
  { id: "db.monitor", label: "监控（MONITOR）", planned: true },
  { sep: true },
  {
    id: "db.flush",
    label: "清空当前逻辑库",
    hint: "SELECT + FLUSHDB,需手输库号确认",
    when: (c) => c.driver.caps.write,
    danger: true,
    run: async (c) => {
      const db = c.database.replace(/^db/i, "");
      const input = await st().askText({
        title: `清空逻辑库 ${c.database}`,
        message: "将删除该逻辑库的全部键，该操作不可撤销。请输入逻辑库号以确认。",
        placeholder: db,
        expect: db,
        confirmText: "清空",
        danger: true,
      });
      if (input === null) return;
      if (input !== db) {
        toast("输入不匹配,已取消");
        return;
      }
      try {
        await api.redisCommand(c.conn, ["SELECT", db]);
        await api.redisCommand(c.conn, ["FLUSHDB"]);
        toast(`已清空 ${c.database}`);
        await refreshTables(c);
      } catch (e) {
        toast(`清空失败: ${e}`);
      }
    },
  },
];

const DB_ITEMS: Record<string, Items<DbCtx>> = {
  sql: SQL_DB_ITEMS,
  kv: KV_DB_ITEMS,
  doc: [
    USE_DB_ITEM,
    { id: "db.refresh", label: "刷新集合列表", run: refreshTables },
    { sep: true },
    {
      id: "db.stats",
      label: "库统计（dbStats）",
      when: (c) => c.driver.caps.stats,
      run: (c) => runMongo(c, { dbStats: 1 }),
    },
    {
      id: "db.aggregate",
      label: "聚合管道编辑器…",
      when: (c) => c.driver.caps.aggregate,
      run: (c) => mongoTemplate(c, { aggregate: "your_collection", pipeline: [{ $limit: 20 }], cursor: {} }),
    },
    { sep: true },
    {
      id: "db.create",
      label: "新建集合…",
      when: (c) => c.driver.caps.write,
      run: async (c) => {
        const input = await st().askText({
          title: `在「${c.database}」新建集合`,
          placeholder: "集合名称",
          confirmText: "创建",
        });
        const name = input?.trim();
        if (!name) return;
        try {
          await runMongo(c, { create: name });
          toast(`已创建集合「${name}」`);
          await refreshTables(c);
        } catch (e) {
          toast(`创建失败: ${e}`);
        }
      },
    },
    { id: "db.import", label: "导入 JSON / 导出 JSON", when: (c) => c.driver.caps.export, planned: true },
    { sep: true },
    {
      id: "db.drop",
      label: "删除库",
      when: (c) => c.driver.caps.write,
      danger: true,
      run: async (c) => {
        const input = await st().askText({
          title: `删除数据库「${c.database}」`,
          message: "将删除该库下全部集合，该操作不可撤销。请输入库名以确认。",
          placeholder: c.database,
          expect: c.database,
          confirmText: "删除",
          danger: true,
        });
        if (input === null) return;
        if (input !== c.database) {
          toast("名称不匹配,已取消");
          return;
        }
        try {
          await runMongo(c, { dropDatabase: 1 });
          toast(`已删除数据库「${c.database}」`);
          await refreshConn(c.conn.id);
        } catch (e) {
          toast(`删除失败: ${e}`);
        }
      },
    },
  ],
  vector: [
    { ...USE_DB_ITEM, when: (c) => c.driver.caps.databases && st().dbTree[c.conn.id]?.selectedDb !== c.database },
    { id: "db.refresh", label: "刷新 Collection", run: refreshTables },
    { sep: true },
    { id: "db.stats", label: "集合统计", hint: "实体数 / 索引状态 / 加载状态", when: (c) => c.driver.caps.stats, planned: true },
    { sep: true },
    { id: "db.create", label: "新建 Collection…", hint: "维度 dim / 主键 / 度量类型", when: (c) => c.driver.caps.write, planned: true },
    { id: "db.load", label: "全部加载 / 全部释放", when: (c) => c.driver.caps.loadRelease, planned: true },
    { sep: true },
    { id: "db.drop", label: "删除库", when: (c) => c.driver.caps.databases && c.driver.caps.write, danger: true, planned: true },
  ],
  search: [
    {
      id: "db.health",
      label: "集群健康",
      hint: "GET /_cluster/health",
      when: (c) => c.driver.caps.clusterHealth,
      run: async (c) => {
        await prepare(c);
        await st().runSql("GET /_cluster/health");
      },
    },
    { id: "db.refresh", label: "刷新索引列表", run: refreshTables },
    { sep: true },
    { id: "db.create", label: "新建索引…", hint: "settings（shards / replicas）+ mapping", when: (c) => c.driver.caps.write, planned: true },
    { id: "db.alias", label: "别名管理", planned: true },
    { sep: true },
    {
      id: "db.shards",
      label: "分片 / 节点分布",
      hint: "GET /_cat/shards?format=json",
      run: async (c) => {
        await prepare(c);
        await st().runSql("GET /_cat/shards?format=json&h=index,shard,prirep,state,node");
      },
    },
  ],
  ts: [
    { ...USE_DB_ITEM, when: (c) => c.driver.caps.databases && st().dbTree[c.conn.id]?.selectedDb !== c.database },
    { id: "db.refresh", label: "刷新 Measurement", run: refreshTables },
    { sep: true },
    { id: "db.timerange", label: "时间范围预设", hint: "最近 15m / 1h / 24h / 7d", when: (c) => c.driver.caps.timeRange, planned: true },
    { id: "db.retention", label: "保留策略 / 降采样", when: (c) => c.driver.caps.retention, planned: true },
    { id: "db.write", label: "写入测试点", when: (c) => c.driver.caps.write, planned: true },
    { sep: true },
    { id: "db.drop", label: (c) => `删除${c.driver.dbLabel}`, when: (c) => c.driver.caps.write, danger: true, planned: true },
  ],
  graph: [
    USE_DB_ITEM,
    { id: "db.refresh", label: "刷新标签", run: refreshTables },
    { sep: true },
    { id: "db.stats", label: "图概览", hint: "节点 / 边数量与标签分布", when: (c) => c.driver.caps.stats, planned: true },
    { sep: true },
    { id: "db.create", label: "新建标签 / 边类型…", when: (c) => c.driver.caps.write, planned: true },
    { id: "db.subgraph", label: "子图可视化", when: (c) => c.driver.caps.subgraph, planned: true },
    { sep: true },
    { id: "db.drop", label: (c) => `删除${c.driver.dbLabel}`, when: (c) => c.driver.caps.write, danger: true, planned: true },
  ],
  storage: [
    {
      id: "db.open",
      label: "打开对象存储工作区",
      hint: "浏览对象 / 上传 / 下载 / 临时链接",
      when: (c) => c.driver.caps.storage,
      run: (c) => st().openStorage(c.conn.id, c.database),
    },
    { id: "db.refresh", label: "刷新 Bucket 列表", run: (c) => refreshConn(c.conn.id) },
    { sep: true },
    { id: "db.copyName", label: "复制 Bucket 名", run: (c) => copyText(c.database) },
  ],
};

/* ────────────────── 表级（按大类） ────────────────── */

const SQL_TABLE_ITEMS: Items<TableCtx> = [
  {
    id: "t.preview",
    label: "预览前 100 行",
    when: (c) => c.driver.caps.sql,
    run: async (c) => {
      await prepare(c);
      const { top, tail } = limitSql(c.conn, 100);
      await st().runSql(`SELECT ${top}* FROM ${ident(c, c.table)}${tail}`);
    },
  },
  {
    id: "t.structure",
    label: "查看结构",
    when: (c) => c.driver.caps.ddl && structureSql(c) !== null,
    run: async (c) => {
      await prepare(c);
      const sql = structureSql(c);
      if (sql) await st().runSql(sql);
    },
  },
  {
    id: "t.ddl",
    label: "查看 DDL",
    when: (c) => c.driver.caps.ddl && ddlSql(c) !== null,
    run: async (c) => {
      await prepare(c);
      const sql = ddlSql(c);
      if (sql) await st().runSql(sql);
    },
  },
  {
    id: "t.template",
    label: "生成 SELECT 模板",
    run: (c) => {
      showRight();
      const { top, tail } = limitSql(c.conn, 100);
      st().setEditorSql(`SELECT ${top}*\nFROM ${ident(c, c.table)}\nWHERE 1 = 1${tail};`);
    },
  },
  {
    id: "t.explain",
    label: "执行计划（EXPLAIN）",
    when: (c) => c.driver.caps.explain && c.driver.caps.sql,
    run: async (c) => {
      await prepare(c);
      await st().runSql(explainSql(c));
    },
  },
  {
    id: "t.count",
    label: "行计数",
    when: (c) => c.driver.caps.sql,
    run: async (c) => {
      await prepare(c);
      await st().runSql(`SELECT COUNT(*) AS total FROM ${ident(c, c.table)}`);
    },
  },
  { sep: true },
  { id: "t.copyName", label: "复制表名", run: (c) => copyText(ident(c, c.table)) },
  { id: "t.filter", label: "加入筛选器…", planned: true },
  { sep: true },
  { id: "t.stats", label: "列统计（直方图）", when: (c) => c.driver.caps.stats, planned: true },
  { id: "t.export", label: "导出 CSV / JSON / SQL", when: (c) => c.driver.caps.export, planned: true },
  { sep: true },
  {
    id: "t.index",
    label: "索引与约束",
    when: (c) => c.driver.caps.index && indexSql(c) !== null,
    run: async (c) => {
      await prepare(c);
      const sql = indexSql(c);
      if (sql) await st().runSql(sql);
    },
  },
  {
    id: "t.partition",
    label: "分区信息",
    when: (c) => c.driver.caps.partition && partitionSql(c) !== null,
    run: async (c) => {
      await prepare(c);
      const sql = partitionSql(c);
      if (sql) await st().runSql(sql);
    },
  },
  { sep: true },
  { id: "t.rename", label: "重命名表", when: (c) => c.driver.caps.write, planned: true },
  { id: "t.truncate", label: "清空表（TRUNCATE）", when: (c) => c.driver.caps.truncate, danger: true, planned: true },
  { id: "t.drop", label: "删除表", when: (c) => c.driver.caps.write, danger: true, planned: true },
];

const KV_TABLE_ITEMS: Items<TableCtx> = [
  {
    id: "t.value",
    label: "查看值",
    hint: "按类型展开为表格(string / hash / list / set / zset / stream)",
    run: async (c) => {
      await prepare(c);
      await st().inspectKey(c.table);
    },
  },
  {
    id: "t.ttl",
    label: "查看 TTL",
    when: (c) => c.driver.caps.ttl,
    run: async (c) => {
      await prepare(c);
      await st().runSql(`TTL ${c.table}`);
    },
  },
  {
    id: "t.expire",
    label: "设置过期时间…",
    when: (c) => c.driver.caps.ttl && c.driver.caps.write,
    run: async (c) => {
      const input = await st().askText({
        title: `设置「${c.table}」的过期时间`,
        message: "单位为秒，-1 表示持久化（不过期）。",
        value: "3600",
        placeholder: "秒",
        confirmText: "设置",
      });
      if (input === null) return;
      const sec = input.trim();
      if (!/^-?\d+$/.test(sec)) {
        toast("请输入整数秒数");
        return;
      }
      if (Number(sec) === 0) {
        toast("0 会立即删除该键，请改用「删除键」");
        return;
      }
      await prepare(c);
      await st().runSql(Number(sec) < 0 ? `PERSIST ${c.table}` : `EXPIRE ${c.table} ${Number(sec)}`);
    },
  },
  { sep: true },
  { id: "t.copyKey", label: "复制键名", run: (c) => copyText(c.table) },
  {
    id: "t.rename",
    label: "重命名键",
    when: (c) => c.driver.caps.write,
    run: async (c) => {
      const input = await st().askText({
        title: "重命名键",
        message: `当前键名：${c.table}`,
        value: c.table,
        placeholder: "新的键名",
        confirmText: "重命名",
      });
      if (input === null) return;
      const next = input.trim();
      if (!next || next === c.table) return;
      if (/\s/.test(next)) {
        toast("键名不能包含空格");
        return;
      }
      await prepare(c);
      await st().runSql(`RENAME ${c.table} ${next}`);
      await refreshTables(c);
    },
  },
  {
    id: "t.persist",
    label: "持久化（移除 TTL）",
    when: (c) => c.driver.caps.ttl && c.driver.caps.write,
    run: async (c) => {
      await prepare(c);
      await st().runSql(`PERSIST ${c.table}`);
    },
  },
  { sep: true },
  {
    id: "t.del",
    label: "删除键",
    when: (c) => c.driver.caps.write,
    danger: true,
    run: async (c) => {
      const ok = await st().askConfirm({
        title: "删除键",
        message: `确定删除键「${c.table}」?该操作不可撤销。`,
        confirmText: "删除",
        danger: true,
      });
      if (!ok) return;
      await prepare(c);
      await st().runSql(`DEL ${c.table}`);
      await refreshTables(c);
    },
  },
];

const TABLE_ITEMS: Record<string, Items<TableCtx>> = {
  sql: SQL_TABLE_ITEMS,
  kv: KV_TABLE_ITEMS,
  messaging: [
    { id: "t.messages", label: "浏览消息 / 实时监听", when: (c) => c.driver.caps.browseMessages,
      run: (c) => st().openMessaging(c.conn.id, c.table) },
    { id: "t.messagingManage", label: "Topic 详情与管理…", when: (c) => c.driver.caps.topicManagement,
      run: (c) => st().openMessaging(c.conn.id, c.table) },
    { id: "t.produce", label: "生产消息…", when: (c) => c.driver.caps.produceMessages,
      run: (c) => st().openMessaging(c.conn.id, c.table) },
    { id: "t.copyName", label: "复制 Topic 名", run: (c) => copyText(c.table) },
  ],
  doc: [
    {
      id: "t.preview",
      label: "预览文档",
      hint: "find().limit(20)",
      run: (c) => runMongo(c, { find: c.table, filter: {}, limit: 20 }),
    },
    {
      id: "t.index",
      label: "查看索引",
      when: (c) => c.driver.caps.index,
      run: (c) => runMongo(c, { listIndexes: c.table }),
    },
    {
      id: "t.count",
      label: "文档计数",
      when: (c) => c.driver.caps.stats,
      run: (c) => runMongo(c, { count: c.table }),
    },
    {
      id: "t.stats",
      label: "集合统计（collStats）",
      when: (c) => c.driver.caps.stats,
      run: (c) => runMongo(c, { collStats: c.table }),
    },
    { sep: true },
    { id: "t.copyName", label: "复制集合名", run: (c) => copyText(c.table) },
    {
      id: "t.aggregate",
      label: "聚合管道编辑器…",
      when: (c) => c.driver.caps.aggregate,
      run: (c) => mongoTemplate(c, {
        aggregate: c.table,
        pipeline: [{ $match: {} }, { $limit: 20 }],
        cursor: {},
      }),
    },
    { id: "t.export", label: "导出 JSON / 导入 JSON", when: (c) => c.driver.caps.export, planned: true },
    { sep: true },
    {
      id: "t.rename",
      label: "重命名集合",
      when: (c) => c.driver.caps.write,
      run: async (c) => {
        const input = await st().askText({
          title: `重命名集合「${c.table}」`,
          value: c.table,
          placeholder: "新的集合名",
          confirmText: "重命名",
        });
        const next = input?.trim();
        if (!next || next === c.table) return;
        try {
          await runMongo(c, {
            renameCollection: `${c.database}.${c.table}`,
            to: `${c.database}.${next}`,
          });
          toast(`已重命名为「${next}」`);
          await refreshTables(c);
        } catch (e) {
          toast(`重命名失败: ${e}`);
        }
      },
    },
    {
      id: "t.clear",
      label: "清空集合",
      when: (c) => c.driver.caps.write,
      danger: true,
      run: async (c) => {
        const ok = await st().askConfirm({
          title: "清空集合",
          message: `将删除「${c.table}」中的全部文档（保留集合与索引），该操作不可撤销。`,
          confirmText: "清空",
          danger: true,
        });
        if (!ok) return;
        try {
          await runMongo(c, { delete: c.table, deletes: [{ q: {}, limit: 0 }] });
          toast(`已清空集合「${c.table}」`);
          await refreshTables(c);
        } catch (e) {
          toast(`清空失败: ${e}`);
        }
      },
    },
    {
      id: "t.drop",
      label: "删除集合",
      when: (c) => c.driver.caps.write,
      danger: true,
      run: async (c) => {
        const ok = await st().askConfirm({
          title: "删除集合",
          message: `确定删除集合「${c.table}」?该操作不可撤销。`,
          confirmText: "删除",
          danger: true,
        });
        if (!ok) return;
        try {
          await runMongo(c, { drop: c.table });
          toast(`已删除集合「${c.table}」`);
          await refreshTables(c);
        } catch (e) {
          toast(`删除失败: ${e}`);
        }
      },
    },
  ],
  vector: [
    { id: "t.preview", label: "预览实体", hint: "向量字段折叠显示", planned: true },
    { id: "t.schema", label: "查看 Schema", hint: "主键 / 向量字段 + dim", planned: true },
    { id: "t.index", label: "索引信息", hint: "index type + metric", when: (c) => c.driver.caps.index, planned: true },
    { id: "t.count", label: "实体计数", when: (c) => c.driver.caps.stats, planned: true },
    { sep: true },
    { id: "t.copyName", label: "复制集合名", run: (c) => copyText(c.table) },
    { id: "t.search", label: "向量检索…", hint: "topK + filter 表达式", when: (c) => c.driver.caps.vectorSearch, planned: true },
    { id: "t.load", label: "加载 / 释放", when: (c) => c.driver.caps.loadRelease, planned: true },
    { sep: true },
    { id: "t.drop", label: "删除 Collection", when: (c) => c.driver.caps.write, danger: true, planned: true },
  ],
  search: [
    { id: "t.preview", label: "预览文档", hint: "_search size=20", when: (c) => c.driver.caps.console, run: async (c) => {
      await prepare(c);
      await st().runSql(`POST /${encodeURIComponent(c.table)}/_search\n${JSON.stringify({ size: 20, query: { match_all: {} } }, null, 2)}`);
    } },
    { id: "t.mapping", label: "查看 Mapping", when: (c) => c.driver.caps.mapping && c.driver.caps.console, run: async (c) => {
      await prepare(c); await st().runSql(`GET /${encodeURIComponent(c.table)}/_mapping`);
    } },
    { id: "t.settings", label: "查看 Settings", hint: "shards / replicas", when: (c) => c.driver.caps.console, run: async (c) => {
      await prepare(c); await st().runSql(`GET /${encodeURIComponent(c.table)}/_settings`);
    } },
    { id: "t.count", label: "文档计数", when: (c) => c.driver.caps.stats && c.driver.caps.console, run: async (c) => {
      await prepare(c); await st().runSql(`GET /${encodeURIComponent(c.table)}/_count`);
    } },
    { sep: true },
    { id: "t.copyName", label: "复制索引名", run: (c) => copyText(c.table) },
    { id: "t.dsl", label: "查询 DSL 编辑器", when: (c) => c.driver.caps.console, run: async (c) => {
      await prepare(c); showRight();
      st().setEditorSql(`POST /${encodeURIComponent(c.table)}/_search\n${JSON.stringify({ size: 20, query: { match_all: {} } }, null, 2)}`);
    } },
    { id: "t.reindex", label: "别名管理 / 重建索引", planned: true },
    { sep: true },
    { id: "t.clear", label: "清空（delete_by_query）", when: (c) => c.driver.caps.write, danger: true, planned: true },
    { id: "t.drop", label: "删除索引", when: (c) => c.driver.caps.write, danger: true, planned: true },
  ],
  ts: [
    { id: "t.preview", label: "最近数据预览", planned: true },
    { id: "t.keys", label: "查看 field / tag keys", when: (c) => c.driver.caps.columns, planned: true },
    { id: "t.agg", label: "聚合查询（按时间降采样）", planned: true },
    { id: "t.retention", label: "保留策略", when: (c) => c.driver.caps.retention, planned: true },
    { sep: true },
    { id: "t.copyName", label: (c) => `复制${c.driver.tableLabel}名`, run: (c) => copyText(c.table) },
    { sep: true },
    { id: "t.drop", label: "删除 series / measurement", when: (c) => c.driver.caps.write, danger: true, planned: true },
  ],
  graph: [
    { id: "t.preview", label: "预览节点 / 边", planned: true },
    { id: "t.schema", label: "查看属性 Schema", when: (c) => c.driver.caps.columns, planned: true },
    { id: "t.count", label: "统计数量", when: (c) => c.driver.caps.stats, planned: true },
    { sep: true },
    { id: "t.copyName", label: (c) => `复制${c.driver.tableLabel}名`, run: (c) => copyText(c.table) },
    { id: "t.subgraph", label: "图可视化（展开 N 跳）", when: (c) => c.driver.caps.subgraph, planned: true },
    { sep: true },
    { id: "t.drop", label: "删除该标签下全部数据", when: (c) => c.driver.caps.write, danger: true, planned: true },
  ],
};

/* ────────────────── 列级（统一） ────────────────── */

const COLUMN_ITEMS: Items<ColumnCtx> = [
  { id: "col.copy", label: "复制列名", run: (c) => copyText(ident(c, c.column)) },
  {
    id: "col.select",
    label: "生成 SELECT 模板",
    when: (c) => c.driver.caps.sql,
    run: (c) => {
      showRight();
      const { top, tail } = limitSql(c.conn, 100);
      st().setEditorSql(`SELECT ${top}${ident(c, c.column)}\nFROM ${ident(c, c.table)}${tail};`);
    },
  },
  {
    id: "col.where",
    label: "生成 WHERE 模板",
    when: (c) => c.driver.caps.sql,
    run: (c) => {
      showRight();
      const { top, tail } = limitSql(c.conn, 100);
      st().setEditorSql(`SELECT ${top}*\nFROM ${ident(c, c.table)}\nWHERE ${ident(c, c.column)} = ''${tail};`);
    },
  },
  { sep: true },
  { id: "col.stats", label: "列统计", hint: "distinct / min / max / 空值率", when: (c) => c.driver.caps.stats, planned: true },
  { id: "col.comment", label: "查看注释 / 完整类型", when: (c) => c.driver.caps.columns, planned: true },
  { sep: true },
  { id: "col.vector", label: "用此字段做向量检索…", when: (c) => hasVectorConsole(c) && c.driver.caps.vectorSearch && /vector|^(100|101|102|103|104|105)(\D|$)/i.test(c.dataType ?? ""), run: vectorSearchTemplate },
  { id: "col.vector.planned", label: "用此字段做向量检索…", when: (c) => !hasVectorConsole(c) && c.driver.caps.vectorSearch, planned: true },
  { id: "col.mapping", label: "字段 mapping（analyzer / 可聚合）", when: (c) => c.driver.caps.mapping, planned: true },
  { id: "col.sample", label: "字段类型采样推断", when: (c) => c.driver.caps.sample, planned: true },
];

const VECTOR_DB_ITEMS: Items<DbCtx> = [
  { ...USE_DB_ITEM, when: (c) => c.driver.caps.databases && st().dbTree[c.conn.id]?.selectedDb !== c.database },
  { id: "db.console", label: "打开控制台", run: async (c) => { await prepare(c); showRight(); st().setEditorSql(vectorRequest("collections/list", vectorBody(c))); } },
  { id: "db.refresh", label: "刷新 Collection", run: refreshTables },
  { id: "db.describe", label: "数据库信息", run: (c) => runVectorRead(c, "databases/describe") },
  { sep: true },
  { id: "db.create", label: "新建 Collection…", when: (c) => c.driver.caps.write, run: createVectorCollection },
  { id: "db.drop", label: "删除数据库…", when: (c) => c.driver.caps.databases && c.driver.caps.write, danger: true, run: dropVectorObject },
];

const VECTOR_TABLE_ITEMS: Items<TableCtx> = [
  { id: "t.preview", label: "预览前 100 条实体", run: (c) => runVectorRead(c, "entities/query", { filter: "", outputFields: ["*"], limit: 100 }) },
  { id: "t.schema", label: "查看 Schema", run: (c) => runVectorRead(c, "collections/describe") },
  { id: "t.stats", label: "集合统计 / 实体数", when: (c) => c.driver.caps.stats, run: (c) => runVectorRead(c, "collections/get_stats") },
  { id: "t.index", label: "索引列表", when: (c) => c.driver.caps.index, run: (c) => runVectorRead(c, "indexes/list") },
  { id: "t.state", label: "加载状态", when: (c) => c.driver.caps.loadRelease, run: (c) => runVectorRead(c, "collections/get_load_state") },
  { id: "t.partitions", label: "分区列表", run: (c) => runVectorRead(c, "partitions/list") },
  { sep: true },
  { id: "t.copyName", label: "复制集合名", run: (c) => copyText(c.table) },
  { id: "t.search", label: "向量检索模板…", when: (c) => c.driver.caps.vectorSearch, run: vectorSearchTemplate },
  { id: "t.get", label: "按主键获取模板…", run: (c) => vectorTemplate(c, "entities/get", { id: [], outputFields: ["*"] }) },
  { id: "t.hybrid", label: "混合检索模板…", when: (c) => c.driver.caps.vectorSearch, run: async (c) => {
    await vectorTemplate(c, "entities/hybrid_search", {
      search: [{ annsField: "your_vector_field_1", data: [[]], limit: 10 }, { annsField: "your_vector_field_2", data: [[]], limit: 10 }],
      rerank: { strategy: "rrf", params: { k: 60 } }, limit: 10, outputFields: ["*"],
    });
    toast("请填写两个真实向量字段与对应查询向量；模板未执行");
  } },
  { sep: true },
  { id: "t.insert", label: "插入数据模板…", when: (c) => c.driver.caps.write, run: (c) => vectorTemplate(c, "entities/insert", { data: [] }) },
  { id: "t.upsert", label: "Upsert 数据模板…", when: (c) => c.driver.caps.write, run: (c) => vectorTemplate(c, "entities/upsert", { data: [] }) },
  { id: "t.delete", label: "删除实体模板…", when: (c) => c.driver.caps.write, danger: true, run: (c) => vectorTemplate(c, "entities/delete", { filter: "请填写精确的过滤表达式" }) },
  { id: "t.createIndex", label: "创建索引模板…", when: (c) => c.driver.caps.index && c.driver.caps.write, run: (c) => vectorTemplate(c, "indexes/create", {
    indexParams: [{ fieldName: "your_vector_field", indexName: "vector_index", metricType: "COSINE", params: { index_type: "AUTOINDEX" } }],
  }) },
  { id: "t.dropIndex", label: "删除索引模板…", when: (c) => c.driver.caps.index && c.driver.caps.write, danger: true, run: (c) => vectorTemplate(c, "indexes/drop", { indexName: "your_index" }) },
  { id: "t.createPartition", label: "创建分区模板…", when: (c) => c.driver.caps.write, run: (c) => vectorTemplate(c, "partitions/create", { partitionName: "your_partition" }) },
  { id: "t.dropPartition", label: "删除分区模板…", when: (c) => c.driver.caps.write, danger: true, run: (c) => vectorTemplate(c, "partitions/drop", { partitionName: "your_partition" }) },
  { sep: true },
  { id: "t.load", label: "加载集合…", when: (c) => c.driver.caps.loadRelease, run: (c) => runVectorWrite(c, c.database, "collections/load", vectorBody(c), "加载集合") },
  { id: "t.release", label: "释放集合…", when: (c) => c.driver.caps.loadRelease, run: (c) => runVectorWrite(c, c.database, "collections/release", vectorBody(c), "释放集合") },
  { id: "t.rename", label: "重命名集合…", when: (c) => c.driver.caps.write, run: async (c) => {
    const input = await st().askText({ title: `重命名 Collection「${c.table}」`, placeholder: "新集合名称", confirmText: "重命名" });
    const name = input?.trim();
    if (!name) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(name)) {
      toast("集合名称须以字母或下划线开头，仅含字母、数字和下划线，最多 255 字符");
      return;
    }
    if (name === c.table) { toast("新名称与原名称相同"); return; }
    await runVectorWrite(c, c.database, "collections/rename",
      { ...vectorBody(c), newCollectionName: name }, "重命名 Collection", () => refreshTables(c));
  } },
  { id: "t.drop", label: "删除 Collection…", when: (c) => c.driver.caps.write, danger: true, run: dropVectorObject },
];

/* ────────────────── 组装 ────────────────── */

function render<C>(list: Items<C>, ctx: C): MenuEntry[] {
  const out: MenuEntry[] = [];
  list.forEach((it, i) => {
    if ("sep" in it) {
      out.push({ id: `sep-${i}`, label: "", sep: true });
      return;
    }
    if (it.when && !it.when(ctx)) return;
    const fn = it.run;
    out.push({
      id: it.id,
      label: typeof it.label === "function" ? it.label(ctx) : it.label,
      hint: typeof it.hint === "function" ? it.hint(ctx) : it.hint,
      planned: it.planned,
      danger: it.danger,
      run: fn ? () => void fn(ctx) : undefined,
    });
  });
  // 去掉开头/结尾/连续的分隔符
  return out.filter((e, i) => !e.sep || (i > 0 && !out[i - 1].sep && i < out.length - 1));
}

export function buildMenu(ctx: MenuCtx): MenuEntry[] {
  switch (ctx.kind) {
    case "connection":
      return render(CONNECTION_ITEMS, ctx);
    case "database":
      return render(hasVectorConsole(ctx) ? VECTOR_DB_ITEMS : DB_ITEMS[ctx.driver.kind] ?? [], ctx);
    case "table":
      return render(hasVectorConsole(ctx) ? VECTOR_TABLE_ITEMS : TABLE_ITEMS[ctx.driver.kind] ?? [], ctx);
    case "column":
      return render(COLUMN_ITEMS, ctx);
  }
}
