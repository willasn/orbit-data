pub mod clickhouse;
pub mod elasticsearch;
pub mod kafka;
pub mod mqtt;
pub mod mssql;
pub mod mysql;
pub mod oss;
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

/// 结果集单元格编辑：列名 + 新值
#[derive(Serialize, Deserialize, Clone)]
pub struct GridCell {
    pub column: String,
    pub value: serde_json::Value,
}

/// 单行修改：keys 为主键定位条件（取原始值），values 为变更列
#[derive(Serialize, Deserialize, Clone)]
pub struct RowUpdate {
    pub keys: Vec<GridCell>,
    pub values: Vec<GridCell>,
}

/// 标识符引用风格（与前端 drivers.ts 的 quote 保持一致）
#[derive(Clone, Copy)]
pub enum Quote {
    Backtick,
    Double,
    Bracket,
}

pub fn quote_ident(quote: Quote, name: &str) -> String {
    match quote {
        Quote::Backtick => format!("`{}`", name.replace('`', "``")),
        Quote::Double => format!("\"{}\"", name.replace('"', "\"\"")),
        Quote::Bracket => name
            .split('.')
            .map(|part| format!("[{}]", part.replace(']', "]]")))
            .collect::<Vec<_>>()
            .join("."),
    }
}

/// SQL 字面量：NULL / 数字 / 字符串。`backslash` 为真时按 MySQL、ClickHouse 规则转义反斜杠。
fn sql_literal(value: &serde_json::Value, backslash: bool) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => if *b { "1" } else { "0" }.to_string(),
        serde_json::Value::String(s) => {
            let escaped = if backslash {
                s.replace('\\', "\\\\").replace('\'', "''")
            } else {
                s.replace('\'', "''")
            };
            format!("'{escaped}'")
        }
        other => sql_literal(&serde_json::Value::String(other.to_string()), backslash),
    }
}

/// 限定表名：表已带 schema / 库前缀时逐段引用，否则按当前库补全
pub fn qualified_name(quote: Quote, database: &str, table: &str) -> String {
    let parts: Vec<&str> = table.split('.').filter(|p| !p.trim().is_empty()).collect();
    if parts.len() >= 2 {
        return parts
            .iter()
            .map(|part| quote_ident(quote, part.trim()))
            .collect::<Vec<_>>()
            .join(".");
    }
    if database.is_empty() {
        quote_ident(quote, table.trim())
    } else {
        format!(
            "{}.{}",
            quote_ident(quote, database),
            quote_ident(quote, table.trim())
        )
    }
}

