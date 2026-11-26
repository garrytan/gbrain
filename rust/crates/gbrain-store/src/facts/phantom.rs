//! The phantom redirect's fact, page and timeline statements (src/core/engine-sql/facts-cycle.ts): the reads and the
//! move that `cycle/phantom-redirect.ts` and `cycle/phantom-redirect-managed.ts` ran through `executeRaw`.
//!
//! Members: listPhantomFactRows, listCanonicalFenceRowNums, moveFactToPage, listActiveFactIdsOfPage,
//! listFactIdsStillOnPage, listRootPageSlugsAfter, listOntologyObservationSlugs, pageHasTimelineEntries.
//! `maxFenceRowNumOfPage` and `readFenceRowNumHint` run the same statement as `maxFenceRowNum` (`facts/cycle.rs`), and
//! the link statements of the phantom merge are in `links/phantom_merge.rs`.
//!
//! A statement with no `ORDER BY` answers in id (or slug byte) order here; its callers depend on no order.
//! `moveFactToPage` sets `entity_slug` and `expired_at`, so it runs the withdrawal guard ([`preserve_withdrawal`]) and
//! then writes through [`write_fact`], which keeps the trust stamp, the purge ledger, the by-page index and the unique
//! fence key. rust/docs/store/facts.md, "Facts cycle, phantom redirect and fence-guard statements", lists what each
//! member answers.

use super::withdrawal_guard::preserve_withdrawal;
use super::{
    bigint, check_row, count_arg, fact_by_number, invalid, page_rows, read_fact, source_rows,
    write_fact,
};
use crate::Store;
use crate::StoreError;
use crate::error::Result;
use crate::facts::cycle::PageCoordinate;
use crate::keys;
use crate::kv::scan_prefix;
use crate::links::no_nul;
use crate::pages::PageRecord;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `moveFactToPage(sourceId, id, slug, rowNum)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveFactArgs {
    pub source_id: String,
    pub id: f64,
    pub slug: String,
    pub row_num: Option<f64>,
}

/// `listFactIdsStillOnPage(ids, slug)`: no source filter, as the statement has none.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FactIdsOnPage {
    pub ids: Vec<f64>,
    pub slug: String,
}

/// `listRootPageSlugsAfter(sourceId, take, held, after)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RootSlugsQuery {
    pub source_id: String,
    pub take: f64,
    pub held: Vec<String>,
    pub after: String,
}

/// A JavaScript number bound to `$n::integer`.
fn integer(op: &str, what: &str, value: f64) -> Result<i32> {
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(invalid(format!(
            "{op}: invalid input syntax for type integer: \"{value}\" ({what})"
        )));
    }
    i32::try_from(value as i64).map_err(|_| {
        invalid(format!(
            "{op}: value \"{value}\" is out of range for type integer ({what})"
        ))
    })
}

/// The coordinate's rows, in id order.
fn coordinate_rows(
    read: &dyn crate::kv::KvRead,
    op: &str,
    q: &PageCoordinate,
) -> Result<Vec<super::FactRecord>> {
    no_nul(op, &[("sourceId", &q.source_id), ("slug", &q.slug)])?;
    let mut rows = page_rows(read, &q.source_id, &q.slug)?;
    rows.sort_by_key(|r| r.id);
    Ok(rows)
}

impl Store {
    /// `listPhantomFactRows(sourceId, slug)`: `{ id, row_num }` of every fact on the coordinate, by id.
    pub fn list_phantom_fact_rows(&self, q: &PageCoordinate) -> Result<Vec<Value>> {
        let read = self.read()?;
        let rows = coordinate_rows(&*read, "listPhantomFactRows", q)?;
        Ok(rows
            .iter()
            .map(|r| json!({ "id": r.id, "row_num": r.row_num }))
            .collect())
    }

    /// `listCanonicalFenceRowNums(sourceId, slug)`: `{ row_num }` of the coordinate's facts that hold one, by id.
    pub fn list_canonical_fence_row_nums(&self, q: &PageCoordinate) -> Result<Vec<Value>> {
        let read = self.read()?;
        let rows = coordinate_rows(&*read, "listCanonicalFenceRowNums", q)?;
        Ok(rows
            .iter()
            .filter_map(|r| r.row_num)
            .map(|n| json!({ "row_num": n }))
            .collect())
    }

    /// `listActiveFactIdsOfPage(sourceId, slug)`: `{ id }` of the coordinate's unexpired facts, by id.
    pub fn list_active_fact_ids_of_page(&self, q: &PageCoordinate) -> Result<Vec<Value>> {
        let read = self.read()?;
        let rows = coordinate_rows(&*read, "listActiveFactIdsOfPage", q)?;
        Ok(rows
            .iter()
            .filter(|r| r.expired_at_us.is_none())
            .map(|r| json!({ "id": r.id }))
            .collect())
    }

