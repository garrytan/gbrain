//! Transactions: commit and roll back as a unit, savepoints, read-your-writes, allocators that
//! never go back (also after a reopen), journaled writes and the page-key hold.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::journal::{PageMutation, Principal};
use gbrain_store::pages::{PageInput, PutPageOptions, ReadScope};
use gbrain_store::sources::SourceInput;
use gbrain_store::transactions::PageKeyHint;
use serde_json::{Value, json};

const REQ_1: &str = "11111111-1111-4111-8111-111111111111";

fn input(title: &str, body: &str) -> PageInput {
    serde_json::from_value(json!({"type": "note", "title": title, "compiled_truth": body})).unwrap()
}

fn put(store: &Store, slug: &str, body: &str) -> Value {
    store
        .put_page(slug, &input(slug, body), &PutPageOptions::default())
        .unwrap()
}

fn title(store: &Store, slug: &str) -> Option<String> {
    store
        .read_page_snapshot(slug, &ReadScope::default())
        .unwrap()
        .map(|s| s["page"]["title"].as_str().unwrap().to_string())
}

fn page_id(page: &Value) -> u64 {
    page["id"].as_u64().unwrap()
}

#[test]
fn a_committed_transaction_publishes_every_write_at_once() {
    let dir = TempDir::new("tx-commit");
    let store = open(&dir);
    let tx = store.begin_transaction(false).unwrap();
    put(&tx, "notes/a", "alpha body");
    put(&tx, "notes/b", "beta body");
    // The transaction reads its own writes; the brain does not see them yet.
    assert_eq!(title(&tx, "notes/a").as_deref(), Some("notes/a"));
    assert_eq!(title(&store, "notes/a"), None);
    let before = store.commit_version().unwrap();
    let sequence = tx.commit_transaction().unwrap();
    assert_eq!(sequence, before + 1, "one commit for the whole transaction");
    assert_eq!(title(&store, "notes/a").as_deref(), Some("notes/a"));
    assert_eq!(title(&store, "notes/b").as_deref(), Some("notes/b"));
    assert_eq!(tx.commit_transaction().unwrap_err().code, STORE_CLOSED);
}

#[test]
fn a_rolled_back_transaction_leaves_nothing_and_the_brain_stays_usable() {
    let dir = TempDir::new("tx-rollback");
    let store = open(&dir);
    let tx = store.begin_transaction(false).unwrap();
    put(&tx, "notes/a", "alpha body");
    tx.rollback_transaction().unwrap();
    assert_eq!(title(&store, "notes/a"), None);
    // The writer was given back.
    put(&store, "notes/b", "beta body");
    assert_eq!(title(&store, "notes/b").as_deref(), Some("notes/b"));
}

#[test]
fn savepoints_nest_release_into_their_parent_and_roll_back_alone() {
    let dir = TempDir::new("tx-savepoint");
    let store = open(&dir);
    let tx = store.begin_transaction(false).unwrap();
    put(&tx, "notes/outer", "outer body");
    let one = tx.savepoint().unwrap();
    put(&tx, "notes/kept", "kept body");
    let two = tx.savepoint().unwrap();
    put(&tx, "notes/dropped", "dropped body");
    assert_eq!((one, two), (1, 2));
    // Only the innermost savepoint can end.
    assert_eq!(tx.release_savepoint(one).unwrap_err().code, INVALID_STATE);
    tx.rollback_savepoint(two).unwrap();
    assert_eq!(title(&tx, "notes/dropped"), None);
    tx.release_savepoint(one).unwrap();
    tx.commit_transaction().unwrap();
    assert_eq!(title(&store, "notes/outer").as_deref(), Some("notes/outer"));
    assert_eq!(title(&store, "notes/kept").as_deref(), Some("notes/kept"));
    assert_eq!(title(&store, "notes/dropped"), None);
}

#[test]
fn an_id_taken_in_a_rolled_back_transaction_is_never_reused_after_a_reopen() {
    let dir = TempDir::new("tx-allocator");
    let (taken, rolled_back) = {
        let store = open(&dir);
        let tx = store.begin_transaction(false).unwrap();
        let taken = page_id(&put(&tx, "notes/a", "alpha body"));
        let depth = tx.savepoint().unwrap();
        let rolled_back = page_id(&put(&tx, "notes/b", "beta body"));
        tx.rollback_savepoint(depth).unwrap();
        tx.rollback_transaction().unwrap();
        drop(tx);
        store.close();
        (taken, rolled_back)
    };
    let store = open(&dir);
    let next = page_id(&put(&store, "notes/c", "gamma body"));
    assert!(
        next > taken && next > rolled_back,
        "{next} reuses {taken} or {rolled_back}"
    );
}

