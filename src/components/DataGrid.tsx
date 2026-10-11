import type { QueryResult } from "../types";

export default function DataGrid({ result }: { result: QueryResult }) {
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
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={cell === null ? "null" : typeof cell === "number" ? "num" : /^Create (Table|View)$/i.test(result.columns[ci]) ? "ddl-cell" : ""}
                    title={typeof cell === "string" ? cell : undefined}
                  >
                    {cell === null ? "NULL" : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
