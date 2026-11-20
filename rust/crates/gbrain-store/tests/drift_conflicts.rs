//! The drift-conflict audit reads of `list_write_conflicts`: bounds, totals, slug groups, the
//! newest committed receipt per slug and the recorded source paths.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::{
    ClaimStamp, DriftConflictFilter, DriftConflictPage, WriteCompletion, WriteRequestInsert,
};
use serde_json::{Value, json};

const DRIFT: &str = "The canonical file contains an uncoordinated local edit.";
const PRINCIPAL_KEY: &str = "principal:local_cli:parity-writer";

fn keys() -> Vec<String> {
    vec![PRINCIPAL_KEY.into(), "brain".into()]
}

fn incarnation(store: &Store) -> String {
    store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string()
}

fn put(store: &Store, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({ "index": false })).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

/// One receipt at `slug`: committed, or a `source_changed` conflict with `message`.
fn receipt(store: &Store, n: u32, slug: &str, conflict: Option<&str>, kind: &str) {
    store.lock_persistence_counters(&keys()).unwrap();
    let insert: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "parity-writer",
        "requestId": format!("c0000000-0000-4000-8000-00000000000{n}"),
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation(store),
        "pageId": null, "slug": slug, "worktreeId": null, "topologyGeneration": null,
        "digest": "digest", "intent": { "kind": kind, "slug": slug }, "authority": {},
        "intentBytes": 10, "terminalReservation": 4096, "targetKind": "page", "protocolVersion": 1,
        "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": keys(),
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }))
    .unwrap();
    let row = store.insert_write_request(&insert).unwrap();
    let id = row["id"].as_str().unwrap().to_string();
    store
        .stamp_write_claim(&ClaimStamp {
            id: id.clone(),
            token: "c0000000-0000-4000-8000-0000000000c1".into(),
            lease_ms: 1000.0,
            phase_json: None,
        })
        .unwrap();
    let completion: WriteCompletion = serde_json::from_value(json!({
        "id": id, "state": if conflict.is_some() { "conflict" } else { "committed" },
        "outcome": { "slug": slug },
        "errorCode": conflict.map(|_| "source_changed"), "errorMessage": conflict,
        "consumerVersion": "v-consumer", "consumerHostId": "d0000000-0000-4000-8000-0000000000d1",
        "errorDetail": null, "resultBytes": 100, "counterKeys": keys(), "intentBytes": 10,
        "retainedBytes": 512, "terminalReservation": 4096, "probePurges": true,
    }))
    .unwrap();
    store.complete_write_row(&completion).unwrap().unwrap();
}

fn filter(store: &Store, live: bool, prefixes: Option<Vec<&str>>) -> DriftConflictFilter {
    let bounds = store.read_drift_conflict_bounds("default").unwrap();
    serde_json::from_value(json!({
        "sourceId": "default", "incarnation": bounds["incarnation"],
        "floor": "-100000", "through": bounds["top"], "slugPrefixes": prefixes, "live": live,
    }))
    .unwrap()
}

fn page(after: &str, fetch: u32) -> DriftConflictPage {
    DriftConflictPage {
        after: after.into(),
        fetch,
    }
}

fn slugs(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
}

