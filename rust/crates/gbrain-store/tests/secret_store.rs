//! The secret store (`secret_store.rs`): the entries and occurrences of `secret_store` and `secret_store_occurrence`, the
//! checks and foreign keys their tables enforce, the backup restore reads, and the cascades (a page delete, a purge, a rename and
//! a source delete). The PGLite and Postgres parity cases are in test/engine-parity/repair-secret-spans.test.ts; these cover the
//! stored keys, the refusals and the cases the parity file cannot seed through typed members.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::secret_store::{
    BackupEntry, BackupOccurrence, SecretEntryInsert, SecretOccurrenceInsert,
};
use gbrain_store::sources::SourceInput;
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    (dir, store)
}

fn put_in(store: &Store, source: &str, slug: &str, body: &str) -> u64 {
    let input: PageInput =
        args(json!({ "type": "note", "title": slug, "compiled_truth": body, "timeline": "" }));
    let options: PutPageOptions = args(json!({ "sourceId": source }));
    store.put_page(slug, &input, &options).unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn put(store: &Store, slug: &str, body: &str) -> u64 {
    put_in(store, "default", slug, body)
}

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&args::<SourceInput>(json!({ "id": id, "name": id })))
        .unwrap();
}

fn id_n(n: u8) -> String {
    format!("ss_{n:012x}")
}

fn mac_n(n: u8) -> String {
    format!("{n:064x}")
}

fn entry(n: u8, source: &str, rule: &str) -> SecretEntryInsert {
    args(
        json!({ "id": id_n(n), "sourceId": source, "rule": rule, "ciphertext": "Y2lwaGVy", "nonce": "bm9uY2U=", "tag": "dGFn",
        "keyId": "0123456789abcdef", "keyHost": "host-a", "valueMac": mac_n(n) }),
    )
}

fn occurrence(
    entry_id: &str,
    source: &str,
    page: Option<u64>,
    slug: Option<&str>,
    field: &str,
) -> SecretOccurrenceInsert {
    args(
        json!({ "entryId": entry_id, "sourceId": source, "pageId": page, "slug": slug, "field": field, "origin": "repair", "createdBy": "test" }),
    )
}

fn seal(store: &Store, n: u8, rule: &str) -> String {
    let id = store
        .insert_secret_entry(&entry(n, "default", rule), "value")
        .unwrap();
    assert_eq!(id.as_deref(), Some(id_n(n).as_str()));
    id_n(n)
}

