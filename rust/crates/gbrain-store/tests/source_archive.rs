//! Source archive (`archiveSource`, `restoreArchivedSource`, `listArchivedSourceRows`,
//! `listExpiredArchivedSources`, `listUnverifiedArchivedSourceIds`, `readSourceDeleteImpact`) and
//! the source's OAuth clients (`listSourceOAuthClients`) and the source delete
//! (`deleteSourceRecord`), on a clock the test moves.

mod memory_env;

use gbrain_store::jobs::ClientInsert;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::raw_files::FileSpec;
use gbrain_store::trust::write_gate::{HoldInput, HoldListOpts};
use memory_env::{Brain, T0, brain};
use serde_json::{Map, Value, json};

const HOUR: i64 = 3_600_000_000;

fn page(b: &Brain, source: &str, slug: &str) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": "body"
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    b.put_page(slug, &input, &opts).unwrap();
}

#[test]
fn archive_sets_both_times_and_federated_false_and_restore_clears_them() {
    let b = brain("archive-restore");
    let mut config = Map::new();
    config.insert("federated".into(), Value::Bool(true));
    b.insert_source("wiki", "Wiki", None, &config).unwrap();
    let row = b.archive_source("wiki", 72).unwrap().expect("archived");
    assert_eq!(row.id, "wiki");
    assert_eq!(row.name.as_deref(), Some("Wiki"));
    assert_eq!(row.archived_at, gbrain_store::env::iso(T0));
    assert_eq!(
        row.archive_expires_at,
        gbrain_store::env::iso(T0 + 72 * HOUR)
    );
    // Already archived, and missing: no row, as the SQL's `WHERE archived = false`.
    assert_eq!(b.archive_source("wiki", 72).unwrap(), None);
    assert_eq!(b.archive_source("nope", 72).unwrap(), None);
    let listed = b.list_archived_source_rows().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        listed[0].archived_at.as_deref(),
        Some(row.archived_at.as_str())
    );
    assert_eq!(
        b.get_source("wiki").unwrap().unwrap().config["federated"],
        json!(false)
    );
    assert!(b.restore_archived_source("wiki", true).unwrap());
    assert!(!b.restore_archived_source("wiki", true).unwrap());
    assert!(b.list_archived_source_rows().unwrap().is_empty());
    assert_eq!(
        b.get_source("wiki").unwrap().unwrap().config["federated"],
        json!(true)
    );
    // Archive again, then restore with federation off.
    b.archive_source("wiki", 72)
        .unwrap()
        .expect("archived again");
    assert!(b.restore_archived_source("wiki", false).unwrap());
    assert_eq!(
        b.get_source("wiki").unwrap().unwrap().config["federated"],
        json!(false)
    );
}

#[test]
fn the_list_is_newest_first_with_unverified_archives_first_and_counts_deleted_pages() {
    let b = brain("archive-list");
    for id in ["a", "b", "c", "d"] {
        b.insert_source(id, id, None, &Map::new()).unwrap();
    }
    page(&b, "a", "notes/one");
    page(&b, "a", "notes/two");
    b.soft_delete_page("notes/two", Some("a")).unwrap();
    b.archive_source("a", 72).unwrap().unwrap();
    b.clock.advance(HOUR);
    b.archive_source("b", 72).unwrap().unwrap();
    // `c` is archived without times (an unverified archive); `d` stays active.
    b.set_source_archived("c", true).unwrap();
    let ids: Vec<(String, u64)> = b
        .list_archived_source_rows()
        .unwrap()
        .into_iter()
        .map(|r| (r.id, r.page_count))
        .collect();
    assert_eq!(ids, [("c".into(), 0), ("b".into(), 0), ("a".into(), 2)]);
    assert_eq!(b.list_unverified_archived_source_ids().unwrap(), ["c"]);
    assert!(b.list_expired_archived_sources().unwrap().is_empty());
}

#[test]
fn an_archive_expires_only_once_its_window_has_passed() {
    let b = brain("archive-expired");
    for id in ["old", "new"] {
        b.insert_source(id, id, Some(&format!("/work/{id}")), &Map::new())
            .unwrap();
    }
    b.archive_source("old", 1).unwrap().unwrap();
    b.archive_source("new", 72).unwrap().unwrap();
    assert!(b.list_expired_archived_sources().unwrap().is_empty());
    b.clock.advance(HOUR);
    let expired = b.list_expired_archived_sources().unwrap();
    assert_eq!(expired.len(), 1);
    assert_eq!(expired[0].id, "old");
    assert_eq!(expired[0].local_path.as_deref(), Some("/work/old"));
    assert_eq!(expired[0].config.get("federated"), Some(&json!(false)));
    // A negative window is already past.
    b.insert_source("gone", "gone", None, &Map::new()).unwrap();
    b.archive_source("gone", -1).unwrap().unwrap();
    let ids: Vec<String> = b
        .list_expired_archived_sources()
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    assert_eq!(ids, ["gone", "old"]);
    assert!(b.list_unverified_archived_source_ids().unwrap().is_empty());
}

