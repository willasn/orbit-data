//! MongoDB 驱动：连接测试、库 / 集合 / 字段元数据，以及 JSON 命令 / shell 子集查询。
//!
//! 控制台输入支持两种写法：
//! 1. JSON 命令，如 `{"find": "users", "filter": {"age": {"$gt": 18}}, "limit": 20}`
//! 2. shell 子集，如 `db.users.find({"age": {"$gt": 18}}).sort({"age": 1}).limit(20)`
//!
//! 对象 / 数组等值按 Extended JSON 解析（`{"$oid": "..."}`、`{"$date": "..."}` 等），
//! 返回结果统一转成单元格，嵌套结构序列化为 JSON 文本。

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use mongodb::bson::{
    doc, oid::ObjectId, spec::BinarySubtype, Binary, Bson, DateTime, Decimal128, Document,
    Regex, Timestamp,
};
use mongodb::options::{ClientOptions, Credential, ServerAddress, TlsOptions};
use mongodb::results::CollectionType;
use mongodb::Client;
use serde_json::{json, Value};

use super::{ColumnInfo, QueryResult, TableInfo};
use crate::config::Connection;

const SAMPLE_SIZE: i64 = 50;
const MAX_NESTED_DEPTH: usize = 2;

fn auth_source(_c: &Connection) -> String {
    // 未单独提供认证库时的通用约定：MongoDB 的账号默认建在 admin 库
    "admin".into()
}

fn client_options(c: &Connection) -> Result<ClientOptions, String> {
    let host = c.host.trim();
    if host.is_empty() {
        return Err("未填写主机地址".into());
    }
    let port = if c.port == 0 { 27017 } else { c.port };
    // 先构建基础配置再按需补字段：typed-builder 的泛型参数在重新赋值时不兼容
    let mut options = ClientOptions::builder()
        .hosts(vec![ServerAddress::Tcp {
            host: host.to_string(),
            port: Some(port),
        }])
        .app_name("OrbitData".to_string())
        .connect_timeout(Some(Duration::from_secs(8)))
        .server_selection_timeout(Some(Duration::from_secs(8)))
        .build();

    if !c.username.trim().is_empty() {
        options.credential = Some(
            Credential::builder()
                .username(c.username.trim().to_string())
                .password(c.password.clone())
                .source(Some(auth_source(c)))
                .build(),
        );
    }

    if c.tls.unwrap_or(false) {
        let tls = TlsOptions::builder()
            .allow_invalid_certificates(c.tls_skip_verify)
            .build();
        options.tls = Some(tls.into());
    }

    Ok(options)
}

async fn client(c: &Connection) -> Result<Client, String> {
    let options = client_options(c)?;
    Client::with_options(options).map_err(|e| format!("创建 MongoDB 客户端失败: {e}"))
}

fn default_database(c: &Connection, database: &str) -> String {
    let db = database.trim();
    if !db.is_empty() {
        return db.to_string();
    }
    let db = c.database.trim();
    if db.is_empty() {
        "admin".into()
    } else {
        db.to_string()
    }
}

pub async fn test(c: &Connection) -> Result<String, String> {
    let client = client(c).await?;
    let db = client.database(&default_database(c, ""));
    db.run_command(doc! { "ping": 1 })
        .await
        .map_err(|e| format!("MongoDB 连接失败: {e}"))?;
    let version = match db.run_command(doc! { "buildInfo": 1 }).await {
        Ok(info) => info
            .get_str("version")
            .map(|v| format!("MongoDB {v}"))
            .unwrap_or_else(|_| "MongoDB".into()),
        Err(_) => "MongoDB".into(),
    };
    Ok(format!(
        "{version} · {}:{}（{}）",
        c.host.trim(),
        if c.port == 0 { 27017 } else { c.port },
        if c.tls.unwrap_or(false) { "TLS" } else { "明文" }
    ))
}

pub async fn list_databases(c: &Connection) -> Result<Vec<String>, String> {
    let client = client(c).await?;
    let mut names = client
        .list_database_names()
        .await
        .map_err(|e| format!("获取数据库列表失败: {e}"))?;
    // admin / config / local 属于系统库，排在最后，避免干扰日常浏览
    names.sort_by_key(|n| (matches!(n.as_str(), "admin" | "config" | "local"), n.clone()));
    Ok(names)
}

pub async fn list_tables(c: &Connection, database: &str) -> Result<Vec<TableInfo>, String> {
    if database.trim().is_empty() {
        return Err("未指定数据库".into());
    }
    let client = client(c).await?;
    let db = client.database(database.trim());
    let mut cursor = db
        .list_collections()
        .await
        .map_err(|e| format!("获取集合列表失败: {e}"))?;
    let mut tables = Vec::new();
    while let Some(spec) = cursor
        .try_next()
        .await
        .map_err(|e| format!("读取集合列表失败: {e}"))?
    {
        let table_type = match spec.collection_type {
            CollectionType::View => "view",
            _ => "collection",
        };
        tables.push(TableInfo {
            name: spec.name,
            table_type: table_type.into(),
        });
    }
    tables.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tables)
}

