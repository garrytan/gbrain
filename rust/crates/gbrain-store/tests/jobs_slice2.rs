//! Jobs slice 2: the writes on one job, the sweeps, the inbox, the private queues, the reads and
//! the attachments, matched to the PGLite engine (`queue.ts` at the cited lines of each member).

mod memory_env;

use gbrain_store::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use gbrain_store::jobs::{
    AdmitSpec, AttachmentInput, CancelOpts, ClaimSpec, DelayOpts, JobPageSpec, OverdueSpec,
    PruneSpec, TokenDelta,
};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const MARK: &str = "watchdog_suspect";
const SEC: i64 = 1_000_000;

fn insert(name: &str, extra: Value) -> Value {
    let mut base = json!({
        "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": {},
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
    });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

fn admit(b: &Brain, spec: Value) -> gbrain_store::Result<gbrain_store::jobs::AdmitOutcome> {
    let mut spec = spec;
    if spec.get("maxSpawnDepth").is_none() {
        spec["maxSpawnDepth"] = json!(5);
    }
    let spec: AdmitSpec = serde_json::from_value(spec).unwrap();
    b.admit_job(&spec)
}

fn add(b: &Brain, name: &str, extra: Value) -> i64 {
    let out = admit(b, json!({ "insert": insert(name, extra) })).unwrap();
    assert_eq!(out.outcome, "inserted");
    out.row["id"].as_i64().unwrap()
}

fn claim_spec(token: &str, queue: &str, names: &[&str], extra: Value) -> ClaimSpec {
    let mut spec = json!({
        "lockToken": token, "lockDurationMs": 30000, "queue": queue, "names": names,
        "suspectMark": MARK, "handlerTimeouts": {}, "handlerLockDurations": {},
        "legacySpend": {"groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5},
    });
    for (k, v) in extra.as_object().unwrap() {
        spec[k] = v.clone();
    }
    serde_json::from_value(spec).unwrap()
}

fn claim(b: &Brain, token: &str) -> Option<Value> {
    b.claim_next_job(&claim_spec(token, "default", &["work"], json!({})))
        .unwrap()
}

fn job(b: &Brain, id: i64) -> Value {
    b.get_job(id).unwrap().expect("job exists")
}

fn ids(rows: &[Value]) -> Vec<i64> {
    let mut v: Vec<i64> = rows.iter().map(|r| r["id"].as_i64().unwrap()).collect();
    v.sort();
    v
}

fn cancel_opts(v: Value) -> CancelOpts {
    serde_json::from_value(v).unwrap()
}

// ------------------------------------------------------------------ writes on one job

#[test]
fn pause_resume_and_delete_terminal() {
    let b = brain("s2-pause");
    let id = add(&b, "work", json!({}));
    let paused = b.pause_job(id).unwrap().unwrap();
    assert_eq!(paused["status"], "paused");
    assert!(b.pause_job(id).unwrap().is_none(), "paused cannot pause");
    assert!(claim(&b, "w:1").is_none(), "a paused row is not claimed");
    assert!(b.resume_job(id + 100).unwrap().is_none());
    assert_eq!(b.resume_job(id).unwrap().unwrap()["status"], "waiting");
    assert!(b.resume_job(id).unwrap().is_none());

    assert!(!b.delete_terminal_job(id).unwrap(), "a live row stays");
    claim(&b, "w:1").unwrap();
    b.complete_job(id, "w:1", None).unwrap().unwrap();
    assert!(b.delete_terminal_job(id).unwrap());
    assert!(b.get_job(id).unwrap().is_none());
    assert!(!b.delete_terminal_job(id).unwrap());
}

#[test]
fn deleting_a_job_cascades_to_inbox_attachments_children_and_owned_queues() {
    let b = brain("s2-cascade");
    let owner = add(&b, "owner", json!({}));
    let owned = add(
        &b,
        "work",
        json!({"queue": "private-q", "private_queue_owner_job_id": owner,
               "private_queue_owner_token": "tok", "private_queue_lease_until": "2027-01-15T09:00:00Z"}),
    );
    assert_eq!(job(&b, owned)["private_queue_owner_job_id"], owner);
    assert_eq!(
        job(&b, owned)["private_queue_lease_until"],
        "2027-01-15T09:00:00.000000Z"
    );
    let child = add(&b, "work", json!({"parent_job_id": owner}));
    b.post_inbox_message(owner, "x", &json!({"a": 1})).unwrap();
    let att = AttachmentInput {
        filename: "a.txt".into(),
        content_type: "text/plain".into(),
        content_b64: "aGk=".into(),
        size_bytes: 2,
        sha256: "abc".into(),
    };
    b.insert_job_attachment(owner, &att).unwrap();

    // terminal-ise the owner: cancel it (the child cascades), then delete the owner
    b.clock.advance(5 * SEC);
    let before = job(&b, owned)["updated_at"].clone();
    b.cancel_jobs(&[owner], &cancel_opts(json!({"rootStatuses": null})))
        .unwrap();
    // the owned queue row is not a descendant, so it stays live
    assert_eq!(job(&b, owned)["status"], "waiting");
    assert_eq!(job(&b, child)["status"], "cancelled");
    b.clock.advance(5 * SEC);
    assert!(b.delete_terminal_job(owner).unwrap());
    let row = job(&b, owned);
    assert_eq!(row["private_queue_owner_job_id"], Value::Null, "SET NULL");
    assert_eq!(
        row["updated_at"], before,
        "the SET NULL does not touch updated_at"
    );
    assert_eq!(job(&b, child)["parent_job_id"], Value::Null);
    assert!(b.list_job_attachment_names(owner).unwrap().is_none());
    assert!(b.list_job_attachments(owner).unwrap().is_empty());
    assert!(b.get_job_attachment(owner, "a.txt").unwrap().is_none());
}

#[test]
fn parent_resolution_failing_and_detaching() {
    let b = brain("s2-parent");
    let parent = add(&b, "parent", json!({}));
    let c1 = add(&b, "work", json!({"parent_job_id": parent}));
    let c2 = add(&b, "work", json!({"parent_job_id": parent}));
    assert_eq!(job(&b, parent)["status"], "waiting-children");
    assert!(
        b.resolve_parent_job(parent).unwrap().is_none(),
        "open children keep the parent waiting"
    );
    assert_eq!(b.resolve_stranded_parents().unwrap(), 0);
    b.detach_child_job(c1).unwrap();
    assert_eq!(job(&b, c1)["parent_job_id"], Value::Null);
    b.detach_child_job(c2).unwrap();
    b.detach_child_job(999).unwrap();
    assert_eq!(b.resolve_stranded_parents().unwrap(), 1);
    assert_eq!(job(&b, parent)["status"], "waiting");
    assert!(b.resolve_parent_job(parent).unwrap().is_none());

    let p2 = add(&b, "parent", json!({}));
    add(&b, "work", json!({"parent_job_id": p2}));
    let failed = b
        .fail_parent_job(p2, "child failed: boom")
        .unwrap()
        .unwrap();
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["error_text"], "child failed: boom");
    assert_ne!(failed["finished_at"], Value::Null);
    assert!(b.fail_parent_job(p2, "again").unwrap().is_none());

    let p3 = add(&b, "parent", json!({}));
    let c3 = add(&b, "work", json!({"parent_job_id": p3}));
    b.detach_child_job(c3).unwrap();
    let woken = b.resolve_parent_job(p3).unwrap().unwrap();
    assert_eq!(woken["status"], "waiting");
}

#[test]
fn progress_tokens_delay_release_mark_and_retry() {
    let b = brain("s2-active");
    let id = add(&b, "work", json!({"timeout_ms": 5000}));
    claim(&b, "w:1").unwrap();
    assert_ne!(job(&b, id)["timeout_at"], Value::Null);

    assert!(
        b.update_job_progress(id, "w:1", &json!({"pct": 50}))
            .unwrap()
    );
    assert_eq!(job(&b, id)["progress"], json!({"pct": 50}));
    assert!(!b.update_job_progress(id, "w:2", &json!(1)).unwrap());
    assert!(b.update_job_progress(id, "w:1", &Value::Null).unwrap());
    assert_eq!(job(&b, id)["progress"], Value::Null);

    let delta = TokenDelta {
        input: 3,
        output: 4,
        cache_read: 5,
    };
    assert!(b.add_job_tokens(id, "w:1", &delta).unwrap());
    assert!(b.add_job_tokens(id, "w:1", &delta).unwrap());
    assert!(!b.add_job_tokens(id, "nope", &delta).unwrap());
    let row = job(&b, id);
    assert_eq!(
        (row["tokens_input"].as_i64(), row["tokens_output"].as_i64()),
        (Some(6), Some(8))
    );
    assert_eq!(row["tokens_cache_read"], 10);

    let opts = |append, clear| DelayOpts {
        error_text: "later".into(),
        delay_ms: 2000.0,
        append_stack: append,
        clear_timeout: clear,
    };
    assert!(
        b.delay_active_job(id, "w:2", &opts(true, false))
            .unwrap()
            .is_none()
    );
    let delayed = b
        .delay_active_job(id, "w:1", &opts(true, false))
        .unwrap()
        .unwrap();
    assert_eq!(delayed["status"], "delayed");
    assert_eq!(delayed["error_text"], "later");
    assert_eq!(delayed["stacktrace"], json!(["later"]));
    assert_ne!(delayed["timeout_at"], Value::Null, "timeout kept");
    assert_eq!(delayed["lock_token"], Value::Null);
    assert_eq!(delayed["started_at"], Value::Null);
    assert_eq!(delayed["delay_until"], "2027-01-15T08:00:02.000000Z");
    assert!(
        b.delay_active_job(id, "w:1", &opts(true, false))
            .unwrap()
            .is_none()
    );

    assert!(b.promote_delayed_jobs().unwrap().is_empty());
    b.clock.advance(2 * SEC);
    let promoted = b.promote_delayed_jobs().unwrap();
    assert_eq!(ids(&promoted), vec![id]);
    assert_eq!(promoted[0]["status"], "waiting");

    claim(&b, "w:1").unwrap();
    let delayed = b
        .delay_active_job(id, "w:1", &opts(false, true))
        .unwrap()
        .unwrap();
    assert_eq!(delayed["stacktrace"], json!(["later"]), "not appended");
    assert_eq!(delayed["timeout_at"], Value::Null);
    b.clock.advance(2 * SEC);
    b.promote_delayed_jobs().unwrap();

    claim(&b, "w:1").unwrap();
    assert!(!b.release_watchdog_claim(id, "w:2", "e", MARK).unwrap());
    assert!(
        b.release_watchdog_claim(id, "w:1", "released", MARK)
            .unwrap()
    );
    let row = job(&b, id);
    assert_eq!(row["status"], "waiting");
    assert_eq!(row["error_text"], "released");
    assert_eq!(row["stacktrace"], json!(["later", MARK]));
    assert_eq!(row["timeout_at"], Value::Null);
    assert_eq!(row["attempts_made"], 0);

    let stamp = row["updated_at"].clone();
    b.clock.advance(SEC);
    b.mark_job_watchdog_suspect(id, MARK).unwrap();
    let row = job(&b, id);
    assert_eq!(row["stacktrace"], json!(["later", MARK]), "already marked");
    let other = add(&b, "work", json!({}));
    let stamp_other = job(&b, other)["updated_at"].clone();
    b.mark_job_watchdog_suspect(other, MARK).unwrap();
    assert_eq!(job(&b, other)["stacktrace"], json!([MARK]));
    assert_eq!(job(&b, other)["updated_at"], stamp_other, "updated_at kept");
    assert_eq!(row["updated_at"], stamp);

    // retry: failed and dead come back fresh, others do not
    assert!(b.retry_job_update(id).unwrap().is_none());
    claim(&b, "w:1").unwrap();
    b.fail_job(id, "w:1", "boom", "dead", None, None)
        .unwrap()
        .unwrap();
    assert_eq!(job(&b, id)["status"], "dead");
    let r = b.retry_job_update(id).unwrap().unwrap();
    assert_eq!(r["status"], "waiting");
    assert_eq!(r["error_text"], Value::Null);
    assert_eq!(r["finished_at"], Value::Null);
    assert_eq!(
        (r["attempts_made"].as_i64(), r["attempts_started"].as_i64()),
        (Some(0), Some(0))
    );
    assert_eq!(r["stalled_counter"], 0);
}

// ------------------------------------------------------------------ sweeps

#[test]
fn a_held_claim_goes_back_to_delayed_with_its_start_error_and_attempts_kept() {
    let b = brain("s2-held-claim");
    let id = add(&b, "work", json!({"timeout_ms": 5000}));
    claim(&b, "w:1").unwrap();
    let held = job(&b, id);

    // A stale token changes nothing.
    assert!(!b.delay_held_claim(id, "w:2", 60_000.0).unwrap());
    assert_eq!(job(&b, id), held);

    b.clock.advance(SEC);
    assert!(b.delay_held_claim(id, "w:1", 60_000.0).unwrap());
    let row = job(&b, id);
    assert_eq!(row["status"], "delayed");
    assert_eq!(row["lock_token"], Value::Null);
    assert_eq!(row["lock_until"], Value::Null);
    assert_eq!(row["delay_until"], "2027-01-15T08:01:01.000000Z");
    assert_ne!(row["updated_at"], held["updated_at"]);
    for kept in [
        "started_at",
        "timeout_at",
        "error_text",
        "stacktrace",
        "attempts_made",
        "attempts_started",
        "stalled_counter",
    ] {
        assert_eq!(row[kept], held[kept], "{kept} stays as the claim set it");
    }

    // The token is gone, so a second release matches no row.
    assert!(!b.delay_held_claim(id, "w:1", 900_000.0).unwrap());
    assert_eq!(job(&b, id), row);
}

#[test]
fn cancel_cascades_posts_child_done_and_resolves_parents() {
    let b = brain("s2-cancel");
    let grand = add(&b, "grand", json!({}));
    let parent = add(&b, "parent", json!({"parent_job_id": grand}));
    let kid = add(&b, "work", json!({"parent_job_id": parent}));
    let sibling = add(&b, "work", json!({"parent_job_id": grand}));
    let done = add(&b, "work", json!({"parent_job_id": parent}));
    claim(&b, "w:1").unwrap();
    b.complete_job(
        job_id_of(&b, "work", &[kid, sibling, done], "w:1"),
        "w:1",
        None,
    )
    .unwrap();
    b.clock.advance(SEC);

    // cancel only the parent: it and its live descendants go; grand has a live child left
    let rows = b
        .cancel_jobs(&[parent], &cancel_opts(json!({"reason": "stop it"})))
        .unwrap();
    let got = ids(&rows);
    assert!(got.contains(&parent));
    for r in &rows {
        assert_eq!(r["status"], "cancelled");
        assert_eq!(r["lock_token"], Value::Null);
        assert_ne!(r["finished_at"], Value::Null);
    }
    let by_id = |id: i64| rows.iter().find(|r| r["id"] == id).cloned();
    assert_eq!(by_id(parent).unwrap()["error_text"], "stop it");
    // the reason is stamped on the roots in `ids` only
    for r in &rows {
        if r["id"] != parent {
            assert_ne!(
                r["error_text"], "stop it",
                "descendants keep their own error"
            );
        }
    }
    // the cancelled parent posted child_done to grand (live) with outcome cancelled
    let tok = claim_grand(&b, grand);
    let msgs = b.read_child_completions(grand, &tok, None).unwrap();
    assert!(msgs.iter().any(|m| m["child_id"] == parent
        && m["outcome"] == "cancelled"
        && m["error"] == "cancelled"
        && m["result"].is_null()
        && m["job_name"] == "parent"
        && m["type"] == "child_done"));
}

/// Completes the first claimed row of `name` among `candidates`: returns its id.
fn job_id_of(b: &Brain, name: &str, candidates: &[i64], token: &str) -> i64 {
    candidates
        .iter()
        .copied()
        .find(|id| {
            let r = job(b, *id);
            r["name"] == name && r["lock_token"] == token
        })
        .expect("a claimed row")
}

/// Forces `grand` active under a known token (the cancel test reads its inbox).
fn claim_grand(b: &Brain, grand: i64) -> String {
    // grand is waiting-children; let a detach-free path through: resolve is not possible, so
    // set up the claim by cancelling nothing: use a dedicated token via the store's own claim
    // once it is waiting. Siblings may still be open, so detach them first.
    let open: Vec<i64> = b
        .list_jobs(&serde_json::from_value(json!({"limit": 100})).unwrap())
        .unwrap()
        .iter()
        .filter(|r| r["parent_job_id"] == grand)
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    for id in open {
        if job(b, id)["status"] != "cancelled" && job(b, id)["status"] != "completed" {
            b.detach_child_job(id).unwrap();
        }
    }
    b.resolve_parent_job(grand).unwrap();
    b.claim_next_job(&claim_spec("g:1", "default", &["grand"], json!({})))
        .unwrap()
        .expect("grand claimed");
    "g:1".into()
}

#[test]
fn cancel_respects_root_statuses_the_owner_fence_and_depth() {
    let b = brain("s2-cancel-fence");
    let mine = json!({"version": 1, "kind": "remote", "client": "c",
        "grant": {"actor": {"system": "s", "external_id": "e", "member": "m"}, "actingFor": ["z", "a", "a"]}});
    let a = add(
        &b,
        "work",
        json!({"data": {"__owner_client_id": "c1"}, "submission_authority": mine}),
    );
    let other = add(&b, "work", json!({"data": {"__owner_client_id": "c2"}}));
    let actor = ["s", "e", "m", "a,z"].map(String::from);
    let fenced = |client: &str, actor: [String; 4]| {
        cancel_opts(json!({"ownerClientId": client, "ownerActor": actor}))
    };
    // wrong client, wrong actor, other row's authority: nothing is cancelled
    assert!(
        b.cancel_jobs(&[a], &fenced("c2", actor.clone()))
            .unwrap()
            .is_empty()
    );
    let wrong = ["s", "e", "m", "a"].map(String::from);
    assert!(
        b.cancel_jobs(&[a], &fenced("c1", wrong))
            .unwrap()
            .is_empty()
    );
    assert!(
        b.cancel_jobs(&[other], &fenced("c2", actor.clone()))
            .unwrap()
            .is_empty()
    );
    assert_eq!(job(&b, a)["status"], "waiting");
    assert_eq!(
        ids(&b.cancel_jobs(&[a], &fenced("c1", actor)).unwrap()),
        vec![a]
    );

    // rootStatuses filters the roots; a missing id is ignored
    let w = add(&b, "work", json!({}));
    assert!(
        b.cancel_jobs(&[w], &cancel_opts(json!({"rootStatuses": ["active"]})))
            .unwrap()
            .is_empty()
    );
    let rows = b
        .cancel_jobs(
            &[w, 9999],
            &cancel_opts(json!({"rootStatuses": ["waiting"], "reason": null})),
        )
        .unwrap();
    assert_eq!(ids(&rows), vec![w]);
    assert!(
        b.cancel_jobs(&[w], &cancel_opts(json!({})))
            .unwrap()
            .is_empty()
    );

    // depth: a chain of 5 is cancelled whole from its root
    let mut chain = vec![add(&b, "n0", json!({}))];
    for i in 1..5 {
        chain.push(add(
            &b,
            &format!("n{i}"),
            json!({"parent_job_id": chain[i - 1]}),
        ));
    }
    let rows = b.cancel_jobs(&chain[..1], &cancel_opts(json!({}))).unwrap();
    assert_eq!(ids(&rows), chain);
}

#[test]
fn cancelling_the_last_child_wakes_its_parent_with_a_child_done_message() {
    let b = brain("s2-cancel-wake");
    let parent = add(&b, "work", json!({}));
    let kid = add(&b, "kid", json!({"parent_job_id": parent}));
    assert_eq!(job(&b, parent)["status"], "waiting-children");
    b.cancel_jobs(&[kid], &cancel_opts(json!({}))).unwrap();
    assert_eq!(job(&b, parent)["status"], "waiting");
    claim(&b, "p:1").unwrap();
    assert!(
        b.read_child_completions(parent, "other", None)
            .unwrap()
            .is_empty()
    );
    let msgs = b.read_child_completions(parent, "p:1", None).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0]["child_id"], kid);
    assert_eq!(msgs[0]["outcome"], "cancelled");
}

