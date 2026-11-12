//! 阿里云 OSS（对象存储）驱动。
//!
//! 只做元数据与对象读写，不把对象存储伪装成关系型数据库：
//! 库级 = Bucket，表级 = 对象 / 前缀，无列级，不支持 SQL。
//! 使用 OSS V1 签名（HMAC-SHA1），凭据只从本机连接配置读取。

use crate::config::Connection;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::Sha1;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

type HmacSha1 = Hmac<Sha1>;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct BucketInfo {
    pub name: String,
    #[serde(default)]
    pub creation_date: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ObjectInfo {
    pub key: String,
    pub is_folder: bool,
    pub size: u64,
    pub last_modified: String,
    pub etag: String,
    pub storage_class: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ObjectListResult {
    pub prefix: String,
    pub objects: Vec<ObjectInfo>,
    pub total: usize,
    pub page: u32,
    pub page_size: u32,
    /// 扫描量达到上限，结果可能不完整
    pub scan_truncated: bool,
}

/// 连接端点解析结果
struct Endpoint {
    scheme: String,
    /// host[:port]，不含 bucket 前缀
    host: String,
    access_key: String,
    secret: String,
    sts_token: String,
    /// 跳过 HTTPS 证书校验（自签 / IP 证书）
    skip_tls_verify: bool,
}

impl Endpoint {
    fn of(c: &Connection) -> Result<Self, String> {
        let scheme = match c.oss.as_ref().map(|o| o.scheme.as_str()) {
            Some("http") => "http".to_string(),
            _ => "https".to_string(),
        };
        let mut host = c.host.trim().to_string();
        if host.is_empty() {
            return Err("请填写 OSS Endpoint（如 oss-cn-hangzhou.aliyuncs.com）".into());
        }
        // 容忍用户把协议写进 Endpoint
        for p in ["https://", "http://"] {
            if let Some(rest) = host.strip_prefix(p) {
                host = rest.trim_end_matches('/').to_string();
            }
        }
        if !host.contains(':') && c.port != 0 && !((scheme == "https" && c.port == 443) || (scheme == "http" && c.port == 80)) {
            host = format!("{host}:{}", c.port);
        }
        if c.username.trim().is_empty() || c.password.is_empty() {
            return Err("请填写 AccessKey ID 与 AccessKey Secret".into());
        }
        Ok(Self {
            scheme,
            host,
            access_key: c.username.trim().to_string(),
            secret: c.password.clone(),
            sts_token: c.oss.as_ref().map(|o| o.sts_token.trim().to_string()).unwrap_or_default(),
            skip_tls_verify: c.tls_skip_verify,
        })
    }

    fn base(&self, bucket: &str) -> String {
        if bucket.is_empty() {
            format!("{}://{}", self.scheme, self.host)
        } else {
            format!("{}://{}.{}", self.scheme, bucket, self.host)
        }
    }
}

/// RFC 3986 编码：保留 A-Z a-z 0-9 - _ . ~
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 对象 Key 编码：保留 `/` 作为路径分隔符
fn encode_key(key: &str) -> String {
    key.split('/').map(encode).collect::<Vec<_>>().join("/")
}

fn gmt_now() -> String {
    chrono::Utc::now().format("%a, %d %b %Y %H:%M:%S GMT").to_string()
}

/// 只有 OSS 定义的子资源才参与签名；prefix / delimiter / max-keys /
/// list-type / continuation-token 等普通查询参数不参与 CanonicalizedResource。
const SIGNED_SUBRESOURCES: &[&str] = &["security-token"];

fn canonical_query(params: &[(String, String)], signed_only: bool) -> String {
    let mut pairs: Vec<String> = params
        .iter()
        .filter(|(k, v)| !v.is_empty() && (!signed_only || SIGNED_SUBRESOURCES.contains(&k.as_str())))
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect();
    pairs.sort();
    pairs.join("&")
}

fn canonical_resource(bucket: &str, key: &str, params: &[(String, String)]) -> String {
    let path = if bucket.is_empty() {
        "/".to_string()
    } else {
        format!("/{}/{}", bucket, key)
    };
    let q = canonical_query(params, true);
    if q.is_empty() {
        path
    } else {
        format!("{path}?{q}")
    }
}

fn hmac_sha1(secret: &str, data: &str) -> String {
    let mut mac = HmacSha1::new_from_slice(secret.as_bytes()).expect("HMAC 支持任意密钥长度");
    mac.update(data.as_bytes());
    B64.encode(mac.finalize().into_bytes())
}

fn string_to_sign(
    method: &str,
    content_type: &str,
    date_or_expires: &str,
    sts_token: &str,
    resource: &str,
) -> String {
    let oss_headers = if sts_token.is_empty() {
        String::new()
    } else {
        format!("x-oss-security-token:{sts_token}\n")
    };
    format!("{method}\n\n{content_type}\n{date_or_expires}\n{oss_headers}{resource}")
}

fn client(ep: &Endpoint) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .danger_accept_invalid_certs(ep.skip_tls_verify)
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {e}"))
}

fn url_of(ep: &Endpoint, bucket: &str, key: &str, params: &[(String, String)]) -> String {
    let path = if key.is_empty() { String::new() } else { encode_key(key) };
    let q = canonical_query(params, false);
    let base = format!("{}/{}", ep.base(bucket), path);
    if q.is_empty() {
        base
    } else {
        format!("{base}?{q}")
    }
}

/// 解析 OSS 错误 XML：Code + Message
async fn check(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let code = tag(&body, "Code").unwrap_or("");
    let msg = tag(&body, "Message").unwrap_or("");
    let hint = match code {
        "InvalidAccessKeyId" => "，请检查 AccessKey ID 是否正确或已禁用",
        "SignatureDoesNotMatch" => "，请检查 AccessKey Secret，或校准本机系统时间",
        "AccessDenied" => "，请检查 RAM 子账号是否具备该 Bucket 的对应权限",
        "NoSuchBucket" => "，请检查 Bucket 名称与 Endpoint 地域是否一致",
        "NoSuchKey" => "，对象不存在或已被删除",
        _ => "",
    };
    if code.is_empty() && msg.is_empty() {
        Err(format!("OSS 请求失败（HTTP {}）", status.as_u16()))
    } else {
        Err(format!("{code}: {msg}（HTTP {}）{hint}", status.as_u16()))
    }
}

fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let s = xml.find(&open)? + open.len();
    let e = xml[s..].find(&close)? + s;
    Some(&xml[s..e])
}

