//! Group D facts repair members: the extractor-fact classifier and the purged-page fact count (SQL in
//! `src/core/engine-sql/facts-repair.ts`, docs in `rust/docs/store/facts.md`).
//!
//! - `listExtractorFactsForClassification` reads the facts, the pages, the withdrawal records and the write journal's
//!   committed requests (`persistence_requests`): a request whose `slug` and `completed_at` are the expiry instant of the
//!   fact is its receipt (the first one by sequence). A natively admitted request keeps no `consumer_version`, so that
//!   field is null.
//! - `countPurgedPageFacts` finds the active page-extraction facts filed on no page whose context names a page that
//!   does not exist. A fact is "evidenced" when the source's `page_purges` ledger (`facts/page_purges.rs`) records a
//!   purge of that slug at or after the fact's `created_at`; the ambiguous ones are the rest whose context head holds a
//!   `/`, as the SQL counts them.

use super::loops::loop_fact_ids;
use super::page_purges::source_page_purges;
use super::repair::posix_space;
use super::{FactRecord, fact_fingerprint, ids_under, refs_prefix, source_rows};
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::journal::RequestRecord;
use crate::keys;
use crate::kv::scan_prefix;
use crate::links::no_nul;
use crate::pages::read_page;
use crate::trust::withdrawals::withdrawn_claim;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};

/// The literal prefix of `f.source LIKE 'cli:extract-conversation-facts%'`.
const EXTRACTOR_PREFIX: &str = "cli:extract-conversation-facts";
/// `PAGE_EXTRACTION_SOURCE_LIST` (`src/core/facts/gone-page-facts.ts`): the sources whose context head is a page slug.
const PAGE_EXTRACTION_SOURCES: [&str; 4] =
    ["mcp:put_page", "sync:import", "file_upload", "code_import"];
/// `CONTEXT_NOTE_SEPARATOR`: the context head ends at the first one.
const CONTEXT_SEPARATOR: &str = " \u{2014} ";

/// `listExtractorFactsForClassification(sourceIds, slug)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractorArgs {
    pub source_ids: Vec<String>,
    /// `($2::text IS NULL OR f.source_markdown_slug = $2)`.
    pub slug: Option<String>,
}

/// `countPurgedPageFacts(sourceIds, cap)`: `limit` is `cap + 1`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgedArgs {
    pub source_ids: Vec<String>,
    pub limit: u64,
}

/// What a committed request tells about a fact's expiry: its id text and the consumer version that published it.
struct Receipt {
    sequence: u64,
    request_id: String,
    consumer_version: Option<String>,
}

/// The first committed request (by sequence) per `(source, slug, completed_at)`.
fn receipts(read: &dyn crate::kv::KvRead) -> Result<HashMap<(String, String, i64), Receipt>> {
    let mut found: HashMap<(String, String, i64), Receipt> = HashMap::new();
    let mut failure = None;
    scan_prefix(read, &[keys::REQUEST], false, &mut |_, v| {
        match serde_json::from_slice::<RequestRecord>(v) {
            Ok(r) if r.state == "committed" => {
                if let Some(at) = r.completed_at_us {
                    let key = (r.source_id.clone(), r.slug.clone(), at);
                    let better = found.get(&key).is_none_or(|k| r.sequence < k.sequence);
                    if better {
                        let consumer_version = r
                            .extra
                            .get("consumer_version")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        found.insert(
                            key,
                            Receipt {
                                sequence: r.sequence,
                                request_id: r.request_id.clone(),
                                consumer_version,
                            },
                        );
                    }
                }
            }
            Ok(_) => {}
            Err(e) => failure = Some(crate::StoreError::from(e)),
        }
        failure.is_none()
    })?;
    match failure {
        Some(e) => Err(e),
        None => Ok(found),
    }
}

/// `split_part(context, ' — ', 1)`: the text before the first separator, or all of it.
fn context_head(row: &FactRecord) -> Option<&str> {
    row.context
        .as_deref()
        .map(|c| c.split(CONTEXT_SEPARATOR).next().unwrap_or(c))
}

