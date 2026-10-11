use super::{ColumnInfo, QueryResult, TableInfo};
use crate::config::Connection;
use reqwest::{Client, Method, Url};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn base_url(c: &Connection) -> Result<Url, String> {
    let host = c.host.trim();
    let address = if host.contains("://") { host.to_owned() } else { format!("http://{host}") };
    let mut url = Url::parse(&address).map_err(|_| "ES 主机地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() || url.path() != "/"
    {
        return Err("ES 主机仅接受主机名或 http(s)://主机，不允许凭据、路径或查询参数".into());
    }
    url.set_port(Some(c.port)).map_err(|_| "ES 端口无效".to_string())?;
    Ok(url)
}

async fn request(c: &Connection, method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('#') || path.contains("://") {
        return Err("ES 请求路径必须是当前集群的相对路径，例如 /_cluster/health".into());
    }
    let base = base_url(c)?;
    let url = base.join(path).map_err(|_| "ES 请求路径无效".to_string())?;
    if url.origin() != base.origin() {
        return Err("不允许请求其他主机".into());
    }
    let client = Client::builder().timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none()).build()
        .map_err(|_| "无法创建 ES HTTP 客户端".to_string())?;
    let mut req = client.request(method, url);
    if !c.username.is_empty() {
        req = req.basic_auth(&c.username, Some(&c.password));
    }
    if let Some(body) = body { req = req.json(&body); }
    let response = req.send().await.map_err(|e| {
        if e.is_timeout() { "ES 请求超时".to_string() }
        else if e.is_connect() { "无法连接 ES，请检查地址、端口及 HTTPS 证书".to_string() }
        else { "ES HTTP 请求失败".to_string() }
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("ES 请求失败（HTTP {}），请检查权限、索引与请求格式", status.as_u16()));
    }
    response.json().await.map_err(|_| "ES 返回的内容不是有效 JSON".to_string())
}

pub async fn test(c: &Connection) -> Result<String, String> {
    let value = request(c, Method::GET, "/", None).await?;
    let version = value.pointer("/version/number").and_then(Value::as_str)
        .ok_or("服务未返回 Elasticsearch 版本信息")?;
    Ok(format!("Elasticsearch {version} 连接成功"))
}

pub async fn list_tables(c: &Connection) -> Result<Vec<TableInfo>, String> {
    let value = request(c, Method::GET, "/_cat/indices?format=json&h=index&s=index&expand_wildcards=open", None).await?;
    let entries = value.as_array().ok_or("ES 索引列表格式无效")?;
    Ok(entries.iter().filter_map(|v| v["index"].as_str()).map(|name| TableInfo {
        name: name.to_owned(), table_type: "index".into(),
    }).collect())
}

fn mapping_fields(properties: &Value, prefix: &str, out: &mut Vec<ColumnInfo>) {
    let Some(fields) = properties.as_object() else { return; };
    for (name, field) in fields {
        let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}.{name}") };
        out.push(ColumnInfo {
            name: path.clone(),
            data_type: field["type"].as_str().unwrap_or("object").to_owned(),
            nullable: true, key: String::new(), comment: field.to_string(),
        });
        mapping_fields(&field["properties"], &path, out);
        mapping_fields(&field["fields"], &path, out);
    }
}

