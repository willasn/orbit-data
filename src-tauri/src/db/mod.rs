pub mod elasticsearch;
pub mod kafka;
pub mod mqtt;
pub mod mssql;
pub mod mysql;
pub mod pg;
pub mod redis;
pub mod session;

use crate::config::Connection;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct TableInfo {
    pub name: String,
    /// table | view | key
    #[serde(rename = "type")]
    pub table_type: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub key: String,
    pub comment: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct QueryResult {
    pub columns: Vec<String>,
    /// 单元格统一序列化为 字符串/数字/null
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub duration_ms: u64,
}

pub async fn test_connection(c: &Connection) -> Result<String, String> {
    const TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    tokio::time::timeout(TEST_TIMEOUT, async {
        match c.db_type.as_str() {
            "mysql" => mysql::test(c).await,
            "postgres" => pg::test(c).await,
            "sqlserver" => mssql::test(c).await,
            "redis" => redis::test(c).await,
            "elasticsearch" => elasticsearch::test(c).await,
            "kafka" => kafka::test(c).await,
            "mqtt" => mqtt::test(c).await,
            other => Err(format!("不支持的数据库类型: {other}")),
        }
    })
    .await
    .unwrap_or_else(|_| Err("连接测试超时（5 秒），请检查主机、端口和网络".into()))
}

pub async fn list_databases(c: &Connection) -> Result<Vec<String>, String> {
    match c.db_type.as_str() {
        "mysql" => mysql::list_databases(c).await,
        "postgres" => pg::list_databases(c).await,
        "sqlserver" => mssql::list_databases(c).await,
        "redis" => Ok(vec!["db0".to_string()]),
        "elasticsearch" | "kafka" | "mqtt" => Ok(vec![]),
        other => Err(format!("不支持的数据库类型: {other}")),
    }
}

pub async fn list_tables(c: &Connection, database: &str) -> Result<Vec<TableInfo>, String> {
    match c.db_type.as_str() {
        "mysql" => mysql::list_tables(c, database).await,
        "postgres" => pg::list_tables(c, database).await,
        "sqlserver" => mssql::list_tables(c, database).await,
        "redis" => redis::list_tables(c).await,
        "elasticsearch" => elasticsearch::list_tables(c).await,
        "kafka" => kafka::tables(c).await,
        "mqtt" => Ok(vec![]),
        other => Err(format!("不支持的数据库类型: {other}")),
    }
}

pub async fn list_columns(
    c: &Connection,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    match c.db_type.as_str() {
        "mysql" => mysql::list_columns(c, database, table).await,
        "postgres" => pg::list_columns(c, database, table).await,
        "sqlserver" => mssql::list_columns(c, database, table).await,
        "elasticsearch" => elasticsearch::list_columns(c, table).await,
        _ => Err("该数据库类型不支持列信息".into()),
    }
}

pub async fn run_query(
    c: &Connection,
    database: &str,
    sql: &str,
    limit: usize,
) -> Result<QueryResult, String> {
    match c.db_type.as_str() {
        "mysql" => mysql::query(c, database, sql, limit).await,
        "postgres" => pg::query(c, database, sql, limit).await,
        "sqlserver" => mssql::query(c, database, sql, limit).await,
        "elasticsearch" => elasticsearch::query(c, database, sql, limit).await,
        "redis" => Err("Redis 请在对话或命令面板中使用 Redis 命令".into()),
        "kafka" => Err("Kafka 请使用消息工作区，不支持 SQL 执行".into()),
        "mqtt" => Err("MQTT 请使用消息工作区，不支持 SQL 执行".into()),
        other => Err(format!("不支持的数据库类型: {other}")),
    }
}
