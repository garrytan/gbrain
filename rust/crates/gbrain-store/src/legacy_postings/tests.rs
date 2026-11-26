//! The store format 14 upgrade deletes the legacy word postings in its one write transaction: a
//! failed upgrade leaves the old brain byte for byte, the next open upgrades it, keyword search
//! answers as before, and a build that stops at format 8 refuses the upgraded brain.

use super::*;
use crate::kv::Kv;
use crate::kv::scan_prefix;
use crate::pages::{PageInput, PutPageOptions};
use crate::search::SearchOptions;
use crate::{OpenOptions, Store, SystemEnv};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;

const QUERIES: &[&str] = &[
    "widget",
    "launch plan",
    "pricing",
    "acme widget launch",
    "nothing-matches-this",
    "roadmap OR hiring",
    "\"launch plan\"",
];

fn env() -> Arc<dyn crate::env::Env> {
    Arc::new(SystemEnv)
}

/// Every record of a store, key and value.
fn dump(kv: &dyn Kv) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = Vec::new();
    kv.snapshot()
        .unwrap()
        .scan(&[], &[0xFF; 64], false, &mut |k, v| {
            out.push((k.to_vec(), v.to_vec()));
            true
        })
        .unwrap();
    out
}

fn legacy_count(kv: &dyn Kv) -> usize {
    let mut n = 0;
    scan_prefix(
        &*kv.snapshot().unwrap(),
        &[keys::POSTING],
        false,
        &mut |_, _| {
            n += 1;
            true
        },
    )
    .unwrap();
    n
}

/// What keyword search answers, for comparing two opens of a brain.
fn answers(store: &Store) -> Vec<Value> {
    let mut out = Vec::new();
    for q in QUERIES {
        for opts in [
            json!({}),
            json!({"type": "note"}),
            json!({"limit": 2.0, "offset": 1.0}),
        ] {
            let opts: SearchOptions = serde_json::from_value(opts).unwrap();
            out.push(json!(store.search_keyword(q, &opts).unwrap()));
        }
    }
    out
}

/// A brain as a format-`version` build left it: pages and chunks, one legacy word posting per
/// distinct word of each chunk (what that build's chunk writes kept), the format record at
/// `version`. Returns the record store, how many postings it holds and what search answered.
fn old_brain(version: u32) -> (Arc<dyn Kv>, usize, Vec<Value>) {
    let kv = crate::test_support::mem_kv();
    let store = Store::open_kv(kv.clone(), env(), OpenOptions::default()).unwrap();
    let bodies = [
        ("notes/a", "note", "Acme widget launch plan for the spring."),
        (
            "notes/b",
            "note",
            "Pricing review: the widget costs too much.",
        ),
        ("people/c", "person", "Works on the roadmap and on hiring."),
        (
            "notes/d",
            "note",
            "Launch plan, second draft, with pricing.",
        ),
        ("notes/e", "note", "Nothing about any of that here."),
    ];
    for (slug, kind, body) in bodies {
        let input: PageInput =
            serde_json::from_value(json!({"type": kind, "title": slug, "compiled_truth": body}))
                .unwrap();
        let options: PutPageOptions = serde_json::from_value(json!({})).unwrap();
        store.put_page(slug, &input, &options).unwrap();
    }
    let said = answers(&store);
    let chunks: Vec<crate::chunks::ChunkRecord> = {
        let read = store.read().unwrap();
        let mut out = Vec::new();
        scan_prefix(&*read, &[keys::CHUNK], false, &mut |_, v| {
            out.push(serde_json::from_slice(v).unwrap());
            true
        })
        .unwrap();
        out
    };
    assert!(!chunks.is_empty());
    let mut postings = 0;
    store
        .write(|tx| {
            postings = 0;
            for chunk in &chunks {
                let mut counts: BTreeMap<String, u32> = BTreeMap::new();
                for term in crate::chunks::tokenize(&chunk.chunk_text) {
                    *counts.entry(term).or_insert(0) += 1;
                }
                for (term, count) in counts {
                    tx.put(
                        &keys::posting(&term, chunk.page_id, chunk.chunk_index),
                        &count.to_be_bytes(),
                    )?;
                    postings += 1;
                }
            }
            let mut stored: crate::StoredFormat =
                crate::get_json(&*tx, &keys::meta("format"))?.unwrap();
            stored.format_version = version;
            crate::put_json(tx, &keys::meta("format"), &stored)
        })
        .unwrap();
    drop(store);
    assert_eq!(legacy_count(&*kv), postings);
    (kv, postings, said)
}