fn blocks<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let start = i + open.len();
        match rest[start..].find(&close) {
            Some(j) => {
                out.push(&rest[start..start + j]);
                rest = &rest[start + j + close.len()..];
            }
            None => break,
        }
    }
    out
}

/* ────────────────── 操作 ────────────────── */

pub async fn test(c: &Connection) -> Result<String, String> {
    let ep = Endpoint::of(c)?;
    let bucket = c.database.trim();
    if bucket.is_empty() {
        let buckets = list_buckets(&ep).await?;
        return Ok(format!("连接成功，账号下共 {} 个 Bucket", buckets.len()));
    }
    let params: Vec<(String, String)> = vec![];
    let date = gmt_now();
    let resource = canonical_resource(bucket, "", &params);
    let sig = hmac_sha1(&ep.secret, &string_to_sign("HEAD", "", &date, &ep.sts_token, &resource));
    let mut req = client(&ep)?
        .head(url_of(&ep, bucket, "", &params))
        .header("Date", &date)
        .header("Authorization", format!("OSS {}:{}", ep.access_key, sig));
    if !ep.sts_token.is_empty() {
        req = req.header("x-oss-security-token", &ep.sts_token);
    }
    let resp = req.send().await.map_err(|e| format!("网络请求失败: {e}"))?;
    check(resp).await?;
    Ok(format!("连接成功，Bucket `{bucket}` 可访问"))
}

