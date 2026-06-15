import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { MqttBridgeService } from "../mqtt/mqtt-bridge.service";

/**
 * Live data feeder for published Builder pages.
 *
 * Devices subscribe ccp/v1/{id}/data/{stream} for every data_source their
 * installed layout declares. This service walks the assigned payload layouts,
 * fetches each referenced stream from its upstream (Binance / open-meteo /
 * open.er-api) on a per-pattern cadence, and publishes the same JSON shapes
 * the Builder simulator feeds — so a page behaves identically on the device.
 */
@Injectable()
export class FeedsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(FeedsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastFetch = new Map<string, number>(); // stream -> epoch ms
  private cache = new Map<string, unknown>(); // stream -> last payload
  private published = new Set<string>(); // "deviceId|stream" already sent the cached value

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttBridgeService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.log.log("data feeder started (5s loop)");
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** streams wanted per device, from the layout of its assigned payload */
  private async targets(): Promise<Map<string, string[]>> {
    const devices = await this.prisma.device.findMany({
      where: { activePayloadVersionId: { not: null } },
      select: { deviceId: true, activePayloadVersion: { select: { layout: true } } },
    });
    const out = new Map<string, string[]>();
    for (const d of devices) {
      const layout = d.activePayloadVersion?.layout as
        | { data_sources?: { stream?: string }[] }
        | null;
      const streams = (layout?.data_sources ?? [])
        .map((s) => s.stream)
        .filter((s): s is string => Boolean(s));
      if (streams.length) out.set(d.deviceId, streams);
    }
    return out;
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const targets = await this.targets();
      if (targets.size === 0) return;
      const streams = new Set<string>();
      for (const list of targets.values()) for (const s of list) streams.add(s);

      // track which devices already have each stream this run, so a freshly
      // online device gets the cached value within 5s (MQTT data isn't retained)
      const seen = this.published;
      for (const stream of streams) {
        const fresh = await this.fetchStream(stream); // null = cadence not due
        if (fresh !== null) this.cache.set(stream, fresh);
        const payload = fresh ?? this.cache.get(stream);
        if (payload === undefined) continue; // nothing fetched yet (e.g. slow first call)

        for (const [deviceId, list] of targets) {
          if (!list.includes(stream)) continue;
          const key = `${deviceId}|${stream}`;
          // publish on a fresh fetch, or once to a device that hasn't seen it yet
          if (fresh !== null || !seen.has(key)) {
            this.mqtt.publishData(deviceId, stream, payload);
            seen.add(key);
          }
        }
      }
    } catch (err) {
      this.log.warn(`feed tick failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  }

  /** Fetch a stream if its cadence is due; null = skip this tick. */
  private async fetchStream(stream: string): Promise<unknown | null> {
    const ticker = /^market\.([A-Z0-9]{5,12})\.ticker$/.exec(stream);
    const klines = /^market\.([A-Z0-9]{5,12})\.klines\.(\d+[mhdw])$/.exec(stream);
    const fx = /^fx\.([A-Z]{6})$/.exec(stream);
    const weather = /^weather\.([a-z-]+)$/.exec(stream);

    const intervalMs = ticker ? 5_000 : klines ? 60_000 : weather ? 600_000 : fx ? 21_600_000 : 0;
    if (!intervalMs) return null;
    const last = this.lastFetch.get(stream) ?? 0;
    if (Date.now() - last < intervalMs) return null;
    this.lastFetch.set(stream, Date.now());

    try {
      if (ticker) return await this.fetchTicker(ticker[1]);
      if (klines) return await this.fetchKlines(klines[1], klines[2]);
      if (fx) return await this.fetchFx(fx[1]);
      if (weather) return await this.fetchWeather(weather[1]);
    } catch (err) {
      this.log.warn(`${stream}: ${err instanceof Error ? err.message : err}`);
      this.lastFetch.set(stream, Date.now() - intervalMs + 30_000); // retry in 30s
    }
    return null;
  }

  private async fetchTicker(symbol: string) {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
    if (!res.ok) throw new Error(`binance ${res.status}`);
    const j = (await res.json()) as { lastPrice: string; priceChangePercent: string };
    const price = Number(j.lastPrice);
    const changePct = Number(j.priceChangePercent);
    const change = `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`;
    const pretty = price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // priceFmt is a top-level formatted price so a bindings-only page (no wasm)
    // can show "64,231.50" via path "priceFmt" — the "<sym>.price" key is dotted
    // and unreachable by jsonpath()/lookupPath which split on ".".
    return { symbol, price, changePct, change, priceFmt: pretty,
             [`${symbol}.price`]: pretty, [`${symbol}.change`]: change };
  }

  private async fetchKlines(symbol: string, interval: string) {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=60`,
    );
    if (!res.ok) throw new Error(`binance ${res.status}`);
    const rows = (await res.json()) as [number, string, string, string, string][];
    return {
      symbol,
      interval,
      o: rows.map((r) => Number(r[1])),
      h: rows.map((r) => Number(r[2])),
      l: rows.map((r) => Number(r[3])),
      c: rows.map((r) => Number(r[4])),
    };
  }

  private static readonly FX_FALLBACK: Record<string, number> = {
    USDTHB: 32.9, USDJPY: 157, EURTHB: 35.5, USDEUR: 0.93,
  };

  private async fetchFx(pair: string) {
    const base = pair.slice(0, 3);
    const quote = pair.slice(3);
    try {
      const res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
      if (res.ok) {
        const j = (await res.json()) as { rates?: Record<string, number> };
        const rate = j.rates?.[quote];
        if (rate) return { pair, rate };
      }
    } catch {
      /* offline → fall through to fallback so the device never sees rate 0 */
    }
    return { pair, rate: FeedsService.FX_FALLBACK[pair] ?? 1 };
  }

  private static readonly CITIES: Record<string, { name: string; lat: number; lon: number }> = {
    bangkok: { name: "Bangkok", lat: 13.7563, lon: 100.5018 },
    "chiang-mai": { name: "Chiang Mai", lat: 18.7883, lon: 98.9853 },
    phuket: { name: "Phuket", lat: 7.8804, lon: 98.3923 },
  };

  private async fetchWeather(citySlug: string) {
    const city = FeedsService.CITIES[citySlug];
    if (!city) throw new Error(`unknown city ${citySlug}`);
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
        `&current=temperature_2m,relative_humidity_2m,weather_code`,
    );
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const j = (await res.json()) as {
      current?: { temperature_2m: number; relative_humidity_2m: number; weather_code: number };
    };
    const cw = j.current;
    if (!cw) throw new Error("no current");
    // air quality (best-effort; PM stays "--" if the AQ endpoint is unavailable)
    let pm25: number | undefined;
    let pm10: number | undefined;
    try {
      const aq = await fetch(
        `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${city.lat}` +
          `&longitude=${city.lon}&current=pm2_5,pm10`,
      );
      if (aq.ok) {
        const aj = (await aq.json()) as { current?: { pm2_5?: number; pm10?: number } };
        pm25 = aj.current?.pm2_5;
        pm10 = aj.current?.pm10;
      }
    } catch {
      /* PM is optional */
    }
    return weatherPayload(city.name, cw.temperature_2m, cw.relative_humidity_2m, cw.weather_code, pm25, pm10);
  }
}

