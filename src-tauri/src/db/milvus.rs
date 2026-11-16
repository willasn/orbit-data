use super::{ColumnInfo, QueryResult, TableInfo};
use crate::config::Connection;
use reqwest::{Client, Url};
use serde_json::{json, Map, Value};
use std::time::{Duration, Instant};

const PREFIX: &str = "/v2/vectordb/";

fn supported(operation: &str) -> bool {
    matches!(operation,
        "databases/list" | "databases/create" | "databases/describe" | "databases/drop"
        | "collections/list" | "collections/create" | "collections/describe"
        | "collections/drop" | "collections/get_stats" | "collections/get_load_state"
        | "collections/load" | "collections/release" | "collections/rename"
        | "entities/query" | "entities/search" | "entities/hybrid_search" | "entities/get" | "entities/insert"
        | "entities/upsert" | "entities/delete" | "indexes/list" | "indexes/create"
        | "indexes/describe" | "indexes/drop" | "partitions/list" | "partitions/create"
        | "partitions/drop" | "partitions/has" | "partitions/load" | "partitions/release"
        | "partitions/get_stats")
}

fn base_url(c: &Connection) -> Result<Url, String> {
    let host = c.host.trim();
    // 在 URL 解析消除路径语法之前拒绝路径，避免将主机之外的内容带入请求。
    let authority = host.split_once("://").map(|(_, rest)| rest).unwrap_or(host);
    if authority.is_empty() || authority.contains(['/', '?', '#', '@', '\\'])
        || authority.chars().any(char::is_whitespace) || authority.chars().any(char::is_control)
    {
        return Err("Milvus 主机不允许凭据、路径或查询参数".into());
    }
    let address = if host.contains("://") {
        host.to_owned()
    } else {
        format!("{}://{host}", if c.tls == Some(true) { "https" } else { "http" })
    };
    let mut url = Url::parse(&address).map_err(|_| "Milvus 主机地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some()
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some()
    {
        return Err("Milvus 主机地址无效，不允许凭据、路径或查询参数".into());
    }
    let port = if c.port == 0 { url.port().unwrap_or(19530) } else { c.port };
    url.set_port(Some(port))
        .map_err(|_| "Milvus 端口无效".to_string())?;
    Ok(url)
}

async fn request(c: &Connection, operation: &str, body: Value) -> Result<Value, String> {
    if !supported(operation) {
        return Err("不支持的 Milvus REST v2 操作".into());
    }
    let mut url = base_url(c)?;
    url.set_path(&format!("{PREFIX}{operation}"));
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .danger_accept_invalid_certs(c.tls_skip_verify)
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "无法创建 Milvus HTTP 客户端".to_string())?;
    let mut req = client.post(url).json(&body);
    if matches!(operation, "entities/query" | "entities/search" | "entities/hybrid_search" | "entities/get") {
        // 保留整数精度，交给结果转换层将超出 JavaScript 安全范围的值转成字符串。
        req = req.header("Accept-Type-Allow-Int64", "true");
    }
    if !c.username.is_empty() {
        req = req.bearer_auth(format!("{}:{}", c.username, c.password));
    } else if !c.password.is_empty() {
        req = req.bearer_auth(&c.password);
    }
    let response = req.send().await.map_err(|error| {
        if error.is_timeout() { "Milvus 请求超时".to_string() }
        else if error.is_connect() { "无法连接 Milvus，请检查地址、端口和 TLS 配置".to_string() }
        else { "Milvus HTTP 请求失败".to_string() }
    })?;
    if !response.status().is_success() {
        return Err(format!("Milvus 请求失败（HTTP {}），请检查权限和请求格式", response.status().as_u16()));
    }
    let value: Value = response.json().await.map_err(|_| "Milvus 返回的内容不是有效 JSON".to_string())?;
    let code = value.get("code").and_then(Value::as_i64)
        .ok_or("Milvus 响应缺少有效业务状态码")?;
    if code != 0 {
        return Err(format!("Milvus 操作失败（业务码 {code}），请检查权限、对象名称与请求参数"));
    }
    Ok(value)
}

fn database_name<'a>(c: &'a Connection, database: &'a str) -> &'a str {
    if !database.trim().is_empty() { database.trim() }
    else if !c.database.trim().is_empty() { c.database.trim() }
    else { "default" }
}

fn names(value: &Value) -> Result<Vec<String>, String> {
    let entries = value.get("data").and_then(Value::as_array)
        .ok_or("Milvus 列表响应格式无效")?;
    entries.iter().map(|entry| entry.as_str().map(str::to_owned)
        .ok_or_else(|| "Milvus 列表条目格式无效".to_string())).collect()
}

