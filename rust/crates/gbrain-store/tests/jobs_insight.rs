//! `readJobInsight` (the reads behind `describeJobs`) on the store: submitter, queue position, slot holders,
//! live children, live leases with their beacon, whether the caller owns each (GST-4010), and the tokens of
//! completed descendants the caller does not own.

mod memory_env;

use gbrain_store::jobs::{AdmitSpec, ClaimSpec, InsightSpec, LockAcquire, TokenDelta};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const SEC: i64 = 1_000_000;
const BEACON: &str = "gbrain-drain-lease";

fn add(b: &Brain, name: &str, extra: Value) -> i64 {
    let mut insert = json!({
        "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": {},
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
    });
    for (k, v) in extra.as_object().unwrap() {
        insert[k] = v.clone();
    }
    let spec: AdmitSpec =
        serde_json::from_value(json!({ "insert": insert, "maxSpawnDepth": 5 })).unwrap();
    let id = b.admit_job(&spec).unwrap().row["id"].as_i64().unwrap();
    b.clock.advance(SEC);
    id
}

fn claim(b: &Brain, token: &str, queue: &str, name: &str) -> i64 {
    let spec: ClaimSpec = serde_json::from_value(json!({
        "lockToken": token, "lockDurationMs": 30000, "queue": queue, "names": [name],
        "suspectMark": "watchdog_suspect", "handlerTimeouts": {}, "handlerLockDurations": {},
        "legacySpend": {"groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5},
    }))
    .unwrap();
    let id = b.claim_next_job(&spec).unwrap().expect("claimed")["id"]
        .as_i64()
        .unwrap();
    b.clock.advance(SEC);
    id
}

fn spec(extra: Value) -> InsightSpec {
    let mut base = json!({ "holderQueue": BEACON, "holderLimit": 500 });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    serde_json::from_value(base).unwrap()
}

/// A fenced caller: the OAuth client that owns rows by their `__owner_client_id` stamp (these rows record no principal).
fn client(id: &str) -> Value {
    json!({ "principal": {"kind": "oauth_client", "id": id}, "clientId": id, "actor": ["", "", "", ""] })
}

fn ids(rows: &Value) -> Vec<i64> {
    rows.as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect()
}

#[test]
fn meta_position_holders_and_children() {
    let b = brain("insight-queue");
    let h1 = add(&b, "h1", json!({ "data": {"__owner_client_id": "a"} }));
    claim(&b, "w:1", "default", "h1");
    let h2 = add(&b, "h2", json!({}));
    claim(&b, "w:2", "default", "h2");
    let beacon = add(&b, "beacon", json!({ "queue": BEACON }));
    claim(&b, "w:3", BEACON, "beacon");
    let late = add(&b, "late", json!({ "priority": 5 }));
    let first = add(&b, "first", json!({ "data": {"__submitter": "cli"} }));
    let remote = add(
        &b,
        "remote",
        json!({
            "data": {"__submitter": "hidden"},
            "submission_authority": {"version": 1, "kind": "remote_generic"},
        }),
    );
    let other = add(&b, "other", json!({ "queue": "other" }));
    let parent = add(&b, "parent", json!({ "data": {"__owner_client_id": "a"} }));
    let live = add(&b, "live", json!({ "parent_job_id": parent }));
    let gone = add(&b, "gone", json!({ "parent_job_id": parent }));
    b.cancel_jobs(&[gone], &Default::default()).unwrap();

    let all = [
        h1, h2, beacon, late, first, remote, other, parent, live, gone, 9999,
    ];
    let out = b
        .read_job_insight(&spec(json!({
            "jobIds": all, "waitingIds": [late, first, remote, other, h1],
            "waitingQueues": ["default", "other", BEACON], "parentIds": [parent],
        })))
        .unwrap();
    let meta: Vec<_> = out["meta"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["id"].as_i64().unwrap(),
                m["submitter"].clone(),
                m["parent_owned"].clone(),
            )
        })
        .collect();
    assert_eq!(meta.len(), 10, "a missing id has no row");
    // Unfenced, the caller owns everything, a missing parent included.
    assert!(meta.contains(&(first, json!("cli"), json!(true))));
    assert!(
        meta.contains(&(remote, Value::Null, json!(true))),
        "only an application authority shows its submitter"
    );
    assert!(
        out["meta"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["owned"] == true)
    );
    assert!(
        out["holders"]
            .as_array()
            .unwrap()
            .iter()
            .all(|h| h["owned"] == true)
    );
    assert!(
        out["children"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["owned"] == true)
    );

    // Fenced as client `a`: it owns the jobs stamped `a` and the parent of `live`, not `live` or a job with no parent.
    let fenced = b
        .read_job_insight(&spec(json!({
            "jobIds": all, "waitingIds": [late], "waitingQueues": ["default"], "parentIds": [parent],
            "owner": client("a"),
        })))
        .unwrap();
    let owned: Vec<_> = fenced["meta"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["id"].as_i64().unwrap(),
                m["owned"].as_bool().unwrap(),
                m["parent_owned"].as_bool().unwrap(),
            )
        })
        .collect();
    assert!(owned.contains(&(h1, true, false)), "stamped `a`, no parent");
    assert!(
        owned.contains(&(live, false, true)),
        "the parent is the caller's"
    );
    assert!(owned.contains(&(first, false, false)));
    let holders: Vec<_> = fenced["holders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| (h["id"].as_i64().unwrap(), h["owned"].as_bool().unwrap()))
        .collect();
    assert_eq!(holders, vec![(h1, true), (h2, false)]);
    assert_eq!(fenced["children"][0]["owned"], false);
    // `first` and `remote` are ahead of `late` (priority 5), `late` is behind the three priority-0 waiting rows of its queue; `h1` is active, so it counts the whole queue.
    let ahead: Vec<_> = out["ahead"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| (a["id"].as_i64().unwrap(), a["ahead"].as_i64().unwrap()))
        .collect();
    assert!(
        ahead.contains(&(first, 0)) && ahead.contains(&(remote, 1)) && ahead.contains(&(late, 3))
    );
    assert!(ahead.contains(&(other, 0)));
    assert!(
        ahead.contains(&(h1, 0)),
        "an active job has no waiting row before its key"
    );
    // Holders: oldest start first, never the drain-lease queue.
    assert_eq!(ids(&out["holders"]), vec![h1, h2]);
    assert_eq!(
        ids(&out["children"]),
        vec![live],
        "a cancelled child is finished"
    );
    assert_eq!(out["foreign_tokens"], json!([]), "no owner, no foreign sum");

    let cut = b.read_job_insight(&spec(json!({
        "jobIds": [first], "waitingIds": [first], "waitingQueues": ["default"], "holderLimit": 1,
    }))).unwrap();
    assert_eq!(ids(&cut["holders"]), vec![h1]);
}

