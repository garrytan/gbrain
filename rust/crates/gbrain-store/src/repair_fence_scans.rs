//! The page scans of the `contact-rows`, `split-facts` and `atom-fence-rows` repair plans
//! (`src/core/engine-sql/repair-fence-scans.ts`).
//!
//! Members: listContactRowPages, listSplitFactsPages, listAtomFenceCandidates, listPageTruths.
//!
//! Each member reads every page record once and filters it as the SQL's `WHERE` does. A live
//! page is one with no `deleted_at`; a segmented page is one whose two body columns are null
//! (`chunks::segmented`, the store's `body_storage = 'segmented'`). Text matches are byte
//! matches, as SQL's `LIKE '%…%'` and `strpos` are with no wildcard in the pattern.

use crate::Store;
use crate::chunks::segmented;
use crate::cli_reads::pg_text::fm_text;
use crate::error::Result;
use crate::kv::KvRead;
use crate::page_body::manifest_rows;
use crate::pages::{PageRecord, all_pages};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const FACTS_BEGIN: &str = "gbrain:facts:begin";
const TAKES_BEGIN: &str = "gbrain:takes:begin";

/// A page a repair plan reads next (`RepairPageRef`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RepairPageRef {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
}

/// `ContactRowQuery`: the pages past `after_id` (at most `limit`), among `slugs` when not empty.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ContactRowQuery {
    #[serde(default)]
    pub after_id: u64,
    #[serde(default)]
    pub limit: u64,
    #[serde(default)]
    pub slugs: Vec<String>,
}

/// A segmented page split-facts lists and does not merge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SegmentedPageRef {
    pub source_id: String,
    pub slug: String,
}

/// `SplitFactsPages`: inline pages with a facts fence in both sections, segmented ones whose live
/// manifest protects a facts region in both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SplitFactsPages {
    pub inline: Vec<RepairPageRef>,
    pub segmented: Vec<SegmentedPageRef>,
}

/// `AtomFenceQuery`: one atom (`atom_id`) or every one, past `after_id`, at most `limit`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AtomFenceQuery {
    #[serde(default)]
    pub atom_id: Option<u64>,
    #[serde(default)]
    pub after_id: u64,
    #[serde(default)]
    pub limit: u64,
}

/// `AtomFenceCandidate`: a world atom whose live source page names a facts or takes fence or is
/// segmented (`origin_unread`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AtomFenceCandidate {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    pub revision: String,
    pub text: Option<String>,
    pub origin_id: u64,
    pub origin_slug: String,
    pub origin_hash: Option<String>,
    pub origin_unread: bool,
}

/// One page's compiled truth (`null` for a segmented page).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageTruth {
    pub id: u64,
    pub body: Option<String>,
}

fn live_in(page: &PageRecord, sources: &BTreeSet<&str>) -> bool {
    page.deleted_at_us.is_none() && sources.contains(page.source_id.as_str())
}

fn page_ref(page: &PageRecord) -> RepairPageRef {
    RepairPageRef {
        id: page.id,
        source_id: page.source_id.clone(),
        slug: page.slug.clone(),
    }
}

/// `CASE WHEN jsonb_typeof(frontmatter->'contacts')='array' THEN jsonb_array_length(...) ELSE 0 END`.
fn contact_rows(page: &PageRecord) -> usize {
    page.frontmatter
        .get("contacts")
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
}

fn has(text: Option<&str>, needle: &str) -> bool {
    text.is_some_and(|t| t.contains(needle))
}

/// `protected_regions @> '[{"kind":"facts"}]'`: an element of the array names the facts kind.
fn protects_facts(regions: &Value) -> bool {
    regions.as_array().is_some_and(|rows| {
        rows.iter()
            .any(|row| row.get("kind").and_then(Value::as_str) == Some("facts"))
    })
}

/// The live manifest of `page` protects a facts region in both its truth and timeline regions.
fn segmented_split(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    let mut truth = false;
    let mut timeline = false;
    for (_, row) in manifest_rows(read, page.id)? {
        if row.gen_to.is_some()
            || row.staging_id.is_some()
            || !protects_facts(&row.protected_regions)
        {
            continue;
        }
        match row.region.as_str() {
            "truth" => truth = true,
            "timeline" => timeline = true,
            _ => {}
        }
    }
    Ok(truth && timeline)
}

