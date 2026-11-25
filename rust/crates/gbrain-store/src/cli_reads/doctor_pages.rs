//! Doctor page reads: the typed members that replace the page-table raw SQL of `gbrain doctor` checks
//! (SQL in `src/core/engine-sql/doctor-pages.ts`, docs in `rust/docs/store/cli-reads-doctor-pages.md`).
//! Each read takes one snapshot and has no keys of its own; it reads page records, the segmented-body
//! state (`page_body.rs`), raw data and evidence keys, link records and source records.
//!
//! Text rules (rust/docs/store/cli-reads-ops.md, "Text semantics"): `octet_length` is bytes, `left` and
//! `length` are characters, a key test (`?`) is key presence even for a JSON null, `->>` is `fm_text`,
//! and every order is bytewise, as PGLite's C.UTF-8 collation orders.

use super::pg_text::{fm_text, jsonb_value};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::page_body::{segmented_reference, truth_lead};
use crate::pages::{PageRecord, all_pages};
use crate::sources::read_source;
use crate::{env, keys};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// `EMBED_SKIP_KEY` of `src/core/embed-skip.ts`.
const EMBED_SKIP_KEY: &str = "embed_skip";
/// `BOUNDED_PREFIX_BYTES` of `src/core/page-window/document.ts`: the characters `boundedBodyPrefixSql` keeps.
const BOUNDED_PREFIX_CHARS: usize = 64 * 1024;
/// Rows the oversized-page list reads (`OVERSIZED_LIST_LIMIT` + 1).
const OVERSIZED_ROWS: usize = 101;
/// Rows the content-hash duplicate list reads.
const DUPLICATE_GROUP_ROWS: usize = 51;
/// Rows the slug-path scan reads (`SLUG_PATH_SCAN_LIMIT` + 1 of the check).
const SLUG_PATH_ROWS: usize = 20_001;
/// Link source of a `[[mention]]` edge.
const MENTIONS: &str = "mentions";

fn live_pages(read: &dyn KvRead) -> Result<Vec<PageRecord>> {
    Ok(all_pages(read)?
        .into_iter()
        .filter(|p| p.deleted_at_us.is_none())
        .collect())
}

/// `left(text, n)`: the first `n` characters.
fn left(text: &str, n: usize) -> String {
    text.chars().take(n).collect()
}

/// Does any key sit under `prefix`?
fn any_under(read: &dyn KvRead, prefix: &[u8]) -> Result<bool> {
    let mut found = false;
    scan_prefix(read, prefix, false, &mut |_, _| {
        found = true;
        false
    })?;
    Ok(found)
}

