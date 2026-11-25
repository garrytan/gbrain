//! `listHeldTimelineRows` (engine-sql/trust-fence.ts): of the listed timeline row ids, the rows a
//! write may not delete or overwrite. A row is held when its stored tier (`tier.rs`) ranks above
//! the writer, or, with `pending`, when a pending `forget` proposal targets it (an open contest,
//! `trust::proposals`). The writer is the named tier when the caller gives one (a name that is no
//! tier ranks 0, as the rank `CASE` does) and the store's write trust context otherwise
//! ([`FenceContext`], `unknown` when undeclared).
//!
//! Entries are keyed by page, so the read walks every `E` record once, as `readRowTrustRows`
//! does. `FOR UPDATE` is skipped while explicit
//! transactions hold the writer (`serialized_transactions`; `listHeldTimelineRows` asserts it). Rows come back by id.

use super::TimelineRecord;
use crate::Store;
use crate::error::{Result, StoreError};
use crate::facts::FenceContext;
use crate::keys;
use crate::kv::scan_prefix;
use crate::trust::TrustTier;
use crate::trust::proposals::pending_forget;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `listHeldTimelineRows(spec)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldTimelineSpec {
    pub ids: Vec<i64>,
    #[serde(default)]
    pub writer: Option<String>,
    #[serde(default)]
    pub pending: Option<bool>,
}

impl Store {
    /// `listHeldTimelineRows({ ids, writer?, pending? })`: `[{ id, trust_tier }]` by id. An id
    /// with no row reads no row; an empty list reads nothing.
    /// In multi-user mode it passes through its row in `lock_skips::MULTIUSER_PROVEN` (read set, `list_held_timeline_rows_refuses_when_the_timeline_changed`): a concurrent writer of what the lock protected refuses the commit `write_conflict`.
    pub fn list_held_timeline_rows(
        &self,
        spec: &HeldTimelineSpec,
        ctx: &FenceContext,
    ) -> Result<Vec<Value>> {
        self.assert_serialized_transactions("listHeldTimelineRows")?;
        let wanted: BTreeSet<u64> = spec
            .ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        if wanted.is_empty() {
            return Ok(Vec::new());
        }
        let writer = match spec.writer.as_deref() {
            Some(name) => TrustTier::parse(name).map_or(0, TrustTier::rank),
            None => ctx.writer_rank(),
        };
        let read = self.read()?;
        let mut found: Vec<TimelineRecord> = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &[keys::TIMELINE], false, &mut |_, v| {
            match serde_json::from_slice::<TimelineRecord>(v) {
                Ok(r) if wanted.contains(&r.id) => found.push(r),
                Ok(_) => {}
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        found.sort_by_key(|r| r.id);
        let mut out = Vec::new();
        for row in found {
            let tier = row.trust.tier();
            let held = tier.rank() > writer
                || (spec.pending == Some(true)
                    && pending_forget(&*read, "timeline_entries", row.id)?);
            if held {
                out.push(json!({ "id": row.id, "trust_tier": tier.as_str() }));
            }
        }
        Ok(out)
    }
}
