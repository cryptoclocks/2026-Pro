"use client";

/**
 * Renders a settings form from a page's `settings_schema`. Shared by the Builder
 * (live preview), the Admin Fleet device-settings editor, and (mirrored) the
 * Flutter app. Values are a flat record keyed by field.key.
 */

export type SettingsFieldType = "text" | "number" | "color" | "select" | "toggle";
export type SettingsOption = string | { value: string | number; label: string };
export type SettingsField = {
  key: string;
  label: string;
  type: SettingsFieldType;
  group?: string;
  default?: string | number | boolean;
  options?: SettingsOption[];
  min?: number;
  max?: number;
  placeholder?: string;
};

export type SettingsValues = Record<string, string | number | boolean>;

/** Merge declared defaults under any already-set values. */
export function withDefaults(schema: SettingsField[], values: SettingsValues = {}): SettingsValues {
  const out: SettingsValues = { ...values };
  for (const f of schema) {
    if (out[f.key] === undefined && f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

export function SchemaForm({
  schema,
  values,
  onChange,
  disabled,
}: {
  schema: SettingsField[];
  values: SettingsValues;
  onChange: (key: string, value: string | number | boolean) => void;
  disabled?: boolean;
}) {
  if (schema.length === 0) {
    return <div className="text-xs text-[var(--ccp-muted)]">No settings declared for this page.</div>;
  }
  // group fields by their optional `group` (preserves declaration order)
  const groups: { name: string; fields: SettingsField[] }[] = [];
  for (const f of schema) {
    const name = f.group || "";
    let g = groups.find((x) => x.name === name);
    if (!g) { g = { name, fields: [] }; groups.push(g); }
    g.fields.push(f);
  }

  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.name || "_"} className="space-y-2">
          {g.name && <div className="text-[10px] uppercase tracking-wide text-[var(--ccp-muted)]">{g.name}</div>}
          {g.fields.map((f) => (
            <label key={f.key} className="grid grid-cols-[120px_1fr] items-center gap-2 text-xs">
              <span className="text-[var(--ccp-muted)] truncate" title={f.label}>{f.label}</span>
              <Field field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} disabled={disabled} />
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

function Field({
  field: f,
  value,
  onChange,
  disabled,
}: {
  field: SettingsField;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean) => void;
  disabled?: boolean;
}) {
  if (f.type === "toggle") {
    return (
      <input type="checkbox" className="h-4 w-4 justify-self-start" disabled={disabled}
        checked={Boolean(value ?? f.default)} onChange={(e) => onChange(e.target.checked)} />
    );
  }
  if (f.type === "color") {
    const v = String(value ?? f.default ?? "#ffffff");
    return (
      <div className="flex items-center gap-2">
        <input type="color" className="h-7 w-10 bg-transparent" disabled={disabled} value={v}
          onChange={(e) => onChange(e.target.value)} />
        <span className="text-[10px] text-[var(--ccp-muted)]">{v}</span>
      </div>
    );
  }
  if (f.type === "select") {
    const opts = f.options ?? [];
    const valueOf = (o: SettingsOption) => typeof o === "string" ? o : o.value;
    const labelOf = (o: SettingsOption) => typeof o === "string" ? o : o.label;
    const coerce = (raw: string | number) => {
      if (typeof raw === "number") return raw;
      if (typeof f.default === "number" && raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
      return raw;
    };
    return (
      <select className="select text-xs px-2 py-1" disabled={disabled}
        value={String(value ?? f.default ?? "")}
        onChange={(e) => {
          const hit = opts.find((o) => String(valueOf(o)) === e.target.value);
          onChange(coerce(hit ? valueOf(hit) : e.target.value));
        }}>
        <option value="">—</option>
        {opts.map((o) => {
          const v = valueOf(o);
          return <option key={String(v)} value={String(v)}>{labelOf(o)}</option>;
        })}
      </select>
    );
  }
  if (f.type === "number") {
    return (
      <input type="number" className="input text-xs px-2 py-1" disabled={disabled}
        value={value === undefined ? "" : String(value)} min={f.min} max={f.max} placeholder={f.placeholder}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
    );
  }
  return (
    <input type="text" className="input text-xs px-2 py-1" disabled={disabled}
      value={String(value ?? "")} placeholder={f.placeholder}
      onChange={(e) => onChange(e.target.value)} />
  );
}
