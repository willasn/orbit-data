/// SQL Server 连接器（TDS 协议，基于 tiberius）
///
/// sqlx 自 0.7 起移除 mssql 驱动，SQL Server 走独立连接器，接口与 mysql.rs / pg.rs 保持一致。
/// 层级映射见 CONTEXT_MENU.md 第三节：库级 = database，表级 = schema.table（dbo 省略前缀），列级 = column。
use std::time::{Duration, Instant};
use tiberius::{AuthMethod, Client, ColumnData, Config};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::{ColumnInfo, QueryResult, TableInfo};
use crate::config::Connection;

/// 未限定表名的默认 schema
const DEFAULT_SCHEMA: &str = "dbo";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

type SqlClient = Client<Compat<TcpStream>>;

pub async fn connect(c: &Connection, database: &str) -> Result<SqlClient, String> {
    let db = if !database.is_empty() {
        database.to_string()
    } else if !c.database.is_empty() {
        c.database.clone()
    } else {
        "master".to_string()
    };
    let mut config = Config::new();
    config.host(&c.host);
    config.port(c.port);
    config.database(&db);
    config.authentication(AuthMethod::sql_server(
        c.username.as_str(),
        c.password.as_str(),
    ));
    // 面向内网与自签证书环境：默认加密等级保留 Required，但不校验证书链
    config.trust_cert();
    let addr = config.get_addr();
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr))
        .await
        .map_err(|_| format!("SQL Server 连接超时（10 秒）：{addr}"))?
        .map_err(|e| format!("SQL Server 连接失败: {e}"))?;
    tcp.set_nodelay(true)
        .map_err(|e| format!("SQL Server 连接失败: {e}"))?;
    Client::connect(config, tcp.compat_write())
        .await
        .map_err(|e| format!("SQL Server 登录失败: {e}"))
}

/// 执行批处理并取第一个结果集（SQL 编辑器允许一次跑多条语句，只展示首个结果集）
async fn fetch_all(client: &mut SqlClient, sql: &str) -> Result<Vec<tiberius::Row>, String> {
    client
        .simple_query(sql)
        .await
        .map_err(|e| format!("查询失败: {e}"))?
        .into_first_result()
        .await
        .map_err(|e| format!("查询失败: {e}"))
}

fn hex_text(bytes: &[u8]) -> String {
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("0x{hex}")
}

/// 按 chrono 类型读取日期时间列（需 tiberius 的 chrono 特性）
fn chrono_text<'a, T>(row: &'a tiberius::Row, i: usize) -> serde_json::Value
where
    T: tiberius::FromSql<'a> + std::fmt::Display,
{
    match row.try_get::<T, _>(i) {
        Ok(Some(v)) => serde_json::json!(v.to_string()),
        _ => serde_json::Value::Null,
    }
}

/// 单元格解码：直接看 TDS 返回的列数据，避免按类型逐个试探
fn cell(row: &tiberius::Row, i: usize) -> serde_json::Value {
    let data = match row.get_column_data(i) {
        Ok(d) => d,
        Err(_) => return serde_json::Value::Null,
    };
    match data {
        ColumnData::U8(Some(v)) => serde_json::json!(*v),
        ColumnData::I16(Some(v)) => serde_json::json!(*v),
        ColumnData::I32(Some(v)) => serde_json::json!(*v),
        ColumnData::I64(Some(v)) => serde_json::json!(*v),
        ColumnData::F32(Some(v)) => serde_json::json!(*v),
        ColumnData::F64(Some(v)) => serde_json::json!(*v),
        ColumnData::Bit(Some(v)) => serde_json::json!(*v),
        ColumnData::String(Some(v)) => serde_json::json!(v.as_ref()),
        ColumnData::Guid(Some(v)) => serde_json::json!(v.to_string()),
        ColumnData::Binary(Some(v)) => serde_json::json!(hex_text(v.as_ref())),
        ColumnData::Numeric(Some(v)) => serde_json::json!(v.to_string()),
        ColumnData::Xml(Some(v)) => {
            let xml: &str = v.as_ref().as_ref();
            serde_json::json!(xml)
        }
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => {
            chrono_text::<chrono::NaiveDateTime>(row, i)
        }
        ColumnData::Date(_) => chrono_text::<chrono::NaiveDate>(row, i),
        ColumnData::Time(_) => chrono_text::<chrono::NaiveTime>(row, i),
        ColumnData::DateTimeOffset(_) => {
            chrono_text::<chrono::DateTime<chrono::FixedOffset>>(row, i)
        }
        _ => serde_json::Value::Null,
    }
}

