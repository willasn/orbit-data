import { quoteIdent, type DriverMeta } from "./drivers";

export interface TableColumnDraft {
  id: number;
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  defaultValue: string;
  primary: boolean;
  autoIncrement: boolean;
  comment: string;
}

export const COLUMN_TYPES = {
  mysql: ["BIGINT", "INT", "VARCHAR", "CHAR", "TEXT", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TIMESTAMP", "JSON"],
  postgres: ["BIGINT", "INTEGER", "VARCHAR", "CHAR", "TEXT", "NUMERIC", "BOOLEAN", "DATE", "TIMESTAMP", "TIMESTAMPTZ", "JSONB"],
  clickhouse: ["UInt8", "UInt16", "UInt32", "UInt64", "Int8", "Int16", "Int32", "Int64", "Float32", "Float64",
    "Decimal", "String", "FixedString", "Date", "Date32", "DateTime", "DateTime64", "UUID", "Bool",
    "Array(String)", "Map(String, String)"],
} as const;

/** ClickHouse 表引擎（MergeTree 系列支持 ORDER BY / PARTITION BY / TTL） */
export const CLICKHOUSE_ENGINES = [
  "MergeTree", "ReplacingMergeTree", "SummingMergeTree", "AggregatingMergeTree", "Memory", "Log", "TinyLog",
] as const;

const MERGETREE_FAMILY = new Set<string>(["MergeTree", "ReplacingMergeTree", "SummingMergeTree", "AggregatingMergeTree"]);

export interface ClickHouseTableOptions {
  engine: string;
  orderBy: string;
  partitionBy: string;
  primaryKey: string;
  ttl: string;
}

export const CLICKHOUSE_TABLE_DEFAULT: ClickHouseTableOptions = {
  engine: "MergeTree", orderBy: "", partitionBy: "", primaryKey: "", ttl: "",
};

const LENGTH_TYPES = new Set(["VARCHAR", "CHAR", "DECIMAL", "NUMERIC"]);
const INTEGER_TYPES = new Set(["BIGINT", "INT", "INTEGER"]);

/** ClickHouse 中需要长度 / 精度参数的字段类型 */
const CH_LENGTH_TYPES: Record<string, RegExp> = {
  Decimal: /^\d{1,3},\d{1,3}$/,
  FixedString: /^\d{1,5}$/,
  DateTime64: /^\d{1,2}$/,
};

export function tableColumn(
  id: number,
  dialect: "mysql" | "postgres" | "clickhouse" = "mysql",
): TableColumnDraft {
  const clickhouse = dialect === "clickhouse";
  return {
    id,
    name: id === 1 ? "id" : "",
    type: clickhouse ? "UInt64" : "BIGINT",
    length: "",
    nullable: id !== 1,
    defaultValue: "",
    primary: !clickhouse && id === 1,
    autoIncrement: !clickhouse && id === 1,
    comment: "",
  };
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** ClickHouse 默认值：函数调用（如 now()、today()）原样输出，其余按字符串字面量 */
function clickhouseDefault(value: string): string {
  const trimmed = value.trim();
  return /^[A-Za-z_][A-Za-z0-9_.]*\([^)]*\)$/.test(trimmed) ? trimmed : literal(value);
}

function tupleExpr(expression: string): string {
  const text = expression.trim();
  if (text.startsWith("(") || !text.includes(",")) return text;
  return `(${text})`;
}

function buildClickHouseTableSql(
  driver: DriverMeta,
  database: string,
  table: string,
  columns: TableColumnDraft[],
  options: ClickHouseTableOptions,
): string {
  if (!database.trim() || !table.trim()) throw new Error("请选择数据库并填写表名");
  if (/[\0-\x1f\x7f]/.test(table)) throw new Error("表名包含控制字符");
  if (!columns.length) throw new Error("请至少添加一个字段");
  if (!(CLICKHOUSE_ENGINES as readonly string[]).includes(options.engine)) {
    throw new Error(`不支持的表引擎：${options.engine}`);
  }
  const mergeTree = MERGETREE_FAMILY.has(options.engine);
  if (mergeTree && !options.orderBy.trim()) throw new Error(`${options.engine} 必须填写 ORDER BY 排序键`);

  const names = new Set<string>();
  const definitions = columns.map((c) => {
    const name = c.name.trim();
    if (!name) throw new Error("字段名称不能为空");
    if (/[\0-\x1f\x7f]/.test(name)) throw new Error(`字段名包含控制字符：${name}`);
    const normalized = name.toLowerCase();
    if (names.has(normalized)) throw new Error(`字段名重复：${name}`);
    names.add(normalized);
    if (!(COLUMN_TYPES.clickhouse as readonly string[]).includes(c.type)) {
      throw new Error(`不支持的字段类型：${c.type}`);
    }
    const length = c.length.trim();
    const lengthRule = CH_LENGTH_TYPES[c.type];
    if (lengthRule) {
      if (!lengthRule.test(length)) {
        throw new Error(`${name} 的长度/精度格式不正确（${c.type} 需填 ${
          c.type === "Decimal" ? "如 18,4" : c.type === "FixedString" ? "如 16" : "如 3"
        }）`);
      }
    } else if (length) throw new Error(`${name} 的类型不支持长度/精度`);
    const q = quoteIdent(driver.type, name);
    const type = `${c.type}${lengthRule ? `(${length})` : ""}`;
    let sql = `${q} ${c.nullable ? `Nullable(${type})` : type}`;
    if (c.defaultValue !== "") sql += ` DEFAULT ${clickhouseDefault(c.defaultValue)}`;
    if (c.comment) sql += ` COMMENT ${literal(c.comment)}`;
    return `  ${sql}`;
  });

  const full = `${quoteIdent(driver.type, database.trim())}.${quoteIdent(driver.type, table.trim())}`;
  let ddl = `CREATE TABLE ${full} (\n${definitions.join(",\n")}\n) ENGINE = ${options.engine}`;
  if (mergeTree) {
    if (options.partitionBy.trim()) {
      if (/[\0-\x1f\x7f]/.test(options.partitionBy)) throw new Error("PARTITION BY 包含控制字符");
      ddl += `\nPARTITION BY ${options.partitionBy.trim()}`;
    }
    ddl += `\nORDER BY ${tupleExpr(options.orderBy)}`;
    if (options.primaryKey.trim()) ddl += `\nPRIMARY KEY ${tupleExpr(options.primaryKey)}`;
    if (options.ttl.trim()) ddl += `\nTTL ${options.ttl.trim()}`;
  }
  return `${ddl};`;
}

export function buildCreateTableSql(
  driver: DriverMeta,
  database: string,
  table: string,
  columns: TableColumnDraft[],
  clickhouseOptions: ClickHouseTableOptions = CLICKHOUSE_TABLE_DEFAULT,
): string {
  const dialect = driver.createDialect;
  if (dialect === "clickhouse") {
    return buildClickHouseTableSql(driver, database, table, columns, clickhouseOptions);
  }
  if (dialect !== "mysql" && dialect !== "postgres") throw new Error("当前连接尚不支持建表");
  if (!database.trim() || !table.trim()) throw new Error("请选择数据库并填写表名");
  if (/[\0-\x1f\x7f]/.test(table)) throw new Error("表名包含控制字符");
  if (!columns.length) throw new Error("请至少添加一个字段");
  const names = new Set<string>();
  const primary = columns.filter((c) => c.primary);
  if (columns.some((c) => c.autoIncrement) && (primary.length !== 1 || !primary[0].autoIncrement)) {
    throw new Error("自增字段必须是唯一主键");
  }
  const definitions = columns.map((c) => {
    const name = c.name.trim();
    if (!name) throw new Error("字段名称不能为空");
    if (/[\0-\x1f\x7f]/.test(name)) throw new Error(`字段名包含控制字符：${name}`);
    const normalized = name.toLowerCase();
    if (names.has(normalized)) throw new Error(`字段名重复：${name}`);
    names.add(normalized);
    if (!COLUMN_TYPES[dialect].some((type) => type === c.type)) throw new Error(`不支持的字段类型：${c.type}`);
    if (c.autoIncrement && !INTEGER_TYPES.has(c.type)) throw new Error(`自增字段必须使用整数类型：${name}`);
    const length = c.length.trim();
    if (LENGTH_TYPES.has(c.type)) {
      if (!/^\d+(,\d+)?$/.test(length)) throw new Error(`${name} 的长度/精度格式不正确`);
      const numbers = length.split(",").map(Number);
      if (numbers.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 65535) ||
        (c.type === "VARCHAR" || c.type === "CHAR") && (numbers.length !== 1 || numbers[0] < 1 || numbers[0] > 16383) ||
        (c.type === "DECIMAL" || c.type === "NUMERIC") && (numbers[0] < 1 || numbers[0] > (dialect === "mysql" ? 65 : 1000) ||
          (numbers[1] ?? 0) > numbers[0])) {
        throw new Error(`${name} 的长度/精度超出范围`);
      }
    } else if (length) throw new Error(`${name} 的类型不支持长度/精度`);
    if (c.autoIncrement && c.defaultValue !== "") throw new Error(`自增字段不能设置默认值：${name}`);
    if (dialect === "mysql" && [c.defaultValue, c.comment].some((value) => value.includes("\\"))) {
      throw new Error(`${name} 的默认值/注释暂不支持反斜杠`);
    }
    const q = quoteIdent(driver.type, name);
    const type = dialect === "postgres" && c.autoIncrement
      ? (c.type === "BIGINT" ? "BIGINT GENERATED BY DEFAULT AS IDENTITY" : "INTEGER GENERATED BY DEFAULT AS IDENTITY")
      : `${c.type}${length ? `(${length})` : ""}`;
    let sql = `${q} ${type}${c.primary || !c.nullable ? " NOT NULL" : ""}`;
    if (dialect === "mysql" && c.autoIncrement) sql += " AUTO_INCREMENT";
    if (c.defaultValue !== "") {
      const value = c.defaultValue;
      sql += ` DEFAULT ${/^CURRENT_TIMESTAMP$/i.test(value.trim()) && ["DATETIME", "TIMESTAMP", "TIMESTAMPTZ"].includes(c.type) ? "CURRENT_TIMESTAMP" : literal(value)}`;
    }
    if (dialect === "mysql" && c.comment) sql += ` COMMENT ${literal(c.comment)}`;
    return `  ${sql}`;
  });
  if (primary.length) definitions.push(`  PRIMARY KEY (${primary.map((c) => quoteIdent(driver.type, c.name.trim())).join(", ")})`);
  const qTable = quoteIdent(driver.type, table.trim());
  const full = dialect === "mysql" ? `${quoteIdent(driver.type, database)}.${qTable}` : qTable;
  return `CREATE TABLE ${full} (\n${definitions.join(",\n")}\n)${dialect === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" : ""};`;
}