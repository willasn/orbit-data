import { useEffect, useMemo, useRef, useState } from "react";
import { Check, RotateCcw } from "lucide-react";
import type { CellValue, QueryResult, RowUpdate, Tab } from "../types";
import { useStore } from "../store";

type ResultTab = Extract<Tab, { kind: "result" }>;

function sameValue(a: CellValue, b: CellValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return String(a) === String(b);
}

/**
 * 查询结果表格。
 * 传入带 `edit` 上下文的结果标签页时支持就地修改：双击单元格编辑，按主键生成 UPDATE 后提交。
 */
export default function DataGrid({ result, tab }: { result: QueryResult; tab?: ResultTab }) {
  const source = tab?.edit;
  const [edits, setEdits] = useState<Record<number, Record<number, CellValue>>>({});
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const editingRef = useRef<{ row: number; col: number } | null>(null);

  useEffect(() => {
    setEdits({});
    setEditing(null);
    editingRef.current = null;
  }, [result]);

  /** 结果列 -> 表列（表达式 / 聚合列映射为空，不可编辑） */
  const columnOf = useMemo<(string | null)[]>(() => {
    if (!source) return result.columns.map(() => null);
    const map: Record<string, string> = {};
    for (const [display, column] of Object.entries(source.columnMap)) {
      map[display.toLowerCase()] = column;
    }
    return result.columns.map((c) => map[c.toLowerCase()] ?? null);
  }, [source, result.columns]);

  /** 主键列在结果中的下标：全部存在才允许提交 */
  const keyColumns = useMemo(() => {
    if (!source) return [];
    return source.pkColumns
      .map((pk) => ({
        column: pk,
        index: columnOf.findIndex((c) => c?.toLowerCase() === pk.toLowerCase()),
      }))
      .filter((k) => k.index >= 0);
  }, [source, columnOf]);

  const editable = !!source && keyColumns.length === source.pkColumns.length && keyColumns.length > 0;
  const changeCount = useMemo(
    () => Object.values(edits).reduce((n, row) => n + Object.keys(row).length, 0),
    [edits],
  );

  const valueAt = (ri: number, ci: number): CellValue => {
    const row = edits[ri];
    if (row && Object.prototype.hasOwnProperty.call(row, ci)) return row[ci];
    return result.rows[ri][ci];
  };

  const isDirty = (ri: number, ci: number) =>
    !!edits[ri] && Object.prototype.hasOwnProperty.call(edits[ri], ci);

  const startEdit = (ri: number, ci: number) => {
    if (!editable || !columnOf[ci]) return;
    const current = valueAt(ri, ci);
    editingRef.current = { row: ri, col: ci };
    setEditing({ row: ri, col: ci });
    setDraft(current === null ? "" : String(current));
  };

  const finishEdit = (commit: boolean) => {
    const target = editingRef.current;
    editingRef.current = null;
    setEditing(null);
    if (!commit || !target) return;
    const original = result.rows[target.row][target.col];
    const raw = draft;
    let next: CellValue;
    if (/^null$/i.test(raw.trim())) next = null;
    else if (typeof original === "number" && raw.trim() !== "" && !Number.isNaN(Number(raw))) {
      next = Number(raw);
    } else next = raw;

    setEdits((prev) => {
      const row = { ...(prev[target.row] ?? {}) };
      if (sameValue(next, original)) delete row[target.col];
      else row[target.col] = next;
      const out = { ...prev };
      if (Object.keys(row).length) out[target.row] = row;
      else delete out[target.row];
      return out;
    });
  };

  const submit = async () => {
    if (!source || !tab || busy) return;
    const rows: RowUpdate[] = Object.entries(edits)
      .map(([ri, cols]) => {
        const row = result.rows[Number(ri)];
        return {
          keys: keyColumns.map((k) => ({ column: k.column, value: row[k.index] })),
          values: Object.entries(cols).map(([ci, value]) => ({
            column: columnOf[Number(ci)] as string,
            value,
          })),
        };
      })
      .filter((row) => row.values.length > 0 && row.keys.length > 0);
    if (!rows.length) return;
    setBusy(true);
    const ok = await useStore.getState().commitResultEdits(tab.id, rows);
    setBusy(false);
    if (ok) {
      setEdits({});
      editingRef.current = null;
      setEditing(null);
    }
  };

  if (result.columns.length === 0) {
    return (
      <div className="empty-hint center">
        执行成功,无结果集(影响 {result.row_count} 行 · {result.duration_ms}ms)
      </div>
    );
  }
  return (
    <div className="datagrid-wrap">
      <div className="datagrid-meta">
        {result.meta ? `${result.meta} · ` : ""}
        {result.row_count} 行 · {result.duration_ms}ms
      </div>
      {source && (
        <div className="grid-edit-bar">
          <span className="grid-edit-hint">
            {editable
              ? `可编辑 · ${source.table} · 主键 ${source.pkColumns.join(", ")} · 双击单元格修改，输入 NULL 设为空`
              : `只读 · 结果中缺少主键列（${source.pkColumns.join(", ")}）`}
          </span>
          <span className="grid-edit-count">{changeCount ? `已修改 ${changeCount} 处` : "未修改"}</span>
          <button
            className="btn"
            disabled={!changeCount || busy}
            onClick={() => {
              setEdits({});
              editingRef.current = null;
              setEditing(null);
            }}
          >
            <RotateCcw size={12} /> 撤销
          </button>
          <button className="btn primary" disabled={!changeCount || busy} onClick={() => void submit()}>
            <Check size={12} /> {busy ? "提交中…" : "提交"}
          </button>
        </div>
      )}
      <div className="datagrid-scroll">
        <table className="datagrid">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {result.columns.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, ri) => (
              <tr key={ri}>
                <td className="rownum">{ri + 1}</td>
                {row.map((cell, ci) => {
                  const isEditing = editing?.row === ri && editing?.col === ci;
                  const value = valueAt(ri, ci);
                  const cellEditable = editable && !!columnOf[ci];
                  if (isEditing) {
                    return (
                      <td key={ci} className="cell-editing">
                        <input
                          className="cell-editor"
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                            if (e.key === "Enter") {
                              e.preventDefault();
                              finishEdit(true);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              finishEdit(false);
                            }
                          }}
                          onBlur={() => finishEdit(true)}
                        />
                      </td>
                    );
                  }
                  return (
                    <td
                      key={ci}
                      className={[
                        value === null ? "null" : typeof value === "number" ? "num" : "",
                        /^Create (Table|View)$/i.test(result.columns[ci]) ? "ddl-cell" : "",
                        isDirty(ri, ci) ? "cell-dirty" : "",
                        cellEditable ? "cell-editable" : "",
                      ].filter(Boolean).join(" ")}
                      title={typeof value === "string" ? value : undefined}
                      onDoubleClick={() => startEdit(ri, ci)}
                    >
                      {value === null ? "NULL" : String(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
