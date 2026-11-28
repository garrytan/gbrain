//! Build script for the addon.
//!
//! 1. `napi_build::setup()` adds the linker flags Node-API addons need (on macOS, undefined
//!    `napi_*` symbols are resolved when the addon is loaded).
//! 2. It computes `GBRAIN_ENGINE_BUILD`, the digest the addon reports as `engineBuild`.
//!
//!    How it is computed, and which files and symlinks it covers: `build_digest.rs`.

mod build_digest;

use std::path::{Path, PathBuf};

fn main() {
    napi_build::setup();
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    // rust/crates/gbrain-napi -> rust/
    let root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("the crate lives in rust/crates/gbrain-napi");
    let digest = build_digest::engine_build(root).expect("hash the rust/ tree");
    println!("cargo:rustc-env=GBRAIN_ENGINE_BUILD={digest}");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=build_digest.rs");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../../Cargo.toml");
    println!("cargo:rerun-if-changed=../../Cargo.lock");
    println!("cargo:rerun-if-changed=../../rust-toolchain.toml");
    println!("cargo:rerun-if-changed=../../crates");
}
