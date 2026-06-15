"use client";

import { create } from "zustand";
import type { Layout, WidgetNode, WidgetType } from "@ccp/shared";
import { SCREEN } from "@ccp/shared";
import { PROFILE_SOCIAL_ASSETS, SLIDESHOW_ASSETS, TEMPLATES, type TemplateKey } from "./templates";
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
export type AssetType = "image" | "gif" | "font" | "audio" | "lottie" | "bin";
export type AssetEntry = {
  id: string;
  type: AssetType;
  path: string; // bundle-relative, e.g. assets/clear.gif
  src: string; // URL or data: URL the Builder renders/uploads from
  sizeBytes?: number;
};
export type SettingsFieldType = "text" | "number" | "color" | "select" | "toggle";
export type SettingsField = {
  key: string;
  label: string;
  type: SettingsFieldType;
  group?: string;
  default?: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  placeholder?: string;
};

/** Built-in weather GIFs (Lottie→GIF), served from web/public, one per theme. */
export const WEATHER_ASSETS: AssetEntry[] = (
  ["clear", "partly", "cloudy", "rain", "thunder", "snow", "fog"] as const
).map((id) => ({
  id,
  type: "gif" as const,
  path: `assets/${id}.gif`,
  src: `/weather-icons/${id}.gif`,
}));

const BUILTIN_ASSETS: AssetEntry[] = [...WEATHER_ASSETS, ...PROFILE_SOCIAL_ASSETS, ...SLIDESHOW_ASSETS] as AssetEntry[];
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
  assets: AssetEntry[];
  settingsSchema: SettingsField[];
  /** Live values for the settings_schema preview/simulate. The simulator feeds
   *  these to the page's `settings.<slug>` stream so the Sim matches the device,
   *  which receives the same values from its saved config on boot. */
  settingsPreview: Record<string, string | number | boolean>;
  logicSource: string;
  logicStarterSource: string;
  compiledWasm: CompiledWasm | null;
  /** widgets of the page currently being edited (mirror of pages[currentPageId]) */
  widgets: WidgetNode[];
  /** all pages in this package; page.show navigates between them on-device */
  pages: { id: string; name: string; widgets: WidgetNode[] }[];
  currentPageId: string;
  selectedId: string | null;
  counter: number;
  simulate: boolean;

  setOrientation: (o: Orientation) => void;
  addAsset: (asset: AssetEntry) => void;
  removeAsset: (id: string) => void;
  addSettingsField: () => void;
  updateSettingsField: (index: number, patch: Partial<SettingsField>) => void;
  removeSettingsField: (index: number) => void;
  setSettingsPreview: (key: string, value: string | number | boolean) => void;
  setMeta: (m: Partial<Pick<BuilderState, "packageId" | "name" | "version">>) => void;
  updateDataSource: (index: number, patch: Partial<DataSourceConfig>) => void;
  addDataSource: () => void;
  removeDataSource: (index: number) => void;
  updateWasmModule: (index: number, patch: Partial<WasmModuleConfig>) => void;
  addWasmModule: () => void;
  removeWasmModule: (index: number) => void;
  upsertWasmModule: (module: WasmModuleConfig) => void;
  setLogicSource: (source: string) => void;
  resetLogicSource: () => void;
  setCompiledWasm: (compiled: CompiledWasm | null) => void;
  addWidget: (type: WidgetType, x?: number, y?: number) => void;
  moveWidget: (id: string, dx: number, dy: number) => void;
  updateWidget: (id: string, patch: Partial<WidgetNode>) => void;
  updateProps: (id: string, props: Record<string, unknown>) => void;
  setBindings: (id: string, bindings: WidgetNode["bindings"]) => void;
  removeWidget: (id: string) => void;
  select: (id: string | null) => void;
  addPage: (name?: string) => void;
  switchPage: (id: string) => void;
  renamePage: (id: string, name: string) => void;
  removePage: (id: string) => void;
  /** mirror the working `widgets` back into `pages`, returning the full set
   *  (call before export/publish so the current page isn't stale) */
  syncedPages: () => { id: string; widgets: WidgetNode[] }[];
  setSimulate: (simulate: boolean) => void;
  toggleSimulate: () => void;
  loadTemplate: (key: TemplateKey) => void;
  loadLayout: (layout: Layout) => void;
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

export const NOOP_LOGIC_SOURCE = `#![no_std]

const CCP_ABI_VERSION: u32 = 1;
const CCP_OK: i32 = 0;
const CCP_ERR_INVAL: i32 = -1;

#[no_mangle]
pub extern "C" fn ccp_on_init(abi_version: u32) -> i32 {
    if abi_version != CCP_ABI_VERSION {
        return CCP_ERR_INVAL;
    }
    CCP_OK
}

#[no_mangle]
pub extern "C" fn ccp_on_tick(_now_ms: u64) {}

#[no_mangle]
pub extern "C" fn ccp_on_event(_widget: i32, _event: u32, _p0: i32, _p1: i32) {}

#[no_mangle]
pub extern "C" fn ccp_on_data(_stream_handle: i32, _payload_ptr: u32, _len: u32) {}

#[no_mangle]
pub extern "C" fn ccp_on_destroy() {}

static mut ARENA: [u8; 4 * 1024] = [0; 4 * 1024];
static mut ARENA_TOP: usize = 0;
static mut ARENA_LAST: usize = 0;

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

/* Real working clock logic — same time-keeping approach as the native clock
   (ask the host for epoch seconds every tick; host = SNTP on device, the
   real system clock in the browser simulator). Widget ids: time / sec / date. */
export const CLOCK_LOGIC_SOURCE = `#![no_std]

const CCP_ABI_VERSION: u32 = 1;
const CCP_OK: i32 = 0;
const CCP_ERR_INVAL: i32 = -1;
const TZ_OFFSET_MIN: i64 = 7 * 60; // Asia/Bangkok UTC+7 — default if no setting yet