#[test]
fn a_format_8_brain_loses_its_legacy_postings_and_answers_as_before() {
    for version in [7, 8] {
        let (kv, postings, said) = old_brain(version);
        assert!(postings > 0);
        let store = Store::open_kv(kv.clone(), env(), OpenOptions::default()).unwrap();
        assert_eq!(store.info().format_version, crate::FORMAT_VERSION);
        assert_eq!(legacy_count(&*kv), 0, "format {version}: postings left");
        assert_eq!(answers(&store), said, "format {version}");
    }
}

/// The upgrade fails at its last write (the format record) or at its commit: the open reports
/// the failure, the brain is left exactly as the format-8 build left it (every record byte for
/// byte, every legacy posting), and the next open upgrades it and search answers as before.
fn upgrade_fails_then_succeeds(op: crate::test_support::FaultOp) {
    use crate::test_support::{FaultOp, FaultyKv};
    let (inner, postings, said) = old_brain(8);
    let before = dump(&*inner);
    let faulty: Arc<dyn Kv> = Arc::new(FaultyKv {
        inner: inner.clone(),
        code: crate::error::STORE_IO,
        ops: match op {
            FaultOp::Commit => &[FaultOp::Commit],
            _ => &[FaultOp::Put],
        },
        fail_on: |key| key == keys::meta("format").as_slice(),
    });
    let err = Store::open_kv(faulty, env(), OpenOptions::default())
        .err()
        .expect("the open must fail");
    assert_eq!(err.code, crate::error::STORE_IO, "{}", err.message);
    assert_eq!(
        legacy_count(&*inner),
        postings,
        "the failed upgrade deleted legacy postings"
    );
    assert!(
        dump(&*inner) == before,
        "the failed upgrade changed records"
    );
    let store = Store::open_kv(inner.clone(), env(), OpenOptions::default()).unwrap();
    assert_eq!(store.info().format_version, crate::FORMAT_VERSION);
    assert_eq!(legacy_count(&*inner), 0);
    assert_eq!(answers(&store), said);
}

#[test]
fn an_upgrade_that_fails_at_its_last_write_leaves_the_format_8_brain_and_runs_again() {
    upgrade_fails_then_succeeds(crate::test_support::FaultOp::Put);
}

#[test]
fn an_upgrade_that_fails_at_its_commit_leaves_the_format_8_brain_and_runs_again() {
    upgrade_fails_then_succeeds(crate::test_support::FaultOp::Commit);
}

/// A build that opens formats 1 to 8 only refuses a brain this build upgraded, before it writes
/// anything (it would write legacy postings again).
#[test]
fn a_format_8_build_refuses_a_brain_at_this_build_s_format() {
    let (kv, _, _) = old_brain(8);
    drop(Store::open_kv(kv.clone(), env(), OpenOptions::default()).unwrap());
    let before = dump(&*kv);
    let format_8_build: Vec<u32> = (1..=8).collect();
    let err = Store::open_kv_in(kv.clone(), env(), OpenOptions::default(), &format_8_build)
        .err()
        .expect("a format-8 build must refuse the upgraded brain");
    assert_eq!(err.code, crate::error::FORMAT_UNKNOWN, "{}", err.message);
    assert!(
        err.message
            .contains(&format!("store format {}", crate::FORMAT_VERSION)),
        "{}",
        err.message
    );
    assert!(dump(&*kv) == before, "the refused open changed records");
}

