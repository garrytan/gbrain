//! The job, cycle-lock and drain-lease findings of the second-model review of lane L5 (G1, G3, G4, G5, G7): a job's
//! progress, token and inbox writes carry the host fence; a cycle lock's holder release needs the claim's epoch (the
//! operator's snapshot delete does not); the page-embedding lease members and the cycle-lock members never act on each
//! other's rows; the drain beacon is written only by the holder of the source's cycle lock; the timeout sweeps carry the
//! fence and end each job's claim epoch with it. Every case also checks that a plain store (the switch off) behaves as
//! it always did.
//!
//! `GBRAIN_RUST_CONCURRENT_WRITES=1` runs every store on the concurrent (optimistic) record file.

use gbrain_store::env::uuid_from_bytes;
use gbrain_store::jobs::{
    AdmitSpec, ClaimSpec, LockAcquire, LockFilter, LockHolder, PageLeaseHolder, PageLeaseTake,
};
use gbrain_store::leases::{LeaseToken, lost_reason};
use gbrain_store::occ_kv::OccKv;
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
        "fences-jobs-{name}-{}-{}",
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

impl Brain {
    /// Every record of the brain, as (key, value): a refused write leaves this unchanged.
    fn dump(&self) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut out = Vec::new();
        let read = self.kv.snapshot().unwrap();
        gbrain_store::kv::scan_prefix(&*read, &[], false, &mut |k, v| {
            out.push((k.to_vec(), v.to_vec()));
            true
        })
        .unwrap();
        out
    }
}

const LOCK_ID: &str = "gbrain-sync:default";
const T1: &str = "a0000000-0000-4000-8000-000000000001";
const T2: &str = "a0000000-0000-4000-8000-000000000002";

fn insert(name: &str, timeout_ms: Option<i64>) -> Value {
    json!({
        "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": {},
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
        "timeout_ms": timeout_ms,
    })
}