#[link(wasm_import_module = "env")]
extern "C" {
    fn ccp_ui_get_widget(id: *const u8, id_len: u32) -> i32;
    fn ccp_ui_set_text(widget: i32, text: *const u8, len: u32) -> i32;
    fn ccp_request_tick(interval_ms: u32) -> i32;
    fn ccp_time_unix() -> u64;
    // settings.clock.* mirrored into wasm KV by the firmware (clk_tz/clk_fmt24/clk_datefmt)
    fn ccp_kv_get(key: *const u8, klen: u32, out: *mut u8, out_len: u32) -> i32;
}

static mut W_TIME: i32 = -1;
static mut W_SEC: i32 = -1;
static mut W_DATE: i32 = -1;
static mut LAST: i64 = -1;

#[no_mangle]
pub extern "C" fn ccp_on_init(abi_version: u32) -> i32 {
    if abi_version != CCP_ABI_VERSION {
        return CCP_ERR_INVAL;
    }
    unsafe {
        W_TIME = ccp_ui_get_widget(b"time".as_ptr(), 4);
        W_SEC = ccp_ui_get_widget(b"sec".as_ptr(), 3);
        W_DATE = ccp_ui_get_widget(b"date".as_ptr(), 4);
        ccp_request_tick(250); // check 4x/s so the seconds flip cleanly
    }
    CCP_OK
}

#[no_mangle]
pub extern "C" fn ccp_on_tick(_now_ms: u64) {
    unsafe {
        let utc = ccp_time_unix();
        if utc == 0 {
            // device: SNTP not synced yet (never happens in the browser sim)
            set_text(W_TIME, b"--:--");
            set_text(W_SEC, b"");
            set_text(W_DATE, b"Syncing time...");
            return;
        }
        // settings.clock.* mirrored into wasm KV by the firmware
        let mut kb = [0u8; 16];
        let mut tz = TZ_OFFSET_MIN;
        let n = kv_read(b"clk_tz", &mut kb);
        if n > 0 { tz = parse_int(&kb[..n]); }
        let mut fmt24 = true;
        let n = kv_read(b"clk_fmt24", &mut kb);
        if n > 0 { fmt24 = kb[0] != b'0'; }
        let mut datefmt = b'l'; // long | dmy | mdy | iso -> first byte
        let n = kv_read(b"clk_datefmt", &mut kb);
        if n > 0 { datefmt = kb[0]; }

        let local = utc as i64 + tz * 60;
        if local == LAST {
            return; // same second -> nothing to redraw
        }
        LAST = local;

        let sod = local.rem_euclid(86400) as u32; // seconds of day
        let h24 = sod / 3600;
        let m = (sod / 60) % 60;
        let s = sod % 60;

        // time: 24h "HH:MM" or 12h "H:MM" (AM/PM shown in the seconds slot)
        let (dh, pm) = if fmt24 {
            (h24, false)
        } else {
            let pm = h24 >= 12;
            let mut hh = h24 % 12;
            if hh == 0 { hh = 12; }
            (hh, pm)
        };
        let mut tb = [0u8; 8];
        let mut tn = 0usize;
        if fmt24 {
            put2(&mut tb[0..2], dh);
            tn = 2;
        } else {
            if dh >= 10 { tb[tn] = b'0' + (dh / 10) as u8; tn += 1; }
            tb[tn] = b'0' + (dh % 10) as u8;
            tn += 1;
        }
        tb[tn] = b':';
        tn += 1;
        put2(&mut tb[tn..tn + 2], m);
        tn += 2;
        set_text(W_TIME, &tb[..tn]);

        if fmt24 {
            let mut sb = [0u8; 2]; // "SS"
            put2(&mut sb[0..2], s);
            set_text(W_SEC, &sb);
        } else {
            set_text(W_SEC, if pm { b"PM" } else { b"AM" });
        }

        let days = local.div_euclid(86400);
        let (y, mo, d) = civil_from_days(days);
        let yv = y as u32;
        let mut db = [0u8; 28];
        let mut n = 0usize;
        if datefmt == b'i' {
            // 2026-06-11
            db[0] = b'0' + (yv / 1000 % 10) as u8;
            db[1] = b'0' + (yv / 100 % 10) as u8;
            db[2] = b'0' + (yv / 10 % 10) as u8;
            db[3] = b'0' + (yv % 10) as u8;
            db[4] = b'-';
            put2(&mut db[5..7], mo);
            db[7] = b'-';
            put2(&mut db[8..10], d);
            n = 10;
        } else if datefmt == b'd' || datefmt == b'm' {
            // dmy: DD/MM/YYYY  |  mdy: MM/DD/YYYY
            let (a, b2) = if datefmt == b'd' { (d, mo) } else { (mo, d) };
            put2(&mut db[0..2], a);
            db[2] = b'/';
            put2(&mut db[3..5], b2);
            db[5] = b'/';
            db[6] = b'0' + (yv / 1000 % 10) as u8;
            db[7] = b'0' + (yv / 100 % 10) as u8;
            db[8] = b'0' + (yv / 10 % 10) as u8;
            db[9] = b'0' + (yv % 10) as u8;
            n = 10;
        } else {
            // long: "Wednesday  11 Jun 2026"
            static WD: [&[u8]; 7] = [b"Sunday", b"Monday", b"Tuesday", b"Wednesday",
                                     b"Thursday", b"Friday", b"Saturday"];
            static MO: [&[u8]; 12] = [b"Jan", b"Feb", b"Mar", b"Apr", b"May", b"Jun",
                                      b"Jul", b"Aug", b"Sep", b"Oct", b"Nov", b"Dec"];
            let wd = WD[(days + 4).rem_euclid(7) as usize]; // 1970-01-01 = Thursday
            n += copy(&mut db[n..], wd);
            n += copy(&mut db[n..], b"  ");
            if d >= 10 { db[n] = b'0' + (d / 10) as u8; n += 1; }
            db[n] = b'0' + (d % 10) as u8;
            n += 1;
            n += copy(&mut db[n..], b" ");
            n += copy(&mut db[n..], MO[(mo - 1) as usize]);
            n += copy(&mut db[n..], b" ");
            db[n] = b'0' + (yv / 1000 % 10) as u8;
            db[n + 1] = b'0' + (yv / 100 % 10) as u8;
            db[n + 2] = b'0' + (yv / 10 % 10) as u8;
            db[n + 3] = b'0' + (yv % 10) as u8;
            n += 4;
        }
        set_text(W_DATE, &db[..n]);
    }
}

