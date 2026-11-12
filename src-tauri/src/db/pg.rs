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
    // TLS：require 只加密不校验证书（适配自签 / 未包含当前 IP 的证书），
    // verify-full 同时校验证书链与主机名（支持证书 SAN 中的 IP 地址）
    let ssl_mode = match c.tls {
        Some(true) if c.tls_skip_verify => Some("require"),
        Some(true) => Some("verify-full"),
        Some(false) => Some("disable"),
        None => None,
    };
    let url = match ssl_mode {
        Some(mode) => format!("{url}?sslmode={mode}"),
        None => url,
    };
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
        "SELECT c.column_name, c.data_type, c.is_nullable, \
         CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS column_key, \
         '' AS comment \
         FROM information_schema.columns c \
         LEFT JOIN ( \
           SELECT kcu.table_schema, kcu.table_name, kcu.column_name \
           FROM information_schema.table_constraints tc \
           INNER JOIN information_schema.key_column_usage kcu \
             ON kcu.constraint_name = tc.constraint_name \
            AND kcu.table_schema = tc.table_schema \
           WHERE tc.constraint_type = 'PRIMARY KEY' \
         ) pk ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name \
           AND pk.column_name = c.column_name \
         WHERE c.table_schema = current_schema() AND c.table_name = $1 \
         ORDER BY c.ordinal_position",
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

/// 按主键批量提交结果集修改：同一事务内逐行 UPDATE，失败整体回滚
pub async fn update_rows(
    c: &Connection,
    database: &str,
    table: &str,
    rows: &[super::RowUpdate],
) -> Result<usize, String> {
    let target = super::qualified_name(super::Quote::Double, "", table);
    let pool = connect(c, database).await?;
    let mut tx = pool.begin().await.map_err(|e| format!("开启事务失败: {e}"))?;
    let mut affected = 0usize;
    for row in rows {
        let sql = super::update_statement("UPDATE", &target, "SET", row, super::Quote::Double, false)?;
        let result = sqlx::query(&sql)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("更新失败: {e}"))?;
        affected += result.rows_affected() as usize;
    }
    tx.commit().await.map_err(|e| format!("提交事务失败: {e}"))?;
    Ok(affected)
}
