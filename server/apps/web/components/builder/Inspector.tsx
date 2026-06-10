"use client";

import { useBuilder } from "./store";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-[var(--ccp-muted)]">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-28 px-2 py-1 rounded bg-[var(--ccp-bg)] border border-[var(--ccp-border)] text-xs text-right";

export function Inspector() {
  const widget = useBuilder((s) => s.widgets.find((w) => w.id === s.selectedId));
  const updateWidget = useBuilder((s) => s.updateWidget);
  const updateProps = useBuilder((s) => s.updateProps);
  const setBindings = useBuilder((s) => s.setBindings);
  const removeWidget = useBuilder((s) => s.removeWidget);

  if (!widget) {
    return (
      <aside className="w-64 shrink-0 text-xs text-[var(--ccp-muted)]">
        <h2 className="text-xs uppercase tracking-wide mb-2">Inspector</h2>
        Select a widget to edit its properties.
      </aside>
    );
  }

  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  return (
    <aside className="w-64 shrink-0 space-y-2 overflow-y-auto">
      <h2 className="text-xs uppercase tracking-wide text-[var(--ccp-muted)]">
        Inspector — <span className="text-[var(--ccp-accent)]">{widget.type}</span>
      </h2>

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

      {(widget.type === "label" || widget.type === "button") && (
        <Row label="text">
          <input
            className={inputCls}
            value={(widget.props?.text as string) ?? ""}
            onChange={(e) => updateProps(widget.id, { text: e.target.value })}
          />
        </Row>
      )}

      <Row label="bg color">
        <input
          className={inputCls}
          placeholder="#181C22"
          value={widget.style?.bg_color ?? ""}
          onChange={(e) =>
            updateWidget(widget.id, { style: { ...widget.style, bg_color: e.target.value } })
          }
        />
      </Row>
      <Row label="text color">
        <input
          className={inputCls}
          placeholder="#EAECEF"
          value={widget.style?.text_color ?? ""}
          onChange={(e) =>
            updateWidget(widget.id, { style: { ...widget.style, text_color: e.target.value } })
          }
        />
      </Row>

      {/* --- Data binding: make the widget show live data on the device --- */}
      {(() => {
        const isChart = widget.type === "chart";
        const prop = isChart ? "series" : "text";
        const b = widget.bindings?.find((x) => x.prop === prop);
        const setB = (patch: Record<string, string>) => {
          const next = { prop, source: "", ...b, ...patch };
          if (!next.source) {
            setBindings(widget.id, []);
          } else {
            setBindings(widget.id, [next]);
          }
        };
        return (
          <div className="mt-3 pt-2 border-t border-[var(--ccp-border)] space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-[var(--ccp-accent)]">
              Data binding ({prop})
            </div>
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
            {!isChart && (
              <Row label="format">
                <input
                  className={inputCls}
                  placeholder="$%s"
                  value={b?.format ?? ""}
                  onChange={(e) => setB({ format: e.target.value })}
                />
              </Row>
            )}
          </div>
        );
      })()}

      <button
        onClick={() => removeWidget(widget.id)}
        className="mt-2 w-full py-1.5 rounded text-xs border border-red-900 text-red-400 hover:bg-red-950"
      >
        Delete widget
      </button>
    </aside>
  );
}