fn bson_type_name(v: &Bson) -> &'static str {
    match v {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Null => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) => "javascript",
        Bson::JavaScriptCodeWithScope(_) => "javascriptWithScope",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Binary(_) => "binData",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Symbol(_) => "symbol",
        Bson::Decimal128(_) => "decimal",
        Bson::Undefined => "undefined",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
        Bson::DbPointer(_) => "dbPointer",
    }
}

/// 字段采样：文档结构不固定，取前 N 篇文档推断字段路径与 BSON 类型
pub async fn list_columns(
    c: &Connection,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    if database.trim().is_empty() || table.trim().is_empty() {
        return Err("未指定数据库或集合".into());
    }
    let client = client(c).await?;
    let db = client.database(database.trim());
    let mut cursor = db
        .collection::<Document>(table.trim())
        .find(Document::new())
        .limit(SAMPLE_SIZE)
        .await
        .map_err(|e| format!("采样集合字段失败: {e}"))?;

    let mut stats: BTreeMap<String, Stat> = BTreeMap::new();
    let mut total = 0usize;
    while let Some(doc) = cursor
        .try_next()
        .await
        .map_err(|e| format!("读取采样文档失败: {e}"))?
    {
        total += 1;
        let mut seen: HashSet<String> = HashSet::new();
        collect_fields(&doc, "", 0, &mut seen, &mut stats);
        for path in &seen {
            if let Some(stat) = stats.get_mut(path) {
                stat.present += 1;
            }
        }
    }

    let mut columns: Vec<ColumnInfo> = stats
        .into_iter()
        .map(|(name, stat)| {
            let mut types = stat.types.into_iter().collect::<Vec<_>>();
            types.sort_unstable();
            let column_type = types.join(" | ");
            let nullable = stat.present < total || stat.nullish > 0;
            ColumnInfo {
                key: if name == "_id" { "PRI".into() } else { String::new() },
                comment: if total == 0 {
                    "集合为空，暂无采样".to_string()
                } else {
                    format!("采样 {total} 篇文档")
                },
                name,
                data_type: column_type,
                nullable,
            }
        })
        .collect();
    columns.sort_by_key(|col| (col.name != "_id", col.name.clone()));
    Ok(columns)
}

fn collect_fields(
    doc: &Document,
    prefix: &str,
    depth: usize,
    seen: &mut HashSet<String>,
    stats: &mut BTreeMap<String, StatBucket>,
) {
    for (key, value) in doc {
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        seen.insert(path.clone());
        let bucket = stats.entry(path.clone()).or_default();
        bucket.types.insert(bson_type_name(value));
        if matches!(value, Bson::Null) {
            bucket.nullish += 1;
        }
        if let Bson::Document(nested) = value {
            if depth < MAX_NESTED_DEPTH {
                collect_fields(nested, &path, depth + 1, seen, stats);
            }
        }
    }
}

type StatBucket = Stat;

#[derive(Default)]
struct Stat {
    types: BTreeSet<&'static str>,
    present: usize,
    nullish: usize,
}

/* ────────────────── 命令解析 ────────────────── */

fn strip_input(input: &str) -> String {
    let mut text = input.trim();
    // 允许整段命令前后带注释行（-- 或 //），避免直接粘贴模板被执行失败
    loop {
        let trimmed = text.trim_start();
        if let Some(rest) = trimmed.strip_prefix("--") {
            text = rest.split_once('\n').map(|(_, r)| r).unwrap_or("");
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("//") {
            text = rest.split_once('\n').map(|(_, r)| r).unwrap_or("");
            continue;
        }
        text = trimmed;
        break;
    }
    text.trim().trim_end_matches(';').trim().to_string()
}

fn parse_json_value(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|e| format!("JSON 解析失败: {e}"))
}

