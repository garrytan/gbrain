//! The extract_atoms phase's reads and release, matched to PGLite (`engine-sql/extract-atoms-reads.ts`): page
//! discovery, the idempotency and atom-title reads, and the release of `managed-atoms` checkpoints recorded below
//! the input cap.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::link_queries::ExtractablePageQuery;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(store: &Store, slug: &str, page: Value) {
    store
        .put_page(
            slug,
            &args::<PageInput>(page),
            &args::<PutPageOptions>(json!({})),
        )
        .unwrap();
}

fn body() -> String {
    "We met and decided many durable things. ".repeat(40)
}

fn query(extra: Value) -> ExtractablePageQuery {
    let mut q =
        json!({ "sourceId": "default", "types": ["meeting"], "minChars": 500, "limit": 50 });
    q.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    args(q)
}

fn slugs(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
}

#[test]
fn discovery_keeps_live_long_unextracted_pages_newest_first() {
    let dir = TempDir::new("extract-atoms");
    let store = open(&dir);
    let b = body();
    put(
        &store,
        "meetings/older",
        json!({ "type": "meeting", "title": "Older", "compiled_truth": b }),
    );
    put(
        &store,
        "meetings/short",
        json!({ "type": "meeting", "title": "Short", "compiled_truth": "short" }),
    );
    put(
        &store,
        "meetings/dreamed",
        json!({ "type": "meeting", "title": "D", "compiled_truth": b, "frontmatter": { "dream_generated": "true" } }),
    );
    put(
        &store,
        "meetings/covered",
        json!({ "type": "meeting", "title": "C", "compiled_truth": format!("{b} covered") }),
    );
    put(
        &store,
        "meetings/newer",
        json!({ "type": "meeting", "title": "N", "compiled_truth": format!("{b} newer") }),
    );
    let covered = store
        .list_extractable_pages(&query(json!({ "affectedSlugs": ["meetings/covered"] })))
        .unwrap();
    let hash = covered[0]["content_hash"]
        .as_str()
        .unwrap()
        .chars()
        .take(16)
        .collect::<String>();
    put(
        &store,
        "atoms/a",
        json!({ "type": "atom", "title": "A", "compiled_truth": "x", "frontmatter": { "source_hash": hash } }),
    );

    let all = store.list_extractable_pages(&query(json!({}))).unwrap();
    assert_eq!(slugs(&all), vec!["meetings/newer", "meetings/older"]);
    let first = store
        .list_extractable_pages(&query(json!({ "limit": 1 })))
        .unwrap();
    assert_eq!(slugs(&first), vec!["meetings/newer"]);
    let named = store
        .list_extractable_pages(&query(
            json!({ "affectedSlugs": ["meetings/older", "meetings/short"] }),
        ))
        .unwrap();
    assert_eq!(slugs(&named), vec!["meetings/older"]);
    assert!(all[0]["source_incarnation"].is_string() && all[0]["knowledge_revision"].is_string());
}