unsafe fn set_text(widget: i32, text: &[u8]) {
    if widget >= 0 {
        ccp_ui_set_text(widget, text.as_ptr(), text.len() as u32);
    }
}

fn put2(out: &mut [u8], v: u32) {
    out[0] = b'0' + (v / 10 % 10) as u8;
    out[1] = b'0' + (v % 10) as u8;
}

fn copy(out: &mut [u8], src: &[u8]) -> usize {
    out[..src.len()].copy_from_slice(src);
    src.len()
}

unsafe fn kv_read(key: &[u8], buf: &mut [u8]) -> usize {
    let n = ccp_kv_get(key.as_ptr(), key.len() as u32, buf.as_mut_ptr(), buf.len() as u32);
    if n > 0 { n as usize } else { 0 }
}

fn parse_int(b: &[u8]) -> i64 {
    let mut i = 0;
    let mut neg = false;
    if i < b.len() && b[i] == b'-' { neg = true; i += 1; }
    let mut v: i64 = 0;
    while i < b.len() && b[i] >= b'0' && b[i] <= b'9' {
        v = v * 10 + (b[i] - b'0') as i64;
        i += 1;
    }
    if neg { -v } else { v }
}

/* days since 1970-01-01 -> (year, month 1-12, day 1-31)
   Howard Hinnant's civil_from_days — correct for all leap years */
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[no_mangle]
pub extern "C" fn ccp_on_event(_widget: i32, _event: u32, _p0: i32, _p1: i32) {}

#[no_mangle]
pub extern "C" fn ccp_on_data(_stream_handle: i32, _payload_ptr: u32, _len: u32) {}

#[no_mangle]
pub extern "C" fn ccp_on_destroy() {}

static mut ARENA: [u8; 4 * 1024] = [0; 4 * 1024];
static mut ARENA_TOP: usize = 0;
static mut ARENA_LAST: usize = 0;

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

/* Faithful port of the native crypto page behavior (home_ui.c):
   symbol cycle (event 101), USD/THB toggle (102), timeframe cycle (103),
   live price + 24h change with green/red color, candlestick chart drawn on a
   canvas with the same algorithm (6% pad, slot*7/10 body, 1px wick). */