/// serde_json 值 → BSON，兼容常用 Extended JSON 形式
fn to_bson(value: &Value) -> Result<Bson, String> {
    Ok(match value {
        Value::Null => Bson::Null,
        Value::Bool(b) => Bson::Boolean(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Bson::Int64(i)
            } else if let Some(u) = n.as_u64() {
                Bson::Int64(u as i64)
            } else {
                Bson::Double(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => Bson::String(s.clone()),
        Value::Array(items) => {
            let mut arr = Vec::with_capacity(items.len());
            for item in items {
                arr.push(to_bson(item)?);
            }
            Bson::Array(arr)
        }
        Value::Object(map) => {
            if map.len() == 1 {
                if let Some(ext) = extended_json(map) {
                    return ext;
                }
            }
            let mut d = Document::new();
            for (k, v) in map {
                d.insert(k.clone(), to_bson(v)?);
            }
            Bson::Document(d)
        }
    })
}

fn extended_json(map: &serde_json::Map<String, Value>) -> Option<Result<Bson, String>> {
    let (key, value) = map.iter().next()?;
    let as_str = || value.as_str().map(|s| s.to_string());
    match key.as_str() {
        "$oid" => Some(
            as_str()
                .ok_or_else(|| "ObjectId 需要字符串".to_string())
                .and_then(|s| ObjectId::parse_str(&s).map(Bson::ObjectId).map_err(|e| format!("ObjectId 无效: {e}"))),
        ),
        "$date" => Some(match value {
            Value::String(s) => DateTime::parse_rfc3339_str(s)
                .map(Bson::DateTime)
                .map_err(|e| format!("日期格式无效: {e}")),
            Value::Number(n) => Ok(Bson::DateTime(DateTime::from_millis(
                n.as_i64().unwrap_or_default(),
            ))),
            Value::Object(o) => o
                .get("$numberLong")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<i64>().ok())
                .map(|ms| Ok(Bson::DateTime(DateTime::from_millis(ms))))
                .unwrap_or_else(|| Err("$date 仅支持 RFC3339 字符串或毫秒时间戳".into())),
            _ => Err("$date 仅支持 RFC3339 字符串或毫秒时间戳".into()),
        }),
        "$numberInt" => Some(
            as_str()
                .and_then(|s| s.parse::<i32>().ok())
                .map(|i| Ok(Bson::Int32(i)))
                .unwrap_or_else(|| Err("$numberInt 需要 32 位整数".into())),
        ),
        "$numberLong" => Some(
            as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .map(|i| Ok(Bson::Int64(i)))
                .unwrap_or_else(|| Err("$numberLong 需要 64 位整数".into())),
        ),
        "$numberDouble" => Some(
            as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .map(|f| Ok(Bson::Double(f)))
                .unwrap_or_else(|| Err("$numberDouble 需要数字".into())),
        ),
        "$numberDecimal" => Some(
            as_str()
                .and_then(|s| s.parse::<Decimal128>().ok())
                .map(|d| Ok(Bson::Decimal128(d)))
                .unwrap_or_else(|| Err("$numberDecimal 需要合法十进制字符串".into())),
        ),
        "$uuid" => Some(
            as_str()
                .and_then(|s| uuid::Uuid::parse_str(&s).ok())
                .map(|u| {
                    Ok(Bson::Binary(Binary {
                        subtype: BinarySubtype::Uuid,
                        bytes: u.as_bytes().to_vec(),
                    }))
                })
                .unwrap_or_else(|| Err("$uuid 格式无效".into())),
        ),
        "$timestamp" => {
            let t = value
                .get("t")
                .and_then(|v| v.as_i64())
                .unwrap_or_default() as u32;
            let i = value
                .get("i")
                .and_then(|v| v.as_i64())
                .unwrap_or_default() as u32;
            Some(Ok(Bson::Timestamp(Timestamp { time: t, increment: i })))
        }
        "$regularExpression" => {
            let pattern = value
                .get("pattern")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let options = value
                .get("options")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            Some(Ok(Bson::RegularExpression(Regex {
                pattern,
                options,
            })))
        }
        _ => None,
    }
}

fn json_to_document(text: &str) -> Result<Document, String> {
    let value = parse_json_value(text)?;
    match to_bson(&value)? {
        Bson::Document(d) => Ok(d),
        _ => Err("命令必须是 JSON 对象".into()),
    }
}

fn json_to_bson_arg(text: &str) -> Result<Bson, String> {
    let value = parse_json_value(text)?;
    to_bson(&value)
}

fn as_document(text: &str, hint: &str) -> Result<Document, String> {
    match json_to_bson_arg(text)? {
        Bson::Document(d) => Ok(d),
        _ => Err(format!("{hint} 必须是 JSON 对象")),
    }
}

/// 按顶层逗号切分 shell 形式的方法参数
fn split_args(text: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for ch in text.chars() {
        if in_string {
            current.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                current.push(ch);
            }
            '{' | '[' | '(' => {
                depth += 1;
                current.push(ch);
            }
            '}' | ']' | ')' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => {
                args.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    if !current.trim().is_empty() {
        args.push(current.trim().to_string());
    }
    args.into_iter().filter(|a| !a.is_empty()).collect()
}

/// 解析 `name(args)`，返回方法名与参数
fn parse_call(text: &str) -> Option<(String, Vec<String>)> {
    let text = text.trim();
    let open = text.find('(')?;
    let name = text[..open].trim().to_string();
    if name.is_empty() || !text.ends_with(')') {
        return None;
    }
    let mut depth = 0i32;
    let mut quote = false;
    let mut escaped = false;
    let mut close = None;
    for (idx, ch) in text[open..].char_indices() {
        if quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                quote = false;
            }
            continue;
        }
        match ch {
            '"' => quote = true,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + idx);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    let inner = &text[open + 1..close];
    Some((name, split_args(inner)))
}

/// 解析链式调用 `.limit(20).sort({...})`
fn parse_chain(text: &str) -> Vec<(String, Vec<String>)> {
    let mut chain = Vec::new();
    let mut rest = text.trim();
    while let Some(stripped) = rest.strip_prefix('.') {
        let Some((name, args)) = parse_call(stripped) else {
            break;
        };
        // 重新计算本次调用的结束位置，继续解析后续链
        let consumed = call_len(stripped);
        chain.push((name, args));
        rest = stripped[consumed..].trim();
    }
    chain
}

fn call_len(text: &str) -> usize {
    let Some(open) = text.find('(') else {
        return text.len();
    };
    let mut depth = 0i32;
    let mut quote = false;
    let mut escaped = false;
    for (idx, ch) in text[open..].char_indices() {
        if quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                quote = false;
            }
            continue;
        }
        match ch {
            '"' => quote = true,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return open + idx + 1;
                }
            }
            _ => {}
        }
    }
    text.len()
}

