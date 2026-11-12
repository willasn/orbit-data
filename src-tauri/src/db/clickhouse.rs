use super::{ColumnInfo, QueryResult, TableInfo};
use crate::config::Connection;
use reqwest::{Client, StatusCode, Url};
use serde_json::Value;
use std::time::{Duration, Instant};

const META_TIMEOUT: Duration = Duration::from_secs(15);
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ERROR_CHARS: usize = 2000;

fn scheme(c: &Connection) -> &str {
    match c.clickhouse.as_ref().map(|v| v.scheme.trim()) {
        Some("https") => "https",
        _ => "http",
    }
}

fn base_url(c: &Connection) -> Result<Url, String> {
    let host = c.host.trim();
    if host.is_empty() {
        return Err("请填写 ClickHouse 主机地址".into());
    }
    if c.port == 9000 {
        return Err("9000 是 ClickHouse 原生 TCP 端口，HTTP 请使用 8123（HTTPS 常用 8443）".into());
    }
    let address = if host.contains("://") {
        host.to_owned()
    } else {
        format!("{}://{host}", scheme(c))
    };
    let mut url = Url::parse(&address).map_err(|_| "ClickHouse 主机地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "ClickHouse 主机仅接受主机名或 http(s)://主机，不允许凭据、路径或查询参数".into(),
        );
    }
    if c.port == 0 {
        return Err("请填写 ClickHouse HTTP 端口（默认 8123）".into());
    }
    url.set_port(Some(c.port))
        .map_err(|_| "ClickHouse 端口无效".to_string())?;
    Ok(url)
}

fn effective_db(c: &Connection, database: &str) -> String {
    if database.trim().is_empty() {
        c.database.clone()
    } else {
        database.to_owned()
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out
}

/// 通过 HTTP 接口执行一条 SQL；SQL 放在请求体，避免出现在 URL 与访问日志中。
async fn request(
    c: &Connection,
    database: &str,
    sql: &str,
    params: &[(&str, String)],
    timeout: Duration,
) -> Result<String, String> {
    let base = base_url(c)?;
    let client = Client::builder()
        .timeout(timeout)
        // 自签证书或证书未包含当前访问 IP / 域名时，可通过连接配置跳过校验
        .danger_accept_invalid_certs(c.tls_skip_verify)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建 ClickHouse HTTP 客户端".to_string())?;

    let mut query: Vec<(&str, String)> = vec![("default_format", "JSON".into())];
    if !database.trim().is_empty() {
        query.push(("database", database.trim().to_owned()));
    }
    for (key, value) in params {
        query.push((*key, value.clone()));
    }

    let mut req = client.post(base).query(&query).body(sql.to_owned());
    if !c.username.trim().is_empty() {
        req = req
            .header("X-ClickHouse-User", c.username.trim())
            .header("X-ClickHouse-Key", &c.password);
    }

    let response = req.send().await.map_err(|e| {
        if e.is_timeout() {
            "ClickHouse 请求超时，请检查网络或缩小查询范围".to_string()
        } else if e.is_connect() {
            "无法连接 ClickHouse，请检查主机与 HTTP 端口（默认 8123）".to_string()
        } else {
            "ClickHouse HTTP 请求失败".to_string()
        }
    })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err("ClickHouse 认证失败，请检查用户名与密码".into());
        }
        let detail = body.trim();
        if detail.is_empty() {
            return Err(format!("ClickHouse 请求失败（HTTP {}）", status.as_u16()));
        }
        return Err(format!(
            "ClickHouse 返回错误（HTTP {}）：{}",
            status.as_u16(),
            truncate(detail, MAX_ERROR_CHARS)
        ));
    }
    Ok(body)
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(v) => v.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 去掉 Nullable(...) / LowCardinality(...) 外层，便于按基础类型处理
fn base_type(data_type: &str) -> &str {
    let text = data_type.trim();
    for prefix in ["Nullable(", "LowCardinality("] {
        if text.starts_with(prefix) && text.ends_with(')') {
            return base_type(&text[prefix.len()..text.len() - 1]);
        }
    }
    text
}

/// 单元格序列化：64 位及以上整数转字符串，避免前端 JS 精度丢失；
/// Array / Map / Tuple 等复合类型转文本，避免表格列宽失控。
fn cell(value: &Value, data_type: Option<&str>) -> Value {
    if let Some(data_type) = data_type {
        if matches!(
            base_type(data_type),
            "UInt64" | "Int64" | "UInt128" | "Int128" | "UInt256" | "Int256"
        ) {
            if let Value::Number(number) = value {
                return Value::String(number.to_string());
            }
        }
    }
    match value {
        Value::Null | Value::String(_) | Value::Number(_) | Value::Bool(_) => value.clone(),
        other => Value::String(other.to_string()),
    }
}

