//! The deletes and reads of a page purge's sweep the store serves: the decide, trust, write-gate, fact and file deletes that
//! name a page, the page's segment storage and claim sweep, the journal reads, and the slug-store scrub
//! (`eval_capture/decide_proposals/purge.rs`, `trust/proposals/purge.rs`, `trust/write_gate/purge.rs`, `raw_files/purge.rs`,
//! `page_body/purge_sweep.rs`, `facts/page_purge_sweep.rs`, `facts/page_purge_journal.rs`). The TypeScript parity cases
//! (test/engine-parity/page-purge-sweep.test.ts) compare the same members with PGLite; these cover the key bookkeeping a
//! parity case cannot see: an index key left pointing at a deleted row would refuse or hide the next write of the same key.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::eval_capture::decide_proposals::DecideProposalInput;
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::page_body::*;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::raw_files::FileSpec;
use gbrain_store::sources::SourceInput;
use gbrain_store::trust::proposals::NewProposal;
use gbrain_store::trust::write_gate::{HoldInput, ReceiptInput};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const SLUG: &str = "notes/a";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    let other: SourceInput = args(json!({ "id": "other", "name": "other", "config": {} }));
    store.upsert_source(&other).unwrap();
    (dir, store)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

fn text_of(body: &[u8]) -> SegmentTextInput {
    args(
        json!({ "sha256": hex(&Sha256::digest(body)), "body": hex(body),
        "lineCount": body.iter().filter(|b| **b == b'\n').count() }),
    )
}

fn text(body: &str) -> SegmentTextInput {
    text_of(body.as_bytes())
}

fn put(store: &Store, slug: &str) -> i64 {
    let input: PageInput =
        args(json!({ "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": {} }));
    store
        .put_page(slug, &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn fact(store: &Store, source: &str, slug: Option<&str>, row: i64, text: &str) -> i64 {
    let input = json!({ "fact": text, "kind": "fact", "visibility": "world", "source": "fence",
        "entity_slug": null, "source_markdown_slug": slug, "row_num": slug.map(|_| row) });
    store
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": [input], "sourceId": source }),
        ))
        .unwrap()["ids"][0]
        .as_i64()
        .unwrap()
}

// ------------------------------------------------------------------ decide and trust rows

#[test]
fn decide_deletes_free_their_unique_keys_so_the_same_rows_can_be_filed_again() {
    let (_dir, store) = brain("sweep-decide");
    let proposal = |sweep: &str, index: i64, new: i64, old: i64| -> DecideProposalInput {
        args(
            json!({ "source_id": "default", "sweep_id": sweep, "pair_index": index,
            "new_fact_id": new, "old_fact_id": old, "direction": "new_supersedes_old",
            "p_supersede": 0.9, "threshold": 0.8, "proposal_floor": 0.5 }),
        )
    };
    // A claim-conflict sweep keeps a fact-pair key too: deleting the proposal must free it.
    assert!(
        store
            .insert_decide_proposal(&proposal("claim_conflicts:x", 0, 11, 12))
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .insert_decide_proposal(&proposal("plain", 0, 12, 13))
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .insert_decide_proposal(&proposal("claim_conflicts:x", 1, 21, 22))
            .unwrap()
            .is_some()
    );
    assert_eq!(
        store.delete_purge_decide_proposals("default", &[]).unwrap(),
        0
    );
    assert_eq!(
        store
            .delete_purge_decide_proposals("other", &[11, 12])
            .unwrap(),
        0
    );
    // Either side names a fact: 11 names the first, 12 names the first and the second.
    assert_eq!(
        store
            .delete_purge_decide_proposals("default", &[12])
            .unwrap(),
        2
    );
    assert!(
        store
            .insert_decide_proposal(&proposal("claim_conflicts:x", 0, 11, 12))
            .unwrap()
            .is_some(),
        "the sweep slot and the fact-pair key are free again"
    );
    assert!(
        store
            .insert_decide_proposal(&proposal("claim_conflicts:y", 0, 11, 12))
            .unwrap()
            .is_none(),
        "but a live pair still refuses"
    );
    assert_eq!(
        store
            .delete_purge_decide_proposals("default", &[21])
            .unwrap(),
        1
    );
}

