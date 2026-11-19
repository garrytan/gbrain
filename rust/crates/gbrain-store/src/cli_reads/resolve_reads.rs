//! The entity resolver's page reads (`src/core/entities/resolve.ts`) that ran through `executeRaw`,
//! as `src/core/engine-sql/entity-reads.ts` sends them. Frontmatter values are read as PostgreSQL's
//! `->>` reads them (`cli_reads::reads::retired`).

use crate::Store;
use crate::cli_reads::pg_text::pg_lower;
use crate::cli_reads::reads::retired;
use crate::error::{Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::keyword::{TRGM_SIMILARITY_THRESHOLD, real_to_js, sql_ilike, trgm_similarity};
use crate::pages::{all_pages, read_page};
use serde::Serialize;
use std::collections::BTreeSet;

/// One `readLivePageTypes` row: a live page's slug and type.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LivePageTypeRow {
    pub slug: String,
    #[serde(rename = "type")]
    pub page_type: String,
}

/// One `readTrigramCandidates` row; `score` only on the `fuzzy` arm, as only its SQL selects one.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TrigramCandidateRow {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

impl Store {
    /// `readLiveSlugs(sourceId, slugs, { limit? })`: the slugs among `slugs` at which a live page
    /// sits in the source, retired or not, each once (`slug = ANY(...)` is a filter), in list order;
    /// `limit` stops the read at that many.
    pub fn read_live_slugs(
        &self,
        source_id: &str,
        slugs: &[String],
        limit: Option<usize>,
    ) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for slug in slugs {
            if limit.is_some_and(|n| out.len() >= n) {
                break;
            }
            if !seen.insert(slug.as_str()) {
                continue;
            }
            if let Some(page) =
                read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
            {
                out.push(page.slug);
            }
        }
        Ok(out)
    }

    /// `readLivePageTypes(sourceId, slugs, policy)`: the live pages of the source among `slugs`,
    /// retired or not, with their types, that the page policy (when given) does not hide, each
    /// once, in list order (the SQL sets none).
    pub fn read_live_page_types(
        &self,
        source_id: &str,
        slugs: &[String],
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<LivePageTypeRow>> {
        let read = self.read()?;
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for slug in slugs {
            if !seen.insert(slug.as_str()) {
                continue;
            }
            let Some(page) =
                read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
            else {
                continue;
            };
            if let Some(policy) = policy
                && page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            out.push(LivePageTypeRow {
                slug: page.slug,
                page_type: page.page_type,
            });
        }
        Ok(out)
    }

    /// `readTrigramCandidates(sourceId, { arm, titleLc, slugFragment, privacy })`: the live,
    /// non-retired pages of the source whose lowered title is trigram-similar to `title_lc`
    /// (`lower(title) % $2`, the f32 similarity widened against the f64 threshold) or whose slug
    /// contains `slug_fragment` (`slug ILIKE '%' || $3 || '%'`, wildcards kept), that the page
    /// policy (when given) does not hide; best `GREATEST` of the two real similarities first, ties
    /// by slug bytes; five rows (`same_name`, `fuzzy`) or twenty (`near`). Only `fuzzy` returns
    /// the score.
    pub fn read_trigram_candidates(
        &self,
        source_id: &str,
        arm: &str,
        title_lc: &str,
        slug_fragment: &str,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<TrigramCandidateRow>> {
        let limit = match arm {
            "same_name" | "fuzzy" => 5,
            "near" => 20,
            other => {
                return Err(StoreError::invalid(format!(
                    "readTrigramCandidates: unknown arm {other}"
                )));
            }
        };
        let read = self.read()?;
        let pattern = format!("%{slug_fragment}%");
        let mut rows: Vec<(f32, TrigramCandidateRow)> = Vec::new();
        for page in all_pages(&*read)? {
            if page.source_id != source_id
                || page.deleted_at_us.is_some()
                || retired(&page.frontmatter)
            {
                continue;
            }
            let title_sim = trgm_similarity(&pg_lower(&page.title), title_lc);
            if f64::from(title_sim) < TRGM_SIMILARITY_THRESHOLD && !sql_ilike(&page.slug, &pattern)
            {
                continue;
            }
            if let Some(policy) = policy
                && page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            let score = title_sim.max(trgm_similarity(&page.slug, slug_fragment));
            rows.push((
                score,
                TrigramCandidateRow {
                    score: (arm == "fuzzy").then(|| real_to_js(score)),
                    slug: page.slug,
                    title: page.title,
                    page_type: page.page_type,
                },
            ));
        }
        rows.sort_by(|a, b| {
            b.0.total_cmp(&a.0)
                .then_with(|| a.1.slug.as_bytes().cmp(b.1.slug.as_bytes()))
        });
        Ok(rows.into_iter().take(limit).map(|(_, row)| row).collect())
    }
}
