# CryptoClock Pro Hub API — container image.
# Build context is the server/ workspace root (see docker-compose.prod.yml).
# Two stages: a build stage that installs + compiles the NestJS app, and a
# runtime stage that also carries a Rust toolchain because the API compiles
# page-logic Rust to wasm32 on demand (payloads.service.ts).
# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:20-bookworm AS build
RUN corepack enable
WORKDIR /app
# Copy the whole workspace (node_modules/dist/.next are excluded via
# .dockerignore). The lockfile is frozen so the install is reproducible.
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @ccp/shared build \
 && pnpm --filter @ccp/api exec prisma generate \
 && pnpm --filter @ccp/api build

# ---------- runtime ----------
FROM node:20-bookworm AS runtime
# Rust toolchain (pinned to 1.79.0) + the wasm target. cc/gcc is needed for
# crates with build scripts. curl is only used to fetch rustup, then removed.
ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    PATH=/opt/cargo/bin:$PATH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gcc \
 && curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain 1.79.0 \
 && rustup target add wasm32-unknown-unknown \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY --from=build /app .
ENV NODE_ENV=production \
    PORT=4000 \
    PAYLOAD_STORAGE_DIR=/data/payloads \
    CCP_RUST_CARGO=/opt/cargo/bin/cargo \
    CCP_RUSTC=/opt/cargo/bin/rustc
EXPOSE 4000
# Apply any pending migrations, then start. migrate deploy uses DIRECT_URL.
CMD ["sh", "-c", "pnpm --filter @ccp/api exec prisma migrate deploy && node apps/api/dist/main.js"]
