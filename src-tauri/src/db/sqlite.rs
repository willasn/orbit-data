//! SQLite 连接器（本地文件型，rusqlite / bundled libsqlite3）。
//!
//! 连接配置约定：`Connection.database` 存放数据库文件绝对路径（支持 `~/` 前缀），
//! host / port / username / password 均不使用。文件必须已存在，「测试连接」即校验文件。

use rusqlite::{types::ValueRef, Connection as SqliteConn, Row};
use std::path::PathBuf;
use std::time::Instant;

use super::{quote_ident, ColumnInfo, QueryResult, Quote, TableInfo};
use crate::config::Connection;

/// 解析文件路径：去空白、展开 `~/`、要求文件存在
fn resolve_path(c: &Connection) -> Result<PathBuf, String> {
    let raw = c.database.trim();
    if raw.is_empty() {
        return Err("未填写 SQLite 文件路径".into());
    }
    let expanded = match raw.strip_prefix("~/") {
        Some(rest) => match std::env::var("HOME") {
            Ok(home) => format!("{home}/{rest}"),
            Err(_) => raw.to_string(),
        },
        None => raw.to_string(),
    };
    let path = PathBuf::from(&expanded);
    if path.is_dir() {
        return Err(format!("路径是目录而不是 SQLite 文件: {expanded}"));
    }
    if !path.exists() {
        return Err(format!("文件不存在: {expanded}"));
    }
    Ok(path)
}

fn open(c: &Connection) -> Result<SqliteConn, String> {
    let path = resolve_path(c)?;
    SqliteConn::open(&path).map_err(|e| format!("打开 SQLite 文件失败: {e}"))
}

/// 在线程池执行同步操作（rusqlite 无异步接口）
async fn blocking<F, T>(c: &Connection, f: F) -> Result<T, String>
where
    F: FnOnce(SqliteConn) -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let cc = c.clone();
    tokio::task::spawn_blocking(move || f(open(&cc)?))
        .await
        .unwrap_or_else(|e| Err(format!("SQLite 任务执行失败: {e}")))
}

/// 单元格解码：与 MySQL / PG 驱动保持同一序列化风格（BLOB 转 0x 十六进制）
fn cell(row: &Row, i: usize) -> serde_json::Value {
    match row.get_ref(i) {
        Ok(ValueRef::Null) | Err(_) => serde_json::Value::Null,
        Ok(ValueRef::Integer(v)) => serde_json::json!(v),
        Ok(ValueRef::Real(v)) => serde_json::json!(v),
        Ok(ValueRef::Text(t)) => serde_json::json!(String::from_utf8_lossy(t).into_owned()),
        Ok(ValueRef::Blob(b)) => {
            let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
            serde_json::json!(format!("0x{hex}"))
        }
    }
}

fn collect_rows(
    stmt: &mut rusqlite::Statement<'_>,
    limit: usize,
) -> Result<QueryResult, String> {
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let n = columns.len();
    let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut mapped = stmt
        .query_map([], |row| Ok((0..n).map(|i| cell(row, i)).collect::<Vec<_>>()))
        .map_err(|e| format!("查询失败: {e}"))?;
    while let Some(r) = mapped.next() {
        if rows.len() >= limit {
            break;
        }
        rows.push(r.map_err(|e| format!("读取结果失败: {e}"))?);
    }
    Ok(QueryResult {
        columns,
        row_count: rows.len(),
        rows,
        duration_ms: 0,
    })
}

pub async fn test(c: &Connection) -> Result<String, String> {
    blocking(c, |db| {
        db.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
            .map_err(|e| format!("文件校验失败（可能不是有效的 SQLite 数据库）: {e}"))?;
        let version: String = db
            .query_row("SELECT sqlite_version()", [], |r| r.get(0))
            .unwrap_or_default();
        Ok(format!("文件校验通过（SQLite {version}）"))
    })
    .await
}

