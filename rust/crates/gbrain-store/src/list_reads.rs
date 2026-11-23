//! The page-list, slug-source, access and storage-shelf reads their callers ran as raw SQL
//! (rust/docs/store/list-reads.md). PGLite and Postgres run the SQL in
//! `src/core/engine-sql/list-reads.ts`; this answers the same questions from the store's records.
//! Text keys compare as bytes, which is what PGLite and `COLLATE "C"` give.
//!
//! Keys: none of its own. It reads the page and source records.

use crate::Store;
use crate::chunks::{keyed_chunks, segmented};
use crate::cli_reads::pg_text::{fm_text, jsonb_value, timestamptz_text};
use crate::error::Result;
use crate::link_queries::all_links;
use crate::page_ops::{PageReadScope, pages_in_read_scope};
use crate::pages::{PageRecord, all_pages};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;

/// A page id and its source (`resolveChainAnchorRows`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageSourceRow {
    pub id: u64,
    pub source_id: String,
}

/// One readable copy of a slug as `explain_target` probes it (`TargetProbeRow` of
/// `src/core/search/explain-target.ts`, before its caller maps the counts to numbers).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TargetProbeRow {
    pub source_id: String,
    pub chunks: u64,
    pub embedded: u64,
    pub current: bool,
    pub chunker_version: Option<i16>,
}

/// A link's two pages by slug and title (`CompanyBrainEvidenceRows`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LinkPair {
    pub from_slug: String,
    pub from_title: String,
    pub to_slug: String,
    pub to_title: String,
}

/// A page by slug and title.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlugTitle {
    pub slug: String,
    pub title: String,
}

/// `readCompanyBrainEvidenceRows(sourceId)`: the first ownership link, the first decision
/// supersession and the first page of a source.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CompanyBrainEvidenceRows {
    pub owner: Option<LinkPair>,
    pub decision: Option<LinkPair>,
    pub page: Option<SlugTitle>,
}

/// A storage-shelf card as `CARD_COLUMNS` of `src/core/engine-sql/list-reads.ts` selects it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CardRow {
    pub id: String,
    pub title: String,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub stores: Vec<Option<String>>,
    pub original_path: Option<String>,
    pub on_source_machine: Option<bool>,
    pub updated_at: String,
}

/// `CardFilters` of `src/core/storage-manifest/find.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CardFilters {
    pub store: Option<String>,
    pub status: Option<String>,
    pub on_source_machine: Option<bool>,
}

/// `listCardRows(query)`: the shelf query of `listCards`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CardListQuery {
    pub source_id: String,
    pub page_type: String,
    pub filters: CardFilters,
    pub scope: Option<PageReadScope>,
    pub limit: f64,
    pub offset: f64,
}

/// `{ total, cards }` of `listCardRows`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CardList {
    pub total: u64,
    pub cards: Vec<CardRow>,
}

/// A shelf page as `readShelfCards` reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShelfPageRow {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub frontmatter: Value,
}

/// `frontmatter -> 'storage'`: the object, or `None` for a missing key or another JSON type.
fn storage_of(frontmatter: &Map<String, Value>) -> Option<&Map<String, Value>> {
    frontmatter.get("storage").and_then(Value::as_object)
}

/// `frontmatter -> 'storage' ->> key`.
fn storage_text(frontmatter: &Map<String, Value>, key: &str) -> Option<String> {
    storage_of(frontmatter).and_then(|s| fm_text(s, key))
}