#[test]
fn foreign_tokens_skip_the_callers_own_children() {
    let b = brain("insight-tokens");
    let parent = add(&b, "parent", json!({}));
    for (name, owner, n) in [
        ("b", Some("client-b"), 1),
        ("none", None, 10),
        ("a", Some("client-a"), 100),
    ] {
        let data = owner.map_or(json!({}), |o| json!({ "__owner_client_id": o }));
        let id = add(&b, name, json!({ "parent_job_id": parent, "data": data }));
        claim(&b, &format!("w:{name}"), "default", name);
        let delta = TokenDelta {
            input: n,
            output: 2 * n,
            cache_read: 3 * n,
        };
        assert!(b.add_job_tokens(id, &format!("w:{name}"), &delta).unwrap());
        b.complete_job(id, &format!("w:{name}"), None)
            .unwrap()
            .unwrap();
    }
    // A child of another owner that holds tokens but has not completed is not summed.
    let midway = add(
        &b,
        "midway",
        json!({ "parent_job_id": parent, "data": {"__owner_client_id": "client-b"} }),
    );
    claim(&b, "w:midway", "default", "midway");
    let delta = TokenDelta {
        input: 1000,
        output: 2000,
        cache_read: 3000,
    };
    assert!(b.add_job_tokens(midway, "w:midway", &delta).unwrap());
    let out = b
        .read_job_insight(&spec(
            json!({ "jobIds": [parent], "owner": client("client-a") }),
        ))
        .unwrap();
    assert_eq!(
        out["foreign_tokens"],
        json!([{ "parent_job_id": parent, "i": 11, "o": 22, "c": 33 }])
    );
    let all = b
        .read_job_insight(&spec(
            json!({ "jobIds": [parent], "owner": client("nobody") }),
        ))
        .unwrap();
    assert_eq!(all["foreign_tokens"][0]["i"], 111);
}