fn shell_command(text: &str, database: &str) -> Result<Document, String> {
    let rest = text
        .strip_prefix("db.")
        .ok_or_else(|| "命令需以 JSON 对象或 db. 开头".to_string())?;

    let (head, tail) = match rest.find('.') {
        Some(idx) => (&rest[..idx], &rest[idx + 1..]),
        None => ("", rest),
    };

    // db.xxx(...)：库级方法
    if head.is_empty() {
        let (method, args) = parse_call(tail)
            .ok_or_else(|| "无法解析 db 方法调用，示例: db.getCollectionNames()".to_string())?;
        return match method.as_str() {
            "getCollectionNames" | "listCollections" => Ok(doc! { "listCollections": 1 }),
            "stats" => Ok(doc! { "dbStats": 1 }),
            "dropDatabase" => Ok(doc! { "dropDatabase": 1 }),
            "createCollection" => {
                let name = args
                    .first()
                    .ok_or_else(|| "createCollection 需要集合名".to_string())?;
                let name = parse_json_value(name)?;
                let name = name
                    .as_str()
                    .ok_or_else(|| "集合名必须是字符串".to_string())?
                    .to_string();
                let mut cmd = doc! { "create": name };
                if let Some(options) = args.get(1) {
                    if let Bson::Document(opts) = json_to_bson_arg(options)? {
                        for (k, v) in opts {
                            cmd.insert(k, v);
                        }
                    }
                }
                Ok(cmd)
            }
            other => Err(format!("不支持的库级方法: db.{other}()")),
        };
    }

    if head == "getCollection" {
        // db.getCollection("name").find(...) 兼容写法
        if let Some((_, args)) = parse_call(tail) {
            if let Some(Value::String(name)) = args.first().map(|a| parse_json_value(a)).transpose()? {
                let inner = tail[call_len(tail)..].trim().trim_start_matches('.');
                return collection_command(&name, inner, database);
            }
        }
        return Err("db.getCollection(\"集合名\") 写法不完整".into());
    }

    collection_command(head, tail, database)
}

