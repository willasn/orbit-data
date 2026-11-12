use redis::Value as RVal;
use serde::Serialize;

use super::TableInfo;
use crate::config::Connection;

fn url(c: &Connection) -> Result<String, String> {
    let db: i64 = if c.database.is_empty() {
        0
    } else {
        c.database.parse().unwrap_or(0)
    };
    let auth = if c.password.is_empty() {
        String::new()
    } else {
        format!(":{}@", urlencoding::encode(&c.password))
    };
    // TLS：启用时使用 rediss://，跳过校验通过 #insecure 片段声明
    let scheme = if c.tls == Some(true) { "rediss" } else { "redis" };
    let mut url = format!("{}://{}{}:{}/{}", scheme, auth, c.host, c.port, db);
    if c.tls == Some(true) && c.tls_skip_verify {
        url.push_str("#insecure");
    }
    Ok(url)
}

async fn get_conn(c: &Connection) -> Result<redis::aio::MultiplexedConnection, String> {
    let client = redis::Client::open(url(c)?).map_err(|e| format!("Redis 连接串错误: {e}"))?;
    client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| format!("Redis 连接失败: {e}"))
}

fn fmt(v: &RVal, indent: usize) -> String {
    match v {
        RVal::Nil => "(nil)".into(),
        RVal::Okay => "OK".into(),
        RVal::SimpleString(s) => s.clone(),
        RVal::Int(i) => i.to_string(),
        RVal::Double(d) => d.to_string(),
        RVal::Boolean(b) => b.to_string(),
        RVal::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
        RVal::VerbatimString { text, .. } => text.clone(),
        RVal::Array(items) | RVal::Set(items) => items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                format!(
                    "{}{}) {}",
                    " ".repeat(indent),
                    i + 1,
                    fmt(item, indent + 4)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        RVal::Map(pairs) => pairs
            .iter()
            .enumerate()
            .map(|(i, (k, val))| {
                format!(
                    "{}{}) {} => {}",
                    " ".repeat(indent),
                    i + 1,
                    fmt(k, indent + 4),
                    fmt(val, indent + 4)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => format!("{other:?}"),
    }
}

pub async fn command(c: &Connection, args: &[String]) -> Result<String, String> {
    if args.is_empty() {
        return Err("缺少 Redis 命令".into());
    }
    let mut con = get_conn(c).await?;
    let mut cmd = redis::cmd(args[0].to_uppercase().as_str());
    for a in &args[1..] {
        cmd.arg(a);
    }
    let v: RVal = cmd
        .query_async(&mut con)
        .await
        .map_err(|e| format!("命令执行失败: {e}"))?;
    Ok(fmt(&v, 0))
}

pub async fn test(c: &Connection) -> Result<String, String> {
    let reply = command(c, &["PING".to_string()]).await?;
    Ok(format!("连接成功 ({reply})"))
}

/// Redis 用键列表代替表（循环 SCAN 直到游标归零，避免只取到一批就漏键）
pub async fn list_tables(c: &Connection) -> Result<Vec<TableInfo>, String> {
    /// 单次 SCAN 的扫描提示值
    const COUNT: usize = 500;
    /// 键数量上限：避免超大实例把界面拖死（超出后只展示前 N 个）
    const MAX_KEYS: usize = 10_000;
    let mut con = get_conn(c).await?;
    let mut cursor: u64 = 0;
    let mut names: Vec<String> = Vec::new();
    loop {
        let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("COUNT")
            .arg(COUNT)
            .query_async(&mut con)
            .await
            .map_err(|e| format!("SCAN 失败: {e}"))?;
        names.extend(keys);
        cursor = next;
        if cursor == 0 || names.len() >= MAX_KEYS {
            break;
        }
    }
    names.sort();
    names.dedup();
    let list: Vec<TableInfo> = names
        .into_iter()
        .map(|name| TableInfo {
            name,
            table_type: "key".into(),
        })
        .collect();
    Ok(list)
}

/* ────────────────── 键内容预览（表格化） ────────────────── */

/// 键内容预览：按值类型展开成「列 + 行」，前端用表格展示，
/// 避免把整段 RESP 文本塞进一个单元格被截断成一长串（见 CONTEXT_MENU.md 5.2「查看值」）。
#[derive(Serialize)]
pub struct KeyView {
    pub key: String,
    /// string | list | set | zset | hash | stream | none
    pub key_type: String,
    /// 剩余过期秒数：-1 永不过期，-2 键不存在
    pub ttl: i64,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// 内容超过展示上限，仅返回前若干项
    pub truncated: bool,
}

/// 单个键最多展开的条目数
const VIEW_MAX: usize = 500;
/// HSCAN / SSCAN / ZSCAN 单次扫描提示值
const VIEW_SCAN_COUNT: usize = 200;

/// 循环 HSCAN / SSCAN / ZSCAN 直到游标归零或达到展示上限
async fn scan_items(
    con: &mut redis::aio::MultiplexedConnection,
    cmd: &str,
    key: &str,
) -> Result<(Vec<String>, bool), String> {
    let mut cursor: u64 = 0;
    let mut items: Vec<String> = Vec::new();
    loop {
        // 语法：HSCAN / SSCAN / ZSCAN <key> <cursor> [COUNT n]
        let (next, part): (u64, Vec<String>) = redis::cmd(cmd)
            .arg(key)
            .arg(cursor)
            .arg("COUNT")
            .arg(VIEW_SCAN_COUNT)
            .query_async(con)
            .await
            .map_err(|e| format!("{cmd} 失败: {e}"))?;
        items.extend(part);
        cursor = next;
        if cursor == 0 {
            return Ok((items, false));
        }
        if items.len() >= VIEW_MAX {
            return Ok((items, true));
        }
    }
}

/// 成对扁平数组（field/value、member/score）转成两列表格
fn pair_rows(items: Vec<String>) -> Vec<Vec<String>> {
    items
        .chunks(2)
        .map(|pair| {
            vec![
                pair[0].clone(),
                pair.get(1).cloned().unwrap_or_default(),
            ]
        })
        .collect()
}

/// 读取单个键的类型、TTL 与内容（键不存在时返回 none 提示行）
pub async fn inspect(c: &Connection, key: &str) -> Result<KeyView, String> {
    let mut con = get_conn(c).await?;
    let key_type: String = redis::cmd("TYPE")
        .arg(key)
        .query_async(&mut con)
        .await
        .map_err(|e| format!("TYPE 失败: {e}"))?;
    // 部分兼容实现会返回大写，统一小写后再按类型分发
    let key_type = key_type.to_lowercase();
    let ttl: i64 = redis::cmd("TTL")
        .arg(key)
        .query_async(&mut con)
        .await
        .unwrap_or(-2);

    let mut view = KeyView {
        key: key.to_string(),
        key_type: key_type.clone(),
        ttl,
        columns: Vec::new(),
        rows: Vec::new(),
        truncated: false,
    };

    match key_type.as_str() {
        "string" => {
            let value: Option<String> = redis::cmd("GET")
                .arg(key)
                .query_async(&mut con)
                .await
                .map_err(|e| format!("GET 失败: {e}"))?;
            view.columns = vec!["值".into()];
            view.rows = vec![vec![value.unwrap_or_else(|| "(nil)".into())]];
        }
        "list" => {
            let len: i64 = redis::cmd("LLEN")
                .arg(key)
                .query_async(&mut con)
                .await
                .map_err(|e| format!("LLEN 失败: {e}"))?;
            let items: Vec<String> = redis::cmd("LRANGE")
                .arg(key)
                .arg(0)
                .arg(VIEW_MAX - 1)
                .query_async(&mut con)
                .await
                .map_err(|e| format!("LRANGE 失败: {e}"))?;
            view.columns = vec!["序号".into(), "值".into()];
            view.rows = items
                .iter()
                .enumerate()
                .map(|(i, v)| vec![(i + 1).to_string(), v.clone()])
                .collect();
            view.truncated = len as usize > view.rows.len();
        }
        "hash" => {
            let (items, truncated) = scan_items(&mut con, "HSCAN", key).await?;
            view.columns = vec!["字段".into(), "值".into()];
            view.rows = pair_rows(items);
            view.truncated = truncated;
        }
        "set" => {
            let (items, truncated) = scan_items(&mut con, "SSCAN", key).await?;
            view.columns = vec!["成员".into()];
            view.rows = items.into_iter().map(|m| vec![m]).collect();
            view.truncated = truncated;
        }
        "zset" => {
            let (items, truncated) = scan_items(&mut con, "ZSCAN", key).await?;
            view.columns = vec!["成员".into(), "分值".into()];
            view.rows = pair_rows(items);
            view.truncated = truncated;
        }
        "stream" => {
            // XRANGE 每项形如 [ID, [field, value, ...]]，内层是扁平数组，按 Value 取更稳妥
            let entries: Vec<RVal> = redis::cmd("XRANGE")
                .arg(key)
                .arg("-")
                .arg("+")
                .arg("COUNT")
                .arg(VIEW_MAX)
                .query_async(&mut con)
                .await
                .map_err(|e| format!("XRANGE 失败: {e}"))?;
            view.columns = vec!["ID".into(), "字段".into()];
            view.rows = entries
                .iter()
                .map(|entry| {
                    let parts: &[RVal] = entry.as_sequence().unwrap_or(&[]);
                    let id = parts.first().map(|v| fmt(v, 0)).unwrap_or_default();
                    let fields = parts
                        .get(1)
                        .and_then(|v| v.as_sequence())
                        .map(|items| {
                            items
                                .chunks(2)
                                .map(|pair| {
                                    let val = pair.get(1).map(|v| fmt(v, 0)).unwrap_or_default();
                                    format!("{}={}", fmt(&pair[0], 0), val)
                                })
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    vec![id, fields]
                })
                .collect();
        }
        "none" => {
            view.columns = vec!["结果".into()];
            view.rows = vec![vec!["键不存在（可能已过期或被删除）".into()]];
        }
        other => {
            view.columns = vec!["结果".into()];
            view.rows = vec![vec![format!("暂不支持预览的类型：{other}")]];
        }
    }
    Ok(view)
}
