//! Build script for the addon.
//!
//! 1. `napi_build::setup()` adds the linker flags Node-API addons need (on macOS, undefined
//!    `napi_*` symbols are resolved when the addon is loaded).
//! 2. It computes `GBRAIN_ENGINE_BUILD`, the digest the addon reports as `engineBuild`.
//!
//! How `engineBuild` is computed: SHA-256 over every file under `rust/` that can change the
//! compiled addon, taken in sorted relative-path order, each as `path NUL length NUL bytes`.
//! Left out: `target/` (build output), `bench/` (a separate workspace that never goes into the
//! addon), `smoke/` and `scripts/` (test and build tooling), `deny.toml`, `.gitignore`, and
//! Markdown files. Two checkouts with the same Rust sources, `Cargo.lock` and
//! `rust-toolchain.toml` therefore report the same value, whatever machine builds them.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

const SKIP_DIRS: &[&str] = &["target", "bench", "smoke", "scripts", ".git"];
const SKIP_FILES: &[&str] = &["deny.toml", ".gitignore"];

fn collect(dir: &Path, root: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type()?.is_dir() {
            if dir == root && SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect(&path, root, out)?;
        } else if !SKIP_FILES.contains(&name.as_str()) && !name.ends_with(".md") {
            out.push(path);
        }
    }
    Ok(())
}

fn engine_build(root: &Path) -> io::Result<String> {
    let mut files = Vec::new();
    collect(root, root, &mut files)?;
    let mut relative: Vec<String> = files
        .iter()
        .map(|file| {
            file.strip_prefix(root)
                .unwrap_or(file)
                .to_string_lossy()
                .replace('\\', "/")
        })
        .collect();
    relative.sort();
    let mut hasher = Sha256::new();
    for name in &relative {
        let bytes = fs::read(root.join(name))?;
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update(bytes.len().to_string().as_bytes());
        hasher.update([0]);
        hasher.update(&bytes);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn main() {
    napi_build::setup();
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    // rust/crates/gbrain-napi -> rust/
    let root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("the crate lives in rust/crates/gbrain-napi");
    let digest = engine_build(root).expect("hash the rust/ tree");
    println!("cargo:rustc-env=GBRAIN_ENGINE_BUILD={digest}");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=../../Cargo.toml");
    println!("cargo:rerun-if-changed=../../Cargo.lock");
    println!("cargo:rerun-if-changed=../../rust-toolchain.toml");
    println!("cargo:rerun-if-changed=../../crates");
}
