/**
 * 数据库驱动能力注册表 —— 右键菜单与 UI 文案的唯一事实来源。
 *
 * 约定（详见 CONTEXT_MENU.md）：
 * - 菜单条目只依赖 `caps`（能力位），绝不按 `db_type` 写分支。
 * - 新增一种数据库：只在此文件加一条 DriverMeta；若大类（kind）已存在则菜单零改动。
 * - caps 描述的是「数据库本身具备的能力」，功能是否落地由菜单条目的 `planned` 标记。
 */

/** 数据库大类：同一大类共用一套库级 / 表级菜单骨架 */
export type DbKind = "sql" | "kv" | "doc" | "vector" | "search" | "ts" | "graph" | "messaging";

export interface Caps {
  /** 可执行 SQL */
  sql: boolean;
  /** 命令行模式（非 SQL，如 Redis / Cypher / PromQL） */
  console: boolean;
  /** 存在库级节点 */
  databases: boolean;
  tables: boolean;
  columns: boolean;
  /** 可查看 / 导出对象结构 */
  ddl: boolean;
  explain: boolean;
  /** 支持写操作（增删改） */
  write: boolean;
  truncate: boolean;
  partition: boolean;
  mv: boolean;
  index: boolean;
  /** 库 / 表统计信息 */
  stats: boolean;
  /** 数据导出 */
  export: boolean;
  /** 本地文件型（无主机端口，如 SQLite / DuckDB） */
  localFile: boolean;
  /** KV：TTL */
  ttl: boolean;
  /** KV：多值类型（hash / list / set / zset / stream） */
  keyTypes: boolean;
  /** 文档：聚合管道 */
  aggregate: boolean;
  /** 文档：字段类型采样推断 */
  sample: boolean;
  /** 向量：相似度检索 */
  vectorSearch: boolean;
  /** 向量：load / release */
  loadRelease: boolean;
  /** 检索：mapping */
  mapping: boolean;
  /** 检索：集群健康 */
  clusterHealth: boolean;
  /** 时序：时间范围 */
  timeRange: boolean;
  /** 时序：保留策略 / 降采样 */
  retention: boolean;
  /** 图：子图可视化 */
  subgraph: boolean;
  messaging: boolean;
  browseMessages: boolean;
  produceMessages: boolean;
  topicManagement: boolean;
  consumerGroups: boolean;
  resetOffsets: boolean;
}

export interface DriverMeta {
  type: string;
  label: string;
  kind: DbKind;
  defaultPort: number;
  color: string;
  /** 库级节点在该类型中的叫法 */
  dbLabel: string;
  /** 表级节点在该类型中的叫法 */
  tableLabel: string;
  /** 标识符引用符 */
  quote: "`" | '"' | "[]" | "";
  /** 当前应用已实现的创建表单与执行方言 */
  createDialect?: "mysql" | "postgres" | "redis";
  queryLanguage?: "elasticsearch";
  caps: Caps;
}

const BASE: Caps = {
  sql: false,
  console: false,
  databases: false,
  tables: false,
  columns: false,
  ddl: false,
  explain: false,
  write: false,
  truncate: false,
  partition: false,
  mv: false,
  index: false,
  stats: false,
  export: false,
  localFile: false,
  ttl: false,
  keyTypes: false,
  aggregate: false,
  sample: false,
  vectorSearch: false,
  loadRelease: false,
  mapping: false,
  clusterHealth: false,
  timeRange: false,
  retention: false,
  subgraph: false,
  messaging: false,
  browseMessages: false,
  produceMessages: false,
  topicManagement: false,
  consumerGroups: false,
  resetOffsets: false,
};

/** 关系型 / OLAP 通用能力 */
const SQL: Caps = {
  ...BASE,
  sql: true,
  databases: true,
  tables: true,
  columns: true,
  ddl: true,
  explain: true,
  write: true,
  truncate: true,
  index: true,
  stats: true,
  export: true,
};

