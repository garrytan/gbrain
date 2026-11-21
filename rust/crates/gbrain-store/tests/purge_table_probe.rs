//! The table probes of a fact purge receipt's swept inventory stores (`countPurgeProbe` on `files`, `open_loops`, `page_aliases`,
//! `write_gate_holds`, `trust_proposals` and the segmented-body stores; `facts/purge_probe.rs` `for_each_table_row`): the rows
//! that carry a needle in a probed column, within the source for a table that has one and brain-wide for one that has none,
//! counted at most `rows + 1`. The probed columns and flags are the ones `purgeProbeShape` sends.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::purge_plan::PurgeProbeArgs;
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const NEEDLE: &str = "harbor will reopen";
const CLAIM: &str = r#"Acme "raised" a Seed \ round"#;

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

/// The inventory's columns of each table, as `purgeProbeShape` sends them (a table's own probe list where it has one).
fn columns(table: &str) -> Vec<&'static str> {
    match table {
        "files" => vec![
            "source_id",
            "page_slug",
            "filename",
            "storage_path",
            "mime_type",
            "content_hash",
            "metadata",
        ],
        "open_loops" => vec![
            "source_id",
            "dedup_key",
            "loop_type",
            "counterparty_slug",
            "counterparty_source_id",
            "counterparty_email",
            "summary",
            "evidence",
            "thread_id",
            "page_slug",
            "status",
            "detector",
            "closed_by",
        ],
        "page_aliases" => vec!["source_id", "alias_norm", "slug", "origin", "alias_text"],
        "write_gate_holds" => vec![
            "kind",
            "source_id",
            "slug",
            "fingerprint",
            "payload",
            "write_origin",
            "tier",
            "reason_families",
            "reasons",
            "request_id",
            "status",
            "decided_by",
        ],
        "trust_proposals" => vec![
            "action",
            "source_id",
            "target_table",
            "related_table",
            "before_state",
            "after_state",
            "proposer",
            "proposer_principal_kind",
            "proposer_principal_id",
            "status",
            "decided_principal_kind",
            "decided_principal_id",
        ],
        "page_body_manifest" => vec![
            "region",
            "source_id",
            "sha256",
            "cut_kind",
            "entry_state",
            "protected_regions",
            "facts_slots",
            "outline",
            "hash_state",
        ],
        "page_body_stagings" => vec![
            "kind",
            "principal_kind",
            "principal_id",
            "source_id",
            "slug",
            "mode",
            "declared_sha256",
            "state",
        ],
        "page_body_staging_texts" => vec!["source_id", "sha256"],
        "page_segment_texts" => vec!["body"],
        "page_segment_derivations" => vec!["output", "receipt"],
        "derived_generations" => vec!["held_context", "proposal"],
        "derived_generation_items" => vec!["preimage"],
        "persistence_effects" => vec![
            "kind",
            "data",
            "state",
            "source_id",
            "error_code",
            "outcome",
            "recovery",
            "claim_owner",
        ],
        other => panic!("no columns for {other}"),
    }
}

/// A probe of `table` for `needle`, as the member sends it: a table with a `source_id` is scoped to it, the segment texts are bytes.
fn probe(table: &str, source: &str, needle: &str, rows: i64) -> PurgeProbeArgs {
    let unscoped = ["page_segment_derivations", "derived_generation_items"];
    args(json!({
        "table": table, "sourceId": source, "columns": columns(table),
        "needles": [{ "text": needle, "lower": needle.to_lowercase(),
            "escaped": serde_json::to_string(needle).unwrap().trim_matches('"').to_lowercase() }],
        "scoped": !unscoped.contains(&table), "binary": table == "page_segment_texts", "rows": rows,
    }))
}

fn count(store: &Store, table: &str, source: &str, needle: &str) -> i64 {
    store
        .count_purge_probe(&probe(table, source, needle, 100))
        .unwrap()
}

