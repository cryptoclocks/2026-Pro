"use client";

import { create } from "zustand";
import type { WidgetNode, WidgetType } from "@ccp/shared";
import { SCREEN } from "@ccp/shared";
import { TEMPLATES, type TemplateKey } from "./templates";
import { defaultProps } from "./widgetProps";

export type Orientation = "landscape" | "portrait";
export type DataSourceConfig = {
  id: string;
  stream: string;
  format: "json" | "raw";
  sample_hint_ms?: number;
};
export type WasmModuleConfig = {
  id: string;
  path: string;
  tick_ms?: number;
  canvas_ids?: string[];
  memory_kb?: number;
};
export type CompiledWasm = {
  moduleId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  wasmBase64: string;
  compiledAt: string;
  diagnostics?: string;
};

interface BuilderState {
  orientation: Orientation;
  packageId: string;
  name: string;
  version: string;
  dataSources: DataSourceConfig[];
  wasmModules: WasmModuleConfig[];
  logicSource: string;
  compiledWasm: CompiledWasm | null;
  widgets: WidgetNode[];
  selectedId: string | null;
  counter: number;
  simulate: boolean;

  setOrientation: (o: Orientation) => void;
  setMeta: (m: Partial<Pick<BuilderState, "packageId" | "name" | "version">>) => void;
  updateDataSource: (index: number, patch: Partial<DataSourceConfig>) => void;
  addDataSource: () => void;
  removeDataSource: (index: number) => void;
  updateWasmModule: (index: number, patch: Partial<WasmModuleConfig>) => void;
  addWasmModule: () => void;
  removeWasmModule: (index: number) => void;
  upsertWasmModule: (module: WasmModuleConfig) => void;
  setLogicSource: (source: string) => void;
  setCompiledWasm: (compiled: CompiledWasm | null) => void;
  addWidget: (type: WidgetType, x?: number, y?: number) => void;
  moveWidget: (id: string, dx: number, dy: number) => void;
  updateWidget: (id: string, patch: Partial<WidgetNode>) => void;
  updateProps: (id: string, props: Record<string, unknown>) => void;
  setBindings: (id: string, bindings: WidgetNode["bindings"]) => void;
  removeWidget: (id: string) => void;
  select: (id: string | null) => void;
  setSimulate: (simulate: boolean) => void;
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

export const DEFAULT_LOGIC_SOURCE = `#![no_std]

const CCP_ABI_VERSION: u32 = 1;
const CCP_OK: i32 = 0;
const CCP_ERR_INVAL: i32 = -1;
const CCP_LOG_INFO: i32 = 2;
const EVT_LED_1: u32 = 101;
const EVT_LED_2: u32 = 102;
const PART_INDICATOR: u32 = 2;

#[link(wasm_import_module = "env")]
extern "C" {
    fn ccp_ui_get_widget(id: *const u8, id_len: u32) -> i32;
    fn ccp_ui_set_color(widget: i32, argb8888: u32, part: u32) -> i32;
    fn ccp_ui_set_text(widget: i32, text: *const u8, len: u32) -> i32;
    fn ccp_ui_show_page(id: *const u8, id_len: u32) -> i32;
    fn ccp_data_subscribe(stream: *const u8, len: u32) -> i32;
    fn ccp_request_tick(interval_ms: u32) -> i32;
    fn ccp_log(level: i32, msg: *const u8, len: u32);
}

static mut LED_1: i32 = -1;
static mut LED_2: i32 = -1;
static mut TITLE: i32 = -1;
static mut LED_1_ON: bool = false;
static mut LED_2_ON: bool = false;
static mut ARENA: [u8; 8 * 1024] = [0; 8 * 1024];
static mut ARENA_TOP: usize = 0;
static mut ARENA_LAST: usize = 0;

#[no_mangle]
pub extern "C" fn ccp_on_init(abi_version: u32) -> i32 {
    if abi_version != CCP_ABI_VERSION {
        return CCP_ERR_INVAL;
    }
    unsafe {
        LED_1 = ccp_ui_get_widget(b"led_1".as_ptr(), 5);
        LED_2 = ccp_ui_get_widget(b"led_2".as_ptr(), 5);
        TITLE = ccp_ui_get_widget(b"title".as_ptr(), 5);
        set_led(LED_1, false, 0xFF0ECB81);
        set_led(LED_2, false, 0xFFF0B90B);

        // Example: subscribe to MQTT/server data routed into this page.
        // ccp_data_subscribe(b"market.BTCUSDT.ticker".as_ptr(), 21);
        // ccp_request_tick(1000);

        let msg = b"page logic loaded";
        ccp_log(CCP_LOG_INFO, msg.as_ptr(), msg.len() as u32);
    }
    CCP_OK
}

#[no_mangle]
pub extern "C" fn ccp_on_event(_widget: i32, event: u32, _p0: i32, _p1: i32) {
    unsafe {
        match event {
            EVT_LED_1 => {
                LED_1_ON = !LED_1_ON;
                set_led(LED_1, LED_1_ON, 0xFF0ECB81);
                set_text(TITLE, if LED_1_ON { &b"LED 1 ON"[..] } else { &b"LED 1 OFF"[..] });
            }
            EVT_LED_2 => {
                LED_2_ON = !LED_2_ON;
                set_led(LED_2, LED_2_ON, 0xFFF0B90B);
                set_text(TITLE, if LED_2_ON { &b"LED 2 ON"[..] } else { &b"LED 2 OFF"[..] });
            }
            _ => {}
        }
    }
}

#[no_mangle]
pub extern "C" fn ccp_on_tick(_now_ms: u64) {}

#[no_mangle]
pub extern "C" fn ccp_on_data(_stream_handle: i32, payload_ptr: u32, len: u32) {
    unsafe {
        if TITLE >= 0 && len > 0 {
            ccp_ui_set_text(TITLE, payload_ptr as *const u8, len.min(48));
        }
    }
}

#[no_mangle]
pub extern "C" fn ccp_on_destroy() {}

unsafe fn set_led(widget: i32, on: bool, color: u32) {
    if widget >= 0 {
        ccp_ui_set_color(widget, if on { color } else { 0xFF20262D }, PART_INDICATOR);
    }
}

unsafe fn set_text(widget: i32, text: &[u8]) {
    if widget >= 0 {
        ccp_ui_set_text(widget, text.as_ptr(), text.len() as u32);
    }
}

#[no_mangle]
pub extern "C" fn ccp_malloc(size: u32) -> u32 {
    let size = ((size as usize) + 7) & !7;
    unsafe {
        if ARENA_TOP + size > ARENA.len() {
            return 0;
        }
        ARENA_LAST = ARENA_TOP;
        let ptr = ARENA.as_mut_ptr().add(ARENA_TOP) as u32;
        ARENA_TOP += size;
        ptr
    }
}

#[no_mangle]
pub extern "C" fn ccp_free(ptr: u32) {
    unsafe {
        let last_ptr = ARENA.as_mut_ptr().add(ARENA_LAST) as u32;
        if ptr == last_ptr {
            ARENA_TOP = ARENA_LAST;
        }
    }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}
`;

export const useBuilder = create<BuilderState>((set, get) => ({
  orientation: "landscape",
  packageId: "com.ccp.my-page",
  name: "My Page",
  version: "1.0.0",
  dataSources: [
    { id: "crypto", stream: "market.BTCUSDT.ticker", format: "json", sample_hint_ms: 1000 },
  ],
  wasmModules: [],
  logicSource: DEFAULT_LOGIC_SOURCE,
  compiledWasm: null,
  widgets: [],
  selectedId: null,
  counter: 0,
  simulate: false,

  setOrientation: (o) => set({ orientation: o }),
  setMeta: (m) => set(m),
  updateDataSource: (index, patch) =>
    set({
      dataSources: get().dataSources.map((d, i) => (i === index ? { ...d, ...patch } : d)),
    }),
  addDataSource: () =>
    set({
      dataSources: [
        ...get().dataSources,
        { id: `source_${get().dataSources.length + 1}`, stream: "", format: "json" },
      ],
    }),
  removeDataSource: (index) =>
    set({ dataSources: get().dataSources.filter((_d, i) => i !== index) }),
  updateWasmModule: (index, patch) =>
    set({
      wasmModules: get().wasmModules.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    }),
  addWasmModule: () =>
    set({
      wasmModules: [
        ...get().wasmModules,
        { id: `logic_${get().wasmModules.length + 1}`, path: "wasm/app.wasm", tick_ms: 1000, memory_kb: 256 },
      ],
    }),
  removeWasmModule: (index) =>
    set({ wasmModules: get().wasmModules.filter((_m, i) => i !== index) }),
  upsertWasmModule: (module) =>
    set({
      wasmModules: get().wasmModules.some((m) => m.id === module.id)
        ? get().wasmModules.map((m) => (m.id === module.id ? { ...m, ...module } : m))
        : [...get().wasmModules, module],
    }),
  setLogicSource: (source) => set({ logicSource: source, compiledWasm: null }),
  setCompiledWasm: (compiled) => set({ compiledWasm: compiled }),

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
      props: defaultProps(type),
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
    set({
      widgets: get().widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)),
      selectedId: patch.id && get().selectedId === id ? patch.id : get().selectedId,
    }),

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

  setSimulate: (simulate) => set({ simulate }),

  toggleSimulate: () => set({ simulate: !get().simulate }),

  loadTemplate: (key) => {
    const t = TEMPLATES[key];
    // deep clone so edits don't mutate the template constant
    const isLedToggle = key === "led_toggle";
    set({
      widgets: JSON.parse(JSON.stringify(t.widgets)) as WidgetNode[],
      name: t.name === "Blank" ? get().name : t.name,
      packageId: isLedToggle ? "com.ccp.led-toggle" : get().packageId,
      wasmModules: isLedToggle
        ? [{ id: "logic", path: "wasm/page.wasm", memory_kb: 128 }]
        : get().wasmModules,
      logicSource: isLedToggle ? DEFAULT_LOGIC_SOURCE : get().logicSource,
      compiledWasm: null,
      selectedId: null,
      counter: t.widgets.length,
    });
  },
}));