fn add_job(b: &Brain, name: &str, timeout_ms: Option<i64>) -> i64 {
    let spec: AdmitSpec =
        serde_json::from_value(json!({ "insert": insert(name, timeout_ms), "maxSpawnDepth": 5 }))
            .unwrap();
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

// ---------------------------------------------------------------------------------------------------------------
// G1: progress, token accounting and inbox reads on an active job carry the host fence.

#[test]
fn g1_job_progress_tokens_and_inbox_reads_carry_the_host_fence() {
    let b = brain("g1", true);
    let a = b.lease("jobs:h", "a");
    let id = add_job(&b, "work", None);
    b.store
        .claim_next_job(&claim_spec("w:1", Some(&a)))
        .unwrap()
        .unwrap();
    let tokens = gbrain_store::jobs::TokenDelta {
        input: 5,
        output: 2,
        cache_read: 1,
    };
    // Under the claim's own fence every write lands.
    assert!(
        b.store
            .update_job_progress_fenced(id, "w:1", &json!({"n": 1}), Some(&a))
            .unwrap()
    );
    assert!(
        b.store
            .add_job_tokens_fenced(id, "w:1", &tokens, Some(&a))
            .unwrap()
    );
    b.store
        .post_inbox_message(id, "admin", &json!({"type": "note", "n": 1}))
        .unwrap();
    assert_eq!(
        b.store
            .read_job_inbox_fenced(id, "w:1", Some(&a))
            .unwrap()
            .len(),
        1
    );
    b.store
        .post_inbox_message(id, "admin", &json!({"type": "note", "n": 2}))
        .unwrap();
    // No fence on a multi-user store, while the host's live lease owns the claim: refused, nothing written.
    let before = b.dump();
    refused(
        &b.store
            .update_job_progress_fenced(id, "w:1", &json!({"n": 2}), None)
            .unwrap_err(),
        "held_by_another",
    );
    refused(
        &b.store
            .add_job_tokens_fenced(id, "w:1", &tokens, None)
            .unwrap_err(),
        "held_by_another",
    );
    refused(
        &b.store.read_job_inbox_fenced(id, "w:1", None).unwrap_err(),
        "held_by_another",
    );
    assert_eq!(
        b.dump(),
        before,
        "a refused write leaves the brain as it was"
    );
    // The host's lease is taken over: the old fence is refused, and the new holder's fence cannot write on a claim
    // taken under the old epoch.
    let new = b.take_over("jobs:h", &a);
    for fence in [&a, &new] {
        let reason = if fence == &a {
            "epoch_moved"
        } else {
            "claim_epoch_mismatch"
        };
        refused(
            &b.store
                .update_job_progress_fenced(id, "w:1", &json!({"n": 3}), Some(fence))
                .unwrap_err(),
            reason,
        );
        refused(
            &b.store
                .add_job_tokens_fenced(id, "w:1", &tokens, Some(fence))
                .unwrap_err(),
            reason,
        );
        refused(
            &b.store
                .read_job_inbox_fenced(id, "w:1", Some(fence))
                .unwrap_err(),
            reason,
        );
    }
    // The takeover itself wrote the lease record; nothing else changed.
    let after: Vec<_> = b.dump();
    assert_eq!(
        after
            .iter()
            .filter(|(k, _)| !k.starts_with(&keys::LEASES))
            .collect::<Vec<_>>(),
        before
            .iter()
            .filter(|(k, _)| !k.starts_with(&keys::LEASES))
            .collect::<Vec<_>>(),
        "no job, inbox or token record changed"
    );
    // A token that is not the job's lock is a quiet no-op under any live fence, as it always was.
    assert!(
        !b.store
            .update_job_progress_fenced(id, "w:other", &json!({}), Some(&new))
            .unwrap()
    );
}

#[test]
fn g1_on_a_plain_store_the_job_writes_are_what_they_always_were() {
    let b = brain("g1-plain", false);
    let id = add_job(&b, "work", None);
    b.store
        .claim_next_job(&claim_spec("w:1", None))
        .unwrap()
        .unwrap();
    assert!(
        b.store
            .update_job_progress(id, "w:1", &json!({"n": 1}))
            .unwrap()
    );
    assert!(
        b.store
            .add_job_tokens(
                id,
                "w:1",
                &gbrain_store::jobs::TokenDelta {
                    input: 1,
                    output: 0,
                    cache_read: 0
                }
            )
            .unwrap()
    );
    b.store
        .post_inbox_message(id, "admin", &json!({"type": "note"}))
        .unwrap();
    assert_eq!(b.store.read_job_inbox(id, "w:1").unwrap().len(), 1);
    assert_eq!(b.claim_epochs(), 0);
    assert!(
        b.lease_records().is_empty(),
        "no ~L record on a plain store with no fence"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// G3: a holder's release of a cycle lock needs the claim's epoch; the operator's snapshot delete does not.

#[test]
fn g3_a_cycle_lock_release_needs_the_claim_epoch_but_the_operator_delete_does_not() {
    let b = brain("g3", true);
    let a = b.lease("consumer:h", "a");
    b.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(T1, Some(&a)))
        .unwrap()
        .unwrap();
    // The host registers again under a new epoch: the lock was taken under the old one.
    let new = b.take_over("consumer:h", &a);
    let before = b.dump();
    refused(
        &b.store
            .release_cycle_lock(LOCK_ID, &lock_holder(T1, Some(&new)))
            .unwrap_err(),
        "claim_epoch_mismatch",
    );
    assert_eq!(b.dump(), before, "the lock and its epoch are as they were");
    // The operator's snapshot delete (a reaper clearing a dead holder's row) is not a holder's release.
    assert!(
        b.store
            .delete_cycle_lock(LOCK_ID, &lock_holder(T1, Some(&new)))
            .unwrap()
    );
    assert_eq!(b.claim_epochs(), 0);
    assert!(
        b.store
            .read_cycle_locks(&LockFilter::All)
            .unwrap()
            .is_empty()
    );
    // A holder whose claim epoch is its own releases normally.
    b.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(T2, Some(&new)))
        .unwrap()
        .unwrap();
    assert!(
        b.store
            .release_cycle_lock(LOCK_ID, &lock_holder(T2, Some(&new)))
            .unwrap()
    );
    assert_eq!(b.claim_epochs(), 0);
    // Without a fence, a multi-user store refuses an unfenced holder's release of a lock a registered holder's live
    // lease owns; the operator's snapshot delete needs no claim epoch, and the stale delete stays allowed.
    b.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(T1, Some(&new)))
        .unwrap()
        .unwrap();
    refused(
        &b.store
            .release_cycle_lock(LOCK_ID, &lock_holder(T1, None))
            .unwrap_err(),
        "held_by_another",
    );
    b.store
        .delete_cycle_lock_if_stale(LOCK_ID, &lock_holder(T1, None))
        .unwrap();
    assert_eq!(b.claim_epochs(), 1, "a live lock is not stale");
    assert!(
        b.store
            .delete_cycle_lock(LOCK_ID, &lock_holder(T1, None))
            .unwrap()
    );
    assert_eq!(b.claim_epochs(), 0);
}

