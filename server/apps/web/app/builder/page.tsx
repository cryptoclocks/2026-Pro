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

  const buildLayout = () =>
    exportLayout({
      packageId: b.packageId,
      name: b.name,
      version: b.version,
      orientation: b.orientation,
      widgets: b.widgets,
    });

  const onExport = () => {
    try {
      downloadLayout(buildLayout());
      setMessage("layout.json exported ✓");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const onPublish = async () => {
    try {
      const layout = buildLayout();
      const api = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
      // server-side validation against the device layout schema
      const res = await fetch(`${api}/api/v1/payloads/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ layout }),
      });
      const ok = res.ok ? (await res.json()).ok : false;
      if (!ok) throw new Error(`server rejected layout: ${await res.text()}`);
      downloadLayout(layout);
      setMessage(
        `✓ Validated & saved layout.json for "${layout.meta.name}" (${layout.meta.id}).\n\n` +
          "To put this page on displays:\n" +
          "1. Package it:  python3 firmware/tools/make_package.py <dir> bundle.zip\n" +
          "2. Publish:     POST /api/v1/payloads/publish (uploads bundle + manifest)\n" +
          "3. Assign:      POST /api/v1/devices/{id}/assign  (or sell it in the Store)\n" +
          "4. The device pulls the bundle over MQTT cmd:sync and swaps the page\n" +
          "   live — no reflash. (Bundle hosting needs the M5 object store online.)",
      );
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

        <select
          className="px-2 py-1 rounded bg-[var(--ccp-panel)] border border-[var(--ccp-border)]"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) b.loadTemplate(e.target.value as never);
            e.target.value = "";
          }}
          title="Load a starter page"
        >
          <option value="">Load template…</option>
          <option value="clock">Clock</option>
          <option value="crypto">Crypto</option>
          <option value="welcome">Welcome</option>
          <option value="blank">Blank</option>
        </select>

        <button
          onClick={b.toggleSimulate}
          className={`px-3 py-1.5 rounded border ${
            b.simulate
              ? "bg-[var(--ccp-accent)] text-black border-transparent font-semibold"
              : "border-[var(--ccp-border)]"
          }`}
          title="Preview with mock live data"
        >
          {b.simulate ? "● Simulating" : "▶ Simulate"}
        </button>

        <button
          onClick={onExport}
          className="ml-auto px-4 py-1.5 rounded border border-[var(--ccp-border)]"
        >
          Export layout.json
        </button>
        <button
          onClick={onPublish}
          className="px-4 py-1.5 rounded bg-[var(--ccp-accent)] text-black font-semibold"
        >
          Publish…
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
