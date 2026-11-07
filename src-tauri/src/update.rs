//! 自动更新（FEATURE.md §7）。
//!
//! 检查与安装都在 Rust 侧完成：前端通过 `update_check` / `update_install` 命令驱动，
//! 更新源与公钥来自 `tauri.conf.json` 的 `plugins.updater`。安装完成后由
//! [`tauri::AppHandle::restart`] 重启应用；下载进度经 [`UPDATE_PROGRESS_EVENT`] 事件回传。
//!
//! 目前配置了两个更新源（GitHub Releases 与 Cloudflare R2 镜像）：每次检查并行探测
//! 两个源的 `latest.json`，总超时 5 秒。都可用时取版本号更大的一个，只有一个可用时
//! 用可用的那个，两个都不可用时提示网络超时。

use std::time::Duration;

use futures_util::future::join_all;
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 下载进度事件名，前端订阅后累加 `chunk` 计算百分比。
pub const UPDATE_PROGRESS_EVENT: &str = "update:progress";

/// 更新检查总超时：并行探测所有更新源，最长等待 5 秒。
const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// 所有更新源都不可用时的提示。
const TIMEOUT_MESSAGE: &str = "更新检查失败：网络超时，请检查网络后重试";

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

/// 读取 `tauri.conf.json` 中 `plugins.updater.endpoints` 配置的全部更新源。
fn configured_endpoints(app: &AppHandle) -> Vec<Url> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .and_then(Value::as_array)
        .map(|endpoints| {
            endpoints
                .iter()
                .filter_map(Value::as_str)
                .filter_map(|url| Url::parse(url).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// 请求单个更新源的 `latest.json`，返回其中声明的版本号。
///
/// 超时、非 2xx、JSON 解析失败或版本号非法都视为该源不可用，返回 `None`。
async fn probe_endpoint(client: &reqwest::Client, url: &Url) -> Option<Version> {
    let response = client.get(url.clone()).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let manifest: Value = response.json().await.ok()?;
    Version::parse(manifest.get("version")?.as_str()?).ok()
}

/// 并行探测所有更新源的版本号，返回 `[(version, url)]` 列表（按版本降序）。
///
/// 整体限时 [`CHECK_TIMEOUT`]；单个源超时、非 2xx、JSON 解析失败或版本号非法都
/// 视为不可用，直接排除。返回空列表表示所有源都不可用。
async fn probe_endpoints_ordered(app: &AppHandle) -> Result<Vec<(Version, Url)>, String> {
    let client = reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| format!("更新检查失败：{e}"))?;

    let probes = configured_endpoints(app).into_iter().map(|url| {
        let client = client.clone();
        async move {
            let version = probe_endpoint(&client, &url).await;
            (url, version)
        }
    });

    let results = tokio::time::timeout(CHECK_TIMEOUT, join_all(probes))
        .await
        .map_err(|_| TIMEOUT_MESSAGE.to_string())?;

    let mut candidates: Vec<(Version, Url)> = results
        .into_iter()
        .filter_map(|(url, version)| version.map(|version| (version, url)))
        .collect();

    candidates.sort_by(|a, b| b.0.cmp(&a.0));

    Ok(candidates)
}

/// 尝试用 `updater.check()` 获取指定 endpoint 的更新对象。
///
/// 返回 `Ok(Some(update))` 表示该 endpoint 确实有比当前版本新的更新；
/// 返回 `Ok(None)` 表示版本不新；返回 `Err` 表示该 endpoint 不可用。
async fn check_update_from(
    app: &AppHandle,
    url: Url,
) -> Result<Option<Update>, tauri_plugin_updater::Error> {
    let updater = app
        .updater_builder()
        .endpoints(vec![url])?
        .timeout(CHECK_TIMEOUT)
        .build()?;

    match updater.check().await {
        Ok(Some(mut update)) => {
            // 探测超时只约束检查阶段，下载大安装包不能被 5 秒限制。
            update.timeout = None;
            Ok(Some(update))
        }
        other => other,
    }
}

/// 检查是否有新版本。只查询、不下载。
///
/// 并行探测所有更新源并取版本号最大者；若两个源都不可用（超时 / 非 2xx / 解析失败），
/// 返回网络超时提示。
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let candidates = probe_endpoints_ordered(&app).await?;

    if candidates.is_empty() {
        return Err(TIMEOUT_MESSAGE.into());
    }

    let mut any_checked_ok = false;
    let mut last_err: Option<String> = None;

    // candidates 已按版本降序：第一个有更新的源就是最新的那个。
    for (_, url) in candidates {
        match check_update_from(&app, url).await {
            Ok(Some(update)) => {
                return Ok(UpdateInfo {
                    has_update: true,
                    current: update.current_version.clone(),
                    latest: Some(update.version.clone()),
                    notes: update.body.clone(),
                    published_at: update.date.map(|date| date.unix_timestamp()),
                })
            }
            Ok(None) => any_checked_ok = true,
            Err(err) => last_err = Some(update_error(err)),
        }
    }

    // 至少有一个源确认「无更新」→ 视为已是最新。
    if any_checked_ok {
        return Ok(UpdateInfo {
            has_update: false,
            current,
            latest: None,
            notes: None,
            published_at: None,
        });
    }

    Err(last_err.unwrap_or_else(|| TIMEOUT_MESSAGE.into()))
}

/// 下载并安装更新，完成后重启应用。下载进度经 [`UPDATE_PROGRESS_EVENT`] 回传。
///
/// 按版本从高到低依次尝试更新源；某个源的安装包下载失败或签名校验失败时，
/// 自动回退到下一个源（典型场景：R2 上的文件损坏，而 GitHub Release 仍保留正确版本）。
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let candidates = probe_endpoints_ordered(&app).await?;

    if candidates.is_empty() {
        return Err(TIMEOUT_MESSAGE.into());
    }

    let mut found_update = false;
    let mut last_install_err: Option<String> = None;

    for (_, url) in candidates {
        let update = match check_update_from(&app, url.clone()).await {
            Ok(Some(update)) => update,
            Ok(None) => continue,
            Err(err) => {
                last_install_err = Some(update_error(err));
                continue;
            }
        };

        found_update = true;
        let emitter = app.clone();
        let install_result = update
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
            .await;

        match install_result {
            Ok(()) => app.restart(),
            Err(err) => {
                last_install_err = Some(update_error(err));
                // 继续尝试下一个更新源
            }
        }
    }

    if !found_update {
        return Err("当前已是最新版本，无需更新".into());
    }

    Err(last_install_err.unwrap_or_else(|| "更新安装失败：所有更新源均不可用".into()))
}
