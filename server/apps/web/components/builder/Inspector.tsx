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
  "w-36 px-2 py-1 rounded bg-[var(--ccp-bg)] border border-[var(--ccp-border)] text-xs";

const ACTION_TRIGGERS = [
  "clicked",
  "pressed",
  "released",
  "long_pressed",
  "value_changed",
  "gesture_left",
  "gesture_right",
] as const;

const ACTION_DOS = [
  "widget.set",
  "wasm.event",
  "page.show",
  "audio.play",
  "audio.stop",
  "mqtt.publish",
  "brightness.set",
  "device.reboot",
  "device.sync",
  "var.set",
] as const;

const WIDGET_SET_KEYS = [
  "text",
  "value",
  "visible",
  "style.bg_color",
  "style.text_color",
  "src",
] as const;

const BINDING_PROPS = [
  "text",
  "value",
  "visible",
  "style.bg_color",
  "style.text_color",
  "src",
  "series.0",
] as const;

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

      <ActionEditor widget={widget} updateWidget={updateWidget} />

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

function ActionEditor({
  widget,
  updateWidget,
}: {
  widget: WidgetNode;
  updateWidget: (id: string, patch: Partial<WidgetNode>) => void;
}) {
  const widgets = useBuilder((s) => s.widgets);
  const wasmModules = useBuilder((s) => s.wasmModules);
  const actions = widget.actions ?? [];
  const setAction = (index: number, patch: Record<string, unknown>) => {
    const base = actions[index] ?? { on: "clicked", do: "widget.set", target: "", key: "text", value: "" };
    const next = [...actions];
    next[index] = { ...base, ...patch } as NonNullable<WidgetNode["actions"]>[number];
    updateWidget(widget.id, { actions: next });
  };
  const add = () => {
    updateWidget(widget.id, {
      actions: [
        ...actions,
        { on: "clicked", do: "widget.set", target: widgets.find((w) => w.id !== widget.id)?.id ?? "", key: "text", value: "" },
      ] as WidgetNode["actions"],
    });
  };
  const remove = (index: number) => {
    const next = actions.filter((_a, i) => i !== index);
    updateWidget(widget.id, { actions: next.length ? next : undefined });
  };

  return (
    <>
      <SectionTitle>Actions / Logic</SectionTitle>
      <div className="space-y-3">
        {actions.map((action, index) => (
          <div key={index} className="space-y-1 rounded border border-[var(--ccp-border)] p-2">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-[var(--ccp-muted)]">
              <span>Action {index + 1}</span>
              <button className="text-[var(--ccp-red)]" onClick={() => remove(index)}>
                Remove
              </button>
            </div>
            <Row label="on">
              <select
                className={inputCls}
                value={action.on}
                onChange={(e) => setAction(index, { on: e.target.value })}
              >
                {ACTION_TRIGGERS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="do">
              <select
                className={inputCls}
                value={action.do}
                onChange={(e) => setAction(index, { do: e.target.value })}
              >
                {ACTION_DOS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Row>

            {action.do === "widget.set" && (
              <>
                <Row label="widget">
                  <select
                    className={inputCls}
                    value={action.target ?? ""}
                    onChange={(e) => setAction(index, { target: e.target.value })}
                  >
                    <option value="">(select)</option>
                    {widgets.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.id}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="property">
                  <select
                    className={inputCls}
                    value={action.key ?? "text"}
                    onChange={(e) => setAction(index, { key: e.target.value })}
                  >
                    {WIDGET_SET_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="value">
                  <input
                    className={inputCls}
                    value={String(action.value ?? "")}
                    placeholder="#15c3a6 / Hello / 1"
                    onChange={(e) => setAction(index, { value: e.target.value })}
                  />
                </Row>
              </>
            )}

            {action.do === "wasm.event" && (
              <>
                <Row label="module">
                  <select
                    className={inputCls}
                    value={action.target ?? ""}
                    onChange={(e) => setAction(index, { target: e.target.value })}
                  >
                    <option value="">(select)</option>
                    {wasmModules.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="event id">
                  <input
                    className={inputCls}
                    type="number"
                    value={action.event_id ?? ""}
                    placeholder="101"
                    onChange={(e) =>
                      setAction(index, { event_id: e.target.value === "" ? undefined : Number(e.target.value) })
                    }
                  />
                </Row>
              </>
            )}

            {action.do === "page.show" && (
              <Row label="page">
                <input
                  className={inputCls}
                  value={action.target ?? ""}
                  placeholder="main"
                  onChange={(e) => setAction(index, { target: e.target.value || undefined })}
                />
              </Row>
            )}

            {action.do === "mqtt.publish" && (
              <>
                <Row label="topic">
                  <input
                    className={inputCls}
                    value={action.topic_suffix ?? action.target ?? ""}
                    placeholder="button"
                    onChange={(e) => setAction(index, { topic_suffix: e.target.value || undefined, target: undefined })}
                  />
                </Row>
                <Row label="payload">
                  <textarea
                    className="w-36 px-2 py-1 rounded bg-[var(--ccp-bg)] border border-[var(--ccp-border)] text-xs h-16"
                    value={typeof action.payload === "string" ? action.payload : JSON.stringify(action.payload ?? {}, null, 0)}
                    placeholder='{"state":true}'
                    onChange={(e) => setAction(index, { payload: parseJsonish(e.target.value) })}
                  />
                </Row>
              </>
            )}

            {action.do === "brightness.set" && (
              <Row label="value">
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  max={100}
                  value={String(action.value ?? "")}
                  placeholder="80"
                  onChange={(e) => setAction(index, { value: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </Row>
            )}

            {action.do === "var.set" && (
              <>
                <Row label="key">
                  <input
                    className={inputCls}
                    value={action.key ?? ""}
                    placeholder="mode"
                    onChange={(e) => setAction(index, { key: e.target.value || undefined })}
                  />
                </Row>
                <Row label="value">
                  <input
                    className={inputCls}
                    value={String(action.value ?? "")}
                    placeholder="on"
                    onChange={(e) => setAction(index, { value: e.target.value })}
                  />
                </Row>
              </>
            )}

            {action.do === "audio.play" && (
              <Row label="asset">
                <input
                  className={inputCls}
                  value={action.asset ?? ""}
                  placeholder="click"
                  onChange={(e) => setAction(index, { asset: e.target.value || undefined })}
                />
              </Row>
            )}
          </div>
        ))}
        <button className="btn py-1.5 px-3 text-xs w-full justify-center" onClick={add}>
          Add action
        </button>
      </div>
    </>
  );
}

function parseJsonish(value: string): unknown {
  if (!value.trim()) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function BindingEditor({
  widget,
  setBindings,
}: {
  widget: WidgetNode;
  setBindings: (id: string, b: WidgetNode["bindings"]) => void;
}) {
  const dataSources = useBuilder((s) => s.dataSources);
  const bindings = widget.bindings ?? [];
  const sourceIds = Array.from(new Set([...dataSources.map((d) => d.id), ...bindings.map((b) => b.source)].filter(Boolean)));

  const setBinding = (index: number, patch: Partial<NonNullable<WidgetNode["bindings"]>[number]>) => {
    const base = bindings[index] ?? { prop: "text", source: sourceIds[0] ?? "", path: "$" };
    const next = [...bindings];
    next[index] = { ...base, ...patch };
    setBindings(widget.id, next.filter((b) => b.source));
  };
  const add = () => {
    setBindings(widget.id, [
      ...bindings,
      { prop: widget.type === "chart" ? "series.0" : "text", source: sourceIds[0] ?? "", path: "$" },
    ]);
  };
  const remove = (index: number) => {
    const next = bindings.filter((_b, i) => i !== index);
    setBindings(widget.id, next.length ? next : undefined);
  };

  return (
    <>
      <SectionTitle>Data Binding</SectionTitle>
      <div className="space-y-3">
        {bindings.map((b, index) => (
          <div key={index} className="space-y-1 rounded border border-[var(--ccp-border)] p-2">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-[var(--ccp-muted)]">
              <span>Binding {index + 1}</span>
              <button className="text-[var(--ccp-red)]" onClick={() => remove(index)}>
                Remove
              </button>
            </div>
            <Row label="target">
              <select
                className={inputCls}
                value={b.prop}
                onChange={(e) => setBinding(index, { prop: e.target.value })}
              >
                {BINDING_PROPS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="source">
              {sourceIds.length ? (
                <select
                  className={inputCls}
                  value={b.source}
                  onChange={(e) => setBinding(index, { source: e.target.value })}
                >
                  <option value="">(select)</option>
                  {sourceIds.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className={inputCls}
                  value={b.source}
                  placeholder="source id"
                  onChange={(e) => setBinding(index, { source: e.target.value })}
                />
              )}
            </Row>
            <Row label="path">
              <input
                className={inputCls}
                placeholder="$.price"
                value={b.path ?? ""}
                onChange={(e) => setBinding(index, { path: e.target.value || undefined })}
              />
            </Row>
            <Row label="format">
              <input
                className={inputCls}
                placeholder="$%,.2f"
                value={b.format ?? ""}
                onChange={(e) => setBinding(index, { format: e.target.value || undefined })}
              />
            </Row>
            <Row label="scale">
              <input
                className={inputCls}
                type="number"
                value={b.scale ?? ""}
                placeholder="1"
                onChange={(e) => setBinding(index, { scale: e.target.value === "" ? undefined : Number(e.target.value) })}
              />
            </Row>
          </div>
        ))}
        <button className="btn py-1.5 px-3 text-xs w-full justify-center" onClick={add}>
          Add binding
        </button>
      </div>
    </>
  );
}
