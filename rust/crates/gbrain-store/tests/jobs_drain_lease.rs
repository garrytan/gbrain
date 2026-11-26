//! The drain lease's holder record (`src/core/persistence/sync-lease.ts`) and the resident
//! notifier's live-job read (`src/core/notifier/resident.ts`), matched to the PGLite engine
//! (engine-sql/cycle-locks.ts and engine-sql/jobs.ts).

mod memory_env;

use gbrain_store::jobs::{AdmitSpec, CancelOpts};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const MIN: i64 = 60_000_000;

fn add(b: &Brain, name: &str, queue: &str, data: Value) -> i64 {
    let spec: AdmitSpec = serde_json::from_value(json!({
        "maxSpawnDepth": 5,
        "insert": {
            "name": name, "queue": queue, "status": "waiting", "priority": 0, "data": data,
            "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
            "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
            "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
        },
    }))
    .unwrap();
    b.admit_job(&spec).unwrap().row["id"].as_i64().unwrap()
}

fn beacon(kind: &str, id: Option<&str>) -> Value {
    json!({ "kind": kind, "id": id, "version": "0.0.0.0" })
}

fn holder_data(source: &str, kind: &str, id: Option<&str>) -> Value {
    json!({ "sourceId": source, "drain_lease_beacon": beacon(kind, id) })
}

fn job(b: &Brain, id: i64) -> Value {
    b.get_job(id).unwrap().expect("job exists")
}

#[test]
fn live_ids_keep_waiting_delayed_paused_and_active_jobs_once_each_in_id_order() {
    let b = brain("drain-live");
    let waiting = add(&b, "work", "default", json!({}));
    let paused = add(&b, "work", "default", json!({}));
    b.pause_job(paused).unwrap();
    let done = add(&b, "other", "default", json!({}));
    let cancel: CancelOpts = serde_json::from_value(json!({})).unwrap();
    b.cancel_jobs(&[done], &cancel).unwrap();
    assert_eq!(job(&b, done)["status"], json!("cancelled"));
    let missing = done + 1000;
    assert_eq!(
        b.read_live_job_ids(&[missing, done, paused, waiting, paused])
            .unwrap(),
        vec![waiting, paused]
    );
    assert!(b.read_live_job_ids(&[]).unwrap().is_empty());
}

#[test]
fn a_holder_write_replaces_the_sources_former_holder_and_carries_the_lease_shape() {
    let b = brain("drain-write");
    // An unrelated job and another source's holder survive the write.
    let other_job = add(&b, "sync", "default", json!({ "sourceId": "alpha" }));
    let beta = b
        .write_drain_lease_holder("beta", "tok-beta", holder_data("beta", "cli", None), 5.0)
        .unwrap();
    let first = b
        .write_drain_lease_holder(
            "alpha",
            "tok-1",
            holder_data("alpha", "job", Some("7")),
            5.0,
        )
        .unwrap();
    let second = b
        .write_drain_lease_holder("alpha", "tok-2", holder_data("alpha", "serve", None), 5.0)
        .unwrap();
    assert!(second > first);
    assert!(
        b.get_job(first).unwrap().is_none(),
        "the former holder is gone"
    );
    assert_eq!(job(&b, other_job)["status"], json!("waiting"));
    assert_eq!(job(&b, beta)["status"], json!("active"));

    let row = job(&b, second);
    let pick = |k: &str| row[k].clone();
    assert_eq!(
        json!({
            "name": pick("name"), "queue": pick("queue"), "status": pick("status"),
            "submission_authority": pick("submission_authority"), "data": pick("data"),
            "max_attempts": pick("max_attempts"), "max_stalled": pick("max_stalled"),
            "lock_token": pick("lock_token"), "remove_on_complete": pick("remove_on_complete"),
            "remove_on_fail": pick("remove_on_fail"), "stacktrace": pick("stacktrace"),
        }),
        json!({
            "name": "sync", "queue": "gbrain-drain-lease", "status": "active",
            "submission_authority": {"version": 1, "kind": "application"},
            "data": holder_data("alpha", "serve", None),
            "max_attempts": 1, "max_stalled": 0, "lock_token": "tok-2",
            "remove_on_complete": true, "remove_on_fail": true, "stacktrace": [],
        })
    );
    assert_eq!(row["started_at"], row["created_at"]);
    assert_ne!(row["lock_until"], row["started_at"]);

    assert_eq!(
        b.read_drain_lease_beacon("tok-2").unwrap(),
        Some(beacon("serve", None))
    );
    assert_eq!(
        b.read_drain_lease_beacon("tok-beta").unwrap(),
        Some(beacon("cli", None))
    );
    assert_eq!(b.read_drain_lease_beacon("tok-1").unwrap(), None);
    assert_eq!(b.read_drain_lease_beacon("no-such-token").unwrap(), None);
}

#[test]
fn a_refresh_moves_the_holders_expiry_and_a_release_deletes_only_that_token() {
    let b = brain("drain-refresh");
    let alpha = b
        .write_drain_lease_holder(
            "alpha",
            "tok-a",
            holder_data("alpha", "job", Some("7")),
            5.0,
        )
        .unwrap();
    let beta = b
        .write_drain_lease_holder("beta", "tok-b", holder_data("beta", "cli", None), 5.0)
        .unwrap();
    let before = job(&b, alpha)["lock_until"].clone();
    let beta_before = job(&b, beta)["lock_until"].clone();
    b.clock.advance(3 * MIN);
    assert_eq!(b.refresh_drain_lease_holder("tok-a", 5.0).unwrap(), 1);
    let after = job(&b, alpha);
    assert!(after["lock_until"].as_str() > before.as_str(), "{after}");
    assert!(
        after["updated_at"].as_str() > after["created_at"].as_str(),
        "{after}"
    );
    assert_eq!(job(&b, beta)["lock_until"], beta_before);
    assert_eq!(
        b.refresh_drain_lease_holder("no-such-token", 5.0).unwrap(),
        0
    );

    assert_eq!(b.release_drain_lease_holder("tok-a").unwrap(), 1);
    assert!(b.get_job(alpha).unwrap().is_none());
    assert_eq!(b.release_drain_lease_holder("tok-a").unwrap(), 0);
    assert_eq!(job(&b, beta)["status"], json!("active"));
}