const DRIVER_LIST: DriverMeta[] = [
  { type: "kafka", label: "Kafka", kind: "messaging", defaultPort: 9092, color: "#a78bfa", dbLabel: "集群", tableLabel: "Topic", quote: "", caps: { ...BASE, tables: true, write: true, partition: true, stats: true, export: true, messaging: true, browseMessages: true, produceMessages: true, topicManagement: true, consumerGroups: true, resetOffsets: true } },
  // ── sql：关系型 ──────────────────────────────────────────────
  { type: "mysql", label: "MySQL", kind: "sql", defaultPort: 3306, color: "#22c55e", dbLabel: "数据库", tableLabel: "表", quote: "`", createDialect: "mysql", caps: SQL },
  { type: "mariadb", label: "MariaDB", kind: "sql", defaultPort: 3306, color: "#16a34a", dbLabel: "数据库", tableLabel: "表", quote: "`", caps: SQL },
  { type: "tidb", label: "TiDB", kind: "sql", defaultPort: 4000, color: "#22c55e", dbLabel: "数据库", tableLabel: "表", quote: "`", caps: SQL },
  { type: "oceanbase", label: "OceanBase", kind: "sql", defaultPort: 2881, color: "#0ea5e9", dbLabel: "数据库", tableLabel: "表", quote: "`", caps: SQL },
  { type: "postgres", label: "PostgreSQL", kind: "sql", defaultPort: 5432, color: "#3b82f6", dbLabel: "数据库", tableLabel: "表", quote: '"', createDialect: "postgres", caps: { ...SQL, mv: true } },
  { type: "timescaledb", label: "TimescaleDB", kind: "sql", defaultPort: 5432, color: "#38bdf8", dbLabel: "数据库", tableLabel: "超表", quote: '"', caps: { ...SQL, mv: true, timeRange: true, retention: true } },
  { type: "oracle", label: "Oracle", kind: "sql", defaultPort: 1521, color: "#f59e0b", dbLabel: "Schema", tableLabel: "表", quote: '"', caps: { ...SQL, mv: true } },
  { type: "sqlserver", label: "SQL Server", kind: "sql", defaultPort: 1433, color: "#e11d48", dbLabel: "数据库", tableLabel: "表", quote: "[]", caps: { ...SQL, mv: true } },
  { type: "dm", label: "达梦 DM", kind: "sql", defaultPort: 5236, color: "#a855f7", dbLabel: "模式", tableLabel: "表", quote: '"', caps: SQL },

  // ── sql：国产 / 信创（按上游协议族登记，后端暂无独立连接器）──────
  { type: "polardb", label: "PolarDB", kind: "sql", defaultPort: 3306, color: "#0ea5e9", dbLabel: "数据库", tableLabel: "表", quote: "`", caps: SQL },
  { type: "kingbase", label: "人大金仓 Kingbase", kind: "sql", defaultPort: 54321, color: "#6366f1", dbLabel: "数据库", tableLabel: "表", quote: '"', caps: SQL },
  { type: "opengauss", label: "openGauss", kind: "sql", defaultPort: 5432, color: "#fb7185", dbLabel: "数据库", tableLabel: "表", quote: '"', caps: SQL },
  { type: "gbase", label: "南大通用 GBase", kind: "sql", defaultPort: 5258, color: "#a21caf", dbLabel: "数据库", tableLabel: "表", quote: '"', caps: SQL },
  { type: "oscar", label: "神舟通用 Oscar", kind: "sql", defaultPort: 2003, color: "#84cc16", dbLabel: "模式", tableLabel: "表", quote: '"', caps: SQL },

  // ── sql：OLAP / 分析型 ───────────────────────────────────────
  { type: "clickhouse", label: "ClickHouse", kind: "sql", defaultPort: 8123, color: "#facc15", dbLabel: "数据库", tableLabel: "表", quote: "`", caps: { ...SQL, partition: true, mv: true, index: false } },
  { type: "doris", label: "Doris", kind: "sql", defaultPort: 9030, color: "#f97316", dbLabel: "数据库", tableLabel: "表", quote: "`", caps: { ...SQL, partition: true, mv: true } },
  { type: "starrocks", label: "StarRocks", kind: "sql", defaultPort: 9030, color: "#fb923c", dbLabel: "数据库", tableLabel: "表", quote: "`", caps: { ...SQL, partition: true, mv: true } },
  { type: "hive", label: "Hive", kind: "sql", defaultPort: 10000, color: "#fde047", dbLabel: "数据库", tableLabel: "表", quote: "`", caps: { ...SQL, partition: true, write: false, truncate: false, index: false } },
  { type: "trino", label: "Trino", kind: "sql", defaultPort: 8080, color: "#06b6d4", dbLabel: "Catalog", tableLabel: "表", quote: '"', caps: { ...SQL, write: false, truncate: false, index: false } },

  // ── sql：本地文件型 ──────────────────────────────────────────
  { type: "sqlite", label: "SQLite", kind: "sql", defaultPort: 0, color: "#64748b", dbLabel: "数据库", tableLabel: "表", quote: '"', caps: { ...SQL, databases: false, stats: false, localFile: true } },
  { type: "duckdb", label: "DuckDB", kind: "sql", defaultPort: 0, color: "#fbbf24", dbLabel: "数据库", tableLabel: "表", quote: '"', caps: { ...SQL, databases: false, stats: false, localFile: true } },

  // ── kv ──────────────────────────────────────────────────────
  { type: "redis", label: "Redis", kind: "kv", defaultPort: 6379, color: "#ef4444", dbLabel: "逻辑库", tableLabel: "键", quote: "", createDialect: "redis", caps: { ...BASE, console: true, databases: true, tables: true, write: true, stats: true, export: true, ttl: true, keyTypes: true } },
  { type: "valkey", label: "Valkey", kind: "kv", defaultPort: 6379, color: "#f43f5e", dbLabel: "逻辑库", tableLabel: "键", quote: "", caps: { ...BASE, console: true, databases: true, tables: true, write: true, stats: true, export: true, ttl: true, keyTypes: true } },
  { type: "dragonfly", label: "Dragonfly", kind: "kv", defaultPort: 6379, color: "#8b5cf6", dbLabel: "逻辑库", tableLabel: "键", quote: "", caps: { ...BASE, console: true, databases: true, tables: true, write: true, stats: true, export: true, ttl: true, keyTypes: true } },
  { type: "memcached", label: "Memcached", kind: "kv", defaultPort: 11211, color: "#94a3b8", dbLabel: "实例", tableLabel: "键", quote: "", caps: { ...BASE, console: true, write: true } },

  // ── doc ─────────────────────────────────────────────────────
  { type: "mongodb", label: "MongoDB", kind: "doc", defaultPort: 27017, color: "#47a248", dbLabel: "数据库", tableLabel: "集合", quote: "", caps: { ...BASE, console: true, databases: true, tables: true, columns: true, write: true, stats: true, export: true, index: true, aggregate: true, sample: true } },

  // ── vector ──────────────────────────────────────────────────
  { type: "milvus", label: "Milvus", kind: "vector", defaultPort: 19530, color: "#0284c7", dbLabel: "数据库", tableLabel: "Collection", quote: "", caps: { ...BASE, databases: true, tables: true, columns: true, write: true, stats: true, export: true, index: true, vectorSearch: true, loadRelease: true } },
  { type: "qdrant", label: "Qdrant", kind: "vector", defaultPort: 6333, color: "#7c3aed", dbLabel: "实例", tableLabel: "Collection", quote: "", caps: { ...BASE, tables: true, columns: true, write: true, stats: true, export: true, index: true, vectorSearch: true } },

  // ── search ──────────────────────────────────────────────────
  { type: "elasticsearch", label: "Elasticsearch", kind: "search", defaultPort: 9200, color: "#38bdf8", dbLabel: "集群", tableLabel: "索引", quote: "", queryLanguage: "elasticsearch", caps: { ...BASE, console: true, tables: true, columns: true, write: true, stats: true, export: true, index: true, mapping: true, clusterHealth: true } },
  { type: "opensearch", label: "OpenSearch", kind: "search", defaultPort: 9200, color: "#22d3ee", dbLabel: "集群", tableLabel: "索引", quote: "", caps: { ...BASE, tables: true, columns: true, write: true, stats: true, export: true, index: true, mapping: true, clusterHealth: true } },

  // ── ts ──────────────────────────────────────────────────────
  { type: "influxdb", label: "InfluxDB", kind: "ts", defaultPort: 8086, color: "#14b8a6", dbLabel: "Bucket", tableLabel: "Measurement", quote: "", caps: { ...BASE, console: true, databases: true, tables: true, columns: true, write: true, stats: true, export: true, timeRange: true, retention: true } },
  { type: "tdengine", label: "TDengine", kind: "ts", defaultPort: 6030, color: "#0891b2", dbLabel: "数据库", tableLabel: "超级表", quote: "`", caps: { ...SQL, partition: true, timeRange: true, retention: true } },
  { type: "prometheus", label: "Prometheus", kind: "ts", defaultPort: 9090, color: "#e6522c", dbLabel: "实例", tableLabel: "指标", quote: "", caps: { ...BASE, console: true, tables: true, columns: true, stats: true, export: true, timeRange: true } },
  { type: "questdb", label: "QuestDB", kind: "ts", defaultPort: 8812, color: "#fbbf24", dbLabel: "数据库", tableLabel: "表", quote: '"', caps: { ...SQL, databases: false, timeRange: true, index: false } },

  // ── graph ───────────────────────────────────────────────────
  { type: "neo4j", label: "Neo4j", kind: "graph", defaultPort: 7687, color: "#65a30d", dbLabel: "数据库", tableLabel: "标签", quote: "", caps: { ...BASE, console: true, databases: true, tables: true, columns: true, write: true, stats: true, export: true, subgraph: true } },
  { type: "nebula", label: "NebulaGraph", kind: "graph", defaultPort: 9669, color: "#1d4ed8", dbLabel: "Space", tableLabel: "Tag / Edge", quote: "", caps: { ...BASE, console: true, databases: true, tables: true, columns: true, write: true, stats: true, export: true, subgraph: true } },
];

export const DRIVERS: Record<string, DriverMeta> = Object.fromEntries(
  DRIVER_LIST.map((d) => [d.type, d])
);

/** 未知类型兜底：按关系型处理，避免新增类型时 UI 崩溃 */
const FALLBACK: DriverMeta = {
  type: "*",
  label: "数据库",
  kind: "sql",
  defaultPort: 0,
  color: "#64748b",
  dbLabel: "数据库",
  tableLabel: "表",
  quote: '"',
  caps: SQL,
};

export function driverOf(type: string): DriverMeta {
  return DRIVERS[type] ?? { ...FALLBACK, type, label: type };
}

export function defaultPortOf(type: string): number {
  return driverOf(type).defaultPort;
}

/** 按方言转义标识符（表名 / 列名） */
export function quoteIdent(type: string, name: string): string {
  const q = driverOf(type).quote;
  if (q === "`") return `\`${name.replace(/`/g, "``")}\``;
  if (q === '"') return `"${name.replace(/"/g, '""')}"`;
  if (q === "[]") {
    // SQL Server：schema.table 这类限定名需逐段转义（[sales].[Orders]）
    return name
      .split(".")
      .map((part) => `[${part.replace(/]/g, "]]")}]`)
      .join(".");
  }
  return name;
}