struct ParsedResult {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

fn row_values(row: &Value, columns: &[String], types: &[String]) -> Vec<Value> {
    // 老版本返回数组行；新版本（如 26.x）默认返回以列名为 key 的对象行
    if let Some(values) = row.as_array() {
        return values
            .iter()
            .enumerate()
            .map(|(i, value)| cell(value, types.get(i).map(String::as_str)))
            .collect();
    }
    if let Some(object) = row.as_object() {
        return columns
            .iter()
            .enumerate()
            .map(|(i, name)| {
                object
                    .get(name)
                    .map(|value| cell(value, types.get(i).map(String::as_str)))
                    .unwrap_or(Value::Null)
            })
            .collect();
    }
    Vec::new()
}

fn parse_json(body: &str) -> Option<ParsedResult> {
    let text = body.trim();
    if text.is_empty() {
        return Some(ParsedResult {
            columns: Vec::new(),
            rows: Vec::new(),
        });
    }
    let value: Value = serde_json::from_str(text).ok()?;
    let meta = value.get("meta")?.as_array()?;
    let columns: Vec<String> = meta
        .iter()
        .filter_map(|m| m.get("name").and_then(Value::as_str).map(str::to_owned))
        .collect();
    let types: Vec<String> = meta
        .iter()
        .map(|m| m.get("type").and_then(Value::as_str).unwrap_or("").to_owned())
        .collect();
    let rows = value
        .get("data")
        .and_then(Value::as_array)
        .map(|data| {
            data.iter()
                .map(|row| row_values(row, &columns, &types))
                .collect()
        })
        .unwrap_or_default();
    Some(ParsedResult { columns, rows })
}

/// 取 JSON 结果中的行（列名在 meta 中，这里只需要行）。
async fn fetch_rows(
    c: &Connection,
    database: &str,
    sql: &str,
    params: &[(&str, String)],
) -> Result<Vec<Vec<Value>>, String> {
    let body = request(c, database, sql, params, META_TIMEOUT).await?;
    if body.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed = parse_json(&body).ok_or("ClickHouse 返回的元数据格式无效")?;
    Ok(parsed.rows)
}

pub async fn test(c: &Connection) -> Result<String, String> {
    let rows = fetch_rows(c, "", "SELECT version()", &[]).await?;
    let version = rows
        .first()
        .and_then(|row| row.first())
        .map(value_text)
        .unwrap_or_default();
    if version.is_empty() {
        return Ok("ClickHouse 连接成功".into());
    }
    Ok(format!("ClickHouse {version} 连接成功"))
}

pub async fn list_databases(c: &Connection) -> Result<Vec<String>, String> {
    let rows = fetch_rows(c, "", "SELECT name FROM system.databases ORDER BY name", &[]).await?;
    Ok(rows
        .iter()
        .filter_map(|row| row.first())
        .map(value_text)
        .filter(|name| !name.is_empty())
        .collect())
}

/// system.tables.engine → 前端表节点类型（view / mv / dictionary / table）
fn table_kind(engine: &str) -> &'static str {
    match engine {
        "View" => "view",
        "MaterializedView" => "mv",
        "Dictionary" => "dictionary",
        _ => "table",
    }
}

pub async fn list_tables(c: &Connection, database: &str) -> Result<Vec<TableInfo>, String> {
    let db = effective_db(c, database);
    let rows = fetch_rows(
        c,
        &db,
        "SELECT name, engine FROM system.tables WHERE database = {db:String} ORDER BY name",
        &[("param_db", db.clone())],
    )
    .await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = row.first().map(value_text).unwrap_or_default();
            if name.is_empty() {
                return None;
            }
            let engine = row.get(1).map(value_text).unwrap_or_default();
            Some(TableInfo {
                name,
                table_type: table_kind(&engine).to_string(),
            })
        })
        .collect())
}

