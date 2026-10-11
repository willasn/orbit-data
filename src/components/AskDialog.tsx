import { useEffect, useState } from "react";
import { useStore } from "../store";

/** 应用内输入 / 确认弹窗（替代 window.prompt / window.confirm：macOS 的 WKWebView 不会弹出原生 prompt） */
export default function AskDialog() {
  const ask = useStore((s) => s.ask);
  const resolveAsk = useStore((s) => s.resolveAsk);
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(ask?.value ?? "");
  }, [ask]);

  // 确认类弹窗没有输入框，焦点不在弹窗内：Esc / Enter 需要在窗口级监听
  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolveAsk(null);
      } else if (e.key === "Enter" && ask.kind === "confirm") {
        e.preventDefault();
        resolveAsk("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask, resolveAsk]);

  if (!ask) return null;
  const isText = ask.kind === "text";
  const mismatch = (!!ask.expect && value !== ask.expect)
    || (!!ask.options && !ask.options.some((option) => option.value === value));
  const submit = () => {
    if (isText && mismatch) return;
    resolveAsk(isText ? value : "");
  };

  return (
    <div className="modal-mask" onClick={() => resolveAsk(null)}>
      <div
        className="modal ask-modal"
        role="dialog"
        aria-modal="true"
        aria-label={ask.title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            resolveAsk(null);
          }
        }}
      >
        <h3>{ask.title}</h3>
        {ask.message && <p className="ask-message">{ask.message}</p>}
        {isText && (
          <div className="form-grid">
            {ask.options ? (
              <select
                autoFocus
                aria-label={ask.title}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              >
                {ask.options.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              <input
                autoFocus
                aria-label={ask.title}
                value={value}
                placeholder={ask.placeholder ?? ""}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  submit();
                }}
              />
            )}
          </div>
        )}
        {isText && ask.expect && mismatch && (
          <p className="create-object-error" role="alert">输入与「{ask.expect}」不一致</p>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={() => resolveAsk(null)}>取消</button>
          <button
            className={`btn primary${ask.danger ? " danger" : ""}`}
            disabled={isText && mismatch}
            onClick={submit}
          >
            {ask.confirmText ?? "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
