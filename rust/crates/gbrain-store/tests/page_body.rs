//! Segmented page bodies: texts, manifests, stagings, the generation flip, derivations and
//! `refreshPageBody`, matched to PGLite's `src/core/engine-sql/page-body.ts`.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::page_body::*;
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

fn text(body: &str) -> SegmentTextInput {
    serde_json::from_value(json!({
        "sha256": sha(body), "body": hex(body.as_bytes()), "lineCount": body.matches('\n').count(),
    }))
    .unwrap()
}

fn meta(title: &str) -> SegmentedPageMeta {
    serde_json::from_value(json!({"type": "note", "title": title})).unwrap()
}

fn shell(store: &Store, slug: &str) -> i64 {
    store
        .create_segmented_page_shell(
            slug,
            &meta(slug),
            &serde_json::from_value(json!({"sourceId": "default"})).unwrap(),
        )
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

const STAGING: &str = "11111111-1111-4111-8111-111111111111";
const STAGING_2: &str = "22222222-2222-4222-8222-222222222222";

fn staging(id: &str, page_id: Option<i64>, client: &str) -> BodyStagingInput {
    serde_json::from_value(json!({
        "id": id, "kind": "put", "principalKind": "local", "principalId": "cli",
        "clientRequestId": client, "sourceId": "default",
        "sourceIncarnation": "33333333-3333-4333-8333-333333333333", "slug": "notes/a",
        "pageId": page_id, "mode": "replace", "baseRevision": null, "baseGeneration": 0,
        "declaredBytes": 10, "declaredSha256": null, "reservedBytes": 10,
        "idleExpiresAt": "2099-01-01T00:00:00.000Z", "hardExpiresAt": "2099-01-02T00:00:00.000Z",
    }))
    .unwrap()
}

fn row(
    page_id: i64,
    occurrence: i64,
    seq: i64,
    start: i64,
    body: &str,
    staging: Option<&str>,
) -> ManifestRow {
    serde_json::from_value(json!({
        "pageId": page_id, "occurrenceId": occurrence, "genFrom": 1, "seq": seq, "region": "truth",
        "sourceId": "default", "sha256": sha(body), "byteStart": start, "byteLen": body.len(),
        "lineStart": 0, "lineCount": 1, "cutKind": "heading", "entryState": {"depth": 0},
        "protectedRegions": [], "factsSlots": [], "staticProjBytes": body.len(),
        "staticProjLines": 1, "outline": [], "dateMin": "2026-01-02", "dateMax": "2026-01-03",
        "hashState": sha("state"), "stagingId": staging,
    }))
    .unwrap()
}

fn flip(
    page_id: i64,
    expected: i64,
    staging: &str,
    body_bytes: i64,
    extra: Value,
) -> BodyFlipInput {
    let mut input = json!({
        "pageId": page_id, "expectedGeneration": expected, "newGeneration": expected + 1,
        "stagingId": staging, "closeOccurrences": [], "retireChunkOccurrences": [],
        "retireMaxRows": 1000,
        "body": {
            "content_hash": "hash-1", "body_bytes": body_bytes, "truth_bytes": body_bytes,
            "body_lines": 2, "segment_count": 2, "segmenter_version": 1,
            "truth_lead": "lead", "timeline_lead": "", "body_flags": {},
        },
        "meta": {"type": "note", "title": "Flipped"},
    });
    for (k, v) in extra.as_object().unwrap() {
        input[k] = v.clone();
    }
    serde_json::from_value(input).unwrap()
}

fn page(store: &Store, slug: &str) -> Value {
    store
        .read_page_snapshot(slug, &ReadScope::default())
        .unwrap()
        .unwrap()["page"]
        .clone()
}

/// A shell page published at generation 1 from two staged texts.
fn published(store: &Store) -> i64 {
    let id = shell(store, "notes/a");
    store
        .open_body_staging(&staging(
            STAGING,
            Some(id),
            "44444444-4444-4444-8444-444444444444",
        ))
        .unwrap();
    store
        .stage_segment_texts(
            "default",
            &[text("one\n"), text("two\n")],
            &serde_json::from_value(json!({"stagingId": STAGING})).unwrap(),
        )
        .unwrap();
    store
        .stage_manifest_rows(&[
            row(id, 1, 0, 0, "one\n", Some(STAGING)),
            row(id, 2, 1, 4, "two\n", Some(STAGING)),
        ])
        .unwrap();
    let result = store
        .flip_body_generation(&flip(id, 0, STAGING, 8, json!({})))
        .unwrap();
    assert_eq!(
        result,
        BodyFlipResult {
            retired_chunks: 0,
            retire_deferred: false
        }
    );
    id
}

#[test]
fn occurrence_ids_ascend_and_a_non_positive_count_allocates_none() {
    let dir = TempDir::new("pb-alloc");
    let store = open(&dir);
    assert_eq!(
        store.allocate_body_occurrence_ids(0).unwrap(),
        Vec::<i64>::new()
    );
    assert_eq!(
        store.allocate_body_occurrence_ids(-2).unwrap(),
        Vec::<i64>::new()
    );
    assert_eq!(
        store.allocate_body_occurrence_ids(3).unwrap(),
        vec![1, 2, 3]
    );
    assert_eq!(store.allocate_body_occurrence_ids(2).unwrap(), vec![4, 5]);
}

#[test]
fn texts_are_stored_once_per_source_and_read_back_by_hash() {
    let dir = TempDir::new("pb-texts");
    let store = open(&dir);
    let none = StageTextsOptions::default();
    let r = store
        .stage_segment_texts(
            "default",
            &[text("one\n"), text("one\n"), text("two\n")],
            &none,
        )
        .unwrap();
    assert_eq!(r, json!({"inserted": 2}));
    let r = store
        .stage_segment_texts("default", &[text("one\n"), text("three\n")], &none)
        .unwrap();
    assert_eq!(r, json!({"inserted": 1}));
    let got = store
        .read_segment_texts("default", &[sha("two\n"), sha("missing"), sha("one\n")])
        .unwrap();
    assert_eq!(
        got,
        vec![(sha("two\n"), hex(b"two\n")), (sha("one\n"), hex(b"one\n"))]
    );
    assert!(
        store
            .read_segment_texts("other", &[sha("one\n")])
            .unwrap()
            .is_empty()
    );
    assert!(store.read_segment_texts("default", &[]).unwrap().is_empty());
    // An empty body breaks the byte_len CHECK; a missing staging breaks its foreign key.
    let empty: SegmentTextInput =
        serde_json::from_value(json!({"sha256": sha(""), "body": "", "lineCount": 0})).unwrap();
    assert_eq!(
        store
            .stage_segment_texts("default", &[empty], &none)
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    let gone = serde_json::from_value(json!({"stagingId": STAGING})).unwrap();
    assert_eq!(
        store
            .stage_segment_texts("default", &[text("x")], &gone)
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        store
            .stage_segment_texts("nope", &[text("x")], &none)
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
}

#[test]
fn a_shell_publishes_generation_one_and_reports_its_body_columns() {
    let dir = TempDir::new("pb-flip");
    let store = open(&dir);
    let id = published(&store);
    let p = page(&store, "notes/a");
    assert_eq!(p["body_storage"], json!("segmented"));
    assert_eq!(p["body_bytes"], json!(8));
    assert_eq!(p["title"], json!("Flipped"));
    assert_eq!(p["content_hash"], json!("hash-1"));
    let rows = store
        .read_manifest(id, &ReadManifestOptions::default())
        .unwrap();
    assert_eq!(
        rows.iter().map(|r| r.occurrence_id).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert!(
        rows.iter()
            .all(|r| r.staging_id.is_none() && r.gen_to.is_none())
    );
    assert_eq!(rows[0].date_min.as_deref(), Some("2026-01-02"));
    let last: ReadManifestOptions = serde_json::from_value(json!({"lastN": 1})).unwrap();
    assert_eq!(store.read_manifest(id, &last).unwrap()[0].occurrence_id, 2);
    let old: ReadManifestOptions = serde_json::from_value(json!({"generation": 0})).unwrap();
    assert!(store.read_manifest(id, &old).unwrap().is_empty());
    let tl: ReadManifestOptions = serde_json::from_value(json!({"region": "timeline"})).unwrap();
    assert!(store.read_manifest(id, &tl).unwrap().is_empty());
    assert!(
        store
            .read_manifest(999, &ReadManifestOptions::default())
            .unwrap()
            .is_empty()
    );
    // The staging is still live until the caller commits it.
    store
        .set_body_staging_state(STAGING, "committed", &StagingStateOptions::default())
        .unwrap();
    store
        .set_body_staging_state(STAGING, "committed", &StagingStateOptions::default())
        .unwrap();
    store
        .set_body_staging_state(STAGING, "aborted", &StagingStateOptions::default())
        .unwrap();
    let err = store
        .set_body_staging_state(STAGING, "open", &StagingStateOptions::default())
        .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    assert!(err.message.starts_with("page_body:"));
    assert!(err.message.contains("\"state\":\"committed\""));
}

#[test]
fn a_second_generation_closes_replaced_occurrences() {
    let dir = TempDir::new("pb-gen2");
    let store = open(&dir);
    let id = published(&store);
    store
        .open_body_staging(&staging(
            STAGING_2,
            Some(id),
            "55555555-5555-4555-8555-555555555555",
        ))
        .unwrap();
    store
        .stage_segment_texts(
            "default",
            &[text("TWO!\n")],
            &serde_json::from_value(json!({"stagingId": STAGING_2})).unwrap(),
        )
        .unwrap();
    let mut replacement = row(id, 3, 1, 4, "TWO!\n", Some(STAGING_2));
    replacement.gen_from = 2;
    store.stage_manifest_rows(&[replacement]).unwrap();
    let staged: ReadManifestOptions =
        serde_json::from_value(json!({"stagingId": STAGING_2})).unwrap();
    assert_eq!(store.read_manifest(id, &staged).unwrap().len(), 1);
    store
        .flip_body_generation(&flip(id, 1, STAGING_2, 9, json!({"closeOccurrences": [2]})))
        .unwrap();
    let now = store
        .read_manifest(id, &ReadManifestOptions::default())
        .unwrap();
    assert_eq!(
        now.iter().map(|r| r.occurrence_id).collect::<Vec<_>>(),
        vec![1, 3]
    );
    let before: ReadManifestOptions = serde_json::from_value(json!({"generation": 1})).unwrap();
    let then = store.read_manifest(id, &before).unwrap();
    assert_eq!(
        then.iter()
            .map(|r| (r.occurrence_id, r.gen_to))
            .collect::<Vec<_>>(),
        vec![(1, None), (2, Some(2))]
    );
}

#[test]
fn a_flip_refuses_a_moved_generation_a_gone_staging_and_an_untiled_body() {
    let dir = TempDir::new("pb-refuse");
    let store = open(&dir);
    let id = published(&store);
    let stale = store
        .flip_body_generation(&flip(id, 0, STAGING, 8, json!({})))
        .unwrap_err();
    assert!(
        stale.message.contains("\"kind\":\"revision_changed\""),
        "{}",
        stale.message
    );
    let gone = store
        .flip_body_generation(&flip(id, 1, STAGING_2, 8, json!({})))
        .unwrap_err();
    assert!(gone.message.contains("\"kind\":\"staging_gone\""));
    let missing = store
        .flip_body_generation(&flip(999, 0, STAGING, 8, json!({})))
        .unwrap_err();
    assert!(
        missing
            .message
            .contains("\"kind\":\"page_identity_changed\"")
    );
    let bad = store
        .flip_body_generation(&flip(id, 1, STAGING, 8, json!({"newGeneration": 5})))
        .unwrap_err();
    assert_eq!(bad.code, INVALID_ARGUMENT);
    // The staging is live, but the body would end at 9 while the rows cover 8: nothing moves.
    let untiled = store
        .flip_body_generation(&flip(id, 1, STAGING, 9, json!({})))
        .unwrap_err();
    assert!(
        untiled
            .message
            .contains("\"kind\":\"generation_incomplete\"")
    );
    assert!(untiled.message.contains("\"covered\":8"));
    assert_eq!(page(&store, "notes/a")["body_bytes"], json!(8));
}

#[test]
fn a_flip_retires_inline_chunks_or_defers_past_the_cap() {
    let dir = TempDir::new("pb-retire");
    let store = open(&dir);
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": "A", "compiled_truth": "inline body"}),
    )
    .unwrap();
    store
        .put_page("notes/b", &input, &PutPageOptions::default())
        .unwrap();
    let id = page(&store, "notes/b")["id"].as_i64().unwrap();
    assert!(
        !store
            .get_chunks("notes/b", &ReadScope::default())
            .unwrap()
            .is_empty()
    );
    let mut s = staging(STAGING, Some(id), "66666666-6666-4666-8666-666666666666");
    s.slug = "notes/b".into();
    store.open_body_staging(&s).unwrap();
    store
        .stage_segment_texts(
            "default",
            &[text("one\n")],
            &serde_json::from_value(json!({"stagingId": STAGING})).unwrap(),
        )
        .unwrap();
    store
        .stage_manifest_rows(&[row(id, 1, 0, 0, "one\n", Some(STAGING))])
        .unwrap();
    let deferred = store
        .flip_body_generation(&flip(
            id,
            0,
            STAGING,
            4,
            json!({"retireInlineChunks": true, "retireMaxRows": 0}),
        ))
        .unwrap();
    assert_eq!(
        deferred,
        BodyFlipResult {
            retired_chunks: 0,
            retire_deferred: true
        }
    );

    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": "C", "compiled_truth": "inline body"}),
    )
    .unwrap();
    store
        .put_page("notes/c", &input, &PutPageOptions::default())
        .unwrap();
    let id = page(&store, "notes/c")["id"].as_i64().unwrap();
    let mut s = staging(STAGING_2, Some(id), "77777777-7777-4777-8777-777777777777");
    s.slug = "notes/c".into();
    store.open_body_staging(&s).unwrap();
    store
        .stage_manifest_rows(&[row(id, 2, 0, 0, "one\n", Some(STAGING_2))])
        .unwrap();
    let retired = store
        .flip_body_generation(&flip(
            id,
            0,
            STAGING_2,
            4,
            json!({"retireInlineChunks": true}),
        ))
        .unwrap();
    assert!(!retired.retire_deferred);
    assert!(retired.retired_chunks > 0);
    assert!(
        store
            .get_chunks("notes/c", &ReadScope::default())
            .unwrap()
            .is_empty()
    );
}

/// Minder's row 1 on #9730: after a deferred retirement and a seal, a title hit must not carry a retired chunk's text.
/// PGLite picks the representative chunk with `chunkGenerationFilter` (title-statement.ts), which drops an inline chunk
/// left on a segmented page; the hit then has no chunk (`chunk_id` 0, empty text).
#[test]
fn a_title_hit_does_not_show_a_chunk_a_deferred_retire_left() {
    use gbrain_store::keyword::{KeywordOptions, TitleAttempt, TitleAttemptKind};
    let dir = TempDir::new("pb-title-retired");
    let store = open(&dir);
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": "A", "compiled_truth": "retired inline body"}),
    )
    .unwrap();
    store
        .put_page("notes/b", &input, &PutPageOptions::default())
        .unwrap();
    let id = page(&store, "notes/b")["id"].as_i64().unwrap();
    let mut s = staging(STAGING, Some(id), "66666666-6666-4666-8666-666666666666");
    s.slug = "notes/b".into();
    store.open_body_staging(&s).unwrap();
    store
        .stage_segment_texts(
            "default",
            &[text("one\n")],
            &serde_json::from_value(json!({"stagingId": STAGING})).unwrap(),
        )
        .unwrap();
    store
        .stage_manifest_rows(&[row(id, 1, 0, 0, "one\n", Some(STAGING))])
        .unwrap();
    let deferred = store
        .flip_body_generation(&flip(
            id,
            0,
            STAGING,
            4,
            json!({"retireInlineChunks": true, "retireMaxRows": 0}),
        ))
        .unwrap();
    assert!(deferred.retire_deferred);
    store.seal_segmented_page(id, "", None).unwrap();
    let attempts = [TitleAttempt {
        texts: vec!["Flipped".into()],
        kind: TitleAttemptKind::Title,
        limit: 10.0,
        offset: 0.0,
    }];
    let result = store
        .search_titles_attempts(&attempts, "flipped", 100.0, &KeywordOptions::default())
        .unwrap();
    let rows = result[0]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{result:?}");
    assert_eq!(rows[0]["slug"], json!("notes/b"));
    assert_eq!(rows[0]["chunk_text"], json!(""), "{result:?}");
    assert_eq!(rows[0]["chunk_id"], json!(0));
}

#[test]
fn manifest_rows_refuse_broken_checks_and_keys() {
    let dir = TempDir::new("pb-manifest");
    let store = open(&dir);
    let id = shell(&store, "notes/a");
    store
        .stage_segment_texts("default", &[text("one\n")], &StageTextsOptions::default())
        .unwrap();
    store
        .stage_manifest_rows(&[row(id, 1, 0, 0, "one\n", None)])
        .unwrap();
    let code = |r: ManifestRow| store.stage_manifest_rows(&[r]).unwrap_err().code;
    assert_eq!(
        code(row(id, 1, 5, 0, "one\n", None)),
        CONSTRAINT_VIOLATION,
        "same key"
    );
    assert_eq!(
        code(row(id, 2, 0, 0, "one\n", None)),
        CONSTRAINT_VIOLATION,
        "same live seq"
    );
    assert_eq!(
        code(row(id, 3, 1, 0, "missing", None)),
        CONSTRAINT_VIOLATION,
        "no text"
    );
    assert_eq!(
        code(row(999, 3, 1, 0, "one\n", None)),
        CONSTRAINT_VIOLATION,
        "no page"
    );
    let mut r = row(id, 3, 1, 0, "one\n", None);
    r.region = "middle".into();
    assert_eq!(code(r), CONSTRAINT_VIOLATION);
    let mut r = row(id, 3, 1, 0, "one\n", None);
    r.outline = Value::Null;
    assert_eq!(code(r), CONSTRAINT_VIOLATION);
    let mut r = row(id, 3, 1, 0, "one\n", None);
    r.date_min = Some("soon".into());
    assert_eq!(code(r), INVALID_ARGUMENT);
    let r = row(id, 3, 1, 0, "one\n", Some("not-a-uuid"));
    assert_eq!(code(r), INVALID_ARGUMENT);
    // A staged row shares no seq rule with the live rows.
    store
        .stage_manifest_rows(&[row(id, 4, 0, 0, "one\n", Some(STAGING))])
        .unwrap();
}

#[test]
fn stagings_refuse_taken_ids_and_client_requests() {
    let dir = TempDir::new("pb-staging");
    let store = open(&dir);
    store
        .open_body_staging(&staging(
            STAGING,
            None,
            "44444444-4444-4444-8444-444444444444",
        ))
        .unwrap();
    let again = store.open_body_staging(&staging(
        STAGING,
        None,
        "55555555-5555-4555-8555-555555555555",
    ));
    assert_eq!(again.unwrap_err().code, CONSTRAINT_VIOLATION);
    let client = store.open_body_staging(&staging(
        STAGING_2,
        None,
        "44444444-4444-4444-8444-444444444444",
    ));
    assert_eq!(client.unwrap_err().code, CONSTRAINT_VIOLATION);
    let mut bad = staging(STAGING_2, None, "55555555-5555-4555-8555-555555555555");
    bad.kind = "teleport".into();
    assert_eq!(
        store.open_body_staging(&bad).unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    let page = store.open_body_staging(&staging(
        STAGING_2,
        Some(999),
        "55555555-5555-4555-8555-555555555555",
    ));
    assert_eq!(page.unwrap_err().code, CONSTRAINT_VIOLATION);
    // Sealing keeps it live; an abort ends it; a missing staging may be aborted silently.
    store
        .set_body_staging_state(STAGING, "sealed", &StagingStateOptions::default())
        .unwrap();
    store
        .set_body_staging_state(STAGING, "aborted", &StagingStateOptions::default())
        .unwrap();
    store
        .set_body_staging_state(STAGING_2, "expired", &StagingStateOptions::default())
        .unwrap();
    let err = store
        .set_body_staging_state(STAGING_2, "sealed", &StagingStateOptions::default())
        .unwrap_err();
    assert!(err.message.contains("\"state\":null"), "{}", err.message);
}

#[test]
fn derivations_upsert_read_and_retire() {
    let dir = TempDir::new("pb-deriv");
    let store = open(&dir);
    let id = shell(&store, "notes/a");
    let d = |kind: &str, occurrence: i64, state: &str| -> SegmentDerivationInput {
        serde_json::from_value(json!({
            "pageId": id, "kind": kind, "occurrenceId": occurrence, "version": 1,
            "segmentSha256": sha("s"), "contextHash": sha("c"), "state": state,
            "output": {"n": occurrence}, "receipt": null,
        }))
        .unwrap()
    };
    store
        .upsert_segment_derivations(&[
            d("mentions", 2, "done"),
            d("links", 3, "done"),
            d("links", 1, "partial"),
        ])
        .unwrap();
    let all = store
        .read_segment_derivations(id, &DerivationReadOptions::default())
        .unwrap();
    let order: Vec<(String, i64)> = all
        .iter()
        .map(|r| {
            (
                r["kind"].as_str().unwrap().into(),
                r["occurrenceId"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        order,
        vec![
            ("links".into(), 1),
            ("links".into(), 3),
            ("mentions".into(), 2)
        ]
    );
    assert_eq!(all[0]["receipt"], Value::Null);
    let created = all[0]["createdAt"].clone();
    store
        .upsert_segment_derivations(&[d("links", 1, "done")])
        .unwrap();
    let only: DerivationReadOptions =
        serde_json::from_value(json!({"kind": "links", "occurrenceIds": [1]})).unwrap();
    let one = store.read_segment_derivations(id, &only).unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0]["state"], json!("done"));
    assert_eq!(one[0]["createdAt"], created);
    let empty: DerivationReadOptions =
        serde_json::from_value(json!({"occurrenceIds": []})).unwrap();
    assert!(
        store
            .read_segment_derivations(id, &empty)
            .unwrap()
            .is_empty()
    );
    let dup = store.upsert_segment_derivations(&[d("links", 9, "done"), d("links", 9, "done")]);
    assert_eq!(dup.unwrap_err().code, CONSTRAINT_VIOLATION);
    assert_eq!(
        store
            .upsert_segment_derivations(&[d("links", 9, "maybe")])
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    let links: DerivationRetireOptions = serde_json::from_value(json!({"kind": "links"})).unwrap();
    assert_eq!(
        store.retire_segment_derivations(id, &[3], &links).unwrap(),
        1
    );
    assert_eq!(
        store
            .retire_segment_derivations(id, &[], &DerivationRetireOptions::default())
            .unwrap(),
        2
    );
    assert!(
        store
            .read_segment_derivations(id, &DerivationReadOptions::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn refresh_page_body_rewrites_live_inline_pages_only() {
    let dir = TempDir::new("pb-refresh");
    let store = open(&dir);
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": "A", "compiled_truth": "old"}))
            .unwrap();
    store
        .put_page("notes/r", &input, &PutPageOptions::default())
        .unwrap();
    let before = store
        .read_page_snapshot("notes/r", &ReadScope::default())
        .unwrap()
        .unwrap();
    store
        .refresh_page_body("notes/r", "default", "new", "tl", "h2")
        .unwrap();
    let after = store
        .read_page_snapshot("notes/r", &ReadScope::default())
        .unwrap()
        .unwrap();
    assert_eq!(after["page"]["compiled_truth"], json!("new"));
    assert_eq!(after["page"]["timeline"], json!("tl"));
    assert_eq!(after["page"]["content_hash"], json!("h2"));
    assert_ne!(after["revision"], before["revision"]);
    // The same text again keeps the revision.
    store
        .refresh_page_body("notes/r", "default", "new", "tl", "h3")
        .unwrap();
    let same = store
        .read_page_snapshot("notes/r", &ReadScope::default())
        .unwrap()
        .unwrap();
    assert_eq!(same["revision"], after["revision"]);
    store
        .refresh_page_body("notes/missing", "default", "x", "", "h")
        .unwrap();
    assert_eq!(
        store
            .refresh_page_body("notes/r", "default", "a\0b", "", "h")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    store.soft_delete_page("notes/r", None).unwrap();
    store
        .refresh_page_body("notes/r", "default", "deleted", "", "h")
        .unwrap();
    let scope: ReadScope = serde_json::from_value(json!({"includeDeleted": true})).unwrap();
    let deleted = store
        .read_page_snapshot("notes/r", &scope)
        .unwrap()
        .unwrap();
    assert_eq!(deleted["page"]["compiled_truth"], json!("new"));
    shell(&store, "notes/seg");
    let seg = store.refresh_page_body("notes/seg", "default", "x", "", "h");
    assert_eq!(seg.unwrap_err().code, CONSTRAINT_VIOLATION);
}

#[test]
fn a_shell_refuses_a_taken_slug_and_an_unknown_source() {
    let dir = TempDir::new("pb-shell");
    let store = open(&dir);
    shell(&store, "notes/a");
    let opts = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    assert_eq!(
        store
            .create_segmented_page_shell("notes/a", &meta("again"), &opts)
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    let other = serde_json::from_value(json!({"sourceId": "nope"})).unwrap();
    assert_eq!(
        store
            .create_segmented_page_shell("notes/b", &meta("b"), &other)
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    let p = page(&store, "notes/a");
    assert_eq!(p["body_bytes"], json!(0));
}

fn seg_chunk(occurrence: i64, ordinal: i64, body: &str) -> gbrain_store::chunks::SegmentChunkInput {
    serde_json::from_value(json!({
        "chunk_text": body, "chunk_source": "compiled_truth", "model": "test-model",
        "occurrence_id": occurrence, "local_ordinal": ordinal,
        "raw_byte_start": 0, "raw_byte_end": body.len(),
    }))
    .unwrap()
}

fn chunk_texts(store: &Store, slug: &str) -> Vec<String> {
    store
        .get_chunks(slug, &ReadScope::default())
        .unwrap()
        .iter()
        .map(|c| c["chunk_text"].as_str().unwrap().to_string())
        .collect()
}

fn stale_detail(error: &StoreError) -> Value {
    assert_eq!(error.code, INVALID_STATE, "{}", error.message);
    let detail: Value =
        serde_json::from_str(error.message.strip_prefix("page_body:").unwrap()).unwrap();
    assert_eq!(detail["kind"], json!("chunks_stale"));
    json!([detail["staged_generation"], detail["current_generation"]])
}

#[test]
fn staging_segment_chunks_refuses_a_stale_or_unpublished_generation() {
    let dir = TempDir::new("pb-chunks-stale");
    let store = open(&dir);
    let id = published(&store);
    let below = store
        .stage_segment_chunks(id, 0, &[seg_chunk(1, 0, "x")])
        .unwrap_err();
    assert_eq!(stale_detail(&below), json!([0, 1]));
    // Occurrence 3 has no published row in generation 1.
    let unpublished = store
        .stage_segment_chunks(id, 1, &[seg_chunk(1, 0, "x"), seg_chunk(3, 0, "y")])
        .unwrap_err();
    assert_eq!(stale_detail(&unpublished), json!([1, 1]));
    let missing = store
        .stage_segment_chunks(999, 1, &[seg_chunk(1, 0, "x")])
        .unwrap_err();
    assert_eq!(stale_detail(&missing), json!([1, null]));
    let input: PageInput =
        serde_json::from_value(json!({"type": "note", "title": "I", "compiled_truth": "inline"}))
            .unwrap();
    store
        .put_page("notes/inline", &input, &PutPageOptions::default())
        .unwrap();
    let inline = page(&store, "notes/inline")["id"].as_i64().unwrap();
    let at_live = store
        .stage_segment_chunks(inline, 0, &[seg_chunk(1, 0, "x")])
        .unwrap_err();
    assert_eq!(stale_detail(&at_live), json!([0, 0]));
    // Above the live generation an inline page takes rows, hidden until a flip.
    let before = chunk_texts(&store, "notes/inline");
    store
        .stage_segment_chunks(inline, 1, &[seg_chunk(1, 0, "hidden")])
        .unwrap();
    assert_eq!(chunk_texts(&store, "notes/inline"), before);
    // Nothing was written by the refusals.
    assert!(chunk_texts(&store, "notes/a").is_empty());
}
