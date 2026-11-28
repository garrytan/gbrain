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
use crate::kv::{Kv, KvRead, KvWrite};
use crate::leases::{LeaseToken, assert_held, read_lease_record};
use crate::write_origin::WriteOrigin;
use std::sync::{Arc, Mutex};

pub use crate::takeover::PRIMARY_LEASE;

/// The `lease_lost` reason of a write on a store that was opened on a brain with a primary lease and has not taken it.
pub const PRIMARY_NOT_SERVED: &str = "primary_not_served";

/// Where a store stands as primary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PrimaryState {
    /// A store without the commit log, read-only, or the lease writes of `serve_as_primary` / `release_primary`
    /// (`Store::unfenced`): writes are not fenced and read nothing more.
    Unwatched,
    /// A logged store that never served, on records that held no primary lease at open. Its writes are not fenced
    /// while the records hold no primary lease: each write reads the lease record, so a lease taken first makes it
    /// conflict (or, once written, refuses it).
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

/// What a write consults for its commit's fence: the store's primary state, the clock its lease is judged on, and the
/// records (for the latest lease, when an optimistic commit's snapshot cannot tell). A transaction keeps one from its
/// begin, so its commit and its rollback are fenced like any write of the store.
#[derive(Clone)]
pub(crate) struct Fencer {
    slot: Arc<PrimarySlot>,
    env: Arc<dyn Env>,
    kv: Arc<dyn Kv>,
}

