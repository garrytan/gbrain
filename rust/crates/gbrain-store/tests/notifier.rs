//! The commit notifier's host lease, host source list, per-source state and coverage rows,
//! freshness status rows and wanted markers (persistence/notifier.rs).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::*;
use gbrain_store::persistence::{
    NotifierCoverage, NotifierLeaseClaim, NotifierStatePatch, WantedMarkerInput,
};
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

fn mark(
    store: &Store,
    id: &str,
    intent: &str,
    head: Option<&str>,
    by: &str,
    job: Option<i64>,
) -> Result<Option<Value>> {
    let m: WantedMarkerInput = serde_json::from_value(json!({
        "sourceId": id, "intent": intent, "wantedHead": head, "requestedBy": by, "jobId": job,
    }))
    .unwrap();
    store.upsert_wanted_marker(&m)
}

/// A marker's source, intent, head, generation, requester and job.
fn pick(m: &Value) -> Value {
    json!([
        m["source_id"],
        m["intent"],
        m["wanted_head"],
        m["generation"],
        m["requested_by"],
        m["job_id"]
    ])
}

#[test]
fn a_marker_upsert_inserts_generation_one_and_a_re_record_bumps_it_keeping_first_due_and_the_job() {
    let dir = TempDir::new("notifier-marker-upsert");
    let store = open(&dir);
    source(&store, "alpha");
    let first = mark(&store, "alpha", "freshness", Some("h1"), "webhook", Some(7))
        .unwrap()
        .unwrap();
    assert_eq!(
        pick(&first),
        json!(["alpha", "freshness", "h1", 1, "webhook", 7])
    );
    assert!(first["source_incarnation"].is_string());
    std::thread::sleep(Duration::from_millis(5));
    let again = mark(&store, "alpha", "freshness", None, "notifier", None)
        .unwrap()
        .unwrap();
    assert_eq!(
        pick(&again),
        json!(["alpha", "freshness", null, 2, "notifier", 7])
    );
    assert_eq!(again["first_due_at"], first["first_due_at"]);
    assert_ne!(again["updated_at"], first["updated_at"]);
    let third = mark(
        &store,
        "alpha",
        "freshness",
        Some("h3"),
        "sync_trigger",
        Some(9),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        pick(&third),
        json!(["alpha", "freshness", "h3", 3, "sync_trigger", 9])
    );
    // Another intent is its own row.
    let pull = mark(&store, "alpha", "pull", None, "webhook", None)
        .unwrap()
        .unwrap();
    assert_eq!(
        pick(&pull),
        json!(["alpha", "pull", null, 1, "webhook", null])
    );
    // A missing source records nothing; a bad intent is refused.
    assert_eq!(
        mark(&store, "missing", "pull", None, "webhook", None).unwrap(),
        None
    );
    assert_eq!(
        mark(&store, "a\0b", "pull", None, "webhook", None).unwrap(),
        None
    );
    assert_eq!(
        mark(&store, "alpha", "push", None, "webhook", None)
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
    assert_eq!(store.read_wanted_markers(None).unwrap().len(), 2);
}

#[test]
fn marker_reads_order_by_first_due_then_source_then_intent_and_filter_by_source() {
    let dir = TempDir::new("notifier-marker-read");
    let store = open(&dir);
    for id in ["alpha", "beta"] {
        source(&store, id);
    }
    mark(&store, "beta", "pull", None, "webhook", None).unwrap();
    std::thread::sleep(Duration::from_millis(5));
    mark(&store, "alpha", "full", None, "webhook", None).unwrap();
    std::thread::sleep(Duration::from_millis(5));
    mark(&store, "alpha", "freshness", Some("h"), "webhook", None).unwrap();
    let order = |rows: Vec<Value>| {
        rows.iter()
            .map(|m| json!([m["source_id"], m["intent"]]))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        order(store.read_wanted_markers(None).unwrap()),
        vec![
            json!(["beta", "pull"]),
            json!(["alpha", "full"]),
            json!(["alpha", "freshness"])
        ]
    );
    let alpha = [
        String::from("alpha"),
        String::from("alpha"),
        String::from("nobody"),
    ];
    assert_eq!(
        order(store.read_wanted_markers(Some(&alpha)).unwrap()),
        vec![json!(["alpha", "full"]), json!(["alpha", "freshness"])]
    );
    // No source here has a last_commit yet, so a freshness marker naming a head is due too.
    assert_eq!(order(store.read_due_wanted_markers(None).unwrap()).len(), 3);
    assert_eq!(
        order(store.read_due_wanted_markers(Some(&alpha)).unwrap()).len(),
        2
    );
    // The status list orders the source's markers by first_due_at, then intent.
    let listed = store.list_source_wanted_markers("alpha").unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|m| m["intent"].clone())
            .collect::<Vec<_>>(),
        vec![json!("full"), json!("freshness")]
    );
    assert_eq!(
        {
            let mut keys: Vec<String> = listed[1].as_object().unwrap().keys().cloned().collect();
            keys.sort();
            keys
        },
        vec!["first_due_at", "intent", "requested_by", "wanted_head"]
    );
    assert!(
        store
            .list_source_wanted_markers("nobody")
            .unwrap()
            .is_empty()
    );
    // The status rows count the due markers.
    let due: Vec<Value> = store
        .read_notifier_status_rows(None)
        .unwrap()
        .iter()
        .filter(|r| r["id"] != json!("default"))
        .map(|r| json!([r["id"], r["due_markers"]]))
        .collect();
    assert_eq!(due, vec![json!(["alpha", 2]), json!(["beta", 1])]);
}

