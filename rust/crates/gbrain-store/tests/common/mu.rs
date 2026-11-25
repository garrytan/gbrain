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

use gbrain_store::{Store, StoreError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::ops::Deref;
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

/// I-3, as `write_origin.rs` has it on the hosts branch (`gbrain_store::write_origin::WriteOrigin`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteOrigin {
    pub host_id: String,
    pub incarnation: String,
    pub writer_id: String,
}

impl WriteOrigin {
    /// Refuses an empty field, a field with NUL or a field longer than 512 bytes.
    pub fn check(&self) -> gbrain_store::Result<()> {
        for (name, value) in [
            ("host_id", &self.host_id),
            ("incarnation", &self.incarnation),
            ("writer_id", &self.writer_id),
        ] {
            if value.is_empty() || value.len() > 512 || value.contains('\0') {
                return Err(StoreError::invalid(format!(
                    "write origin {name} must be 1 to 512 bytes of text without NUL"
                )));
            }
        }
        Ok(())
    }
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
#[derive(Copy, Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
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

/// One operation of a commit record (I-4: op u8, key, operand; the operand is the full value for a put, never a reference).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitOp {
    /// 1 put, 2 delete, 3 add_i64, 4 raise_counter.
    pub op: u8,
    pub key: Vec<u8>,
    pub operand: Vec<u8>,
}

/// A commit record as I-4.v2 lays it out, decoded: the position it sits at, who wrote it, its commit time, the request ids and
/// the ops. JSON form (wire, tests) adds `commit_time_us`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitRecord {
    /// The record version; only 2 is read.
    pub version: u8,
    pub position: CommitPosition,
    pub origin: WriteOrigin,
    /// Microseconds since the Unix epoch, UTC; strictly rises in position order across the whole log.
    pub commit_time_us: i64,
    pub write_ids: Vec<String>,
    pub ops: Vec<CommitOp>,
}

fn put_str(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s);
}

impl CommitRecord {
    /// The v2 value: `[2][host_id][incarnation][writer_id][commit_time i64 BE][write_ids: u32 BE count, each length-prefixed]
    /// [ops: u32 BE count, each: op u8, key, operand]`, every string or byte run a u32 BE length then its bytes.
    pub fn encode_v2(&self) -> Vec<u8> {
        let mut out = vec![2u8];
        for field in [
            &self.origin.host_id,
            &self.origin.incarnation,
            &self.origin.writer_id,
        ] {
            put_str(&mut out, field.as_bytes());
        }
        out.extend_from_slice(&self.commit_time_us.to_be_bytes());
        out.extend_from_slice(&(self.write_ids.len() as u32).to_be_bytes());
        for id in &self.write_ids {
            put_str(&mut out, id.as_bytes());
        }
        out.extend_from_slice(&(self.ops.len() as u32).to_be_bytes());
        for op in &self.ops {
            out.push(op.op);
            put_str(&mut out, &op.key);
            put_str(&mut out, &op.operand);
        }
        out
    }

    /// Reads a v2 value at `position`. Any other version, version 1 included, is `format_unknown`, not corruption; a short or
    /// overlong value is `store_corrupt`.
    pub fn decode_v2(position: CommitPosition, bytes: &[u8]) -> gbrain_store::Result<CommitRecord> {
        fn corrupt() -> StoreError {
            StoreError::new("store_corrupt", "a commit record is cut short")
        }
        fn take<'a>(b: &mut &'a [u8], n: usize) -> gbrain_store::Result<&'a [u8]> {
            if b.len() < n {
                return Err(corrupt());
            }
            let (head, tail) = b.split_at(n);
            *b = tail;
            Ok(head)
        }
        fn u32_be(b: &mut &[u8]) -> gbrain_store::Result<u32> {
            Ok(u32::from_be_bytes(take(b, 4)?.try_into().unwrap()))
        }
        fn run<'a>(b: &mut &'a [u8]) -> gbrain_store::Result<&'a [u8]> {
            let n = u32_be(b)? as usize;
            take(b, n)
        }
        fn text(b: &mut &[u8]) -> gbrain_store::Result<String> {
            String::from_utf8(run(b)?.to_vec()).map_err(|_| corrupt())
        }
        let mut b = bytes;
        let version = take(&mut b, 1)?[0];
        if version != 2 {
            return Err(StoreError::new(
                "format_unknown",
                format!("a commit record of version {version}; only 2 is read"),
            ));
        }
        let origin = WriteOrigin {
            host_id: text(&mut b)?,
            incarnation: text(&mut b)?,
            writer_id: text(&mut b)?,
        };
        let commit_time_us = i64::from_be_bytes(take(&mut b, 8)?.try_into().unwrap());
        let mut write_ids = Vec::new();
        for _ in 0..u32_be(&mut b)? {
            write_ids.push(text(&mut b)?);
        }
        let mut ops = Vec::new();
        for _ in 0..u32_be(&mut b)? {
            let op = take(&mut b, 1)?[0];
            ops.push(CommitOp {
                op,
                key: run(&mut b)?.to_vec(),
                operand: run(&mut b)?.to_vec(),
            });
        }
        if !b.is_empty() {
            return Err(corrupt());
        }
        Ok(CommitRecord {
            version,
            position,
            origin,
            commit_time_us,
            write_ids,
            ops,
        })
    }
}

/// `LogPage { records, oldest_retained, newest, snapshot_required }`. The interface list leaves the position field types
/// open; positions are `Option<CommitPosition>`. Records are decoded I-4.v2 records.
#[derive(Clone, Debug, Default)]
pub struct LogPage {
    pub records: Vec<CommitRecord>,
    pub oldest_retained: Option<CommitPosition>,
    pub newest: Option<CommitPosition>,
    pub snapshot_required: bool,
}

/// The clock floor of a server that takes over as primary from the log (I-4.v2): the larger of its own `M\0ctime` and the last
/// applied record's commit time. `None` when there is neither.
pub fn clock_floor(local_ctime: Option<i64>, last_applied: Option<&CommitRecord>) -> Option<i64> {
    match (local_ctime, last_applied.map(|r| r.commit_time_us)) {
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
    fn begin_with(&self, _opts: TxnOptions) -> MuResult<MuTxn> {
        pending(L1_TXN, "Store::begin_with")
    }
    fn single_flight(&self, _txn: &MuTxn, _keys: &[SingleFlightKey]) -> MuResult<()> {
        pending(L1_TXN, "Store::single_flight")
    }
    fn commit_position(&self, _txn: MuTxn) -> MuResult<CommitPosition> {
        pending(L2_LOG, "Transaction::commit -> CommitPosition")
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
        pending(L2_LOG, "Store::last_commit_time")
    }
    fn promote_from_log(&self, _applied: Option<CommitPosition>) -> MuResult<Option<i64>> {
        pending(
            L2_LOG,
            "promote a follower from the log (clock floor = max(M\\0ctime, last applied commit_time)); election: L5 hosts",
        )
    }
    fn read_commit_log(&self, _after: Option<CommitPosition>, _max: usize) -> MuResult<LogPage> {
        pending(L2_LOG, "Store::read_commit_log")
    }
}

/// Stand-in for a step a lane owns that has no member yet (the server, host election, and so on).
pub fn pending_member<T>(owner: &'static str, member: &'static str) -> MuResult<T> {
    pending(owner, member)
}
