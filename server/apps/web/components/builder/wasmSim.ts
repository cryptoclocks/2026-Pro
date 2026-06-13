"use client";

/*
 * Browser simulator for CCP WASM page logic.
 *
 * Runs the exact wasm binary the device will run (compiled by the server from
 * the page's Rust source) against a JS implementation of the firmware host ABI
 * (schema/abi/ccp_abi_v1.md). Widget mutations are written to a separate
 * "overrides" store so simulation never dirties the design state.
 */

import { create } from "zustand";
import type { WidgetNode } from "@ccp/shared";
import { MOCK } from "./templates";
import type { DataSourceConfig } from "./store";

/* ------------------------------------------------------------ sim store */

export type SimOverride = {
  text?: string;
  src?: string;
  value?: number;
  series?: number[];
  bg?: string;
  textColor?: string;
  indicatorColor?: string;
  hidden?: boolean;
  checked?: boolean;
  on?: boolean;
  ledColor?: string;
};

export type SimLog = { at: string; level: "err" | "warn" | "info" | "dbg" | "sys"; msg: string };

export type SimStreamInfo = {
  source: string;
  stream: string;
  mode: "time" | "binance" | "mock" | "manual" | "settings";
  lastAt?: string;
  lastPayload?: string;
};

interface SimState {
  wasmStatus: "none" | "running" | "error";
  ticks: number;
  overrides: Record<string, SimOverride>;
  logs: SimLog[];
  streams: SimStreamInfo[];
  patchOverride: (id: string, patch: SimOverride) => void;
  reset: () => void;
  pushLog: (level: SimLog["level"], msg: string) => void;
  setWasmStatus: (s: SimState["wasmStatus"]) => void;
  bumpTicks: () => void;
  setStreams: (streams: SimStreamInfo[]) => void;
  markStream: (stream: string, payload: string) => void;
}

export const useSim = create<SimState>((set, get) => ({
  wasmStatus: "none",
  ticks: 0,
  overrides: {},
  logs: [],
  streams: [],
  patchOverride: (id, patch) =>
    set({ overrides: { ...get().overrides, [id]: { ...get().overrides[id], ...patch } } }),
  reset: () => set({ overrides: {}, logs: [], streams: [], ticks: 0, wasmStatus: "none" }),
  pushLog: (level, msg) =>
    set({
      logs: [...get().logs.slice(-199), { at: new Date().toLocaleTimeString(), level, msg }],
    }),
  setWasmStatus: (wasmStatus) => set({ wasmStatus }),
  bumpTicks: () => set({ ticks: get().ticks + 1 }),
  setStreams: (streams) => set({ streams }),
  markStream: (stream, payload) =>
    set({
      streams: get().streams.map((s) =>
        s.stream === stream
          ? { ...s, lastAt: new Date().toLocaleTimeString(), lastPayload: payload.slice(0, 160) }
          : s,
      ),
    }),
}));

/* ----------------------------------------------------- canvas registry */

const canvasRegistry = new Map<string, HTMLCanvasElement>();

export function registerSimCanvas(id: string, el: HTMLCanvasElement | null) {
  if (el) canvasRegistry.set(id, el);
  else canvasRegistry.delete(id);
}

/* ------------------------------------------------------- wasm exports */

type WasmExports = {
  memory: WebAssembly.Memory;
  ccp_on_init: (abi: number) => number;
  ccp_on_tick?: (now: bigint) => void;
  ccp_on_event?: (w: number, e: number, p0: number, p1: number) => void;
  ccp_on_data?: (h: number, ptr: number, len: number) => void;
  ccp_on_destroy?: () => void;
  ccp_malloc?: (n: number) => number;
  ccp_free?: (ptr: number) => void;
};

export const CCP_EVT = {
  PRESSED: 1,
  PRESSING: 2,
  RELEASED: 3,
  CLICKED: 4,
  LONG_PRESSED: 5,
  VALUE_CHANGED: 6,
  GESTURE: 7,
  DRAG: 8,
} as const;

const hex = (argb: number) => `#${(argb & 0xffffff).toString(16).padStart(6, "0")}`;
/** Rough luminance check so the LED demo's "dark = off" color reads as off. */
const isDark = (argb: number) => {
  const r = (argb >> 16) & 0xff, g = (argb >> 8) & 0xff, b = argb & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.16;
};