pub async fn list_bucket_names(c: &Connection) -> Result<Vec<String>, String> {
    let ep = Endpoint::of(c)?;
    match list_buckets(&ep).await {
        Ok(list) => {
            let mut names: Vec<String> = list.into_iter().map(|b| b.name).collect();
            names.sort();
            Ok(names)
        }
        // 无 ListBuckets 权限但配置了默认 Bucket 时，仍允许浏览该 Bucket
        Err(e) => {
            let fallback = c.database.trim();
            if fallback.is_empty() {
                Err(e)
            } else {
                Ok(vec![fallback.to_string()])
            }
        }
    }
}

async fn list_buckets(ep: &Endpoint) -> Result<Vec<BucketInfo>, String> {
    let params: Vec<(String, String)> = vec![];
    let date = gmt_now();
    let resource = canonical_resource("", "", &params);
    let sig = hmac_sha1(&ep.secret, &string_to_sign("GET", "", &date, &ep.sts_token, &resource));
    let mut req = client(ep)?
        .get(url_of(ep, "", "", &params))
        .header("Date", &date)
        .header("Authorization", format!("OSS {}:{}", ep.access_key, sig));
    if !ep.sts_token.is_empty() {
        req = req.header("x-oss-security-token", &ep.sts_token);
    }
    let resp = check(req.send().await.map_err(|e| format!("网络请求失败: {e}"))?).await?;
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    Ok(blocks(&body, "Bucket")
        .into_iter()
        .map(|b| BucketInfo {
            name: tag(b, "Name").unwrap_or("").to_string(),
            creation_date: tag(b, "CreationDate").unwrap_or("").to_string(),
        })
        .filter(|b| !b.name.is_empty())
        .collect())
}

/// 单页原始列表结果（含续页游标）
struct RawPage {
    objects: Vec<ObjectInfo>,
    next_token: Option<String>,
}

async fn fetch_objects(
    ep: &Endpoint,
    bucket: &str,
    prefix: &str,
    continuation: &str,
    max_keys: u32,
) -> Result<RawPage, String> {
    if bucket.is_empty() {
        return Err("请先选择 Bucket".into());
    }
    let mut params: Vec<(String, String)> = vec![
        ("list-type".into(), "2".into()),
        ("prefix".into(), prefix.to_string()),
        ("delimiter".into(), "/".into()),
        ("max-keys".into(), max_keys.to_string()),
        ("continuation-token".into(), continuation.to_string()),
    ];
    params.retain(|(_, v)| !v.is_empty());
    let date = gmt_now();
    let resource = canonical_resource(bucket, "", &params);
    let sig = hmac_sha1(&ep.secret, &string_to_sign("GET", "", &date, &ep.sts_token, &resource));
    let mut req = client(ep)?
        .get(url_of(ep, bucket, "", &params))
        .header("Date", &date)
        .header("Authorization", format!("OSS {}:{}", ep.access_key, sig));
    if !ep.sts_token.is_empty() {
        req = req.header("x-oss-security-token", &ep.sts_token);
    }
    let resp = check(req.send().await.map_err(|e| format!("网络请求失败: {e}"))?).await?;
    let body = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;

    let mut objects: Vec<ObjectInfo> = blocks(&body, "Contents")
        .into_iter()
        .map(|o| ObjectInfo {
            key: tag(o, "Key").unwrap_or("").to_string(),
            is_folder: false,
            size: tag(o, "Size").and_then(|v| v.parse().ok()).unwrap_or(0),
            last_modified: tag(o, "LastModified").unwrap_or("").to_string(),
            etag: tag(o, "ETag").unwrap_or("").trim_matches('"').to_string(),
            storage_class: tag(o, "StorageClass").unwrap_or("").to_string(),
        })
        .filter(|o| !o.key.is_empty())
        .collect();
    for cp in blocks(&body, "CommonPrefixes") {
        if let Some(p) = tag(cp, "Prefix") {
            objects.push(ObjectInfo {
                key: p.to_string(),
                is_folder: true,
                ..Default::default()
            });
        }
    }
    let next_token = tag(&body, "NextContinuationToken").map(|s| s.to_string());
    Ok(RawPage { objects, next_token })
}