/// 元数据列读成字符串
fn text(row: &tiberius::Row, i: usize) -> String {
    match cell(row, i) {
        serde_json::Value::String(s) => s,
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// SQL 字符串字面量（标识符用 OBJECT_ID 解析，这里只用于少量固定查询）
fn lit(s: &str) -> String {
    format!("N'{}'", s.replace('\'', "''"))
}

pub async fn test(c: &Connection) -> Result<String, String> {
    let mut client = connect(c, "").await?;
    client
        .simple_query("SELECT 1")
        .await
        .map_err(|e| format!("测试查询失败: {e}"))?
        .into_first_result()
        .await
        .map_err(|e| format!("测试查询失败: {e}"))?;
    Ok("连接成功".into())
}

pub async fn list_databases(c: &Connection) -> Result<Vec<String>, String> {
    let mut client = connect(c, "").await?;
    // 排除 master / model / msdb / tempdb 四个系统库，只列在线且当前登录可访问的库
    let rows = fetch_all(
        &mut client,
        "SELECT name FROM sys.databases \
         WHERE state = 0 AND database_id > 4 AND HAS_DBACCESS(name) = 1 ORDER BY name",
    )
    .await?;
    Ok(rows
        .iter()
        .map(|r| text(r, 0))
        .filter(|s| !s.is_empty())
        .collect())
}

pub async fn list_tables(c: &Connection, database: &str) -> Result<Vec<TableInfo>, String> {
    let mut client = connect(c, database).await?;
    // type: U = 用户表, V = 视图；非 dbo 的表带 schema 前缀，便于后续限定查询
    let rows = fetch_all(
        &mut client,
        "SELECT s.name AS schema_name, o.name AS object_name, \
         CASE o.type WHEN 'V' THEN 'view' ELSE 'table' END AS object_type \
         FROM sys.objects o INNER JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 \
         ORDER BY s.name, o.name",
    )
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let schema = text(r, 0);
            let name = text(r, 1);
            TableInfo {
                name: if schema.eq_ignore_ascii_case(DEFAULT_SCHEMA) {
                    name
                } else {
                    format!("{schema}.{name}")
                },
                table_type: text(r, 2),
            }
        })
        .filter(|t| !t.name.is_empty())
        .collect())
}

pub async fn list_columns(
    c: &Connection,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    if table.trim().is_empty() {
        return Err("未指定表".into());
    }
    let mut client = connect(c, database).await?;
    // 表级节点名可能是 schema.table，统一交给 OBJECT_ID 解析，避免手拼标识符
    let sql = format!(
        "SELECT c.name AS column_name, \
         CASE \
           WHEN t.name IN ('nchar', 'nvarchar') THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CONVERT(varchar(10), c.max_length / 2) END + ')' \
           WHEN t.name IN ('char', 'varchar', 'binary', 'varbinary') THEN t.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CONVERT(varchar(10), c.max_length) END + ')' \
           WHEN t.name IN ('decimal', 'numeric') THEN t.name + '(' + CONVERT(varchar(10), c.precision) + ',' + CONVERT(varchar(10), c.scale) + ')' \
           WHEN t.name IN ('datetime2', 'datetimeoffset', 'time') THEN t.name + '(' + CONVERT(varchar(10), c.scale) + ')' \
           ELSE t.name \
         END AS data_type, \
         CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS is_nullable, \
         CASE WHEN pk.column_id IS NOT NULL THEN 'PRI' ELSE '' END AS column_key, \
         ISNULL(CONVERT(nvarchar(4000), ep.value), '') AS column_comment \
         FROM sys.columns c \
         INNER JOIN sys.types t ON t.user_type_id = c.user_type_id \
         LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.name = 'MS_Description' \
           AND ep.major_id = c.object_id AND ep.minor_id = c.column_id \
         LEFT JOIN ( \
           SELECT ic.object_id, ic.column_id FROM sys.index_columns ic \
           INNER JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id \
           WHERE i.is_primary_key = 1 \
         ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id \
         WHERE c.object_id = OBJECT_ID({}) \
         ORDER BY c.column_id",
        lit(table)
    );
    let rows = fetch_all(&mut client, &sql).await?;
    Ok(rows
        .iter()
        .map(|r| ColumnInfo {
            name: text(r, 0),
            data_type: text(r, 1),
            nullable: text(r, 2).eq_ignore_ascii_case("YES"),
            key: text(r, 3),
            comment: text(r, 4),
        })
        .collect())
}

pub async fn query(
    c: &Connection,
    database: &str,
    sql: &str,
    limit: usize,
) -> Result<QueryResult, String> {
    let mut client = connect(c, database).await?;
    let start = Instant::now();
    let rows = fetch_all(&mut client, sql).await?;
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