#[test]
fn a_journaled_write_commits_or_rolls_back_with_its_transaction() {
    let dir = TempDir::new("tx-journal");
    let store = open(&dir);
    let principal = Principal {
        kind: "local_cli".into(),
        id: "writer-1".into(),
    };
    let mutation: PageMutation = serde_json::from_value(json!({
        "principal": {"kind": "local_cli", "id": "writer-1"},
        "requestId": REQ_1,
        "slug": "notes/journaled",
        "page": {"type": "note", "title": "notes/journaled", "compiled_truth": "journaled body"},
        "options": {},
    }))
    .unwrap();
    let tx = store.begin_transaction(false).unwrap();
    let receipt = tx.submit_page_mutation(&mutation, None).unwrap();
    assert_eq!(receipt["state"], "committed");
    assert!(tx.get_write_receipt(&principal, REQ_1).unwrap().is_some());
    tx.rollback_transaction().unwrap();
    assert!(
        store
            .get_write_receipt(&principal, REQ_1)
            .unwrap()
            .is_none()
    );
    assert_eq!(title(&store, "notes/journaled"), None);

    let tx = store.begin_transaction(false).unwrap();
    tx.submit_page_mutation(&mutation, None).unwrap();
    tx.commit_transaction().unwrap();
    assert_eq!(
        store.get_write_receipt(&principal, REQ_1).unwrap().unwrap()["state"],
        "committed"
    );
    assert_eq!(
        title(&store, "notes/journaled").as_deref(),
        Some("notes/journaled")
    );
}

#[test]
fn a_failed_write_inside_a_transaction_does_not_poison_it() {
    let dir = TempDir::new("tx-statement");
    let store = open(&dir);
    let tx = store.begin_transaction(false).unwrap();
    put(&tx, "notes/a", "alpha body");
    let refused = tx
        .put_page(
            "notes/a",
            &input("again", "other body"),
            &serde_json::from_value(
                json!({"expectedRevision": "00000000-0000-4000-8000-000000000000"}),
            )
            .unwrap(),
        )
        .unwrap_err();
    assert_eq!(refused.code, REVISION_CONFLICT);
    put(&tx, "notes/b", "beta body");
    tx.commit_transaction().unwrap();
    assert_eq!(title(&store, "notes/a").as_deref(), Some("notes/a"));
    assert_eq!(title(&store, "notes/b").as_deref(), Some("notes/b"));
}

#[test]
fn reads_outside_never_wait_for_an_open_transaction() {
    let dir = TempDir::new("tx-snapshot");
    let store = open(&dir);
    put(&store, "notes/a", "alpha body");
    let tx = store.begin_transaction(false).unwrap();
    put(&tx, "notes/b", "beta body");
    let reader = std::thread::scope(|s| {
        s.spawn(|| (title(&store, "notes/a"), title(&store, "notes/b")))
            .join()
            .unwrap()
    });
    assert_eq!(reader, (Some("notes/a".into()), None));
    tx.commit_transaction().unwrap();
}

#[test]
fn page_keys_need_their_source_and_a_matching_incarnation() {
    let dir = TempDir::new("tx-keys");
    let store = open(&dir);
    let wiki = store
        .upsert_source(
            &serde_json::from_value::<SourceInput>(json!({"id": "wiki", "name": "wiki"})).unwrap(),
        )
        .unwrap();
    let incarnation = serde_json::to_value(&wiki).unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    let key = |source: &str, slug: &str, incarnation: Option<&str>| PageKeyHint {
        source_id: source.into(),
        slug: slug.into(),
        incarnation: incarnation.map(str::to_string),
    };
    let tx = store.begin_transaction(false).unwrap();
    let held = tx
        .hold_page_keys(
            &[
                key("wiki", "b", Some(&incarnation)),
                key("default", "a", None),
            ],
            false,
        )
        .unwrap();
    assert_eq!(
        held,
        vec![("default".into(), "a".into()), ("wiki".into(), "b".into())]
    );
    tx.hold_page_keys(&[key("wiki", "c", Some(&incarnation))], true)
        .unwrap();
    let stale = tx
        .hold_page_keys(&[key("wiki", "d", Some("another"))], true)
        .unwrap_err();
    assert_eq!(
        (stale.code, stale.message.as_str()),
        (SOURCE_CHANGED, "Page source was recreated: wiki")
    );
    // Every hinted key is checked, not only the first of its source: a later key of the same source
    // with a stale incarnation refuses too, and holds nothing.
    let before = tx.held_page_keys().unwrap();
    let later = tx
        .hold_page_keys(
            &[
                key("wiki", "e", Some(&incarnation)),
                key("wiki", "f", Some("another")),
            ],
            true,
        )
        .unwrap_err();
    assert_eq!(
        (later.code, later.message.as_str()),
        (SOURCE_CHANGED, "Page source was recreated: wiki")
    );
    assert_eq!(tx.held_page_keys().unwrap(), before);
    let missing = tx
        .hold_page_keys(&[key("absent", "a", None)], false)
        .unwrap_err();
    assert_eq!(missing.code, SOURCE_NOT_FOUND);
    tx.commit_transaction().unwrap();
    assert_eq!(tx.held_page_keys().unwrap_err().code, STORE_CLOSED);
    // Outside a transaction there is nothing to hold keys in.
    assert_eq!(
        store
            .hold_page_keys(&[key("default", "a", None)], false)
            .unwrap_err()
            .code,
        INVALID_STATE
    );
}