fn collection_command(collection: &str, tail: &str, database: &str) -> Result<Document, String> {
    let (method, args) = parse_call(tail)
        .ok_or_else(|| format!("无法解析集合方法: db.{collection}.{tail}"))?;
    let chain = parse_chain(&tail[call_len(tail)..]);

    let mut find_extra = Document::new();
    for (name, args) in &chain {
        let arg = args
            .first()
            .ok_or_else(|| format!("{name}() 缺少参数"))?;
        match name.as_str() {
            "limit" => {
                let n = parse_json_value(arg)?
                    .as_i64()
                    .ok_or_else(|| "limit() 需要整数".to_string())?;
                find_extra.insert("limit", n);
            }
            "skip" => {
                let n = parse_json_value(arg)?
                    .as_i64()
                    .ok_or_else(|| "skip() 需要整数".to_string())?;
                find_extra.insert("skip", n);
            }
            "sort" => {
                find_extra.insert("sort", json_to_bson_arg(arg)?);
            }
            "project" | "projection" => {
                find_extra.insert("projection", json_to_bson_arg(arg)?);
            }
            other => return Err(format!("不支持的链式方法: .{other}()")),
        }
    }

    match method.as_str() {
        "find" | "findOne" => {
            let filter = match args.first() {
                Some(a) => as_document(a, "find 的过滤条件")?,
                None => Document::new(),
            };
            let mut cmd = doc! { "find": collection, "filter": filter };
            for (k, v) in find_extra {
                cmd.insert(k, v);
            }
            if method == "findOne" {
                cmd.insert("limit", 1i64);
                cmd.insert("singleBatch", true);
            }
            Ok(cmd)
        }
        "count" | "countDocuments" => {
            let filter = match args.first() {
                Some(a) => as_document(a, "count 的过滤条件")?,
                None => Document::new(),
            };
            Ok(doc! { "count": collection, "query": filter })
        }
        "estimatedDocumentCount" => Ok(doc! { "count": collection }),
        "aggregate" => {
            let pipeline = match args.first() {
                Some(a) => json_to_bson_arg(a)?,
                None => return Err("aggregate 需要管道数组".into()),
            };
            Ok(doc! { "aggregate": collection, "pipeline": pipeline, "cursor": {} })
        }
        "distinct" => {
            let key = args
                .first()
                .map(|a| parse_json_value(a))
                .transpose()?
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .ok_or_else(|| "distinct 需要字段名".to_string())?;
            let mut cmd = doc! { "distinct": collection, "key": key };
            if let Some(filter) = args.get(1) {
                cmd.insert("query", as_document(filter, "distinct 的过滤条件")?);
            }
            Ok(cmd)
        }
        "insertOne" => {
            let document = args
                .first()
                .ok_or_else(|| "insertOne 需要文档".to_string())?;
            Ok(doc! { "insert": collection, "documents": [as_document(document, "文档")?] })
        }
        "insertMany" => {
            let documents = args
                .first()
                .ok_or_else(|| "insertMany 需要文档数组".to_string())?;
            match json_to_bson_arg(documents)? {
                Bson::Array(items) => Ok(doc! { "insert": collection, "documents": items }),
                _ => Err("insertMany 需要数组".into()),
            }
        }
        "updateOne" | "updateMany" | "replaceOne" => {
            let filter = args
                .first()
                .ok_or_else(|| format!("{method} 需要过滤条件"))?;
            let update = args
                .get(1)
                .ok_or_else(|| format!("{method} 需要更新内容"))?;
            let replacement = method == "replaceOne";
            let update_doc = if replacement {
                as_document(update, "替换文档")?
            } else {
                let parsed = as_document(update, "更新内容")?;
                if parsed.keys().any(|k| k.starts_with('$')) {
                    parsed
                } else {
                    doc! { "$set": parsed }
                }
            };
            Ok(doc! {
                "update": collection,
                "updates": [{
                    "q": as_document(filter, "过滤条件")?,
                    "u": update_doc,
                    "multi": method == "updateMany",
                    "upsert": false,
                }]
            })
        }
        "deleteOne" | "deleteMany" => {
            let filter = match args.first() {
                Some(a) => as_document(a, "删除条件")?,
                None => Document::new(),
            };
            Ok(doc! {
                "delete": collection,
                "deletes": [{ "q": filter, "limit": if method == "deleteOne" { 1i64 } else { 0i64 } }]
            })
        }
        "deleteManyAll" => Err("未知方法 deleteManyAll".into()),
        "getIndexes" | "indexes" => Ok(doc! { "listIndexes": collection }),
        "stats" => Ok(doc! { "collStats": collection }),
        "drop" => Ok(doc! { "drop": collection }),
        "renameCollection" => {
            let target = args
                .first()
                .map(|a| parse_json_value(a))
                .transpose()?
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .ok_or_else(|| "renameCollection 需要新集合名".to_string())?;
            Ok(doc! {
                "renameCollection": format!("{database}.{collection}"),
                "to": format!("{database}.{target}"),
            })
        }
        other => Err(format!("不支持的集合方法: db.{collection}.{other}()")),
    }
}

fn parse_command(text: &str, database: &str) -> Result<Document, String> {
    let input = strip_input(text);
    if input.is_empty() {
        return Err("命令为空".into());
    }
    if input.starts_with('{') {
        return json_to_document(&input);
    }
    if input.starts_with("db.") {
        return shell_command(&input, database);
    }
    Err("MongoDB 仅支持 JSON 命令或 db.集合.方法(...) 写法，例如 {\"find\": \"users\", \"limit\": 20}".into())
}

/* ────────────────── 结果转换 ────────────────── */

fn cell(v: &Bson) -> Value {
    match v {
        Bson::Double(f) => {
            if f.is_finite() {
                json!(f)
            } else {
                json!(f.to_string())
            }
        }
        Bson::String(s) => json!(s),
        Bson::Boolean(b) => json!(b),
        Bson::Null => Value::Null,
        Bson::Int32(i) => json!(i),
        Bson::Int64(i) => json!(i),
        Bson::ObjectId(o) => json!(o.to_hex()),
        Bson::DateTime(d) => json!(d.to_string()),
        Bson::Decimal128(d) => json!(d.to_string()),
        Bson::Timestamp(t) => json!(format!("{}.{}", t.time, t.increment)),
        Bson::Binary(b) => json!(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &b.bytes
        )),
        Bson::RegularExpression(r) => json!(format!("/{}/{}", r.pattern, r.options)),
        Bson::JavaScriptCode(code) => json!(code),
        Bson::Symbol(s) => json!(s),
        other => serde_json::to_value(other)
            .unwrap_or_else(|_| json!(format!("{other:?}"))),
    }
}

fn docs_to_result(docs: Vec<Document>) -> QueryResult {
    let mut columns: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for d in &docs {
        for key in d.keys() {
            if seen.insert(key.clone()) {
                columns.push(key.clone());
            }
        }
    }
    let rows = docs
        .iter()
        .map(|d| {
            columns
                .iter()
                .map(|col| d.get(col).map(cell).unwrap_or(Value::Null))
                .collect()
        })
        .collect::<Vec<_>>();
    QueryResult {
        row_count: rows.len(),
        columns,
        rows,
        duration_ms: 0,
    }
}

