//! Test-only adapter for the multi-user store interfaces I-1 to I-5.
//!
//! The members below are copied exactly from the frozen interface list. Until the owning lane lands
//! its member in `gbrain-store`, each stub fails with the store error code `multi_writer_pending` naming that lane (`pending_owner`), so a pending
//! conformance case compiles today and fails loudly (with the owner's name) when it is run with
//! `--ignored`. Landing a member is a one-line edit: replace the stub body with the real call (or
//! re-export the real type), and the test that lists the stubs (`mu_adapter_stubs_are_still_pending`
//! in `multi_writer_conformance.rs`) goes red until it is edited too, so an un-pend is a visible
//! change.
//!
//! Nothing here touches product code, and nothing in the product reads these types.

use gbrain_store::commit_log;
use gbrain_store::occ_kv::OccKv;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{Env, Kv, MultiUserWrites, OpenOptions, Store, StoreError, keys};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

/// Lane owners, exactly as they appear in pending reasons.
pub const L1_TXN: &str = "L1 optimistic transactions";
pub const L1_SIM: &str = "L1 sim seam";
pub const L2_LOG: &str = "L2 commit log";
pub const L3_SERVER: &str = "L3 server";
pub const L4_ACCESS: &str = "L4 access";
pub const L5_HOSTS: &str = "L5 hosts";

/// Every member returns the store's own result type, as the real one will, so a landed member replaces its stub
/// without a change to any caller. A member that has not landed fails with `PENDING`.
pub type MuResult<T> = gbrain_store::Result<T>;

/// The code of a stub's error. Never a code the store raises.
pub const PENDING: &str = "multi_writer_pending";

fn pending<T>(owner: &'static str, member: &'static str) -> MuResult<T> {
    Err(StoreError::new(
        PENDING,
        format!("pending on {owner}: {member}"),
    ))
}

/// The lane a pending error names, when the error is a stub's.
pub fn pending_owner(error: &StoreError) -> Option<&str> {
    let rest = error.message.strip_prefix("pending on ")?;
    if error.code != PENDING {
        return None;
    }
    rest.split(": ").next()
}

// ---- I-1 ---------------------------------------------------------------------------------------

/// I-1, landed with the optimistic-transactions lane: re-exported (`gbrain_store::transactions`). `TxnOptions` also carries
/// `read_only`, `retry_keys` and `age` (I-1.v2), all defaulting to off, so a literal takes `..TxnOptions::default()`.
#[allow(unused_imports)]
pub use gbrain_store::transactions::{SingleFlightKey, TxnMode, TxnOptions};

/// I-3, landed with the hosts lane: re-exported (`gbrain_store::write_origin::WriteOrigin`, with `check()`).
pub use gbrain_store::write_origin::WriteOrigin;

// ---- I-2 and I-4 -------------------------------------------------------------------------------

/// I-2 and I-4, landed with the commit-log lane: re-exported, so a test and the store agree on one type. `CommitPosition` is
/// ordered by (sequence, index), the single-writer index is always 0, and `token()` is the `cp1:<sequence>.<index>` read token.
#[allow(unused_imports)]
pub use gbrain_store::commit_log::{CommitPosition, CommitRecord, LogOp, LogPage};

