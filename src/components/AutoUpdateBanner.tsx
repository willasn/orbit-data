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
      .catch(() => {
        /* 自动检查失败不打扰用户：静默忽略，仍可在下次启动时重试 */
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

  if (checking || dismissed || !info) return null;
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
