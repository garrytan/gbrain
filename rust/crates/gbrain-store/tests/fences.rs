//! Claim epochs and protected writes (lane L5, step 3; `src/fence.rs`, `src/leases.rs`).
//!
//! Every protected entry point takes the caller's host fence. With one, the write checks the lease and the claim's
//! recorded epoch in its own transaction; with none, a plain store behaves as it always has (and writes no `~L` record) and a multi-user store takes
//! an implicit lease for a claim it takes (`tests/implicit_leases.rs`) and refuses `lease_lost` / `held_by_another` when a
//! registered holder's live lease owns the claim. The cases run through the real members: jobs (claim,
//! renew, finish, fail, release, reclaim: conformance C05), write claims (stamp, renew, release, finish, expire, the
//! publication steps: C06), effects (claim and settle: C07), the drain lease holder and the cycle lock.
//!
//! `GBRAIN_RUST_CONCURRENT_WRITES=1` runs every store on the concurrent (optimistic) record file.

use gbrain_store::env::uuid_from_bytes;
use gbrain_store::jobs::{AdmitSpec, ClaimSpec, DelayOpts, LockAcquire, LockHolder};
use gbrain_store::leases::{self, LeaseToken, lost_reason};
use gbrain_store::occ_kv::OccKv;
use gbrain_store::persistence::{
    ClaimRelease, ClaimStamp, EffectClaim, EffectSettle, ExpireClaims, InstallClaim,
    PublicationEffectsSpec, PublicationWrite, Settle, WriteCompletion, WriteRequestInsert,
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

    /// The claim-epoch records themselves, as (key, value).
    fn claim_epoch_records(&self) -> Vec<(Vec<u8>, Vec<u8>)> {
        self.lease_records()
            .into_iter()
            .filter(|(k, _)| k[keys::LEASES.len()] == 0x05)
            .collect()
    }

    /// The drain-lease claim epochs (`~L 0x05 0x04 ...`).
    fn drain_epochs(&self) -> usize {
        self.lease_records()
            .iter()
            .filter(|(k, _)| {
                k[keys::LEASES.len()] == 0x05
                    && k[keys::LEASES.len() + 1] == leases::CLAIM_DRAIN_LEASE
            })
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
fn a_job_member_without_a_fence_refuses_held_by_another_while_a_registered_holder_owns_the_claim() {
    let b = brain("job-held", true);
    let id = add_job(&b, "work");
    let fence = b.lease("jobs:a", "a");
    // With no host registered, an unfenced claim is taken (it is not refused for lacking a fence).
    let other = add_job(&b, "work");
    b.store
        .claim_next_job(&claim_spec("w:0", None))
        .unwrap()
        .unwrap();
    assert_eq!(
        job(&b, id)["status"],
        "active",
        "the oldest job was claimed"
    );
    b.store
        .claim_next_job(&claim_spec("w:1", Some(&fence)))
        .unwrap()
        .unwrap();
    let claimed = job(&b, other);
    assert_eq!(claimed["status"], "active");
    let before = b.claim_epoch_records();
    for (what, error) in [
        (
            "renew",
            b.store.renew_job_lease(other, "w:1", 30000.0).unwrap_err(),
        ),
        (
            "complete",
            b.store.complete_job(other, "w:1", None).unwrap_err(),
        ),
        (
            "fail",
            b.store
                .fail_job(other, "w:1", "x", "failed", None, None)
                .unwrap_err(),
        ),
        (
            "delay_held_claim",
            b.store.delay_held_claim(other, "w:1", 1000.0).unwrap_err(),
        ),
        (
            "release_watchdog_claim",
            b.store
                .release_watchdog_claim(other, "w:1", "x", MARK)
                .unwrap_err(),
        ),
    ] {
        assert_eq!(error.code, gbrain_store::error::LEASE_LOST, "{what}");
        refused(&error, "held_by_another");
    }
    let delay = DelayOpts {
        error_text: "x".into(),
        delay_ms: 1000.0,
        append_stack: false,
        clear_timeout: false,
        fence: None,
    };
    refused(
        &b.store.delay_active_job(other, "w:1", &delay).unwrap_err(),
        "held_by_another",
    );
    // A sweep with no fence reclaims nothing that is still live.
    b.store.reclaim_stalled_jobs(0.0, MARK).unwrap();
    assert_eq!(job(&b, other), claimed, "no refused call changed the job");
    assert_eq!(b.claim_epoch_records(), before, "the record is unchanged");
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
    // With no fence a multi-user store still takes a lock nobody holds (an implicit lease), but an unfenced holder
    // cannot refresh or release a lock a registered holder's live lease owns.
    b.store
        .acquire_cycle_lock("gbrain-sync:other", &lock_acquire(LOCK_TOKEN, None))
        .unwrap()
        .expect("a free lock is taken with no fence");
    let before = b
        .store
        .read_cycle_locks(&gbrain_store::jobs::LockFilter::All)
        .unwrap();
    refused(
        &b.store
            .refresh_cycle_lock("gbrain-sync:default", &lock_holder(LOCK_TOKEN, None))
            .unwrap_err(),
        "held_by_another",
    );
    refused(
        &b.store
            .release_cycle_lock("gbrain-sync:default", &lock_holder(LOCK_TOKEN, None))
            .unwrap_err(),
        "held_by_another",
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

const TOK_A: &str = "a0000000-0000-4000-8000-0000000000a1";
const TOK_N: &str = "a0000000-0000-4000-8000-0000000000c1";

#[test]
fn the_drain_lease_holder_writes_refreshes_and_releases_under_its_fence() {
    for multiuser in [false, true] {
        let b = brain("drain", multiuser);
        let a = b.lease("consumer:h", "a");
        if multiuser {
            // The beacon is written only by the holder of the source's cycle lock (review G5).
            b.store
                .acquire_cycle_lock("gbrain-sync:default", &lock_acquire(TOK_A, Some(&a)))
                .unwrap()
                .unwrap();
        }
        let data = json!({ "sourceId": "default", "drain_lease_beacon": { "kind": "consumer", "id": null, "version": "t" } });
        b.store
            .write_drain_lease_holder_fenced("default", TOK_A, data.clone(), 10.0, Some(&a))
            .unwrap();
        assert_eq!(b.drain_epochs(), 1);
        assert_eq!(
            b.store
                .refresh_drain_lease_holder_fenced(TOK_A, 10.0, Some(&a))
                .unwrap(),
            1
        );
        // Taken over: the old fence cannot refresh or release; a fence of another epoch cannot either.
        let new = b.take_over("consumer:h", &a);
        refused(
            &b.store
                .refresh_drain_lease_holder_fenced(TOK_A, 10.0, Some(&a))
                .unwrap_err(),
            "epoch_moved",
        );
        refused(
            &b.store
                .release_drain_lease_holder_fenced(TOK_A, Some(&a))
                .unwrap_err(),
            "epoch_moved",
        );
        refused(
            &b.store
                .refresh_drain_lease_holder_fenced(TOK_A, 10.0, Some(&new))
                .unwrap_err(),
            "claim_epoch_mismatch",
        );
        assert!(
            b.store.read_drain_lease_beacon(TOK_A).unwrap().is_some(),
            "the holder record is unchanged"
        );
        if multiuser {
            // With no fence the holder record of a registered holder's live lease is not finished by another.
            refused(
                &b.store.refresh_drain_lease_holder(TOK_A, 10.0).unwrap_err(),
                "held_by_another",
            );
            refused(
                &b.store.release_drain_lease_holder(TOK_A).unwrap_err(),
                "held_by_another",
            );
        }
        if multiuser {
            // The new holder took the source's cycle lock over (the former's row was cleared) before its beacon.
            assert!(
                b.store
                    .delete_cycle_lock("gbrain-sync:default", &lock_holder(TOK_A, Some(&new)))
                    .unwrap()
            );
            b.store
                .acquire_cycle_lock("gbrain-sync:default", &lock_acquire(TOK_N, Some(&new)))
                .unwrap()
                .unwrap();
        }
        // A new holder replaces the former one's record, and the former's epoch goes with it.
        b.store
            .write_drain_lease_holder_fenced("default", TOK_N, data, 10.0, Some(&new))
            .unwrap();
        assert_eq!(b.drain_epochs(), 1);
        assert_eq!(
            b.store
                .release_drain_lease_holder_fenced(TOK_N, Some(&new))
                .unwrap(),
            1
        );
        assert_eq!(b.drain_epochs(), 0);
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
fn a_write_claim_step_without_a_fence_refuses_held_by_another_while_a_registered_holder_owns_it() {
    let b = brain("write-held", true);
    let a = b.lease("consumer:h", "a");
    let id = admit_request(&b, REQ);
    // Nothing registered owns a queued request: an unfenced select and expiry sweep just run.
    b.store.select_claimable_write(&Default::default()).unwrap();
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, Some(&a)))
        .unwrap()
        .unwrap();
    let running = request(&b, &id);
    let records = b.claim_epoch_records();
    for error in [
        b.store
            .renew_write_claim(&stamp(&id, TOKEN, None))
            .unwrap_err(),
        b.store
            .complete_write_row(&completion(&id, None))
            .unwrap_err(),
        b.store
            .publication_journal_write(&PublicationWrite::PublicationStarted { id: id.clone() })
            .unwrap_err(),
        b.store
            .release_unpublished_claim(&ClaimRelease {
                id: id.clone(),
                token: Some(TOKEN.into()),
                reason: "x".into(),
                charge: false,
                fence: None,
            })
            .unwrap_err(),
    ] {
        refused(&error, "held_by_another");
    }
    let spec = ExpireClaims {
        host_id: HOST.into(),
        charge: false,
        dead_owners: vec![],
        fence: None,
    };
    // The sweep takes nothing that is still live.
    assert_eq!(b.store.expire_stale_write_claims(&spec).unwrap(), 0);
    assert_eq!(
        request(&b, &id),
        running,
        "no refused call changed the request"
    );
    assert_eq!(b.claim_epoch_records(), records, "the record is unchanged");
    // Once the registered holder's lease is gone, the member's own token rules decide.
    b.store.release_lease(&a).unwrap();
    assert!(b.store.renew_write_claim(&stamp(&id, TOKEN, None)).unwrap());
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
        dead_owners: vec![],
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
fn an_effect_settle_without_a_fence_refuses_held_by_another_while_a_registered_holder_owns_it() {
    let b = brain("effect-held", true);
    let a = b.lease("consumer:h", "a");
    let id = admit_request(&b, REQ);
    queue_effect(&b, &id);
    let claimed = effect_claim(&b, EFFECT_TOKEN_A, Some(&a)).unwrap().unwrap();
    let running = b.store.read_request_effects(&id).unwrap();
    let records = b.claim_epoch_records();
    for action in [Settle::Renew, Settle::Complete, Settle::Retry, Settle::Fail] {
        refused(
            &b.store
                .settle_effect(action, &settle(&claimed["id"], EFFECT_TOKEN_A, None))
                .unwrap_err(),
            "held_by_another",
        );
    }
    assert_eq!(b.store.read_request_effects(&id).unwrap(), running);
    assert_eq!(b.claim_epoch_records(), records, "the record is unchanged");
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

// ---------------------------------------------------------------------------------------------------------------
// G18: late upkeep after a finished claim.

#[test]
fn g18_a_late_renewal_or_release_after_a_completed_claim_gets_the_inactive_result() {
    let b = brain("write-late-upkeep", true);
    let a = b.lease("consumer:h", "a");
    let id = admit_request(&b, REQ);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, Some(&a)))
        .unwrap()
        .unwrap();
    b.store
        .complete_write_row(&completion(&id, Some(&a)))
        .unwrap()
        .unwrap();
    assert_eq!(b.claim_epochs(), 0);
    let done = request(&b, &id);
    let release = ClaimRelease {
        id: id.clone(),
        token: Some(TOKEN.into()),
        reason: "claim_lost".into(),
        charge: false,
        fence: Some(a.clone()),
    };
    // The same live registration, the same token, a row that finished: the answers a plain store gives.
    assert!(
        !b.store
            .renew_write_claim(&stamp(&id, TOKEN, Some(&a)))
            .expect("a late renewal is answered, not refused"),
        "the row is not running"
    );
    assert!(
        !b.store
            .release_unpublished_claim(&release)
            .expect("a late release is answered, not refused"),
        "the row is not running"
    );
    assert_eq!(request(&b, &id), done, "nothing was written");
}

#[test]
fn g18_a_renewal_or_release_under_another_live_claim_is_the_inactive_result_and_the_holder_still_holds()
 {
    let b = brain("write-other-claim", true);
    let a = b.lease("consumer:h", "a");
    let other = b.lease("consumer:o", "o");
    let id = admit_request(&b, REQ);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, Some(&a)))
        .unwrap()
        .unwrap();
    let held = request(&b, &id);
    // A caller holding a different token has no claim here: false, never an epoch refusal.
    let late = "c0000000-0000-4000-8000-0000000000c2";
    assert!(
        !b.store
            .renew_write_claim(&stamp(&id, late, Some(&other)))
            .unwrap()
    );
    let release = ClaimRelease {
        id: id.clone(),
        token: Some(late.into()),
        reason: "claim_lost".into(),
        charge: false,
        fence: Some(other.clone()),
    };
    assert!(!b.store.release_unpublished_claim(&release).unwrap());
    assert_eq!(request(&b, &id), held);
    // The real holder's epoch is still checked: another fence with its token is refused.
    refused(
        &b.store
            .renew_write_claim(&stamp(&id, TOKEN, Some(&other)))
            .unwrap_err(),
        "claim_epoch_mismatch",
    );
    assert!(
        b.store
            .renew_write_claim(&stamp(&id, TOKEN, Some(&a)))
            .unwrap()
    );
}

// ---------------------------------------------------------------------------------------------------------------
// G6: a direct stamp claims only what is claimable now.

const TOKEN_2: &str = "c0000000-0000-4000-8000-0000000000c2";
const REQ_2: &str = "b0000000-0000-4000-8000-0000000000b2";

#[test]
fn g6_a_delayed_direct_stamp_cannot_take_a_live_write_claim_or_revive_finished_work() {
    let b = brain("stamp-write-guard", true);
    let a = b.lease("consumer:h", "a");
    let other = b.lease("consumer:o", "o");
    let id = admit_request(&b, REQ);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, Some(&a)))
        .unwrap()
        .unwrap();
    let held = request(&b, &id);
    // Another live host's delayed stamp finds the claim live: nothing is claimed, nothing is written.
    assert!(
        b.store
            .stamp_write_claim(&stamp(&id, TOKEN_2, Some(&other)))
            .unwrap()
            .is_none()
    );
    assert_eq!(request(&b, &id), held, "the live claim is untouched");
    assert_eq!(b.claim_epochs(), 1, "and keeps its epoch");
    assert!(
        b.store
            .renew_write_claim(&stamp(&id, TOKEN, Some(&a)))
            .unwrap(),
        "the holder still holds"
    );
    // Finished work stays finished.
    b.store
        .complete_write_row(&completion(&id, Some(&a)))
        .unwrap()
        .unwrap();
    let done = request(&b, &id);
    assert_eq!(done["state"], "committed");
    assert!(
        b.store
            .stamp_write_claim(&stamp(&id, TOKEN_2, Some(&other)))
            .unwrap()
            .is_none()
    );
    assert_eq!(request(&b, &id), done, "a committed request is not revived");
    assert_eq!(b.claim_epochs(), 0);
}