#[test]
fn review_deletes_match_either_ref_in_their_source_only() {
    let (_dir, store) = brain("sweep-review");
    let review = |a: &str,
                  b: &str,
                  source: &str|
     -> gbrain_store::eval_capture::decide_proposals::DecideReviewProposalInput {
        args(
            json!({ "kind": "duplicate_page", "source_id": source, "sweep_id": "r", "a_ref": a,
            "b_ref": b, "subject": "*", "p_action": 0.7, "threshold": 0.6 }),
        )
    };
    for (a, b, source) in [
        ("5", "pages/x", "default"),
        ("pages/y", "5", "default"),
        ("6", "pages/x", "default"),
        ("5", "pages/x", "other"),
    ] {
        store
            .insert_decide_review_proposal(&review(a, b, source))
            .unwrap()
            .unwrap();
    }
    let queue = |a: &str, b: &str, source: &str| {
        let op = args(
            json!({ "op": "enqueue", "kind": "duplicate_page", "source_id": source,
            "a_ref": a, "b_ref": b }),
        );
        store.apply_decide_review_queue(&op).unwrap();
    };
    queue("5", "pages/x", "default");
    queue("pages/z", "5", "default");
    queue("6", "pages/x", "default");
    let refs = vec!["5".to_string(), "not-a-ref".to_string()];
    assert_eq!(
        store
            .delete_purge_review_proposals("default", &refs)
            .unwrap(),
        2
    );
    assert_eq!(
        store.delete_purge_review_queue("default", &refs).unwrap(),
        2
    );
    assert_eq!(
        store
            .delete_purge_review_proposals("default", &refs)
            .unwrap(),
        0
    );
    // The unique key went with the row: the same proposal files again.
    assert!(
        store
            .insert_decide_review_proposal(&review("5", "pages/x", "default"))
            .unwrap()
            .is_some()
    );
    // A ref with a NUL is not refused here: main's `delete_purge_review_*` (facts/purge_writes.rs) check only the source id.
}

#[test]
fn trust_proposals_go_by_page_fact_or_take_and_free_their_pending_key() {
    let (_dir, store) = brain("sweep-trust");
    let propose =
        |action: &str, target: (&str, i64), related: Option<(&str, i64)>, source: &str| {
            let input: NewProposal = args(json!({ "action": action, "sourceId": source,
            "target": { "table": target.0, "id": target.1 },
            "related": related.map(|(t, i)| json!({ "table": t, "id": i })),
            "before": {}, "proposer": "test" }));
            store.insert_trust_proposal(&input).unwrap()["id"]
                .as_u64()
                .unwrap()
        };
    propose("lower_page", ("pages", 7), None, "default");
    propose("confirm", ("facts", 90), Some(("pages", 7)), "default");
    propose("forget", ("facts", 91), None, "default");
    propose("forget", ("takes", 31), None, "default");
    propose("confirm", ("facts", 92), Some(("takes", 32)), "default");
    propose("lower_page", ("pages", 8), None, "default");
    propose("lower_page", ("pages", 7), None, "other");
    assert_eq!(
        store
            .delete_purged_page_trust_proposals("default", 999, &[], &[])
            .unwrap(),
        0
    );
    // An id that is a fact is not a page: the proposal on facts 7 is not the page's.
    assert_eq!(
        store
            .delete_purged_page_trust_proposals("default", 7, &[91], &[31, 32])
            .unwrap(),
        5
    );
    assert_eq!(
        store
            .delete_purged_page_trust_proposals("default", 7, &[91], &[31, 32])
            .unwrap(),
        0
    );
    // The pending key went with the first one, so the same proposal opens again instead of returning the old row.
    let again: NewProposal = args(json!({ "action": "lower_page", "sourceId": "default",
        "target": { "table": "pages", "id": 7 }, "before": {}, "proposer": "test" }));
    assert_eq!(
        store.insert_trust_proposal(&again).unwrap()["created"],
        true
    );
    // The other source's and the other page's proposals stayed.
    assert_eq!(
        store.pending_trust_proposals_for("pages", 8).unwrap().len(),
        1
    );
}

