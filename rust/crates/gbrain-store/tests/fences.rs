//! Claim epochs and protected writes (lane L5, step 3; `src/fence.rs`, `src/leases.rs`).
//!
//! Every protected entry point takes the caller's host fence. With one, the write checks the lease and the claim's
//! recorded epoch in its own transaction; with none, a multi-user store refuses `lease_lost` / `fence_missing` and a plain
//! store behaves as it always has (and writes no `~L` record). The cases run through the real members: jobs (claim,
//! renew, finish, fail, release, reclaim: conformance C05), write claims (stamp, renew, release, finish, expire, the
//! publication steps: C06), effects (claim and settle: C07), the drain lease holder and the cycle lock.
//!
//! `GBRAIN_RUST_CONCURRENT_WRITES=1` runs every store on the concurrent (optimistic) record file.

use gbrain_store::env::uuid_from_bytes;
use gbrain_store::jobs::{AdmitSpec, ClaimSpec, DelayOpts, LockAcquire, LockHolder};
use gbrain_store::leases::{LeaseToken, lost_reason};
use gbrain_store::occ_kv::OccKv;
use gbrain_store::persistence::{
    ClaimRelease, ClaimStamp, EffectClaim, EffectSettle, ExpireClaims, PublicationEffectsSpec,
    PublicationWrite, Settle, WriteCompletion, WriteRequestInsert,
};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::write_origin::WriteOrigin;
use gbrain_store::{Env, Kv, OpenOptions, Store, keys};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);
/// 2027-01-15T08:00:00Z.
const T0: i64 = 1_800_000_000_000_000;
const MARK: &str = "watchdog_suspect";
const HOST: &str = "d0000000-0000-4000-8000-0000000000d1";
const KEYS: [&str; 2] = ["principal:local_cli:parity-writer", "brain"];

struct Clock {
    now: AtomicI64,
    ids: AtomicU64,
}

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        uuid_from_bytes(bytes)
    }
}

/// A brain on a clock the test moves; `kv` is kept to look at the raw `~L` records.
struct Brain {
    store: Store,
    clock: Arc<Clock>,
    kv: Arc<dyn Kv>,
    dir: PathBuf,
}

impl Drop for Brain {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn brain(name: &str, multiuser: bool) -> Brain {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "fences-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let clock = Arc::new(Clock {
        now: AtomicI64::new(T0),
        ids: AtomicU64::new(1),
    });
    let kv = RedbKv::open_path(&dir.join("records.redb")).unwrap();
    let kv: Arc<dyn Kv> = if std::env::var("GBRAIN_RUST_CONCURRENT_WRITES").is_ok_and(|v| v == "1")
    {
        Arc::new(OccKv::new(kv).unwrap())
    } else {
        Arc::new(kv)
    };
    let options = OpenOptions {
        multiuser,
        ..OpenOptions::default()
    };
    let store = Store::open_kv(kv.clone(), clock.clone(), options).unwrap();
    Brain {
        store,
        clock,
        kv,
        dir,
    }
}

impl Brain {
    fn advance_ms(&self, ms: i64) {
        self.clock.now.fetch_add(ms * 1000, Ordering::SeqCst);
    }

    /// Every record under the lease family `~L`, as (key, value).
    fn lease_records(&self) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut out = Vec::new();
        let read = self.kv.snapshot().unwrap();
        gbrain_store::kv::scan_prefix(&*read, &keys::LEASES, false, &mut |k, v| {
            out.push((k.to_vec(), v.to_vec()));
            true
        })
        .unwrap();
        out
    }

    /// The claim-epoch records (`~L 0x05 ...`).
    fn claim_epochs(&self) -> usize {
        self.lease_records()
            .iter()
            .filter(|(k, _)| k[keys::LEASES.len()] == 0x05)
            .count()
    }

    fn lease(&self, name: &str, who: &str) -> LeaseToken {
        let origin = WriteOrigin {
            host_id: format!("{who}-host"),
            incarnation: format!("{who}-incarnation"),
            writer_id: "local_cli:test".into(),
        };
        self.store
            .acquire_lease(name, &origin, 3_600_000)
            .unwrap()
            .expect("the lease is free")
    }

    /// Host A's lease is taken over by host B: released, then taken again under the next epoch.
    fn take_over(&self, name: &str, old: &LeaseToken) -> LeaseToken {
        self.store.release_lease(old).unwrap();
        self.lease(name, "b")
    }
}