/* ── 列表索引缓存：排序 / 时间筛选 / 分页在服务端完成，翻页不必重复扫描 ── */

/// 索引有效期；过期后下一次请求重新扫描 Bucket
const INDEX_TTL: Duration = Duration::from_secs(30);
const MAX_INDEX_ENTRIES: usize = 16;
/// 单次扫描的对象上限，避免超大 Bucket 长时间阻塞
const MAX_SCAN_OBJECTS: usize = 200_000;
/// 文本预览最多读取的字节数
const MAX_PREVIEW_BYTES: usize = 512 * 1024;

struct IndexEntry {
    created: Instant,
    objects: Vec<ObjectInfo>,
    scan_truncated: bool,
}

fn index_cache() -> &'static Mutex<HashMap<String, IndexEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, IndexEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_get(key: &str) -> Option<(Vec<ObjectInfo>, bool)> {
    let mut cache = index_cache().lock().ok()?;
    let entry = cache.get(key)?;
    if entry.created.elapsed() > INDEX_TTL {
        cache.remove(key);
        return None;
    }
    Some((entry.objects.clone(), entry.scan_truncated))
}

fn cache_put(key: String, objects: Vec<ObjectInfo>, scan_truncated: bool) {
    let Ok(mut cache) = index_cache().lock() else { return };
    if cache.len() >= MAX_INDEX_ENTRIES {
        cache.clear();
    }
    cache.insert(key, IndexEntry { created: Instant::now(), objects, scan_truncated });
}

/// 对象变动（上传 / 删除）后索引失效
fn cache_clear() {
    if let Ok(mut cache) = index_cache().lock() {
        cache.clear();
    }
}

fn parse_time(v: &str, label: &str) -> Result<Option<DateTime<Utc>>, String> {
    let v = v.trim();
    if v.is_empty() {
        return Ok(None);
    }
    DateTime::parse_from_rfc3339(v)
        .map(|d| Some(d.with_timezone(&Utc)))
        .map_err(|_| format!("{label}格式不正确，请使用 ISO 8601（如 2026-01-01T00:00:00Z）"))
}

fn object_time(o: &ObjectInfo) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(o.last_modified.trim())
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn in_range(o: &ObjectInfo, start: Option<DateTime<Utc>>, end: Option<DateTime<Utc>>) -> bool {
    if o.is_folder || (start.is_none() && end.is_none()) {
        return true;
    }
    let Some(t) = object_time(o) else { return true };
    start.map_or(true, |s| t >= s) && end.map_or(true, |e| t <= e)
}

fn sort_objects(list: &mut [ObjectInfo], sort: &str) {
    let by_name = sort.starts_with("name");
    let desc = sort.ends_with("desc");
    list.sort_by(|a, b| {
        if a.is_folder != b.is_folder {
            return if a.is_folder { Ordering::Less } else { Ordering::Greater };
        }
        let ord = if by_name {
            a.key.cmp(&b.key)
        } else {
            let ta = object_time(a);
            let tb = object_time(b);
            ta.cmp(&tb).then_with(|| a.key.cmp(&b.key))
        };
        if desc { ord.reverse() } else { ord }
    });
}

/// 扫描前缀下全部对象并按时间区间过滤（OSS 列表接口不支持时间范围与排序，只能在本地聚合）
async fn scan_objects(
    ep: &Endpoint,
    bucket: &str,
    prefix: &str,
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
) -> Result<(Vec<ObjectInfo>, bool), String> {
    let mut token = String::new();
    let mut objects: Vec<ObjectInfo> = Vec::new();
    let mut scanned = 0usize;
    loop {
        let page = fetch_objects(ep, bucket, prefix, &token, 1000).await?;
        scanned += page.objects.len();
        objects.extend(page.objects.into_iter().filter(|o| in_range(o, start, end)));
        let Some(next) = page.next_token else { break };
        if scanned >= MAX_SCAN_OBJECTS {
            return Ok((objects, true));
        }
        token = next;
    }
    Ok((objects, false))
}

