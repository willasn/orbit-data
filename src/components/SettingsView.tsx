import { useState } from "react";
import { ArrowLeft, Plus, Trash2, Star, RefreshCw, UploadCloud, DownloadCloud, GitBranch, Bot } from "lucide-react";
import { api } from "../api";
import { useStore } from "../store";
import type { ModelConfig, SyncConfig } from "../types";

const blankModel = (): ModelConfig => ({
  id: "",
  name: "",
  base_url: "",
  api_key: "",
  model: "",
  protocol: "openai",
  input_tokens: null,
  output_tokens: null,
  supports_images: false,
});

export default function SettingsView() {
  const { config, setView, showToast, init, askConfirm } = useStore();
  const [editing, setEditing] = useState<ModelConfig | null>(null);
  const [syncForm, setSyncForm] = useState<SyncConfig>(
    () => config?.sync ?? { repo_path: "", branch: "", remote_url: "", auto_push: false }
  );
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const models = config?.models ?? [];

  const updateSync = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      showToast(ok);
      await init();
    } catch (e) {
      showToast(`${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-view">
      <div className="settings-header">
        <div className="settings-header-inner">
          <button className="btn" onClick={() => setView("chat")}>
            <ArrowLeft size={14} /> 返回
          </button>
          <h2>设置</h2>
        </div>
      </div>

      <div className="settings-body">
        <div className="settings-intro">
          <h1>偏好设置</h1>
          <p>管理 AI 模型与多设备配置同步</p>
        </div>
        <section className="settings-card">
          <div className="card-title">
            <span className="card-title-label"><span className="settings-icon"><Bot size={18} /></span>AI 模型</span>
            <button className="btn primary" onClick={() => setEditing(blankModel())}>
              <Plus size={13} /> 添加模型
            </button>
          </div>
          <p className="card-desc">支持 OpenAI Chat Completions、OpenAI Responses 与 Anthropic 协议，可配置模型能力与 token 上限。</p>
          <div className="model-list">
            {models.map((m) => (
              <div key={m.id} className={`model-item${m.id === config?.active_model_id ? " active" : ""}`}>
                <div className="model-info">
                  <div className="model-name">
                    {m.name}
                    {m.id === config?.active_model_id && <span className="tree-tag key">默认</span>}
                  </div>
                  <div className="model-meta">{m.base_url} · {m.model}</div>
                </div>
                <div className="model-actions">
                  {m.id !== config?.active_model_id && (
                    <button
                      className="icon-btn"
                      title="设为默认"
                      onClick={() => updateSync(() => api.setActiveModel(m.id), "已设为默认模型")}
                    >
                      <Star size={14} />
                    </button>
                  )}
                  <button className="icon-btn" title="编辑" onClick={() => setEditing({ ...m })}>
                    ✎
                  </button>
                  <button
                    className="icon-btn danger"
                    title="删除"
                    onClick={() => {
                      void (async () => {
                        const ok = await askConfirm({
                          title: "删除模型",
                          message: `确定删除模型「${m.name}」?该操作不可撤销。`,
                          confirmText: "删除",
                          danger: true,
                        });
                        if (ok) await updateSync(() => api.deleteModel(m.id), "模型已删除");
                      })();
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
            {models.length === 0 && (
              <div className="settings-empty">
                <span className="settings-empty-icon"><Bot size={22} /></span>
                <strong>还没有配置 AI 模型</strong>
                <span>添加模型后，即可在对话中使用 AI 能力</span>
                <button className="btn" onClick={() => setEditing(blankModel())}>
                  <Plus size={13} /> 添加第一个模型
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="settings-card">
          <div className="card-title">
            <span className="card-title-label"><span className="settings-icon"><GitBranch size={18} /></span>Git 同步</span>
          </div>
          <p className="card-desc">
            将数据库连接与 AI 模型配置同步到 Git 仓库，实现多设备共享。配置包含敏感信息，请使用私有仓库。
          </p>
          <div className="form-grid settings-sync-form">
            <label>本地仓库路径</label>
            <input
              value={syncForm.repo_path}
              onChange={(e) => setSyncForm({ ...syncForm, repo_path: e.target.value })}
              placeholder="选择或输入本地私有仓库路径"
            />
            <label>远程仓库 URL</label>
            <input
              value={syncForm.remote_url}
              onChange={(e) => setSyncForm({ ...syncForm, remote_url: e.target.value })}
              placeholder="远程私有仓库地址（可选）"
            />
            <label>分支</label>
            <input
              value={syncForm.branch}
              onChange={(e) => setSyncForm({ ...syncForm, branch: e.target.value })}
              placeholder="留空使用默认分支"
            />
          </div>
          <div className="sync-actions">
            <button className="btn" disabled={busy} onClick={() => updateSync(async () => {
              await saveSyncForm(syncForm);
              await init();
              await api.syncInit();
            }, "同步仓库已初始化")}>
              <RefreshCw size={13} /> 初始化仓库
            </button>
            <button className="btn primary" disabled={busy} onClick={() => updateSync(async () => {
              await saveSyncForm(syncForm);
              await api.syncCommit("sync: 手动同步");
            }, "已提交并推送")}>
              <UploadCloud size={13} /> 提交并推送
            </button>
            <button className="btn" disabled={busy} onClick={() => updateSync(async () => {
              await api.syncPull();
              await init();
            }, "已拉取并应用远程配置")}>
              <DownloadCloud size={13} /> 拉取同步
            </button>
            <button className="btn" disabled={busy} onClick={() => updateSync(async () => {
              const s = await api.syncStatus();
              setStatus(s);
            }, "")}>
              查看状态
            </button>
          </div>
          {status && <pre className="sync-status">{status}</pre>}
        </section>
      </div>

      {editing && (
        <ModelEditDialog
          model={editing}
          onClose={() => setEditing(null)}
          onSave={async (m) => {
            await api.saveModel(m);
            await init();
            setEditing(null);
            showToast("模型已保存");
          }}
        />
      )}
    </div>
  );
}

async function saveSyncForm(sync: SyncConfig) {
  // 同步配置随主配置一起由后端持久化:通过 set 专用通道(复用 save_model 会污染 models,故直接走 Tauri 命令)
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_sync_config", { sync });
}

function ModelEditDialog({
  model,
  onClose,
  onSave,
}: {
  model: ModelConfig;
  onClose: () => void;
  onSave: (m: ModelConfig) => Promise<void>;
}) {
  const [form, setForm] = useState<ModelConfig>(model);
  const [testedConfig, setTestedConfig] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const configKey = JSON.stringify(form);
  const valid = !!form.name.trim() && !!form.base_url.trim() && !!form.model.trim() &&
    [form.input_tokens, form.output_tokens].every((value) => value === null || (Number.isInteger(value) && value >= 1 && value <= 4294967295));
  const suffixHelp = {
    openai: "填写基础地址（OpenAI 官方以 /v1 结尾）；自动追加 /chat/completions，请勿重复填写。",
    openai_responses: "填写基础地址（OpenAI 官方以 /v1 结尾）；自动追加 /responses，请勿重复填写。",
    anthropic: "填写基础地址（Anthropic 官方以 /v1 结尾）；自动追加 /messages，请勿重复填写。",
    gemini: "旧配置：填写含版本号的基础地址（通常以 /v1beta 结尾）；自动追加 /models/{模型 ID}:generateContent。",
  }[form.protocol];

  const test = async () => {
    setBusy(true);
    setTestStatus("正在测试模型…");
    setTestedConfig(null);
    try {
      await api.testModel(form);
      setTestedConfig(configKey);
      setTestStatus("测试成功，可以保存");
    } catch (e) {
      setTestStatus(`测试失败：${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{model.id ? "编辑模型" : "添加模型"}</h3>
        <div className="form-grid">
          <label>名称 *</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如 GPT-4o" />
          <label>协议 *</label>
          <select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value as ModelConfig["protocol"] })}>
            <option value="openai">OpenAI（Chat Completions）</option>
            <option value="openai_responses">OpenAI Responses</option>
            <option value="anthropic">Anthropic</option>
            {form.protocol === "gemini" && <option value="gemini">Gemini（旧配置）</option>}
          </select>
          <label>接口地址 *</label>
          <div className="model-url-field">
            <input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder={form.protocol === "gemini" ? "https://api.example.com/v1beta" : "https://api.example.com/v1"} />
            <span className="model-url-help">{suffixHelp}</span>
          </div>
          <label>API Key</label>
          <input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} />
          <label>模型 ID *</label>
          <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="gpt-4o-mini / deepseek-chat …" />
          <label>输入 token 大小</label>
          <input type="number" min="1" step="1" value={form.input_tokens ?? ""} onChange={(e) => setForm({ ...form, input_tokens: e.target.value === "" ? null : Number(e.target.value) })} placeholder="留空跟随模型" />
          <label>输出 token 大小</label>
          <input type="number" min="1" step="1" value={form.output_tokens ?? ""} onChange={(e) => setForm({ ...form, output_tokens: e.target.value === "" ? null : Number(e.target.value) })} placeholder={form.protocol === "anthropic" ? "留空使用 4096（协议必填）" : "留空跟随模型"} />
          <label>支持图片输入</label>
          <input type="checkbox" checked={form.supports_images} onChange={(e) => setForm({ ...form, supports_images: e.target.checked })} />
        </div>
        <div className="modal-actions">
          <span className="model-test-status" role="status">{testedConfig !== configKey && testStatus === "测试成功，可以保存" ? "配置已修改，请重新测试" : testStatus}</span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn" disabled={!valid || busy} onClick={test}>{busy && testStatus === "正在测试模型…" ? "测试中…" : "测试"}</button>
          <button
            className="btn primary"
            disabled={!valid || busy || testedConfig !== configKey}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(form);
              } catch (e) {
                setTestStatus(`保存失败：${e}`);
                setBusy(false);
              }
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
