import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  AgentStepInput,
  AgentStepResult,
  AppConfig,
  ChatMessage,
  ColumnInfo,
  Connection,
  KafkaRequest,
  ModelConfig,
  MqttPage,
  QueryResult,
  RedisKeyView,
  RowUpdate,
  SessionInfo,
  OssRequest,
  OssTransferRequest,
  SyncConfig,
  SyncOutcome,
  TableInfo,
  UpdateInfo,
} from "./types";

export interface ChatEvent {
  type: "delta" | "done";
  text?: string;
  /** done 事件：回答被用户主动中断 */
  cancelled?: boolean;
}

export const api = {
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConnection: (conn: Connection) =>
    invoke<AppConfig>("save_connection", { conn }),
  deleteConnection: (id: string) => invoke<AppConfig>("delete_connection", { id }),
  saveModel: (model: ModelConfig) => invoke<AppConfig>("save_model", { model }),
  testModel: (model: ModelConfig) => invoke<void>("test_model", { model }),
  deleteModel: (id: string) => invoke<AppConfig>("delete_model", { id }),
  setActiveModel: (id: string) => invoke<AppConfig>("set_active_model", { id }),

  testConnection: (conn: Connection) => invoke<string>("test_connection", { conn }),
  connectDb: (conn: Connection) => invoke<string>("connect_db", { conn }),
  disconnectDb: (id: string) => invoke<void>("disconnect_db", { id }),
  connectionStatus: () => invoke<Record<string, SessionInfo>>("connection_status"),
  kafkaRequest: <T = unknown>(connId: string, request: KafkaRequest) =>
    invoke<T>("kafka_request", { connId, request }),
  ossRequest: <T = unknown>(connId: string, request: OssRequest) =>
    invoke<T>("oss_request", { connId, request }),
  ossTransfer: <T = unknown>(connId: string, request: OssTransferRequest) =>
    invoke<T>("oss_transfer", { connId, request }),
  mqttSubscribe: (
    connId: string,
    topic: string,
    qos: number,
    noLocal = false,
    retainAsPublished = false,
    retainHandling = 0,
  ) =>
    invoke<void>("mqtt_subscribe", { connId, topic, qos, noLocal, retainAsPublished, retainHandling }),
  mqttUnsubscribe: (connId: string, topic: string) =>
    invoke<void>("mqtt_unsubscribe", { connId, topic }),
  mqttPublish: (
    connId: string,
    topic: string,
    qos: number,
    retain: boolean,
    payload: string,
    format: string,
    userProperties: [string, string][] = [],
  ) =>
    invoke<void>("mqtt_publish", { connId, topic, qos, retain, payload, format, userProperties }),
  mqttMessages: (connId: string, since: number) =>
    invoke<MqttPage>("mqtt_messages", { connId, since }),
  mqttClear: (connId: string) => invoke<void>("mqtt_clear", { connId }),
  listDatabases: (conn: Connection) => invoke<string[]>("list_databases", { conn }),
  listTables: (conn: Connection, database: string) =>
    invoke<TableInfo[]>("list_tables", { conn, database }),
  listColumns: (conn: Connection, database: string, table: string) =>
    invoke<ColumnInfo[]>("list_columns", { conn, database, table }),
  /** ES 的 database 是目标索引；Milvus 是数据库名，sql 承载 REST v2 请求或带 operation 的 JSON。 */
  runQuery: (conn: Connection, database: string, sql: string, limit = 500) =>
    invoke<QueryResult>("run_query", { conn, database, sql, limit }),
  /** 按主键批量提交结果集修改，返回影响行数 */
  updateRows: (conn: Connection, database: string, table: string, rows: RowUpdate[]) =>
    invoke<number>("update_rows", { conn, database, table, rows }),
  redisCommand: (conn: Connection, args: string[]) =>
    invoke<string>("redis_command", { conn, args }),
  redisKeyView: (conn: Connection, key: string) =>
    invoke<RedisKeyView>("redis_key_view", { conn, key }),

  aiChat: (
    modelId: string,
    messages: ChatMessage[],
    requestId: string,
    onEvent: (ev: ChatEvent) => void
  ) => {
    const channel = new Channel<ChatEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("ai_chat", { modelId, messages, requestId, channel });
  },

  /** 中断指定请求的流式回答；已生成内容保留 */
  aiCancel: (requestId: string) => invoke<void>("ai_cancel", { requestId }),

  /** Agent 单步决策：返回下一步命令或结束结论（不在后端执行命令） */
  aiAgentStep: (modelId: string, input: AgentStepInput) =>
    invoke<AgentStepResult>("ai_agent_step", { modelId, input }),

  /** 测试 Git 远程仓库连通性与认证 */
  syncTest: (sync: SyncConfig) => invoke<string>("sync_test", { sync }),
  /** 单键同步；resolution 为空时遇到冲突返回 needs_choice */
  syncNow: (resolution?: "remote" | "local") =>
    invoke<SyncOutcome>("sync_now", { resolution: resolution ?? null }),

  /** 检查是否有新版本(只查询,不下载) */
  updateCheck: () => invoke<UpdateInfo>("update_check"),
  /** 下载并安装更新,完成后应用自动重启 */
  updateInstall: () => invoke<void>("update_install"),
};
