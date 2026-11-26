//! The managed sync's named statements (`runSyncStatement`): the source row, the checkpoint rows of the pass, holds, tail and
//! failures, and the page reads, matched to the Postgres text each name replaces (rust/docs/store/managed-mode.md, "Managed sync").

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn rows(store: &Store, name: &str, params: Value) -> Vec<Value> {
    store
        .sync_store_rows(name, params.as_array().unwrap())
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

fn write(store: &Store, name: &str, params: Value) -> Vec<Value> {
    store
        .sync_store_write(name, params.as_array().unwrap())
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

fn source(store: &Store, id: &str) {
    let input: SourceInput = serde_json::from_value(
        json!({ "id": id, "name": id, "local_path": "/tmp/checkout", "config": {} }),
    )
    .unwrap();
    store.upsert_source(&input).unwrap();
}

fn page(store: &Store, source_id: &str, slug: &str) {
    let input: PageInput =
        serde_json::from_value(json!({ "type": "note", "title": slug, "compiled_truth": "body" }))
            .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "sourceId": source_id })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

#[test]
fn the_source_row_answers_its_columns_and_a_missing_source_no_row() {
    let dir = TempDir::new("managed-sync-store");
    let store = open(&dir);
    source(&store, "work");
    let found = rows(&store, "source_row", json!(["work"]));
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["archived"], json!(false));
    assert_eq!(found[0]["local_path"], json!("/tmp/checkout"));
    assert_eq!(found[0]["last_commit"], Value::Null);
    assert!(rows(&store, "source_row", json!(["nope"])).is_empty());
}

#[test]
fn a_source_page_read_answers_live_origins_only() {
    let dir = TempDir::new("managed-sync-store");
    let store = open(&dir);
    source(&store, "work");
    page(&store, "work", "notes/a");
    assert!(
        rows(&store, "live_origin_pages", json!(["work"])).is_empty(),
        "a page with no origin has no origin row"
    );
    let by_slug = rows(
        &store,
        "pages_by_slug",
        json!(["work", ["notes/a", "notes/zzz"]]),
    );
    assert_eq!(by_slug.len(), 1);
    assert_eq!(by_slug[0]["slug"], json!("notes/a"));
    assert_eq!(by_slug[0]["deleted"], json!(false));
}

#[test]
fn the_tail_keeps_sixteen_obligations_and_clears_only_what_it_read() {
    let dir = TempDir::new("managed-sync-store");
    let store = open(&dir);
    for n in 0..17 {
        write(
            &store,
            "tail_record_pass",
            json!([
                "managed-sync-tail",
                "work",
                format!("pass-{n}"),
                3,
                true,
                null
            ]),
        );
    }
    let kept = rows(
        &store,
        "checkpoint_keys",
        json!(["managed-sync-tail", "work"]),
    );
    let list = kept[0]["completed_keys"].as_array().unwrap();
    assert_eq!(list.len(), 16);
    assert_eq!(
        list[0]["run_id"],
        json!("pass-1"),
        "the oldest obligation falls off at the cap"
    );
    assert!(list[0].get("since").is_none(), "a null `since` is stripped");
    let stale = serde_json::to_string(&list[..1]).unwrap();
    write(
        &store,
        "tail_clear",
        json!(["managed-sync-tail", "work", stale]),
    );
    assert_eq!(
        rows(
            &store,
            "checkpoint_keys",
            json!(["managed-sync-tail", "work"])
        )
        .len(),
        1,
        "a tail that moved meanwhile stays"
    );
    let all = serde_json::to_string(list).unwrap();
    write(
        &store,
        "tail_clear",
        json!(["managed-sync-tail", "work", all]),
    );
    assert!(
        rows(
            &store,
            "checkpoint_keys",
            json!(["managed-sync-tail", "work"])
        )
        .is_empty()
    );
}

#[test]
fn a_repeated_failure_counts_its_repeats_and_a_new_target_replaces_it() {
    let dir = TempDir::new("managed-sync-store");
    let store = open(&dir);
    let failure = |target: &str, observation: &str| {
        json!([{ "path": "a.md", "code": "x", "message": "m", "target": target,
        "observation_id": observation, "first_seen": "t0", "attempts": 1, "repeats": 1, "invocation": observation }])
    };
    let first = write(
        &store,
        "failure_record",
        json!(["key", failure("t1", "o1").to_string()]),
    );
    assert_eq!(first[0]["completed_keys"][0]["attempts"], json!(1));
    let second = write(
        &store,
        "failure_record",
        json!(["key", failure("t1", "o2").to_string()]),
    );
    assert_eq!(second[0]["completed_keys"][0]["attempts"], json!(2));
    assert_eq!(second[0]["completed_keys"][0]["repeats"], json!(2));
    assert_eq!(second[0]["completed_keys"][0]["first_seen"], json!("t0"));
    let moved = write(
        &store,
        "failure_record",
        json!(["key", failure("t2", "o3").to_string()]),
    );
    assert_eq!(
        moved[0]["completed_keys"][0]["attempts"],
        json!(1),
        "a new target starts over"
    );
    assert_eq!(write(&store, "failure_clear", json!(["key"])).len(), 1);
    assert!(write(&store, "failure_clear", json!(["key"])).is_empty());
}