#[test]
fn g6_a_write_claim_past_its_lease_and_a_queued_request_are_stamped() {
    let b = brain("stamp-write-lapsed", true);
    let a = b.lease("consumer:h", "a");
    let other = b.lease("consumer:o", "o");
    let id = admit_request(&b, REQ_2);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, Some(&a)))
        .unwrap()
        .unwrap();
    b.advance_ms(31_000);
    let taken = b
        .store
        .stamp_write_claim(&stamp(&id, TOKEN_2, Some(&other)))
        .unwrap()
        .expect("a lapsed claim is claimable");
    assert_eq!(taken["execution_token"], TOKEN_2);
    assert_eq!(b.claim_epochs(), 1, "the epoch moved to the new claimer");
    refused(
        &b.store
            .renew_write_claim(&stamp(&id, TOKEN_2, Some(&a)))
            .unwrap_err(),
        "claim_epoch_mismatch",
    );
}

#[test]
fn g6_with_the_mode_off_a_stamp_is_exactly_what_it_was() {
    let b = brain("stamp-write-off", false);
    let id = admit_request(&b, REQ);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, None))
        .unwrap()
        .unwrap();
    // Today's behavior, kept byte for byte: the stamp does not look at the row's state.
    let again = b
        .store
        .stamp_write_claim(&stamp(&id, TOKEN_2, None))
        .unwrap()
        .expect("a plain store stamps what it is told to");
    assert_eq!(again["execution_token"], TOKEN_2);
    b.store
        .complete_write_row(&completion(&id, None))
        .unwrap()
        .unwrap();
    let revived = b
        .store
        .stamp_write_claim(&stamp(&id, TOKEN, None))
        .unwrap()
        .expect("a plain store stamps what it is told to");
    assert_eq!(revived["state"], "running");
}