export const CRYPTO_LOGIC_SOURCE = `#![no_std]

const CCP_ABI_VERSION: u32 = 1;
const CCP_OK: i32 = 0;
const CCP_ERR_INVAL: i32 = -1;

const EVT_SYMBOL: u32 = 101;
const EVT_CURRENCY: u32 = 102;
const EVT_TIMEFRAME: u32 = 103;

const COL_PANEL: u32 = 0x161B22;
const COL_GREEN: u32 = 0x0ECB81;
const COL_RED: u32 = 0xF6465D;
const CANDLE_W: i32 = 444;
const CANDLE_H: i32 = 130;
const MAXC: usize = 60;

#[link(wasm_import_module = "env")]
extern "C" {
    fn ccp_ui_get_widget(id: *const u8, id_len: u32) -> i32;
    fn ccp_ui_set_text(widget: i32, text: *const u8, len: u32) -> i32;
    fn ccp_ui_set_color(widget: i32, argb: u32, part: u32) -> i32;
    fn ccp_canvas_fill_rect(w: i32, x: i32, y: i32, rw: i32, rh: i32, argb: u32) -> i32;
    fn ccp_canvas_draw_line(w: i32, x0: i32, y0: i32, x1: i32, y1: i32, argb: u32, width: u32) -> i32;
    fn ccp_canvas_flush(w: i32) -> i32;
    fn ccp_data_subscribe(stream: *const u8, len: u32) -> i32;
    fn ccp_data_unsubscribe(handle: i32) -> i32;
}

static SYMBOLS: [&[u8]; 4] = [b"BTCUSDT", b"ETHUSDT", b"BNBUSDT", b"SOLUSDT"];
static TFS: [&[u8]; 4] = [b"15m", b"1h", b"4h", b"1d"];

static mut W_SYM: i32 = -1;
static mut W_CUR: i32 = -1;
static mut W_PRICE: i32 = -1;
static mut W_CHANGE: i32 = -1;
static mut W_CANDLES: i32 = -1;
static mut W_TF: i32 = -1;
static mut W_UPD: i32 = -1;
static mut W_DOT: i32 = -1;

static mut SYM_IDX: usize = 0;
static mut TF_IDX: usize = 0;
static mut THB: bool = false;
static mut RATE: f64 = 0.0;
static mut PRICE: f64 = 0.0;
static mut CHG: f64 = 0.0;
static mut HAVE_QUOTE: bool = false;

static mut H_TICKER: [i32; 4] = [-1; 4];
static mut H_FX: i32 = -1;
static mut H_KLINES: i32 = -1;

static mut CO: [f64; MAXC] = [0.0; MAXC];
static mut CH: [f64; MAXC] = [0.0; MAXC];
static mut CL: [f64; MAXC] = [0.0; MAXC];
static mut CC: [f64; MAXC] = [0.0; MAXC];
static mut NCANDLES: usize = 0;

#[no_mangle]
pub extern "C" fn ccp_on_init(abi_version: u32) -> i32 {
    if abi_version != CCP_ABI_VERSION {
        return CCP_ERR_INVAL;
    }
    unsafe {
        W_SYM = get(b"sym_btn");
        W_CUR = get(b"cur_btn");
        W_PRICE = get(b"price");
        W_CHANGE = get(b"change");
        W_CANDLES = get(b"candles");
        W_TF = get(b"tf_btn");
        W_UPD = get(b"updated");
        W_DOT = get(b"dot");

        let mut i = 0;
        while i < SYMBOLS.len() {
            let mut b = [0u8; 32];
            let mut n = 0;
            n += copy(&mut b[n..], b"market.");
            n += copy(&mut b[n..], SYMBOLS[i]);
            n += copy(&mut b[n..], b".ticker");
            H_TICKER[i] = ccp_data_subscribe(b.as_ptr(), n as u32);
            i += 1;
        }
        H_FX = ccp_data_subscribe(b"fx.USDTHB".as_ptr(), 9);
        sub_klines();
        update_header();
        render_price();
        render_candles();
    }
    CCP_OK
}

#[no_mangle]
pub extern "C" fn ccp_on_event(_widget: i32, event: u32, _p0: i32, _p1: i32) {
    unsafe {
        match event {
            EVT_SYMBOL => {
                SYM_IDX = (SYM_IDX + 1) % SYMBOLS.len();
                NCANDLES = 0;
                HAVE_QUOTE = false;
                sub_klines();
                update_header();
                render_price();
                render_candles();
            }
            EVT_CURRENCY => {
                THB = !THB;
                update_header();
                render_price();
            }
            EVT_TIMEFRAME => {
                TF_IDX = (TF_IDX + 1) % TFS.len();
                NCANDLES = 0;
                sub_klines();
                update_header();
                render_candles();
            }
            _ => {}
        }
    }
}

#[no_mangle]
pub extern "C" fn ccp_on_data(h: i32, payload_ptr: u32, len: u32) {
    unsafe {
        let b = core::slice::from_raw_parts(payload_ptr as *const u8, len as usize);
        if h == H_KLINES {
            let no = key_array(b, b"\\"o\\":[", &mut CO);
            let nh = key_array(b, b"\\"h\\":[", &mut CH);
            let nl = key_array(b, b"\\"l\\":[", &mut CL);
            let nc = key_array(b, b"\\"c\\":[", &mut CC);
            let mut n = no;
            if nh < n { n = nh; }
            if nl < n { n = nl; }
            if nc < n { n = nc; }
            NCANDLES = n;
            render_candles();
        } else if h == H_FX {
            if let Some(r) = key_f64(b, b"\\"rate\\":") {
                RATE = r;
                render_price();
            }
        } else if h == H_TICKER[SYM_IDX] {
            if let Some(p) = key_f64(b, b"\\"price\\":") {
                PRICE = p;
                HAVE_QUOTE = true;
                if let Some(cp) = key_f64(b, b"\\"changePct\\":") {
                    CHG = cp;
                }
                // live tick updates the forming candle's close/high/low (like native)
                if NCANDLES > 0 {
                    let i = NCANDLES - 1;
                    CC[i] = p;
                    if p > CH[i] { CH[i] = p; }
                    if p < CL[i] { CL[i] = p; }
                    render_candles();
                }
                render_price();
                ccp_ui_set_color(W_DOT, COL_GREEN, 0);
                set_text(W_UPD, b"Binance \\xc2\\xb7 live");
            }
        }
    }
}

#[no_mangle]
pub extern "C" fn ccp_on_tick(_now_ms: u64) {}

#[no_mangle]
pub extern "C" fn ccp_on_destroy() {}

/* ----------------------------------------------------------- rendering */

unsafe fn update_header() {
    let s = SYMBOLS[SYM_IDX];
    let mut b = [0u8; 16];
    let mut n = 0;
    n += copy(&mut b[n..], &s[..s.len() - 4]); // strip USDT
    n += copy(&mut b[n..], b"/USDT");
    set_text(W_SYM, &b[..n]);
    set_text(W_CUR, if THB { b"THB" } else { b"USD" });
    set_text(W_TF, TFS[TF_IDX]);
}

unsafe fn render_price() {
    if !HAVE_QUOTE {
        set_text(W_PRICE, b"--");
        set_text(W_CHANGE, b"loading...");
        return;
    }
    let thb = THB && RATE > 0.0;
    let p = if thb { PRICE * RATE } else { PRICE };
    let mut buf = [0u8; 32];
    let mut n = 0;
    n += copy(&mut buf[n..], if thb { &b"THB "[..] } else { &b"$"[..] });
    n += fmt_price(&mut buf[n..], p);
    set_text(W_PRICE, &buf[..n]);

    let mut cb = [0u8; 24];
    let mut m = 0;
    cb[m] = if CHG < 0.0 { b'-' } else { b'+' };
    m += 1;
    let a = if CHG < 0.0 { -CHG } else { CHG };
    let cents = (a * 100.0 + 0.5) as u64;
    m += fmt_u64(&mut cb[m..], cents / 100, false);
    cb[m] = b'.';
    m += 1;
    cb[m] = b'0' + ((cents / 10) % 10) as u8;
    m += 1;
    cb[m] = b'0' + (cents % 10) as u8;
    m += 1;
    m += copy(&mut cb[m..], b"% (24h)");
    set_text(W_CHANGE, &cb[..m]);
    ccp_ui_set_color(W_CHANGE, if CHG < 0.0 { COL_RED } else { COL_GREEN }, 1);
}

/* same algorithm as home_ui.c candle_render(): 6% pad, body 7/10 slot, 1px wick */
unsafe fn render_candles() {
    if W_CANDLES < 0 {
        return;
    }
    ccp_canvas_fill_rect(W_CANDLES, 0, 0, CANDLE_W, CANDLE_H, COL_PANEL);
    let n = NCANDLES;
    if n == 0 {
        ccp_canvas_flush(W_CANDLES);
        return;
    }
    let mut lo = CL[0];
    let mut hi = CH[0];
    let mut i = 1;
    while i < n {
        if CL[i] < lo { lo = CL[i]; }
        if CH[i] > hi { hi = CH[i]; }
        i += 1;
    }
    if hi <= lo { hi = lo + 1.0; }
    let pad = (hi - lo) * 0.06;
    lo -= pad;
    hi += pad;
    let range = hi - lo;
    let mut slot = CANDLE_W / n as i32;
    if slot < 1 { slot = 1; }
    let mut body_w = slot * 7 / 10;
    if body_w < 1 { body_w = 1; }

    i = 0;
    while i < n {
        let up = CC[i] >= CO[i];
        let col = if up { COL_GREEN } else { COL_RED };
        let xc = i as i32 * slot + slot / 2;
        let yh = y_of(CH[i], hi, range);
        let yl = y_of(CL[i], hi, range);
        ccp_canvas_draw_line(W_CANDLES, xc, yh, xc, yl, col, 1);
        let mut ya = y_of(if up { CC[i] } else { CO[i] }, hi, range);
        let mut yb = y_of(if up { CO[i] } else { CC[i] }, hi, range);
        if yb <= ya { yb = ya + 1; }
        if ya < 0 { ya = 0; }
        ccp_canvas_fill_rect(W_CANDLES, xc - body_w / 2, ya, body_w, yb - ya, col);
        i += 1;
    }
    ccp_canvas_flush(W_CANDLES);
}

fn y_of(v: f64, hi: f64, range: f64) -> i32 {
    ((hi - v) / range * (CANDLE_H - 1) as f64) as i32
}

/* ------------------------------------------------------------- helpers */

unsafe fn get(id: &[u8]) -> i32 {
    ccp_ui_get_widget(id.as_ptr(), id.len() as u32)
}

unsafe fn set_text(widget: i32, text: &[u8]) {
    if widget >= 0 {
        ccp_ui_set_text(widget, text.as_ptr(), text.len() as u32);
    }
}

unsafe fn sub_klines() {
    if H_KLINES >= 0 {
        ccp_data_unsubscribe(H_KLINES);
    }
    let mut b = [0u8; 40];
    let mut n = 0;
    n += copy(&mut b[n..], b"market.");
    n += copy(&mut b[n..], SYMBOLS[SYM_IDX]);
    n += copy(&mut b[n..], b".klines.");
    n += copy(&mut b[n..], TFS[TF_IDX]);
    H_KLINES = ccp_data_subscribe(b.as_ptr(), n as u32);
}

fn copy(out: &mut [u8], src: &[u8]) -> usize {
    out[..src.len()].copy_from_slice(src);
    src.len()
}

fn fmt_u64(out: &mut [u8], mut v: u64, commas: bool) -> usize {
    let mut tmp = [0u8; 24];
    let mut k = 0;
    if v == 0 {
        tmp[0] = b'0';
        k = 1;
    }
    while v > 0 {
        tmp[k] = b'0' + (v % 10) as u8;
        v /= 10;
        k += 1;
    }
    let mut n = 0;
    let mut i = k;
    while i > 0 {
        i -= 1;
        out[n] = tmp[i];
        n += 1;
        if commas && i > 0 && i % 3 == 0 {
            out[n] = b',';
            n += 1;
        }
    }
    n
}

fn fmt_price(out: &mut [u8], p: f64) -> usize {
    if p >= 1.0 {
        let cents = (p * 100.0 + 0.5) as u64;
        let mut n = fmt_u64(out, cents / 100, p >= 1000.0);
        out[n] = b'.';
        n += 1;
        out[n] = b'0' + ((cents / 10) % 10) as u8;
        n += 1;
        out[n] = b'0' + (cents % 10) as u8;
        n += 1;
        n
    } else {
        // sub-$1 coins: 0.xxxxxx
        let micros = (p * 1_000_000.0 + 0.5) as u64 % 1_000_000;
        out[0] = b'0';
        out[1] = b'.';
        let mut n = 2;
        let mut div = 100_000u64;
        while div > 0 {
            out[n] = b'0' + ((micros / div) % 10) as u8;
            n += 1;
            div /= 10;
        }
        n
    }
}

/* tiny JSON scanners — payloads are trusted server feeds */

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    let mut i = 0;
    while i + needle.len() <= hay.len() {
        if &hay[i..i + needle.len()] == needle {
            return Some(i + needle.len());
        }
        i += 1;
    }
    None
}

fn parse_f64(b: &[u8], pos: &mut usize) -> f64 {
    let n = b.len();
    while *pos < n && b[*pos] == b' ' {
        *pos += 1;
    }
    let mut neg = false;
    if *pos < n && b[*pos] == b'-' {
        neg = true;
        *pos += 1;
    }
    let mut v: f64 = 0.0;
    while *pos < n && b[*pos].is_ascii_digit() {
        v = v * 10.0 + (b[*pos] - b'0') as f64;
        *pos += 1;
    }
    if *pos < n && b[*pos] == b'.' {
        *pos += 1;
        let mut scale = 0.1;
        while *pos < n && b[*pos].is_ascii_digit() {
            v += (b[*pos] - b'0') as f64 * scale;
            scale *= 0.1;
            *pos += 1;
        }
    }
    if *pos < n && (b[*pos] == b'e' || b[*pos] == b'E') {
        *pos += 1;
        let mut eneg = false;
        if *pos < n && (b[*pos] == b'+' || b[*pos] == b'-') {
            eneg = b[*pos] == b'-';
            *pos += 1;
        }
        let mut e = 0i32;
        while *pos < n && b[*pos].is_ascii_digit() {
            e = e * 10 + (b[*pos] - b'0') as i32;
            *pos += 1;
        }
        let mut k = 0;
        while k < e {
            v = if eneg { v * 0.1 } else { v * 10.0 };
            k += 1;
        }
    }
    if neg { -v } else { v }
}

fn key_f64(b: &[u8], key: &[u8]) -> Option<f64> {
    match find(b, key) {
        Some(mut pos) => Some(parse_f64(b, &mut pos)),
        None => None,
    }
}

fn key_array(b: &[u8], key: &[u8], out: &mut [f64; MAXC]) -> usize {
    let mut pos = match find(b, key) {
        Some(p) => p,
        None => return 0,
    };
    let mut n = 0usize;
    while pos < b.len() && n < MAXC {
        out[n] = parse_f64(b, &mut pos);
        n += 1;
        while pos < b.len() && b[pos] == b' ' {
            pos += 1;
        }
        if pos < b.len() && b[pos] == b',' {
            pos += 1;
        } else {
            break;
        }
    }
    n
}

static mut ARENA: [u8; 16 * 1024] = [0; 16 * 1024];
static mut ARENA_TOP: usize = 0;
static mut ARENA_LAST: usize = 0;

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

/* Cute animated Weather page: full-screen canvas "scene" that the wasm paints
   each tick with a weather-themed gradient background + a procedurally animated
   icon (sun w/ rotating rays, drifting clouds, falling rain/snow, lightning
   flash, fog). Text (city/temp/humidity/desc) comes from bindings; the clock is
   driven here from ccp_time_unix. theme switches on the weather payload's
   "theme" field (clear|partly|cloudy|rain|thunder|snow|fog). */
export const WEATHER_LOGIC_SOURCE = `#![no_std]

