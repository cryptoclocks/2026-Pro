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

      for (const stream of streams) {
        const payload = await this.fetchStream(stream);
        if (payload === null) continue; // not due yet or unknown pattern
        this.cache.set(stream, payload);
        for (const [deviceId, list] of targets) {
          if (list.includes(stream)) this.mqtt.publishData(deviceId, stream, payload);
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
    return { symbol, price, changePct, change, [`${symbol}.price`]: pretty, [`${symbol}.change`]: change };
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

  private async fetchFx(pair: string) {
    const base = pair.slice(0, 3);
    const quote = pair.slice(3);
    const res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
    if (!res.ok) throw new Error(`er-api ${res.status}`);
    const j = (await res.json()) as { rates?: Record<string, number> };
    const rate = j.rates?.[quote];
    if (!rate) throw new Error(`no rate ${pair}`);
    return { pair, rate };
  }

  private static readonly CITIES: Record<string, { name: string; lat: number; lon: number }> = {
    bangkok: { name: "Bangkok", lat: 13.7563, lon: 100.5018 },
    "chiang-mai": { name: "Chiang Mai", lat: 18.7883, lon: 98.9853 },
    phuket: { name: "Phuket", lat: 7.8804, lon: 98.3923 },
  };

  private static readonly WMO: [number, string][] = [
    [0, "Clear sky"], [1, "Mainly clear"], [2, "Partly cloudy"], [3, "Overcast"],
    [45, "Fog"], [51, "Light drizzle"], [61, "Light rain"], [63, "Rain"],
    [65, "Heavy rain"], [80, "Rain showers"], [95, "Thunderstorm"],
  ];

  private async fetchWeather(citySlug: string) {
    const city = FeedsService.CITIES[citySlug];
    if (!city) throw new Error(`unknown city ${citySlug}`);
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current_weather=true`,
    );
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const j = (await res.json()) as { current_weather?: { temperature: number; weathercode: number } };
    const cw = j.current_weather;
    if (!cw) throw new Error("no current_weather");
    let desc = "—";
    for (const [code, label] of FeedsService.WMO) if (cw.weathercode >= code) desc = label;
    return {
      city: city.name,
      temp: `${Math.round(cw.temperature)}°C`,
      temp_c: cw.temperature,
      desc,
    };
  }
}
