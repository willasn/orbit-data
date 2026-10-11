import { useEffect, useRef, useState } from "react";

const LIMITS: Record<"left" | "right", [number, number]> = {
  left: [180, 560],
  right: [260, 760],
};

interface Props {
  side: "left" | "right";
  width: number;
  onResize: (width: number) => void;
}

/** 左右栏之间的可拖动分隔条 */
export default function PanelResizer({ side, width, onResize }: Props) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });

  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("resizing");
    return () => document.body.classList.remove("resizing");
  }, [dragging]);

  const clamp = (w: number) => {
    const [min, max] = LIMITS[side];
    return Math.min(max, Math.max(min, w));
  };

  return (
    <div
      className={`panel-resizer${dragging ? " dragging" : ""}`}
      title="拖动调整宽度"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const delta = e.clientX - start.current.x;
        onResize(clamp(start.current.width + (side === "left" ? delta : -delta)));
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
      }}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => onResize(side === "left" ? 264 : 372)}
    />
  );
}