/// A direct effect stamp as a store call; `dead_owners` is the owner keys the caller proved dead.
fn direct_effect_stamp(
    b: &Brain,
    effect: &Value,
    token: &str,
    fence: Option<&LeaseToken>,
    dead_owners: &[&str],
) -> Option<Value> {
    let claim: EffectClaim = serde_json::from_value(json!({
        "id": effect["id"], "token": token,
        "ownerJson": json!({ "token": token, "owner": { "pid": 9, "nonce": "z", "start": "s" } }).to_string(),
        "fence": fence, "deadOwners": dead_owners,
    }))
    .unwrap();
    b.store.stamp_effect_claim(&claim).unwrap()
}

#[test]
fn g6_a_delayed_direct_effect_stamp_cannot_take_a_live_claim_or_revive_a_finished_effect() {
    let b = brain("stamp-effect-guard", true);
    let a = b.lease("consumer:h", "a");
    let other = b.lease("consumer:o", "o");
    let id = admit_request(&b, REQ);
    queue_effect(&b, &id);
    let claimed = effect_claim(&b, EFFECT_TOKEN_A, Some(&a)).unwrap().unwrap();
    let held = b.store.read_request_effects(&id).unwrap();
    assert!(direct_effect_stamp(&b, &claimed, EFFECT_TOKEN_B, Some(&other), &[]).is_none());
    assert_eq!(
        b.store.read_request_effects(&id).unwrap(),
        held,
        "the live claim is untouched"
    );
    assert_eq!(b.claim_epochs(), 1);
    assert!(
        b.store
            .settle_effect(
                Settle::Complete,
                &settle(&claimed["id"], EFFECT_TOKEN_A, Some(&a))
            )
            .unwrap()
    );
    let done = b.store.read_request_effects(&id).unwrap();
    assert_eq!(done[0]["state"], "committed");
    assert!(direct_effect_stamp(&b, &claimed, EFFECT_TOKEN_B, Some(&other), &[]).is_none());
    assert_eq!(
        b.store.read_request_effects(&id).unwrap(),
        done,
        "a committed effect is not revived"
    );
    assert_eq!(b.claim_epochs(), 0);
}

