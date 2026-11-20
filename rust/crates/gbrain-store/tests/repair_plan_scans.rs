//! The plan reads of the frontmatter and segmented-tiling repairs and the source hold listing. The
//! three-arm cases are in test/engine-parity/repair-plan-scans.test.ts; these pin what the parity
//! cases cannot reach: a page whose live rows do not tile its body (no Rust write publishes one),
//! archived sources, stale incarnations and the byte order of holds. The busy rows case pins the
//! `->>` text of a numeric index and of a `done` flag, and an empty or held record with no path.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::page_body::*;
use gbrain_store::sources::SourceInput;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

fn put(store: &Store, slug: &str, path: Option<&str>, body: &str) {
    let input = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": body, "timeline": "",
        "source_path": path,
    }))
    .unwrap();
    store
        .put_page(slug, &input, &serde_json::from_value(json!({})).unwrap())
        .unwrap();
}

fn shell(store: &Store, slug: &str) -> i64 {
    let meta: SegmentedPageMeta =
        serde_json::from_value(json!({"type": "note", "title": slug})).unwrap();
    store
        .create_segmented_page_shell(
            slug,
            &meta,
            &serde_json::from_value(json!({"sourceId": "default"})).unwrap(),
        )
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn row(page_id: i64, seq: i64, start: i64, body: &str, staging: Option<&str>) -> ManifestRow {
    serde_json::from_value(json!({
        "pageId": page_id, "occurrenceId": seq + 1, "genFrom": 1, "seq": seq, "region": "truth",
        "sourceId": "default", "sha256": sha(body), "byteStart": start, "byteLen": body.len(),
        "lineStart": 0, "lineCount": 1, "cutKind": "heading", "entryState": {"depth": 0},
        "protectedRegions": [], "factsSlots": [], "staticProjBytes": body.len(),
        "staticProjLines": 1, "outline": [], "dateMin": "2026-01-02", "dateMax": "2026-01-03",
        "hashState": sha("state"), "stagingId": staging,
    }))
    .unwrap()
}

/// Publishes `slug` at generation 1 from "one\n" and "two\n" (8 bytes, tiled).
fn published(store: &Store, slug: &str) -> i64 {
    let id = shell(store, slug);
    let staging_id = format!("{id:08x}-1111-4111-8111-111111111111");
    let staging_id = staging_id.as_str();
    let staging: BodyStagingInput = serde_json::from_value(json!({
        "id": staging_id, "kind": "put", "principalKind": "local", "principalId": "cli",
        "clientRequestId": format!("{id:08x}-4444-4444-8444-444444444444"), "sourceId": "default",
        "sourceIncarnation": "33333333-3333-4333-8333-333333333333", "slug": slug,
        "pageId": id, "mode": "replace", "baseRevision": null, "baseGeneration": 0,
        "declaredBytes": 8, "declaredSha256": null, "reservedBytes": 8,
        "idleExpiresAt": "2099-01-01T00:00:00.000Z", "hardExpiresAt": "2099-01-02T00:00:00.000Z",
    }))
    .unwrap();
    store.open_body_staging(&staging).unwrap();
    let texts: Vec<SegmentTextInput> = ["one\n", "two\n"]
        .iter()
        .map(|body| {
            serde_json::from_value(json!({
                "sha256": sha(body), "body": hex(body.as_bytes()), "lineCount": 1,
            }))
            .unwrap()
        })
        .collect();
    store
        .stage_segment_texts(
            "default",
            &texts,
            &serde_json::from_value(json!({"stagingId": staging_id})).unwrap(),
        )
        .unwrap();
    store
        .stage_manifest_rows(&[
            row(id, 0, 0, "one\n", Some(staging_id)),
            row(id, 1, 4, "two\n", Some(staging_id)),
        ])
        .unwrap();
    let flip: BodyFlipInput = serde_json::from_value(json!({
        "pageId": id, "expectedGeneration": 0, "newGeneration": 1, "stagingId": staging_id,
        "closeOccurrences": [], "retireChunkOccurrences": [], "retireMaxRows": 1000,
        "body": {
            "content_hash": "hash-1", "body_bytes": 8, "truth_bytes": 8, "body_lines": 2,
            "segment_count": 2, "segmenter_version": 1, "truth_lead": "lead",
            "timeline_lead": "", "body_flags": {},
        },
        "meta": {"type": "note", "title": slug, "source_path": format!("{slug}.md")},
    }))
    .unwrap();
    store.flip_body_generation(&flip).unwrap();
    id
}

fn source(store: &Store, id: &str, config: Value) -> String {
    let config: Map<String, Value> = serde_json::from_value(config).unwrap();
    store
        .upsert_source(&SourceInput {
            id: id.to_owned(),
            name: None,
            local_path: None,
            last_sync_at: None,
            config: Some(config),
        })
        .unwrap()
        .incarnation
}

#[test]
fn origin_path_pages_and_segmented_count() {
    let dir = TempDir::new("repair-plan-origin");
    let store = open(&dir);
    put(&store, "b", Some("b.md"), &"x".repeat(450));
    put(&store, "a", Some("a.md"), "short");
    put(&store, "c", None, "no origin");
    put(&store, "d", Some("d.md"), "gone");
    store.soft_delete_page("d", None).unwrap();
    published(&store, "seg");

    let pages = store.list_pages_by_origin_path("default").unwrap();
    let got: Vec<(&str, &str, Option<usize>)> = pages
        .iter()
        .map(|p| {
            (
                p.slug.as_str(),
                p.source_path.as_str(),
                p.head.as_ref().map(|h| h.chars().count()),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("a", "a.md", Some(5)),
            ("b", "b.md", Some(400)),
            ("seg", "seg.md", None)
        ]
    );
    assert!(store.list_pages_by_origin_path("other").unwrap().is_empty());

    let ids = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        store
            .count_segmented_origin_pages(&ids(&["default"]))
            .unwrap(),
        1
    );
    assert_eq!(
        store
            .count_segmented_origin_pages(&ids(&["other"]))
            .unwrap(),
        0
    );
    assert_eq!(
        store.list_segmented_page_slugs("default").unwrap(),
        vec!["seg".to_owned()]
    );
    assert!(store.list_segmented_page_slugs("other").unwrap().is_empty());
    store.soft_delete_page("seg", None).unwrap();
    assert_eq!(
        store
            .count_segmented_origin_pages(&ids(&["default"]))
            .unwrap(),
        0
    );
    assert!(
        store
            .list_segmented_page_slugs("default")
            .unwrap()
            .is_empty()
    );
}

#[test]
fn untiled_pages_are_the_ones_whose_live_rows_miss_the_body() {
    let dir = TempDir::new("repair-plan-untiled");
    let store = open(&dir);
    let tiled = published(&store, "tiled");
    shell(&store, "shell");
    let long = published(&store, "long");
    let gap = published(&store, "gap");
    // Damage no Rust write makes: a published row past the body, and a published row after a gap.
    store
        .stage_manifest_rows(&[row(long, 2, 8, "two\n", None)])
        .unwrap();
    store
        .stage_manifest_rows(&[row(gap, 2, 20, "two\n", None)])
        .unwrap();
    let _ = tiled;

    let all = store
        .list_untiled_segmented_pages(None, None, 1000)
        .unwrap();
    let got: Vec<(&str, i64, i64, bool, Option<i64>)> = all
        .iter()
        .map(|p| (p.slug.as_str(), p.n, p.covered, p.gapless, p.body_bytes))
        .collect();
    assert_eq!(
        got,
        vec![
            ("gap", 3, 12, false, Some(8)),
            ("long", 3, 12, true, Some(8))
        ]
    );
    assert_eq!(all[0].body_generation, 1);
    assert_eq!(all[0].source_path.as_deref(), Some("gap.md"));

    let slug = vec!["long".to_owned()];
    let one = store
        .list_untiled_segmented_pages(None, Some(&slug), 1000)
        .unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].slug, "long");
    assert_eq!(
        store
            .list_untiled_segmented_pages(None, None, 1)
            .unwrap()
            .len(),
        1
    );
    let other = vec!["other".to_owned()];
    assert!(
        store
            .list_untiled_segmented_pages(Some(&other), None, 1000)
            .unwrap()
            .is_empty()
    );

    store.soft_delete_page("gap", None).unwrap();
    assert_eq!(
        store
            .list_untiled_segmented_pages(None, None, 1000)
            .unwrap()
            .len(),
        1
    );
    store.set_source_archived("default", true).unwrap();
    assert!(
        store
            .list_untiled_segmented_pages(None, None, 1000)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn hold_records_name_a_live_incarnation() {
    let dir = TempDir::new("repair-plan-holds");
    let store = open(&dir);
    let b = source(&store, "b-src", json!({"mirror_read_only": true}));
    let a = source(&store, "a-src", json!({}));
    let hold = |fp: &str, keys: Value| {
        store
            .write_op_checkpoint_record("git-hold", fp, Some(&keys))
            .unwrap();
    };
    hold(
        "f2",
        json!([{"source_id": "a-src", "incarnation": a, "slug": "two", "run_id": "r1"}]),
    );
    hold(
        "f1",
        json!([{"source_id": "a-src", "incarnation": a, "slug": "one"}]),
    );
    hold(
        "f0",
        json!([{"source_id": "b-src", "incarnation": b, "slug": "mirror", "run_id": "r1"}]),
    );
    hold(
        "f3",
        json!([{"source_id": "a-src", "incarnation": "stale", "slug": "old"}]),
    );
    hold(
        "f4",
        json!([{"source_id": "gone", "incarnation": a, "slug": "orphan"}]),
    );
    hold("f5", json!([]));
    store
        .write_op_checkpoint_record(
            "other-op",
            "f9",
            Some(&json!([{"source_id": "a-src", "incarnation": a}])),
        )
        .unwrap();

    let slugs = |records: &[gbrain_store::repair_plan_scans::SourceHoldRecord]| {
        records
            .iter()
            .map(|r| {
                (
                    r.record["slug"].as_str().unwrap().to_owned(),
                    r.mirror_read_only,
                )
            })
            .collect::<Vec<_>>()
    };
    let all = store
        .list_source_hold_records("git-hold", None, None)
        .unwrap();
    assert_eq!(
        slugs(&all),
        vec![
            ("one".to_owned(), false),
            ("two".to_owned(), false),
            ("mirror".to_owned(), true)
        ]
    );
    let only_b = vec!["b-src".to_owned()];
    assert_eq!(
        slugs(
            &store
                .list_source_hold_records("git-hold", Some(&only_b), None)
                .unwrap()
        ),
        vec![("mirror".to_owned(), true)]
    );
    assert_eq!(
        slugs(
            &store
                .list_source_hold_records("git-hold", None, Some("r1"))
                .unwrap()
        ),
        vec![("two".to_owned(), false), ("mirror".to_owned(), true)]
    );
}

#[test]
fn busy_rows_read_cursor_text_and_held_paths() {
    let dir = TempDir::new("repair-busy-rows");
    let store = open(&dir);
    let a = source(&store, "a-src", json!({}));
    let put = |op: &str, fp: &str, keys: Value| {
        store
            .write_op_checkpoint_record(op, fp, Some(&keys))
            .unwrap();
    };
    let cursor = |run: &str, done: Value| json!([{"runId": run, "index": 3, "sourceId": "a-src", "incarnation": a, "done": done}]);
    let busy = |source_id: &str, inc: &str| store.read_repair_busy_rows(source_id, inc).unwrap();
    put(
        "sync-hold",
        "h1",
        json!([{"source_id": "a-src", "incarnation": a, "path": "x.md"}]),
    );
    // No cursor is open, so the holds are not read.
    assert!(busy("a-src", &a).held.is_empty());

    put("managed-sync", "c2", cursor("r-open", json!(false)));
    put("managed-sync", "c1", cursor("r-null", Value::Null));
    put("managed-sync", "c3", cursor("r-bool", json!(true)));
    put("managed-sync", "c4", cursor("r-text", json!("true")));
    put("managed-sync", "c5", json!([]));
    put(
        "sync-hold",
        "h0",
        json!([{"source_id": "a-src", "incarnation": a}]),
    );
    put(
        "sync-hold",
        "h2",
        json!([{"source_id": "a-src", "incarnation": "stale", "path": "y.md"}]),
    );
    let rows = busy("a-src", &a);
    let runs: Vec<_> = rows
        .cursors
        .iter()
        .map(|c| (c.run_id.clone().unwrap(), c.index.clone().unwrap()))
        .collect();
    assert_eq!(
        runs,
        vec![
            ("r-null".to_owned(), "3".to_owned()),
            ("r-open".to_owned(), "3".to_owned())
        ]
    );
    assert_eq!(rows.held, vec!["x.md".to_owned()]);
    assert!(rows.pending.is_empty());
    assert!(busy("a-src", "stale").cursors.is_empty());
}
