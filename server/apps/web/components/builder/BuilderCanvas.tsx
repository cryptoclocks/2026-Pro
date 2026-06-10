"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { SCREEN, type WidgetNode } from "@ccp/shared";
import { useBuilder } from "./store";
import { resolveText } from "./templates";

/** A tiny mock candlestick chart shown for chart widgets in simulate mode. */
function MockCandles() {
  const bars = [
    [0.4, 0.7, 1], [0.6, 0.9, 1], [0.5, 0.6, -1], [0.3, 0.55, 1],
    [0.5, 0.8, 1], [0.7, 0.75, -1], [0.45, 0.85, 1], [0.6, 0.7, -1],
    [0.4, 0.9, 1], [0.65, 0.95, 1], [0.7, 0.6, -1], [0.4, 0.7, 1],
  ];
  return (
    <div className="w-full h-full flex items-end justify-around px-1 pb-1">
      {bars.map(([lo, hi, dir], i) => (
        <div key={i} className="relative" style={{ width: 6 }}>
          <div
            style={{
              position: "absolute", left: 2.5, width: 1, bottom: `${lo * 70}%`,
              height: `${(hi - lo) * 70 + 18}%`,
              background: dir > 0 ? "#0ECB81" : "#F6465D",
            }}
          />
          <div
            style={{
              position: "absolute", left: 0, width: 6, bottom: `${lo * 70 + 6}%`,
              height: `${(hi - lo) * 55 + 8}%`,
              background: dir > 0 ? "#0ECB81" : "#F6465D",
            }}
          />
        </div>
      ))}
    </div>
  );
}

function CanvasWidget({ widget, simulate }: { widget: WidgetNode; simulate: boolean }) {
  const select = useBuilder((s) => s.select);
  const selected = useBuilder((s) => s.selectedId === widget.id);
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: widget.id,
    data: { from: "canvas" },
  });

  const bound = simulate ? resolveText(widget) : null;
  const hasBinding = (widget.bindings?.length ?? 0) > 0;
  const label =
    bound ??
    (widget.props?.text as string | undefined) ??
    (widget.type === "canvas" ? "WASM canvas" : widget.type);

  const isChart = widget.type === "chart";

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={(e) => {
        e.stopPropagation();
        select(widget.id);
      }}
      className={`absolute flex items-center justify-center text-xs overflow-hidden cursor-move select-none rounded ${
        selected ? "ring-2 ring-[var(--ccp-accent)]" : "ring-1 ring-[var(--ccp-border)]"
      }`}
      style={{
        left: widget.x,
        top: widget.y,
        width: widget.w,
        height: widget.h,
        background: widget.style?.bg_color ?? (isChart ? "#161B22" : "#181C22"),
        color: widget.style?.text_color ?? "#EAECEF",
        textAlign: (widget.style?.align as "left" | "center" | "right") ?? "center",
        fontSize: widget.h >= 70 ? 26 : 12,
        borderRadius: widget.style?.radius ?? 4,
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
      }}
    >
      {isChart && simulate ? <MockCandles /> : label}
      {hasBinding && !simulate && (
        <span className="absolute top-0 right-0 text-[8px] bg-[var(--ccp-accent)] text-black px-1 rounded-bl">
          ⛓
        </span>
      )}
    </div>
  );
}

export function BuilderCanvas() {
  const widgets = useBuilder((s) => s.widgets);
  const orientation = useBuilder((s) => s.orientation);
  const select = useBuilder((s) => s.select);
  const simulate = useBuilder((s) => s.simulate);
  const screen = SCREEN[orientation];
  const { setNodeRef } = useDroppable({ id: "artboard" });

  return (
    <div className="flex-1 flex items-center justify-center">
      <div
        ref={setNodeRef}
        id="ccp-artboard"
        onClick={() => select(null)}
        className="relative shrink-0 rounded-lg shadow-2xl border border-[var(--ccp-border)] overflow-hidden"
        style={{ width: screen.w, height: screen.h, background: "#0B0E11" }}
      >
        {widgets.map((w) => (
          <CanvasWidget key={w.id} widget={w} simulate={simulate} />
        ))}
        <div className="absolute bottom-1 right-2 text-[10px] text-[var(--ccp-muted)] pointer-events-none">
          {screen.w}×{screen.h}{simulate ? " · SIM" : ""}
        </div>
      </div>
    </div>
  );
}