fn refused(error: &gbrain_store::StoreError, reason: &str) {
    assert_eq!(error.code, gbrain_store::error::LEASE_LOST, "{error}");
    assert_eq!(lost_reason(error).as_deref(), Some(reason), "{error}");
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs.

fn insert(name: &str) -> Value {
    json!({
        "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": {},
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
    })
}

fn add_job(b: &Brain, name: &str) -> i64 {
    let spec: AdmitSpec =
        serde_json::from_value(json!({ "insert": insert(name), "maxSpawnDepth": 5 })).unwrap();
    // The admit itself is not a protected entry point: it takes no fence on either store.
    b.store.admit_job(&spec).unwrap().row["id"]
        .as_i64()
        .unwrap()
}

fn claim_spec(token: &str, fence: Option<&LeaseToken>) -> ClaimSpec {
    let mut spec: ClaimSpec = serde_json::from_value(json!({
        "lockToken": token, "lockDurationMs": 30000, "queue": "default", "names": ["work"],
        "suspectMark": MARK, "handlerTimeouts": {}, "handlerLockDurations": {},
        "legacySpend": {"groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5},
    }))
    .unwrap();
    spec.fence = fence.cloned();
    spec
}

fn job(b: &Brain, id: i64) -> Value {
    b.store.get_job(id).unwrap().expect("the job exists")
}

#[test]
fn a_fenced_job_claim_finishes_under_its_fence_and_the_job_record_gains_no_field() {
    for multiuser in [false, true] {
        let b = brain("job-happy", multiuser);
        let id = add_job(&b, "work");
        let fence = b.lease("jobs:a", "a");
        let claimed = b
            .store
            .claim_next_job(&claim_spec("w:1", Some(&fence)))
            .unwrap()
            .unwrap();
        assert_eq!(claimed["id"], id);
        assert_eq!(
            b.claim_epochs(),
            1,
            "the claim records its epoch (multiuser={multiuser})"
        );
        // The record shows nothing of the epoch: its keys are the keys a claim without a fence leaves.
        let plain = brain("job-plain", false);
        add_job(&plain, "work");
        let unfenced = plain
            .store
            .claim_next_job(&claim_spec("w:1", None))
            .unwrap()
            .unwrap();
        let keys_of = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(keys_of(&claimed), keys_of(&unfenced));
        assert!(
            b.store
                .renew_job_lease_fenced(id, "w:1", 30000.0, Some(&fence))
                .unwrap()
        );
        let done = b
            .store
            .complete_job_fenced(id, "w:1", None, Some(&fence))
            .unwrap()
            .unwrap();
        assert_eq!(done["status"], "completed");
        assert_eq!(b.claim_epochs(), 0, "the epoch record goes with the claim");
    }
}

#[test]
fn a_job_claim_without_a_fence_on_a_plain_store_writes_no_lease_record() {
    let b = brain("job-plain-bytes", false);
    let id = add_job(&b, "work");
    b.store
        .claim_next_job(&claim_spec("w:1", None))
        .unwrap()
        .unwrap();
    assert!(b.store.renew_job_lease(id, "w:1", 30000.0).unwrap());
    b.store.complete_job(id, "w:1", None).unwrap().unwrap();
    assert!(
        b.lease_records().is_empty(),
        "no `~L` key is written without a fence"
    );
}

#[test]
fn a_job_member_without_a_fence_on_a_multi_user_store_refuses_before_writing() {
    let b = brain("job-omit", true);
    let id = add_job(&b, "work");
    let fence = b.lease("jobs:a", "a");
    let before = job(&b, id);
    let e = b
        .store
        .claim_next_job(&claim_spec("w:1", None))
        .unwrap_err();
    refused(&e, "fence_missing");
    assert_eq!(job(&b, id), before, "nothing was claimed");
    b.store
        .claim_next_job(&claim_spec("w:1", Some(&fence)))
        .unwrap()
        .unwrap();
    let claimed = job(&b, id);
    refused(
        &b.store.renew_job_lease(id, "w:1", 30000.0).unwrap_err(),
        "fence_missing",
    );
    refused(
        &b.store.complete_job(id, "w:1", None).unwrap_err(),
        "fence_missing",
    );
    refused(
        &b.store
            .fail_job(id, "w:1", "x", "failed", None, None)
            .unwrap_err(),
        "fence_missing",
    );
    refused(
        &b.store.reclaim_stalled_jobs(0.0, MARK).unwrap_err(),
        "fence_missing",
    );
    let delay = DelayOpts {
        error_text: "x".into(),
        delay_ms: 1000.0,
        append_stack: false,
        clear_timeout: false,
        fence: None,
    };
    refused(
        &b.store.delay_active_job(id, "w:1", &delay).unwrap_err(),
        "fence_missing",
    );
    refused(
        &b.store.delay_held_claim(id, "w:1", 1000.0).unwrap_err(),
        "fence_missing",
    );
    refused(
        &b.store
            .release_watchdog_claim(id, "w:1", "x", MARK)
            .unwrap_err(),
        "fence_missing",
    );
    assert_eq!(job(&b, id), claimed, "no refused call changed the job");
}

#[test]
fn a_job_finish_under_a_lease_that_was_taken_over_refuses_and_leaves_the_job_alone() {
    for multiuser in [false, true] {
        let b = brain("job-stale", multiuser);
        let id = add_job(&b, "work");
        let a = b.lease("jobs:h", "a");
        b.store
            .claim_next_job(&claim_spec("w:1", Some(&a)))
            .unwrap()
            .unwrap();
        let held = job(&b, id);
        // Host A pauses; its lease is taken over (epoch 2) by host B.
        let new = b.take_over("jobs:h", &a);
        assert_eq!(new.epoch, a.epoch + 1);
        refused(
            &b.store
                .complete_job_fenced(id, "w:1", None, Some(&a))
                .unwrap_err(),
            "epoch_moved",
        );
        refused(
            &b.store
                .fail_job_fenced(id, "w:1", "x", "failed", None, None, Some(&a))
                .unwrap_err(),
            "epoch_moved",
        );
        refused(
            &b.store
                .renew_job_lease_fenced(id, "w:1", 30000.0, Some(&a))
                .unwrap_err(),
            "epoch_moved",
        );
        assert_eq!(job(&b, id), held, "the job is unchanged");
        // The new holder cannot finish A's claim either: the claim was taken under epoch 1.
        refused(
            &b.store
                .complete_job_fenced(id, "w:1", None, Some(&new))
                .unwrap_err(),
            "claim_epoch_mismatch",
        );
        assert_eq!(job(&b, id), held);
        assert_eq!(b.claim_epochs(), 1);
    }
}

/// Conformance C05: an expired job claim is reclaimed once, and a renewal with the old token or the old epoch is refused.
#[test]
fn c05_an_expired_job_claim_is_reclaimed_once_and_the_old_holder_cannot_renew() {
    for multiuser in [false, true] {
        let b = brain("job-c05", multiuser);
        let id = add_job(&b, "work");
        let a = b.lease("jobs:a", "a");
        let c = b.lease("jobs:c", "c");
        b.store
            .claim_next_job(&claim_spec("a:1", Some(&a)))
            .unwrap()
            .unwrap();
        // A's job lease (30 s) runs out; the host leases (10 min) are still live.
        b.advance_ms(31_000);
        let first = b
            .store
            .reclaim_stalled_jobs_fenced(0.0, MARK, Some(&c))
            .unwrap();
        assert_eq!(first["requeued"].as_array().unwrap().len(), 1, "{first}");
        let second = b
            .store
            .reclaim_stalled_jobs_fenced(0.0, MARK, Some(&c))
            .unwrap();
        assert!(
            second["requeued"].as_array().unwrap().is_empty(),
            "reclaimed once: {second}"
        );
        assert_eq!(
            b.claim_epochs(),
            0,
            "a reclaimed claim loses its epoch record"
        );
        // C takes it over under its own epoch.
        let taken = b
            .store
            .claim_next_job(&claim_spec("c:1", Some(&c)))
            .unwrap()
            .unwrap();
        assert_eq!(taken["id"], id);
        // The old token no longer holds the job; the old epoch cannot renew, finish or fail it either.
        assert!(
            !b.store
                .renew_job_lease_fenced(id, "a:1", 30000.0, Some(&a))
                .unwrap()
        );
        assert!(
            b.store
                .complete_job_fenced(id, "a:1", None, Some(&a))
                .unwrap()
                .is_none()
        );
        // The same token under another epoch is refused (a holder that registered again keeps its lock token).
        let again = b.take_over("jobs:a", &a);
        refused(
            &b.store
                .renew_job_lease_fenced(id, "c:1", 30000.0, Some(&again))
                .unwrap_err(),
            "claim_epoch_mismatch",
        );
        assert!(
            b.store
                .renew_job_lease_fenced(id, "c:1", 30000.0, Some(&c))
                .unwrap()
        );
        assert!(
            b.store
                .complete_job_fenced(id, "c:1", None, Some(&c))
                .unwrap()
                .is_some()
        );
        assert_eq!(b.claim_epochs(), 0);
    }
}

#[test]
fn the_job_hand_backs_end_the_claim_under_its_fence_and_refuse_a_stale_one() {
    let b = brain("job-handback", true);
    let a = b.lease("jobs:h", "a");
    let id = add_job(&b, "work");
    b.store
        .claim_next_job(&claim_spec("w:1", Some(&a)))
        .unwrap()
        .unwrap();
    let delay = |fence: Option<&LeaseToken>| DelayOpts {
        error_text: "later".into(),
        delay_ms: 1000.0,
        append_stack: false,
        clear_timeout: true,
        fence: fence.cloned(),
    };
    let new = b.take_over("jobs:h", &a);
    let held = job(&b, id);
    refused(
        &b.store
            .delay_active_job(id, "w:1", &delay(Some(&a)))
            .unwrap_err(),
        "epoch_moved",
    );
    refused(
        &b.store
            .delay_held_claim_fenced(id, "w:1", 1000.0, Some(&a))
            .unwrap_err(),
        "epoch_moved",
    );
    refused(
        &b.store
            .release_watchdog_claim_fenced(id, "w:1", "x", MARK, Some(&a))
            .unwrap_err(),
        "epoch_moved",
    );
    assert_eq!(job(&b, id), held);
    // A claim taken under the new epoch ends under it.
    let id2 = add_job(&b, "work");
    b.store
        .claim_next_job(&claim_spec("w:2", Some(&new)))
        .unwrap()
        .unwrap();
    assert_eq!(b.claim_epochs(), 2);
    let back = b
        .store
        .delay_active_job(id2, "w:2", &delay(Some(&new)))
        .unwrap()
        .unwrap();
    assert_eq!(back["status"], "delayed");
    assert_eq!(b.claim_epochs(), 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Cycle lock and drain lease.

fn lock_acquire(token: &str, fence: Option<&LeaseToken>) -> LockAcquire {
    LockAcquire {
        holder_pid: 7,
        holder_host: Some("h".into()),
        acquisition_token: token.into(),
        ttl_minutes: 10.0,
        steal_grace_seconds: 0.0,
        fence: fence.cloned(),
    }
}

fn lock_holder(token: &str, fence: Option<&LeaseToken>) -> LockHolder {
    LockHolder {
        holder_pid: 7,
        acquisition_token: token.into(),
        ttl_minutes: Some(10.0),
        max_age_seconds: Some(0.0),
        fence: fence.cloned(),
    }
}

const LOCK_TOKEN: &str = "a0000000-0000-4000-8000-000000000001";

#[test]
fn the_cycle_lock_takes_refreshes_and_releases_under_its_fence() {
    for multiuser in [false, true] {
        let b = brain("lock-happy", multiuser);
        let a = b.lease("consumer:h", "a");
        let got = b
            .store
            .acquire_cycle_lock("gbrain-sync:default", &lock_acquire(LOCK_TOKEN, Some(&a)))
            .unwrap()
            .unwrap();
        assert_eq!(got["id"], "gbrain-sync:default");
        assert_eq!(b.claim_epochs(), 1);
        assert!(
            b.store
                .refresh_cycle_lock("gbrain-sync:default", &lock_holder(LOCK_TOKEN, Some(&a)))
                .unwrap()
        );
        assert!(
            b.store
                .assert_cycle_lease_fenced("gbrain-sync:default", LOCK_TOKEN, Some(&a))
                .unwrap()
        );
        assert!(
            b.store
                .release_cycle_lock("gbrain-sync:default", &lock_holder(LOCK_TOKEN, Some(&a)))
                .unwrap()
        );
        assert_eq!(b.claim_epochs(), 0);
    }
}

#[test]
fn a_cycle_lock_holder_whose_host_lease_was_taken_over_cannot_refresh_or_release_it() {
    let b = brain("lock-stale", true);
    let a = b.lease("consumer:h", "a");
    b.store
        .acquire_cycle_lock("gbrain-sync:default", &lock_acquire(LOCK_TOKEN, Some(&a)))
        .unwrap()
        .unwrap();
    let before = b
        .store
        .read_cycle_locks(&gbrain_store::jobs::LockFilter::All)
        .unwrap();
    let new = b.take_over("consumer:h", &a);
    refused(
        &b.store
            .refresh_cycle_lock("gbrain-sync:default", &lock_holder(LOCK_TOKEN, Some(&a)))
            .unwrap_err(),
        "epoch_moved",
    );
    refused(
        &b.store
            .release_cycle_lock("gbrain-sync:default", &lock_holder(LOCK_TOKEN, Some(&a)))
            .unwrap_err(),
        "epoch_moved",
    );
    refused(
        &b.store
            .delete_cycle_lock_if_stale("gbrain-sync:default", &lock_holder(LOCK_TOKEN, Some(&a)))
            .unwrap_err(),
        "epoch_moved",
    );
    refused(
        &b.store
            .assert_cycle_lease_fenced("gbrain-sync:default", LOCK_TOKEN, Some(&a))
            .unwrap_err(),
        "epoch_moved",
    );
    // The new epoch holds a lock taken under the old one only by taking it again, not by refreshing it.
    refused(
        &b.store
            .refresh_cycle_lock("gbrain-sync:default", &lock_holder(LOCK_TOKEN, Some(&new)))
            .unwrap_err(),
        "claim_epoch_mismatch",
    );
    assert_eq!(
        b.store
            .read_cycle_locks(&gbrain_store::jobs::LockFilter::All)
            .unwrap(),
        before,
        "the lock is unchanged"
    );
    // Without a fence a multi-user store refuses every cycle-lock write.
    refused(
        &b.store
            .acquire_cycle_lock("gbrain-sync:other", &lock_acquire(LOCK_TOKEN, None))
            .unwrap_err(),
        "fence_missing",
    );
    refused(
        &b.store
            .refresh_cycle_lock("gbrain-sync:default", &lock_holder(LOCK_TOKEN, None))
            .unwrap_err(),
        "fence_missing",
    );
    refused(
        &b.store
            .release_cycle_lock("gbrain-sync:default", &lock_holder(LOCK_TOKEN, None))
            .unwrap_err(),
        "fence_missing",
    );
    // An operator's stale-lock delete (`--break-lock`) runs with no fence; a live lock is not stale, so it stays.
    b.store
        .delete_cycle_lock_if_stale("gbrain-sync:default", &lock_holder(LOCK_TOKEN, None))
        .unwrap();
    assert_eq!(
        b.store
            .read_cycle_locks(&gbrain_store::jobs::LockFilter::All)
            .unwrap(),
        before
    );
}

#[test]
fn a_cycle_lock_steal_records_the_stealer_s_epoch() {
    let b = brain("lock-steal", true);
    let a = b.lease("consumer:a", "a");
    let c = b.lease("consumer:c", "c");
    b.store
        .acquire_cycle_lock("gbrain-sync:default", &lock_acquire(LOCK_TOKEN, Some(&a)))
        .unwrap()
        .unwrap();
    b.advance_ms(11 * 60_000);
    let token_c = "a0000000-0000-4000-8000-000000000002";
    b.store
        .acquire_cycle_lock("gbrain-sync:default", &lock_acquire(token_c, Some(&c)))
        .unwrap()
        .unwrap();
    assert_eq!(b.claim_epochs(), 1, "one record, now the stealer's");
    assert!(
        b.store
            .refresh_cycle_lock("gbrain-sync:default", &lock_holder(token_c, Some(&c)))
            .unwrap()
    );
    assert!(
        !b.store
            .refresh_cycle_lock("gbrain-sync:default", &lock_holder(LOCK_TOKEN, Some(&a)))
            .unwrap()
    );
}

#[test]
fn the_drain_lease_holder_writes_refreshes_and_releases_under_its_fence() {
    for multiuser in [false, true] {
        let b = brain("drain", multiuser);
        let a = b.lease("consumer:h", "a");
        let data = json!({ "sourceId": "default", "drain_lease_beacon": { "kind": "consumer", "id": null, "version": "t" } });
        b.store
            .write_drain_lease_holder_fenced("default", "tok-a", data.clone(), 10.0, Some(&a))
            .unwrap();
        assert_eq!(b.claim_epochs(), 1);
        assert_eq!(
            b.store
                .refresh_drain_lease_holder_fenced("tok-a", 10.0, Some(&a))
                .unwrap(),
            1
        );
        // Taken over: the old fence cannot refresh or release; a fence of another epoch cannot either.
        let new = b.take_over("consumer:h", &a);
        refused(
            &b.store
                .refresh_drain_lease_holder_fenced("tok-a", 10.0, Some(&a))
                .unwrap_err(),
            "epoch_moved",
        );
        refused(
            &b.store
                .release_drain_lease_holder_fenced("tok-a", Some(&a))
                .unwrap_err(),
            "epoch_moved",
        );
        refused(
            &b.store
                .refresh_drain_lease_holder_fenced("tok-a", 10.0, Some(&new))
                .unwrap_err(),
            "claim_epoch_mismatch",
        );
        assert!(
            b.store.read_drain_lease_beacon("tok-a").unwrap().is_some(),
            "the holder record is unchanged"
        );
        if multiuser {
            refused(
                &b.store
                    .write_drain_lease_holder("default", "tok-b", data.clone(), 10.0)
                    .unwrap_err(),
                "fence_missing",
            );
            refused(
                &b.store
                    .refresh_drain_lease_holder("tok-a", 10.0)
                    .unwrap_err(),
                "fence_missing",
            );
            refused(
                &b.store.release_drain_lease_holder("tok-a").unwrap_err(),
                "fence_missing",
            );
        }
        // A new holder replaces the former one's record, and the former's epoch goes with it.
        b.store
            .write_drain_lease_holder_fenced("default", "tok-n", data, 10.0, Some(&new))
            .unwrap();
        assert_eq!(b.claim_epochs(), 1);
        assert_eq!(
            b.store
                .release_drain_lease_holder_fenced("tok-n", Some(&new))
                .unwrap(),
            1
        );
        assert_eq!(b.claim_epochs(), 0);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Write claims.

fn admit_request(b: &Brain, request: &str) -> String {
    let incarnation = b.store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    let insert: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "parity-writer", "requestId": request,
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation,
        "pageId": null, "slug": "notes/a", "worktreeId": null, "topologyGeneration": null,
        "digest": "digest", "intent": {}, "authority": {}, "intentBytes": 10,
        "terminalReservation": 4096, "targetKind": "page", "protocolVersion": 1,
        "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": KEYS,
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }))
    .unwrap();
    b.store
        .lock_persistence_counters(&KEYS.map(String::from))
        .unwrap();
    b.store.insert_write_request(&insert).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

const REQ: &str = "b0000000-0000-4000-8000-0000000000b1";
const TOKEN: &str = "c0000000-0000-4000-8000-0000000000c1";

fn stamp(id: &str, token: &str, fence: Option<&LeaseToken>) -> ClaimStamp {
    ClaimStamp {
        id: id.into(),
        token: token.into(),
        lease_ms: 30_000.0,
        phase_json: None,
        fence: fence.cloned(),
    }
}

fn completion(id: &str, fence: Option<&LeaseToken>) -> WriteCompletion {
    let mut c: WriteCompletion = serde_json::from_value(json!({
        "id": id, "state": "committed", "outcome": {"slug": "notes/a"}, "errorCode": null, "errorMessage": null,
        "consumerVersion": "v-consumer", "consumerHostId": HOST, "errorDetail": null, "resultBytes": 100,
        "counterKeys": KEYS, "intentBytes": 10, "retainedBytes": 512, "terminalReservation": 4096, "probePurges": false,
    }))
    .unwrap();
    c.fence = fence.cloned();
    c
}

fn request(b: &Brain, id: &str) -> Value {
    b.store
        .read_write_request_by_id(id)
        .unwrap()
        .expect("the request exists")
}

#[test]
fn a_write_claim_is_stamped_renewed_and_finished_under_its_fence() {
    for multiuser in [false, true] {
        let b = brain("write-happy", multiuser);
        let a = b.lease("consumer:h", "a");
        let id = admit_request(&b, REQ);
        assert!(
            b.store
                .stamp_write_claim(&stamp(&id, TOKEN, Some(&a)))
                .unwrap()
                .is_some()
        );
        assert_eq!(b.claim_epochs(), 1);
        assert!(
            b.store
                .renew_write_claim(&stamp(&id, TOKEN, Some(&a)))
                .unwrap()
        );
        let done = b
            .store
            .complete_write_row(&completion(&id, Some(&a)))
            .unwrap()
            .unwrap();
        assert_eq!(done["state"], "committed");
        assert_eq!(b.claim_epochs(), 0);
    }
}

#[test]
fn a_released_write_claim_loses_its_epoch_and_can_be_claimed_again_under_another() {
    let b = brain("write-release", true);
    let a = b.lease("consumer:h", "a");
    let id = admit_request(&b, REQ);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, Some(&a)))
        .unwrap()
        .unwrap();
    let release = |fence: Option<&LeaseToken>| ClaimRelease {
        id: id.clone(),
        token: Some(TOKEN.into()),
        reason: "claim_lost".into(),
        charge: false,
        fence: fence.cloned(),
    };
    assert!(
        b.store
            .release_unpublished_claim(&release(Some(&a)))
            .unwrap()
    );
    assert_eq!(b.claim_epochs(), 0);
    assert_eq!(request(&b, &id)["state"], "queued");
    let new = b.take_over("consumer:h", &a);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, Some(&new)))
        .unwrap()
        .unwrap();
    // The old holder, back from a pause, can neither renew, release nor finish the claim of the new epoch.
    let held = request(&b, &id);
    refused(
        &b.store
            .renew_write_claim(&stamp(&id, TOKEN, Some(&a)))
            .unwrap_err(),
        "epoch_moved",
    );
    refused(
        &b.store
            .release_unpublished_claim(&release(Some(&a)))
            .unwrap_err(),
        "epoch_moved",
    );
    refused(
        &b.store
            .complete_write_row(&completion(&id, Some(&a)))
            .unwrap_err(),
        "epoch_moved",
    );
    assert_eq!(request(&b, &id), held);
}

