//! Slug reads that callers ran through `executeRaw` and that order by byte
//! (`src/core/engine-sql/collate-slug-reads.ts`).
//!
//! Members: resolveLiveSlugByPath, listUnarchivedSlugSources, countLivePageTypes, listTypeOrphanPages, readExportPageRows.
//!
//! Keys: none. Each read scans the page records (`pages::all_pages`), as `page_ops` does. Text
//! sorts in byte order, which is what `COLLATE "C"` gives on Postgres and PGLite; a Rust `String`
//! compares by byte.

use crate::Store;
use crate::error::{Result, StoreError};
use crate::links::no_nul;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::sources::all_sources;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The source scope of `findTypeOrphans`: `source_ids` when not empty, else `source_id`, else
/// every source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TypeScope {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
}

impl TypeScope {
    fn check(&self, member: &str) -> Result<()> {
        let mut parts: Vec<(&str, &str)> = Vec::new();
        if let Some(id) = &self.source_id {
            parts.push(("sourceId", id));
        }
        for id in self.source_ids.iter().flatten() {
            parts.push(("sourceIds", id));
        }
        no_nul(member, &parts)
    }

    /// Whether a page is in scope: live (`deleted_at IS NULL`) and in the named sources.
    fn holds(&self, page: &PageRecord) -> bool {
        if page.deleted_at_us.is_some() {
            return false;
        }
        match (&self.source_ids, &self.source_id) {
            (Some(ids), _) if !ids.is_empty() => ids.contains(&page.source_id),
            (_, Some(id)) if !id.is_empty() => page.source_id == *id,
            _ => true,
        }
    }
}

/// `listTypeOrphanPages({ scope, types, limit })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TypeOrphanQuery {
    #[serde(default)]
    pub scope: TypeScope,
    pub types: Vec<String>,
    pub limit: i64,
}

impl Store {
    /// `resolveLiveSlugByPath(path)`: the slug of the live page that records `path` as its origin
    /// (`source_path`), across every source. With several such pages, the one in the lowest source
    /// id, then the lowest slug. `None` when no live page claims the path.
    pub fn resolve_live_slug_by_path(&self, path: &str) -> Result<Option<String>> {
        no_nul("resolveLiveSlugByPath", &[("path", path)])?;
        let read = self.read()?;
        Ok(all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && p.source_path.as_deref() == Some(path))
            .map(|p| (p.source_id, p.slug))
            .min()
            .map(|(_, slug)| slug)
            .filter(|slug| !slug.is_empty()))
    }

    /// `listUnarchivedSlugSources(slug)`: the distinct ids of the unarchived sources that hold a
    /// live page at `slug`, in byte order.
    pub fn list_unarchived_slug_sources(&self, slug: &str) -> Result<Vec<String>> {
        no_nul("listUnarchivedSlugSources", &[("slug", slug)])?;
        let read = self.read()?;
        let unarchived: BTreeSet<String> = all_sources(&*read)?
            .into_iter()
            .filter(|s| !s.archived)
            .map(|s| s.id)
            .collect();
        let held: BTreeSet<String> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.slug == slug && p.deleted_at_us.is_none())
            .map(|p| p.source_id)
            .filter(|id| unarchived.contains(id))
            .collect();
        Ok(held.into_iter().collect())
    }

    /// `countLivePageTypes(scope)`: `{ type, n }` for each type the live pages in scope carry, `n`
    /// the page count as text. The SQL has no `ORDER BY`; the store answers in type byte order.
    pub fn count_live_page_types(&self, scope: &TypeScope) -> Result<Vec<Value>> {
        scope.check("countLivePageTypes")?;
        let read = self.read()?;
        let mut counts: BTreeMap<String, u64> = BTreeMap::new();
        for page in all_pages(&*read)?.iter().filter(|p| scope.holds(p)) {
            *counts.entry(page.page_type.clone()).or_default() += 1;
        }
        Ok(counts
            .into_iter()
            .map(|(t, n)| json!({ "type": t, "n": n.to_string() }))
            .collect())
    }

    /// `listTypeOrphanPages(query)`: `{ slug, source_id, type }` of the live pages in scope whose
    /// type is empty or one of `types`, by source id, then slug, in byte order, up to `limit`.
    pub fn list_type_orphan_pages(&self, query: &TypeOrphanQuery) -> Result<Vec<Value>> {
        query.scope.check("listTypeOrphanPages")?;
        let named: Vec<&str> = query.types.iter().map(String::as_str).collect();
        no_nul(
            "listTypeOrphanPages",
            &named.iter().map(|t| ("types", *t)).collect::<Vec<_>>(),
        )?;
        let limit = usize::try_from(query.limit)
            .map_err(|_| StoreError::invalid("listTypeOrphanPages: limit must not be negative"))?;
        let read = self.read()?;
        let mut rows: Vec<(String, String, String)> = all_pages(&*read)?
            .into_iter()
            .filter(|p| query.scope.holds(p))
            .filter(|p| p.page_type.is_empty() || named.contains(&p.page_type.as_str()))
            .map(|p| (p.source_id, p.slug, p.page_type))
            .collect();
        rows.sort();
        Ok(rows
            .into_iter()
            .take(limit)
            .map(|(source_id, slug, t)| json!({ "slug": slug, "source_id": source_id, "type": t }))
            .collect())
    }

    /// `readExportPageRows(ids)`: `{ page, tags }` for each live page whose id is in `ids`, in id
    /// order (the SQL has no `ORDER BY`; the caller maps the rows by id). A repeated id answers
    /// once and an id no live page has answers nothing. `page` is the page `getPage` returns with
    /// its columns; `tags` are the page's tags in byte order.
    pub fn read_export_page_rows(&self, ids: &[u64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let wanted: BTreeSet<u64> = ids.iter().copied().collect();
        let mut out = Vec::with_capacity(wanted.len());
        for id in wanted {
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            if page.deleted_at_us.is_some() {
                continue;
            }
            let mut tags = page.tags.clone();
            tags.sort();
            out.push(json!({ "page": page.to_page_with_columns(&*read)?, "tags": tags }));
        }
        Ok(out)
    }
}
