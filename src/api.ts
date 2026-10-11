import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  AppConfig,
  ChatMessage,
  ColumnInfo,
  Connection,
  KafkaRequest,
  ModelConfig,
  QueryResult,
  RedisKeyView,
  SessionInfo,
  TableInfo,
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
  listDatabases: (conn: Connection) => invoke<string[]>("list_databases", { conn }),
  listTables: (conn: Connection, database: string) =>
    invoke<TableInfo[]>("list_tables", { conn, database }),
  listColumns: (conn: Connection, database: string, table: string) =>
    invoke<ColumnInfo[]>("list_columns", { conn, database, table }),
  /** ES 的 database 是目标索引，sql 承载 JSON DSL 或 METHOD /path + JSON。 */
  runQuery: (conn: Connection, database: string, sql: string, limit = 500) =>
    invoke<QueryResult>("run_query", { conn, database, sql, limit }),
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

  syncInit: () => invoke<string>("sync_init"),
  syncCommit: (message: string) => invoke<string>("sync_commit", { message }),
  syncPull: () => invoke<AppConfig>("sync_pull"),
  syncStatus: () => invoke<string>("sync_status"),
};