/**
 * Canonical weather payload shared by the server feeder and the Builder
 * simulator so the Weather page behaves identically on device and in preview.
 * `theme` is what the page wasm switches background + animation on.
 */
export function weatherPayload(
  city: string, tempC: number, humidity: number, code: number, pm25?: number, pm10?: number,
) {
  const [desc, theme] = wmoToDescTheme(code);
  return {
    city,
    temp: `${Math.round(tempC)}°C`,
    temp_c: tempC,
    humidity: `${Math.round(humidity)}%`,
    humidity_pct: Math.round(humidity),
    code,
    desc,
    theme, // clear | partly | cloudy | rain | thunder | snow | fog
    icon: theme, // asset id of the matching weather GIF (bound to the gif widget's src)
    bg: THEME_BG[theme] ?? "#27384B", // full-screen background color for the theme
    pm25: pm25 != null ? `${Math.round(pm25)}` : "--", // µg/m³ (unit shown in label)
    pm10: pm10 != null ? `${Math.round(pm10)}` : "--",
  };
}

/** Themed background colors (dark enough for white text + the GIF to pop). */
const THEME_BG: Record<string, string> = {
  clear: "#2B6FB0",
  partly: "#3C6E9E",
  cloudy: "#49566A",
  rain: "#27384B",
  thunder: "#1C1736",
  snow: "#5A7390",
  fog: "#5B636E",
};

/** WMO weather code → (label, animation theme). */
export function wmoToDescTheme(code: number): [string, string] {
  if (code <= 1) return [code === 0 ? "Clear sky" : "Mainly clear", "clear"];
  if (code === 2) return ["Partly cloudy", "partly"];
  if (code === 3) return ["Overcast", "cloudy"];
  if (code >= 45 && code <= 48) return ["Fog", "fog"];
  if (code >= 51 && code <= 57) return ["Drizzle", "rain"];
  if (code >= 61 && code <= 67) return ["Rain", "rain"];
  if (code >= 71 && code <= 77) return ["Snow", "snow"];
  if (code >= 80 && code <= 82) return ["Rain showers", "rain"];
  if (code >= 85 && code <= 86) return ["Snow showers", "snow"];
  if (code >= 95) return ["Thunderstorm", "thunder"];
  return ["—", "cloudy"];
}
