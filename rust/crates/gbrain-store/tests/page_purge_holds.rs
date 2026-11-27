//! The parks and owed-purge records of a derived-origin purge the store serves (`persistence/origin_holds.rs`). The
//! TypeScript parity cases (test/engine-parity/page-purge-holds.test.ts) compare the same members with PGLite; these cover what
//! a parity case cannot see: the stored record bytes, the rows each call reports, and the arguments the store refuses.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

const PARK: &str = "derived-origin-park";
const OWED: &str = "owed-page-purge";

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    (dir, store)
}

fn put(store: &Store, slug: &str, page_type: &str, frontmatter: Value) -> i64 {
    let input: PageInput = serde_json::from_value(json!({
        "type": page_type, "title": slug, "compiled_truth": slug, "frontmatter": frontmatter,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": "default" })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
    store
        .read_page_label_row("default", slug)
        .unwrap()
        .expect("page written")
        .id as i64
}

fn doc(store: &Store, op: &str, id: i64) -> Value {
    store.read_op_checkpoint_doc(op, &id.to_string()).unwrap()
}

fn park(id: i64, extra: Value) -> Value {
    let mut base = json!({
        "source_id": "default", "slug": "o/gone", "page_id": id, "blocking_slug": "o/dep", "code": "label_failed",
        "reason": "blocked", "parked_at": "2026-01-01T00:00:00.000Z",
    });
    base.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    base
}

#[test]
fn the_origins_are_the_atoms_and_hidden_pages_among_the_ids_and_a_park_hides_one_unless_rechecked()
{
    let (_dir, store) = brain("holds-origins");
    let private = put(
        &store,
        "o/private",
        "note",
        json!({ "visibility": "private" }),
    );
    let atom = put(&store, "o/atom", "atom", json!({}));
    let plain = put(&store, "o/plain", "note", json!({}));
    let ids = [plain, atom, private, private, 9999, -3];
    let slugs = |rows: Vec<gbrain_store::persistence::PurgeOrigin>| -> Vec<String> {
        rows.into_iter().map(|r| r.slug).collect()
    };
    assert_eq!(
        slugs(store.list_purge_origins(&ids, false, false).unwrap()),
        vec!["o/private".to_string(), "o/atom".to_string()]
    );
    store
        .upsert_derived_origin_park(private, &park(private, json!({})))
        .unwrap();
    assert_eq!(
        slugs(store.list_purge_origins(&ids, false, false).unwrap()),
        vec!["o/atom".to_string()]
    );
    assert_eq!(
        slugs(store.list_purge_origins(&ids, true, false).unwrap()),
        vec!["o/private".to_string(), "o/atom".to_string()]
    );
    assert!(
        store
            .list_purge_origins(&[], false, false)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_re_park_keeps_the_owner_request_the_earlier_park_held_unless_the_new_park_names_one() {
    let (_dir, store) = brain("holds-park");
    let id = put(&store, "o/gone", "note", json!({}));
    store
        .upsert_derived_origin_park(
            id,
            &park(
                id,
                json!({ "held_request_id": "req-1", "held_deleted_us": "111" }),
            ),
        )
        .unwrap();
    store
        .upsert_derived_origin_park(id, &park(id, json!({ "reason": "again" })))
        .unwrap();
    let kept = doc(&store, PARK, id);
    assert_eq!(kept["reason"], "again");
    assert_eq!(kept["held_request_id"], "req-1");
    assert_eq!(kept["held_deleted_us"], "111");
    store
        .upsert_derived_origin_park(id, &park(id, json!({ "held_request_id": "req-2" })))
        .unwrap();
    let replaced = doc(&store, PARK, id);
    assert_eq!(replaced["held_request_id"], "req-2");
    assert!(replaced.get("held_deleted_us").is_none());
    // A park with no hold is replaced whole.
    store.delete_origin_hold_rows(PARK, &[id]).unwrap();
    store
        .upsert_derived_origin_park(id, &park(id, json!({})))
        .unwrap();
    store
        .upsert_derived_origin_park(id, &park(id, json!({ "reason": "second" })))
        .unwrap();
    let plain = doc(&store, PARK, id);
    assert_eq!(plain["reason"], "second");
    assert!(plain.get("held_request_id").is_none());
    // A document with a NUL is refused, as jsonb refuses it.
    assert!(
        store
            .upsert_derived_origin_park(id, &park(id, json!({ "reason": "a\u{0}b" })))
            .is_err()
    );
}

#[test]
fn an_owed_record_is_written_for_a_tombstone_once_and_binds_the_park_that_holds_the_request() {
    let (_dir, store) = brain("holds-owed");
    let live = put(&store, "o/live", "note", json!({}));
    let gone = put(&store, "o/gone", "note", json!({}));
    store.soft_delete_page("o/gone", Some("default")).unwrap();
    let rows = |id, req: &str| store.record_owed_purge_rows(id, req).unwrap();
    assert_eq!(rows(live, "req-live"), json!({ "owed": 0, "held": 0 }));
    assert_eq!(rows(9999, "req-live"), json!({ "owed": 0, "held": 0 }));
    assert_eq!(doc(&store, OWED, live), Value::Null);
    assert_eq!(rows(gone, "req-1"), json!({ "owed": 1, "held": 0 }));
    let first = doc(&store, OWED, gone);
    assert_eq!(first["request_id"], "req-1");
    assert_eq!(first["page_id"], gone);
    assert_eq!(first["source_id"], "default");
    assert!(
        first["deleted_us"]
            .as_str()
            .unwrap()
            .parse::<i64>()
            .unwrap()
            > 0
    );
    // The same tombstone again changes nothing, even for another request.
    assert_eq!(rows(gone, "req-2"), json!({ "owed": 0, "held": 0 }));
    assert_eq!(doc(&store, OWED, gone)["request_id"], "req-1");
    // A park that holds the request is bound to the tombstone; one that holds another is not.
    store
        .upsert_derived_origin_park(gone, &park(gone, json!({ "held_request_id": "req-1" })))
        .unwrap();
    assert_eq!(rows(gone, "req-other"), json!({ "owed": 0, "held": 0 }));
    assert!(doc(&store, PARK, gone).get("held_deleted_us").is_none());
    assert_eq!(rows(gone, "req-1"), json!({ "owed": 0, "held": 1 }));
    assert_eq!(
        doc(&store, PARK, gone)["held_deleted_us"],
        first["deleted_us"]
    );
    assert!(store.record_owed_purge_rows(gone, "a\u{0}b").is_err());
}

#[test]
fn clearing_removes_the_records_of_the_op_and_pages_named_and_counts_them() {
    let (_dir, store) = brain("holds-clear");
    let a = put(&store, "o/a", "note", json!({}));
    let b = put(&store, "o/b", "note", json!({}));
    store.soft_delete_page("o/a", Some("default")).unwrap();
    store.record_owed_purge_rows(a, "req-1").unwrap();
    store
        .upsert_derived_origin_park(a, &park(a, json!({})))
        .unwrap();
    store
        .upsert_derived_origin_park(b, &park(b, json!({})))
        .unwrap();
    assert_eq!(store.delete_origin_hold_rows(OWED, &[a, b, a]).unwrap(), 1);
    assert_eq!(doc(&store, OWED, a), Value::Null);
    assert_ne!(doc(&store, PARK, a), Value::Null);
    assert_eq!(store.delete_origin_hold_rows(PARK, &[b, 9999]).unwrap(), 1);
    assert_ne!(doc(&store, PARK, a), Value::Null);
    assert_eq!(store.delete_origin_hold_rows(PARK, &[]).unwrap(), 0);
    // Only the two hold ops are cleared by this call.
    assert!(store.delete_origin_hold_rows("sync-hold", &[a]).is_err());
}
