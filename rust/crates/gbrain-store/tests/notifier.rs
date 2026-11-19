//! The commit notifier's host lease, host source list, per-source state and coverage rows and
//! freshness status rows (persistence/notifier.rs).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::persistence::{NotifierCoverage, NotifierLeaseClaim, NotifierStatePatch};
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
fn the_fencing_check_holds_only_for_the_owner_with_its_fence_and_a_release_expires_only_its_own_lease()
 {
    let dir = TempDir::new("notifier-release");
    let store = open(&dir);
    assert_eq!(store.read_notifier_lease(HOST).unwrap(), None);
    assert!(!store.holds_notifier_lease(HOST, "owner-a", 1.0).unwrap());
    claim(&store, HOST, "owner-a", "serve", 101, 60_000.0);
    let mut lease = store.read_notifier_lease(HOST).unwrap().unwrap();
    assert!(lease["expires_at"].as_str().unwrap().ends_with('Z'));
    lease.as_object_mut().unwrap().remove("expires_at");
    assert_eq!(
        lease,
        json!({ "owner_id": "owner-a", "fence": 1, "resident_kind": "serve", "pid": 101, "live": true })
    );
    assert!(store.holds_notifier_lease(HOST, "owner-a", 1.0).unwrap());
    assert!(!store.holds_notifier_lease(HOST, "owner-a", 2.0).unwrap());
    assert!(!store.holds_notifier_lease(HOST, "owner-b", 1.0).unwrap());
    assert!(
        !store
            .holds_notifier_lease(OTHER_HOST, "owner-a", 1.0)
            .unwrap()
    );
    // Another owner's release changes nothing; the owner's own release expires the row at once.
    store.release_notifier_lease(HOST, "owner-b").unwrap();
    assert!(store.holds_notifier_lease(HOST, "owner-a", 1.0).unwrap());
    store.release_notifier_lease(HOST, "owner-a").unwrap();
    assert!(!store.holds_notifier_lease(HOST, "owner-a", 1.0).unwrap());
    assert_eq!(
        store.read_notifier_lease(HOST).unwrap().unwrap()["live"],
        json!(false)
    );
    // The next owner takes the released lease over with the fence up by one.
    assert_eq!(
        claim(&store, HOST, "owner-b", "jobs-worker", 201, 60_000.0),
        json!({ "owner": true, "fence": 2 })
    );
    // A release on a host with no row writes none.
    store.release_notifier_lease(OTHER_HOST, "owner-a").unwrap();
    assert_eq!(store.read_notifier_lease(OTHER_HOST).unwrap(), None);
    assert_eq!(
        store.read_notifier_lease("a\u{0}b").unwrap_err().code,
        INVALID_ARGUMENT
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

fn source(store: &Store, id: &str) {
    let input: SourceInput = serde_json::from_value(
        json!({ "id": id, "name": id, "local_path": format!("/repos/{id}"), "config": {} }),
    )
    .unwrap();
    store.upsert_source(&input).unwrap();
}

fn state(store: &Store, id: &str, patch: Value) -> Result<()> {
    let patch: NotifierStatePatch = serde_json::from_value(patch).unwrap();
    store.write_notifier_state(id, &patch)
}

fn coverage(store: &Store, id: &str, head: Option<&str>, host: &str, pid: i64) {
    let c: NotifierCoverage = serde_json::from_value(json!({
        "head": head, "mode": "watch", "ownerHostId": host, "ownerKind": "serve", "ownerPid": pid,
    }))
    .unwrap();
    store.write_notifier_coverage(id, &c).unwrap();
}

fn row(store: &Store, id: &str) -> Value {
    let ids = [id.to_string()];
    let mut rows = store.read_notifier_sources(Some(&ids)).unwrap();
    assert!(rows.len() <= 1, "{rows:?}");
    rows.pop().unwrap_or(Value::Null)
}

/// The fields of a row that are not timestamps, plus which timestamps are set.
fn shape(row: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for (k, v) in row.as_object().unwrap() {
        if k.ends_with("_at") {
            out.insert(k.clone(), json!(!v.is_null()));
        } else if k != "source_incarnation" {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

#[test]
fn a_state_write_inserts_the_row_and_a_later_write_keeps_what_the_patch_does_not_name() {
    let dir = TempDir::new("notifier-state");
    let store = open(&dir);
    source(&store, "alpha");
    state(&store, "alpha", json!({ "state": "retry", "reason": "sync_failed", "firstDue": "keep", "attempts": 2, "nextRetryInMs": 60000,
        "errorGiven": true, "error": { "code": "E_SYNC", "message": "failed", "tracePath": "/trace" } })).unwrap();
    let inserted = row(&store, "alpha");
    assert_eq!(
        (
            inserted["state"].clone(),
            inserted["attempts"].clone(),
            inserted["last_error_code"].clone(),
            inserted["trace_path"].clone()
        ),
        (json!("retry"), json!(2), json!("E_SYNC"), json!("/trace"))
    );
    assert!(
        !inserted["first_due_at"].is_null()
            && !inserted["next_retry_at"].is_null()
            && !inserted["last_error_at"].is_null()
    );
    assert!(inserted["last_progress_at"].is_null());
    // A patch with no error, attempts or retry keeps the error and attempts, keeps first_due_at
    // and clears the retry time.
    state(
        &store,
        "alpha",
        json!({ "state": "running", "firstDue": "keep", "progress": true }),
    )
    .unwrap();
    let kept = row(&store, "alpha");
    assert_eq!(kept["first_due_at"], inserted["first_due_at"]);
    assert_eq!(
        (
            kept["attempts"].clone(),
            kept["last_error"].clone(),
            kept["reason"].clone()
        ),
        (json!(2), json!("failed"), Value::Null)
    );
    assert!(kept["next_retry_at"].is_null() && !kept["last_progress_at"].is_null());
    // 'clear' empties first_due_at and a null error clears the last error.
    state(&store, "alpha", json!({ "state": "idle", "firstDue": "clear", "attempts": 0, "errorGiven": true, "error": null })).unwrap();
    let cleared = shape(&row(&store, "alpha"));
    assert_eq!(
        (
            cleared["first_due_at"].clone(),
            cleared["last_error_code"].clone(),
            cleared["last_error_at"].clone(),
            cleared["trace_path"].clone(),
            cleared["attempts"].clone()
        ),
        (
            json!(false),
            Value::Null,
            json!(false),
            Value::Null,
            json!(0)
        )
    );
    // A source that does not exist gets no row, and a state outside the CHECK is refused.
    state(
        &store,
        "missing",
        json!({ "state": "due", "firstDue": "keep" }),
    )
    .unwrap();
    assert_eq!(row(&store, "missing"), Value::Null);
    let error = state(
        &store,
        "alpha",
        json!({ "state": "napping", "firstDue": "keep" }),
    )
    .unwrap_err();
    assert_eq!(error.code, INVALID_ARGUMENT);
}

#[test]
fn coverage_and_the_syncer_host_are_recorded_and_the_same_syncer_changes_nothing() {
    let dir = TempDir::new("notifier-coverage");
    let store = open(&dir);
    source(&store, "beta");
    assert!(!store.has_notifier_coverage().unwrap());
    store.record_notifier_syncer_host("beta", "host-s").unwrap();
    assert!(!store.has_notifier_coverage().unwrap());
    coverage(&store, "beta", Some("abc123"), "host-b", 4242);
    assert!(store.has_notifier_coverage().unwrap());
    let covered = row(&store, "beta");
    assert_eq!(
        (
            covered["observed_head"].clone(),
            covered["detection_mode"].clone(),
            covered["owner_host_id"].clone(),
            covered["owner_pid"].clone(),
            covered["state"].clone(),
            covered["syncer_host_id"].clone()
        ),
        (
            json!("abc123"),
            json!("watch"),
            json!("host-b"),
            json!(4242),
            json!("idle"),
            json!("host-s")
        )
    );
    std::thread::sleep(Duration::from_millis(2));
    store.record_notifier_syncer_host("beta", "host-s").unwrap();
    assert_eq!(
        row(&store, "beta"),
        covered,
        "the same syncer host writes nothing"
    );
    store.record_notifier_syncer_host("beta", "host-t").unwrap();
    let moved = row(&store, "beta");
    assert_eq!(moved["syncer_host_id"], json!("host-t"));
    assert_eq!(moved["source_incarnation"], covered["source_incarnation"]);
    // Every source with a row, in id order; none for a missing source.
    store
        .record_notifier_syncer_host("missing", "host-s")
        .unwrap();
    source(&store, "alpha");
    coverage(&store, "alpha", None, "host-b", 4242);
    let ids: Vec<Value> = store
        .read_notifier_sources(None)
        .unwrap()
        .iter()
        .map(|r| r["source_id"].clone())
        .collect();
    assert_eq!(ids, vec![json!("alpha"), json!("beta")]);
}

#[test]
fn the_status_rows_list_each_live_source_with_its_row_and_whether_its_owner_lease_is_live() {
    let dir = TempDir::new("notifier-status");
    let store = open(&dir);
    for id in ["alpha", "beta", "gone", "plain"] {
        source(&store, id);
    }
    store.set_source_archived("gone", true).unwrap();
    claim(&store, HOST, "owner-a", "serve", 101, 60_000.0);
    coverage(&store, "alpha", None, HOST, 101);
    coverage(&store, "beta", Some("abc123"), OTHER_HOST, 202);
    coverage(&store, "gone", None, HOST, 101);
    let rows: Vec<Value> = store
        .read_notifier_status_rows(None)
        .unwrap()
        .into_iter()
        .filter(|r| r["id"] != json!("default"))
        .collect();
    let pick = |r: &Value| {
        json!([
            r["id"],
            r["state"],
            r["observed_head"],
            r["owner_host_id"],
            r["lease_live"],
            !r["lease_expires_at"].is_null(),
            r["due_markers"],
            r["last_commit"]
        ])
    };
    assert_eq!(
        rows.iter().map(pick).collect::<Vec<_>>(),
        vec![
            json!(["alpha", "idle", null, HOST, true, true, 0, null]),
            json!(["beta", "idle", "abc123", OTHER_HOST, false, false, 0, null]),
            json!(["plain", null, null, null, false, false, 0, null]),
        ]
    );
    let some = [String::from("beta"), String::from("gone")];
    let listed: Vec<Value> = store
        .read_notifier_status_rows(Some(&some))
        .unwrap()
        .iter()
        .map(|r| r["id"].clone())
        .collect();
    assert_eq!(listed, vec![json!("beta")]);
}