#[test]
fn files_loops_aliases_holds_and_proposals_are_counted_within_their_source() {
    let (_dir, store) = brain("purge-table-probe-slug-stores");
    let page: gbrain_store::pages::PageInput = args(
        json!({ "type": "note", "title": "Doomed", "compiled_truth": "body", "frontmatter": {} }),
    );
    store
        .put_page(
            "notes/doomed",
            &page,
            &gbrain_store::pages::PutPageOptions::default(),
        )
        .unwrap();
    for table in [
        "files",
        "open_loops",
        "page_aliases",
        "write_gate_holds",
        "trust_proposals",
    ] {
        assert_eq!(count(&store, table, "default", NEEDLE), 0, "{table}");
    }

    let file = |source: &str, name: &str, path: &str, metadata: Value| {
        let spec: gbrain_store::raw_files::FileSpec = args(json!({
            "source_id": source, "page_slug": "notes/doomed", "filename": name, "storage_path": path,
            "content_hash": path, "size_bytes": 1, "metadata": metadata.to_string(),
        }));
        store.upsert_file(&spec).unwrap();
    };
    file(
        "default",
        "The Harbor Will Reopen.png",
        "d/a.png",
        json!({}),
    );
    file("default", "b.png", "d/b.png", json!({ "caption": CLAIM }));
    file("default", "c.png", "d/c.png", json!({}));
    file("other", "the harbor will reopen.png", "o/d.png", json!({}));
    assert_eq!(count(&store, "files", "default", NEEDLE), 1);
    assert_eq!(count(&store, "files", "default", CLAIM), 1, "JSON-escaped");
    assert_eq!(count(&store, "files", "other", NEEDLE), 1);
    assert_eq!(count(&store, "files", "default", "never stated"), 0);
    assert_eq!(count(&store, "files", "nobody", NEEDLE), 0);
    // The source's own id is a probed column, so every row of the source matches; the count stops one past the bound.
    assert_eq!(count(&store, "files", "default", "default"), 3);
    assert_eq!(
        store
            .count_purge_probe(&probe("files", "default", "default", 1))
            .unwrap(),
        2
    );

    let at = "2026-03-01T10:00:00.000Z";
    let open_loop = |source: &str, key: &str, summary: &str, email: &str| {
        let loop_: gbrain_store::facts::loops::OpenLoopUpsert = args(json!({
            "sourceId": source, "dedupKey": key, "loopType": "commitment_owed_by_me",
            "counterpartyEmail": email, "summary": summary, "evidence": [], "detector": "manual",
            "lastActivityAt": at, "openedAt": at,
        }));
        store.upsert_open_loop(&loop_).unwrap();
    };
    open_loop(
        "default",
        "a",
        "The harbor will reopen in spring",
        "a@example.com",
    );
    open_loop(
        "default",
        "b",
        "Unrelated",
        "harbor.will.reopen@example.com",
    );
    open_loop("default", "c", "Unrelated", "a@example.com");
    open_loop(
        "other",
        "d",
        "The harbor will reopen in spring",
        "a@example.com",
    );
    assert_eq!(count(&store, "open_loops", "default", NEEDLE), 1);
    assert_eq!(
        count(&store, "open_loops", "default", "harbor.will.reopen"),
        1
    );
    assert_eq!(count(&store, "open_loops", "other", NEEDLE), 1);
    assert_eq!(
        count(&store, "open_loops", "default", "commitment_owed_by_me"),
        3
    );

    store
        .set_page_aliases(
            "notes/doomed",
            "default",
            &["the harbor will reopen".into(), "the quay".into()],
        )
        .unwrap();
    store
        .set_page_aliases("notes/doomed", "other", &["the harbor will reopen".into()])
        .unwrap();
    assert_eq!(count(&store, "page_aliases", "default", NEEDLE), 1);
    assert_eq!(count(&store, "page_aliases", "other", NEEDLE), 1);
    assert_eq!(count(&store, "page_aliases", "default", "frontmatter"), 2);
    assert_eq!(count(&store, "page_aliases", "default", "never stated"), 0);

    let hold = |source: &str, fingerprint: &str, payload: Value, reasons: Value| {
        let input: gbrain_store::trust::write_gate::HoldInput = args(json!({
            "kind": "fact", "source_id": source, "slug": "people/a", "fingerprint": fingerprint,
            "detector_version": 1, "tier": "agent_written", "reason_families": ["prompt_injection"],
            "reasons": reasons, "detector_error": false, "payload": payload, "write_origin": null,
            "request_id": null,
        }));
        store.upsert_write_gate_hold(input).unwrap();
    };
    let ignore = json!(["ignore previous instructions"]);
    hold(
        "default",
        "p",
        json!({ "fact": "The harbor will reopen" }),
        ignore.clone(),
    );
    hold(
        "default",
        "r",
        json!({ "fact": "Nothing" }),
        json!(["the harbor will reopen"]),
    );
    hold("default", "c", json!({ "fact": "Nothing" }), ignore.clone());
    hold(
        "other",
        "o",
        json!({ "fact": "The harbor will reopen" }),
        ignore,
    );
    assert_eq!(count(&store, "write_gate_holds", "default", NEEDLE), 2);
    assert_eq!(count(&store, "write_gate_holds", "other", NEEDLE), 1);
    // A text array reads as its Postgres literal.
    assert_eq!(
        count(&store, "write_gate_holds", "default", "{prompt_injection}"),
        3
    );

    let mut related = 1000;
    let mut proposal = |source: &str, before: Value, proposer: &str| {
        related += 1;
        let input: gbrain_store::trust::proposals::NewProposal = args(json!({
            "action": "supersede_fact", "sourceId": source, "target": { "table": "facts", "id": 1 },
            "related": { "table": "facts", "id": related }, "before": before, "proposer": proposer,
        }));
        store.insert_trust_proposal(&input).unwrap();
    };
    proposal("default", json!({ "note": CLAIM }), "parity");
    proposal(
        "default",
        json!({ "note": "nothing" }),
        "harbor will reopen guard",
    );
    proposal("default", json!({ "note": "nothing" }), "clean");
    proposal(
        "other",
        json!({ "note": "the harbor will reopen" }),
        "parity",
    );
    assert_eq!(
        count(&store, "trust_proposals", "default", CLAIM),
        1,
        "JSON-escaped"
    );
    assert_eq!(count(&store, "trust_proposals", "default", NEEDLE), 1);
    assert_eq!(count(&store, "trust_proposals", "other", NEEDLE), 1);
    assert_eq!(count(&store, "trust_proposals", "default", "pending"), 3);
}