fn page_prefix(family: &[u8], page_id: u64) -> Vec<u8> {
    let mut key = family.to_vec();
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// `raw_data` rows of a page (`raw_files.rs` keeps them under `r 0x01 <page id>`).
fn has_raw_data(read: &dyn KvRead, page_id: u64) -> Result<bool> {
    any_under(read, &page_prefix(&[keys::RAW_FILES, 0x01], page_id))
}

/// `synthesis_evidence` rows of a synthesis page (`takes.rs` keeps them under `T 0x03 <synthesis page id>`).
fn has_synthesis_evidence(read: &dyn KvRead, page_id: u64) -> Result<bool> {
    any_under(read, &page_prefix(&[keys::TAKE, 0x03], page_id))
}

/// `pages.body_storage = 'segmented'` and `pages.body_bytes`.
fn segmented_body_bytes(read: &dyn KvRead, page_id: u64) -> Result<Option<Option<i64>>> {
    Ok(segmented_reference(read, page_id)?.map(|(_, bytes)| bytes))
}

/// `LEFT(COALESCE(timeline, ''), n)` of a page.
fn timeline_head(page: &PageRecord, n: usize) -> String {
    left(page.timeline.as_deref().unwrap_or(""), n)
}

/// `p.slug ~ '[^a-z0-9/._-]|--|-/|/-|^-|-$|//'` (`CANDIDATE_PATTERN` of the slug_path_mismatch check).
fn slug_pattern_matches(slug: &str) -> bool {
    slug.chars()
        .any(|c| !(c.is_ascii_lowercase() || c.is_ascii_digit() || "/._-".contains(c)))
        || ["--", "-/", "/-", "//"]
            .iter()
            .any(|bad| slug.contains(bad))
        || slug.starts_with('-')
        || slug.ends_with('-')
}

/// `[[:cntrl:]]` as PGLite and the test Postgres evaluate it (probed over every non-surrogate code point below
/// U+30D40): C0 (U+1..U+1F), DEL and C1 (U+7F..U+9F). The line and paragraph separators are not control characters
/// there. A server built on a different libc locale may widen the class; the doc names the probe.
fn is_pg_cntrl(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// The repository's `UNVERIFIED` extraction stub: `provenance` is `auto-extracted` and `status` is `unverified`.
fn unverified_extraction(page: &PageRecord) -> bool {
    fm_text(&page.frontmatter, "provenance").as_deref() == Some("auto-extracted")
        && fm_text(&page.frontmatter, "status").as_deref() == Some("unverified")
}

/// The `rawProvenanceCheck` predicate (every term of its `where`).
fn lacks_raw_provenance(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    let fm = &page.frontmatter;
    let synthesized =
        fm_text(fm, "dream_generated").as_deref() == Some("true") || page.page_type == "synthesis";
    if page.deleted_at_us.is_some() || !synthesized {
        return Ok(false);
    }
    if ["raw_trace", "raw_source", "source_uri"]
        .iter()
        .any(|k| fm.contains_key(*k))
    {
        return Ok(false);
    }
    if fm_text(fm, "raw_trace_exempt").as_deref() == Some("true") {
        return Ok(false);
    }
    let extracted_atom = page.page_type == "atom"
        && fm_text(fm, "extracted_by").is_some_and(|by| by.starts_with("extract_atoms"))
        && ["source_slug", "source_path"]
            .iter()
            .any(|k| fm.contains_key(*k));
    if extracted_atom {
        return Ok(false);
    }
    Ok(!has_raw_data(read, page.id)? && !has_synthesis_evidence(read, page.id)?)
}

impl Store {
    /// `listOversizedPages(minBytes)`: live pages without an `embed_skip` marker whose body and timeline together are
    /// more than `min_bytes` bytes, largest first, at most 101. A segmented page's body columns are NULL, so it is
    /// passed by. Rows: `{slug, source_id, bytes}`.
    pub fn list_oversized_pages(&self, min_bytes: i64) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows: Vec<(i64, String, String)> = Vec::new();
        for page in live_pages(&*read)? {
            let Some(truth) = page.compiled_truth.as_deref() else {
                continue;
            };
            if page.frontmatter.contains_key(EMBED_SKIP_KEY) {
                continue;
            }
            let bytes = (truth.len() + page.timeline.as_deref().map_or(0, str::len)) as i64;
            if bytes > min_bytes {
                rows.push((bytes, page.slug, page.source_id));
            }
        }
        rows.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| a.2.cmp(&b.2))
        });
        rows.truncate(OVERSIZED_ROWS);
        Ok(rows
            .into_iter()
            .map(|(bytes, slug, source_id)| json!({ "slug": slug, "source_id": source_id, "bytes": bytes }))
            .collect())
    }

    /// `listScraperJunkCandidates(limit)`: live pages, most recently updated first (`limit` of them; `None` is every
    /// page, in id order), with the title, the first 2048 characters of the body (NULL for a segmented page), the first
    /// 1024 of the timeline and the frontmatter.
    pub fn list_scraper_junk_candidates(&self, limit: Option<i64>) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages = live_pages(&*read)?;
        if let Some(limit) = limit {
            pages.sort_by(|a, b| {
                b.updated_at_us
                    .cmp(&a.updated_at_us)
                    .then_with(|| b.id.cmp(&a.id))
            });
            pages.truncate(
                usize::try_from(limit)
                    .map_err(|_| StoreError::invalid("limit must not be negative"))?,
            );
        } else {
            pages.sort_by_key(|p| p.id);
        }
        Ok(pages
            .into_iter()
            .map(|p| {
                json!({
                    "slug": p.slug,
                    "source_id": p.source_id,
                    "title": p.title,
                    "body_head": p.compiled_truth.as_deref().map(|t| left(t, 2048)),
                    "tl_head": timeline_head(&p, 1024),
                    "frontmatter": jsonb_value(&Value::Object(p.frontmatter.clone())),
                })
            })
            .collect())
    }

    /// `countMarkedPages(marker)`: live pages whose frontmatter has the key `marker` (`quarantine` or `content_flag`).
    pub fn count_marked_pages(&self, marker: &str) -> Result<u64> {
        if marker != "quarantine" && marker != "content_flag" {
            return Err(StoreError::invalid(format!(
                "countMarkedPages: '{marker}' is not a page marker"
            )));
        }
        let read = self.read()?;
        Ok(live_pages(&*read)?
            .iter()
            .filter(|p| p.frontmatter.contains_key(marker))
            .count() as u64)
    }

    /// `countOversizedCorePages(maxBytes)`: live `always_load: true` pages stored in segments with more than
    /// `max_bytes` body bytes.
    pub fn count_oversized_core_pages(&self, max_bytes: i64) -> Result<u64> {
        let read = self.read()?;
        let mut n = 0;
        for page in live_pages(&*read)? {
            if page.frontmatter.get("always_load") != Some(&Value::Bool(true)) {
                continue;
            }
            if let Some(Some(bytes)) = segmented_body_bytes(&*read, page.id)?
                && bytes > max_bytes
            {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `readRawProvenanceGaps()`: the count of synthesized pages with no raw trace, raw data or evidence and no
    /// exemption, and (when there are some) the first five slugs. Rows: `{count, slugs}`.
    pub fn read_raw_provenance_gaps(&self) -> Result<Value> {
        let read = self.read()?;
        let mut slugs = Vec::new();
        for page in all_pages(&*read)? {
            if lacks_raw_provenance(&*read, &page)? {
                slugs.push(page.slug);
            }
        }
        let count = slugs.len();
        slugs.sort();
        slugs.truncate(5);
        Ok(json!({ "count": count, "slugs": slugs }))
    }

    /// `countUnverifiedExtractions(days, sourceId)`: live unverified auto-extracted pages created more than `days` days
    /// ago (in `source_id` when given).
    pub fn count_unverified_extractions(&self, days: f64, source_id: Option<&str>) -> Result<u64> {
        let cutoff = self.env.now_micros() - (days * 86_400_000_000.0).round() as i64;
        let read = self.read()?;
        Ok(live_pages(&*read)?
            .iter()
            .filter(|p| {
                unverified_extraction(p)
                    && p.created_at_us < cutoff
                    && source_id.is_none_or(|s| p.source_id == s)
            })
            .count() as u64)
    }

    /// `listContentHashDuplicates()`: live pages that share a non-empty `content_hash` within a source, one row per
    /// group (`source_id`, `content_hash`, `slugs` joined by `|`, shortest first), at most 51 groups.
    pub fn list_content_hash_duplicates(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut groups: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
        for page in live_pages(&*read)? {
            if let Some(hash) = page.content_hash.filter(|h| !h.is_empty()) {
                groups
                    .entry((page.source_id, hash))
                    .or_default()
                    .push(page.slug);
            }
        }
        Ok(groups
            .into_iter()
            .filter(|(_, slugs)| slugs.len() > 1)
            .take(DUPLICATE_GROUP_ROWS)
            .map(|((source_id, content_hash), mut slugs)| {
                slugs.sort_by(|a, b| a.chars().count().cmp(&b.chars().count()).then_with(|| a.cmp(b)));
                json!({ "source_id": source_id, "content_hash": content_hash, "slugs": slugs.join("|") })
            })
            .collect())
    }

    /// `countTranscriptImportPages()`: live conversation pages whose frontmatter has `transcript_import`.
    pub fn count_transcript_import_pages(&self) -> Result<u64> {
        let read = self.read()?;
        Ok(live_pages(&*read)?
            .iter()
            .filter(|p| {
                p.page_type == "conversation" && p.frontmatter.contains_key("transcript_import")
            })
            .count() as u64)
    }

    /// `countPageRows()`: every page row, soft-deleted pages included.
    pub fn count_page_rows(&self) -> Result<u64> {
        let read = self.read()?;
        Ok(all_pages(&*read)?.len() as u64)
    }

    /// `countPagesBySlugPrefix(prefix)`: page rows (soft-deleted included) whose slug starts with `prefix`, the prefix
    /// taken literally.
    pub fn count_pages_by_slug_prefix(&self, prefix: &str) -> Result<u64> {
        let read = self.read()?;
        Ok(all_pages(&*read)?
            .iter()
            .filter(|p| p.slug.starts_with(prefix))
            .count() as u64)
    }

    /// `countLivePages()`: live page rows.
    pub fn count_live_pages(&self) -> Result<u64> {
        let read = self.read()?;
        Ok(live_pages(&*read)?.len() as u64)
    }

    /// `readOldestPageCreatedAt()`: the earliest `created_at` of any page row (soft-deleted included) as an ISO string,
    /// or null for a brain with no page.
    pub fn read_oldest_page_created_at(&self) -> Result<Option<String>> {
        let read = self.read()?;
        Ok(all_pages(&*read)?
            .iter()
            .map(|p| p.created_at_us)
            .min()
            .map(env::iso))
    }

    /// `countPageTrustTiers()`: page rows per stored `trust_tier` (a page the store never stamped is `unknown`).
    /// Rows: `{tier, n}`.
    pub fn count_page_trust_tiers(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut per_tier: BTreeMap<String, u64> = BTreeMap::new();
        for page in all_pages(&*read)? {
            *per_tier
                .entry(page.trust_tier.unwrap_or_else(|| "unknown".to_owned()))
                .or_default() += 1;
        }
        Ok(per_tier
            .into_iter()
            .map(|(tier, n)| json!({ "tier": tier, "n": n }))
            .collect())
    }

    /// `countPagesWithMentionLinks()`: live pages that have at least one outgoing `mentions` link.
    pub fn count_pages_with_mention_links(&self) -> Result<u64> {
        let read = self.read()?;
        let mut n = 0;
        for page in live_pages(&*read)? {
            if crate::links::out_links(&*read, page.id)?
                .iter()
                .any(|l| l.link_source.as_deref() == Some(MENTIONS))
            {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `readImagePageCoverage()`: live image pages, those with no image vector (the store keeps none, so all of them)
    /// and those with no recorded `source_path`. Rows: `{image_pages, without_image_vector, null_source_path}`.
    pub fn read_image_page_coverage(&self) -> Result<Value> {
        let read = self.read()?;
        let images: Vec<PageRecord> = live_pages(&*read)?
            .into_iter()
            .filter(|p| p.page_kind == "image")
            .collect();
        let null_source_path = images.iter().filter(|p| p.source_path.is_none()).count();
        Ok(json!({
            "image_pages": images.len(),
            "without_image_vector": images.len(),
            "null_source_path": null_source_path,
        }))
    }

    /// `listFactsPageBodies()`: live `facts` pages in (source, slug) order with `segmented` and the first 65536
    /// characters of `coalesce(compiled_truth, truth_lead)`. Rows: `{slug, source_id, segmented, body}`.
    pub fn list_facts_page_bodies(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = live_pages(&*read)?
            .into_iter()
            .filter(|p| p.page_type == "facts")
            .collect();
        pages.sort_by(|a, b| {
            a.source_id
                .cmp(&b.source_id)
                .then_with(|| a.slug.cmp(&b.slug))
        });
        let mut rows = Vec::new();
        for page in pages {
            let segmented = segmented_reference(&*read, page.id)?.is_some();
            let body = match page.compiled_truth.as_deref() {
                Some(text) => Some(text.to_owned()),
                None => truth_lead(&*read, page.id)?,
            };
            rows.push(json!({
                "slug": page.slug,
                "source_id": page.source_id,
                "segmented": segmented,
                "body": body.map(|b| left(&b, BOUNDED_PREFIX_CHARS)),
            }));
        }
        Ok(rows)
    }

    /// `listBracketPathPages()`: live pages whose `source_path` has a `[` or `]` or a control character. Rows:
    /// `{slug, source_id, source_path}`, in id order.
    pub fn list_bracket_path_pages(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages = live_pages(&*read)?;
        pages.sort_by_key(|p| p.id);
        Ok(pages
            .into_iter()
            .filter_map(|p| {
                let path = p.source_path.as_deref()?;
                (path.contains('[') || path.contains(']') || path.chars().any(is_pg_cntrl)).then(
                    || json!({ "slug": p.slug, "source_id": p.source_id, "source_path": path }),
                )
            })
            .collect())
    }

    /// `listSlugPathCandidates(sourceIds)`: live pages of an unarchived source with a non-blank `source_path` whose slug
    /// has a character outside `[a-z0-9/._-]`, a doubled dash or slash, a dash next to a slash, or a leading or
    /// trailing dash, in id order, at most 20001 (`sourceIds` limits them to those sources). Rows: `{source_id, slug,
    /// source_path}`.
    pub fn list_slug_path_candidates(&self, source_ids: Option<Vec<String>>) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages = live_pages(&*read)?;
        pages.sort_by_key(|p| p.id);
        let mut rows = Vec::new();
        for page in pages {
            let Some(path) = page.source_path.as_deref() else {
                continue;
            };
            // NULLIF(btrim(source_path), '') IS NOT NULL
            if path.trim_matches(' ').is_empty() || !slug_pattern_matches(&page.slug) {
                continue;
            }
            if source_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&page.source_id))
            {
                continue;
            }
            // JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE
            if !read_source(&*read, &page.source_id)?.is_some_and(|s| !s.archived) {
                continue;
            }
            rows.push(
                json!({ "source_id": page.source_id, "slug": page.slug, "source_path": path }),
            );
            if rows.len() == SLUG_PATH_ROWS {
                break;
            }
        }
        Ok(rows)
    }
}
