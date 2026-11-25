//! The page reads of the moved-pages verdict (`readMovedPage`, src/core/persistence/moved-pages.ts) and of
//! `gbrain repair moved-pages`' apply recheck (src/core/engine-sql/moved-page-reads.ts).
//!
//! - `listLivePagesBySourcePaths(sourceId, excludeId, paths)`: the live pages of the source (but `excludeId`) whose
//!   `source_path` is one of `paths`, by id.
//! - `listLivePagesByFileName(sourceId, excludeId, name)`: at most five live pages whose `source_path` is `name` or
//!   ends in `/name`, by slug.
//! - `listLivePagesSharingFrontmatterId(sourceId, pageId)`: at most five other live pages whose frontmatter `id` text
//!   is page `pageId`'s, by slug; none when that page names no id.
//! - `hasSegmentedHistory(pageId)`: whether the page or one of its versions is stored in segments.
//! - `readLivePagesByIds(sourceId, ids)`: the named live pages of the source with their revision and path.
//!
//! Slugs sort in byte order, which is the SQL's order under the C collation the parity brains use.

use serde_json::{Value, json};
use std::collections::BTreeSet;

use crate::Store;
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::{PageRecord, all_pages, read_page_by_id, versions_of};

const NAMED_LIMIT: usize = 5;

/// SQL's `->>` on a frontmatter key.
fn fm_text(page: &PageRecord, key: &str) -> Option<String> {
    match page.frontmatter.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

fn live_of(pages: Vec<PageRecord>, source_id: &str, exclude: i64) -> Vec<PageRecord> {
    pages
        .into_iter()
        .filter(|p| {
            p.source_id == source_id
                && p.deleted_at_us.is_none()
                && i64::try_from(p.id).is_ok_and(|id| id != exclude)
        })
        .collect()
}

fn page_row(p: &PageRecord) -> Value {
    json!({ "id": p.id, "slug": p.slug, "revision": p.knowledge_revision, "source_path": p.source_path })
}

impl Store {
    pub fn list_live_pages_by_source_paths(
        &self,
        source_id: &str,
        exclude_id: i64,
        paths: &[String],
    ) -> Result<Vec<Value>> {
        let op = "listLivePagesBySourcePaths";
        no_nul(op, &[("sourceId", source_id)])?;
        for path in paths {
            no_nul(op, &[("paths", path)])?;
        }
        let wanted: BTreeSet<&str> = paths.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut rows: Vec<PageRecord> = live_of(all_pages(&*read)?, source_id, exclude_id)
            .into_iter()
            .filter(|p| {
                p.source_path
                    .as_deref()
                    .is_some_and(|sp| wanted.contains(sp))
            })
            .collect();
        rows.sort_by_key(|p| p.id);
        Ok(rows.iter().map(page_row).collect())
    }

    pub fn list_live_pages_by_file_name(
        &self,
        source_id: &str,
        exclude_id: i64,
        name: &str,
    ) -> Result<Vec<Value>> {
        no_nul(
            "listLivePagesByFileName",
            &[("sourceId", source_id), ("name", name)],
        )?;
        let suffix = format!("/{name}");
        let read = self.read()?;
        let mut rows: Vec<PageRecord> = live_of(all_pages(&*read)?, source_id, exclude_id)
            .into_iter()
            .filter(|p| {
                p.source_path
                    .as_deref()
                    .is_some_and(|sp| sp == name || sp.ends_with(&suffix))
            })
            .collect();
        rows.sort_by(|a, b| a.slug.as_bytes().cmp(b.slug.as_bytes()));
        rows.truncate(NAMED_LIMIT);
        Ok(rows
            .iter()
            .map(|p| json!({ "slug": p.slug, "source_path": p.source_path }))
            .collect())
    }

    pub fn list_live_pages_sharing_frontmatter_id(
        &self,
        source_id: &str,
        page_id: i64,
    ) -> Result<Vec<String>> {
        no_nul(
            "listLivePagesSharingFrontmatterId",
            &[("sourceId", source_id)],
        )?;
        let read = self.read()?;
        let Ok(id) = u64::try_from(page_id) else {
            return Ok(Vec::new());
        };
        let Some(own) = read_page_by_id(&*read, id)?.and_then(|p| fm_text(&p, "id")) else {
            return Ok(Vec::new());
        };
        if own.is_empty() {
            return Ok(Vec::new());
        }
        let mut slugs: Vec<String> = live_of(all_pages(&*read)?, source_id, page_id)
            .into_iter()
            .filter(|p| fm_text(p, "id").as_deref() == Some(own.as_str()))
            .map(|p| p.slug)
            .collect();
        slugs.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        slugs.truncate(NAMED_LIMIT);
        Ok(slugs)
    }

    pub fn has_segmented_history(&self, page_id: i64) -> Result<bool> {
        let Ok(id) = u64::try_from(page_id) else {
            return Ok(false);
        };
        let read = self.read()?;
        if read_page_by_id(&*read, id)?.is_some_and(|p| p.compiled_truth.is_null()) {
            return Ok(true);
        }
        Ok(versions_of(&*read, id)?
            .iter()
            .any(|v| v.body_storage.as_deref().is_some_and(|s| s != "inline")))
    }

    pub fn read_live_pages_by_ids(&self, source_id: &str, ids: &[i64]) -> Result<Vec<Value>> {
        no_nul("readLivePagesByIds", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let mut out = Vec::new();
        let ids: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        for id in ids {
            if let Some(p) = read_page_by_id(&*read, id)?
                && p.source_id == source_id
                && p.deleted_at_us.is_none()
            {
                out.push(page_row(&p));
            }
        }
        Ok(out)
    }
}
