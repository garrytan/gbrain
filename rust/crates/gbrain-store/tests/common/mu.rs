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
use gbrain_store::persistence::{EffectSettle, Settle};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{Env, Kv, MultiUserWrites, OpenOptions, Store, StoreError, keys};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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

/// I-3, served by the commit-log lane: re-exported.
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

// ---- I-2 ---------------------------------------------------------------------------------------

/// I-2, served by the commit-log lane: re-exported.
pub use gbrain_store::commit_log::CommitPosition;

// ---- I-4 ---------------------------------------------------------------------------------------

/// I-4, served by the commit-log lane: re-exported.
pub use gbrain_store::commit_log::{CommitRecord, LogOp, LogPage};

/// The clock floor of a server that takes over as primary from the log (I-4.v2): the larger of its own `M\0ctime` and the last
/// applied record's commit time. `None` when there is neither.
pub fn clock_floor(local_ctime: Option<i64>, last_applied: Option<&CommitRecord>) -> Option<i64> {
    match (local_ctime, last_applied.map(|r| r.commit_time)) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

// ---- I-5 ---------------------------------------------------------------------------------------

/// What a holder keeps and shows on every protected write (`gbrain_store::leases::LeaseToken`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeaseToken {
    pub name: String,
    pub epoch: u64,
    /// A UUID v7 minted when the lease was taken.
    pub token: String,
}

/// What `read_lease` shows (`gbrain_store::leases::LeaseState`): the record without its token, and whether it is live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeaseState {
    pub name: String,
    pub epoch: u64,
    pub holder: WriteOrigin,
    pub acquired_at_us: i64,
    pub renewed_at_us: i64,
    pub expires_at_us: i64,
    pub released: bool,
    pub live: bool,
}

/// Why a fence was refused (`gbrain_store::leases::LostReason`, the `lease_lost` reason).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LostReason {
    /// No lease record carries the name.
    NotFound,
    /// The epoch or token moved: someone took the lease over.
    EpochMoved,
    /// The holder released it.
    Released,
    /// It expired and was not renewed.
    Expired,
    /// A protected entry point on a multi-user store was called without a fence.
    FenceMissing,
    /// The claim was taken under another lease name or epoch than the fence shows.
    ClaimEpochMismatch,
}

impl LostReason {
    pub const ALL: [LostReason; 6] = [
        LostReason::NotFound,
        LostReason::EpochMoved,
        LostReason::Released,
        LostReason::Expired,
        LostReason::FenceMissing,
        LostReason::ClaimEpochMismatch,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            LostReason::NotFound => "not_found",
            LostReason::EpochMoved => "epoch_moved",
            LostReason::Released => "released",
            LostReason::Expired => "expired",
            LostReason::FenceMissing => "fence_missing",
            LostReason::ClaimEpochMismatch => "claim_epoch_mismatch",
        }
    }
}

/// The `lease_lost` code (`gbrain_store::error::LEASE_LOST`).
pub const LEASE_LOST: &str = "lease_lost";

/// `lease_lost`. The message is JSON: `{ reason, name, epoch, current_epoch }`.
pub fn lease_lost(reason: LostReason, name: &str, epoch: u64, current: Option<u64>) -> StoreError {
    StoreError::new(
        LEASE_LOST,
        json!({ "reason": reason.as_str(), "name": name, "epoch": epoch, "current_epoch": current })
            .to_string(),
    )
}

/// The `lease_lost` reason of an error, when it is one.
pub fn lost_reason(error: &StoreError) -> Option<String> {
    if error.code != LEASE_LOST {
        return None;
    }
    serde_json::from_str::<Value>(&error.message)
        .ok()
        .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_owned))
}

