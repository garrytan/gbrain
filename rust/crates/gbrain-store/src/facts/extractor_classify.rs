//! `listExtractorFactsForClassification` (src/core/engine-sql/facts-repair.ts): the expired
//! fenceless conversation-extractor facts `gbrain repair` classifies, with their evidence.
//!
//! The SQL, clause by clause, as this read serves it:
//!
//! - `cand`: facts of the sources whose `source` starts with `cli:extract-conversation-facts`,
//!   expired, with no fence row number, with a provenance page slug, whose `context` does not
//!   carry `retired: conversation-labels`, and of `slug` when one is given;
//! - `page_id` / `page_deleted`: the provenance page (a soft-deleted page still counts); `page_id`
//!   is null for no page and `page_deleted` is false, as `deleted_at IS NOT NULL` over a LEFT JOIN is;
//! - `withdrawn`: a `fact_withdrawals` row of the source at the fact's visibility with its
//!   fingerprint or v1 fingerprint, under subject `*` or the fact's entity (only `*` when the
//!   fact has no entity);
//! - `active_duplicate`: an active fact of the same source, visibility, page and entity with the
//!   same fingerprint;
//! - `fence_history`: any fact of the page whose `source` is not an extractor source;
//! - `receipt` / `receipt_consumer`: the committed write request of the page that completed at
//!   the exact instant the fact expired, the lowest sequence first. The requests are read from
//!   the write journal (`journal::RequestRecord`); this read writes nothing there.
//!
//! The rows come back ordered by source id, page slug and id. Postgres compares the two texts
//! in the database collation, which is byte order for the lowercase slugs the extractor writes.

use super::{FactRecord, source_rows};
use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::read_page;
use crate::trust::fingerprint::{fact_fingerprint, fact_fingerprint_v1};
use crate::trust::withdrawals::withdrawal_hash_under;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// `EXTRACTOR_FACTS_SOURCE_PREFIX`.
const EXTRACTOR_PREFIX: &str = "cli:extract-conversation-facts";
/// The `context` marker of a fact the conversation-labels repair retired.
const RETIRED_MARKER: &str = "retired: conversation-labels";

/// `listExtractorFactsForClassification(sourceIds, slug)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractorClassificationQuery {
    pub source_ids: Vec<String>,
    pub slug: Option<String>,
}

/// `(source_id, slug, completed_at)` of a receipt the candidates join on.
type ReceiptKey = (String, String, i64);

