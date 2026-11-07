import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../api";
import type { UpdateInfo } from "../types";

/** 下载进度事件名，与 Rust 侧 update.rs 的 UPDATE_PROGRESS_EVENT 保持一致。 */
const PROGRESS_EVENT = "update:progress";

interface ProgressPayload {
  chunk: number;
  total: number | null;
}

/**
 * 启动后检查更新，发现新版本时在右下角展示提示条。
 *
 * 检查与安装都在 Rust 侧完成（见 src-tauri/src/update.rs），这里只维护状态与展示：
 * 「稍后」仅隐藏本次会话的提示，下载进度经 update:progress 事件累加。
 */
export default function AutoUpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkError, setCheckError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .updateCheck()
      .then((res) => {
        if (alive) setInfo(res);
      })
      .catch((e) => {
        /* GitHub 与 R2 都没查到（通常是网络超时）时给出提示，避免静默失败 */
        if (alive) setCheckError(String(e));
      })
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const install = async () => {
    setDownloading(true);
    setPercent(0);
    setError("");
    let downloaded = 0;
    let total: number | null = null;
    const off = await listen<ProgressPayload>(PROGRESS_EVENT, (ev) => {
      downloaded += Number(ev.payload?.chunk || 0);
      total = ev.payload?.total ?? total;
      setPercent(total ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
    });
    try {
      await api.updateInstall();
      off();
    } catch (e) {
      off();
      setDownloading(false);
      setError(String(e));
    }
  };

  if (checking || dismissed) return null;

  // 两个更新源都不可用：提示网络超时，不再静默失败。
  if (!info) {
    if (!checkError) return null;
    return (
      <div className="update-banner" role="status">
        <div className="update-banner-text">
          <strong>检查更新失败</strong>
          <span className="muted">
            {checkError.replace(/^更新检查失败：/, "")}
          </span>
        </div>
        <div className="update-banner-actions">
          <button className="btn" type="button" onClick={() => setDismissed(true)}>
            知道了
          </button>
        </div>
      </div>
    );
  }

  const failed = !downloading && !!error && info.has_update;
  if (!info.has_update && !failed) return null;

  const published = info.published_at
    ? new Date(info.published_at * 1000).toLocaleDateString()
    : "";

  return (
    <div className="update-banner" role="status" title={info.notes || ""}>
      <div className="update-banner-text">
        <strong>{failed ? "更新失败" : `发现新版本 ${info.latest}`}</strong>
        <span className="muted">
          {failed
            ? error
            : downloading
              ? percent === null
                ? "正在下载…"
                : `正在下载 ${percent}%`
              : `当前 ${info.current}${published ? ` · ${published} 发布` : ""}`}
        </span>
      </div>
      <div className="update-banner-actions">
        <button className="btn" type="button" disabled={downloading} onClick={() => setDismissed(true)}>
          稍后
        </button>
        <button className="btn primary" type="button" disabled={downloading} onClick={() => void install()}>
          {downloading ? "下载中" : failed ? "重试" : "立即更新"}
        </button>
      </div>
    </div>
  );
}