#[test]
fn timeouts_and_wall_clock_kill_active_rows() {
    let b = brain("s2-kill");
    let timed = add(&b, "work", json!({"timeout_ms": 1000}));
    let wall = add(&b, "work", json!({"timeout_ms": 10_000}));
    let plain = add(&b, "work", json!({}));
    let parent = add(&b, "parent", json!({}));
    let kid = add(&b, "work", json!({"parent_job_id": parent}));
    for i in 0..4 {
        claim(&b, &format!("w:{i}")).unwrap();
    }
    assert_eq!(job(&b, kid)["status"], "active");
    assert!(b.kill_timed_out_jobs().unwrap().is_empty());
    b.clock.advance(2 * SEC);
    let killed = b.kill_timed_out_jobs().unwrap();
    assert_eq!(ids(&killed), vec![timed]);
    assert_eq!(killed[0]["status"], "dead");
    assert_eq!(killed[0]["error_text"], "timeout exceeded");
    assert_eq!(killed[0]["attempts_made"], 1);

    // an expired lease is the stall sweep's, not the timeout kill's
    b.clock.advance(60 * SEC);
    assert!(b.kill_timed_out_jobs().unwrap().is_empty());

    // wall clock: timeout_ms*2 = 20s for `wall`; the others use lockDurationMs*2*max_stalled
    let killed = b.kill_wall_clock_jobs(30_000.0).unwrap();
    assert_eq!(ids(&killed), vec![wall], "only timeout_ms*2 has passed");
    assert_eq!(killed[0]["status"], "dead");
    assert_eq!(killed[0]["error_text"], "wall-clock timeout exceeded");

    // the default bound is lockDurationMs * 2 * max_stalled (5 by default; no column value here, so the argument)
    b.clock.advance(300 * SEC);
    let killed = b.kill_wall_clock_jobs(30_000.0).unwrap();
    assert_eq!(ids(&killed), vec![plain, kid]);
    // the killed child posted child_done and woke the parent
    assert_eq!(job(&b, parent)["status"], "waiting");
    assert!(b.kill_wall_clock_jobs(30_000.0).unwrap().is_empty());
}

