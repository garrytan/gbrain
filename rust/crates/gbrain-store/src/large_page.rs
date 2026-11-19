//! The large-page write guard's read: the stored body size of a live page, which a remote put_page
//! measures before it is queued (the TypeScript `engine-sql/large-page.ts`).
//!
//! Members: readStoredBodyBytes and listPageSizeRows (the sync receipt's size-state read).
//!
//! readStoredBodyBytes: a segmented page (both body columns NULL) answers its body state's
//! `body_bytes`; an inline page answers the UTF-8 bytes of `compiled_truth` plus `timeline` (a NULL
//! timeline counts 0), as PGLite's `octet_length(compiled_truth) + COALESCE(octet_length(timeline), 0)`.
//! A missing or soft-deleted page answers `None`.
//!
//! listPageSizeRows: the live pages of a source (all, or only the given slugs) with an `embed_skip`
//! frontmatter key, a body over the inline limit or segmented storage, in slug byte order (the SQL
//! engines order by `slug COLLATE "C"`). The store keeps no embedding budget rows, so `state` and
//! `reason` are always null and a budget row never selects a page.
//!
//! Keys: this family adds none. It reads page records through `pages.rs` and body state through
//! `page_body.rs`.

use crate::kv::{KvRead, scan_prefix};
use crate::page_body::segmented_reference;
use crate::pages::{PageRecord, read_page};
use crate::{Result, Store, keys};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

/// One row of `listPageSizeRows`: `PageSizeRow` of `src/core/engine-sql/large-page.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageSizeRow {
    pub slug: String,
    pub bytes: Option<i64>,
    pub segmented: bool,
    pub frontmatter: Value,
    pub state: Option<String>,
    pub reason: Option<String>,
}

/// The stored body size of `page`: a segmented page's `body_bytes`, else the UTF-8 bytes of
/// `compiled_truth` plus `timeline` (NULL when `compiled_truth` is NULL), and whether it is segmented.
fn body_size(read: &dyn KvRead, page: &PageRecord) -> Result<(Option<i64>, bool)> {
    if let Some((_, bytes)) = segmented_reference(read, page.id)? {
        return Ok((bytes, true));
    }
    let timeline = page.timeline.as_deref().map_or(0, str::len);
    Ok((
        page.compiled_truth
            .as_deref()
            .map(|truth| i64::try_from(truth.len() + timeline).unwrap_or(i64::MAX)),
        false,
    ))
}

impl Store {
    /// `readStoredBodyBytes(slug, sourceId)`: the stored body size of the live page, or `None`.
    pub fn read_stored_body_bytes(&self, slug: &str, source_id: &str) -> Result<Option<i64>> {
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(None);
        };
        if page.compiled_truth.is_null() && page.timeline.is_null() {
            return Ok(segmented_reference(&*read, page.id)?.and_then(|(_, bytes)| bytes));
        }
        let timeline = page.timeline.as_deref().map_or(0, str::len);
        Ok(page
            .compiled_truth
            .as_deref()
            .map(|truth| i64::try_from(truth.len() + timeline).unwrap_or(i64::MAX)))
    }

    /// `listPageSizeRows(sourceId, inlineMaxBytes, slugs)`: the source's live pages that can have a
    /// size state, in slug byte order. `slugs` `None` reads every page; an empty list reads none.
    pub fn list_page_size_rows(
        &self,
        source_id: &str,
        inline_max_bytes: i64,
        slugs: Option<Vec<String>>,
    ) -> Result<Vec<PageSizeRow>> {
        if source_id.contains('\0') || slugs.as_ref().is_some_and(Vec::is_empty) {
            return Ok(Vec::new());
        }
        let only: Option<HashSet<String>> = slugs.map(|s| s.into_iter().collect());
        let read = self.read()?;
        let mut pages = Vec::new();
        let mut failure = None;
        scan_prefix(
            &*read,
            &keys::text(keys::PAGE, &[source_id, ""]),
            false,
            &mut |_, v| match serde_json::from_slice::<PageRecord>(v) {
                Ok(page) => {
                    if page.deleted_at_us.is_none()
                        && only.as_ref().is_none_or(|set| set.contains(&page.slug))
                    {
                        pages.push(page);
                    }
                    true
                }
                Err(e) => {
                    failure = Some(e.into());
                    false
                }
            },
        )?;
        if let Some(e) = failure {
            return Err(e);
        }
        let mut rows = Vec::new();
        for page in pages {
            let (bytes, segmented) = body_size(&*read, &page)?;
            let skip = page.frontmatter.contains_key("embed_skip");
            if skip || segmented || bytes.is_some_and(|b| b > inline_max_bytes) {
                rows.push(PageSizeRow {
                    slug: page.slug,
                    bytes,
                    segmented,
                    frontmatter: Value::Object(page.frontmatter),
                    state: None,
                    reason: None,
                });
            }
        }
        rows.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(rows)
    }
}
