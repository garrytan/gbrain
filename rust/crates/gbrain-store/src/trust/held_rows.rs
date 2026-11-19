//! The held-row read of a lower-tier write (engine-sql/trust-fence.ts `listHeldRows`,
//! trust/fence-guard.ts `heldRows`): of a page's take or timeline rows, the ones the write may not
//! delete or overwrite, because they are more trusted than the writer or an open `forget` contest
//! holds them.
//!
//! Both carry their stamped tier in their record: a timeline entry in its `E` record
//! (`timeline/tier.rs`), a take in its `A 0x01` record (`trust/row_trust.rs`, stamped by
//! `takes::store_take`). A record stored before the tier reads `unknown`, the column default.
//! The store runs one write at a time, so the SQL's `FOR UPDATE` lock has nothing to add here.

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::facts::FenceContext;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::takes::page_takes;
use crate::timeline::TimelineRecord;
use crate::trust::TrustTier;
use crate::trust::proposals::pending_forget;
use crate::{Store, keys};

/// `listHeldRows({ table, pageId, ids, writer?, pending })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldRowsQuery {
    pub table: String,
    pub page_id: i64,
    pub ids: Vec<i64>,
    /// The writer's tier by name; `None` reads the declared tier of the write trust context.
    #[serde(default)]
    pub writer: Option<String>,
    #[serde(default)]
    pub pending: bool,
}

impl Store {
    /// `listHeldRows(q)`: `[{ id, trust_tier }]` by id, of the page's `q.table` rows among `ids` that
    /// are more trusted than the writer (`q.writer`, else the declared tier of `ctx`; a name that is
    /// no tier ranks 0) or, with `pending`, held by an open `forget` contest. `trust_tier` is the
    /// stored tier (`unknown` when none is stored).
    pub fn list_held_rows(&self, q: &HeldRowsQuery, ctx: &FenceContext) -> Result<Vec<Value>> {
        no_nul("listHeldRows", &[("table", q.table.as_str())])?;
        if let Some(writer) = &q.writer {
            no_nul("listHeldRows", &[("writer", writer.as_str())])?;
        }
        if q.table != "timeline_entries" && q.table != "takes" {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!("listHeldRows: unknown table {}", q.table),
            ));
        }
        let writer = match &q.writer {
            Some(name) => TrustTier::parse(name).map_or(0, TrustTier::rank),
            None => ctx.writer_rank(),
        };
        let wanted: BTreeSet<u64> = q
            .ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let Ok(page_id) = u64::try_from(q.page_id) else {
            return Ok(Vec::new());
        };
        if wanted.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let mut rows: Vec<(u64, TrustTier)> = if q.table == "takes" {
            page_takes(&*read, page_id)?
                .into_iter()
                .filter(|take| wanted.contains(&take.id))
                .map(|take| (take.id, take.trust.tier()))
                .collect()
        } else {
            timeline_rows(&*read, page_id, &wanted)?
        };
        rows.sort_by_key(|(id, _)| *id);
        let mut out = Vec::new();
        for (id, tier) in rows {
            if tier.rank() > writer || (q.pending && pending_forget(&*read, &q.table, id)?) {
                out.push(json!({ "id": id, "trust_tier": tier.as_str() }));
            }
        }
        Ok(out)
    }
}

/// The page's timeline entries among `wanted`, with their stored tier.
fn timeline_rows(
    read: &dyn KvRead,
    page_id: u64,
    wanted: &BTreeSet<u64>,
) -> Result<Vec<(u64, TrustTier)>> {
    let mut rows = Vec::new();
    let mut failure = None;
    scan_prefix(read, &keys::timeline_prefix(page_id), false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(entry) if wanted.contains(&entry.id) => rows.push((entry.id, entry.trust.tier())),
            Ok(_) => {}
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    match failure {
        Some(e) => Err(e),
        None => Ok(rows),
    }
}