/// Claim families whose claims record an epoch (`gbrain_store::leases::CLAIM_*`).
pub const CLAIM_JOB: u8 = 0x01;
pub const CLAIM_WRITE: u8 = 0x02;
pub const CLAIM_EFFECT: u8 = 0x03;
pub const CLAIM_DRAIN_LEASE: u8 = 0x04;
pub const CLAIM_CYCLE_LOCK: u8 = 0x05;

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
    /// I-1 / I-5 `Store::assert_lease(&self, token: &LeaseToken) -> Result<()>`: on a store bound to a transaction (`MuTxn`
    /// derefs to one) a statement that reads the lease record into the transaction, so the check holds at its commit;
    /// on the brain's own store a check against the latest snapshot. `lease_lost` when the token does not hold its lease.
    /// Owner: L5.
    fn assert_lease(&self, token: &LeaseToken) -> MuResult<()>;
    /// I-5 `Store::acquire_lease(&self, name, holder, ttl_ms) -> Result<Option<LeaseToken>>`
    /// (every takeover increments the epoch). Owner: L5.
    fn acquire_lease(
        &self,
        name: &str,
        holder: &WriteOrigin,
        ttl_ms: u64,
    ) -> MuResult<Option<LeaseToken>>;
    /// I-5 `Store::renew_lease(&self, token: &LeaseToken, ttl_ms: u64) -> Result<()>`: `lease_lost` when the epoch or
    /// token moved, the lease was released, or it expired on the store clock (an expired holder takes it again with
    /// `acquire_lease`, under a new epoch).
    fn renew_lease(&self, token: &LeaseToken, ttl_ms: u64) -> MuResult<()>;
    /// I-5 `Store::release_lease(&self, token: &LeaseToken) -> Result<()>`; a stale or unknown token changes nothing.
    fn release_lease(&self, token: &LeaseToken) -> MuResult<()>;
    /// I-5 `Store::read_lease(&self, name: &str) -> Result<Option<LeaseState>>`.
    fn read_lease(&self, name: &str) -> MuResult<Option<LeaseState>>;
    /// `leases::record_claim_epoch`: claim `id` of `family` was taken under `fence`. The real function takes a write
    /// handle that no public store member lends, so this is the member the claims lane has to expose.
    fn record_claim_epoch(&self, family: u8, id: &str, fence: &LeaseToken) -> MuResult<()>;
    /// `leases::check_fence`'s rule on a store opened in multi-user mode (`OpenOptions::multiuser` on the hosts branch): a
    /// protected entry point (`what`) called with no fence fails `lease_lost` / `fence_missing`; with one it asserts it.
    /// The real function takes a read handle no public member lends, so this is the member the claims lane exposes.
    fn check_fence(&self, fence: Option<&LeaseToken>, what: &str) -> MuResult<()>;
    /// `claim_effects` under a fence: claims the next claimable effect of `host` and records the claim under `fence`
    /// (`record_claim_epoch`, family `CLAIM_EFFECT`), and takes back an effect whose claiming lease has expired or moved
    /// to another epoch (the dead host's claim). `None` when nothing is claimable. The claims lane exposes the member.
    fn claim_effect_with_fence(&self, host: &str, fence: &LeaseToken) -> MuResult<Option<Value>>;
    /// `settle_effect` under a fence: first `check_fence` (a stale fence is `lease_lost`), then the claim's epoch
    /// (`claim_epoch_mismatch`), then the settle itself. The claims lane exposes the member.
    fn settle_effect_with_fence(
        &self,
        kind: Settle,
        settle: &EffectSettle,
        fence: &LeaseToken,
    ) -> MuResult<bool>;
    /// A follower applies the given commit records, in order, to its own brain and returns the position of the last one
    /// (`None` for no records). Stand-in for the log-apply step; owner: L2.
    fn apply_log(&self, records: &[CommitRecord]) -> MuResult<Option<CommitPosition>>;
    /// `leases::check_claim_epoch`: fails `lease_lost` / `claim_epoch_mismatch` unless claim `id` of `family` was taken
    /// under `fence`'s lease name and epoch (a claim with no record refuses too).
    fn check_claim_epoch(&self, family: u8, id: &str, fence: &LeaseToken) -> MuResult<()>;
    /// I-4.v2 `Store::last_commit_time(&self) -> Result<Option<i64>>`: the commit time of the newest commit, read from `M\0ctime`
    /// (written only while the multi-user switch is on); the clock floor at open. Owner: L2.
    fn last_commit_time(&self) -> MuResult<Option<i64>>;
    /// A follower that applied the log up to `applied` and takes over as primary: opens its clock at the floor
    /// `clock_floor(its M\0ctime, the last applied record)` and returns that floor. Stand-in for the promotion step; owners:
    /// L2 (the log) and L5 (the election).
    fn promote_from_log(&self, applied: Option<CommitPosition>) -> MuResult<Option<i64>>;
    /// I-4 `Store::read_commit_log(&self, after: Option<CommitPosition>, max: usize) -> Result<LogPage>`.
    /// Owner: L2.
    fn read_commit_log(&self, after: Option<CommitPosition>, max: usize) -> MuResult<LogPage>;
}