#[test]
fn a_killed_child_posts_child_done_with_outcome_timeout() {
    let b = brain("s2-kill-parent");
    let parent = add(&b, "work", json!({}));
    let kid = add(
        &b,
        "kid",
        json!({"parent_job_id": parent, "timeout_ms": 1000}),
    );
    // claim the kid (the parent is waiting-children)
    b.claim_next_job(&claim_spec("k:1", "default", &["kid"], json!({})))
        .unwrap()
        .unwrap();
    // lease is 30 s, so advance only 2 s
    b.clock.advance(2 * SEC);
    let killed = b.kill_timed_out_jobs().unwrap();
    assert_eq!(ids(&killed), vec![kid]);
    assert_eq!(job(&b, parent)["status"], "waiting");
    claim(&b, "p:1").unwrap();
    let msgs = b.read_child_completions(parent, "p:1", None).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0]["outcome"], "timeout");
    assert_eq!(msgs[0]["error"], "timeout exceeded");
}

#[test]
fn the_lease_beacon_queue_is_never_killed() {
    let b = brain("s2-beacon");
    add(
        &b,
        "work",
        json!({"queue": "gbrain-drain-lease", "timeout_ms": 1000}),
    );
    b.claim_next_job(&claim_spec(
        "b:1",
        "gbrain-drain-lease",
        &["work"],
        json!({}),
    ))
    .unwrap()
    .unwrap();
    b.clock.advance(5 * SEC);
    assert!(b.kill_timed_out_jobs().unwrap().is_empty());
    assert!(b.kill_wall_clock_jobs(1.0).unwrap().is_empty());
}

