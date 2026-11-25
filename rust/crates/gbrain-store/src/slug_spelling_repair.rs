//! The reads of `gbrain repair slug-spelling` and its doctor check (`legacy_slug_spellings`):
//! `src/core/engine-sql/slug-spelling-repair.ts`, called from src/core/repair/slug-spelling.ts and
//! src/commands/doctor/checks/legacy-slug-spellings.ts. The store writes every slug in normal form
//! (`validate_slug`), so on a Rust brain these reads find no page to move; they answer the rows the
//! SQL would, so the doctor check and the repair preview say so instead of refusing.

use std::collections::BTreeSet;

use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

use crate::Store;
use crate::error::Result;
use crate::link_slug_reads::source_pages;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::sources::read_source;

/// The spelling index key (`SPELLING_KEY_SQL` in src/core/slug-spelling-key.ts): U+0130 becomes `i`
/// and a combining dot, U+212A becomes `k`, ASCII capitals are lowered (no locale), then the text
/// is composed to NFC. Every other character keeps its case.
pub fn spelling_index_key(slug: &str) -> String {
    let mut lowered = String::with_capacity(slug.len());
    for c in slug.chars() {
        match c {
            '\u{130}' => lowered.push_str("i\u{307}"),
            '\u{212A}' => lowered.push('k'),
            c => lowered.push(c.to_ascii_lowercase()),
        }
    }
    lowered.nfc().collect()
}

/// The scan key (`SCAN_KEY_SQL`): the index key cut down to `a-z` and `0-9`.
pub fn spelling_scan_key(slug: &str) -> String {
    spelling_index_key(slug)
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

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

/// A preview candidate row (`id, slug, revision, source_path, deleted`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceSpellingCandidate {
    pub id: u64,
    pub slug: String,
    pub revision: String,
    pub source_path: Option<String>,
    pub deleted: bool,
}

/// A page that shares a spelling key (`id, slug`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SpellingKeyPage {
    pub id: u64,
    pub slug: String,
}

/// The source row the preview and the move read.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlugRepairSource {
    pub local_path: Option<String>,
    pub incarnation: String,
    pub slug_root_mode: Option<String>,
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

    /// `listSourceSlugSpellingCandidates(sourceId, afterId, limit)`: the same filter over one source.
    pub fn list_source_slug_spelling_candidates(
        &self,
        source_id: &str,
        after_id: u64,
        limit: usize,
    ) -> Result<Vec<SourceSpellingCandidate>> {
        let read = self.read()?;
        Ok(
            after_in_id_order(source_pages(&*read, source_id)?, after_id, limit)
                .into_iter()
                .map(|p| SourceSpellingCandidate {
                    id: p.id,
                    slug: p.slug,
                    revision: p.knowledge_revision,
                    source_path: p.source_path,
                    deleted: p.deleted_at_us.is_some(),
                })
                .collect(),
        )
    }

    /// `readSpellingKeyPages(sourceId, keys, scanKey, excludeId)`: the source's pages (deleted ones
    /// included) other than `exclude_id` whose index key is one of `keys`, or, with no `keys`, whose
    /// scan key is `scan_key`; in id order.
    pub fn read_spelling_key_pages(
        &self,
        source_id: &str,
        keys: Option<&[String]>,
        scan_key: &str,
        exclude_id: u64,
    ) -> Result<Vec<SpellingKeyPage>> {
        let read = self.read()?;
        let wanted: Option<BTreeSet<&str>> = keys.map(|k| k.iter().map(String::as_str).collect());
        let mut pages: Vec<SpellingKeyPage> = source_pages(&*read, source_id)?
            .into_iter()
            .filter(|p| p.id != exclude_id)
            .filter(|p| match &wanted {
                Some(set) => set.contains(spelling_index_key(&p.slug).as_str()),
                None => spelling_scan_key(&p.slug) == scan_key,
            })
            .map(|p| SpellingKeyPage {
                id: p.id,
                slug: p.slug,
            })
            .collect();
        pages.sort_by_key(|p| p.id);
        Ok(pages)
    }

    /// `readSlugRepairSource(sourceId)`: the source's checkout, incarnation and slug-root mode
    /// (`config.slug_root_mode` when it is the text `git-root` or `source-root`), or None.
    pub fn read_slug_repair_source(&self, source_id: &str) -> Result<Option<SlugRepairSource>> {
        let read = self.read()?;
        Ok(read_source(&*read, source_id)?.map(|s| SlugRepairSource {
            slug_root_mode: s
                .config
                .get("slug_root_mode")
                .and_then(|v| v.as_str())
                .filter(|m| *m == "git-root" || *m == "source-root")
                .map(str::to_string),
            local_path: s.local_path,
            incarnation: s.incarnation,
        }))
    }

    /// `readPageSlugInSource(pageId, sourceId)`: the slug of page `page_id` when it belongs to the
    /// source (deleted or not), or None.
    pub fn read_page_slug_in_source(
        &self,
        page_id: u64,
        source_id: &str,
    ) -> Result<Option<String>> {
        let read = self.read()?;
        Ok(read_page_by_id(&*read, page_id)?
            .filter(|p| p.source_id == source_id)
            .map(|p| p.slug))
    }

    /// `readSlugRepairPage(pageId, sourceId)`: page `page_id` of the source (deleted or not) with the
    /// preview candidate columns, or None.
    pub fn read_slug_repair_page(
        &self,
        page_id: u64,
        source_id: &str,
    ) -> Result<Option<SourceSpellingCandidate>> {
        let read = self.read()?;
        Ok(read_page_by_id(&*read, page_id)?
            .filter(|p| p.source_id == source_id)
            .map(|p| SourceSpellingCandidate {
                id: p.id,
                slug: p.slug,
                revision: p.knowledge_revision,
                source_path: p.source_path,
                deleted: p.deleted_at_us.is_some(),
            }))
    }
}
