//! The reads of the entity gazetteer (`buildGazetteer`), the full extract walk's watermark snapshot,
//! the by-mention rebuild and `gbrain extract mentions --explain`
//! (`src/core/engine-sql/mention-reads.ts`, `rust/docs/store/mention-state.md`). Each read takes
//! one snapshot and keeps no records of its own. The SQL leaves some row orders undefined; the
//! store answers pages by id and alias rows in key order, and the callers do not depend on it.

use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::Value;

use crate::Store;
use crate::cli_reads::entities::is_retired;
use crate::cli_reads::pg_text::{fm_text, fm_value};
use crate::env::iso;
use crate::error::Result;
use crate::mention_state::{mention_due, read_page_state};
use crate::pages::{PageRecord, all_pages, read_page};

/// One entity page of the gazetteer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GazetteerPageRow {
    pub slug: String,
    pub source_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub connector_stub: bool,
    pub h1: Option<String>,
    pub h2: Option<String>,
    pub h3: Option<String>,
    pub h4: Option<String>,
}

/// One alias row of a live entity page.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GazetteerAliasRow {
    pub alias_norm: String,
    pub slug: String,
    pub source_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub origin: String,
    pub case_sensitive: bool,
    pub alias_text: Option<String>,
    pub identity: Option<String>,
}

/// The text columns of a page explain reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageNameTextRow {
    pub title: String,
    pub compiled_truth: Option<String>,
    pub timeline: Option<String>,
    pub frontmatter: Value,
}

fn live_page(read: &dyn crate::kv::KvRead, source: &str, slug: &str) -> Result<Option<PageRecord>> {
    if source.contains('\0') || slug.contains('\0') {
        return Ok(None);
    }
    Ok(read_page(read, source, slug)?.filter(|p| p.deleted_at_us.is_none()))
}

fn live_pages_by_id(read: &dyn crate::kv::KvRead) -> Result<Vec<PageRecord>> {
    let mut pages: Vec<PageRecord> = all_pages(read)?
        .into_iter()
        .filter(|p| p.deleted_at_us.is_none())
        .collect();
    pages.sort_by_key(|p| p.id);
    Ok(pages)
}

fn name_text(p: &PageRecord) -> PageNameTextRow {
    PageNameTextRow {
        title: p.title.clone(),
        compiled_truth: p.compiled_truth.as_deref().map(str::to_owned),
        timeline: p.timeline.as_deref().map(str::to_owned),
        frontmatter: Value::Object(p.frontmatter.clone()),
    }
}