pub async fn list_columns(c: &Connection, index: &str) -> Result<Vec<ColumnInfo>, String> {
    let path = format!("/{}/_mapping", urlencoding::encode(index));
    let value = request(c, Method::GET, &path, None).await?;
    let mut out = Vec::new();
    if let Some(indices) = value.as_object() {
        for index in indices.values() {
            let mappings = &index["mappings"];
            mapping_fields(&mappings["properties"], "", &mut out);
            if mappings.get("properties").is_none() {
                if let Some(types) = mappings.as_object() {
                    for mapping in types.values() { mapping_fields(&mapping["properties"], "", &mut out); }
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup_by(|a, b| a.name == b.name);
    Ok(out)
}

fn parse_query(index: &str, text: &str, limit: usize) -> Result<(Method, String, Option<Value>), String> {
    let text = text.trim();
    let (method, path, body_text) = if text.starts_with('{') {
        if index.is_empty() { return Err("请先选择索引，或使用 GET /索引/_search 加 JSON 请求体".into()); }
        (Method::POST, format!("/{}/_search", urlencoding::encode(index)), text)
    } else {
        let (head, body) = text.split_once('\n').unwrap_or((text, ""));
        let parts: Vec<_> = head.split_whitespace().collect();
        if parts.len() != 2 { return Err("请求格式：GET /索引/_search，下一行填写可选 JSON 请求体".into()); }
        let method = match parts[0].to_ascii_uppercase().as_str() {
            "GET" => Method::GET,
            "POST" => Method::POST,
            _ => return Err("当前 ES 控制台仅支持只读 GET 与 POST 查询".into()),
        };
        (method, parts[1].to_owned(), body.trim())
    };
    let endpoint = path.split('?').next().unwrap_or(&path);
    let read_endpoint = endpoint == "/" || endpoint.ends_with("/_search") || endpoint.ends_with("/_count")
        || endpoint.ends_with("/_mapping") || endpoint.ends_with("/_settings")
        || endpoint == "/_cluster/health" || endpoint.starts_with("/_cat/");
    if !read_endpoint || (method == Method::POST && !endpoint.ends_with("/_search") && !endpoint.ends_with("/_count")) {
        return Err("当前 ES 控制台支持 _search、_count、_mapping、_settings、_cluster/health 与 _cat 只读接口".into());
    }
    let mut body = if body_text.is_empty() { None } else {
        let value: Value = serde_json::from_str(body_text).map_err(|e| format!("JSON 格式错误: {e}"))?;
        if !value.is_object() { return Err("ES 请求体必须是 JSON 对象".into()); }
        Some(value)
    };
    if endpoint.ends_with("/_search") {
        if path.split('?').nth(1).is_some_and(|query| query.split('&').any(|pair| {
            let key = pair.split('=').next().unwrap_or("");
            urlencoding::decode(key).is_ok_and(|key| key == "size" || key == "source")
        })) {
            return Err("请在 JSON 请求体中设置 size，不要使用 URL size/source 参数".into());
        }
        let body = body.get_or_insert_with(|| json!({}));
        let size = match body.get("size") {
            Some(value) => value.as_u64().ok_or("size 必须是非负整数")? as usize,
            None => limit,
        };
        body["size"] = json!(size.min(limit));
    }
    Ok((method, path, body))
}

fn cell(value: &Value) -> Value {
    match value { Value::Null | Value::String(_) | Value::Number(_) => value.clone(), _ => Value::String(value.to_string()) }
}

fn query_result(value: Value, limit: usize, duration_ms: u64) -> QueryResult {
    let mut result = QueryResult { duration_ms, ..Default::default() };
    if let Some(hits) = value.pointer("/hits/hits").and_then(Value::as_array) {
        result.columns = vec!["_index".into(), "_id".into(), "_score".into()];
        for hit in hits.iter().take(limit) {
            if let Some(source) = hit["_source"].as_object() {
                for key in source.keys() {
                    let column = format!("_source.{key}");
                    if !result.columns.contains(&column) { result.columns.push(column); }
                }
            }
        }
        for hit in hits.iter().take(limit) {
            result.rows.push(result.columns.iter().map(|key| {
                let value = if let Some(field) = key.strip_prefix("_source.") { &hit["_source"][field] } else { &hit[key] };
                cell(value)
            }).collect());
        }
        if value.get("aggregations").is_some() || value.get("error").is_some() || value["_shards"]["failed"].as_u64().unwrap_or(0) > 0 {
            result.columns.push("_response".into());
            for row in &mut result.rows { row.push(Value::Null); }
            let mut row = vec![Value::Null; result.columns.len()];
            *row.last_mut().unwrap() = Value::String(value.to_string());
            result.rows.push(row);
        }
    } else {
        result.columns = vec!["response".into()];
        result.rows = vec![vec![Value::String(serde_json::to_string_pretty(&value).unwrap_or_default())]];
    }
    result.row_count = result.rows.len();
    result
}

pub async fn query(c: &Connection, index: &str, text: &str, limit: usize) -> Result<QueryResult, String> {
    let started = Instant::now();
    let limit = limit.clamp(1, 1000);
    let (method, path, body) = parse_query(index, text, limit)?;
    let value = request(c, method, &path, body).await?;
    Ok(query_result(value, limit, started.elapsed().as_millis() as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsl_requires_index_and_caps_size() {
        assert!(parse_query("", "{}", 100).is_err());
        let (_, path, body) = parse_query("example-index", "{\"size\":9999}", 100).unwrap();
        assert_eq!(path, "/example-index/_search");
        assert_eq!(body.unwrap()["size"], 100);
        assert!(parse_query("example-index", "{\"size\":-1}", 100).is_err());
    }

    #[test]
    fn only_read_requests_are_accepted() {
        assert!(parse_query("", "DELETE /example-index", 100).is_err());
        assert!(parse_query("", "POST /example-index/_delete_by_query\n{}", 100).is_err());
        assert!(parse_query("", "POST /_cluster/health", 100).is_err());
        assert!(parse_query("", "GET /example-index/_search?size=9999", 100).is_err());
        assert!(parse_query("", "GET /_cluster/health", 100).is_ok());
    }

    #[test]
    fn nested_mapping_and_multifields() {
        let mut columns = Vec::new();
        mapping_fields(&json!({"title":{"type":"text","fields":{"keyword":{"type":"keyword"}}},"user":{"properties":{"age":{"type":"integer"}}}}), "", &mut columns);
        assert!(columns.iter().any(|c| c.name == "title.keyword" && c.data_type == "keyword"));
        assert!(columns.iter().any(|c| c.name == "user.age" && c.data_type == "integer"));
    }

    #[test]
    fn sources_and_aggregations_remain_visible() {
        let result = query_result(json!({"hits":{"hits":[{"_id":"1","_source":{"tags":["a"],"active":true}}]},"aggregations":{"total":{"value":1}}}), 100, 0);
        assert!(result.columns.contains(&"_source.tags".to_string()));
        assert!(result.columns.contains(&"_response".to_string()));
        assert_eq!(result.row_count, 2);
    }
}
