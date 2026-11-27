//! The identity-downgrade read the store serves (`persistence/identity_downgrade.rs`): open records
//! only, joined to their old page and to the live slugs at the new path.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::IdentityDowngradeSpec;
use gbrain_store::sources::SourceInput;
use gbrain_store::write_guards::PageOriginTarget;
use serde_json::{Value, json};

const OP: &str = "sync-identity-downgrade";

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    let other: SourceInput = serde_json::from_value(
        json!({ "id": "other", "name": "other", "local_path": "/brains/other", "config": {} }),
    )
    .unwrap();
    store.upsert_source(&other).unwrap();
    (dir, store)
}

fn put(store: &Store, source: &str, slug: &str, path: &str) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": slug, "source_path": path,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

fn gone(store: &Store, source: &str, slug: &str) {
    put(store, source, slug, &format!("{slug}.md"));
    store.soft_delete_page(slug, Some(source)).unwrap();
}

/// Records a downgrade of `slug`, keyed by its page id, with its `deleted_at` unless `record`
/// replaces it.
fn record(store: &Store, source: &str, slug: &str, record: Value) -> u64 {
    let target: PageOriginTarget =
        serde_json::from_value(json!({ "sourceId": source, "slug": slug })).unwrap();
    let page = store.read_page_origin(&target).unwrap().expect("page");
    let mut full =
        json!({ "source_id": source, "old_slug": slug, "old_deleted_at": page.deleted_at });
    for (k, v) in record.as_object().unwrap() {
        full[k] = v.clone();
    }
    store
        .put_op_checkpoint_row(OP, &page.id.to_string(), json!([full]))
        .unwrap();
    page.id
}

fn read(store: &Store, sources: Option<&[&str]>) -> Vec<(String, Value)> {
    let spec = IdentityDowngradeSpec {
        op: OP.into(),
        source_ids: sources.map(|s| s.iter().map(|x| x.to_string()).collect()),
    };
    store
        .read_identity_downgrade_rows(&spec)
        .unwrap()
        .into_iter()
        .map(|row| {
            (
                row["record"]["old_slug"].as_str().unwrap().to_string(),
                row["new_slugs"].clone(),
            )
        })
        .collect()
}

#[test]
fn open_records_read_oldest_first_with_the_live_slugs_of_their_source_at_the_new_path() {
    let (_dir, store) = brain("identity-downgrade-open");
    for slug in ["notes/a", "notes/b", "notes/c", "notes/d", "notes/f"] {
        gone(&store, "default", slug);
    }
    gone(&store, "other", "notes/h");
    put(&store, "default", "notes/a2", "notes/a2.md");
    put(&store, "other", "notes/h2", "notes/h2.md");
    put(&store, "default", "notes/h2-default", "notes/h2.md");
    record(
        &store,
        "default",
        "notes/a",
        json!({ "to": "notes/a2.md", "recorded_at": "2026-01-02T00:00:00.000Z" }),
    );
    record(
        &store,
        "default",
        "notes/b",
        json!({ "to": "notes/never.md", "recorded_at": "2026-01-01T00:00:00.000Z" }),
    );
    record(
        &store,
        "other",
        "notes/h",
        json!({ "to": "notes/h2.md", "recorded_at": "2026-01-03T00:00:00.000Z" }),
    );
    record(
        &store,
        "default",
        "notes/c",
        json!({ "to": "notes/a2.md", "disposition": { "kind": "closed" } }),
    );
    record(
        &store,
        "default",
        "notes/d",
        json!({ "to": "notes/a2.md", "old_deleted_at": "2000-01-01 00:00:00+00" }),
    );
    record(
        &store,
        "default",
        "notes/a2",
        json!({ "to": "notes/a2.md", "old_deleted_at": "2000-01-01 00:00:00+00" }),
    );
    record(
        &store,
        "default",
        "notes/f",
        json!({ "to": "notes/a2.md", "source_id": "other" }),
    );
    store
        .put_op_checkpoint_row(OP, "0099999", json!([{ "source_id": "default" }]))
        .unwrap();

    let a = ("notes/a".to_string(), json!(["notes/a2"]));
    let b = ("notes/b".to_string(), Value::Null);
    let h = ("notes/h".to_string(), json!(["notes/h2"]));
    assert_eq!(read(&store, None), vec![b.clone(), a.clone(), h.clone()]);
    assert_eq!(read(&store, Some(&["default"])), vec![b, a]);
    assert_eq!(read(&store, Some(&["other", "missing"])), vec![h]);
    assert!(read(&store, Some(&[])).is_empty());
}

#[test]
fn the_postgres_text_form_of_old_deleted_at_matches_and_text_that_is_not_a_time_refuses() {
    let (_dir, store) = brain("identity-downgrade-forms");
    gone(&store, "default", "notes/a");
    let target: PageOriginTarget =
        serde_json::from_value(json!({ "sourceId": "default", "slug": "notes/a" })).unwrap();
    let iso = store
        .read_page_origin(&target)
        .unwrap()
        .unwrap()
        .deleted_at
        .unwrap();
    let pg = format!("{} {}+00", &iso[..10], &iso[11..iso.len() - 1]);
    record(
        &store,
        "default",
        "notes/a",
        json!({ "to": "notes/a.md", "old_deleted_at": pg }),
    );
    assert_eq!(read(&store, None).len(), 1);

    record(
        &store,
        "default",
        "notes/a",
        json!({ "to": "notes/a.md", "old_deleted_at": "garbage" }),
    );
    let spec = IdentityDowngradeSpec {
        op: OP.into(),
        source_ids: None,
    };
    let err = store.read_identity_downgrade_rows(&spec).unwrap_err();
    assert!(
        err.to_string()
            .contains("invalid input syntax for type timestamp with time zone: \"garbage\""),
        "{err}"
    );
}
