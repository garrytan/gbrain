//! The preview scans of `gbrain repair open-facts` (src/core/engine-sql/open-facts-scans.ts): `listOpenFactsWindow`, one
//! keyset window of eligible private facts, and `countOpenFactReasons`, the counts by class and by the reason a fact
//! stays private.
//!
//! A fact's class (`openFactClassSql`) is `unpaged:<lane>` when it has no holding page or comes from a transcript lane,
//! `fenced` when it holds a `row_num`, else `unfenced`. Its reason (`openFactsReasonSql`) is the first of: expired,
//! superseded, lapsed (`valid_until` at or before now), a member page among its holding, entity and provenance slugs, a
//! withdrawal or purge tombstone of its claim (any visibility, subject `*` or its entity), a trust contest
//! ([`open_fact_contested`]), then the page reasons of `factPageReasons` in order: the holding page derivation-private,
//! missing or quarantined, the provenance page the same, the entity page derivation-private. Texts compare by bytes.

use super::purge_ledger::purged_claim;
use super::repair::{derivation_private, provenance_slug};
use super::{FactRecord, QUARANTINE_KEY, source_rows};
use crate::Store;
use crate::error::Result;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::read_page;
use crate::persistence::projection_queue::parse_timestamptz;
use crate::trust::proposals::open_fact_contested;
use crate::trust::withdrawals::withdrawn_claim;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// `MEMBER_PAGE_PREFIX` (access/principals.ts).
const MEMBER_PAGE_PREFIX: &str = "memory/members/";

/// `listOpenFactsWindow` and `countOpenFactReasons`: the selection, and for a window its keyset bounds, classes and limit.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenFactsArgs {
    pub source_id: String,
    pub created_before: Option<String>,
    pub ids: Option<Vec<i64>>,
    #[serde(default)]
    pub after: Option<i64>,
    #[serde(default)]
    pub upper: Option<i64>,
    #[serde(default)]
    pub classes: Option<Vec<String>>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// `transcriptLanesSql`: conversation extraction, the capture hooks, the corpus sweep, transcripts and connectors.
fn transcript_lane(source: &str) -> bool {
    source.starts_with("cli:extract-conversation-facts")
        || matches!(source, "hook:writeback" | "hook:compact" | "sweep:corpus")
        || source.starts_with("transcript:")
        || source.starts_with("connector:")
}

/// `openFactClassSql`.
fn class_of(f: &FactRecord) -> String {
    if f.source_markdown_slug.is_none() || transcript_lane(&f.source) {
        let lane = if f.source.is_empty() {
            "unknown"
        } else {
            f.source.as_str()
        };
        format!("unpaged:{lane}")
    } else if f.row_num.is_some() {
        "fenced".to_string()
    } else {
        "unfenced".to_string()
    }
}

/// The three page reasons of one slug (`factPageReasons`): derivation-private in its row (deleted or not), no live page,
/// or a live page that is quarantined.
fn page_reason(
    read: &dyn KvRead,
    source: &str,
    slug: &str,
    names: [&'static str; 3],
) -> Result<Option<&'static str>> {
    let page = read_page(read, source, slug)?;
    if let Some(page) = &page
        && derivation_private(read, page, false)?
    {
        return Ok(Some(names[0]));
    }
    match page.filter(|p| p.deleted_at_us.is_none()) {
        None => Ok(Some(names[1])),
        Some(live) if live.frontmatter.contains_key(QUARANTINE_KEY) => Ok(Some(names[2])),
        Some(_) => Ok(None),
    }
}

