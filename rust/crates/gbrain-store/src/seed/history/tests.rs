//! Read-back tests of the history group: one per relation, each reading the rows back through the
//! family's own public read, with a retry that skips and a check that the family's next write
//! lands above the copied ids.

use crate::Store;
use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, PAGE_NOT_FOUND, SOURCE_NOT_FOUND};
use crate::seed::decode::timestamp_us;
use crate::seed::{ImportResult, SeedRow};
use crate::test_support::store;
use crate::{get_json, keys};
use serde_json::{Value, json};

const SEED: &str = "seed-1";
const REV: &str = "11111111-1111-4111-8111-111111111111";
const OTHER_REV: &str = "33333333-3333-4333-8333-333333333333";

fn row(pairs: &[(&str, &str)]) -> SeedRow {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), Some((*v).to_owned())))
        .collect()
}

fn import(s: &Store, relation: &str, rows: Vec<SeedRow>) -> ImportResult {
    s.import_relation(SEED, relation, rows).unwrap()
}

fn counter(s: &Store, name: &str) -> u64 {
    let read = s.read().unwrap();
    keys::be8(&read.get(&keys::meta(name)).unwrap().unwrap()).unwrap()
}

fn us(text: &str) -> i64 {
    timestamp_us(text).unwrap()
}

fn page_row(id: &str, slug: &str, body: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("source_id", "default"),
        ("slug", slug),
        ("type", "person"),
        ("title", "Alice Example"),
        ("compiled_truth", body),
        ("timeline", ""),
        ("frontmatter", "{}"),
        ("created_at", "2026-01-02 03:04:05+00"),
        ("updated_at", "2026-02-03 04:05:06+00"),
        ("knowledge_revision", REV),
        ("text_projection_revision", REV),
    ])
}

/// A store with the default source and two pages (ids 7 and 9).
fn seeded_pages() -> Store {
    let s = store();
    let r = import(
        &s,
        "pages",
        vec![
            page_row("7", "people/alice-example", "Alice builds widgets."),
            page_row("9", "companies/acme-example", "Acme <!--facts--> body."),
        ],
    );
    assert_eq!(r.imported, 2);
    s
}

