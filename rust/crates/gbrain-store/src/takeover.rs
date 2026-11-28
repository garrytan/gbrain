//! Taking over as primary (lane L5; design note "M3", "Hosts and fencing"; lane L2's follower, `follower.rs`, and the
//! primary's write fence, `primary.rs`).
//!
//! Two positions cannot tell two histories apart after a promotion. So a takeover does three things:
//!
//! 1. The promotion itself is fenced (`Follower::promote_with`, under the follower's state lock): the old primary's
//!    replicated lease [`PRIMARY_LEASE`] must be released, or lapsed past [`TakeoverSettings::margin_ms`] with the
//!    caller's `OldPrimaryStopped` attestation; a live lease refuses (`primary_live`), a lapse without the attestation
//!    refuses (`primary_unconfirmed`). Nothing changes on a refusal.
//! 2. The new primary takes [`PRIMARY_LEASE`] at the next epoch and serves under it (`Store::serve_as_primary`), so a
//!    write that carries the old token is refused (`epoch_moved`). The old primary, if it served under the lease, is
//!    refused at its own commit once the lease lapsed or was released (`primary.rs`).
//! 3. It checks the lineage BEFORE it continues any follower: [`continue_following`] refuses a page from another
//!    history (`snapshot_required`) without applying anything; the follower then installs a snapshot.
//!
//! No file lock, no process-wide mutex and no busy error: a takeover that is too early is refused, never made to wait.
//! Two primaries after a wrong attestation or a double promotion are phase M4 (work item 9e3753d4); no product path
//! reaches a takeover.

use crate::commit_log::{self, LogPage};
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::follower::{Applied, Follower, OldPrimaryStopped, PROMOTION_PARTIAL, SNAPSHOT_REQUIRED};
use crate::leases::{LeaseToken, MAX_TTL_MS};
use crate::write_origin::WriteOrigin;
use crate::{OpenOptions, Store};
use std::sync::Arc;

/// The lease the primary of a brain holds while it serves writes.
pub const PRIMARY_LEASE: &str = "primary";

/// The default wait past the end of the old primary's lease before an attested takeover (2 s): the clock skew between
/// the old primary and the promoting machine it absorbs. A skew larger than the margin is not covered.
pub const DEFAULT_TAKEOVER_MARGIN_MS: u64 = 2_000;

/// How a takeover judges the old primary's lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TakeoverSettings {
    /// The wait past the lease's end, on the promoting machine's clock, before an attested promotion.
    pub margin_ms: u64,
}

impl Default for TakeoverSettings {
    fn default() -> Self {
        TakeoverSettings {
            margin_ms: DEFAULT_TAKEOVER_MARGIN_MS,
        }
    }
}

impl TakeoverSettings {
    /// The margin in microseconds; at most a lease's longest time to live.
    pub fn margin_us(&self) -> Result<i64> {
        if self.margin_ms > MAX_TTL_MS {
            return Err(StoreError::invalid(format!(
                "a takeover margin must be 0 to {MAX_TTL_MS} milliseconds"
            )));
        }
        Ok((self.margin_ms as i64) * 1000)
    }
}

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

/// Promotes `follower` to primary when the old primary handed its lease over, and serves under [`PRIMARY_LEASE`] at
/// the next epoch: [`take_over_with`] with the default settings and no attestation. `env` is this machine's clock.
pub fn take_over(
    follower: Follower,
    holder: &WriteOrigin,
    options: OpenOptions,
    ttl_ms: u64,
    env: Arc<dyn Env>,
) -> Result<(Store, LeaseToken)> {
    take_over_with(
        follower,
        holder,
        options,
        ttl_ms,
        env,
        &TakeoverSettings::default(),
        None,
    )
}

/// Promotes `follower` (`Follower::promote_with`: fenced on `env`, this machine's clock, with `settings` and `stopped`)
/// and serves under [`PRIMARY_LEASE`] at the next epoch (`Store::serve_as_primary`). `holder` and `ttl_ms` are checked
/// before anything changes. A failure after the promotion is `promotion_partial`: open the brain with
/// `Store::open_dir` and call `serve_as_primary`.
pub fn take_over_with(
    follower: Follower,
    holder: &WriteOrigin,
    options: OpenOptions,
    ttl_ms: u64,
    env: Arc<dyn Env>,
    settings: &TakeoverSettings,
    stopped: Option<&OldPrimaryStopped>,
) -> Result<(Store, LeaseToken)> {
    holder.check()?;
    if ttl_ms == 0 || ttl_ms > MAX_TTL_MS {
        return Err(StoreError::invalid(format!(
            "a lease time to live must be 1 to {MAX_TTL_MS} milliseconds"
        )));
    }
    let store = follower.promote_with(options, env, settings, stopped)?;
    let partial = |why: String| {
        StoreError::new(
            crate::error::INVALID_STATE,
            format!(
                "{PROMOTION_PARTIAL}: the follower is promoted but {why}; open the brain with Store::open_dir and call serve_as_primary"
            ),
        )
    };
    match store.serve_as_primary(holder, ttl_ms) {
        Ok(Some(token)) => Ok((store, token)),
        Ok(None) => Err(partial(
            "another holder took the primary lease during the promotion".into(),
        )),
        Err(e) => Err(partial(format!("taking the primary lease failed: {e}"))),
    }
}