/// A new brain writes no legacy posting, whatever it holds.
#[test]
fn chunk_writes_keep_no_legacy_postings() {
    let kv = crate::test_support::mem_kv();
    let store = Store::open_kv(kv.clone(), env(), OpenOptions::default()).unwrap();
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": "t", "compiled_truth": "widgets and launch plans"}),
    )
    .unwrap();
    store
        .put_page(
            "notes/x",
            &input,
            &serde_json::from_value(json!({})).unwrap(),
        )
        .unwrap();
    assert!(
        !store
            .search_keyword("widgets", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(legacy_count(&*kv), 0);
}

/// The addon's `searchKeyword` is the keyword arm with the query as both match and rank query.
#[test]
fn search_keyword_answers_as_the_keyword_arm() {
    let (kv, _, _) = old_brain(8);
    let store = Store::open_kv(kv, env(), OpenOptions::default()).unwrap();
    for q in QUERIES {
        for opts in [
            json!({}),
            json!({"type": "note"}),
            json!({"limit": 1.0}),
            json!({"hardExcludes": ["people/"]}),
            json!({"sources": ["default"]}),
        ] {
            let opts: SearchOptions = serde_json::from_value(opts).unwrap();
            assert_eq!(
                json!(store.search_keyword(q, &opts).unwrap()),
                json!(store.search_keyword_arm(q, q, &opts).unwrap()),
                "{q}"
            );
        }
    }
}

/// A brain directory opened with concurrent writes (the addon's mode) upgrades on the record file
/// before the concurrent layer wraps it, and answers as before.
#[test]
fn a_concurrent_open_of_a_format_8_directory_upgrades_it() {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/test-tmp")
        .join(format!("legacy-postings-occ-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let options = OpenOptions {
        concurrent_writes: true,
        keyword_index_builder: false,
        ..OpenOptions::default()
    };
    let (postings, said) = {
        let store = Store::open_dir(&dir, options.clone()).unwrap();
        let input: PageInput = serde_json::from_value(
            json!({"type": "note", "title": "a", "compiled_truth": "Acme widget launch plan."}),
        )
        .unwrap();
        store
            .put_page(
                "notes/a",
                &input,
                &serde_json::from_value(json!({})).unwrap(),
            )
            .unwrap();
        let said = answers(&store);
        let mut postings = 0;
        store
            .write(|tx| {
                postings = 0;
                for (i, term) in ["acme", "widget", "launch", "plan"].iter().enumerate() {
                    tx.put(&keys::posting(term, 1, i as u32), &1u32.to_be_bytes())?;
                    postings += 1;
                }
                let mut stored: crate::StoredFormat =
                    crate::get_json(&*tx, &keys::meta("format"))?.unwrap();
                stored.format_version = 8;
                crate::put_json(tx, &keys::meta("format"), &stored)
            })
            .unwrap();
        (postings, said)
    };
    let mut on_disk = crate::format::read(&dir).unwrap().unwrap();
    on_disk.format_version = 8;
    crate::format::write(&dir, &on_disk).unwrap();
    assert!(postings > 0);
    let store = Store::open_dir(&dir, options).unwrap();
    assert_eq!(store.info().format_version, crate::FORMAT_VERSION);
    let mut left = 0;
    scan_prefix(
        &*store.read().unwrap(),
        &[keys::POSTING],
        false,
        &mut |_, _| {
            left += 1;
            true
        },
    )
    .unwrap();
    assert_eq!(left, 0);
    assert_eq!(answers(&store), said);
    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The next format's upgrade (a build one format past this one) does not run the legacy delete
/// again: a record under the legacy tag in a brain at this build's format survives it.
#[test]
fn a_later_format_s_upgrade_does_not_run_the_legacy_delete_again() {
    assert_eq!(DROPPED_AT_FORMAT, crate::FORMAT_VERSION);
    let kv = crate::test_support::mem_kv();
    let store = Store::open_kv(kv.clone(), env(), OpenOptions::default()).unwrap();
    let mut key = vec![keys::POSTING];
    key.extend_from_slice(b"marker\0\0\0\0\0\0\0\0\x01\0\0\0\0");
    store.write(|w| w.put(&key, b"kept")).unwrap();
    drop(store);
    assert_eq!(legacy_count(&*kv), 1);
    let stored = crate::upgrade_format_to(&*kv, crate::FORMAT_VERSION + 1).unwrap();
    assert_eq!(stored.format_version, crate::FORMAT_VERSION + 1);
    assert_eq!(
        legacy_count(&*kv),
        1,
        "the next format's upgrade ran the legacy delete again"
    );
}
