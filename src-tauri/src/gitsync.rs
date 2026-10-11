use crate::config::{AppConfig, SyncConfig};
use std::fs;
use std::path::Path;
use std::process::Command;

/// 同步文件名:包含连接信息 + AI 模型配置
const SYNC_FILE: &str = "orbit-data-sync.json";

fn run_git(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git 执行失败(请确认系统已安装 git): {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return Err(format!("git {} 失败:\n{}", args.join(" "), stderr));
    }
    Ok(if stdout.is_empty() { stderr } else { stdout })
}

fn repo_ready(dir: &str) -> bool {
    !dir.is_empty() && Path::new(dir).join(".git").exists()
}

pub fn init(sync: &SyncConfig) -> Result<String, String> {
    let dir = sync.repo_path.clone();
    if dir.is_empty() {
        return Err("请先在设置中配置同步仓库路径".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    if !repo_ready(&dir) {
        run_git(&dir, &["init"])?;
        if !sync.branch.is_empty() {
            let _ = run_git(&dir, &["branch", "-M", &sync.branch]);
        }
    }
    if !sync.remote_url.is_empty() {
        let _ = run_git(&dir, &["remote", "remove", "origin"]);
        run_git(&dir, &["remote", "add", "origin", &sync.remote_url])?;
    }
    Ok("同步仓库已就绪".into())
}

pub fn commit_and_push(cfg: &AppConfig, sync: &SyncConfig, message: &str) -> Result<String, String> {
    let dir = sync.repo_path.clone();
    if dir.is_empty() {
        return Err("请先在设置中配置同步仓库路径".into());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    if !repo_ready(&dir) {
        init(sync)?;
    }
    let data = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(Path::new(&dir).join(SYNC_FILE), data)
        .map_err(|e| format!("写入同步文件失败: {e}"))?;

    run_git(&dir, &["add", "."])?;
    let msg = if message.trim().is_empty() {
        "sync: 更新连接与 AI 配置"
    } else {
        message
    };
    let mut result = match run_git(&dir, &["commit", "-m", msg]) {
        Ok(out) => out,
        Err(e) => {
            if e.contains("nothing to commit") {
                "没有需要同步的变更".to_string()
            } else {
                return Err(e);
            }
        }
    };
    if !sync.remote_url.is_empty() {
        let b: &str = if sync.branch.is_empty() {
            "HEAD"
        } else {
            &sync.branch
        };
        match run_git(&dir, &["push", "-u", "origin", b]) {
            Ok(out) => {
                result.push_str("\n");
                result.push_str(&out);
            }
            Err(e) => result.push_str(&format!("\n推送失败: {e}")),
        }
    } else {
        result.push_str("\n(未配置远程仓库,仅本地提交)");
    }
    Ok(result)
}

pub fn pull(sync: &SyncConfig) -> Result<AppConfig, String> {
    let dir = sync.repo_path.clone();
    if !repo_ready(&dir) {
        return Err("同步仓库尚未初始化".into());
    }
    if sync.remote_url.is_empty() {
        run_git(&dir, &["pull"])?;
    } else {
        let b: &str = if sync.branch.is_empty() {
            "main"
        } else {
            &sync.branch
        };
        run_git(&dir, &["pull", "origin", b])?;
    }
    let data = fs::read_to_string(Path::new(&dir).join(SYNC_FILE))
        .map_err(|e| format!("读取同步文件失败: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("解析同步文件失败: {e}"))
}

pub fn status(sync: &SyncConfig) -> Result<String, String> {
    let dir = sync.repo_path.clone();
    if !repo_ready(&dir) {
        return Ok("未初始化(请先配置仓库路径并初始化)".into());
    }
    let branch = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let last = run_git(&dir, &["log", "-1", "--oneline"]).unwrap_or_default();
    let changes = run_git(&dir, &["status", "--short"]).unwrap_or_default();
    let remote = run_git(&dir, &["remote", "get-url", "origin"]).unwrap_or_default();
    Ok(format!(
        "分支: {branch}\n远程: {}\n最新提交: {last}\n待同步变更:\n{}",
        if remote.is_empty() { "(无)" } else { &remote },
        if changes.is_empty() { "(无)" } else { &changes }
    ))
}