#[test]
fn holds_and_receipts_go_with_their_dedupe_keys() {
    let (_dir, store) = brain("sweep-gate");
    let hold = |slug: &str, fingerprint: &str, source: &str| -> u64 {
        let input: HoldInput = args(json!({ "kind": "fact", "source_id": source, "slug": slug,
            "fingerprint": fingerprint, "detector_version": 1, "tier": "agent_written",
            "reason_families": ["prompt_injection"], "reasons": ["x"], "detector_error": false,
            "payload": { "fact": "held" }, "write_origin": null, "request_id": null }));
        store.upsert_write_gate_hold(input).unwrap()
    };
    let receipt = |table: &str, id: &str| {
        let input: ReceiptInput = args(json!({ "target_table": table, "target_id": id,
            "source_id": "default", "content_hash": format!("h-{table}-{id}"), "tier": "agent_written",
            "detector_version": 1, "verdict": "flag", "reason_families": ["override"], "reasons": ["r"],
            "detector_error": false, "request_id": null }));
        store.upsert_write_gate_receipt(input).unwrap();
    };
    let first = hold(SLUG, "fp-1", "default");
    let second = hold(SLUG, "fp-2", "default");
    let keeper = hold("notes/keeper", "fp-3", "default");
    hold(SLUG, "fp-4", "other");
    let deleted = store.delete_purged_page_holds("default", SLUG).unwrap();
    assert_eq!(deleted, vec![first.to_string(), second.to_string()]);
    assert!(
        store
            .delete_purged_page_holds("default", SLUG)
            .unwrap()
            .is_empty()
    );
    // The dedupe key went: the same content held again is a new hold, not the old id reopened.
    let again = hold(SLUG, "fp-1", "default");
    assert!(again > keeper);
    for (table, id) in [
        ("pages", "5"),
        ("facts", "9"),
        ("takes", "4"),
        ("write_gate_holds", &first.to_string()),
        ("write_gate_holds", &keeper.to_string()),
        ("pages", "6"),
        ("facts", "10"),
    ] {
        receipt(table, id);
    }
    // Ids are matched as text: "05" is not 5, and a hold id names only that hold.
    assert_eq!(
        store
            .delete_purged_page_gate_receipts(5, &[9], &[4], &[first.to_string(), "05".into()])
            .unwrap(),
        4
    );
    assert_eq!(
        store
            .delete_purged_page_gate_receipts(5, &[9], &[4], &[first.to_string()])
            .unwrap(),
        0
    );
    // The receipt of a re-opened receipt key can be written again.
    receipt("pages", "5");
    assert_eq!(
        store
            .delete_purged_page_gate_receipts(5, &[], &[], &[])
            .unwrap(),
        1
    );
}

// ------------------------------------------------------------------ facts and files

