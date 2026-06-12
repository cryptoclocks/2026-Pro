import { NestFactory } from "@nestjs/core";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module";

async function bootstrap() {
  // rawBody is required for Stripe webhook signature verification
  const app = await NestFactory.create(AppModule, { rawBody: true });
  // publish-compiled carries base64 wasm + page assets (gifs/png) — allow up to 24MB
  app.use(json({ limit: "24mb" }));
  app.use(urlencoded({ limit: "24mb", extended: true }));
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" });
  app.setGlobalPrefix("api/v1");
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  console.log(`CryptoClock Pro Hub API on :${port}`);
}
bootstrap();
