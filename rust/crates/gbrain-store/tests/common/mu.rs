//! Test-only adapter for the multi-user store interfaces I-1 to I-5.
//!
//! The members below are copied exactly from the frozen interface list. Until the owning lane lands
//! its member in `gbrain-store`, each stub returns `MuError::Pending` naming that lane, so a pending
//! conformance case compiles today and fails loudly (with the owner's name) when it is run with
//! `--ignored`. Landing a member is a one-line edit: replace the stub body with the real call (or
//! re-export the real type), and the test that lists the stubs (`mu_adapter_stubs_are_still_pending`
//! in `multi_writer_conformance.rs`) goes red until it is edited too, so an un-pend is a visible
//! change.
//!
//! Nothing here touches product code, and nothing in the product reads these types.

use gbrain_store::{Store, StoreError};
use serde_json::Value;
use std::ops::Deref;
use std::time::Instant;

/// Lane owners, exactly as they appear in pending reasons.
pub const L1_TXN: &str = "L1 optimistic transactions";
pub const L1_SIM: &str = "L1 sim seam";
pub const L2_LOG: &str = "L2 commit log";
pub const L3_SERVER: &str = "L3 server";
pub const L4_ACCESS: &str = "L4 access";
pub const L5_HOSTS: &str = "L5 hosts";

/// A member that has not landed: which lane owns it and what it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pending {
    pub owner: &'static str,
    pub member: &'static str,
}

#[derive(Debug)]
pub enum MuError {
    Pending(Pending),
    Store(StoreError),
}

impl MuError {
    pub fn pending(&self) -> Option<&Pending> {
        match self {
            MuError::Pending(p) => Some(p),
            MuError::Store(_) => None,
        }
    }

    /// The typed store error code, when this is a real store error.
    pub fn code(&self) -> Option<&str> {
        match self {
            MuError::Store(e) => Some(e.code),
            MuError::Pending(_) => None,
        }
    }
}

impl std::fmt::Display for MuError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MuError::Pending(p) => write!(f, "pending on {}: {}", p.owner, p.member),
            MuError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl From<StoreError> for MuError {
    fn from(e: StoreError) -> Self {
        MuError::Store(e)
    }
}

pub type MuResult<T> = Result<T, MuError>;

fn pending<T>(owner: &'static str, member: &'static str) -> MuResult<T> {
    Err(MuError::Pending(Pending { owner, member }))
}

// ---- I-1 ---------------------------------------------------------------------------------------

/// `pub enum TxnMode { Serialized, Optimistic }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxnMode {
    Serialized,
    Optimistic,
}

/// I-3: `pub struct WriteOrigin { host_id, incarnation, writer_id }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteOrigin {
    pub host_id: String,
    pub incarnation: String,
    pub writer_id: String,
}

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

// ---- I-2 ---------------------------------------------------------------------------------------

/// `#[derive(Copy, Clone, Eq, PartialEq, Ord, PartialOrd)] pub struct CommitPosition`, ordered by
/// (sequence, index); the single-writer index is always 0. The field order is what makes the derived
/// `Ord` the right one.
#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct CommitPosition {
    pub sequence: u64,
    pub index: u32,
}

impl CommitPosition {
    /// The read token string, `cp1:<sequence>.<index>`.
    pub fn token(&self) -> String {
        format!("cp1:{}.{}", self.sequence, self.index)
    }
}

// ---- I-4 ---------------------------------------------------------------------------------------

/// `LogPage { records, oldest_retained, newest, snapshot_required }`. The interface list leaves the
/// record and position field types open; positions are `Option<CommitPosition>` and records are JSON.
#[derive(Clone, Debug, Default)]
pub struct LogPage {
    pub records: Vec<Value>,
    pub oldest_retained: Option<CommitPosition>,
    pub newest: Option<CommitPosition>,
    pub snapshot_required: bool,
}

// ---- I-5 ---------------------------------------------------------------------------------------

/// `pub struct LeaseToken { name, epoch, token }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LeaseToken {
    pub name: String,
    pub epoch: u64,
    pub token: String,
}

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

/// The multi-user members of `Store`, as the frozen interfaces spell them.
pub trait MuStore {
    /// I-1 `Store::begin_with(&self, opts: TxnOptions) -> Result<Transaction>`. Owner: L1.
    fn begin_with(&self, opts: TxnOptions) -> MuResult<MuTxn>;
    /// I-1 `Store::single_flight(&self, txn: &Transaction, keys: &[SingleFlightKey]) -> Result<()>`
    /// (keys sorted, held to commit or abort). Owner: L1.
    fn single_flight(&self, txn: &MuTxn, keys: &[SingleFlightKey]) -> MuResult<()>;
    /// I-1 and I-2 `Transaction::commit(self) -> Result<CommitPosition>`. Owner: L2 (the position).
    fn commit_position(&self, txn: MuTxn) -> MuResult<CommitPosition>;
    /// I-1 `Transaction::assert_lease(&self, token: &LeaseToken) -> Result<()>` (adds the lease row
    /// to the read set). Owner: L5.
    fn assert_lease(&self, txn: &MuTxn, token: &LeaseToken) -> MuResult<()>;
    /// I-5 `Store::acquire_lease(&self, name, holder, ttl_ms) -> Result<Option<LeaseToken>>`
    /// (every takeover increments the epoch). Owner: L5.
    fn acquire_lease(
        &self,
        name: &str,
        holder: &WriteOrigin,
        ttl_ms: u64,
    ) -> MuResult<Option<LeaseToken>>;
    /// I-5 `Store::renew_lease(&self, token, ttl_ms) -> Result<()>` (`lease_lost` if the epoch moved).
    fn renew_lease(&self, token: &LeaseToken, ttl_ms: u64) -> MuResult<()>;
    /// I-5 `Store::release_lease(&self, token) -> Result<()>`.
    fn release_lease(&self, token: &LeaseToken) -> MuResult<()>;
    /// I-4 `Store::read_commit_log(&self, after: Option<CommitPosition>, max: usize) -> Result<LogPage>`.
    /// Owner: L2.
    fn read_commit_log(&self, after: Option<CommitPosition>, max: usize) -> MuResult<LogPage>;
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
    fn assert_lease(&self, _txn: &MuTxn, _token: &LeaseToken) -> MuResult<()> {
        pending(L5_HOSTS, "Transaction::assert_lease")
    }
    fn acquire_lease(
        &self,
        _name: &str,
        _holder: &WriteOrigin,
        _ttl_ms: u64,
    ) -> MuResult<Option<LeaseToken>> {
        pending(L5_HOSTS, "Store::acquire_lease")
    }
    fn renew_lease(&self, _token: &LeaseToken, _ttl_ms: u64) -> MuResult<()> {
        pending(L5_HOSTS, "Store::renew_lease")
    }
    fn release_lease(&self, _token: &LeaseToken) -> MuResult<()> {
        pending(L5_HOSTS, "Store::release_lease")
    }
    fn read_commit_log(&self, _after: Option<CommitPosition>, _max: usize) -> MuResult<LogPage> {
        pending(L2_LOG, "Store::read_commit_log")
    }
}

/// Stand-in for a step a lane owns that has no member yet (the server, host election, and so on).
pub fn pending_member<T>(owner: &'static str, member: &'static str) -> MuResult<T> {
    pending(owner, member)
}