fn places(store: &Store, id: &str) -> Vec<(Option<String>, Option<u64>, String)> {
    store
        .list_secret_occurrences(id)
        .unwrap()
        .iter()
        .map(|o| {
            (
                o["slug"].as_str().map(str::to_owned),
                o["page_id"].as_u64(),
                o["field"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

#[test]
fn an_entry_is_one_row_per_source_and_value_and_the_conflict_clause_decides_a_clash() {
    let (_dir, store) = brain("secret-entry");
    assert_eq!(
        store
            .insert_secret_entry(&entry(1, "default", "github_token"), "value")
            .unwrap()
            .as_deref(),
        Some(id_n(1).as_str())
    );
    // The same value under another id: both clauses skip it; the same id with another value: only `any` skips it.
    let same_value = |n: u8| SecretEntryInsert {
        value_mac: mac_n(1),
        ..entry(n, "default", "github_token")
    };
    assert_eq!(
        store.insert_secret_entry(&same_value(2), "value").unwrap(),
        None
    );
    assert_eq!(
        store.insert_secret_entry(&same_value(2), "any").unwrap(),
        None
    );
    let same_id = SecretEntryInsert {
        value_mac: mac_n(9),
        ..entry(1, "default", "github_token")
    };
    assert_eq!(store.insert_secret_entry(&same_id, "any").unwrap(), None);
    assert_eq!(
        store
            .insert_secret_entry(&same_id, "value")
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        store
            .insert_secret_entry(&entry(3, "default", "aws_access_key"), "bogus")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    // Another source may hold the same value.
    source(&store, "other");
    assert!(
        store
            .insert_secret_entry(&entry(1, "other", "github_token"), "value")
            .is_err(),
        "the id is taken"
    );
    let other = SecretEntryInsert {
        id: id_n(4),
        ..entry(1, "other", "github_token")
    };
    assert_eq!(
        store
            .insert_secret_entry(&other, "value")
            .unwrap()
            .as_deref(),
        Some(id_n(4).as_str())
    );
    assert_eq!(
        store
            .find_secret_entry_by_mac("default", &mac_n(1))
            .unwrap()
            .as_deref(),
        Some(id_n(1).as_str())
    );
    assert_eq!(
        store
            .find_secret_entry_by_mac("other", &mac_n(1))
            .unwrap()
            .as_deref(),
        Some(id_n(4).as_str())
    );
    assert_eq!(
        store
            .find_secret_entry_by_mac("default", &mac_n(7))
            .unwrap(),
        None
    );
    assert!(store.secret_entry_exists(&id_n(1)).unwrap());
    assert!(!store.secret_entry_exists(&id_n(7)).unwrap());
    let row = store.read_secret_entry(&id_n(1)).unwrap().unwrap();
    assert_eq!(
        (
            row["status"].as_str(),
            row["rule"].as_str(),
            row["key_host"].as_str()
        ),
        (Some("active"), Some("github_token"), Some("host-a"))
    );
    assert!(
        row["created_at"].as_str().unwrap().ends_with("+00"),
        "timestamptz text: {row}"
    );
    assert_eq!(store.read_secret_entry(&id_n(7)).unwrap(), None);
}

#[test]
fn the_check_constraints_and_foreign_keys_refuse_and_write_nothing() {
    let (_dir, store) = brain("secret-checks");
    let bad = |f: &dyn Fn(&mut SecretEntryInsert)| {
        let mut row = entry(1, "default", "github_token");
        f(&mut row);
        store.insert_secret_entry(&row, "value").unwrap_err().code
    };
    assert_eq!(bad(&|r| r.id = "ss_xyz".into()), CONSTRAINT_VIOLATION);
    assert_eq!(
        bad(&|r| r.id = "ss_0123456789AB".into()),
        CONSTRAINT_VIOLATION
    );
    assert_eq!(bad(&|r| r.rule = "Bad Rule".into()), CONSTRAINT_VIOLATION);
    assert_eq!(bad(&|r| r.rule = "a".repeat(65)), CONSTRAINT_VIOLATION);
    assert_eq!(bad(&|r| r.rule = String::new()), CONSTRAINT_VIOLATION);
    assert_eq!(bad(&|r| r.key_id = "xyz".into()), CONSTRAINT_VIOLATION);
    assert_eq!(
        bad(&|r| r.value_mac = "ab".repeat(31)),
        CONSTRAINT_VIOLATION
    );
    assert_eq!(bad(&|r| r.ciphertext = "a\0b".into()), INVALID_ARGUMENT);
    assert_eq!(bad(&|r| r.source_id = "nowhere".into()), SOURCE_NOT_FOUND);
    assert_eq!(store.count_unreferenced_secret_entries().unwrap(), 0);
    let id = seal(&store, 1, "github_token");
    let page = put(&store, "notes/a", "body");
    let place = |f: &dyn Fn(&mut Value)| {
        let mut v = json!({ "entryId": id, "sourceId": "default", "pageId": page, "slug": "notes/a", "field": "title", "origin": "repair", "createdBy": "t" });
        f(&mut v);
        store.insert_secret_occurrence(&args(v)).unwrap_err().code
    };
    assert_eq!(
        place(&|v| v["origin"] = json!("nowhere")),
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        place(&|v| v["preFieldSha256"] = json!("abc")),
        CONSTRAINT_VIOLATION
    );
    assert_eq!(
        place(&|v| v["entryId"] = json!(id_n(9))),
        CONSTRAINT_VIOLATION
    );
    assert_eq!(place(&|v| v["pageId"] = json!(9999)), CONSTRAINT_VIOLATION);
    assert_eq!(place(&|v| v["pageId"] = json!(-1)), CONSTRAINT_VIOLATION);
    assert!(places(&store, &id).is_empty());
}

#[test]
fn occurrences_list_in_recording_order_and_summaries_counts_and_keys_group_by_entry() {
    let (_dir, store) = brain("secret-listings");
    let (a, b) = (put(&store, "notes/a", "x"), put(&store, "notes/b", "y"));
    let (e1, e2, e3) = (
        seal(&store, 1, "github_token"),
        seal(&store, 2, "github_token"),
        seal(&store, 3, "aws_access_key"),
    );
    store
        .insert_secret_occurrence(&occurrence(
            &e1,
            "default",
            Some(a),
            Some("notes/a"),
            "compiled_truth",
        ))
        .unwrap();
    store
        .insert_secret_occurrence(&occurrence(
            &e1,
            "default",
            Some(b),
            Some("notes/b"),
            "title",
        ))
        .unwrap();
    store
        .insert_secret_occurrence(&occurrence(
            &e1,
            "default",
            None,
            Some("notes/a"),
            "timeline",
        ))
        .unwrap();
    store
        .insert_secret_occurrence(&occurrence(
            &e2,
            "default",
            Some(a),
            Some("notes/a"),
            "title",
        ))
        .unwrap();
    let commit: SecretOccurrenceInsert = args(
        json!({ "entryId": e3, "sourceId": "default", "field": "compiled_truth", "origin": "publish_rebuild",
        "commit": "abc123", "path": "notes/c.md", "line": 7, "preFieldSha256": "ab".repeat(32) }),
    );
    store.insert_secret_occurrence(&commit).unwrap();
    let all = store.list_secret_occurrences(&e1).unwrap();
    assert_eq!(
        all.iter()
            .map(|o| o["field"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["compiled_truth", "title", "timeline"]
    );
    assert_eq!(
        store.list_secret_occurrences(&e3).unwrap()[0]["line"],
        json!(7)
    );
    assert_eq!(
        store.list_secret_occurrences(&e3).unwrap()[0]["commit_sha"],
        json!("abc123")
    );

    let summaries = store
        .list_secret_entry_summaries(Some("default"), None, 100)
        .unwrap();
    assert_eq!(
        summaries
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [e1.as_str(), e2.as_str(), e3.as_str()]
    );
    assert_eq!(
        (
            summaries[0]["occurrences"].as_u64(),
            summaries[0]["slugs"].clone()
        ),
        (Some(3), json!(["notes/a", "notes/b"]))
    );
    assert!(
        summaries[0].get("ciphertext").is_none() && summaries[0].get("value_mac").is_none(),
        "never a value or its mac"
    );
    assert_eq!(
        store
            .list_secret_entry_summaries(None, Some("notes/b"), 100)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .list_secret_entry_summaries(Some("other"), None, 100)
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        store
            .list_secret_entry_summaries(None, None, 2)
            .unwrap()
            .len(),
        2
    );

    assert_eq!(
        store.count_secrets_by_rule(None).unwrap(),
        vec![
            json!({ "rule": "aws_access_key", "entries": 1, "occurrences": 1 }),
            json!({ "rule": "github_token", "entries": 2, "occurrences": 4 })
        ]
    );
    assert!(
        store
            .count_secrets_by_rule(Some("other"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.list_secret_keys_in_use().unwrap(),
        vec![json!({ "key_id": "0123456789abcdef", "key_host": "host-a", "entries": 3 })]
    );

    // Restored entries: one source's list, and every source's in key order.
    store.mark_secret_entry_allowed(&e2).unwrap();
    store.mark_secret_entry_allowed(&e3).unwrap();
    store.mark_secret_entry_allowed(&id_n(99)).unwrap();
    assert_eq!(
        store
            .list_allowed_secret_macs(Some("default"))
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        store.list_allowed_secret_macs(None).unwrap()[0]["value_mac"],
        json!(mac_n(2))
    );
    assert!(
        store
            .list_allowed_secret_macs(Some("other"))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.read_secret_entry(&e2).unwrap().unwrap()["status"],
        json!("allowed")
    );

    // Only an entry no occurrence references can be deleted that way.
    assert!(!store.delete_unreferenced_secret_entry(&e1).unwrap());
    let loose = seal(&store, 4, "bearer");
    assert_eq!(store.count_unreferenced_secret_entries().unwrap(), 1);
    assert!(store.delete_unreferenced_secret_entry(&loose).unwrap());
    assert!(!store.delete_unreferenced_secret_entry(&loose).unwrap());
    assert_eq!(
        store
            .find_secret_entry_by_mac("default", &mac_n(4))
            .unwrap(),
        None,
        "the value key goes with the entry"
    );
    assert_eq!(store.count_unreferenced_secret_entries().unwrap(), 0);
}

#[test]
fn the_snapshot_names_a_page_place_by_the_slug_its_page_has_now() {
    let (_dir, store) = brain("secret-snapshot");
    let page = put(&store, "notes/old-name", "x");
    let id = seal(&store, 1, "github_token");
    store
        .insert_secret_occurrence(&occurrence(
            &id,
            "default",
            Some(page),
            Some("notes/stale"),
            "title",
        ))
        .unwrap();
    let on_commit: SecretOccurrenceInsert = args(
        json!({ "entryId": id, "sourceId": "default", "pageId": page, "slug": "notes/kept", "field": "f",
        "origin": "publish_rebuild", "commit": "c1", "path": "p", "line": 1 }),
    );
    store.insert_secret_occurrence(&on_commit).unwrap();
    let snapshot = store.read_secret_store_snapshot().unwrap();
    assert_eq!(snapshot["entries"].as_array().unwrap().len(), 1);
    let created = snapshot["entries"][0]["created_at"].as_str().unwrap();
    assert!(
        created.ends_with('Z') && created.len() == 24,
        "UTC ISO milliseconds: {created}"
    );
    let slugs: Vec<_> = snapshot["occurrences"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["slug"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        slugs,
        ["notes/old-name", "notes/kept"],
        "a page place follows its page; a commit place keeps its own slug"
    );
}

#[test]
fn a_backup_row_writes_once_for_a_source_the_brain_has_and_a_page_place_needs_a_page_that_holds_its_slug()
 {
    let (_dir, store) = brain("secret-backup");
    let page = put(&store, "notes/a", "body");
    let row = |n: u8, source: &str| -> BackupEntry {
        args(
            json!({ "id": id_n(n), "source_id": source, "rule": "github_token", "ciphertext": "Y2lwaGVy", "nonce": "bm9uY2U=", "tag": "dGFn", "key_id": "0123456789abcdef",
            "key_host": "h", "value_mac": mac_n(n), "status": "allowed", "created_at": "2026-11-21T10:00:00.123Z", "updated_at": "2026-11-21T11:00:00.456Z" }),
        )
    };
    assert!(
        store
            .insert_backup_secret_entry(&row(1, "default"))
            .unwrap()
    );
    assert!(
        !store
            .insert_backup_secret_entry(&row(1, "default"))
            .unwrap(),
        "the id is held"
    );
    assert!(
        !store
            .insert_backup_secret_entry(&BackupEntry {
                id: id_n(2),
                ..row(1, "default")
            })
            .unwrap(),
        "the value is held"
    );
    assert!(
        !store
            .insert_backup_secret_entry(&row(3, "nowhere"))
            .unwrap(),
        "no such source: skipped, not refused"
    );
    let kept = store.read_secret_entry(&id_n(1)).unwrap().unwrap();
    assert_eq!(kept["status"], json!("allowed"));
    assert_eq!(kept["created_at"], json!("2026-11-21 10:00:00.123+00"));
    assert_eq!(
        store.read_secret_store_snapshot().unwrap()["entries"][0]["updated_at"],
        json!("2026-11-21T11:00:00.456Z")
    );
    assert_eq!(
        store
            .insert_backup_secret_entry(&BackupEntry {
                created_at: "yesterday".into(),
                ..row(4, "default")
            })
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(
        store
            .read_backup_entry_hold(&id_n(1), "default", &mac_n(1))
            .unwrap(),
        Some(true)
    );
    assert_eq!(
        store
            .read_backup_entry_hold(&id_n(1), "default", &mac_n(2))
            .unwrap(),
        Some(false)
    );
    assert_eq!(
        store
            .read_backup_entry_hold(&id_n(8), "default", &mac_n(1))
            .unwrap(),
        None
    );

    let place = |slug: Option<&str>, commit: Option<&str>| -> BackupOccurrence {
        args(
            json!({ "entry_id": id_n(1), "source_id": "default", "slug": slug, "field": "compiled_truth", "origin": "repair", "commit_sha": commit,
            "created_by": "t", "created_at": "2026-11-21T10:00:00.789Z" }),
        )
    };
    // A page place needs the page id of the page that holds its slug; with none it is skipped.
    assert!(
        !store
            .insert_backup_secret_occurrence(&place(Some("notes/a"), None), None)
            .unwrap()
    );
    assert!(
        !store
            .insert_backup_secret_occurrence(&place(Some("notes/other"), None), Some(page as i64))
            .unwrap()
    );
    assert!(
        store
            .insert_backup_secret_occurrence(&place(Some("notes/a"), None), Some(page as i64))
            .unwrap()
    );
    assert!(
        !store
            .insert_backup_secret_occurrence(&place(Some("notes/a"), None), Some(page as i64))
            .unwrap(),
        "the same row, to the millisecond, is not written twice"
    );
    // A commit place needs no page; its slug still resolves to the page at that slug.
    assert!(
        store
            .insert_backup_secret_occurrence(&place(Some("notes/a"), Some("c1")), None)
            .unwrap()
    );
    assert!(
        store
            .insert_backup_secret_occurrence(&place(None, None), None)
            .unwrap()
    );
    assert_eq!(
        places(&store, &id_n(1))
            .iter()
            .map(|p| p.1)
            .collect::<Vec<_>>(),
        [Some(page), Some(page), None]
    );
    assert_eq!(
        store
            .insert_backup_secret_occurrence(
                &BackupOccurrence {
                    origin: "x".into(),
                    ..place(None, Some("c"))
                },
                None
            )
            .unwrap_err()
            .code,
        CONSTRAINT_VIOLATION
    );
}

#[test]
fn a_page_holds_a_marker_in_any_store_the_redaction_reads_and_only_for_the_entry_it_names() {
    let (_dir, store) = brain("secret-holding");
    let id = id_n(7);
    let marker = |rule: &str, id: &str| format!("<REDACTED:{rule}:{id}>");
    let holder = |slug: &str, body: &str| put(&store, slug, body);
    let (inline, timeline, take, link, fact, raw, clean, glued) = (
        holder(
            "notes/inline",
            &format!("see {}", marker("github_token", &id)),
        ),
        holder("notes/timeline", "x"),
        holder("notes/take", "x"),
        holder("notes/link", "x"),
        holder("notes/fact", "x"),
        holder("notes/raw", "x"),
        holder(
            "notes/clean",
            &format!("another {}", marker("github_token", &id_n(8))),
        ),
        holder(
            "notes/glued",
            &format!("<REDACTED:{}:{}>", "a".repeat(65), id),
        ),
    );
    store.add_timeline_entry("notes/timeline", &args::<TimelineInput>(json!({ "date": "2024-01-01", "source": "s", "summary": marker("openai", &id), "detail": "" })),
        &AddTimelineOptions::default()).unwrap();
    store.add_takes_batch(&[args(json!({ "page_id": take, "row_num": 1, "claim": "c", "kind": "bet", "holder": "h", "weight": 0.5, "active": true, "source": marker("aws_access_key", &id) }))]).unwrap();
    let opts: gbrain_store::links::AddLinkOptions =
        args(json!({ "context": marker("bearer", &id), "linkType": "mentions" }));
    store.add_link("notes/link", "notes/clean", &opts).unwrap();
    store.insert_fact(&args(json!({ "input": { "fact": "f", "context": marker("bearer", &id), "entity_slug": "notes/fact", "source": "s" }, "sourceId": "default" }))).unwrap();
    store
        .put_raw_data(
            "notes/raw",
            Some("src"),
            Some(&json!({ "nested": { "v": marker("openai", &id) } }).to_string()),
            None,
        )
        .unwrap();
    let slugs: Vec<String> = [
        "notes/inline",
        "notes/timeline",
        "notes/take",
        "notes/link",
        "notes/fact",
        "notes/raw",
        "notes/clean",
        "notes/glued",
        "notes/missing",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let rows = store
        .list_secret_holding_pages("default", &slugs, &id)
        .unwrap();
    let holds: Vec<(String, bool)> = rows
        .iter()
        .map(|r| {
            (
                r["slug"].as_str().unwrap().to_owned(),
                r["holds"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        holds,
        [
            ("notes/clean", false),
            ("notes/fact", true),
            ("notes/glued", false),
            ("notes/inline", true),
            ("notes/link", true),
            ("notes/raw", true),
            ("notes/take", true),
            ("notes/timeline", true)
        ]
        .map(|(s, h)| (s.to_owned(), h))
    );
    assert!(rows.iter().all(|r| r["segmented"] == json!(false)));
    let _ = (inline, timeline, take, link, fact, raw, clean, glued);
    assert!(
        store
            .list_secret_holding_pages("other", &slugs, &id)
            .unwrap()
            .is_empty()
    );
    // The restore preview: a live page whose title, body, timeline or frontmatter holds the marker.
    let m = marker("github_token", &id);
    assert_eq!(
        store
            .read_restore_page_hit("default", "notes/inline", &m)
            .unwrap()
            .unwrap()["hit"],
        json!(true)
    );
    assert_eq!(
        store
            .read_restore_page_hit("default", "notes/clean", &m)
            .unwrap()
            .unwrap()["hit"],
        json!(false)
    );
    assert_eq!(
        store
            .read_restore_page_hit("default", "notes/missing", &m)
            .unwrap(),
        None
    );
    store
        .soft_delete_pages(
            &["notes/inline".to_owned()],
            &args(json!({ "sourceId": "default" })),
        )
        .unwrap();
    assert_eq!(
        store
            .read_restore_page_hit("default", "notes/inline", &m)
            .unwrap(),
        None,
        "a tombstone is not live"
    );
}

#[test]
fn a_purge_takes_the_originals_only_the_purged_pages_held_and_leaves_the_rest() {
    let (_dir, store) = brain("secret-purge");
    let (a, b) = (put(&store, "notes/a", "x"), put(&store, "notes/b", "y"));
    let (only_a, shared, commit, loose) = (
        seal(&store, 1, "github_token"),
        seal(&store, 2, "aws_access_key"),
        seal(&store, 3, "openai"),
        seal(&store, 4, "bearer"),
    );
    store
        .insert_secret_occurrence(&occurrence(
            &only_a,
            "default",
            Some(a),
            Some("notes/a"),
            "title",
        ))
        .unwrap();
    store
        .insert_secret_occurrence(&occurrence(
            &shared,
            "default",
            Some(a),
            Some("notes/a"),
            "title",
        ))
        .unwrap();
    store
        .insert_secret_occurrence(&occurrence(
            &shared,
            "default",
            Some(b),
            Some("notes/b"),
            "title",
        ))
        .unwrap();
    let on_commit: SecretOccurrenceInsert = args(
        json!({ "entryId": commit, "sourceId": "default", "slug": "notes/a", "field": "f", "origin": "publish_rebuild", "commit": "c1", "path": "p" }),
    );
    store.insert_secret_occurrence(&on_commit).unwrap();
    // A place under a slug the page had before a rename still names the page by id, so a purge of the page finds it.
    store
        .insert_secret_occurrence(&occurrence(
            &loose,
            "default",
            Some(a),
            Some("notes/older"),
            "title",
        ))
        .unwrap();
    // A place whose slug is notes/a but whose page is another live page stays: the original belongs to that page.
    store
        .insert_secret_occurrence(&occurrence(
            &loose,
            "default",
            Some(b),
            Some("notes/a"),
            "title",
        ))
        .unwrap();

    let removed = store
        .delete_pages(
            &["notes/a".to_owned()],
            &args(json!({ "sourceId": "default" })),
        )
        .unwrap();
    assert_eq!(removed, ["notes/a"]);
    assert_eq!(
        store.read_secret_entry(&only_a).unwrap(),
        None,
        "the entry only the purged page held goes"
    );
    assert_eq!(
        places(&store, &shared),
        [(Some("notes/b".into()), Some(b), "title".into())]
    );
    assert!(
        store.read_secret_entry(&commit).unwrap().is_some(),
        "a commit place is not a page place"
    );
    assert_eq!(places(&store, &commit).len(), 1);
    assert_eq!(
        places(&store, &loose),
        [(Some("notes/a".into()), Some(b), "title".into())],
        "the stale-slug place of the purged page went; the live page's stayed"
    );

    // A tombstone purge does the same, per source.
    store
        .soft_delete_pages(
            &["notes/b".to_owned()],
            &args(json!({ "sourceId": "default" })),
        )
        .unwrap();
    assert!(
        store.read_secret_entry(&shared).unwrap().is_some(),
        "a soft delete keeps every row"
    );
    let purged = store.purge_deleted_pages(0.0, &args(json!({}))).unwrap();
    assert_eq!(purged["slugs"], json!(["notes/b"]));
    assert_eq!(store.read_secret_entry(&shared).unwrap(), None);
    assert_eq!(store.read_secret_entry(&loose).unwrap(), None);
    assert!(store.read_secret_entry(&commit).unwrap().is_some());
    assert_eq!(
        store
            .find_secret_entry_by_mac("default", &mac_n(2))
            .unwrap(),
        None,
        "the value key goes with its entry"
    );
}

#[test]
fn a_hard_delete_clears_the_page_id_of_what_it_leaves_and_a_rename_moves_only_the_pages_own_places()
{
    let (_dir, store) = brain("secret-rename");
    let a = put(&store, "notes/a", "x");
    let id = seal(&store, 1, "github_token");
    store
        .insert_secret_occurrence(&occurrence(
            &id,
            "default",
            Some(a),
            Some("notes/a"),
            "title",
        ))
        .unwrap();
    let elsewhere: SecretOccurrenceInsert = args(
        json!({ "entryId": id, "sourceId": "default", "slug": "notes/a", "field": "f", "origin": "publish_rebuild", "commit": "c1", "path": "p" }),
    );
    store.insert_secret_occurrence(&elsewhere).unwrap();
    store
        .insert_secret_occurrence(&occurrence(
            &id,
            "default",
            None,
            Some("notes/a"),
            "timeline",
        ))
        .unwrap();
    assert_eq!(store.update_slug("notes/a", "notes/z", None).unwrap(), 1);
    let moved: Vec<_> = places(&store, &id)
        .into_iter()
        .map(|p| (p.0.unwrap(), p.1.is_some()))
        .collect();
    assert_eq!(
        moved,
        [
            ("notes/z".to_owned(), true),
            ("notes/a".to_owned(), false),
            ("notes/z".to_owned(), false)
        ],
        "the commit place keeps its slug"
    );
    // A rename to a slug no other page owns does not touch a place another live page owns under the old slug.
    let b = put(&store, "notes/b", "y");
    store
        .insert_secret_occurrence(&occurrence(
            &id,
            "default",
            Some(b),
            Some("notes/z"),
            "title",
        ))
        .unwrap();
    assert_eq!(store.update_slug("notes/z", "notes/y", None).unwrap(), 1);
    let by_page: Vec<_> = places(&store, &id)
        .into_iter()
        .map(|p| (p.0.unwrap(), p.1))
        .collect();
    assert!(
        by_page.contains(&("notes/z".to_owned(), Some(b))),
        "page b keeps its place under the old slug: {by_page:?}"
    );
    assert!(by_page.contains(&("notes/y".to_owned(), Some(a))));
}

#[test]
fn a_source_delete_takes_the_sources_entries_with_their_places_and_no_other_source_s() {
    let (_dir, store) = brain("secret-source-delete");
    source(&store, "doomed");
    let d = put_in(&store, "doomed", "notes/d", "x");
    let k = put(&store, "notes/k", "y");
    let theirs = SecretEntryInsert {
        id: id_n(1),
        ..entry(1, "doomed", "github_token")
    };
    store.insert_secret_entry(&theirs, "value").unwrap();
    let ours = seal(&store, 2, "github_token");
    store
        .insert_secret_occurrence(&occurrence(
            &id_n(1),
            "doomed",
            Some(d),
            Some("notes/d"),
            "title",
        ))
        .unwrap();
    store
        .insert_secret_occurrence(&occurrence(
            &ours,
            "default",
            Some(k),
            Some("notes/k"),
            "title",
        ))
        .unwrap();
    assert!(store.delete_source_record("doomed", false).unwrap());
    assert_eq!(store.read_secret_entry(&id_n(1)).unwrap(), None);
    assert!(store.list_secret_occurrences(&id_n(1)).unwrap().is_empty());
    assert_eq!(
        store.find_secret_entry_by_mac("doomed", &mac_n(1)).unwrap(),
        None
    );
    assert_eq!(places(&store, &ours).len(), 1);
    assert_eq!(store.count_secrets_by_rule(None).unwrap().len(), 1);
}
