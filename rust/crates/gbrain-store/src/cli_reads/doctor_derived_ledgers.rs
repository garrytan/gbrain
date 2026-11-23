//! Doctor-derived reads, fourth part: the body-tiling, ontology-fact and derivation-receipt checks
//! (`segmented_tiling`, `ontology_facts_fenced`, `extraction_input_truncated`,
//! `derivation_unpriced_model`). SQL in `src/core/engine-sql/doctor-derived.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-derived.md`. Each read takes one snapshot.
//!
//! `page_extraction_state` has no Rust writer (the Rust engine refuses `executeRaw`, which writes
//! it), so the receipts that table holds contribute nothing; the receipts of
//! `page_segment_derivations` (a typed member writes them) are the whole answer.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{Value, json};

use super::doctor_derived::{LiveSources, in_scope};
use super::pg_text::jsonb_text;
use crate::Store;
use crate::error::Result;
use crate::kv::KvRead;
use crate::page_body::health::{Derivation, all_derivations, segmented_body, tiling};
use crate::pages::{all_pages, read_page_by_id};

/// The samples a receipt group lists (`[1:3]`).
const SAMPLES: usize = 3;

/// A receipt group member: `(updated_at_us, page id, "source:slug" plus its detail)`.
type Sample = (i64, u64, String);

/// `receipt ->> key` of a derivation receipt (JSON null and a missing key are NULL).
fn receipt_text(receipt: &Value, key: &str) -> Option<String> {
    match receipt.get(key)? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// The `source_id:slug` of a live page, looked up once per page id.
struct LivePages<'a> {
    read: &'a dyn KvRead,
    seen: HashMap<u64, Option<String>>,
}

impl<'a> LivePages<'a> {
    fn new(read: &'a dyn KvRead) -> Self {
        Self {
            read,
            seen: HashMap::new(),
        }
    }

    fn name(&mut self, page_id: u64) -> Result<Option<String>> {
        if let Some(known) = self.seen.get(&page_id) {
            return Ok(known.clone());
        }
        let name = read_page_by_id(self.read, page_id)?
            .filter(|p| p.deleted_at_us.is_none())
            .map(|p| format!("{}:{}", p.source_id, p.slug));
        self.seen.insert(page_id, name.clone());
        Ok(name)
    }
}

/// One `(page, pipeline, kind)` group of the receipts statement.
struct Receipt {
    updated_at_us: i64,
    detail: Option<String>,
}

