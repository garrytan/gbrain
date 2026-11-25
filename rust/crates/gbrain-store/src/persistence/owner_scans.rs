//! Owner scans: the statements of `src/core/engine-sql/persistence-owner-scans.ts` that the write
//! owner's housekeeping sends on each scan tick (rust/docs/store/persistence.md, "Owner scans").
//!
//! Each scan joins a write request (or a refresh) to a `persistence_worktrees` row the host owns,
//! read through `worktree_rows.rs`. The overdue lists and the recovery heads read the requests;
//! no caller here writes a refresh row, so no refresh is interrupted. The parameters are still
//! checked as their Postgres casts check them, so an argument Postgres refuses is refused here too.

use super::effect_scans::host_uuid;
use super::worktree_admission::read_refresh;
use super::worktree_rows::read_worktree_row;
use super::write_claim_terms::worktree_of;
use super::{all_requests, extra_is_null};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use crate::sources::read_source;
use serde_json::Value;

/// `HOLD_CEILING_LIMITS` and `HOLD_CEILING_FLOOR_MS`: however often a write is held again, it waits
/// at most four wait limits from its admission, and never less than four hours.
const HOLD_CEILING_LIMITS: f64 = 4.0;
const HOLD_CEILING_FLOOR_MS: f64 = 4.0 * 60.0 * 60_000.0;

/// `now()-(ms*interval '1 millisecond')` in microseconds.
fn before(now: i64, ms: f64) -> i64 {
    now - (ms * 1000.0) as i64
}

/// Whether request `r` is a deferred write on a worktree host `host` owns.
fn deferred_on_owned(read: &dyn KvRead, r: &RequestRecord, host: &str) -> Result<bool> {
    if r.state != "deferred" {
        return Ok(false);
    }
    let Some(w) = worktree_of(r) else {
        return Ok(false);
    };
    Ok(read_worktree_row(read, &w)?.is_some_and(|row| row.owned_by(Some(host))))
}

/// `overdueDeferredFrom(host, wait)` / `overdueImportFrom(host, wait)` for one request: a deferred
/// write on a worktree `host` owns, held past `wait_ms` behind an unreleased refresh (`refresh`),
/// or held for an import still pending, its refresh (if any) released, unchanged for the wait or
/// older than the hold ceiling (`import`).
pub(super) fn held_overdue(
    read: &dyn KvRead,
    r: &RequestRecord,
    host: &str,
    wait_ms: f64,
    now: i64,
    hold: &str,
) -> Result<bool> {
    if !deferred_on_owned(read, r, host)? {
        return Ok(false);
    }
    let refresh_id = r.extra.get("deferred_refresh_id").and_then(Value::as_str);
    let refresh = match refresh_id {
        Some(id) => read_refresh(read, &id.to_lowercase())?,
        None => None,
    };
    if hold == "refresh" {
        return Ok(refresh.is_some_and(|f| f.released_at_us.is_none())
            && r.created_at_us < before(now, wait_ms));
    }
    let Some(import_from) = r.extra.get("deferred_import_from").and_then(Value::as_str) else {
        return Ok(false);
    };
    let refresh_clear = refresh_id.is_none() || refresh.is_some_and(|f| f.released_at_us.is_some());
    if !refresh_clear {
        return Ok(false);
    }
    Ok(import_pending(read, r, import_from)? && hold_overdue(r, wait_ms, now))
}

/// `COALESCE(s.last_commit,'')=importFrom` with the source row present. The store keeps no
/// `last_commit` (it reads null), so only an import from `''` is still pending here.
fn import_pending(read: &dyn KvRead, r: &RequestRecord, import_from: &str) -> Result<bool> {
    Ok(import_from.is_empty() && read_source(read, &r.source_id)?.is_some())
}

/// `holdOverdue(maxWait)`: held longer than the wait limit, or accepted longer ago than the ceiling.
fn hold_overdue(r: &RequestRecord, wait_ms: f64, now: i64) -> bool {
    let ceiling = (wait_ms * HOLD_CEILING_LIMITS).max(HOLD_CEILING_FLOOR_MS);
    r.updated_at_us < before(now, wait_ms) || r.created_at_us < before(now, ceiling)
}

/// `listOverdueHeldWrites(hostId, maxWaitMs, hold)`: up to 100 deferred writes on worktrees
/// `host_id` owns whose `hold` is past `max_wait_ms`, in sequence order. A non-uuid host id refuses.
pub(crate) fn list_overdue_held_writes(
    read: &dyn KvRead,
    now: i64,
    host_id: &str,
    max_wait_ms: f64,
    hold: &str,
) -> Result<Vec<Value>> {
    hold_kind(hold)?;
    host_uuid(host_id)?;
    let mut rows = Vec::new();
    for r in all_requests(read)? {
        if held_overdue(read, &r, host_id, max_wait_ms, now, hold)? {
            rows.push(r);
        }
    }
    rows.sort_by_key(|r| r.sequence);
    Ok(rows.iter().take(100).map(RequestRecord::to_row).collect())
}

