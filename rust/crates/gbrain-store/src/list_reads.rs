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
use crate::keyword::sql_like;
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

/// A file path that several live pages of one source record (`listPathTwinSlugs`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PathTwins {
    pub source_path: String,
    pub slugs: Vec<String>,
}

/// A live page's slug and the file it records (`listLiveSlugOrigins`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlugOrigin {
    pub slug: String,
    pub source_path: Option<String>,
}

/// `probeRetypeRows`: how many live pages a retype rule matches and the first ten slugs by byte.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RetypeProbe {
    pub count: u64,
    pub sample: Vec<String>,
}

/// One retype-rule probe: the live pages of `fromType` whose file path and slug match the `LIKE`
/// patterns given, in the source when given.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RetypeProbeQuery {
    pub from_type: String,
    pub path_filter: Option<String>,
    pub slug_filter: Option<String>,
    pub source_id: Option<String>,
}

/// A page's slug, body and frontmatter as the schema-pack page rules read it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageBodyRow {
    pub slug: String,
    pub compiled_truth: Option<String>,
    pub frontmatter: Value,
}

/// A source scope: `sourceIds` when not empty, else a non-empty `sourceId`, else every source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceScope {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
}

impl SourceScope {
    fn admits(&self, source_id: &str) -> bool {
        if let Some(ids) = self.source_ids.as_ref().filter(|ids| !ids.is_empty()) {
            ids.iter().any(|id| id == source_id)
        } else if let Some(id) = self.source_id.as_ref().filter(|id| !id.is_empty()) {
            id == source_id
        } else {
            true
        }
    }
}

/// A stored page type and how many live pages carry it (`countLivePagesByType`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TypeCount {
    #[serde(rename = "type")]
    pub page_type: String,
    pub n: String,
}

/// A page with no type or a type the pack does not declare (`listTypeOrphanRows`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TypeOrphanRow {
    pub slug: String,
    pub source_id: String,
    #[serde(rename = "type")]
    pub page_type: String,
}

fn body_row(p: PageRecord) -> PageBodyRow {
    PageBodyRow {
        compiled_truth: p.compiled_truth.as_deref().map(str::to_owned),
        frontmatter: jsonb_value(&Value::Object(p.frontmatter)),
        slug: p.slug,
    }
}

/// A scanned page of the stale-mention scan, its text joined as the SQL joins it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MentionScanPage {
    pub id: u64,
    pub slug: String,
    pub source_id: String,
    pub title: String,
    pub body_storage: String,
    pub body: String,
}

/// A mention link from a scanned page (`StaleMentionScan`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MentionScanLink {
    pub from_id: u64,
    pub from_slug: String,
    pub to_slug: String,
    pub to_source_id: String,
    pub link_kind: Option<String>,
    pub link_type: String,
}

