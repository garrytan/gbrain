//! The primary's write fence (lane L2; design note "M3", "Hosts and fencing"; `takeover.rs`, `follower.rs`).
//!
//! A store that serves as the primary of a brain holds the lease [`PRIMARY_LEASE`] (lane L5's leases, unchanged) and
//! writes only while it holds it. [`Store::serve_as_primary`] takes the lease and arms the fence; from then on every
//! write of the store (its own writes, its bound transactions, its keyword index builder) checks the lease inside its
//! own write transaction, and the record file accepts the commit only while its commit time is before the lease's end
//! (`commit_log::CommitFence`, checked in the pipeline's batch write and in the single-writer commit). So once the
//! lease lapses, is released, or another holder takes it at a new epoch, the old primary's writes are refused with
//! `lease_lost` and write nothing.
//!
//! The fence lives in the open store, so a store opened on records that hold a primary lease record starts
//! fail-closed: its writes are refused (`lease_lost`, reason `primary_not_served`) until it serves as primary again.
//! Such an open writes nothing either: its open-time upkeep (the sweep-record index backfill, the keyword index
//! repair, the access flag scan) waits for `serve_as_primary`, which runs it right after it takes the lease and
//! before it arms the fence, and an open that would have to upgrade the format or switch the brain to the log is
//! refused with the same reason. A store whose records never held one (every product store) is never armed and does
//! exactly what it did before.
//!
//! The check runs at every commit, not only at every statement: a transaction's commit reads the lease again inside
//! the commit (`transactions.rs`), and the id-sequence write of a refused or rolled-back transaction carries the same
//! fence or, when the store must not write, is skipped (multi-user mode reserves every id range on disk before it
//! hands an id out, so no id is reused).
//!
//! Nothing here judges whether ANOTHER machine still writes: a replica cannot know about a renewal it never applied.
//! That is the promotion's rule (`follower.rs`, `Follower::promote_with`), and a partition-safe answer is phase M4.

use crate::Store;
use crate::commit_log::CommitFence;
use crate::env::Env;
use crate::error::{LEASE_LOST, Result, StoreError};
use crate::kv::KvRead;
use crate::leases::{LeaseToken, assert_held, read_lease_record};
use crate::write_origin::WriteOrigin;
use std::sync::{Arc, Mutex};

pub use crate::takeover::PRIMARY_LEASE;

/// The `lease_lost` reason of a write on a store that was opened on a brain with a primary lease and has not taken it.
pub const PRIMARY_NOT_SERVED: &str = "primary_not_served";

/// Where a store stands as primary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PrimaryState {
    /// It never served and its records held no primary lease at open: writes are not fenced.
    NeverArmed,
    /// It holds the primary lease under this token: every write is fenced by it.
    Armed(LeaseToken),
    /// It must not write until it serves again: `released` (it handed over), or `primary_not_served` (opened on a
    /// brain with a primary lease).
    Lost(&'static str),
}

/// The fence state one open store shares with its bound stores and its builder.
#[derive(Debug)]
pub(crate) struct PrimarySlot(Mutex<PrimaryState>);

impl PrimarySlot {
    pub(crate) fn new(state: PrimaryState) -> Self {
        PrimarySlot(Mutex::new(state))
    }

    fn get(&self) -> PrimaryState {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn set(&self, state: PrimaryState) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = state;
    }
}

/// What a write consults for its commit's fence: the store's primary state, and the clock its lease is judged on. A
/// transaction keeps one from its begin, so its commit and its rollback are fenced like any write of the store.
#[derive(Clone)]
pub(crate) struct Fencer {
    slot: Arc<PrimarySlot>,
    env: Arc<dyn Env>,
}

impl Fencer {
    /// Inside a write: `None` when the store's writes are not fenced, the fence of the lease it holds now, or
    /// `lease_lost` when it must not write (its state, or a lease it no longer holds). The lease record joins the
    /// write's read set, so a renewal, release or takeover committed first makes the write conflict and run again.
    pub(crate) fn fence(&self, read: &dyn KvRead) -> Result<Option<CommitFence>> {
        match self.slot.get() {
            PrimaryState::NeverArmed => Ok(None),
            PrimaryState::Lost(reason) => Err(not_served(reason)),
            PrimaryState::Armed(token) => {
                assert_held(read, &token, self.env.clock_micros())?;
                let record = read_lease_record(read, &token.name)?.ok_or_else(|| {
                    StoreError::new(
                        crate::error::STORE_CORRUPT,
                        "the primary lease record vanished inside the write",
                    )
                })?;
                Ok(Some(CommitFence {
                    name: token.name.clone(),
                    epoch: token.epoch,
                    expires_at_us: record.expires_at_us,
                }))
            }
        }
    }

    /// The fence of a transaction's commit, read inside its base. Only the holder is judged here; the time is left
    /// to the record file (`CommitFence::admit`, after its conflict checks), so a lease renewed after an optimistic
    /// snapshot makes the commit conflict instead of being refused on the old lease end. `snapshot` is true for an
    /// optimistic base, which reads the state the transaction began on: there a lease record that is not this store's
    /// lease cannot tell a lost lease from a newer one, so the commit conflicts and a rerun judges the lease as it is
    /// then. A serialized base reads the latest state: there the store is not the holder and the commit is refused.
    pub(crate) fn fence_at_commit(
        &self,
        read: &dyn KvRead,
        snapshot: bool,
    ) -> Result<Option<CommitFence>> {
        let PrimaryState::Armed(token) = self.slot.get() else {
            return self.fence(read);
        };
        match read_lease_record(read, &token.name)? {
            Some(record)
                if record.epoch == token.epoch
                    && record.token == token.token
                    && !record.released =>
            {
                Ok(Some(CommitFence {
                    name: token.name.clone(),
                    epoch: token.epoch,
                    expires_at_us: record.expires_at_us,
                }))
            }
            _ if snapshot => Err(StoreError::new(
                crate::error::WRITE_CONFLICT,
                "the transaction's snapshot predates the primary lease this store holds now: run it again",
            )),
            _ => {
                // `assert_held` names why (judged at the start of time: never as expired, which is the commit's).
                assert_held(read, &token, i64::MIN)?;
                Err(not_served("epoch_moved"))
            }
        }
    }
}

