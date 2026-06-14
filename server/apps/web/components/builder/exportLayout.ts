import { LayoutSchema, type Layout, type WidgetNode } from "@ccp/shared";
import type { AssetEntry, DataSourceConfig, SettingsField, WasmModuleConfig } from "./store";

/**
 * Convert builder state into a device-ready layout.json (validated against
 * the shared zod schema, which mirrors schema/layout.schema.json).
 * Throws with readable issues when invalid — surfaced in the builder UI.
 */
export function exportLayout(opts: {
  packageId: string;
  name: string;
  version: string;
  orientation: "landscape" | "portrait";
  dataSources: DataSourceConfig[];
  wasmModules: WasmModuleConfig[];
  assets?: AssetEntry[];
  settingsSchema?: SettingsField[];
  logicSource: string;
  pages: { id: string; widgets: WidgetNode[] }[];
}): Layout {
  const assets = (opts.assets ?? []).filter((a) => a.id && a.path);
  const settingsSchema = (opts.settingsSchema ?? []).filter((f) => f.key && f.label);
  const candidate = {
    schema_version: "1.0" as const,
    meta: {
      id: opts.packageId,
      name: opts.name,
      version: opts.version,
    },
    display: { orientation: opts.orientation },
    assets: assets.length
      ? assets.map((a) => ({ id: a.id, type: a.type, path: a.path }))
      : undefined,
    settings_schema: settingsSchema.length
      ? settingsSchema.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          group: f.group || undefined,
          default: f.default,
          options: f.options?.length ? f.options : undefined,
          min: f.min,
          max: f.max,
          placeholder: f.placeholder || undefined,
        }))
      : undefined,
    data_sources: opts.dataSources.filter((d) => d.id && d.stream),
    wasm: opts.wasmModules
      .filter((m) => m.id && m.path)
      .map((m) => ({
        ...m,
        tick_ms: m.tick_ms && m.tick_ms >= 16 ? m.tick_ms : undefined,
      })),
    builder: opts.logicSource ? { logic_source: opts.logicSource } : undefined,
    pages: (opts.pages.length ? opts.pages : [{ id: "main", widgets: [] }]).map((p) => ({
      id: p.id,
      bg: "#0B0E11",
      widgets: sanitizeWidgets(p.widgets),
    })),
  };

  const parsed = LayoutSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Layout invalid:\n${issues}`);
  }
  return parsed.data;
}

function sanitizeWidgets(widgets: WidgetNode[]): WidgetNode[] {
  return widgets.map((widget) => {
    const bindings = widget.bindings?.filter((binding) => binding.source.trim());
    const children = widget.children ? sanitizeWidgets(widget.children) : undefined;
    return {
      ...widget,
      bindings: bindings?.length ? bindings : undefined,
      children,
    };
  });
}

export function downloadLayout(layout: Layout): void {
  const blob = new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "layout.json";
  a.click();
  URL.revokeObjectURL(url);
}
