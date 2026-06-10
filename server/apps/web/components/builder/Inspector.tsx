"use client";

import type { WidgetNode } from "@ccp/shared";
import { useBuilder } from "./store";
import { COMMON_STYLE, WIDGET_PROPS, type PropDef } from "./widgetProps";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs py-0.5">
      <span className="text-[var(--ccp-muted)] truncate">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-32 px-2 py-1 rounded bg-[var(--ccp-bg)] border border-[var(--ccp-border)] text-xs";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wide text-[var(--ccp-accent)] mt-3 mb-1 border-t border-[var(--ccp-border)] pt-2">
      {children}
    </div>
  );
}

/** Render one schema control bound to a value + onChange. */
function Control({
  def,
  value,
  onChange,
}: {
  def: PropDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (def.kind) {
    case "bool":
      return (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    case "number":
      return (
        <input
          className={inputCls}
          type="number"
          min={def.min}
          max={def.max}
          step={def.step}
          value={value === undefined || value === null ? "" : Number(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
    case "color":
      return (
        <span className="flex items-center gap-1">
          <input
            type="color"
            className="w-6 h-6 rounded bg-transparent border border-[var(--ccp-border)]"
            value={typeof value === "string" && value ? value : "#161b22"}
            onChange={(e) => onChange(e.target.value)}
          />
          <input
            className="w-20 px-1 py-1 rounded bg-[var(--ccp-bg)] border border-[var(--ccp-border)] text-xs"
            placeholder="#RRGGBB"
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value || undefined)}
          />
        </span>
      );
    case "select":
      return (
        <select
          className={inputCls}
          value={(value as string) ?? def.options?.[0] ?? ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {def.options?.map((o) => (
            <option key={o} value={o}>
              {o === "" ? "(default)" : o}
            </option>
          ))}
        </select>
      );
    case "textarea":
      return (
        <textarea
          className="w-32 px-2 py-1 rounded bg-[var(--ccp-bg)] border border-[var(--ccp-border)] text-xs h-14"
          value={(value as string) ?? ""}
          placeholder={def.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return (
        <input
          className={inputCls}
          value={(value as string) ?? ""}
          placeholder={def.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

export function Inspector() {
  const widget = useBuilder((s) => s.widgets.find((w) => w.id === s.selectedId));
  const updateWidget = useBuilder((s) => s.updateWidget);
  const updateProps = useBuilder((s) => s.updateProps);
  const setBindings = useBuilder((s) => s.setBindings);
  const removeWidget = useBuilder((s) => s.removeWidget);

  if (!widget) {
    return (
      <aside className="w-72 shrink-0 text-xs text-[var(--ccp-muted)]">
        <h2 className="text-xs uppercase tracking-wide mb-2">Inspector</h2>
        Select a widget to edit its properties.
      </aside>
    );
  }

  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const setStyle = (key: string, v: unknown) =>
    updateWidget(widget.id, {
      style: { ...widget.style, [key]: v === undefined || v === "" ? undefined : v },
    });

  const typeProps = WIDGET_PROPS[widget.type] ?? [];

  return (
    <aside className="w-72 shrink-0 space-y-1 overflow-y-auto pr-1">
      <h2 className="text-xs uppercase tracking-wide text-[var(--ccp-muted)]">
        Inspector — <span className="text-[var(--ccp-accent)]">{widget.type}</span>
      </h2>

      <SectionTitle>Layout</SectionTitle>
      <Row label="id">
        <input
          className={inputCls}
          value={widget.id}
          onChange={(e) => updateWidget(widget.id, { id: e.target.value })}
        />
      </Row>
      {(["x", "y", "w", "h"] as const).map((k) => (
        <Row key={k} label={k}>
          <input
            className={inputCls}
            type="number"
            value={widget[k]}
            onChange={(e) => updateWidget(widget.id, { [k]: num(e.target.value) })}
          />
        </Row>
      ))}
      <Row label="hidden">
        <input
          type="checkbox"
          checked={Boolean(widget.hidden)}
          onChange={(e) => updateWidget(widget.id, { hidden: e.target.checked || undefined })}
        />
      </Row>

      {typeProps.length > 0 && (
        <>
          <SectionTitle>Properties</SectionTitle>
          {typeProps.map((def) => (
            <Row key={def.key} label={def.label}>
              <Control
                def={def}
                value={widget.props?.[def.key]}
                onChange={(v) => updateProps(widget.id, { [def.key]: v })}
              />
            </Row>
          ))}
        </>
      )}

      <SectionTitle>Style</SectionTitle>
      {COMMON_STYLE.map((def) => (
        <Row key={def.key} label={def.label}>
          <Control
            def={def}
            value={(widget.style as Record<string, unknown> | undefined)?.[def.key]}
            onChange={(v) => setStyle(def.key, v)}
          />
        </Row>
      ))}

      <BindingEditor widget={widget} setBindings={setBindings} />

      <button
        onClick={() => removeWidget(widget.id)}
        className="mt-3 w-full py-1.5 rounded text-xs border border-red-900 text-red-400 hover:bg-red-950"
      >
        Delete widget
      </button>
    </aside>
  );
}

function BindingEditor({
  widget,
  setBindings,
}: {
  widget: WidgetNode;
  setBindings: (id: string, b: WidgetNode["bindings"]) => void;
}) {
  const isChart = widget.type === "chart";
  const prop = isChart ? "series" : widget.type === "arc" || widget.type === "bar" || widget.type === "slider" ? "value" : "text";
  const b = widget.bindings?.find((x) => x.prop === prop);
  const setB = (patch: Record<string, string>) => {
    const next = { prop, source: "", ...b, ...patch };
    setBindings(widget.id, next.source ? [next] : []);
  };
  return (
    <>
      <SectionTitle>Data binding ({prop})</SectionTitle>
      <Row label="source">
        <select
          className={inputCls}
          value={b?.source ?? ""}
          onChange={(e) => setB({ source: e.target.value })}
        >
          <option value="">(static)</option>
          <option value="clock">clock</option>
          <option value="crypto">crypto</option>
          <option value="weather">weather</option>
          <option value="device">device</option>
        </select>
      </Row>
      <Row label="path">
        <input
          className={inputCls}
          placeholder="BTCUSDT.price"
          value={b?.path ?? ""}
          onChange={(e) => setB({ path: e.target.value })}
        />
      </Row>
      <Row label="format">
        <input
          className={inputCls}
          placeholder="$%s"
          value={b?.format ?? ""}
          onChange={(e) => setB({ format: e.target.value })}
        />
      </Row>
    </>
  );
}