/// The state a store opened on `read` starts in.
pub(crate) fn state_at_open(read: &dyn KvRead) -> Result<PrimaryState> {
    Ok(match read_lease_record(read, PRIMARY_LEASE)? {
        Some(_) => PrimaryState::Lost(PRIMARY_NOT_SERVED),
        None => PrimaryState::NeverArmed,
    })
}

fn not_served(reason: &str) -> StoreError {
    StoreError::new(
        LEASE_LOST,
        serde_json::json!({ "reason": reason, "name": PRIMARY_LEASE, "epoch": null, "current_epoch": null })
            .to_string(),
    )
}

/// The refusal of an open that would have to write (`what`) on records that hold a primary lease: it would write
/// before the store serves as primary. Open the brain read-only, or promote a follower.
pub(crate) fn not_served_open(what: &str) -> StoreError {
    StoreError::new(
        LEASE_LOST,
        serde_json::json!({
            "reason": PRIMARY_NOT_SERVED,
            "name": PRIMARY_LEASE,
            "epoch": null,
            "current_epoch": null,
            "detail": format!("this brain holds a primary lease, and opening it would {what}: a store that does not serve as primary writes nothing"),
        })
        .to_string(),
    )
}

impl Store {
    /// The fence every write of this store, its bound stores and its builder consults (`Fencer::fence`).
    pub(crate) fn fencer(&self) -> Fencer {
        Fencer {
            slot: self.primary.clone(),
            env: self.env.clone(),
        }
    }

    /// A store on the same records whose writes are not fenced: the lease writes of `serve_as_primary` and
    /// `release_primary`, which must pass a store that is not (yet, or any more) armed. Only those two use it, and
    /// only for that one write; no other store or thread is affected.
    fn unfenced(&self) -> Store {
        let mut store = self.sibling();
        store.primary = Arc::new(PrimarySlot::new(PrimaryState::NeverArmed));
        store
    }

    /// Takes the primary lease ([`PRIMARY_LEASE`], lane L5's `acquire_lease`) and arms the write fence: from now on
    /// every write of this store, its bound stores and its builder is refused once the lease is not held. Multi-user
    /// mode with the commit log only. `None` while another holder's lease is live (never an error, as
    /// `acquire_lease`).
    pub fn serve_as_primary(
        &self,
        holder: &WriteOrigin,
        ttl_ms: u64,
    ) -> Result<Option<LeaseToken>> {
        if !(self.multiuser() && self.info().commit_log) {
            return Err(StoreError::new(
                crate::error::INVALID_STATE,
                "only a multi-user store with the commit log serves as a primary (GBRAIN_RUST_MULTIUSER=1, GBRAIN_RUST_COMMIT_LOG=1)",
            ));
        }
        if self.bound.is_some() {
            return Err(StoreError::new(
                crate::error::INVALID_STATE,
                "a store bound to a transaction cannot start serving as a primary",
            ));
        }
        let Some(token) = self
            .unfenced()
            .acquire_lease(PRIMARY_LEASE, holder, ttl_ms)?
        else {
            return Ok(None);
        };
        // The open-time upkeep a fail-closed open left (`open_kv_in`), before the first write is admitted. It writes
        // derived records only, unfenced, right after the lease was taken. A failure hands the lease back.
        let needs_build = match self.finish_open_upkeep() {
            Ok(needs_build) => needs_build,
            Err(e) => {
                let _ = self.unfenced().release_lease(&token);
                return Err(e);
            }
        };
        self.primary.set(PrimaryState::Armed(token.clone()));
        if needs_build && self.runs_builder {
            self.start_keyword_index_builder();
        }
        Ok(Some(token))
    }

    /// Renews the primary lease this store holds (lane L5's `renew_lease`); the fence keeps the same token.
    pub fn renew_primary(&self, ttl_ms: u64) -> Result<()> {
        match self.primary.get() {
            PrimaryState::Armed(token) => self.renew_lease(&token, ttl_ms),
            PrimaryState::NeverArmed => Err(StoreError::new(
                crate::error::INVALID_STATE,
                "this store does not serve as a primary",
            )),
            PrimaryState::Lost(reason) => Err(not_served(reason)),
        }
    }

    /// Hands the primary lease over (lane L5's `release_lease`): a follower that applied the release may promote at
    /// once. From then on this store refuses every write (`lease_lost`, reason `released`) until it serves again.
    pub fn release_primary(&self) -> Result<()> {
        let PrimaryState::Armed(token) = self.primary.get() else {
            return Err(StoreError::new(
                crate::error::INVALID_STATE,
                "this store does not hold the primary lease",
            ));
        };
        // Refused from here on, whatever the release returns: a failed release must not leave a primary writing.
        self.primary.set(PrimaryState::Lost("released"));
        self.unfenced().release_lease(&token)
    }

    /// The primary token this store writes under, when it serves as primary.
    pub fn primary_token(&self) -> Option<LeaseToken> {
        match self.primary.get() {
            PrimaryState::Armed(token) => Some(token),
            _ => None,
        }
    }
}
