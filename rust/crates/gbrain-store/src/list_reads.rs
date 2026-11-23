//! The page-list, slug-source, access and storage-shelf reads their callers ran as raw SQL
//! (rust/docs/store/list-reads.md). PGLite and Postgres run the SQL in
//! `src/core/engine-sql/list-reads.ts`; this answers the same questions from the store's records.
//! Text keys compare as bytes, which is what PGLite and `COLLATE "C"` give.
//!
//! Keys: none of its own. It reads the page and source records.

use crate::Store;
use crate::aliases::all_alias_rows;
use crate::aliases::page_alias_rows;
use crate::chunks::{keyed_chunks, segmented};
use crate::cli_reads::entities::arrow_text;
use crate::cli_reads::pg_text::{btrim, pg_lower};
use crate::cli_reads::pg_text::{fm_text, jsonb_value, timestamptz_text};
use crate::env::iso;
use crate::error::Result;
use crate::facts::PrivacyPolicy;
use crate::facts::privacy::{page_access_allowed, page_folder_rules_allowed, stamped_rules};
use crate::keyword::{
    plainto_tsquery_simple, sql_like, to_tsvector_simple, trgm_word_similarity, ts_matches,
};
use crate::kv::scan_prefix;
use crate::link_queries::all_links;
use crate::owner_only::{OwnerOnlyForm, OwnerOnlySources};
use crate::page_body::truth_lead;
use crate::page_ops::{PageReadScope, pages_in_read_scope};
use crate::pages::{PageRecord, all_pages};
use crate::sources::all_sources;
use crate::takes::{all_takes, real_out};
use crate::trust::belief_events::{EVENT, EVENTS, EventRecord, part_key};
use crate::trust::belief_lifetimes::{LIFETIMES, LifetimeRecord, RECORD};
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
    pub stores: Vec<String>,
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
/// store once in byte order, then, when a location names none, the NULL element, which PGLite and
/// Postgres both hand back as the text `NULL`; `[]` with no location.
fn card_row(page: &PageRecord) -> CardRow {
    let fm = &page.frontmatter;
    let mut stores: Vec<Option<String>> =
        storage_locations(fm).iter().map(location_store).collect();
    stores.sort_by(|a, b| match (a, b) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    stores.dedup();
    let stores = stores
        .into_iter()
        .map(|s| s.unwrap_or_else(|| "NULL".to_owned()))
        .collect();
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
        && storage_text(fm, "on_source_machine").as_deref()
            != Some(if on { "true" } else { "false" })
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

/// A source id and its incarnation (`listLiveSourceIncarnations`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceIncarnation {
    pub id: String,
    pub incarnation: String,
}

/// One page of the attendance-repair scan window (`PAGE_PIN_SQL` of attendance-repair.ts).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AttendanceWindowRow {
    pub id: String,
    pub slug: String,
    pub source_id: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub revision: String,
    pub deleted: bool,
}

/// A page by slug and source (`listEmailAliasPages`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlugSourceRow {
    pub slug: String,
    pub source_id: String,
}

/// One source's chat census (`ChatCensusRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChatCensusRow {
    pub source_id: String,
    pub chat_pages: u64,
    pub channels: u64,
}

/// `readChatCensusRows(query)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChatCensusQuery {
    pub source_ids: Vec<String>,
    pub chat_types: Vec<String>,
    pub dm_types: Vec<String>,
    pub exclude_private: Option<crate::facts::PrivacyPolicy>,
}

/// `lower(substring(title from '^#([A-Za-z0-9._-]+)'))`: the channel a leading `#name` names.
fn title_channel(title: &str) -> Option<String> {
    let rest = title.strip_prefix('#')?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    (!name.is_empty()).then(|| name.to_ascii_lowercase())
}

