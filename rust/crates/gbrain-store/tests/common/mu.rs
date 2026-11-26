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

use gbrain_store::{Env, Kv, Store, StoreError};
use std::collections::BTreeMap;
use std::ops::Deref;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

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

/// `pub enum TxnMode { Serialized, Optimistic }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxnMode {
    Serialized,
    Optimistic,
}

/// I-3, landed with the hosts lane: re-exported (`gbrain_store::write_origin::WriteOrigin`, with `check()`).
pub use gbrain_store::write_origin::WriteOrigin;

/// `pub struct TxnOptions { mode, deadline, origin }`; the default is Serialized with no deadline
/// and no origin.
#[derive(Clone, Debug)]
pub struct TxnOptions {
    pub mode: TxnMode,
    pub deadline: Option<Instant>,
    pub origin: Option<WriteOrigin>,
}

impl Default for TxnOptions {
    fn default() -> Self {
        TxnOptions {
            mode: TxnMode::Serialized,
            deadline: None,
            origin: None,
        }
    }
}

/// `pub struct SingleFlightKey { source_id, slug }`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SingleFlightKey {
    pub source_id: String,
    pub slug: String,
}

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

/// What `Store::begin_with` returns. Today's explicit transaction is a `Store` handle
/// (`begin_transaction`), so this derefs to it and a pending body can write through it.
pub struct MuTxn {
    inner: Store,
}

impl MuTxn {
    /// For the day `begin_with` lands: wraps the handle the real call returns.
    pub fn from_store(inner: Store) -> Self {
        MuTxn { inner }
    }
}

impl Deref for MuTxn {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.inner
    }
}

// ---- the store side ----------------------------------------------------------------------------

/// The multi-user members of `Store` no lane has landed yet, as the frozen interfaces spell them. Landed with the commit-log
/// lane and called on `Store` directly: `last_commit_time` (I-4.v2) and `read_commit_log` (I-4).
pub trait MuStore {
    /// I-1 `Store::begin_with(&self, opts: TxnOptions) -> Result<Transaction>`. Owner: L1.
    fn begin_with(&self, opts: TxnOptions) -> MuResult<MuTxn>;
    /// I-1 `Store::single_flight(&self, txn: &Transaction, keys: &[SingleFlightKey]) -> Result<()>`
    /// (keys sorted, held to commit or abort). Owner: L1.
    fn single_flight(&self, txn: &MuTxn, keys: &[SingleFlightKey]) -> MuResult<()>;
    /// I-1 and I-2 `Transaction::commit(self) -> Result<CommitPosition>`. Owner: L2 (the position).
    fn commit_position(&self, txn: MuTxn) -> MuResult<CommitPosition>;
    /// A follower applies the given commit records, in order, to its own brain and returns the position of the last one
    /// (`None` for no records). Stand-in for the log-apply step; owner: L2.
    fn apply_log(&self, records: &[CommitRecord]) -> MuResult<Option<CommitPosition>>;
    /// A follower that applied the log up to `applied` and takes over as primary: opens its clock at the floor
    /// `clock_floor(its M\0ctime, the last applied record)` and returns that floor. Stand-in for the promotion step; owners:
    /// L2 (the log) and L5 (the election).
    fn promote_from_log(&self, applied: Option<CommitPosition>) -> MuResult<Option<i64>>;
}

impl MuStore for Store {
    fn begin_with(&self, _opts: TxnOptions) -> MuResult<MuTxn> {
        pending(L1_TXN, "Store::begin_with")
    }
    fn single_flight(&self, _txn: &MuTxn, _keys: &[SingleFlightKey]) -> MuResult<()> {
        pending(L1_TXN, "Store::single_flight")
    }
    fn commit_position(&self, _txn: MuTxn) -> MuResult<CommitPosition> {
        pending(L2_LOG, "Transaction::commit -> CommitPosition")
    }
    fn apply_log(&self, _records: &[CommitRecord]) -> MuResult<Option<CommitPosition>> {
        pending(L2_LOG, "apply commit records to a follower")
    }
    fn promote_from_log(&self, _applied: Option<CommitPosition>) -> MuResult<Option<i64>> {
        pending(
            L2_LOG,
            "promote a follower from the log (clock floor = max(M\\0ctime, last applied commit_time)); election: L5 hosts",
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

/// Opens (or reopens) the record file at `path` with the multi-user switch and the commit log on, on `env`, as host `host_id`, on
/// the single-writer or the optimistic store. Pending until the commit-log lane's open options exist in this tree.
pub fn open_logged(
    _path: &Path,
    _optimistic: bool,
    _env: Arc<dyn Env>,
    _host_id: &str,
) -> MuResult<LoggedBrain> {
    pending(L2_LOG, "OpenOptions::multiuser_writes (the commit log on)")
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

/// Pending with the open options.
pub fn logged_brain_needing_upkeep(
    _path: &Path,
    _optimistic: bool,
    _kind: UpkeepKind,
) -> MuResult<ClosedBrain> {
    pending(
        L2_LOG,
        "a logged brain whose open writes (upgrade, open-time upkeep)",
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpkeepKind {
    OlderBase,
    UpkeepOnly,
}
