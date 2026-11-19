//! The rename confirmation reads of `sync-rename-identity.ts`: `readRenameStoredTitles`,
//! `readLiveIdentityHolders` and `readPageIdentity` (SQL in `src/core/engine-sql/sources.ts`).
//! Each reads one snapshot. The store never refuses a value it holds, so the SQL engines'
//! 22021/22P05 retry path never runs here.

use crate::Store;
use crate::cli_reads::pg_text::jsonb_text;
use crate::error::Result;
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::read_page_by_id;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// One row of `readRenameStoredTitles`: `RenameStoredTitle`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RenameStoredTitle {
    pub slug: String,
    pub source_path: Option<String>,
    pub title: Option<String>,
}

/// One row of `readLiveIdentityHolders`: `LiveIdentityHolder`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveIdentityHolder {
    pub slug: String,
    pub source_path: Option<String>,
    pub fm_id: Option<String>,
    pub title: Option<String>,
}

/// The row of `readPageIdentity`: `PageIdentityRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageIdentityRow {
    pub fm_id: Option<String>,
    pub title: Option<String>,
}

/// The page fields these reads use.
#[derive(Deserialize)]
struct IdentityFields {
    slug: String,
    title: String,
    #[serde(default)]
    frontmatter: Map<String, Value>,
    #[serde(default)]
    source_path: Option<String>,
    #[serde(default)]
    deleted_at_us: Option<i64>,
}

/// `frontmatter->>'id'`: a string's text, NULL for a JSON null or no key, else the jsonb text.
fn fm_id(frontmatter: &Map<String, Value>) -> Option<String> {
    match frontmatter.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(jsonb_text(other)),
    }
}

impl Store {
    /// The live pages of `source_id` in slug byte order (the SQL engines order by `slug COLLATE "C"`).
    fn live_identity_pages(&self, source_id: &str) -> Result<Vec<IdentityFields>> {
        if source_id.contains('\0') {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let mut rows = Vec::new();
        let mut failure = None;
        scan_prefix(
            &*read as &dyn KvRead,
            &keys::text(keys::PAGE, &[source_id, ""]),
            false,
            &mut |_, v| match serde_json::from_slice::<IdentityFields>(v) {
                Ok(page) => {
                    if page.deleted_at_us.is_none() {
                        rows.push(page);
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
        rows.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(rows)
    }

    /// `readRenameStoredTitles(sourceId, paths, slugs)`: the live pages of the source whose
    /// source path is in `paths` or whose slug is in `slugs`, in slug byte order.
    pub fn read_rename_stored_titles(
        &self,
        source_id: &str,
        paths: &[String],
        slugs: &[String],
    ) -> Result<Vec<RenameStoredTitle>> {
        let paths: BTreeSet<&str> = paths.iter().map(String::as_str).collect();
        let slugs: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        Ok(self
            .live_identity_pages(source_id)?
            .into_iter()
            .filter(|page| {
                slugs.contains(page.slug.as_str())
                    || page
                        .source_path
                        .as_deref()
                        .is_some_and(|path| paths.contains(path))
            })
            .map(|page| RenameStoredTitle {
                slug: page.slug,
                source_path: page.source_path,
                title: Some(page.title),
            })
            .collect())
    }

    /// `readLiveIdentityHolders(sourceId, ids, titles)`: the live pages of the source whose
    /// frontmatter `id` (as `->>` text) is in `ids` or whose title is in `titles`, in slug byte
    /// order.
    pub fn read_live_identity_holders(
        &self,
        source_id: &str,
        ids: &[String],
        titles: &[String],
    ) -> Result<Vec<LiveIdentityHolder>> {
        let ids: BTreeSet<&str> = ids.iter().map(String::as_str).collect();
        let titles: BTreeSet<&str> = titles.iter().map(String::as_str).collect();
        Ok(self
            .live_identity_pages(source_id)?
            .into_iter()
            .filter_map(|page| {
                let fm_id = fm_id(&page.frontmatter);
                let held = titles.contains(page.title.as_str())
                    || fm_id.as_deref().is_some_and(|id| ids.contains(id));
                held.then_some(LiveIdentityHolder {
                    slug: page.slug,
                    source_path: page.source_path,
                    fm_id,
                    title: Some(page.title),
                })
            })
            .collect())
    }

    /// `readPageIdentity(pageId)`: the frontmatter `id` and title of a live page; `None` for a
    /// missing or soft-deleted page.
    pub fn read_page_identity(&self, page_id: u64) -> Result<Option<PageIdentityRow>> {
        let read = self.read()?;
        Ok(read_page_by_id(&*read, page_id)?
            .filter(|page| page.deleted_at_us.is_none())
            .map(|page| PageIdentityRow {
                fm_id: fm_id(&page.frontmatter),
                title: Some(page.title),
            }))
    }
}