/// One page `whoCanRead` reports on (src/commands/access.ts): its type, frontmatter, stamped
/// folder rule ids (`source:rule`, null when none) and whether it is owner-only.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WhoCanReadRow {
    pub slug: String,
    pub source_id: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub frontmatter: Value,
    pub folder_rule_ids: Option<Vec<String>>,
    pub owner_only: bool,
}

/// `readForecastPredictions(query)`: the journal's filters.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PredictionQuery {
    pub source_ids: Option<Vec<String>>,
    pub holder: Option<String>,
    pub about: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
}

/// One prediction of the forecast journal (forecast-journal.ts `TakeRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PredictionRow {
    pub id: u64,
    pub source_id: String,
    pub page_slug: String,
    pub row_num: i32,
    pub claim: String,
    pub kind: String,
    pub holder: String,
    pub weight: f64,
    pub since_date: Option<String>,
    pub resolved_quality: Option<String>,
    pub resolved_at: Option<String>,
    pub resolved_by: Option<String>,
    pub resolved_source: Option<String>,
}

/// A ledger event that dates a prediction (`readPredictionLedgerEvents`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PredictionLedgerEvent {
    pub source_id: String,
    pub slug: String,
    pub event_type: String,
    pub subject_key: Option<String>,
    pub at: String,
}

/// `findCardRows(query)`: the ranked shelf lookup of `findCards`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CardFindQuery {
    pub source_id: String,
    pub page_type: String,
    /// The phrase, trimmed and lowercased.
    pub query: String,
    /// The phrase's alias form (`normalizeAlias`).
    pub alias_norm: String,
    pub terms: Vec<String>,
    pub filters: CardFilters,
    pub scope: Option<PageReadScope>,
}

/// One ranked card: the card columns plus the ranking columns `findCards` reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CardHitRow {
    #[serde(flatten)]
    pub card: CardRow,
    pub exact_id: bool,
    pub exact_alias: bool,
    pub exact_title: bool,
    pub matched: u64,
    pub similarity: f64,
}