pub async fn test(c: &Connection) -> Result<String, String> {
    list_databases(c).await?;
    Ok("Milvus REST v2 连接成功".into())
}

pub async fn list_databases(c: &Connection) -> Result<Vec<String>, String> {
    names(&request(c, "databases/list", json!({})).await?)
}

pub async fn list_tables(c: &Connection, database: &str) -> Result<Vec<TableInfo>, String> {
    let value = request(c, "collections/list", json!({"dbName": database_name(c, database)})).await?;
    Ok(names(&value)?.into_iter().map(|name| TableInfo {
        name, table_type: "collection".into(),
    }).collect())
}

pub async fn list_columns(c: &Connection, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let value = request(c, "collections/describe", json!({
        "dbName": database_name(c, database), "collectionName": table,
    })).await?;
    let fields = value.pointer("/data/fields").and_then(Value::as_array)
        .ok_or("Milvus 集合字段响应格式无效")?;
    fields.iter().map(|field| {
        let name = field.get("name").or_else(|| field.get("fieldName"))
            .and_then(Value::as_str).ok_or("Milvus 字段缺少名称")?;
        let mut data_type = field.get("type").or_else(|| field.get("dataType"))
            .map(|v| v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()))
            .unwrap_or_else(|| "unknown".into());
        let dim = field.pointer("/params/dim")
            .or_else(|| field.pointer("/elementTypeParams/dim"))
            .or_else(|| field.get("dim"))
            .or_else(|| field.pointer("/typeParams/dim"))
            .or_else(|| ["params", "elementTypeParams", "typeParams"].iter().find_map(|key| {
                field.get(*key).and_then(Value::as_array)
                    .and_then(|params| params.iter().find(|p| p["key"] == "dim"))
                    .and_then(|param| param.get("value"))
            }));
        if let Some(dim) = dim {
            data_type.push_str(&format!("(dim={})", dim.as_str().map(str::to_owned).unwrap_or_else(|| dim.to_string())));
        }
        Ok(ColumnInfo {
            name: name.to_owned(), data_type,
            nullable: field.get("nullable").and_then(Value::as_bool).unwrap_or(false),
            key: if field.get("primaryKey").or_else(|| field.get("isPrimary"))
                .and_then(Value::as_bool).unwrap_or(false) { "PRI".into() } else { String::new() },
            comment: field.get("description").and_then(Value::as_str).unwrap_or("").to_owned(),
        })
    }).collect()
}

fn parse_query(c: &Connection, database: &str, text: &str, limit: usize) -> Result<(String, Value), String> {
    let text = text.trim();
    let (operation, mut body) = if text.starts_with('{') {
        let mut body: Value = serde_json::from_str(text).map_err(|_| "Milvus 请求 JSON 格式错误".to_string())?;
        let operation = body.as_object_mut().and_then(|object| object.remove("operation"))
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or("Milvus JSON 请求必须包含字符串 operation，例如 entities/query")?;
        (operation, body)
    } else {
        let split = text.find('{').unwrap_or(text.len());
        let parts: Vec<_> = text[..split].split_whitespace().collect();
        if parts.len() != 2 || !parts[0].eq_ignore_ascii_case("POST") {
            return Err("Milvus 请求格式：POST /v2/vectordb/操作 + JSON，或包含 operation 的 JSON 对象".into());
        }
        let operation = parts[1].strip_prefix(PREFIX).ok_or("Milvus 请求路径必须以 /v2/vectordb/ 开头")?;
        let body = if split == text.len() { json!({}) } else {
            serde_json::from_str(&text[split..]).map_err(|_| "Milvus 请求 JSON 格式错误".to_string())?
        };
        (operation.to_owned(), body)
    };
    if !supported(&operation) { return Err("不支持的 Milvus REST v2 操作".into()); }
    let object = body.as_object_mut().ok_or("Milvus 请求体必须是 JSON 对象")?;
    if operation == "databases/list" {
        if object.contains_key("dbName") {
            return Err("databases/list 不接受 dbName".into());
        }
    } else {
        if let Some(name) = object.get("dbName") {
            if name.as_str().is_none_or(|name| name.trim().is_empty()) {
                return Err("dbName 必须是非空字符串".into());
            }
        } else if matches!(operation.as_str(), "databases/create" | "databases/drop") {
            return Err("创建或删除数据库必须显式填写 dbName".into());
        } else {
            object.insert("dbName".into(), json!(database_name(c, database)));
        }
    }
    if matches!(operation.as_str(), "entities/query" | "entities/search" | "entities/hybrid_search") {
        let cap = limit.clamp(1, 1000) as u64;
        let requested = match object.get("limit") {
            Some(value) => value.as_u64().filter(|n| *n > 0).ok_or("limit 必须是正整数")?,
            None => cap,
        };
        object.insert("limit".into(), json!(requested.min(cap)));
        if operation == "entities/hybrid_search" {
            if let Some(searches) = object.get_mut("search") {
                let searches = searches.as_array_mut().ok_or("hybrid_search 的 search 必须是数组")?;
                for search in searches {
                    let search = search.as_object_mut().ok_or("hybrid_search 的子查询必须是 JSON 对象")?;
                    let requested = match search.get("limit") {
                        Some(value) => value.as_u64().filter(|n| *n > 0).ok_or("子查询 limit 必须是正整数")?,
                        None => cap,
                    };
                    search.insert("limit".into(), json!(requested.min(cap)));
                }
            }
        }
        if operation == "entities/query" {
            let offset = match object.get("offset") {
                Some(value) => value.as_u64().ok_or("offset 必须是非负整数")?,
                None => 0,
            };
            if offset.checked_add(requested.min(cap)).is_none_or(|end| end > 16384) {
                return Err("Milvus query 的 offset + limit 不能超过 16384".into());
            }
        }
    }
    Ok((operation, body))
}