/// The clock floor of a server that takes over as primary from the log (I-4.v2): the larger of its own `M\0ctime` and the last
/// applied record's commit time. `None` when there is neither.
pub fn clock_floor(local_ctime: Option<i64>, last_applied: Option<&CommitRecord>) -> Option<i64> {
    match (local_ctime, last_applied.map(|r| r.commit_time)) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

// ---- I-5 ---------------------------------------------------------------------------------------

/// I-5, landed with the hosts lane: re-exported. `acquire_lease`, `renew_lease`, `release_lease`, `read_lease` and `assert_lease`
/// are inherent members of `Store` now (and `assert_lease` on a transaction's handle reads the lease row into its read set).
#[allow(unused_imports)]
pub use gbrain_store::error::LEASE_LOST;
#[allow(unused_imports)]
pub use gbrain_store::leases::{
    CLAIM_CYCLE_LOCK, CLAIM_DRAIN_LEASE, CLAIM_EFFECT, CLAIM_JOB, CLAIM_WRITE, LeaseState,
    LeaseToken, LostReason, lease_lost, lost_reason,
};

/// Every `lease_lost` reason, in the order the interface lists them.
pub const LOST_REASONS: [LostReason; 6] = [
    LostReason::NotFound,
    LostReason::EpochMoved,
    LostReason::Released,
    LostReason::Expired,
    LostReason::ClaimEpochMismatch,
    LostReason::HeldByAnother,
];

// ---- the transaction handle --------------------------------------------------------------------

/// What `Store::begin_with` returns (I-1, landed): the real transaction, which derefs to its bound store.
#[allow(unused_imports)]
pub use gbrain_store::transactions::Transaction as MuTxn;

// ---- the store side ----------------------------------------------------------------------------

/// The multi-user members of `Store` no lane has landed yet, as the frozen interfaces spell them. Landed and called on `Store`
/// directly: `begin_with` and `single_flight` (I-1), `last_commit_time` (I-4.v2) and `read_commit_log` (I-4).
pub trait MuStore {
    /// I-1 and I-2 `Transaction::commit(self) -> Result<CommitPosition>`: the real `Transaction::commit_at`
    /// (`Store::commit_transaction_at`).
    fn commit_position(&self, txn: MuTxn) -> MuResult<CommitPosition>;
    /// A follower applies the given commit records, in order, to its own brain and returns the position of the last one
    /// (`None` for no records). Pending: the commit-log lane has `commit_log::apply_record(&mut dyn KvWrite, &CommitRecord)`, a
    /// function over a raw write handle, and no `Store` member (and no public follower open) that applies records.
    fn apply_log(&self, records: &[CommitRecord]) -> MuResult<Option<CommitPosition>>;
    /// A follower that applied the log up to `applied` and takes over as primary: opens its clock at the floor
    /// `clock_floor(its M\0ctime, the last applied record)` and returns that floor. Stand-in for the promotion step; owners:
    /// L2 (the log) and L5 (the election).
    fn promote_from_log(&self, applied: Option<CommitPosition>) -> MuResult<Option<i64>>;
}

impl MuStore for Store {
    fn commit_position(&self, txn: MuTxn) -> MuResult<CommitPosition> {
        txn.commit_at()
    }
    fn apply_log(&self, _records: &[CommitRecord]) -> MuResult<Option<CommitPosition>> {
        pending(
            L2_LOG,
            "no Store member applies commit records (commit_log::apply_record takes a raw KvWrite); a public follower-apply path",
        )
    }
    fn promote_from_log(&self, _applied: Option<CommitPosition>) -> MuResult<Option<i64>> {
        pending(
            L2_LOG,
            "no Store member promotes a follower from the log (clock floor = max(M\\0ctime, last applied commit_time)); election: L5 hosts",
        )
    }
}

/// Stand-in for a step a lane owns that has no member yet (the server, host election, and so on).
pub fn pending_member<T>(owner: &'static str, member: &'static str) -> MuResult<T> {
    pending(owner, member)
}

// ---- a store with the commit log on, and byte images of its keys ---------------------------------------------------------

/// Every key and value of a record file but the commit log's own keys (tag `2`): what a log replay must reproduce.
pub type Image = BTreeMap<Vec<u8>, Vec<u8>>;

/// The commit log's key family (`b'2'`, I-4).
pub fn is_log_key(key: &[u8]) -> bool {
    key.first() == Some(&b'2')
}

/// The image of a record file, from one snapshot.
pub fn image_of(kv: &dyn Kv) -> Image {
    let read = kv.snapshot().unwrap();
    let mut out = Image::new();
    read.scan(&[1], &[0xFF; 64], false, &mut |k, v| {
        if !is_log_key(k) {
            out.insert(k.to_vec(), v.to_vec());
        }
        true
    })
    .unwrap();
    out
}

/// A brain the test holds a raw handle on, with the multi-user switch and the commit log on.
pub struct LoggedBrain {
    pub kv: Arc<dyn Kv>,
    pub store: Store,
}

/// The host id every logged open in the multi-writer tests uses unless it names another.
pub const TEST_HOST: &str = "d0000000-0000-4000-8000-0000000000d1";

/// The options of a store opened with multi-user mode AND the commit log on, in the run, as host `host_id`: never read from the
/// environment, so a run cannot drift into a plain store.
pub fn logged_options(optimistic: bool, host_id: &str) -> OpenOptions {
    OpenOptions {
        concurrent_writes: optimistic,
        keyword_index_builder: false,
        multiuser: true,
        multiuser_writes: MultiUserWrites {
            commit_log: true,
            write_origin: false,
            host_id: Some(host_id.into()),
            log_retention_bytes: None,
        },
        ..OpenOptions::default()
    }
}

/// The resolved state a logged test asserts about the store it opened: multi-user mode on and the log on, as the open info
/// reports them. A store opened with the mode off fails this, so a run that lost the switch cannot pass.
pub fn assert_logged(store: &Store) {
    assert!(
        store.multiuser(),
        "the store did not resolve multi-user mode on"
    );
    let info = store.info();
    assert!(
        info.multiuser,
        "the open info does not report multi-user mode: {info:?}"
    );
    assert!(
        info.commit_log,
        "the open info does not report the commit log: {info:?}"
    );
}

/// Opens (or reopens) the brain directory `dir` (`<dir>/records.redb` and `FORMAT`) logged, as `logged_options` says, and asserts the
/// resolved state.
pub fn open_dir_logged(dir: &Path, optimistic: bool, host_id: &str) -> MuResult<Store> {
    let store = Store::open_dir(dir, logged_options(optimistic, host_id))?;
    assert_logged(&store);
    Ok(store)
}

/// Opens (or reopens) the record file at `path` with the multi-user switch and the commit log on, on `env`, as host `host_id`, on
/// the single-writer or the optimistic store, and asserts the resolved state. Served by the commit-log lane.
pub fn open_logged(
    path: &Path,
    optimistic: bool,
    env: Arc<dyn Env>,
    host_id: &str,
) -> MuResult<LoggedBrain> {
    let base = RedbKv::open_path(path)?;
    let kv: Arc<dyn Kv> = if optimistic {
        Arc::new(OccKv::new(base)?)
    } else {
        Arc::new(base)
    };
    let store = Store::open_kv(kv.clone(), env, logged_options(optimistic, host_id))?;
    assert_logged(&store);
    Ok(LoggedBrain { kv, store })
}

/// `open_logged` on the optimistic store, keeping the concrete `OccKv` so a test can hold its pipeline and watch its queue
/// (`OccKv::queued_commits`).
pub fn open_logged_occ(
    path: &Path,
    env: Arc<dyn Env>,
    host_id: &str,
) -> MuResult<(Arc<OccKv>, Store)> {
    let occ = Arc::new(OccKv::new(RedbKv::open_path(path)?)?);
    let kv: Arc<dyn Kv> = occ.clone();
    let store = Store::open_kv(kv, env, logged_options(true, host_id))?;
    assert_logged(&store);
    Ok((occ, store))
}

/// A closed logged brain that the next open must write to without any caller: `OlderBase` is one whose records are at an older
/// base format (its upgrade runs at open), `UpkeepOnly` one at the current format whose open-time markers are gone (the
/// access-flag scan, the keyword index reset and the source-index backfill run at open).
pub struct ClosedBrain {
    /// The image of the closed brain: the starting copy a replay of the open's log records must turn into the opened brain.
    pub image: Image,
    /// The log's newest position before the open: the open's records are exactly those after it.
    pub cursor: Option<CommitPosition>,
}

/// Builds the closed brain at `path`, as the commit-log lane's own test builds its base-7 brain: a logged brain with a page and a
/// config row, then hand edits that undo the open-time markers (and, for `OlderBase`, the token-secret move and the base format),
/// then the log re-pinned after the edits (they are the starting copy, not logged changes).
pub fn logged_brain_needing_upkeep(
    path: &Path,
    optimistic: bool,
    kind: UpkeepKind,
) -> MuResult<ClosedBrain> {
    {
        let brain = open_logged(
            path,
            optimistic,
            Arc::new(gbrain_store::SystemEnv),
            TEST_HOST,
        )?;
        brain.store.set_config("test.a", "1")?;
        let page: gbrain_store::pages::PageInput = serde_json::from_value(
            json!({"type": "note", "title": "one", "compiled_truth": "one"}),
        )
        .unwrap();
        brain.store.put_page(
            "notes/one",
            &page,
            &gbrain_store::pages::PutPageOptions::default(),
        )?;
    }
    let kv = RedbKv::open_path(path)?;
    let mut tx = kv.begin_write()?;
    if kind == UpkeepKind::OlderBase {
        let secret_new = vec![keys::ACCESS_MEMBERS, 0x0d];
        let secret_old = vec![keys::ACCESS_MEMBERS, 0x04];
        let secret = tx.get(&secret_new)?.expect("a seeded token secret");
        tx.delete(&secret_new)?;
        tx.put(&secret_old, &secret)?;
    }
    tx.delete(&keys::meta("access_flag_scan"))?;
    tx.delete(&keys::meta("derivation_purge_source_index"))?;
    tx.delete(&keys::keyword_index_state())?;
    if kind == UpkeepKind::OlderBase {
        let mut format: Value =
            serde_json::from_slice(&tx.get(&keys::meta("format"))?.unwrap()).unwrap();
        format["log"]["base_format"] = json!(7);
        tx.put(&keys::meta("format"), &serde_json::to_vec(&format).unwrap())?;
    }
    let since = CommitPosition::new(kv.version()? + 1, 0);
    let mut stale = Vec::new();
    tx.scan(
        &commit_log::record_key(CommitPosition::default()),
        b"3",
        false,
        &mut |k, _| {
            stale.push(k.to_vec());
            true
        },
    )?;
    for k in stale {
        tx.delete(&k)?;
    }
    commit_log::write_activation(&mut *tx, since)?;
    tx.commit()?;
    Ok(ClosedBrain {
        image: image_of(&kv),
        cursor: Some(since),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpkeepKind {
    OlderBase,
    UpkeepOnly,
}
