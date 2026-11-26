//! The lease-fence follow-up (lane L5; `docs/designs/rust-engine/multi-user-server.md`, "I-5, host fence table"): the
//! lease families that kept only their own token and TTL carry the host fence. In each test a host takes its lease,
//! starts the family's lease under that fence, loses its host lease to a takeover (a new epoch), and then every
//! renewal, release or new take under the old fence is refused at commit with `lease_lost` and changes nothing.
//! Multi-user mode is on and asserted in every test.
#![allow(dead_code)]

use gbrain_store::env::uuid_from_bytes;
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
        "lease-fences-{name}-{}-{}",
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

/// `value` with `fence` set, as the TypeScript caller sends it.
fn fenced<T: serde::de::DeserializeOwned>(mut value: Value, fence: &LeaseToken) -> T {
    value["fence"] = serde_json::to_value(fence).unwrap();
    serde_json::from_value(value).unwrap()
}

// ---------------------------------------------------------------------------------------------------------------
// Family 2: the housekeeping turn.

const HOST: &str = "d0000000-0000-4000-8000-0000000000d1";

fn turn_claim(fence: &LeaseToken) -> gbrain_store::persistence::HousekeepingClaim {
    fenced(
        json!({ "op": "housekeeping", "hostId": HOST, "intervalMs": 60_000, "leaseMs": 60_000 }),
        fence,
    )
}

fn turn(fence: &LeaseToken) -> gbrain_store::persistence::HousekeepingTurn {
    fenced(json!({ "op": "housekeeping", "hostId": HOST }), fence)
}

#[test]
fn lf2_a_stale_host_cannot_claim_or_complete_a_housekeeping_turn() {
    let b = brain("lf2-turn", true);
    assert!(b.store.multiuser(), "multi-user mode is on");
    let a = b.lease("consumer:h", "a");
    assert!(b.store.claim_housekeeping_turn(&turn_claim(&a)).unwrap());
    let new = b.take_over("consumer:h", &a);
    let before = b.dump();
    refused(
        &b.store.complete_housekeeping_turn(&turn(&a)).unwrap_err(),
        "epoch_moved",
    );
    b.advance_ms(120_000); // past the turn's lease: free again
    refused(
        &b.store
            .claim_housekeeping_turn(&turn_claim(&a))
            .unwrap_err(),
        "epoch_moved",
    );
    assert_eq!(b.dump(), before, "a refused turn write changed the brain");
    assert!(b.store.claim_housekeeping_turn(&turn_claim(&new)).unwrap());
    b.store.complete_housekeeping_turn(&turn(&new)).unwrap();
}

// ---------------------------------------------------------------------------------------------------------------
// Family 3: the private queue owner lease.

fn add_job(b: &Brain, extra: Value) -> i64 {
    let mut insert = json!({
        "name": "work", "queue": "default", "status": "waiting", "priority": 0, "data": {},
        "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
        "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
        "remove_on_fail": false, "submission_authority": {"version": 1, "kind": "application"},
    });
    for (k, v) in extra.as_object().unwrap() {
        insert[k] = v.clone();
    }
    let spec: gbrain_store::jobs::AdmitSpec =
        serde_json::from_value(json!({ "insert": insert, "maxSpawnDepth": 5 })).unwrap();
    b.store.admit_job(&spec).unwrap().row["id"]
        .as_i64()
        .unwrap()
}

#[test]
fn lf3_a_stale_host_cannot_renew_a_private_queue_lease() {
    let b = brain("lf3-private", true);
    assert!(b.store.multiuser(), "multi-user mode is on");
    let q = "dream-private:cycle-1";
    let a = b.lease("consumer:h", "a");
    add_job(
        &b,
        json!({"queue": q, "private_queue_owner_token": "tok", "private_queue_lease_until": "2027-01-15T08:00:30Z"}),
    );
    assert_eq!(
        b.store
            .renew_private_queue_lease_fenced(q, "tok", 60_000.0, Some(&a))
            .unwrap(),
        1
    );
    let new = b.take_over("consumer:h", &a);
    let before = b.dump();
    refused(
        &b.store
            .renew_private_queue_lease_fenced(q, "tok", 600_000.0, Some(&a))
            .unwrap_err(),
        "epoch_moved",
    );
    assert_eq!(b.dump(), before, "a refused renewal changed the brain");
    assert_eq!(
        b.store
            .renew_private_queue_lease_fenced(q, "tok", 600_000.0, Some(&new))
            .unwrap(),
        1
    );
}