#[test]
fn an_unknown_statement_is_refused() {
    let dir = TempDir::new("managed-sync-store");
    let store = open(&dir);
    assert!(store.sync_store_rows("no_such_statement", &[]).is_err());
    assert!(store.sync_store_write("no_such_statement", &[]).is_err());
}

#[test]
fn a_cursor_inserts_once_swaps_on_its_header_and_retires_with_its_unshared_manifest() {
    let dir = TempDir::new("managed-sync-store");
    let store = open(&dir);
    let head = |index: i64, done: bool| {
        json!([{ "sourceId": "work", "runId": "run-a", "index": index, "done": done, "pending": { "requestId": "r1", "intent": { "kind": "k" } } }]).to_string()
    };
    assert!(
        write(
            &store,
            "cursor_manifest_insert",
            json!(["managed-sync-manifest", "run-a", "[{\"slug\":\"a\"}]"])
        )
        .is_empty()
    );
    assert!(
        write(
            &store,
            "cursor_manifest_insert",
            json!(["managed-sync-manifest", "run-a", "[{\"slug\":\"zzz\"}]"])
        )
        .is_empty()
    );
    assert_eq!(
        rows(
            &store,
            "checkpoint_keys",
            json!(["managed-sync-manifest", "run-a"])
        )[0]["completed_keys"],
        json!([{ "slug": "a" }])
    );
    assert_eq!(
        write(
            &store,
            "cursor_insert",
            json!(["managed-sync", "k1", head(1, false)])
        )
        .len(),
        1
    );
    assert!(
        write(
            &store,
            "cursor_insert",
            json!(["managed-sync", "k1", head(9, false)])
        )
        .is_empty(),
        "a second insert changes nothing"
    );
    assert!(
        write(
            &store,
            "cursor_swap",
            json!(["managed-sync", "k1", head(7, false), head(3, false)])
        )
        .is_empty(),
        "a swap on a stale header loses"
    );
    assert_eq!(
        write(
            &store,
            "cursor_swap",
            json!(["managed-sync", "k1", head(1, false), head(3, true)])
        )
        .len(),
        1
    );
    let locked = rows(&store, "cursor_head_locked", json!(["k1"]));
    assert_eq!(
        (
            locked[0]["run_id"].clone(),
            locked[0]["index"].clone(),
            locked[0]["request_id"].clone()
        ),
        (json!("run-a"), json!(3), json!("r1"))
    );
    let held = rows(
        &store,
        "pending_intent_held",
        json!(["managed-sync", "k1", "{\"kind\":\"k\"}"]),
    );
    assert_eq!(held[0]["same"], json!(true));
    assert!(write(&store, "manifest_delete_unshared", json!(["run-a"])).is_empty());
    assert_eq!(
        rows(
            &store,
            "checkpoint_keys",
            json!(["managed-sync-manifest", "run-a"])
        )
        .len(),
        1,
        "the cursor still names the run"
    );
    assert_eq!(
        write(&store, "finished_cursor_delete", json!(["k1"]))[0]["run_id"],
        json!("run-a")
    );
    write(&store, "manifest_delete_unshared", json!(["run-a"]));
    assert!(
        rows(
            &store,
            "checkpoint_keys",
            json!(["managed-sync-manifest", "run-a"])
        )
        .is_empty()
    );
    write(
        &store,
        "cursor_insert",
        json!(["managed-sync-slice", "w:i:a", "[{}]"]),
    );
    write(
        &store,
        "cursor_insert",
        json!(["managed-sync-slice", "w:j:a", "[{}]"]),
    );
    write(
        &store,
        "prefix_delete",
        json!(["managed-sync-slice", "w:i:"]),
    );
    assert_eq!(
        rows(
            &store,
            "checkpoint_prefix",
            json!(["managed-sync-slice", "w:"])
        )
        .len(),
        1
    );
}

#[test]
fn an_unfinished_page_request_read_answers_nothing_for_a_store_without_requests() {
    let dir = TempDir::new("managed-sync-store");
    let store = open(&dir);
    let wt = "00000000-0000-4000-8000-000000000001";
    assert!(
        rows(
            &store,
            "unfinished_page_request",
            json!([
                wt,
                wt,
                "work",
                "notes/x",
                1,
                "1",
                "notes/x.md",
                "notes/x.md"
            ])
        )
        .is_empty()
    );
    assert!(rows(&store, "stale_page_requests", json!([wt, "run-1", "2"])).is_empty());
    assert!(
        rows(
            &store,
            "refused_checkpoint",
            json!(["work", ["delete_page", "purge_page"]])
        )
        .is_empty()
    );
}
