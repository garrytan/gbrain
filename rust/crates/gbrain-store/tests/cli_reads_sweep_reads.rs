//! The maintenance sweep's page reads (`cli_reads/sweep_reads.rs`): the PGLite semantics of each, on rows the typed
//! writers make. The parity cases are in test/engine-parity/sweep-reads.test.ts; these cover the tie order, the
//! clock and the inputs this engine refuses.

mod memory_env;

use gbrain_store::cli_reads::sweep_reads::*;
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::extraction::ExtractedRef;
use gbrain_store::page_body::{
    BodyFlipInput, BodyStagingInput, ManifestRow, SegmentTextInput, SegmentedPageMeta,
};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, T0, brain};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU32, Ordering};

const SECOND: i64 = 1_000_000;
const SINCE: &str = "2027-01-15T07:00:00.000Z";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(b: &Brain, slug: &str, source: Option<&str>, body: &str) {
    let input: PageInput = args(json!({ "type": "note", "title": slug, "compiled_truth": body }));
    let opts = PutPageOptions {
        source_id: source.map(str::to_string),
        ..PutPageOptions::default()
    };
    b.put_page(slug, &input, &opts).unwrap();
}

fn stamp(b: &Brain, slug: &str, at: &str) {
    let refs: Vec<ExtractedRef> =
        args(json!([{ "slug": slug, "source_id": "default", "extractedAt": at }]));
    b.mark_pages_extracted_batch(&refs, at).unwrap();
}

fn hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn hex(text: &str) -> String {
    text.bytes().map(|b| format!("{b:02x}")).collect()
}

static NEXT_STAGING: AtomicU32 = AtomicU32::new(1);

/// A published segmented page of one segment whose manifest row carries `facts_slots`.
fn segmented(b: &Brain, slug: &str, facts_slots: Value) {
    let n = NEXT_STAGING.fetch_add(1, Ordering::Relaxed);
    let staging_id = format!("{n:08x}-1111-4111-8111-111111111111");
    let client_id = format!("{n:08x}-4444-4444-8444-444444444444");
    let text = "one\n";
    let meta: SegmentedPageMeta = args(json!({ "type": "note", "title": slug }));
    let id = b
        .create_segmented_page_shell(slug, &meta, &args(json!({ "sourceId": "default" })))
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let staging: BodyStagingInput = args(json!({
        "id": staging_id, "kind": "put", "principalKind": "local", "principalId": "cli",
        "clientRequestId": client_id, "sourceId": "default",
        "sourceIncarnation": "33333333-3333-4333-8333-333333333333", "slug": slug,
        "pageId": id, "mode": "replace", "baseRevision": null, "baseGeneration": 0,
        "declaredBytes": 10, "declaredSha256": null, "reservedBytes": 10,
        "idleExpiresAt": "2099-01-01T00:00:00.000Z", "hardExpiresAt": "2099-01-02T00:00:00.000Z",
    }));
    b.open_body_staging(&staging).unwrap();
    let staged: Vec<SegmentTextInput> = vec![args(
        json!({ "sha256": hash(text), "body": hex(text), "lineCount": 1 }),
    )];
    b.stage_segment_texts(
        "default",
        &staged,
        &args(json!({ "stagingId": staging_id })),
    )
    .unwrap();
    let rows: Vec<ManifestRow> = vec![args(json!({
        "pageId": id, "occurrenceId": 1, "genFrom": 1, "seq": 0, "region": "truth",
        "sourceId": "default", "sha256": hash(text), "byteStart": 0, "byteLen": text.len(),
        "lineStart": 0, "lineCount": 1, "cutKind": "heading", "entryState": {"depth": 0},
        "protectedRegions": [], "factsSlots": facts_slots, "staticProjBytes": text.len(),
        "staticProjLines": 1, "outline": [], "dateMin": null, "dateMax": null,
        "hashState": hash("state"), "stagingId": staging_id,
    }))];
    b.stage_manifest_rows(&rows).unwrap();
    let flip: BodyFlipInput = args(json!({
        "pageId": id, "expectedGeneration": 0, "newGeneration": 1, "stagingId": staging_id,
        "closeOccurrences": [], "retireChunkOccurrences": [], "retireMaxRows": 1000,
        "body": {
            "content_hash": "hash-1", "body_bytes": text.len(), "truth_bytes": text.len(),
            "body_lines": 1, "segment_count": 1, "segmenter_version": 1, "truth_lead": "lead",
            "timeline_lead": "", "body_flags": {},
        },
        "meta": {"type": "note", "title": slug},
    }));
    b.flip_body_generation(&flip).unwrap();
}