#[test]
fn g6_an_effect_claim_past_its_lease_or_held_by_a_dead_owner_is_stamped() {
    let b = brain("stamp-effect-lapsed", true);
    let a = b.lease("consumer:h", "a");
    let other = b.lease("consumer:o", "o");
    let id = admit_request(&b, REQ);
    queue_effect(&b, &id);
    let claimed = effect_claim(&b, EFFECT_TOKEN_A, Some(&a)).unwrap().unwrap();
    // Held by an owner the caller proved dead: claimable before its lease runs out (`effect_claim` stamps pid 7).
    assert!(direct_effect_stamp(&b, &claimed, EFFECT_TOKEN_B, Some(&other), &["8:n:s"]).is_none());
    let taken = direct_effect_stamp(&b, &claimed, EFFECT_TOKEN_B, Some(&other), &["7:n:s"])
        .expect("dead owner");
    assert_eq!(taken["execution_token"], EFFECT_TOKEN_B);
    // Past its two-minute lease: claimable.
    b.advance_ms(121_000);
    let again = direct_effect_stamp(&b, &claimed, EFFECT_TOKEN_A, Some(&a), &[]).expect("lapsed");
    assert_eq!(again["execution_token"], EFFECT_TOKEN_A);
    assert_eq!(b.claim_epochs(), 1);
}

