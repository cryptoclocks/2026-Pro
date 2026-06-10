import { LayoutSchema, type Layout, type WidgetNode } from "@ccp/shared";

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
  widgets: WidgetNode[];
}): Layout {
  const candidate = {
    schema_version: "1.0" as const,
    meta: {
      id: opts.packageId,
      name: opts.name,
      version: opts.version,
    },
    display: { orientation: opts.orientation },
    pages: [
      {
        id: "main",
        bg: "#0B0E11",
        widgets: opts.widgets,
      },
    ],
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

export function downloadLayout(layout: Layout): void {
  const blob = new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "layout.json";
  a.click();
  URL.revokeObjectURL(url);
}
