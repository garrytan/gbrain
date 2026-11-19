//! The commit notifier's host lease and host source list (persistence/notifier.rs).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::persistence::NotifierLeaseClaim;
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};
use std::time::Duration;

const HOST: &str = "00000000-0000-4000-8000-00000000c001";
const OTHER_HOST: &str = "00000000-0000-4000-8000-00000000c002";

fn claim(store: &Store, host: &str, owner: &str, kind: &str, pid: i64, lease_ms: f64) -> Value {
    let claim: NotifierLeaseClaim = serde_json::from_value(json!({
        "hostId": host, "ownerId": owner, "kind": kind, "pid": pid, "leaseMs": lease_ms,
    }))
    .unwrap();
    store.claim_notifier_lease(&claim).unwrap()
}

/// The holder of a lost claim with its expiry checked (an ISO time in the future when live) and
/// removed, so the rest compares by value.
fn holder(claim: &Value) -> Value {
    assert_eq!(claim["owner"], json!(false), "{claim}");
    let mut holder = claim["holder"].clone();
    let expires = holder["expires_at"].as_str().unwrap().to_string();
    assert!(expires.ends_with('Z') && expires.contains('T'), "{expires}");
    holder.as_object_mut().unwrap().remove("expires_at");
    holder
}

#[test]
fn the_first_claim_wins_a_renewal_keeps_the_fence_and_a_live_lease_refuses_another_owner() {
    let dir = TempDir::new("notifier-lease");
    let store = open(&dir);
    assert_eq!(
        claim(&store, HOST, "owner-a", "serve", 101, 60_000.0),
        json!({ "owner": true, "fence": 1 })
    );
    assert_eq!(
        claim(&store, HOST, "owner-a", "serve", 102, 60_000.0),
        json!({ "owner": true, "fence": 1 })
    );
    let lost = claim(&store, HOST, "owner-b", "jobs-worker", 201, 60_000.0);
    assert_eq!(
        holder(&lost),
        json!({ "owner_id": "owner-a", "fence": 1, "resident_kind": "serve", "pid": 102, "live": true })
    );
    // Another host's lease is its own row.
    assert_eq!(
        claim(&store, OTHER_HOST, "owner-b", "jobs-worker", 201, 60_000.0),
        json!({ "owner": true, "fence": 1 })
    );
}

#[test]
fn an_expired_lease_goes_to_the_next_owner_with_the_fence_up_by_one() {
    let dir = TempDir::new("notifier-takeover");
    let store = open(&dir);
    claim(&store, HOST, "owner-a", "serve", 101, 60_000.0);
    // A renewal with a 1 ms lease keeps the fence and lets the lease lapse.
    assert_eq!(
        claim(&store, HOST, "owner-a", "serve", 101, 1.0),
        json!({ "owner": true, "fence": 1 })
    );
    std::thread::sleep(Duration::from_millis(25));
    assert_eq!(
        claim(&store, HOST, "owner-b", "jobs-worker", 202, 60_000.0),
        json!({ "owner": true, "fence": 2 })
    );
    let stale = claim(&store, HOST, "owner-a", "serve", 101, 60_000.0);
    assert_eq!(
        holder(&stale),
        json!({ "owner_id": "owner-b", "fence": 2, "resident_kind": "jobs-worker", "pid": 202, "live": true })
    );
}

#[test]
fn a_lease_of_under_half_a_millisecond_is_one_millisecond_and_a_nul_host_is_refused() {
    let dir = TempDir::new("notifier-bounds");
    let store = open(&dir);
    assert_eq!(
        claim(&store, HOST, "owner-a", "serve", 1, 0.2),
        json!({ "owner": true, "fence": 1 })
    );
    let bad: NotifierLeaseClaim = serde_json::from_value(json!({
        "hostId": "a\u{0}b", "ownerId": "o", "kind": "serve", "pid": 1, "leaseMs": 1000,
    }))
    .unwrap();
    let error = store.claim_notifier_lease(&bad).unwrap_err();
    assert_eq!(error.code, INVALID_ARGUMENT);
}

#[test]
fn the_host_source_list_has_every_source_that_is_not_archived_in_id_order_with_no_binding() {
    let dir = TempDir::new("notifier-sources");
    let store = open(&dir);
    for (id, path, config) in [
        ("beta", Some("/repos/beta"), json!({ "syncEnabled": false })),
        ("alpha", Some("/repos/alpha"), json!({})),
        ("nopath", None, json!({})),
        ("gone", Some("/repos/gone"), json!({})),
    ] {
        let input: SourceInput = serde_json::from_value(json!({
            "id": id, "name": id, "local_path": path, "config": config,
        }))
        .unwrap();
        store.upsert_source(&input).unwrap();
    }
    store.set_source_archived("gone", true).unwrap();
    let rows: Vec<Value> = store
        .list_notifier_host_source_rows()
        .unwrap()
        .into_iter()
        .filter(|r| r["id"] != json!("default"))
        .collect();
    let row = |id: &str, path: Value, config: Value| json!({ "id": id, "local_path": path, "last_commit": null, "bound": false, "owner": null, "root": null, "syncer": null, "config": config });
    assert_eq!(
        rows,
        vec![
            row("alpha", json!("/repos/alpha"), json!({})),
            row(
                "beta",
                json!("/repos/beta"),
                json!({ "syncEnabled": false })
            ),
            row("nopath", Value::Null, json!({})),
        ]
    );
}
