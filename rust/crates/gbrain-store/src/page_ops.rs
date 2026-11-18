//! Page operations: the id-keyed marker and date reads hybrid search needs (`getContentFlagsByPageIds`,
//! `getUnverifiedExtractionPageIds`, `getEffectiveDates`), each the PGLite query of the same name answered
//! over the page records of `pages.rs`. The other page operations are not built yet.
//!
//! Members: getContentFlagsByPageIds, getUnverifiedExtractionPageIds, getEffectiveDates.
//!
//! Keys: none. Every read scans the page records, as `list_pages` does; the family tag
//! `keys::PAGE_OPS` (`p`) stays unused until an index is needed, and such an index needs the core
//! `write_page` hook to stay in step.

use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::facts::{OwnerOnlyCache, PrivacyPolicy};
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages, read_page};
use crate::sources::{SourceRecord, all_sources};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};

/// A page named by source and slug: `{ slug, source_id }` (also read as `sourceId`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PageRef {
    pub slug: String,
    #[serde(alias = "sourceId")]
    pub source_id: String,
}

/// The `PageReadScope` of the id and ref reads. `live` is true when the caller passed a scope at
/// all: PGLite then adds its live filter (not deleted, not quarantined, source not archived).
/// `exclude_private` (`excludePrivate`) is the page policy `pageReadFilter` adds, as
/// `facts/privacy.rs` `page_hidden` reads it; `None` hides nothing.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PageReadScope {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub live: bool,
    pub exclude_private: Option<PrivacyPolicy>,
}

/// Postgres `->>` on a JSON value: a string as is, `null` as SQL NULL, anything else as its jsonb
/// text form.
fn json_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// The jsonb output form: `{"k": v, "k2": v}` with keys ordered by length, then bytes, and `[1, 2]`.
fn jsonb_text(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(jsonb_text).collect();
            format!("[{}]", parts.join(", "))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
            let parts: Vec<String> = keys
                .iter()
                .map(|k| format!("{}: {}", Value::String((*k).clone()), jsonb_text(&map[*k])))
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
        other => other.to_string(),
    }
}

/// `frontmatter ->> key`.
fn fm_text(frontmatter: &Map<String, Value>, key: &str) -> Option<String> {
    frontmatter.get(key).and_then(json_text)
}

/// `COALESCE(effective_date, updated_at, created_at)`.
fn effective_us(page: &PageRecord) -> i64 {
    page.effective_date_us.unwrap_or(page.updated_at_us)
}

fn sources_by_id(read: &dyn KvRead) -> Result<HashMap<String, SourceRecord>> {
    Ok(all_sources(read)?
        .into_iter()
        .map(|s| (s.id.clone(), s))
        .collect())
}

/// `pageReadFilter(alias, scope, params, live)` for the scope fields the store has.
fn passes_read_scope(
    read: &dyn KvRead,
    page: &PageRecord,
    scope: &PageReadScope,
    sources: &HashMap<String, SourceRecord>,
    owner_only: &mut OwnerOnlyCache,
) -> Result<bool> {
    if let Some(ids) = scope.source_ids.as_ref().filter(|ids| !ids.is_empty()) {
        if !ids.contains(&page.source_id) {
            return Ok(false);
        }
    } else if let Some(id) = scope.source_id.as_ref().filter(|id| !id.is_empty())
        && *id != page.source_id
    {
        return Ok(false);
    }
    if let Some(policy) = &scope.exclude_private
        && owner_only.page_hidden(read, page, policy)?
    {
        return Ok(false);
    }
    if scope.live {
        let unarchived = sources.get(&page.source_id).is_some_and(|s| !s.archived);
        if page.deleted_at_us.is_some()
            || page.frontmatter.contains_key("quarantine")
            || !unarchived
        {
            return Ok(false);
        }
    }
    Ok(true)
}