/// `openFactsReasonSql`: why fact `f` stays private, or none when it may open.
fn reason_of(read: &dyn KvRead, f: &FactRecord, now: i64) -> Result<Option<&'static str>> {
    if f.expired_at_us.is_some() {
        return Ok(Some("expired"));
    }
    if f.superseded_by.is_some() {
        return Ok(Some("superseded"));
    }
    if f.valid_until_us.is_some_and(|u| u <= now) {
        return Ok(Some("lapsed"));
    }
    let provenance = provenance_slug(f);
    if [
        f.source_markdown_slug.as_deref(),
        f.entity_slug.as_deref(),
        provenance.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|s| s.starts_with(MEMBER_PAGE_PREFIX))
    {
        return Ok(Some("member_page"));
    }
    for visibility in ["private", "world"] {
        if withdrawn_claim(
            read,
            &f.source_id,
            visibility,
            &f.fact,
            f.entity_slug.as_deref(),
        )? || purged_claim(
            read,
            &f.source_id,
            visibility,
            &f.fact,
            f.entity_slug.as_deref(),
        )? {
            return Ok(Some("withdrawn"));
        }
    }
    if open_fact_contested(read, f.id as i64)? {
        return Ok(Some("contested"));
    }
    if let Some(holding) = &f.source_markdown_slug
        && let Some(reason) = page_reason(
            read,
            &f.source_id,
            holding,
            [
                "holding_page_private",
                "holding_page_missing",
                "holding_page_quarantined",
            ],
        )?
    {
        return Ok(Some(reason));
    }
    if let Some(prov) = &provenance
        && let Some(reason) = page_reason(
            read,
            &f.source_id,
            prov,
            [
                "provenance_private",
                "provenance_unresolved",
                "provenance_quarantined",
            ],
        )?
    {
        return Ok(Some(reason));
    }
    if let Some(entity) = &f.entity_slug
        && let Some(page) = read_page(read, &f.source_id, entity)?
        && derivation_private(read, &page, false)?
    {
        return Ok(Some("entity_page_private"));
    }
    Ok(None)
}

impl Store {
    /// The selection's private facts (`BASE`): of the source, created before the cut (none without one), the named ids.
    fn open_facts_selection(
        &self,
        read: &dyn KvRead,
        a: &OpenFactsArgs,
    ) -> Result<Vec<FactRecord>> {
        no_nul("openFacts", &[("sourceId", a.source_id.as_str())])?;
        let Some(cut) = &a.created_before else {
            return Ok(Vec::new());
        };
        let cut = parse_timestamptz(cut, "openFacts createdBefore")?;
        let ids: Option<BTreeSet<i64>> = a.ids.as_ref().map(|ids| ids.iter().copied().collect());
        let mut rows: Vec<FactRecord> = source_rows(read, &a.source_id)?
            .into_iter()
            .filter(|f| {
                f.visibility == "private"
                    && f.created_at_us < cut
                    && ids.as_ref().is_none_or(|ids| ids.contains(&(f.id as i64)))
            })
            .collect();
        rows.sort_by_key(|f| f.id);
        Ok(rows)
    }

    /// `listOpenFactsWindow(sel, after, upper, classes, limit)`: the eligible facts (no reason) of the selected classes
    /// with ids in (after, upper], as `{ id, row_num, fact, source_markdown_slug, cls }`, by id, at most `limit`.
    pub fn list_open_facts_window(&self, a: &OpenFactsArgs) -> Result<Vec<Value>> {
        let classes: BTreeSet<&str> = a.classes.iter().flatten().map(String::as_str).collect();
        let after = a.after.unwrap_or(0);
        let limit = usize::try_from(a.limit.unwrap_or(0)).unwrap_or(0);
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut out = Vec::new();
        for f in self.open_facts_selection(&*read, a)? {
            if out.len() >= limit {
                break;
            }
            let id = f.id as i64;
            if id <= after || a.upper.is_some_and(|u| id > u) {
                continue;
            }
            let cls = class_of(&f);
            if !classes.contains(cls.as_str()) || reason_of(&*read, &f, now)?.is_some() {
                continue;
            }
            out.push(json!({ "id": f.id, "row_num": f.row_num, "fact": f.fact, "source_markdown_slug": f.source_markdown_slug, "cls": cls }));
        }
        Ok(out)
    }

    /// `countOpenFactReasons(sel)`: `{ cls, reason, n }` per class and reason (`eligible` when none) over the selection,
    /// by class then reason in byte order.
    pub fn count_open_fact_reasons(&self, a: &OpenFactsArgs) -> Result<Vec<Value>> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut counts: BTreeMap<(String, String), u64> = BTreeMap::new();
        for f in self.open_facts_selection(&*read, a)? {
            let reason = reason_of(&*read, &f, now)?.unwrap_or("eligible");
            *counts
                .entry((class_of(&f), reason.to_string()))
                .or_default() += 1;
        }
        Ok(counts
            .into_iter()
            .map(|((cls, reason), n)| json!({ "cls": cls, "reason": reason, "n": n }))
            .collect())
    }
}