const CCP_ABI_VERSION: u32 = 1;
const CCP_OK: i32 = 0;
const CCP_ERR_INVAL: i32 = -1;
const TZ_OFFSET_MIN: i64 = 7 * 60; // Asia/Bangkok

#[link(wasm_import_module = "env")]
extern "C" {
    fn ccp_ui_get_widget(id: *const u8, id_len: u32) -> i32;
    fn ccp_ui_set_text(widget: i32, text: *const u8, len: u32) -> i32;
    fn ccp_request_tick(interval_ms: u32) -> i32;
    fn ccp_time_unix() -> u64;
}

static mut W_TIME: i32 = -1;
static mut LAST_MIN: i64 = -1;

#[no_mangle]
pub extern "C" fn ccp_on_init(abi_version: u32) -> i32 {
    if abi_version != CCP_ABI_VERSION {
        return CCP_ERR_INVAL;
    }
    unsafe {
        W_TIME = ccp_ui_get_widget(b"time".as_ptr(), 4);
        ccp_request_tick(1000);
    }
    CCP_OK
}

#[no_mangle]
pub extern "C" fn ccp_on_tick(_now_ms: u64) {
    unsafe {
        let utc = ccp_time_unix();
        if utc == 0 {
            return;
        }
        let local = utc as i64 + TZ_OFFSET_MIN * 60;
        let minute = local / 60;
        if minute == LAST_MIN {
            return;
        }
        LAST_MIN = minute;
        let sod = local.rem_euclid(86400) as u32;
        let mut buf = [0u8; 5];
        put2(&mut buf[0..2], sod / 3600);
        buf[2] = b':';
        put2(&mut buf[3..5], (sod / 60) % 60);
        if W_TIME >= 0 {
            ccp_ui_set_text(W_TIME, buf.as_ptr(), 5);
        }
    }
}

