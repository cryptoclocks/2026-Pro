#!/usr/bin/env bash
# Build a CryptoClock Pro WASM app:  ./build.sh <src.c> <out.wasm>
set -euo pipefail

WASI_SDK="${WASI_SDK:-$HOME/sdk/wasi-sdk}"
CLANG="$WASI_SDK/bin/clang"
SDK_DIR="$(cd "$(dirname "$0")/../sdk" && pwd)"

if [ ! -x "$CLANG" ]; then
  echo "wasi-sdk not found at $WASI_SDK (set WASI_SDK env var)" >&2
  exit 1
fi

SRC="${1:?usage: build.sh <src.c> <out.wasm>}"
OUT="${2:?usage: build.sh <src.c> <out.wasm>}"

"$CLANG" --target=wasm32 -nostdlib -O2 \
  -I"$SDK_DIR" \
  -Wl,--no-entry \
  -Wl,--allow-undefined \
  -Wl,--export=ccp_on_init \
  -Wl,--export=ccp_on_tick \
  -Wl,--export=ccp_on_event \
  -Wl,--export=ccp_on_data \
  -Wl,--export=ccp_on_destroy \
  -Wl,--export=ccp_malloc \
  -Wl,--export=ccp_free \
  -Wl,--initial-memory=131072 -Wl,--max-memory=1048576 \
  -z stack-size=16384 \
  -o "$OUT" "$SRC"

echo "built $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
