//! The reads of a page purge (src/core/engine-sql/page-purge.ts), served from the fact, take, link, version,
//! chunk, timeline and journal records.
//!
//! A page's facts are `PAGE_FACTS` of the SQL: the facts filed on it (`source_markdown_slug` is its slug) and the facts
//! extracted from it and filed on none (`extractedFromPageSql`: no slug, a page-extraction source, and a context whose
//! head is the slug). The filed ones come from the page's index; the extracted ones have no index here, so a read of them
//! walks the source's facts (as `countPurgedPageFacts` does). The fingerprint is `gbrain_fact_fingerprint`
//! (`fact_fingerprint`), the one the fact and take purge ledgers use.
//!
//! Members: `listPurgeClaimFacts`, `listPurgeClaimTakes`, `listPurgeSegmentClaims`, `listQueuedPagePurges`,
//! `listPageLinkStreams`, `readPurgePageBody`, `listPageMirrorFacts`, `listPageMirrorTakeHashes`, `countPageCascadeRows`,
//! `listPageVersionSourcePaths`, `listPageVersionBodiesForPurge`. The writes and the tombstone reads live with their
//! ledgers (`page_purges.rs`, `purge_ledger.rs`, `take_purges.rs`).

use super::purge::outcome_marker;
use super::repair::{PAGE_EXTRACTION_SOURCES, context_head};
use super::{FactRecord, fact_fingerprint, page_rows, source_rows};
use crate::Store;
use crate::chunks::read_chunks;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::links::{in_links, no_nul, out_links};
use crate::page_body::read_body_state;
use crate::pages::{read_page, read_page_by_id, versions_of};
use crate::takes::page_takes;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `LIMIT 1000` of the claim reads.
const CLAIM_LIMIT: usize = 1000;
/// `LIMIT 64` of the version source path read.
const SOURCE_PATH_LIMIT: usize = 64;

/// A page's facts, filed on it or extracted from it (`PAGE_FACTS`), by id.
pub(crate) fn page_facts(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
) -> Result<Vec<FactRecord>> {
    let mut rows = page_rows(read, source_id, slug)?;
    for f in source_rows(read, source_id)? {
        if f.source_markdown_slug.is_none()
            && PAGE_EXTRACTION_SOURCES.contains(&f.source.as_str())
            && f.context.as_deref().map(context_head) == Some(slug)
        {
            rows.push(f);
        }
    }
    rows.sort_by_key(|f| f.id);
    Ok(rows)
}

/// The page id of a SQL `integer` argument: a negative or unknown id names no page.
fn page_u64(page_id: i64) -> Option<u64> {
    u64::try_from(page_id).ok()
}

/// The takes of a page by id; a page id that names no page has none.
fn takes_of(read: &dyn KvRead, page_id: i64) -> Result<Vec<crate::takes::TakeRecord>> {
    let Some(id) = page_u64(page_id) else {
        return Ok(Vec::new());
    };
    let mut takes = page_takes(read, id)?;
    takes.sort_by_key(|t| t.id);
    Ok(takes)
}

/// The sort the SQL's `DISTINCT` leaves open, as byte order (the caller sorts the same way).
fn distinct_sorted(values: BTreeSet<String>) -> Vec<String> {
    values.into_iter().collect()
}

/// The facts of `page_facts` that are not outcome markers, with their purge fingerprint.
fn mirror_rows(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
) -> Result<BTreeSet<(String, String, String)>> {
    Ok(page_facts(read, source_id, slug)?
        .iter()
        .filter(|f| !outcome_marker(f))
        .map(|f| {
            (
                fact_fingerprint(&f.fact),
                f.visibility.clone(),
                f.entity_slug.clone().unwrap_or_else(|| "*".to_string()),
            )
        })
        .collect())
}

/// The `(fact_hash, visibility, subject)` of every distinct claim a page purge tombstones, for
/// [`Store::insert_page_fact_purges`].
pub(super) fn page_fact_tombstones(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
) -> Result<Vec<(String, String, String)>> {
    Ok(mirror_rows(read, source_id, slug)?.into_iter().collect())
}

