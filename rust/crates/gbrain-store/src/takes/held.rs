//! `listHeldTakeRows` (engine-sql/trust-fence.ts): of the listed take ids, the takes a write may
//! not delete or overwrite. A take is held when its stored tier (`trust_tier`, stamped by
//! `store_take`) ranks above the writer, or, with `pending`, when a pending `forget` proposal
//! targets it (an open contest, `trust::proposals`). The writer is the named tier when the caller
//! gives one (a name that is no tier ranks 0, as the rank `CASE` does) and the store's write trust
//! context otherwise ([`FenceContext`], `unknown` when undeclared).
//!
//! Takes are keyed by id, so each listed id is one lookup. `FOR UPDATE` is skipped while explicit transactions
//! hold the writer (`serialized_transactions`; `listHeldTakeRows` asserts it). Rows come back by id.

use super::read_take;
use crate::Store;
use crate::error::Result;
use crate::facts::FenceContext;
use crate::trust::TrustTier;
use crate::trust::proposals::pending_forget;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `listHeldTakeRows(spec)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldTakeSpec {
    pub ids: Vec<i64>,
    #[serde(default)]
    pub writer: Option<String>,
    #[serde(default)]
    pub pending: Option<bool>,
}

impl Store {
    /// `listHeldTakeRows({ ids, writer?, pending? })`: `[{ id, trust_tier }]` by id. An id with no
    /// take reads no row; an empty list reads nothing.
    /// In multi-user mode it passes through its row in `lock_skips::MULTIUSER_PROVEN` (read set, `list_held_take_rows_refuses_when_the_take_changed`): a concurrent writer of what the lock protected refuses the commit `write_conflict`.
    pub fn list_held_take_rows(
        &self,
        spec: &HeldTakeSpec,
        ctx: &FenceContext,
    ) -> Result<Vec<Value>> {
        self.assert_serialized_transactions("listHeldTakeRows")?;
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
        let mut out = Vec::new();
        for id in wanted {
            let Some(take) = read_take(&*read, id)? else {
                continue;
            };
            let tier = take.trust.tier();
            let held = tier.rank() > writer
                || (spec.pending == Some(true) && pending_forget(&*read, "takes", take.id)?);
            if held {
                out.push(json!({ "id": take.id, "trust_tier": tier.as_str() }));
            }
        }
        Ok(out)
    }
}