#[test]
fn the_segmented_body_stores_are_counted_by_text_hex_and_bytes() {
    let (_dir, store) = brain("purge-table-probe-body");
    let shell = |slug: &str, source: &str| -> i64 {
        let meta: gbrain_store::page_body::SegmentedPageMeta =
            args(json!({ "type": "note", "title": slug }));
        store
            .create_segmented_page_shell(slug, &meta, &args(json!({ "sourceId": source })))
            .unwrap()["id"]
            .as_i64()
            .unwrap()
    };
    let staging = |id: &str, page: Option<i64>, client: &str, source: &str, slug: &str| {
        let input: gbrain_store::page_body::BodyStagingInput = args(json!({
            "id": id, "kind": "put", "principalKind": "local", "principalId": "cli",
            "clientRequestId": client, "sourceId": source,
            "sourceIncarnation": "33333333-3333-4333-8333-333333333333", "slug": slug,
            "pageId": page, "mode": "replace", "baseRevision": null, "baseGeneration": 0,
            "declaredBytes": 10, "declaredSha256": sha("declared"), "reservedBytes": 10,
            "idleExpiresAt": "2099-01-01T00:00:00.000Z", "hardExpiresAt": "2099-01-02T00:00:00.000Z",
        }));
        store.open_body_staging(&input).unwrap();
    };
    let text = |source: &str, body: &str, staging_id: &str| {
        let input: gbrain_store::page_body::SegmentTextInput = args(json!({
            "sha256": sha(body), "body": hex(body.as_bytes()), "lineCount": 2,
        }));
        store
            .stage_segment_texts(source, &[input], &args(json!({ "stagingId": staging_id })))
            .unwrap();
    };
    let manifest = |page: i64, source: &str, body: &str, staging_id: &str| {
        let row: gbrain_store::page_body::ManifestRow = args(json!({
            "pageId": page, "occurrenceId": 1, "genFrom": 1, "seq": 0, "region": "truth",
            "sourceId": source, "sha256": sha(body), "byteStart": 0, "byteLen": body.len(),
            "lineStart": 0, "lineCount": 1, "cutKind": "heading", "entryState": { "heading": ["Intro"] },
            "protectedRegions": [], "factsSlots": [], "staticProjBytes": body.len(),
            "staticProjLines": 1, "outline": [{ "text": "Intro" }], "dateMin": "2026-01-02",
            "dateMax": "2026-01-03", "hashState": sha("state"), "stagingId": staging_id,
        }));
        store.stage_manifest_rows(&[row]).unwrap();
    };
    let own = "# Intro\nThe harbor will reopen in spring\n";
    let away = "# Elsewhere\nA page of another source\n";
    let (first, second) = (
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
    );
    let page = shell("notes/seg", "default");
    staging(
        first,
        Some(page),
        "44444444-4444-4444-8444-444444444444",
        "default",
        "notes/seg",
    );
    text("default", own, first);
    manifest(page, "default", own, first);
    let other_page = shell("notes/seg-away", "other");
    staging(
        second,
        Some(other_page),
        "55555555-5555-4555-8555-555555555555",
        "other",
        "notes/seg-away",
    );
    text("other", away, second);
    manifest(other_page, "other", away, second);
    let derivation = |page: i64, sha_hex: &str, output: Value, receipt: Value| {
        let row: gbrain_store::page_body::SegmentDerivationInput = args(json!({
            "pageId": page, "kind": "links", "occurrenceId": 1, "version": 1, "segmentSha256": sha_hex,
            "contextHash": sha("ctx"), "state": "done", "output": output, "receipt": receipt,
        }));
        store.upsert_segment_derivations(&[row]).unwrap();
    };
    derivation(
        page,
        &sha(own),
        json!({ "excerpt": "Today the Harbor will reopen" }),
        json!({}),
    );
    derivation(other_page, &sha(away), json!({}), json!({ "found": CLAIM }));

    assert_eq!(count(&store, "page_body_manifest", "default", "truth"), 1);
    assert_eq!(
        count(&store, "page_body_manifest", "default", "intro"),
        1,
        "jsonb text"
    );
    assert_eq!(
        count(&store, "page_body_manifest", "default", &sha(own)),
        1,
        "bytea text"
    );
    assert_eq!(count(&store, "page_body_manifest", "other", "truth"), 1);
    assert_eq!(count(&store, "page_body_manifest", "default", "heading"), 1);
    assert_eq!(
        count(&store, "page_body_stagings", "default", "notes/seg"),
        1
    );
    assert_eq!(
        count(&store, "page_body_stagings", "default", &sha("declared")),
        1
    );
    assert_eq!(
        count(&store, "page_body_stagings", "default", "notes/seg-away"),
        0
    );
    assert_eq!(
        count(&store, "page_body_stagings", "other", "notes/seg-away"),
        1
    );
    assert_eq!(
        count(&store, "page_body_staging_texts", "default", &sha(own)),
        1
    );
    assert_eq!(
        count(&store, "page_body_staging_texts", "default", "default"),
        1
    );
    assert_eq!(
        count(&store, "page_body_staging_texts", "other", &sha(own)),
        0
    );
    // Segment texts are bytes: the case of a needle matters.
    assert_eq!(count(&store, "page_segment_texts", "default", NEEDLE), 1);
    assert_eq!(
        count(
            &store,
            "page_segment_texts",
            "default",
            &NEEDLE.to_uppercase()
        ),
        0
    );
    assert_eq!(
        count(&store, "page_segment_texts", "default", "another source"),
        0
    );
    assert_eq!(
        count(&store, "page_segment_texts", "other", "another source"),
        1
    );
    // Derivation results have no source: the probe is brain-wide.
    assert_eq!(
        count(&store, "page_segment_derivations", "default", NEEDLE),
        1
    );
    assert_eq!(
        count(&store, "page_segment_derivations", "default", CLAIM),
        1,
        "JSON-escaped"
    );
    assert_eq!(
        count(&store, "page_segment_derivations", "nobody", CLAIM),
        1
    );
    assert_eq!(
        count(
            &store,
            "page_segment_derivations",
            "default",
            "never stated"
        ),
        0
    );

    // The stores this brain holds nothing in, or keeps no row of, find nothing; an inventory table the store does not probe refuses.
    for table in [
        "derived_generations",
        "derived_generation_items",
        "persistence_effects",
    ] {
        assert_eq!(count(&store, table, "default", "default"), 0, "{table}");
    }
    let mut missing = probe("files", "default", NEEDLE, 1);
    missing.table = "retrieval_feedback".into();
    assert!(store.count_purge_probe(&missing).is_err());
}