async fn run_command_docs(
    db: &mongodb::Database,
    command: Document,
    limit: usize,
) -> Result<Vec<Document>, String> {
    let reply = db
        .run_command(command)
        .await
        .map_err(|e| format!("MongoDB 执行失败: {e}"))?;

    let cursor_doc = match reply.get_document("cursor") {
        Ok(c) => c,
        Err(_) => return Ok(vec![reply]),
    };

    let mut docs: Vec<Document> = Vec::new();
    if let Ok(batch) = cursor_doc.get_array("firstBatch") {
        for item in batch {
            if let Bson::Document(d) = item {
                docs.push(d.clone());
            }
        }
    }
    let ns = cursor_doc.get_str("ns").unwrap_or_default().to_string();
    let collection = ns
        .split_once('.')
        .map(|(_, c)| c.to_string())
        .unwrap_or_default();
    let mut cursor_id = cursor_doc.get_i64("id").unwrap_or(0);

    while cursor_id != 0 && docs.len() < limit && !collection.is_empty() {
        let more = db
            .run_command(
                doc! {
                    "getMore": cursor_id,
                    "collection": collection.clone(),
                    "batchSize": 200i64,
                },
            )
            .await
            .map_err(|e| format!("读取后续结果失败: {e}"))?;
        let Some(cursor) = more.get_document("cursor").ok() else {
            break;
        };
        if let Ok(batch) = cursor.get_array("nextBatch") {
            for item in batch {
                if let Bson::Document(d) = item {
                    docs.push(d.clone());
                }
            }
        }
        cursor_id = cursor.get_i64("id").unwrap_or(0);
    }
    docs.truncate(limit);
    Ok(docs)
}