#[test]
fn discovery_skips_a_completed_managed_atoms_checkpoint_of_the_current_content() {
    let dir = TempDir::new("extract-atoms");
    let store = open(&dir);
    put(
        &store,
        "meetings/m",
        json!({ "type": "meeting", "title": "M", "compiled_truth": body() }),
    );
    let row = store
        .list_extractable_pages(&query(json!({})))
        .unwrap()
        .remove(0);
    let key = json!([{
        "sourceId": "default", "incarnation": row["source_incarnation"], "kind": "page",
        "pageId": row["id"].to_string(), "contentHash": row["content_hash"],
    }]);
    store
        .write_op_checkpoint_record("managed-atoms", "m", Some(&key))
        .unwrap();
    assert!(
        store
            .list_extractable_pages(&query(json!({})))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn idempotency_and_title_reads_see_live_atoms_of_the_source() {
    let dir = TempDir::new("extract-atoms");
    let store = open(&dir);
    put(
        &store,
        "atoms/one",
        json!({ "type": "atom", "title": "One", "compiled_truth": "x", "frontmatter": { "source_hash": "h1", "source_slug": "meetings/m1" } }),
    );
    put(
        &store,
        "atoms/managed",
        json!({ "type": "atom", "title": "M", "compiled_truth": "x", "frontmatter": { "source_hash": "h2", "managed_extraction": "true", "source_slug": "meetings/m1" } }),
    );
    put(
        &store,
        "notes/n",
        json!({ "type": "note", "title": "N", "compiled_truth": "x", "frontmatter": { "source_hash": "h3", "source_slug": "meetings/m1" } }),
    );
    let hashes = store
        .list_atom_source_hashes("default", &["h1".into(), "h2".into(), "h3".into()])
        .unwrap();
    assert_eq!(hashes, vec!["h1"]);
    let mut titles = store
        .list_source_page_atom_titles("default", "meetings/m1")
        .unwrap();
    titles.sort_by_key(|t| t["slug"].as_str().unwrap().to_string());
    assert_eq!(
        titles,
        vec![
            json!({ "slug": "atoms/managed", "title": "M" }),
            json!({ "slug": "atoms/one", "title": "One" })
        ]
    );
}

#[test]
fn release_deletes_only_this_sources_checkpoints_below_the_cap() {
    let dir = TempDir::new("extract-atoms");
    let store = open(&dir);
    let seed = |fp: &str, key: Value| {
        store
            .write_op_checkpoint_record("managed-atoms", fp, Some(&json!([key])))
            .unwrap()
    };
    seed("low", json!({ "sourceId": "default", "partial": 500 }));
    seed("at-cap", json!({ "sourceId": "default", "partial": 1000 }));
    seed("whole", json!({ "sourceId": "default" }));
    seed("other", json!({ "sourceId": "other", "partial": 1 }));
    store
        .release_partial_atom_dispositions("default", 1000)
        .unwrap();
    let kept: Vec<String> = store
        .list_op_checkpoint_records("managed-atoms")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["fingerprint"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(kept, vec!["at-cap", "other", "whole"]);
    seed("bad", json!({ "sourceId": "default", "partial": "x" }));
    let err = store
        .release_partial_atom_dispositions("default", 1000)
        .unwrap_err();
    assert!(
        err.to_string()
            .contains("invalid input syntax for type integer")
    );
}

#[test]
fn a_tombstoned_or_partial_ledger_row_leaves_discovery_and_the_backlog() {
    let dir = TempDir::new("extract-atoms-ledger");
    let store = open(&dir);
    put(
        &store,
        "meetings/m",
        json!({ "type": "meeting", "title": "M", "compiled_truth": body() }),
    );
    let row = store
        .list_extractable_pages(&query(json!({})))
        .unwrap()
        .remove(0);
    let backlog = |cap: i64| {
        store
            .count_atom_extraction_backlog(&args(json!({
                "sourceId": "default", "types": ["meeting"], "minChars": 500, "maxInputChars": cap,
            })))
            .unwrap()
    };
    assert_eq!(backlog(1000), 1);
    let pin: gbrain_store::atom_state::AtomPagePin = args(json!({
        "pageId": row["id"], "sourceIncarnation": row["source_incarnation"], "sourceId": "default", "slug": "meetings/m",
        "contentHash": row["content_hash"], "revision": row["knowledge_revision"],
    }));
    // A failure is not a disposition: the page stays.
    assert_eq!(
        store.write_atom_page_state(&pin, 1, false).unwrap(),
        json!(1)
    );
    assert_eq!(
        slugs(&store.list_extractable_pages(&query(json!({}))).unwrap()),
        vec!["meetings/m"]
    );
    // A partial cap below the current cap counts in the backlog (the next run releases it) but leaves discovery.
    assert_eq!(
        store.record_atom_page_partial(&pin, 500).unwrap(),
        row["id"]
    );
    assert!(
        store
            .list_extractable_pages(&query(json!({})))
            .unwrap()
            .is_empty()
    );
    assert_eq!(backlog(1000), 1);
    assert_eq!(backlog(500), 0);
    store
        .release_partial_atom_dispositions("default", 1000)
        .unwrap();
    assert_eq!(
        slugs(&store.list_extractable_pages(&query(json!({}))).unwrap()),
        vec!["meetings/m"]
    );
    // A tombstone leaves both.
    store.write_atom_page_state(&pin, 0, true).unwrap();
    assert!(
        store
            .list_extractable_pages(&query(json!({})))
            .unwrap()
            .is_empty()
    );
    assert_eq!(backlog(1000), 0);
}
