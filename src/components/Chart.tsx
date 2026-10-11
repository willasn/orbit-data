import { useMemo, useState } from "react";
import type { QueryResult } from "../types";

const SERIES_COLORS = ["#6366f1", "#f59e0b", "#22c55e"];

/** 极简 SVG 图表:自动识别分类列(字符串)与数值列,柱状图 + 折线叠加 */
export default function Chart({ result }: { result: QueryResult }) {
  const [mode, setMode] = useState<"bar" | "line">("bar");

  const model = useMemo(() => {
    const isNumeric = (v: unknown) => typeof v === "number";
    const numericCols: number[] = [];
    let labelCol = -1;
    result.columns.forEach((_, ci) => {
      const col = result.rows.map((r) => r[ci]);
      if (col.every(isNumeric) && col.some((v) => v !== null)) numericCols.push(ci);
      else if (labelCol === -1 && col.every((v) => typeof v === "string" || v === null)) labelCol = ci;
    });
    if (labelCol === -1 && numericCols.length > 0) labelCol = 0;
    return { labelCol, numericCols: numericCols.filter((c) => c !== labelCol).slice(0, 3) };
  }, [result]);

  if (model.labelCol === -1 || model.numericCols.length === 0) {
    return (
      <div className="empty-hint center">
        当前结果缺少可绘制的数值列(需要一列文本 + 至少一列数字)
      </div>
    );
  }

  const labels = result.rows.map((r) => String(r[model.labelCol] ?? ""));
  const series = model.numericCols.map((ci) => ({
    name: result.columns[ci],
    values: result.rows.map((r) => Number(r[ci] ?? 0)),
  }));
  const max = Math.max(...series.flatMap((s) => s.values), 1);

  const W = 640, H = 260, PAD_L = 48, PAD_B = 28, PAD_T = 12;
  const innerW = W - PAD_L - 12;
  const innerH = H - PAD_T - PAD_B;
  const n = labels.length || 1;
  const x = (i: number) => PAD_L + (innerW / n) * (i + 0.5);
  const y = (v: number) => PAD_T + innerH - (v / max) * innerH;

  const barWidth = Math.max(4, (innerW / n) * 0.6);

  return (
    <div className="chart-wrap">
      <div className="chart-toolbar">
        <div className="chart-legend">
          {series.map((s, i) => (
            <span key={i}>
              <i style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
              {s.name}
            </span>
          ))}
        </div>
        <div className="chart-modes">
          <button className={mode === "bar" ? "active" : ""} onClick={() => setMode("bar")}>柱状</button>
          <button className={mode === "line" ? "active" : ""} onClick={() => setMode("line")}>折线</button>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - 12} y1={y(max * t)} y2={y(max * t)} className="grid-line" />
            <text x={PAD_L - 6} y={y(max * t) + 3} textAnchor="end" className="axis-text">
              {formatNum(max * t)}
            </text>
          </g>
        ))}
        {mode === "bar" &&
          series.map((s, si) =>
            s.values.map((v, i) => {
              const offset = (si - (series.length - 1) / 2) * (barWidth / Math.max(series.length, 1));
              return (
                <rect
                  key={`${si}-${i}`}
                  x={x(i) - barWidth / 2 + offset}
                  y={y(v)}
                  width={barWidth / Math.max(series.length, 1) - 2}
                  height={PAD_T + innerH - y(v)}
                  rx={2}
                  fill={SERIES_COLORS[si % SERIES_COLORS.length]}
                  opacity={0.85}
                />
              );
            })
          )}
        {mode === "line" &&
          series.map((s, si) => (
            <polyline
              key={si}
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
              fill="none"
              stroke={SERIES_COLORS[si % SERIES_COLORS.length]}
              strokeWidth={2}
            />
          ))}
        {labels.map((l, i) =>
          i % Math.ceil(n / 12) === 0 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" className="axis-text">
              {l.length > 8 ? l.slice(0, 7) + "…" : l}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}

function formatNum(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}
