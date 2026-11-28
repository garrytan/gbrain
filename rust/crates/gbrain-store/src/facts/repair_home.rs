//! The reads behind the scan of `gbrain repair facts-home` and the approved-set digests of the maintenance repairs
//! (`src/core/engine-sql/facts-repair.ts`):
//!
//! - `listFactsHomeCandidates(sourceId)`: the active facts with no fence position (ontology rows too), with whether
//!   the entity has a live and a soft-deleted page, by entity (no entity first) then id;
//! - `listHeldHomeRows(sourceId, days)`: the fence rows held on a holding page of the source that name an entity
//!   which is not itself a holding slug, with whether the entity has a live page, the `created_at` second and whether
//!   the row is more than `days` days old, by entity then id;
//! - `listOrphanedFenceRows(sourceId)`: the active fence rows whose page is not live, by id;
//! - `readFactSnapshots(sourceId, ids)`: the 27 columns of each named fact as the `jsonb_build_object` the SQL builds.
//!
//! Text ordering is byte order, as for the other facts reads (the same for the lowercase slugs these columns hold).
//! `days` counts 24-hour days from the store's clock (the SQL's `interval '30 days'` is the same on a UTC session).
//! Timestamps in a snapshot are the text a `timestamptz` gives `jsonb`: `2026-02-03T10:11:12.345678+00:00`, no
//! fraction zeros.

use super::privacy::holding_slug;
use super::purge::fence_columns;
use super::{FactRecord, real, source_rows};
use crate::Store;
use crate::cli_reads::pg_text::timestamptz_text;
use crate::env::iso;
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::read_page;
use serde::Deserialize;
use serde_json::{Map, Value, json};

const DAY_US: i64 = 86_400_000_000;

/// `listFactsHomeCandidates(sourceId)` and `listOrphanedFenceRows(sourceId)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct HomeSourceArgs {
    pub source_id: String,
}

/// `listHeldHomeRows(sourceId, days)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct HeldHomeArgs {
    pub source_id: String,
    pub days: i64,
}

/// `readFactSnapshots(sourceId, ids)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotArgs {
    pub source_id: String,
    pub ids: Vec<u64>,
}

/// The text `jsonb` shows a `timestamptz` (UTC session): `timestamptz::text` with a `T` and a `+00:00` offset.
fn jsonb_time(us: i64) -> String {
    format!("{}:00", timestamptz_text(us).replacen(' ', "T", 1))
}

/// The columns every row of the scan reads: `id`, `source_id`, `entity_slug`, `fact` and the fence columns.
fn base_row(r: &FactRecord) -> Map<String, Value> {
    let mut row = Map::new();
    row.insert("id".into(), json!(r.id));
    row.insert("source_id".into(), json!(r.source_id));
    row.insert("entity_slug".into(), json!(r.entity_slug));
    row.insert("fact".into(), json!(r.fact));
    fence_columns(&mut row, r);
    row
}

impl Store {
    /// `listFactsHomeCandidates`: by entity (a fact with no entity first), then id.
    pub fn list_facts_home_candidates(&self, a: &HomeSourceArgs) -> Result<Vec<Value>> {
        no_nul("listFactsHomeCandidates", &[("sourceId", &a.source_id)])?;
        let read = self.read()?;
        let mut rows: Vec<FactRecord> = source_rows(&*read, &a.source_id)?
            .into_iter()
            .filter(|r| r.row_num.is_none() && r.expired_at_us.is_none())
            .collect();
        rows.sort_by(|a, b| a.entity_slug.cmp(&b.entity_slug).then(a.id.cmp(&b.id)));
        let mut out = Vec::with_capacity(rows.len());
        for r in &rows {
            let page = match &r.entity_slug {
                Some(slug) => read_page(&*read, &r.source_id, slug)?,
                None => None,
            };
            let mut row = base_row(r);
            row.insert("dimension".into(), json!(r.dimension));
            row.insert(
                "page_exists".into(),
                json!(page.as_ref().is_some_and(|p| p.deleted_at_us.is_none())),
            );
            row.insert(
                "page_deleted".into(),
                json!(page.as_ref().is_some_and(|p| p.deleted_at_us.is_some())),
            );
            out.push(Value::Object(row));
        }
        Ok(out)
    }