#[test]
fn conflicts_group_by_slug_and_the_page_policy_hides_a_private_page() {
    let dir = TempDir::new("drift-conflicts");
    let store = open(&dir);
    put(&store, "notes/public-drift", json!({}));
    put(
        &store,
        "notes/private-drift",
        json!({ "visibility": "private" }),
    );
    receipt(&store, 1, "notes/public-drift", None, "put_page");
    receipt(
        &store,
        2,
        "notes/public-drift",
        Some("Another message."),
        "put_page",
    );
    receipt(&store, 3, "notes/public-drift", Some(DRIFT), "tag");
    receipt(&store, 4, "notes/private-drift", Some(DRIFT), "put_page");
    receipt(&store, 5, "notes/ghost-drift", Some(DRIFT), "put_page");

    let bounds = store.read_drift_conflict_bounds("default").unwrap();
    assert_eq!(bounds["top"], json!("5"));
    assert_eq!(bounds["bottom"], json!("1"));
    assert_eq!(
        store.read_drift_conflict_bounds("nope").unwrap(),
        Value::Null
    );

    let all = filter(&store, false, None);
    assert_eq!(
        store.count_drift_conflicts(&all, None).unwrap(),
        json!({ "slugs": 3, "receipts": 4 })
    );
    let groups = store
        .list_drift_conflict_groups(&all, &page("", 10), None, DRIFT)
        .unwrap();
    assert_eq!(
        slugs(&groups),
        [
            "notes/ghost-drift",
            "notes/private-drift",
            "notes/public-drift"
        ]
    );
    let public = &groups[2];
    assert_eq!(public["receipts"], json!(2));
    assert_eq!(public["drift_receipts"], json!(1));
    assert_eq!(
        public["producers"],
        json!(["put_page:put_page", "put_page:tag"])
    );
    assert_eq!(
        public["last_request_id"],
        json!("c0000000-0000-4000-8000-000000000003")
    );
    assert!(public["first_seen"].as_str().unwrap().ends_with('Z'));
    assert_eq!(public["first_seen"].as_str().unwrap().len(), 20);

    // The cursor and the fetch count page the groups in byte order.
    let first = store
        .list_drift_conflict_groups(&all, &page("", 1), None, DRIFT)
        .unwrap();
    assert_eq!(slugs(&first), ["notes/ghost-drift"]);
    let next = store
        .list_drift_conflict_groups(&all, &page("notes/ghost-drift", 1), None, DRIFT)
        .unwrap();
    assert_eq!(slugs(&next), ["notes/private-drift"]);

    // Live pages only, then the page policy over them.
    let live = filter(&store, true, None);
    let live_groups = store
        .list_drift_conflict_groups(&live, &page("", 10), None, DRIFT)
        .unwrap();
    assert_eq!(
        slugs(&live_groups),
        ["notes/private-drift", "notes/public-drift"]
    );
    // The page policy's privacy part (`privatePagesFilterForCaller`), as the remote floor sends it.
    let policy = PrivacyPolicy {
        entity_privacy: true,
        ..Default::default()
    };
    let floor = store
        .list_drift_conflict_groups(&live, &page("", 10), Some(&policy), DRIFT)
        .unwrap();
    assert_eq!(slugs(&floor), ["notes/public-drift"]);
    assert_eq!(
        store.count_drift_conflicts(&live, Some(&policy)).unwrap(),
        json!({ "slugs": 1, "receipts": 2 })
    );

    // Prefixes: a folder matches under it, a slug matches itself or under it.
    let folder = filter(&store, false, Some(vec!["notes/p"]));
    assert_eq!(
        store.count_drift_conflicts(&folder, None).unwrap()["slugs"],
        json!(0)
    );
    let exact = filter(&store, false, Some(vec!["notes/ghost-drift", "notes/"]));
    assert_eq!(
        store.count_drift_conflicts(&exact, None).unwrap()["slugs"],
        json!(3)
    );
    let one = filter(&store, false, Some(vec!["notes/ghost-drift"]));
    assert_eq!(
        store.count_drift_conflicts(&one, None).unwrap()["slugs"],
        json!(1)
    );

    // The committed receipt and the recorded paths.
    let wanted = vec![
        "notes/public-drift".to_string(),
        "notes/ghost-drift".to_string(),
    ];
    let committed = store
        .read_newest_committed_receipts("default", &wanted)
        .unwrap();
    assert_eq!(slugs(&committed), ["notes/public-drift"]);
    assert_eq!(
        committed[0]["request_id"],
        json!("c0000000-0000-4000-8000-000000000001")
    );
    let paths = store.read_page_source_paths("default", &wanted).unwrap();
    assert_eq!(slugs(&paths), ["notes/public-drift"]);
    assert_eq!(paths[0]["source_path"], Value::Null);
}
