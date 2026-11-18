//! Extraction state: the stale predicate, the stamps, the attendance marker and the reserved
//! frontmatter key sweep. The PGLite parity cases are in test/engine-parity/extraction.test.ts;
//! these cover what they cannot show: durability across a reopen, the hard-delete cascade, guest
//! sources and the inputs this engine refuses.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::extraction::*;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

const FRESH: &str = "2099-01-01T00:00:00.000Z";
const OLD: &str = "2000-01-01T00:00:00.000Z";

fn put_in(store: &Store, slug: &str, frontmatter: Value, source: Option<&str>) -> Value {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note",
        "title": slug,
        "compiled_truth": format!("{slug} body"),
        "frontmatter": frontmatter,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &options).unwrap()
}

fn put(store: &Store, slug: &str) -> Value {
    put_in(store, slug, json!({}), None)
}

fn source(store: &Store, id: &str, config: Value) {
    let input: SourceInput =
        serde_json::from_value(json!({ "id": id, "name": id, "config": config })).unwrap();
    store.upsert_source(&input).unwrap();
}

fn stale(value: Value) -> StaleOptions {
    serde_json::from_value(value).unwrap()
}

fn count(store: &Store, value: Value) -> u64 {
    store
        .count_stale_pages_for_extraction(&stale(value))
        .unwrap()
}

fn slugs(store: &Store, value: Value) -> Vec<String> {
    store
        .list_stale_pages_for_extraction(&stale(value))
        .unwrap()
        .iter()
        .map(|r| r["slug"].as_str().unwrap().to_string())
        .collect()
}

fn stamp(store: &Store, refs: Value, default: &str) -> u64 {
    let refs: Vec<ExtractedRef> = serde_json::from_value(refs).unwrap();
    store.mark_pages_extracted_batch(&refs, default).unwrap()
}

fn block(store: &Store, refs: Value) -> Result<u64> {
    let refs: Vec<AttendanceRef> = serde_json::from_value(refs).unwrap();
    store.mark_pages_attendance_blocked(&refs)
}

fn page_of(store: &Store, slug: &str) -> Value {
    store
        .read_page_snapshot(slug, &ReadScope::default())
        .unwrap()
        .unwrap()["page"]
        .clone()
}

#[test]
fn stamps_and_markers_survive_a_reopen_and_a_hard_delete_clears_them() {
    let dir = TempDir::new("extraction-reopen");
    let revision;
    {
        let store = open(&dir);
        put(&store, "notes/a");
        let b = put(&store, "notes/b");
        revision = b["knowledge_revision"].as_str().unwrap().to_string();
        assert_eq!(
            stamp(
                &store,
                json!([{"slug": "notes/a", "source_id": "default"}]),
                FRESH
            ),
            1
        );
        assert_eq!(
            block(
                &store,
                json!([{"slug": "notes/b", "source_id": "default", "revision": revision}])
            )
            .unwrap(),
            1
        );
    }
    let store = open(&dir);
    assert_eq!(slugs(&store, json!({})), ["notes/b"]);
    assert_eq!(count(&store, json!({"attendance": "blocked"})), 1);
    assert_eq!(count(&store, json!({"attendance": "exclude"})), 0);

    // A page deleted for good and created again starts unstamped and unblocked.
    store.delete_page("notes/a", None).unwrap();
    store.delete_page("notes/b", None).unwrap();
    put(&store, "notes/a");
    put(&store, "notes/b");
    assert_eq!(slugs(&store, json!({})), ["notes/a", "notes/b"]);
    assert_eq!(count(&store, json!({"attendance": "blocked"})), 0);
}