impl Store {
    /// `listUntiledSegmentedPageRows(sourceIds, slugs, limit)`: live segmented pages of unarchived
    /// sources (the named sources and slugs when given) whose published rows of the live
    /// generation leave a gap, overlap, or do not add up to `body_bytes`, by source and slug.
    pub fn list_untiled_segmented_page_rows(
        &self,
        source_ids: Option<&[String]>,
        slugs: Option<&[String]>,
        limit: i64,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut sources = LiveSources::new(&*read);
        let mut found = Vec::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || !in_scope(source_ids, &page.source_id)
                || !slugs.is_none_or(|s| s.contains(&page.slug))
                || !sources.unarchived(&page.source_id)?
            {
                continue;
            }
            let Some(body) = segmented_body(&*read, page.id)? else {
                continue;
            };
            let tiles = tiling(&*read, page.id, body.generation)?;
            // `NOT gapless OR covered <> body_bytes`: a NULL `body_bytes` leaves a gapless page out.
            if tiles.gapless && body.bytes.is_none_or(|b| b == tiles.covered) {
                continue;
            }
            found.push((
                (page.source_id.clone(), page.slug.clone()),
                json!({
                    "id": page.id,
                    "source_id": page.source_id,
                    "slug": page.slug,
                    "revision": page.knowledge_revision,
                    "body_generation": body.generation,
                    "body_bytes": body.bytes,
                    "segment_count": body.segments,
                    "source_path": page.source_path,
                    "n": tiles.rows,
                    "covered": tiles.covered,
                    "gapless": tiles.gapless,
                }),
            ));
        }
        found.sort_by(|a, b| a.0.cmp(&b.0));
        found.truncate(usize::try_from(limit).unwrap_or(0));
        Ok(found.into_iter().map(|(_, row)| row).collect())
    }

    /// `listExtractionInputReceipts()`: the derivation receipts that say an extraction read only
    /// part of its input (any `kind` but `unpriced_model`, or the `purge_sweep_pending` reason),
    /// by pipeline and kind, with the number of live pages and the three most recently updated
    /// `source:slug` samples (a failed-windows receipt adds its first window and occurrence).
    pub fn list_extraction_input_receipts(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut live = LivePages::new(&*read);
        // `GROUP BY page_id, pipeline, kind`: newest update, and the smallest failed-window detail.
        let mut receipts: BTreeMap<(u64, String, String), Receipt> = BTreeMap::new();
        for d in all_derivations(&*read)? {
            let kind = receipt_text(&d.receipt, "kind");
            let purge =
                receipt_text(&d.receipt, "reason").as_deref() == Some("purge_sweep_pending");
            if !(kind.as_deref().is_some_and(|k| k != "unpriced_model") || purge) {
                continue;
            }
            let group_kind = if purge {
                "purge_sweep_pending".to_string()
            } else {
                kind.clone().unwrap_or_else(|| "unknown".into())
            };
            let detail = (kind.as_deref() == Some("failed_windows"))
                .then(|| window_detail(&d))
                .flatten();
            let entry = receipts
                .entry((d.page_id, d.pipeline.clone(), group_kind))
                .or_insert(Receipt {
                    updated_at_us: d.updated_at_us,
                    detail: None,
                });
            entry.updated_at_us = entry.updated_at_us.max(d.updated_at_us);
            if let Some(detail) = detail
                && entry
                    .detail
                    .as_deref()
                    .is_none_or(|old| detail.as_bytes() < old.as_bytes())
            {
                entry.detail = Some(detail);
            }
        }
        let mut groups: BTreeMap<(String, String), Vec<Sample>> = BTreeMap::new();
        for ((page_id, pipeline, kind), receipt) in receipts {
            if let Some(name) = live.name(page_id)? {
                let sample = format!("{name}{}", receipt.detail.unwrap_or_default());
                groups.entry((pipeline, kind)).or_default().push((
                    receipt.updated_at_us,
                    page_id,
                    sample,
                ));
            }
        }
        Ok(groups
            .into_iter()
            .map(|((pipeline, kind), mut pages)| {
                // `ORDER BY r.updated_at DESC`: ties have no order in SQL; page id keeps it stable.
                pages.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
                let samples: Vec<&str> = pages.iter().take(SAMPLES).map(|p| p.2.as_str()).collect();
                json!({ "pipeline": pipeline, "kind": kind, "pages": pages.len(), "samples": samples })
            })
            .collect())
    }

    /// `listUnpricedDerivationModels()`: the models whose derivation receipts on live pages say
    /// `unpriced_model` (as the `kind` or the `reason`), by page count then model, with their
    /// pipelines and the first three `source:slug` samples in sorted order.
    pub fn list_unpriced_derivation_models(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut live = LivePages::new(&*read);
        type Seen = (BTreeSet<String>, BTreeSet<u64>, BTreeSet<String>);
        let mut models: BTreeMap<String, Seen> = BTreeMap::new();
        for d in all_derivations(&*read)? {
            let unpriced = receipt_text(&d.receipt, "kind").as_deref() == Some("unpriced_model")
                || receipt_text(&d.receipt, "reason").as_deref() == Some("unpriced_model");
            let Some(model) = receipt_text(&d.receipt, "model").filter(|_| unpriced) else {
                continue;
            };
            if let Some(name) = live.name(d.page_id)? {
                let seen = models.entry(model).or_default();
                seen.0.insert(d.pipeline);
                seen.1.insert(d.page_id);
                seen.2.insert(name);
            }
        }
        let mut rows: Vec<_> = models.into_iter().collect();
        rows.sort_by_key(|a| std::cmp::Reverse(a.1.1.len()));
        Ok(rows
            .into_iter()
            .map(|(model, (pipelines, pages, names))| {
                let samples: Vec<&String> = names.iter().take(SAMPLES).collect();
                json!({ "model": model, "pipelines": pipelines, "pages": pages.len(), "samples": samples })
            })
            .collect())
    }
}

/// `' window ' || receipt -> 'windows' -> 0 ->> 'ordinal' || ' of occurrence ' || occurrence_id`
/// (NULL when the first window has no ordinal).
fn window_detail(d: &Derivation) -> Option<String> {
    let ordinal = match d
        .receipt
        .get("windows")?
        .as_array()?
        .first()?
        .get("ordinal")?
    {
        Value::Null => return None,
        Value::String(s) => s.clone(),
        other => jsonb_text(other),
    };
    Some(format!(" window {ordinal} of occurrence {}", d.occurrence))
}
