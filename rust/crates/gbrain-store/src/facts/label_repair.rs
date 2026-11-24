//! The preview reads of `gbrain repair conversation-labels` (src/core/engine-sql/label-repair-reads.ts):
//! `listLabelFactCandidates`, `listSegmentedLabelPages` and `hasActiveAuditMarker`.
//!
//! The predicates are the ones `countLabelFacts` evaluates (`facts/repair.rs`): the TypeScript member reads the label
//! line into literal labels (`store-members/label-line.ts`) and [`has_label_line`] matches them, and an audit row
//! decides a page when its context is version-stamped ([`version_stamped`]). Rows come back in (source, page, id)
//! order, sources in byte order of their id, which is the SQL's order under the C collation the parity brains use.

use super::loops::loop_fact_ids;
use super::repair::{has_label_line, version_stamped};
use super::{FactRecord, ids_under, refs_prefix, source_rows};
use crate::Store;
use crate::chunks::segmented;
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::read_page;
use crate::trust::withdrawals::withdrawn_claim;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// `listLabelFactCandidates(sourceIds, slug, args)` and, without `labels`, `listSegmentedLabelPages(sourceIds, args)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LabelFactArgs {
    pub source_ids: Vec<String>,
    /// `$2::text IS NULL OR f.source_markdown_slug = $2`.
    pub slug: Option<String>,
    /// `f.source = $5`: the segment extractor's source.
    pub segment_source: String,
    /// The labels of `(^|\n)\*\*(labels)[[:space:]]*:\*\*`, ASCII, matched with ASCII case folding.
    pub labels: Vec<String>,
    /// `o.source IN ($3, $4)`: the audit sources whose stamped active row decides a page.
    pub terminal_source: String,
    pub non_extractable_source: String,
}

/// One candidate with its classification evidence.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LabelFactCandidate {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    pub fact: String,
    pub context: Option<String>,
    pub entity_slug: Option<String>,
    pub visibility: String,
    pub superseded: bool,
    pub withdrawn: bool,
    pub referenced: bool,
    pub open_loop: bool,
    pub outcome_stamped: bool,
}

/// One segmented page with undecided active segment-extractor facts.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentedLabelPage {
    pub source_id: String,
    pub slug: String,
    pub n: u64,
}

/// `hasActiveAuditMarker(sourceId, slug, sources)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditMarkerArgs {
    pub source_id: String,
    pub slug: String,
    pub sources: Vec<String>,
}

fn check(op: &str, a: &LabelFactArgs) -> Result<()> {
    for source in &a.source_ids {
        no_nul(op, &[("sourceIds", source)])?;
    }
    for label in &a.labels {
        no_nul(op, &[("labels", label)])?;
    }
    no_nul(
        op,
        &[
            ("slug", a.slug.as_deref().unwrap_or("")),
            ("segmentSource", &a.segment_source),
            ("terminalSource", &a.terminal_source),
            ("nonExtractableSource", &a.non_extractable_source),
        ],
    )
}

/// The pages of `rows` an active, version-stamped audit row of one of the two sources decided.
fn decided<'a>(rows: &'a [FactRecord], a: &LabelFactArgs) -> BTreeSet<&'a str> {
    rows.iter()
        .filter(|o| {
            o.expired_at_us.is_none()
                && (o.source == a.terminal_source || o.source == a.non_extractable_source)
                && o.context.as_deref().is_some_and(version_stamped)
        })
        .filter_map(|o| o.source_markdown_slug.as_deref())
        .collect()
}

