//! A fact purge's derivation sweep record (`recordDerivationPurgeRow`, `readDerivationPurgeState`; page_body/purge_record.rs): the
//! record is kept once per request, reads `pending`, is counted by the table probe within its source, and, while it is there,
//! `upsertSegmentDerivations` drops a row the sweep would delete and that holds the claim and reports how many it dropped. The sweep
//! itself (`continueDerivationSweep`; page_body/derivation_sweep.rs) walks the record in batches, deletes the rows it drops and ends
//! with the record deleted.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::facts::purge_plan::PurgeProbeArgs;
use gbrain_store::page_body::derivation_sweep::DerivationSweepArgs;
use gbrain_store::page_body::purge_record::{DerivationPurgeRecordArgs, DerivationPurgeStateArgs};
use gbrain_store::page_body::{DerivationReadOptions, SegmentDerivationInput, SegmentedPageMeta};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const REQ: &str = "c0000000-0000-4000-8000-0000000000c1";
const REQ2: &str = "c0000000-0000-4000-8000-0000000000c2";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    let other: SourceInput = args(json!({ "id": "other", "name": "other", "config": {} }));
    store.upsert_source(&other).unwrap();
    (dir, store)
}

fn record(
    store: &Store,
    request: &str,
    source: &str,
    pages: &[i64],
    needle: &str,
) -> gbrain_store::Result<()> {
    let q: DerivationPurgeRecordArgs = args(json!({
        "requestId": request, "sourceId": source, "needles": [format!(" {needle} ")],
        "patterns": [format!("%{}%", needle.replace(' ', "%"))], "pageIds": pages,
    }));
    store.record_derivation_purge_row(&q)
}

fn state(store: &Store, request: &str) -> gbrain_store::Result<Value> {
    store.read_derivation_purge_state(&args::<DerivationPurgeStateArgs>(
        json!({ "requestId": request }),
    ))
}

fn probe(store: &Store, source: &str, needle: &str) -> usize {
    let q: PurgeProbeArgs = args(json!({
        "table": "page_segment_derivation_purges", "sourceId": source, "scoped": true, "binary": false, "rows": 10,
        "columns": ["source_id", "needles", "patterns", "page_ids", "phase", "recheck", "cursor_pipeline", "stalled_reason", "pending_reason"],
        "needles": [{ "text": needle, "lower": needle, "escaped": needle }],
    }));
    store.count_purge_probe(&q).unwrap() as usize
}