#[test]
fn prune_deletes_old_rows_dry_runs_and_archives_dream_synthesis() {
    let b = brain("s2-prune");
    let old: Vec<i64> = (0..3).map(|_| add(&b, "work", json!({}))).collect();
    for (i, _) in old.iter().enumerate() {
        claim(&b, &format!("w:{i}")).unwrap();
    }
    for (i, id) in old.iter().enumerate() {
        b.complete_job(*id, &format!("w:{i}"), None)
            .unwrap()
            .unwrap();
    }
    b.clock.advance(10 * SEC);
    let fresh = add(&b, "work", json!({}));
    let spec = |dry| -> PruneSpec {
        serde_json::from_value(json!({"statuses": ["completed", "failed"],
            "olderThan": "2027-01-15T08:00:05Z", "dryRun": dry}))
        .unwrap()
    };
    let dry = b.prune_jobs(&spec(true)).unwrap();
    assert_eq!(dry.count, 3);
    assert_eq!(b.list_job_attachment_names(old[0]).unwrap(), Some(vec![]));
    let done = b.prune_jobs(&spec(false)).unwrap();
    assert_eq!(done.count, 3);
    for id in &old {
        assert!(b.get_job(*id).unwrap().is_none());
    }
    assert!(b.get_job(fresh).unwrap().is_some());

    // a completed dream-synthesis subagent's key moves to the archive as the row goes
    let finish = |b: &Brain, rows: &[(&str, Value)]| -> Vec<i64> {
        let ids: Vec<i64> = rows.iter().map(|(n, x)| add(b, n, x.clone())).collect();
        for (n, (name, x)) in rows.iter().enumerate() {
            b.claim_next_job(&claim_spec(
                &format!("s:{n}"),
                x["queue"].as_str().unwrap(),
                &[name],
                json!({}),
            ))
            .unwrap()
            .unwrap();
        }
        for (n, id) in ids.iter().enumerate() {
            b.complete_job(*id, &format!("s:{n}"), None)
                .unwrap()
                .unwrap();
        }
        ids
    };
    let synth_ids = finish(
        &b,
        &[
            (
                "subagent",
                json!({"idempotency_key": "dream:synth:abc", "queue": "q2", "data": {"source_id": "src"}}),
            ),
            (
                "subagent",
                json!({"idempotency_key": "dream:synth-v2:def", "queue": "q3", "data": {"source_id": ""}}),
            ),
            (
                "subagent",
                json!({"idempotency_key": "other:ghi", "queue": "q4"}),
            ),
            ("work", json!({"queue": "q5"})),
        ],
    );
    let failed_synth = add(
        &b,
        "subagent",
        json!({"idempotency_key": "dream:synth:failed", "queue": "q6", "status": "failed"}),
    );
    b.clock.advance(60 * SEC);
    let spec = |dry: bool| -> PruneSpec {
        serde_json::from_value(json!({"statuses": ["completed", "failed"],
            "olderThan": "2027-01-15T09:00:00Z", "dryRun": dry}))
        .unwrap()
    };
    let dry = b.prune_jobs(&spec(true)).unwrap();
    assert_eq!(dry.count, 5);
    // live completed rows answer the reads before the prune; a dry run archives nothing
    assert_eq!(
        b.list_synthesis_completion_keys("src", "dream:synth:")
            .unwrap(),
        vec!["dream:synth:abc".to_string()]
    );
    let done = b.prune_jobs(&spec(false)).unwrap();
    assert_eq!(serde_json::to_value(&done).unwrap(), json!({"count": 5}));
    for id in synth_ids.iter().chain([&failed_synth]) {
        assert!(b.get_job(*id).unwrap().is_none());
    }
    assert_eq!(
        b.list_synthesis_completion_keys("src", "dream:synth:")
            .unwrap(),
        vec!["dream:synth:abc".to_string()]
    );
    // an empty source_id is the default source; a v1 prefix does not match v2 keys
    assert_eq!(
        b.list_synthesis_completion_keys("default", "dream:synth-v2:")
            .unwrap(),
        vec!["dream:synth-v2:def".to_string()]
    );
    assert!(
        b.list_synthesis_completion_keys("default", "dream:synth:")
            .unwrap()
            .is_empty()
    );
    let recent = b.list_recent_synthesis_completions("default", 1.0).unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0]["idempotency_key"], "dream:synth-v2:def");
    assert!(
        b.list_recent_synthesis_completions("src", 1.0)
            .unwrap()
            .is_empty()
    );
    let first_at = recent[0]["at"].clone();
    // the same key completes again and is pruned again: the archive keeps its first row
    b.clock.advance(60 * SEC);
    let again = finish(
        &b,
        &[(
            "subagent",
            json!({"idempotency_key": "dream:synth-v2:def", "queue": "q7"}),
        )],
    );
    // a live completed job and its archived twin read once (UNION) or twice (UNION ALL)
    assert_eq!(
        b.list_synthesis_completion_keys("default", "dream:synth-v2:")
            .unwrap(),
        vec!["dream:synth-v2:def".to_string()]
    );
    assert_eq!(
        b.list_recent_synthesis_completions("default", 1.0)
            .unwrap()
            .len(),
        2
    );
    b.clock.advance(60 * SEC);
    let spec: PruneSpec = serde_json::from_value(json!({"statuses": ["completed"],
        "olderThan": "2027-01-15T10:00:00Z"}))
    .unwrap();
    assert_eq!(b.prune_jobs(&spec).unwrap().count, 1);
    assert!(b.get_job(again[0]).unwrap().is_none());
    let recent = b.list_recent_synthesis_completions("default", 1.0).unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0]["at"], first_at);
    // past the window nothing is recent; the keys stay
    assert!(
        b.list_recent_synthesis_completions("default", 0.0001)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        b.list_synthesis_completion_keys("default", "dream:synth-v2:")
            .unwrap()
            .len(),
        1
    );
}

