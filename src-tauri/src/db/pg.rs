use sqlx::postgres::{PgPoolOptions, PgRow};
use sqlx::{Column, Row, ValueRef};
use std::sync::Arc;
use std::time::Instant;
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use super::{ColumnInfo, QueryResult, TableInfo};
use crate::config::Connection;

fn enc(s: &str) -> String {
    urlencoding::encode(s).into_owned()
}

/// 连接句柄：TLS 直连隧道需随连接池一同释放
pub struct PgHandle {
    pool: sqlx::postgres::PgPool,
    tunnel: Option<JoinHandle<()>>,
}

impl std::ops::Deref for PgHandle {
    type Target = sqlx::postgres::PgPool;
    fn deref(&self) -> &Self::Target {
        &self.pool
    }
}

impl Drop for PgHandle {
    fn drop(&mut self) {
        if let Some(task) = self.tunnel.take() {
            task.abort();
        }
    }
}

fn pool_options() -> PgPoolOptions {
    PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(10))
}

fn db_name(c: &Connection, database: &str) -> String {
    if !database.is_empty() {
        database.to_string()
    } else if !c.database.is_empty() {
        c.database.clone()
    } else {
        "postgres".to_string()
    }
}

fn conn_url(c: &Connection, host: &str, port: u16, db: &str, ssl_mode: Option<&str>) -> String {
    let url = format!(
        "postgres://{}:{}@{}:{}/{}",
        enc(&c.username),
        enc(&c.password),
        host,
        port,
        enc(db)
    );
    match ssl_mode {
        Some(mode) => format!("{url}?sslmode={mode}"),
        None => url,
    }
}

pub async fn connect(c: &Connection, database: &str) -> Result<PgHandle, String> {
    let db = db_name(c, database);
    // TLS：require 只加密不校验证书（适配自签 / 未包含当前 IP 的证书），
    // verify-full 同时校验证书链与主机名（支持证书 SAN 中的 IP 地址）
    let ssl_mode = match c.tls {
        Some(true) if c.tls_skip_verify => Some("require"),
        Some(true) => Some("verify-full"),
        Some(false) => Some("disable"),
        None => None,
    };
    let url = conn_url(c, &c.host, c.port, &db, ssl_mode);
    match pool_options().connect(&url).await {
        Ok(pool) => Ok(PgHandle { pool, tunnel: None }),
        // 部分网关在 TLS 终止后要求直接发送 StartupMessage，不支持标准 SSLRequest 协商，
        // 会在收到 8 字节 SSLRequest 时直接断开；此时改走本机 TLS 隧道重试
        Err(e) if c.tls == Some(true) && is_handshake_reset(&e) => {
            connect_via_tls_tunnel(c, &db).await
        }
        Err(e) => Err(format!("PostgreSQL 连接失败: {e}")),
    }
}

fn is_handshake_reset(e: &sqlx::Error) -> bool {
    let msg = e.to_string();
    [
        "Connection reset by peer",
        "unexpected EOF",
        "server closed the connection",
        "Broken pipe",
    ]
    .iter()
    .any(|k| msg.contains(k))
}

/// 本机随机端口上的 TCP → TLS 转发：sqlx 以明文说 PG 协议，由隧道包进 TLS 通道。
/// 适用于 TLS 终止型代理（先 TLS 握手，之后直接收 StartupMessage）。
async fn connect_via_tls_tunnel(c: &Connection, db: &str) -> Result<PgHandle, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("PostgreSQL 连接失败: 无法建立本地 TLS 隧道: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("PostgreSQL 连接失败: 无法获取隧道端口: {e}"))?
        .port();
    let server_name = rustls::pki_types::ServerName::try_from(c.host.clone())
        .map_err(|e| format!("PostgreSQL 连接失败: 主机名非法: {e}"))?;
    let host = c.host.clone();
    let remote_port = c.port;
    let skip_verify = c.tls_skip_verify;

    let task = tokio::spawn(async move {
        while let Ok((mut inbound, _)) = listener.accept().await {
            let server_name = server_name.clone();
            let host = host.clone();
            tokio::spawn(async move {
                let Ok(outbound) = TcpStream::connect((host.as_str(), remote_port)).await else {
                    return;
                };
                let Ok(mut stream) = tls_connect(outbound, server_name, skip_verify).await else {
                    return;
                };
                let _ = copy_bidirectional(&mut inbound, &mut stream).await;
            });
        }
    });

    let url = conn_url(c, "127.0.0.1", port, db, Some("disable"));
    let pool = pool_options()
        .connect(&url)
        .await
        .map_err(|e| format!("PostgreSQL 连接失败: {e}"))?;
    Ok(PgHandle {
        pool,
        tunnel: Some(task),
    })
}

