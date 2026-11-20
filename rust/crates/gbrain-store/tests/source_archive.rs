//! Source archive (`archiveSource`, `restoreArchivedSource`, `listArchivedSourceRows`,
//! `listExpiredArchivedSources`, `listUnverifiedArchivedSourceIds`, `readSourceImpactCounts`) and
//! the source's OAuth clients (`listSourceOAuthClients`), on a clock the test moves.

mod memory_env;

use gbrain_store::jobs::ClientInsert;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::raw_files::FileSpec;
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
fn impact_counts_cover_pages_with_deleted_ones_and_a_missing_source_is_none() {
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
    let counts = b.read_source_impact_counts("wiki").unwrap().unwrap();
    assert_eq!(counts.name.as_deref(), Some("Wiki"));
    assert_eq!(counts.pages, 2);
    // Only the source's own files count.
    assert_eq!((counts.embeddings, counts.files, counts.facts), (0, 2, 0));
    assert_eq!(b.read_source_impact_counts("nope").unwrap(), None);
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