// ------------------------------------------------------------------ inbox

#[test]
fn inbox_messages_are_read_once_by_the_token_holder() {
    let b = brain("s2-inbox");
    let id = add(&b, "work", json!({}));
    let err = b.post_inbox_message(999, "s", &json!({})).unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let err = b.post_inbox_message(id, "s", &Value::Null).unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let m1 = b.post_inbox_message(id, "alice", &json!({"n": 1})).unwrap();
    b.clock.advance(SEC);
    let m2 = b.post_inbox_message(id, "bob", &json!([1, 2])).unwrap();
    assert!(m2["id"].as_i64() > m1["id"].as_i64());
    assert_eq!(m1["read_at"], Value::Null);
    assert_eq!(m1["sender"], "alice");
    assert_eq!(m1["sent_at"], "2027-01-15T08:00:00.000000Z");

    assert!(
        b.read_job_inbox(id, "w:1").unwrap().is_empty(),
        "not active"
    );
    claim(&b, "w:1").unwrap();
    assert!(
        b.read_job_inbox(id, "w:2").unwrap().is_empty(),
        "wrong token"
    );
    let rows = b.read_job_inbox(id, "w:1").unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["payload"], json!({"n": 1}));
    assert_eq!(rows[1]["payload"], json!([1, 2]));
    assert_eq!(rows[0]["read_at"], "2027-01-15T08:00:01.000000Z");
    assert!(b.read_job_inbox(id, "w:1").unwrap().is_empty(), "read once");
    b.post_inbox_message(id, "c", &json!("late")).unwrap();
    assert_eq!(b.read_job_inbox(id, "w:1").unwrap().len(), 1);
}