/* ----------------------------------------------------------- session */

export class SimSession {
  private exports: WasmExports | null = null;
  private widgetIds: string[] = [];
  private widgetTypes: Record<string, string> = {};
  private subs: string[] = []; // index = stream handle
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private feeders: ReturnType<typeof setInterval>[] = [];
  private widgets: WidgetNode[] = [];
  private audioCtx: AudioContext | null = null;
  private stopped = false;
  private binancePrice: Record<string, number> = {};
  /** values the user set in the settings_schema form; seeded to settings.<slug> */
  private settingsValues: Record<string, unknown> = {};

  static async start(opts: {
    widgets: WidgetNode[];
    dataSources: DataSourceConfig[];
    settingsValues?: Record<string, unknown>;
    wasmBytes: Uint8Array | null;
    defaultTickMs?: number;
  }): Promise<SimSession> {
    const s = new SimSession();
    s.widgets = opts.widgets;
    s.widgetIds = opts.widgets.map((w) => w.id);
    for (const w of opts.widgets) s.widgetTypes[w.id] = w.type;
    s.settingsValues = opts.settingsValues ?? {};

    s.startFeeders(opts.dataSources);

    if (opts.wasmBytes) {
      try {
        await s.instantiate(opts.wasmBytes, opts.defaultTickMs);
        useSim.getState().setWasmStatus("running");
        useSim.getState().pushLog("sys", `wasm loaded (${opts.wasmBytes.length} bytes) — ccp_on_init ok`);
      } catch (err) {
        useSim.getState().setWasmStatus("error");
        useSim.getState().pushLog("err", `wasm: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      useSim.getState().pushLog("sys", "no wasm logic — simulating bindings only");
    }
    activeSession = s;
    return s;
  }

  stop() {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const f of this.feeders) clearInterval(f);
    try {
      this.exports?.ccp_on_destroy?.();
    } catch {
      /* module already broken — ignore on teardown */
    }
    this.exports = null;
    if (activeSession === this) activeSession = null;
    useSim.getState().reset();
  }

  /* ------------------------------------------------------ wasm runtime */

  private async instantiate(bytes: Uint8Array, defaultTickMs?: number) {
    const sim = useSim.getState();
    const mem = () => new Uint8Array(this.exports!.memory.buffer);
    const readStr = (ptr: number, len: number) =>
      new TextDecoder().decode(mem().slice(ptr, ptr + len));
    const widgetId = (w: number) => this.widgetIds[w];
    const patch = (w: number, p: SimOverride) => {
      const id = widgetId(w);
      if (id) useSim.getState().patchOverride(id, p);
    };
    const ok = 0, errInval = -1, errNotFound = -2;

    const env: Record<string, (...args: never[]) => unknown> = {
      /* ---- UI ---- */
      ccp_ui_get_widget: (ptr: number, len: number) => {
        const id = readStr(ptr, len);
        const idx = this.widgetIds.indexOf(id);
        if (idx < 0) sim.pushLog("warn", `ccp_ui_get_widget("${id}") -> not found`);
        return idx >= 0 ? idx : errNotFound;
      },
      ccp_ui_set_text: (w: number, ptr: number, len: number) => {
        if (!widgetId(w)) return errNotFound;
        patch(w, { text: readStr(ptr, len) });
        return ok;
      },
      ccp_ui_set_value: (w: number, value: number) => {
        const id = widgetId(w);
        if (!id) return errNotFound;
        if (this.widgetTypes[id] === "switch") patch(w, { checked: value !== 0 });
        else patch(w, { value });
        return ok;
      },
      ccp_ui_set_color: (w: number, argb: number, part: number) => {
        const id = widgetId(w);
        if (!id) return errNotFound;
        const color = hex(argb);
        if (this.widgetTypes[id] === "led") patch(w, { ledColor: color, on: !isDark(argb) });
        else if (part === 1) patch(w, { textColor: color });
        else if (part === 2) patch(w, { indicatorColor: color });
        else patch(w, { bg: color });
        return ok;
      },
      ccp_ui_set_visible: (w: number, visible: number) => {
        if (!widgetId(w)) return errNotFound;
        patch(w, { hidden: !visible });
        return ok;
      },
      ccp_ui_show_page: (ptr: number, len: number) => {
        sim.pushLog("info", `ccp_ui_show_page("${readStr(ptr, len)}") — single page in Builder`);
        return ok;
      },

      /* ---- canvas ---- */
      ccp_canvas_blit: (w: number, x: number, y: number, bw: number, bh: number, ptr: number, byteLen: number) => {
        const ctx = this.canvasCtx(w);
        if (!ctx) return errNotFound;
        if (bw <= 0 || bh <= 0 || byteLen < bw * bh * 2) return errInval;
        const src = mem().slice(ptr, ptr + bw * bh * 2);
        const img = ctx.createImageData(bw, bh);
        for (let i = 0; i < bw * bh; i++) {
          const px = src[i * 2] | (src[i * 2 + 1] << 8); // rgb565 LE
          img.data[i * 4] = ((px >> 11) & 0x1f) << 3;
          img.data[i * 4 + 1] = ((px >> 5) & 0x3f) << 2;
          img.data[i * 4 + 2] = (px & 0x1f) << 3;
          img.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, x, y);
        return ok;
      },
      ccp_canvas_fill_rect: (w: number, x: number, y: number, rw: number, rh: number, argb: number) => {
        const ctx = this.canvasCtx(w);
        if (!ctx) return errNotFound;
        ctx.fillStyle = hex(argb);
        ctx.fillRect(x, y, rw, rh);
        return ok;
      },
      ccp_canvas_draw_line: (w: number, x0: number, y0: number, x1: number, y1: number, argb: number, width: number) => {
        const ctx = this.canvasCtx(w);
        if (!ctx) return errNotFound;
        ctx.strokeStyle = hex(argb);
        ctx.lineWidth = Math.max(1, width);
        ctx.beginPath();
        ctx.moveTo(x0 + 0.5, y0 + 0.5);
        ctx.lineTo(x1 + 0.5, y1 + 0.5);
        ctx.stroke();
        return ok;
      },
      ccp_canvas_draw_text: (w: number, x: number, y: number, ptr: number, len: number, argb: number, fontSize: number) => {
        const ctx = this.canvasCtx(w);
        if (!ctx) return errNotFound;
        ctx.fillStyle = hex(argb);
        ctx.font = `${fontSize >= 28 ? 28 : 14}px sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillText(readStr(ptr, len), x, y);
        return ok;
      },
      ccp_canvas_flush: (w: number) => (this.canvasCtx(w) ? ok : errNotFound),

      /* ---- data / kv / audio ---- */
      ccp_data_subscribe: (ptr: number, len: number) => {
        const stream = readStr(ptr, len);
        const h = this.subs.length;
        this.subs.push(stream);
        this.ensureFeeder(stream); // live-feed new streams subscribed at runtime
        sim.pushLog("sys", `subscribed "${stream}" (handle ${h})`);
        return h;
      },
      ccp_data_unsubscribe: (h: number) => {
        if (h < 0 || h >= this.subs.length) return errInval;
        this.subs[h] = "";
        return ok;
      },
      ccp_kv_get: (kp: number, kl: number, vp: number, vl: number) => {
        const key = readStr(kp, kl);
        const stored = typeof window !== "undefined" ? window.localStorage.getItem(`ccp-sim-kv:${key}`) : null;
        if (stored === null) return errNotFound;
        const bytes = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
        const n = Math.min(bytes.length, vl);
        mem().set(bytes.slice(0, n), vp);
        return n;
      },
      ccp_kv_set: (kp: number, kl: number, vp: number, vl: number) => {
        if (vl > 4096) return errInval;
        const key = readStr(kp, kl);
        const bytes = mem().slice(vp, vp + vl);
        window.localStorage.setItem(`ccp-sim-kv:${key}`, btoa(String.fromCharCode(...bytes)));
        return ok;
      },
      ccp_audio_play: (ptr: number, len: number, flags: number) => {
        sim.pushLog("info", `ccp_audio_play("${readStr(ptr, len)}", loop=${flags & 1})`);
        return ok;
      },
      ccp_audio_tone: (freq: number, durMs: number, vol: number) => {
        this.tone(freq, durMs, vol);
        return ok;
      },
      ccp_audio_stop: () => ok,

      /* ---- misc ---- */
      ccp_time_ms: () => BigInt(Math.floor(performance.now())),
      ccp_time_unix: () => BigInt(Math.floor(Date.now() / 1000)),
      ccp_rand: () => (Math.random() * 0x100000000) | 0,
      ccp_log: (level: number, ptr: number, len: number) => {
        const lv = (["err", "warn", "info", "dbg"] as const)[level] ?? "info";
        sim.pushLog(lv, readStr(ptr, len));
      },
      ccp_request_tick: (intervalMs: number) => {
        this.setTick(intervalMs);
        return ok;
      },
    };

    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {
      env: env as unknown as WebAssembly.ModuleImports,
    });
    this.exports = instance.exports as unknown as WasmExports;
    if (typeof this.exports.ccp_on_init !== "function" || !this.exports.memory) {
      throw new Error("module does not export ccp_on_init/memory (not a CCP ABI v1 module)");
    }
    const rc = this.exports.ccp_on_init(1);
    if (rc < 0) throw new Error(`ccp_on_init returned ${rc} (ABI mismatch?)`);
    // layout-configured initial tick applies when the module didn't request one
    if (!this.tickTimer && opts_defaultTick(defaultTickMs)) this.setTick(defaultTickMs!);
  }