async fn tls_connect(
    stream: TcpStream,
    server_name: rustls::pki_types::ServerName<'static>,
    skip_verify: bool,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let config = tls_client_config(skip_verify)?;
    tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(server_name, stream)
        .await
        .map_err(|e| format!("TLS 握手失败: {e}"))
}

fn tls_client_config(skip_verify: bool) -> Result<rustls::ClientConfig, String> {
    // 显式指定 ring provider：不依赖进程级 install_default（单测环境未安装会 panic）
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = if skip_verify {
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("TLS 配置失败: {e}"))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoVerify))
            .with_no_client_auth()
    } else {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("TLS 配置失败: {e}"))?
            .with_root_certificates(roots)
            .with_no_client_auth()
    };
    Ok(config)
}

/// 跳过服务器证书校验（对齐 sqlx 的 sslmode=require）
#[derive(Debug)]
struct NoVerify;

impl rustls::client::danger::ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
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
    // PostgreSQL 数组类型（text[] / int[] / float8[] / bool[]）
    try_get!(Vec<String>, |v| serde_json::json!(v));
    try_get!(Vec<i64>, |v| serde_json::json!(v));
    try_get!(Vec<f64>, |v| serde_json::json!(v));
    try_get!(Vec<bool>, |v| serde_json::json!(v));
    if let Ok(bytes) = row.try_get::<Vec<u8>, _>(i) {
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        return serde_json::json!(format!("0x{hex}"));
    }
    serde_json::Value::Null
}

pub async fn test(c: &Connection) -> Result<String, String> {
    let pool = connect(c, "").await?;
    sqlx::query("SELECT 1")
        .execute(&*pool)
        .await
        .map_err(|e| format!("测试查询失败: {e}"))?;
    Ok("连接成功".into())
}

