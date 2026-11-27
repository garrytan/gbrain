//! The extract_facts fence reconcile and deleted-page expiry (src/core/engine-sql/facts-cycle.ts): the statements
//! `runExtractFacts` (src/core/cycle/extract-facts.ts) runs on a page's fence rows, which the maintenance sweep's pass 1
//! reaches.
//!
//! Members: listFenceRowSupersession, setFactSupersededBy, expireFactInPlace, expireAndDetachFact,
//! updateFenceFactCells, listHeldWideningFactIds, listDeletedPageSlugsWithActiveFacts,
//! listExpirableFactIdsOfDeletedPage, readDeletedPageBody, expireFactsByIds.
//!
//! Each write updates the row through [`write_fact`], so the trust stamp, the purge ledger and the unique fence key
//! apply as the `facts` triggers and indexes do. `updateFenceFactCells` names `visibility` and `expired_at` in its
//! `SET` list, so it runs the withdrawal guard ([`preserve_withdrawal`], `facts_preserve_withdrawal`); the expiries
//! leave a row expired, where the guard does nothing. `now()` is the store's clock. A statement with no `ORDER BY`
//! answers in id order here; its callers depend on no order. rust/docs/store/facts.md, "Fence reconcile and
//! deleted-page expiry", lists what each member answers.

use super::withdrawal_guard::preserve_withdrawal;
use super::{
    FactRecord, bigint, check_row, fact_by_number, foreign_key, opt_time, page_rows, read_fact,
    source_rows, write_fact,
};
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::links::no_nul;
use crate::page_body::body_storage_columns;
use crate::pages::{PageRecord, read_page};
use crate::trust::proposals::held_narrower_in;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `(sourceId, id)`: one fact of a source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FactInSource {
    pub source_id: String,
    pub id: f64,
}

/// `setFactSupersededBy(sourceId, id, supersededBy)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SupersededByArgs {
    pub source_id: String,
    pub id: f64,
    pub superseded_by: Option<f64>,
}

/// `updateFenceFactCells(sourceId, id, cells)`: the cells as the caller resolved them (`FenceFactCells`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FenceCellsArgs {
    pub source_id: String,
    pub id: f64,
    pub kind: String,
    pub visibility: String,
    pub notability: String,
    pub context: Option<String>,
    pub valid_from: Option<String>,
    pub set_valid_until: bool,
    pub valid_until: Option<String>,
    pub expired_at: Option<String>,
    pub source: String,
    pub confidence: f64,
    pub claim_metric: Option<String>,
    pub claim_value: Option<f64>,
    pub claim_unit: Option<String>,
    pub claim_period: Option<String>,
}

/// `(sourceId, ids)`: facts of a source by id (`id = ANY($2::bigint[])`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FactIdsInSource {
    pub source_id: String,
    pub ids: Vec<f64>,
}

/// `listExpirableFactIdsOfDeletedPage(sourceId, slug, pageId)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DeletedPageQuery {
    pub source_id: String,
    pub slug: String,
    pub page_id: Option<f64>,
}

/// `(sourceId, slug)`: a page coordinate.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct CoordinateArgs {
    pub source_id: String,
    pub slug: String,
}

/// The distinct ids of a `bigint[]` list, in id order; an id no row can have (below 1) is left out.
fn id_set(op: &str, ids: &[f64]) -> Result<BTreeSet<u64>> {
    let mut out = BTreeSet::new();
    for &id in ids {
        let n = bigint(op, "ids", id)?;
        if n >= 1 {
            out.insert(n as u64);
        }
    }
    Ok(out)
}

/// The soft-deleted page at a coordinate (`pages` keeps one row per `(source_id, slug)`).
fn deleted_page(
    read: &dyn crate::kv::KvRead,
    source_id: &str,
    slug: &str,
) -> Result<Option<PageRecord>> {
    Ok(read_page(read, source_id, slug)?.filter(|p| p.deleted_at_us.is_some()))
}

