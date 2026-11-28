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
//! A store whose records never held one (every product store) is never armed and does exactly what it did before.
//!
//! Nothing here judges whether ANOTHER machine still writes: a replica cannot know about a renewal it never applied.
//! That is the promotion's rule (`follower.rs`, `Follower::promote_with`), and a partition-safe answer is phase M4.

use crate::Store;
use crate::commit_log::CommitFence;
use crate::error::{LEASE_LOST, Result, StoreError};
use crate::kv::KvRead;
use crate::leases::{LeaseToken, assert_held, read_lease_record};
use crate::write_origin::WriteOrigin;
use std::cell::Cell;
use std::sync::Mutex;

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

thread_local! {
    /// Set while this thread runs the lease writes of `serve_as_primary` / `release_primary`, which must pass a store
    /// that is not (yet, or any more) armed.
    static SERVING: Cell<bool> = const { Cell::new(false) };
}

struct Serving;

impl Serving {
    fn open() -> Serving {
        SERVING.with(|s| s.set(true));
        Serving
    }
}

impl Drop for Serving {
    fn drop(&mut self) {
        SERVING.with(|s| s.set(false));
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

impl Store {
    /// The primary token every write of this store must hold, or `None` when its writes are not fenced. Refuses a store
    /// that must not write (`PrimaryState::Lost`).
    pub(crate) fn primary_fence(&self) -> Result<Option<LeaseToken>> {
        if SERVING.with(Cell::get) {
            return Ok(None);
        }
        match self.primary.get() {
            PrimaryState::NeverArmed => Ok(None),
            PrimaryState::Armed(token) => Ok(Some(token)),
            PrimaryState::Lost(reason) => Err(not_served(reason)),
        }
    }

    /// Inside a write transaction: `lease_lost` unless `token` holds the primary lease now; the lease's end, for the
    /// commit's fence. The lease record is in the transaction's read set, so a renewal, release or takeover committed
    /// first makes this write conflict and run again.
    pub(crate) fn primary_commit_fence(
        &self,
        read: &dyn KvRead,
        token: &LeaseToken,
    ) -> Result<CommitFence> {
        assert_held(read, token, self.env.clock_micros())?;
        let record = read_lease_record(read, &token.name)?.ok_or_else(|| {
            StoreError::new(
                crate::error::STORE_CORRUPT,
                "the primary lease record vanished inside the write",
            )
        })?;
        Ok(CommitFence {
            name: token.name.clone(),
            epoch: token.epoch,
            expires_at_us: record.expires_at_us,
        })
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
        let token = {
            let _serving = Serving::open();
            self.acquire_lease(PRIMARY_LEASE, holder, ttl_ms)?
        };
        if let Some(token) = &token {
            self.primary.set(PrimaryState::Armed(token.clone()));
        }
        Ok(token)
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
        let _serving = Serving::open();
        self.release_lease(&token)
    }

    /// The primary token this store writes under, when it serves as primary.
    pub fn primary_token(&self) -> Option<LeaseToken> {
        match self.primary.get() {
            PrimaryState::Armed(token) => Some(token),
            _ => None,
        }
    }
}