#[test]
fn g6_with_the_mode_off_an_effect_stamp_is_exactly_what_it_was() {
    let b = brain("stamp-effect-off", false);
    let id = admit_request(&b, REQ);
    queue_effect(&b, &id);
    let claimed = effect_claim(&b, EFFECT_TOKEN_A, None).unwrap().unwrap();
    let again = direct_effect_stamp(&b, &claimed, EFFECT_TOKEN_B, None, &[])
        .expect("a plain store stamps what it is told to");
    assert_eq!(again["execution_token"], EFFECT_TOKEN_B);
}

// ---------------------------------------------------------------------------------------------------------------
// G8: a successor settles a recovered publication.

/// A recovering request claimed under `a`: publication started, recovery recorded, publication refused.
fn recovering_request(b: &Brain, a: &LeaseToken) -> String {
    let id = admit_request(b, REQ);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, Some(a)))
        .unwrap()
        .unwrap();
    let steps = [
        json!({ "kind": "publication_started", "id": id }),
        json!({ "kind": "record_recovery", "id": id, "executionToken": TOKEN, "recovery": { "files": [] },
                "bytes": 0, "keys": [], "checked": true }),
        json!({ "kind": "mark_recovering", "id": id, "executionToken": TOKEN, "reason": "publication_refused",
                "errorCode": "git_failed", "errorMessage": "refused" }),
    ];
    for step in steps {
        let step: PublicationWrite = serde_json::from_value(step).unwrap();
        b.store
            .publication_journal_write_fenced(&step, Some(a))
            .unwrap();
    }
    assert_eq!(request(b, &id)["state"], "recovering");
    id
}

