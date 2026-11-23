//! The page reads `recordIdentityDowngrades` made through raw SQL
//! (`src/core/engine-sql/identity-downgrades.ts`): the soft-deleted page a renamed file
//! once backed (`readSoftDeletedPageAtOrigin`), the live pages at the new file's path
//! (`listLivePagesAtOrigin`) and what a carry would move (`countPageCarryRows`).
//! PGLite and Postgres run the SQL; this answers the same questions from the store's records.
//! What each member answers: rust/docs/store/identity-downgrades.md.
//!
//! Keys: none of its own. It reads page, fact, link and alias records.

use crate::Store;
use crate::aliases::page_alias_rows;
use crate::cli_reads::pg_text::timestamptz_text;
use crate::error::Result;
use crate::facts::entity_rows;
use crate::links::{in_links, out_links};
use crate::pages::all_pages;
use serde::Serialize;
use std::collections::BTreeSet;

/// A soft-deleted page (`SoftDeletedPageRow`): `deleted_at` is `timestamptz::text`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SoftDeletedPageRow {
    pub id: u64,
    pub slug: String,
    pub deleted_at: String,
}

/// A live page at a file path (`LivePageAtOriginRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LivePageAtOriginRow {
    pub id: u64,
    pub slug: String,
}

/// What a carry moves off a page (`PageCarryCounts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageCarryCounts {
    pub facts: u64,
    pub links: u64,
    pub aliases: u64,
}

impl Store {
    /// The soft-deleted page of `source_id` whose `source_path` is `path`, or that has no path and
    /// the slug `slug`: the latest deletion first, the lowest page id among equal deletions.
    pub fn read_soft_deleted_page_at_origin(
        &self,
        source_id: &str,
        path: &str,
        slug: &str,
    ) -> Result<Option<SoftDeletedPageRow>> {
        let read = self.read()?;
        let mut found: Vec<(i64, u64, String)> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id)
            .filter_map(|p| {
                let deleted = p.deleted_at_us?;
                let backed = match &p.source_path {
                    Some(origin) => origin == path,
                    None => p.slug == slug,
                };
                backed.then_some((deleted, p.id, p.slug))
            })
            .collect();
        found.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        Ok(found
            .into_iter()
            .next()
            .map(|(deleted, id, slug)| SoftDeletedPageRow {
                id,
                slug,
                deleted_at: timestamptz_text(deleted),
            }))
    }

    /// The live pages of `source_id` whose `source_path` is `source_path`, by slug bytes.
    pub fn list_live_pages_at_origin(
        &self,
        source_id: &str,
        source_path: &str,
    ) -> Result<Vec<LivePageAtOriginRow>> {
        let read = self.read()?;
        let mut rows: Vec<LivePageAtOriginRow> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.source_id == source_id
                    && p.deleted_at_us.is_none()
                    && p.source_path.as_deref() == Some(source_path)
            })
            .map(|p| LivePageAtOriginRow {
                id: p.id,
                slug: p.slug,
            })
            .collect();
        rows.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(rows)
    }

    /// The facts about `slug` in `source_id`, the links that leave or arrive at page `page_id`
    /// (a link from a page to itself counts once) and the aliases of `slug`, as the three counts
    /// the downgrade record keeps.
    pub fn count_page_carry_rows(
        &self,
        source_id: &str,
        slug: &str,
        page_id: u64,
    ) -> Result<PageCarryCounts> {
        let read = self.read()?;
        let facts = entity_rows(&*read, source_id, slug)?.len() as u64;
        let links: BTreeSet<u64> = out_links(&*read, page_id)?
            .into_iter()
            .chain(in_links(&*read, page_id)?)
            .map(|l| l.id)
            .collect();
        let aliases = page_alias_rows(&*read, source_id, slug)?.len() as u64;
        Ok(PageCarryCounts {
            facts,
            links: links.len() as u64,
            aliases,
        })
    }
}