    /// `listFactIdsStillOnPage(ids, slug)`: `{ id }` of the named facts, of any source, that are unexpired and sit on
    /// page `slug`, by id; a duplicate id answers once.
    pub fn list_fact_ids_still_on_page(&self, q: &FactIdsOnPage) -> Result<Vec<Value>> {
        const OP: &str = "listFactIdsStillOnPage";
        no_nul(OP, &[("slug", &q.slug)])?;
        let mut ids = BTreeSet::new();
        for &id in &q.ids {
            let n = bigint(OP, "ids", id)?;
            if n >= 1 {
                ids.insert(n as u64);
            }
        }
        let read = self.read()?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(row) = read_fact(&*read, id)?
                && row.expired_at_us.is_none()
                && row.source_markdown_slug.as_deref() == Some(q.slug.as_str())
            {
                out.push(json!({ "id": row.id }));
            }
        }
        Ok(out)
    }

    /// `moveFactToPage(sourceId, id, slug, rowNum)`: points the fact at page `slug` (entity and fence page) under
    /// `rowNum`; a null `rowNum` also expires it at now unless it already expired. A fact of another source, or no
    /// fact, is left alone. A row number another fact of the page holds refuses with `constraint_violation`.
    pub fn move_fact_to_page(&self, a: &MoveFactArgs) -> Result<()> {
        const OP: &str = "moveFactToPage";
        no_nul(OP, &[("sourceId", &a.source_id), ("slug", &a.slug)])?;
        let row_num = a.row_num.map(|n| integer(OP, "rowNum", n)).transpose()?;
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = fact_by_number(tx, OP, "id", a.id)? else {
                return Ok(());
            };
            if old.source_id != a.source_id {
                return Ok(());
            }
            let mut new = old.clone();
            new.entity_slug = Some(a.slug.clone());
            new.source_markdown_slug = Some(a.slug.clone());
            new.row_num = row_num;
            if row_num.is_none() {
                new.expired_at_us = new.expired_at_us.or(Some(now));
            }
            check_row(OP, &new)?;
            preserve_withdrawal(&*tx, &mut new)?;
            write_fact(tx, trust, Some(&old), &new)
        })
    }

    /// `listOntologyObservationSlugs(sourceId)`: `{ slug }` for each distinct fence page with no `/` that holds an
    /// unexpired fact with a `dimension`, in byte order.
    pub fn list_ontology_observation_slugs(&self, source_id: &str) -> Result<Vec<Value>> {
        no_nul("listOntologyObservationSlugs", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let slugs: BTreeSet<String> = source_rows(&*read, source_id)?
            .into_iter()
            .filter(|r| r.dimension.is_some() && r.expired_at_us.is_none())
            .filter_map(|r| r.source_markdown_slug)
            .filter(|slug| !slug.contains('/'))
            .collect();
        Ok(slugs
            .into_iter()
            .map(|slug| json!({ "slug": slug }))
            .collect())
    }

    /// `listRootPageSlugsAfter(sourceId, take, held, after)`: `{ slug }` of the source's live pages with no `/` in the
    /// slug, not in `held`, past `after`, in byte order of slug, at most `take`.
    pub fn list_root_page_slugs_after(&self, q: &RootSlugsQuery) -> Result<Vec<Value>> {
        const OP: &str = "listRootPageSlugsAfter";
        no_nul(OP, &[("sourceId", &q.source_id), ("after", &q.after)])?;
        for slug in &q.held {
            no_nul(OP, &[("held", slug)])?;
        }
        let take = count_arg(OP, "take", q.take)?;
        let held: BTreeSet<&str> = q.held.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut out = Vec::new();
        let mut failure = None;
        if take > 0 {
            scan_prefix(&*read, &keys::page(&q.source_id, ""), false, &mut |_, v| {
                let page = match serde_json::from_slice::<PageRecord>(v) {
                    Ok(page) => page,
                    Err(e) => {
                        failure = Some(StoreError::from(e));
                        return false;
                    }
                };
                if page.source_id == q.source_id
                    && page.deleted_at_us.is_none()
                    && !page.slug.contains('/')
                    && !held.contains(page.slug.as_str())
                    && page.slug.as_str() > q.after.as_str()
                {
                    out.push(json!({ "slug": page.slug }));
                }
                out.len() < take
            })?;
        }
        failure.map_or(Ok(out), Err)
    }

    /// `pageHasTimelineEntries(pageId)`: whether page `pageId` holds a timeline entry; a null id holds none.
    pub fn page_has_timeline_entries(&self, page_id: Option<f64>) -> Result<bool> {
        let Some(page_id) = page_id else {
            return Ok(false);
        };
        let id = bigint("pageHasTimelineEntries", "pageId", page_id)?;
        if id < 1 {
            return Ok(false);
        }
        let read = self.read()?;
        let mut found = false;
        scan_prefix(
            &*read,
            &keys::timeline_prefix(id as u64),
            false,
            &mut |_, _| {
                found = true;
                false
            },
        )?;
        Ok(found)
    }
}