impl Store {
    /// `listPurgeClaimFacts`: `{ id, fact, source }` of the page's first 1000 facts, by id.
    pub fn list_purge_claim_facts(&self, source_id: &str, slug: &str) -> Result<Vec<Value>> {
        no_nul(
            "listPurgeClaimFacts",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        Ok(page_facts(&*read, source_id, slug)?
            .into_iter()
            .take(CLAIM_LIMIT)
            .map(|f| json!({ "id": f.id, "fact": f.fact, "source": f.source }))
            .collect())
    }

    /// `listPurgeClaimTakes`: `{ id, claim }` of the page's first 1000 takes, by id.
    pub fn list_purge_claim_takes(&self, page_id: i64) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(takes_of(&*read, page_id)?
            .into_iter()
            .take(CLAIM_LIMIT)
            .map(|t| json!({ "id": t.id, "claim": t.claim }))
            .collect())
    }

    /// `listPurgeSegmentClaims`: the text of every fact of the page that is not an outcome marker and of every take of
    /// `page_id`, each once, in byte order (the SQL's `UNION` has no order).
    pub fn list_purge_segment_claims(
        &self,
        source_id: &str,
        slug: &str,
        page_id: i64,
    ) -> Result<Vec<String>> {
        no_nul(
            "listPurgeSegmentClaims",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        let mut claims: BTreeSet<String> = page_facts(&*read, source_id, slug)?
            .into_iter()
            .filter(|f| !outcome_marker(f))
            .map(|f| f.fact)
            .collect();
        claims.extend(takes_of(&*read, page_id)?.into_iter().map(|t| t.claim));
        Ok(distinct_sorted(claims))
    }

    /// `listQueuedPagePurges`: the queued `delete_page` requests of the source with `intent.purge` true and a sequence
    /// over `after`, by sequence, up to `limit`, each with the id of the page at its slug (null when there is none).
    pub fn list_queued_page_purges(
        &self,
        source_id: &str,
        after: &str,
        limit: i64,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listQueuedPagePurges";
        no_nul(OP, &[("sourceId", source_id)])?;
        let after: i128 = after
            .trim()
            .parse()
            .map_err(|_| StoreError::invalid(format!("{OP}: after is not a bigint")))?;
        let limit = usize::try_from(limit)
            .map_err(|_| StoreError::invalid(format!("{OP}: LIMIT must not be negative")))?;
        let read = self.read()?;
        let mut queued = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &[keys::REQUEST], false, &mut |_, v| {
            match serde_json::from_slice::<RequestRecord>(v) {
                Ok(r) if purge_request(&r, source_id, after) => queued.push(r),
                Ok(_) => {}
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        queued.sort_by_key(|r| r.sequence);
        queued
            .into_iter()
            .take(limit)
            .map(|r| {
                let page = read_page(&*read, source_id, &r.slug)?.map(|p| p.id);
                Ok(json!({ "id": r.id, "slug": r.slug, "page_id": page }))
            })
            .collect()
    }

    /// `listPageLinkStreams`: the slug of the stream of every link to or from the page (the origin page's slug when the
    /// link has one, else its from page's), for the links whose stream is in `source_id`, each once, in byte order.
    pub fn list_page_link_streams(&self, source_id: &str, page_id: i64) -> Result<Vec<String>> {
        no_nul("listPageLinkStreams", &[("sourceId", source_id)])?;
        let Some(page) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let mut links = out_links(&*read, page)?;
        links.extend(in_links(&*read, page)?);
        let mut slugs = BTreeSet::new();
        for link in links {
            let Some(from) = read_page_by_id(&*read, link.from_page_id)? else {
                continue;
            };
            let origin = match link.origin_page_id {
                Some(id) => read_page_by_id(&*read, id)?,
                None => None,
            };
            let stream = origin.as_ref().unwrap_or(&from);
            if stream.source_id == source_id {
                slugs.insert(stream.slug.clone());
            }
        }
        Ok(distinct_sorted(slugs))
    }

    /// `readPurgePageBody`: `{ content_hash, body_generation }` of the page, or null when no page has the id.
    pub fn read_purge_page_body(&self, page_id: i64) -> Result<Value> {
        let read = self.read()?;
        let Some(id) = page_u64(page_id) else {
            return Ok(Value::Null);
        };
        let Some(page) = read_page_by_id(&*read, id)? else {
            return Ok(Value::Null);
        };
        let generation = read_body_state(&*read, id)?.map_or(0, |s| s.body_generation);
        Ok(json!({ "content_hash": page.content_hash, "body_generation": generation }))
    }

    /// `listPageMirrorFacts`: `{ fact_hash, visibility, subject }` of each distinct claim of the page that is not an
    /// outcome marker, `subject` the entity or `*`, in that order of fields.
    pub fn list_page_mirror_facts(&self, source_id: &str, slug: &str) -> Result<Vec<Value>> {
        no_nul(
            "listPageMirrorFacts",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        Ok(mirror_rows(&*read, source_id, slug)?
            .into_iter()
            .map(|(hash, visibility, subject)| {
                json!({ "fact_hash": hash, "visibility": visibility, "subject": subject })
            })
            .collect())
    }

    /// `listPageMirrorTakeHashes`: the fingerprint of each distinct take claim of the page, in byte order.
    pub fn list_page_mirror_take_hashes(&self, page_id: i64) -> Result<Vec<String>> {
        let read = self.read()?;
        let hashes: BTreeSet<String> = takes_of(&*read, page_id)?
            .iter()
            .map(|t| fact_fingerprint(&t.claim))
            .collect();
        Ok(distinct_sorted(hashes))
    }

    /// `countPageCascadeRows`: how many chunks, versions, takes and timeline entries the page has.
    pub fn count_page_cascade_rows(&self, page_id: i64) -> Result<Value> {
        let read = self.read()?;
        let Some(id) = page_u64(page_id) else {
            return Ok(json!({ "chunks": 0, "versions": 0, "takes": 0, "timeline": 0 }));
        };
        let mut timeline = 0u64;
        scan_prefix(&*read, &keys::timeline_prefix(id), false, &mut |_, _| {
            timeline += 1;
            true
        })?;
        Ok(json!({
            "chunks": read_chunks(&*read, id)?.len(),
            "versions": versions_of(&*read, id)?.len(),
            "takes": page_takes(&*read, id)?.len(),
            "timeline": timeline,
        }))
    }

    /// `listPageVersionSourcePaths`: the distinct source paths of the page's versions, up to 64, in byte order.
    pub fn list_page_version_source_paths(&self, page_id: i64) -> Result<Vec<String>> {
        let read = self.read()?;
        let Some(id) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let paths: BTreeSet<String> = versions_of(&*read, id)?
            .into_iter()
            .filter_map(|v| v.source_path)
            .collect();
        Ok(distinct_sorted(paths)
            .into_iter()
            .take(SOURCE_PATH_LIMIT)
            .collect())
    }

    /// `listPageVersionBodiesForPurge`: the page's newest 1000 versions, newest first, with the columns that give each
    /// body its import hash: title, type, both text columns (null for a segmented snapshot), frontmatter, tags, the
    /// storage kind, the generation a segmented snapshot references and the content hash. Only a segmented snapshot
    /// holds a content hash (the SQL engines' inline snapshot leaves the column null, as the store's record copies the
    /// page's).
    pub fn list_page_version_bodies_for_purge(&self, page_id: i64) -> Result<Vec<Value>> {
        let read = self.read()?;
        let Some(id) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let mut versions = versions_of(&*read, id)?;
        versions.sort_by_key(|v| std::cmp::Reverse(v.id));
        Ok(versions
            .into_iter()
            .take(CLAIM_LIMIT)
            .map(|v| {
                json!({
                    "title": v.title,
                    "type": v.page_type,
                    "compiled_truth": v.compiled_truth,
                    "timeline": v.timeline,
                    "frontmatter": crate::jsonb::order_map(v.frontmatter.clone()),
                    "tags": v.tags,
                    "body_storage": v.body_storage.clone().unwrap_or_else(|| "inline".to_string()),
                    "body_generation": v.body_generation,
                    "content_hash": if v.body_storage.as_deref() == Some("segmented") { v.content_hash.clone() } else { None },
                })
            })
            .collect())
    }
}

/// A queued purge request of the source after `after`: `state = 'queued' AND source_id AND sequence > after AND
/// operation = 'delete_page' AND intent->>'purge' = 'true'`.
fn purge_request(r: &RequestRecord, source_id: &str, after: i128) -> bool {
    r.state == "queued"
        && r.source_id == source_id
        && i128::from(r.sequence) > after
        && r.operation == "delete_page"
        && match r.intent.get("purge") {
            Some(Value::Bool(flag)) => *flag,
            Some(Value::String(text)) => text == "true",
            _ => false,
        }
}
