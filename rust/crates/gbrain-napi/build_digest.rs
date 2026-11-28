//! `engineBuild`: the digest the addon reports, computed by `build.rs` over the `rust/` tree.
//!
//! SHA-256 over every file under `rust/` that can change the compiled addon, taken in sorted
//! relative-path order, each as `path NUL length NUL bytes`. Left out: `target/` (build output),
//! `bench/` (a separate workspace that never goes into the addon), `smoke/` and `scripts/` (test
//! and build tooling), `.git`, `deny.toml`, `.gitignore`, and Markdown files. Two checkouts with
//! the same Rust sources, `Cargo.lock` and `rust-toolchain.toml` therefore report the same value,
//! whatever machine builds them.
//!
//! Symlinks: a root entry named in `SKIP_DIRS` is skipped by its name whatever it is, so a
//! `target` (or `bench`, ...) that is a symlink to a build directory elsewhere is left out like a
//! real one. A symlink to a file is followed and its target's bytes are hashed under the link's
//! path. A symlink to a directory anywhere else is refused with an error naming it: following it
//! could hash a tree twice or loop, and skipping it would leave sources the addon compiles out of
//! the digest.
//!
//! This file is a module of `build.rs` and of `tests/engine_build_digest.rs`, so it uses only
//! `std` and `sha2`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Root entries left out by name.
pub const SKIP_DIRS: &[&str] = &["target", "bench", "smoke", "scripts", ".git"];
/// File names left out at any depth.
pub const SKIP_FILES: &[&str] = &["deny.toml", ".gitignore"];

fn collect(dir: &Path, root: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if dir == root && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            collect(&path, root, out)?;
        } else if kind.is_symlink() && fs::metadata(&path)?.is_dir() {
            return Err(io::Error::other(format!(
                "engineBuild: {} is a symlink to a directory; only a root entry named in SKIP_DIRS \
                 ({}) may be one",
                path.display(),
                SKIP_DIRS.join(", ")
            )));
        } else if !SKIP_FILES.contains(&name.as_str()) && !name.ends_with(".md") {
            out.push(path);
        }
    }
    Ok(())
}

/// The `engineBuild` digest of the tree at `root` (the `rust/` directory), as lowercase hex.
pub fn engine_build(root: &Path) -> io::Result<String> {
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