#[test]
fn attach_clear_and_settle_act_only_at_the_generation_read_and_prune_deletes_nothing_before_a_last_commit()
 {
    let dir = TempDir::new("notifier-marker-generation");
    let store = open(&dir);
    source(&store, "alpha");
    mark(&store, "alpha", "pull", None, "webhook", None).unwrap();
    mark(&store, "alpha", "pull", None, "webhook", None).unwrap();
    store
        .attach_wanted_marker_job("alpha", "pull", 1, 11)
        .unwrap();
    assert_eq!(
        store.read_wanted_markers(None).unwrap()[0]["job_id"],
        Value::Null
    );
    store
        .attach_wanted_marker_job("alpha", "pull", 2, 12)
        .unwrap();
    assert_eq!(
        store.read_wanted_markers(None).unwrap()[0]["job_id"],
        json!(12)
    );
    assert!(!store.clear_wanted_marker("alpha", "pull", 1).unwrap());
    assert!(!store.clear_wanted_marker("alpha", "full", 2).unwrap());
    assert!(store.clear_wanted_marker("alpha", "pull", 2).unwrap());
    assert!(!store.clear_wanted_marker("alpha", "pull", 2).unwrap());
    // A freshness marker that names no head settles at its generation only.
    mark(&store, "alpha", "freshness", None, "webhook", None).unwrap();
    store.settle_freshness_marker("alpha", 2, None).unwrap();
    assert_eq!(store.read_wanted_markers(None).unwrap().len(), 1);
    store
        .settle_freshness_marker("alpha", 1, Some("h"))
        .unwrap();
    assert!(store.read_wanted_markers(None).unwrap().is_empty());
    // One that names a head stays: the source has no last_commit yet to equal it.
    mark(&store, "alpha", "freshness", Some("h"), "webhook", None).unwrap();
    store
        .settle_freshness_marker("alpha", 1, Some("h"))
        .unwrap();
    mark(&store, "alpha", "pull", Some("h"), "webhook", None).unwrap();
    store
        .prune_satisfied_wanted_markers(&[String::from("alpha")])
        .unwrap();
    assert_eq!(store.read_wanted_markers(None).unwrap().len(), 2);
}

#[test]
fn the_sync_shape_is_a_live_sources_path_with_no_binding_and_none_for_a_missing_or_archived_source()
{
    let dir = TempDir::new("notifier-sync-shape");
    let store = open(&dir);
    source(&store, "alpha");
    source(&store, "gone");
    store.set_source_archived("gone", true).unwrap();
    assert_eq!(
        store.read_source_sync_shape("alpha").unwrap(),
        Some(json!({ "local_path": "/repos/alpha", "root": null, "bound": false }))
    );
    assert_eq!(store.read_source_sync_shape("gone").unwrap(), None);
    assert_eq!(store.read_source_sync_shape("missing").unwrap(), None);
}

