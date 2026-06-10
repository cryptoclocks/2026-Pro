"use client";

import { create } from "zustand";
import type { WidgetNode, WidgetType } from "@ccp/shared";
import { SCREEN } from "@ccp/shared";
import { TEMPLATES, type TemplateKey } from "./templates";

export type Orientation = "landscape" | "portrait";

interface BuilderState {
  orientation: Orientation;
  packageId: string;
  name: string;
  version: string;
  widgets: WidgetNode[];
  selectedId: string | null;
  counter: number;
  simulate: boolean;

  setOrientation: (o: Orientation) => void;
  setMeta: (m: Partial<Pick<BuilderState, "packageId" | "name" | "version">>) => void;
  addWidget: (type: WidgetType, x?: number, y?: number) => void;
  moveWidget: (id: string, dx: number, dy: number) => void;
  updateWidget: (id: string, patch: Partial<WidgetNode>) => void;
  updateProps: (id: string, props: Record<string, unknown>) => void;
  setBindings: (id: string, bindings: WidgetNode["bindings"]) => void;
  removeWidget: (id: string) => void;
  select: (id: string | null) => void;
  toggleSimulate: () => void;
  loadTemplate: (key: TemplateKey) => void;
}

const DEFAULT_SIZE: Partial<Record<WidgetType, { w: number; h: number }>> = {
  label: { w: 160, h: 32 },
  button: { w: 120, h: 40 },
  image: { w: 120, h: 120 },
  chart: { w: 280, h: 140 },
  canvas: { w: 320, h: 200 },
  arc: { w: 120, h: 120 },
  bar: { w: 200, h: 20 },
  slider: { w: 200, h: 20 },
  switch: { w: 60, h: 32 },
  qrcode: { w: 120, h: 120 },
  scale: { w: 160, h: 160 },
};

export const useBuilder = create<BuilderState>((set, get) => ({
  orientation: "landscape",
  packageId: "com.ccp.my-page",
  name: "My Page",
  version: "1.0.0",
  widgets: [],
  selectedId: null,
  counter: 0,
  simulate: false,

  setOrientation: (o) => set({ orientation: o }),
  setMeta: (m) => set(m),

  addWidget: (type, x = 20, y = 20) => {
    const n = get().counter + 1;
    const size = DEFAULT_SIZE[type] ?? { w: 100, h: 50 };
    const widget: WidgetNode = {
      type,
      id: `${type}_${n}`,
      x: Math.round(x),
      y: Math.round(y),
      w: size.w,
      h: size.h,
      props: type === "label" ? { text: "Text" } : type === "button" ? { text: "Button" } : {},
      style: {},
    };
    set({ widgets: [...get().widgets, widget], counter: n, selectedId: widget.id });
  },

  moveWidget: (id, dx, dy) => {
    const screen = SCREEN[get().orientation];
    set({
      widgets: get().widgets.map((w) =>
        w.id === id
          ? {
              ...w,
              x: Math.max(0, Math.min(screen.w - w.w, w.x + Math.round(dx))),
              y: Math.max(0, Math.min(screen.h - w.h, w.y + Math.round(dy))),
            }
          : w,
      ),
    });
  },

  updateWidget: (id, patch) =>
    set({ widgets: get().widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)) }),

  updateProps: (id, props) =>
    set({
      widgets: get().widgets.map((w) =>
        w.id === id ? { ...w, props: { ...w.props, ...props } } : w,
      ),
    }),

  setBindings: (id, bindings) =>
    set({
      widgets: get().widgets.map((w) =>
        w.id === id ? { ...w, bindings: bindings && bindings.length ? bindings : undefined } : w,
      ),
    }),

  removeWidget: (id) =>
    set({
      widgets: get().widgets.filter((w) => w.id !== id),
      selectedId: get().selectedId === id ? null : get().selectedId,
    }),

  select: (id) => set({ selectedId: id }),

  toggleSimulate: () => set({ simulate: !get().simulate }),

  loadTemplate: (key) => {
    const t = TEMPLATES[key];
    // deep clone so edits don't mutate the template constant
    set({
      widgets: JSON.parse(JSON.stringify(t.widgets)) as WidgetNode[],
      name: t.name === "Blank" ? get().name : t.name,
      selectedId: null,
      counter: t.widgets.length,
    });
  },
}));