/// `concat_ws(E'\n', title, compiled_truth, frontmatter->>'source_quote')`: the present parts.
fn atom_text(page: &PageRecord) -> String {
    let quote = fm_text(&page.frontmatter, "source_quote");
    [
        Some(page.title.as_str()),
        page.compiled_truth.as_deref(),
        quote.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n")
}

fn take(limit: u64) -> usize {
    usize::try_from(limit).unwrap_or(usize::MAX)
}

impl Store {
    /// `listContactRowPages(sourceIds, q)`: the live inline pages of `source_ids` with two or more
    /// frontmatter contact rows, by id.
    pub fn list_contact_row_pages(
        &self,
        source_ids: &[String],
        q: &ContactRowQuery,
    ) -> Result<Vec<RepairPageRef>> {
        let read = self.read()?;
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let slugs: BTreeSet<&str> = q.slugs.iter().map(String::as_str).collect();
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                live_in(p, &sources)
                    && !segmented(p)
                    && p.id > q.after_id
                    && contact_rows(p) > 1
                    && (slugs.is_empty() || slugs.contains(p.slug.as_str()))
            })
            .collect();
        pages.sort_by_key(|p| p.id);
        pages.truncate(take(q.limit.max(1)));
        Ok(pages.iter().map(page_ref).collect())
    }

    /// `listSplitFactsPages(sourceIds)`: the live pages of `source_ids` a split-facts preview
    /// reads, each list by id.
    pub fn list_split_facts_pages(&self, source_ids: &[String]) -> Result<SplitFactsPages> {
        let read = self.read()?;
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| live_in(p, &sources))
            .collect();
        pages.sort_by_key(|p| p.id);
        let mut out = SplitFactsPages {
            inline: Vec::new(),
            segmented: Vec::new(),
        };
        for page in &pages {
            if has(page.compiled_truth.as_deref(), FACTS_BEGIN)
                && has(page.timeline.as_deref(), FACTS_BEGIN)
            {
                out.inline.push(page_ref(page));
            }
            if segmented(page) && segmented_split(&*read, page)? {
                out.segmented.push(SegmentedPageRef {
                    source_id: page.source_id.clone(),
                    slug: page.slug.clone(),
                });
            }
        }
        Ok(out)
    }

    /// `listAtomFenceCandidates(sourceIds, q)`: the world atoms of `source_ids` whose live source
    /// page names a facts or takes fence or is segmented, by id.
    pub fn list_atom_fence_candidates(
        &self,
        source_ids: &[String],
        q: &AtomFenceQuery,
    ) -> Result<Vec<AtomFenceCandidate>> {
        let read = self.read()?;
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let pages: Vec<PageRecord> = all_pages(&*read)?;
        let live: BTreeMap<(&str, &str), &PageRecord> = pages
            .iter()
            .filter(|p| p.deleted_at_us.is_none())
            .map(|p| ((p.source_id.as_str(), p.slug.as_str()), p))
            .collect();
        let mut out = Vec::new();
        for atom in &pages {
            if !live_in(atom, &sources)
                || atom.page_type != "atom"
                || atom.id <= q.after_id
                || q.atom_id.is_some_and(|id| id != atom.id)
                || fm_text(&atom.frontmatter, "visibility").as_deref() != Some("world")
            {
                continue;
            }
            let Some(origin_slug) = fm_text(&atom.frontmatter, "source_slug") else {
                continue;
            };
            let Some(origin) = live.get(&(atom.source_id.as_str(), origin_slug.as_str())) else {
                continue;
            };
            let body = origin.compiled_truth.as_deref();
            if !(body.is_none() || has(body, FACTS_BEGIN) || has(body, TAKES_BEGIN)) {
                continue;
            }
            out.push(AtomFenceCandidate {
                id: atom.id,
                source_id: atom.source_id.clone(),
                slug: atom.slug.clone(),
                revision: atom.knowledge_revision.to_lowercase(),
                text: Some(atom_text(atom)),
                origin_id: origin.id,
                origin_slug: origin.slug.clone(),
                origin_hash: origin.content_hash.clone(),
                origin_unread: body.is_none(),
            });
        }
        out.sort_by_key(|c| c.id);
        out.truncate(take(q.limit));
        Ok(out)
    }

    /// `listPageTruths(ids)`: the compiled truth of each page in `ids` (any state), by id.
    pub fn list_page_truths(&self, ids: &[u64]) -> Result<Vec<PageTruth>> {
        let read = self.read()?;
        let wanted: BTreeSet<u64> = ids.iter().copied().collect();
        let mut out: Vec<PageTruth> = all_pages(&*read)?
            .into_iter()
            .filter(|p| wanted.contains(&p.id))
            .map(|p| PageTruth {
                id: p.id,
                body: p.compiled_truth.as_deref().map(str::to_string),
            })
            .collect();
        out.sort_by_key(|t| t.id);
        Ok(out)
    }
}
