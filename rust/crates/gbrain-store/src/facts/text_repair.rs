//! The fact reads and writes of `gbrain repair redacted-facts` and of the `gbrain repair conversation-labels`
//! retirement (src/core/engine-sql/fact-text-repair.ts).
//!
//! - redacted-facts: `listRedactedFactCandidates` (active, unsuperseded rows whose text holds `[redacted`),
//!   `restoreRedactedFactTexts` (rewrites each row still exactly as previewed and appends the restore marker to its
//!   context) and `listProjectedFenceRows` (the fence rows a page write projected with their restored text).
//! - conversation-labels: `listUnexpiredFactIds`, `expireFactWithNote` (expires one row and appends the retirement
//!   marker), `expirePageFactsBySource` (expires a page's active rows of some sources) and `readMaxFactRowNum`.
//!
//! A context append is `concat_ws(' | ', NULLIF(context, ''), note)`. Every write goes through [`write_fact`], so the
//! trust stamp and the withdrawal trigger run as they do on Postgres.

use super::{FactRecord, read_fact, source_rows, write_fact};
use crate::Store;
use crate::error::Result;
use crate::links::no_nul;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

/// The marker SQL's `LIKE '%[redacted%'` matches.
const REDACTED: &str = "[redacted";
/// The conversation extractor's source prefix (`f.source LIKE 'cli:extract-conversation-facts%'`).
const CONVERSATION_EXTRACTOR: &str = "cli:extract-conversation-facts";

/// `listRedactedFactCandidates({ sourceIds, ids })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct RedactedFactQuery {
    pub source_ids: Vec<String>,
    /// `None` is every row.
    pub ids: Option<Vec<i64>>,
}

/// One candidate row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RedactedFactRow {
    pub id: u64,
    pub source_id: String,
    pub fact: String,
    pub visibility: String,
    pub entity_slug: Option<String>,
    pub row_num: Option<i32>,
    pub source_markdown_slug: Option<String>,
    pub context: Option<String>,
    pub source: String,
}

/// One approved rewrite: the row as previewed and its restored text.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FactTextRestore {
    pub id: i64,
    pub from_text: String,
    pub to_text: String,
    pub visibility: String,
    pub entity_slug: Option<String>,
    pub source_markdown_slug: Option<String>,
    pub row_num: Option<i32>,
}

/// `restoreRedactedFactTexts({ sourceId, restores, marker })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FactTextRestoreArgs {
    pub source_id: String,
    pub restores: Vec<FactTextRestore>,
    pub marker: String,
}

/// `listProjectedFenceRows({ sourceId, slug, rowNums, texts })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectedFenceQuery {
    pub source_id: String,
    pub slug: String,
    pub row_nums: Vec<i32>,
    pub texts: Vec<String>,
}

/// `listUnexpiredFactIds({ ids })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FactIdsQuery {
    pub ids: Vec<i64>,
}

/// `expireFactWithNote({ sourceId, id, note })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpireWithNote {
    pub source_id: String,
    pub id: i64,
    pub note: String,
}

/// `expirePageFactsBySource({ sourceId, slug, sources })` and, without `sources`, `readMaxFactRowNum`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PageFactsArgs {
    pub source_id: String,
    pub slug: String,
    pub sources: Vec<String>,
}

/// `concat_ws(' | ', NULLIF(context, ''), note)`.
fn append_note(context: Option<&str>, note: &str) -> String {
    match context {
        Some(c) if !c.is_empty() => format!("{c} | {note}"),
        _ => note.to_string(),
    }
}

fn active(f: &FactRecord) -> bool {
    f.expired_at_us.is_none() && f.superseded_by.is_none()
}

impl Store {
    /// Every active, unsuperseded fact of the sources (or of `ids`) whose text holds `[redacted`, by (source, id).
    pub fn list_redacted_fact_candidates(
        &self,
        q: &RedactedFactQuery,
    ) -> Result<Vec<RedactedFactRow>> {
        let op = "listRedactedFactCandidates";
        for source in &q.source_ids {
            no_nul(op, &[("sourceIds", source)])?;
        }
        let wanted: Option<BTreeSet<i64>> = q.ids.as_ref().map(|ids| ids.iter().copied().collect());
        let sources: BTreeSet<&str> = q.source_ids.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut out = Vec::new();
        for source in sources {
            let mut rows: Vec<RedactedFactRow> = source_rows(&*read, source)?
                .into_iter()
                .filter(|f| active(f) && f.fact.contains(REDACTED))
                .filter(|f| {
                    wanted
                        .as_ref()
                        .is_none_or(|w| i64::try_from(f.id).is_ok_and(|id| w.contains(&id)))
                })
                .map(|f| RedactedFactRow {
                    id: f.id,
                    source_id: f.source_id,
                    fact: f.fact,
                    visibility: f.visibility,
                    entity_slug: f.entity_slug,
                    row_num: f.row_num,
                    source_markdown_slug: f.source_markdown_slug,
                    context: f.context,
                    source: f.source,
                })
                .collect();
            rows.sort_by_key(|r| r.id);
            out.extend(rows);
        }
        Ok(out)
    }