fn fence(b: &Brain, v: Value) -> Vec<String> {
    b.list_facts_fence_pages(&args(v)).unwrap()
}

fn stale(b: &Brain, v: Value) -> Vec<Value> {
    b.list_sweep_stale_pages(&args(v)).unwrap()
}

fn slugs(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
}

#[test]
fn fence_pages_read_the_marker_or_a_published_facts_slot_within_the_scan_cap() {
    let b = brain("sweep-fence");
    put(&b, "n/plain", None, "plain");
    b.clock.advance(SECOND);
    put(
        &b,
        "n/fenced",
        None,
        "a\n<!-- gbrain:facts:begin -->\n| x |\n<!-- gbrain:facts:end -->",
    );
    b.clock.advance(SECOND);
    segmented(&b, "n/seg-empty", json!([]));
    b.clock.advance(SECOND);
    segmented(&b, "n/seg-facts", json!([{ "byteStart": 0, "byteLen": 4 }]));
    b.clock.advance(SECOND);
    let other: SourceInput = args(json!({ "id": "other", "name": "other" }));
    b.upsert_source(&other).unwrap();
    put(
        &b,
        "n/other-source",
        Some("other"),
        "<!-- gbrain:facts:begin -->",
    );
    let all = json!({ "sourceId": "default", "since": SINCE, "scanCap": 500, "limit": 8 });
    assert_eq!(fence(&b, all.clone()), ["n/seg-facts", "n/fenced"]);
    // The scan cap counts the newest pages before the filter, so the two newest leave out n/fenced.
    assert_eq!(
        fence(
            &b,
            json!({ "sourceId": "default", "since": SINCE, "scanCap": 2, "limit": 8 })
        ),
        ["n/seg-facts"]
    );
    assert_eq!(
        fence(
            &b,
            json!({ "sourceId": "default", "since": SINCE, "scanCap": 500, "limit": 1 })
        ),
        ["n/seg-facts"]
    );
    // A page updated before `since` is not read.
    assert!(
        fence(&b, json!({ "sourceId": "default", "since": "2099-01-01T00:00:00Z", "scanCap": 500, "limit": 8 }))
            .is_empty()
    );
    b.soft_delete_page("n/fenced", None).unwrap();
    assert_eq!(fence(&b, all), ["n/seg-facts"]);
}

#[test]
fn stale_pages_read_the_links_watermark_the_exclusions_and_the_body_columns() {
    let b = brain("sweep-stale");
    put(&b, "n/a", None, "a");
    b.clock.advance(SECOND);
    put(&b, "n/b", None, "b");
    b.clock.advance(SECOND);
    put(&b, "n/c", None, "c");
    b.clock.advance(SECOND);
    segmented(&b, "n/seg", json!([]));
    // n/b is stamped after its write (fresh); n/a before it (stale).
    stamp(&b, "n/b", "2099-01-01T00:00:00.000Z");
    stamp(&b, "n/a", "2000-01-01T00:00:00.000Z");
    b.clock.advance(SECOND);
    let rows = stale(
        &b,
        json!({ "sourceId": "default", "since": SINCE, "limit": 8, "exclude": ["n/c"] }),
    );
    assert_eq!(slugs(&rows), ["n/seg", "n/a"]);
    let read_at = "2027-01-15T08:00:04.000000Z";
    assert_eq!(
        rows[0],
        json!({ "slug": "n/seg", "read_at": read_at, "updated_at_iso": "2027-01-15T08:00:03.000000Z",
                "body_storage": "segmented", "body_bytes": 4 })
    );
    assert_eq!(
        rows[1],
        json!({ "slug": "n/a", "read_at": read_at, "updated_at_iso": "2027-01-15T08:00:00.000000Z",
                "body_storage": "inline", "body_bytes": null })
    );
    // `exclude` defaults to none; `limit` keeps the newest.
    assert_eq!(
        slugs(&stale(
            &b,
            json!({ "sourceId": "default", "since": SINCE, "limit": 2 })
        )),
        ["n/seg", "n/c"]
    );
}