#[no_mangle]
pub extern "C" fn ccp_on_event(_w: i32, _e: u32, _p0: i32, _p1: i32) {}
#[no_mangle]
pub extern "C" fn ccp_on_data(_h: i32, _ptr: u32, _len: u32) {}
#[no_mangle]
pub extern "C" fn ccp_on_destroy() {}

fn put2(out: &mut [u8], v: u32) {
    out[0] = b'0' + (v / 10 % 10) as u8;
    out[1] = b'0' + (v % 10) as u8;
}

static mut ARENA: [u8; 2 * 1024] = [0; 2 * 1024];
static mut ARENA_TOP: usize = 0;
static mut ARENA_LAST: usize = 0;

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

export const UNAVAILABLE_LOGIC_SOURCE = `// Source for this published WASM was not saved by the older Builder.
// You can still edit widget properties and Save / Publish; the server will carry
// the previous wasm file forward. To change logic, paste the Rust source here
// or click Reset page logic to start from the no-op template, then Compile Rust.
`;

export const LED_TOGGLE_LOGIC_SOURCE = `#![no_std]

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
  dataSources: [],
  wasmModules: [],
  assets: [],
  settingsSchema: [],
  settingsPreview: {},
  logicSource: NOOP_LOGIC_SOURCE,
  logicStarterSource: NOOP_LOGIC_SOURCE,
  compiledWasm: null,
  widgets: [],
  pages: [{ id: "main", name: "Main", widgets: [] }],
  currentPageId: "main",
  selectedId: null,
  counter: 0,
  simulate: false,

  setOrientation: (o) => set({ orientation: o }),
  addAsset: (asset) =>
    set((s) => ({ assets: [...s.assets.filter((a) => a.id !== asset.id), asset] })),
  removeAsset: (id) => set((s) => ({ assets: s.assets.filter((a) => a.id !== id) })),
  addSettingsField: () =>
    set((s) => ({
      settingsSchema: [
        ...s.settingsSchema,
        { key: `field_${s.settingsSchema.length + 1}`, label: "New field", type: "text" as const },
      ],
    })),
  updateSettingsField: (index, patch) =>
    set((s) => ({
      settingsSchema: s.settingsSchema.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    })),
  removeSettingsField: (index) =>
    set((s) => ({ settingsSchema: s.settingsSchema.filter((_, i) => i !== index) })),
  setSettingsPreview: (key, value) =>
    set((s) => ({ settingsPreview: { ...s.settingsPreview, [key]: value } })),
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
  resetLogicSource: () =>
    set({
      logicSource: get().logicStarterSource === UNAVAILABLE_LOGIC_SOURCE ? NOOP_LOGIC_SOURCE : get().logicStarterSource,
      compiledWasm: null,
    }),
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

  // ---- multi-page ----
  // `widgets` is the working copy of the current page; pages[] holds them all.
  // On every switch we flush `widgets` back into its page first.
  switchPage: (id) =>
    set((s) => {
      const pages = s.pages.map((p) => (p.id === s.currentPageId ? { ...p, widgets: s.widgets } : p));
      const target = pages.find((p) => p.id === id) ?? pages[0];
      return {
        pages,
        currentPageId: target.id,
        widgets: JSON.parse(JSON.stringify(target.widgets)) as WidgetNode[],
        selectedId: null,
      };
    }),
  addPage: (name) =>
    set((s) => {
      const flushed = s.pages.map((p) => (p.id === s.currentPageId ? { ...p, widgets: s.widgets } : p));
      let n = flushed.length + 1;
      let id = `page_${n}`;
      while (flushed.some((p) => p.id === id)) id = `page_${++n}`;
      return {
        pages: [...flushed, { id, name: name || `Page ${flushed.length + 1}`, widgets: [] }],
        currentPageId: id,
        widgets: [],
        selectedId: null,
      };
    }),
  renamePage: (id, name) =>
    set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, name } : p)) })),
  removePage: (id) =>
    set((s) => {
      if (s.pages.length <= 1) return {}; // keep at least one page
      const flushed = s.pages.map((p) => (p.id === s.currentPageId ? { ...p, widgets: s.widgets } : p));
      const pages = flushed.filter((p) => p.id !== id);
      const cur = id === s.currentPageId ? pages[0] : pages.find((p) => p.id === s.currentPageId)!;
      return {
        pages,
        currentPageId: cur.id,
        widgets: JSON.parse(JSON.stringify(cur.widgets)) as WidgetNode[],
        selectedId: null,
      };
    }),
  syncedPages: () => {
    const s = get();
    return s.pages.map((p) => ({
      id: p.id,
      widgets: p.id === s.currentPageId ? s.widgets : p.widgets,
    }));
  },

  setSimulate: (simulate) => set({ simulate }),

  toggleSimulate: () => set({ simulate: !get().simulate }),

  loadTemplate: (key) => {
    const t = TEMPLATES[key];
    // deep clone so edits don't mutate the template constant
    const logicSource =
      key === "led_toggle" ? LED_TOGGLE_LOGIC_SOURCE :
      key === "clock" ? CLOCK_LOGIC_SOURCE :
      key === "calendar" ? CLOCK_LOGIC_SOURCE : // drives the "date" label
      key === "profile" ? CLOCK_LOGIC_SOURCE : // drives the big "time" label
      key === "crypto" ? CRYPTO_LOGIC_SOURCE :
      key === "weather" ? WEATHER_LOGIC_SOURCE :
      NOOP_LOGIC_SOURCE;
    const hasLogic = key === "led_toggle" || key === "clock" || key === "calendar" || key === "profile" || key === "crypto" || key === "weather";
    const wasmModules = hasLogic
      ? [{ id: "logic", path: "wasm/page.wasm", memory_kb: key === "crypto" || key === "weather" ? 256 : 128 }]
      : [];
    console.debug("[builder] loadTemplate", { key, widgets: t.widgets.length });
    const tplPages = (t.pages ?? [{ id: "main", name: "Main", widgets: t.widgets }]).map((p) => ({
      id: p.id,
      name: p.name,
      widgets: JSON.parse(JSON.stringify(p.widgets)) as WidgetNode[],
    }));
    set({
      widgets: JSON.parse(JSON.stringify(tplPages[0].widgets)) as WidgetNode[],
      pages: tplPages,
      currentPageId: tplPages[0].id,
      name: t.name === "Blank" ? get().name : t.name,
      packageId:
        key === "led_toggle" ? "com.ccp.led-toggle" :
        key === "clock" ? "com.ccp.clock-custom" :
        key === "calendar" ? "com.ccp.calendar" :
        key === "crypto" ? "com.ccp.crypto-custom" :
        key === "crypto_big" ? "com.ccp.crypto-big" :
        key === "slideshow" ? "com.ccp.slideshow-custom" :
        key === "profile" ? "com.ccp.profile" :
        key === "weather" ? "com.ccp.weather" :
        key === "welcome" ? "com.ccp.welcome-custom" :
        get().packageId,
      dataSources: key === "weather"
        ? [
            { id: "weather", stream: "weather.bangkok", format: "json" as const, sample_hint_ms: 60000 },
            { id: "settings", stream: "settings.weather", format: "json" as const },
          ]
        : key === "profile"
        ? [{ id: "settings", stream: "settings.profile", format: "json" as const }]
        : key === "clock"
        ? [{ id: "settings", stream: "settings.clock", format: "json" as const }]
        : key === "calendar"
        ? [{ id: "settings", stream: "settings.calendar", format: "json" as const }]
        : key === "crypto_big"
        ? [{ id: "btc", stream: "market.BTCUSDT.ticker", format: "json" as const, sample_hint_ms: 2000 }]
        : key === "crypto"
        ? [
            { id: "btc", stream: "market.BTCUSDT.ticker", format: "json" as const, sample_hint_ms: 2000 },
            { id: "eth", stream: "market.ETHUSDT.ticker", format: "json" as const, sample_hint_ms: 2000 },
            { id: "bnb", stream: "market.BNBUSDT.ticker", format: "json" as const, sample_hint_ms: 2000 },
            { id: "sol", stream: "market.SOLUSDT.ticker", format: "json" as const, sample_hint_ms: 2000 },
            { id: "fx", stream: "fx.USDTHB", format: "json" as const },
            { id: "kl", stream: "market.BTCUSDT.klines.15m", format: "json" as const, sample_hint_ms: 15000 },
          ]
        : [],
      wasmModules,
      assets:
        key === "weather"
          ? WEATHER_ASSETS.map((a) => ({ ...a }))
          : key === "profile"
            ? PROFILE_SOCIAL_ASSETS.map((a) => ({ ...a }))
            : key === "slideshow"
              ? SLIDESHOW_ASSETS.map((a) => ({ ...a }))
              : [],
      settingsSchema: key === "clock"
        ? [
            { key: "format_24h", label: "24-hour clock", type: "toggle" as const, default: true },
            { key: "show_seconds", label: "Show seconds", type: "toggle" as const, default: true },
            { key: "show_date", label: "Show date", type: "toggle" as const, default: true },
            { key: "date_format", label: "Date format", type: "select" as const, options: ["long", "dmy", "mdy", "iso"], default: "long" },
            { key: "show_logo", label: "Show logo", type: "toggle" as const, default: true },
            { key: "tz_offset_min", label: "Timezone offset (min)", type: "number" as const, default: 420 },
            { key: "time_color", label: "Time colour", type: "color" as const, group: "Colours", default: "#00D1FF" },
            { key: "sec_color", label: "Seconds colour", type: "color" as const, group: "Colours", default: "#FF9500" },
            { key: "date_color", label: "Date colour", type: "color" as const, group: "Colours", default: "#848E9C" },
            { key: "bg_color", label: "Background", type: "color" as const, group: "Colours", default: "#0B0E11" },
          ]
        : key === "weather"
        ? [
            { key: "city", label: "City", type: "text" as const, default: "Bangkok" },
            { key: "show_pm", label: "Show PM2.5 / PM10", type: "toggle" as const, default: true },
            { key: "bg_color", label: "Background colour", type: "color" as const, default: "#27384B" },
            { key: "bg_gif", label: "Background GIF (480×320, set in app)", type: "text" as const },
          ]
        : key === "calendar"
        ? [
            { key: "title", label: "Title", type: "text" as const, default: "CALENDAR" },
            { key: "bg_color", label: "Background colour", type: "color" as const, default: "#0B0E11" },
          ]
        : key === "profile"
        ? [
            { key: "nickname", label: "Nickname", type: "text" as const, default: "SATOSHI NAKAMOTO" },
            { key: "role", label: "Role / subtitle", type: "text" as const, default: "(SAT) CYPHERPUNK" },
            { key: "motto", label: "Motto (top-right)", type: "text" as const, default: "DON'T TRUST  VERIFY" },
            { key: "company", label: "Company", type: "text" as const, default: "Acme Capital" },
            { key: "show", label: "Show this page", type: "toggle" as const, default: true },
            { key: "name_color", label: "Name colour", type: "color" as const, group: "Colours", default: "#EAECEF" },
            { key: "role_color", label: "Role colour", type: "color" as const, group: "Colours", default: "#848E9C" },
            { key: "company_color", label: "Company colour", type: "color" as const, group: "Colours", default: "#F0B90B" },
            { key: "verify_color", label: "Motto colour", type: "color" as const, group: "Colours", default: "#F0B90B" },
            { key: "bg_color", label: "Background", type: "color" as const, group: "Colours", default: "#0B0E11" },
            { key: "fb_url", label: "Facebook URL", type: "text" as const, group: "Social" },
            { key: "yt_url", label: "YouTube URL", type: "text" as const, group: "Social" },
            { key: "tt_url", label: "TikTok URL", type: "text" as const, group: "Social" },
            { key: "ig_url", label: "Instagram URL", type: "text" as const, group: "Social" },
          ]
        : [],
      settingsPreview: {},
      logicSource,
      logicStarterSource: logicSource,
      compiledWasm: null,
      selectedId: null,
      simulate: false,
      counter: t.widgets.length,
    });
  },

  loadLayout: (layout) => {
    const layoutPages = (layout.pages?.length ? layout.pages : [{ id: "main", widgets: [] }]).map((p, i) => ({
      id: p.id || `page_${i + 1}`,
      name: (p as { name?: string }).name || (i === 0 ? "Main" : p.id || `Page ${i + 1}`),
      widgets: JSON.parse(JSON.stringify(p.widgets ?? [])) as WidgetNode[],
    }));
    const widgets = layoutPages[0].widgets;
    const logicSource = layout.builder?.logic_source || ((layout.wasm?.length ?? 0) > 0 ? UNAVAILABLE_LOGIC_SOURCE : NOOP_LOGIC_SOURCE);
    console.debug("[builder] loadLayout", {
      packageId: layout.meta.id,
      version: layout.meta.version,
      widgets: widgets.length,
      wasm: layout.wasm?.length ?? 0,
    });
    set({
      packageId: layout.meta.id,
      name: layout.meta.name,
      version: layout.meta.version,
      orientation: layout.display?.orientation ?? "landscape",
      dataSources: (layout.data_sources ?? []) as DataSourceConfig[],
      wasmModules: (layout.wasm ?? []) as WasmModuleConfig[],
      assets: (layout.assets ?? []).map((a) => {
        const builtin = BUILTIN_ASSETS.find((w) => w.id === a.id);
        return {
          id: a.id,
          type: a.type as AssetType,
          path: a.path,
          // built-in weather GIFs render from web/public; others from the saved bundle file
          src: builtin?.src ?? `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/api/v1/packages/${layout.meta.id}/${layout.meta.version}/${a.path}`,
        };
      }),
      settingsSchema: (layout.settings_schema ?? []) as SettingsField[],
      settingsPreview: {},
      logicSource,
      logicStarterSource: logicSource,
      compiledWasm: null,
      widgets,
      pages: layoutPages,
      currentPageId: layoutPages[0].id,
      selectedId: null,
      simulate: false,
      counter: nextCounter(widgets),
    });
  },
}));

function nextCounter(widgets: WidgetNode[]) {
  let max = widgets.length;
  for (const widget of widgets) {
    const match = widget.id.match(/_(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
}
