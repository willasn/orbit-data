import { KIND_LABEL } from "../db/sqlCompletion";
import type { Suggestion } from "../db/sqlCompletion";
import type { SqlCompletionState } from "./useSqlCompletion";

/** SQL 补全候选弹层；placement="above" 用于贴在窗口底部的会话输入框 */
export function SqlCompletionPopup({
  completion,
  placement = "below",
  onAccept,
  onHighlight,
}: {
  completion: SqlCompletionState | null;
  placement?: "below" | "above";
  onAccept: (item: Suggestion) => void;
  onHighlight: (index: number) => void;
}) {
  if (!completion) return null;
  // 输入框位于窗口底部时向上展开，避免超出可视区域
  const style = placement === "above"
    ? { left: completion.left, top: Math.max(8, completion.top - 22), transform: "translateY(-100%)" }
    : { left: completion.left, top: completion.top };
  return (
    <div
      className="sql-completion"
      style={style}
      role="listbox"
      aria-label="SQL 补全候选"
      onMouseDown={(e) => e.preventDefault()}
    >
      {completion.items.map((item, i) => (
        <div
          key={`${item.kind}-${item.label}-${item.detail ?? ""}-${i}`}
          role="option"
          aria-selected={i === completion.index}
          className={`sql-completion-item${i === completion.index ? " active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onAccept(item);
          }}
          onMouseEnter={() => onHighlight(i)}
        >
          <span className="sql-completion-kind">{KIND_LABEL[item.kind]}</span>
          <span className="sql-completion-label">{item.label}</span>
          {item.detail && <span className="sql-completion-detail">{item.detail}</span>}
        </div>
      ))}
    </div>
  );
}