#[test]
fn the_claims_of_a_derivation_probe_are_normalized_and_folded_distinct_and_never_empty() {
    let (_dir, store) = brain("purge-table-probe-forms");
    let forms = |claims: Value| -> Vec<String> {
        let q: gbrain_store::facts::purge_plan::DerivationClaimsArgs =
            args(json!({ "claims": claims }));
        store.list_derivation_claim_forms(&q).unwrap()
    };
    assert_eq!(
        forms(json!([
            "Alice  likes TEA.",
            "alice likes tea",
            "Hello, World! (v2.0)"
        ])),
        ["alice likes tea", "hello world v2.0"]
    );
    // A final sigma reads as sigma; the dot a lowered dotted capital I keeps is dropped.
    assert_eq!(
        forms(json!(["ΚΩΣΤΑΣ", "İstanbul calling", "Straße 42"])),
        ["istanbul calling", "straße 42", "κωστασ"]
    );
    assert!(forms(json!([])).is_empty());
    assert!(forms(json!(["", "...", "  "])).is_empty());
    let nul: gbrain_store::facts::purge_plan::DerivationClaimsArgs =
        args(json!({ "claims": ["a\u{0}b"] }));
    assert!(store.list_derivation_claim_forms(&nul).is_err());
}

/// A page published at generation 1 from three staged texts, with four stored derivation results: the first backed by its live
/// segment and holding the claim in a longer excerpt, the second backed by none and holding it, the third a word apart from it, the
/// fourth of another pipeline with no claim.
fn derived_page(store: &Store) -> (i64, [String; 3]) {
    let texts = [
        "# One\nfirst segment\n",
        "## Two\nsecond segment\n",
        "## Three\nthird segment\n",
    ];
    let meta: gbrain_store::page_body::SegmentedPageMeta =
        args(json!({ "type": "note", "title": "A" }));
    let page = store
        .create_segmented_page_shell("notes/a", &meta, &args(json!({ "sourceId": "default" })))
        .unwrap()["id"]
        .as_i64()
        .unwrap();
    let staging = "11111111-1111-4111-8111-111111111111";
    let input: gbrain_store::page_body::BodyStagingInput = args(json!({
        "id": staging, "kind": "put", "principalKind": "local", "principalId": "cli",
        "clientRequestId": "44444444-4444-4444-8444-444444444444", "sourceId": "default",
        "sourceIncarnation": "33333333-3333-4333-8333-333333333333", "slug": "notes/a", "pageId": page,
        "mode": "replace", "baseRevision": null, "baseGeneration": 0, "declaredBytes": 10,
        "declaredSha256": null, "reservedBytes": 10, "idleExpiresAt": "2099-01-01T00:00:00.000Z",
        "hardExpiresAt": "2099-01-02T00:00:00.000Z",
    }));
    store.open_body_staging(&input).unwrap();
    let inputs: Vec<gbrain_store::page_body::SegmentTextInput> = texts
        .iter()
        .map(|t| args(json!({ "sha256": sha(t), "body": hex(t.as_bytes()), "lineCount": 2 })))
        .collect();
    store
        .stage_segment_texts("default", &inputs, &args(json!({ "stagingId": staging })))
        .unwrap();
    let mut start = 0;
    let rows: Vec<gbrain_store::page_body::ManifestRow> = texts
        .iter()
        .enumerate()
        .map(|(n, t)| {
            let at = start;
            start += t.len();
            args(json!({
                "pageId": page, "occurrenceId": n + 1, "genFrom": 1, "seq": n, "region": "truth",
                "sourceId": "default", "sha256": sha(t), "byteStart": at, "byteLen": t.len(),
                "lineStart": 0, "lineCount": 2, "cutKind": "heading", "entryState": { "depth": 0 },
                "protectedRegions": [], "factsSlots": [], "staticProjBytes": t.len(),
                "staticProjLines": 2, "outline": [], "dateMin": null, "dateMax": null,
                "hashState": sha("state"), "stagingId": staging,
            }))
        })
        .collect();
    store.stage_manifest_rows(&rows).unwrap();
    let flip: gbrain_store::page_body::BodyFlipInput = args(json!({
        "pageId": page, "expectedGeneration": 0, "newGeneration": 1, "stagingId": staging,
        "closeOccurrences": [], "retireChunkOccurrences": [], "retireMaxRows": 1000,
        "body": { "content_hash": "hash-1", "body_bytes": start, "truth_bytes": start, "body_lines": 6,
            "segment_count": 3, "segmenter_version": 1, "truth_lead": "lead", "timeline_lead": "",
            "body_flags": {} },
        "meta": { "type": "note", "title": "Flipped" },
    }));
    store.flip_body_generation(&flip).unwrap();
    let derivation = |kind: &str, occurrence: i64, segment: &str, output: Value| {
        let row: gbrain_store::page_body::SegmentDerivationInput = args(json!({
            "pageId": page, "kind": kind, "occurrenceId": occurrence, "version": 1,
            "segmentSha256": segment, "contextHash": sha("ctx"), "state": "done", "output": output,
        }));
        store.upsert_segment_derivations(&[row]).unwrap();
    };
    derivation(
        "links",
        1,
        &sha(texts[0]),
        json!({ "links": [{ "excerpt": "Today ALICE likes   tea at noon" }] }),
    );
    derivation(
        "links",
        2,
        &sha("a segment since rewritten"),
        json!(["Alice likes tea"]),
    );
    derivation(
        "links",
        3,
        &sha(texts[2]),
        json!({ "note": "Alice likes teas" }),
    );
    derivation("timeline", 3, &sha(texts[2]), json!({ "dates": 1 }));
    (page, texts.map(String::from))
}

