//! The owner allow rules came in at store format 8 without a format bump (`t 0x0f`, `t 0x10`,
//! rust/docs/store/format.md). These tests show that every scan that walks the whole store, a
//! whole tag or a neighbouring trust kind reads a brain that holds rules without a corruption
//! error: the integrity check of a copy (with and without its manifest), the keyword index check,
//! the snapshot copy, the read-only open, the keyspace catalog, the shadow follow's digest reads,
//! and the trust family's own neighbouring reads.

mod common;

use common::TempDir;
use gbrain_store::keys;
use gbrain_store::kv::{Kv, collect_prefix};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::seed::{DigestInput, SeedRow};
use gbrain_store::snapshot::SnapshotOp;
use gbrain_store::sources::SourceInput;
use gbrain_store::trust::allow_rules::NewAllowRule;
use gbrain_store::trust::proposals::ProposalFilter;
use gbrain_store::verify::{Verdict, verify_store_dir};
use gbrain_store::{OpenOptions, Store, keyspaces};

fn plain() -> OpenOptions {
    OpenOptions {
        keyword_index_builder: false,
        ..OpenOptions::default()
    }
}

fn rule(source: &str, prefix: &str) -> NewAllowRule {
    NewAllowRule {
        source_id: source.into(),
        uri_prefix: Some(prefix.into()),
        reason_family: Some("standing_instruction".into()),
        created_by: "local_cli:owner".into(),
        reason: None,
    }
}

/// A brain with pages, a complete keyword index, one active rule and one removed rule.
fn brain_with_rules(dir: &TempDir) -> Store {
    let store = Store::open_dir(&dir.path().join("brain"), plain()).unwrap();
    for n in 0..12 {
        let page: PageInput = serde_json::from_value(serde_json::json!({
            "type": "note", "title": format!("Page {n}"), "compiled_truth": format!("page {n} apple pear"),
        }))
        .unwrap();
        store
            .put_page(&format!("notes/p{n}"), &page, &PutPageOptions::default())
            .unwrap();
    }
    store
        .upsert_source(&SourceInput {
            id: "work".into(),
            name: Some("work".into()),
            local_path: None,
            last_sync_at: None,
            config: None,
        })
        .unwrap();
    store
        .add_trust_allow_rule(&rule("default", "https://feeds.example.com/"))
        .unwrap();
    let removed = store
        .add_trust_allow_rule(&rule("work", "https://other.example.com/"))
        .unwrap();
    let id = removed["row"]["id"].as_u64().unwrap();
    store
        .remove_trust_allow_rule(id, "local_cli:owner")
        .unwrap();
    store.keyword_index_rebuild().unwrap();
    while !store
        .keyword_index_build_step(64)
        .unwrap()
        .is_some_and(|s| s.complete)
    {}
    store
}

#[test]
fn the_integrity_check_the_index_check_and_a_snapshot_read_a_brain_with_rules() {
    let dir = TempDir::new("allow-rules-verify");
    let store = brain_with_rules(&dir);
    let index = store.keyword_index_verify(None).unwrap();
    assert!(index.ok, "{index:?}");

    let copy = dir.path().join("copy");
    let manifest = store.snapshot_to(&copy, &SnapshotOp::new()).unwrap();
    for expected in [Some(&manifest), None] {
        let report = verify_store_dir(&copy, expected).unwrap();
        assert_eq!(report.verdict, Verdict::Ok, "{report:?}");
        assert_eq!(report.integrity, None);
        assert!(report.mismatches.is_empty(), "{:?}", report.mismatches);
        assert!(report.keyword_index.as_ref().unwrap().ok);
    }
    drop(store);
    let kv = RedbKv::open_path(&copy.join("records.redb")).unwrap();
    let rule_keys =
        collect_prefix(&*kv.snapshot().unwrap(), &[keys::TRUST, 0x0f], false, 100).unwrap();
    assert_eq!(rule_keys.len(), 2, "both rules are stored under t 0x0f");
    drop(kv);

    let restored = Store::open_dir_read_only(&copy).unwrap();
    let rules = restored.list_trust_allow_rules(None, true).unwrap();
    assert_eq!(rules.len(), 2);
    assert!(
        rules[1]["removed_at"].is_string(),
        "the removed rule keeps its receipt"
    );
}

#[test]
fn the_keyspace_catalog_and_the_neighbouring_trust_reads_are_unchanged_by_rules() {
    let dir = TempDir::new("allow-rules-neighbours");
    let store = brain_with_rules(&dir);
    let catalog = keyspaces::keyspace_catalog();
    let trust: Vec<_> = catalog
        .keyspaces
        .iter()
        .filter(|k| k.tag == keys::TRUST)
        .collect();
    assert_eq!(trust.len(), 1, "the rules ride inside the trust tag");
    // The kinds beside `t 0x0f` and `t 0x10` (proposals at 0x06, label guards at 0x0e) still read.
    assert!(
        store
            .list_trust_proposals(&ProposalFilter::default())
            .unwrap()
            .is_empty()
    );
    let page: PageInput = serde_json::from_value(serde_json::json!({
        "type": "note", "title": "Guarded", "compiled_truth": "guarded page",
    }))
    .unwrap();
    let id = store
        .put_page("notes/guarded", &page, &PutPageOptions::default())
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    assert_eq!(store.read_page_label_guard(id).unwrap(), None);
}

#[test]
fn the_shadow_follow_reads_a_seeded_brain_with_rules() {
    let dir = TempDir::new("allow-rules-follow");
    let store = Store::open_dir(&dir.path().join("brain"), plain()).unwrap();
    let row = |id: &str, removed: Option<&str>| -> SeedRow {
        [
            ("id", Some(id)),
            ("source_id", Some("default")),
            ("uri_prefix", Some("https://feeds.example.com/")),
            ("reason_family", None),
            ("created_by", Some("local_cli:owner")),
            ("created_at", Some("2026-11-20 10:00:00+00")),
            ("removed_at", removed),
            ("removed_by", removed.map(|_| "local_cli:owner")),
            ("reason", None),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.map(str::to_owned)))
        .collect()
    };
    let digests = [
        DigestInput {
            sort: "01".into(),
            digest: "aa".repeat(32),
        },
        DigestInput {
            sort: "02".into(),
            digest: "bb".repeat(32),
        },
    ];
    let result = store
        .import_relation_with_digests(
            "seed-1",
            "trust_allow_rules",
            vec![row("1", Some("2026-11-21 10:00:00+00")), row("2", None)],
            &digests,
        )
        .unwrap();
    assert_eq!((result.imported, result.dropped), (2, 0));
    let digest = store
        .relation_digest("seed-1", "trust_allow_rules", None, None)
        .unwrap();
    assert_eq!(digest.rows, 2);
    // A neighbouring relation's digest read is not disturbed by the new keys.
    assert_eq!(
        store
            .relation_digest("seed-1", "trust_proposals", None, None)
            .unwrap()
            .rows,
        0
    );
    let rules = store.list_trust_allow_rules(None, true).unwrap();
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0]["removed_by"], "local_cli:owner");
    assert!(rules[1]["removed_at"].is_null());
}