/// The failure completion of recovery: `recovered` names the state and token the successor read.
fn recovered_failure(id: &str, fence: Option<&LeaseToken>, recovered: Value) -> WriteCompletion {
    let mut fields = json!({
        "id": id, "state": "failed", "outcome": {}, "errorCode": "git_failed", "errorMessage": "refused",
        "consumerVersion": "v-consumer", "consumerHostId": HOST, "errorDetail": null, "resultBytes": 100,
        "counterKeys": KEYS, "intentBytes": 10, "retainedBytes": 512, "terminalReservation": 4096,
        "probePurges": false, "fence": fence,
    });
    if !recovered.is_null() {
        fields["recovered"] = recovered;
    }
    serde_json::from_value(fields).unwrap()
}

#[test]
fn g8_a_successor_settles_the_failure_a_predecessor_recorded_and_retires_its_claim_epoch() {
    let b = brain("recovery-settle", true);
    let a = b.lease("consumer:h", "a");
    let id = recovering_request(&b, &a);
    let new = b.take_over("consumer:h", &a);
    let held = request(&b, &id);
    // Ordinary completion needs the former claim epoch: the successor cannot use it.
    refused(
        &b.store
            .complete_write_row(&recovered_failure(&id, Some(&new), Value::Null))
            .unwrap_err(),
        "claim_epoch_mismatch",
    );
    // The recovery transition names the state and token recovery found.
    let recovered = json!({ "state": "recovering", "executionToken": TOKEN });
    let done = b
        .store
        .complete_write_row(&recovered_failure(&id, Some(&new), recovered.clone()))
        .expect("the successor settles the recovery")
        .unwrap();
    assert_eq!(done["state"], "failed");
    assert_eq!(
        b.claim_epochs(),
        0,
        "the predecessor's claim epoch is retired"
    );
    assert_ne!(request(&b, &id), held);
    // The request is finished: the predecessor's late completion changes nothing and a repeat is refused too.
    refused(
        &b.store
            .complete_write_row(&recovered_failure(&id, Some(&a), recovered))
            .unwrap_err(),
        "epoch_moved",
    );
}

