//! `engineBuild` (`build_digest.rs`, run by `build.rs`): the digest of a fixed tree is pinned, a
//! root build directory that is a symlink is left out by name, and a directory symlink anywhere
//! else under `rust/` is refused.

#[path = "../build_digest.rs"]
mod build_digest;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use build_digest::engine_build;

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A fresh empty directory under cargo's test scratch space.
fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "engine-build-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(root: &Path, relative: &str, bytes: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

/// A small `rust/` tree with every kind of entry the digest covers or leaves out, as real
/// directories and files.
fn fixture(name: &str) -> PathBuf {
    let root = scratch(name);
    write(
        &root,
        "Cargo.toml",
        "[workspace]\nmembers = [\"crates/a\"]\n",
    );
    write(&root, "Cargo.lock", "version = 4\n");
    write(&root, "rust-toolchain.toml", "[toolchain]\n");
    write(&root, "crates/a/Cargo.toml", "[package]\nname = \"a\"\n");
    write(&root, "crates/a/src/lib.rs", "pub fn a() {}\n");
    write(&root, "crates/a/src/nested/mod.rs", "// nested\n");
    // Left out: Markdown, deny.toml and .gitignore at any depth, and the root build directories.
    write(&root, "crates/a/README.md", "# a\n");
    write(&root, "deny.toml", "[bans]\n");
    write(&root, "crates/a/.gitignore", "*.tmp\n");
    write(&root, "target/debug/out.bin", "build output");
    write(&root, "bench/Cargo.toml", "[package]\n");
    write(&root, "smoke/run.sh", "#!/bin/sh\n");
    write(&root, "scripts/build.sh", "#!/bin/sh\n");
    // Not at the root, so not left out: a crate directory that happens to be named `target`.
    write(&root, "crates/a/target/keep.rs", "// kept\n");
    root
}

/// The value the code before this change (rust-engine/main 9063ea55b5, `build.rs`'s own
/// `engine_build`) computes for `fixture`: the digest of a normal checkout does not move.
const FIXTURE_DIGEST: &str = "cc47de027a7d90b5ba313d1d123425cdc2f5c64aa42de961b3bef6f3df2be089";

#[test]
fn a_plain_tree_keeps_the_digest_it_had_before() {
    let root = fixture("plain");
    assert_eq!(engine_build(&root).unwrap(), FIXTURE_DIGEST);
}

#[cfg(unix)]
mod symlinks {
    use super::*;
    use std::os::unix::fs::symlink;

    /// `fixture` with each root build directory moved elsewhere and replaced by a symlink to it.
    fn linked_fixture(name: &str) -> PathBuf {
        let root = fixture(name);
        let away = scratch(&format!("{name}-away"));
        for dir in ["target", "bench", "smoke", "scripts"] {
            fs::rename(root.join(dir), away.join(dir)).unwrap();
            symlink(away.join(dir), root.join(dir)).unwrap();
        }
        root
    }

    #[test]
    fn a_symlinked_root_build_directory_is_left_out_by_name() {
        let root = linked_fixture("linked");
        assert_eq!(engine_build(&root).unwrap(), FIXTURE_DIGEST);
        // A dangling one too: it is skipped by its name, never opened.
        fs::remove_file(root.join("target")).unwrap();
        symlink(root.join("no-such-dir"), root.join("target")).unwrap();
        assert_eq!(engine_build(&root).unwrap(), FIXTURE_DIGEST);
    }

    #[test]
    fn a_symlink_to_a_file_is_hashed_as_the_file_it_names() {
        let root = fixture("file-link");
        write(&root, "crates/a/src/copy.rs", "pub fn a() {}\n");
        let copied = engine_build(&root).unwrap();
        fs::remove_file(root.join("crates/a/src/copy.rs")).unwrap();
        symlink(
            root.join("crates/a/src/lib.rs"),
            root.join("crates/a/src/copy.rs"),
        )
        .unwrap();
        assert_eq!(engine_build(&root).unwrap(), copied);
    }

    #[test]
    fn a_directory_symlink_below_the_root_is_refused_with_its_path() {
        let root = fixture("dir-link");
        let elsewhere = scratch("dir-link-elsewhere");
        write(&elsewhere, "lib.rs", "pub fn b() {}\n");
        symlink(&elsewhere, root.join("crates/b")).unwrap();
        let err = engine_build(&root).unwrap_err().to_string();
        assert!(
            err.contains("symlink to a directory") && err.contains("crates/b"),
            "{err}"
        );
    }
}