#[test]
fn child_completions_filter_by_type_and_since_in_sent_order() {
    let b = brain("s2-completions");
    let id = add(&b, "work", json!({}));
    b.post_inbox_message(id, "x", &json!({"type": "child_done", "child_id": 1}))
        .unwrap();
    b.clock.advance(2 * SEC);
    b.post_inbox_message(id, "x", &json!({"type": "note"}))
        .unwrap();
    b.post_inbox_message(id, "x", &json!({"type": "child_done", "child_id": 2}))
        .unwrap();
    b.post_inbox_message(id, "x", &json!({"type": "child_done", "child_id": 3}))
        .unwrap();
    claim(&b, "w:1").unwrap();
    let all = b.read_child_completions(id, "w:1", None).unwrap();
    let kids: Vec<i64> = all
        .iter()
        .map(|m| m["child_id"].as_i64().unwrap())
        .collect();
    assert_eq!(kids, vec![1, 2, 3]);
    let later = b
        .read_child_completions(id, "w:1", Some("2027-01-15T08:00:00.000000Z"))
        .unwrap();
    let kids: Vec<i64> = later
        .iter()
        .map(|m| m["child_id"].as_i64().unwrap())
        .collect();
    assert_eq!(kids, vec![2, 3], "sent_at strictly after since");
    assert!(
        b.read_child_completions(id, "w:1", Some("2030-01-01T00:00:00Z"))
            .unwrap()
            .is_empty()
    );
    // reading completions leaves the rows unread
    assert_eq!(b.read_job_inbox(id, "w:1").unwrap().len(), 4);
    let err = b
        .read_child_completions(id, "w:1", Some("nonsense"))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

// ------------------------------------------------------------------ private queues

#[test]
fn private_queue_listing_lease_renewal_and_recovery_state() {
    let b = brain("s2-private");
    let owner = add(&b, "owner", json!({}));
    claim_named(&b, "o:1", "owner");
    let q = "dream-private:abc";
    let r1 = add(
        &b,
        "work",
        json!({"queue": q, "private_queue_owner_job_id": owner,
               "private_queue_owner_token": "tok", "private_queue_lease_until": "2027-01-15T08:00:30Z"}),
    );
    let r2 = add(&b, "work", json!({"queue": q}));
    add(&b, "work", json!({"queue": "dream-private:none"}));
    add(
        &b,
        "work",
        json!({"queue": "other", "private_queue_owner_job_id": owner}),
    );
    assert_eq!(b.list_open_job_ids_in_queue(q).unwrap(), vec![r1, r2]);
    assert!(b.list_open_job_ids_in_queue("nope").unwrap().is_empty());
    assert_eq!(
        b.list_owned_private_queues("dream-private:", 10).unwrap(),
        vec![q.to_string()],
        "a queue without owner metadata is not listed"
    );
    assert!(
        b.list_owned_private_queues("dream-private:", 0)
            .unwrap()
            .is_empty()
    );
    assert!(b.list_owned_private_queues("zzz", 10).unwrap().is_empty());

    b.clock.advance(200 * SEC);
    let state = b.read_private_queue_state(q).unwrap();
    let v = serde_json::to_value(&state).unwrap();
    assert_eq!(v["active_healthy"], 0);
    assert_eq!(v["owner_ids"], json!([owner]));
    assert_eq!(v["metadata_rows"], 1);
    assert_eq!(v["live_owner_rows"], 0, "the owner's lease lapsed");
    assert_eq!(v["nonterminal_owner_rows"], 1);
    assert_eq!(v["max_lease_until"], "2027-01-15T08:00:30.000000Z");
    assert_eq!(v["future_lease_rows"], 0);
    assert_eq!(v["recently_touched"], 0);

    assert_eq!(
        b.renew_private_queue_lease(q, "wrong", 60_000.0).unwrap(),
        0
    );
    assert_eq!(b.renew_private_queue_lease(q, "tok", 60_000.0).unwrap(), 1);
    let v = serde_json::to_value(b.read_private_queue_state(q).unwrap()).unwrap();
    assert_eq!(v["max_lease_until"], "2027-01-15T08:04:20.000000Z");
    assert_eq!(v["future_lease_rows"], 1);
    assert_eq!(v["recently_touched"], 1);
    // a shorter lease never shortens
    b.renew_private_queue_lease(q, "tok", 1.0).unwrap();
    let v = serde_json::to_value(b.read_private_queue_state(q).unwrap()).unwrap();
    assert_eq!(v["max_lease_until"], "2027-01-15T08:04:20.000000Z");

    // a missing owner row counts in neither owner count
    let ghost = brain("s2-private-ghost");
    let o2 = add(&ghost, "owner", json!({}));
    add(
        &ghost,
        "work",
        json!({"queue": "pq", "private_queue_owner_job_id": o2}),
    );
    ghost.cancel_jobs(&[o2], &cancel_opts(json!({}))).unwrap();
    ghost.delete_terminal_job(o2).unwrap();
    let v = serde_json::to_value(ghost.read_private_queue_state("pq").unwrap()).unwrap();
    assert_eq!(v["owner_ids"], json!([]));
    assert_eq!(v["live_owner_rows"], 0);
    assert_eq!(v["nonterminal_owner_rows"], 0);
}

fn claim_named(b: &Brain, token: &str, name: &str) -> Value {
    b.claim_next_job(&claim_spec(token, "default", &[name], json!({})))
        .unwrap()
        .expect("claimed")
}

#[test]
fn owned_queues_are_ordered_oldest_first_and_limited() {
    let b = brain("s2-owned-order");
    let lease = "2027-01-15T09:00:00Z";
    add(
        &b,
        "w",
        json!({"queue": "p:b", "private_queue_lease_until": lease}),
    );
    b.clock.advance(SEC);
    add(
        &b,
        "w",
        json!({"queue": "p:a", "private_queue_lease_until": lease}),
    );
    add(
        &b,
        "w",
        json!({"queue": "p:c", "private_queue_lease_until": lease}),
    );
    add(&b, "w", json!({"queue": "p:b"}));
    assert_eq!(
        b.list_owned_private_queues("p:", 10).unwrap(),
        ["p:b", "p:a", "p:c"]
    );
    assert_eq!(
        b.list_owned_private_queues("p:", 2).unwrap(),
        ["p:b", "p:a"]
    );
}

// ------------------------------------------------------------------ reads

#[test]
fn stale_waiting_ttl_expired_unreviewed_and_failed_for_retry() {
    let b = brain("s2-reads");
    let a = add(&b, "ttl", json!({}));
    b.clock.advance(SEC);
    let c = add(&b, "ttl", json!({}));
    let remote = add(
        &b,
        "remote",
        json!({"submission_authority": {"version": 1, "kind": "remote", "client": "c"}}),
    );
    b.clock.advance(3 * 3600 * SEC);
    assert_eq!(
        b.list_stale_waiting_job_ids("ttl", 2.0, 10).unwrap(),
        vec![a, c]
    );
    assert_eq!(
        b.list_stale_waiting_job_ids("ttl", 2.0, 1).unwrap(),
        vec![a]
    );
    assert!(
        b.list_stale_waiting_job_ids("ttl", 4.0, 10)
            .unwrap()
            .is_empty()
    );
    assert!(
        b.list_stale_waiting_job_ids("nope", 2.0, 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(b.count_ttl_expired_waiting("ttl", 2.0).unwrap(), 2);
    assert_eq!(b.count_ttl_expired_waiting("ttl", 5.0).unwrap(), 0);

    let unreviewed = b.list_unreviewed_jobs().unwrap();
    let got: Vec<i64> = unreviewed
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    assert_eq!(got, vec![remote], "application rows are reviewed");
    assert_eq!(unreviewed[0]["submission_authority"]["kind"], "remote");

    assert!(b.get_failed_job_for_retry(a).unwrap().is_none(), "waiting");
    claim_named(&b, "w:1", "ttl");
    b.fail_job(a, "w:1", "x", "failed", None, None)
        .unwrap()
        .unwrap();
    let r = b.get_failed_job_for_retry(a).unwrap().unwrap();
    assert_eq!(r, json!({"name": "ttl", "data": {}}));
    assert!(b.get_failed_job_for_retry(12345).unwrap().is_none());
}

#[test]
fn job_stats_and_family_stats() {
    let b = brain("s2-stats");
    let done = add(&b, "work", json!({}));
    let failing = add(&b, "other", json!({}));
    claim(&b, "w:1").unwrap();
    b.clock.advance(4 * SEC);
    b.complete_job(done, "w:1", None).unwrap().unwrap();
    claim_named(&b, "w:2", "other");
    b.fail_job(failing, "w:2", "boom", "dead", None, None)
        .unwrap()
        .unwrap();
    add(&b, "work", json!({}));
    b.clock.advance(10 * SEC);
    let s = b.read_job_stats("2027-01-15T00:00:00Z", "default").unwrap();
    let count = |st: &str| {
        s["by_status"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["status"] == st)
            .map(|r| r["count"].as_i64().unwrap())
    };
    assert_eq!(
        (count("completed"), count("dead"), count("waiting")),
        (Some(1), Some(1), Some(1))
    );
    let work = s["types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "work")
        .unwrap();
    assert_eq!(work["total"], 2);
    assert_eq!(work["completed"], 1);
    assert_eq!(work["avg_duration_ms"].as_f64(), Some(4000.0));
    let depth = &s["depth"].as_array().unwrap()[0];
    assert_eq!(
        (depth["name"].as_str(), depth["waiting_now"].as_i64()),
        (Some("work"), Some(1))
    );
    assert_eq!(depth["oldest_waiting_seconds"].as_f64(), Some(10.0));
    assert_eq!(s["stalled"], 0);
    assert_eq!(s["wedge"]["waiting"], 1);
    assert_eq!(s["wedge"]["active_healthy"], 0);
    assert_eq!(s["wedge"]["last_completed"], "2027-01-15 08:00:04+00");
    assert!(
        s["drained"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["name"] == "work" && r["completed"] == 1)
    );
    assert!(
        s["drained"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["name"] == "other" && r["dead"] == 1)
    );
    // `since` in the future excludes everything
    let s = b.read_job_stats("2030-01-01T00:00:00Z", "default").unwrap();
    assert!(s["types"].as_array().unwrap().is_empty());
    assert!(s["drained"].as_array().unwrap().is_empty());
    assert!(b.read_job_stats("garbage", "default").is_err());

    // stalled: an active row with an expired lease
    claim(&b, "w:3").unwrap();
    b.clock.advance(60 * SEC);
    assert_eq!(
        b.read_job_stats("2027-01-15T00:00:00Z", "default").unwrap()["stalled"],
        1
    );
}

#[test]
fn queue_family_stats_group_by_prefix() {
    let b = brain("s2-family");
    add(&b, "w", json!({"queue": "dream:1"}));
    add(&b, "w", json!({"queue": "dream:2"}));
    add(&b, "w", json!({"queue": "plain"}));
    b.claim_next_job(&claim_spec("c:1", "dream:1", &["w"], json!({})))
        .unwrap()
        .unwrap();
    let rows = b
        .read_queue_family_stats("2027-01-15T00:00:00Z", "dream:")
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["queue"], "dream");
    assert_eq!(rows[0]["queues"], 2);
    assert_eq!(rows[0]["waiting_now"], 1);
    assert_eq!(rows[0]["active_now"], 1);
    assert_eq!(rows[0]["total"], 2);
    assert_eq!(rows[1]["queue"], "plain");
    assert_eq!(rows[1]["queues"], 1);
}

#[test]
fn overdue_watchdog_suspects_and_suspect_wait_claiming() {
    let b = brain("s2-suspect");
    let marked = add(&b, "work", json!({}));
    b.mark_job_watchdog_suspect(marked, MARK).unwrap();
    let spec = |wait: f64| OverdueSpec {
        queue: "default".into(),
        names: vec!["work".into()],
        mark: MARK.into(),
        wait_ms: wait,
    };
    assert!(
        !b.has_overdue_watchdog_suspect(&spec(1000.0)).unwrap(),
        "not yet"
    );
    b.clock.advance(2 * SEC);
    assert!(b.has_overdue_watchdog_suspect(&spec(1000.0)).unwrap());
    assert!(
        b.has_overdue_watchdog_suspect(&spec(2000.0)).unwrap(),
        "<= is overdue"
    );
    assert!(!b.has_overdue_watchdog_suspect(&spec(2001.0)).unwrap());
    let mut other = spec(1000.0);
    other.names = vec!["else".into()];
    assert!(!b.has_overdue_watchdog_suspect(&other).unwrap());
    other = spec(1000.0);
    other.queue = "elsewhere".into();
    assert!(!b.has_overdue_watchdog_suspect(&other).unwrap());

    // ordering: the overdue marked row leads a later, higher-priority row
    let fresh = add(&b, "work", json!({"priority": -5}));
    let lead = b
        .claim_next_job(&claim_spec(
            "c:1",
            "default",
            &["work"],
            json!({"suspectWaitMs": 1000}),
        ))
        .unwrap()
        .unwrap();
    assert_eq!(lead["id"], marked);
    // excluding suspects with an overdue row blocks the claim
    let b2 = brain("s2-suspect-block");
    let m = add(&b2, "work", json!({}));
    b2.mark_job_watchdog_suspect(m, MARK).unwrap();
    let f = add(&b2, "work", json!({}));
    b2.clock.advance(2 * SEC);
    let blocked = b2
        .claim_next_job(&claim_spec(
            "c:1",
            "default",
            &["work"],
            json!({"suspectWaitMs": 1000, "excludeWatchdogSuspects": true}),
        ))
        .unwrap();
    assert!(
        blocked.is_none(),
        "an overdue suspect blocks the co-runner claim"
    );
    // not yet overdue: the marked row is skipped, the fresh one claims
    let b3 = brain("s2-suspect-skip");
    let m = add(&b3, "work", json!({}));
    b3.mark_job_watchdog_suspect(m, MARK).unwrap();
    let f3 = add(&b3, "work", json!({}));
    let got = b3
        .claim_next_job(&claim_spec(
            "c:1",
            "default",
            &["work"],
            json!({"suspectWaitMs": 60000, "excludeWatchdogSuspects": true}),
        ))
        .unwrap()
        .unwrap();
    assert_eq!(got["id"], f3);
    let _ = (fresh, f);
    // suspect options need the mark
    let err = b3
        .claim_next_job(&claim_spec(
            "c:2",
            "default",
            &["work"],
            json!({"suspectMark": null, "suspectWaitMs": 5}),
        ))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

#[test]
fn job_page_orders_newest_first_with_a_tuple_cursor_and_filters() {
    let b = brain("s2-page");
    let mut all = Vec::new();
    for i in 0..5 {
        let q = if i % 2 == 0 { "even" } else { "odd" };
        all.push(add(&b, "work", json!({"queue": q})));
        if i != 2 {
            b.clock.advance(1);
        }
    }
    // rows 2 and 3 share a created_at: the id breaks the tie
    let spec = |v: Value| -> JobPageSpec { serde_json::from_value(v).unwrap() };
    let page = b.list_job_page(&spec(json!({"limit": 3}))).unwrap();
    let got: Vec<i64> = page.iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(got, vec![all[4], all[3], all[2]]);
    assert!(
        page[0]["created_us"]
            .as_str()
            .unwrap()
            .parse::<i64>()
            .is_ok()
    );
    let last = page.last().unwrap();
    let next = b
        .list_job_page(&spec(json!({"limit": 10,
            "cursor": {"micros": last["created_us"], "id": last["id"]}})))
        .unwrap();
    let got: Vec<i64> = next.iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(got, vec![all[1], all[0]]);
    let even = b
        .list_job_page(&spec(json!({"queue": "even", "limit": 10})))
        .unwrap();
    assert_eq!(even.len(), 3);
    assert!(
        b.list_job_page(&spec(json!({"status": "active", "limit": 10})))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        b.list_job_page(&spec(json!({"name": "work", "limit": 2})))
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn actor_matching_follows_job_actor_sql() {
    let b = brain("s2-actor");
    let auth =
        |grant: Value| json!({"version": 1, "kind": "remote", "client": "c", "grant": grant});
    let with_array = add(
        &b,
        "work",
        json!({"data": {"__owner_client_id": "c"},
               "submission_authority": auth(json!({"actor": {"system": "s", "external_id": 7, "member": null}, "actingFor": ["b", "a", "b"]}))}),
    );
    let non_array = add(
        &b,
        "work",
        json!({"data": {"__owner_client_id": "c"},
               "submission_authority": auth(json!({"actor": {"system": "s"}, "actingFor": "x"}))}),
    );
    let empty_array = add(
        &b,
        "work",
        json!({"data": {"__owner_client_id": "c"},
               "submission_authority": auth(json!({"actor": {}, "actingFor": []}))}),
    );
    let missing = add(
        &b,
        "work",
        json!({"data": {"__owner_client_id": "c"},
               "submission_authority": auth(json!({"actor": {"system": "s"}}))}),
    );
    let no_grant = add(&b, "work", json!({"data": {"__owner_client_id": "c"}}));
    let page = |actor: [&str; 4]| -> Vec<i64> {
        let mut v: Vec<i64> = b
            .list_job_page(&JobPageSpec {
                status: None,
                queue: None,
                name: None,
                owner: None,
                owner_client_id: Some("c".into()),
                owner_actor: Some(actor.map(String::from)),
                limit: 50,
                cursor: None,
            })
            .unwrap()
            .iter()
            .map(|r| r["id"].as_i64().unwrap())
            .collect();
        v.sort();
        v
    };
    assert_eq!(page(["s", "7", "", "a,b"]), vec![with_array]);
    assert_eq!(page(["s", "", "", "!"]), vec![non_array]);
    assert_eq!(page(["", "", "", ""]), vec![empty_array, no_grant]);
    assert_eq!(page(["s", "", "", ""]), vec![missing]);
}

// ------------------------------------------------------------------ NULL authority admission

#[test]
fn a_null_authority_insert_is_refused_like_the_protocol_trigger() {
    let b = brain("s2-legacy");
    for extra in [json!({"idempotency_key": "k"}), json!({})] {
        let mut fields = extra.clone();
        fields["submission_authority"] = Value::Null;
        let err = admit(&b, json!({"insert": insert("work", fields)})).unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION);
        assert!(
            err.message.starts_with("Minion queue protocol 1 required"),
            "{}",
            err.message
        );
    }
    // nothing was stored, and the key is still free for an authorized caller
    assert!(claim(&b, "w:0").is_none());
    let fresh = admit(
        &b,
        json!({"insert": insert("work", json!({"idempotency_key": "k"}))}),
    )
    .unwrap();
    assert_eq!(fresh.outcome, "inserted");
}

#[test]
fn a_private_queue_owner_must_exist() {
    let b = brain("s2-owner-fk");
    let err = admit(
        &b,
        json!({"insert": insert("work", json!({"queue": "pq", "private_queue_owner_job_id": 42}))}),
    )
    .unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
}

// ------------------------------------------------------------------ attachments

#[test]
fn attachments_are_unique_per_job_and_filename() {
    let b = brain("s2-attach");
    let id = add(&b, "work", json!({}));
    let input = |name: &str, size: i64| AttachmentInput {
        filename: name.into(),
        content_type: "text/plain".into(),
        content_b64: "aGVsbG8=".into(),
        size_bytes: size,
        sha256: "2cf24dba".into(),
    };
    assert_eq!(b.list_job_attachment_names(id).unwrap(), Some(vec![]));
    assert_eq!(b.list_job_attachment_names(99).unwrap(), None);
    let err = b.insert_job_attachment(99, &input("a", 5)).unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    let err = b.insert_job_attachment(id, &input("a", -1)).unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);

    let meta = b.insert_job_attachment(id, &input("b.txt", 5)).unwrap();
    assert_eq!(meta["filename"], "b.txt");
    assert_eq!(meta["job_id"], id);
    assert_eq!(meta["storage_uri"], Value::Null);
    assert_eq!(meta["size_bytes"], 5);
    assert_eq!(meta["created_at"], "2027-01-15T08:00:00.000000Z");
    assert!(meta.get("content_b64").is_none());
    b.insert_job_attachment(id, &input("a.txt", 5)).unwrap();
    let err = b.insert_job_attachment(id, &input("a.txt", 5)).unwrap_err();
    assert_eq!(err.code, CONSTRAINT_VIOLATION);
    assert!(err.message.contains("uniq_minion_attachments_job_filename"));
    // another job may reuse the filename
    let id2 = add(&b, "work", json!({}));
    b.insert_job_attachment(id2, &input("a.txt", 5)).unwrap();

    assert_eq!(
        b.list_job_attachment_names(id).unwrap(),
        Some(vec!["b.txt".to_string(), "a.txt".to_string()]),
        "insertion order"
    );
    let metas = b.list_job_attachments(id).unwrap();
    assert_eq!(metas.len(), 2);
    assert_eq!(metas[0]["filename"], "b.txt");
    let full = b.get_job_attachment(id, "a.txt").unwrap().unwrap();
    assert_eq!(full["content_b64"], "aGVsbG8=");
    assert!(b.get_job_attachment(id, "nope").unwrap().is_none());
    assert!(b.delete_job_attachment(id, "a.txt").unwrap());
    assert!(!b.delete_job_attachment(id, "a.txt").unwrap());
    assert!(b.get_job_attachment(id, "a.txt").unwrap().is_none());
    assert!(b.get_job_attachment(id2, "a.txt").unwrap().is_some());
    b.insert_job_attachment(id, &input("a.txt", 5)).unwrap();
}

#[test]
fn open_jobs_are_counted_per_delegated_owner_across_live_statuses() {
    let b = brain("s2-owner-count");
    let owned = |c: Value| json!({ "data": { "__owner_client_id": c } });
    let waiting = add(&b, "subagent", owned(json!("c1")));
    let paused = add(&b, "subagent", owned(json!("c1")));
    b.pause_job(paused).unwrap().unwrap();
    add(
        &b,
        "subagent",
        json!({ "queue": "other", "data": { "__owner_client_id": "c1" } }),
    );
    add(&b, "work", owned(json!("c1")));
    add(&b, "subagent", owned(json!("c2")));
    add(&b, "subagent", owned(json!(7)));
    add(&b, "subagent", owned(Value::Null));
    assert_eq!(
        b.count_open_jobs_by_owner("c1").unwrap(),
        3,
        "waiting, paused, other queue"
    );
    assert_eq!(
        b.count_open_jobs_by_owner("7").unwrap(),
        1,
        "a number owner matches its text"
    );
    assert_eq!(
        b.count_open_jobs_by_owner("null").unwrap(),
        0,
        "a null owner never matches"
    );
    assert_eq!(b.count_open_jobs_by_owner("nobody").unwrap(), 0);

    let claimed = claim_named(&b, "w:1", "subagent");
    assert_eq!(
        claimed["id"].as_i64(),
        Some(waiting),
        "the oldest waiting subagent"
    );
    assert_eq!(
        b.count_open_jobs_by_owner("c1").unwrap(),
        3,
        "active still holds a slot"
    );
    b.complete_job(waiting, "w:1", None).unwrap().unwrap();
    assert_eq!(
        b.count_open_jobs_by_owner("c1").unwrap(),
        2,
        "a completed row frees its slot"
    );
}

#[test]
fn job_source_state_reads_archived_and_the_creation_stamp() {
    let b = brain("s2-job-source");
    let created = b.get_source("default").unwrap().unwrap().created_at;
    assert_eq!(
        b.read_job_source_state("default").unwrap(),
        Some(
            json!({ "archived": false, "created_at": created.clone(), "local_path": null, "config": { "federated": true } })
        )
    );
    assert_eq!(b.read_job_source_state("nope").unwrap(), None);
    assert_eq!(b.read_job_source_state("de\0fault").unwrap(), None);
    // A generic remote job reads the registered root and config from the same row.
    b.attach_source_path("default", "/srv/brain", None, None)
        .unwrap();
    let mut patch = serde_json::Map::new();
    patch.insert("kind".into(), json!("example-connector"));
    assert!(b.update_source_config("default", &patch).unwrap());
    assert!(b.set_source_archived("default", true).unwrap());
    assert_eq!(
        b.read_job_source_state("default").unwrap(),
        Some(json!({
            "archived": true,
            "created_at": created,
            "local_path": "/srv/brain",
            "config": { "federated": true, "kind": "example-connector" },
        }))
    );
}

#[test]
fn unfinished_jobs_by_name_lists_every_live_row_of_the_names_by_id() {
    let b = brain("s2-unfinished");
    let a = add(&b, "manual", json!({}));
    let other = add(&b, "other", json!({}));
    let c = add(&b, "manual", json!({}));
    let d = add(&b, "manual", json!({}));
    add(&b, "elsewhere", json!({}));
    b.pause_job(c).unwrap().unwrap();
    b.cancel_jobs(&[d], &cancel_opts(json!({"rootStatuses": null})))
        .unwrap();
    let names = vec!["manual".to_string(), "other".to_string()];
    let got: Vec<(i64, String, String)> = b
        .list_unfinished_jobs_by_name(&names)
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["id"].as_i64().unwrap(),
                r["name"].as_str().unwrap().to_string(),
                r["status"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (a, "manual".to_string(), "waiting".to_string()),
            (other, "other".to_string(), "waiting".to_string()),
            (c, "manual".to_string(), "paused".to_string()),
        ],
        "paused is unfinished, cancelled is not, other names are left out, by id"
    );
    assert!(b.list_unfinished_jobs_by_name(&[]).unwrap().is_empty());
}
