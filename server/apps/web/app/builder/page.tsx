"use client";

import { useState } from "react";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import type { WidgetType } from "@ccp/shared";
import { useBuilder } from "@/components/builder/store";
import { WidgetPalette } from "@/components/builder/WidgetPalette";
import { BuilderCanvas } from "@/components/builder/BuilderCanvas";
import { Inspector } from "@/components/builder/Inspector";
import { exportLayout, downloadLayout } from "@/components/builder/exportLayout";

export default function BuilderPage() {
  const b = useBuilder();
  const [message, setMessage] = useState<string | null>(null);

  const onDragEnd = (e: DragEndEvent) => {
    const data = e.active.data.current as { from: string; type?: WidgetType } | undefined;
    if (!data) return;

    if (data.from === "canvas") {
      b.moveWidget(String(e.active.id), e.delta.x, e.delta.y);
    } else if (data.from === "palette" && data.type && e.over?.id === "artboard") {
      // drop position relative to the artboard
      const artboard = document.getElementById("ccp-artboard")?.getBoundingClientRect();
      const rect = e.active.rect.current.translated;
      const x = artboard && rect ? rect.left - artboard.left : 20;
      const y = artboard && rect ? rect.top - artboard.top : 20;
      b.addWidget(data.type, Math.max(0, x), Math.max(0, y));
    }
  };

  const onExport = () => {
    try {
      const layout = exportLayout({
        packageId: b.packageId,
        name: b.name,
        version: b.version,
        orientation: b.orientation,
        widgets: b.widgets,
      });
      downloadLayout(layout);
      setMessage("layout.json exported ✓");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="p-4 h-[calc(100vh-49px)] flex flex-col gap-3">
      <div className="flex items-center gap-3 text-sm">
        <input
          className="px-2 py-1 rounded bg-[var(--ccp-panel)] border border-[var(--ccp-border)] w-52"
          value={b.packageId}
          onChange={(e) => b.setMeta({ packageId: e.target.value })}
          title="package id (reverse-DNS)"
        />
        <input
          className="px-2 py-1 rounded bg-[var(--ccp-panel)] border border-[var(--ccp-border)] w-40"
          value={b.name}
          onChange={(e) => b.setMeta({ name: e.target.value })}
          title="display name"
        />
        <input
          className="px-2 py-1 rounded bg-[var(--ccp-panel)] border border-[var(--ccp-border)] w-20"
          value={b.version}
          onChange={(e) => b.setMeta({ version: e.target.value })}
          title="semver"
        />
        <select
          className="px-2 py-1 rounded bg-[var(--ccp-panel)] border border-[var(--ccp-border)]"
          value={b.orientation}
          onChange={(e) => b.setOrientation(e.target.value as "landscape" | "portrait")}
        >
          <option value="landscape">landscape 480×320</option>
          <option value="portrait">portrait 320×480</option>
        </select>
        <button
          onClick={onExport}
          className="ml-auto px-4 py-1.5 rounded bg-[var(--ccp-accent)] text-black font-semibold"
        >
          Export layout.json
        </button>
      </div>

      {message && (
        <pre className="text-xs whitespace-pre-wrap text-[var(--ccp-muted)] border border-[var(--ccp-border)] rounded p-2">
          {message}
        </pre>
      )}

      <DndContext onDragEnd={onDragEnd}>
        <div className="flex gap-4 flex-1 min-h-0">
          <WidgetPalette />
          <BuilderCanvas />
          <Inspector />
        </div>
      </DndContext>
    </main>
  );
}
