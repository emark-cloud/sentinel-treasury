//! Odra's contracts build script. Reads the `ODRA_MODULE` env var (set per-contract by
//! `cargo odra build`) and emits the matching `odra_module` cfg, so each contract compiles to
//! its own WASM with only its entry points. Without this, every contract builds identically.

pub fn main() {
    odra_build::build();
}