/// The elements of `frontmatter -> 'storage' -> 'locations'` when it is an array, else none.
fn storage_locations(frontmatter: &Map<String, Value>) -> &[Value] {
    storage_of(frontmatter)
        .and_then(|s| s.get("locations"))
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `loc ->> 'store'` of one location element (`None` when it is not an object or has no store).
fn location_store(loc: &Value) -> Option<String> {
    loc.as_object().and_then(|o| fm_text(o, "store"))
}

/// One page as `CARD_COLUMNS` reads it. `stores` is `array_agg(DISTINCT loc->>'store')`: each
/// store once in byte order, one NULL last when a location names none, `[]` with no location.
fn card_row(page: &PageRecord) -> CardRow {
    let fm = &page.frontmatter;
    let mut stores: Vec<Option<String>> = storage_locations(fm).iter().map(location_store).collect();
    stores.sort_by(|a, b| match (a, b) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    stores.dedup();
    CardRow {
        id: page.slug.clone(),
        title: page.title.clone(),
        status: storage_text(fm, "status"),
        kind: storage_text(fm, "kind"),
        stores,
        original_path: storage_text(fm, "original_path"),
        on_source_machine: match storage_text(fm, "on_source_machine").as_deref() {
            Some("true") => Some(true),
            Some("false") => Some(false),
            _ => None,
        },
        updated_at: timestamptz_text(page.updated_at_us),
    }
}

/// `cardFilterSql`: the status, store and on-source-machine filters on the card's frontmatter.
fn card_passes(page: &PageRecord, filters: &CardFilters) -> bool {
    let fm = &page.frontmatter;
    if let Some(status) = &filters.status
        && storage_text(fm, "status").as_ref() != Some(status)
    {
        return false;
    }
    if let Some(store) = &filters.store
        && !storage_locations(fm)
            .iter()
            .any(|loc| location_store(loc).as_ref() == Some(store))
    {
        return false;
    }
    if let Some(on) = filters.on_source_machine
        && storage_text(fm, "on_source_machine").as_deref() != Some(if on { "true" } else { "false" })
    {
        return false;
    }
    true
}

/// The pages at `slug` that the read policy admits with its live filter on, by source id.
fn readable_copies(store: &Store, slug: &str, scope: &PageReadScope) -> Result<Vec<PageRecord>> {
    let read = store.read()?;
    let live = PageReadScope {
        live: true,
        ..scope.clone()
    };
    let mut pages = pages_in_read_scope(
        &*read,
        all_pages(&*read)?.into_iter().filter(|p| p.slug == slug).collect(),
        &live,
    )?;
    pages.sort_by(|a, b| a.source_id.cmp(&b.source_id));
    Ok(pages)
}

impl Store {
    /// `listLiveSlugSourceIds(slug)`: the sources holding a live page at `slug`, by id in byte
    /// order. An archived source still counts, as the SQL reads only `pages`.
    pub fn list_live_slug_source_ids(&self, slug: &str) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut ids: Vec<String> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.slug == slug && p.deleted_at_us.is_none())
            .map(|p| p.source_id)
            .collect();
        ids.sort();
        Ok(ids)
    }

    /// `readCompanyBrainEvidenceRows(sourceId)`: the three picks of `company-brain/evidence.ts`. A
    /// link counts when both pages are live in the source, it was written from frontmatter or
    /// markdown, and the page that holds it is its `from` page (a markdown link with no origin
    /// counts too). The owner pick prefers a `customer` page, then goes by from slug and to slug in
    /// byte order; the decision pick takes `supersedes` links between decision pages the same way;
    /// the page pick is the source's first live page by slug.
    pub fn read_company_brain_evidence_rows(
        &self,
        source_id: &str,
    ) -> Result<CompanyBrainEvidenceRows> {
        let read = self.read()?;
        let pages: HashMap<u64, PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.deleted_at_us.is_none())
            .map(|p| (p.id, p))
            .collect();
        let mut owners: Vec<(u8, &PageRecord, &PageRecord)> = Vec::new();
        let mut decisions: Vec<(&PageRecord, &PageRecord)> = Vec::new();
        let links = all_links(&*read)?;
        for l in &links {
            let (Some(f), Some(t)) = (pages.get(&l.from_page_id), pages.get(&l.to_page_id)) else {
                continue;
            };
            let source = l.link_source.as_deref();
            if !matches!(source, Some("frontmatter" | "markdown")) {
                continue;
            }
            let held = l.origin_page_id == Some(f.id)
                || (l.origin_page_id.is_none() && source == Some("markdown"));
            if !held {
                continue;
            }
            if l.link_type == "owned_by" {
                owners.push((u8::from(f.page_type != "customer"), f, t));
            }
            if l.link_type == "supersedes" && f.page_type == "decision" && t.page_type == "decision"
            {
                decisions.push((f, t));
            }
        }
        let pair = |f: &PageRecord, t: &PageRecord| LinkPair {
            from_slug: f.slug.clone(),
            from_title: f.title.clone(),
            to_slug: t.slug.clone(),
            to_title: t.title.clone(),
        };
        let owner = owners
            .into_iter()
            .min_by(|a, b| (a.0, &a.1.slug, &a.2.slug).cmp(&(b.0, &b.1.slug, &b.2.slug)))
            .map(|(_, f, t)| pair(f, t));
        let decision = decisions
            .into_iter()
            .min_by(|a, b| (&a.0.slug, &a.1.slug).cmp(&(&b.0.slug, &b.1.slug)))
            .map(|(f, t)| pair(f, t));
        let page = pages
            .values()
            .min_by(|a, b| a.slug.cmp(&b.slug))
            .map(|p| SlugTitle {
                slug: p.slug.clone(),
                title: p.title.clone(),
            });
        Ok(CompanyBrainEvidenceRows {
            owner,
            decision,
            page,
        })
    }

    /// `listCardRows(query)`: the count of the shelf's cards of `page_type` in `source_id` that the
    /// read scope (with its live filter) and the card filters admit, and the page of them at
    /// `offset`, at most `limit`, by slug in byte order.
    pub fn list_card_rows(&self, query: &CardListQuery) -> Result<CardList> {
        let read = self.read()?;
        let scope = PageReadScope {
            live: true,
            ..query.scope.clone().unwrap_or_default()
        };
        let mut pages = pages_in_read_scope(
            &*read,
            all_pages(&*read)?
                .into_iter()
                .filter(|p| p.source_id == query.source_id && p.page_type == query.page_type)
                .filter(|p| card_passes(p, &query.filters))
                .collect(),
            &scope,
        )?;
        pages.sort_by(|a, b| a.slug.cmp(&b.slug));
        let total = pages.len() as u64;
        let offset = query.offset.max(0.0) as usize;
        let limit = query.limit.max(0.0) as usize;
        Ok(CardList {
            total,
            cards: pages.iter().skip(offset).take(limit).map(card_row).collect(),
        })
    }

    /// `readShelfPageRows(sourceId)`: every live page of the source as `{ slug, title, type,
    /// frontmatter }`, by slug in byte order, the frontmatter keys in jsonb order.
    pub fn read_shelf_page_rows(&self, source_id: &str) -> Result<Vec<ShelfPageRow>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.deleted_at_us.is_none())
            .collect();
        pages.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(pages
            .into_iter()
            .map(|p| ShelfPageRow {
                frontmatter: jsonb_value(&Value::Object(p.frontmatter)),
                slug: p.slug,
                title: p.title,
                page_type: p.page_type,
            })
            .collect())
    }

    /// `resolveChainAnchorRows(slug, policy)`: every live copy of `slug` the read policy admits, as
    /// `{ id, source_id }`, by source id.
    pub fn resolve_chain_anchor_rows(
        &self,
        slug: &str,
        scope: &PageReadScope,
    ) -> Result<Vec<PageSourceRow>> {
        Ok(readable_copies(self, slug, scope)?
            .into_iter()
            .map(|p| PageSourceRow {
                id: p.id,
                source_id: p.source_id,
            })
            .collect())
    }

    /// `probeTargetRows(slug, policy, chunkManifest)`: every live copy of `slug` the read policy
    /// admits, by source id, with its live-body chunk count (`chunkGenerationFilter`; with
    /// `chunk_manifest` off only the inline chunks of a page that is not segmented), how many of those
    /// have a vector, whether its text projection is current, and its chunker version.
    pub fn probe_target_rows(
        &self,
        slug: &str,
        scope: &PageReadScope,
        chunk_manifest: bool,
    ) -> Result<Vec<TargetProbeRow>> {
        let copies = readable_copies(self, slug, scope)?;
        let read = self.read()?;
        let mut rows = Vec::with_capacity(copies.len());
        for page in copies {
            let seg = segmented(&page);
            let chunks: Vec<_> = if chunk_manifest {
                keyed_chunks(&*read, page.id, Some(seg))?
                    .into_iter()
                    .map(|(_, c)| c)
                    .collect()
            } else if seg {
                Vec::new()
            } else {
                keyed_chunks(&*read, page.id, Some(false))?
                    .into_iter()
                    .map(|(_, c)| c)
                    .filter(|c| c.segment.is_none())
                    .collect()
            };
            rows.push(TargetProbeRow {
                current: page.text_projection_revision.as_deref()
                    == Some(page.knowledge_revision.as_str()),
                chunker_version: page.chunker_version,
                embedded: chunks.iter().filter(|c| c.embed.has_vector()).count() as u64,
                chunks: chunks.len() as u64,
                source_id: page.source_id,
            });
        }
        Ok(rows)
    }
}