#[test]
fn live_leases_carry_their_beacon_and_whether_the_caller_owns_the_holder() {
    let b = brain("insight-locks");
    let holder = add(
        &b,
        "holder",
        json!({ "data": {"__owner_client_id": "client-a"} }),
    );
    let lease = |pid: i64, token: &str, ttl: f64| LockAcquire {
        holder_pid: pid,
        holder_host: Some(format!("host-{pid}")),
        acquisition_token: token.into(),
        ttl_minutes: ttl,
        steal_grace_seconds: 0.0,
    };
    let t = |n: u8| format!("00000000-0000-4000-8000-0000000000{n:02}");
    b.acquire_cycle_lock("src1", &lease(1, &t(1), 30.0))
        .unwrap()
        .unwrap();
    add(
        &b,
        "beacon",
        json!({ "queue": BEACON, "data": {"drain_lease_beacon": {"kind": "job", "id": holder.to_string()}} }),
    );
    claim(&b, &t(1), BEACON, "beacon");
    b.acquire_cycle_lock("src2", &lease(2, &t(2), 30.0))
        .unwrap()
        .unwrap();
    b.acquire_cycle_lock("proc", &lease(4, &t(4), 30.0))
        .unwrap()
        .unwrap();
    add(
        &b,
        "beacon-proc",
        json!({ "queue": BEACON, "data": {"drain_lease_beacon": {"kind": "process", "pid": 4, "id": holder.to_string()}} }),
    );
    claim(&b, &t(4), BEACON, "beacon-proc");
    b.acquire_cycle_lock("old", &lease(3, &t(3), -1.0))
        .unwrap()
        .unwrap();
    let out = b
        .read_job_insight(&spec(
            json!({ "jobIds": [holder], "lockIds": ["src1", "src2", "proc", "old", "absent"] }),
        ))
        .unwrap();
    let locks = out["locks"].as_array().unwrap();
    assert_eq!(
        locks.len(),
        3,
        "the expired and the absent lease are not listed"
    );
    assert_eq!(locks[0]["id"], "proc");
    assert_eq!(locks[0]["beacon"]["kind"], "process");
    assert_eq!(
        locks[0]["holder_owned"], true,
        "unfenced, the caller owns every holder"
    );
    assert_eq!(locks[1]["id"], "src1");
    assert_eq!(
        locks[1]["beacon"],
        json!({"kind": "job", "id": holder.to_string()})
    );
    assert_eq!(locks[1]["holder_owned"], true);
    assert_eq!(locks[1]["holder_pid"], 1);
    assert_eq!(locks[2]["id"], "src2");
    assert_eq!(locks[2]["beacon"], Value::Null);
    assert_eq!(locks[2]["holder_owned"], true);

    // Fenced as `client-a`: only the lease whose beacon names a job it owns reads as its own; a process beacon and a
    // lease with no beacon name no holder.
    let fenced = b
        .read_job_insight(&spec(json!({
            "jobIds": [holder], "lockIds": ["src1", "src2", "proc"], "owner": client("client-a"),
        })))
        .unwrap();
    let owned: Vec<_> = fenced["locks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["id"].as_str().unwrap().to_string(),
                l["holder_owned"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        owned,
        vec![
            ("proc".to_string(), false),
            ("src1".to_string(), true),
            ("src2".to_string(), false)
        ]
    );
}

#[test]
fn foreign_tokens_walk_through_the_callers_completed_children() {
    let b = brain("insight-walk");
    let parent = add(&b, "parent", json!({}));
    // A finished job takes no new children, so the whole tree is admitted first and then finished bottom-up.
    let child = |name: &str, parent: i64, owner: &str| -> i64 {
        add(
            &b,
            name,
            json!({ "parent_job_id": parent, "data": {"__owner_client_id": owner} }),
        )
    };
    let finish = |name: &str, id: i64, n: i32| {
        claim(&b, &format!("w:{name}"), "default", name);
        let delta = TokenDelta {
            input: n.into(),
            output: 0,
            cache_read: 0,
        };
        assert!(b.add_job_tokens(id, &format!("w:{name}"), &delta).unwrap());
        b.complete_job(id, &format!("w:{name}"), None)
            .unwrap()
            .unwrap();
    };
    let mine = child("mine", parent, "client-a");
    let theirs_under_mine = child("theirs-under-mine", mine, "client-b");
    let theirs = child("theirs", parent, "client-b");
    let mine_under_theirs = child("mine-under-theirs", theirs, "client-b");
    // Under the caller's completed child: another owner's completed grandchild is foreign.
    finish("theirs-under-mine", theirs_under_mine, 10);
    finish("mine", mine, 1);
    // Under another owner's completed child: never reached. A finished child's tokens roll up into its parent, so its 1000
    // already sit in `theirs` and the walk must not add them a second time.
    finish("mine-under-theirs", mine_under_theirs, 1000);
    finish("theirs", theirs, 100);
    let out = b
        .read_job_insight(&spec(
            json!({ "jobIds": [parent], "owner": client("client-a") }),
        ))
        .unwrap();
    let dbg = b.read_job_insight(&spec(json!({ "jobIds": [parent, mine, theirs_under_mine, theirs, mine_under_theirs], "owner": client("client-a") }))).unwrap();
    eprintln!(
        "DBG ids={:?} meta={}",
        [parent, mine, theirs_under_mine, theirs, mine_under_theirs],
        dbg["meta"]
    );
    // The walk reaches `parent` and `mine`; foreign children of those are `theirs` (100 and the 1000 rolled up from its
    // child) and `theirs-under-mine` (10).
    assert_eq!(out["foreign_tokens"][0]["i"], 1110);
}