impl Store {
    /// Every active segment-extractor fact on a live page whose body or timeline has a label line, with its evidence.
    pub fn list_label_fact_candidates(&self, a: &LabelFactArgs) -> Result<Vec<LabelFactCandidate>> {
        let op = "listLabelFactCandidates";
        check(op, a)?;
        let read = self.read()?;
        let held = loop_fact_ids(&*read, op)?;
        let sources: BTreeSet<&str> = a.source_ids.iter().map(String::as_str).collect();
        let mut out = Vec::new();
        for source in sources {
            let rows = source_rows(&*read, source)?;
            let stamped = decided(&rows, a);
            let mut labelled: HashMap<&str, bool> = HashMap::new();
            let mut found: Vec<LabelFactCandidate> = Vec::new();
            for f in &rows {
                let Some(slug) = f.source_markdown_slug.as_deref() else {
                    continue;
                };
                if f.source != a.segment_source
                    || f.expired_at_us.is_some()
                    || a.slug.as_deref().is_some_and(|s| s != slug)
                {
                    continue;
                }
                let on_label_page = match labelled.get(slug) {
                    Some(known) => *known,
                    None => {
                        let hit = read_page(&*read, source, slug)?.is_some_and(|p| {
                            p.deleted_at_us.is_none()
                                && (has_label_line(
                                    p.compiled_truth.as_deref().unwrap_or(""),
                                    &a.labels,
                                ) || has_label_line(
                                    p.timeline.as_deref().unwrap_or(""),
                                    &a.labels,
                                ))
                        });
                        labelled.insert(slug, hit);
                        hit
                    }
                };
                if !on_label_page {
                    continue;
                }
                found.push(LabelFactCandidate {
                    id: f.id,
                    source_id: f.source_id.clone(),
                    slug: slug.to_string(),
                    fact: f.fact.clone(),
                    context: f.context.clone(),
                    entity_slug: f.entity_slug.clone(),
                    visibility: f.visibility.clone(),
                    superseded: f.superseded_by.is_some(),
                    withdrawn: withdrawn_claim(
                        &*read,
                        source,
                        &f.visibility,
                        &f.fact,
                        f.entity_slug.as_deref(),
                    )?,
                    referenced: !ids_under(&*read, &refs_prefix(f.id))?.is_empty(),
                    open_loop: held.contains(&f.id),
                    outcome_stamped: stamped.contains(slug),
                });
            }
            found.sort_by(|x, y| {
                x.slug
                    .as_bytes()
                    .cmp(y.slug.as_bytes())
                    .then(x.id.cmp(&y.id))
            });
            out.extend(found);
        }
        Ok(out)
    }

    /// The segmented live pages with active segment-extractor facts no stamped audit row decided, in page id order.
    pub fn list_segmented_label_pages(&self, a: &LabelFactArgs) -> Result<Vec<SegmentedLabelPage>> {
        let op = "listSegmentedLabelPages";
        check(op, a)?;
        let read = self.read()?;
        let sources: BTreeSet<&str> = a.source_ids.iter().map(String::as_str).collect();
        let mut by_page: BTreeMap<u64, SegmentedLabelPage> = BTreeMap::new();
        for source in sources {
            let rows = source_rows(&*read, source)?;
            let stamped = decided(&rows, a);
            let mut pages: HashMap<&str, Option<u64>> = HashMap::new();
            for f in &rows {
                let Some(slug) = f.source_markdown_slug.as_deref() else {
                    continue;
                };
                if f.source != a.segment_source
                    || f.expired_at_us.is_some()
                    || stamped.contains(slug)
                {
                    continue;
                }
                let page_id = match pages.get(slug) {
                    Some(known) => *known,
                    None => {
                        let id = read_page(&*read, source, slug)?
                            .filter(|p| p.deleted_at_us.is_none() && segmented(p))
                            .map(|p| p.id);
                        pages.insert(slug, id);
                        id
                    }
                };
                if let Some(id) = page_id {
                    by_page
                        .entry(id)
                        .or_insert_with(|| SegmentedLabelPage {
                            source_id: source.to_string(),
                            slug: slug.to_string(),
                            n: 0,
                        })
                        .n += 1;
                }
            }
        }
        Ok(by_page.into_values().collect())
    }

    /// Whether the page holds an active fact of one of `sources`.
    pub fn has_active_audit_marker(&self, a: &AuditMarkerArgs) -> Result<bool> {
        let op = "hasActiveAuditMarker";
        no_nul(op, &[("sourceId", &a.source_id), ("slug", &a.slug)])?;
        for source in &a.sources {
            no_nul(op, &[("sources", source)])?;
        }
        let read = self.read()?;
        Ok(source_rows(&*read, &a.source_id)?.iter().any(|f| {
            f.expired_at_us.is_none()
                && f.source_markdown_slug.as_deref() == Some(a.slug.as_str())
                && a.sources.contains(&f.source)
        }))
    }
}
