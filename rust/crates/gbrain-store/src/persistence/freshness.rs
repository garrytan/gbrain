//! The freshness samples of `gbrain sync status` (`listFreshnessTargets`,
//! `src/core/engine-sql/sync-status-reads.ts` `FRESHNESS_SAMPLE_WHERE`): the commit targets of a
//! worktree's committed `managed_sync_import` receipts in the window, read from the request
//! records. On this engine managed writes are held, so no such receipt is written yet; the read
//! still evaluates every predicate the SQL tests.

use super::{all_requests, uuid_param};
use crate::Store;
use crate::cli_reads::pg_text::jsonb_text;
use crate::error::Result;
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use serde_json::Value;
use std::collections::BTreeMap;

/// `intent->>'key'`: a string as itself, JSON null or a missing key as None, any other value as
/// its JSON text.
fn intent_text(r: &RequestRecord, key: &str) -> Option<String> {
    match r.intent.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(jsonb_text(other)),
    }
}

/// `FRESHNESS_SAMPLE_WHERE` for one request, with `since_us` the window's start.
fn sample(r: &RequestRecord, worktree: &str, incarnation: &str, since_us: i64) -> bool {
    r.extra
        .get("worktree_id")
        .and_then(Value::as_str)
        .is_some_and(|w| w.eq_ignore_ascii_case(worktree))
        && r.source_incarnation.eq_ignore_ascii_case(incarnation)
        && r.state == "committed"
        && intent_text(r, "kind").as_deref() == Some("managed_sync_import")
        && r.completed_at_us.is_some_and(|at| at > since_us)
        && intent_text(r, "from").is_some()
        && intent_text(r, "working").as_deref().unwrap_or("false") != "true"
}

/// The sample targets grouped, by newest completion first, then byte target (a null target
/// last), at most `limit`.
pub(crate) fn freshness_targets_in(
    read: &dyn KvRead,
    worktree_id: &str,
    incarnation: &str,
    window_hours: i64,
    limit: usize,
    now_us: i64,
) -> Result<Vec<Option<String>>> {
    let worktree = uuid_param(worktree_id, "worktreeId")?;
    let incarnation = uuid_param(incarnation, "incarnation")?;
    let since_us = now_us.saturating_sub(window_hours.saturating_mul(3_600_000_000));
    let mut newest: BTreeMap<Option<String>, i64> = BTreeMap::new();
    for r in all_requests(read)? {
        if !sample(&r, &worktree, &incarnation, since_us) {
            continue;
        }
        let at = r.completed_at_us.unwrap_or_default();
        let entry = newest.entry(intent_text(&r, "target")).or_insert(at);
        *entry = (*entry).max(at);
    }
    let mut rows: Vec<(Option<String>, i64)> = newest.into_iter().collect();
    rows.sort_by(|(ta, a), (tb, b)| {
        b.cmp(a).then_with(|| match (ta, tb) {
            (Some(x), Some(y)) => x.as_bytes().cmp(y.as_bytes()),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        })
    });
    rows.truncate(limit.max(1));
    Ok(rows.into_iter().map(|(t, _)| t).collect())
}

impl Store {
    /// `listFreshnessTargets(worktreeId, incarnation, windowHours, limit)`.
    pub fn list_freshness_targets(
        &self,
        worktree_id: &str,
        incarnation: &str,
        window_hours: i64,
        limit: usize,
    ) -> Result<Vec<Option<String>>> {
        let now = self.env.now_micros();
        freshness_targets_in(
            &*self.read()?,
            worktree_id,
            incarnation,
            window_hours,
            limit,
            now,
        )
    }
}