    /// Rewrites each named row of the source still exactly as previewed to its restored text, appending `marker` to
    /// its context; answers the ids rewritten, by id.
    pub fn restore_redacted_fact_texts(&self, a: &FactTextRestoreArgs) -> Result<Vec<u64>> {
        let op = "restoreRedactedFactTexts";
        no_nul(op, &[("sourceId", &a.source_id), ("marker", &a.marker)])?;
        for r in &a.restores {
            no_nul(
                op,
                &[
                    ("from_text", &r.from_text),
                    ("to_text", &r.to_text),
                    ("visibility", &r.visibility),
                    ("entity_slug", r.entity_slug.as_deref().unwrap_or("")),
                    (
                        "source_markdown_slug",
                        r.source_markdown_slug.as_deref().unwrap_or(""),
                    ),
                ],
            )?;
        }
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut done = Vec::new();
            for r in &a.restores {
                let Ok(id) = u64::try_from(r.id) else {
                    continue;
                };
                let Some(old) = read_fact(tx, id)? else {
                    continue;
                };
                let same = old.source_id == a.source_id
                    && old.fact == r.from_text
                    && old.visibility == r.visibility
                    && old.entity_slug == r.entity_slug
                    && old.source_markdown_slug == r.source_markdown_slug
                    && active(&old)
                    && old.row_num == r.row_num
                    && (r.row_num.is_none() || old.source.starts_with(CONVERSATION_EXTRACTOR));
                if !same || done.contains(&id) {
                    continue;
                }
                let mut new = old.clone();
                new.fact = r.to_text.clone();
                new.context = Some(append_note(old.context.as_deref(), &a.marker));
                write_fact(tx, trust, Some(&old), &new)?;
                done.push(id);
            }
            done.sort_unstable();
            Ok(done)
        })
    }

    /// The row numbers of the page's active rows whose number and text are among the listed ones, ascending.
    pub fn list_projected_fence_rows(&self, q: &ProjectedFenceQuery) -> Result<Vec<i32>> {
        let op = "listProjectedFenceRows";
        no_nul(op, &[("sourceId", &q.source_id), ("slug", &q.slug)])?;
        for text in &q.texts {
            no_nul(op, &[("texts", text)])?;
        }
        let rows: BTreeSet<i32> = q.row_nums.iter().copied().collect();
        let texts: BTreeSet<&str> = q.texts.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut out: Vec<i32> = source_rows(&*read, &q.source_id)?
            .into_iter()
            .filter(|f| {
                f.expired_at_us.is_none()
                    && f.source_markdown_slug.as_deref() == Some(q.slug.as_str())
                    && f.row_num.is_some_and(|n| rows.contains(&n))
                    && texts.contains(f.fact.as_str())
            })
            .filter_map(|f| f.row_num)
            .collect();
        out.sort_unstable();
        Ok(out)
    }

    /// The named facts that are not expired, ascending.
    pub fn list_unexpired_fact_ids(&self, q: &FactIdsQuery) -> Result<Vec<u64>> {
        let read = self.read()?;
        let ids: BTreeSet<u64> = q
            .ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for id in ids {
            if read_fact(&*read, id)?.is_some_and(|f| f.expired_at_us.is_none()) {
                out.push(id);
            }
        }
        Ok(out)
    }

    /// Expires fact `id` of the source when it is not expired, appending `note` to its context; true when it did.
    pub fn expire_fact_with_note(&self, a: &ExpireWithNote) -> Result<bool> {
        no_nul(
            "expireFactWithNote",
            &[("sourceId", &a.source_id), ("note", &a.note)],
        )?;
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Ok(id) = u64::try_from(a.id) else {
                return Ok(false);
            };
            let Some(old) = read_fact(tx, id)? else {
                return Ok(false);
            };
            if old.source_id != a.source_id || old.expired_at_us.is_some() {
                return Ok(false);
            }
            let mut new = old.clone();
            new.expired_at_us = Some(now);
            new.context = Some(append_note(old.context.as_deref(), &a.note));
            write_fact(tx, trust, Some(&old), &new)?;
            Ok(true)
        })
    }

    /// Expires the page's unexpired facts whose source is one of `sources`; answers how many.
    pub fn expire_page_facts_by_source(&self, a: &PageFactsArgs) -> Result<u64> {
        let op = "expirePageFactsBySource";
        no_nul(op, &[("sourceId", &a.source_id), ("slug", &a.slug)])?;
        for source in &a.sources {
            no_nul(op, &[("sources", source)])?;
        }
        let sources: BTreeSet<&str> = a.sources.iter().map(String::as_str).collect();
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut n = 0;
            for old in source_rows(&*tx, &a.source_id)? {
                if old.expired_at_us.is_some()
                    || old.source_markdown_slug.as_deref() != Some(a.slug.as_str())
                    || !sources.contains(old.source.as_str())
                {
                    continue;
                }
                let mut new = old.clone();
                new.expired_at_us = Some(now);
                write_fact(tx, trust, Some(&old), &new)?;
                n += 1;
            }
            Ok(n)
        })
    }

    /// The largest `row_num` of any fact (expired or not) the page holds, or none.
    pub fn read_max_fact_row_num(&self, a: &PageFactsArgs) -> Result<Option<i32>> {
        no_nul(
            "readMaxFactRowNum",
            &[("sourceId", &a.source_id), ("slug", &a.slug)],
        )?;
        let read = self.read()?;
        Ok(source_rows(&*read, &a.source_id)?
            .into_iter()
            .filter(|f| f.source_markdown_slug.as_deref() == Some(a.slug.as_str()))
            .filter_map(|f| f.row_num)
            .max())
    }

    /// `hasActiveFactText({ sourceId, slug, fact, visibility })`: whether the page holds an unexpired fact with that
    /// text and visibility (`gbrain repair lost-fence-rows`).
    pub fn has_active_fact_text(&self, a: &FactTextQuery) -> Result<bool> {
        no_nul(
            "hasActiveFactText",
            &[
                ("sourceId", &a.source_id),
                ("slug", &a.slug),
                ("fact", &a.fact),
                ("visibility", &a.visibility),
            ],
        )?;
        let read = self.read()?;
        Ok(source_rows(&*read, &a.source_id)?.iter().any(|f| {
            f.expired_at_us.is_none()
                && f.source_markdown_slug.as_deref() == Some(a.slug.as_str())
                && f.fact == a.fact
                && f.visibility == a.visibility
        }))
    }

    /// `readFactTrustTier(id)`: the stored trust tier of fact `id`, or none.
    pub fn read_fact_trust_tier(&self, id: i64) -> Result<Option<String>> {
        let Ok(id) = u64::try_from(id) else {
            return Ok(None);
        };
        let read = self.read()?;
        Ok(read_fact(&*read, id)?.map(|f| f.tier().as_str().to_string()))
    }

    /// `listFenceFactRowNums({ sourceId, slug })`: the row numbers of every fact (expired or not) the page holds.
    pub fn list_fence_fact_row_nums(&self, a: &PageFactsArgs) -> Result<Vec<i32>> {
        no_nul(
            "listFenceFactRowNums",
            &[("sourceId", &a.source_id), ("slug", &a.slug)],
        )?;
        let read = self.read()?;
        let mut out: Vec<i32> = source_rows(&*read, &a.source_id)?
            .into_iter()
            .filter(|f| f.source_markdown_slug.as_deref() == Some(a.slug.as_str()))
            .filter_map(|f| f.row_num)
            .collect();
        out.sort_unstable();
        Ok(out)
    }

    /// `readLiveFactRowTier({ sourceId, slug, rowNum, fact })`: `{ id, trust_tier }` of the unexpired fact at that row
    /// number of the page with that text, or none.
    pub fn read_live_fact_row_tier(&self, a: &FactRowQuery) -> Result<Option<Value>> {
        no_nul(
            "readLiveFactRowTier",
            &[
                ("sourceId", &a.source_id),
                ("slug", &a.slug),
                ("fact", &a.fact),
            ],
        )?;
        let read = self.read()?;
        Ok(source_rows(&*read, &a.source_id)?
            .into_iter()
            .filter(|f| {
                f.expired_at_us.is_none()
                    && f.source_markdown_slug.as_deref() == Some(a.slug.as_str())
                    && f.row_num == Some(a.row_num)
                    && f.fact == a.fact
            })
            .min_by_key(|f| f.id)
            .map(|f| serde_json::json!({ "id": f.id, "trust_tier": f.tier().as_str() })))
    }
}

/// `hasActiveFactText({ sourceId, slug, fact, visibility })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FactTextQuery {
    pub source_id: String,
    pub slug: String,
    pub fact: String,
    pub visibility: String,
}

/// `readLiveFactRowTier({ sourceId, slug, rowNum, fact })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FactRowQuery {
    pub source_id: String,
    pub slug: String,
    pub row_num: i32,
    pub fact: String,
}