#[test]
fn the_stale_predicate_reads_version_edits_quarantine_guests_and_held() {
    let dir = TempDir::new("extraction-predicate");
    let store = open(&dir);
    source(&store, "guest-bool", json!({"guest": true}));
    source(&store, "guest-text", json!({"guest": "true"}));
    source(&store, "not-guest", json!({"guest": false}));
    put(&store, "notes/old");
    put(&store, "notes/fresh");
    put_in(&store, "notes/q", json!({"quarantine": null}), None);
    put_in(&store, "notes/g1", json!({}), Some("guest-bool"));
    put_in(&store, "notes/g2", json!({}), Some("guest-text"));
    put_in(&store, "notes/n", json!({}), Some("not-guest"));
    stamp(
        &store,
        json!([
            {"slug": "notes/old", "source_id": "default", "extractedAt": OLD},
            {"slug": "notes/fresh", "source_id": "default"},
        ]),
        FRESH,
    );
    assert_eq!(slugs(&store, json!({})), ["notes/old", "notes/n"]);
    assert_eq!(
        slugs(&store, json!({"versionTs": "2100-01-01T00:00:00Z"})),
        ["notes/old", "notes/fresh", "notes/n"]
    );
    // An empty versionTs or sourceId is no filter, as the falsy checks of PGLite read them.
    assert_eq!(count(&store, json!({"versionTs": "", "sourceId": ""})), 2);
    assert_eq!(count(&store, json!({"sourceId": "guest-bool"})), 0);
    assert_eq!(count(&store, json!({"held": "exclude"})), 2);
    assert_eq!(count(&store, json!({"held": "only"})), 0);
    assert_eq!(count(&store, json!({"wantedProducers": ["x"]})), 2);

    // An edit after the stamp makes the page stale again.
    assert_eq!(
        stamp(
            &store,
            json!([{"slug": "notes/old", "source_id": "default"}]),
            FRESH
        ),
        1
    );
    assert_eq!(slugs(&store, json!({})), ["notes/n"]);

    let err = store
        .count_stale_pages_for_extraction(&stale(json!({"versionTs": "yesterday"})))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn listing_pages_by_id_and_refuses_a_negative_batch() {
    let dir = TempDir::new("extraction-list");
    let store = open(&dir);
    for slug in ["notes/c", "notes/a", "notes/b"] {
        put(&store, slug);
    }
    assert_eq!(slugs(&store, json!({})), ["notes/c", "notes/a", "notes/b"]);
    let rows = store
        .list_stale_pages_for_extraction(&stale(json!({"batchSize": 1})))
        .unwrap();
    assert_eq!(rows.len(), 1);
    let first = rows[0]["id"].as_i64().unwrap();
    assert_eq!(
        slugs(&store, json!({"batchSize": 5, "afterPageId": first})),
        ["notes/a", "notes/b"]
    );
    assert_eq!(rows[0]["updated_at"], rows[0]["updated_at_iso"]);
    assert_eq!(rows[0]["frontmatter"], json!({}));
    assert!(slugs(&store, json!({"batchSize": 0})).is_empty());
    let err = store
        .list_stale_pages_for_extraction(&stale(json!({"batchSize": -1})))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn stamping_counts_each_page_once_includes_deleted_pages_and_keeps_updated_at() {
    let dir = TempDir::new("extraction-stamp");
    let store = open(&dir);
    let before = put(&store, "notes/a");
    put(&store, "notes/gone");
    store.soft_delete_page("notes/gone", None).unwrap();
    assert_eq!(
        stamp(
            &store,
            json!([
                {"slug": "notes/a", "source_id": "default"},
                {"slug": "notes/a", "source_id": "default", "extractedAt": OLD},
                {"slug": "notes/gone", "source_id": "default"},
            ]),
            FRESH
        ),
        2
    );
    // The first stamp of a page named twice wins: the page reads fresh.
    assert_eq!(count(&store, json!({})), 0);
    assert_eq!(
        page_of(&store, "notes/a")["updated_at"],
        before["updated_at"]
    );
    let refs: Vec<ExtractedRef> =
        serde_json::from_value(json!([{"slug": "notes/a", "source_id": "default"}])).unwrap();
    assert_eq!(
        store
            .mark_pages_extracted_batch(&refs, "not a time")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        store.mark_pages_extracted_batch(&[], "not a time").unwrap(),
        0
    );
}

#[test]
fn attendance_marks_match_the_revision_in_any_case_and_refuse_a_non_uuid() {
    let dir = TempDir::new("extraction-attendance");
    let store = open(&dir);
    let a = put(&store, "notes/a");
    let upper = a["knowledge_revision"].as_str().unwrap().to_uppercase();
    assert_eq!(
        block(
            &store,
            json!([
                {"slug": "notes/a", "source_id": "default", "revision": upper},
                {"slug": "notes/a", "source_id": "default", "revision": upper},
            ])
        )
        .unwrap(),
        1
    );
    assert_eq!(count(&store, json!({"attendance": "blocked"})), 1);
    let err = block(
        &store,
        json!([{"slug": "notes/a", "source_id": "default", "revision": "nope"}]),
    )
    .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    // Stamping clears the marker.
    stamp(
        &store,
        json!([{"slug": "notes/a", "source_id": "default", "extractedAt": OLD}]),
        FRESH,
    );
    assert_eq!(count(&store, json!({"attendance": "blocked"})), 0);
    assert_eq!(count(&store, json!({"attendance": "exclude"})), 1);
}

#[test]
fn the_reserved_key_sweep_changes_the_revision_but_not_updated_at() {
    let dir = TempDir::new("extraction-keys");
    let store = open(&dir);
    source(&store, "work", json!({}));
    let typed = put_in(
        &store,
        "notes/typed",
        json!({"type": "x", "mood": "calm"}),
        None,
    );
    put_in(&store, "notes/w", json!({"slug": "s"}), Some("work"));
    let counts: FrontmatterKeyCountOptions =
        serde_json::from_value(json!({"sourceIds": ["work", "default", "work"]})).unwrap();
    assert_eq!(
        store.count_stale_frontmatter_key_pages(&counts).unwrap(),
        [
            json!({"source_id": "default", "n": 1}),
            json!({"source_id": "work", "n": 1})
        ]
    );
    let list: FrontmatterKeyListOptions =
        serde_json::from_value(json!({"sourceId": "default", "afterId": -5, "limit": 10})).unwrap();
    let listed = store.list_stale_frontmatter_key_pages(&list).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["keys"], json!(["type"]));

    let id = typed["id"].as_i64().unwrap();
    let strip: StripFrontmatterKeysOptions =
        serde_json::from_value(json!({"sourceId": "default", "ids": [id, id, -1, 99999]})).unwrap();
    assert_eq!(store.strip_stale_frontmatter_keys(&strip).unwrap(), 1);
    let after = page_of(&store, "notes/typed");
    assert_eq!(after["frontmatter"], json!({"mood": "calm"}));
    assert_eq!(after["updated_at"], typed["updated_at"]);
    assert_ne!(after["knowledge_revision"], typed["knowledge_revision"]);
    assert_eq!(after["text_projection_revision"], Value::Null);
    assert_eq!(store.strip_stale_frontmatter_keys(&strip).unwrap(), 0);
}
