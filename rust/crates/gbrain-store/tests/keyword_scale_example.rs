//! The `keyword_scale` measurement example's `load ... nosync` mode must respect the lock a running
//! brain holds on its record file, as the normal open does (`store_locked`): two writers on one
//! `records.redb` corrupt it, and a brain an owner process holds is exactly where a stray loader
//! run would land. Runs the real example binary against a brain this test holds open.

mod common;

use common::TempDir;
use gbrain_store::{OpenOptions, Store};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Builds the example (`cargo test --test` does not) and returns its path, as cargo reports it.
fn example() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let release = exe
        .ancestors()
        .any(|dir| dir.file_name().is_some_and(|n| n == "release"));
    let mut build = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    build.args([
        "build",
        "-q",
        "-p",
        "gbrain-store",
        "--example",
        "keyword_scale",
        "--message-format=json",
    ]);
    if release {
        build.arg("--release");
    }
    let out = build.output().unwrap();
    assert!(out.status.success(), "building the example");
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter(|message| message["target"]["name"] == "keyword_scale")
        .find_map(|message| message["executable"].as_str().map(PathBuf::from))
        .expect("cargo did not report the example's executable")
}

/// A one-page corpus in the bake-off layout the loader reads.
fn corpus(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("manifest.json"), r#"{"sources":["default"]}"#).unwrap();
    std::fs::write(
        dir.join("pages.jsonl"),
        concat!(
            r#"{"i":0,"slug":"notes/loaded","source_id":"default","type":"note","title":"Loaded","#,
            r#""body":"Loaded by the example.","frontmatter":{}}"#,
            "\n"
        ),
    )
    .unwrap();
    std::fs::write(dir.join("chunks.jsonl"), "").unwrap();
}

fn load(example: &Path, corpus: &Path, brain: &Path) -> Output {
    Command::new(example)
        .args(["load"])
        .arg(corpus)
        .arg(brain)
        .arg("nosync")
        .output()
        .unwrap()
}

#[test]
fn the_nosync_loader_refuses_a_brain_another_handle_holds_and_leaves_it_alone() {
    let dir = TempDir::new("keyword-scale-lock");
    let (corpus_dir, brain) = (dir.path().join("corpus"), dir.path().join("brain"));
    corpus(&corpus_dir);
    let example = example();

    let held = Store::open_dir(&brain, OpenOptions::default()).unwrap();
    // The raw-byte check reads the record file through a second handle. On
    // Windows the holder's byte-range lock refuses that read (and every open
    // of the store rewrites bytes, so closing first is no fix there); the
    // held store's own read below covers Windows.
    #[cfg(not(windows))]
    let before = std::fs::read(brain.join("records.redb")).unwrap();
    let refused = load(&example, &corpus_dir, &brain);
    assert!(
        !refused.status.success(),
        "the loader must not open a brain another handle holds; stdout: {}",
        String::from_utf8_lossy(&refused.stdout)
    );
    assert!(
        held.read_page_snapshot("notes/loaded", &Default::default())
            .unwrap()
            .is_none(),
        "the refused loader wrote a page"
    );
    #[cfg(not(windows))]
    assert_eq!(
        std::fs::read(brain.join("records.redb")).unwrap(),
        before,
        "the refused loader changed the record file"
    );

    // Once the holder lets go, the same run loads.
    drop(held);
    let loaded = load(&example, &corpus_dir, &brain);
    assert!(
        loaded.status.success(),
        "{}",
        String::from_utf8_lossy(&loaded.stderr)
    );
    let reopened = Store::open_dir(&brain, OpenOptions::default()).unwrap();
    assert!(
        reopened
            .read_page_snapshot("notes/loaded", &Default::default())
            .unwrap()
            .is_some()
    );
}
