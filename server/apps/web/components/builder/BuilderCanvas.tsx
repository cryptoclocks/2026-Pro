"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import { SCREEN, type WidgetNode } from "@ccp/shared";
import { useBuilder } from "./store";
import {
  CCP_EVT,
  getSimSession,
  registerSimCanvas,
  useSim,
  type SimOverride,
} from "./wasmSim";

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
  const ov = useSim((s) => (simulate ? s.overrides[widget.id] : undefined));
  const patchOverride = useSim((s) => s.patchOverride);
  const widgets = useBuilder((s) => s.widgets);
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: widget.id,
    data: { from: "canvas" },
  });

  const hasBinding = (widget.bindings?.length ?? 0) > 0;
  // Match the device: only widgets with an explicit bg_color get a fill. Labels,
  // images and self-drawn widgets are transparent on LVGL unless styled.
  const bg =
    ov?.bg ??
    widget.style?.bg_color ??
    (widget.type === "chart" ? "#161B22" : widget.type === "button" ? "#2b3139" : "transparent");

  /** In simulate mode events go to the real wasm session (same path as the device). */
  const simulateClick = () => {
    if (!simulate) return false;
    const session = getSimSession();

    if (widget.type === "switch") {
      const next = !(ov?.checked ?? Boolean(widget.props?.checked));
      patchOverride(widget.id, { checked: next });
      session?.sendWidgetEvent(widget.id, CCP_EVT.VALUE_CHANGED, next ? 1 : 0, 0);
      return true;
    }

    session?.sendWidgetEvent(widget.id, CCP_EVT.CLICKED, widget.x, widget.y);
    // fire click actions for ANY widget that declares them (e.g. an image used
    // as a social button with page.show), not just <button>s
    const clickActions = (widget.actions ?? []).filter((a) => a.on === "clicked");
    if (widget.type !== "button" && clickActions.length === 0) return false;

    select(widget.id);
    for (const action of widget.actions ?? []) {
      if (action.on !== "clicked") continue;
      if (action.do === "wasm.event" && typeof action.event_id === "number") {
        session?.sendAppEvent(widget.id, action.event_id);
      } else if (action.do === "page.show" && action.target) {
        // navigate the simulator to another page in this package
        useSim.getState().setPage(action.target);
      } else if (action.do === "widget.set" && action.target && action.key) {
        // ui_renderer handles widget.set natively on the device — emulate via overrides
        const target = widgets.find((w) => w.id === action.target);
        if (!target) continue;
        const value = action.value;
        const patch: SimOverride = {};
        if (action.key === "text") patch.text = String(value ?? "");
        else if (action.key === "src") patch.src = String(value ?? "");
        else if (action.key === "value") patch.value = Number(value) || 0;
        else if (action.key === "visible") patch.hidden = !truthy(value);
        else if (action.key === "style.bg_color") patch.bg = String(value ?? "");
        else if (action.key === "style.text_color") patch.textColor = String(value ?? "");
        patchOverride(target.id, patch);
      }
    }
    if (widget.props?.checkable) {
      patchOverride(widget.id, { checked: !(ov?.checked ?? Boolean(widget.props.checked)) });
    }
    return true;
  };

  if (simulate && (ov?.hidden ?? widget.hidden)) return null;

  return (
    <div
      ref={setNodeRef}
      {...(simulate ? {} : listeners)}
      {...(simulate ? {} : attributes)}
      onClick={(e) => {
        e.stopPropagation();
        if (simulateClick()) return;
        select(widget.id);
      }}
      className={`absolute flex justify-center text-xs overflow-hidden cursor-move select-none ${
        selected ? "ring-2 ring-[var(--ccp-accent)]" : "ring-1 ring-[var(--ccp-border)]/40"
      }`}
      style={{
        alignItems: widget.type === "label" ? "flex-start" : "center",
        left: widget.x,
        top: widget.y,
        width: widget.w,
        height: widget.h,
        background: widget.style?.bg_grad_color
          ? `linear-gradient(${
              widget.style?.bg_grad_dir === "hor" ? "to right" : widget.style?.bg_grad_dir === "diag" ? "135deg" : "to bottom"
            }, ${bg}, ${widget.style.bg_grad_color})`
          : bg,
        color: ov?.textColor ?? widget.style?.text_color ?? "#EAECEF",
        textAlign: (widget.style?.align as "left" | "center" | "right") ?? "center",
        borderRadius: widget.style?.radius ?? 4,
        border:
          (widget.style?.border_width ?? 0) > 0
            ? `${widget.style?.border_width}px solid ${widget.style?.border_color ?? "#2b3139"}`
            : undefined,
        opacity: widget.style?.opa !== undefined ? Number(widget.style.opa) / 255 : 1,
        cursor: simulate ? (widget.type === "button" || widget.type === "switch" ? "pointer" : "default") : "move",
        transform: !simulate && transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
      }}
    >
      <WidgetInner widget={widget} simulate={simulate} ov={ov} />
      {hasBinding && !simulate && (
        <span className="absolute top-0 right-0 text-[8px] bg-[var(--ccp-accent)] text-black px-1 rounded-bl">
          ⛓
        </span>
      )}
    </div>
  );
}

