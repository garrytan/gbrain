//! The timeline repair reads of `src/core/engine-sql/timeline-repair-reads.ts`: the page scans of
//! `gbrain repair timeline` (`listTimelineHistoryPages`), `timeline-comments`
//! (`listTimelineMarkupRows`, `listMaterializedMarkerPages`), `timeline-order`
//! (`listDateBulletPages`) and `connector-fences` (`listConnectorFencePages`), the stored-version
//! reads of the timeline retraction check (`listTimelineVersionWitnesses`,
//! `readTimelineVersionBody`) and the comment-row rewrite (`rewriteTimelineRow`).
//!
//! Each member answers what the SQL engines' statement answers over the same rows. None applies a
//! read policy. A page is live when it is not soft-deleted; an inline page is one whose body
//! columns are not both NULL (`pages_body_storage_chk`). An own timeline row is one with no event
//! page. `LIKE` patterns match by character: `_` is any one character, `%` any run.
//!
//! `rewriteTimelineRow` moves the entry's `D` key with its new source and summary; a new key that
//! names another entry of the page is `constraint_violation`, as the unique index refuses the
//! UPDATE.

use std::collections::BTreeSet;

use super::{jsonb_field_text, own_entries};
use crate::Store;
use crate::error::Result;
use crate::facts::md5_hex;
use crate::links::no_nul;
use crate::pages::{PageRecord, all_pages, versions_of};
use crate::sources::all_sources;
use crate::timeline::{TimelineRecord, put_entry};
use serde::Deserialize;
use serde_json::{Value, json};

/// `listTimelineHistoryPages(sourceIds, q)`: `afterId` + `limit`, or `ids`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineHistoryInput {
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub after_id: Option<i64>,
    #[serde(default)]
    pub limit: Option<u64>,
    #[serde(default)]
    pub ids: Option<Vec<i64>>,
}

/// `listTimelineMarkupRows(q)`: `sourceIds` + `afterId`, or `pageId`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMarkupInput {
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
    #[serde(default)]
    pub after_id: Option<i64>,
    #[serde(default)]
    pub page_id: Option<i64>,
}

/// `listDateBulletPages(sourceIds, afterId, slugs, limit)` and `listMaterializedMarkerPages(sourceIds, afterId)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePageScanInput {
    #[serde(default)]
    pub source_ids: Vec<String>,
    pub after_id: i64,
    #[serde(default)]
    pub slugs: Vec<String>,
    #[serde(default)]
    pub limit: Option<u64>,
}

/// `listConnectorFencePages(sourceIds, kinds, segmented)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorFenceInput {
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub segmented: bool,
}

/// `rewriteTimelineRow(pageId, { id, source, summary, detail })`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TimelineRowRewrite {
    pub id: i64,
    pub source: String,
    pub summary: String,
    pub detail: String,
}

fn inline(page: &PageRecord) -> bool {
    !(page.compiled_truth.is_null() && page.timeline.is_null())
}

fn body(page: &PageRecord) -> Value {
    json!({
        "id": page.id,
        "source_id": page.source_id,
        "slug": page.slug,
        "compiled_truth": page.compiled_truth.as_deref(),
        "timeline": page.timeline.as_deref(),
    })
}

/// `text LIKE '%- **____-__-__**%'`.
fn has_date_bullet(text: &str) -> bool {
    const SHAPE: &str = "- **____-__-__**";
    let shape: Vec<char> = SHAPE.chars().collect();
    let chars: Vec<char> = text.chars().collect();
    chars
        .windows(shape.len())
        .any(|w| w.iter().zip(&shape).all(|(c, s)| *s == '_' || c == s))
}

fn markup(text: &str) -> bool {
    text.contains("<!--") || text.contains("-->")
}

fn live_pages(store: &Store, sources: &BTreeSet<&str>) -> Result<Vec<PageRecord>> {
    let read = store.read()?;
    let mut pages: Vec<PageRecord> = all_pages(&*read)?
        .into_iter()
        .filter(|p| p.deleted_at_us.is_none() && sources.contains(p.source_id.as_str()))
        .collect();
    pages.sort_by_key(|p| p.id);
    Ok(pages)
}

fn after(page: &PageRecord, after_id: i64) -> bool {
    i64::try_from(page.id).is_ok_and(|id| id > after_id)
}

fn take(limit: Option<u64>) -> usize {
    limit.map_or(usize::MAX, |l| {
        usize::try_from(l.max(1)).unwrap_or(usize::MAX)
    })
}