impl MuStore for Store {
    /// SHIM, not served: `begin_with` has not landed. This is today's explicit transaction (`begin_transaction`), which holds
    /// the writer, so `TxnOptions` (mode, deadline, origin) is ignored and two of these never overlap.
    fn begin_with(&self, _opts: TxnOptions) -> MuResult<MuTxn> {
        Ok(MuTxn::from_store(self.begin_transaction(false)?))
    }
    fn single_flight(&self, _txn: &MuTxn, _keys: &[SingleFlightKey]) -> MuResult<()> {
        pending(L1_TXN, "Store::single_flight")
    }
    /// Served: `Store::commit_transaction_at` returns the commit's own position.
    fn commit_position(&self, txn: MuTxn) -> MuResult<CommitPosition> {
        txn.commit_transaction_at()
    }
    fn assert_lease(&self, _token: &LeaseToken) -> MuResult<()> {
        pending(L5_HOSTS, "Store::assert_lease")
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
    fn read_lease(&self, _name: &str) -> MuResult<Option<LeaseState>> {
        pending(L5_HOSTS, "Store::read_lease")
    }
    fn record_claim_epoch(&self, _family: u8, _id: &str, _fence: &LeaseToken) -> MuResult<()> {
        pending(L5_HOSTS, "leases::record_claim_epoch (claim under a fence)")
    }
    fn claim_effect_with_fence(&self, _host: &str, _fence: &LeaseToken) -> MuResult<Option<Value>> {
        pending(
            L5_HOSTS,
            "claim_effects under a fence (a claim of an expired lease is taken back)",
        )
    }
    fn settle_effect_with_fence(
        &self,
        _kind: Settle,
        _settle: &EffectSettle,
        _fence: &LeaseToken,
    ) -> MuResult<bool> {
        pending(L5_HOSTS, "settle_effect under a fence")
    }
    fn apply_log(&self, _records: &[CommitRecord]) -> MuResult<Option<CommitPosition>> {
        pending(L2_LOG, "apply commit records to a follower")
    }
    fn check_fence(&self, _fence: Option<&LeaseToken>, _what: &str) -> MuResult<()> {
        pending(
            L5_HOSTS,
            "leases::check_fence (a protected write with no fence)",
        )
    }
    fn check_claim_epoch(&self, _family: u8, _id: &str, _fence: &LeaseToken) -> MuResult<()> {
        pending(L5_HOSTS, "leases::check_claim_epoch (claim under a fence)")
    }
    fn last_commit_time(&self) -> MuResult<Option<i64>> {
        Store::last_commit_time(self)
    }
    fn promote_from_log(&self, _applied: Option<CommitPosition>) -> MuResult<Option<i64>> {
        pending(
            L2_LOG,
            "promote a follower from the log (clock floor = max(M\\0ctime, last applied commit_time)); election: L5 hosts",
        )
    }
    fn read_commit_log(&self, after: Option<CommitPosition>, max: usize) -> MuResult<LogPage> {
        Store::read_commit_log(self, after, max)
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
/// the single-writer or the optimistic store. Served by the commit-log lane (`OpenOptions::multiuser_writes`).
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
    let options = OpenOptions {
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
    };
    let store = Store::open_kv(kv.clone(), env, options)?;
    Ok(LoggedBrain { kv, store })
}

/// A closed logged brain that the next open must write to without any caller: `OlderBase` is one whose records are at an older
/// base format (its upgrade runs at open), `UpkeepOnly` one at the current format whose open-time markers are gone (the
/// access-flag scan, the keyword index reset and the source-index backfill run at open). Returns the image of the closed brain,
/// the starting copy a replay of the open's log records must turn into the opened brain. Built as the commit-log lane's own test
/// builds its base-7 brain (the log is re-pinned after the hand edits, which are the starting copy, not logged changes).
pub fn logged_brain_needing_upkeep(
    path: &Path,
    optimistic: bool,
    kind: UpkeepKind,
) -> MuResult<Image> {
    {
        let brain = open_logged(
            path,
            optimistic,
            Arc::new(gbrain_store::SystemEnv),
            "d0000000-0000-4000-8000-0000000000d1",
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
        &[b'3'],
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
    Ok(image_of(&kv))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpkeepKind {
    OlderBase,
    UpkeepOnly,
}
