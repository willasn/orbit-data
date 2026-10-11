use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{Column, Row, ValueRef};
use std::time::Instant;

use super::{ColumnInfo, QueryResult, TableInfo};
use crate::config::Connection;

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

pub async fn connect(c: &Connection, database: &str) -> Result<sqlx::postgres::PgPool, String> {
    let db = if !database.is_empty() {
        database.to_string()
    } else if !c.database.is_empty() {
        c.database.clone()
    } else {
        "postgres".to_string()
    };
    let url = format!(
        "postgres://{}:{}@{}:{}/{}",
        enc(&c.username),
        enc(&c.password),
        c.host,
        c.port,
        enc(&db)
    );
    PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&url)
        .await
        .map_err(|e| format!("PostgreSQL 连接失败: {e}"))
}

fn cell(row: &PgRow, i: usize) -> serde_json::Value {
    let raw = match row.try_get_raw(i) {
        Ok(v) => v,
        Err(_) => return serde_json::Value::Null,
    };
    if raw.is_null() {
        return serde_json::Value::Null;
    }
    macro_rules! try_get {
        ($t:ty, $conv:expr) => {
            if let Ok(Some(v)) = row.try_get::<Option<$t>, _>(i) {
                let f: fn($t) -> serde_json::Value = $conv;
                return f(v);
            }
        };
    }
    try_get!(i64, |v| serde_json::json!(v));
    try_get!(f64, |v| serde_json::json!(v));
    try_get!(bool, |v| serde_json::json!(v));
    try_get!(rust_decimal::Decimal, |v| serde_json::json!(v.to_string()));
    try_get!(uuid::Uuid, |v| serde_json::json!(v.to_string()));
    try_get!(String, |v| serde_json::json!(v));
    try_get!(chrono::NaiveDateTime, |v| serde_json::json!(v.to_string()));
    try_get!(chrono::NaiveDate, |v| serde_json::json!(v.to_string()));
    try_get!(chrono::NaiveTime, |v| serde_json::json!(v.to_string()));
    try_get!(serde_json::Value, |v| v);
    if let Ok(bytes) = row.try_get::<Vec<u8>, _>(i) {
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        return serde_json::json!(format!("0x{hex}"));
    }
    serde_json::Value::Null
}

pub async fn test(c: &Connection) -> Result<String, String> {
    let pool = connect(c, "").await?;
    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .map_err(|e| format!("测试查询失败: {e}"))?;
    Ok("连接成功".into())
}

pub async fn list_databases(c: &Connection) -> Result<Vec<String>, String> {
    let pool = connect(c, "").await?;
    let rows = sqlx::query(
        "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("获取数据库列表失败: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| cell(r, 0).as_str().unwrap_or_default().to_string())
        .collect())
}

pub async fn list_tables(c: &Connection, database: &str) -> Result<Vec<TableInfo>, String> {
    let pool = connect(c, database).await?;
    let rows = sqlx::query(
        "SELECT table_name, CASE table_type WHEN 'BASE TABLE' THEN 'table' ELSE 'view' END \
         FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("获取表列表失败: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| TableInfo {
            name: cell(r, 0).as_str().unwrap_or_default().to_string(),
            table_type: cell(r, 1).as_str().unwrap_or("table").to_string(),
        })
        .collect())
}

pub async fn list_columns(
    c: &Connection,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let pool = connect(c, database).await?;
    let rows = sqlx::query(
        "SELECT column_name, data_type, is_nullable, '' AS key, '' AS comment \
         FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    )
    .bind(table)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("获取列信息失败: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| ColumnInfo {
            name: cell(r, 0).as_str().unwrap_or_default().to_string(),
            data_type: cell(r, 1).as_str().unwrap_or_default().to_string(),
            nullable: cell(r, 2)
                .as_str()
                .map(|s| s.eq_ignore_ascii_case("YES"))
                .unwrap_or(false),
            key: cell(r, 3).as_str().unwrap_or_default().to_string(),
            comment: cell(r, 4).as_str().unwrap_or_default().to_string(),
        })
        .collect())
}

pub async fn query(
    c: &Connection,
    database: &str,
    sql: &str,
    limit: usize,
) -> Result<QueryResult, String> {
    let pool = connect(c, database).await?;
    let start = Instant::now();
    let rows: Vec<PgRow> = sqlx::query(sql)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("查询失败: {e}"))?;
    let columns: Vec<String> = rows
        .first()
        .map(|r| r.columns().iter().map(|col| col.name().to_string()).collect())
        .unwrap_or_default();
    let mut out: Vec<Vec<serde_json::Value>> = Vec::new();
    for row in rows.iter().take(limit) {
        out.push((0..columns.len()).map(|i| cell(row, i)).collect());
    }
    Ok(QueryResult {
        columns,
        row_count: out.len(),
        rows: out,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}
