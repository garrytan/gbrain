//! The page-state, body-tiling, ontology-fact and derivation-receipt doctor reads
//! (`cli_reads/doctor_derived_health.rs`, `cli_reads/doctor_derived_ledgers.rs`): the PGLite
//! semantics of each, on rows the typed writers make.

mod memory_env;

use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::facts::repair_previews::SourcesArgs;
use gbrain_store::page_body::{
    BodyFlipInput, BodyStagingInput, ManifestRow, SegmentDerivationInput, SegmentTextInput,
    SegmentedPageMeta,
};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, T0, brain};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU32, Ordering};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn put(b: &Brain, slug: &str, page_type: &str, extra: Value) -> i64 {
    let mut input =
        json!({ "type": page_type, "title": slug, "compiled_truth": format!("{slug} body") });
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let input: PageInput = args(input);
    let options = PutPageOptions {
        index: Some(false),
        ..PutPageOptions::default()
    };
    b.put_page(slug, &input, &options).unwrap()["id"]
        .as_i64()
        .unwrap()
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

// ---- readAtomProvenanceCounts -------------------------------------------------------------------

#[test]
fn atom_provenance_counts_drifted_atoms_by_their_source_page() {
    let b = brain("derived-health-provenance");
    let empty = json!({ "total": 0, "slug_unbound": 0, "drifted": 0, "source_changed": 0, "source_gone": 0, "oldest_ext": null });
    assert_eq!(b.read_atom_provenance_counts().unwrap(), empty);
    put(
        &b,
        "notes/origin",
        "note",
        json!({ "content_hash": "abcdef0123456789ffff" }),
    );
    put(&b, "notes/gone", "note", json!({}));
    let atom = |slug: &str, fm: Value| put(&b, slug, "atom", json!({ "frontmatter": fm }));
    // Bound to a live source whose hash matches: not drifted.
    atom(
        "atoms/ok",
        json!({ "source_slug": "notes/origin", "source_hash": "abcdef0123456789" }),
    );
    // Bound to a live source whose hash moved: source_changed.
    atom(
        "atoms/changed",
        json!({ "source_slug": "notes/origin", "source_hash": "0000000000000000", "extracted_at": "2026-03-04T00:00:00Z" }),
    );
    // Bound to a source that is gone: source_gone.
    atom(
        "atoms/gone",
        json!({ "source_slug": "notes/missing", "source_hash": "1111111111111111", "extracted_at": "2026-01-02T00:00:00Z" }),
    );
    // No source slug: unbound, not counted in total.
    atom(
        "atoms/unbound",
        json!({ "source_hash": "2222222222222222" }),
    );
    // A pending marker counts only on a managed atom.
    atom(
        "atoms/pending",
        json!({ "source_slug": "notes/origin", "source_hash": "pending:3333333333333333" }),
    );
    atom(
        "atoms/managed",
        json!({ "source_slug": "notes/origin", "source_hash": "pending:abcdef0123456789", "managed_extraction": "true" }),
    );
    // No hash at all: left out.
    atom("atoms/nohash", json!({ "source_slug": "notes/origin" }));
    assert_eq!(
        b.read_atom_provenance_counts().unwrap(),
        json!({ "total": 4, "slug_unbound": 1, "drifted": 2, "source_changed": 1, "source_gone": 1, "oldest_ext": "2026-01-02T00:00:00Z" })
    );
    b.soft_delete_page("atoms/gone", None).unwrap();
    assert_eq!(
        b.read_atom_provenance_counts().unwrap()["source_gone"],
        json!(0)
    );
}

// ---- countDerivedVisibility ---------------------------------------------------------------------

#[test]
fn derived_visibility_counts_unstamped_and_looser_derived_pages() {
    let b = brain("derived-health-visibility");
    let sources = strings(&["default"]);
    let zero = json!({ "unstamped_atoms": 0, "unstamped_concepts": 0, "looser_atoms": 0, "looser_concepts": 0, "looser_events": 0, "alias_pages_without_visibility": 0 });
    assert_eq!(b.count_derived_visibility(&sources).unwrap(), zero);
    put(
        &b,
        "notes/open",
        "note",
        json!({ "frontmatter": { "visibility": "world" } }),
    );
    put(
        &b,
        "notes/closed",
        "note",
        json!({ "frontmatter": { "visibility": "private" } }),
    );
    put(
        &b,
        "notes/label",
        "note",
        json!({ "frontmatter": { "access": "private" } }),
    );
    put(&b, "atoms/unstamped", "atom", json!({}));
    put(
        &b,
        "atoms/fine",
        "atom",
        json!({ "frontmatter": { "visibility": "world", "source_slug": "notes/open" } }),
    );
    put(
        &b,
        "atoms/orphan",
        "atom",
        json!({ "frontmatter": { "visibility": "world", "source_slug": "notes/missing" } }),
    );
    put(
        &b,
        "atoms/hidden",
        "atom",
        json!({ "frontmatter": { "visibility": "world", "source_slug": "notes/closed" } }),
    );
    put(
        &b,
        "concepts/unstamped",
        "concept",
        json!({ "frontmatter": { "synthesized_by": "dream" } }),
    );
    put(&b, "concepts/plain", "concept", json!({}));
    put(
        &b,
        "events/chronicle",
        "event",
        json!({ "frontmatter": { "captured_via": "life-chronicle:x", "event": { "depth": "notes/closed" } } }),
    );
    assert_eq!(
        b.count_derived_visibility(&sources).unwrap(),
        json!({ "unstamped_atoms": 1, "unstamped_concepts": 1, "looser_atoms": 2, "looser_concepts": 0, "looser_events": 1, "alias_pages_without_visibility": 1 })
    );
    assert_eq!(
        b.count_derived_visibility(&strings(&["nowhere"])).unwrap(),
        zero
    );
}

// ---- readEmbeddingBacklogAge --------------------------------------------------------------------

#[test]
fn backlog_age_reads_the_oldest_pending_chunk_without_a_vector() {
    let b = brain("derived-health-backlog");
    b.clock.set(T0);
    assert_eq!(
        b.read_embedding_backlog_age("embedding").unwrap(),
        json!({ "age_s": null, "unaged": 0, "backfilled": null })
    );
    let chunk = |text: &str| -> ChunkInput {
        args(json!({ "chunk_index": 0, "chunk_text": text, "chunk_source": "compiled_truth" }))
    };
    put(&b, "notes/a", "note", json!({}));
    put(
        &b,
        "notes/skipped",
        "note",
        json!({ "frontmatter": { "embed_skip": true } }),
    );
    let options = UpsertChunksOptions::default();
    b.upsert_chunks("notes/a", &[chunk("alpha")], &options)
        .unwrap();
    b.clock.advance(90_000_000);
    b.upsert_chunks("notes/skipped", &[chunk("beta")], &options)
        .unwrap();
    let row = b.read_embedding_backlog_age("embedding").unwrap();
    // The skipped page does not count, so the oldest pending chunk is `notes/a` from 90 s ago.
    assert_eq!(
        row,
        json!({ "age_s": 90.0, "unaged": 0, "backfilled": null })
    );
}

// ---- countCredentialProjectionPending -----------------------------------------------------------

#[test]
fn credential_pending_counts_key_blocks_behind_their_projection() {
    let b = brain("derived-health-credential");
    let key = concat!(
        "-----BEGIN ",
        "RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"
    );
    assert_eq!(
        b.count_credential_projection_pending(None).unwrap(),
        json!({ "rebuildable": 0, "kept": 0 })
    );
    put(&b, "notes/key", "note", json!({ "compiled_truth": key }));
    put(&b, "notes/timeline-key", "note", json!({ "timeline": key }));
    put(&b, "notes/plain", "note", json!({}));
    put(
        &b,
        "notes/pub",
        "note",
        json!({ "compiled_truth": concat!("-----BEGIN ", "PUBLIC KEY-----") }),
    );
    put(&b, "notes/gone", "note", json!({ "compiled_truth": key }));
    b.soft_delete_page("notes/gone", None).unwrap();
    let all = b.count_credential_projection_pending(None).unwrap();
    assert_eq!(
        all["rebuildable"].as_u64().unwrap() + all["kept"].as_u64().unwrap(),
        2
    );
    assert_eq!(
        b.count_credential_projection_pending(Some(&strings(&["default"])))
            .unwrap(),
        all
    );
    assert_eq!(
        b.count_credential_projection_pending(Some(&strings(&["nowhere"])))
            .unwrap(),
        json!({ "rebuildable": 0, "kept": 0 })
    );
}

// ---- readIgnoredPrivacyLabelCounts --------------------------------------------------------------

#[test]
fn ignored_labels_group_by_key_and_value() {
    let b = brain("derived-health-labels");
    assert!(
        b.read_ignored_privacy_label_counts(None)
            .unwrap()
            .is_empty()
    );
    put(
        &b,
        "notes/a",
        "note",
        json!({ "frontmatter": { "access": "secret" } }),
    );
    put(
        &b,
        "notes/b",
        "note",
        json!({ "frontmatter": { "access": "secret", "confidentiality": "internal" } }),
    );
    put(
        &b,
        "notes/c",
        "note",
        json!({ "frontmatter": { "access": "internal" } }),
    );
    put(
        &b,
        "notes/typed",
        "note",
        json!({ "frontmatter": { "access": "private", "visibility": "private" } }),
    );
    put(
        &b,
        "notes/blank",
        "note",
        json!({ "frontmatter": { "access": "  " } }),
    );
    put(&b, "notes/plain", "note", json!({}));
    put(
        &b,
        "atoms/x",
        "atom",
        json!({ "frontmatter": { "access": "secret" } }),
    );
    let rows = b.read_ignored_privacy_label_counts(None).unwrap();
    assert_eq!(
        rows,
        vec![
            json!({ "key": "access", "raw": "secret", "is_string": true, "pages": 2, "scanned": 3, "groups": 3 }),
            json!({ "key": "access", "raw": "internal", "is_string": true, "pages": 1, "scanned": 3, "groups": 3 }),
            json!({ "key": "confidentiality", "raw": "internal", "is_string": true, "pages": 1, "scanned": 3, "groups": 3 }),
        ]
    );
    assert_eq!(
        b.read_ignored_privacy_label_counts(Some(&strings(&["default"])))
            .unwrap(),
        rows
    );
    assert!(
        b.read_ignored_privacy_label_counts(Some(&strings(&["nowhere"])))
            .unwrap()
            .is_empty()
    );
}

// ---- listUntiledSegmentedPageRows ---------------------------------------------------------------

static NEXT_STAGING: AtomicU32 = AtomicU32::new(1);

fn segmented(b: &Brain, slug: &str, texts: &[&str]) -> i64 {
    let n = NEXT_STAGING.fetch_add(1, Ordering::Relaxed);
    let staging_id = format!("{n:08x}-1111-4111-8111-111111111111");
    let client_id = format!("{n:08x}-4444-4444-8444-444444444444");
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
    let staged: Vec<SegmentTextInput> = texts
        .iter()
        .map(|t| args(json!({ "sha256": hash(t), "body": hex(t), "lineCount": 1 })))
        .collect();
    b.stage_segment_texts(
        "default",
        &staged,
        &args(json!({ "stagingId": staging_id })),
    )
    .unwrap();
    let mut start = 0usize;
    let rows: Vec<ManifestRow> = texts
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let row = args(json!({
                "pageId": id, "occurrenceId": i + 1, "genFrom": 1, "seq": i, "region": "truth",
                "sourceId": "default", "sha256": hash(t), "byteStart": start, "byteLen": t.len(),
                "lineStart": 0, "lineCount": 1, "cutKind": "heading", "entryState": {"depth": 0},
                "protectedRegions": if t.contains("PRIVATE KEY") { json!([{ "kind": "pem", "byteStart": 0, "byteLen": 4 }]) } else { json!([]) },
                "factsSlots": [], "staticProjBytes": t.len(), "staticProjLines": 1, "outline": [],
                "dateMin": "2026-01-02", "dateMax": "2026-01-03", "hashState": hash("state"),
                "stagingId": staging_id,
            }));
            start += t.len();
            row
        })
        .collect();
    b.stage_manifest_rows(&rows).unwrap();
    let flip: BodyFlipInput = args(json!({
        "pageId": id, "expectedGeneration": 0, "newGeneration": 1, "stagingId": staging_id,
        "closeOccurrences": [], "retireChunkOccurrences": [], "retireMaxRows": 1000,
        "body": {
            "content_hash": "hash-1", "body_bytes": start, "truth_bytes": start, "body_lines": 2,
            "segment_count": texts.len(), "segmenter_version": 1, "truth_lead": "lead",
            "timeline_lead": "", "body_flags": {},
        },
        "meta": {"type": "note", "title": slug},
    }));
    b.flip_body_generation(&flip).unwrap();
    id
}

