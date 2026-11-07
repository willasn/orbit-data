//! 自动更新（FEATURE.md §7）。
//!
//! 检查与安装都在 Rust 侧完成：前端通过 `update_check` / `update_install` 命令驱动，
//! 更新源与公钥来自 `tauri.conf.json` 的 `plugins.updater`。安装完成后由
//! [`tauri::AppHandle::restart`] 重启应用；下载进度经 [`UPDATE_PROGRESS_EVENT`] 事件回传。

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// 下载进度事件名，前端订阅后累加 `chunk` 计算百分比。
pub const UPDATE_PROGRESS_EVENT: &str = "update:progress";

/// 更新检查结果；`has_update` 为 false 时其余字段均为 `None`。
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub has_update: bool,
    /// 当前运行版本
    pub current: String,
    /// 远端最新版本
    pub latest: Option<String>,
    /// 更新说明（Release notes）
    pub notes: Option<String>,
    /// 发布时间（Unix 秒），由前端按本地时区格式化
    pub published_at: Option<i64>,
}

/// 下载进度负载：本次新增字节数 + 安装包总字节数（未知时为 null）。
#[derive(Debug, Clone, Serialize)]
struct ProgressPayload {
    chunk: u64,
    total: Option<u64>,
}

fn update_error(e: impl std::fmt::Display) -> String {
    format!("更新失败：{e}")
}

/// 检查是否有新版本。只查询、不下载。
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(update_error)?;

    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            has_update: true,
            current: update.current_version.clone(),
            latest: Some(update.version.clone()),
            notes: update.body.clone(),
            published_at: update.date.map(|date| date.unix_timestamp()),
        }),
        Ok(None) => Ok(UpdateInfo {
            has_update: false,
            current,
            latest: None,
            notes: None,
            published_at: None,
        }),
        Err(e) => Err(update_error(e)),
    }
}

/// 下载并安装更新，完成后重启应用。下载进度经 [`UPDATE_PROGRESS_EVENT`] 回传。
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(update_error)?;
    let update = match updater.check().await.map_err(update_error)? {
        Some(update) => update,
        None => return Err("当前已是最新版本，无需更新".into()),
    };

    let emitter = app.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let _ = emitter.emit(
                    UPDATE_PROGRESS_EVENT,
                    ProgressPayload {
                        chunk: chunk_length as u64,
                        total: content_length,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(update_error)?;

    app.restart();
}