/// Conformance C06: a paused holder's protected data write is refused after takeover, through the real member.
#[test]
fn c06_a_paused_claimant_cannot_publish_after_its_host_lease_was_taken_over() {
    for multiuser in [false, true] {
        let b = brain("write-c06", multiuser);
        let a = b.lease("consumer:h", "a");
        let id = admit_request(&b, REQ);
        b.store
            .stamp_write_claim(&stamp(&id, TOKEN, Some(&a)))
            .unwrap()
            .unwrap();
        // The last renewal passed; the claimant pauses; its host lease is taken over.
        assert!(
            b.store
                .renew_write_claim(&stamp(&id, TOKEN, Some(&a)))
                .unwrap()
        );
        let new = b.take_over("consumer:h", &a);
        let held = request(&b, &id);
        let started = PublicationWrite::PublicationStarted { id: id.clone() };
        refused(
            &b.store
                .publication_journal_write_fenced(&started, Some(&a))
                .unwrap_err(),
            "epoch_moved",
        );
        refused(
            &b.store
                .complete_write_row(&completion(&id, Some(&a)))
                .unwrap_err(),
            "epoch_moved",
        );
        assert_eq!(
            request(&b, &id),
            held,
            "no protected data and no terminal result committed"
        );
        // The new host's fence cannot finish a claim of the old epoch either; the claim expires and is claimed again.
        refused(
            &b.store
                .complete_write_row(&completion(&id, Some(&new)))
                .unwrap_err(),
            "claim_epoch_mismatch",
        );
        b.advance_ms(31_000);
        let spec = ExpireClaims {
            host_id: HOST.into(),
            charge: false,
            dead_owners: vec![],
            fence: Some(new.clone()),
        };
        assert_eq!(b.store.expire_stale_write_claims(&spec).unwrap(), 1);
        assert_eq!(b.claim_epochs(), 0);
        b.store
            .stamp_write_claim(&stamp(&id, TOKEN, Some(&new)))
            .unwrap()
            .unwrap();
        b.store
            .publication_journal_write_fenced(&started, Some(&new))
            .unwrap();
        assert!(
            b.store
                .complete_write_row(&completion(&id, Some(&new)))
                .unwrap()
                .is_some()
        );
    }
}

