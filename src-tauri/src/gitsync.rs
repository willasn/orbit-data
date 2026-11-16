//! Git 同步（FEATURE.md §6）。
//!
//! 使用 git2（内置 libgit2）实现，不依赖系统安装的 git。同步文件包含连接信息与
//! AI 模型配置；Git 凭据只保存在本机配置中，不写入同步文件。
//!
//! 单按钮同步流程：拉取远程分支 → 合并本地与远程配置 → 提交并推送。连接以
//! 「主机 + 端口 + 名称」判定是否为同一条；同一连接内容不同时视为冲突，由用户
//! 选择保留远程或本地。

use crate::config::{AppConfig, Connection, ModelConfig, SyncConfig};
use git2::{
    build::CheckoutBuilder, Cred, Direction, FetchOptions, Oid, PushOptions, RemoteCallbacks,
    Repository, ResetType, Signature,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

/// 同步文件名：包含连接信息 + AI 模型配置（不含 Git 凭据）
const SYNC_FILE: &str = "orbit-data-sync.json";
const REMOTE: &str = "origin";
const DEFAULT_BRANCH: &str = "main";

/// 写入同步文件的内容；刻意不包含 `sync`（远程地址、用户名、密码、邮箱）
#[derive(Serialize, Deserialize, Default)]
struct SyncPayload {
    #[serde(default)]
    connections: Vec<Connection>,
    #[serde(default)]
    models: Vec<ModelConfig>,
    #[serde(default)]
    active_model_id: String,
}

/// 冲突的连接（主机、端口、名称相同但其余配置不同）
#[derive(Debug, Clone, Serialize)]
pub struct SyncConflict {
    pub name: String,
    pub host: String,
    pub port: u16,
}

/// 同步结果；`needs_choice` 为 true 时表示需要前端选择保留远程还是本地
#[derive(Debug, Clone, Serialize)]
pub struct SyncOutcome {
    pub needs_choice: bool,
    pub message: String,
    pub conflicts: Vec<SyncConflict>,
}

fn branch_name(sync: &SyncConfig) -> &str {
    let branch = sync.branch.trim();
    if branch.is_empty() {
        DEFAULT_BRANCH
    } else {
        branch
    }
}

fn validate(sync: &SyncConfig) -> Result<(), String> {
    if sync.remote_url.trim().is_empty() {
        return Err("请填写远程仓库 URL".into());
    }
    if sync.username.trim().is_empty() {
        return Err("请填写 Git 用户名".into());
    }
    if sync.password.is_empty() {
        return Err("请填写 Git 密码或访问令牌".into());
    }
    if sync.email.trim().is_empty() {
        return Err("请填写提交邮箱".into());
    }
    Ok(())
}

/// 用户名 + 密码（或访问令牌）认证回调
fn credentials(sync: &SyncConfig) -> RemoteCallbacks<'static> {
    let username = sync.username.trim().to_string();
    let password = sync.password.clone();
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, _username_from_url, _allowed| {
        Cred::userpass_plaintext(&username, &password)
    });
    callbacks
}

/// 打开（或初始化）内置同步仓库，并确保 origin 指向配置的远程地址
fn open_repo(dir: &Path, sync: &SyncConfig) -> Result<Repository, String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建同步目录失败: {e}"))?;
    let repo = match Repository::open(dir) {
        Ok(repo) => repo,
        Err(_) => Repository::init(dir).map_err(|e| format!("初始化同步仓库失败: {e}"))?,
    };

    let url = sync.remote_url.trim();
    match repo.find_remote(REMOTE) {
        Ok(remote) => {
            if remote.url() != Some(url) {
                repo.remote_set_url(REMOTE, url)
                    .map_err(|e| format!("设置远程仓库地址失败: {e}"))?;
            }
        }
        Err(_) => {
            repo.remote(REMOTE, url)
                .map_err(|e| format!("添加远程仓库失败: {e}"))?;
        }
    }
    Ok(repo)
}

