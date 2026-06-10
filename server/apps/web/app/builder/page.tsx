"use client";

import { useEffect, useState } from "react";
import { DndContext, DragOverlay, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import type { WidgetType } from "@ccp/shared";
import { DEFAULT_LOGIC_SOURCE, useBuilder, type CompiledWasm, type WasmModuleConfig } from "@/components/builder/store";
import { WidgetPalette } from "@/components/builder/WidgetPalette";
import { BuilderCanvas } from "@/components/builder/BuilderCanvas";
import { Inspector } from "@/components/builder/Inspector";
import { exportLayout, downloadLayout } from "@/components/builder/exportLayout";
import { API, useAuth } from "@/lib/auth";

type CompileWasmResponse = {
  ok: true;
  moduleId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  wasmBase64: string;
  diagnostics?: string;
};

export default function BuilderPage() {
  const b = useBuilder();
  const { me, token } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [logicOpen, setLogicOpen] = useState(false);
  const [busy, setBusy] = useState<"compile" | "publish" | null>(null);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <main className="h-[calc(100vh-49px)] p-4">
        <div className="h-full rounded-lg border border-[var(--ccp-border)] bg-[var(--ccp-panel)]" />
      </main>
    );
  }

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as { from: string; type?: WidgetType } | undefined;
    setDragLabel(data?.type ?? String(e.active.id));
  };

  const onDragEnd = (e: DragEndEvent) => {
    const data = e.active.data.current as { from: string; type?: WidgetType } | undefined;
    setDragLabel(null);
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

  const wasmModulesForExport = () =>
    b.compiledWasm
      ? upsertWasmModuleList(b.wasmModules, {
          id: b.compiledWasm.moduleId,
          path: b.compiledWasm.path,
          memory_kb: 128,
        })
      : b.wasmModules;

  const buildLayout = () =>
    exportLayout({
      packageId: b.packageId,
      name: b.name,
      version: b.version,
      orientation: b.orientation,
      dataSources: b.dataSources,
      wasmModules: wasmModulesForExport(),
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
      setBusy("publish");
      const layout = buildLayout();

      if (!me?.id) {
        const res = await fetch(`${API}/api/v1/payloads/validate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ layout }),
        });
        if (!res.ok) throw new Error(await readApiError(res));
        downloadLayout(layout);
        setMessage(
          `✓ Layout validated and exported for "${layout.meta.name}".\n\n` +
            "Login as admin before publishing to the server/store or assigning this page to a device.",
        );
        return;
      }

      const res = await fetch(`${API}/api/v1/payloads/publish-compiled`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          ownerId: me.id,
          title: layout.meta.name,
          version: layout.meta.version,
          layout,
          wasmFiles: b.compiledWasm
            ? [{ path: b.compiledWasm.path, wasmBase64: b.compiledWasm.wasmBase64 }]
            : [],
        }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const published = (await res.json()) as {
        payloadVersionId: string;
        packageId: string;
        version: string;
        bundleUrl: string;
        bundleSha256: string;
        sizeBytes: number;
      };
      setMessage(
        `✓ Published "${layout.meta.name}" ${published.version}\n\n` +
          `PayloadVersion: ${published.payloadVersionId}\n` +
          `Bundle: ${published.bundleUrl}\n` +
          `SHA256: ${published.bundleSha256}\n` +
          `Size: ${published.sizeBytes} bytes\n\n` +
          "Next: assign this PayloadVersion to a device. The server will push MQTT cmd:sync and the ESP32 downloads this bundle without reflashing.",
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onCompileLogic = async () => {
    try {
      setBusy("compile");
      const res = await fetch(`${API}/api/v1/payloads/compile-wasm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: b.logicSource, moduleId: "logic" }),
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const json = (await res.json()) as CompileWasmResponse;
      const compiled: CompiledWasm = {
        moduleId: json.moduleId,
        path: json.path,
        sizeBytes: json.sizeBytes,
        sha256: json.sha256,
        wasmBase64: json.wasmBase64,
        compiledAt: new Date().toISOString(),
        diagnostics: json.diagnostics,
      };
      b.setCompiledWasm(compiled);
      b.upsertWasmModule({ id: compiled.moduleId, path: compiled.path, memory_kb: 128 });
      setMessage(`✓ Logic compiled to ${compiled.path} (${compiled.sizeBytes} bytes)\nSHA256: ${compiled.sha256}`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="h-[calc(100vh-49px)] overflow-hidden p-4 flex flex-col gap-3">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 text-sm shrink-0">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <input
            className="px-2 py-1 rounded bg-[var(--ccp-panel)] border border-[var(--ccp-border)] w-48"
            value={b.packageId}
            onChange={(e) => b.setMeta({ packageId: e.target.value })}
            title="package id (reverse-DNS)"
          />
          <input
            className="px-2 py-1 rounded bg-[var(--ccp-panel)] border border-[var(--ccp-border)] w-36"
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
            className="px-2 py-1 rounded bg-[var(--ccp-panel)] border border-[var(--ccp-border)] w-40"
            value={b.orientation}
            onChange={(e) => b.setOrientation(e.target.value as "landscape" | "portrait")}
          >
            <option value="landscape">landscape 480×320</option>
            <option value="portrait">portrait 320×480</option>
          </select>

          <select
            className="px-2 py-1 rounded bg-[var(--ccp-panel)] border border-[var(--ccp-border)] w-36"
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
            <option value="led_toggle">LED Toggle</option>
            <option value="blank">Blank</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex overflow-hidden rounded border border-[var(--ccp-border)]">
            <button
              onClick={() => b.setSimulate(false)}
              className={`px-3 py-1.5 ${
                !b.simulate ? "bg-[var(--ccp-accent)] text-black font-semibold" : "bg-[var(--ccp-panel)]"
              }`}
            >
              Edit
            </button>
            <button
              onClick={() => b.setSimulate(true)}
              className={`px-3 py-1.5 border-l border-[var(--ccp-border)] ${
                b.simulate ? "bg-[var(--ccp-accent)] text-black font-semibold" : "bg-[var(--ccp-panel)]"
              }`}
            >
              ▶ Simulate
            </button>
          </div>

          <button
            onClick={() => setLogicOpen(true)}
            className="px-4 py-1.5 rounded border border-[var(--ccp-border)] bg-[var(--ccp-panel)]"
          >
            Edit Logic
          </button>
          <button
            onClick={onExport}
            className="px-4 py-1.5 rounded border border-[var(--ccp-border)]"
          >
            Export layout.json
          </button>
          <button
            onClick={onPublish}
            disabled={busy !== null}
            className="px-4 py-1.5 rounded bg-[var(--ccp-accent)] text-black font-semibold"
          >
            {busy === "publish" ? "Publishing…" : "Publish…"}
          </button>
        </div>
      </div>

      {message && (
        <pre className="text-xs whitespace-pre-wrap text-[var(--ccp-muted)] border border-[var(--ccp-border)] rounded p-2">
          {message}
        </pre>
      )}

      <DndContext onDragStart={onDragStart} onDragCancel={() => setDragLabel(null)} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-[280px_minmax(520px,1fr)_320px] gap-4 flex-1 min-h-0">
          <BuilderSidebar />
          <BuilderCanvas />
          <Inspector />
        </div>
        <DragOverlay>
          {dragLabel ? (
            <div className="px-3 py-2 rounded border border-[var(--ccp-accent)] bg-[var(--ccp-panel)] text-sm shadow-2xl">
              {dragLabel}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <LogicEditor
        open={logicOpen}
        busy={busy}
        onClose={() => setLogicOpen(false)}
        onCompile={onCompileLogic}
      />
    </main>
  );
}

function LogicEditor({
  open,
  busy,
  onClose,
  onCompile,
}: {
  open: boolean;
  busy: "compile" | "publish" | null;
  onClose: () => void;
  onCompile: () => void;
}) {
  const source = useBuilder((s) => s.logicSource);
  const setSource = useBuilder((s) => s.setLogicSource);
  const compiled = useBuilder((s) => s.compiledWasm);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center">
      <section className="w-[min(1100px,96vw)] h-[min(780px,92vh)] rounded-lg border border-[var(--ccp-border)] bg-[var(--ccp-bg)] shadow-2xl flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--ccp-border)] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-semibold text-[var(--ccp-fg)]">Page Logic</h2>
            <p className="text-xs text-[var(--ccp-muted)] truncate">
              Rust source compiled by the server into wasm/page.wasm for this page only.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button className="btn px-3 py-1.5 text-xs" onClick={() => setSource(DEFAULT_LOGIC_SOURCE)}>
              Reset template
            </button>
            <button className="btn px-3 py-1.5 text-xs" onClick={onCompile} disabled={busy !== null}>
              {busy === "compile" ? "Compiling…" : "Compile Rust"}
            </button>
            <button className="btn px-3 py-1.5 text-xs" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <textarea
          className="flex-1 min-h-0 w-full resize-none bg-[#050808] text-[#DCEBE7] font-mono text-xs leading-relaxed p-4 outline-none border-0"
          spellCheck={false}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <div className="px-4 py-2 border-t border-[var(--ccp-border)] text-xs text-[var(--ccp-muted)] flex flex-wrap items-center gap-x-4 gap-y-1">
          {compiled ? (
            <>
              <span>{compiled.path}</span>
              <span>{compiled.sizeBytes} bytes</span>
              <span className="truncate max-w-[520px]">sha256 {compiled.sha256}</span>
            </>
          ) : (
            <span>Compile before publishing when this page needs custom Rust logic.</span>
          )}
        </div>
      </section>
    </div>
  );
}

function BuilderSidebar() {
  return (
    <aside className="min-h-0 overflow-y-auto pr-1 space-y-4">
      <WidgetPalette />
      <LayersPanel />
      <LayoutDataPanel />
    </aside>
  );
}

function LayersPanel() {
  const widgets = useBuilder((s) => s.widgets);
  const selectedId = useBuilder((s) => s.selectedId);
  const select = useBuilder((s) => s.select);

  if (widgets.length === 0) return null;

  return (
    <section className="border border-[var(--ccp-border)] rounded-lg p-3 min-w-0 text-xs">
      <h2 className="uppercase tracking-wide text-[var(--ccp-muted)] mb-2">Layers</h2>
      <div className="space-y-1">
        {widgets.map((w) => (
          <button
            key={w.id}
            className={`w-full grid grid-cols-[1fr_auto] gap-2 text-left px-2 py-1.5 rounded border ${
              selectedId === w.id
                ? "border-[var(--ccp-accent)] text-[var(--ccp-accent)] bg-[var(--ccp-panel-2)]"
                : "border-[var(--ccp-border)] bg-[var(--ccp-panel)]"
            }`}
            onClick={() => select(w.id)}
          >
            <span className="truncate">{w.id}</span>
            <span className="text-[var(--ccp-muted)]">{w.type}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function LayoutDataPanel() {
  const dataSources = useBuilder((s) => s.dataSources);
  const wasmModules = useBuilder((s) => s.wasmModules);
  const updateDataSource = useBuilder((s) => s.updateDataSource);
  const addDataSource = useBuilder((s) => s.addDataSource);
  const removeDataSource = useBuilder((s) => s.removeDataSource);
  const updateWasmModule = useBuilder((s) => s.updateWasmModule);
  const addWasmModule = useBuilder((s) => s.addWasmModule);
  const removeWasmModule = useBuilder((s) => s.removeWasmModule);

  return (
    <div className="space-y-4 text-xs">
      <section className="border border-[var(--ccp-border)] rounded-lg p-3 min-w-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="uppercase tracking-wide text-[var(--ccp-muted)]">Data Sources</h2>
          <button className="btn py-1 px-2 text-xs" onClick={addDataSource}>Add</button>
        </div>
        <div className="space-y-2">
          {dataSources.map((d, i) => (
            <div key={i} className="grid gap-2 border-t border-[var(--ccp-border)]/60 pt-2 first:border-t-0 first:pt-0">
              <div className="grid grid-cols-[1fr_72px_auto] gap-2">
                <input className="input text-xs px-2 py-1 min-w-0" value={d.id} placeholder="crypto" onChange={(e) => updateDataSource(i, { id: e.target.value })} />
                <select className="select text-xs px-2 py-1" value={d.format} onChange={(e) => updateDataSource(i, { format: e.target.value as "json" | "raw" })}>
                  <option value="json">json</option>
                  <option value="raw">raw</option>
                </select>
                <button className="btn py-1 px-2 text-xs" onClick={() => removeDataSource(i)}>×</button>
              </div>
              <input className="input text-xs px-2 py-1 w-full" value={d.stream} placeholder="market.BTCUSDT.ticker" onChange={(e) => updateDataSource(i, { stream: e.target.value })} />
              <input className="input text-xs px-2 py-1 w-full" type="number" value={d.sample_hint_ms ?? ""} placeholder="sample hint ms" onChange={(e) => updateDataSource(i, { sample_hint_ms: e.target.value ? Number(e.target.value) : undefined })} />
            </div>
          ))}
        </div>
      </section>

      <section className="border border-[var(--ccp-border)] rounded-lg p-3 min-w-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="uppercase tracking-wide text-[var(--ccp-muted)]">WASM Logic</h2>
          <button className="btn py-1 px-2 text-xs" onClick={addWasmModule}>Add</button>
        </div>
        <div className="space-y-2">
          {wasmModules.map((m, i) => (
            <div key={i} className="grid gap-2 border-t border-[var(--ccp-border)]/60 pt-2 first:border-t-0 first:pt-0">
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <input className="input text-xs px-2 py-1 min-w-0" value={m.id} placeholder="logic" onChange={(e) => updateWasmModule(i, { id: e.target.value })} />
                <button className="btn py-1 px-2 text-xs" onClick={() => removeWasmModule(i)}>×</button>
              </div>
              <input className="input text-xs px-2 py-1 w-full" value={m.path} placeholder="wasm/app.wasm" onChange={(e) => updateWasmModule(i, { path: e.target.value })} />
              <div className="grid grid-cols-2 gap-2">
                <input className="input text-xs px-2 py-1 min-w-0" type="number" value={m.tick_ms ?? ""} placeholder="tick ms" onChange={(e) => updateWasmModule(i, { tick_ms: e.target.value ? Number(e.target.value) : undefined })} />
                <input className="input text-xs px-2 py-1 min-w-0" type="number" value={m.memory_kb ?? ""} placeholder="memory KB" onChange={(e) => updateWasmModule(i, { memory_kb: e.target.value ? Number(e.target.value) : undefined })} />
              </div>
              <input className="input text-xs px-2 py-1 w-full" value={(m.canvas_ids ?? []).join(",")} placeholder="canvas ids" onChange={(e) => updateWasmModule(i, { canvas_ids: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function upsertWasmModuleList(list: WasmModuleConfig[], module: WasmModuleConfig) {
  return list.some((m) => m.id === module.id)
    ? list.map((m) => (m.id === module.id ? { ...m, ...module } : m))
    : [...list, module];
}

async function readApiError(res: Response) {
  const text = await res.text();
  if (!text) return `${res.status} ${res.statusText}`;
  try {
    const json = JSON.parse(text) as { message?: unknown; diagnostics?: unknown };
    const message = Array.isArray(json.message) ? json.message.join("\n") : json.message;
    return [message, json.diagnostics].filter(Boolean).join("\n") || text;
  } catch {
    return text;
  }
}