/// 生成单行修改语句。
/// - 关系型：`assign` 传 "SET"，得到 `UPDATE 表 SET … WHERE …`
/// - ClickHouse：`assign` 传 "UPDATE"，得到 `ALTER TABLE 表 UPDATE … WHERE …`（SETTINGS 由调用方追加）
pub fn update_statement(
    prefix: &str,
    target: &str,
    assign: &str,
    row: &RowUpdate,
    quote: Quote,
    backslash: bool,
) -> Result<String, String> {
    if row.values.is_empty() {
        return Err("没有需要更新的列".into());
    }
    if row.keys.is_empty() {
        return Err("缺少主键列，无法定位要修改的行".into());
    }
    let sets = row
        .values
        .iter()
        .map(|cell| {
            format!(
                "{} = {}",
                quote_ident(quote, &cell.column),
                sql_literal(&cell.value, backslash)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let conditions = row
        .keys
        .iter()
        .map(|cell| {
            let ident = quote_ident(quote, &cell.column);
            if cell.value.is_null() {
                format!("{ident} IS NULL")
            } else {
                format!("{ident} = {}", sql_literal(&cell.value, backslash))
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    Ok(format!("{prefix} {target} {assign} {sets} WHERE {conditions}"))
}

pub async fn update_rows(
    c: &Connection,
    database: &str,
    table: &str,
    rows: &[RowUpdate],
) -> Result<usize, String> {
    if table.trim().is_empty() {
        return Err("未指定要更新的表".into());
    }
    if rows.is_empty() {
        return Ok(0);
    }
    match c.db_type.as_str() {
        "mysql" => mysql::update_rows(c, database, table, rows).await,
        "postgres" => pg::update_rows(c, database, table, rows).await,
        "sqlserver" => mssql::update_rows(c, database, table, rows).await,
        "clickhouse" => clickhouse::update_rows(c, database, table, rows).await,
        other => Err(format!("{other} 不支持在结果集内直接提交修改")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row() -> RowUpdate {
        RowUpdate {
            keys: vec![GridCell {
                column: "id".into(),
                value: json!("6"),
            }],
            values: vec![GridCell {
                column: "hi".into(),
                value: json!("422"),
            }],
        }
    }

    #[test]
    fn builds_update_for_relationals() {
        let sql = update_statement("UPDATE", "`test`.`hi`", "SET", &row(), Quote::Backtick, true)
            .unwrap();
        assert_eq!(sql, "UPDATE `test`.`hi` SET `hi` = '422' WHERE `id` = '6'");
    }

    #[test]
    fn builds_alter_update_for_clickhouse() {
        // ClickHouse 的语法是 ALTER TABLE … UPDATE …，不能写 SET
        let sql = update_statement("ALTER TABLE", "`test`.`hi`", "UPDATE", &row(), Quote::Backtick, true)
            .unwrap();
        assert_eq!(
            sql,
            "ALTER TABLE `test`.`hi` UPDATE `hi` = '422' WHERE `id` = '6'"
        );
    }

    #[test]
    fn escapes_literals_and_handles_null_keys() {
        let mut r = row();
        r.values = vec![GridCell {
            column: "hi".into(),
            value: json!("a'b\\c"),
        }];
        r.keys = vec![GridCell {
            column: "id".into(),
            value: serde_json::Value::Null,
        }];
        let sql = update_statement("UPDATE", "t", "SET", &r, Quote::Double, false).unwrap();
        assert_eq!(sql, "UPDATE t SET \"hi\" = 'a''b\\c' WHERE \"id\" IS NULL");
    }

    #[test]
    fn qualifies_names_by_database_and_schema() {
        assert_eq!(
            qualified_name(Quote::Backtick, "test", "hi"),
            "`test`.`hi`"
        );
        assert_eq!(qualified_name(Quote::Bracket, "", "sales.Orders"), "[sales].[Orders]");
    }
}

pub async fn test_connection(c: &Connection) -> Result<String, String> {
    const TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    tokio::time::timeout(TEST_TIMEOUT, async {
        match c.db_type.as_str() {
            "mysql" => mysql::test(c).await,
            "postgres" => pg::test(c).await,
            "sqlserver" => mssql::test(c).await,
            "clickhouse" => clickhouse::test(c).await,
            "redis" => redis::test(c).await,
            "elasticsearch" => elasticsearch::test(c).await,
            "kafka" => kafka::test(c).await,
            "mqtt" => mqtt::test(c).await,
            "aliyun_oss" => oss::test(c).await,
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
        "clickhouse" => clickhouse::list_databases(c).await,
        "redis" => Ok(vec!["db0".to_string()]),
        "elasticsearch" | "kafka" | "mqtt" => Ok(vec![]),
        "aliyun_oss" => {
            let mut buckets = oss::list_bucket_names(c).await?;
            buckets.sort();
            Ok(buckets)
        }
        other => Err(format!("不支持的数据库类型: {other}")),
    }
}

pub async fn list_tables(c: &Connection, database: &str) -> Result<Vec<TableInfo>, String> {
    match c.db_type.as_str() {
        "mysql" => mysql::list_tables(c, database).await,
        "postgres" => pg::list_tables(c, database).await,
        "sqlserver" => mssql::list_tables(c, database).await,
        "clickhouse" => clickhouse::list_tables(c, database).await,
        "redis" => redis::list_tables(c).await,
        "elasticsearch" => elasticsearch::list_tables(c).await,
        "kafka" => kafka::tables(c).await,
        "mqtt" => Ok(vec![]),
        "aliyun_oss" => Ok(vec![]),
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
        "clickhouse" => clickhouse::list_columns(c, database, table).await,
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
        "clickhouse" => clickhouse::query(c, database, sql, limit).await,
        "elasticsearch" => elasticsearch::query(c, database, sql, limit).await,
        "redis" => Err("Redis 请在对话或命令面板中使用 Redis 命令".into()),
        "kafka" => Err("Kafka 请使用消息工作区，不支持 SQL 执行".into()),
        "mqtt" => Err("MQTT 请使用消息工作区，不支持 SQL 执行".into()),
        "aliyun_oss" => Err("对象存储请使用 OSS 工作区，不支持 SQL 执行".into()),
        other => Err(format!("不支持的数据库类型: {other}")),
    }
}
