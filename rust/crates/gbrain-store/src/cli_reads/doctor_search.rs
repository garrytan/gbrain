//! Doctor search-and-knowledge reads: the typed members that replace the raw SQL of the `gbrain doctor` checks
//! dangling_aliases, type_proliferation, person_title_duplicates, markdown_body_completeness,
//! link_resolution_opportunity, hidden_by_search_policy, image_embedding_coverage, text_projection_readiness and
//! extract_atoms_backlog (SQL in `src/core/engine-sql/doctor-search.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-search.md`). Each read takes one snapshot and has no keys of its own.
//!
//! Text rules (rust/docs/store/cli-reads-ops.md, "Text semantics"): `length` is characters, `octet_length` bytes,
//! a key test (`?`) is key presence even for a JSON null, `->>` is `fm_text`, and every order is bytewise, as
//! PGLite's C.UTF-8 collation orders.

use super::pg_text::fm_text;
use crate::Store;
use crate::aliases::alias_row_targets;
use crate::chunks::read_chunks;
use crate::error::Result;
use crate::facts::like;
use crate::get_json;
use crate::kv::KvRead;
use crate::link_queries::retrieval_coverage::served;
use crate::page_body::segmented_reference;
use crate::pages::{PageRecord, all_pages, read_page};
use crate::persistence::{HousekeepingRow, turn_key};
use crate::raw_files::raw_rows_of;
use crate::sources::{all_sources, read_source};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

fn live_pages(read: &dyn KvRead) -> Result<Vec<PageRecord>> {
    Ok(all_pages(read)?
        .into_iter()
        .filter(|p| p.deleted_at_us.is_none())
        .collect())
}

/// Rows `list_truncated_markdown_bodies` reads (`TRUNCATED_BODY_ROWS`).
const TRUNCATED_BODY_ROWS: usize = 101;
/// Pages the recent-body sample reads (`RECENT_PAGE_SAMPLE`).
const RECENT_PAGE_SAMPLE: usize = 1000;
/// The `op` of the per-source hold summary (`GIT_HOLD_SUMMARY_OP`, `src/core/engine-sql/persistence-journal.ts`).
const GIT_HOLD_SUMMARY_OP: &str = "sync-hold-summary";

/// `length(raw_data.data ->> 'content')` when the row has a `content` key holding a text over 1000 characters with an
/// H2/H3 heading: `rd.data ? 'content' AND length(..) > 1000 AND (..) ~ '(^|\n)##+ '`.
fn long_content_with_headings(data: &Value) -> Option<(String, usize)> {
    let content = fm_text(data.as_object()?, "content")?;
    let chars = content.chars().count();
    (chars > 1000 && has_heading(&content)).then_some((content, chars))
}

/// `text ~ '(^|\n)##+ '`: a line that starts with two or more `#` and then a space.
fn has_heading(text: &str) -> bool {
    text.split('\n').any(|line| {
        let hashes = line.bytes().take_while(|b| *b == b'#').count();
        hashes >= 2 && line.as_bytes().get(hashes) == Some(&b' ')
    })
}

/// The live pages in id order, newest first, within `source_ids` when given.
fn recent_pages(read: &dyn KvRead, source_ids: &Option<Vec<String>>) -> Result<Vec<PageRecord>> {
    let mut pages: Vec<PageRecord> = live_pages(read)?
        .into_iter()
        .filter(|p| {
            source_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&p.source_id))
        })
        .collect();
    pages.sort_by_key(|p| std::cmp::Reverse(p.id));
    pages.truncate(RECENT_PAGE_SAMPLE);
    Ok(pages)
}

impl Store {
    /// `listOrphanedAliasCounts()`: per source, the `slug_aliases` rows whose canonical page row is absent and the
    /// `page_aliases` rows whose page row is absent, in source order (a source with none is not listed). Rows:
    /// `{source_id, slug_redirects, page_aliases}`.
    pub fn list_orphaned_alias_counts(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let (slug_aliases, page_aliases) = alias_row_targets(&*read)?;
        let mut per_source: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        for (source, slug) in slug_aliases {
            if read_page(&*read, &source, &slug)?.is_none() {
                per_source.entry(source).or_default().0 += 1;
            }
        }
        for (source, slug) in page_aliases {
            if read_page(&*read, &source, &slug)?.is_none() {
                per_source.entry(source).or_default().1 += 1;
            }
        }
        Ok(per_source
            .into_iter()
            .map(|(source_id, (slug_redirects, page_aliases))| {
                json!({ "source_id": source_id, "slug_redirects": slug_redirects, "page_aliases": page_aliases })
            })
            .collect())
    }

    /// `readSoftDeletedAliasCounts()`: the alias rows (each table) whose page row is soft-deleted. Row:
    /// `{slug_redirects, page_aliases}`.
    pub fn read_soft_deleted_alias_counts(&self) -> Result<Value> {
        let read = self.read()?;
        let (slug_aliases, page_aliases) = alias_row_targets(&*read)?;
        let count = |rows: Vec<(String, String)>| -> Result<u64> {
            let mut n = 0;
            for (source, slug) in rows {
                if read_page(&*read, &source, &slug)?.is_some_and(|p| p.deleted_at_us.is_some()) {
                    n += 1;
                }
            }
            Ok(n)
        };
        let slug_redirects = count(slug_aliases)?;
        let page_aliases = count(page_aliases)?;
        Ok(json!({ "slug_redirects": slug_redirects, "page_aliases": page_aliases }))
    }

