//! The reads of `gbrain repair slug-spelling` and its doctor check (`legacy_slug_spellings`):
//! `src/core/engine-sql/slug-spelling-repair.ts`, called from src/core/repair/slug-spelling.ts and
//! src/commands/doctor/checks/legacy-slug-spellings.ts. The store writes every slug in normal form
//! (`validate_slug`), so on a Rust brain these reads find no page to move; they answer the rows the
//! SQL would, so the doctor check says so instead of refusing.

use serde::Serialize;

use crate::Store;
use crate::error::Result;
use crate::pages::{PageRecord, all_pages};

/// The SQL prefilter `slug <> lower(slug) OR slug ~ '[^ -~]'`: an ASCII capital, or any character
/// outside printable ASCII (every non-ASCII character is caught by the second test, so how `lower`
/// treats it does not matter).
fn is_candidate(slug: &str) -> bool {
    slug.chars()
        .any(|c| c.is_ascii_uppercase() || !(' '..='~').contains(&c))
}

/// A doctor-check candidate row (`id, source_id, slug`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SpellingCandidate {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
}

fn after_in_id_order(mut pages: Vec<PageRecord>, after_id: u64, limit: usize) -> Vec<PageRecord> {
    pages.retain(|p| p.id > after_id && is_candidate(&p.slug));
    pages.sort_by_key(|p| p.id);
    pages.truncate(limit);
    pages
}

impl Store {
    /// `listSlugSpellingCandidates(afterId)`: pages of every source (deleted ones included) whose
    /// slug has an ASCII capital or a character outside printable ASCII, id above `after_id`, in id
    /// order, at most `limit` (the caller's batch, 5000).
    pub fn list_slug_spelling_candidates(
        &self,
        after_id: u64,
        limit: usize,
    ) -> Result<Vec<SpellingCandidate>> {
        let read = self.read()?;
        Ok(after_in_id_order(all_pages(&*read)?, after_id, limit)
            .into_iter()
            .map(|p| SpellingCandidate {
                id: p.id,
                source_id: p.source_id,
                slug: p.slug,
            })
            .collect())
    }
}
