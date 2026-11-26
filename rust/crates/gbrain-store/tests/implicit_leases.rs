//! Implicit leases (lane L5, frozen interface I-5; `src/fence.rs`, `src/leases.rs`): a protected call with NO fence on a
//! multi-user store is not refused for lacking one. A single host that never registered a host lease (a one-shot
//! command, a cycle lock taken outside a consumer, the parity harness, a served caller) runs as it does with the switch
//! off. The store takes an implicit lease for each claim an unfenced caller takes, inside the claim's own write:
//!
//! - lease name `implicit:<family byte as 2 hex digits>:<claim id>`, epoch = the name's last epoch + 1 (1 when none), a
//!   UUID v7 token, holder origin `unregistered` / `unregistered` / the member's name, and a time to live equal to the
//!   claim's own lease (60 s when it has none);
//! - the claim's epoch record (`~L 0x05`) names that lease.
//!
//! One row per protected family below runs the whole unfenced life of a claim on a multi-user store. The refusals that
//! stay are checked too: an unfenced finish of a claim a registered holder's live lease owns refuses `held_by_another`
//! and writes nothing, and a fenced caller with a stale epoch or a foreign token refuses as before. With the switch off
//! nothing is written under `~L`.
//!
//! `GBRAIN_RUST_CONCURRENT_WRITES=1` runs every store on the concurrent (optimistic) record file.