#[test]
fn g8_a_stale_owner_or_a_moved_recovery_cannot_use_the_recovery_transition() {
    let b = brain("recovery-settle-guards", true);
    let a = b.lease("consumer:h", "a");
    let id = recovering_request(&b, &a);
    let new = b.take_over("consumer:h", &a);
    let held = request(&b, &id);
    let recovered = json!({ "state": "recovering", "executionToken": TOKEN });
    // A stale owner (its lease was taken over) is refused by the fence, whatever it names.
    refused(
        &b.store
            .complete_write_row(&recovered_failure(&id, Some(&a), recovered.clone()))
            .unwrap_err(),
        "epoch_moved",
    );
    // No fence on a multi-user store: the settle is not refused for lacking one; it needs the recovery state the
    // caller read (checked below with the current owner's fence), so a row that moved is refused the same way.
    let moved = b
        .store
        .complete_write_row(&recovered_failure(
            &id,
            None,
            json!({ "state": "running", "executionToken": TOKEN }),
        ))
        .unwrap_err();
    assert!(moved.to_string().contains("recovery_moved"), "{moved}");
    // The current owner names a state or token the row no longer has: refused, nothing written.
    for wrong in [
        json!({ "state": "running", "executionToken": TOKEN }),
        json!({ "state": "recovering", "executionToken": TOKEN_2 }),
        json!({ "state": "recovering", "executionToken": null }),
    ] {
        let e = b
            .store
            .complete_write_row(&recovered_failure(&id, Some(&new), wrong))
            .unwrap_err();
        assert_eq!(e.code, gbrain_store::error::INVALID_STATE, "{e}");
    }
    assert_eq!(request(&b, &id), held);
    assert_eq!(b.claim_epochs(), 1);
    // A row with no recovery record is not in recovery: the transition does not apply to a live claim.
    let live = admit_request(&b, REQ_2);
    b.store
        .stamp_write_claim(&stamp(&live, TOKEN_2, Some(&new)))
        .unwrap()
        .unwrap();
    let e = b
        .store
        .complete_write_row(&recovered_failure(
            &live,
            Some(&new),
            json!({ "state": "running", "executionToken": TOKEN_2 }),
        ))
        .unwrap_err();
    assert_eq!(e.code, gbrain_store::error::INVALID_STATE, "{e}");
    assert_eq!(request(&b, &live)["state"], "running");
}

// ---------------------------------------------------------------------------------------------------------------
// The effect installs (embedding, links, facts) check the claim they run under, in the install's own transaction.

/// `lock_effect_claim_row_claimed`'s claim: the effect and the token and fence it was claimed under.
fn install_claim(effect: &Value, token: &str, fence: Option<&LeaseToken>) -> InstallClaim {
    serde_json::from_value(json!({ "effectId": effect["id"], "token": token, "fence": fence }))
        .unwrap()
}

fn effect_id(effect: &Value) -> i64 {
    effect["id"].as_str().unwrap().parse().unwrap()
}

#[test]
fn an_effect_install_reads_its_claim_under_the_host_fence_and_the_claim_epoch() {
    let b = brain("install-claim", true);
    let a = b.lease("consumer:h", "a");
    let id = admit_request(&b, REQ);
    queue_effect(&b, &id);
    let claimed = effect_claim(&b, EFFECT_TOKEN_A, Some(&a)).unwrap().unwrap();
    let row = b
        .store
        .lock_effect_claim_row_claimed(
            effect_id(&claimed),
            Some(&install_claim(&claimed, EFFECT_TOKEN_A, Some(&a))),
        )
        .unwrap();
    assert_eq!(row["state"], "running");
    assert_eq!(row["execution_token"], EFFECT_TOKEN_A);
    // No fence on a multi-user store: the host's live lease owns the claim, so the read refuses `held_by_another`.
    refused(
        &b.store
            .lock_effect_claim_row_claimed(
                effect_id(&claimed),
                Some(&install_claim(&claimed, EFFECT_TOKEN_A, None)),
            )
            .unwrap_err(),
        "held_by_another",
    );
    // The host's lease is taken over during the provider call: the old fence is refused, and so is the new host's
    // fence on a claim of the old epoch. The effect row itself is untouched.
    let new = b.take_over("consumer:h", &a);
    refused(
        &b.store
            .lock_effect_claim_row_claimed(
                effect_id(&claimed),
                Some(&install_claim(&claimed, EFFECT_TOKEN_A, Some(&a))),
            )
            .unwrap_err(),
        "epoch_moved",
    );
    refused(
        &b.store
            .lock_effect_claim_row_claimed(
                effect_id(&claimed),
                Some(&install_claim(&claimed, EFFECT_TOKEN_A, Some(&new))),
            )
            .unwrap_err(),
        "claim_epoch_mismatch",
    );
    // A claim that is no longer running under the token is the inactive answer the caller already handles.
    let other = b
        .store
        .lock_effect_claim_row_claimed(
            effect_id(&claimed),
            Some(&install_claim(&claimed, EFFECT_TOKEN_B, Some(&new))),
        )
        .unwrap();
    assert_eq!(
        other["execution_token"], EFFECT_TOKEN_A,
        "the caller compares tokens and stops"
    );
}