async fn list_page(
    c: &Connection,
    ep: &Endpoint,
    bucket: &str,
    prefix: &str,
    start_raw: &str,
    end_raw: &str,
    sort: &str,
    page: u32,
    page_size: u32,
    refresh: bool,
) -> Result<ObjectListResult, String> {
    if bucket.is_empty() {
        return Err("请先选择 Bucket".into());
    }
    let start = parse_time(start_raw, "开始时间")?;
    let end = parse_time(end_raw, "结束时间")?;
    if let (Some(s), Some(e)) = (start, end) {
        if s > e {
            return Err("开始时间不能晚于结束时间".into());
        }
    }
    let key = format!("{}|{}|{}|{start_raw}|{end_raw}", c.id, bucket, prefix);
    let cached = if refresh { None } else { cache_get(&key) };
    let (mut objects, scan_truncated) = match cached {
        Some(hit) => hit,
        None => {
            let scanned = scan_objects(ep, bucket, prefix, start, end).await?;
            cache_put(key, scanned.0.clone(), scanned.1);
            scanned
        }
    };

    sort_objects(&mut objects, sort);
    let page_size = page_size.clamp(1, 1000);
    let total = objects.len();
    let total_pages = (total + page_size as usize - 1) / page_size as usize;
    let total_pages = total_pages.max(1);
    let page = page.max(1).min(total_pages as u32);
    let begin = (page as usize - 1) * page_size as usize;
    let objects: Vec<ObjectInfo> = objects.into_iter().skip(begin).take(page_size as usize).collect();
    Ok(ObjectListResult {
        prefix: prefix.to_string(),
        objects,
        total,
        page,
        page_size,
        scan_truncated,
    })
}


/// 读取文本类对象内容用于在线预览；超出上限的部分截断
async fn get_object_text(ep: &Endpoint, bucket: &str, key: &str) -> Result<Value, String> {
    if bucket.is_empty() || key.is_empty() {
        return Err("Bucket 与对象 Key 不能为空".into());
    }
    let params: Vec<(String, String)> = vec![];
    let date = gmt_now();
    let resource = canonical_resource(bucket, key, &params);
    let sig = hmac_sha1(&ep.secret, &string_to_sign("GET", "", &date, &ep.sts_token, &resource));
    let mut req = client(ep)?
        .get(url_of(ep, bucket, key, &params))
        .header("Date", &date)
        .header("Authorization", format!("OSS {}:{}", ep.access_key, sig));
    if !ep.sts_token.is_empty() {
        req = req.header("x-oss-security-token", &ep.sts_token);
    }
    let mut resp = check(req.send().await.map_err(|e| format!("网络请求失败: {e}"))?).await?;
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let size = resp.content_length().unwrap_or(0);
    let mut buf: Vec<u8> = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取对象内容失败: {e}"))? {
        let room = MAX_PREVIEW_BYTES.saturating_sub(buf.len());
        if chunk.len() > room {
            buf.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk);
        if buf.len() >= MAX_PREVIEW_BYTES {
            truncated = true;
            break;
        }
    }
    Ok(serde_json::json!({
        "key": key,
        "content_type": content_type,
        "size": size,
        "text": String::from_utf8_lossy(&buf),
        "truncated": truncated,
    }))
}

async fn head_object(ep: &Endpoint, bucket: &str, key: &str) -> Result<Value, String> {
    let params: Vec<(String, String)> = vec![];
    let date = gmt_now();
    let resource = canonical_resource(bucket, key, &params);
    let sig = hmac_sha1(&ep.secret, &string_to_sign("HEAD", "", &date, &ep.sts_token, &resource));
    let mut req = client(ep)?
        .head(url_of(ep, bucket, key, &params))
        .header("Date", &date)
        .header("Authorization", format!("OSS {}:{}", ep.access_key, sig));
    if !ep.sts_token.is_empty() {
        req = req.header("x-oss-security-token", &ep.sts_token);
    }
    let resp = check(req.send().await.map_err(|e| format!("网络请求失败: {e}"))?).await?;
    let h = resp.headers();
    let get = |name: &str| h.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    Ok(serde_json::json!({
        "key": key,
        "size": get("content-length").parse::<u64>().unwrap_or(0),
        "content_type": get("content-type"),
        "etag": get("etag").trim_matches('"').to_string(),
        "last_modified": get("last-modified"),
        "storage_class": get("x-oss-storage-class"),
        "content_md5": get("content-md5"),
    }))
}