/// The committed requests of the candidate keys, the lowest sequence per key: `(request_id,
/// consumer_version, sequence)`.
fn receipts(
    read: &dyn KvRead,
    wanted: &BTreeSet<ReceiptKey>,
) -> Result<HashMap<ReceiptKey, (String, Value, u64)>> {
    let mut out: HashMap<ReceiptKey, (String, Value, u64)> = HashMap::new();
    if wanted.is_empty() {
        return Ok(out);
    }
    let mut failure = None;
    scan_prefix(read, &[keys::REQUEST], false, &mut |_, v| {
        match serde_json::from_slice::<RequestRecord>(v) {
            Ok(r) if r.state == "committed" => {
                if let Some(at) = r.completed_at_us {
                    let key = (r.source_id.clone(), r.slug.clone(), at);
                    if wanted.contains(&key)
                        && out.get(&key).is_none_or(|(_, _, seq)| r.sequence < *seq)
                    {
                        let consumer = r
                            .extra
                            .get("consumer_version")
                            .cloned()
                            .unwrap_or(Value::Null);
                        out.insert(key, (r.request_id.clone(), consumer, r.sequence));
                    }
                }
            }
            Ok(_) => {}
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// The fact's withdrawal: either fingerprint, at its visibility, under `*` or its entity.
pub(super) fn withdrawn(read: &dyn KvRead, row: &FactRecord) -> Result<bool> {
    let subject = row.entity_slug.as_deref().unwrap_or("*");
    for hash in [fact_fingerprint(&row.fact), fact_fingerprint_v1(&row.fact)] {
        if withdrawal_hash_under(read, &row.source_id, &row.visibility, Some(subject), &hash)? {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Store {
    /// `listExtractorFactsForClassification`: the expired fenceless extractor facts with the
    /// page, withdrawal, duplicate, fence and receipt evidence, in (source, page, id) order.
    pub fn list_extractor_facts_for_classification(
        &self,
        q: &ExtractorClassificationQuery,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listExtractorFactsForClassification";
        let mut texts: Vec<(&str, &str)> = q
            .source_ids
            .iter()
            .map(|s| ("sourceIds", s.as_str()))
            .collect();
        if let Some(slug) = &q.slug {
            texts.push(("slug", slug));
        }
        no_nul(OP, &texts)?;
        let read = self.read()?;
        let sources: BTreeSet<&str> = q.source_ids.iter().map(String::as_str).collect();
        let mut by_source: BTreeMap<&str, Vec<FactRecord>> = BTreeMap::new();
        let mut cand: Vec<(FactRecord, String, i64)> = Vec::new();
        for source in sources {
            let rows = source_rows(&*read, source)?;
            for row in &rows {
                let (Some(slug), Some(expired)) = (&row.source_markdown_slug, row.expired_at_us)
                else {
                    continue;
                };
                if row.source.starts_with(EXTRACTOR_PREFIX)
                    && row.row_num.is_none()
                    && !row
                        .context
                        .as_deref()
                        .unwrap_or("")
                        .contains(RETIRED_MARKER)
                    && q.slug.as_ref().is_none_or(|s| s == slug)
                {
                    cand.push((row.clone(), slug.clone(), expired));
                }
            }
            by_source.insert(source, rows);
        }
        let wanted: BTreeSet<ReceiptKey> = cand
            .iter()
            .map(|(row, slug, expired)| (row.source_id.clone(), slug.clone(), *expired))
            .collect();
        let receipts = receipts(&*read, &wanted)?;
        cand.sort_by(|(a, sa, _), (b, sb, _)| {
            a.source_id
                .cmp(&b.source_id)
                .then(sa.cmp(sb))
                .then(a.id.cmp(&b.id))
        });
        let mut out = Vec::with_capacity(cand.len());
        for (row, slug, expired) in cand {
            let page = read_page(&*read, &row.source_id, &slug)?;
            let fingerprint = fact_fingerprint(&row.fact);
            let rows = by_source
                .get(row.source_id.as_str())
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let in_page =
                |a: &&FactRecord| a.source_markdown_slug.as_deref() == Some(slug.as_str());
            let active_duplicate = rows.iter().filter(in_page).any(|a| {
                a.visibility == row.visibility
                    && a.expired_at_us.is_none()
                    && a.entity_slug == row.entity_slug
                    && fact_fingerprint(&a.fact) == fingerprint
            });
            let fence_history = rows
                .iter()
                .filter(in_page)
                .any(|g| !g.source.starts_with(EXTRACTOR_PREFIX));
            let receipt = receipts.get(&(row.source_id.clone(), slug.clone(), expired));
            out.push(json!({
                "id": row.id,
                "source_id": row.source_id,
                "slug": slug,
                "fact": row.fact,
                "visibility": row.visibility,
                "entity_slug": row.entity_slug,
                "superseded": row.superseded_by.is_some(),
                "fingerprint": fingerprint,
                "expired_at": iso(expired),
                "page_id": page.as_ref().map(|p| p.id),
                // `p.deleted_at IS NOT NULL` over the LEFT JOIN: false when there is no page.
                "page_deleted": page.as_ref().is_some_and(|p| p.deleted_at_us.is_some()),
                "withdrawn": withdrawn(&*read, &row)?,
                "active_duplicate": active_duplicate,
                "fence_history": fence_history,
                "receipt": receipt.map(|(id, _, _)| id.clone()),
                "receipt_consumer": receipt.map_or(Value::Null, |(_, c, _)| c.clone()),
            }));
        }
        Ok(out)
    }
}