/// 拉取远程分支，返回远程分支最新提交；远程分支不存在时返回 `None`
fn fetch_branch(repo: &Repository, sync: &SyncConfig) -> Result<Option<Oid>, String> {
    let branch = branch_name(sync);
    let mut remote = repo
        .find_remote(REMOTE)
        .map_err(|e| format!("查找远程仓库失败: {e}"))?;
    let refspec = format!("+refs/heads/{branch}:refs/remotes/{REMOTE}/{branch}");
    let mut options = FetchOptions::new();
    options.remote_callbacks(credentials(sync));

    if let Err(err) = remote.fetch(&[refspec.as_str()], Some(&mut options), None) {
        let message = err.message().to_lowercase();
        // 远程仓库为空或分支尚未创建：后续同步会自动新建分支
        if message.contains("couldn't find remote ref") || message.contains("does not exist") {
            return Ok(None);
        }
        return Err(format!(
            "拉取远程仓库失败，请检查地址、分支与用户名/密码: {err}"
        ));
    }

    Ok(repo
        .refname_to_id(&format!("refs/remotes/{REMOTE}/{branch}"))
        .ok())
}

/// 读取远程提交中的同步文件
fn read_remote_payload(repo: &Repository, oid: Oid) -> Result<Option<SyncPayload>, String> {
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("读取远程提交失败: {e}"))?;
    let tree = commit
        .tree()
        .map_err(|e| format!("读取远程目录失败: {e}"))?;
    let entry = match tree.get_name(SYNC_FILE) {
        Some(entry) => entry,
        None => return Ok(None),
    };
    let object = entry
        .to_object(repo)
        .map_err(|e| format!("读取同步文件失败: {e}"))?;
    let blob = object
        .as_blob()
        .ok_or_else(|| "远程同步文件格式错误".to_string())?;
    let text = std::str::from_utf8(blob.content())
        .map_err(|e| format!("远程同步文件编码错误: {e}"))?;
    serde_json::from_str(text)
        .map(Some)
        .map_err(|e| format!("解析远程同步文件失败: {e}"))
}

/// 连接唯一标识：主机 + 端口 + 名称
fn connection_key(conn: &Connection) -> (String, u16, String) {
    (
        conn.host.trim().to_lowercase(),
        conn.port,
        conn.name.trim().to_string(),
    )
}

fn model_key(model: &ModelConfig) -> String {
    if model.id.trim().is_empty() {
        model.name.trim().to_string()
    } else {
        model.id.trim().to_string()
    }
}