use gbrain_store::env::uuid_from_bytes;
use gbrain_store::jobs::{AdmitSpec, ClaimSpec, DelayOpts, LockAcquire, LockHolder};
use gbrain_store::leases::{
    self, CLAIM_CYCLE_LOCK, CLAIM_DRAIN_LEASE, CLAIM_EFFECT, CLAIM_JOB, CLAIM_WRITE, LeaseToken,
    lost_reason,
};
use gbrain_store::occ_kv::OccKv;
use gbrain_store::persistence::{
    ClaimRelease, ClaimStamp, EffectClaim, EffectSettle, ExpireClaims, PublicationEffectsSpec,
    Settle, WriteCompletion, WriteRequestInsert,
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
const REQ: &str = "b0000000-0000-4000-8000-0000000000b1";
const TOKEN: &str = "c0000000-0000-4000-8000-0000000000c1";
const EFFECT_TOKEN: &str = "f0000000-0000-4000-8000-000000000001";
const REVISION: &str = "e0000000-0000-4000-8000-0000000000e1";
const LOCK_ID: &str = "gbrain-sync:default";
const LOCK_TOKEN: &str = "a0000000-0000-4000-8000-000000000001";
const DRAIN_TOKEN: &str = "a0000000-0000-4000-8000-0000000000a1";

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
        "implicit-{name}-{}-{}",
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

/// One claim-epoch record: (family byte, claim id, lease name, epoch).
type Epoch = (u8, String, String, u64);

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

    /// The claim-epoch records (`~L 0x05 <family> <claim id>`).
    fn epochs(&self) -> Vec<Epoch> {
        let at = keys::LEASES.len();
        self.lease_records()
            .into_iter()
            .filter(|(k, _)| k[at] == leases::CLAIM_EPOCH)
            .map(|(k, v)| {
                let v: Value = serde_json::from_slice(&v).unwrap();
                (
                    k[at + 1],
                    String::from_utf8(k[at + 2..].to_vec()).unwrap(),
                    v["lease"].as_str().unwrap().to_owned(),
                    v["epoch"].as_u64().unwrap(),
                )
            })
            .collect()
    }

    /// The epoch record of claim `id` of `family`, which must be there and name an implicit lease at `epoch`; and that
    /// lease, as `read_lease` shows it (held by the `unregistered` origin, live now).
    fn assert_implicit(&self, family: u8, id: &str, epoch: u64, writer: &str) {
        let name = format!("implicit:{family:02x}:{id}");
        let found = self
            .epochs()
            .into_iter()
            .find(|e| e.0 == family && e.1 == id)
            .unwrap_or_else(|| panic!("no epoch record for {name}"));
        assert_eq!((found.2.as_str(), found.3), (name.as_str(), epoch));
        let lease = self
            .store
            .read_lease(&name)
            .unwrap()
            .expect("the lease row");
        assert_eq!(lease.epoch, epoch);
        assert!(lease.live && !lease.released, "{name} is live");
        assert_eq!(
            (
                lease.holder.host_id.as_str(),
                lease.holder.incarnation.as_str(),
                lease.holder.writer_id.as_str()
            ),
            ("unregistered", "unregistered", writer)
        );
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
}

fn refused(error: &gbrain_store::StoreError, reason: &str) {
    assert_eq!(error.code, gbrain_store::error::LEASE_LOST, "{error}");
    assert_eq!(lost_reason(error).as_deref(), Some(reason), "{error}");
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs.

fn add_job(b: &Brain, timeout_ms: Option<i64>) -> i64 {
    let spec: AdmitSpec = serde_json::from_value(json!({
        "insert": {
            "name": "work", "queue": "default", "status": "waiting", "priority": 0, "data": {},
            "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
            "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
            "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
            "timeout_ms": timeout_ms,
        },
        "maxSpawnDepth": 5,
    }))
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

fn claim_unfenced(b: &Brain, token: &str, timeout: Option<i64>) -> i64 {
    let id = add_job(b, timeout);
    let claimed = b
        .store
        .claim_next_job(&claim_spec(token, None))
        .unwrap()
        .expect("an unfenced claim is taken");
    assert_eq!(claimed["id"], id);
    b.assert_implicit(CLAIM_JOB, &id.to_string(), 1, "claim_next_job");
    id
}

fn delay() -> DelayOpts {
    DelayOpts {
        error_text: "x".into(),
        delay_ms: 1000.0,
        append_stack: false,
        clear_timeout: false,
        fence: None,
    }
}

/// One row per job member: what an unfenced caller does with the claim it just took.
type JobStep = (&'static str, fn(&Brain, i64, &str));

const JOB_STEPS: [JobStep; 8] = [
    ("renew_job_lease then complete_job", |b, id, t| {
        assert!(b.store.renew_job_lease(id, t, 30000.0).unwrap());
        assert_eq!(
            b.store.complete_job(id, t, None).unwrap().unwrap()["status"],
            "completed"
        );
    }),
    ("fail_job", |b, id, t| {
        assert!(
            b.store
                .fail_job(id, t, "x", "failed", None, None)
                .unwrap()
                .is_some()
        );
    }),
    ("delay_active_job", |b, id, t| {
        assert!(b.store.delay_active_job(id, t, &delay()).unwrap().is_some());
    }),
    ("delay_held_claim", |b, id, t| {
        assert!(b.store.delay_held_claim(id, t, 1000.0).unwrap());
    }),
    ("release_watchdog_claim", |b, id, t| {
        assert!(b.store.release_watchdog_claim(id, t, "x", MARK).unwrap());
    }),
    (
        "update_job_progress, add_job_tokens, read_job_inbox",
        |b, id, t| {
            assert!(
                b.store
                    .update_job_progress(id, t, &json!({"n": 1}))
                    .unwrap()
            );
            b.store.read_job_inbox(id, t).unwrap();
            b.store.complete_job(id, t, None).unwrap().unwrap();
        },
    ),
    ("reclaim_stalled_jobs", |b, _, _| {
        b.advance_ms(31_000);
        b.store.reclaim_stalled_jobs(0.0, MARK).unwrap();
    }),
    (
        "claim again after the reclaim: epoch 2 of the same name",
        |b, id, _| {
            b.advance_ms(31_000);
            b.store.reclaim_stalled_jobs(0.0, MARK).unwrap();
            let again = b
                .store
                .claim_next_job(&claim_spec("w:2", None))
                .unwrap()
                .unwrap();
            assert_eq!(again["id"], id);
            b.assert_implicit(CLAIM_JOB, &id.to_string(), 2, "claim_next_job");
        },
    ),
];

#[test]
fn jobs_an_unfenced_claim_takes_an_implicit_lease_and_every_step_on_it_succeeds() {
    for (label, step) in JOB_STEPS {
        let b = brain("jobs", true);
        let id = claim_unfenced(&b, "w:1", None);
        step(&b, id, "w:1");
        if !label.starts_with("claim again") {
            assert!(
                b.epochs().is_empty(),
                "{label}: the record goes with the claim"
            );
        }
    }
}

#[test]
fn jobs_the_implicit_lease_lives_as_long_as_the_claim_s_own_lease() {
    let b = brain("jobs-ttl", true);
    let id = claim_unfenced(&b, "w:1", None);
    let name = format!("implicit:{CLAIM_JOB:02x}:{id}");
    let lease = b.store.read_lease(&name).unwrap().unwrap();
    // The job claim's own lease is 30 s (`lockDurationMs`).
    assert_eq!(lease.expires_at_us - lease.acquired_at_us, 30_000 * 1000);
    assert_eq!(lease.acquired_at_us, T0);
}

#[test]
fn jobs_the_timeout_sweeps_run_unfenced_and_end_the_claim_record() {
    let b = brain("jobs-sweeps", true);
    let id = claim_unfenced(&b, "w:1", Some(1000));
    b.advance_ms(2000);
    let dead = b.store.kill_timed_out_jobs_fenced(None).unwrap();
    assert_eq!(dead.len(), 1);
    assert_eq!(b.store.get_job(id).unwrap().unwrap()["status"], "dead");
    assert!(b.epochs().is_empty());
    let id = claim_unfenced(&b, "w:2", None);
    b.advance_ms(301_000);
    let dead = b.store.kill_wall_clock_jobs_fenced(30_000.0, None).unwrap();
    assert_eq!(dead.len(), 1);
    assert_eq!(b.store.get_job(id).unwrap().unwrap()["status"], "dead");
    assert!(b.epochs().is_empty());
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

fn stamp(id: &str, token: &str, fence: Option<&LeaseToken>) -> ClaimStamp {
    ClaimStamp {
        id: id.into(),
        token: token.into(),
        lease_ms: 30_000.0,
        phase_json: None,
        fence: fence.cloned(),
    }
}

fn completion(id: &str) -> WriteCompletion {
    serde_json::from_value(json!({
        "id": id, "state": "committed", "outcome": {"slug": "notes/a"}, "errorCode": null, "errorMessage": null,
        "consumerVersion": "v-consumer", "consumerHostId": HOST, "errorDetail": null, "resultBytes": 100,
        "counterKeys": KEYS, "intentBytes": 10, "retainedBytes": 512, "terminalReservation": 4096, "probePurges": false,
    }))
    .unwrap()
}

fn expire_spec() -> ExpireClaims {
    ExpireClaims {
        host_id: HOST.into(),
        charge: false,
        dead_owners: vec![],
        fence: None,
    }
}

#[test]
fn write_claims_an_unfenced_claim_takes_an_implicit_lease_and_every_step_on_it_succeeds() {
    let b = brain("write", true);
    let id = admit_request(&b, REQ);
    assert!(
        b.store
            .select_claimable_write(&Default::default())
            .unwrap()
            .is_some()
    );
    assert_eq!(
        b.store.expire_stale_write_claims(&expire_spec()).unwrap(),
        0
    );
    assert!(
        b.store
            .stamp_write_claim(&stamp(&id, TOKEN, None))
            .unwrap()
            .is_some()
    );
    b.assert_implicit(CLAIM_WRITE, &id.to_lowercase(), 1, "stamp_write_claim");
    let lease = b
        .store
        .read_lease(&format!("implicit:{CLAIM_WRITE:02x}:{id}"))
        .unwrap()
        .unwrap();
    assert_eq!(lease.expires_at_us - lease.acquired_at_us, 30_000 * 1000);
    assert!(b.store.renew_write_claim(&stamp(&id, TOKEN, None)).unwrap());
    let done = b
        .store
        .complete_write_row(&completion(&id))
        .unwrap()
        .unwrap();
    assert_eq!(done["state"], "committed");
    assert!(b.epochs().is_empty());
    // A released claim ends its record; a stamp again takes epoch 2 of the same name.
    let id = admit_request(&b, "b0000000-0000-4000-8000-0000000000b2");
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, None))
        .unwrap()
        .unwrap();
    assert!(
        b.store
            .release_unpublished_claim(&ClaimRelease {
                id: id.clone(),
                token: Some(TOKEN.into()),
                reason: "x".into(),
                charge: false,
                fence: None,
            })
            .unwrap()
    );
    assert!(b.epochs().is_empty());
    b.store
        .stamp_write_claim(&stamp(&id, TOKEN, None))
        .unwrap()
        .unwrap();
    b.assert_implicit(CLAIM_WRITE, &id.to_lowercase(), 2, "stamp_write_claim");
    // An expired claim is swept and its record ends with it.
    b.advance_ms(31_000);
    assert_eq!(
        b.store.expire_stale_write_claims(&expire_spec()).unwrap(),
        1
    );
    assert!(b.epochs().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// Effects.

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

fn effect_claim(b: &Brain, token: &str) -> Option<Value> {
    let candidate = b.store.select_claimable_effect(HOST, &[]).unwrap();
    if candidate.is_null() {
        return None;
    }
    let owner = json!({ "token": token, "owner": { "pid": 7, "nonce": "n", "start": "s" } });
    b.store
        .stamp_effect_claim(&EffectClaim {
            id: candidate["id"].as_str().unwrap().into(),
            token: token.into(),
            owner_json: owner.to_string(),
            fence: None,
            dead_owners: vec![],
        })
        .unwrap()
}

fn settle(id: &Value, token: &str) -> EffectSettle {
    EffectSettle {
        id: id.as_str().unwrap().into(),
        token: Some(token.into()),
        slug: None,
        outcome_json: Some("{}".into()),
        data_json: None,
        reason: Some("x".into()),
        delay_ms: Some(0.0),
        fence: None,
    }
}

#[test]
fn effects_an_unfenced_claim_takes_an_implicit_lease_and_every_settle_succeeds() {
    let b = brain("effect", true);
    let request = admit_request(&b, REQ);
    queue_effect(&b, &request);
    let claimed = effect_claim(&b, EFFECT_TOKEN).expect("an unfenced effect claim is taken");
    let id = claimed["id"].as_str().unwrap().to_owned();
    b.assert_implicit(CLAIM_EFFECT, &id, 1, "stamp_effect_claim");
    // An effect claim has no lease of its own: the implicit one lives 60 s.
    let lease = b
        .store
        .read_lease(&format!("implicit:{CLAIM_EFFECT:02x}:{id}"))
        .unwrap()
        .unwrap();
    assert_eq!(lease.expires_at_us - lease.acquired_at_us, 60_000 * 1000);
    assert!(
        b.store
            .settle_effect(Settle::Renew, &settle(&claimed["id"], EFFECT_TOKEN))
            .unwrap()
    );
    assert!(
        b.store
            .settle_effect(Settle::Complete, &settle(&claimed["id"], EFFECT_TOKEN))
            .unwrap()
    );
    assert!(b.epochs().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// Cycle lock and drain lease.

fn lock_acquire(token: &str) -> LockAcquire {
    LockAcquire {
        holder_pid: 7,
        holder_host: Some("h".into()),
        acquisition_token: token.into(),
        ttl_minutes: 10.0,
        steal_grace_seconds: 0.0,
        fence: None,
    }
}

fn lock_holder(token: &str) -> LockHolder {
    LockHolder {
        holder_pid: 7,
        acquisition_token: token.into(),
        ttl_minutes: Some(10.0),
        max_age_seconds: Some(0.0),
        fence: None,
    }
}

#[test]
fn cycle_lock_an_unfenced_acquire_refresh_and_release_succeed() {
    let b = brain("lock", true);
    let got = b
        .store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(LOCK_TOKEN))
        .unwrap()
        .expect("an unfenced lock is taken");
    assert_eq!(got["id"], LOCK_ID);
    b.assert_implicit(CLAIM_CYCLE_LOCK, LOCK_ID, 1, "acquire_cycle_lock");
    let lease = b
        .store
        .read_lease(&format!("implicit:{CLAIM_CYCLE_LOCK:02x}:{LOCK_ID}"))
        .unwrap()
        .unwrap();
    assert_eq!(
        lease.expires_at_us - lease.acquired_at_us,
        10 * 60 * 1000 * 1000
    );
    assert!(
        b.store
            .refresh_cycle_lock(LOCK_ID, &lock_holder(LOCK_TOKEN))
            .unwrap()
    );
    assert!(
        b.store
            .assert_cycle_lease_fenced(LOCK_ID, LOCK_TOKEN, None)
            .unwrap()
    );
    assert!(
        b.store
            .release_cycle_lock(LOCK_ID, &lock_holder(LOCK_TOKEN))
            .unwrap()
    );
    assert!(b.epochs().is_empty());
    // The next taker's epoch is one past the name's last.
    b.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(LOCK_TOKEN))
        .unwrap()
        .unwrap();
    b.assert_implicit(CLAIM_CYCLE_LOCK, LOCK_ID, 2, "acquire_cycle_lock");
}

#[test]
fn drain_lease_an_unfenced_holder_writes_refreshes_and_releases() {
    let b = brain("drain", true);
    let data = json!({ "sourceId": "default", "drain_lease_beacon": { "kind": "consumer", "id": null, "version": "t" } });
    b.store
        .write_drain_lease_holder("default", DRAIN_TOKEN, data, 10.0)
        .unwrap();
    b.assert_implicit(
        CLAIM_DRAIN_LEASE,
        DRAIN_TOKEN,
        1,
        "write_drain_lease_holder",
    );
    let lease = b
        .store
        .read_lease(&format!("implicit:{CLAIM_DRAIN_LEASE:02x}:{DRAIN_TOKEN}"))
        .unwrap()
        .unwrap();
    assert_eq!(
        lease.expires_at_us - lease.acquired_at_us,
        10 * 60 * 1000 * 1000
    );
    assert_eq!(
        b.store
            .refresh_drain_lease_holder(DRAIN_TOKEN, 10.0)
            .unwrap(),
        1
    );
    assert_eq!(b.store.release_drain_lease_holder(DRAIN_TOKEN).unwrap(), 1);
    assert!(b.epochs().is_empty());
}

// ---------------------------------------------------------------------------------------------------------------
// The refusals that stay.

#[test]
fn an_unfenced_finish_of_a_claim_a_registered_live_holder_owns_refuses_and_changes_nothing() {
    let b = brain("held", true);
    let a = b.lease("consumer:h", "a");
    let id = add_job(&b, None);
    b.store
        .claim_next_job(&claim_spec("w:1", Some(&a)))
        .unwrap()
        .unwrap();
    let job = b.store.get_job(id).unwrap().unwrap();
    let records = b.lease_records();
    refused(
        &b.store.complete_job(id, "w:1", None).unwrap_err(),
        "held_by_another",
    );
    assert_eq!(b.store.get_job(id).unwrap().unwrap(), job);
    assert_eq!(b.lease_records(), records, "the record is unchanged");
    // The registered holder's own fenced finish still works.
    b.store
        .complete_job_fenced(id, "w:1", None, Some(&a))
        .unwrap()
        .unwrap();
}

#[test]
fn a_fenced_caller_with_a_stale_epoch_or_a_foreign_token_still_refuses() {
    let b = brain("fenced", true);
    let a = b.lease("jobs:h", "a");
    let id = add_job(&b, None);
    b.store
        .claim_next_job(&claim_spec("w:1", Some(&a)))
        .unwrap()
        .unwrap();
    // A claim taken implicitly is not finished by a registered fence.
    let other = add_job(&b, None);
    b.store
        .claim_next_job(&claim_spec("w:2", None))
        .unwrap()
        .unwrap();
    refused(
        &b.store
            .complete_job_fenced(other, "w:2", None, Some(&a))
            .unwrap_err(),
        "claim_epoch_mismatch",
    );
    // Host A pauses; its lease is taken over by host B.
    b.store.release_lease(&a).unwrap();
    let new = b.lease("jobs:h", "b");
    refused(
        &b.store
            .complete_job_fenced(id, "w:1", None, Some(&a))
            .unwrap_err(),
        "epoch_moved",
    );
    refused(
        &b.store
            .complete_job_fenced(id, "w:1", None, Some(&new))
            .unwrap_err(),
        "claim_epoch_mismatch",
    );
    let foreign = LeaseToken {
        token: "00000000-0000-7000-8000-000000000000".into(),
        ..new.clone()
    };
    refused(
        &b.store
            .complete_job_fenced(id, "w:1", None, Some(&foreign))
            .unwrap_err(),
        "epoch_moved",
    );
    assert_eq!(b.store.get_job(id).unwrap().unwrap()["status"], "active");
}

#[test]
fn with_the_switch_off_an_unfenced_call_writes_nothing_under_the_lease_family() {
    let b = brain("off", false);
    let id = claim_job_plain(&b);
    assert!(b.store.renew_job_lease(id, "w:1", 30000.0).unwrap());
    b.store.complete_job(id, "w:1", None).unwrap().unwrap();
    let request = admit_request(&b, REQ);
    b.store
        .stamp_write_claim(&stamp(&request, TOKEN, None))
        .unwrap()
        .unwrap();
    b.store
        .complete_write_row(&completion(&request))
        .unwrap()
        .unwrap();
    b.store
        .acquire_cycle_lock(LOCK_ID, &lock_acquire(LOCK_TOKEN))
        .unwrap()
        .unwrap();
    b.store
        .release_cycle_lock(LOCK_ID, &lock_holder(LOCK_TOKEN))
        .unwrap();
    assert!(b.lease_records().is_empty(), "no `~L` key is written");
}

fn claim_job_plain(b: &Brain) -> i64 {
    let id = add_job(b, None);
    b.store
        .claim_next_job(&claim_spec("w:1", None))
        .unwrap()
        .unwrap();
    id
}
