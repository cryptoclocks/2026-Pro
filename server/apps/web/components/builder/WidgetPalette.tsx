"use client";

import { useDraggable } from "@dnd-kit/core";
import { WIDGET_TYPES, type WidgetType } from "@ccp/shared";
import { useBuilder } from "./store";

function PaletteItem({ type }: { type: WidgetType }) {
  const addWidget = useBuilder((s) => s.addWidget);
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: `palette-${type}`,
    data: { from: "palette", type },
  });

  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => addWidget(type)}
      className="w-full text-left px-3 py-1.5 rounded text-sm border border-[var(--ccp-border)] bg-[var(--ccp-panel)] hover:border-[var(--ccp-accent)] cursor-grab"
      style={
        transform
          ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 50, position: "relative" }
          : undefined
      }
    >
      {type}
    </button>
  );
}

export function WidgetPalette() {
  return (
    <section className="w-full space-y-1">
      <h2 className="text-xs uppercase tracking-wide text-[var(--ccp-muted)] mb-2">Widgets</h2>
      {WIDGET_TYPES.map((t) => (
        <PaletteItem key={t} type={t} />
      ))}
    </section>
  );
}
