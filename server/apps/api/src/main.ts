import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module";
import { DevicesService } from "./devices/devices.service";

async function bootstrap() {
  // rawBody is required for Stripe webhook signature verification
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // publish-compiled carries base64 wasm + page assets (gifs/png) — allow up to 24MB
  app.use(json({ limit: "24mb" }));
  app.use(urlencoded({ limit: "24mb", extended: true }));
  // Allow the admin web, the static web-user app (any port), and LAN origins
  // (phones). No-origin requests (curl, the device, native apps) pass too. This
  // is a self-hosted LAN tool and sensitive endpoints still require a Bearer token.
  const allowList = (process.env.WEB_ORIGIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowList.includes(origin)) return cb(null, true);
      if (/^https?:\/\/(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)[^/]*$/.test(origin)) return cb(null, true);
      return cb(null, false);
    },
  });
  app.setGlobalPrefix("api/v1");
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`CryptoClock Pro Hub API on :${port}`);

  // Idempotent: ensure every device with a legacy settings cache has been
  // split into DeviceConfigHead + DevicePageSettings rows. Runs once per
  // boot. (schema.md §10 — backfill step)
  try {
    const devices = app.get(DevicesService);
    const r = await devices.backfillConfig();
    console.log(`backfillConfig on boot: ${JSON.stringify(r)}`);
  } catch (e) {
    console.error("backfillConfig on boot failed:", e);
  }
}
bootstrap();