#[test]
fn page_facts_go_whole_in_their_source_only() {
    let (_dir, store) = brain("sweep-facts");
    let a = fact(&store, "default", Some(SLUG), 1, "Filed one");
    let b = fact(&store, "default", Some(SLUG), 2, "Filed two");
    let keeper = fact(&store, "default", Some("notes/keeper"), 1, "Kept");
    let other = fact(&store, "other", Some(SLUG), 1, "Other source");
    assert_eq!(
        store
            .delete_purged_page_facts("default", "notes/never")
            .unwrap(),
        0
    );
    assert_eq!(store.delete_purged_page_facts("nobody", SLUG).unwrap(), 0);
    assert_eq!(store.delete_purged_page_facts("default", SLUG).unwrap(), 2);
    assert_eq!(store.delete_purged_page_facts("default", SLUG).unwrap(), 0);
    let left = store
        .list_purge_claim_facts("default", "notes/keeper")
        .unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0]["id"].as_i64(), Some(keeper));
    assert_eq!(
        store.list_purge_claim_facts("other", SLUG).unwrap().len(),
        1
    );
    let _ = (a, b, other);
    assert_eq!(
        store
            .delete_purged_page_facts("default", "a\0b")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn files_go_by_page_or_by_slug_and_the_blobs_come_back_sorted() {
    let (_dir, store) = brain("sweep-files");
    let page = put(&store, SLUG);
    let keeper = put(&store, "notes/keeper");
    let file = |source: Option<&str>, slug: &str, page_id: Option<i64>, path: &str| {
        let spec: FileSpec = args(
            json!({ "source_id": source, "page_slug": slug, "page_id": page_id,
            "filename": path, "storage_path": path, "content_hash": format!("h-{path}"), "size_bytes": 1, "metadata": "{}" }),
        );
        store.upsert_file(&spec).unwrap();
    };
    file(None, SLUG, Some(page), "z/attached.png");
    file(None, SLUG, None, "a/detached.png");
    file(None, "notes/keeper", Some(keeper), "k/keeper.png");
    file(Some("other"), SLUG, None, "o/other.png");
    file(None, "notes/else", None, "e/else.png");
    assert!(
        store
            .delete_purged_page_files("default", "notes/never", 999)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .delete_purged_page_files("default", SLUG, page)
            .unwrap(),
        vec!["a/detached.png".to_string(), "z/attached.png".to_string()]
    );
    assert!(
        store
            .delete_purged_page_files("default", SLUG, page)
            .unwrap()
            .is_empty()
    );
    assert_eq!(store.list_files_for_page(&json!(page)).unwrap().len(), 0);
    assert_eq!(store.list_files_for_page(&json!(keeper)).unwrap().len(), 1);
}

// ------------------------------------------------------------------ segment storage

const STAGING: &str = "11111111-1111-4111-8111-111111111111";
const STAGING_2: &str = "22222222-2222-4222-8222-222222222222";

fn staging(id: &str, page_id: Option<i64>, client: &str, slug: &str) -> BodyStagingInput {
    args(json!({
        "id": id, "kind": "put", "principalKind": "local", "principalId": "cli",
        "clientRequestId": client, "sourceId": "default",
        "sourceIncarnation": "33333333-3333-4333-8333-333333333333", "slug": slug,
        "pageId": page_id, "mode": "replace", "baseRevision": null, "baseGeneration": 0,
        "declaredBytes": 10, "declaredSha256": null, "reservedBytes": 10,
        "idleExpiresAt": "2099-01-01T00:00:00.000Z", "hardExpiresAt": "2099-01-02T00:00:00.000Z",
    }))
}

fn row(
    page_id: i64,
    occurrence: i64,
    seq: i64,
    start: i64,
    body: &str,
    staging: &str,
) -> ManifestRow {
    args(json!({
        "pageId": page_id, "occurrenceId": occurrence, "genFrom": 1, "seq": seq, "region": "truth",
        "sourceId": "default", "sha256": sha(body), "byteStart": start, "byteLen": body.len(),
        "lineStart": 0, "lineCount": 1, "cutKind": "heading", "entryState": {"depth": 0},
        "protectedRegions": [], "factsSlots": [], "staticProjBytes": body.len(),
        "staticProjLines": 1, "outline": [], "dateMin": "2026-01-02", "dateMax": "2026-01-03",
        "hashState": sha("state"), "stagingId": staging,
    }))
}

/// A segmented page published at generation 1 from two texts, with the staging that published it.
fn published(store: &Store) -> i64 {
    let id = store
        .create_segmented_page_shell(
            SLUG,
            &args(json!({"type": "note", "title": SLUG})),
            &args(json!({"sourceId": "default"})),
        )
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    store
        .open_body_staging(&staging(
            STAGING,
            Some(id),
            "44444444-4444-4444-8444-444444444444",
            SLUG,
        ))
        .unwrap();
    store
        .stage_segment_texts(
            "default",
            &[text("one\n"), text("two\n")],
            &args(json!({"stagingId": STAGING})),
        )
        .unwrap();
    store
        .stage_manifest_rows(&[
            row(id, 1, 0, 0, "one\n", STAGING),
            row(id, 2, 1, 4, "two\n", STAGING),
        ])
        .unwrap();
    let flip: BodyFlipInput = args(json!({
        "pageId": id, "expectedGeneration": 0, "newGeneration": 1, "stagingId": STAGING,
        "closeOccurrences": [], "retireChunkOccurrences": [], "retireMaxRows": 1000,
        "body": { "content_hash": "hash-1", "body_bytes": 8, "truth_bytes": 8, "body_lines": 2,
            "segment_count": 2, "segmenter_version": 1, "truth_lead": "lead", "timeline_lead": "",
            "body_flags": {} },
        "meta": {"type": "note", "title": "Flipped"},
    }));
    store.flip_body_generation(&flip).unwrap();
    id
}

#[test]
fn a_page_delete_reads_its_shas_and_stagings_and_keeps_what_a_live_write_needs() {
    let (_dir, store) = brain("sweep-segments");
    let id = published(&store);
    // A create's staging with no page row, another page's live staging holding a text, and a text nothing names.
    store
        .open_body_staging(&staging(
            STAGING_2,
            None,
            "55555555-5555-4555-8555-555555555555",
            "notes/new",
        ))
        .unwrap();
    store
        .stage_segment_texts(
            "default",
            &[text("shared\n")],
            &args(json!({"stagingId": STAGING_2})),
        )
        .unwrap();
    store
        .stage_segment_texts("default", &[text("loose\n")], &Default::default())
        .unwrap();
    assert_eq!(store.count_page_manifest_rows(id).unwrap(), 2);
    assert_eq!(store.count_page_manifest_rows(-1).unwrap(), 0);
    let mut shas = vec![sha("one\n"), sha("two\n")];
    shas.sort();
    assert_eq!(
        store.list_page_segment_shas("default", SLUG, id).unwrap(),
        shas
    );
    assert!(
        store
            .list_page_segment_shas("other", SLUG, 999)
            .unwrap()
            .is_empty()
    );
    // The manifest names both texts: nothing deletes while the page exists.
    assert_eq!(
        store.delete_page_segment_texts("default", &shas).unwrap(),
        0
    );
    assert_eq!(store.delete_page_stagings("default", SLUG, id).unwrap(), 1);
    assert_eq!(store.delete_page_stagings("default", SLUG, id).unwrap(), 0);
    store.delete_page(SLUG, Some("default")).unwrap();
    assert_eq!(store.count_page_manifest_rows(id).unwrap(), 0);
    // The other staging is live and recorded "shared"; a text it needs stays.
    let all = vec![sha("one\n"), sha("two\n"), sha("shared\n"), sha("missing")];
    assert_eq!(store.delete_page_segment_texts("default", &all).unwrap(), 2);
    assert_eq!(
        store
            .delete_page_segment_texts("default", &["zz".to_string()])
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    let left = store
        .read_segment_texts("default", &[sha("one\n"), sha("shared\n"), sha("loose\n")])
        .unwrap();
    assert_eq!(left.len(), 2);
}

#[test]
fn the_claim_sweep_deletes_unreferenced_texts_that_hold_a_form_in_chunks() {
    let (_dir, store) = brain("sweep-claims");
    let id = published(&store);
    let texts = [
        "Alice likes tea\n",
        "nothing here\n",
        "An escaped alice \\| tea cell\n",
        "ALICE LIKES TEA, upper case\n",
    ];
    for t in texts {
        store
            .stage_segment_texts("default", &[text(t)], &Default::default())
            .unwrap();
    }
    // Another source's copy of the claim, and a live staging's text that holds it.
    store
        .stage_segment_texts(
            "other",
            &[text("alice likes tea elsewhere\n")],
            &Default::default(),
        )
        .unwrap();
    store
        .open_body_staging(&staging(
            STAGING_2,
            None,
            "55555555-5555-4555-8555-555555555555",
            "notes/new",
        ))
        .unwrap();
    store
        .stage_segment_texts(
            "default",
            &[text("a live staging holds alice likes tea\n")],
            &args(json!({"stagingId": STAGING_2})),
        )
        .unwrap();
    let forms = vec!["alice likes tea".to_string(), "alice \\| tea".to_string()];
    // A zero-byte chunk takes nothing; the cursor past every sha takes nothing and reports no last sha.
    let none = store
        .sweep_page_texts_for_claims("default", "", &forms, 0)
        .unwrap();
    assert_eq!(none, json!({ "last": null, "deleted": [] }));
    let past = store
        .sweep_page_texts_for_claims("default", &"ff".repeat(32), &forms, 1 << 22)
        .unwrap();
    assert_eq!(past, json!({ "last": null, "deleted": [] }));
    let swept = store
        .sweep_page_texts_for_claims("default", "", &forms, 1 << 22)
        .unwrap();
    let mut expected = vec![sha(texts[0]), sha(texts[2]), sha(texts[3])];
    expected.sort();
    assert_eq!(swept["deleted"], json!(expected));
    let mut chunk: Vec<String> = texts.iter().map(|t| sha(t)).collect();
    chunk.push(sha("a live staging holds alice likes tea\n"));
    chunk.sort();
    assert_eq!(
        swept["last"],
        json!(chunk.last().unwrap()),
        "the last sha of the chunk, the live staging's included"
    );
    // The manifest's texts, the clean text, the live staging's text and the other source's text stay.
    let remaining = store
        .read_segment_texts(
            "default",
            &[
                sha("one\n"),
                sha("two\n"),
                sha(texts[1]),
                sha("a live staging holds alice likes tea\n"),
                sha(texts[0]),
            ],
        )
        .unwrap();
    assert_eq!(remaining.len(), 4);
    assert_eq!(
        store
            .read_segment_texts("other", &[sha("alice likes tea elsewhere\n")])
            .unwrap()
            .len(),
        1
    );
    // A page's own texts are never claim-swept: they are named by its manifest.
    assert_eq!(store.count_page_manifest_rows(id).unwrap(), 2);
    // A text that is not UTF-8 refuses the sweep, as convert_from does.
    store
        .stage_segment_texts(
            "default",
            &[text_of(&[0xff, 0xfe, b'\n'])],
            &Default::default(),
        )
        .unwrap();
    assert_eq!(
        store
            .sweep_page_texts_for_claims("default", "", &forms, 1 << 22)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        store
            .sweep_page_texts_for_claims("default", "xyz", &forms, 1)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn the_claim_sweep_stops_a_chunk_at_the_byte_budget() {
    let (_dir, store) = brain("sweep-chunk");
    // Three 20-byte texts holding the claim. A 25-byte budget reads the first text (0 bytes before it) and the second
    // (20 before), and stops before the third (40 before): the sum before a text is the bytes of the shorter shas.
    let bodies = [
        "claim aaaa 000000000\n",
        "claim bbbb 000000000\n",
        "claim cccc 000000000\n",
    ];
    for b in bodies {
        store
            .stage_segment_texts("default", &[text(b)], &Default::default())
            .unwrap();
    }
    let mut ordered: Vec<String> = bodies.iter().map(|b| sha(b)).collect();
    ordered.sort();
    let forms = vec!["claim".to_string()];
    let first = store
        .sweep_page_texts_for_claims("default", "", &forms, 25)
        .unwrap();
    assert_eq!(
        first,
        json!({ "last": ordered[1], "deleted": [ordered[0], ordered[1]] })
    );
    let next = store
        .sweep_page_texts_for_claims("default", &ordered[1], &forms, 25)
        .unwrap();
    assert_eq!(next, json!({ "last": ordered[2], "deleted": [ordered[2]] }));
}

// ------------------------------------------------------------------ journal reads and slug stores

#[test]
fn journal_reads_of_an_empty_brain_and_bad_inputs() {
    let (_dir, store) = brain("sweep-journal");
    put(&store, SLUG);
    assert!(
        store
            .list_page_timeline_receipts("default", &[SLUG.to_string()], 10, "0", true)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .list_page_timeline_receipts("default", &[SLUG.to_string()], -1, "0", true)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        store
            .list_page_timeline_receipts("default", &[SLUG.to_string()], 1, "abc", true)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert!(
        store
            .list_requests_recording_reasons("default", SLUG)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_page_change_reasons("default", SLUG, 1)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_page_change_reasons("default", SLUG, -5)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn the_slug_store_scrub_counts_each_store_and_leaves_other_slugs_and_sources() {
    let (_dir, store) = brain("sweep-slugs");
    put(&store, SLUG);
    assert_eq!(
        store.delete_purged_slug_store_rows("default", &[]).unwrap(),
        json!({ "removed": {}, "secretStore": false })
    );
    let out = store
        .delete_purged_slug_store_rows("default", &[SLUG.to_string(), SLUG.to_string()])
        .unwrap();
    assert_eq!(
        out,
        json!({ "removed": { "take_proposals": 0, "open_loops": 0, "core_edit_notices": 0,
            "page_aliases": 0, "slug_aliases": 0, "slug_rename_history": 0 }, "secretStore": false })
    );
    // A notice on the slug is deleted and counted, the acknowledged one too; another slug's and another source's stay.
    let notice = |source: &str, slug: &str| -> u64 {
        let input = args(
            json!({ "sourceId": source, "slug": slug, "pageId": null, "revision": "r1",
            "baseRevision": null, "baseText": "before", "actor": "remote:agent" }),
        );
        store.insert_core_edit_notice(&input).unwrap()
    };
    let first = notice("default", SLUG);
    notice("default", SLUG);
    notice("default", "notes/b");
    notice("other", SLUG);
    store
        .ack_core_edit_notices("default", SLUG, Some(first as i64))
        .unwrap();
    let out = store
        .delete_purged_slug_store_rows("default", &[SLUG.to_string()])
        .unwrap();
    assert_eq!(out["removed"]["core_edit_notices"], 2);
    assert_eq!(out["removed"]["open_loops"], 0);
    assert_eq!(
        store.list_pending_core_edit_notices(None).unwrap().len(),
        2,
        "the other slug and the other source keep theirs"
    );
    assert_eq!(
        store
            .delete_purged_slug_store_rows("default", &["a\0".to_string()])
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}