async fn delete_object(ep: &Endpoint, bucket: &str, key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("对象 Key 不能为空".into());
    }
    let params: Vec<(String, String)> = vec![];
    let date = gmt_now();
    let resource = canonical_resource(bucket, key, &params);
    let sig = hmac_sha1(&ep.secret, &string_to_sign("DELETE", "", &date, &ep.sts_token, &resource));
    let mut req = client(ep)?
        .delete(url_of(ep, bucket, key, &params))
        .header("Date", &date)
        .header("Authorization", format!("OSS {}:{}", ep.access_key, sig));
    if !ep.sts_token.is_empty() {
        req = req.header("x-oss-security-token", &ep.sts_token);
    }
    check(req.send().await.map_err(|e| format!("网络请求失败: {e}"))?).await?;
    Ok(())
}

/// 生成临时下载地址（签名 URL）
fn presign_url(ep: &Endpoint, bucket: &str, key: &str, expires_secs: i64) -> Result<Value, String> {
    if bucket.is_empty() || key.is_empty() {
        return Err("Bucket 与对象 Key 不能为空".into());
    }
    let expires = chrono::Utc::now().timestamp() + expires_secs.clamp(60, 86400);
    let mut params: Vec<(String, String)> = Vec::new();
    if !ep.sts_token.is_empty() {
        params.push(("security-token".into(), ep.sts_token.clone()));
    }
    let resource = canonical_resource(bucket, key, &params);
    let sig = hmac_sha1(&ep.secret, &string_to_sign("GET", "", &expires.to_string(), "", &resource));
    let mut url = format!(
        "{}?OSSAccessKeyId={}&Expires={}&Signature={}",
        url_of(ep, bucket, key, &[]),
        encode(&ep.access_key),
        expires,
        encode(&sig)
    );
    if !ep.sts_token.is_empty() {
        url.push_str(&format!("&security-token={}", encode(&ep.sts_token)));
    }
    Ok(serde_json::json!({
        "url": url,
        "expires_at": expires * 1000,
    }))
}

async fn upload_file(
    ep: &Endpoint,
    bucket: &str,
    key: &str,
    local_path: &str,
) -> Result<Value, String> {
    if bucket.is_empty() || key.is_empty() {
        return Err("Bucket 与对象 Key 不能为空".into());
    }
    let meta = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| format!("读取本地文件失败: {e}"))?;
    if !meta.is_file() {
        return Err("请选择本地文件而不是目录".into());
    }
    let content_type = mime_guess::from_path(local_path)
        .first_or_octet_stream()
        .to_string();
    let file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("打开本地文件失败: {e}"))?;
    let stream = tokio_util::io::ReaderStream::new(file);
    let body = reqwest::Body::wrap_stream(stream.map_err(std::io::Error::other));

    let params: Vec<(String, String)> = vec![];
    let date = gmt_now();
    let resource = canonical_resource(bucket, key, &params);
    let sig = hmac_sha1(
        &ep.secret,
        &string_to_sign("PUT", &content_type, &date, &ep.sts_token, &resource),
    );
    let mut req = client(ep)?
        .put(url_of(ep, bucket, key, &params))
        .header("Date", &date)
        .header("Content-Type", &content_type)
        .header("Content-Length", meta.len().to_string())
        .header("Authorization", format!("OSS {}:{}", ep.access_key, sig))
        .body(body);
    if !ep.sts_token.is_empty() {
        req = req.header("x-oss-security-token", &ep.sts_token);
    }
    let resp = check(req.send().await.map_err(|e| format!("上传请求失败: {e}"))?).await?;
    Ok(serde_json::json!({
        "key": key,
        "etag": resp.headers().get("etag").and_then(|v| v.to_str().ok()).unwrap_or("").trim_matches('"'),
        "size": meta.len(),
        "content_type": content_type,
    }))
}