    /// `listHeldHomeRows`: by entity, then id.
    pub fn list_held_home_rows(&self, a: &HeldHomeArgs) -> Result<Vec<Value>> {
        no_nul("listHeldHomeRows", &[("sourceId", &a.source_id)])?;
        let now = self.env.now_micros();
        let read = self.read()?;
        let mut rows = Vec::new();
        for r in source_rows(&*read, &a.source_id)? {
            let (Some(entity), Some(held_on)) = (&r.entity_slug, &r.source_markdown_slug) else {
                continue;
            };
            if r.row_num.is_none() || r.expired_at_us.is_some() || r.dimension.is_some() {
                continue;
            }
            if holding_slug(entity) || !holding_slug(held_on) {
                continue;
            }
            // The holding page itself may be live or soft-deleted: the SQL's subquery reads `pages` unfiltered.
            if read_page(&*read, &r.source_id, held_on)?.is_none() {
                continue;
            }
            rows.push(r);
        }
        rows.sort_by(|a, b| a.entity_slug.cmp(&b.entity_slug).then(a.id.cmp(&b.id)));
        let mut out = Vec::with_capacity(rows.len());
        for r in &rows {
            let entity = r.entity_slug.as_deref().unwrap_or_default();
            let live =
                read_page(&*read, &r.source_id, entity)?.is_some_and(|p| p.deleted_at_us.is_none());
            let mut row = base_row(r);
            row.insert("page_exists".into(), json!(live));
            row.insert("from_slug".into(), json!(r.source_markdown_slug));
            row.insert(
                "held_since".into(),
                json!(format!("{}Z", &iso(r.created_at_us)[..19])),
            );
            row.insert(
                "old".into(),
                json!(r.created_at_us < now.saturating_sub(a.days.saturating_mul(DAY_US))),
            );
            out.push(Value::Object(row));
        }
        Ok(out)
    }

    /// `listOrphanedFenceRows`: by id.
    pub fn list_orphaned_fence_rows(&self, a: &HomeSourceArgs) -> Result<Vec<Value>> {
        no_nul("listOrphanedFenceRows", &[("sourceId", &a.source_id)])?;
        let read = self.read()?;
        let mut rows: Vec<FactRecord> = source_rows(&*read, &a.source_id)?
            .into_iter()
            .filter(|r| r.row_num.is_some() && r.expired_at_us.is_none())
            .collect();
        rows.sort_by_key(|r| r.id);
        let mut out = Vec::new();
        for r in &rows {
            // `p.slug = f.source_markdown_slug` is never true for a NULL slug: such a row has no live page.
            let live = match &r.source_markdown_slug {
                Some(slug) => read_page(&*read, &r.source_id, slug)?
                    .is_some_and(|p| p.deleted_at_us.is_none()),
                None => false,
            };
            if !live {
                out.push(json!({ "id": r.id, "slug": r.source_markdown_slug }));
            }
        }
        Ok(out)
    }

    /// `readFactSnapshots`: by id; an id that names no fact of the source gives no row.
    pub fn read_fact_snapshots(&self, a: &SnapshotArgs) -> Result<Vec<Value>> {
        no_nul("readFactSnapshots", &[("sourceId", &a.source_id)])?;
        let mut rows: Vec<FactRecord> = source_rows(&*self.read()?, &a.source_id)?
            .into_iter()
            .filter(|r| a.ids.contains(&r.id))
            .collect();
        rows.sort_by_key(|r| r.id);
        let time = |us: Option<i64>| us.map(jsonb_time);
        Ok(rows
            .iter()
            .map(|r| {
                json!({ "id": r.id, "value": {
                    "source_id": r.source_id, "entity_slug": r.entity_slug, "source_markdown_slug": r.source_markdown_slug,
                    "row_num": r.row_num, "fact": r.fact, "kind": r.kind, "visibility": r.visibility,
                    "notability": r.notability, "context": r.context, "valid_from": r.valid_from().map(jsonb_time),
                    "valid_until": time(r.valid_until_us), "expired_at": time(r.expired_at_us),
                    "superseded_by": r.superseded_by, "consolidated_at": time(r.consolidated_at_us),
                    "consolidated_into": r.consolidated_into, "source": r.source, "source_session": r.source_session,
                    "confidence": real(r.confidence), "claim_metric": r.claim_metric, "claim_value": r.claim_value,
                    "claim_unit": r.claim_unit, "claim_period": r.claim_period, "event_type": r.event_type,
                    "dimension": r.dimension, "value": r.value, "dim_status": r.dim_status,
                    "attributed_to": r.attributed_to } })
            })
            .collect())
    }
}
