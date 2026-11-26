//! Taking over as primary (lane L5; design note "M3", "Hosts and fencing"; lane L2's follower, `follower.rs`).
//!
//! Two positions cannot tell two histories apart after a promotion, and the store refuses a forked follower but does
//! not fence. So a takeover does two things the store alone does not:
//!
//! 1. It fences the old primary BEFORE it promotes. The primary holds the lease [`PRIMARY_LEASE`], and that lease
//!    record is replicated to every follower with the data. [`take_over`] refuses (`invalid_state`, reason
//!    `primary_live`) while the replicated lease is live on this machine's clock. Once it has lapsed, every write
//!    the old primary makes under its token is refused at its own commit (`lease_lost` / `expired`), because its lease
//!    no longer holds there. Only then does the follower promote. The first write of the new primary takes the lease at
//!    the next epoch, so any write that still carries the old token is refused on the new primary too
//!    (`epoch_moved`).
//! 2. It checks the lineage BEFORE it continues any follower: [`continue_following`] refuses a page from another
//!    history (`snapshot_required`) without applying anything; the follower then installs a snapshot.
//!
//! No file lock, no process-wide mutex and no busy error: a takeover that is too early is refused, never made to wait.

use crate::commit_log::{self, LogPage};
use crate::env::Env;
use crate::error::{INVALID_STATE, Result, StoreError};
use crate::follower::{Applied, Follower, SNAPSHOT_REQUIRED};
use crate::kv::Kv;
use crate::leases::{LeaseToken, read_lease_record};
use crate::write_origin::WriteOrigin;
use crate::{OpenOptions, Store};

/// The lease the primary of a brain holds while it serves writes.
pub const PRIMARY_LEASE: &str = "primary";

/// Applies the next page only when it continues the follower's history: a page from another timeline (a primary
/// promoted elsewhere after this follower's cursor) is refused with `snapshot_required` and nothing changes.
pub fn continue_following(follower: &Follower, page: &LogPage) -> Result<Applied> {
    if let Some(cursor) = follower.cursor()
        && !commit_log::lineage_continues(&follower.lineage(), cursor, &page.lineage)
    {
        return Err(StoreError::new(
            SNAPSHOT_REQUIRED,
            "the log comes from another history than this follower's (another primary was promoted); install a snapshot",
        ));
    }
    follower.apply_page(page)
}

/// Promotes `follower` to primary after fencing the old primary (module docs), and takes [`PRIMARY_LEASE`] at the
/// next epoch as the new primary's first write. `env` is this machine's clock, the only clock a lease is judged on.
pub fn take_over(
    follower: Follower,
    holder: &WriteOrigin,
    options: OpenOptions,
    ttl_ms: u64,
    env: &dyn Env,
) -> Result<(Store, LeaseToken)> {
    let replicated = read_lease_record(&*follower.records().snapshot()?, PRIMARY_LEASE)?;
    if let Some(old) = &replicated
        && !old.released
        && old.expires_at_us > env.clock_micros()
    {
        return Err(StoreError::new(
            INVALID_STATE,
            format!(
                "primary_live: the old primary still holds its lease (epoch {}) until {} µs; take over after it lapses",
                old.epoch, old.expires_at_us
            ),
        ));
    }
    let store = follower.promote(options)?;
    let token = store
        .acquire_lease(PRIMARY_LEASE, holder, ttl_ms)?
        .ok_or_else(|| {
            StoreError::new(
                INVALID_STATE,
                "primary_live: another holder took the primary lease during the promotion",
            )
        })?;
    Ok((store, token))
}
