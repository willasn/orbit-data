use sqlx::mysql::{MySqlPoolOptions, MySqlRow};
use sqlx::{Column, Row, ValueRef};
use std::time::Instant;

use super::{ColumnInfo, QueryResult, TableInfo};
use crate::config::Connection;

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

pub async fn connect(c: &Connection, database: &str) -> Result<sqlx::mysql::MySqlPool, String> {
    let db = if database.is_empty() {
        c.database.clone()
    } else {
        database.to_string()
    };
    let mut url = format!(
        "mysql://{}:{}@{}:{}",
        enc(&c.username),
        enc(&c.password),
        c.host,
        c.port
    );
    if !db.is_empty() {
        url.push('/');
        url.push_str(&enc(&db));
    }
    MySqlPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(&url)
        .await
        .map_err(|e| format!("MySQL 连接失败: {e}"))
}

/// 通用单元格解码:按类型链依次尝试
fn cell(row: &MySqlRow, i: usize) -> serde_json::Value {
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
    try_get!(u64, |v| serde_json::json!(v));
    try_get!(f64, |v| serde_json::json!(v));
    try_get!(f32, |v| serde_json::json!(v));
    try_get!(bool, |v| serde_json::json!(v));
    try_get!(rust_decimal::Decimal, |v| serde_json::json!(v.to_string()));
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

fn metadata_text(row: &MySqlRow, i: usize) -> String {
    if let Ok(Some(value)) = row.try_get::<Option<String>, _>(i) {
        return value;
    }
    row.try_get::<Option<Vec<u8>>, _>(i)
        .ok()
        .flatten()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
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
    let rows = sqlx::query("SHOW DATABASES")
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("获取数据库列表失败: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| metadata_text(r, 0))
        .collect())
}

pub async fn list_tables(c: &Connection, database: &str) -> Result<Vec<TableInfo>, String> {
    let db = if database.is_empty() {
        c.database.clone()
    } else {
        database.to_string()
    };
    let pool = connect(c, &db).await?;
    let rows = sqlx::query("SHOW FULL TABLES")
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("获取表列表失败: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| TableInfo {
            name: metadata_text(r, 0),
            table_type: metadata_text(r, 1)
                .to_lowercase()
                .replace("base table", "table"),
        })
        .collect())
}

pub async fn list_columns(
    c: &Connection,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let db = if database.is_empty() {
        c.database.clone()
    } else {
        database.to_string()
    };
    let pool = connect(c, &db).await?;
    let sql = format!(
        "SHOW FULL COLUMNS FROM `{}`.`{}`",
        db.replace('`', ""),
        table.replace('`', "")
    );
    let rows = sqlx::query(&sql)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("获取列信息失败: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| ColumnInfo {
            name: metadata_text(r, 0),
            data_type: metadata_text(r, 1),
            nullable: metadata_text(r, 3).eq_ignore_ascii_case("YES"),
            key: metadata_text(r, 4),
            comment: metadata_text(r, 8),
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
    let rows: Vec<MySqlRow> = sqlx::query(sql)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("查询失败: {e}"))?;
    let is_column_structure = sql
        .trim_start()
        .to_ascii_uppercase()
        .starts_with("SHOW FULL COLUMNS ");
    let indices: Vec<usize> = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .enumerate()
                .filter(|(_, col)| !is_column_structure || col.name() != "Privileges")
                .map(|(i, _)| i)
                .collect()
        })
        .unwrap_or_default();
    let columns: Vec<String> = rows
        .first()
        .map(|r| indices.iter().map(|&i| r.columns()[i].name().to_string()).collect())
        .unwrap_or_default();
    let mut out: Vec<Vec<serde_json::Value>> = Vec::new();
    for row in rows.iter().take(limit) {
        out.push(indices.iter().map(|&i| {
            if is_column_structure {
                if row.try_get_raw(i).map(|v| v.is_null()).unwrap_or(true) {
                    serde_json::Value::Null
                } else {
                    serde_json::json!(metadata_text(row, i))
                }
            } else {
                cell(row, i)
            }
        }).collect());
    }
    Ok(QueryResult {
        columns,
        row_count: out.len(),
        rows: out,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}