impl Store {
    /// `listExtractorFactsForClassification`: the expired, fenceless (`row_num` null) conversation-extractor facts filed
    /// on a page of these sources (or of one page), each with the page, withdrawal, duplicate, fence-history and receipt
    /// evidence, by (source, page, id).
    pub fn list_extractor_facts_for_classification(
        &self,
        args: &ExtractorArgs,
    ) -> Result<Vec<Value>> {
        let op = "listExtractorFactsForClassification";
        for source in &args.source_ids {
            no_nul(op, &[("sourceIds", source)])?;
        }
        if let Some(slug) = &args.slug {
            no_nul(op, &[("slug", slug)])?;
        }
        let read = self.read()?;
        let sources: BTreeSet<&str> = args.source_ids.iter().map(String::as_str).collect();
        let mut receipts_by_instant = None;
        let mut out = Vec::new();
        for source in sources {
            let rows = source_rows(&*read, source)?;
            let mut candidates: Vec<&FactRecord> = rows
                .iter()
                .filter(|f| {
                    f.source.starts_with(EXTRACTOR_PREFIX)
                        && f.expired_at_us.is_some()
                        && f.row_num.is_none()
                        && f.source_markdown_slug.as_deref().is_some_and(|slug| {
                            args.slug.as_deref().is_none_or(|want| want == slug)
                        })
                        && !f
                            .context
                            .as_deref()
                            .unwrap_or("")
                            .contains("retired: conversation-labels")
                })
                .collect();
            candidates.sort_by(|a, b| {
                (&a.source_markdown_slug, a.id).cmp(&(&b.source_markdown_slug, b.id))
            });
            for f in candidates {
                let (Some(slug), Some(expired)) =
                    (f.source_markdown_slug.as_deref(), f.expired_at_us)
                else {
                    continue;
                };
                let fingerprint = fact_fingerprint(&f.fact);
                let page = read_page(&*read, source, slug)?;
                let withdrawn = withdrawn_claim(
                    &*read,
                    source,
                    &f.visibility,
                    &f.fact,
                    f.entity_slug.as_deref(),
                )?;
                let active_duplicate = rows.iter().any(|a| {
                    a.visibility == f.visibility
                        && a.expired_at_us.is_none()
                        && a.source_markdown_slug.as_deref() == Some(slug)
                        && a.entity_slug == f.entity_slug
                        && fact_fingerprint(&a.fact) == fingerprint
                });
                let fence_history = rows.iter().any(|g| {
                    g.source_markdown_slug.as_deref() == Some(slug)
                        && !g.source.starts_with(EXTRACTOR_PREFIX)
                });
                if receipts_by_instant.is_none() {
                    receipts_by_instant = Some(receipts(&*read)?);
                }
                let receipt = receipts_by_instant
                    .as_ref()
                    .and_then(|all| all.get(&(source.to_string(), slug.to_string(), expired)));
                out.push(json!({
                    "id": f.id,
                    "source_id": f.source_id,
                    "slug": slug,
                    "fact": f.fact,
                    "visibility": f.visibility,
                    "entity_slug": f.entity_slug,
                    "superseded": f.superseded_by.is_some(),
                    "fingerprint": fingerprint,
                    "expired_at": iso(expired),
                    "page_id": page.as_ref().map(|p| p.id),
                    // `p.deleted_at IS NOT NULL` over the LEFT JOIN: false when there is no page.
                    "page_deleted": page.as_ref().is_some_and(|p| p.deleted_at_us.is_some()),
                    "withdrawn": withdrawn,
                    "active_duplicate": active_duplicate,
                    "fence_history": fence_history,
                    "receipt": receipt.map(|r| r.request_id.clone()),
                    "receipt_consumer": receipt.and_then(|r| r.consumer_version.clone()),
                }));
            }
        }
        Ok(out)
    }

    /// `countPurgedPageFacts`, as the `purged` flag of each counted fact (at most `limit`, by (source, id)): true when a
    /// purge ledger row of the source names the context head at or after the fact was written. The facts: active,
    /// filed on no page, written by a page extraction path, whose context head is a slug (not empty, no whitespace)
    /// that no page holds (a soft-deleted page holds it), with a `/` in the head or a purge ledger row, and neither
    /// withdrawn, superseded, replaced by another fact nor named by a loop.
    pub fn count_purged_page_facts(&self, args: &PurgedArgs) -> Result<Vec<bool>> {
        let op = "countPurgedPageFacts";
        for source in &args.source_ids {
            no_nul(op, &[("sourceIds", source)])?;
        }
        if args.limit == 0 {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let held = loop_fact_ids(&*read, op)?;
        let sources: BTreeSet<&str> = args.source_ids.iter().map(String::as_str).collect();
        let mut out = Vec::new();
        for source in sources {
            // The newest purge of each slug: `pp.purged_at >= f.created_at` holds when that one does.
            let mut ledger: HashMap<String, i64> = HashMap::new();
            for (_, row) in source_page_purges(&*read, source)? {
                let newest = ledger.entry(row.slug).or_insert(row.purged_at_us);
                *newest = (*newest).max(row.purged_at_us);
            }
            for f in source_rows(&*read, source)? {
                let Some(head) = context_head(&f) else {
                    continue;
                };
                let evidenced = ledger.get(head).is_some_and(|at| *at >= f.created_at_us);
                if f.expired_at_us.is_some()
                    || f.source_markdown_slug.is_some()
                    || !PAGE_EXTRACTION_SOURCES.contains(&f.source.as_str())
                    || head.is_empty()
                    || head.chars().any(posix_space)
                    || !(head.contains('/') || evidenced)
                    || f.superseded_by.is_some()
                    || held.contains(&f.id)
                    || read_page(&*read, source, head)?.is_some()
                    || !ids_under(&*read, &refs_prefix(f.id))?.is_empty()
                    || withdrawn_claim(
                        &*read,
                        source,
                        &f.visibility,
                        &f.fact,
                        f.entity_slug.as_deref(),
                    )?
                {
                    continue;
                }
                out.push(evidenced);
                if out.len() as u64 >= args.limit {
                    return Ok(out);
                }
            }
        }
        Ok(out)
    }
}