  private setTick(intervalMs: number) {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (intervalMs <= 0) return;
    const ms = Math.max(16, intervalMs);
    this.tickTimer = setInterval(() => {
      if (this.stopped || !this.exports?.ccp_on_tick) return;
      try {
        this.exports.ccp_on_tick(BigInt(Math.floor(performance.now())));
        useSim.getState().bumpTicks();
      } catch (err) {
        this.trap("ccp_on_tick", err);
      }
    }, ms);
  }

  private canvasCtx(w: number) {
    const id = this.widgetIds[w];
    if (!id || this.widgetTypes[id] !== "canvas") return null;
    return canvasRegistry.get(id)?.getContext("2d") ?? null;
  }

  private tone(freq: number, durMs: number, vol: number) {
    try {
      type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };
      const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
      if (!Ctor) return;
      this.audioCtx = this.audioCtx ?? new Ctor();
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = Math.min(1, vol / 100) * 0.2;
      osc.connect(gain).connect(this.audioCtx.destination);
      osc.start();
      osc.stop(this.audioCtx.currentTime + durMs / 1000);
    } catch {
      /* audio blocked until user gesture — fine for sim */
    }
  }

  private trap(where: string, err: unknown) {
    useSim.getState().setWasmStatus("error");
    useSim.getState().pushLog("err", `${where} trapped: ${err instanceof Error ? err.message : String(err)}`);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /* ------------------------------------------------------- events in */

  sendWidgetEvent(widgetId: string, event: number, p0 = 0, p1 = 0) {
    const idx = this.widgetIds.indexOf(widgetId);
    if (idx < 0 || !this.exports?.ccp_on_event) return;
    try {
      this.exports.ccp_on_event(idx, event, p0, p1);
    } catch (err) {
      this.trap("ccp_on_event", err);
    }
  }

  /** Builder action `wasm.event` -> ccp_on_event(widget, event_id, 0, 0), like the firmware. */
  sendAppEvent(widgetId: string | null, eventId: number) {
    const idx = widgetId ? this.widgetIds.indexOf(widgetId) : -1;
    if (!this.exports?.ccp_on_event) return;
    try {
      this.exports.ccp_on_event(idx, eventId, 0, 0);
    } catch (err) {
      this.trap("ccp_on_event", err);
    }
  }

  /* -------------------------------------------------------- data in */

  deliver(stream: string, payload: string) {
    useSim.getState().markStream(stream, payload);
    // 1) wasm subscribers — host copies the payload in via the module's own allocator
    const handle = this.subs.indexOf(stream);
    if (handle >= 0 && this.exports?.ccp_on_data && this.exports.ccp_malloc && this.exports.ccp_free) {
      const bytes = new TextEncoder().encode(payload);
      try {
        const ptr = this.exports.ccp_malloc(bytes.length);
        if (ptr === 0) {
          useSim.getState().pushLog("warn", `ccp_malloc(${bytes.length}) returned 0 — arena too small`);
        } else {
          new Uint8Array(this.exports.memory.buffer).set(bytes, ptr);
          this.exports.ccp_on_data(handle, ptr, bytes.length);
          this.exports.ccp_free(ptr);
        }
      } catch (err) {
        this.trap("ccp_on_data", err);
      }
    }
    // 2) layout bindings (what ui_renderer_handle_data does on the device)
    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      for (const source of this.sourcesForStream(stream)) this.applyBindings(source, data);
    } catch {
      /* raw / non-JSON payload — wasm-only */
    }
  }

  private dataSources: DataSourceConfig[] = [];

  private sourcesForStream(stream: string) {
    const ids = this.dataSources.filter((d) => d.stream === stream).map((d) => d.id);
    return ids.length ? ids : [stream];
  }

  private applyBindings(sourceId: string, data: Record<string, unknown>) {
    for (const w of this.widgets) {
      for (const b of w.bindings ?? []) {
        if (b.source !== sourceId) continue;
        const raw = lookupPath(data, b.path ?? "");
        if (raw === undefined) continue;
        if (b.prop === "text") {
          const text = b.format ? b.format.replace("%s", String(raw)) : String(raw);
          useSim.getState().patchOverride(w.id, { text });
        } else if (b.prop === "value") {
          useSim.getState().patchOverride(w.id, { value: Number(raw) || 0 });
        } else if (b.prop === "series" && Array.isArray(raw)) {
          // what ui_renderer does for lv_chart: numeric array -> chart points
          useSim.getState().patchOverride(w.id, { series: raw.map((v) => Number(v) || 0) });
        } else if (b.prop === "src") {
          // ui_renderer maps the value through find_asset; BuilderCanvas resolves it too
          useSim.getState().patchOverride(w.id, { src: String(raw) });
        }
      }
    }
  }

  /* ----------------------------------------------------- live feeders */

  private fedStreams = new Set<string>();

  private startFeeders(dataSources: DataSourceConfig[]) {
    this.dataSources = dataSources;

    // union of configured sources + sources referenced by bindings (older templates)
    const bound = new Set<string>();
    for (const w of this.widgets) for (const b of w.bindings ?? []) bound.add(b.source);
    const all = new Map<string, { source: string; stream: string; hintMs?: number }>();
    for (const d of dataSources) if (d.stream) all.set(d.id, { source: d.id, stream: d.stream, hintMs: d.sample_hint_ms });
    for (const src of bound) if (!all.has(src)) all.set(src, { source: src, stream: src });

    for (const { source, stream, hintMs } of all.values()) this.ensureFeeder(stream, source, hintMs);
  }

  /** Start a live feeder for a stream (idempotent). Also called for streams the
      wasm subscribes at runtime, e.g. switching klines timeframe. */
  private ensureFeeder(stream: string, source?: string, hintMs?: number) {
    if (this.fedStreams.has(stream)) return;
    this.fedStreams.add(stream);
    const src = source ?? stream;

    const ticker = /^market\.([A-Z0-9]{5,12})\.ticker$/.exec(stream);
    const klines = /^market\.([A-Z0-9]{5,12})\.klines\.(\d+[mhdw])$/.exec(stream);
    const fx = /^fx\.([A-Z]{6})$/.exec(stream);
    const weather = /^weather\.([a-z-]+)$/.exec(stream);
    const settings = /^settings(\.|$)/.test(stream);

    let info: SimStreamInfo;
    let seedAfterRegister: string | null = null;
    if (settings) {
      // the page's own user settings — feed the same values the device receives
      // from its saved config (settings_schema defaults + form edits). Deliver
      // after the stream is registered below, so markStream can record it.
      info = { source: src, stream, mode: "settings" };
      seedAfterRegister = JSON.stringify(this.settingsValues);
    } else if (src === "clock" || stream === "clock" || stream.startsWith("time.")) {
      info = { source: src, stream, mode: "time" };
      const feed = () => this.deliver(stream, JSON.stringify(clockData()));
      feed();
      this.feeders.push(setInterval(feed, 1000));
    } else if (ticker) {
      info = { source: src, stream, mode: "binance" };
      const feed = () => void this.feedTicker(stream, ticker[1]);
      feed();
      this.feeders.push(setInterval(feed, Math.max(1000, hintMs ?? 2000)));
    } else if (klines) {
      info = { source: src, stream, mode: "binance" };
      const feed = () => void this.feedKlines(stream, klines[1], klines[2]);
      feed();
      this.feeders.push(setInterval(feed, Math.max(5000, hintMs ?? 15_000)));
    } else if (fx) {
      info = { source: src, stream, mode: "binance" };
      // deliver a fallback rate immediately so the THB toggle never sees rate=0,
      // then fetch the real rate and refresh hourly
      this.deliver(stream, JSON.stringify({ pair: fx[1], rate: fxFallback(fx[1]) }));
      void this.feedFx(stream, fx[1]);
      this.feeders.push(setInterval(() => void this.feedFx(stream, fx[1]), 3_600_000));
    } else if (weather) {
      info = { source: src, stream, mode: "binance" };
      void this.feedWeather(stream, weather[1]);
      this.feeders.push(setInterval(() => void this.feedWeather(stream, weather[1]), 600_000));
    } else if (MOCK[src]) {
      info = { source: src, stream, mode: "mock" };
      this.deliver(stream, JSON.stringify(MOCK[src]));
    } else {
      info = { source: src, stream, mode: "manual" };
    }
    useSim.getState().setStreams([...useSim.getState().streams, info]);
    if (seedAfterRegister !== null && !this.stopped) this.deliver(stream, seedAfterRegister);
  }

  private klines: Record<string, number[]> = {};
  private klinesAt: Record<string, number> = {};

  private async feedTicker(stream: string, symbol: string) {
    let price = this.binancePrice[symbol];
    let changePct = 0;
    let change = "";
    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as { lastPrice: string; priceChangePercent: string };
      price = Number(j.lastPrice);
      changePct = Number(j.priceChangePercent);
      change = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
    } catch {
      // offline fallback: random walk so the sim still moves
      price = (price || 64000) * (1 + (Math.random() - 0.5) * 0.002);
      change = "offline";
    }
    // closes for the lv_chart line widget (`series` binding)
    if (Date.now() - (this.klinesAt[symbol] ?? 0) > 30_000) {
      this.klinesAt[symbol] = Date.now();
      try {
        const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=48`);
        if (res.ok) {
          const rows = (await res.json()) as [number, string, string, string, string][];
          this.klines[symbol] = rows.map((r) => Number(r[4])); // close
        }
      } catch {
        /* keep previous klines */
      }
    }
    if (this.stopped) return;
    this.binancePrice[symbol] = price;
    const pretty = price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    this.deliver(
      stream,
      JSON.stringify({
        symbol,
        price,
        changePct,
        change,
        [`${symbol}.price`]: pretty,
        [`${symbol}.change`]: change,
        [`${symbol}.klines`]: this.klines[symbol] ?? [],
      }),
    );
  }

  /** OHLC candles, same shape a server-side feeder would publish for the device. */
  private async feedKlines(stream: string, symbol: string, interval: string) {
    try {
      const res = await fetch(
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=60`,
      );
      if (!res.ok) throw new Error(String(res.status));
      const rows = (await res.json()) as [number, string, string, string, string][];
      if (this.stopped) return;
      this.deliver(
        stream,
        JSON.stringify({
          symbol,
          interval,
          o: rows.map((r) => Number(r[1])),
          h: rows.map((r) => Number(r[2])),
          l: rows.map((r) => Number(r[3])),
          c: rows.map((r) => Number(r[4])),
        }),
      );
    } catch (err) {
      useSim.getState().pushLog("warn", `klines ${symbol} ${interval}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** USD->THB (etc.) rate — same source the firmware uses (open.er-api.com). */
  private async feedFx(stream: string, pair: string) {
    const base = pair.slice(0, 3);
    const quote = pair.slice(3);
    let rate = 0;
    try {
      const res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
      if (res.ok) {
        const j = (await res.json()) as { rates?: Record<string, number> };
        rate = j.rates?.[quote] ?? 0;
      }
    } catch {
      /* offline */
    }
    if (!rate) rate = fxFallback(pair); // offline fallback
    if (this.stopped) return;
    this.deliver(stream, JSON.stringify({ pair, rate }));
  }

  /** Live weather from open-meteo (same payload the server feeder publishes). */
  private async feedWeather(stream: string, citySlug: string) {
    const city = CITIES[citySlug] ?? { name: "Bangkok", lat: 13.7563, lon: 100.5018 };
    try {
      const res = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
          `&current=temperature_2m,relative_humidity_2m,weather_code`,
      );
      if (res.ok) {
        const j = (await res.json()) as {
          current?: { temperature_2m: number; relative_humidity_2m: number; weather_code: number };
        };
        const cw = j.current;
        if (cw && !this.stopped) {
          this.deliver(stream, JSON.stringify(weatherPayload(city.name, cw.temperature_2m, cw.relative_humidity_2m, cw.weather_code)));
          return;
        }
      }
    } catch {
      /* offline → fallback below */
    }
    if (this.stopped) return;
    this.deliver(stream, JSON.stringify(weatherPayload(city.name, 31, 68, 2)));
  }
}

const CITIES: Record<string, { name: string; lat: number; lon: number }> = {
  bangkok: { name: "Bangkok", lat: 13.7563, lon: 100.5018 },
  "chiang-mai": { name: "Chiang Mai", lat: 18.7883, lon: 98.9853 },
  phuket: { name: "Phuket", lat: 7.8804, lon: 98.3923 },
};

/** Mirror of the server's weatherPayload so the page behaves the same in preview. */
function weatherPayload(city: string, tempC: number, humidity: number, code: number) {
  const [desc, theme] = wmoToDescTheme(code);
  return {
    city,
    temp: `${Math.round(tempC)}°C`,
    temp_c: tempC,
    humidity: `${Math.round(humidity)}%`,
    humidity_pct: Math.round(humidity),
    code,
    desc,
    theme,
    icon: theme,
    bg: WX_BG[theme] ?? "#27384B",
  };
}

const WX_BG: Record<string, string> = {
  clear: "#2B6FB0", partly: "#3C6E9E", cloudy: "#49566A",
  rain: "#27384B", thunder: "#1C1736", snow: "#5A7390", fog: "#5B636E",
};

function wmoToDescTheme(code: number): [string, string] {
  if (code <= 1) return [code === 0 ? "Clear sky" : "Mainly clear", "clear"];
  if (code === 2) return ["Partly cloudy", "partly"];
  if (code === 3) return ["Overcast", "cloudy"];
  if (code >= 45 && code <= 48) return ["Fog", "fog"];
  if (code >= 51 && code <= 57) return ["Drizzle", "rain"];
  if (code >= 61 && code <= 67) return ["Rain", "rain"];
  if (code >= 71 && code <= 77) return ["Snow", "snow"];
  if (code >= 80 && code <= 82) return ["Rain showers", "rain"];
  if (code >= 85 && code <= 86) return ["Snow showers", "snow"];
  if (code >= 95) return ["Thunderstorm", "thunder"];
  return ["—", "cloudy"];
}

/* --------------------------------------------------------- module api */

let activeSession: SimSession | null = null;

export function getSimSession() {
  return activeSession;
}

function clockData() {
  const now = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return {
    hhmm: `${p2(now.getHours())}:${p2(now.getMinutes())}`,
    hhmmss: `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`,
    seconds: p2(now.getSeconds()),
    date: `${WD[now.getDay()]}  ${now.getDate()} ${MO[now.getMonth()]} ${now.getFullYear()}`,
    epoch: Math.floor(now.getTime() / 1000),
  };
}

function lookupPath(data: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  if (path in data) return data[path]; // flat key like "BTCUSDT.price"
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function opts_defaultTick(v: number | undefined): v is number {
  return typeof v === "number" && v > 0;
}

/** Offline / pre-fetch fallback FX rates (approx, June 2026). */
function fxFallback(pair: string): number {
  const RATES: Record<string, number> = { USDTHB: 32.9, USDJPY: 157, EURTHB: 35.5, USDEUR: 0.93 };
  return RATES[pair] ?? 1;
}

export function base64ToBytes(b64: string) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