async fn download_file(
    ep: &Endpoint,
    bucket: &str,
    key: &str,
    local_path: &str,
) -> Result<Value, String> {
    if bucket.is_empty() || key.is_empty() {
        return Err("Bucket 与对象 Key 不能为空".into());
    }
    let params: Vec<(String, String)> = vec![];
    let date = gmt_now();
    let resource = canonical_resource(bucket, key, &params);
    let sig = hmac_sha1(&ep.secret, &string_to_sign("GET", "", &date, &ep.sts_token, &resource));
    let mut req = client(ep)?
        .get(url_of(ep, bucket, key, &params))
        .header("Date", &date)
        .header("Authorization", format!("OSS {}:{}", ep.access_key, sig));
    if !ep.sts_token.is_empty() {
        req = req.header("x-oss-security-token", &ep.sts_token);
    }
    let mut resp = check(req.send().await.map_err(|e| format!("下载请求失败: {e}"))?).await?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| format!("创建本地文件失败: {e}"))?;
    let mut written: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断: {e}"))? {
        file.write_all(&chunk).await.map_err(|e| format!("写入本地文件失败: {e}"))?;
        written += chunk.len() as u64;
    }
    file.flush().await.map_err(|e| format!("写入本地文件失败: {e}"))?;
    Ok(serde_json::json!({ "key": key, "path": local_path, "size": written, "total": total }))
}

/* ────────────────── 命令入口 ────────────────── */

fn str_field(v: &Value, name: &str) -> String {
    v.get(name).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// 元数据类操作：list_buckets / list_objects / head_object / delete_object / presign_url
pub async fn request(c: &Connection, req: Value) -> Result<Value, String> {
    let ep = Endpoint::of(c)?;
    let action = str_field(&req, "action");
    match action.as_str() {
        "list_buckets" => {
            let buckets = list_buckets(&ep).await?;
            Ok(serde_json::to_value(buckets).map_err(|e| e.to_string())?)
        }
        "list_objects" => {
            let result = list_page(
                c,
                &ep,
                &str_field(&req, "bucket"),
                &str_field(&req, "prefix"),
                &str_field(&req, "start_time"),
                &str_field(&req, "end_time"),
                &str_field(&req, "sort"),
                req.get("page").and_then(|v| v.as_u64()).unwrap_or(1).max(1) as u32,
                req.get("page_size").and_then(|v| v.as_u64()).unwrap_or(100).clamp(1, 1000) as u32,
                req.get("refresh").and_then(|v| v.as_bool()).unwrap_or(false),
            )
            .await?;
            Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
        }
        "get_object_text" => get_object_text(&ep, &str_field(&req, "bucket"), &str_field(&req, "key")).await,
        "head_object" => head_object(&ep, &str_field(&req, "bucket"), &str_field(&req, "key")).await,
        "delete_object" => {
            let result = delete_object(&ep, &str_field(&req, "bucket"), &str_field(&req, "key")).await;
            cache_clear();
            result?;
            Ok(serde_json::json!({ "ok": true }))
        }
        "presign_url" => presign_url(
            &ep,
            &str_field(&req, "bucket"),
            &str_field(&req, "key"),
            req.get("expires_secs").and_then(|v| v.as_i64()).unwrap_or(3600),
        ),
        other => Err(format!("不支持的 OSS 操作: {other}")),
    }
}

/// 文件传输：upload_file / download_file
pub async fn transfer(c: &Connection, req: Value) -> Result<Value, String> {
    let ep = Endpoint::of(c)?;
    let action = str_field(&req, "action");
    let bucket = str_field(&req, "bucket");
    let key = str_field(&req, "key");
    let path = str_field(&req, "local_path");
    match action.as_str() {
        "upload_file" => {
            let result = upload_file(&ep, &bucket, &key, &path).await;
            cache_clear();
            result
        }
        "download_file" => download_file(&ep, &bucket, &key, &path).await,
        other => Err(format!("不支持的 OSS 传输操作: {other}")),
    }
}