pub async fn list_tables(c: &Connection, _database: &str) -> Result<Vec<TableInfo>, String> {
    blocking(c, |db| {
        let mut stmt = db
            .prepare(
                "SELECT name, type FROM sqlite_master \
                 WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
                 ORDER BY type DESC, name",
            )
            .map_err(|e| format!("获取表列表失败: {e}"))?;
        let mut mapped = stmt
            .query_map([], |r| {
                Ok(TableInfo {
                    name: r.get(0)?,
                    table_type: r.get(1)?,
                })
            })
            .map_err(|e| format!("获取表列表失败: {e}"))?;
        let mut out = Vec::new();
        while let Some(t) = mapped.next() {
            out.push(t.map_err(|e| format!("获取表列表失败: {e}"))?);
        }
        Ok(out)
    })
    .await
}

pub async fn list_columns(
    c: &Connection,
    _database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let table = table.to_string();
    blocking(c, move |db| {
        let sql = format!(
            "PRAGMA table_info({})",
            quote_ident(Quote::Double, &table)
        );
        let mut stmt = db
            .prepare(&sql)
            .map_err(|e| format!("获取列信息失败: {e}"))?;
        let mut mapped = stmt
            .query_map([], |r| {
                let pk: i64 = r.get(5)?;
                Ok(ColumnInfo {
                    name: r.get(1)?,
                    data_type: r.get(2)?,
                    nullable: r.get::<_, i64>(3)? == 0,
                    key: if pk > 0 { "PRI".into() } else { String::new() },
                    comment: String::new(),
                })
            })
            .map_err(|e| format!("获取列信息失败: {e}"))?;
        let mut out = Vec::new();
        while let Some(col) = mapped.next() {
            out.push(col.map_err(|e| format!("获取列信息失败: {e}"))?);
        }
        Ok(out)
    })
    .await
}

