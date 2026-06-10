# LED Toggle Rust Logic

This is the Rust logic for the Builder template `LED Toggle`.

Layout contract:

- LED widgets: `led_1`, `led_2`
- Button 1 action: `wasm.event`, target `logic`, `event_id=101`
- Button 2 action: `wasm.event`, target `logic`, `event_id=102`
- WASM module config: `id=logic`, `path=wasm/led-toggle.wasm`

Build:

```sh
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
```

If Homebrew Rust is first in `PATH`, use the rustup compiler explicitly:

```sh
RUSTC=$HOME/.rustup/toolchains/1.79.0-aarch64-apple-darwin/bin/rustc \
  $HOME/.rustup/toolchains/1.79.0-aarch64-apple-darwin/bin/cargo build \
  --release --target wasm32-unknown-unknown
```

Copy `target/wasm32-unknown-unknown/release/ccp_led_toggle.wasm` into the page
bundle as `wasm/led-toggle.wasm`.
