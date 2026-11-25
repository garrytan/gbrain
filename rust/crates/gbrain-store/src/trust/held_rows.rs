//! The held-row read of a lower-tier write (engine-sql/trust-fence.ts `listHeldRows`,
//! trust/fence-guard.ts `heldRows`): of a page's take or timeline rows, the ones the write may not
//! delete or overwrite, because they are more trusted than the writer or an open `forget` contest
//! holds them.
//!
//! Both carry their stamped tier in their record: a timeline entry in its `E` record
//! (`timeline/tier.rs`), a take in its `A 0x01` record (`trust/row_trust.rs`, stamped by
//! `takes::store_take`). A record stored before the tier reads `unknown`, the column default.
//! The SQL's `FOR UPDATE` lock is skipped while explicit transactions hold the writer (`serialized_transactions`);
//! `listHeldRows` and `listGuardedTakeRows` assert it.
//!
//! `listGuardedTakeRows` is the batch form for takes (trust/fence-guard.ts `guardTakeRows`): over
//! the pages of a reconcile batch, the stored takes the batch would delete, overwrite or deactivate
//! and that it may not.

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

/// One incoming fence row of `listGuardedTakeRows`. `active` absent is SQL NULL.
#[derive(Debug, Clone, Deserialize)]
pub struct GuardedIncoming {
    pub page_id: i64,
    pub row_num: i64,
    pub claim: String,
    pub kind: String,
    pub holder: String,
    #[serde(default)]
    pub active: Option<bool>,
}

/// One row of `listGuardedTakeRows` the batch deletes.
#[derive(Debug, Clone, Deserialize)]
pub struct GuardedGone {
    pub page_id: i64,
    pub row_num: i64,
}

/// `listGuardedTakeRows({ incoming, gone, pending? })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardedTakeRowsQuery {
    #[serde(default)]
    pub incoming: Vec<GuardedIncoming>,
    #[serde(default)]
    pub gone: Vec<GuardedGone>,
    #[serde(default)]
    pub pending: bool,
}

impl Store {
    /// `listGuardedTakeRows(q)`: `[{ id, page_id, row_num, trust_tier, change }]` by page and row
    /// number, of the stored takes on the pages of `q.incoming` and `q.gone` that the batch deletes
    /// (a `gone` entry) or changes (an incoming row of the same page and number with another claim,
    /// kind or holder, or that deactivates an active take), and that are more trusted than the
    /// declared tier of `ctx` or, with `pending`, held by an open `forget` contest. `change` is
    /// `removed` with no incoming row, `replaced` when the content differs, else `deactivated`.
    /// A take with several matching entries is listed once per pair, as the SQL's joins list it.
    pub fn list_guarded_take_rows(
        &self,
        q: &GuardedTakeRowsQuery,
        ctx: &FenceContext,
    ) -> Result<Vec<Value>> {
        self.assert_serialized_transactions("listGuardedTakeRows")?;
        for n in &q.incoming {
            no_nul(
                "listGuardedTakeRows",
                &[
                    ("claim", n.claim.as_str()),
                    ("kind", n.kind.as_str()),
                    ("holder", n.holder.as_str()),
                ],
            )?;
        }
        if q.incoming.is_empty() && q.gone.is_empty() {
            return Ok(Vec::new());
        }
        let pages: BTreeSet<u64> = q
            .incoming
            .iter()
            .map(|n| n.page_id)
            .chain(q.gone.iter().map(|g| g.page_id))
            .filter_map(|id| u64::try_from(id).ok())
            .collect();
        let writer = ctx.writer_rank();
        let read = self.read()?;
        let mut out = Vec::new();
        for page_id in pages {
            for x in page_takes(&*read, page_id)? {
                let at = |p: i64, r: i64| p == x.page_id as i64 && r == i64::from(x.row_num);
                let tier = x.trust.tier();
                if !(tier.rank() > writer || (q.pending && pending_forget(&*read, "takes", x.id)?))
                {
                    continue;
                }
                let ns: Vec<&GuardedIncoming> = q
                    .incoming
                    .iter()
                    .filter(|n| at(n.page_id, n.row_num))
                    .collect();
                let gs = q.gone.iter().filter(|g| at(g.page_id, g.row_num)).count();
                let n_rows: Vec<Option<&GuardedIncoming>> = if ns.is_empty() {
                    vec![None]
                } else {
                    ns.into_iter().map(Some).collect()
                };
                for n in n_rows {
                    let distinct = n.is_some_and(|n| {
                        (&x.claim, &x.kind, &x.holder) != (&n.claim, &n.kind, &n.holder)
                    });
                    let deactivates = n.is_some_and(|n| x.active && n.active == Some(false));
                    let changes = n.is_some() && (distinct || deactivates);
                    let change = match n {
                        None => "removed",
                        Some(_) if distinct => "replaced",
                        Some(_) => "deactivated",
                    };
                    let row = json!({ "id": x.id, "page_id": x.page_id, "row_num": x.row_num, "trust_tier": tier.as_str(), "change": change });
                    if gs > 0 {
                        out.extend(std::iter::repeat_n(row, gs));
                    } else if changes {
                        out.push(row);
                    }
                }
            }
        }
        Ok(out)
    }

    /// `listHeldRows(q)`: `[{ id, trust_tier }]` by id, of the page's `q.table` rows among `ids` that
    /// are more trusted than the writer (`q.writer`, else the declared tier of `ctx`; a name that is
    /// no tier ranks 0) or, with `pending`, held by an open `forget` contest. `trust_tier` is the
    /// stored tier (`unknown` when none is stored).
    pub fn list_held_rows(&self, q: &HeldRowsQuery, ctx: &FenceContext) -> Result<Vec<Value>> {
        self.assert_serialized_transactions("listHeldRows")?;
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