const N = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true" || v === "on";

/* Exact device font sizes: ui_renderer supports montserrat_14/20/28/48 and the
   LVGL default (montserrat_14). The artboard loads the same Montserrat face. */
function fontPx(style?: WidgetNode["style"]) {
  const m = /^montserrat_(\d+)$/.exec(String(style?.font ?? ""));
  return m ? Number(m[1]) : 14;
}

/* LVGL line-heights (px) for the bundled fonts — these differ from CSS's default
   ~1.2em leading, which is why text (esp. the big montserrat_80 clock) used to
   sit lower in the artboard than on the device. Match them so the preview is
   WYSIWYG. montserrat_80 is a cropped digits+colon face with line-height 58. */
const LVGL_LINE_HEIGHT: Record<number, number> = { 14: 16, 20: 23, 28: 32, 48: 57, 80: 58 };
function fontLineHeight(px: number) {
  return LVGL_LINE_HEIGHT[px] ?? Math.round(px * 1.15);
}

/** Line chart matching what lv_chart (type line) shows on the device. */
function SimLineChart({ series, color, w, h }: { series: number[]; color: string; w: number; h: number }) {
  if (series.length < 2) return null;
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const span = Math.max(hi - lo, 1e-9);
  const pad = 6;
  const pts = series
    .map((v, i) => {
      const x = pad + (i * (w - pad * 2)) / (series.length - 1);
      const y = pad + (1 - (v - lo) / span) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} style={{ position: "absolute", inset: 0 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}

/** Render the visual interior of a widget from its props (SquareLine-style). */
function WidgetInner({
  widget: w,
  simulate,
  ov,
}: {
  widget: WidgetNode;
  simulate: boolean;
  ov?: SimOverride;
}) {
  const p = w.props ?? {};
  const assets = useBuilder((s) => s.assets);
  const accent = ov?.indicatorColor ?? w.style?.text_color ?? "#15c3a6";

  switch (w.type) {
    case "label": {
      const txt = ov?.text ?? (p.text as string) ?? "Label";
      // size comes from the font, with an optional transform scale (device uses lv
      // transform_scale → same effect). Use LVGL's line-height (not CSS's larger
      // leading) and vertically centre a single-line label in its box the way the
      // firmware now does, so the big clock sits at the same height here & on-device.
      const scale = Number(w.style?.scale) > 0 ? Number(w.style?.scale) : 1;
      const px = fontPx(w.style) * scale;
      const lh = fontLineHeight(fontPx(w.style)) * scale;
      const singleLine = !String(txt).includes("\n");
      return (
        <span style={{ fontSize: px, lineHeight: `${lh}px`, width: "100%", alignSelf: singleLine ? "center" : "flex-start" }}>
          {txt}
        </span>
      );
    }
    case "button": {
      const checked = ov?.checked ?? Boolean(p.checked);
      return (
        <span
          className="px-2 rounded"
          style={{
            background: checked ? accent : "#2b3139",
            color: checked ? "#0B0E11" : undefined,
            fontSize: fontPx(w.style),
            lineHeight: `${Math.max(0, w.h - 8)}px`,
          }}
        >
          {ov?.text ?? (p.text as string) ?? "Button"}
        </span>
      );
    }
    case "image":
    case "gif": {
      const ref = ov?.src ?? (p.src as string) ?? "";
      // resolve to an uploaded/built-in asset by id or bundle path (the device
      // does the same via find_asset); fall back to the raw string as a URL
      const asset = assets.find((a) => a.id === ref || a.path === ref || a.path === `assets/${ref}`);
      const url = asset?.src ?? ref;
      if (url && (url.startsWith("/") || url.startsWith("http") || url.startsWith("data:"))) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src={url} alt={w.id} style={{ width: "100%", height: "100%", objectFit: "contain" }} />;
      }
      if (ref.toLowerCase().includes("logo")) {
        // eslint-disable-next-line @next/next/no-img-element
        return <img src="/logo.png" alt="logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} />;
      }
      return (
        <span className="text-[10px] text-[var(--ccp-muted)] flex flex-col items-center">
          🖼<span className="truncate max-w-full">{(ref || w.type).split("/").pop()}</span>
        </span>
      );
    }
    case "arc": {
      const ratio = ((ov?.value ?? N(p.value, 40)) - N(p.min, 0)) / Math.max(1, N(p.max, 100) - N(p.min, 0));
      const r = Math.min(w.w, w.h) / 2 - 4;
      const c = 2 * Math.PI * r;
      return (
        <svg width={w.w} height={w.h}>
          <circle cx={w.w / 2} cy={w.h / 2} r={r} fill="none" stroke="#2b3139" strokeWidth={6} />
          <circle
            cx={w.w / 2} cy={w.h / 2} r={r} fill="none" stroke={accent} strokeWidth={6}
            strokeDasharray={`${c * Math.max(0, Math.min(1, ratio))} ${c}`} strokeLinecap="round"
            transform={`rotate(-90 ${w.w / 2} ${w.h / 2})`}
          />
        </svg>
      );
    }
    case "bar":
    case "slider": {
      const ratio = ((ov?.value ?? N(p.value, 50)) - N(p.min, 0)) / Math.max(1, N(p.max, 100) - N(p.min, 0));
      const pct = Math.max(0, Math.min(1, ratio)) * 100;
      return (
        <div className="relative w-full mx-1 rounded-full" style={{ height: 6, background: "#2b3139" }}>
          <div className="absolute left-0 top-0 h-full rounded-full" style={{ width: `${pct}%`, background: accent }} />
          {w.type === "slider" && (
            <div className="absolute rounded-full" style={{ width: 14, height: 14, top: -4, left: `calc(${pct}% - 7px)`, background: accent }} />
          )}
        </div>
      );
    }
    case "switch": {
      const on = ov?.checked ?? Boolean(p.checked);
      return (
        <div className="rounded-full flex items-center" style={{ width: 44, height: 22, background: on ? accent : "#2b3139", padding: 2, justifyContent: on ? "flex-end" : "flex-start" }}>
          <div className="rounded-full bg-white" style={{ width: 18, height: 18 }} />
        </div>
      );
    }
    case "checkbox":
      return (
        <span className="flex items-center gap-1 text-[12px]">
          <span style={{ width: 14, height: 14, borderRadius: 3, background: (ov?.checked ?? p.checked) ? accent : "transparent", border: "1px solid #5a6", display: "inline-block" }} />
          {(p.text as string) ?? "Option"}
        </span>
      );
    case "led":
      {
        const on = ov?.on ?? Boolean(p.on);
        const color = ov?.ledColor ?? ((p.color as string) || "#0ECB81");
        const brightness = Math.max(0, Math.min(255, N(p.brightness, 255))) / 255;
        return (
          <div
            className="rounded-full"
            style={{
              width: Math.min(w.w, w.h) - 4,
              height: Math.min(w.w, w.h) - 4,
              background: on ? color : "#20262D",
              opacity: on ? Math.max(0.25, brightness) : 0.45,
              boxShadow: on ? `0 0 ${Math.round(16 * brightness)}px ${color}` : "inset 0 0 8px #000",
            }}
          />
        );
      }
    case "qrcode": {
      const data = ov?.data ?? (p.data as string) ?? (p.text as string) ?? "";
      const seed = Array.from(data).reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 17);
      return (
        <div className="grid" style={{ gridTemplateColumns: "repeat(7,1fr)", width: Math.min(w.w, w.h) - 6, height: Math.min(w.w, w.h) - 6, background: "#fff", padding: 2 }}>
          {Array.from({ length: 49 }).map((_, i) => (
            <div key={i} style={{ background: ((i * 7 + ((i / 7) | 0) + seed) % 3) ? "#000" : "#fff" }} />
          ))}
        </div>
      );
    }
    case "spinner":
      return <div className="rounded-full animate-spin" style={{ width: Math.min(w.w, w.h) - 6, height: Math.min(w.w, w.h) - 6, border: `4px solid #2b3139`, borderTopColor: accent }} />;
    case "dropdown":
    case "roller": {
      const opts = String((p.options as string) ?? "").split("\n").filter(Boolean);
      const sel = opts[N(p.selected, 0)] ?? opts[0] ?? w.type;
      return <span className="flex items-center justify-between w-full px-2 text-[12px]">{sel}<span className="text-[var(--ccp-muted)]">▾</span></span>;
    }
    case "chart": {
      if (simulate && ov?.series?.length) {
        return <SimLineChart series={ov.series} color={w.style?.text_color ?? "#0ECB81"} w={w.w} h={w.h} />;
      }
      return simulate ? <MockCandles /> : <span className="text-[11px] text-[var(--ccp-muted)]">{(p.chart_type as string) ?? "chart"}</span>;
    }
    case "list": {
      const items = String((p.items as string) ?? "").split("\n").filter(Boolean);
      return <div className="w-full text-[11px] text-left px-1">{items.slice(0, 4).map((it, i) => <div key={i} className="truncate border-b border-[var(--ccp-border)]/40 py-0.5">{it}</div>)}</div>;
    }
    case "tabs": {
      const tabs = String((p.tabs as string) ?? "").split("\n").filter(Boolean);
      return <div className="w-full flex gap-1 text-[11px] px-1">{tabs.map((t, i) => <span key={i} className={`px-1 ${i === 0 ? "border-b-2 border-[var(--ccp-accent)]" : "text-[var(--ccp-muted)]"}`}>{t}</span>)}</div>;
    }
    case "textarea":
      return <span className="text-[12px] text-[var(--ccp-muted)] w-full px-2 text-left">{(p.text as string) || (p.placeholder as string) || "Type…"}</span>;
    case "spinbox":
      return <span className="text-[14px]">{ov?.value ?? N(p.value, 0)}</span>;
    case "canvas":
      // simulate: a real <canvas> the wasm draws on via ccp_canvas_* imports
      return simulate ? (
        <canvas
          width={w.w}
          height={w.h}
          ref={(el) => registerSimCanvas(w.id, el)}
          style={{ width: w.w, height: w.h }}
        />
      ) : (
        <span className="text-[10px] text-[var(--ccp-muted)]">WASM canvas</span>
      );
    default:
      return <span className="text-[11px] text-[var(--ccp-muted)]">{w.type}</span>;
  }
}

export function BuilderCanvas() {
  const editWidgets = useBuilder((s) => s.widgets);
  const pages = useBuilder((s) => s.pages);
  const currentPageId = useBuilder((s) => s.currentPageId);
  const orientation = useBuilder((s) => s.orientation);
  const select = useBuilder((s) => s.select);
  const simulate = useBuilder((s) => s.simulate);
  const simPage = useSim((s) => s.page);
  // while editing, show the page being edited (live `widgets`); while simulating,
  // show whichever page page.show navigated to (live widgets for the current one)
  const widgets =
    simulate && simPage && simPage !== currentPageId
      ? pages.find((p) => p.id === simPage)?.widgets ?? editWidgets
      : editWidgets;
  const screen = SCREEN[orientation];
  const { setNodeRef } = useDroppable({ id: "artboard" });

  return (
    <div className="flex-1 flex items-center justify-center">
      <div
        ref={setNodeRef}
        id="ccp-artboard"
        onClick={() => select(null)}
        className="relative shrink-0 rounded-lg shadow-2xl border border-[var(--ccp-border)] overflow-hidden"
        style={{
          width: screen.w,
          height: screen.h,
          background: "#0B0E11",
          // same typeface LVGL ships (Montserrat Medium) so sizes match the panel 1:1
          fontFamily: "var(--font-montserrat), Montserrat, sans-serif",
        }}
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