impl Store {
    /// `listLivePageSourceIds()`: the sources holding a live page, in byte order.
    pub fn list_live_page_source_ids(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let ids: BTreeSet<String> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none())
            .map(|p| p.source_id)
            .collect();
        Ok(ids
            .into_iter()
            .map(|id| serde_json::json!({ "id": id }))
            .collect())
    }

    /// `listGazetteerPages(types, handleKeys)`: live, unretired (`retiredPageSql`) pages of `types`, by id.
    pub fn list_gazetteer_pages(
        &self,
        types: &[String],
        handle_keys: &[String],
    ) -> Result<Vec<GazetteerPageRow>> {
        let read = self.read()?;
        let key = |i: usize| handle_keys.get(i).map(String::as_str).unwrap_or("");
        Ok(live_pages_by_id(&*read)?
            .into_iter()
            .filter(|p| types.contains(&p.page_type) && !is_retired(p))
            .map(|p| GazetteerPageRow {
                connector_stub: fm_text(&p.frontmatter, "google_contact_id").is_some(),
                h1: fm_text(&p.frontmatter, key(0)),
                h2: fm_text(&p.frontmatter, key(1)),
                h3: fm_text(&p.frontmatter, key(2)),
                h4: fm_text(&p.frontmatter, key(3)),
                slug: p.slug,
                source_id: p.source_id,
                title: p.title,
                page_type: p.page_type,
            })
            .collect())
    }

    /// `listGazetteerAliases(types)`: the alias rows of live, unretired pages of `types`, in key order.
    pub fn list_gazetteer_aliases(&self, types: &[String]) -> Result<Vec<GazetteerAliasRow>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for (source, slug, alias_norm, origin, value) in crate::aliases::all_alias_rows(&*read)? {
            let Some(p) = live_page(&*read, &source, &slug)? else {
                continue;
            };
            if !types.contains(&p.page_type) || is_retired(&p) {
                continue;
            }
            out.push(GazetteerAliasRow {
                alias_norm,
                slug,
                source_id: source,
                title: p.title.clone(),
                page_type: p.page_type.clone(),
                origin,
                case_sensitive: value.case_sensitive,
                alias_text: value.alias_text,
                identity: fm_text(&p.frontmatter, "identity"),
            });
        }
        Ok(out)
    }

    /// `readPageStampTimes(slugs, sourceIds)`: each live page of the pairs with its updated_at.
    pub fn read_page_stamp_times(
        &self,
        slugs: &[String],
        source_ids: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for (slug, source) in slugs.iter().zip(source_ids) {
            if let Some(p) = live_page(&*read, source, slug)? {
                out.push(serde_json::json!({ "slug": p.slug, "source_id": p.source_id, "updated_at_iso": iso(p.updated_at_us) }));
            }
        }
        Ok(out)
    }

    /// `readPageRevisionForShare(sourceId, slug)`: the live page's content revision.
    pub fn read_page_revision_for_share(&self, source_id: &str, slug: &str) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(live_page(&*read, source_id, slug)?
            .map(|p| serde_json::json!({ "revision": p.knowledge_revision }))
            .into_iter()
            .collect())
    }

    /// `readExplainPage(sourceId, slug)`.
    pub fn read_explain_page(&self, source_id: &str, slug: &str) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(live_page(&*read, source_id, slug)?
            .map(|p| serde_json::json!({ "slug": p.slug, "type": p.page_type, "title": p.title }))
            .into_iter()
            .collect())
    }

    /// `readExplainScanPage(sourceId, slug, version)`: the page's text, `mention_ignore` and due flag.
    pub fn read_explain_scan_page(
        &self,
        source_id: &str,
        slug: &str,
        version: i64,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let Some(p) = live_page(&*read, source_id, slug)? else {
            return Ok(Vec::new());
        };
        let due = mention_due(read_page_state(&*read, p.id)?.as_ref(), &p, version);
        Ok(vec![serde_json::json!({
            "id": p.id, "slug": p.slug, "title": p.title,
            "compiled_truth": p.compiled_truth.as_deref(), "timeline": p.timeline.as_deref(),
            "mention_ignore": fm_value(&p.frontmatter, "mention_ignore"), "due": due,
        })])
    }

    /// `countMentionLinksTo(pageId, sourceId, targets)`.
    pub fn count_mention_links_to(
        &self,
        page_id: i64,
        source_id: &str,
        targets: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut n = 0u64;
        if let Ok(id) = u64::try_from(page_id) {
            for link in crate::links::out_links(&*read, id)? {
                if link.link_source.as_deref() != Some("mentions") {
                    continue;
                }
                if let Some(t) = crate::pages::read_page_by_id(&*read, link.to_page_id)?
                    && t.source_id == source_id
                    && targets.contains(&t.slug)
                {
                    n += 1;
                }
            }
        }
        Ok(vec![serde_json::json!({ "n": n })])
    }

    /// `readPageNameText(sourceId, slug)`.
    pub fn read_page_name_text(&self, source_id: &str, slug: &str) -> Result<Vec<PageNameTextRow>> {
        let read = self.read()?;
        Ok(live_page(&*read, source_id, slug)?
            .map(|p| name_text(&p))
            .into_iter()
            .collect())
    }

    /// `listFrontmatterAliasNorms(sourceId, slug)`: the page's frontmatter alias rows, by alias.
    pub fn list_frontmatter_alias_norms(&self, source_id: &str, slug: &str) -> Result<Vec<Value>> {
        let read = self.read()?;
        let norms: BTreeSet<String> = crate::aliases::all_alias_rows(&*read)?
            .into_iter()
            .filter(|(s, sl, _, origin, _)| s == source_id && sl == slug && origin == "frontmatter")
            .map(|(_, _, alias, _, _)| alias)
            .collect();
        Ok(norms
            .into_iter()
            .map(|a| serde_json::json!({ "alias_norm": a }))
            .collect())
    }

    /// `listRejectedDeclarationPages(sourceId, types, pattern)`: up to 50 live pages of `types` in
    /// the source whose body or title ILIKE `pattern`, by id.
    pub fn list_rejected_declaration_pages(
        &self,
        source_id: &str,
        types: &[String],
        pattern: &str,
    ) -> Result<Vec<PageNameTextRow>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for p in live_pages_by_id(&*read)? {
            if out.len() >= 50 {
                break;
            }
            if p.source_id != source_id || !types.contains(&p.page_type) {
                continue;
            }
            let body_hit = match p.compiled_truth.as_deref() {
                Some(ct) => crate::facts::like(ct, pattern, true)?,
                None => false,
            };
            if body_hit || crate::facts::like(&p.title, pattern, true)? {
                out.push(name_text(&p));
            }
        }
        Ok(out)
    }

    /// `readSegmentedPageSealed(sourceId, slug)`: the live page's `text_projection_revision = knowledge_revision`
    /// (null while it has no projection revision, as the SQL comparison with NULL is).
    pub fn read_segmented_page_sealed(&self, source_id: &str, slug: &str) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(live_page(&*read, source_id, slug)?
            .map(|p| {
                let sealed = p
                    .text_projection_revision
                    .as_deref()
                    .map(|r| r == p.knowledge_revision);
                serde_json::json!({ "sealed": sealed })
            })
            .into_iter()
            .collect())
    }
}
