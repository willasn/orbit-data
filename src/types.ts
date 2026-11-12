export interface KafkaConfig {
  bootstrap_servers: string[];
  security_protocol: "PLAINTEXT" | "SSL" | "SASL_PLAINTEXT" | "SASL_SSL";
  sasl_mechanism: "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512";
  ssl_ca_location: string;
  ssl_certificate_location: string;
  ssl_key_location: string;
  client_id: string;
}

export interface MqttConfig {
  protocol: "mqtt" | "mqtts" | "ws" | "wss";
  client_id: string;
  mqtt_version: "5.0" | "3.1.1";
  keep_alive_secs: number;
  clean_start: boolean;
  session_expiry_secs: number;
  connection_timeout_secs: number;
  /** WebSocket 路径（仅 ws / wss） */
  path: string;
  ca_file: string;
  client_cert_file: string;
  client_key_file: string;
  will_topic: string;
  will_payload: string;
  will_qos: 0 | 1 | 2;
  will_retain: boolean;
}

export interface OssConfig {
  /** https | http */
  scheme: "https" | "http";
  /** 可选：STS 临时凭据 token */
  sts_token: string;
}

export interface ClickHouseConfig {
  /** http | https，默认 http */
  scheme: "http" | "https";
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
  mqtt?: MqttConfig | null;
  oss?: OssConfig | null;
  clickhouse?: ClickHouseConfig | null;
  /** 启用 TLS（TCP 类为 SSL/TLS，HTTP 类为 HTTPS）；未设置时沿用各类型原有默认行为 */
  tls?: boolean;
  /** 跳过服务器证书校验（自签证书或证书未包含当前访问 IP / 域名时使用） */
  tls_skip_verify?: boolean;
}

export interface MqttMessage {
  seq: number;
  topic: string;
  payload: string;
  payload_hex: string;
  size: number;
  qos: number;
  retain: boolean;
  /** true = 本机发布，false = 从 Broker 收到 */
  sent: boolean;
  ts: number;
}

export interface MqttPage {
  messages: MqttMessage[];
  last_seq: number;
  reset: boolean;
  connected: boolean;
  error: string;
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
  /** Agent 步骤：待执行的命令 */
  command?: string;
  /** 命令类型(用于代码块标注) */
  commandKind?: "sql" | "redis" | "elasticsearch";
  /** Agent 步骤状态 */
  status?: "thinking" | "pending" | "running" | "done" | "error" | "skipped" | "stopped";
  /** 需要用户确认的原因(写入 / 修改 / 删除等) */
  authReason?: string;
  /** 高风险破坏性操作：确认时额外弹窗 */
  danger?: boolean;
  /** 执行输出(回填给模型并展示) */
  output?: string;
  /** 输出概要(行数 / 耗时) */
  outputMeta?: string;
  /** 查询结果(仅内存展示，不持久化) */
  result?: QueryResult;
  /** 达到步数上限：显示「继续执行」 */
  canContinue?: boolean;
}

/** Agent 已执行的一步(回填给模型) */
export interface AgentStep {
  command: string;
  output: string;
}

/** Agent 单步决策入参 */
export interface AgentStepInput {
  goal: string;
  steps: AgentStep[];
  context?: string;
  db_type?: string;
  remaining_steps?: number;
}

/** Agent 单步决策结果 */
export interface AgentStepResult {
  action: "run" | "done";
  thought?: string | null;
  command?: string | null;
  summary?: string | null;
  requires_auth: boolean;
  auth_reason?: string | null;
  danger: boolean;
  danger_reason?: string | null;
  raw: string;
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

/** 结果集单格修改 */
export interface GridCellEdit {
  column: string;
  value: CellValue;
}

/** 结果集按行提交：keys 为主键原始值，values 为变更列 */
export interface RowUpdate {
  keys: GridCellEdit[];
  values: GridCellEdit[];
}

/** 结果集可编辑上下文：仅单表查询且主键列在结果中时存在 */
export interface ResultEditSource {
  connId: string;
  database: string;
  /** 产生该结果的 SQL，提交后用于刷新 */
  sql: string;
  table: string;
  /** 结果列名 -> 表列名（大小写不敏感匹配） */
  columnMap: Record<string, string>;
  /** 主键列（表列名） */
  pkColumns: string[];
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
  | { id: string; kind: "result"; title: string; result: QueryResult; edit?: ResultEditSource }
  | { id: string; kind: "messaging"; title: string; connId: string; topic?: string }
  | { id: string; kind: "storage"; title: string; connId: string; bucket?: string; prefix?: string };

/* ────────────────── 对象存储（阿里云 OSS） ────────────────── */

export interface OssBucket {
  name: string;
  creation_date: string;
}

export interface OssObject {
  key: string;
  is_folder: boolean;
  size: number;
  last_modified: string;
  etag: string;
  storage_class: string;
}

export type OssSortMode = "name-asc" | "name-desc" | "mtime-asc" | "mtime-desc";

export interface OssObjectList {
  prefix: string;
  objects: OssObject[];
  /** 时间筛选后的对象总数（整个前缀，而非当前页） */
  total: number;
  /** 后端校正后的当前页（1 基） */
  page: number;
  page_size: number;
  /** 扫描量达到上限，结果可能不完整 */
  scan_truncated: boolean;
}

export interface OssObjectDetail {
  key: string;
  size: number;
  content_type: string;
  etag: string;
  last_modified: string;
  storage_class: string;
  content_md5: string;
}

export interface OssPresignResult {
  url: string;
  /** 失效时间（毫秒时间戳） */
  expires_at: number;
}

export interface OssObjectText {
  key: string;
  content_type: string;
  size: number;
  text: string;
  /** 超过预览上限，内容已截断 */
  truncated: boolean;
}

export type OssRequest = {
  action: "list_buckets" | "list_objects" | "get_object_text" | "head_object" | "delete_object" | "presign_url";
  bucket?: string;
  prefix?: string;
  /** ISO 8601 时间，服务端按最后修改时间过滤 */
  start_time?: string;
  end_time?: string;
  sort?: OssSortMode;
  /** 1 基页码 */
  page?: number;
  page_size?: number;
  /** 跳过索引缓存，强制重新扫描 Bucket */
  refresh?: boolean;
  key?: string;
  expires_secs?: number;
};

export type OssTransferRequest = {
  action: "upload_file" | "download_file";
  bucket: string;
  key: string;
  local_path: string;
};

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

/** 自动更新检查结果；无新版本时 latest / notes / published_at 为 null */
export interface UpdateInfo {
  has_update: boolean;
  /** 当前运行版本 */
  current: string;
  /** 远端最新版本 */
  latest: string | null;
  /** 更新说明(Release notes) */
  notes: string | null;
  /** 发布时间(Unix 秒) */
  published_at: number | null;
}