#[test]
fn the_derivation_probe_walks_batches_from_a_cursor_and_tells_swept_from_kept() {
    let (_dir, store) = brain("purge-table-probe-derivations");
    let (page, _) = derived_page(&store);
    let batch = |source: &str, pages: Value, cursor: Value, rows: i64| -> Value {
        let q: gbrain_store::page_body::purge_probe::DerivationProbeArgs = args(json!({
            "sourceId": source, "needles": [" alice likes tea "], "pageIds": pages,
            "patterns": ["%alice%likes%tea%"], "cursor": cursor, "rows": rows,
        }));
        store.probe_purge_derivations(&q).unwrap()
    };
    let whole = batch("default", json!([]), Value::Null, 100);
    assert_eq!(
        (
            whole["scanned"].as_i64(),
            whole["normalized"].as_i64(),
            whole["swept"].as_i64(),
            whole["kept"].as_i64()
        ),
        (Some(4), Some(3), Some(1), Some(1)),
        "{whole}"
    );
    assert_eq!(whole["last_pipeline"], "timeline");
    assert_eq!(whole["last_occurrence"], "3");
    // A page the purge rewrote is swept whole.
    let rewritten = batch("default", json!([page]), Value::Null, 100);
    assert_eq!(
        (rewritten["swept"].as_i64(), rewritten["kept"].as_i64()),
        (Some(2), Some(0))
    );
    // Two at a time, each batch from the key the last one ended on.
    let first = batch("default", json!([]), Value::Null, 2);
    assert_eq!(
        (
            first["scanned"].as_i64(),
            first["last_pipeline"].as_str(),
            first["last_occurrence"].as_str()
        ),
        (Some(2), Some("links"), Some("2"))
    );
    let cursor = json!({ "page": first["last_page"], "pipeline": first["last_pipeline"], "occurrence": first["last_occurrence"] });
    let second = batch("default", json!([]), cursor, 2);
    assert_eq!(
        (
            second["scanned"].as_i64(),
            second["last_pipeline"].as_str(),
            second["last_occurrence"].as_str()
        ),
        (Some(2), Some("timeline"), Some("3"))
    );
    let past = json!({ "page": page, "pipeline": "timeline", "occurrence": "3" });
    let end = batch("default", json!([]), past, 100);
    assert_eq!(
        (end["scanned"].as_i64(), end["last_page"].clone()),
        (Some(0), Value::Null)
    );
    assert_eq!(batch("other", json!([]), Value::Null, 100)["scanned"], 0);
    assert_eq!(batch("default", json!([]), Value::Null, 0)["scanned"], 0);
    // A needle the rows never hold passes the prefilter for none.
    let q: gbrain_store::page_body::purge_probe::DerivationProbeArgs = args(json!({
        "sourceId": "default", "needles": [" bob likes tea "], "pageIds": [], "patterns": ["%bob%likes%tea%"], "rows": 100,
    }));
    let none = store.probe_purge_derivations(&q).unwrap();
    assert_eq!(
        (none["scanned"].as_i64(), none["normalized"].as_i64()),
        (Some(4), Some(0))
    );
}