pub async fn list_columns(
    c: &Connection,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let db = effective_db(c, database);
    let rows = fetch_rows(
        c,
        &db,
        "SELECT name, type, default_expression, comment, is_in_primary_key \
         FROM system.columns WHERE database = {db:String} AND table = {table:String} ORDER BY position",
        &[("param_db", db.clone()), ("param_table", table.to_owned())],
    )
    .await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = row.first().map(value_text).unwrap_or_default();
            if name.is_empty() {
                return None;
            }
            let data_type = row.get(1).map(value_text).unwrap_or_default();
            let default_expression = row.get(2).map(value_text).unwrap_or_default();
            let comment = row.get(3).map(value_text).unwrap_or_default();
            let primary = row.get(4).and_then(Value::as_u64).unwrap_or(0) == 1;
            let nullable = data_type.trim_start().starts_with("Nullable(");
            Some(ColumnInfo {
                name,
                data_type,
                nullable,
                key: if primary { "PRI".into() } else { String::new() },
                comment: if default_expression.is_empty() {
                    comment
                } else {
                    format!("{comment} 默认值: {default_expression}").trim().to_string()
                },
            })
        })
        .collect())
}

/// 解析 `FORMAT JSON` 输出；非 JSON（用户显式指定了其他 FORMAT）返回 None。
fn parse_json_result(body: &str, limit: usize) -> Option<QueryResult> {
    let parsed = parse_json(body)?;
    let mut result = QueryResult {
        columns: parsed.columns,
        ..Default::default()
    };
    result.rows = parsed.rows.into_iter().take(limit).collect();
    result.row_count = result.rows.len();
    Some(result)
}

fn query_result(body: &str, limit: usize, duration_ms: u64) -> QueryResult {
    match parse_json_result(body, limit) {
        Some(mut result) => {
            result.duration_ms = duration_ms;
            result
        }
        None => QueryResult {
            columns: vec!["response".into()],
            rows: vec![vec![Value::String(body.trim().to_owned())]],
            row_count: 1,
            duration_ms,
        },
    }
}

pub async fn query(
    c: &Connection,
    database: &str,
    sql: &str,
    limit: usize,
) -> Result<QueryResult, String> {
    let sql = sql.trim();
    if sql.is_empty() {
        return Err("请输入要执行的 SQL".into());
    }
    let db = effective_db(c, database);
    let started = Instant::now();
    let body = request(c, &db, sql, &[], QUERY_TIMEOUT).await?;
    Ok(query_result(&body, limit, started.elapsed().as_millis() as u64))
}