fn version_row(id: &str, page_id: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("page_id", page_id),
        ("compiled_truth", "Alice v1"),
        ("frontmatter", r#"{"role": "founder"}"#),
        ("snapshot_at", "2026-02-01 10:00:00.25+00"),
        ("content_hash", "h1"),
        ("source_path", "people/alice.md"),
        ("knowledge_revision", REV),
        ("timeline", "- 2026-01-01: joined"),
        ("title", "Alice Example"),
        ("type", "person"),
        ("tags", r#"["b", "a"]"#),
        ("is_deleted", "f"),
        ("trust_tier", "user_confirmed"),
        ("write_origin", r#"{"kind": "cli"}"#),
        ("change_reason", "edited"),
        ("successor_pruned", "t"),
        ("body_storage", "inline"),
    ])
}

#[test]
fn page_versions_keep_ids_times_and_columns() {
    let s = seeded_pages();
    let mut second = version_row("32", "7");
    second.insert("snapshot_at".into(), Some("2026-02-02 11:00:00+00".into()));
    second.insert("compiled_truth".into(), Some("Alice v2".into()));
    second.insert("write_request_id".into(), Some(REV.into()));
    let r = import(&s, "page_versions", vec![version_row("31", "7"), second]);
    assert_eq!((r.imported, r.skipped, r.dropped), (2, 0, 0));
    assert!(r.unmapped_columns.is_empty());
    assert!(r.losses.is_empty());

    let got = s
        .get_versions("people/alice-example", &Default::default())
        .unwrap();
    let ids: Vec<_> = got.iter().map(|v| v["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, [32, 31]);
    let first = &got[1];
    assert_eq!(first["page_id"], json!(7));
    assert_eq!(first["compiled_truth"], "Alice v1");
    assert_eq!(first["timeline"], "- 2026-01-01: joined");
    assert_eq!(first["title"], "Alice Example");
    assert_eq!(first["type"], "person");
    assert_eq!(first["tags"], json!(["b", "a"]));
    assert_eq!(first["frontmatter"], json!({"role": "founder"}));
    assert_eq!(first["source_path"], "people/alice.md");
    assert_eq!(first["content_hash"], "h1");
    assert_eq!(first["knowledge_revision"], REV);
    assert_eq!(first["is_deleted"], json!(false));
    assert_eq!(first["snapshot_at"], iso(us("2026-02-01T10:00:00.25Z")));

    let read = s.read().unwrap();
    let stored: crate::pages::VersionRecord =
        get_json(&*read, &keys::version(7, 31)).unwrap().unwrap();
    assert_eq!(stored.trust_tier.as_deref(), Some("user_confirmed"));
    assert_eq!(stored.write_origin, Some(json!({"kind": "cli"})));
    assert_eq!(stored.change_reason.as_deref(), Some("edited"));
    assert!(stored.successor_pruned);
    assert_eq!(stored.body_storage, None);
    assert!(stored.receipt.is_empty());
    let second: crate::pages::VersionRecord =
        get_json(&*read, &keys::version(7, 32)).unwrap().unwrap();
    assert_eq!(second.receipt.written.request_id.as_deref(), Some(REV));
    assert!(second.receipt.archived.is_empty());
    drop(read);

    assert_eq!(
        import(&s, "page_versions", vec![version_row("31", "7")]).skipped,
        1
    );
    assert_eq!(counter(&s, "next_version_id"), 33);
    let next = s.create_version("people/alice-example", None).unwrap();
    assert_eq!(next["id"], json!(33));
}

#[test]
fn page_versions_report_segmented_and_legacy_rows() {
    let s = seeded_pages();
    let mut segmented = version_row("41", "9");
    segmented.insert("compiled_truth".into(), None);
    segmented.insert("timeline".into(), None);
    segmented.insert("body_storage".into(), Some("segmented".into()));
    segmented.insert("body_generation".into(), Some("3".into()));
    segmented.insert("body_bytes".into(), Some("100".into()));
    let mut legacy = version_row("42", "9");
    legacy.insert("title".into(), None);
    legacy.insert("knowledge_revision".into(), None);
    legacy.insert("tags".into(), None);
    let r = import(&s, "page_versions", vec![segmented, legacy]);
    assert_eq!(r.imported, 2);
    assert_eq!(r.losses.get("segmented_version_body"), Some(&1));
    assert_eq!(r.losses.get("legacy_version_columns"), Some(&1));
    let read = s.read().unwrap();
    let stored: crate::pages::VersionRecord =
        get_json(&*read, &keys::version(9, 41)).unwrap().unwrap();
    assert!(stored.compiled_truth.is_null());
    assert_eq!(stored.body_storage.as_deref(), Some("segmented"));
    assert_eq!(stored.body_generation, Some(3));
    assert_eq!(stored.body_bytes, Some(100));
    let err = s
        .import_relation(SEED, "page_versions", vec![version_row("43", "99")])
        .unwrap_err();
    assert_eq!(err.code, PAGE_NOT_FOUND);
}

fn file_row(id: &str, path: &str, page_id: Option<&str>) -> SeedRow {
    let mut r = row(&[
        ("id", id),
        ("source_id", "default"),
        ("filename", "a.png"),
        ("storage_path", path),
        ("mime_type", "image/png"),
        ("size_bytes", "2048"),
        ("content_hash", "sha"),
        ("metadata", r#"{"width": 10}"#),
        ("created_at", "2026-03-01 00:00:00.5+00"),
    ]);
    if let Some(page) = page_id {
        r.insert("page_id".into(), Some(page.into()));
        r.insert("page_slug".into(), Some("people/alice-example".into()));
    }
    r
}

#[test]
fn files_keep_ids_times_and_the_page_index() {
    let s = seeded_pages();
    let mut later = file_row("52", "files/b.png", Some("7"));
    later.insert("created_at".into(), Some("2026-03-02 00:00:00+00".into()));
    let r = import(
        &s,
        "files",
        vec![
            file_row("51", "files/a.png", Some("7")),
            later,
            file_row("53", "files/c.png", None),
        ],
    );
    assert_eq!((r.imported, r.skipped), (3, 0));
    assert!(r.unmapped_columns.is_empty());

    let a = s.get_file("default", "files/a.png").unwrap().unwrap();
    assert_eq!(a["id"], json!(51));
    assert_eq!(a["page_id"], json!(7));
    assert_eq!(a["page_slug"], "people/alice-example");
    assert_eq!(a["size_bytes"], json!(2048));
    assert_eq!(a["metadata"], json!({"width": 10}));
    assert_eq!(a["created_at"], iso(us("2026-03-01T00:00:00.5Z")));
    let listed = s.list_files_for_page(&json!(7)).unwrap();
    let ids: Vec<_> = listed.iter().map(|f| f["id"].as_u64().unwrap()).collect();
    assert_eq!(ids, [51, 52]);
    assert_eq!(
        s.get_file("default", "files/c.png").unwrap().unwrap()["page_id"],
        Value::Null
    );

    assert_eq!(
        import(&s, "files", vec![file_row("51", "files/a.png", Some("7"))]).skipped,
        1
    );
    let err = s
        .import_relation(SEED, "files", vec![file_row("60", "files/a.png", None)])
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let err = s
        .import_relation(
            SEED,
            "files",
            vec![file_row("61", "files/d.png", Some("99"))],
        )
        .unwrap_err();
    assert_eq!(err.code, PAGE_NOT_FOUND);

    assert_eq!(counter(&s, "next_file_id"), 54);
    let spec = serde_json::from_value(json!({
        "filename": "n.png", "storage_path": "files/n.png", "content_hash": "h", "metadata": "{}"
    }))
    .unwrap();
    let next = s.upsert_file(&spec).unwrap();
    assert_eq!((next.id, next.created), (54, true));
}

#[test]
fn raw_data_keeps_fetched_at_and_retries_skip() {
    let s = seeded_pages();
    let raw = row(&[
        ("id", "5"),
        ("page_id", "7"),
        ("source", "crustdata"),
        ("data", r#"{"name": "Alice", "n": 1}"#),
        ("fetched_at", "2026-03-05 06:07:08.5+00"),
    ]);
    let r = import(&s, "raw_data", vec![raw.clone()]);
    assert_eq!(r.imported, 1);
    // The serial id is not kept: every row reports it.
    assert_eq!(r.unmapped_columns, vec!["id".to_string()]);
    let got = s
        .get_raw_data("people/alice-example", None, &Default::default())
        .unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["source"], "crustdata");
    assert_eq!(got[0]["data"], json!({"n": 1, "name": "Alice"}));
    assert_eq!(got[0]["fetched_at"], iso(us("2026-03-05T06:07:08.5Z")));

    assert_eq!(import(&s, "raw_data", vec![raw.clone()]).skipped, 1);
    let mut changed = raw.clone();
    changed.insert("data".into(), Some(r#"{"name": "Bob"}"#.into()));
    // The table has no id: the key is `(page_id, source)`, and the stored row is kept.
    assert_eq!(import(&s, "raw_data", vec![changed]).skipped, 1);
    let got = s
        .get_raw_data("people/alice-example", None, &Default::default())
        .unwrap();
    assert_eq!(got[0]["data"]["name"], "Alice");
    let mut orphan = raw;
    orphan.insert("page_id".into(), Some("99".into()));
    let err = s
        .import_relation(SEED, "raw_data", vec![orphan])
        .unwrap_err();
    assert_eq!(err.code, PAGE_NOT_FOUND);
    // The table has no id counter: nothing to raise.
}

fn chunk_row(id: &str, page_id: &str, index: &str, symbol: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("page_id", page_id),
        ("chunk_index", index),
        ("chunk_text", &format!("fn {symbol}() {{}}")),
        ("chunk_source", "compiled_truth"),
        ("symbol_name", symbol),
        ("model", "openai:text-embedding-3-large"),
    ])
}

fn edge_row(id: &str, from: &str, to: Option<&str>, to_symbol: &str, edge_type: &str) -> SeedRow {
    let mut r = row(&[
        ("id", id),
        ("from_chunk_id", from),
        ("from_symbol_qualified", "a.run"),
        ("to_symbol_qualified", to_symbol),
        ("edge_type", edge_type),
        ("edge_metadata", r#"{"line": 3}"#),
        ("source_id", "default"),
        ("created_at", "2026-04-01 00:00:00.75+00"),
    ]);
    if let Some(to) = to {
        r.insert("to_chunk_id".into(), Some(to.into()));
    }
    r
}

fn edges_store() -> Store {
    let s = seeded_pages();
    import(
        &s,
        "content_chunks",
        vec![
            chunk_row("41", "7", "0", "run"),
            chunk_row("42", "9", "0", "helper"),
        ],
    );
    s
}

fn lookup(name: &str) -> crate::code_edges::EdgeLookup {
    serde_json::from_value(json!({"name": name, "limit": 100})).unwrap()
}

#[test]
fn code_edges_chunk_keep_ids_and_every_index_key() {
    let s = edges_store();
    let r = import(
        &s,
        "code_edges_chunk",
        vec![edge_row("11", "41", Some("42"), "b.helper", "calls")],
    );
    assert_eq!((r.imported, r.skipped), (1, 0));
    assert!(r.unmapped_columns.is_empty());

    let callers = s.get_callers_of(&lookup("b.helper")).unwrap();
    assert_eq!(callers.len(), 1);
    assert_eq!(callers[0]["id"], json!(11));
    assert_eq!(callers[0]["resolved"], json!(true));
    assert_eq!(callers[0]["to_chunk_id"], json!(42));
    assert_eq!(callers[0]["edge_metadata"], json!({"line": 3}));
    let callees = s.get_callees_of(&lookup("a.run")).unwrap();
    assert_eq!(callees.len(), 1);
    assert_eq!(callees[0]["id"], json!(11));
    for (chunk, direction) in [(41, "out"), (42, "in")] {
        let by_chunk = s
            .get_edges_by_chunk(
                &serde_json::from_value(
                    json!({"chunk_id": chunk, "direction": direction, "limit": 50}),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(by_chunk.len(), 1, "{direction}");
    }
    // `created_at` is read from the stored row.
    let read = s.read().unwrap();
    let edge: crate::code_edges::EdgeRecord = get_json(&*read, &{
        let mut key = vec![keys::CODE_EDGE, 0x01, 0];
        key.extend_from_slice(&11u64.to_be_bytes());
        key
    })
    .unwrap()
    .unwrap();
    assert_eq!(edge.created_at_us, us("2026-04-01T00:00:00.75Z"));
    drop(read);

    assert_eq!(
        import(
            &s,
            "code_edges_chunk",
            vec![edge_row("11", "41", Some("42"), "b.helper", "calls")]
        )
        .skipped,
        1
    );
    let err = s
        .import_relation(
            SEED,
            "code_edges_chunk",
            vec![edge_row("12", "41", Some("42"), "b.helper", "calls")],
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    // A chunk the chunk table never reached is a missing parent.
    let err = s
        .import_relation(
            SEED,
            "code_edges_chunk",
            vec![edge_row("13", "41", Some("99"), "b.other", "calls")],
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);

    assert_eq!(counter(&s, "next_code_edge_chunk"), 12);
    let added = s
        .add_code_edges(&[serde_json::from_value(json!({
            "from_chunk_id": 42, "to_chunk_id": 41, "from_symbol_qualified": "b.helper",
            "to_symbol_qualified": "a.run", "edge_type": "calls", "edge_metadata": {},
            "source_id": "default",
        }))
        .unwrap()])
        .unwrap();
    assert_eq!(added, 1);
    let next = s.get_callers_of(&lookup("a.run")).unwrap();
    assert_eq!(next[0]["id"], json!(12));
}

#[test]
fn an_edge_to_the_highest_dropped_chunk_does_not_abort_the_seed() {
    // Value: protects=a code edge that names a retired or segmented chunk above every kept chunk is stored, not refused; fails_when=a dropped chunk
    // leaves the chunk id counter below its id; why_new=the edge tests only name kept chunks and a chunk id the table never reached; seam=none;
    // no_claim=reads of dropped chunks' edges (every edge read keeps only live chunk ends).
    let s = seeded_pages();
    let mut retired = chunk_row("42", "9", "0", "helper");
    retired.insert("retired_generation".into(), Some("1".into()));
    let mut segment = chunk_row("43", "9", "1", "segment");
    segment.insert("body_generation".into(), Some("1".into()));
    let r = import(
        &s,
        "content_chunks",
        vec![chunk_row("41", "7", "0", "run"), retired, segment],
    );
    assert_eq!((r.imported, r.dropped), (1, 2));
    let r = import(
        &s,
        "code_edges_chunk",
        vec![
            edge_row("11", "41", Some("42"), "b.helper", "calls"),
            edge_row("12", "43", Some("41"), "a.run", "calls"),
        ],
    );
    assert_eq!((r.imported, r.skipped), (2, 0));
    // A chunk id past every chunk the primary had is still a missing parent.
    let err = s
        .import_relation(
            SEED,
            "code_edges_chunk",
            vec![edge_row("13", "41", Some("44"), "b.other", "calls")],
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
}

#[test]
fn code_edges_symbol_keep_ids_and_every_index_key() {
    let s = edges_store();
    let r = import(
        &s,
        "code_edges_symbol",
        vec![edge_row("21", "41", None, "ext.log", "calls")],
    );
    assert_eq!((r.imported, r.skipped), (1, 0));
    let callers = s.get_callers_of(&lookup("ext.log")).unwrap();
    assert_eq!(callers.len(), 1);
    assert_eq!(callers[0]["id"], json!(21));
    assert_eq!(callers[0]["resolved"], json!(false));
    assert_eq!(callers[0]["to_chunk_id"], Value::Null);
    let callees = s.get_callees_of(&lookup("a.run")).unwrap();
    assert_eq!(callees[0]["id"], json!(21));
    let by_chunk = s
        .get_edges_by_chunk(
            &serde_json::from_value(json!({"chunk_id": 41, "direction": "out", "limit": 50}))
                .unwrap(),
        )
        .unwrap();
    assert_eq!(by_chunk.len(), 1);
    assert!(s.has_code_edges_symbol("default").unwrap());

    assert_eq!(
        import(
            &s,
            "code_edges_symbol",
            vec![edge_row("21", "41", None, "ext.log", "calls")]
        )
        .skipped,
        1
    );
    let err = s
        .import_relation(
            SEED,
            "code_edges_symbol",
            vec![edge_row("22", "41", None, "ext.log", "calls")],
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let mut stray = edge_row("23", "41", None, "ext.other", "calls");
    stray.insert("source_id".into(), Some("nope".into()));
    let err = s
        .import_relation(SEED, "code_edges_symbol", vec![stray])
        .unwrap_err();
    assert_eq!(err.code, SOURCE_NOT_FOUND);

    assert_eq!(counter(&s, "next_code_edge_symbol"), 22);
    let added = s
        .add_code_edges(&[serde_json::from_value(json!({
            "from_chunk_id": 42, "from_symbol_qualified": "b.helper",
            "to_symbol_qualified": "ext.log", "edge_type": "calls", "edge_metadata": {},
            "source_id": "default",
        }))
        .unwrap()])
        .unwrap();
    assert_eq!(added, 1);
    let ids: Vec<_> = s
        .get_callers_of(&lookup("ext.log"))
        .unwrap()
        .iter()
        .map(|e| e["id"].as_u64().unwrap())
        .collect();
    assert_eq!(ids, [21, 22]);
}

fn loop_row(id: &str, dedup: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("source_id", "default"),
        ("dedup_key", dedup),
        ("loop_type", "commitment_owed_by_me"),
        ("counterparty_slug", "people/alice-example"),
        ("counterparty_source_id", "default"),
        ("counterparty_email", "alice@example.com"),
        ("summary", "Send the deck"),
        ("evidence", r#"[{"msg": 1}]"#),
        ("thread_id", "t-1"),
        ("page_slug", "people/alice-example"),
        ("due_at", "2026-06-01 00:00:00+00"),
        ("status", "done"),
        ("detector", "llm_extract"),
        ("confidence", "0.7"),
        ("fact_id", "501"),
        ("opened_at", "2026-05-01 08:00:00+00"),
        ("last_activity_at", "2026-05-02 09:00:00+00"),
        ("closed_at", "2026-05-03 10:00:00+00"),
        ("closed_by", "manual"),
        ("created_at", "2026-05-01 08:00:01+00"),
        ("updated_at", "2026-05-03 10:00:01+00"),
    ])
}

fn list_loops(s: &Store) -> Vec<Value> {
    s.list_open_loops(&serde_json::from_value(json!({})).unwrap())
        .unwrap()
}

fn notice_row(id: &str, revision: &str, acked_at: Option<&str>) -> SeedRow {
    let mut r = row(&[
        ("id", id),
        ("source_id", "default"),
        ("slug", "people/alice-example"),
        ("page_id", "7"),
        ("revision", revision),
        ("base_revision", "rev-0"),
        ("base_text", "The page before the remote edit"),
        ("actor", "remote:agent"),
        ("created_at", "2026-05-04 11:00:00.25+00"),
    ]);
    r.insert("acked_at".to_string(), acked_at.map(str::to_owned));
    r
}

#[test]
fn core_edit_notices_keep_ids_times_and_acknowledgement() {
    // No page or source is seeded first: the table has no foreign key.
    let s = store();
    let r = import(
        &s,
        "core_edit_notices",
        vec![
            notice_row("5", "rev-1", Some("2026-05-05 12:00:00.5+00")),
            notice_row("8", "rev-2", None),
        ],
    );
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.unmapped_columns.is_empty());
    let pending = s.list_pending_core_edit_notices(None).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["revision"], "rev-2");
    assert_eq!(pending[0]["created_at"], "2026-05-04 11:00:00.25+00");
    assert_eq!(
        s.find_core_edit_notice_id_by_revision("default", "people/alice-example", "rev-1")
            .unwrap(),
        Some(5)
    );
    let oldest = s
        .read_oldest_pending_core_edit_notice("default", "people/alice-example")
        .unwrap()
        .unwrap();
    assert_eq!(oldest["base_text"], "The page before the remote edit");

    // A retry skips the rows it has; a changed copy of a held id is skipped, not overwritten.
    assert_eq!(
        import(
            &s,
            "core_edit_notices",
            vec![notice_row("5", "rev-1", None)]
        )
        .skipped,
        1
    );
    assert_eq!(
        import(
            &s,
            "core_edit_notices",
            vec![notice_row("8", "rev-9", None)]
        )
        .skipped,
        1
    );
    assert_eq!(
        s.list_pending_core_edit_notices(None).unwrap()[0]["revision"],
        "rev-2"
    );

    // The counter holds the next id, above the highest copied one.
    assert_eq!(counter(&s, "next_core_edit_notices_id"), 9);
    let input = serde_json::from_value(json!({
        "sourceId": "default", "slug": "people/alice-example", "actor": "remote:agent",
    }))
    .unwrap();
    assert_eq!(s.insert_core_edit_notice(&input).unwrap(), 9);
}

#[test]
fn a_core_edit_notice_without_its_required_columns_is_refused() {
    let s = store();
    for missing in ["source_id", "slug", "actor", "created_at"] {
        let mut r = notice_row("1", "rev-1", None);
        r.remove(missing);
        let err = s
            .import_relation(SEED, "core_edit_notices", vec![r])
            .unwrap_err();
        assert!(!err.to_string().is_empty(), "{missing}");
    }
    assert!(s.list_pending_core_edit_notices(None).unwrap().is_empty());
}

#[test]
fn open_loops_keep_ids_times_status_and_the_dedup_key() {
    let s = seeded_pages();
    let r = import(&s, "open_loops", vec![loop_row("71", "thread:t-1")]);
    assert_eq!((r.imported, r.skipped), (1, 0));
    assert!(r.unmapped_columns.is_empty());
    let loops = list_loops(&s);
    assert_eq!(loops.len(), 1);
    let l = &loops[0];
    assert_eq!(l["id"], json!(71));
    assert_eq!(l["status"], "done");
    assert_eq!(l["loop_type"], "commitment_owed_by_me");
    assert_eq!(l["summary"], "Send the deck");
    assert_eq!(l["evidence"], json!([{"msg": 1}]));
    assert_eq!(l["fact_id"], json!(501));
    assert_eq!(l["closed_by"], "manual");
    assert_eq!(l["counterparty_source_id"], "default");
    assert!((l["confidence"].as_f64().unwrap() - 0.7).abs() < 1e-6);
    for (column, text) in [
        ("opened_at", "2026-05-01T08:00:00Z"),
        ("last_activity_at", "2026-05-02T09:00:00Z"),
        ("closed_at", "2026-05-03T10:00:00Z"),
        ("created_at", "2026-05-01T08:00:01Z"),
        ("updated_at", "2026-05-03T10:00:01Z"),
        ("due_at", "2026-06-01T00:00:00Z"),
    ] {
        assert_eq!(l[column], iso(us(text)), "{column}");
    }

    assert_eq!(
        import(&s, "open_loops", vec![loop_row("71", "thread:t-1")]).skipped,
        1
    );
    let err = s
        .import_relation(SEED, "open_loops", vec![loop_row("72", "thread:t-1")])
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);

    assert_eq!(counter(&s, "next_open_loops_id"), 72);
    // The dedup key was written: an upsert of the same loop lands on the copied row.
    let input = |dedup: &str| {
        serde_json::from_value(json!({
            "sourceId": "default", "dedupKey": dedup, "loopType": "commitment_owed_by_me",
            "summary": "Again", "evidence": [], "detector": "manual",
        }))
        .unwrap()
    };
    let same = s.upsert_open_loop(&input("thread:t-1")).unwrap();
    assert_eq!((same.id, same.created), (71, false));
    let fresh = s.upsert_open_loop(&input("thread:t-2")).unwrap();
    assert!(fresh.created && fresh.id > 71, "{}", fresh.id);
}

#[test]
fn synthesis_evidence_keeps_created_at_and_needs_its_take() {
    let s = seeded_pages();
    import(
        &s,
        "takes",
        vec![row(&[
            ("id", "61"),
            ("page_id", "7"),
            ("row_num", "1"),
            ("claim", "Widgets win"),
            ("kind", "bet"),
            ("holder", "people/alice-example"),
            ("weight", "0.8"),
            ("active", "t"),
            ("created_at", "2026-01-05 00:00:00+00"),
            ("updated_at", "2026-01-06 00:00:00+00"),
        ])],
    );
    let evidence = |take_row: &str| {
        row(&[
            ("synthesis_page_id", "9"),
            ("take_page_id", "7"),
            ("take_row_num", take_row),
            ("citation_index", "2"),
            ("created_at", "2026-05-06 07:08:09.5+00"),
        ])
    };
    let r = import(&s, "synthesis_evidence", vec![evidence("1")]);
    assert_eq!((r.imported, r.skipped), (1, 0));
    assert!(r.unmapped_columns.is_empty());

    // The row and its reverse index are stored with the copied time and the synthesis source.
    let read = s.read().unwrap();
    let mut rows = Vec::new();
    crate::kv::scan_prefix(&*read, &[keys::TAKE, 0x03], false, &mut |_, v| {
        rows.push(serde_json::from_slice::<Value>(v).unwrap());
        true
    })
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["citation_index"], json!(2));
    assert_eq!(
        rows[0]["created_at_us"],
        json!(us("2026-05-06T07:08:09.5Z"))
    );
    assert_eq!(rows[0]["synthesis_source_id"], "default");
    let mut cited = 0;
    crate::kv::scan_prefix(&*read, &[keys::TAKE, 0x04], false, &mut |_, _| {
        cited += 1;
        true
    })
    .unwrap();
    assert_eq!(cited, 1);
    drop(read);

    assert_eq!(
        import(&s, "synthesis_evidence", vec![evidence("1")]).skipped,
        1
    );
    // `addSynthesisEvidence` sees the copied row: nothing is inserted twice.
    let again = serde_json::from_value(json!({
        "synthesis_page_id": 9, "take_page_id": 7, "take_row_num": 1, "citation_index": 5
    }))
    .unwrap();
    assert_eq!(s.add_synthesis_evidence(&[again]).unwrap(), 0);
    // A take that is not stored is a missing parent.
    let err = s
        .import_relation(SEED, "synthesis_evidence", vec![evidence("2")])
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let mut orphan = evidence("1");
    orphan.insert("synthesis_page_id".into(), Some("99".into()));
    let err = s
        .import_relation(SEED, "synthesis_evidence", vec![orphan])
        .unwrap_err();
    assert_eq!(err.code, PAGE_NOT_FOUND);
}

fn proposal_row(id: &str, status: &str, target: &str) -> SeedRow {
    let mut r = row(&[
        ("id", id),
        ("action", "forget"),
        ("source_id", "default"),
        ("target_table", "facts"),
        ("target_id", target),
        ("related_table", "facts"),
        ("related_id", "9"),
        ("before_state", r#"{"visibility": "world"}"#),
        ("after_state", r#"{"visibility": "private"}"#),
        ("proposer", "fence_projection"),
        ("proposer_principal_kind", "token"),
        ("proposer_principal_id", "tok-1"),
        ("write_request_id", REV),
        ("status", status),
        ("created_at", "2026-07-01 00:00:00+00"),
        ("updated_at", "2026-07-02 00:00:00+00"),
    ]);
    if status != "pending" {
        r.insert("decided_at".into(), Some("2026-07-02 00:00:00+00".into()));
        r.insert("decided_principal_kind".into(), Some("owner".into()));
        r.insert("decided_principal_id".into(), Some("garry".into()));
    }
    r
}

#[test]
fn trust_proposals_keep_status_decisions_and_index_keys() {
    let s = store();
    let r = import(
        &s,
        "trust_proposals",
        vec![
            proposal_row("81", "pending", "5"),
            proposal_row("82", "accepted", "6"),
            proposal_row("83", "pending", "7"),
        ],
    );
    assert_eq!((r.imported, r.skipped), (3, 0));
    assert_eq!(
        r.unmapped_columns,
        vec![
            "proposer_principal_id".to_string(),
            "proposer_principal_kind".to_string(),
            "write_request_id".to_string()
        ]
    );
    let pending = s.get_trust_proposal(81).unwrap().unwrap();
    assert_eq!(pending["status"], "pending");
    assert_eq!(pending["created_at"], iso(us("2026-07-01T00:00:00Z")));
    assert_eq!(pending["updated_at"], iso(us("2026-07-02T00:00:00Z")));
    assert_eq!(pending["before_state"], json!({"visibility": "world"}));
    assert_eq!(pending["related_id"], json!(9));
    assert_eq!(pending["proposer_principal_kind"], Value::Null);
    let accepted = s.get_trust_proposal(82).unwrap().unwrap();
    assert_eq!(accepted["status"], "accepted");
    assert_eq!(accepted["decided_at"], iso(us("2026-07-02T00:00:00Z")));
    assert_eq!(accepted["decided_principal_kind"], "owner");
    assert_eq!(accepted["decided_principal_id"], "garry");

    // Only pending proposals hold the pending key; every proposal is in the row index.
    let by_target = s.pending_trust_proposals_for("facts", 5).unwrap();
    assert_eq!(by_target.len(), 1);
    assert!(
        s.pending_trust_proposals_for("facts", 6)
            .unwrap()
            .is_empty()
    );
    let by_related = s.pending_trust_proposals_for("facts", 9).unwrap();
    let ids: Vec<_> = by_related
        .iter()
        .map(|p| p["id"].as_u64().unwrap())
        .collect();
    assert_eq!(ids, [81, 83]);
    let all = s
        .list_trust_proposals(&serde_json::from_value(json!({"status": "all"})).unwrap())
        .unwrap();
    assert_eq!(all.len(), 3);

    assert_eq!(
        import(
            &s,
            "trust_proposals",
            vec![proposal_row("81", "pending", "5")]
        )
        .skipped,
        1
    );
    // The pending unique key: another pending proposal of the same action and rows conflicts.
    let err = s
        .import_relation(
            SEED,
            "trust_proposals",
            vec![proposal_row("90", "pending", "5")],
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    // A decided proposal of the same rows does not.
    assert_eq!(
        import(
            &s,
            "trust_proposals",
            vec![proposal_row("91", "rejected", "5")]
        )
        .imported,
        1
    );

    assert_eq!(counter(&s, "trust_proposals"), 92);
    let new = s
        .insert_trust_proposal(
            &serde_json::from_value(json!({
                "action": "forget", "sourceId": "default", "target": {"table": "facts", "id": 100},
                "before": {}, "proposer": "x",
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(new["id"], json!(92));
}

fn wanted_row(id: &str, kind: &str, target: &str, checked_at: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("origin_page_id", "7"),
        ("source_id", "default"),
        ("producer", "body"),
        ("ref_kind", kind),
        ("target_source_id", "default"),
        ("target_ref", target),
        ("link_type", "mentions"),
        ("context", "see [[x]]"),
        ("checked_at", checked_at),
        ("first_seen_at", "2026-08-01 00:00:00.5+00"),
    ])
}

#[test]
fn wanted_links_keep_checked_at_first_seen_and_the_row_key() {
    let s = seeded_pages();
    let r = import(
        &s,
        "wanted_links",
        vec![
            wanted_row("101", "name", "Bob Example", "2026-08-02 00:00:00+00"),
            wanted_row("102", "slug", "people/bob-example", "-infinity"),
        ],
    );
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert!(r.unmapped_columns.is_empty());
    let pages = s.list_wanted_pages(&Default::default()).unwrap();
    assert_eq!(pages.total, 2);
    let by_target = |t: &str| pages.rows.iter().find(|p| p.target == t).unwrap();
    let name = by_target("Bob Example");
    assert_eq!(name.ref_kind, "name");
    assert_eq!(name.first_seen, "2026-08-01T00:00:00.500Z");
    assert_eq!(name.last_checked, "2026-08-02T00:00:00.000Z");
    assert_eq!(name.link_types, ["mentions"]);
    // `-infinity` is a row the target was live for: never checked since.
    let slug = by_target("people/bob-example");
    assert_eq!(slug.last_checked, "pending");

    assert_eq!(
        import(
            &s,
            "wanted_links",
            vec![wanted_row(
                "101",
                "name",
                "Bob Example",
                "2026-08-02 00:00:00+00"
            )]
        )
        .skipped,
        1
    );
    let err = s
        .import_relation(
            SEED,
            "wanted_links",
            vec![wanted_row(
                "110",
                "name",
                "Bob Example",
                "2026-08-02 00:00:00+00",
            )],
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);

    // The row key is the family's: a replace keeps the copied id and first_seen.
    assert_eq!(counter(&s, "wanted_link_id"), 103);
    let replacement = serde_json::from_value(json!({
        "rows": [
            {"producer": "body", "ref_kind": "name", "target_source_id": "default",
             "target_ref": "Bob Example", "link_type": "mentions", "context": "new"},
            {"producer": "body", "ref_kind": "name", "target_source_id": "default",
             "target_ref": "Carol Example", "link_type": "mentions", "context": "new"},
        ],
        "producers": ["body"],
        "readAt": "2026-09-01T00:00:00Z",
    }))
    .unwrap();
    assert_eq!(
        s.replace_wanted_link_rows(7, "default", &replacement)
            .unwrap(),
        2
    );
    assert_eq!(counter(&s, "wanted_link_id"), 104);
    let pages = s.list_wanted_pages(&Default::default()).unwrap();
    assert_eq!(pages.total, 2);
    let bob = pages
        .rows
        .iter()
        .find(|p| p.target == "Bob Example")
        .unwrap();
    assert_eq!(bob.first_seen, "2026-08-01T00:00:00.500Z");
}

#[test]
fn page_facts_reconcile_keeps_the_watermark() {
    let s = seeded_pages();
    let backlog = |s: &Store| {
        s.list_facts_reconcile_backlog(
            &serde_json::from_value(json!({"marker": "<!--facts-->"})).unwrap(),
        )
        .unwrap()
    };
    // Page 9 holds the marker, page 7 does not: one due row before the seed.
    assert_eq!(backlog(&s)["rows"].as_array().unwrap().len(), 1);
    let complete = row(&[
        ("page_id", "9"),
        ("reconciled_revision", REV),
        ("reconciled_at", "2026-09-01 00:00:00+00"),
        ("outcome", "complete"),
        ("attempted_revision", REV),
        ("attempted_at", "2026-09-01 00:00:00.5+00"),
    ]);
    let r = import(&s, "page_facts_reconcile", vec![complete.clone()]);
    assert_eq!((r.imported, r.skipped), (1, 0));
    assert!(r.unmapped_columns.is_empty());
    assert!(backlog(&s)["rows"].as_array().unwrap().is_empty());
    let read = s.read().unwrap();
    let mark = crate::facts::reconcile::read_reconcile(&*read, 9, "test")
        .unwrap()
        .unwrap();
    assert_eq!(mark.reconciled_revision.as_deref(), Some(REV));
    assert_eq!(mark.reconciled_at_us, Some(us("2026-09-01T00:00:00Z")));
    assert_eq!(mark.attempted_at_us, us("2026-09-01T00:00:00.5Z"));
    drop(read);
    assert_eq!(
        import(&s, "page_facts_reconcile", vec![complete]).skipped,
        1
    );

    // A page last attempted at its current revision as invalid reads as invalid in the backlog.
    let s = seeded_pages();
    import(
        &s,
        "page_facts_reconcile",
        vec![{
            let mut r = row(&[
                ("page_id", "9"),
                ("outcome", "invalid"),
                ("attempted_revision", REV),
                ("attempted_at", "2026-09-02 00:00:00+00"),
            ]);
            r.insert("reconciled_revision".into(), Some(OTHER_REV.into()));
            r
        }],
    );
    assert_eq!(backlog(&s)["rows"][0]["invalid"], json!(true));
    let err = s
        .import_relation(
            SEED,
            "page_facts_reconcile",
            vec![row(&[
                ("page_id", "99"),
                ("outcome", "complete"),
                ("attempted_at", "2026-09-02 00:00:00+00"),
            ])],
        )
        .unwrap_err();
    assert_eq!(err.code, PAGE_NOT_FOUND);
}

fn attempt_row(fact_id: &str, outcome: &str, attempted_at: &str) -> SeedRow {
    row(&[
        ("source_id", "default"),
        ("fact_id", fact_id),
        ("outcome", outcome),
        ("reason", "because"),
        ("tier", "paid_reextract"),
        ("model", "m-1"),
        ("target_slug", "people/alice-example"),
        ("run_id", "run-1"),
        ("attempted_at", attempted_at),
    ])
}

#[test]
fn fact_relink_attempts_keep_attempted_at_and_both_keys() {
    let s = store();
    let recent = iso(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64
        - 3_600_000_000);
    let r = import(
        &s,
        "fact_relink_attempts",
        vec![
            attempt_row("501", "linked", "2020-01-01 00:00:00+00"),
            attempt_row("502", "linked", &recent),
            attempt_row("503", "no_subject", "2020-01-02 00:00:00+00"),
        ],
    );
    assert_eq!((r.imported, r.skipped), (3, 0));
    assert!(r.unmapped_columns.is_empty());
    let outcomes = s
        .list_fact_relink_outcomes("default", &[501.0, 502.0, 503.0], &["linked".to_string()])
        .unwrap();
    let ids: Vec<_> = outcomes
        .iter()
        .map(|o| o["fact_id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [501, 502]);
    // `linked` counts only inside the last seven days: the stored attempted_at decides.
    let counts = s
        .count_fact_relink_outcomes(&["default".to_string()])
        .unwrap();
    assert_eq!(counts.len(), 2);
    let n = |outcome: &str| {
        counts
            .iter()
            .find(|c| c["outcome"] == outcome)
            .map(|c| c["n"].as_u64().unwrap())
    };
    assert_eq!((n("linked"), n("no_subject")), (Some(1), Some(1)));

    assert_eq!(
        import(
            &s,
            "fact_relink_attempts",
            vec![attempt_row("501", "linked", "2020-01-01 00:00:00+00")]
        )
        .skipped,
        1
    );
    // The memo index entry (`F 0x0B`) was written: deleting the page's memos finds the rows.
    s.delete_fact_relink_memos("default", "paid_reextract", "people/alice-example")
        .unwrap();
    let left = s
        .list_fact_relink_outcomes(
            "default",
            &[501.0, 502.0, 503.0],
            &["linked".into(), "no_subject".into()],
        )
        .unwrap();
    assert!(left.is_empty(), "{left:?}");
}

fn generation_row(id: &str, owner: &str, state: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("source_id", "default"),
        ("kind", "fence"),
        ("owner_key", owner),
        ("generation", "4"),
        ("state", state),
        ("run_id", "run-1"),
        ("operation_id", "op-1"),
        ("input_pin", "pin"),
        ("completeness", "{}"),
        ("item_set_hash", "hash"),
        ("attempts", "0"),
        ("created_at", "2026-10-01 00:00:00.5+00"),
        ("updated_at", "2026-10-02 00:00:00+00"),
    ])
}

fn item_row(generation_id: &str, key: &str, action: &str, preimage: Option<&str>) -> SeedRow {
    let mut r = row(&[
        ("generation_id", generation_id),
        ("item_key", key),
        ("identity_hash", "id-hash"),
        ("action", action),
        ("pending", "f"),
    ]);
    if let Some(p) = preimage {
        r.insert("preimage".into(), Some(p.into()));
    }
    r
}

#[test]
fn derived_generations_and_items_read_back_through_unwithdrawn_facts() {
    let s = seeded_pages();
    import(
        &s,
        "facts",
        vec![row(&[
            ("id", "501"),
            ("source_id", "default"),
            ("entity_slug", "people/alice-example"),
            ("fact", "Alice founded acme"),
            ("kind", "fact"),
            ("visibility", "world"),
            ("valid_from", "2026-01-01 00:00:00+00"),
            ("expired_at", "2026-02-01 00:00:00+00"),
            ("source", "meeting"),
            ("created_at", "2026-01-01 12:00:00+00"),
        ])],
    );
    let read = |s: &Store| {
        s.list_unwithdrawn_facts(
            &serde_json::from_value(json!({"sourceIds": ["default"], "fenceKind": "fence"}))
                .unwrap(),
        )
        .unwrap()
    };
    assert!(read(&s).is_empty());

    let preimage =
        r#"{"id": 501, "row_num": 1, "fact": "Alice founded acme", "visibility": "world"}"#;
    let r = import(
        &s,
        "derived_generations",
        vec![
            generation_row("301", "page:people/alice-example", "superseded"),
            generation_row("302", "page:companies/acme-example", "live"),
        ],
    );
    assert_eq!((r.imported, r.skipped), (2, 0));
    assert_eq!(
        r.unmapped_columns,
        [
            "input_pin",
            "item_set_hash",
            "operation_id",
            "run_id",
            "updated_at"
        ]
        .map(String::from)
    );
    // A generation with no items lists nothing.
    assert!(read(&s).is_empty());

    let r = import(
        &s,
        "derived_generation_items",
        vec![
            item_row("301", "fact:501", "retired", Some(preimage)),
            item_row("301", "fact:502", "published", None),
            item_row("302", "fact:9", "kept", None),
        ],
    );
    assert_eq!((r.imported, r.skipped), (3, 0));
    assert_eq!(r.unmapped_columns, vec!["identity_hash".to_string()]);
    let rows = read(&s);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], json!(501));
    assert_eq!(rows[0]["slug"], "people/alice-example");
    assert_eq!(rows[0]["generation_id"], json!(301));
    assert_eq!(rows[0]["generation"], json!(4));
    assert_eq!(rows[0]["retired_at"], iso(us("2026-10-01T00:00:00.5Z")));
    assert_eq!(rows[0]["preimage"]["row_num"], json!(1));

    // Retries skip, in either table.
    assert_eq!(
        import(
            &s,
            "derived_generations",
            vec![generation_row(
                "301",
                "page:people/alice-example",
                "superseded"
            )]
        )
        .skipped,
        1
    );
    assert_eq!(
        import(
            &s,
            "derived_generation_items",
            vec![item_row("301", "fact:501", "retired", Some(preimage))]
        )
        .skipped,
        1
    );
    assert_eq!(read(&s).len(), 1);
    // An item needs its generation.
    let err = s
        .import_relation(
            SEED,
            "derived_generation_items",
            vec![item_row("999", "fact:1", "kept", None)],
        )
        .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    // A held generation is not read.
    import(
        &s,
        "derived_generations",
        vec![generation_row("303", "page:people/alice-example", "held")],
    );
    import(
        &s,
        "derived_generation_items",
        vec![item_row("303", "fact:501", "retired", Some(preimage))],
    );
    assert_eq!(read(&s)[0]["generation_id"], json!(301));
}