#[test]
fn a_write_claim_step_without_a_fence_on_a_multi_user_store_refuses_before_writing() {
    let b = brain("write-omit", true);
    let a = b.lease("consumer:h", "a");
    let id = admit_request(&b, REQ);
    let queued = request(&b, &id);
    refused(
        &b.store
            .stamp_write_claim(&stamp(&id, TOKEN, None))
            .unwrap_err(),
        "fence_missing",
    );
    refused(
        &b.store
            .select_claimable_write(&Default::default())
            .unwrap_err(),
        "fence_missing",
    );
    assert_eq!(request(&b, &id), queued);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, Some(&a)))
        .unwrap()
        .unwrap();
    let running = request(&b, &id);
    refused(
        &b.store
            .renew_write_claim(&stamp(&id, TOKEN, None))
            .unwrap_err(),
        "fence_missing",
    );
    refused(
        &b.store
            .complete_write_row(&completion(&id, None))
            .unwrap_err(),
        "fence_missing",
    );
    refused(
        &b.store
            .publication_journal_write(&PublicationWrite::PublicationStarted { id: id.clone() })
            .unwrap_err(),
        "fence_missing",
    );
    let spec = ExpireClaims {
        host_id: HOST.into(),
        charge: false,
        dead_owners: vec![],
        fence: None,
    };
    refused(
        &b.store.expire_stale_write_claims(&spec).unwrap_err(),
        "fence_missing",
    );
    assert_eq!(request(&b, &id), running);
}

