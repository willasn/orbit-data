import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MenuEntry } from "../db/menuItems";

interface Props {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}

/** 通用右键菜单外壳：定位翻转、外部点击关闭、键盘导航 */
export default function ContextMenu({ x, y, entries, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  const enabled = entries.map((e, i) => (e.sep || e.planned ? -1 : i)).filter((i) => i >= 0);
  const [active, setActive] = useState(enabled[0] ?? 0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - w - 8)),
      top: Math.max(4, Math.min(y, window.innerHeight - h - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    setActive(enabled[0] ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (enabled.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const cur = enabled.indexOf(active);
        const next =
          e.key === "ArrowDown"
            ? (cur + 1) % enabled.length
            : (cur - 1 + enabled.length) % enabled.length;
        setActive(enabled[next]);
        return;
      }
      if (e.key === "Enter") {
        const entry = entries[active];
        if (entry && !entry.planned) {
          entry.run?.();
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, enabled, entries, onClose]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu">
      {entries.map((e, i) =>
        e.sep ? (
          <div className="ctx-sep" key={e.id} />
        ) : (
          <button
            key={e.id}
            role="menuitem"
            className={`ctx-item${e.danger ? " danger" : ""}${e.planned ? " planned" : ""}${
              i === active && !e.planned ? " active" : ""
            }`}
            title={e.planned ? "设计已确定,功能未实现" : e.hint}
            disabled={e.planned}
            onMouseEnter={() => !e.planned && setActive(i)}
            onClick={() => {
              e.run?.();
              onClose();
            }}
          >
            <span className="ctx-label">{e.label}</span>
            {e.planned && <span className="ctx-tag">规划中</span>}
          </button>
        )
      )}
    </div>
  );
}
