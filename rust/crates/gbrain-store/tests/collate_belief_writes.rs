//! The belief ledger's write path (belief_events.rs): the event insert, the coverage reads, the
//! redaction register and the commit marks. Nothing in a shipped brain calls these yet, so every
//! case drives the store directly.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::belief_events::EventRow;
use gbrain_store::facts::purge_ledger::FactPurgeInsert;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

const PUBLICATION: &str = "6f9619ff-8b86-4d01-b42d-00cf4fc964f1";
const REQUEST: &str = "6F9619FF-8B86-4D01-B42D-00CF4FC964FF";

fn put(store: &Store, slug: &str) {
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "body"}))
            .unwrap();
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
}

fn incarnation(store: &Store) -> String {
    store
        .get_source_by_id("default")
        .unwrap()
        .expect("the default source exists")
        .incarnation
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// One row as `appendBeliefEvents` builds it; `over` replaces fields.
fn row(inc: &str, key: &str, over: Value) -> EventRow {
    let mut base = json!({
        "event_key": key, "source_id": "default", "source_incarnation": inc, "page_lifetime": null,
        "slug": "", "subject_kind": "coverage", "subject_key": "[\"coverage\"]",
        "event_type": "coverage.started", "origin": "live", "trust_tier": "unknown",
        "writer_tier": null, "tier_basis": "unknown", "visibility": "private",
        "publication_id": PUBLICATION, "ord": 0, "source_time": null, "valid_from": null,
        "valid_until": null, "value": null, "value_hash": null, "prior_hash": null,
        "state_hash": "state", "cause": "{}", "claim_fp": null, "purged": false,
        "redacted_fields": null,
    });
    for (name, value) in over.as_object().unwrap() {
        base[name] = value.clone();
    }
    serde_json::from_value(base).unwrap()
}

fn baseline(inc: &str, key: &str, slug: &str, run: &str, ord: i32) -> EventRow {
    row(
        inc,
        key,
        json!({"slug": slug, "subject_kind": "page", "subject_key": format!("[\"page\",\"{slug}\"]"),
            "event_type": "baseline", "origin": "baseline", "cause": json!({"run": run}).to_string(),
            "ord": ord}),
    )
}

#[test]
fn events_insert_in_ord_order_and_a_known_key_is_skipped() {
    let dir = TempDir::new("belief-events-insert");
    let store = open(&dir);
    let inc = incarnation(&store);
    assert_eq!(
        store
            .read_belief_coverage("default", "[\"coverage\"]")
            .unwrap(),
        None
    );
    let done = row(
        &inc,
        "aa01",
        json!({"event_type": "coverage.complete", "cause": "{\"run\":\"r1\"}", "ord": 1}),
    );
    let started = row(&inc, "aa02", json!({"cause": "{\"run\":\"r1\"}", "ord": 0}));
    assert_eq!(
        store
            .insert_belief_events(vec![done.clone(), started.clone()])
            .unwrap(),
        2
    );
    let newest = store
        .read_belief_coverage("default", "[\"coverage\"]")
        .unwrap()
        .unwrap();
    assert_eq!(newest.event_type, "coverage.complete");
    assert_eq!(newest.run.as_deref(), Some("r1"));
    assert_eq!(newest.id, 2);
    assert!(newest.recorded_at.ends_with('Z') || newest.recorded_at.contains('+'));
    assert_eq!(store.insert_belief_events(vec![done, started]).unwrap(), 0);
    let twin = row(&inc, "bb01", json!({}));
    assert_eq!(
        store
            .insert_belief_events(vec![twin.clone(), twin])
            .unwrap(),
        1
    );
}

#[test]
fn a_restore_another_incarnation_and_another_source_are_not_the_coverage() {
    let dir = TempDir::new("belief-events-coverage");
    let store = open(&dir);
    let inc = incarnation(&store);
    let stale = "11111111-2222-4333-8444-555555555555";
    store
        .insert_belief_events(vec![row(
            &inc,
            "cc01",
            json!({"cause": "{\"run\":\"r1\"}"}),
        )])
        .unwrap();
    store
        .insert_belief_events(vec![
            row(&inc, "cc02", json!({"event_type": "coverage.restored"})),
            row(stale, "cc03", json!({"event_type": "coverage.stopped"})),
            row(
                &inc,
                "cc04",
                json!({"subject_key": "[\"other\"]", "event_type": "coverage.stopped"}),
            ),
        ])
        .unwrap();
    let got = store
        .read_belief_coverage("default", "[\"coverage\"]")
        .unwrap()
        .unwrap();
    assert_eq!((got.event_type.as_str(), got.id), ("coverage.started", 1));
    assert_eq!(
        store
            .read_belief_coverage("missing", "[\"coverage\"]")
            .unwrap(),
        None
    );
    assert!(
        store
            .read_belief_coverage("a\0b", "[\"coverage\"]")
            .is_err()
    );
}

#[test]
fn a_row_that_breaks_a_column_check_refuses_the_whole_call() {
    let dir = TempDir::new("belief-events-refuse");
    let store = open(&dir);
    let inc = incarnation(&store);
    for bad in [
        json!({"origin": "nonsense"}),
        json!({"subject_kind": "nonsense"}),
        json!({"tier_basis": "nonsense"}),
        json!({"cause": "{not json"}),
        json!({"publication_id": "nope"}),
        json!({"event_key": "xyz"}),
        json!({"slug": "a\0b"}),
    ] {
        let rows = vec![row(&inc, "dd01", json!({})), row(&inc, "dd02", bad)];
        assert!(store.insert_belief_events(rows).is_err());
    }
    assert_eq!(
        store
            .read_belief_coverage("default", "[\"coverage\"]")
            .unwrap(),
        None
    );
    assert_eq!(store.count_baselined_slugs("default", "r1").unwrap(), 0);
}

#[test]
fn pending_slugs_walk_by_byte_with_cursor_skip_limit_and_the_run() {
    let dir = TempDir::new("belief-pending");
    let store = open(&dir);
    for slug in ["ab", "a/z", "a-z"] {
        put(&store, slug);
    }
    let inc = incarnation(&store);
    let list = |run: &str, after: &str, skip: &[&str], limit: usize| {
        store
            .list_pending_baseline_slugs("default", run, after, &strings(skip), limit)
            .unwrap()
    };
    assert_eq!(list("r1", "", &[], 10), ["a-z", "a/z", "ab"]);
    store
        .insert_belief_events(vec![
            baseline(&inc, "ee01", "a/z", "r1", 0),
            baseline(&inc, "ee02", "a/z", "r1", 1),
            baseline(&inc, "ee03", "ab", "r0", 0),
        ])
        .unwrap();
    assert_eq!(list("r1", "", &[], 10), ["a-z", "ab"]);
    assert_eq!(list("r2", "a-z", &[], 10), ["a/z", "ab"]);
    assert_eq!(list("r2", "", &["a/z"], 10), ["a-z", "ab"]);
    assert_eq!(list("r2", "", &[], 1), ["a-z"]);
    assert_eq!(list("r2", "", &[], 0), ["a-z"]);
    assert!(list("r2", "ab", &[], 10).is_empty());
    assert!(store.has_baseline_event("default", "a/z", "r1").unwrap());
    assert!(!store.has_baseline_event("default", "a-z", "r1").unwrap());
    assert!(!store.has_baseline_event("default", "a/z", "r2").unwrap());
    assert_eq!(store.count_baselined_slugs("default", "r1").unwrap(), 1);
    assert_eq!(store.count_baselined_slugs("default", "r2").unwrap(), 0);
    assert!(
        store
            .list_pending_baseline_slugs("missing", "r1", "", &[], 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_redaction_register_matches_by_subject_key_or_field_hash_and_shows_a_release() {
    let dir = TempDir::new("belief-redactions");
    let store = open(&dir);
    let first = store
        .insert_belief_redaction("default", "key-1", "title", REQUEST, "hash-1")
        .unwrap();
    let second = store
        .insert_belief_redaction("default", "key-2", "body", REQUEST, "hash-2")
        .unwrap();
    assert_eq!((first, second), (1, 2));
    let by_key = store
        .read_belief_redactions("default", &strings(&["key-1"]), &[])
        .unwrap();
    assert_eq!(by_key.len(), 1);
    assert_eq!(by_key[0].purge_request, REQUEST.to_lowercase());
    assert_eq!(by_key[0].released_hash, None);
    let either = store
        .read_belief_redactions("default", &strings(&["key-1"]), &strings(&["hash-2"]))
        .unwrap();
    assert_eq!(either.iter().map(|r| r.id).collect::<Vec<_>>(), [1, 2]);
    assert!(
        store
            .read_belief_redactions("default", &[], &[])
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .read_belief_redactions("other", &strings(&["key-1"]), &[])
            .unwrap()
            .is_empty()
    );
    store
        .release_belief_redactions(&[first, 99], PUBLICATION, "released-hash")
        .unwrap();
    let after = store
        .read_belief_redactions("default", &strings(&["key-1", "key-2"]), &[])
        .unwrap();
    assert_eq!(
        after
            .iter()
            .map(|r| r.released_hash.as_deref())
            .collect::<Vec<_>>(),
        [Some("released-hash"), None]
    );
    assert!(
        store
            .insert_belief_redaction("default", "k", "f", "nope", "h")
            .is_err()
    );
    assert!(store.release_belief_redactions(&[1], "nope", "h").is_err());
}

#[test]
fn purged_fingerprints_are_the_fact_tombstones_of_the_source() {
    let dir = TempDir::new("belief-purged");
    let store = open(&dir);
    for (visibility, subject, hash) in [
        ("world", "*", "fp-one"),
        ("private", "people/ana", "fp-two"),
    ] {
        assert!(
            store
                .insert_fact_purge(&FactPurgeInsert {
                    source_id: "default".into(),
                    visibility: visibility.into(),
                    subject: subject.into(),
                    fact_hash: hash.into(),
                    request_id: Some(REQUEST.to_lowercase()),
                    actor: Some("owner:local".into()),
                    reason: Some("test".into()),
                })
                .unwrap()
        );
    }
    let ask = |source: &str, facts: &[&str], takes: &[&str]| {
        store
            .list_purged_fingerprints(source, &strings(facts), &strings(takes))
            .unwrap()
    };
    assert_eq!(ask("default", &["fp-one", "fp-none"], &[]), ["fp-one"]);
    assert_eq!(
        ask("default", &["fp-two", "fp-one"], &[]),
        ["fp-one", "fp-two"]
    );
    assert!(ask("default", &["fp-none"], &[]).is_empty());
    assert!(ask("default", &[], &["fp-one"]).is_empty());
    assert!(ask("other", &["fp-one"], &[]).is_empty());
}

#[test]
fn a_commit_mark_is_recorded_once_for_a_publication_with_events() {
    let dir = TempDir::new("belief-marks");
    let store = open(&dir);
    let inc = incarnation(&store);
    let other = "6f9619ff-8b86-4d01-b42d-00cf4fc964f2";
    store.record_belief_commit_marks(&[]).unwrap();
    store
        .record_belief_commit_marks(&strings(&[PUBLICATION]))
        .unwrap();
    assert_eq!(store.read_belief_commit_mark(PUBLICATION).unwrap(), None);
    store
        .insert_belief_events(vec![row(&inc, "ff01", json!({}))])
        .unwrap();
    store
        .record_belief_commit_marks(&strings(&[PUBLICATION, other]))
        .unwrap();
    let mark = store.read_belief_commit_mark(PUBLICATION).unwrap().unwrap();
    store
        .record_belief_commit_marks(&strings(&[PUBLICATION]))
        .unwrap();
    assert_eq!(
        store.read_belief_commit_mark(PUBLICATION).unwrap(),
        Some(mark)
    );
    assert_eq!(store.read_belief_commit_mark(other).unwrap(), None);
    assert!(
        store
            .record_belief_commit_marks(&strings(&["not-a-uuid"]))
            .is_err()
    );
}