fn shell(store: &Store, slug: &str) -> i64 {
    let meta: SegmentedPageMeta = args(json!({ "type": "note", "title": slug }));
    store
        .create_segmented_page_shell(slug, &meta, &args(json!({ "sourceId": "default" })))
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn derivation(page: i64, occurrence: i64, output: Value) -> SegmentDerivationInput {
    args(json!({
        "pageId": page, "kind": "links", "occurrenceId": occurrence, "version": 1,
        "segmentSha256": sha("segment"), "contextHash": sha("ctx"), "state": "done", "output": output,
    }))
}

#[test]
fn a_recorded_sweep_reads_pending_and_a_second_record_of_the_request_keeps_nothing() {
    let (_dir, store) = brain("derivation-purge-record");
    assert_eq!(state(&store, REQ).unwrap(), Value::Null);
    record(&store, REQ, "default", &[7, 3], "alice likes tea").unwrap();
    assert_eq!(
        state(&store, REQ).unwrap(),
        json!({ "state": "pending", "reason": null })
    );
    assert_eq!(state(&store, REQ2).unwrap(), Value::Null);
    // ON CONFLICT (request_id) DO NOTHING, also under another spelling of the uuid.
    record(
        &store,
        &REQ.to_uppercase(),
        "default",
        &[9],
        "zebra crossing",
    )
    .unwrap();
    assert_eq!(probe(&store, "default", "zebra crossing"), 0);
    assert_eq!(probe(&store, "default", "alice likes tea"), 1);
    assert_eq!(probe(&store, "default", "{7,3}"), 1);
    assert_eq!(probe(&store, "other", "alice likes tea"), 0);
}

#[test]
fn a_record_refuses_what_postgres_refuses() {
    let (_dir, store) = brain("derivation-purge-record-refusals");
    assert_eq!(
        record(&store, "not-a-uuid", "default", &[], "x")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        state(&store, "not-a-uuid").unwrap_err().code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        record(&store, REQ, "default", &[i64::from(i32::MAX) + 1], "x")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        record(&store, REQ, "nobody", &[], "x").unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    assert_eq!(state(&store, REQ).unwrap(), Value::Null);
    // A conflict never reaches the source check: the first record stays, whatever source the second names.
    record(&store, REQ, "default", &[], "x").unwrap();
    record(&store, REQ, "nobody", &[], "x").unwrap();
}

#[test]
fn a_derivation_write_the_sweep_would_delete_and_that_holds_the_claim_is_dropped_and_counted() {
    let (_dir, store) = brain("derivation-purge-record-guard");
    let page = shell(&store, "notes/a");
    let kept = shell(&store, "notes/b");
    assert_eq!(
        store
            .upsert_segment_derivations(&[derivation(page, 1, json!({ "excerpt": "harmless" }))])
            .unwrap(),
        0
    );
    record(&store, REQ, "default", &[page], "alice likes tea").unwrap();
    // The purge rewrote `page`: the row holding the claim is dropped (the stored one stays), the others are stored.
    let refused = store
        .upsert_segment_derivations(&[
            derivation(
                page,
                1,
                json!({ "excerpt": "Today ALICE likes   tea at noon" }),
            ),
            derivation(page, 2, json!({ "excerpt": "unrelated" })),
        ])
        .unwrap();
    assert_eq!(refused, 1);
    let rows = store
        .read_segment_derivations(page, &DerivationReadOptions::default())
        .unwrap();
    let outputs: Vec<(i64, Value)> = rows
        .iter()
        .map(|r| (r["occurrenceId"].as_i64().unwrap(), r["output"].clone()))
        .collect();
    assert_eq!(
        outputs,
        vec![
            (1, json!({ "excerpt": "harmless" })),
            (2, json!({ "excerpt": "unrelated" }))
        ]
    );
    // No sweep covers a page of another source: the same row is stored there.
    let other = brain("derivation-purge-record-guard-other");
    let there = shell(&other.1, "notes/a");
    record(&other.1, REQ, "other", &[there], "alice likes tea").unwrap();
    assert_eq!(
        other
            .1
            .upsert_segment_derivations(&[derivation(
                there,
                1,
                json!({ "excerpt": "alice likes tea" })
            )])
            .unwrap(),
        0
    );
    // A shell page has no live segment, so no segment backs the row: it is in scope even on a page the purge did not rewrite.
    assert_eq!(
        store
            .upsert_segment_derivations(&[derivation(
                kept,
                1,
                json!({ "excerpt": "alice likes tea" })
            )])
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .upsert_segment_derivations(&[derivation(kept, 1, json!({ "excerpt": "no claim" }))])
            .unwrap(),
        0
    );
}

#[test]
fn a_request_id_is_one_request_in_every_spelling_postgres_reads_as_a_uuid() {
    let (_dir, store) = brain("derivation-purge-record-uuid");
    let plain = REQ.replace('-', "");
    let spellings = [
        REQ.to_string(),
        REQ.to_uppercase(),
        plain.clone(),
        plain.to_uppercase(),
        format!("{{{REQ}}}"),
        format!("{{{plain}}}"),
        format!(
            "{}-{}-{}-{}",
            &plain[..8],
            &plain[8..16],
            &plain[16..24],
            &plain[24..]
        ),
        format!(
            "{}-{}-{}-{}-{}-{}-{}-{}",
            &plain[..4],
            &plain[4..8],
            &plain[8..12],
            &plain[12..16],
            &plain[16..20],
            &plain[20..24],
            &plain[24..28],
            &plain[28..]
        ),
    ];
    record(&store, &spellings[4], "default", &[1], "alice likes tea").unwrap();
    for spelling in &spellings {
        assert_eq!(
            state(&store, spelling).unwrap(),
            json!({ "state": "pending", "reason": null }),
            "{spelling}"
        );
        record(&store, spelling, "default", &[2], "zebra crossing").unwrap();
    }
    assert_eq!(probe(&store, "default", "zebra crossing"), 0);
    assert_eq!(probe(&store, "default", "alice likes tea"), 1);
    for bad in [
        "",
        "not-a-uuid",
        &REQ[1..],
        &format!("{REQ}0"),
        &format!("{{{REQ}"),
        &format!("{REQ}}}"),
        &format!(" {REQ}"),
        &REQ.replace("c1", "cg"),
    ] {
        assert_eq!(
            state(&store, bad).unwrap_err().code,
            INVALID_ARGUMENT,
            "{bad:?}"
        );
        assert_eq!(
            record(&store, bad, "default", &[], "x").unwrap_err().code,
            INVALID_ARGUMENT,
            "{bad:?}"
        );
    }
}

#[test]
fn a_row_the_sweep_drops_reaches_neither_the_check_constraints_nor_the_conflict_handling() {
    let (_dir, store) = brain("derivation-purge-record-order");
    let page = shell(&store, "notes/a");
    record(&store, REQ, "default", &[page], "alice likes tea").unwrap();
    let outputs = || -> Vec<Value> {
        store
            .read_segment_derivations(page, &DerivationReadOptions::default())
            .unwrap()
            .iter()
            .map(|r| r["output"].clone())
            .collect()
    };
    // Two rows of one key: the first holds the claim and is dropped, so the second is no repeat.
    let refused = store
        .upsert_segment_derivations(&[
            derivation(page, 1, json!({ "excerpt": "Alice likes tea" })),
            derivation(page, 1, json!({ "excerpt": "harmless" })),
        ])
        .unwrap();
    assert_eq!(refused, 1);
    assert_eq!(outputs(), vec![json!({ "excerpt": "harmless" })]);
    // Two harmless rows of one key still reach the conflict handling.
    let repeated = store.upsert_segment_derivations(&[
        derivation(page, 2, json!({ "n": 1 })),
        derivation(page, 2, json!({ "n": 2 })),
    ]);
    assert_eq!(repeated.unwrap_err().code, CONSTRAINT_VIOLATION);
    // A dropped row that would fail a CHECK (a negative version) is dropped; a kept one fails it.
    let negative = |output: Value| -> SegmentDerivationInput {
        let mut row = derivation(page, 3, output);
        row.version = -1;
        row
    };
    assert_eq!(
        store
            .upsert_segment_derivations(&[negative(json!({ "excerpt": "Alice likes tea" }))])
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .upsert_segment_derivations(&[negative(json!({ "excerpt": "harmless" }))])
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    assert_eq!(outputs(), vec![json!({ "excerpt": "harmless" })]);
}

fn sweep(
    store: &Store,
    first: Option<&str>,
    batch_rows: i64,
    total_ms: i64,
) -> gbrain_store::Result<Value> {
    store.continue_derivation_sweep(&args::<DerivationSweepArgs>(json!({
        "sourceId": "default", "first": first, "inline": false, "batchRows": batch_rows, "totalMs": total_ms, "inlineMs": 5000,
    })))
}

fn rows(store: &Store, page: i64) -> usize {
    store
        .read_segment_derivations(page, &DerivationReadOptions::default())
        .unwrap()
        .len()
}

#[test]
fn a_sweep_walks_one_batch_per_call_deletes_the_rows_holding_the_claim_and_ends_with_its_record_deleted()
 {
    let (_dir, store) = brain("derivation-sweep");
    let page = shell(&store, "notes/sweep");
    // Three rows on a page whose segments back nothing, so the purge's scope holds them all: two hold the claim.
    store
        .upsert_segment_derivations(&[
            derivation(page, 1, json!({ "excerpt": "Alice likes tea" })),
            derivation(page, 2, json!({ "excerpt": "harmless" })),
            derivation(page, 3, json!({ "excerpt": "alice  LIKES tea at noon" })),
        ])
        .unwrap();
    record(&store, REQ, "default", &[], "alice likes tea").unwrap();
    // Batches of two rows, one per call: [1 2] deletes row 1, [3] deletes row 3 and ends the walk, and the verify walk reads [2]: clean, so it ends the record.
    let mut deleted = 0;
    let mut calls = 0;
    while state(&store, REQ).unwrap() != Value::Null {
        let out = sweep(&store, Some(REQ), 2, 0).unwrap();
        deleted += out["deleted"].as_i64().unwrap();
        calls += 1;
        assert!(calls < 10, "the sweep must end");
    }
    assert_eq!(deleted, 2);
    assert_eq!(rows(&store, page), 1);
    assert_eq!(calls, 3);
    // Nothing is left to walk.
    assert_eq!(sweep(&store, None, 2, 0).unwrap()["deleted"], json!(0));
}

#[test]
fn a_sweep_walks_the_named_request_first_and_never_another_sources_record() {
    let (_dir, store) = brain("derivation-sweep-order");
    let page = shell(&store, "notes/sweep-order");
    store
        .upsert_segment_derivations(&[derivation(page, 1, json!({ "excerpt": "Alice likes tea" }))])
        .unwrap();
    record(&store, REQ, "default", &[], "alice likes tea").unwrap();
    record(&store, REQ2, "default", &[], "bob owns a boat").unwrap();
    record(
        &store,
        "c0000000-0000-4000-8000-0000000000c3",
        "other",
        &[],
        "alice likes tea",
    )
    .unwrap();
    // One call, one batch of the request named first: its walk has read the row and ends (the verify walk is next).
    sweep(&store, Some(REQ2), 2, 0).unwrap();
    assert_eq!(rows(&store, page), 1);
    for _ in 0..8 {
        sweep(&store, Some(REQ2), 2, 0).unwrap();
    }
    // REQ2 ended first; REQ was then walked and deleted its row; the other source's record is still there.
    assert_eq!(state(&store, REQ2).unwrap(), Value::Null);
    assert_eq!(state(&store, REQ).unwrap(), Value::Null);
    assert_eq!(rows(&store, page), 0);
    assert_eq!(
        state(&store, "c0000000-0000-4000-8000-0000000000c3").unwrap(),
        json!({ "state": "pending", "reason": null })
    );
}

#[test]
fn a_sweep_refuses_a_batch_of_no_rows_and_a_request_id_that_is_no_uuid() {
    let (_dir, store) = brain("derivation-sweep-refusals");
    assert!(sweep(&store, None, 0, 0).is_err());
    assert!(sweep(&store, Some("not-a-uuid"), 2, 0).is_err());
    let retry = args::<DerivationSweepArgs>(
        json!({ "sourceId": "default", "retry": "nope", "batchRows": 2, "totalMs": 0, "inlineMs": 0 }),
    );
    assert!(store.continue_derivation_sweep(&retry).is_err());
}