/// Inside a write: `lease_lost` unless `token` holds the primary lease now; the commit's fence otherwise.
fn token_fence(read: &dyn KvRead, token: &LeaseToken, now: i64) -> Result<CommitFence> {
    assert_held(read, token, now)?;
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

/// True when `record` is the lease `token` took, not released.
fn holds(record: Option<&crate::leases::LeaseRecord>, token: &LeaseToken) -> bool {
    record.is_some_and(|r| r.epoch == token.epoch && r.token == token.token && !r.released)
}

impl Fencer {
    /// Inside a write: `None` when the store's writes are not fenced, the fence of the lease it holds now, or
    /// `lease_lost` when it must not write (its state, or a lease it no longer holds). The lease record joins the
    /// write's read set, so a renewal, release or takeover committed first makes the write conflict and run again.
    pub(crate) fn fence(&self, read: &dyn KvRead) -> Result<Option<CommitFence>> {
        match self.slot.get() {
            PrimaryState::Unwatched => Ok(None),
            // The read puts the lease record in the write's read set: a lease taken after it conflicts the write.
            PrimaryState::NeverArmed => match read_lease_record(read, PRIMARY_LEASE)? {
                None => Ok(None),
                Some(_) => Err(not_served(PRIMARY_NOT_SERVED)),
            },
            PrimaryState::Lost(reason) => Err(not_served(reason)),
            PrimaryState::Armed(token) => {
                token_fence(read, &token, self.env.clock_micros()).map(Some)
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
        let record = read_lease_record(read, &token.name)?;
        if let Some(record) = record.as_ref().filter(|r| holds(Some(r), &token)) {
            return Ok(Some(CommitFence {
                name: token.name.clone(),
                epoch: token.epoch,
                expires_at_us: record.expires_at_us,
            }));
        }
        // Not the holder in what the base reads. An optimistic snapshot may only predate the lease: if the latest
        // records still hold it, the commit conflicts and a rerun reads it; otherwise the lease is gone.
        let latest = if snapshot {
            Some(self.kv.snapshot()?)
        } else {
            None
        };
        if let Some(latest) = &latest
            && holds(read_lease_record(&**latest, &token.name)?.as_ref(), &token)
        {
            return Err(StoreError::new(
                crate::error::WRITE_CONFLICT,
                "the transaction's snapshot predates the primary lease this store holds now: run it again",
            ));
        }
        // `assert_held` names why (judged at the start of time: never as expired, which is the commit's).
        let now = latest.as_deref().map_or(read, |l| l as &dyn KvRead);
        assert_held(now, &token, i64::MIN)?;
        Err(not_served("epoch_moved"))
    }
}

#[cfg(test)]
thread_local! {
    /// Test seam: runs in `serve_as_primary` right after the lease is taken, before the open-time upkeep.
    pub(crate) static AFTER_ACQUIRE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        std::cell::RefCell::new(None);
}

fn after_acquire() {
    #[cfg(test)]
    if let Some(hook) = AFTER_ACQUIRE.with(|h| h.borrow_mut().take()) {
        hook();
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
            kv: self.kv.clone(),
        }
    }

    /// The hook the open-time upkeep runs before each of its commits while `serve_as_primary` finishes it: the commit
    /// carries the fence of `token` (read inside the commit, judged at its accept), so upkeep that outlives the lease
    /// is refused and stops.
    fn upkeep_fence<'t>(
        &self,
        token: &'t LeaseToken,
    ) -> impl Fn(&mut dyn KvWrite) -> Result<()> + 't {
        let env = self.env.clone();
        move |w: &mut dyn KvWrite| {
            let fence = token_fence(&*w, token, env.clock_micros())?;
            w.set_commit_meta(crate::commit_log::CommitMeta {
                fence: Some(Box::new(fence)),
                ..Default::default()
            });
            Ok(())
        }
    }

    /// A store on the same records whose writes are not fenced: the lease writes of `serve_as_primary` and
    /// `release_primary`, which must pass a store that is not (yet, or any more) armed. Only those two use it, and
    /// only for that one write; no other store or thread is affected.
    fn unfenced(&self) -> Store {
        let mut store = self.sibling();
        store.primary = Arc::new(PrimarySlot::new(PrimaryState::Unwatched));
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
        // The single-writer record adapter keeps no durable id reservation, so a transaction the fence refuses could
        // not keep its ids from being handed out again: only the concurrent store serves (ruling B).
        if self.kv.occ_stats().is_none() {
            return Err(StoreError::new(
                crate::error::INVALID_STATE,
                "only the concurrent record store serves as a primary: open the brain with GBRAIN_RUST_CONCURRENT_WRITES=1 or in multi-user mode (GBRAIN_RUST_MULTIUSER=1)",
            ));
        }
        let previous = self.primary.get();
        // Fail-closed from here until the lease is held and the upkeep done, and so on every failure below: the
        // records hold a primary lease record from the acquisition on (ours, or the live holder's).
        self.primary.set(PrimaryState::Lost(PRIMARY_NOT_SERVED));
        // A store that took no lease goes back to where it was: a never-armed store reads the lease record in every
        // write, so it refuses writes once the records hold one.
        let token = match self.unfenced().acquire_lease(PRIMARY_LEASE, holder, ttl_ms) {
            Ok(Some(token)) => token,
            other => {
                self.primary.set(previous);
                return other;
            }
        };
        after_acquire();
        // The open-time upkeep a fail-closed open left (`open_kv_in`), before the first write is admitted. Each of
        // its commits carries this lease's fence. A failure hands the lease back.
        let needs_build = match self.finish_open_upkeep(&self.upkeep_fence(&token)) {
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
            PrimaryState::Unwatched | PrimaryState::NeverArmed => Err(StoreError::new(
                crate::error::INVALID_STATE,
                "this store does not serve as a primary",
            )),
            PrimaryState::Lost(reason) => Err(not_served(reason)),
        }
    }

    /// Hands the primary lease over (lane L5's `release_lease`): a follower that applied the release may promote at
    /// once. From then on this store refuses every write (`lease_lost`, reason `released`) until it serves again.
    pub fn release_primary(&self) -> Result<()> {
        // A transaction's store would wait on its own transaction's writer: refused before anything changes.
        if self.bound.is_some() {
            return Err(StoreError::new(
                crate::error::INVALID_STATE,
                "a store bound to a transaction cannot hand the primary lease over; end the transaction first",
            ));
        }
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

#[cfg(test)]
mod tests;