fn same_value<T: Serialize>(a: &T, b: &T) -> bool {
    match (serde_json::to_value(a), serde_json::to_value(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// 合并本地与远程配置。`resolution` 为 `None` 时只检测冲突、不覆盖任何一方。
fn merge(
    local: &AppConfig,
    remote: &SyncPayload,
    resolution: Option<&str>,
) -> (SyncPayload, Vec<SyncConflict>) {
    let mut connections = local.connections.clone();
    let mut conflicts = Vec::new();
    let remote_wins = resolution == Some("remote");

    for incoming in &remote.connections {
        let key = connection_key(incoming);
        match connections
            .iter()
            .position(|current| connection_key(current) == key)
        {
            None => connections.push(incoming.clone()),
            Some(index) => {
                if !same_value(&connections[index], incoming) {
                    conflicts.push(SyncConflict {
                        name: incoming.name.clone(),
                        host: incoming.host.clone(),
                        port: incoming.port,
                    });
                    if remote_wins {
                        connections[index] = incoming.clone();
                    }
                }
            }
        }
    }

    let mut models = local.models.clone();
    for incoming in &remote.models {
        let key = model_key(incoming);
        if !models.iter().any(|model| model_key(model) == key) {
            models.push(incoming.clone());
        }
    }

    let active_model_id = if local.active_model_id.trim().is_empty() {
        remote.active_model_id.clone()
    } else {
        local.active_model_id.clone()
    };

    (
        SyncPayload {
            connections,
            models,
            active_model_id,
        },
        conflicts,
    )
}

/// 以远程分支为基线写入同步文件，提交并推送（分支不存在时新建）
fn commit_and_push(repo: &Repository, sync: &SyncConfig, payload: &SyncPayload) -> Result<(), String> {
    let branch = branch_name(sync);
    let refname = format!("refs/heads/{branch}");
    let remote_ref = format!("refs/remotes/{REMOTE}/{branch}");

    let parent = repo
        .refname_to_id(&remote_ref)
        .ok()
        .and_then(|oid| repo.find_commit(oid).ok());

    if let Some(commit) = &parent {
        repo.reference(&refname, commit.id(), true, "sync: 对齐远程分支")
            .map_err(|e| format!("更新本地分支失败: {e}"))?;
        repo.set_head(&refname)
            .map_err(|e| format!("切换同步分支失败: {e}"))?;
        let mut checkout = CheckoutBuilder::new();
        checkout.force();
        repo.reset(commit.as_object(), ResetType::Hard, Some(&mut checkout))
            .map_err(|e| format!("重置同步仓库失败: {e}"))?;
    } else {
        repo.set_head(&refname)
            .map_err(|e| format!("创建同步分支失败: {e}"))?;
    }

    let workdir = repo
        .workdir()
        .ok_or_else(|| "同步仓库缺少工作目录".to_string())?;
    let json = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    fs::write(workdir.join(SYNC_FILE), json).map_err(|e| format!("写入同步文件失败: {e}"))?;

    let mut index = repo.index().map_err(|e| format!("读取同步索引失败: {e}"))?;
    index
        .add_path(Path::new(SYNC_FILE))
        .map_err(|e| format!("添加同步文件失败: {e}"))?;
    index.write().map_err(|e| format!("写入同步索引失败: {e}"))?;
    let tree_id = index
        .write_tree()
        .map_err(|e| format!("写入同步目录树失败: {e}"))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| format!("读取同步目录树失败: {e}"))?;

    let name = {
        let username = sync.username.trim();
        if username.is_empty() {
            "OrbitData"
        } else {
            username
        }
    };
    let signature = Signature::now(name, sync.email.trim())
        .map_err(|e| format!("提交身份无效（请检查用户名与邮箱）: {e}"))?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let commit_id = repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            "sync: 更新连接与 AI 模型配置",
            &tree,
            &parents,
        )
        .map_err(|e| format!("提交同步文件失败: {e}"))?;
    repo.reference(&refname, commit_id, true, "sync: 提交同步文件")
        .map_err(|e| format!("更新同步分支失败: {e}"))?;

    let mut remote = repo
        .find_remote(REMOTE)
        .map_err(|e| format!("查找远程仓库失败: {e}"))?;
    let mut push_options = PushOptions::new();
    push_options.remote_callbacks(credentials(sync));
    let push_refspec = format!("{refname}:{refname}");
    remote
        .push(&[push_refspec.as_str()], Some(&mut push_options))
        .map_err(|e| format!("推送到远程仓库失败: {e}"))?;

    Ok(())
}

/// 测试远程仓库连通性与认证；分支不存在时提示将自动新建
pub fn test(sync: &SyncConfig) -> Result<String, String> {
    validate(sync)?;
    let branch = branch_name(sync);

    let dir = std::env::temp_dir().join(format!("orbit-data-sync-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;

    let result = (|| -> Result<String, String> {
        let repo =
            Repository::init(&dir).map_err(|e| format!("初始化临时仓库失败: {e}"))?;
        let mut remote = repo
            .remote_anonymous(sync.remote_url.trim())
            .map_err(|e| format!("远程地址无效: {e}"))?;
        remote
            .connect_auth(Direction::Fetch, Some(credentials(sync)), None)
            .map_err(|e| format!("连接失败，请检查地址与用户名/密码: {e}"))?;

        // 连接成功即可；分支会在同步时按需创建（空仓库无法安全枚举引用）
        Ok(format!("连接成功，同步时使用分支 {branch}"))
    })();

    let _ = fs::remove_dir_all(&dir);
    result
}

/// 单键同步：拉取远程 → 合并（冲突时返回待选择）→ 提交推送。
///
/// `resolution`：`Some("remote")` 冲突保留远程，`Some("local")` 保留本地。
pub fn sync_now(
    cfg: &AppConfig,
    dir: &Path,
    resolution: Option<&str>,
) -> Result<(AppConfig, SyncOutcome), String> {
    let sync = &cfg.sync;
    validate(sync)?;

    let repo = open_repo(dir, sync)?;
    let remote_oid = fetch_branch(&repo, sync)?;
    let remote = match remote_oid {
        Some(oid) => read_remote_payload(&repo, oid)?.unwrap_or_default(),
        None => SyncPayload::default(),
    };

    let (payload, conflicts) = merge(cfg, &remote, resolution);
    if resolution.is_none() && !conflicts.is_empty() {
        return Ok((
            cfg.clone(),
            SyncOutcome {
                needs_choice: true,
                message: format!("检测到 {} 个连接冲突", conflicts.len()),
                conflicts,
            },
        ));
    }

    commit_and_push(&repo, sync, &payload)?;

    let mut merged = cfg.clone();
    merged.connections = payload.connections;
    merged.models = payload.models;
    merged.active_model_id = payload.active_model_id;
    let connection_count = merged.connections.len();
    let model_count = merged.models.len();

    Ok((
        merged,
        SyncOutcome {
            needs_choice: false,
            message: format!("同步完成：{connection_count} 个连接，{model_count} 个 AI 模型"),
            conflicts: Vec::new(),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(name: &str, host: &str, port: u16, database: &str) -> Connection {
        Connection {
            name: name.into(),
            host: host.into(),
            port,
            database: database.into(),
            ..Default::default()
        }
    }

    fn cfg_with(remote: &str, connections: Vec<Connection>) -> AppConfig {
        AppConfig {
            connections,
            sync: SyncConfig {
                remote_url: remote.into(),
                branch: "main".into(),
                username: "tester".into(),
                password: "secret".into(),
                email: "tester@example.com".into(),
            },
            ..Default::default()
        }
    }

    #[test]
    fn sync_flow_creates_branch_merges_and_detects_conflicts() {
        let base = std::env::temp_dir().join(format!("orbit-data-sync-flow-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let remote_dir = base.join("remote.git");
        let work = base.join("work");
        fs::create_dir_all(&remote_dir).unwrap();
        fs::create_dir_all(&work).unwrap();
        Repository::init_bare(&remote_dir).unwrap();
        let remote_url = remote_dir.to_string_lossy().to_string();

        let first = cfg_with(&remote_url, vec![conn("dev", "127.0.0.1", 3306, "app")]);
        assert!(test(&first.sync).is_ok());
        let (merged, outcome) = sync_now(&first, &work, None).unwrap();
        assert!(!outcome.needs_choice);
        assert_eq!(merged.connections.len(), 1);

        let second = cfg_with(&remote_url, vec![conn("dev", "127.0.0.1", 3306, "app2")]);
        let (_, conflict) = sync_now(&second, &work, None).unwrap();
        assert!(conflict.needs_choice);
        assert_eq!(conflict.conflicts.len(), 1);

        let (remote_kept, done) = sync_now(&second, &work, Some("remote")).unwrap();
        assert!(!done.needs_choice);
        assert_eq!(remote_kept.connections[0].database, "app");

        let (local_kept, done) = sync_now(&second, &work, Some("local")).unwrap();
        assert!(!done.needs_choice);
        assert_eq!(local_kept.connections[0].database, "app2");

        let _ = fs::remove_dir_all(&base);
    }
}