impl Store {
    /// Updates fact `id` of `source_id` through `change`, when that row exists (`WHERE id = $1 AND source_id = $2`).
    fn update_fact_in_source(
        &self,
        op: &str,
        source_id: &str,
        id: f64,
        change: &mut dyn FnMut(&dyn crate::kv::KvRead, &mut FactRecord) -> Result<()>,
    ) -> Result<()> {
        no_nul(op, &[("sourceId", source_id)])?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = fact_by_number(tx, op, "id", id)? else {
                return Ok(());
            };
            if old.source_id != source_id {
                return Ok(());
            }
            let mut new = old.clone();
            change(&*tx, &mut new)?;
            write_fact(tx, trust, Some(&old), &new)
        })
    }

    /// `listFenceRowSupersession(sourceId, slug)`: `{ id, row_num, expired_at, superseded_by }` of the coordinate's
    /// rows that hold a `row_num`, by id. `expired_at` is ISO text, which the TypeScript member turns into a `Date`.
    pub fn list_fence_row_supersession(&self, q: &CoordinateArgs) -> Result<Vec<Value>> {
        no_nul(
            "listFenceRowSupersession",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        let mut rows = page_rows(&*read, &q.source_id, &q.slug)?;
        rows.sort_by_key(|r| r.id);
        Ok(rows
            .iter()
            .filter(|r| r.row_num.is_some())
            .map(|r| {
                json!({
                    "id": r.id, "row_num": r.row_num, "expired_at": r.expired_at_us.map(iso),
                    "superseded_by": r.superseded_by,
                })
            })
            .collect())
    }

    /// `setFactSupersededBy(sourceId, id, supersededBy)`: sets or clears `superseded_by`. A successor that names no
    /// row is refused, as `facts_superseded_by_fkey` refuses it.
    pub fn set_fact_superseded_by(&self, a: &SupersededByArgs) -> Result<()> {
        const OP: &str = "setFactSupersededBy";
        let by = a
            .superseded_by
            .map(|b| bigint(OP, "supersededBy", b))
            .transpose()?;
        self.update_fact_in_source(OP, &a.source_id, a.id, &mut |read, row| {
            row.superseded_by = match by {
                None => None,
                Some(b) if b >= 1 && read_fact(read, b as u64)?.is_some() => Some(b as u64),
                Some(_) => return Err(foreign_key("facts_superseded_by_fkey")),
            };
            Ok(())
        })
    }

    /// `expireFactInPlace(sourceId, id)`: `expired_at = COALESCE(expired_at, now())`; the row keeps its number.
    pub fn expire_fact_in_place(&self, a: &FactInSource) -> Result<()> {
        let now = self.env.now_micros();
        self.update_fact_in_source("expireFactInPlace", &a.source_id, a.id, &mut |_, row| {
            row.expired_at_us = row.expired_at_us.or(Some(now));
            Ok(())
        })
    }

    /// `expireAndDetachFact(sourceId, id)`: as `expireFactInPlace`, and `row_num = NULL`.
    pub fn expire_and_detach_fact(&self, a: &FactInSource) -> Result<()> {
        let now = self.env.now_micros();
        self.update_fact_in_source("expireAndDetachFact", &a.source_id, a.id, &mut |_, row| {
            row.expired_at_us = row.expired_at_us.or(Some(now));
            row.row_num = None;
            Ok(())
        })
    }

    /// `updateFenceFactCells(sourceId, id, cells)`: writes a fence row's cells onto the fact. A null `validFrom`
    /// keeps the stored one, and so does one equal to the stored instant to the second (#10055: a sub-second
    /// `remember` instant survives its whole-second fence cell); `validUntil` is written only with `setValidUntil`; a null `expiredAt` clears the
    /// expiry and a time keeps an existing one (`COALESCE(expired_at, $10)`). `confidence` is a `REAL`.
    pub fn update_fence_fact_cells(&self, a: &FenceCellsArgs) -> Result<()> {
        const OP: &str = "updateFenceFactCells";
        let valid_from = opt_time(OP, "validFrom", &a.valid_from)?;
        let valid_until = opt_time(OP, "validUntil", &a.valid_until)?;
        let expired_at = opt_time(OP, "expiredAt", &a.expired_at)?;
        self.update_fact_in_source(OP, &a.source_id, a.id, &mut |read, row| {
            row.kind = a.kind.clone();
            row.visibility = a.visibility.clone();
            row.notability = a.notability.clone();
            row.context = a.context.clone();
            if let Some(from) = valid_from
                && row.valid_from_us != from
                && super::fence_projection::whole_second(row.valid_from_us) != from
            {
                row.valid_from_us = from;
            }
            if a.set_valid_until {
                row.valid_until_us = valid_until;
            }
            row.expired_at_us = expired_at.map(|at| row.expired_at_us.unwrap_or(at));
            row.source = a.source.clone();
            row.confidence = a.confidence as f32;
            row.claim_metric = a.claim_metric.clone();
            row.claim_value = a.claim_value;
            row.claim_unit = a.claim_unit.clone();
            row.claim_period = a.claim_period.clone();
            check_row(OP, row)?;
            preserve_withdrawal(read, row)
        })
    }

    /// `listHeldWideningFactIds(sourceId, ids)`: `{ id }` for each `supersede_fact` or `confirm` proposal of the
    /// source that names one of `ids` as its related fact, is pending, rejected or undone, and has a `visibility`
    /// key in its before state; a fact two proposals hold is named twice, as the statement names it.
    pub fn list_held_widening_fact_ids(&self, q: &FactIdsInSource) -> Result<Vec<Value>> {
        const OP: &str = "listHeldWideningFactIds";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        let ids = id_set(OP, &q.ids)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for id in ids {
            for _ in 0..held_narrower_in(&*read, Some(&q.source_id), id)? {
                out.push(json!({ "id": id }));
            }
        }
        Ok(out)
    }

    /// `listDeletedPageSlugsWithActiveFacts(sourceId)`: `{ slug }` of each soft-deleted page of the source that still
    /// has an unexpired fence row, in byte order.
    pub fn list_deleted_page_slugs_with_active_facts(&self, source_id: &str) -> Result<Vec<Value>> {
        no_nul(
            "listDeletedPageSlugsWithActiveFacts",
            &[("sourceId", source_id)],
        )?;
        let read = self.read()?;
        let mut slugs = BTreeSet::new();
        for row in source_rows(&*read, source_id)? {
            if row.row_num.is_none() || row.expired_at_us.is_some() {
                continue;
            }
            let Some(slug) = row.source_markdown_slug.as_deref() else {
                continue;
            };
            if !slugs.contains(slug) && deleted_page(&*read, source_id, slug)?.is_some() {
                slugs.insert(slug.to_string());
            }
        }
        Ok(slugs
            .into_iter()
            .map(|slug| json!({ "slug": slug }))
            .collect())
    }

    /// `listExpirableFactIdsOfDeletedPage(sourceId, slug, pageId)`: `{ id }` of the coordinate's unexpired fence rows
    /// when its page is soft-deleted and, with `pageId`, has that id; by id.
    pub fn list_expirable_fact_ids_of_deleted_page(
        &self,
        q: &DeletedPageQuery,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listExpirableFactIdsOfDeletedPage";
        no_nul(OP, &[("sourceId", &q.source_id), ("slug", &q.slug)])?;
        let page_id = q.page_id.map(|p| bigint(OP, "pageId", p)).transpose()?;
        let read = self.read()?;
        let Some(page) = deleted_page(&*read, &q.source_id, &q.slug)? else {
            return Ok(Vec::new());
        };
        if page_id.is_some_and(|id| u64::try_from(id).ok() != Some(page.id)) {
            return Ok(Vec::new());
        }
        let mut rows = page_rows(&*read, &q.source_id, &q.slug)?;
        rows.sort_by_key(|r| r.id);
        Ok(rows
            .iter()
            .filter(|r| r.row_num.is_some() && r.expired_at_us.is_none())
            .map(|r| json!({ "id": r.id }))
            .collect())
    }

    /// `readDeletedPageBody(sourceId, slug)`: `{ compiled_truth, timeline, body_storage }` of the coordinate's
    /// soft-deleted page, or null when the page is live or missing.
    pub fn read_deleted_page_body(&self, q: &CoordinateArgs) -> Result<Value> {
        no_nul(
            "readDeletedPageBody",
            &[("sourceId", &q.source_id), ("slug", &q.slug)],
        )?;
        let read = self.read()?;
        let Some(page) = deleted_page(&*read, &q.source_id, &q.slug)? else {
            return Ok(Value::Null);
        };
        let (body_storage, _) = body_storage_columns(&*read, page.id)?;
        Ok(json!({
            "compiled_truth": page.compiled_truth.as_deref(), "timeline": page.timeline.as_deref(),
            "body_storage": body_storage,
        }))
    }

    /// `expireFactsByIds(sourceId, ids)`: expires the unexpired rows of the source among `ids` now; `{ id }` of each
    /// row it expired, by id.
    pub fn expire_facts_by_ids(&self, q: &FactIdsInSource) -> Result<Vec<Value>> {
        const OP: &str = "expireFactsByIds";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        let ids = id_set(OP, &q.ids)?;
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut out = Vec::new();
            for id in &ids {
                let Some(old) = read_fact(tx, *id)? else {
                    continue;
                };
                if old.source_id != q.source_id || old.expired_at_us.is_some() {
                    continue;
                }
                let mut new = old.clone();
                new.expired_at_us = Some(now);
                write_fact(tx, trust, Some(&old), &new)?;
                out.push(json!({ "id": id }));
            }
            Ok(out)
        })
    }
}