#[test]
fn pages_updated_in_the_same_microsecond_come_newest_id_first() {
    let b = brain("sweep-tie");
    put(&b, "n/first", None, "1");
    put(&b, "n/second", None, "2");
    let rows = stale(
        &b,
        json!({ "sourceId": "default", "since": SINCE, "limit": 8 }),
    );
    assert_eq!(slugs(&rows), ["n/second", "n/first"]);
    assert_eq!(rows[0]["updated_at_iso"], rows[1]["updated_at_iso"]);
    assert_eq!(rows[0]["updated_at_iso"], json!(gbrain_store::env::iso(T0)));
}

#[test]
fn deferred_pages_keep_only_the_named_pages_that_are_still_stale() {
    let b = brain("sweep-deferred");
    put(&b, "n/a", None, "a");
    put(&b, "n/b", None, "b");
    put(&b, "n/c", None, "c");
    stamp(&b, "n/b", "2099-01-01T00:00:00.000Z");
    let rows = b
        .list_sweep_deferred_pages(&args(
            json!({ "sourceId": "default", "since": SINCE, "slugs": ["n/a", "n/b", "n/missing"] }),
        ))
        .unwrap();
    assert_eq!(
        rows,
        [json!({ "slug": "n/a", "updated_at_iso": "2027-01-15T08:00:00.000000Z" })]
    );
    assert!(
        b.list_sweep_deferred_pages(&args(
            json!({ "sourceId": "default", "since": SINCE, "slugs": [] })
        ))
        .unwrap()
        .is_empty()
    );
}

#[test]
fn a_bad_since_a_negative_limit_and_an_unknown_field_are_refused() {
    let b = brain("sweep-refusals");
    let err = b
        .list_sweep_stale_pages(&args(
            json!({ "sourceId": "default", "since": "yesterday", "limit": 1 }),
        ))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    let err = b
        .list_facts_fence_pages(&args(
            json!({ "sourceId": "default", "since": SINCE, "scanCap": -1, "limit": 1 }),
        ))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    let err = b
        .list_sweep_deferred_pages(&args(
            json!({ "sourceId": "default", "since": "", "slugs": [] }),
        ))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert!(
        serde_json::from_value::<SweepStalePagesSpec>(
            json!({ "sourceId": "default", "since": SINCE, "limit": 1, "extra": 1 })
        )
        .is_err()
    );
}

#[test]
fn page_refs_read_the_named_live_pages_of_every_source() {
    let b = brain("sweep-refs");
    put(&b, "n/a", None, "a");
    put(&b, "n/b", None, "b");
    put(&b, "n/gone", None, "gone");
    let other: SourceInput = args(json!({ "id": "other", "name": "other" }));
    b.upsert_source(&other).unwrap();
    put(&b, "n/a", Some("other"), "a elsewhere");
    b.soft_delete_page("n/gone", None).unwrap();
    let rows = b
        .list_page_refs_for_slugs(&args(json!({ "slugs": ["n/a", "n/gone", "n/missing"] })))
        .unwrap();
    let refs: Vec<(&str, &str, &str)> = rows
        .iter()
        .map(|r| {
            (
                r["source_id"].as_str().unwrap(),
                r["slug"].as_str().unwrap(),
                r["type"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(refs, [("default", "n/a", "note"), ("other", "n/a", "note")]);
    assert!(rows.iter().all(|r| r["knowledge_revision"].is_string()));
    assert!(
        b.list_page_refs_for_slugs(&args(json!({ "slugs": [] })))
            .unwrap()
            .is_empty()
    );
    let err = b
        .list_page_refs_for_slugs(&args(json!({ "slugs": ["n/\0"] })))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}