#[test]
fn the_first_due_clock_is_the_earlier_of_a_busy_row_and_a_due_freshness_marker_per_existing_source()
{
    let dir = TempDir::new("notifier-first-due");
    let store = open(&dir);
    for id in ["alpha", "beta", "gamma", "delta", "gone"] {
        source(&store, id);
    }
    store.set_source_archived("gone", true).unwrap();
    state(
        &store,
        "beta",
        json!({ "state": "due", "reason": "commit", "firstDue": "keep" }),
    )
    .unwrap();
    coverage(&store, "beta", Some("b"), HOST, 1);
    std::thread::sleep(Duration::from_millis(5));
    mark(&store, "beta", "freshness", None, "lock_busy", None).unwrap();
    coverage(&store, "gamma", Some("c"), HOST, 2);
    mark(&store, "gamma", "freshness", Some("c"), "notifier", None).unwrap();
    state(
        &store,
        "delta",
        json!({ "state": "idle", "firstDue": "clear" }),
    )
    .unwrap();
    mark(&store, "delta", "pull", None, "sync_trigger", None).unwrap();
    state(
        &store,
        "gone",
        json!({ "state": "retry", "reason": "sync_failed", "firstDue": "keep" }),
    )
    .unwrap();
    let markers = store.read_wanted_markers(None).unwrap();
    let marker_due = |id: &str| {
        markers
            .iter()
            .find(|m| m["source_id"] == json!(id) && m["intent"] == json!("freshness"))
            .unwrap()["first_due_at"]
            .clone()
    };
    let ids: Vec<String> = ["gone", "beta", "missing", "alpha", "gamma", "delta", "beta"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let got = store.read_notifier_first_due(&ids).unwrap();
    assert_eq!(
        got,
        vec![
            json!({ "source_id": "alpha", "observed_head": null, "first_due_at": null }),
            json!({ "source_id": "beta", "observed_head": "b", "first_due_at": row(&store, "beta")["first_due_at"] }),
            json!({ "source_id": "delta", "observed_head": null, "first_due_at": null }),
            json!({ "source_id": "gamma", "observed_head": "c", "first_due_at": marker_due("gamma") }),
            json!({ "source_id": "gone", "observed_head": null, "first_due_at": row(&store, "gone")["first_due_at"] }),
        ]
    );
    for clock in [row(&store, "beta"), row(&store, "gone")] {
        assert!(clock["first_due_at"].is_string(), "{clock}");
    }
    assert!(marker_due("gamma").is_string());
    assert!(row(&store, "beta")["first_due_at"].as_str() < marker_due("beta").as_str());
    assert!(store.read_notifier_first_due(&[]).unwrap().is_empty());
}

#[test]
fn a_last_commit_advance_stamps_the_source_and_due_prune_and_settle_compare_markers_with_it() {
    let dir = TempDir::new("notifier-last-commit");
    let store = open(&dir);
    source(&store, "alpha");
    assert_eq!(store.read_source_last_commit("alpha").unwrap(), None);
    store.advance_source_commit("nobody", "aaa", None).unwrap();
    assert!(
        store.get_source("nobody").unwrap().is_none(),
        "an unknown source is not made"
    );
    store
        .advance_source_commit("alpha", "aaa", Some(Some("2026-01-02T03:04:05.000Z")))
        .unwrap();
    let got = store.get_source("alpha").unwrap().unwrap();
    assert_eq!(got.last_commit.as_deref(), Some("aaa"));
    assert_eq!(
        store.read_source_last_commit("alpha").unwrap().as_deref(),
        Some("aaa")
    );
    assert_eq!(store.read_source_last_commit("nobody").unwrap(), None);
    assert!(got.last_sync_at.is_some());
    let record = |store: &Store| {
        store
            .list_source_records()
            .unwrap()
            .into_iter()
            .find(|r| r.id == "alpha")
            .unwrap()
    };
    assert_eq!(
        record(&store).newest_content_at.as_deref(),
        Some("2026-01-02T03:04:05.000000Z")
    );
    // No newest time keeps the stored one; null clears it.
    store.advance_source_commit("alpha", "bbb", None).unwrap();
    assert_eq!(record(&store).last_commit.as_deref(), Some("bbb"));
    assert_eq!(
        record(&store).newest_content_at.as_deref(),
        Some("2026-01-02T03:04:05.000000Z")
    );
    store
        .advance_source_commit("alpha", "bbb", Some(None))
        .unwrap();
    assert_eq!(record(&store).newest_content_at, None);
    assert!(
        store
            .advance_source_commit("alpha", "bbb", Some(Some("not a time")))
            .is_err()
    );
    // The host and status rows read it.
    let host = store.list_notifier_host_source_rows().unwrap();
    assert_eq!(
        host.iter().find(|r| r["id"] == json!("alpha")).unwrap()["last_commit"],
        json!("bbb")
    );
    // A freshness marker naming the source's head is not due; one naming another head is.
    mark(&store, "alpha", "freshness", Some("bbb"), "webhook", None).unwrap();
    mark(&store, "alpha", "pull", Some("bbb"), "webhook", None).unwrap();
    assert_eq!(store.read_due_wanted_markers(None).unwrap().len(), 1);
    let status = store.read_notifier_status_rows(None).unwrap();
    let alpha = status.iter().find(|r| r["id"] == json!("alpha")).unwrap();
    assert_eq!(alpha["last_commit"], json!("bbb"));
    assert_eq!(alpha["due_markers"], json!(1));
    // The prune deletes both markers that name the source's head.
    store
        .prune_satisfied_wanted_markers(&[String::from("alpha")])
        .unwrap();
    assert!(store.read_wanted_markers(None).unwrap().is_empty());
    // The settle keeps a marker naming another head, unless the checkout head equals last_commit.
    mark(&store, "alpha", "freshness", Some("ccc"), "webhook", None).unwrap();
    store
        .settle_freshness_marker("alpha", 1, Some("ccc"))
        .unwrap();
    assert_eq!(store.read_wanted_markers(None).unwrap().len(), 1);
    store
        .settle_freshness_marker("alpha", 1, Some("bbb"))
        .unwrap();
    assert!(store.read_wanted_markers(None).unwrap().is_empty());
    mark(&store, "alpha", "freshness", Some("bbb"), "webhook", None).unwrap();
    store.settle_freshness_marker("alpha", 1, None).unwrap();
    assert!(store.read_wanted_markers(None).unwrap().is_empty());
}

#[test]
fn attach_clear_and_settle_act_only_at_the_generation_read_and_prune_deletes_nothing() {
    let dir = TempDir::new("notifier-marker-generation");
    let store = open(&dir);
    source(&store, "alpha");
    mark(&store, "alpha", "pull", None, "webhook", None).unwrap();
    mark(&store, "alpha", "pull", None, "webhook", None).unwrap();
    store
        .attach_wanted_marker_job("alpha", "pull", 1, 11)
        .unwrap();
    assert_eq!(
        store.read_wanted_markers(None).unwrap()[0]["job_id"],
        Value::Null
    );
    store
        .attach_wanted_marker_job("alpha", "pull", 2, 12)
        .unwrap();
    assert_eq!(
        store.read_wanted_markers(None).unwrap()[0]["job_id"],
        json!(12)
    );
    assert!(!store.clear_wanted_marker("alpha", "pull", 1).unwrap());
    assert!(!store.clear_wanted_marker("alpha", "full", 2).unwrap());
    assert!(store.clear_wanted_marker("alpha", "pull", 2).unwrap());
    assert!(!store.clear_wanted_marker("alpha", "pull", 2).unwrap());
    // A freshness marker that names no head settles at its generation only.
    mark(&store, "alpha", "freshness", None, "webhook", None).unwrap();
    store.settle_freshness_marker("alpha", 2, None).unwrap();
    assert_eq!(store.read_wanted_markers(None).unwrap().len(), 1);
    store
        .settle_freshness_marker("alpha", 1, Some("h"))
        .unwrap();
    assert!(store.read_wanted_markers(None).unwrap().is_empty());
    // One that names a head stays: the source has no last_commit to equal it.
    mark(&store, "alpha", "freshness", Some("h"), "webhook", None).unwrap();
    store
        .settle_freshness_marker("alpha", 1, Some("h"))
        .unwrap();
    mark(&store, "alpha", "pull", Some("h"), "webhook", None).unwrap();
    store
        .prune_satisfied_wanted_markers(&[String::from("alpha")])
        .unwrap();
    assert_eq!(store.read_wanted_markers(None).unwrap().len(), 2);
}

#[test]
fn a_stored_last_commit_settles_prunes_and_undues_the_markers_that_name_it_and_first_due_reads_the_earlier_time()
 {
    let dir = TempDir::new("notifier-last-commit");
    let store = open(&dir);
    for id in ["alpha", "beta", "gamma"] {
        source(&store, id);
    }
    store.advance_source_commit("alpha", "c1", None).unwrap();
    let order = |rows: Vec<Value>| {
        rows.iter()
            .map(|m| json!([m["source_id"], m["intent"]]))
            .collect::<Vec<_>>()
    };
    state(
        &store,
        "alpha",
        json!({ "state": "due", "firstDue": "keep" }),
    )
    .unwrap();
    coverage(&store, "alpha", Some("c2"), "host-a", 1);
    std::thread::sleep(Duration::from_millis(5));
    mark(&store, "alpha", "freshness", Some("c1"), "notifier", None).unwrap();
    state(
        &store,
        "beta",
        json!({ "state": "idle", "firstDue": "clear" }),
    )
    .unwrap();
    let beta = mark(&store, "beta", "freshness", None, "notifier", None)
        .unwrap()
        .unwrap();
    let alpha_due = row(&store, "alpha")["first_due_at"].clone();
    let ids: Vec<String> = ["gamma", "alpha", "beta", "missing", "alpha"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(
        store.read_first_due(&ids).unwrap(),
        vec![
            json!({ "source_id": "alpha", "observed_head": "c2", "first_due_at": alpha_due }),
            json!({ "source_id": "beta", "observed_head": null, "first_due_at": beta["first_due_at"] }),
            json!({ "source_id": "gamma", "observed_head": null, "first_due_at": null }),
        ]
    );
    // The marker naming the reached commit is not due; the status and host rows read the commit.
    assert_eq!(
        order(store.read_due_wanted_markers(None).unwrap()),
        vec![json!(["beta", "freshness"])]
    );
    let alpha = [String::from("alpha")];
    let status = store.read_notifier_status_rows(Some(&alpha)).unwrap();
    assert_eq!(
        (&status[0]["last_commit"], &status[0]["due_markers"]),
        (&json!("c1"), &json!(0))
    );
    let host = store.list_notifier_host_source_rows().unwrap();
    assert_eq!(host[0]["last_commit"], json!("c1"));
    // The prune deletes the freshness and pull markers naming it; a full marker stays.
    mark(&store, "alpha", "pull", Some("c1"), "webhook", None).unwrap();
    mark(&store, "alpha", "full", Some("c1"), "sync_trigger", None).unwrap();
    store.prune_satisfied_wanted_markers(&alpha).unwrap();
    assert_eq!(
        order(store.read_wanted_markers(Some(&alpha)).unwrap()),
        vec![json!(["alpha", "full"])]
    );
    // A marker naming another head settles once the source reached the checkout head seen.
    mark(&store, "alpha", "freshness", Some("c9"), "notifier", None).unwrap();
    store
        .settle_freshness_marker("alpha", 1, Some("c8"))
        .unwrap();
    assert_eq!(store.read_wanted_markers(Some(&alpha)).unwrap().len(), 2);
    store
        .settle_freshness_marker("alpha", 1, Some("c1"))
        .unwrap();
    assert_eq!(
        order(store.read_wanted_markers(Some(&alpha)).unwrap()),
        vec![json!(["alpha", "full"])]
    );
}
