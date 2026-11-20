//! The maintenance sweep's page reads served from the store (SQL in `src/core/engine-sql/sweep-reads.ts`, docs in
//! `rust/docs/store/sweep-reads.md`): the facts-fence pass's pages, the links and timeline pass's stale pages and the
//! deferred segmented pages that are still stale.
//!
//! Each read scans every page record and filters in memory (the store has no `(source, updated_at)` index). Pages are
//! ordered by `updated_at` newest first, then by id newest first; the SQL leaves a tie in no set order.

use crate::Store;
use crate::env::{iso, parse_iso, transaction_clock};
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::extraction::links_extracted_at_us;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::page_body::{body_storage_columns, has_published_facts_slot};
use crate::pages::{PageRecord, all_pages};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

/// The begin marker of a facts fence (`FACTS_FENCE_BEGIN_MARKER`).
const FACTS_FENCE_BEGIN_MARKER: &str = "gbrain:facts:begin";

/// `listFactsFencePages({ sourceId, since, scanCap, limit })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactsFencePagesSpec {
    pub source_id: String,
    pub since: String,
    pub scan_cap: i64,
    pub limit: i64,
}

/// `listSweepStalePages({ sourceId, since, limit, exclude })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SweepStalePagesSpec {
    pub source_id: String,
    pub since: String,
    pub limit: i64,
    #[serde(default)]
    pub exclude: Vec<String>,
}

/// `listSweepDeferredPages({ sourceId, since, slugs })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SweepDeferredPagesSpec {
    pub source_id: String,
    pub since: String,
    pub slugs: Vec<String>,
}

/// `listPageRefsForSlugs({ slugs })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRefsForSlugsSpec {
    pub slugs: Vec<String>,
}

/// `$n::timestamptz` of an ISO string; `invalid_argument` for any other shape.
fn since_us(op: &str, text: &str) -> Result<i64> {
    parse_iso(text).ok_or_else(|| {
        StoreError::new(
            INVALID_ARGUMENT,
            format!(
                "{op}: invalid input syntax for type timestamp with time zone: \"{text}\" (the rust engine reads ISO 8601 UTC strings ending in Z)"
            ),
        )
    })
}

/// `LIMIT n`: a negative value is refused as Postgres refuses it.
fn limit(n: i64) -> Result<usize> {
    usize::try_from(n).map_err(|_| StoreError::new(INVALID_ARGUMENT, "LIMIT must not be negative"))
}

/// The live pages of `source` updated at or after `since`, newest first (then id newest first).
fn recent_pages(read: &dyn KvRead, source: &str, since: i64) -> Result<Vec<PageRecord>> {
    let mut pages: Vec<PageRecord> = all_pages(read)?
        .into_iter()
        .filter(|p| p.source_id == source && p.deleted_at_us.is_none() && p.updated_at_us >= since)
        .collect();
    pages.sort_by(|a, b| b.updated_at_us.cmp(&a.updated_at_us).then(b.id.cmp(&a.id)));
    Ok(pages)
}

/// `links_extracted_at IS NULL OR updated_at > links_extracted_at`.
fn links_stale(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    Ok(links_extracted_at_us(read, page.id)?.is_none_or(|stamp| page.updated_at_us > stamp))
}

impl Store {
    /// `listFactsFencePages`: of the newest `scanCap` recent live pages of the source, the slugs of those whose compiled
    /// truth holds the fence marker or that are segmented with a published facts slot, newest first, at most `limit`.
    pub fn list_facts_fence_pages(&self, spec: &FactsFencePagesSpec) -> Result<Vec<String>> {
        let op = "listFactsFencePages";
        no_nul(op, &[("sourceId", &spec.source_id)])?;
        let since = since_us(op, &spec.since)?;
        let (scan_cap, keep) = (limit(spec.scan_cap)?, limit(spec.limit)?);
        let read = self.read()?;
        let mut out = Vec::new();
        for page in recent_pages(&*read, &spec.source_id, since)?
            .into_iter()
            .take(scan_cap)
        {
            if out.len() >= keep {
                break;
            }
            let fenced = page.compiled_truth.contains(FACTS_FENCE_BEGIN_MARKER)
                || (body_storage_columns(&*read, page.id)?.0 == "segmented"
                    && has_published_facts_slot(&*read, page.id)?);
            if fenced {
                out.push(page.slug);
            }
        }
        Ok(out)
    }

    /// `listSweepStalePages`: recent live pages of the source whose links watermark is absent or older than the page,
    /// less `exclude`, newest first, at most `limit`; `read_at` is the transaction clock in full-µs UTC.
    pub fn list_sweep_stale_pages(&self, spec: &SweepStalePagesSpec) -> Result<Vec<Value>> {
        let op = "listSweepStalePages";
        no_nul(op, &[("sourceId", &spec.source_id)])?;
        let since = since_us(op, &spec.since)?;
        let keep = limit(spec.limit)?;
        let excluded: HashSet<&str> = spec.exclude.iter().map(String::as_str).collect();
        let read_at =
            iso(transaction_clock::transaction_now().unwrap_or_else(|| self.env.now_micros()));
        let read = self.read()?;
        let mut out = Vec::new();
        for page in recent_pages(&*read, &spec.source_id, since)? {
            if out.len() >= keep {
                break;
            }
            if excluded.contains(page.slug.as_str()) || !links_stale(&*read, &page)? {
                continue;
            }
            let (body_storage, body_bytes) = body_storage_columns(&*read, page.id)?;
            out.push(json!({
                "slug": page.slug,
                "read_at": read_at,
                "updated_at_iso": iso(page.updated_at_us),
                "body_storage": body_storage,
                "body_bytes": body_bytes,
            }));
        }
        Ok(out)
    }

    /// `listSweepDeferredPages`: of `slugs`, the recent live pages of the source that are still link-stale.
    pub fn list_sweep_deferred_pages(&self, spec: &SweepDeferredPagesSpec) -> Result<Vec<Value>> {
        let op = "listSweepDeferredPages";
        no_nul(op, &[("sourceId", &spec.source_id)])?;
        let since = since_us(op, &spec.since)?;
        if spec.slugs.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: HashSet<&str> = spec.slugs.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut out = Vec::new();
        for page in recent_pages(&*read, &spec.source_id, since)? {
            if wanted.contains(page.slug.as_str()) && links_stale(&*read, &page)? {
                out.push(json!({ "slug": page.slug, "updated_at_iso": iso(page.updated_at_us) }));
            }
        }
        Ok(out)
    }

    /// `listPageRefsForSlugs`: the live pages of any source whose slug is in `slugs`, by source then slug:
    /// `{ slug, source_id, type, knowledge_revision }`.
    pub fn list_page_refs_for_slugs(&self, spec: &PageRefsForSlugsSpec) -> Result<Vec<Value>> {
        let op = "listPageRefsForSlugs";
        for slug in &spec.slugs {
            no_nul(op, &[("slug", slug)])?;
        }
        if spec.slugs.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: HashSet<&str> = spec.slugs.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && wanted.contains(p.slug.as_str()))
            .collect();
        pages.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
        Ok(pages
            .into_iter()
            .map(|p| {
                json!({
                    "slug": p.slug,
                    "source_id": p.source_id,
                    "type": p.page_type,
                    "knowledge_revision": p.knowledge_revision,
                })
            })
            .collect())
    }
}
