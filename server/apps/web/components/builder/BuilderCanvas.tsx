"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { SCREEN, type WidgetNode } from "@ccp/shared";
import { useBuilder } from "./store";

function CanvasWidget({ widget }: { widget: WidgetNode }) {
  const select = useBuilder((s) => s.select);
  const selected = useBuilder((s) => s.selectedId === widget.id);
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: widget.id,
    data: { from: "canvas" },
  });

  const label =
    (widget.props?.text as string | undefined) ??
    (widget.type === "canvas" ? "WASM canvas" : widget.type);

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
        background: widget.style?.bg_color ?? "#181C22",
        color: widget.style?.text_color ?? "#EAECEF",
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
      }}
    >
      {label}
    </div>
  );
}

export function BuilderCanvas() {
  const widgets = useBuilder((s) => s.widgets);
  const orientation = useBuilder((s) => s.orientation);
  const select = useBuilder((s) => s.select);
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
          <CanvasWidget key={w.id} widget={w} />
        ))}
        <div className="absolute bottom-1 right-2 text-[10px] text-[var(--ccp-muted)] pointer-events-none">
          {screen.w}×{screen.h}
        </div>
      </div>
    </div>
  );
}
