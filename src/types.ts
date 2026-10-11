export interface KafkaConfig {
  bootstrap_servers: string[];
  security_protocol: "PLAINTEXT" | "SSL" | "SASL_PLAINTEXT" | "SASL_SSL";
  sasl_mechanism: "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512";
  ssl_ca_location: string;
  ssl_certificate_location: string;
  ssl_key_location: string;
  client_id: string;
}

/// 数据库连接配置
export interface Connection {
  id: string;
  name: string;
  /** 数据库类型标识,能力与文案见 src/db/drivers.ts 注册表 */
  db_type: string;
  host: string;
  port: number;
  username: string;
  password: string;
  /** SQL 默认数据库；Elasticsearch 默认索引 */
  database: string;
  color: string;
  /** 左栏分组名(空串表示未分组) */
  group: string;
  kafka?: KafkaConfig | null;
}

/** 后端记录的已连接会话 */
export interface SessionInfo {
  db_type: string;
  detail: string;
  since_ms: number;
}

export type ModelProtocol = "openai" | "openai_responses" | "anthropic" | "gemini";

/// 自定义 AI 模型配置
export interface ModelConfig {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  protocol: ModelProtocol;
  input_tokens: number | null;
  output_tokens: number | null;
  supports_images: boolean;
}

export interface SyncConfig {
  repo_path: string;
  branch: string;
  remote_url: string;
  auto_push: boolean;
}

export interface AppConfig {
  connections: Connection[];
  models: ModelConfig[];
  active_model_id: string;
  sync: SyncConfig;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** 该条回答被用户主动中断(已生成内容保留) */
  stopped?: boolean;
}

export interface TableInfo {
  name: string;
  type: string;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  key: string;
  comment: string;
}

export type CellValue = string | number | null;

export interface QueryResult {
  columns: string[];
  rows: CellValue[][];
  row_count: number;
  duration_ms: number;
  /** 结果表头左侧的补充说明(如 Redis 键的类型与 TTL) */
  meta?: string;
}

/** Redis 单键内容预览(后端按值类型展开成列与行,见 CONTEXT_MENU.md 5.2) */
export interface RedisKeyView {
  key: string;
  /** string | list | set | zset | hash | stream | none */
  key_type: string;
  /** 剩余过期秒数:-1 永不过期,-2 键不存在 */
  ttl: number;
  columns: string[];
  rows: string[][];
  /** 内容超过展示上限,仅返回前若干项 */
  truncated: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  streaming: boolean;
  pinned?: boolean;
  /** 当前对话选择的模型；未指定时使用默认模型 */
  modelId?: string;
}

export type Tab =
  | { id: string; kind: "chat"; sessionId: string; title: string }
  | { id: string; kind: "result"; title: string; result: QueryResult }
  | { id: string; kind: "messaging"; title: string; connId: string; topic?: string };

export type KafkaRequest = {
  action: "metadata" | "list_topics" | "topic_detail" | "brokers" | "read" | "produce" |
    "create_topic" | "delete_topic" | "increase_partitions" | "topic_config" | "alter_config" |
    "groups" | "list_groups" | "group_offsets" | "group_detail" | "reset_offsets" | "reset_group_offsets" | "delete_group";
  [key: string]: unknown;
};

export interface KafkaTopic {
  name: string;
  partitions: number;
  is_internal?: boolean;
}

export interface KafkaPartition {
  partition: number;
  leader: number;
  replicas: number[];
  isr: number[];
  low?: string;
  high?: string;
}

export interface KafkaTopicConfig {
  name: string;
  value: string | null;
  is_read_only?: boolean;
  is_sensitive?: boolean;
  source?: string;
}

export interface KafkaTopicDetail {
  partitions: KafkaPartition[];
  configs: KafkaTopicConfig[];
}

export interface KafkaMessage {
  topic: string;
  partition: number;
  offset: string;
  timestamp: number | null;
  key: string | null;
  value: string | null;
  key_hex?: string | null;
  value_hex?: string | null;
  headers: { key: string; value: string | null; value_hex?: string | null }[];
}

export interface KafkaReadResult {
  messages: KafkaMessage[];
  next_offsets: Record<string, string>;
  truncated?: boolean;
  warnings?: string[];
}

export interface KafkaGroup {
  group_id: string;
  state?: string;
  protocol_type?: string;
}

export interface KafkaGroupDetail {
  state: string;
  members: { id: string; client_id: string; client_host: string; assignment?: unknown }[];
  offsets: { topic: string; partition: number; offset: string | null; high: string; lag: string | null }[];
}

export interface KafkaBrokers {
  brokers: { id: number; host: string; port: number }[];
  controller_id: number | null;
}

/** 对象树正在拉取的层级(展开时用于显示加载态) */
export type TreeLoading = "" | "databases" | "tables" | "columns";

export interface DbTree {
  /** 连接级是否展开(独立于 activeConnId,可收起且仍保持选中) */
  expanded: boolean;
  databases: string[] | null;
  selectedDb: string;
  tables: TableInfo[] | null;
  /** tables 属于哪个库(收起后保留缓存,再次展开免请求) */
  tablesDb: string;
  selectedTable: string;
  /** 对话上下文选择的字段 */
  selectedColumn?: string;
  columns: ColumnInfo[] | null;
  /** columns 属于哪张表 */
  columnsTable: string;
  loading: TreeLoading;
  /** 最近一次加载失败的原因(空串表示无错误) */
  error: string;
  /** error 来自哪一层(只在对应层级显示「加载失败,点击重试」) */
  errorLevel: TreeLoading;
}