#[test]
fn a_write_claim_on_a_plain_store_without_a_fence_writes_no_lease_record() {
    let b = brain("write-plain", false);
    let id = admit_request(&b, REQ);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, None))
        .unwrap()
        .unwrap();
    assert!(b.store.renew_write_claim(&stamp(&id, TOKEN, None)).unwrap());
    b.store
        .complete_write_row(&completion(&id, None))
        .unwrap()
        .unwrap();
    assert!(b.lease_records().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// Effects.

const REVISION: &str = "e0000000-0000-4000-8000-0000000000e1";
const EFFECT_TOKEN_A: &str = "f0000000-0000-4000-8000-000000000001";
const EFFECT_TOKEN_B: &str = "f0000000-0000-4000-8000-000000000002";

fn queue_effect(b: &Brain, request: &str) {
    let incarnation = b.store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    let spec: PublicationEffectsSpec = serde_json::from_value(json!({
        "requestId": request, "revision": REVISION, "sourceId": "default", "sourceIncarnation": incarnation,
        "worktreeId": null, "effects": [{ "kind": "embedding", "data": { "slug": "notes/a", "page_id": 1 } }],
    }))
    .unwrap();
    b.store.insert_publication_effects(&spec).unwrap();
}

fn effect_claim(
    b: &Brain,
    token: &str,
    fence: Option<&LeaseToken>,
) -> Result<Option<Value>, gbrain_store::StoreError> {
    let candidate = b.store.select_claimable_effect(HOST, &[]).unwrap();
    if candidate.is_null() {
        return Ok(None);
    }
    let owner = json!({ "token": token, "owner": { "pid": 7, "nonce": "n", "start": "s" } });
    b.store.stamp_effect_claim(&EffectClaim {
        id: candidate["id"].as_str().unwrap().into(),
        token: token.into(),
        owner_json: owner.to_string(),
        fence: fence.cloned(),
    })
}

fn settle(id: &Value, token: &str, fence: Option<&LeaseToken>) -> EffectSettle {
    EffectSettle {
        id: id.as_str().unwrap().into(),
        token: Some(token.into()),
        slug: None,
        outcome_json: Some("{}".into()),
        data_json: None,
        reason: Some("x".into()),
        delay_ms: Some(0.0),
        fence: fence.cloned(),
    }
}

/// Conformance C07: an effect is claimed once; after its owner's lease is lost a rerun by the new owner works and
/// leaves no second row.
#[test]
fn c07_an_effect_is_claimed_once_and_a_rerun_by_the_new_owner_leaves_one_row() {
    for multiuser in [false, true] {
        let b = brain("effect-c07", multiuser);
        let a = b.lease("consumer:h", "a");
        let id = admit_request(&b, REQ);
        queue_effect(&b, &id);
        let claimed = effect_claim(&b, EFFECT_TOKEN_A, Some(&a))
            .unwrap()
            .expect("claimed");
        assert_eq!(claimed["state"], "running");
        assert_eq!(b.claim_epochs(), 1);
        assert!(
            effect_claim(&b, EFFECT_TOKEN_B, Some(&a))
                .unwrap()
                .is_none(),
            "a running effect is claimed once"
        );
        assert!(
            b.store
                .settle_effect(
                    Settle::Renew,
                    &settle(&claimed["id"], EFFECT_TOKEN_A, Some(&a))
                )
                .unwrap()
        );
        // The owner pauses past its claim lease; its host lease is taken over.
        let new = b.take_over("consumer:h", &a);
        b.advance_ms(121_000);
        let held = b.store.read_request_effects(&id).unwrap();
        refused(
            &b.store
                .settle_effect(
                    Settle::Complete,
                    &settle(&claimed["id"], EFFECT_TOKEN_A, Some(&a)),
                )
                .unwrap_err(),
            "epoch_moved",
        );
        assert_eq!(
            b.store.read_request_effects(&id).unwrap(),
            held,
            "the stale owner's result recorded nothing"
        );
        // The new owner claims it again under its own epoch and finishes it.
        let again = effect_claim(&b, EFFECT_TOKEN_B, Some(&new))
            .unwrap()
            .expect("claimed again");
        assert_eq!(again["id"], claimed["id"]);
        assert_eq!(b.claim_epochs(), 1);
        refused(
            &b.store
                .settle_effect(
                    Settle::Complete,
                    &settle(&claimed["id"], EFFECT_TOKEN_B, Some(&a)),
                )
                .unwrap_err(),
            "epoch_moved",
        );
        assert!(
            b.store
                .settle_effect(
                    Settle::Complete,
                    &settle(&claimed["id"], EFFECT_TOKEN_B, Some(&new))
                )
                .unwrap()
        );
        assert_eq!(b.claim_epochs(), 0);
        let rows = b.store.read_request_effects(&id).unwrap();
        assert_eq!(rows.len(), 1, "no duplicate row");
        assert_eq!(rows[0]["state"], "committed");
    }
}

#[test]
fn an_effect_claim_or_settle_without_a_fence_on_a_multi_user_store_refuses_before_writing() {
    let b = brain("effect-omit", true);
    let a = b.lease("consumer:h", "a");
    let id = admit_request(&b, REQ);
    queue_effect(&b, &id);
    let queued = b.store.read_request_effects(&id).unwrap();
    refused(
        &effect_claim(&b, EFFECT_TOKEN_A, None).unwrap_err(),
        "fence_missing",
    );
    assert_eq!(b.store.read_request_effects(&id).unwrap(), queued);
    let claimed = effect_claim(&b, EFFECT_TOKEN_A, Some(&a)).unwrap().unwrap();
    let running = b.store.read_request_effects(&id).unwrap();
    for action in [Settle::Renew, Settle::Complete, Settle::Retry, Settle::Fail] {
        refused(
            &b.store
                .settle_effect(action, &settle(&claimed["id"], EFFECT_TOKEN_A, None))
                .unwrap_err(),
            "fence_missing",
        );
    }
    assert_eq!(b.store.read_request_effects(&id).unwrap(), running);
}

#[test]
fn an_effect_on_a_plain_store_without_a_fence_writes_no_lease_record() {
    let b = brain("effect-plain", false);
    let id = admit_request(&b, REQ);
    queue_effect(&b, &id);
    let claimed = effect_claim(&b, EFFECT_TOKEN_A, None).unwrap().unwrap();
    assert!(
        b.store
            .settle_effect(
                Settle::Complete,
                &settle(&claimed["id"], EFFECT_TOKEN_A, None)
            )
            .unwrap()
    );
    assert!(b.lease_records().is_empty());
}