/// `readStaleMentionScan(limit)`: the scanned pages and their mention links.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StaleMentionScan {
    pub pages: Vec<MentionScanPage>,
    pub links: Vec<MentionScanLink>,
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

    /// `readFirstLiveSlugAtPath(path)`: the slug of the first live page, in (source, slug) byte order,
    /// that records `path` as its file, or `None` (sync-git.ts, the unscoped removed-path lane).
    pub fn read_first_live_slug_at_path(&self, path: &str) -> Result<Option<String>> {
        let read = self.read()?;
        Ok(all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && p.source_path.as_deref() == Some(path))
            .min_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)))
            .map(|p| p.slug))
    }

    /// `listPathTwinSlugs(sourceId, paths)`: each of `paths` that more than one live page of the
    /// source records, with those pages' slugs in byte order. The order of the rows is not set (the
    /// SQL has no ORDER BY); this gives them by path.
    pub fn list_path_twin_slugs(&self, source_id: &str, paths: &[String]) -> Result<Vec<PathTwins>> {
        let read = self.read()?;
        let mut by_path: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for p in all_pages(&*read)? {
            if p.source_id != source_id || p.deleted_at_us.is_some() {
                continue;
            }
            if let Some(path) = p.source_path.filter(|path| paths.contains(path)) {
                by_path.entry(path).or_default().push(p.slug);
            }
        }
        Ok(by_path
            .into_iter()
            .filter(|(_, slugs)| slugs.len() > 1)
            .map(|(source_path, mut slugs)| {
                slugs.sort();
                PathTwins { source_path, slugs }
            })
            .collect())
    }

    /// `listLiveSlugOrigins(slugs, sourceId)`: every live page at one of `slugs` (in the source when
    /// one is given) with the file it records, in (source, slug) byte order.
    pub fn list_live_slug_origins(
        &self,
        slugs: &[String],
        source_id: Option<&str>,
    ) -> Result<Vec<SlugOrigin>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.deleted_at_us.is_none()
                    && slugs.contains(&p.slug)
                    && source_id.is_none_or(|s| s == p.source_id)
            })
            .collect();
        pages.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
        Ok(pages
            .into_iter()
            .map(|p| SlugOrigin {
                slug: p.slug,
                source_path: p.source_path,
            })
            .collect())
    }

    /// `probeRetypeRows(query)`: the count of live pages of `fromType` matching the path and slug
    /// patterns (`LIKE`, `\` escapes) in the source when given, and the first ten slugs by byte (none
    /// when the count is zero).
    pub fn probe_retype_rows(&self, query: &RetypeProbeQuery) -> Result<RetypeProbe> {
        let read = self.read()?;
        let mut slugs: Vec<String> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && p.page_type == query.from_type)
            .filter(|p| {
                query.path_filter.as_deref().is_none_or(|pattern| {
                    p.source_path.as_deref().is_some_and(|path| sql_like(path, pattern))
                })
            })
            .filter(|p| query.slug_filter.as_deref().is_none_or(|pattern| sql_like(&p.slug, pattern)))
            .filter(|p| query.source_id.as_deref().is_none_or(|s| s == p.source_id))
            .map(|p| p.slug)
            .collect();
        let count = slugs.len() as u64;
        slugs.sort();
        slugs.truncate(10);
        Ok(RetypeProbe {
            count,
            sample: if count == 0 { Vec::new() } else { slugs },
        })
    }

    /// `listAliasCandidatePages(type, sourceId, limit)`: the live pages of `type` in the source, by
    /// slug in byte order, at most `limit` (the page-to-alias preview).
    pub fn list_alias_candidate_pages(
        &self,
        page_type: &str,
        source_id: &str,
        limit: u32,
    ) -> Result<Vec<PageBodyRow>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && p.page_type == page_type && p.source_id == source_id)
            .collect();
        pages.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(pages.into_iter().take(limit as usize).map(body_row).collect())
    }

    /// `listLinkCandidatePages(type, sourceId, limit)`: the live pages of `type`, in the source when
    /// given, by slug in byte order and then id, at most `limit` (the page-to-link preview).
    pub fn list_link_candidate_pages(
        &self,
        page_type: &str,
        source_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<PageBodyRow>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.deleted_at_us.is_none()
                    && p.page_type == page_type
                    && source_id.is_none_or(|s| s == p.source_id)
            })
            .collect();
        pages.sort_by(|a, b| (&a.slug, a.id).cmp(&(&b.slug, b.id)));
        Ok(pages.into_iter().take(limit as usize).map(body_row).collect())
    }

    /// `countLivePagesByType(scope)`: each stored type of the live pages in scope with its count as
    /// text, by type (the SQL `GROUP BY` sets no order).
    pub fn count_live_pages_by_type(&self, scope: &SourceScope) -> Result<Vec<TypeCount>> {
        let read = self.read()?;
        let mut counts: std::collections::BTreeMap<String, u64> = Default::default();
        for p in all_pages(&*read)? {
            if p.deleted_at_us.is_none() && scope.admits(&p.source_id) {
                *counts.entry(p.page_type).or_default() += 1;
            }
        }
        Ok(counts
            .into_iter()
            .map(|(page_type, n)| TypeCount {
                page_type,
                n: n.to_string(),
            })
            .collect())
    }

    /// `listTypeOrphanRows(scope, undeclared, limit)`: the live pages in scope with an empty type or
    /// one of `undeclared`, by (source, slug) in byte order, at most `limit`.
    pub fn list_type_orphan_rows(
        &self,
        scope: &SourceScope,
        undeclared: &[String],
        limit: u32,
    ) -> Result<Vec<TypeOrphanRow>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.deleted_at_us.is_none()
                    && scope.admits(&p.source_id)
                    && (p.page_type.is_empty() || undeclared.contains(&p.page_type))
            })
            .collect();
        pages.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
        Ok(pages
            .into_iter()
            .take(limit as usize)
            .map(|p| TypeOrphanRow {
                slug: p.slug,
                source_id: p.source_id,
                page_type: p.page_type,
            })
            .collect())
    }

    /// `readStaleMentionScan(limit)`: the first `limit` live pages, by (slug in byte order, id), that
    /// hold a `mentions` link, each with `title \n\n compiled_truth \n\n timeline` (a NULL part as
    /// empty), and every `mentions` link from those pages by (from slug, to slug) in byte order (ties
    /// by link id; the SQL leaves their order unset).
    pub fn read_stale_mention_scan(&self, limit: u32) -> Result<StaleMentionScan> {
        let read = self.read()?;
        let links: Vec<_> = all_links(&*read)?
            .into_iter()
            .filter(|l| l.link_source.as_deref() == Some("mentions"))
            .collect();
        let from_ids: std::collections::HashSet<u64> = links.iter().map(|l| l.from_page_id).collect();
        let all: HashMap<u64, PageRecord> = all_pages(&*read)?.into_iter().map(|p| (p.id, p)).collect();
        let mut scanned: Vec<&PageRecord> = all
            .values()
            .filter(|p| p.deleted_at_us.is_none() && from_ids.contains(&p.id))
            .collect();
        scanned.sort_by(|a, b| (&a.slug, a.id).cmp(&(&b.slug, b.id)));
        scanned.truncate(limit as usize);
        let in_scan: std::collections::HashSet<u64> = scanned.iter().map(|p| p.id).collect();
        let pages = scanned
            .iter()
            .map(|p| MentionScanPage {
                id: p.id,
                slug: p.slug.clone(),
                source_id: p.source_id.clone(),
                title: p.title.clone(),
                body_storage: if segmented(p) { "segmented" } else { "inline" }.to_owned(),
                body: format!(
                    "{}\n\n{}\n\n{}",
                    p.title,
                    p.compiled_truth.as_deref().unwrap_or(""),
                    p.timeline.as_deref().unwrap_or("")
                ),
            })
            .collect();
        let mut found: Vec<(&String, &String, u64, MentionScanLink)> = Vec::new();
        for l in &links {
            if !in_scan.contains(&l.from_page_id) {
                continue;
            }
            let (Some(f), Some(t)) = (all.get(&l.from_page_id), all.get(&l.to_page_id)) else {
                continue;
            };
            found.push((
                &f.slug,
                &t.slug,
                l.id,
                MentionScanLink {
                    from_id: f.id,
                    from_slug: f.slug.clone(),
                    to_slug: t.slug.clone(),
                    to_source_id: t.source_id.clone(),
                    link_kind: l.link_kind.clone(),
                    link_type: l.link_type.clone(),
                },
            ));
        }
        found.sort_by(|a, b| (a.0, a.1, a.2).cmp(&(b.0, b.1, b.2)));
        Ok(StaleMentionScan {
            pages,
            links: found.into_iter().map(|(_, _, _, l)| l).collect(),
        })
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
