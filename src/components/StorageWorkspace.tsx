import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, Download, ExternalLink, Folder, File as FileIcon, HardDrive, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { useStore } from "../store";
import type {
  OssBucket,
  OssObject,
  OssObjectDetail,
  OssObjectList,
  OssObjectText,
  OssPresignResult,
  OssSortMode,
} from "../types";
import "./StorageWorkspace.css";

const PAGE_SIZES = [50, 100, 200, 500];
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]);
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml", "xml", "ini",
  "conf", "toml", "sql", "js", "mjs", "ts", "tsx", "jsx", "py", "rs", "go", "java", "c", "cpp",
  "h", "css", "html", "htm", "sh", "env",
]);

/** 已提交的查询条件；只有点击「查询」才会更新，避免输入过程中反复扫描 Bucket */
interface OssQuery {
  prefix: string;
  start: string;
  end: string;
  sort: OssSortMode;
  pageSize: number;
}

const DEFAULT_QUERY: OssQuery = { prefix: "", start: "", end: "", sort: "name-asc", pageSize: 100 };


const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function baseName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function extOf(key: string) {
  const name = key.split("/").pop() ?? key;
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function humanSize(n: number) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function timeText(s: string) {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

/** datetime-local 的本地时间转 UTC ISO，供服务端按 RFC 3339 解析 */
function toIso(local: string) {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}


export function StorageWorkspace({ connId, initialBucket = "" }: { connId: string; initialBucket?: string }) {
  const connection = useStore((s) => s.config?.connections.find((c) => c.id === connId));
  const session = useStore((s) => s.connSessions[connId]);
  const view = useStore((s) => s.view);
  const dialog = useStore((s) => s.dialogOpen);
  const activeTabId = useStore((s) => s.activeTabId);

  const [buckets, setBuckets] = useState<string[]>([]);
  const [bucket, setBucket] = useState(initialBucket || connection?.database || "");
  const [dir, setDir] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState<OssQuery>(DEFAULT_QUERY);
  const [draftSort, setDraftSort] = useState<OssSortMode>(DEFAULT_QUERY.sort);
  const [draftPageSize, setDraftPageSize] = useState(DEFAULT_QUERY.pageSize);
  const [draftStart, setDraftStart] = useState("");
  const [draftEnd, setDraftEnd] = useState("");
  const [objects, setObjects] = useState<OssObject[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [jumpPage, setJumpPage] = useState("1");
  const [scanTruncated, setScanTruncated] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<OssObject | null>(null);
  const [detail, setDetail] = useState<OssObjectDetail | null>(null);
  const [presign, setPresign] = useState<{ key: string; expiry: number; url: string; expiresAt: number } | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [textPreview, setTextPreview] = useState<OssObjectText | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewOpen, setPreviewOpen] = useState(true);

  const generation = useRef(0);
  const mounted = useRef(true);
  const bucketRef = useRef(bucket);
  bucketRef.current = bucket;

  const available = !!connection && !!session && view === "chat" &&
    !(dialog && typeof dialog === "object" && dialog.id === connId);

  const fail = useCallback((e: unknown) => setError(errText(e)), []);

  const loadBuckets = useCallback(async () => {
    if (!available) return;
    try {
      const list = await api.ossRequest<OssBucket[]>(connId, { action: "list_buckets" });
      const names = list.map((b) => b.name).filter(Boolean);
      const fallback = connection?.database?.trim();
      const merged = names.length ? names : fallback ? [fallback] : [];
      if (fallback && !merged.includes(fallback)) merged.unshift(fallback);
      setBuckets(merged);
      setBucket((cur) => (cur && merged.includes(cur) ? cur : merged[0] ?? ""));
    } catch (e) {
      // 无 ListBuckets 权限但配置了默认 Bucket 时，仍允许使用默认 Bucket
      const fallback = connection?.database?.trim();
      if (fallback) {
        setBuckets([fallback]);
        setBucket((cur) => cur || fallback);
      } else {
        fail(e);
      }
    }
  }, [available, connId, connection?.database, fail]);

  /** 排序、时间筛选与分页统一由后端完成，前端只负责展示指定页 */
  const loadPage = useCallback(async (target: number, refresh = false) => {
    if (!available || !bucket) return;
    const g = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const res = await api.ossRequest<OssObjectList>(connId, {
        action: "list_objects",
        bucket,
        prefix: query.prefix,
        start_time: toIso(query.start),
        end_time: toIso(query.end),
        sort: query.sort,
        page: target,
        page_size: query.pageSize,
        refresh,
      });
      if (!mounted.current || g !== generation.current) return;
      setObjects(res.objects);
      setTotal(res.total);
      setPage(res.page);
      setJumpPage(String(res.page));
      setScanTruncated(res.scan_truncated);
      setLoadedOnce(true);
    } catch (e) {
      if (mounted.current && g === generation.current) fail(e);
    } finally {
      if (mounted.current && g === generation.current) setLoading(false);
    }
  }, [available, bucket, connId, query, fail]);

  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  // 连接变化：清空列表与全部查询条件
  useEffect(() => {
    setObjects([]);
    setTotal(0);
    setPage(1);
    setJumpPage("1");
    setScanTruncated(false);
    setLoadedOnce(false);
    setSelected(null);
    setDetail(null);
    setDir("");
    setSearch("");
    setQuery(DEFAULT_QUERY);
    setDraftSort(DEFAULT_QUERY.sort);
    setDraftPageSize(DEFAULT_QUERY.pageSize);
    setDraftStart("");
    setDraftEnd("");
    if (available) void loadBuckets();
    // 连接变化时重置，不随 bucket 变化重复拉取 Bucket 列表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, available]);

  // 左栏重新选择 Bucket 时同步到工作区
  useEffect(() => {
    if (!initialBucket) return;
    setBucket(initialBucket);
  }, [initialBucket]);

  // Bucket 或查询条件变化：清空旧数据并按第 1 页重新加载，避免残留上一个 Bucket 的列表与筛选
  const prevBucket = useRef(bucket);
  useEffect(() => {
    const bucketChanged = prevBucket.current !== bucket;
    prevBucket.current = bucket;
    generation.current += 1;
    setObjects([]);
    setTotal(0);
    setPage(1);
    setJumpPage("1");
    setScanTruncated(false);
    setSelected(null);
    setDetail(null);
    if (bucketChanged) {
      setDir("");
      setSearch("");
      setDraftSort(DEFAULT_QUERY.sort);
      setDraftPageSize(DEFAULT_QUERY.pageSize);
      setDraftStart("");
      setDraftEnd("");
      const isDefaultQuery = query.prefix === "" && query.start === "" && query.end === ""
        && query.sort === DEFAULT_QUERY.sort && query.pageSize === DEFAULT_QUERY.pageSize;
      if (!isDefaultQuery) {
        // 先恢复默认查询条件，由下一次渲染统一发起请求，避免用旧筛选打新 Bucket
        setQuery(DEFAULT_QUERY);
        return;
      }
    }
    if (available && bucket) void loadPage(1);
    else setLoadedOnce(false);
  }, [bucket, query, available, loadPage]);

  // 选中对象时加载元数据与在线预览内容（图片走签名 URL，文本走内容接口）
  useEffect(() => {
    setPreviewUrl("");
    setTextPreview(null);
    setPreviewError("");
    setPreviewOpen(true);
    if (!selected || selected.is_folder || !available || !bucket) {
      setDetail(null);
      setPreviewLoading(false);
      return;
    }
    let alive = true;
    setPreviewLoading(true);
    api.ossRequest<OssObjectDetail>(connId, { action: "head_object", bucket, key: selected.key })
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && fail(e));

    const ext = extOf(selected.key);
    const task = IMAGE_EXT.has(ext)
      ? api.ossRequest<OssPresignResult>(connId, { action: "presign_url", bucket, key: selected.key, expires_secs: 900 })
        .then((r) => alive && setPreviewUrl(r.url))
      : TEXT_EXT.has(ext)
        ? api.ossRequest<OssObjectText>(connId, { action: "get_object_text", bucket, key: selected.key })
          .then((r) => alive && setTextPreview(r))
        : Promise.resolve();
    task
      .catch((e) => alive && setPreviewError(errText(e)))
      .finally(() => alive && setPreviewLoading(false));
    return () => {
      alive = false;
    };
  }, [selected, available, connId, bucket, fail]);

  const crumbs = useMemo(() => {
    const parts = dir.split("/").filter(Boolean);
    return parts.map((p, i) => ({ name: p, prefix: parts.slice(0, i + 1).join("/") + "/" }));
  }, [dir]);

  const selectedExt = selected && !selected.is_folder ? extOf(selected.key) : "";
  const previewable = IMAGE_EXT.has(selectedExt) || TEXT_EXT.has(selectedExt);

  function goPrefix(next: string) {
    setDir(next);
    setSearch("");
    setQuery((q) => ({ ...q, prefix: next }));
  }

  /** 唯一入口：一次性提交搜索 / 排序 / 每页条数 / 时间区间 */
  function runQuery() {
    setQuery({
      prefix: dir + search.trim(),
      start: draftStart,
      end: draftEnd,
      sort: draftSort,
      pageSize: draftPageSize,
    });
  }

  function jump(target: number) {
    const n = Math.min(Math.max(1, Math.trunc(target) || 1), totalPages);
    if (n !== page) void loadPage(n);
    else setJumpPage(String(n));
  }

  function copy(text: string, tip: string) {
    navigator.clipboard.writeText(text).then(
      () => setNotice(tip),
      () => setError("复制失败，请手动复制"),
    );
  }

  async function upload() {
    if (!available || !bucket) return;
    const picked = await openDialog({ multiple: true, directory: false, title: "选择要上传的文件" });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (!paths.length) return;
    setBusy((n) => n + 1);
    setError("");
    const failures: string[] = [];
    let ok = 0;
    try {
      for (const path of paths) {
        const name = baseName(path);
        const key = dir + name;
        // 同名对象先探测，存在则确认覆盖
        const exists = await api.ossRequest(connId, { action: "head_object", bucket, key })
          .then(() => true)
          .catch(() => false);
        if (exists) {
          const okCover = await useStore.getState().askConfirm({
            title: "覆盖已有对象",
            message: `对象「${key}」已存在，是否覆盖？`,
            confirmText: "覆盖",
            danger: true,
          });
          if (!okCover) continue;
        }
        try {
          await api.ossTransfer(connId, { action: "upload_file", bucket, key, local_path: path });
          ok += 1;
        } catch (e) {
          failures.push(`${name}: ${errText(e)}`);
        }
      }
      setNotice(`上传完成 ${ok} 个${failures.length ? `，失败 ${failures.length} 个` : ""}`);
      if (failures.length) setError(failures.join("\n"));
      await loadPage(1, true);
    } finally {
      setBusy((n) => Math.max(0, n - 1));
    }
  }

  async function download(obj: OssObject) {
    if (!available || !bucket) return;
    const target = await saveDialog({ defaultPath: baseName(obj.key), title: "保存对象到本地" });
    if (!target) return;
    setBusy((n) => n + 1);
    setError("");
    try {
      await api.ossTransfer(connId, { action: "download_file", bucket, key: obj.key, local_path: target });
      setNotice(`已下载到 ${target}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy((n) => Math.max(0, n - 1));
    }
  }

  async function remove(obj: OssObject) {
    if (!available || !bucket) return;
    const input = await useStore.getState().askText({
      title: "删除对象",
      message: `Bucket: ${bucket}\n将永久删除该对象，无法恢复。请输入完整 Key 确认。`,
      placeholder: obj.key,
      expect: obj.key,
      confirmText: "删除",
      danger: true,
    });
    if (input === null) return;
    if (input !== obj.key) {
      setError("Key 不匹配，已取消删除");
      return;
    }
    setBusy((n) => n + 1);
    try {
      await api.ossRequest(connId, { action: "delete_object", bucket, key: obj.key });
      setNotice(`已删除 ${obj.key}`);
      setSelected((cur) => (cur?.key === obj.key ? null : cur));
      await loadPage(page, true);
    } catch (e) {
      fail(e);
    } finally {
      setBusy((n) => Math.max(0, n - 1));
    }
  }

  async function makePresign(key: string, expiry: number) {
    if (!available || !bucket) return;
    setBusy((n) => n + 1);
    setError("");
    try {
      const r = await api.ossRequest<OssPresignResult>(connId, { action: "presign_url", bucket, key, expires_secs: expiry });
      setPresign({ key, expiry, url: r.url, expiresAt: r.expires_at });
    } catch (e) {
      fail(e);
    } finally {
      setBusy((n) => Math.max(0, n - 1));
    }
  }

  const disabled = !available || busy > 0;

  return (
    <div className="oss-workspace">
      <header className="oss-header">
        <span className="oss-logo"><HardDrive size={20} /></span>
        <div className="oss-heading">
          <h2>对象存储工作区 <span className="oss-badge">{connection?.name ?? "连接不存在"}</span></h2>
          <p>Bucket · 对象 · 上传下载 · 临时链接</p>
        </div>
        {busy > 0 && <Loader2 size={14} className="oss-spin" />}
        <select aria-label="选择 Bucket" value={bucket} disabled={disabled || !buckets.length}
          onChange={(e) => setBucket(e.target.value)}>
          {!buckets.length && <option value="">暂无 Bucket</option>}
          {buckets.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <button disabled={disabled || !bucket} onClick={() => { void loadPage(page, true); }}>
          <RefreshCw size={13} />刷新
        </button>
        <button className="primary" disabled={disabled || !bucket} onClick={() => void upload()}>
          <Upload size={13} />上传文件
        </button>
      </header>

      {!available && <div className="oss-alert info">连接不可用或正在编辑，请从左栏重新连接。</div>}
      {error && <div className="oss-alert" role="alert"><span className="oss-multiline">{error}</span><button onClick={() => setError("")} aria-label="关闭错误">×</button></div>}
      {notice && <div className="oss-alert info" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示">×</button></div>}

      <div className="oss-body">
        <nav className="oss-crumbs" aria-label="路径">
          <button onClick={() => goPrefix("")} disabled={!bucket}>{bucket || "—"}</button>
          {crumbs.map((c) => (
            <span key={c.prefix}>
              <span className="oss-sep">/</span>
              <button onClick={() => goPrefix(c.prefix)}>{c.name}</button>
            </span>
          ))}
        </nav>

        <div className="oss-toolbar">
          <input
            aria-label="按前缀搜索"
            placeholder="按前缀搜索…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runQuery(); }}
            disabled={!available || !bucket}
          />
          <select aria-label="排序" value={draftSort} onChange={(e) => setDraftSort(e.target.value as OssSortMode)}>
            <option value="name-asc">名称 正序</option>
            <option value="name-desc">名称 倒序</option>
            <option value="mtime-desc">修改时间 倒序</option>
            <option value="mtime-asc">修改时间 正序</option>
          </select>
          <select aria-label="每页数量" value={draftPageSize} onChange={(e) => setDraftPageSize(Number(e.target.value))}>
            {PAGE_SIZES.map((n) => <option key={n} value={n}>每页 {n}</option>)}
          </select>
          <span className="oss-filter-label">修改时间</span>
          <input
            type="datetime-local"
            aria-label="开始时间"
            value={draftStart}
            max={draftEnd || undefined}
            onChange={(e) => setDraftStart(e.target.value)}
            disabled={!available || !bucket}
          />
          <span className="oss-sep">~</span>
          <input
            type="datetime-local"
            aria-label="结束时间"
            value={draftEnd}
            min={draftStart || undefined}
            onChange={(e) => setDraftEnd(e.target.value)}
            disabled={!available || !bucket}
          />
          <button className="primary" disabled={disabled || !bucket} onClick={runQuery}>查询</button>
        </div>

        <p className="oss-note">
          当前目录：{query.prefix || "/"}　·　共 {total} 条，本页 {objects.length} 条
          {scanTruncated ? "　·　扫描量已达上限，结果可能不完整" : ""}　·　时间区间可留空
        </p>

        <div className="oss-table-wrap">
          <table className="oss-table">
            <thead>
              <tr>
                <th>名称</th>
                <th className="num">大小</th>
                <th>最后修改</th>
                <th>存储类型</th>
                <th className="ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {objects.map((o) => {
                // 只剥离「当前目录」前缀，不能按搜索前缀剥离：搜索词通常不是目录边界，
                // 按它截取会把文件名开头一起裁掉（如搜索 "foo/b" 时把 "foo/bar.txt" 显示成 "ar.txt"）
                const relBase = dir && o.key.startsWith(dir) ? dir.length : 0;
                const rel = o.key.slice(relBase) || o.key;
                const name = o.is_folder ? rel.replace(/\/$/, "") : rel;
                return (
                  <tr key={o.key} className={`selectable${selected?.key === o.key ? " selected" : ""}`}
                    onClick={() => setSelected(o)}
                    onDoubleClick={() => { if (o.is_folder) goPrefix(o.key); }}>
                    <td>
                      <span className="oss-name">
                        {o.is_folder ? <Folder size={13} /> : <FileIcon size={13} />}
                        <span title={o.key}>{name || o.key}</span>
                      </span>
                    </td>
                    <td className="num">{o.is_folder ? "—" : humanSize(o.size)}</td>
                    <td>{timeText(o.last_modified)}</td>
                    <td>{o.storage_class || "—"}</td>
                    <td className="ops">
                      {o.is_folder ? (
                        <button onClick={(e) => { e.stopPropagation(); goPrefix(o.key); }}>打开</button>
                      ) : (
                        <>
                          <button disabled={disabled} title="下载" onClick={(e) => { e.stopPropagation(); void download(o); }}><Download size={12} /></button>
                          <button disabled={disabled} title="临时下载地址" onClick={(e) => { e.stopPropagation(); void makePresign(o.key, 3600); }}><ExternalLink size={12} /></button>
                          <button disabled={disabled || !o.key} title="复制路径" onClick={(e) => { e.stopPropagation(); copy(`${bucket}/${o.key}`, "已复制对象路径"); }}><Copy size={12} /></button>
                          <button className="danger" disabled={disabled} title="删除" onClick={(e) => { e.stopPropagation(); void remove(o); }}><Trash2 size={12} /></button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loading && <div className="oss-empty"><Loader2 size={18} className="oss-spin" />正在加载对象…</div>}
          {!loading && loadedOnce && !objects.length && (
            <div className="oss-empty"><HardDrive size={22} />{query.prefix ? "当前前缀下没有对象" : "Bucket 为空"}</div>
          )}
          {!loading && !bucket && <div className="oss-empty"><HardDrive size={22} />请选择或填写 Bucket</div>}
        </div>

        <div className="oss-footer">
          <span>共 {total} 条 · 本页 {objects.length} 条</span>
          <span className="oss-spacer" />
          <button disabled={disabled || loading || page <= 1} onClick={() => void loadPage(1)}>首页</button>
          <button disabled={disabled || loading || page <= 1} title="上一页" onClick={() => void loadPage(page - 1)}>
            <ChevronLeft size={12} />
          </button>
          <span className="oss-page-no">第 {page} / {totalPages} 页</span>
          <button disabled={disabled || loading || page >= totalPages} title="下一页" onClick={() => void loadPage(page + 1)}>
            <ChevronRight size={12} />
          </button>
          <button disabled={disabled || loading || page >= totalPages} onClick={() => void loadPage(totalPages)}>末页</button>
          <input
            className="oss-jump"
            aria-label="跳转页码"
            value={jumpPage}
            onChange={(e) => setJumpPage(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => { if (e.key === "Enter") jump(Number(jumpPage)); }}
            disabled={disabled}
          />
          <button disabled={disabled || loading} onClick={() => jump(Number(jumpPage))}>跳转</button>
        </div>

        {selected && !selected.is_folder && (
          <div className="oss-detail">
            <div className="oss-detail-head">
              <strong>{selected.key}</strong>
              <span className="oss-spacer" />
              <button disabled={disabled} onClick={() => void makePresign(selected.key, 3600)}><ExternalLink size={12} />临时链接</button>
              <button disabled={disabled} onClick={() => void download(selected)}><Download size={12} />下载</button>
            </div>
            <div className="oss-kv">
              <div><span>大小</span><b>{humanSize(detail?.size ?? selected.size)}</b></div>
              <div><span>类型</span><b>{detail?.content_type || "—"}</b></div>
              <div><span>存储类型</span><b>{detail?.storage_class || selected.storage_class || "—"}</b></div>
              <div><span>最后修改</span><b>{timeText(detail?.last_modified || selected.last_modified)}</b></div>
              <div><span>ETag</span><b>{detail?.etag || selected.etag || "—"}</b></div>
              <div><span>Bucket</span><b>{bucket}</b></div>
            </div>
            {previewOpen ? (
              <div className="oss-preview">
                <div className="oss-preview-head">
                  <strong>在线预览</strong>
                  {previewLoading && <Loader2 size={12} className="oss-spin" />}
                  <span className="oss-spacer" />
                  <button
                    className="oss-preview-close"
                    title="关闭预览"
                    aria-label="关闭预览"
                    onClick={() => setPreviewOpen(false)}
                  >
                    ×
                  </button>
                </div>
                {previewError && <p className="oss-note oss-warning">{previewError}</p>}
                {!!previewUrl && <img className="oss-preview-image" src={previewUrl} alt={selected.key} />}
                {textPreview && (
                  <>
                    <pre className="oss-preview-text">{textPreview.text}</pre>
                    {textPreview.truncated && <p className="oss-note">内容较大，仅预览前 512 KB，完整内容请下载查看。</p>}
                  </>
                )}
                {!previewLoading && !previewError && !previewUrl && !textPreview && (
                  <p className="oss-note">
                    {previewable ? "暂无预览内容。" : "该类型暂不支持在线预览，请下载后查看。"}
                  </p>
                )}
              </div>
            ) : (
              <div className="oss-preview-collapsed">
                <span className="oss-note">预览已关闭</span>
                <button onClick={() => setPreviewOpen(true)}>打开预览</button>
              </div>
            )}
          </div>
        )}
      </div>

      {presign && (
        <div className="modal-mask" onClick={() => setPresign(null)}>
          <div className="modal oss-presign" onClick={(e) => e.stopPropagation()}>
            <h3>临时下载地址</h3>
            <p className="oss-note">对象：{presign.key}</p>
            <label className="oss-presign-row">
              有效期
              <select value={presign.expiry} onChange={(e) => void makePresign(presign.key, Number(e.target.value))}>
                <option value={900}>15 分钟</option>
                <option value={3600}>1 小时</option>
                <option value={28800}>8 小时</option>
              </select>
            </label>
            <textarea readOnly rows={4} value={presign.url} onFocus={(e) => e.currentTarget.select()} />
            <p className="oss-note">失效时间：{new Date(presign.expiresAt).toLocaleString()}</p>
            <p className="oss-note oss-warning">任何拿到该链接的人在有效期内都能下载此对象，请勿公开传播。链接不会写入日志。</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => copy(presign.url, "已复制临时链接")}>复制链接</button>
              <button className="btn" onClick={() => window.open(presign.url, "_blank")}>浏览器打开</button>
              <div className="spacer" />
              <button className="btn primary" onClick={() => setPresign(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default StorageWorkspace;