pub async fn list_databases(c: &Connection) -> Result<Vec<String>, String> {
    let pool = connect(c, "").await?;
    let rows = sqlx::query(
        "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| format!("获取数据库列表失败: {e}"))?;
    Ok(rows
        .iter()
        .map(|r| cell(r, 0).as_str().unwrap_or_default().to_string())
        .collect())
}

/// 表 / 视图 / 物化视图列表：覆盖当前 schema 之外的用户 schema，非当前 schema 用 `schema.table` 展示
pub async fn list_tables(c: &Connection, database: &str) -> Result<Vec<TableInfo>, String> {
    let pool = connect(c, database).await?;
    let rows = sqlx::query(
        "SELECT CASE WHEN n.nspname = COALESCE(current_schema(), 'public') \
                     THEN cl.relname ELSE n.nspname || '.' || cl.relname END AS name, \
                CASE cl.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' ELSE 'table' END AS type \
         FROM pg_catalog.pg_class cl \
         JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace \
         WHERE cl.relkind IN ('r', 'p', 'v', 'm', 'f') \
           AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
           AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' \
         ORDER BY (n.nspname <> COALESCE(current_schema(), 'public')), n.nspname, cl.relname",
    )
    .fetch_all(&*pool)
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
    // 非当前 schema 的表以 schema.table 形式传入，拆开后按 schema 精确定位
    let (schema, name) = match table.split_once('.') {
        Some((s, t)) if !s.is_empty() && !t.is_empty() => (Some(s), t),
        _ => (None, table),
    };
    let rows = sqlx::query(
        "SELECT a.attname::text AS column_name, \
                pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, \
                CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable, \
                CASE WHEN pk.attnum IS NOT NULL THEN 'PRI' ELSE '' END AS column_key, \
                COALESCE(pg_catalog.col_description(a.attrelid, a.attnum), '') AS comment \
         FROM pg_catalog.pg_attribute a \
         JOIN pg_catalog.pg_class cl ON cl.oid = a.attrelid \
         JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace \
         LEFT JOIN ( \
           SELECT i.indrelid, unnest(i.indkey::smallint[]) AS attnum \
           FROM pg_catalog.pg_index i WHERE i.indisprimary \
         ) pk ON pk.indrelid = a.attrelid AND pk.attnum = a.attnum \
         WHERE cl.relname = $1 \
           AND n.nspname = COALESCE($2, COALESCE(current_schema(), 'public')) \
           AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
    )
    .bind(name)
    .bind(schema)
    .fetch_all(&*pool)
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
        .fetch_all(&*pool)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{GridCell, RowUpdate};

    fn conn_from_env() -> Option<Connection> {
        let host = std::env::var("PG_TEST_HOST").ok()?;
        Some(Connection {
            id: "pg-live-test".into(),
            name: "PostgreSQL 测试".into(),
            db_type: "postgres".into(),
            host,
            port: std::env::var("PG_TEST_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(5432),
            username: std::env::var("PG_TEST_USER").unwrap_or_default(),
            password: std::env::var("PG_TEST_PASSWORD").unwrap_or_default(),
            database: std::env::var("PG_TEST_DATABASE").unwrap_or_else(|_| "postgres".into()),
            tls: Some(std::env::var("PG_TEST_TLS").map(|v| v == "1").unwrap_or(false)),
            tls_skip_verify: std::env::var("PG_TEST_TLS_SKIP_VERIFY")
                .map(|v| v == "1")
                .unwrap_or(false),
            ..Default::default()
        })
    }

    async fn exec(c: &Connection, db: &str, sql: &str) {
        query(c, db, sql, 1).await.unwrap_or_else(|e| panic!("执行失败: {sql}\n{e}"));
    }

    /// 真实实例联调：通过 PG_TEST_HOST 等环境变量提供连接信息，默认跳过。
    /// 覆盖：连接测试 / 库列表 / 表-视图-物化视图 / 列元数据(类型/主键/注释) / 查询与取值 /
    /// 结果集按主键更新 / 结构 SQL / 索引 SQL / EXPLAIN / 行计数 / 建库删库 / 建表删表。
    /// 测试夹具保留在 orbitdata_it schema 中，便于人工复核。
    #[tokio::test]
    #[ignore = "需要 PG_TEST_HOST 指向真实 PostgreSQL 实例"]
    async fn live_smoke() {
        let Some(c) = conn_from_env() else {
            return;
        };
        let db = c.database.clone();

        assert_eq!(test(&c).await.expect("连接测试失败"), "连接成功");

        let dbs = list_databases(&c).await.expect("库列表失败");
        assert!(dbs.contains(&db), "库列表缺少 {db}: {dbs:?}");

        // 夹具：跨 schema 的表 / 视图 / 物化视图 / 注释 / 索引 / 多类型列
        for sql in [
            "DROP MATERIALIZED VIEW IF EXISTS orbitdata_it.orbitdata_pg_mv",
            "DROP VIEW IF EXISTS orbitdata_it.orbitdata_pg_view",
            "DROP TABLE IF EXISTS orbitdata_it.orbitdata_pg_types",
            "DROP TABLE IF EXISTS public.orbitdata_pg_public",
            "DROP SCHEMA IF EXISTS orbitdata_it CASCADE",
            "CREATE SCHEMA orbitdata_it",
            "CREATE TABLE orbitdata_it.orbitdata_pg_types (\
               id bigserial PRIMARY KEY, name varchar(64) NOT NULL, price numeric(10,2), \
               active boolean DEFAULT true, created_at timestamptz DEFAULT now(), \
               payload jsonb, tags text[])",
            "COMMENT ON TABLE orbitdata_it.orbitdata_pg_types IS '类型测试表'",
            "COMMENT ON COLUMN orbitdata_it.orbitdata_pg_types.price IS '单价'",
            "CREATE INDEX orbitdata_pg_types_name_idx ON orbitdata_it.orbitdata_pg_types (name)",
            "INSERT INTO orbitdata_it.orbitdata_pg_types (name, price, active, payload, tags) VALUES \
               ('alpha', 12.50, true, '{\"k\": 1}'::jsonb, ARRAY['a','b']), \
               ('beta', NULL, false, NULL, NULL)",
            "CREATE VIEW orbitdata_it.orbitdata_pg_view AS SELECT id, name FROM orbitdata_it.orbitdata_pg_types",
            "CREATE MATERIALIZED VIEW orbitdata_it.orbitdata_pg_mv AS \
               SELECT count(*)::bigint AS total FROM orbitdata_it.orbitdata_pg_types",
            "CREATE TABLE public.orbitdata_pg_public (id int PRIMARY KEY, note text)",
        ] {
            exec(&c, &db, sql).await;
        }

        // 表 / 视图 / 物化视图
        let tables = list_tables(&c, &db).await.expect("表列表失败");
        let kind_of = |name: &str| {
            tables
                .iter()
                .find(|t| t.name == name)
                .map(|t| t.table_type.as_str())
                .unwrap_or_else(|| panic!("缺少 {name}: {:?}", tables.iter().map(|t| &t.name).collect::<Vec<_>>()))
        };
        assert_eq!(kind_of("orbitdata_it.orbitdata_pg_types"), "table");
        assert_eq!(kind_of("orbitdata_it.orbitdata_pg_view"), "view");
        assert_eq!(kind_of("orbitdata_it.orbitdata_pg_mv"), "matview");
        // 当前 schema 的表不带前缀，非当前 schema 带 schema 前缀
        let cur_schema = query(&c, &db, "SELECT current_schema()", 1)
            .await
            .expect("current_schema 失败")
            .rows[0][0]
            .as_str()
            .unwrap_or("public")
            .to_string();
        let public_ref = if cur_schema == "public" {
            "orbitdata_pg_public".to_string()
        } else {
            "public.orbitdata_pg_public".to_string()
        };
        assert_eq!(kind_of(&public_ref), "table");

        // 列元数据：类型 / 可空 / 主键 / 注释
        let cols = list_columns(&c, &db, "orbitdata_it.orbitdata_pg_types")
            .await
            .expect("列信息失败");
        let col = |name: &str| cols.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("缺少列 {name}"));
        assert_eq!(cols.len(), 7);
        assert_eq!(col("id").data_type, "bigint");
        assert_eq!(col("id").key, "PRI");
        assert!(!col("id").nullable);
        assert_eq!(col("name").data_type, "character varying(64)");
        assert!(!col("name").nullable);
        assert_eq!(col("price").data_type, "numeric(10,2)");
        assert_eq!(col("price").comment, "单价");
        assert_eq!(col("payload").data_type, "jsonb");
        assert_eq!(col("tags").data_type, "text[]");
        // 不带 schema 前缀时按当前 schema 查（公开表）
        let public_cols = list_columns(&c, &db, &public_ref).await.expect("公开表列信息失败");
        assert_eq!(public_cols.len(), 2);
        assert_eq!(public_cols[0].key, "PRI");

        // 查询：多类型取值 + 行数上限
        let result = query(
            &c,
            &db,
            "SELECT id, name, price, active, payload, tags FROM orbitdata_it.orbitdata_pg_types ORDER BY id",
            100,
        )
        .await
        .expect("查询失败");
        assert_eq!(result.row_count, 2);
        assert_eq!(result.columns[1], "name");
        assert_eq!(result.rows[0][1], serde_json::json!("alpha"));
        assert_eq!(result.rows[0][2], serde_json::json!("12.50"));
        assert_eq!(result.rows[0][3], serde_json::json!(true));
        assert_eq!(result.rows[0][4], serde_json::json!({"k": 1}));
        assert_eq!(result.rows[0][5], serde_json::json!(["a", "b"]));
        let limited = query(&c, &db, "SELECT id FROM orbitdata_it.orbitdata_pg_types ORDER BY id", 1)
            .await
            .expect("限量查询失败");
        assert_eq!(limited.row_count, 1);

        // 结果集按主键更新（非 public schema 的限定名）
        let affected = update_rows(
            &c,
            &db,
            "orbitdata_it.orbitdata_pg_types",
            &[RowUpdate {
                keys: vec![GridCell { column: "id".into(), value: serde_json::json!(1) }],
                values: vec![GridCell { column: "name".into(), value: serde_json::json!("alpha-updated") }],
            }],
        )
        .await
        .expect("更新失败");
        assert_eq!(affected, 1);
        let updated = query(
            &c,
            &db,
            "SELECT name FROM orbitdata_it.orbitdata_pg_types WHERE id = 1",
            1,
        )
        .await
        .expect("回查失败");
        assert_eq!(updated.rows[0][0], serde_json::json!("alpha-updated"));

        // 右键菜单：查看结构 / 索引 / EXPLAIN / 行计数
        let structure = query(
            &c,
            &db,
            "SELECT column_name, data_type, is_nullable, column_default \
             FROM information_schema.columns \
             WHERE table_schema = 'orbitdata_it' AND table_name = 'orbitdata_pg_types' \
             ORDER BY ordinal_position",
            100,
        )
        .await
        .expect("查看结构失败");
        assert_eq!(structure.row_count, 7);
        let indexes = query(
            &c,
            &db,
            "SELECT indexname, indexdef FROM pg_indexes \
             WHERE schemaname = 'orbitdata_it' AND tablename = 'orbitdata_pg_types' ORDER BY indexname",
            100,
        )
        .await
        .expect("索引查询失败");
        assert!(indexes.rows.iter().any(|r| r[0] == serde_json::json!("orbitdata_pg_types_pkey")));
        assert!(indexes.rows.iter().any(|r| r[0] == serde_json::json!("orbitdata_pg_types_name_idx")));
        let plan = query(&c, &db, "EXPLAIN SELECT * FROM orbitdata_it.orbitdata_pg_types", 100)
            .await
            .expect("EXPLAIN 失败");
        assert!(plan.row_count > 0);
        let count = query(&c, &db, "SELECT COUNT(*) FROM orbitdata_it.orbitdata_pg_types", 1)
            .await
            .expect("行计数失败");
        assert_eq!(count.rows[0][0], serde_json::json!(2));

        // 建库 / 删库 / 建表 / 删表
        exec(&c, &db, "DROP DATABASE IF EXISTS orbitdata_pg_itdb").await;
        exec(&c, &db, "CREATE DATABASE orbitdata_pg_itdb").await;
        let dbs = list_databases(&c).await.expect("库列表失败");
        assert!(dbs.contains(&"orbitdata_pg_itdb".to_string()));
        exec(&c, &db, "DROP DATABASE orbitdata_pg_itdb").await;
        exec(
            &c,
            &db,
            "CREATE TABLE orbitdata_it.orbitdata_pg_created (id serial PRIMARY KEY, v text)",
        )
        .await;
        let tables = list_tables(&c, &db).await.expect("表列表失败");
        assert!(tables.iter().any(|t| t.name == "orbitdata_it.orbitdata_pg_created"));
        exec(&c, &db, "DROP TABLE orbitdata_it.orbitdata_pg_created").await;
    }

    /// 演示数据：在 orbitdata_demo schema 下建表 / 视图 / 物化视图 / 索引并写入样例数据，
    /// 另在 public 下留一张表用于验证「当前 schema 不带前缀」的展示。可重复执行（先删后建）。
    #[tokio::test]
    #[ignore = "需要 PG_TEST_HOST 指向真实 PostgreSQL 实例"]
    async fn seed_demo_data() {
        let Some(c) = conn_from_env() else {
            return;
        };
        let db = c.database.clone();

        for sql in [
            "DROP SCHEMA IF EXISTS orbitdata_demo CASCADE",
            "CREATE SCHEMA orbitdata_demo",
            "CREATE TABLE orbitdata_demo.customers (\
               id serial PRIMARY KEY, name text NOT NULL, email text UNIQUE, \
               level text NOT NULL DEFAULT 'basic', balance numeric(12,2) NOT NULL DEFAULT 0, \
               tags text[], active boolean NOT NULL DEFAULT true, profile jsonb, \
               created_at timestamptz NOT NULL DEFAULT now())",
            "COMMENT ON TABLE orbitdata_demo.customers IS '演示客户表'",
            "COMMENT ON COLUMN orbitdata_demo.customers.level IS '客户等级：basic / silver / gold'",
            "COMMENT ON COLUMN orbitdata_demo.customers.balance IS '账户余额（元）'",
            "CREATE TABLE orbitdata_demo.orders (\
               id bigserial PRIMARY KEY, customer_id int NOT NULL REFERENCES orbitdata_demo.customers(id), \
               amount numeric(12,2) NOT NULL, status text NOT NULL, \
               created_at timestamptz NOT NULL DEFAULT now())",
            "COMMENT ON COLUMN orbitdata_demo.orders.status IS '订单状态：pending / paid / shipped / done / cancelled'",
            "CREATE INDEX orbitdata_demo_orders_customer_idx ON orbitdata_demo.orders (customer_id)",
            "INSERT INTO orbitdata_demo.customers (name, email, level, balance, tags, active, profile) \
             SELECT '客户' || i, 'user' || i || '@example.com', \
                    (ARRAY['basic','silver','gold'])[1 + i % 3], \
                    round((random() * 10000)::numeric, 2), \
                    ARRAY['tag' || (i % 5), 'demo'], i % 7 <> 0, \
                    jsonb_build_object('city', (ARRAY['北京','上海','深圳','杭州','成都'])[1 + i % 5], 'age', 20 + i % 40) \
             FROM generate_series(1, 30) AS i",
            "INSERT INTO orbitdata_demo.orders (customer_id, amount, status, created_at) \
             SELECT 1 + (i % 30), round((random() * 500 + 10)::numeric, 2), \
                    (ARRAY['pending','paid','shipped','done','cancelled'])[1 + i % 5], \
                    now() - (i || ' hours')::interval \
             FROM generate_series(1, 120) AS i",
            "CREATE VIEW orbitdata_demo.v_customer_stats AS \
             SELECT c.id, c.name, c.level, count(o.id) AS order_count, \
                    COALESCE(sum(o.amount), 0)::numeric(14,2) AS total_amount \
             FROM orbitdata_demo.customers c \
             LEFT JOIN orbitdata_demo.orders o ON o.customer_id = c.id \
             GROUP BY c.id, c.name, c.level",
            "CREATE MATERIALIZED VIEW orbitdata_demo.mv_daily_orders AS \
             SELECT date_trunc('day', created_at)::date AS day, count(*) AS order_count, \
                    sum(amount)::numeric(14,2) AS amount \
             FROM orbitdata_demo.orders GROUP BY 1",
            "CREATE INDEX mv_daily_orders_day_idx ON orbitdata_demo.mv_daily_orders (day)",
            "DROP TABLE IF EXISTS public.orbitdata_demo_public",
            "CREATE TABLE public.orbitdata_demo_public (\
               id int PRIMARY KEY, note text, updated_at timestamptz DEFAULT now())",
            "INSERT INTO public.orbitdata_demo_public (id, note) \
             SELECT i, '当前 schema 演示数据 #' || i FROM generate_series(1, 5) AS i",
        ] {
            exec(&c, &db, sql).await;
        }

        let tables = list_tables(&c, &db).await.expect("表列表失败");
        let has = |name: &str, kind: &str| {
            let t = tables.iter().find(|t| t.name == name);
            assert_eq!(
                t.map(|t| t.table_type.as_str()),
                Some(kind),
                "缺少 {name}（{kind}）"
            );
        };
        has("orbitdata_demo.customers", "table");
        has("orbitdata_demo.orders", "table");
        has("orbitdata_demo.v_customer_stats", "view");
        has("orbitdata_demo.mv_daily_orders", "matview");

        let count = |sql: &'static str| async {
            query(&c, &db, sql, 1).await.expect("计数失败").rows[0][0].clone()
        };
        assert_eq!(count("SELECT COUNT(*) FROM orbitdata_demo.customers").await, serde_json::json!(30));
        assert_eq!(count("SELECT COUNT(*) FROM orbitdata_demo.orders").await, serde_json::json!(120));
        assert_eq!(count("SELECT COUNT(*) FROM orbitdata_demo.v_customer_stats").await, serde_json::json!(30));
        assert_eq!(count("SELECT COUNT(*) FROM orbitdata_demo.mv_daily_orders").await, serde_json::json!(6));

        let cols = list_columns(&c, &db, "orbitdata_demo.customers").await.expect("列信息失败");
        assert_eq!(cols.len(), 9);
        assert_eq!(cols[0].key, "PRI");
        assert_eq!(cols[3].comment, "客户等级：basic / silver / gold");

        println!(
            "演示数据已就绪：schema=orbitdata_demo，customers 30 行 / orders 120 行 / 视图 1 / 物化视图 1；public.orbitdata_demo_public 5 行"
        );
    }
}