#[test]
fn the_delete_impact_covers_pages_with_deleted_ones_and_a_missing_source_is_none() {
    let b = brain("archive-impact");
    b.insert_source("wiki", "Wiki", None, &Map::new()).unwrap();
    page(&b, "wiki", "notes/one");
    page(&b, "wiki", "notes/two");
    b.soft_delete_page("notes/two", Some("wiki")).unwrap();
    for (source, path) in [
        ("wiki", "a/one.png"),
        ("wiki", "a/two.png"),
        ("default", "a/three.png"),
    ] {
        let spec: FileSpec = serde_json::from_value(json!({
            "source_id": source, "filename": path, "storage_path": path, "content_hash": path, "metadata": "{}",
        }))
        .unwrap();
        b.upsert_file(&spec).unwrap();
    }
    let counts = b.read_source_delete_impact("wiki").unwrap().unwrap();
    assert_eq!(
        (counts.id.as_str(), counts.name.as_deref()),
        ("wiki", Some("Wiki"))
    );
    assert_eq!(counts.pages, 2);
    // Only the source's own files count.
    assert_eq!((counts.embeddings, counts.files, counts.facts), (0, 2, 0));
    assert_eq!(b.read_source_delete_impact("nope").unwrap(), None);
}

#[test]
fn the_source_client_list_names_revoked_clients_and_skips_other_sources() {
    let b = brain("archive-clients");
    for id in ["src-a", "src-b"] {
        b.insert_source(id, id, None, &Map::new()).unwrap();
    }
    for (id, source, deleted) in [
        ("zed", "src-a", None),
        ("amy", "src-a", Some("2027-01-01T00:00:00Z")),
        ("bob", "src-b", None),
    ] {
        let row: ClientInsert = serde_json::from_value(json!({
            "client_id": id, "client_name": format!("{id} app"), "source_id": source, "deleted_at": deleted,
        }))
        .unwrap();
        b.insert_oauth_client(&row).unwrap();
    }
    assert_eq!(
        b.list_source_oauth_clients("src-a").unwrap(),
        json!([
            { "client_id": "amy", "client_name": "amy app", "deleted": true },
            { "client_id": "zed", "client_name": "zed app", "deleted": false },
        ])
    );
    assert_eq!(b.list_source_oauth_clients("nope").unwrap(), json!([]));
}

fn hold(b: &Brain, source: &str) {
    let input: HoldInput = serde_json::from_value(json!({
        "kind": "fact", "source_id": source, "slug": "notes/shared", "fingerprint": "fp",
        "detector_version": 1, "tier": "agent_written", "reason_families": ["override"],
        "reasons": ["override found"], "detector_error": false,
        "payload": {}, "write_origin": null, "request_id": null,
    }))
    .unwrap();
    b.upsert_write_gate_hold(input).unwrap();
}

#[test]
fn deleting_a_source_removes_its_pages_holds_and_cursors_and_keeps_other_sources() {
    let b = brain("archive-delete");
    for id in ["stale", "keeper"] {
        b.insert_source(id, id, None, &Map::new()).unwrap();
        page(&b, id, "notes/shared");
        hold(&b, id);
        b.write_op_checkpoint_record(
            "managed-sync",
            &format!("{id}-cursor"),
            Some(&json!([{ "sourceId": id }])),
        )
        .unwrap();
    }
    page(&b, "stale", "notes/only-here");
    // A missing source and, for the purge, a source that is not an expired archive: no change.
    assert!(!b.delete_source_record("nope", false).unwrap());
    assert!(!b.delete_source_record("stale", true).unwrap());
    b.archive_source("stale", 72).unwrap().unwrap();
    assert!(!b.delete_source_record("stale", true).unwrap());
    assert_eq!(b.count_source_pages("stale", true).unwrap(), 2);
    b.clock.advance(72 * HOUR);
    assert!(b.delete_source_record("stale", true).unwrap());
    assert!(b.get_source("stale").unwrap().is_none());
    assert_eq!(b.count_source_pages("stale", true).unwrap(), 0);
    assert_eq!(b.count_source_pages("keeper", true).unwrap(), 1);
    let opts: HoldListOpts =
        serde_json::from_value(json!({ "status": "all", "limit": 100 })).unwrap();
    let holds: Vec<Value> = b
        .list_write_gate_hold_rows(&opts)
        .unwrap()
        .into_iter()
        .map(|row| row["source_id"].clone())
        .collect();
    assert_eq!(holds, [json!("keeper")]);
    let cursors: Vec<Value> = b
        .list_op_checkpoint_records("managed-sync")
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["fingerprint"].clone())
        .collect();
    assert_eq!(cursors, [json!("keeper-cursor")]);
    // A source made again with the same id starts empty.
    b.insert_source("stale", "stale", None, &Map::new())
        .unwrap();
    assert_eq!(b.count_source_pages("stale", true).unwrap(), 0);
}

#[test]
fn an_oauth_client_of_the_source_refuses_its_delete_even_when_revoked() {
    let b = brain("archive-delete-client");
    b.insert_source("held", "held", None, &Map::new()).unwrap();
    page(&b, "held", "notes/one");
    let row: ClientInsert = serde_json::from_value(json!({
        "client_id": "old-app", "client_name": "old app", "source_id": "held", "deleted_at": "2027-01-01T00:00:00Z",
    }))
    .unwrap();
    b.insert_oauth_client(&row).unwrap();
    let err = b.delete_source_record("held", false).unwrap_err();
    assert_eq!(err.code, "constraint_violation");
    assert!(
        err.message.contains("oauth_clients_source_id_fkey"),
        "{}",
        err.message
    );
    assert!(b.get_source("held").unwrap().is_some());
    assert_eq!(b.count_source_pages("held", true).unwrap(), 1);
}