pub async fn query(
    c: &Connection,
    database: &str,
    sql: &str,
    limit: usize,
) -> Result<QueryResult, String> {
    let started = Instant::now();
    let db_name = default_database(c, database);
    let mut command = parse_command(sql, &db_name)?;

    // find 未显式指定 limit 时使用结果集上限，避免一次拉回整个集合
    if command.contains_key("find") && !command.contains_key("limit") {
        command.insert("limit", limit.max(1) as i64);
    }

    let client = client(c).await?;
    // renameCollection 只能在 admin 库执行，命令里已带完整命名空间
    let target_db = if command.contains_key("renameCollection") {
        "admin"
    } else {
        db_name.as_str()
    };
    let db = client.database(target_db);
    let docs = run_command_docs(&db, command, limit.max(1)).await?;
    let mut result = docs_to_result(docs);
    result.duration_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn_from_env() -> Option<Connection> {
        let host = std::env::var("MONGO_TEST_HOST").ok()?;
        Some(Connection {
            id: "mongo-live-test".into(),
            name: "MongoDB 测试".into(),
            db_type: "mongodb".into(),
            host,
            port: std::env::var("MONGO_TEST_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(27017),
            username: std::env::var("MONGO_TEST_USER").unwrap_or_default(),
            password: std::env::var("MONGO_TEST_PASSWORD").unwrap_or_default(),
            database: std::env::var("MONGO_TEST_DATABASE").unwrap_or_else(|_| "admin".into()),
            tls: Some(std::env::var("MONGO_TEST_TLS").map(|v| v == "1").unwrap_or(false)),
            tls_skip_verify: std::env::var("MONGO_TEST_TLS_SKIP_VERIFY")
                .map(|v| v == "1")
                .unwrap_or(false),
            ..Default::default()
        })
    }

    #[test]
    fn parses_shell_find_with_chain() {
        let cmd = parse_command(
            "db.users.find({\"age\": {\"$gt\": 18}}).sort({\"age\": 1}).limit(5).skip(2)",
            "test",
        )
        .unwrap();
        assert_eq!(cmd.get_str("find").unwrap(), "users");
        assert_eq!(cmd.get_i64("limit").unwrap(), 5);
        assert_eq!(cmd.get_i64("skip").unwrap(), 2);
        assert_eq!(
            cmd.get_document("filter")
                .and_then(|f| f.get_document("age"))
                .and_then(|a| a.get_i64("$gt"))
                .unwrap(),
            18
        );
    }

    #[test]
    fn parses_extended_json_oid() {
        let cmd = parse_command(
            "db.users.deleteOne({\"_id\": {\"$oid\": \"507f1f77bcf86cd799439011\"}})",
            "test",
        )
        .unwrap();
        let deletes = cmd.get_array("deletes").unwrap();
        assert!(matches!(deletes[0], Bson::Document(_)));
    }

    #[test]
    fn parses_json_command_and_db_methods() {
        let find = parse_command("{\"find\": \"t\", \"limit\": 3}", "test").unwrap();
        assert_eq!(find.get_i64("limit").unwrap(), 3);
        assert!(parse_command("db.dropDatabase()", "test")
            .unwrap()
            .contains_key("dropDatabase"));
        assert!(parse_command("db.users.aggregate([{\"$match\": {}}])", "test")
            .unwrap()
            .contains_key("cursor"));
    }

    #[test]
    fn converts_bson_cells() {
        assert_eq!(cell(&Bson::ObjectId(ObjectId::from_bytes([0; 12]))), json!("000000000000000000000000"));
        assert_eq!(cell(&Bson::Int64(7)), json!(7));
        assert_eq!(cell(&Bson::Null), Value::Null);
    }

    /// 真实实例联调：需通过环境变量提供 MONGO_TEST_HOST 等，默认跳过
    #[tokio::test]
    #[ignore]
    async fn live_smoke() {
        let Some(c) = conn_from_env() else {
            return;
        };
        let detail = test(&c).await.expect("连接测试失败");
        assert!(detail.starts_with("MongoDB"));
        let dbs = list_databases(&c).await.expect("库列表失败");
        assert!(!dbs.is_empty());

        let db_name = std::env::var("MONGO_TEST_DATABASE").unwrap_or_else(|_| "orbitdata_test".into());
        let coll = "orbitdata_test";
        query(&c, &db_name, &format!("db.{coll}.drop()"), 10)
            .await
            .ok();
        query(
            &c,
            &db_name,
            &format!(
                "db.{coll}.insertMany([{{\"name\": \"alpha\", \"score\": 1.5, \"tags\": [\"a\", \"b\"]}}, {{\"name\": \"beta\", \"score\": 2, \"nested\": {{\"k\": true}}}}])"
            ),
            10,
        )
        .await
        .expect("插入失败");

        let found = query(
            &c,
            &db_name,
            &format!("db.{coll}.find({{\"score\": {{\"$gte\": 1}}}}).sort({{\"score\": 1}}).limit(10)"),
            10,
        )
        .await
        .expect("查询失败");
        assert_eq!(found.row_count, 2);
        assert!(found.columns.iter().any(|c| c == "name"));

        let count = query(&c, &db_name, &format!("db.{coll}.countDocuments({{}})"), 10)
            .await
            .expect("计数失败");
        assert!(count.row_count >= 1);

        let agg = query(
            &c,
            &db_name,
            &format!("db.{coll}.aggregate([{{\"$match\": {{}}}}, {{\"$group\": {{\"_id\": null, \"total\": {{\"$sum\": 1}}}}}}])"),
            10,
        )
        .await
        .expect("聚合失败");
        assert_eq!(agg.row_count, 1);

        let tables = list_tables(&c, &db_name).await.expect("集合列表失败");
        assert!(tables.iter().any(|t| t.name == coll));

        let columns = list_columns(&c, &db_name, coll).await.expect("字段采样失败");
        assert!(columns.iter().any(|f| f.name == "name"));
        assert!(columns.iter().any(|f| f.name == "_id" && f.key == "PRI"));

        let indexes = query(&c, &db_name, &format!("db.{coll}.getIndexes()"), 10)
            .await
            .expect("索引查询失败");
        assert!(indexes.row_count >= 1);

        let stats = query(&c, &db_name, &format!("db.{coll}.stats()"), 10)
            .await
            .expect("集合统计失败");
        assert!(stats.columns.iter().any(|c| c == "count"));

        let db_stats = query(&c, &db_name, "db.stats()", 10)
            .await
            .expect("库统计失败");
        assert!(db_stats.columns.iter().any(|c| c == "collections"));

        // ── JSON 命令写法（右键菜单与 AI 实际下发的形式）──
        let json_coll = "orbitdata_json";
        query(&c, &db_name, &format!("{{\"drop\":\"{json_coll}\"}}"), 10)
            .await
            .ok();
        query(
            &c,
            &db_name,
            &format!(
                "{{\"insert\":\"{json_coll}\",\"documents\":[\
                 {{\"name\":\"gamma\",\"score\":3,\"created\":{{\"$date\":\"2026-01-01T00:00:00Z\"}}}},\
                 {{\"name\":\"delta\",\"score\":4,\"flag\":true}}]}}"
            ),
            10,
        )
        .await
        .expect("JSON 插入失败");

        let json_find = query(
            &c,
            &db_name,
            &format!("{{\"find\":\"{json_coll}\",\"filter\":{{\"score\":{{\"$gte\":3}}}},\"limit\":5}}"),
            5,
        )
        .await
        .expect("JSON find 失败");
        assert_eq!(json_find.row_count, 2);

        let json_count = query(
            &c,
            &db_name,
            &format!("{{\"count\":\"{json_coll}\",\"query\":{{\"score\":{{\"$gt\":0}}}}}}"),
            10,
        )
        .await
        .expect("JSON count 失败");
        // count 命令返回单行 { n, ok }，直接校验 n
        let n_index = json_count
            .columns
            .iter()
            .position(|c| c == "n")
            .expect("count 结果缺少 n");
        assert_eq!(json_count.rows[0][n_index], json!(2));

        let json_agg = query(
            &c,
            &db_name,
            &format!(
                "{{\"aggregate\":\"{json_coll}\",\"pipeline\":[{{\"$group\":{{\"_id\":null,\"avg\":{{\"$avg\":\"$score\"}}}}}}],\"cursor\":{{}}}}"
            ),
            10,
        )
        .await
        .expect("JSON aggregate 失败");
        assert_eq!(json_agg.row_count, 1);

        let json_indexes = query(
            &c,
            &db_name,
            &format!("{{\"listIndexes\":\"{json_coll}\"}}"),
            10,
        )
        .await
        .expect("JSON listIndexes 失败");
        assert!(json_indexes.row_count >= 1);

        let json_stats = query(
            &c,
            &db_name,
            &format!("{{\"collStats\":\"{json_coll}\"}}"),
            10,
        )
        .await
        .expect("JSON collStats 失败");
        assert!(json_stats.columns.iter().any(|c| c == "count"));
        let json_db_stats = query(&c, &db_name, "{\"dbStats\":1}", 10)
            .await
            .expect("JSON dbStats 失败");
        assert!(json_db_stats.columns.iter().any(|c| c == "collections"));

        query(
            &c,
            &db_name,
            &format!(
                "{{\"update\":\"{json_coll}\",\"updates\":[{{\"q\":{{\"name\":\"gamma\"}},\"u\":{{\"$set\":{{\"score\":30}}}}}}]}}"
            ),
            10,
        )
        .await
        .expect("JSON update 失败");
        let updated = query(
            &c,
            &db_name,
            &format!("db.{json_coll}.find({{\"name\":\"gamma\"}})"),
            5,
        )
        .await
        .expect("更新后查询失败");
        let score_index = updated
            .columns
            .iter()
            .position(|c| c == "score")
            .expect("查询结果缺少 score");
        assert_eq!(updated.rows[0][score_index], json!(30));

        query(
            &c,
            &db_name,
            &format!("{{\"delete\":\"{json_coll}\",\"deletes\":[{{\"q\":{{\"name\":\"delta\"}},\"limit\":1}}]}}"),
            10,
        )
        .await
        .expect("JSON delete 失败");
        let after_delete = query(
            &c,
            &db_name,
            &format!("{{\"count\":\"{json_coll}\",\"query\":{{}}}}"),
            10,
        )
        .await
        .expect("删除后计数失败");
        assert_eq!(after_delete.rows[0][n_index], json!(1));

        // 新建 / 重命名集合
        let rename_src = "orbitdata_rename_src";
        let rename_dst = "orbitdata_rename_dst";
        query(&c, &db_name, &format!("{{\"drop\":\"{rename_dst}\"}}"), 10)
            .await
            .ok();
        query(&c, &db_name, &format!("{{\"create\":\"{rename_src}\"}}"), 10)
            .await
            .expect("JSON create 失败");
        let renamed = query(
            &c,
            &db_name,
            &format!("{{\"renameCollection\":\"{db_name}.{rename_src}\",\"to\":\"{db_name}.{rename_dst}\"}}"),
            10,
        )
        .await
        .expect("JSON renameCollection 失败");
        assert_eq!(renamed.row_count, 1);
        let after_rename = list_tables(&c, &db_name).await.expect("重命名后集合列表失败");
        assert!(after_rename.iter().any(|t| t.name == rename_dst));
        query(&c, &db_name, &format!("{{\"drop\":\"{rename_dst}\"}}"), 10)
            .await
            .expect("清理重命名集合失败");

        // 游标翻页：一次取回 250 条（firstBatch + getMore）
        let paging = "orbitdata_paging";
        query(&c, &db_name, &format!("{{\"drop\":\"{paging}\"}}"), 10)
            .await
            .ok();
        let docs = (0..250)
            .map(|i| format!("{{\"i\":{i}}}"))
            .collect::<Vec<_>>()
            .join(",");
        query(
            &c,
            &db_name,
            &format!("{{\"insert\":\"{paging}\",\"documents\":[{docs}]}}"),
            10,
        )
        .await
        .expect("批量插入失败");
        let paged = query(
            &c,
            &db_name,
            &format!("{{\"find\":\"{paging}\",\"filter\":{{}},\"sort\":{{\"i\":1}},\"limit\":250}}"),
            250,
        )
        .await
        .expect("翻页查询失败");
        assert_eq!(paged.row_count, 250);
        assert_eq!(paged.rows[249][1], json!(249));
        query(&c, &db_name, &format!("{{\"drop\":\"{paging}\"}}"), 10)
            .await
            .expect("清理分页集合失败");

        // 保留测试内容：orbitdata_test / orbitdata_json 各留一份样本
        let kept = query(&c, &db_name, &format!("db.{coll}.countDocuments({{}})"), 10)
            .await
            .expect("保留数据校验失败");
        assert!(kept.row_count >= 1);
        let kept_json = query(
            &c,
            &db_name,
            &format!("{{\"count\":\"{json_coll}\",\"query\":{{}}}}"),
            10,
        )
        .await
        .expect("保留 JSON 数据校验失败");
        assert!(kept_json.row_count >= 1);
    }
}
