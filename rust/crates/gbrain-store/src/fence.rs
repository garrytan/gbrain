//! The steps every protected entry point runs inside its own write transaction (lane L5, step 3; `leases.rs` has
//! the primitives and the rules).
//!
//! A protected entry point (a job, write-claim, effect, drain-lease or cycle-lock write) takes `fence:
//! Option<&LeaseToken>`, the caller's host registration. In the SAME write as the data change it runs, in this order:
//!
//! 1. [`begin`]: with a fence, the lease must be held now; with none, a multi-user store refuses
//!    `lease_lost` / `fence_missing` before anything is written, and a plain store goes on exactly as it always has.
//! 2. When it takes a claim: [`claim_taken`] records the fence's lease name and epoch beside the claim, only when a
//!    fence is given (a plain store with no fence writes no `~L` key).
//! 3. When it writes on a claim the caller holds: [`claim_held`] requires that the claim was taken under this
//!    fence's lease name and epoch, so a holder that took its lease again (a new epoch) cannot finish a claim of the
//!    old one.
//! 4. When the claim ends (finish, release, reclaim, expiry, delete): [`claim_ended`] deletes the record. A reclaim
//!    by a new claimer overwrites it with [`claim_taken`] instead.
//!
//! Job, request, effect and lock records never gain a field: the epochs live only in the `~L 0x05` side records.
//! No file lock, no process-wide mutex and no busy error: a refusal is `lease_lost`, and nothing is written.

use crate::Store;
use crate::error::Result;
use crate::kv::KvWrite;
use crate::leases::{
    LeaseToken, check_claim_epoch, check_fence, clear_claim_epoch, record_claim_epoch,
};

/// Step 1: the fence of `what`, asserted inside the writing transaction.
pub fn begin(
    store: &Store,
    tx: &mut dyn KvWrite,
    fence: Option<&LeaseToken>,
    what: &str,
) -> Result<()> {
    check_fence(store, tx, fence, what)
}

/// Step 2: the claim `id` of `family` was taken under `fence` (nothing is written without a fence).
pub fn claim_taken(
    tx: &mut dyn KvWrite,
    family: u8,
    id: &str,
    fence: Option<&LeaseToken>,
) -> Result<()> {
    match fence {
        Some(fence) => record_claim_epoch(tx, family, id, fence),
        None => Ok(()),
    }
}

/// Step 3: the claim `id` of `family` was taken under `fence`'s lease name and epoch (no check without a fence: a
/// plain store keeps today's behavior, and [`begin`] has already refused a multi-user store).
pub fn claim_held(
    tx: &mut dyn KvWrite,
    family: u8,
    id: &str,
    fence: Option<&LeaseToken>,
) -> Result<()> {
    match fence {
        Some(fence) => check_claim_epoch(tx, family, id, fence),
        None => Ok(()),
    }
}

/// Step 4: the claim ended. Reads and deletes a record only when a fence is given or the store is multi-user, so a
/// plain store with no fence touches no `~L` key.
pub fn claim_ended(
    store: &Store,
    tx: &mut dyn KvWrite,
    family: u8,
    id: &str,
    fence: Option<&LeaseToken>,
) -> Result<()> {
    if fence.is_some() || store.multiuser() {
        clear_claim_epoch(tx, family, id)?;
    }
    Ok(())
}
