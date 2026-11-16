import { useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { driverOf } from "../db/drivers";
import { collectSuggestions, filterSuggestions, wordBeforeCaret } from "../db/sqlCompletion";
import type { Suggestion } from "../db/sqlCompletion";
import { useStore } from "../store";
import type { Connection } from "../types";

/** 补全弹层宽度，用于右侧边界收拢（与 styles.css 中 .sql-completion 保持一致） */
export const SQL_COMPLETION_WIDTH = 300;

export interface SqlCompletionState {
  items: Suggestion[];
  index: number;
  /** 触发补全时的候选词起始下标 */
  start: number;
  left: number;
  top: number;
}

/** 用镜像节点测量光标在 textarea 中的坐标（相对容器，按软换行后的实际位置） */
function caretPoint(ta: HTMLTextAreaElement, panel: HTMLElement, text: string, index: number) {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "anywhere";
  mirror.style.fontFamily = cs.fontFamily;
  mirror.style.fontSize = cs.fontSize;
  mirror.style.fontWeight = cs.fontWeight;
  mirror.style.fontStyle = cs.fontStyle;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.padding = cs.padding;
  mirror.style.border = "0";
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.textContent = text.slice(0, index);
  const marker = document.createElement("span");
  // 只取光标所在行的剩余内容，避免后续换行影响测量
  marker.textContent = text.slice(index).split("\n")[0] || "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const x = marker.offsetLeft;
  const y = marker.offsetTop;
  document.body.removeChild(mirror);
  const lineHeight = parseFloat(cs.lineHeight) || 18;
  const taRect = ta.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  // 绝对定位以容器 padding 盒为原点，需扣除容器内边距
  const panelCs = getComputedStyle(panel);
  const padLeft = parseFloat(panelCs.paddingLeft) || 0;
  const padTop = parseFloat(panelCs.paddingTop) || 0;
  return {
    left: taRect.left - panelRect.left + x - ta.scrollLeft - padLeft,
    top: taRect.top - panelRect.top + y - ta.scrollTop + lineHeight - padTop,
  };
}

/**
 * SQL 自动补全：关键字 + 当前连接的库 / 表 / 列。
 * SQL 编辑器面板与会话合并输入框共用同一套逻辑。
 */
export function useSqlCompletion({
  conn,
  setValue,
  textareaRef,
  containerRef,
}: {
  conn: Connection | null;
  setValue: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  containerRef: RefObject<HTMLElement>;
}) {
  const [completion, setCompletion] = useState<SqlCompletionState | null>(null);
  const seq = useRef(0);

  const closeCompletion = () => setCompletion(null);

  /** 丢弃未返回的补全请求并关闭弹层（切换连接 / 库时用） */
  const resetCompletion = () => {
    seq.current += 1;
    setCompletion(null);
  };

  /** 打开补全：拉取当前连接的真实元数据后按候选词过滤 */
  const requestCompletion = (text: string, caret: number, force = false) => {
    if (!conn || !driverOf(conn.db_type).caps.sql) {
      setCompletion(null);
      return;
    }
    const { word, start } = wordBeforeCaret(text, caret);
    if (!force && word.length < 2) {
      setCompletion(null);
      return;
    }
    const id = ++seq.current;
    const tree = useStore.getState().dbTree[conn.id];
    void collectSuggestions({
      conn,
      currentDb: tree?.selectedDb || conn.database,
      databases: tree?.databases ?? null,
      tables: tree?.tables ?? null,
      tablesDb: tree?.tablesDb ?? "",
      columns: tree?.columns ?? null,
      columnsTable: tree?.columnsTable ?? "",
      selectedTable: tree?.selectedTable ?? "",
      sql: text,
    }).then((all) => {
      if (id !== seq.current) return;
      const items = filterSuggestions(all, word);
      const ta = textareaRef.current;
      const container = containerRef.current;
      if (!items.length || !ta || !container) {
        setCompletion(null);
        return;
      }
      const point = caretPoint(ta, container, text, start);
      const left = Math.max(8, Math.min(point.left, container.clientWidth - SQL_COMPLETION_WIDTH - 8));
      setCompletion({ items, index: 0, start, left, top: point.top });
    });
  };

  const acceptCompletion = (item: Suggestion) => {
    const ta = textareaRef.current;
    if (!ta || !completion) return;
    const text = ta.value;
    const caret = Math.max(ta.selectionStart, completion.start);
    setValue(text.slice(0, completion.start) + item.label + text.slice(caret));
    setCompletion(null);
    const pos = completion.start + item.label.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const highlight = (index: number) => {
    setCompletion((prev) => (prev ? { ...prev, index } : prev));
  };

  /** 处理补全相关按键；返回 true 表示已消费，调用方不再处理该按键 */
  const handleCompletionKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return false;
    if ((e.metaKey || e.ctrlKey) && (e.key === " " || e.code === "Space")) {
      e.preventDefault();
      requestCompletion(e.currentTarget.value, e.currentTarget.selectionStart, true);
      return true;
    }
    if (!completion) return false;
    const size = completion.items.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCompletion({ ...completion, index: (completion.index + 1) % size });
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCompletion({ ...completion, index: (completion.index - 1 + size) % size });
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      acceptCompletion(completion.items[completion.index]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setCompletion(null);
      return true;
    }
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
      setCompletion(null);
    }
    return false;
  };

  return { completion, requestCompletion, acceptCompletion, handleCompletionKey, highlight, closeCompletion, resetCompletion };
}