impl Store {
    /// `listTimelineHistoryPages(sourceIds, q)`: live inline pages of the sources, by id: with
    /// `ids` those pages; else those after `afterId` holding an own row, at most `limit`.
    pub fn list_timeline_history_pages(&self, input: &TimelineHistoryInput) -> Result<Vec<Value>> {
        let sources: BTreeSet<&str> = input.source_ids.iter().map(String::as_str).collect();
        let pages = live_pages(self, &sources)?.into_iter().filter(inline);
        if let Some(ids) = &input.ids {
            let ids: BTreeSet<u64> = ids
                .iter()
                .filter_map(|id| u64::try_from(*id).ok())
                .collect();
            return Ok(pages
                .filter(|p| ids.contains(&p.id))
                .map(|p| body(&p))
                .collect());
        }
        let read = self.read()?;
        let mut out = Vec::new();
        let limit = take(input.limit);
        let after_id = input.after_id.unwrap_or(0);
        for page in pages.filter(|p| after(p, after_id)) {
            if out.len() >= limit {
                break;
            }
            if own_entries(&*read, page.id)?.is_empty() {
                continue;
            }
            out.push(body(&page));
        }
        Ok(out)
    }

    /// `listTimelineVersionWitnesses(sourceId, slug)`: the stored versions of the page at
    /// (`sourceId`, `slug`), deleted or not, newest first.
    pub fn list_timeline_version_witnesses(
        &self,
        source_id: &str,
        slug: &str,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut versions = Vec::new();
        for page in all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.slug == slug)
        {
            versions.extend(versions_of(&*read, page.id)?);
        }
        versions.sort_by_key(|v| std::cmp::Reverse(v.id));
        Ok(versions
            .into_iter()
            .map(|v| {
                json!({
                    "id": v.id,
                    "body_storage": v.body_storage.as_deref().unwrap_or("inline"),
                    "page_id": v.page_id,
                    "generation": v.body_generation,
                    "content_hash": v.content_hash,
                })
            })
            .collect())
    }

    /// `readTimelineVersionBody(pageId, versionId)`: the version's body and the md5 of each part
    /// (`head` the compiled truth, `tail` the timeline or ''), or null.
    pub fn read_timeline_version_body(&self, page_id: i64, version_id: i64) -> Result<Value> {
        let (Ok(page_id), Ok(version_id)) = (u64::try_from(page_id), u64::try_from(version_id))
        else {
            return Ok(Value::Null);
        };
        let read = self.read()?;
        let Some(v) = versions_of(&*read, page_id)?
            .into_iter()
            .find(|v| v.id == version_id)
        else {
            return Ok(Value::Null);
        };
        Ok(json!({
            "compiled_truth": v.compiled_truth.as_deref(),
            "timeline": v.timeline.as_deref(),
            "head": v.compiled_truth.as_deref().map(md5_hex),
            "tail": md5_hex(v.timeline.as_deref().unwrap_or("")),
        }))
    }

    /// `listTimelineMarkupRows(q)`: own rows on live pages whose summary, source or detail holds
    /// `<!--` or `-->`, on page `pageId` or on the sources' pages after `afterId`, by page then id.
    pub fn list_timeline_markup_rows(&self, input: &TimelineMarkupInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let sources: Option<BTreeSet<&str>> = input
            .source_ids
            .as_ref()
            .map(|s| s.iter().map(String::as_str).collect());
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none())
            .filter(|p| match input.page_id {
                Some(id) => i64::try_from(p.id).is_ok_and(|p| p == id),
                None => {
                    sources
                        .as_ref()
                        .is_some_and(|s| s.contains(p.source_id.as_str()))
                        && after(p, input.after_id.unwrap_or(0))
                }
            })
            .collect();
        pages.sort_by_key(|p| p.id);
        let mut out = Vec::new();
        for page in pages {
            let mut rows: Vec<TimelineRecord> = own_entries(&*read, page.id)?
                .into_values()
                .filter(|e| markup(&e.summary) || markup(&e.source) || markup(&e.detail))
                .collect();
            rows.sort_by_key(|e| e.id);
            let storage = if inline(&page) { "inline" } else { "segmented" };
            for e in rows {
                out.push(json!({
                    "id": e.id,
                    "page_id": e.page_id,
                    "source_id": page.source_id,
                    "slug": page.slug,
                    "date": e.date,
                    "source": e.source,
                    "summary": e.summary,
                    "detail": e.detail,
                    "body_storage": storage,
                }));
            }
        }
        Ok(out)
    }

    /// `listMaterializedMarkerPages(sourceIds, afterId)`: live pages of the sources after `afterId`
    /// whose body holds `gbrain:materialized`, by id.
    pub fn list_materialized_marker_pages(
        &self,
        input: &TimelinePageScanInput,
    ) -> Result<Vec<Value>> {
        let sources: BTreeSet<&str> = input.source_ids.iter().map(String::as_str).collect();
        let holds = |t: Option<&str>| t.is_some_and(|t| t.contains("gbrain:materialized"));
        Ok(live_pages(self, &sources)?
            .into_iter()
            .filter(|p| after(p, input.after_id))
            .filter(|p| holds(p.compiled_truth.as_deref()) || holds(p.timeline.as_deref()))
            .map(|p| body(&p))
            .collect())
    }

    /// `listDateBulletPages(sourceIds, afterId, slugs, limit)`: live inline pages of the sources
    /// after `afterId` (of `slugs` unless empty) whose body holds a dated bullet, by id, at most
    /// `limit`.
    pub fn list_date_bullet_pages(&self, input: &TimelinePageScanInput) -> Result<Vec<Value>> {
        let sources: BTreeSet<&str> = input.source_ids.iter().map(String::as_str).collect();
        let slugs: BTreeSet<&str> = input.slugs.iter().map(String::as_str).collect();
        let holds = |t: Option<&str>| t.is_some_and(has_date_bullet);
        Ok(live_pages(self, &sources)?
            .into_iter()
            .filter(|p| inline(p) && after(p, input.after_id))
            .filter(|p| holds(p.timeline.as_deref()) || holds(p.compiled_truth.as_deref()))
            .filter(|p| slugs.is_empty() || slugs.contains(p.slug.as_str()))
            .take(take(input.limit))
            .map(|p| body(&p))
            .collect())
    }

    /// `listConnectorFencePages(sourceIds, kinds, segmented)`: live pages of the sources whose
    /// source `config.kind` is one of `kinds`, by id: segmented ones, or those whose timeline holds
    /// `gbrain:facts:` or `gbrain:takes:`.
    pub fn list_connector_fence_pages(&self, input: &ConnectorFenceInput) -> Result<Vec<Value>> {
        let read = self.read()?;
        let kinds: BTreeSet<&str> = input.kinds.iter().map(String::as_str).collect();
        let wanted: BTreeSet<&str> = input.source_ids.iter().map(String::as_str).collect();
        let connector: BTreeSet<String> = all_sources(&*read)?
            .into_iter()
            .filter(|s| wanted.contains(s.id.as_str()))
            .filter(|s| {
                s.config
                    .get("kind")
                    .and_then(jsonb_field_text)
                    .is_some_and(|k| kinds.contains(k.as_str()))
            })
            .map(|s| s.id)
            .collect();
        let sources: BTreeSet<&str> = connector.iter().map(String::as_str).collect();
        let fenced = |t: Option<&str>| {
            t.is_some_and(|t| t.contains("gbrain:facts:") || t.contains("gbrain:takes:"))
        };
        Ok(live_pages(self, &sources)?
            .into_iter()
            .filter(|p| {
                if input.segmented {
                    !inline(p)
                } else {
                    fenced(p.timeline.as_deref())
                }
            })
            .map(|p| body(&p))
            .collect())
    }

    /// `rewriteTimelineRow(pageId, row)`: sets the source, summary and detail of the page's own
    /// entry `row.id`; no such entry writes nothing.
    pub fn rewrite_timeline_row(&self, page_id: i64, row: &TimelineRowRewrite) -> Result<()> {
        no_nul(
            "rewriteTimelineRow",
            &[
                ("source", &row.source),
                ("summary", &row.summary),
                ("detail", &row.detail),
            ],
        )?;
        let (Ok(page_id), Ok(id)) = (u64::try_from(page_id), u64::try_from(row.id)) else {
            return Ok(());
        };
        self.write(|tx| {
            let own = own_entries(&*tx, page_id)?;
            let Some(entry) = own.get(&id) else {
                return Ok(());
            };
            let new = TimelineRecord {
                source: row.source.clone(),
                summary: row.summary.clone(),
                detail: row.detail.clone(),
                ..entry.clone()
            };
            put_entry(tx, Some(entry), &new)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_bullet_matches_any_character_per_underscore() {
        assert!(has_date_bullet("x\n- **2024-03-01** a"));
        assert!(has_date_bullet("- **abcd-ef-gh**"));
        assert!(!has_date_bullet("- **2024-3-01**"));
        assert!(has_date_bullet("- **2024-é3-01** - **20é4-03-01**"));
    }
}
