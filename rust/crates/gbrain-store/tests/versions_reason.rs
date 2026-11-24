//! `createVersion` with an import history (`CreateVersionOptions`): the snapshot keeps the reason
//! as `change_reason`, unless a purge tombstoned its (commit, path) (`stampableReason`); a history
//! gap stamps the page. `getVersions` reads each reason as `replaced_because`.

mod common;

use common::TempDir;
use gbrain_store::pages::{
    CreateVersionOptions, PageInput, PutPageOptions, ReasonSource, VersionsOptions,
};
use gbrain_store::reason_tombstones::ReasonTombstone;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{OpenOptions, Store, SystemEnv};
use serde_json::{Value, json};
use std::sync::Arc;

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let kv = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
    let store = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    (dir, store)
}

fn write(store: &Store, title: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": title, "compiled_truth": format!("{title}."), "frontmatter": frontmatter,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({"index": false})).unwrap();
    store.put_page("notes/why", &input, &options).unwrap();
}

fn version(store: &Store, reason: Option<&str>, commit: Option<&str>, gap: bool) -> Value {
    let options = CreateVersionOptions {
        reason: reason.map(str::to_string),
        reason_source: commit.map(|c| ReasonSource {
            commit: c.repeat(40),
            path: "notes/why.md".into(),
        }),
        history_gap: Some(gap),
        ..CreateVersionOptions::default()
    };
    store.create_version_opts("notes/why", &options).unwrap()
}

fn reasons(store: &Store) -> Vec<(String, Value)> {
    let options = VersionsOptions::default();
    store
        .get_versions("notes/why", &options)
        .unwrap()
        .into_iter()
        .map(|v| {
            (
                v["title"].as_str().unwrap().to_string(),
                v["replaced_because"].clone(),
            )
        })
        .collect()
}

#[test]
fn a_version_keeps_its_reason_unless_a_purge_tombstoned_the_source() {
    let (_dir, store) = brain("versions-reason");
    store
        .write_reason_purge_tombstones(
            "default",
            &[ReasonTombstone {
                commit_sha: "b".repeat(40),
                path: "notes/why.md".into(),
            }],
        )
        .unwrap();
    write(&store, "First", json!({}));
    let first = version(&store, Some("Add the note"), Some("a"), false);
    write(&store, "Second", json!({"readable_by": ["bob-example"]}));
    let purged = version(&store, Some("Name a deal"), Some("b"), false);
    write(&store, "Third", json!({}));
    let third = version(&store, Some(""), None, true);
    assert_eq!(first["change_reason"], json!("Add the note"));
    assert_eq!(purged["change_reason"], Value::Null);
    assert_eq!(third["change_reason"], json!(""));
    assert_eq!(
        reasons(&store),
        vec![
            ("Third".to_string(), json!("")),
            ("Second".to_string(), Value::Null),
            ("First".to_string(), json!("Add the note")),
        ]
    );
}

#[test]
fn a_reason_with_a_nul_byte_is_refused() {
    let (_dir, store) = brain("versions-reason-nul");
    write(&store, "First", json!({}));
    let options = CreateVersionOptions {
        reason: Some("bad\0reason".into()),
        ..CreateVersionOptions::default()
    };
    let err = store
        .create_version_opts("notes/why", &options)
        .unwrap_err();
    assert!(err.to_string().contains("NUL"), "{err}");
}