fn cell(value: &Value) -> Value {
    match value {
        Value::Number(number) => {
            let unsafe_integer = number.as_i64().is_some_and(|n| n.unsigned_abs() > 9_007_199_254_740_991)
                || number.as_u64().is_some_and(|n| n > 9_007_199_254_740_991);
            if unsafe_integer { Value::String(number.to_string()) } else { value.clone() }
        }
        Value::Array(_) | Value::Object(_) | Value::Bool(_) => Value::String(value.to_string()),
        _ => value.clone(),
    }
}

fn append_rows(value: &Value, group: Option<usize>, rows: &mut Vec<Map<String, Value>>, cap: usize) {
    if rows.len() >= cap { return; }
    if let Some(array) = value.as_array() {
        for (index, entry) in array.iter().enumerate() {
            append_rows(entry, if entry.is_array() { Some(index) } else { group }, rows, cap);
            if rows.len() >= cap { break; }
        }
    } else {
        let mut row = value.as_object().cloned().unwrap_or_else(|| {
            let mut row = Map::new();
            row.insert("value".into(), value.clone());
            row
        });
        if let Some(group) = group { row.insert("_query_index".into(), json!(group)); }
        rows.push(row);
    }
}

pub async fn query(c: &Connection, database: &str, text: &str, limit: usize) -> Result<QueryResult, String> {
    let start = Instant::now();
    let (operation, body) = parse_query(c, database, text, limit)?;
    let value = request(c, &operation, body).await?;
    let mut objects = Vec::new();
    let cap = limit.clamp(1, 1000);
    if let Some(data) = value.get("data").filter(|data| data.is_array()) {
        append_rows(data, None, &mut objects, cap);
    } else {
        let mut row = Map::new();
        row.insert("response".into(), value);
        objects.push(row);
    }
    let mut result = QueryResult { duration_ms: start.elapsed().as_millis() as u64, ..Default::default() };
    for object in &objects {
        for key in object.keys() {
            if !result.columns.contains(key) { result.columns.push(key.clone()); }
        }
    }
    result.rows = objects.iter().map(|object| result.columns.iter()
        .map(|key| cell(object.get(key).unwrap_or(&Value::Null))).collect()).collect();
    result.row_count = result.rows.len();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn_from_env() -> Option<Connection> {
        let host = std::env::var("ORBIT_MILVUS_TEST_HOST").ok()?;
        Some(Connection {
            id: "milvus-live-test".into(),
            name: "Milvus 测试".into(),
            db_type: "milvus".into(),
            host,
            port: std::env::var("ORBIT_MILVUS_TEST_PORT")
                .ok().and_then(|p| p.parse().ok()).unwrap_or(19530),
            username: std::env::var("ORBIT_MILVUS_TEST_USERNAME").unwrap_or_default(),
            password: std::env::var("ORBIT_MILVUS_TEST_PASSWORD").unwrap_or_default(),
            database: std::env::var("ORBIT_MILVUS_TEST_DATABASE").unwrap_or_else(|_| "default".into()),
            tls: Some(std::env::var("ORBIT_MILVUS_TEST_TLS").map(|v| v == "1").unwrap_or(false)),
            tls_skip_verify: std::env::var("ORBIT_MILVUS_TEST_SKIP_VERIFY")
                .map(|v| v == "1").unwrap_or(false),
            ..Default::default()
        })
    }

    fn sample_vector(seed: f32) -> Vec<f32> {
        (0..8).map(|i| (seed + i as f32 * 0.1).sin()).collect()
    }

    #[test]
    fn base_url_uses_tls_scheme_and_port() {
        let mut c = Connection { host: "127.0.0.1".into(), port: 19530, tls: Some(true), ..Default::default() };
        assert_eq!(base_url(&c).unwrap().as_str(), "https://127.0.0.1:19530/");
        c.tls = Some(false);
        assert_eq!(base_url(&c).unwrap().as_str(), "http://127.0.0.1:19530/");
        c.host = "http://example.com/path".into();
        assert!(base_url(&c).is_err());
        c.host = "user@example.com".into();
        assert!(base_url(&c).is_err());
    }

    #[test]
    fn parse_query_accepts_both_forms_and_caps_limit() {
        let c = Connection::default();
        let (op, body) = parse_query(&c, "", "{\"operation\":\"entities/query\",\"collectionName\":\"a\",\"limit\":5000}", 100).unwrap();
        assert_eq!(op, "entities/query");
        assert_eq!(body["limit"], 100);
        assert_eq!(body["dbName"], "default");
        let (op, body) = parse_query(&c, "db1", "POST /v2/vectordb/entities/search\n{\"collectionName\":\"a\"}", 10).unwrap();
        assert_eq!(op, "entities/search");
        assert_eq!(body["limit"], 10);
        assert_eq!(body["dbName"], "db1");
        assert!(parse_query(&c, "", "POST /v2/vectordb/users/list {}", 10).is_err());
        assert!(parse_query(&c, "", "GET /v2/vectordb/databases/list", 10).is_err());
        assert!(parse_query(&c, "", "{\"operation\":\"databases/list\",\"dbName\":\"x\"}", 10).is_err());
        assert!(parse_query(&c, "", "{\"operation\":\"entities/query\",\"collectionName\":\"a\",\"offset\":16380,\"limit\":10}", 100).is_err());
    }

    #[test]
    fn cell_protects_big_integers_and_flattens_containers() {
        assert!(cell(&json!(9_007_199_254_740_993_i64)).is_string());
        assert_eq!(cell(&json!(42)), json!(42));
        assert!(cell(&json!([1, 2])).is_string());
        assert!(cell(&json!({"a": 1})).is_string());
    }

    #[test]
    fn append_rows_tags_nested_query_groups() {
        let mut rows = Vec::new();
        append_rows(&json!([[{"id": 1}], [{"id": 2}]]), None, &mut rows, 10);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["_query_index"], 0);
        assert_eq!(rows[1]["_query_index"], 1);
    }

    #[tokio::test]
    async fn live_full_feature_flow() {
        let Some(c) = conn_from_env() else { return };
        const DB: &str = "orbitdata_test";
        const COLL: &str = "orbitdata_demo";
        const RENAMED: &str = "orbitdata_demo_tmp";

        // 1. 连接测试与库列表
        assert!(test(&c).await.unwrap().contains("成功"));
        assert!(list_databases(&c).await.unwrap().iter().any(|n| n == "default"));

        // 2. 创建测试库（已存在则忽略）
        let _ = request(&c, "databases/create", json!({ "dbName": DB })).await;
        assert!(list_databases(&c).await.unwrap().iter().any(|n| n == DB));
        request(&c, "databases/describe", json!({ "dbName": DB })).await.unwrap();

        // 3. 清理残留集合后按 Quick Setup 建集合（Int64 主键 + 8 维 COSINE 向量）
        for name in [COLL, RENAMED] {
            let _ = request(&c, "collections/drop", json!({ "dbName": DB, "collectionName": name })).await;
        }
        request(&c, "collections/create", json!({
            "dbName": DB, "collectionName": COLL, "dimension": 8, "metricType": "COSINE",
            "primaryFieldName": "id", "idType": "Int64", "autoID": false, "vectorFieldName": "vector",
        })).await.unwrap();
        assert!(list_tables(&c, DB).await.unwrap().iter().any(|t| t.name == COLL));

        // 4. 字段元数据：主键标记与向量维度
        let columns = list_columns(&c, DB, COLL).await.unwrap();
        let id = columns.iter().find(|f| f.name == "id").unwrap();
        let vector = columns.iter().find(|f| f.name == "vector").unwrap();
        assert_eq!(id.key, "PRI");
        assert!(vector.data_type.contains("dim=8"), "实际类型: {}", vector.data_type);

        // 5. 插入 3 行；查询 / 检索前必须先加载集合（轮询直到 Loaded）
        request(&c, "entities/insert", json!({
            "dbName": DB, "collectionName": COLL,
            "data": [
                { "id": 1, "vector": sample_vector(0.0) },
                { "id": 2, "vector": sample_vector(1.0) },
                { "id": 3, "vector": sample_vector(2.0) },
            ],
        })).await.unwrap();
        request(&c, "collections/load", json!({ "dbName": DB, "collectionName": COLL })).await.unwrap();
        let mut state = String::new();
        for _ in 0..30 {
            state = request(&c, "collections/get_load_state", json!({ "dbName": DB, "collectionName": COLL }))
                .await.unwrap().to_string();
            if state.contains("Loaded") { break; }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        assert!(state.contains("Loaded"), "加载状态: {state}");

        // 6. 预览（走控制台 query 入口）与按主键获取
        let preview = query(&c, DB, &format!(
            "POST /v2/vectordb/entities/query\n{{\"collectionName\":\"{COLL}\",\"filter\":\"id >= 1\",\"outputFields\":[\"*\"],\"limit\":10}}"), 100).await.unwrap();
        assert_eq!(preview.row_count, 3);
        assert!(preview.columns.iter().any(|col| col == "id"));
        assert!(preview.columns.iter().any(|col| col == "vector"));
        let got = request(&c, "entities/get", json!({
            "dbName": DB, "collectionName": COLL, "id": [1, 2], "outputFields": ["id"],
        })).await.unwrap();
        assert_eq!(got["data"].as_array().unwrap().len(), 2);

        // 7. Upsert 覆盖 id=1
        request(&c, "entities/upsert", json!({
            "dbName": DB, "collectionName": COLL,
            "data": [{ "id": 1, "vector": sample_vector(3.0) }],
        })).await.unwrap();

        // 8. 索引与分区元数据
        let indexes = request(&c, "indexes/list", json!({ "dbName": DB, "collectionName": COLL })).await.unwrap();
        assert!(indexes.to_string().contains("vector"), "索引列表: {indexes}");
        let partitions = request(&c, "partitions/list", json!({ "dbName": DB, "collectionName": COLL })).await.unwrap();
        assert!(partitions.to_string().contains("_default"), "分区列表: {partitions}");

        // 9. 向量检索与混合检索（删除前执行，避免删除可见性延迟影响命中数）
        let search = query(&c, DB, &format!(
            "{{\"operation\":\"entities/search\",\"collectionName\":\"{COLL}\",\"annsField\":\"vector\",\"data\":[{:?}],\"limit\":5,\"outputFields\":[\"id\"]}}",
            sample_vector(0.0)), 100).await.unwrap();
        assert_eq!(search.row_count, 3, "检索应命中全部 3 行");
        let hybrid = request(&c, "entities/hybrid_search", json!({
            "dbName": DB, "collectionName": COLL,
            "search": [{ "annsField": "vector", "data": [sample_vector(1.0)], "limit": 5 }],
            "rerank": { "strategy": "rrf" }, "limit": 5, "outputFields": ["id"],
        })).await.unwrap();
        assert!(!hybrid["data"].as_array().unwrap().is_empty());

        // 10. 按表达式删除 id=3，轮询直到可见（保留 2 行测试数据）
        request(&c, "entities/delete", json!({
            "dbName": DB, "collectionName": COLL, "filter": "id == 3",
        })).await.unwrap();
        let mut count = usize::MAX;
        for _ in 0..15 {
            count = query(&c, DB, &format!(
                "{{\"operation\":\"entities/query\",\"collectionName\":\"{COLL}\",\"filter\":\"id >= 1\",\"outputFields\":[\"id\"],\"limit\":10}}"), 100).await.unwrap().row_count;
            if count == 2 { break; }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        assert_eq!(count, 2, "删除后应剩 2 行");
        request(&c, "collections/get_stats", json!({ "dbName": DB, "collectionName": COLL })).await.unwrap();
        request(&c, "collections/rename", json!({
            "dbName": DB, "collectionName": COLL, "newCollectionName": RENAMED,
        })).await.unwrap();
        assert!(list_tables(&c, DB).await.unwrap().iter().any(|t| t.name == RENAMED));
        request(&c, "collections/rename", json!({
            "dbName": DB, "collectionName": RENAMED, "newCollectionName": COLL,
        })).await.unwrap();
        request(&c, "collections/release", json!({ "dbName": DB, "collectionName": COLL })).await.unwrap();
        request(&c, "collections/load", json!({ "dbName": DB, "collectionName": COLL })).await.unwrap();
        println!("Milvus 全流程测试通过：库 {DB} 与集合 {COLL}（2 行实体）已保留");
    }
}