#[test]
fn with_the_mode_off_an_effect_install_read_ignores_the_claim() {
    let b = brain("install-claim-off", false);
    let id = admit_request(&b, REQ);
    queue_effect(&b, &id);
    let claimed = effect_claim(&b, EFFECT_TOKEN_A, None).unwrap().unwrap();
    let plain = b.store.lock_effect_claim_row(effect_id(&claimed)).unwrap();
    let with_claim = b
        .store
        .lock_effect_claim_row_claimed(
            effect_id(&claimed),
            Some(&install_claim(&claimed, EFFECT_TOKEN_B, None)),
        )
        .unwrap();
    assert_eq!(plain, with_claim);
    assert!(b.lease_records().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// The claimant's publication steps after the claim finished.

fn step(fields: Value) -> PublicationWrite {
    serde_json::from_value(fields).unwrap()
}

/// The three claimant steps, as the claimant sends them for request `id` held under `TOKEN`.
fn claimant_steps(id: &str) -> [PublicationWrite; 3] {
    [
        step(
            json!({ "kind": "record_recovery", "id": id, "executionToken": TOKEN, "recovery": { "files": [] },
                     "bytes": 0, "keys": [], "checked": true }),
        ),
        step(
            json!({ "kind": "mark_recovering", "id": id, "executionToken": TOKEN, "reason": "late",
                     "errorCode": "git_failed", "errorMessage": "refused" }),
        ),
        step(json!({ "kind": "publication_started", "id": id })),
    ]
}

#[test]
fn g18b_a_claimant_step_after_its_claim_finished_gets_the_answer_a_plain_store_gives() {
    // The answers before the lane, on a plain store with no fence.
    let plain = brain("late-step-plain", false);
    let plain_id = admit_request(&plain, REQ);
    plain
        .store
        .stamp_write_claim(&stamp(&plain_id, TOKEN, None))
        .unwrap()
        .unwrap();
    plain
        .store
        .complete_write_row(&completion(&plain_id, None))
        .unwrap()
        .unwrap();
    let expected: Vec<Value> = claimant_steps(&plain_id)
        .iter()
        .map(|s| plain.store.publication_journal_write(s).unwrap())
        .collect();
    // The same steps, from the same live host registration, after the same completion on a multi-user store.
    let b = brain("late-step", true);
    let a = b.lease("consumer:h", "a");
    let id = admit_request(&b, REQ);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, Some(&a)))
        .unwrap()
        .unwrap();
    b.store
        .complete_write_row(&completion(&id, Some(&a)))
        .unwrap()
        .unwrap();
    let got: Vec<Value> = claimant_steps(&id)
        .iter()
        .map(|s| {
            b.store
                .publication_journal_write_fenced(s, Some(&a))
                .expect("a late step is answered, not refused")
        })
        .collect();
    assert_eq!(got[0], expected[0], "record_recovery");
    assert_eq!(got[1], expected[1], "mark_recovering");
    assert_eq!(got[2]["state"], expected[2]["state"], "publication_started");
    assert_eq!(request(&b, &id)["state"], "committed");
}

#[test]
fn g18b_a_claimant_step_under_another_live_claim_is_still_refused() {
    let b = brain("late-step-other", true);
    let a = b.lease("consumer:h", "a");
    let other = b.lease("consumer:o", "o");
    let id = admit_request(&b, REQ);
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, Some(&a)))
        .unwrap()
        .unwrap();
    let held = request(&b, &id);
    // The running claim belongs to host A's epoch: another host's step is refused, whatever it names.
    for s in claimant_steps(&id) {
        refused(
            &b.store
                .publication_journal_write_fenced(&s, Some(&other))
                .unwrap_err(),
            "claim_epoch_mismatch",
        );
    }
    assert_eq!(request(&b, &id), held);
}