/// 结果集修改：ClickHouse 无 UPDATE，按主键生成 ALTER TABLE ... UPDATE 变更（同步等待 mutation 完成）
pub async fn update_rows(
    c: &Connection,
    database: &str,
    table: &str,
    rows: &[super::RowUpdate],
) -> Result<usize, String> {
    let db = effective_db(c, database);
    let target = super::qualified_name(super::Quote::Backtick, &db, table);
    let mut affected = 0usize;
    for row in rows {
        let sql = format!(
            "{} SETTINGS mutations_sync = 1",
            super::update_statement(
                "ALTER TABLE",
                &target,
                "UPDATE",
                row,
                super::Quote::Backtick,
                true
            )?
        );
        request(c, "", &sql, &[], QUERY_TIMEOUT).await?;
        affected += 1;
    }
    Ok(affected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn conn(port: u16, scheme: &str) -> Connection {
        Connection {
            db_type: "clickhouse".into(),
            host: "127.0.0.1".into(),
            port,
            clickhouse: Some(crate::config::ClickHouseConfig {
                scheme: scheme.into(),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn builds_http_url_and_rejects_native_port() {
        let url = base_url(&conn(8123, "http")).unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:8123/");
        let url = base_url(&conn(8443, "https")).unwrap();
        assert_eq!(url.as_str(), "https://127.0.0.1:8443/");
        assert!(base_url(&conn(9000, "http")).is_err());
    }

    #[test]
    fn rejects_host_with_credentials_or_path() {
        let mut c = conn(8123, "http");
        c.host = "http://user:pass@127.0.0.1".into();
        assert!(base_url(&c).is_err());
        c.host = "http://127.0.0.1/dashboard".into();
        assert!(base_url(&c).is_err());
    }

    #[test]
    fn maps_engines_to_node_types() {
        assert_eq!(table_kind("MergeTree"), "table");
        assert_eq!(table_kind("View"), "view");
        assert_eq!(table_kind("MaterializedView"), "mv");
        assert_eq!(table_kind("Dictionary"), "dictionary");
    }

    #[test]
    fn parses_json_result_and_truncates_rows() {
        let body = r#"{"meta":[{"name":"id","type":"UInt64"},{"name":"tags","type":"Array(String)"}],
            "data":[["1",["a","b"]],["2",[]]],"rows":2}"#;
        let result = parse_json_result(body, 1).unwrap();
        assert_eq!(result.columns, vec!["id", "tags"]);
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0][0], json!("1"));
        assert_eq!(result.rows[0][1], json!("[\"a\",\"b\"]"));
    }

    #[test]
    fn parses_object_rows_and_keeps_large_integers() {
        // ClickHouse 26.x 的 JSON 输出以列名为 key 返回对象行
        let body = r#"{"meta":[{"name":"big","type":"UInt64"},{"name":"arr","type":"Array(UInt8)"},{"name":"n","type":"Nullable(UInt8)"}],
            "data":[{"big":18446744073709551615,"arr":[1,2],"n":null}],"rows":1}"#;
        let result = parse_json_result(body, 500).unwrap();
        assert_eq!(result.columns, vec!["big", "arr", "n"]);
        assert_eq!(result.rows[0][0], json!("18446744073709551615"));
        assert_eq!(result.rows[0][1], json!("[1,2]"));
        assert!(result.rows[0][2].is_null());
    }

    #[test]
    fn strips_wrapper_types() {
        assert_eq!(base_type("Nullable(UInt64)"), "UInt64");
        assert_eq!(base_type("LowCardinality(Nullable(String))"), "String");
    }

    /// 临时联调：仅当设置了 CK_TEST_HOST 环境变量时执行，凭据只从环境变量读取
    #[tokio::test]
    async fn live_smoke() {
        let Ok(host) = std::env::var("CK_TEST_HOST") else { return };
        if host.is_empty() {
            return;
        }
        let c = Connection {
            db_type: "clickhouse".into(),
            host,
            port: std::env::var("CK_TEST_PORT").unwrap_or_default().parse().unwrap_or(8123),
            username: std::env::var("CK_TEST_USER").unwrap_or_default(),
            password: std::env::var("CK_TEST_PASS").unwrap_or_default(),
            database: "default".into(),
            clickhouse: Some(crate::config::ClickHouseConfig {
                scheme: "http".into(),
            }),
            ..Default::default()
        };
        println!("test: {}", test(&c).await.unwrap());
        let dbs = list_databases(&c).await.unwrap();
        println!("dbs: {dbs:?}");
        let tables = list_tables(&c, "system").await.unwrap();
        println!(
            "tables(system) first 3: {:?}",
            tables
                .iter()
                .take(3)
                .map(|t| format!("{}:{}", t.name, t.table_type))
                .collect::<Vec<_>>()
        );
        let cols = list_columns(&c, "system", "numbers").await.unwrap();
        println!(
            "cols(system.numbers) first: {:?}",
            cols.first().map(|c| format!(
                "{} {} nullable={} key={} comment={}",
                c.name, c.data_type, c.nullable, c.key, c.comment
            ))
        );
        let result = query(
            &c,
            "default",
            "SELECT 1 AS a, [1,2] AS arr, map('k',2) AS m, toUInt64(18446744073709551615) AS big",
            500,
        )
        .await
        .unwrap();
        println!("query columns: {:?}", result.columns);
        println!("query rows: {:?}", result.rows);
        query(
            &c,
            "default",
            "DROP TABLE IF EXISTS default.orbit_smoke",
            500,
        )
        .await
        .unwrap();
        query(
            &c,
            "default",
            "CREATE TABLE default.orbit_smoke (id UInt64, name Nullable(String) DEFAULT '') \
             ENGINE = MergeTree ORDER BY id",
            500,
        )
        .await
        .unwrap();
        query(&c, "default", "INSERT INTO default.orbit_smoke VALUES (1, 'a')", 500)
            .await
            .unwrap();
        let rows = query(&c, "default", "SELECT * FROM default.orbit_smoke ORDER BY id", 500)
            .await
            .unwrap();
        println!("smoke table rows: {:?}", rows.rows);
        query(&c, "default", "DROP TABLE default.orbit_smoke", 500)
            .await
            .unwrap();
        println!("LIVE_SMOKE_OK");
    }

    #[test]
    fn empty_body_is_empty_result_and_other_formats_fall_back() {
        let result = query_result("", 500, 3);
        assert!(result.columns.is_empty());
        assert_eq!(result.row_count, 0);
        assert_eq!(result.duration_ms, 3);

        let result = query_result("1\n2\n", 500, 5);
        assert_eq!(result.columns, vec!["response"]);
        assert_eq!(result.row_count, 1);
    }
}