    /// `listPageTypePairs()`: every distinct `(source_id, type)` of the live typed pages, in source then type order.
    /// Rows: `{source_id, type}`.
    pub fn list_page_type_pairs(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let pairs: BTreeSet<(String, String)> = live_pages(&*read)?
            .into_iter()
            .map(|p| (p.source_id, p.page_type))
            .collect();
        Ok(pairs
            .into_iter()
            .map(|(source_id, ty)| json!({ "source_id": source_id, "type": ty }))
            .collect())
    }

    /// `listTruncatedMarkdownBodies()`: the pages (soft-deleted included, as the SQL has no filter) whose body is under
    /// 30% of the characters of a `raw_data` row's `content` (over 1000 characters, with an H2/H3 heading), one row per
    /// raw row, in page id order, at most 101. A segmented page's body is NULL, so it never compares. Rows:
    /// `{slug, body_len, raw_len}`.
    pub fn list_truncated_markdown_bodies(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages = all_pages(&*read)?;
        pages.sort_by_key(|p| p.id);
        let mut rows = Vec::new();
        'pages: for page in pages {
            let Some(truth) = page.compiled_truth.as_deref() else {
                continue;
            };
            let body_len = truth.chars().count();
            for raw in raw_rows_of(&*read, page.id)? {
                let Some((_, raw_len)) = long_content_with_headings(&raw.data) else {
                    continue;
                };
                if (body_len as f64) < (raw_len as f64) * 0.3 {
                    rows.push(
                        json!({ "slug": page.slug, "body_len": body_len, "raw_len": raw_len }),
                    );
                    if rows.len() == TRUNCATED_BODY_ROWS {
                        break 'pages;
                    }
                }
            }
        }
        Ok(rows)
    }

    /// `countSegmentedMarkdownBodies()`: the segmented pages (soft-deleted included) with a `raw_data` row whose
    /// `content` is over 1000 characters and has an H2/H3 heading.
    pub fn count_segmented_markdown_bodies(&self) -> Result<u64> {
        let read = self.read()?;
        let mut n = 0;
        for page in all_pages(&*read)? {
            if segmented_reference(&*read, page.id)?.is_none() {
                continue;
            }
            if raw_rows_of(&*read, page.id)?
                .iter()
                .any(|raw| long_content_with_headings(&raw.data).is_some())
            {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `listRecentPageBodies(sourceIds | null)`: `{compiled_truth, timeline}` of the 1000 newest live pages by id
    /// (within `sourceIds` when given). A segmented page's columns are null.
    pub fn list_recent_page_bodies(&self, source_ids: Option<Vec<String>>) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(recent_pages(&*read, &source_ids)?
            .into_iter()
            .map(|p| {
                json!({ "compiled_truth": p.compiled_truth.as_deref(), "timeline": p.timeline.as_deref() })
            })
            .collect())
    }

    /// `countSegmentedRecentPages(sourceIds | null)`: how many of those 1000 newest live pages are segmented.
    pub fn count_segmented_recent_pages(&self, source_ids: Option<Vec<String>>) -> Result<u64> {
        let read = self.read()?;
        let mut n = 0;
        for page in recent_pages(&*read, &source_ids)? {
            if segmented_reference(&*read, page.id)?.is_some() {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `countPagesHiddenByPrefix(pattern, sourceIds | null)`: the live pages with at least one chunk that search
    /// serves (projected, in a present unarchived source, not quarantined, not a pinned question) whose slug matches
    /// the LIKE `pattern` (`\` escapes), within `sourceIds` when given.
    pub fn count_pages_hidden_by_prefix(
        &self,
        pattern: String,
        source_ids: Option<Vec<String>>,
    ) -> Result<u64> {
        let read = self.read()?;
        let mut n = 0;
        for page in live_pages(&*read)? {
            if source_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&page.source_id))
                || !served(&page)
                || page.frontmatter.contains_key("quarantine")
                || page.frontmatter.contains_key("pinned_question")
                || read_source(&*read, &page.source_id)?.is_none_or(|s| s.archived)
                || !like(&page.slug, &pattern, false)?
                || read_chunks(&*read, page.id)?.is_empty()
            {
                continue;
            }
            n += 1;
        }
        Ok(n)
    }

    /// `listGitImageHoldCounts(sourceIds)`: per source among `sourceIds`, the `images` count of the
    /// `sync-hold-summary` checkpoint of its current incarnation (`completed_keys[0].images`), the sources with a
    /// positive count only, by source id. Rows: `{source_id, images}`. The checkpoint is read in the housekeeping key
    /// space (`d 0x02 <op> 0x00 <source id>:<incarnation>`), the home of every `op_checkpoints` row this store keeps.
    /// No writer of that op exists yet, so the answer is empty until one is added.
    pub fn list_git_image_hold_counts(&self, source_ids: Vec<String>) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for source in all_sources(&*read)? {
            if !source_ids.contains(&source.id) {
                continue;
            }
            let key = turn_key(
                GIT_HOLD_SUMMARY_OP,
                &format!("{}:{}", source.id, source.incarnation),
            )?;
            let Some(row) = get_json::<HousekeepingRow>(&*read, &key)? else {
                continue;
            };
            let images = row
                .completed_keys
                .get(0)
                .and_then(|v| v.get("images"))
                .map_or(0, |v| match v {
                    Value::Number(n) => n.as_i64().unwrap_or(0),
                    Value::String(t) => t.trim().parse().unwrap_or(0),
                    _ => 0,
                });
            if images > 0 {
                rows.push(json!({ "source_id": source.id, "images": images }));
            }
        }
        Ok(rows)
    }
}