impl Store {
    /// `getPageTimestamps(slugs)`: `{ slug, ts }` for every page with one of the slugs, in any
    /// source and deleted or not, in page id order (the caller keys a map by slug, so a later
    /// source's page wins, as PGLite's row order makes it).
    pub fn get_page_timestamps(&self, slugs: &[String]) -> Result<Vec<Value>> {
        if slugs.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: HashSet<&str> = slugs.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| wanted.contains(p.slug.as_str()))
            .collect();
        pages.sort_by_key(|p| p.id);
        Ok(pages
            .iter()
            .map(|p| json!({ "slug": p.slug, "ts": iso(p.updated_at_us) }))
            .collect())
    }

    /// `getEffectiveDates(refs, scope?)`: `{ slug, source_id, ts }` per ref that names a page,
    /// `ts` = effective date, else updated_at.
    pub fn get_effective_dates(
        &self,
        refs: &[PageRef],
        scope: &PageReadScope,
    ) -> Result<Vec<Value>> {
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let sources = sources_by_id(&*read)?;
        let mut owner_only = OwnerOnlyCache::default();
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for r in refs {
            if !seen.insert((r.source_id.as_str(), r.slug.as_str())) {
                continue;
            }
            if let Some(page) = read_page(&*read, &r.source_id, &r.slug)?
                && passes_read_scope(&*read, &page, scope, &sources, &mut owner_only)?
            {
                out.push(json!({
                    "slug": page.slug,
                    "source_id": page.source_id,
                    "ts": iso(effective_us(&page)),
                }));
            }
        }
        Ok(out)
    }

    fn pages_by_ids(&self, ids: &[i64], scope: &PageReadScope) -> Result<Vec<PageRecord>> {
        let read = self.read()?;
        let sources = sources_by_id(&*read)?;
        let mut owner_only = OwnerOnlyCache::default();
        let wanted: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for id in wanted {
            if let Some(page) = crate::pages::read_page_by_id(&*read, id)?
                && passes_read_scope(&*read, &page, scope, &sources, &mut owner_only)?
            {
                out.push(page);
            }
        }
        Ok(out)
    }

    /// `getContentFlagsByPageIds(ids, scope?)`: `{ id, reason, detail }` for every page whose
    /// frontmatter `content_flag` has a non-empty `reason`; `detail` is `''` when absent.
    pub fn get_content_flags_by_page_ids(
        &self,
        ids: &[i64],
        scope: &PageReadScope,
    ) -> Result<Vec<Value>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for page in self.pages_by_ids(ids, scope)? {
            let Some(flag) = page.frontmatter.get("content_flag") else {
                continue;
            };
            let field = |k: &str| flag.as_object().and_then(|o| o.get(k)).and_then(json_text);
            let Some(reason) = field("reason").filter(|r| !r.is_empty()) else {
                continue;
            };
            out.push(json!({
                "id": page.id,
                "reason": reason,
                "detail": field("detail").unwrap_or_default(),
            }));
        }
        Ok(out)
    }

    /// `getUnverifiedExtractionPageIds(ids, scope?)`: `{ id, status, unverified }` for every page
    /// with a frontmatter `status`; `unverified` when `provenance` is `auto-extracted` and
    /// `status` is `unverified`.
    pub fn get_unverified_extraction_page_ids(
        &self,
        ids: &[i64],
        scope: &PageReadScope,
    ) -> Result<Vec<Value>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for page in self.pages_by_ids(ids, scope)? {
            let Some(status) = fm_text(&page.frontmatter, "status") else {
                continue;
            };
            let unverified = fm_text(&page.frontmatter, "provenance").as_deref()
                == Some("auto-extracted")
                && status == "unverified";
            out.push(json!({ "id": page.id, "status": status, "unverified": unverified }));
        }
        Ok(out)
    }
}

/// The page index hook (`page_index::reindex_page`): keeps this family's index of page fields in
/// step with a page write. Empty until this family indexes a page field.
pub(crate) fn reindex_page(
    _tx: &mut dyn crate::kv::KvWrite,
    _before: Option<&crate::pages::PageRecord>,
    _after: Option<&crate::pages::PageRecord>,
) -> crate::Result<()> {
    Ok(())
}