/// `lockOverdueHold(hold)`: a refresh hold stands while its refresh row (`worktree_admission.rs`)
/// is not released. An import hold stands while request `id` is still deferred on `import_from`,
/// that import still pending and the hold past `max_wait_ms`. The id is checked as `$1::uuid`
/// checks it; a hold with no id, or an import hold with no `import_from`, matches no row.
pub(crate) fn lock_overdue_hold(
    read: &dyn KvRead,
    now: i64,
    hold: &str,
    id: Option<&str>,
    import_from: Option<&str>,
    max_wait_ms: f64,
) -> Result<bool> {
    hold_kind(hold)?;
    let Some(id) = id else {
        return Ok(false);
    };
    host_uuid(id)?;
    if hold == "refresh" {
        return super::worktree_admission::refresh_unreleased(read, &id.to_lowercase());
    }
    let Some(import_from) = import_from else {
        return Ok(false);
    };
    let Some(r) = all_requests(read)?
        .into_iter()
        .find(|r| r.id.eq_ignore_ascii_case(id))
    else {
        return Ok(false);
    };
    let held = r.state == "deferred"
        && r.extra.get("deferred_import_from").and_then(Value::as_str) == Some(import_from);
    Ok(held && import_pending(read, &r, import_from)? && hold_overdue(&r, max_wait_ms, now))
}

/// `listOwnerRecoveryHeads(hostId, excluded)`: the oldest recovering write of each worktree
/// `host_id` owns that is not in `excluded`, at most 16, oldest update first. A non-uuid host id
/// refuses.
pub(crate) fn list_owner_recovery_heads(
    read: &dyn KvRead,
    host_id: &str,
    excluded: &[String],
) -> Result<Vec<Value>> {
    host_uuid(host_id)?;
    let all = all_requests(read)?;
    let recovering = |r: &&RequestRecord| !extra_is_null(r, "recovery");
    let mut heads = Vec::new();
    for r in all.iter().filter(recovering) {
        let Some(w) = worktree_of(r) else { continue };
        if excluded.contains(&w)
            || !read_worktree_row(read, &w)?.is_some_and(|row| row.owned_by(Some(host_id)))
        {
            continue;
        }
        let earlier = all
            .iter()
            .filter(recovering)
            .any(|e| worktree_of(e).as_deref() == Some(w.as_str()) && e.sequence < r.sequence);
        if !earlier {
            heads.push(r);
        }
    }
    heads.sort_by_key(|r| (r.updated_at_us, r.sequence));
    Ok(heads.iter().take(16).map(|r| r.to_row()).collect())
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
    pub fn list_overdue_held_writes(
        &self,
        host_id: &str,
        max_wait_ms: f64,
        hold: &str,
    ) -> Result<Vec<Value>> {
        let now = self.env.now_micros();
        list_overdue_held_writes(&*self.read()?, now, host_id, max_wait_ms, hold)
    }

    /// `lockOverdueHold(hold)`.
    pub fn lock_overdue_hold(
        &self,
        hold: &str,
        id: Option<&str>,
        import_from: Option<&str>,
        max_wait_ms: f64,
    ) -> Result<bool> {
        self.assert_serialized_transactions("lockOverdueHold")?;
        let now = self.env.now_micros();
        lock_overdue_hold(&*self.read()?, now, hold, id, import_from, max_wait_ms)
    }

    /// `listOwnerRecoveryHeads(hostId, excluded)`.
    pub fn list_owner_recovery_heads(
        &self,
        host_id: &str,
        excluded: &[String],
    ) -> Result<Vec<Value>> {
        list_owner_recovery_heads(&*self.read()?, host_id, excluded)
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
        let s = crate::test_support::store();
        for hold in ["refresh", "import"] {
            assert!(
                s.list_overdue_held_writes(HOST, 1000.0, hold)
                    .unwrap()
                    .is_empty()
            );
        }
        let bad = s
            .list_overdue_held_writes("nope", 1000.0, "refresh")
            .unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
        assert!(s.list_overdue_held_writes(HOST, 1000.0, "other").is_err());
    }

    #[test]
    fn no_overdue_hold_stands_without_a_row_and_a_non_uuid_id_refuses() {
        let s = crate::test_support::store();
        assert!(
            !s.lock_overdue_hold("refresh", Some(HOST), None, 0.0)
                .unwrap()
        );
        assert!(!s.lock_overdue_hold("refresh", None, None, 0.0).unwrap());
        assert!(
            !s.lock_overdue_hold("import", Some(HOST), Some("abc"), 0.0)
                .unwrap()
        );
        assert!(
            !s.lock_overdue_hold("import", Some(HOST), None, 0.0)
                .unwrap()
        );
        let bad = s
            .lock_overdue_hold("import", Some("nope"), Some("abc"), 0.0)
            .unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
    }

    #[test]
    fn owner_recovery_heads_are_empty_and_refuse_a_non_uuid_host() {
        let s = crate::test_support::store();
        assert!(s.list_owner_recovery_heads(HOST, &[]).unwrap().is_empty());
        let bad = s.list_owner_recovery_heads("nope", &[]).unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
    }

    #[test]
    fn resumable_refreshes_are_empty_and_refuse_a_non_uuid_host() {
        assert!(list_resumable_refreshes(HOST).unwrap().is_empty());
        let bad = list_resumable_refreshes("nope").unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
    }
}