#[test]
fn g3_on_a_plain_store_release_and_delete_are_one_statement_as_before() {
    let b = brain("g3-plain", false);
    b.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(T1, None))
        .unwrap()
        .unwrap();
    assert!(
        b.store
            .release_cycle_lock(LOCK_ID, &lock_holder(T1, None))
            .unwrap()
    );
    b.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(T1, None))
        .unwrap()
        .unwrap();
    assert!(
        b.store
            .delete_cycle_lock(LOCK_ID, &lock_holder(T1, None))
            .unwrap()
    );
    assert!(b.lease_records().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// G4: the two lock families never act on each other's rows (multi-user).

fn page_take(token: &str) -> PageLeaseTake {
    PageLeaseTake {
        holder_pid: 7,
        holder_host: "h".into(),
        acquisition_token: token.into(),
        ttl_minutes: 10.0,
    }
}

fn page_holder(token: &str) -> PageLeaseHolder {
    PageLeaseHolder {
        acquisition_token: token.into(),
        ttl_minutes: Some(10.0),
    }
}

#[test]
fn g4_page_embedding_members_never_act_on_a_cycle_lock_row() {
    let b = brain("g4-embed", true);
    let a = b.lease("consumer:h", "a");
    b.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(T1, Some(&a)))
        .unwrap()
        .unwrap();
    let before = b.dump();
    // Renew and release by the cycle lock's own token: refused as no lease of that family.
    assert!(
        !b.store
            .renew_page_embedding_lease(LOCK_ID, &page_holder(T1))
            .unwrap()
    );
    b.store
        .release_page_embedding_lease(LOCK_ID, &page_holder(T1))
        .unwrap();
    assert_eq!(
        b.dump(),
        before,
        "the cycle lock and its epoch are untouched"
    );
    // Even once the lock expired, an embedding take does not overwrite it.
    b.advance_ms(11 * 60_000);
    let expired = b.dump();
    assert!(
        b.store
            .take_page_embedding_lease(LOCK_ID, &page_take(T2))
            .is_err()
    );
    assert_eq!(b.dump(), expired);
    // An embedding lease works on its own namespace.
    assert!(
        b.store
            .take_page_embedding_lease("embed-page:7", &page_take(T2))
            .unwrap()
    );
    assert!(
        b.store
            .renew_page_embedding_lease("embed-page:7", &page_holder(T2))
            .unwrap()
    );
    b.store
        .release_page_embedding_lease("embed-page:7", &page_holder(T2))
        .unwrap();
}

#[test]
fn g4_cycle_lock_members_never_act_on_a_page_embedding_lease_row() {
    let b = brain("g4-cycle", true);
    let a = b.lease("consumer:h", "a");
    assert!(
        b.store
            .take_page_embedding_lease("embed-page:7", &page_take(T1))
            .unwrap()
    );
    let before = b.dump();
    assert!(
        b.store
            .acquire_cycle_lock("embed-page:7", &lock_acquire(T2, Some(&a)))
            .is_err()
    );
    let holder = lock_holder(T1, Some(&a));
    assert!(!b.store.refresh_cycle_lock("embed-page:7", &holder).unwrap());
    assert!(!b.store.release_cycle_lock("embed-page:7", &holder).unwrap());
    assert!(!b.store.delete_cycle_lock("embed-page:7", &holder).unwrap());
    assert!(
        !b.store
            .delete_cycle_lock_if_stale("embed-page:7", &holder)
            .unwrap()["deleted"]
            .as_bool()
            .unwrap()
    );
    assert!(
        !b.store
            .assert_cycle_lease_fenced("embed-page:7", T1, Some(&a))
            .unwrap()
    );
    assert_eq!(b.dump(), before, "the embedding lease is untouched");
}

#[test]
fn g4_on_a_plain_store_the_two_families_behave_as_before() {
    let b = brain("g4-plain", false);
    b.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(T1, None))
        .unwrap()
        .unwrap();
    assert!(
        b.store
            .renew_page_embedding_lease(LOCK_ID, &page_holder(T1))
            .unwrap()
    );
    b.store
        .release_page_embedding_lease(LOCK_ID, &page_holder(T1))
        .unwrap();
    assert!(
        b.store
            .read_cycle_locks(&LockFilter::All)
            .unwrap()
            .is_empty()
    );
}

// ---------------------------------------------------------------------------------------------------------------
// G5: the drain beacon is written only while the caller's cycle lock for the source is held by its token and epoch.

fn beacon() -> Value {
    json!({ "sourceId": "default", "drain_lease_beacon": { "kind": "consumer", "id": null, "version": "t" } })
}

