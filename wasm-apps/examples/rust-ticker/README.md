# Rust WASM Logic Example

Build:

```sh
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/ccp_rust_ticker.wasm ../../dist/rust-ticker.wasm
```

Use it in Builder:

- Add a label with id `price`.
- Add data source `crypto` with stream `market.BTCUSDT.ticker`.
- Add WASM module `logic` with path `wasm/rust-ticker.wasm`, tick `1000`, memory `256`.

The module subscribes to `market.BTCUSDT.ticker`, updates the `price` label on
data, and writes a simple tick counter once per second.
