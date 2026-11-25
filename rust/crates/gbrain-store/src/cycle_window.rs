//! The two reads a per-source cycle's changed-page window made through raw SQL
//! (`src/core/engine-sql/cycle-window.ts`): the listing instant
//! (`readCycleListingInstant`) and one window of live pages after a cursor
//! (`listSourceChangedPagesAfter`). PGLite and Postgres run the SQL; this answers the same
//! questions from the store's page records. What each member answers:
//! rust/docs/store/cycle-window.md.
//!
//! Keys: none of its own. It reads page records.

use crate::Store;
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::pages::all_pages;
use serde::Serialize;

/// A page of a window (`SourceChangedPageRow`): `updated_at` is UTC ISO with microseconds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceChangedPageRow {
    pub slug: String,
    pub updated_at: String,
}

impl Store {
    /// The cycle's listing instant: now, as UTC ISO text with microseconds. The SQL engines move
    /// it back to just before the oldest transaction open on another connection (at most ten
    /// minutes); the store has one writer and no other connection, so nothing holds it back.
    pub fn read_cycle_listing_instant(&self) -> Result<String> {
        Ok(iso(self.env.now_micros()))
    }

    /// Up to `limit` live pages of `source_id` after the cursor `(since, slug)`, ordered by
    /// `(updated_at, slug bytes)`; every page when `since` is `None`. `since` is UTC ISO text, the
    /// shape the cursor is written in; another shape refuses.
    pub fn list_source_changed_pages_after(
        &self,
        source_id: &str,
        since: Option<&str>,
        slug: &str,
        limit: usize,
    ) -> Result<Vec<SourceChangedPageRow>> {
        let after = match since {
            Some(text) => Some(
                parse_iso(text)
                    .ok_or_else(|| StoreError::invalid("a window cursor must be UTC ISO text"))?,
            ),
            None => None,
        };
        let read = self.read()?;
        let mut rows: Vec<(i64, String)> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.deleted_at_us.is_none())
            .filter(|p| match after {
                None => true,
                Some(at) => (p.updated_at_us, p.slug.as_bytes()) > (at, slug.as_bytes()),
            })
            .map(|p| (p.updated_at_us, p.slug))
            .collect();
        rows.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then_with(|| a.1.as_bytes().cmp(b.1.as_bytes()))
        });
        rows.truncate(limit);
        Ok(rows
            .into_iter()
            .map(|(at, slug)| SourceChangedPageRow {
                slug,
                updated_at: iso(at),
            })
            .collect())
    }
}