#[test]
fn untiled_rows_are_empty_while_every_published_body_tiles() {
    // `flipBodyGeneration` refuses a body its rows do not tile, so a typed writer cannot make an
    // untiled page; the read sees a tiled one as fine and an inline page as not segmented.
    let b = brain("derived-health-untiled");
    assert!(
        b.list_untiled_segmented_page_rows(None, None, 10)
            .unwrap()
            .is_empty()
    );
    segmented(&b, "notes/seg", &["one\n", "two\n"]);
    put(&b, "notes/inline", "note", json!({}));
    assert!(
        b.list_untiled_segmented_page_rows(None, None, 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        b.list_untiled_segmented_page_rows(
            Some(&strings(&["default"])),
            Some(&strings(&["notes/seg"])),
            10
        )
        .unwrap()
        .is_empty()
    );
}

#[test]
fn a_segmented_page_with_a_key_block_counts_as_credential_pending() {
    let b = brain("derived-health-segmented-key");
    segmented(
        &b,
        "notes/seg-key",
        &["x\n", concat!("-----BEGIN ", "PRIVATE KEY-----\n")],
    );
    segmented(&b, "notes/seg-plain", &["x\n"]);
    let row = b.count_credential_projection_pending(None).unwrap();
    // Both pages are behind their projection; only the one with a published pem region holds a key.
    assert_eq!(
        row["rebuildable"].as_u64().unwrap() + row["kept"].as_u64().unwrap(),
        1
    );
}

// ---- listOntologyFactCandidates -----------------------------------------------------------------

#[test]
fn ontology_candidates_carry_their_verdicts() {
    let b = brain("derived-health-ontology");
    b.upsert_source(&SourceInput {
        id: "other".into(),
        name: Some("other".into()),
        ..SourceInput::default()
    })
    .unwrap();
    assert!(
        b.list_ontology_fact_candidates(&args::<SourcesArgs>(json!({ "sourceIds": ["default"] })))
            .unwrap()
            .is_empty()
    );
    let insert = |source: &str, rows: Value| {
        b.insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": rows, "sourceId": source }),
        ))
        .unwrap()
    };
    let row = |fact: &str, source: &str, row_num: Value, extra: Value| {
        let mut r = json!({
            "fact": fact, "kind": "fact", "entity_slug": "people/a", "visibility": "world", "source": source,
            "dimension": "role", "value": fact, "value_hash": format!("h-{fact}"),
            "source_markdown_slug": "notes/page", "row_num": row_num, "valid_from": "2026-01-01T00:00:00Z",
        });
        r.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        r
    };
    insert(
        "default",
        json!([
            // Row 2 is stamped with the page row 1 names as its source: row 1 is its stint's duplicate.
            row(
                "one",
                "notes/page",
                json!(1),
                json!({ "source_markdown_slug": "notes/other" })
            ),
            row("one", "ontology:run1", json!(2), json!({})),
            row("two", "ontology:run1", json!(3), json!({})),
            // The conversation extractor's own rows and page-source rows are left out.
            row(
                "three",
                "cli:extract-conversation-facts",
                json!(4),
                json!({})
            ),
            row(
                "four",
                "notes/page",
                Value::Null,
                json!({ "source_markdown_slug": "notes/page" })
            ),
        ]),
    );
    insert(
        "other",
        json!([row("five", "ontology:run1", json!(1), json!({}))]),
    );
    b.insert_fact_withdrawal("default", "world", "two", "people/a", None)
        .unwrap();
    let rows = b
        .list_ontology_fact_candidates(&args::<SourcesArgs>(json!({ "sourceIds": ["default"] })))
        .unwrap();
    let verdicts: Vec<(String, bool, bool, bool)> = rows
        .iter()
        .map(|r| {
            (
                r["row_num"].to_string(),
                r["withdrawn"].as_bool().unwrap(),
                r["consolidated"].as_bool().unwrap(),
                r["duplicate"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        verdicts,
        vec![
            ("1".into(), false, false, true),
            ("2".into(), false, false, false),
            ("3".into(), true, false, false),
        ]
    );
    assert!(
        rows.iter()
            .all(|r| r["source_id"] == "default" && r["expired_at"].is_null())
    );
}

// ---- listExtractionInputReceipts and listUnpricedDerivationModels --------------------------------

fn derive(b: &Brain, page_id: i64, kind: &str, occurrence: i64, receipt: Value) {
    let d: SegmentDerivationInput = args(json!({
        "pageId": page_id, "kind": kind, "occurrenceId": occurrence, "version": 1,
        "segmentSha256": hash("s"), "contextHash": hash("c"), "state": "partial",
        "output": {}, "receipt": receipt,
    }));
    b.upsert_segment_derivations(&[d]).unwrap();
    b.clock.advance(1_000);
}

#[test]
fn receipts_group_by_pipeline_and_kind_and_unpriced_models_by_page_count() {
    let b = brain("derived-health-receipts");
    assert!(b.list_extraction_input_receipts().unwrap().is_empty());
    assert!(b.list_unpriced_derivation_models().unwrap().is_empty());
    let a = segmented(&b, "notes/a", &["one\n"]);
    let c = put(&b, "notes/c", "note", json!({}));
    derive(
        &b,
        a,
        "links",
        1,
        json!({ "kind": "failed_windows", "windows": [{ "ordinal": 4 }] }),
    );
    derive(
        &b,
        a,
        "mentions",
        1,
        json!({ "kind": "unpriced_model", "model": "m-x" }),
    );
    derive(&b, c, "links", 2, json!({ "kind": "failed_windows" }));
    derive(
        &b,
        c,
        "mentions",
        2,
        json!({ "reason": "unpriced_model", "model": "m-x" }),
    );
    derive(
        &b,
        c,
        "synopsis",
        2,
        json!({ "reason": "purge_sweep_pending" }),
    );
    derive(
        &b,
        c,
        "synopsis",
        3,
        json!({ "kind": "unpriced_model", "model": "m-y" }),
    );
    let rows = b.list_extraction_input_receipts().unwrap();
    assert_eq!(
        rows,
        vec![
            json!({ "pipeline": "links", "kind": "failed_windows", "pages": 2, "samples": ["default:notes/c", "default:notes/a window 4 of occurrence 1"] }),
            json!({ "pipeline": "synopsis", "kind": "purge_sweep_pending", "pages": 1, "samples": ["default:notes/c"] }),
        ]
    );
    assert_eq!(
        b.list_unpriced_derivation_models().unwrap(),
        vec![
            json!({ "model": "m-x", "pipelines": ["mentions"], "pages": 2, "samples": ["default:notes/a", "default:notes/c"] }),
            json!({ "model": "m-y", "pipelines": ["synopsis"], "pages": 1, "samples": ["default:notes/c"] }),
        ]
    );
    b.soft_delete_page("notes/c", None).unwrap();
    assert_eq!(b.list_unpriced_derivation_models().unwrap().len(), 1);
}
