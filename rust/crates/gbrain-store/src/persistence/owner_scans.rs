//! Owner scans: the statements of `src/core/engine-sql/persistence-owner-scans.ts` that the write
//! owner's housekeeping sends on each scan tick (rust/docs/store/persistence.md, "Owner scans").
//!
//! Each scan joins a write request (or a refresh) to a `persistence_worktrees` row the host owns.
//! This engine keeps no worktree (a request here always has a null `worktree_id`, and an insert that names a
//! refresh hold refuses), so every list answers no row and no hold stands. The parameters are
//! still checked as their Postgres casts check them, so an argument Postgres refuses is refused
//! here too.

use super::effect_scans::host_uuid;
use crate::Store;
use crate::error::{Result, StoreError};
use serde_json::Value;

/// `listOverdueHeldWrites(hostId, maxWaitMs, hold)`: no write here waits behind a refresh or a
/// worktree import, so no row; a non-uuid host id refuses. The wait limit only narrows the rows.
pub(crate) fn list_overdue_held_writes(host_id: &str, hold: &str) -> Result<Vec<Value>> {
    hold_kind(hold)?;
    host_uuid(host_id)?;
    Ok(Vec::new())
}

/// `lockOverdueHold(hold)`: no refresh row or worktree import hold exists here, so none stands
/// (false). The id the hold names is still checked as `$1::uuid` checks it; a refresh hold with
/// no refresh id matches no row on Postgres either.
pub(crate) fn lock_overdue_hold(hold: &str, id: Option<&str>) -> Result<bool> {
    hold_kind(hold)?;
    if let Some(id) = id {
        host_uuid(id)?;
    }
    Ok(false)
}

/// `listOwnerRecoveryHeads(hostId, excluded)`: no write here carries a recovery record (those
/// live only on worktree-owned writes), so no head; a non-uuid host id refuses. The excluded
/// worktree ids only narrow the rows.
pub(crate) fn list_owner_recovery_heads(host_id: &str) -> Result<Vec<Value>> {
    host_uuid(host_id)?;
    Ok(Vec::new())
}

/// `listResumableRefreshes(hostId, budgetMs)`: no refresh row exists here (refreshes live only
/// on managed worktrees), so none is interrupted; a non-uuid host id refuses. The sync budget
/// only marks rows stale.
pub(crate) fn list_resumable_refreshes(host_id: &str) -> Result<Vec<Value>> {
    host_uuid(host_id)?;
    Ok(Vec::new())
}

/// The two holds the SQL engines have a statement for; another kind is a caller bug.
fn hold_kind(hold: &str) -> Result<()> {
    match hold {
        "refresh" | "import" => Ok(()),
        other => Err(StoreError::invalid(format!(
            "unknown hold kind: \"{other}\""
        ))),
    }
}

impl Store {
    /// `listOverdueHeldWrites(hostId, maxWaitMs, hold)`.
    pub fn list_overdue_held_writes(&self, host_id: &str, hold: &str) -> Result<Vec<Value>> {
        list_overdue_held_writes(host_id, hold)
    }

    /// `lockOverdueHold(hold)`.
    pub fn lock_overdue_hold(&self, hold: &str, id: Option<&str>) -> Result<bool> {
        lock_overdue_hold(hold, id)
    }

    /// `listOwnerRecoveryHeads(hostId, excluded)`.
    pub fn list_owner_recovery_heads(&self, host_id: &str) -> Result<Vec<Value>> {
        list_owner_recovery_heads(host_id)
    }

    /// `listResumableRefreshes(hostId, budgetMs)`.
    pub fn list_resumable_refreshes(&self, host_id: &str) -> Result<Vec<Value>> {
        list_resumable_refreshes(host_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "0f000000-0000-4000-8000-0000000000f1";

    #[test]
    fn overdue_held_writes_are_empty_and_refuse_a_non_uuid_host() {
        for hold in ["refresh", "import"] {
            assert!(list_overdue_held_writes(HOST, hold).unwrap().is_empty());
        }
        let bad = list_overdue_held_writes("nope", "refresh").unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
        assert!(list_overdue_held_writes(HOST, "other").is_err());
    }

    #[test]
    fn no_overdue_hold_stands_and_a_non_uuid_id_refuses() {
        assert!(!lock_overdue_hold("refresh", Some(HOST)).unwrap());
        assert!(!lock_overdue_hold("refresh", None).unwrap());
        assert!(!lock_overdue_hold("import", Some(HOST)).unwrap());
        let bad = lock_overdue_hold("import", Some("nope")).unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
    }

    #[test]
    fn owner_recovery_heads_are_empty_and_refuse_a_non_uuid_host() {
        assert!(list_owner_recovery_heads(HOST).unwrap().is_empty());
        let bad = list_owner_recovery_heads("nope").unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
    }

    #[test]
    fn resumable_refreshes_are_empty_and_refuse_a_non_uuid_host() {
        assert!(list_resumable_refreshes(HOST).unwrap().is_empty());
        let bad = list_resumable_refreshes("nope").unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
    }
}
