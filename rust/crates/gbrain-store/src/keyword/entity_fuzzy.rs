//! `findFuzzyEntityCandidates(sourceId, title, fragment)`: the fuzzy entity lookup of
//! `entities/resolve.ts` (`tryFuzzyMatch`), as `engine-sql/entity-reads.ts` selects it:
//!
//! ```sql
//! SELECT slug, title, type,
//!        GREATEST(similarity(lower(title), $2), similarity(slug, $3)) AS score
//! FROM pages
//! WHERE source_id = $1 AND deleted_at IS NULL AND NOT <retiredPageSql>
//!   AND (lower(title) % $2 OR slug ILIKE '%' || $3 || '%')
//! ORDER BY score DESC, slug ASC LIMIT 5
//! ```
//!
//! `similarity` is a `real`, so `GREATEST` of two is the f32 maximum and `%` compares the f32
//! score with the f64 threshold 0.3 (`keyword/trgm.rs`). `ILIKE` lowers both sides and then
//! matches as `LIKE`. Equal scores sort by slug bytes, as PGLite's C collation sorts them.

use super::title_fuzzy::{real_to_js, sql_like};
use super::trgm::{TRGM_SIMILARITY_THRESHOLD, trgm_similarity};
use crate::Store;
use crate::cli_reads::entities::is_retired;
use crate::cli_reads::pg_text::pg_lower;
use crate::error::Result;
use crate::pages::all_pages;
use serde::Serialize;

/// The statement's `LIMIT`.
const CANDIDATE_LIMIT: usize = 5;

/// One candidate row: `score` is the `real` as JavaScript reads it from PGLite.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FuzzyEntityCandidate {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub score: f64,
}

/// `slug ILIKE '%' || fragment || '%'`.
fn slug_contains(slug: &str, fragment: &str) -> bool {
    sql_like(&pg_lower(slug), &pg_lower(&format!("%{fragment}%")))
}

impl Store {
    /// `findFuzzyEntityCandidates(sourceId, title, fragment)`: up to five live, unretired pages of
    /// the source whose lowercased title is trigram-similar to `title` or whose slug contains
    /// `fragment`, best score first, then by slug.
    pub fn find_fuzzy_entity_candidates(
        &self,
        source_id: &str,
        title: &str,
        fragment: &str,
    ) -> Result<Vec<FuzzyEntityCandidate>> {
        let read = self.read()?;
        let mut rows: Vec<(f32, FuzzyEntityCandidate)> = Vec::new();
        for page in all_pages(&*read)? {
            if page.source_id != source_id || page.deleted_at_us.is_some() || is_retired(&page) {
                continue;
            }
            let by_title = trgm_similarity(&pg_lower(&page.title), title);
            if f64::from(by_title) < TRGM_SIMILARITY_THRESHOLD
                && !slug_contains(&page.slug, fragment)
            {
                continue;
            }
            let score = by_title.max(trgm_similarity(&page.slug, fragment));
            rows.push((
                score,
                FuzzyEntityCandidate {
                    slug: page.slug,
                    title: page.title,
                    page_type: page.page_type,
                    score: real_to_js(score),
                },
            ));
        }
        rows.sort_by(|(a, ra), (b, rb)| {
            b.total_cmp(a)
                .then_with(|| ra.slug.as_bytes().cmp(rb.slug.as_bytes()))
        });
        rows.truncate(CANDIDATE_LIMIT);
        Ok(rows.into_iter().map(|(_, row)| row).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::slug_contains;

    #[test]
    fn slug_contains_is_ilike_with_like_wildcards() {
        assert!(slug_contains("people/alice-example", "alice"));
        assert!(slug_contains("People/Alice", "alice"));
        assert!(slug_contains("people/alice", ""));
        assert!(slug_contains("people/alxce", "al_ce"));
        assert!(!slug_contains("people/bob", "alice"));
    }
}