/// 是否存在第一条完整语句之后的剩余 SQL（即多条语句脚本）。
/// 逐字符扫描，跳过 `'` 字符串、`"` 标识符与 `--` / `/* */` 注释后再找分号。
fn has_extra_statements(sql: &str) -> bool {
    let b = sql.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        match b[i] {
            b'\'' | b'"' => {
                let q = b[i];
                i += 1;
                while i < b.len() {
                    if b[i] == q {
                        if i + 1 < b.len() && b[i + 1] == q {
                            i += 2; // 转义的同名引号
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            b'-' if i + 1 < b.len() && b[i + 1] == b'-' => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < b.len() && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            b';' => {
                if !sql[i + 1..].trim().trim_end_matches(';').trim().is_empty() {
                    return true;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    false
}

pub async fn query(
    c: &Connection,
    _database: &str,
    sql: &str,
    limit: usize,
) -> Result<QueryResult, String> {
    let sql = sql.to_string();
    blocking(c, move |db| {
        let start = Instant::now();
        let finish = |r: QueryResult| QueryResult {
            duration_ms: start.elapsed().as_millis() as u64,
            ..r
        };
        // rusqlite 0.32 的 prepare 会静默丢弃首条之后的语句，先识别多语句脚本
        if has_extra_statements(&sql) {
            db.execute_batch(&sql)
                .map_err(|e| format!("执行失败: {e}"))?;
            return Ok(finish(QueryResult::default()));
        }
        let mut stmt = db.prepare(&sql).map_err(|e| format!("执行失败: {e}"))?;
        if stmt.column_count() > 0 {
            // 有结果集：SELECT / PRAGMA / EXPLAIN 等
            return Ok(finish(collect_rows(&mut stmt, limit)?));
        }
        // 单条无结果集语句（DDL / DML）
        stmt.execute([]).map_err(|e| format!("执行失败: {e}"))?;
        Ok(finish(QueryResult::default()))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// 构造带表 / 视图 / 索引 / 数据的临时数据库文件
    fn fixture(name: &str) -> (Connection, PathBuf) {
        let path = std::env::temp_dir().join(format!("orbitdata_sqlite_{name}.db"));
        let _ = std::fs::remove_file(&path);
        let db = SqliteConn::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, score REAL);
             CREATE INDEX idx_users_name ON users(name);
             CREATE VIEW adult_users AS SELECT id, name FROM users WHERE age >= 18;
             INSERT INTO users (name, age, score) VALUES ('alice', 30, 91.5), ('bob', 17, 78.0), ('carol', 25, 88.25);",
        )
        .unwrap();
        drop(db);
        let mut c = Connection::default();
        c.db_type = "sqlite".into();
        c.database = path.to_string_lossy().into_owned();
        (c, path)
    }

    #[tokio::test]
    async fn test_connection_and_bad_path() {
        let (c, path) = fixture("test_conn");
        let msg = test(&c).await.unwrap();
        assert!(msg.contains("SQLite"), "got: {msg}");

        let mut missing = c.clone();
        missing.database = "/tmp/orbitdata_sqlite_not_exists.db".into();
        assert!(test(&missing).await.unwrap_err().contains("文件不存在"));

        let mut dir = c.clone();
        dir.database = "/tmp".into();
        assert!(test(&dir).await.unwrap_err().contains("目录"));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn lists_tables_and_columns() {
        let (c, path) = fixture("tree");
        let tables = list_tables(&c, "").await.unwrap();
        let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"users") && names.contains(&"adult_users"));
        assert!(!names.iter().any(|n| n.starts_with("sqlite_")));
        let view = tables.iter().find(|t| t.name == "adult_users").unwrap();
        assert_eq!(view.table_type, "view");

        let cols = list_columns(&c, "", "users").await.unwrap();
        assert_eq!(cols.len(), 4);
        assert_eq!(cols[0].name, "id");
        assert_eq!(cols[0].key, "PRI");
        assert_eq!(cols[1].data_type, "TEXT");
        assert!(cols[1].nullable == false && cols[2].nullable == true);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn query_select_pragma_explain() {
        let (c, path) = fixture("select");
        let r = query(&c, "", "SELECT id, name, age, score FROM users ORDER BY id", 500)
            .await
            .unwrap();
        assert_eq!(r.columns, vec!["id", "name", "age", "score"]);
        assert_eq!(r.row_count, 3);
        assert_eq!(r.rows[0][1], Value::String("alice".into()));
        assert_eq!(r.rows[0][0], serde_json::json!(1));
        assert_eq!(r.rows[1][2], serde_json::json!(17));

        // 行数限制
        let limited = query(&c, "", "SELECT * FROM users", 2).await.unwrap();
        assert_eq!(limited.row_count, 2);

        // NULL 单元格
        let r2 = query(&c, "", "SELECT NULL AS n", 10).await.unwrap();
        assert_eq!(r2.rows[0][0], Value::Null);

        // PRAGMA（查看索引入口）
        let idx = query(&c, "", "PRAGMA index_list(\"users\")", 100).await.unwrap();
        assert!(idx.row_count >= 1);

        // EXPLAIN
        let plan = query(&c, "", "EXPLAIN SELECT * FROM users", 100).await.unwrap();
        assert!(plan.row_count > 0);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn ddl_dml_and_multi_statement_scripts() {
        let (c, path) = fixture("dml");
        // DDL：建表
        let r = query(
            &c,
            "",
            "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)",
            100,
        )
        .await
        .unwrap();
        assert_eq!(r.row_count, 0);
        // DML：写入 / 更新 / 删除
        query(&c, "", "INSERT INTO notes (title) VALUES ('hello')", 100)
            .await
            .unwrap();
        query(&c, "", "UPDATE notes SET title = 'hi' WHERE id = 1", 100)
            .await
            .unwrap();
        let r = query(&c, "", "SELECT title FROM notes", 100).await.unwrap();
        assert_eq!(r.rows[0][0], Value::String("hi".into()));
        query(&c, "", "DELETE FROM notes WHERE id = 1", 100)
            .await
            .unwrap();
        let r = query(&c, "", "SELECT COUNT(*) AS n FROM notes", 100).await.unwrap();
        assert_eq!(r.rows[0][0], serde_json::json!(0));

        // 多条语句脚本（AI 生成的建库脚本常见形态）
        query(
            &c,
            "",
            "CREATE TABLE t2(a INTEGER); INSERT INTO t2 VALUES (1); INSERT INTO t2 VALUES (2);",
            100,
        )
        .await
        .unwrap();
        let r = query(&c, "", "SELECT SUM(a) AS s FROM t2", 100).await.unwrap();
        assert_eq!(r.rows[0][0], serde_json::json!(3));

        // 语法错误应返回错误而非 panic
        assert!(query(&c, "", "SELCT bad syntax", 100).await.is_err());
        let _ = std::fs::remove_file(path);
    }
}