#[test]
fn g5_a_delayed_drain_beacon_write_cannot_replace_the_successors_beacon() {
    let b = brain("g5", true);
    let a = b.lease("consumer:a", "a");
    let c = b.lease("consumer:c", "c");
    b.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(T1, Some(&a)))
        .unwrap()
        .unwrap();
    // The holder's cycle lock lapses before it writes its beacon; the successor takes the lock and writes its own.
    b.advance_ms(11 * 60_000);
    b.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(T2, Some(&c)))
        .unwrap()
        .unwrap();
    b.store
        .write_drain_lease_holder_fenced("default", T2, beacon(), 10.0, Some(&c))
        .unwrap();
    let before = b.dump();
    // The delayed write: host a's own lease is live, but its cycle lock is gone.
    assert!(
        b.store
            .write_drain_lease_holder_fenced("default", T1, beacon(), 10.0, Some(&a))
            .is_err()
    );
    assert_eq!(b.dump(), before, "the successor's beacon and epoch stand");
    assert!(b.store.read_drain_lease_beacon(T2).unwrap().is_some());
    // The right token under another epoch of the host is refused too.
    let b2 = brain("g5-epoch", true);
    let a = b2.lease("consumer:h", "a");
    b2.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(T1, Some(&a)))
        .unwrap()
        .unwrap();
    let new = b2.take_over("consumer:h", &a);
    refused(
        &b2.store
            .write_drain_lease_holder_fenced("default", T1, beacon(), 10.0, Some(&new))
            .unwrap_err(),
        "claim_epoch_mismatch",
    );
    assert!(b2.store.read_drain_lease_beacon(T1).unwrap().is_none());
    // The holder that still holds its lock under its epoch writes it.
    let b3 = brain("g5-ok", true);
    let a = b3.lease("consumer:h", "a");
    b3.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(T1, Some(&a)))
        .unwrap()
        .unwrap();
    b3.store
        .write_drain_lease_holder_fenced("default", T1, beacon(), 10.0, Some(&a))
        .unwrap();
    assert!(b3.store.read_drain_lease_beacon(T1).unwrap().is_some());
}

#[test]
fn g5_on_a_plain_store_the_beacon_needs_no_cycle_lock() {
    let b = brain("g5-plain", false);
    b.store
        .write_drain_lease_holder("default", "tok-a", beacon(), 10.0)
        .unwrap();
    assert!(b.store.read_drain_lease_beacon("tok-a").unwrap().is_some());
    assert!(b.lease_records().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// G7: the worker's timeout sweeps carry the fence and end each job's claim epoch with the job.

#[test]
fn g7_timeout_sweeps_carry_the_fence_and_clear_the_claim_epoch() {
    let b = brain("g7", true);
    let a = b.lease("jobs:a", "a");
    let id = add_job(&b, "work", Some(1000));
    b.store
        .claim_next_job(&claim_spec("w:1", Some(&a)))
        .unwrap()
        .unwrap();
    b.advance_ms(2000);
    let before = b.dump();
    // The sweeping worker lost its own lease: it ends no job.
    let old = b.lease("jobs:sweeper", "s");
    let sweeper = b.take_over("jobs:sweeper", &old);
    refused(
        &b.store.kill_timed_out_jobs_fenced(Some(&old)).unwrap_err(),
        "epoch_moved",
    );
    assert_eq!(
        b.dump()
            .iter()
            .filter(|(k, _)| !k.starts_with(&keys::LEASES))
            .count(),
        before
            .iter()
            .filter(|(k, _)| !k.starts_with(&keys::LEASES))
            .count()
    );
    assert_eq!(b.store.get_job(id).unwrap().unwrap()["status"], "active");
    assert_eq!(b.claim_epochs(), 1);
    // A live sweeper ends the job, and the claim's epoch goes with it, in the same write.
    let dead = b.store.kill_timed_out_jobs_fenced(Some(&sweeper)).unwrap();
    assert_eq!(dead.len(), 1);
    assert_eq!(b.store.get_job(id).unwrap().unwrap()["status"], "dead");
    assert_eq!(b.claim_epochs(), 0, "the dead job's claim epoch is cleared");
}

#[test]
fn g7_wall_clock_sweep_carries_the_fence_and_clears_the_claim_epoch() {
    let b = brain("g7-wall", true);
    let a = b.lease("jobs:a", "a");
    add_job(&b, "work", None);
    b.store
        .claim_next_job(&claim_spec("w:1", Some(&a)))
        .unwrap()
        .unwrap();
    b.advance_ms(301_000);
    let dead = b
        .store
        .kill_wall_clock_jobs_fenced(30_000.0, Some(&a))
        .unwrap();
    assert_eq!(dead.len(), 1);
    assert_eq!(b.claim_epochs(), 0, "the dead job's claim epoch is cleared");
}

#[test]
fn g7_on_a_plain_store_the_sweeps_are_what_they_always_were() {
    let b = brain("g7-plain", false);
    let id = add_job(&b, "work", Some(1000));
    b.store
        .claim_next_job(&claim_spec("w:1", None))
        .unwrap()
        .unwrap();
    b.advance_ms(2000);
    assert_eq!(b.store.kill_timed_out_jobs().unwrap().len(), 1);
    assert_eq!(b.store.get_job(id).unwrap().unwrap()["status"], "dead");
    assert!(b.lease_records().is_empty());
}