/// `left(text, n)`: the first `n` characters.
fn left_chars(text: &str, n: usize) -> &str {
    text.char_indices()
        .nth(n)
        .map_or(text, |(at, _)| &text[..at])
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
        all_pages(&*read)?
            .into_iter()
            .filter(|p| p.slug == slug)
            .collect(),
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
            cards: pages
                .iter()
                .skip(offset)
                .take(limit)
                .map(card_row)
                .collect(),
        })
    }

    /// `findCardRows(query)`: the shelf cards the read scope (live) and card filters admit, each
    /// with `exact_id` (slug = query), `exact_alias` (an alias row equals `alias_norm`),
    /// `exact_title` (`lower(btrim(title))` = query), `matched` (how many terms the `simple` text
    /// search finds in `title aliases slug left(body, 65536)`, none when the page has no body) and
    /// `similarity` (the best `word_similarity(query, ..)` over the lowered title and the aliases),
    /// best first by those columns in that order, then slug in byte order, at most 500.
    pub fn find_card_rows(&self, query: &CardFindQuery) -> Result<Vec<CardHitRow>> {
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
        let tsqueries = query
            .terms
            .iter()
            .map(|t| plainto_tsquery_simple(t))
            .collect::<Result<Vec<_>>>()?;
        let mut rows = Vec::with_capacity(pages.len());
        for page in &pages {
            let aliases: Vec<String> = page_alias_rows(&*read, &page.source_id, &page.slug)?
                .into_iter()
                .map(|(alias, _)| alias)
                .collect();
            let body = match page.compiled_truth.as_deref() {
                Some(text) => Some(text.to_string()),
                None => truth_lead(&*read, page.id)?,
            };
            let matched = match body {
                Some(body) => {
                    let doc = to_tsvector_simple(&format!(
                        "{} {} {} {}",
                        page.title,
                        aliases.join(" "),
                        page.slug,
                        left_chars(&body, 64 * 1024)
                    ))?;
                    tsqueries.iter().filter(|q| ts_matches(&doc, q)).count() as u64
                }
                None => 0,
            };
            let alias_best = aliases
                .iter()
                .map(|a| trgm_word_similarity(&query.query, a))
                .fold(None, |m: Option<f32>, s| Some(m.map_or(s, |m| m.max(s))))
                .unwrap_or(0.0);
            let similarity =
                trgm_word_similarity(&query.query, &pg_lower(&page.title)).max(alias_best);
            rows.push(CardHitRow {
                card: card_row(page),
                exact_id: page.slug == query.query,
                exact_alias: aliases.contains(&query.alias_norm),
                exact_title: pg_lower(btrim(&page.title)) == query.query,
                matched,
                similarity: f64::from(similarity),
            });
        }
        // Stable: the rows are by slug byte, the last key.
        rows.sort_by(|a, b| {
            b.exact_id
                .cmp(&a.exact_id)
                .then(b.exact_alias.cmp(&a.exact_alias))
                .then(b.exact_title.cmp(&a.exact_title))
                .then(b.matched.cmp(&a.matched))
                .then(
                    b.similarity
                        .partial_cmp(&a.similarity)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
        });
        rows.truncate(500);
        Ok(rows)
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
    pub fn list_path_twin_slugs(
        &self,
        source_id: &str,
        paths: &[String],
    ) -> Result<Vec<PathTwins>> {
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
                    p.source_path
                        .as_deref()
                        .is_some_and(|path| sql_like(path, pattern))
                })
            })
            .filter(|p| {
                query
                    .slug_filter
                    .as_deref()
                    .is_none_or(|pattern| sql_like(&p.slug, pattern))
            })
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
            .filter(|p| {
                p.deleted_at_us.is_none() && p.page_type == page_type && p.source_id == source_id
            })
            .collect();
        pages.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(pages
            .into_iter()
            .take(limit as usize)
            .map(body_row)
            .collect())
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
        Ok(pages
            .into_iter()
            .take(limit as usize)
            .map(body_row)
            .collect())
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
        let from_ids: std::collections::HashSet<u64> =
            links.iter().map(|l| l.from_page_id).collect();
        let all: HashMap<u64, PageRecord> =
            all_pages(&*read)?.into_iter().map(|p| (p.id, p)).collect();
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

    /// `readClockMillisText()`: `floor(extract(epoch FROM clock_timestamp())*1000)::text`, the
    /// store clock in whole milliseconds since the epoch.
    pub fn read_clock_millis_text(&self) -> Result<String> {
        self.read()?;
        Ok(self.env.clock_micros().div_euclid(1000).to_string())
    }

    /// `listLiveSourceIncarnations(ids)`: `{ id, incarnation }` of each listed source that is not
    /// archived and has no archive time. The SQL sets no order; this gives them by id.
    pub fn list_live_source_incarnations(&self, ids: &[String]) -> Result<Vec<SourceIncarnation>> {
        let read = self.read()?;
        let mut rows: Vec<SourceIncarnation> = all_sources(&*read)?
            .into_iter()
            .filter(|s| ids.contains(&s.id) && !s.archived && s.archived_at_us.is_none())
            .map(|s| SourceIncarnation {
                id: s.id,
                incarnation: s.incarnation,
            })
            .collect();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(rows)
    }

    /// `readAttendanceWindow(sourceId, afterSlug, limit)`: the source's pages (soft-deleted ones
    /// included, marked) whose slug is after `after_slug` in byte order, by slug, at most `limit`.
    pub fn read_attendance_window(
        &self,
        source_id: &str,
        after_slug: &str,
        limit: u32,
    ) -> Result<Vec<AttendanceWindowRow>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.slug.as_str() > after_slug)
            .collect();
        pages.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(pages
            .into_iter()
            .take(limit as usize)
            .map(|p| AttendanceWindowRow {
                id: p.id.to_string(),
                deleted: p.deleted_at_us.is_some(),
                slug: p.slug,
                source_id: p.source_id,
                page_type: p.page_type,
                revision: p.knowledge_revision,
            })
            .collect())
    }

    /// `listEmailAliasPages(aliasNorm, sourceId)`: up to two distinct `{ slug, source_id }` of live
    /// pages in another source that carry `alias_norm` as a page alias (open-loop counterparty
    /// resolution). The SQL sets no order; this gives them by (source, slug).
    pub fn list_email_alias_pages(
        &self,
        alias_norm: &str,
        source_id: &str,
    ) -> Result<Vec<SlugSourceRow>> {
        let read = self.read()?;
        let live: std::collections::HashSet<(String, String)> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none())
            .map(|p| (p.source_id, p.slug))
            .collect();
        let found: std::collections::BTreeSet<(String, String)> = all_alias_rows(&*read)?
            .into_iter()
            .filter(|(source, slug, alias, _, _)| {
                alias == alias_norm
                    && source != source_id
                    && live.contains(&(source.clone(), slug.clone()))
            })
            .map(|(source, slug, _, _, _)| (source, slug))
            .collect();
        Ok(found
            .into_iter()
            .take(2)
            .map(|(source_id, slug)| SlugSourceRow { slug, source_id })
            .collect())
    }

    /// `readChatCensusRows(query)`: per source among `sourceIds` (by id in byte order), its live pages
    /// of a chat type that the page policy admits (when given), and how many distinct channels they
    /// come from: a DM-type page is its own channel (`dm:<slug>`), else the frontmatter `channel`,
    /// `chat` or `conversation` (the first non-empty), else a leading `#name` of the title lowered,
    /// else the empty channel. A source with no such page has no row.
    pub fn read_chat_census_rows(&self, query: &ChatCensusQuery) -> Result<Vec<ChatCensusRow>> {
        let read = self.read()?;
        let scope = PageReadScope {
            source_ids: Some(query.source_ids.clone()),
            exclude_private: query.exclude_private.clone(),
            ..PageReadScope::default()
        };
        let pages = pages_in_read_scope(
            &*read,
            all_pages(&*read)?
                .into_iter()
                .filter(|p| {
                    p.deleted_at_us.is_none()
                        && query.chat_types.contains(&p.page_type)
                        && query.source_ids.contains(&p.source_id)
                })
                .collect(),
            &scope,
        )?;
        let mut by_source: std::collections::BTreeMap<
            String,
            (u64, std::collections::BTreeSet<String>),
        > = Default::default();
        for p in pages {
            let channel = if query.dm_types.contains(&p.page_type) {
                format!("dm:{}", p.slug)
            } else {
                ["channel", "chat", "conversation"]
                    .iter()
                    .find_map(|k| fm_text(&p.frontmatter, k).filter(|v| !v.is_empty()))
                    .or_else(|| title_channel(&p.title))
                    .unwrap_or_default()
            };
            let entry = by_source.entry(p.source_id).or_default();
            entry.0 += 1;
            entry.1.insert(channel);
        }
        Ok(by_source
            .into_iter()
            .map(|(source_id, (chat_pages, channels))| ChatCensusRow {
                source_id,
                chat_pages,
                channels: channels.len() as u64,
            })
            .collect())
    }

    /// `readWhoCanReadRows(slug, sourceId, form)`: every page at `slug` (soft-deleted ones too), in
    /// the source when given, by source id, with whether `ownerOnlyPageSql(form)` holds for it.
    pub fn read_who_can_read_rows(
        &self,
        slug: &str,
        source_id: Option<&str>,
        form: OwnerOnlyForm,
    ) -> Result<Vec<WhoCanReadRow>> {
        let read = self.read()?;
        let owner_only = OwnerOnlySources::read(&*read)?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.slug == slug && source_id.is_none_or(|s| s == p.source_id))
            .collect();
        pages.sort_by(|a, b| a.source_id.cmp(&b.source_id));
        let mut rows = Vec::with_capacity(pages.len());
        for p in pages {
            let mut ids: Vec<String> = stamped_rules(&*read, &p)?
                .into_iter()
                .map(|r| format!("{}:{}", r.source_id, r.rule_id))
                .collect();
            ids.sort();
            rows.push(WhoCanReadRow {
                owner_only: owner_only.page_hidden(&*read, &p, form)?,
                folder_rule_ids: (!ids.is_empty()).then_some(ids),
                frontmatter: jsonb_value(&Value::Object(p.frontmatter)),
                slug: p.slug,
                source_id: p.source_id,
                page_type: p.page_type,
            });
        }
        Ok(rows)
    }

    /// `readPageAccessAllowed(sourceId, slug, identity, policy)`: whether the page (soft-deleted or
    /// not) exists and `accessAllowedSql(identity)` admits it under the caller record's policy.
    pub fn read_page_access_allowed(
        &self,
        source_id: &str,
        slug: &str,
        identity: &[String],
        policy: &PrivacyPolicy,
    ) -> Result<bool> {
        let read = self.read()?;
        match crate::pages::read_page(&*read, source_id, slug)? {
            Some(page) => page_access_allowed(&*read, &page, identity, policy),
            None => Ok(false),
        }
    }

    /// `readPageFolderRulesAllowed(sourceId, slug, satisfied, policy)`: whether the page exists and
    /// `folderRulesAllowedSql(satisfied)` admits it under the caller record's policy.
    pub fn read_page_folder_rules_allowed(
        &self,
        source_id: &str,
        slug: &str,
        satisfied: &[String],
        policy: &PrivacyPolicy,
    ) -> Result<bool> {
        let read = self.read()?;
        match crate::pages::read_page(&*read, source_id, slug)? {
            Some(page) => page_folder_rules_allowed(&*read, &page, satisfied, policy),
            None => Ok(false),
        }
    }

    /// `countLineageClosingRules(ruleIds, sourceId)`: how many of `rule_ids` are not
    /// `<source>:<rule>` of a rule of the source that keeps only raw pages (`covers_derived` false).
    pub fn count_lineage_closing_rules(&self, rule_ids: &[String], source_id: &str) -> Result<u64> {
        let mut n = 0;
        for id in rule_ids {
            let raw_only = match id.strip_prefix(source_id).and_then(|r| r.strip_prefix(':')) {
                Some(rule_id) => self
                    .get_access_rule(source_id, rule_id)?
                    .is_some_and(|r| !r.covers_derived),
                None => false,
            };
            if !raw_only {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `readForecastPredictions(query)`: the active takes that are not facts, on live pages, in the
    /// named sources (all when none), of the holder, whose page slug starts with `about`, and whose
    /// `since_date` lies in [since, until] (text order), by (source, slug) in byte order then row.
    pub fn read_forecast_predictions(&self, q: &PredictionQuery) -> Result<Vec<PredictionRow>> {
        let read = self.read()?;
        let pages: HashMap<u64, PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none())
            .map(|p| (p.id, p))
            .collect();
        let mut rows: Vec<PredictionRow> = Vec::new();
        for t in all_takes(&*read)? {
            let Some(p) = pages.get(&t.page_id) else {
                continue;
            };
            if !t.active || t.kind == "fact" {
                continue;
            }
            if q.source_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&p.source_id))
                || q.holder.as_ref().is_some_and(|h| *h != t.holder)
                || q.about
                    .as_ref()
                    .is_some_and(|a| !p.slug.starts_with(a.as_str()))
            {
                continue;
            }
            let since = t.since_date.as_deref();
            if q.since
                .as_deref()
                .is_some_and(|s| !since.is_some_and(|d| d >= s))
                || q.until
                    .as_deref()
                    .is_some_and(|u| !since.is_some_and(|d| d <= u))
            {
                continue;
            }
            rows.push(PredictionRow {
                id: t.id,
                source_id: p.source_id.clone(),
                page_slug: p.slug.clone(),
                row_num: t.row_num,
                claim: t.claim,
                kind: t.kind,
                holder: t.holder,
                weight: real_out(t.weight),
                since_date: t.since_date,
                resolved_quality: t.resolved_quality,
                resolved_at: t.resolved_at_us.map(iso),
                resolved_by: t.resolved_by,
                resolved_source: t.resolved_source,
            });
        }
        rows.sort_by(|a, b| {
            (&a.source_id, &a.page_slug, a.row_num).cmp(&(&b.source_id, &b.page_slug, b.row_num))
        });
        Ok(rows)
    }

    /// `readPredictionLedgerEvents(sourceIds, slugs)`: the events of the open page lifetimes (of
    /// the source's current incarnation) at the listed sources and slugs that date a prediction: a
    /// take event, or a `page.published` with no `revision_before`; never a backfill. By event id.
    pub fn read_prediction_ledger_events(
        &self,
        source_ids: &[String],
        slugs: &[String],
    ) -> Result<Vec<PredictionLedgerEvent>> {
        let read = self.read()?;
        let mut lifetimes: Vec<(String, LifetimeRecord)> = Vec::new();
        let prefix = [crate::keys::TRUST, LIFETIMES, RECORD];
        let mut bad = None;
        scan_prefix(&*read, &prefix, false, &mut |k, v| {
            match serde_json::from_slice::<LifetimeRecord>(v) {
                Ok(r) => {
                    lifetimes.push((String::from_utf8_lossy(&k[prefix.len()..]).into_owned(), r))
                }
                Err(e) => bad = Some(e),
            }
            bad.is_none()
        })?;
        if let Some(e) = bad {
            return Err(e.into());
        }
        let mut out: Vec<(u64, PredictionLedgerEvent)> = Vec::new();
        for (lifetime, l) in lifetimes {
            if l.ended_at_us.is_some()
                || !source_ids.contains(&l.source_id)
                || !slugs.contains(&l.slug)
            {
                continue;
            }
            if !crate::sources::read_source(&*read, &l.source_id)?
                .is_some_and(|s| s.incarnation == l.source_incarnation)
            {
                continue;
            }
            let ev_prefix = part_key(
                &[crate::keys::TRUST, EVENTS, EVENT],
                &[&l.source_id, &l.source_incarnation],
                None,
            );
            let mut events: Vec<EventRecord> = Vec::new();
            let mut fail = None;
            scan_prefix(&*read, &ev_prefix, false, &mut |_, v| {
                match serde_json::from_slice::<EventRecord>(v) {
                    Ok(e) => events.push(e),
                    Err(e) => fail = Some(e),
                }
                fail.is_none()
            })?;
            if let Some(e) = fail {
                return Err(e.into());
            }
            for e in events {
                if e.page_lifetime.as_deref() != Some(lifetime.as_str()) || e.origin == "backfill" {
                    continue;
                }
                let revision_before = e
                    .value
                    .as_ref()
                    .and_then(|v| v.as_object())
                    .and_then(|o| o.get("revision_before"))
                    .and_then(arrow_text);
                if !(e.subject_kind == "take"
                    || (e.event_type == "page.published" && revision_before.is_none()))
                {
                    continue;
                }
                out.push((
                    e.id,
                    PredictionLedgerEvent {
                        source_id: l.source_id.clone(),
                        slug: l.slug.clone(),
                        event_type: e.event_type,
                        subject_key: Some(e.subject_key),
                        at: iso(e.recorded_at_us),
                    },
                ));
            }
        }
        out.sort_by_key(|(id, _)| *id);
        Ok(out.into_iter().map(|(_, e)| e).collect())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_members::PageOriginRefresh;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;
    use serde_json::{Map, json};

    fn page(store: &Store, source: &str, slug: &str, page_type: &str, path: Option<&str>) {
        let input: PageInput = serde_json::from_value(json!({
            "type": page_type, "title": slug, "compiled_truth": "body", "timeline": "",
        }))
        .unwrap();
        let opts = PutPageOptions {
            source_id: Some(source.to_string()),
            ..Default::default()
        };
        store.put_page(slug, &input, &opts).unwrap();
        if let Some(path) = path {
            let refresh = PageOriginRefresh {
                source_id: source.to_string(),
                source_path: path.to_string(),
                source_uri: None,
            };
            store.refresh_page_origin(slug, &refresh).unwrap();
        }
    }

    fn seeded() -> Store {
        let store = store();
        store
            .insert_source("work", "work", None, &Map::new())
            .unwrap();
        page(&store, "default", "notes/a", "note", Some("notes/a.md"));
        page(&store, "default", "notes/b", "note", Some("notes/b.md"));
        page(&store, "default", "people/x", "person", Some("people/x.md"));
        page(&store, "work", "notes/a", "note", Some("notes/a.md"));
        page(&store, "work", "gone", "", None);
        store.soft_delete_page("gone", Some("work")).unwrap();
        store
    }

    #[test]
    fn slug_sources_and_origins_read_live_pages_in_byte_order() {
        let store = seeded();
        assert_eq!(
            store.list_live_slug_source_ids("notes/a").unwrap(),
            vec!["default".to_string(), "work".to_string()]
        );
        assert!(store.list_live_slug_source_ids("gone").unwrap().is_empty());
        let slugs = vec!["notes/a".to_string(), "gone".to_string()];
        let all = store.list_live_slug_origins(&slugs, None).unwrap();
        assert_eq!(all.len(), 2);
        assert!(
            all.iter()
                .all(|o| o.slug == "notes/a" && o.source_path.as_deref() == Some("notes/a.md"))
        );
        assert_eq!(
            store
                .list_live_slug_origins(&slugs, Some("work"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store
                .read_first_live_slug_at_path("notes/a.md")
                .unwrap()
                .as_deref(),
            Some("notes/a")
        );
        assert_eq!(store.read_first_live_slug_at_path("none.md").unwrap(), None);
    }

    #[test]
    fn path_twins_are_empty_while_each_live_path_has_one_holder() {
        // The live-origin key lets one live page hold a path, so a twin is a page the key never
        // saw (an older brain); a store written through the members has none.
        let store = seeded();
        let paths = vec!["notes/a.md".to_string(), "notes/b.md".to_string()];
        assert!(
            store
                .list_path_twin_slugs("default", &paths)
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .list_path_twin_slugs("work", &paths)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn type_counts_respect_the_scope_and_skip_deleted_pages() {
        let store = seeded();
        let every = store
            .count_live_pages_by_type(&SourceScope::default())
            .unwrap();
        let pairs: Vec<(String, String)> = every.into_iter().map(|c| (c.page_type, c.n)).collect();
        assert_eq!(
            pairs,
            vec![
                ("note".to_string(), "3".to_string()),
                ("person".to_string(), "1".to_string())
            ]
        );
        let work = SourceScope {
            source_id: Some("work".to_string()),
            source_ids: None,
        };
        let counts = store.count_live_pages_by_type(&work).unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].n, "1");
        // A non-empty list wins over the scalar.
        let listed = SourceScope {
            source_id: Some("work".to_string()),
            source_ids: Some(vec!["default".to_string()]),
        };
        let counts = store.count_live_pages_by_type(&listed).unwrap();
        assert_eq!(
            counts.iter().map(|c| c.n.as_str()).collect::<Vec<_>>(),
            vec!["2", "1"]
        );
    }

    #[test]
    fn live_incarnations_skip_unlisted_sources() {
        let store = seeded();
        let ids = vec!["work".to_string(), "missing".to_string()];
        let rows = store.list_live_source_incarnations(&ids).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "work");
        assert!(!rows[0].incarnation.is_empty());
        let millis: i64 = store.read_clock_millis_text().unwrap().parse().unwrap();
        assert!(millis > 0);
    }
}
