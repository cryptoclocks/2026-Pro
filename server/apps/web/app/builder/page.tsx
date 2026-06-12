"use client";

import { useEffect, useRef, useState } from "react";
import { DndContext, DragOverlay, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import type { Layout, WidgetType } from "@ccp/shared";
import { NOOP_LOGIC_SOURCE, UNAVAILABLE_LOGIC_SOURCE, useBuilder, type CompiledWasm, type WasmModuleConfig } from "@/components/builder/store";
import { WidgetPalette } from "@/components/builder/WidgetPalette";
import { BuilderCanvas } from "@/components/builder/BuilderCanvas";
import { Inspector } from "@/components/builder/Inspector";
import { exportLayout, downloadLayout } from "@/components/builder/exportLayout";
import { SimSession, base64ToBytes, getSimSession, useSim } from "@/components/builder/wasmSim";
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

type SavedBuilderPage = {
  packageId: string;
  title: string;
  latest: { version: string; createdAt: string; sizeBytes: number };
  marketplaceItem?: { slug: string; published: boolean } | null;
};

type BuilderPageResponse = SavedBuilderPage & {
  latest: SavedBuilderPage["latest"] & { layout: Layout };
};

export default function BuilderPage() {
  const b = useBuilder();
  const { me, token } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [logicOpen, setLogicOpen] = useState(false);
  const [busy, setBusy] = useState<"compile" | "publish" | "load" | null>(null);
  const [savedPages, setSavedPages] = useState<SavedBuilderPage[]>([]);
  const [simEpoch, setSimEpoch] = useState(0);
  const simRef = useRef<SimSession | null>(null);

  useEffect(() => setMounted(true), []);

  /* Simulate = run the page for real: compile (if needed) and execute the same
     wasm the device gets, fed with real time / live market data. */
  useEffect(() => {
    if (!b.simulate) return;
    let cancelled = false;
    (async () => {
      const state = useBuilder.getState();
      useSim.getState().reset();
      let compiled = state.compiledWasm;
      const wantsWasm =
        state.logicSource !== NOOP_LOGIC_SOURCE && state.logicSource !== UNAVAILABLE_LOGIC_SOURCE;
      if (wantsWasm && !compiled) {
        useSim.getState().pushLog("sys", "compiling Rust logic for simulation…");
        try {
          compiled = await compileLogic(state.logicSource);
          state.setCompiledWasm(compiled);
          state.upsertWasmModule({ id: compiled.moduleId, path: compiled.path, memory_kb: 128 });
          useSim.getState().pushLog("sys", `compiled ${compiled.path} (${compiled.sizeBytes} bytes)`);
        } catch (err) {
          useSim.getState().pushLog("err", `compile failed: ${err instanceof Error ? err.message : String(err)}`);
          compiled = null;
        }
      }
      if (cancelled) return;
      const session = await SimSession.start({
        widgets: state.widgets,
        dataSources: state.dataSources,
        wasmBytes: compiled && wantsWasm ? base64ToBytes(compiled.wasmBase64) : null,
        defaultTickMs: state.wasmModules[0]?.tick_ms,
      });
      if (cancelled) {
        session.stop();
        return;
      }
      simRef.current = session;
    })().catch((err) => {
      useSim.getState().pushLog("err", err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
      simRef.current?.stop();
      simRef.current = null;
    };
  }, [b.simulate, simEpoch]);

  useEffect(() => {
    if (!token || !me?.id) {
      setSavedPages([]);
      return;
    }
    fetch(`${API}/api/v1/payloads/builder-pages`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readApiError(res));
        return res.json() as Promise<SavedBuilderPage[]>;
      })
      .then(setSavedPages)
      .catch((err) => console.debug("[builder] saved-pages:load-failed", err));
  }, [token, me?.id]);

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
      assets: b.assets,
      logicSource: b.logicSource,
      widgets: b.widgets,
    });

  const refreshSavedPages = async () => {
    if (!token || !me?.id) return;
    const res = await fetch(`${API}/api/v1/payloads/builder-pages`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(await readApiError(res));
    setSavedPages((await res.json()) as SavedBuilderPage[]);
  };

  const loadSavedPage = async (packageId: string) => {
    if (!packageId || !token) return;
    try {
      setBusy("load");
      console.debug("[builder] saved-page:load", { packageId });
      const res = await fetch(`${API}/api/v1/payloads/builder-pages/${encodeURIComponent(packageId)}/latest`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const json = (await res.json()) as BuilderPageResponse;
      b.loadLayout(json.latest.layout);
      setMessage(
        `✓ Opened "${json.title}" ${json.latest.version} from server\n\n` +
          "Edits now happen on this saved page. Use Save / Publish to write a new bundle/version back to the Hub.",
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

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

      // Auto-bump the patch version when re-publishing an existing page so every
      // entitled CryptoClock sees a new version and re-downloads (the device
      // caches by package@version and skips an identical one).
      const existing = savedPages.find((p) => p.packageId === layout.meta.id);
      if (me?.id && existing) {
        const next = bumpPatch(existing.latest.version);
        layout.meta.version = next;
        b.setMeta({ version: next });
      }
      console.debug("[builder] publish:start", { packageId: layout.meta.id, version: layout.meta.version });

      if (!me?.id) {
        const res = await fetch(`${API}/api/v1/payloads/validate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ layout }),
        });
        if (!res.ok) throw new Error(await readApiError(res));
        setMessage(
          `✓ Layout is valid for "${layout.meta.name}".\n\n` +
            "Sign in as admin, then press Save / Publish to save it into the Hub and Store. Use Export layout.json only when you explicitly want a local file.",
        );
        return;
      }

      const savedPackageExists = savedPages.some((page) => page.packageId === layout.meta.id);
      const hasWasm = (layout.wasm?.length ?? 0) > 0;
      const logicChanged = b.logicSource !== b.logicStarterSource;
      const compilable = b.logicSource !== UNAVAILABLE_LOGIC_SOURCE && b.logicSource !== NOOP_LOGIC_SOURCE;

      // Auto-compile when needed so visual-only edits (e.g. moving a widget) just
      // work. We only skip compiling when the logic is unchanged AND the page is
      // already on the hub (the server carries the previous wasm forward).
      let compiled = b.compiledWasm;
      if (hasWasm && !compiled && (logicChanged || !savedPackageExists)) {
        if (!compilable) {
          throw new Error("This page's Rust source isn't available to compile. Open Edit Logic and paste the source, or Reset page logic.");
        }
        setMessage("Compiling page logic…");
        compiled = await compileLogic(b.logicSource);
        b.setCompiledWasm(compiled);
        b.upsertWasmModule({ id: compiled.moduleId, path: compiled.path, memory_kb: 128 });
      }

      // Fetch each asset's bytes (from web/public for built-ins, or its data: URL
      // for uploads) and ship them as base64. Skip ones already on the hub
      // (server carries them forward) so re-publishes don't re-upload megabytes.
      const assetFiles: { path: string; base64: string }[] = [];
      if (b.assets.length) {
        setMessage("Bundling assets…");
        for (const asset of b.assets) {
          try {
            const buf = await (await fetch(asset.src)).arrayBuffer();
            assetFiles.push({ path: asset.path, base64: bytesToBase64(new Uint8Array(buf)) });
          } catch (err) {
            if (!savedPackageExists) throw new Error(`Could not read asset "${asset.id}": ${err instanceof Error ? err.message : err}`);
            // on re-publish a fetch failure is non-fatal — the server keeps the prior file
          }
        }
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
          wasmFiles: compiled
            ? [{ path: compiled.path, wasmBase64: compiled.wasmBase64 }]
            : [],
          assetFiles,
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
        pushedToDevices?: number;
        marketplaceItem?: { slug: string; title: string; published: boolean };
      };
      console.debug("[builder] publish:done", published);
      await refreshSavedPages();
      setMessage(
        `✓ Saved / Published "${layout.meta.name}" ${published.version}\n\n` +
          `PayloadVersion: ${published.payloadVersionId}\n` +
          (published.marketplaceItem ? `Store item: ${published.marketplaceItem.slug} (${published.marketplaceItem.published ? "published" : "draft"})\n` : "") +
          `Bundle: ${published.bundleUrl}\n` +
          `SHA256: ${published.bundleSha256}\n` +
          `Size: ${published.sizeBytes} bytes\n\n` +
          (published.pushedToDevices
            ? `✓ Auto-updated ${published.pushedToDevices} CryptoClock${published.pushedToDevices === 1 ? "" : "s"} already entitled to this page (MQTT sync sent — they re-download within seconds, no re-grant needed).`
            : "No devices own this page yet. Grant it from Fleet → Rights and the device downloads this bundle without reflashing."),
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
      if (b.logicSource === UNAVAILABLE_LOGIC_SOURCE) {
        throw new Error("This older page has no saved Rust source. Paste the source or click Reset page logic before compiling.");
      }
      console.debug("[builder] compile:start", { moduleId: "logic", sourceBytes: new Blob([b.logicSource]).size });
      const compiled = await compileLogic(b.logicSource);
      b.setCompiledWasm(compiled);
      b.upsertWasmModule({ id: compiled.moduleId, path: compiled.path, memory_kb: 128 });
      console.debug("[builder] compile:done", { path: compiled.path, sizeBytes: compiled.sizeBytes, sha256: compiled.sha256 });
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
            title="Starter template: creates an editable copy, not a live device page"
          >
            <option value="">Starter template…</option>
            <option value="clock">Clock</option>
            <option value="crypto">Crypto</option>
            <option value="weather">Weather</option>
            <option value="welcome">Welcome</option>
            <option value="led_toggle">LED Toggle</option>
            <option value="blank">Blank</option>
          </select>

          <select
            className="px-2 py-1 rounded bg-[var(--ccp-panel)] border border-[var(--ccp-border)] w-48"
            value=""
            disabled={!token || busy !== null}
            onChange={(e) => {
              void loadSavedPage(e.target.value);
              e.target.value = "";
            }}
            title="Open a page already saved/published on the Hub"
          >
            <option value="">{token ? "Open saved page…" : "Sign in to open saved pages"}</option>
            {savedPages.map((page) => (
              <option key={page.packageId} value={page.packageId}>
                {page.title} {page.latest.version}
              </option>
            ))}
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
              Edit Properties
            </button>
            <button
              onClick={() => b.setSimulate(true)}
              className={`px-3 py-1.5 border-l border-[var(--ccp-border)] ${
                b.simulate ? "bg-[var(--ccp-accent)] text-black font-semibold" : "bg-[var(--ccp-panel)]"
              }`}
            >
              Simulate
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
            {busy === "publish" ? "Saving…" : "Save / Publish"}
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
          {b.simulate ? <SimulateInspector onRestart={() => setSimEpoch((n) => n + 1)} /> : <Inspector />}
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
  busy: "compile" | "publish" | "load" | null;
  onClose: () => void;
  onCompile: () => void;
}) {
  const source = useBuilder((s) => s.logicSource);
  const setSource = useBuilder((s) => s.setLogicSource);
  const resetSource = useBuilder((s) => s.resetLogicSource);
  const compiled = useBuilder((s) => s.compiledWasm);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 p-4 flex items-center justify-center">
      <section className="w-[min(1100px,96vw)] h-[min(780px,92vh)] rounded-lg border border-[var(--ccp-border)] bg-[var(--ccp-bg)] shadow-2xl flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--ccp-border)] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-semibold text-[var(--ccp-fg)]">Page Logic</h2>
            <p className="text-xs text-[var(--ccp-muted)] truncate">
              Rust source for this page only. Compile to attach wasm/logic.wasm before publishing.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button className="btn px-3 py-1.5 text-xs" onClick={resetSource}>
              Reset page logic
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

function SimulateInspector({ onRestart }: { onRestart: () => void }) {
  const wasmStatus = useSim((s) => s.wasmStatus);
  const ticks = useSim((s) => s.ticks);
  const logs = useSim((s) => s.logs);
  const streams = useSim((s) => s.streams);
  const compiled = useBuilder((s) => s.compiledWasm);
  const [stream, setStream] = useState("");
  const [payload, setPayload] = useState('{"price": 64000}');
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs.length]);

  const statusLabel =
    wasmStatus === "running"
      ? `wasm running · ${compiled ? `${compiled.sizeBytes} bytes` : ""} · ${ticks} ticks`
      : wasmStatus === "error"
        ? "wasm error — see log"
        : "bindings only (no wasm logic)";
  const statusColor =
    wasmStatus === "running" ? "text-[#0ECB81]" : wasmStatus === "error" ? "text-[#F6465D]" : "text-[var(--ccp-muted)]";
  const MODE_LABEL: Record<string, string> = {
    time: "real time",
    binance: "live Binance",
    mock: "mock once",
    manual: "manual",
  };

  return (
    <aside className="min-h-0 overflow-y-auto text-xs text-[var(--ccp-muted)] border border-[var(--ccp-border)] rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="uppercase tracking-wide text-[var(--ccp-accent)]">Simulation</h2>
        <button className="btn py-1 px-2 text-xs" onClick={onRestart}>Restart</button>
      </div>

      <div className={`rounded border border-[var(--ccp-border)] p-2 ${statusColor}`}>
        {statusLabel}
        <div className="text-[10px] text-[var(--ccp-muted)] mt-1">
          This runs the exact wasm a CryptoClock receives — clicks, ticks and data go through the same ABI.
        </div>
      </div>

      <section>
        <h3 className="uppercase tracking-wide mb-1">Data streams</h3>
        {streams.length === 0 && <div className="text-[var(--ccp-muted)]">none (add Data Sources or subscribe in logic)</div>}
        <div className="space-y-1">
          {streams.map((s) => (
            <div key={s.stream} className="rounded border border-[var(--ccp-border)] p-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[var(--ccp-fg)] truncate">{s.stream}</span>
                <span className="shrink-0 px-1 rounded bg-[var(--ccp-panel-2)]">{MODE_LABEL[s.mode]}</span>
              </div>
              {s.lastAt && (
                <div className="text-[10px] truncate" title={s.lastPayload}>
                  {s.lastAt} · {s.lastPayload}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="uppercase tracking-wide mb-1">Send test payload</h3>
        <select className="select w-full text-xs px-2 py-1 mb-1" value={stream} onChange={(e) => setStream(e.target.value)}>
          <option value="">choose stream…</option>
          {streams.map((s) => (
            <option key={s.stream} value={s.stream}>{s.stream}</option>
          ))}
        </select>
        <textarea
          className="input w-full text-xs px-2 py-1 font-mono h-16 resize-none"
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
        />
        <button
          className="btn w-full py-1 text-xs mt-1"
          disabled={!stream}
          onClick={() => getSimSession()?.deliver(stream, payload)}
        >
          Deliver to page
        </button>
      </section>

      <section className="flex flex-col min-h-0">
        <h3 className="uppercase tracking-wide mb-1">Log</h3>
        <div ref={logRef} className="rounded border border-[var(--ccp-border)] bg-[#050808] p-2 h-44 overflow-y-auto font-mono text-[10px] space-y-0.5">
          {logs.map((l, i) => (
            <div
              key={i}
              className={
                l.level === "err" ? "text-[#F6465D]" : l.level === "warn" ? "text-[#F0B90B]" : l.level === "sys" ? "text-[#15c3a6]" : "text-[#DCEBE7]"
              }
            >
              {l.at} {l.msg}
            </div>
          ))}
          {logs.length === 0 && <div>—</div>}
        </div>
      </section>
    </aside>
  );
}

async function compileLogic(source: string): Promise<CompiledWasm> {
  const res = await fetch(`${API}/api/v1/payloads/compile-wasm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, moduleId: "logic" }),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  const json = (await res.json()) as CompileWasmResponse;
  return {
    moduleId: json.moduleId,
    path: json.path,
    sizeBytes: json.sizeBytes,
    sha256: json.sha256,
    wasmBase64: json.wasmBase64,
    compiledAt: new Date().toISOString(),
    diagnostics: json.diagnostics,
  };
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

const MAX_ASSET_BYTES = 4 * 1024 * 1024;

/** slug a filename base for use as an asset id: "My Logo.png" -> "my_logo" */
function assetIdFromName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return base || "asset";
}

/** Upload page assets (PNG/GIF/WAV) from disk; on Publish they're bundled into
    the package zip and the device extracts them to its SD card. */
function AssetsPanel() {
  const assets = useBuilder((s) => s.assets);
  const addAsset = useBuilder((s) => s.addAsset);
  const removeAsset = useBuilder((s) => s.removeAsset);
  const [err, setErr] = useState<string | null>(null);

  const onFiles = (files: FileList | null) => {
    setErr(null);
    for (const file of Array.from(files ?? [])) {
      const ext = (file.name.split(".").pop() || "bin").toLowerCase();
      const type =
        ext === "gif" ? "gif" :
        ext === "png" ? "image" :
        ext === "wav" ? "audio" :
        ext === "ttf" || ext === "otf" ? "font" : "bin";
      if (ext === "jpg" || ext === "jpeg") { setErr("JPEG can't be decoded on the device — use PNG."); continue; }
      if (file.size > MAX_ASSET_BYTES) { setErr(`${file.name} is too big (max 4MB).`); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        const id = assetIdFromName(file.name);
        addAsset({ id, type, path: `assets/${id}.${ext}`, src: reader.result as string, sizeBytes: file.size });
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <section className="border border-[var(--ccp-border)] rounded-lg p-3 min-w-0">
      <div className="flex items-center justify-between mb-2">
        <h2 className="uppercase tracking-wide text-[var(--ccp-muted)]">Assets</h2>
        <label className="btn py-1 px-2 text-xs cursor-pointer">
          Upload
          <input type="file" accept=".png,.gif,.wav,.ttf,.otf" multiple className="hidden"
            onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
        </label>
      </div>
      {err && <div className="text-[var(--ccp-down)] mb-2">{err}</div>}
      {assets.length === 0 ? (
        <div className="text-[var(--ccp-muted)]">none — upload a PNG/GIF (e.g. a logo) and reference it from an image/gif widget&apos;s src.</div>
      ) : (
        <div className="space-y-1">
          {assets.map((a) => (
            <div key={a.id} className="flex items-center gap-2 border-t border-[var(--ccp-border)]/60 pt-1 first:border-t-0 first:pt-0">
              {(a.type === "image" || a.type === "gif") && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.src} alt={a.id} className="w-8 h-8 object-contain rounded bg-black/20 shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[var(--ccp-text)]">{a.id} <span className="text-[var(--ccp-muted)]">· {a.type}</span></div>
                <div className="truncate text-[10px] text-[var(--ccp-muted)]">{a.path}{a.sizeBytes ? ` · ${Math.ceil(a.sizeBytes / 1024)}KB` : ""}</div>
              </div>
              <button className="btn py-1 px-2 text-xs" onClick={() => removeAsset(a.id)}>×</button>
            </div>
          ))}
        </div>
      )}
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
      <AssetsPanel />
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

/** Uint8Array -> base64 (chunked to avoid call-stack limits on large assets). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** "1.2.3" -> "1.2.4"; falls back to appending .1 for non-semver strings. */
function bumpPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return `${version}.1`;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
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