#[test]
fn a_derivation_with_no_output_or_receipt_is_sql_null_and_a_nested_null_is_the_text_null() {
    let (_dir, store) = brain("purge-table-probe-null-derivations");
    let (page, texts) = derived_page(&store);
    let derivation = |occurrence: i64, output: Value, receipt: Value| {
        let row: gbrain_store::page_body::SegmentDerivationInput = args(json!({
            "pageId": page, "kind": "mentions", "occurrenceId": occurrence, "version": 1,
            "segmentSha256": sha(&texts[0]), "contextHash": sha("ctx"), "state": "done",
            "output": output, "receipt": receipt,
        }));
        store.upsert_segment_derivations(&[row]).unwrap();
    };
    // Neither written, and a top-level JSON null: SQL NULL. A null inside a document: text.
    let omitted: gbrain_store::page_body::SegmentDerivationInput = args(json!({
        "pageId": page, "kind": "mentions", "occurrenceId": 1, "version": 1,
        "segmentSha256": sha(&texts[0]), "contextHash": sha("ctx"), "state": "done",
    }));
    store.upsert_segment_derivations(&[omitted]).unwrap();
    derivation(2, Value::Null, Value::Null);
    assert_eq!(
        count(&store, "page_segment_derivations", "default", "null"),
        0
    );
    derivation(3, json!({ "note": null }), json!({}));
    assert_eq!(
        count(&store, "page_segment_derivations", "default", "null"),
        1
    );
    let batch = |needle: &str| -> Value {
        let q: gbrain_store::page_body::purge_probe::DerivationProbeArgs = args(json!({
            "sourceId": "default", "needles": [format!(" {needle} ")], "pageIds": [],
            "patterns": [format!("%{needle}%")], "rows": 100,
        }));
        store.probe_purge_derivations(&q).unwrap()
    };
    // Seven rows: the four of derived_page, then the three here (the first two empty).
    let nulls = batch("null");
    assert_eq!(
        (nulls["scanned"].as_i64(), nulls["normalized"].as_i64()),
        (Some(7), Some(1)),
        "{nulls}"
    );
}
