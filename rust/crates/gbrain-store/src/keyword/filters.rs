//! What the keyword members share: their options, the page and chunk filters of
//! `search/keyword-statement.ts` (`keywordFilters`) and `searchKeywordChunks`, the chunk
//! `search_vector`, the source factor of `buildSourceFactorCase`, and the row they return.
//!
//! The TypeScript members resolve every engine default before the call (the hard-exclude list,
//! the boost map as ordered `[prefix, factor]` pairs, the collapsed query, the slug handles, the
//! date bounds as UTC microseconds), so the store applies exactly the predicates it is given.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::cjk::CjkTerm;
use super::tsearch::{TsVector, Weight, concat, fts_input, setweight, to_tsvector};
use super::vector_cache::{VectorKind, cached};
use crate::chunks::{ChunkRecord, SAFE_FENCE_CHUNKER_VERSION};
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::facts::{OwnerOnlySources, PrivacyPolicy, page_hidden_with};
use crate::kv::KvRead;
use crate::pages::PageRecord;
use crate::sources::read_source;
use crate::timeline_queries::jsonb_field_text;
use crate::trust::{TrustTier, activation_suppressed};

/// The `text_projection_revision` the v153 activation leaves on a page whose pre-upgrade index it
/// keeps serving (`servedTextProjectionFilter`, search/safe-chunks.ts).
const ACTIVATION_SERVED_REVISION: &str = "00000000-0000-0000-0000-000000000153";

/// Frontmatter keys whose presence hides a page from search (`buildVisibilityClause`).
const HIDING_FRONTMATTER_KEYS: [&str; 2] = ["quarantine", "pinned_question"];

/// A date bound: `COALESCE(effective_date, updated_at, created_at) > | >= | < | <= $bound`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DateBound {
    /// UTC microseconds, as decimal text (N-API passes large numbers as doubles).
    pub micros: String,
    #[serde(default)]
    pub inclusive: bool,
}

/// The keyset resume point of `searchKeywordPages`: rows after `(score, pageId)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AfterKey {
    pub score: f64,
    pub page_id: f64,
}

/// Options of the keyword members, resolved by the TypeScript member.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct KeywordOptions {
    /// Row limit. `searchKeywordChunks`: already clamped. `searchKeywordPages`: the window's
    /// limit; `None` is no limit.
    pub limit: Option<f64>,
    /// Rows skipped before the limit.
    pub offset: Option<f64>,
    /// `detail === 'low'`: compiled-truth chunks only.
    pub detail_low: bool,
    /// The chunk's `language`.
    pub language: Option<String>,
    /// The chunk's `symbol_type`.
    pub symbol_kind: Option<String>,
    /// `p.type = $type`.
    #[serde(rename = "type")]
    pub page_type: Option<String>,
    /// `p.type = ANY($types)`, applied with `type`.
    pub types: Option<Vec<String>>,
    /// Frontmatter containment: every entry must hold; an entry holds when the field equals one
    /// of its values or is a list holding one of them.
    #[serde(rename = "where")]
    pub where_fields: Vec<(String, Vec<Value>)>,
    /// `p.slug != ALL($exclude_slugs)`.
    pub exclude_slugs: Vec<String>,
    pub after_date: Option<DateBound>,
    pub before_date: Option<DateBound>,
    /// `p.source_id = ANY($sources)`.
    pub sources: Option<Vec<String>>,
    /// Slug prefixes that hide a page.
    pub hard_excludes: Vec<String>,
    /// `[prefix, factor]`, longest prefix first; empty for a factor of 1.
    pub boosts: Vec<(String, f64)>,
    /// `keywordPhrase === true`: a chunk holding the query as a phrase ranks twice as high.
    pub phrase: bool,
    /// Slug handles of the query: a page whose slug basename is one matches on every chunk.
    pub handles: Vec<String>,
    /// `searchKeywordPages`' keyset.
    pub after: Option<AfterKey>,
    /// `searchKeywordPages`: only the handle arm (`buildKeywordHandlePagesStatement`, the keyword
    /// arm's rows for the pages the query's slug handles name).
    pub handles_only: bool,
    /// `searchKeyword`: the per-page candidates kept before the window (`LIMIT $2`, 3x the limit).
    pub inner_limit: Option<f64>,
    /// `excludePrivate`: the store page policy (`storePagePolicy`) that `privatePagesFilterForCaller(p)`
    /// renders, applied by `facts/privacy.rs` `page_hidden`; `null` when the read does not ask for it.
    pub exclude_private: Option<PrivacyPolicy>,
    /// `requiresSafeChunks(opts)`: only pages past the chunker-version fence (`safeChunksFilter(p)`).
    /// An `excludePrivate` read asks for it unless it says otherwise.
    pub require_safe_chunks: bool,
    /// `minTrust`: the trust floor (`trustFloorSql(p)`), a page's stamped tier at or above it.
    /// `null` or empty keeps every tier; a name that is no tier refuses.
    pub min_trust: Option<String>,
    /// `suppressFlagged`: drops a page `activationSuppressedSql('pages', p)` suppresses, a page at or
    /// below `agent_written` that holds a `flag` receipt in an activation reason family.
    pub suppress_flagged: bool,
    /// `countKeywordPages` and `searchKeywordPages` on a CJK query: the match terms
    /// (`cjkMatchTerms`), matched with `LIKE` / `ILIKE` in place of the text search, with no
    /// handle arm (`keyword/cjk.rs`).
    pub cjk_terms: Option<Vec<CjkTerm>>,
}

/// A parsed date bound.
pub(super) struct Bound {
    micros: i64,
    inclusive: bool,
}

/// A read's parsed `afterDate` and `beforeDate`. A page is dated by its `effective_date`, else its
/// `updated_at` (the SQL's `created_at` arm is never reached: a page row always has `updated_at`).
pub(crate) struct DateWindow {
    after: Option<Bound>,
    before: Option<Bound>,
}

impl DateWindow {
    pub(crate) fn parse(after: Option<&DateBound>, before: Option<&DateBound>) -> Result<Self> {
        Ok(Self {
            after: Bound::parse(after, "afterDate")?,
            before: Bound::parse(before, "beforeDate")?,
        })
    }

    /// `dateBound('>' | '>=', afterDate)` and `dateBound('<' | '<=', beforeDate)`.
    pub(crate) fn admits(&self, page: &PageRecord) -> bool {
        let dated = page.effective_date_us.unwrap_or(page.updated_at_us);
        let after = self.after.as_ref().is_none_or(|b| {
            if b.inclusive {
                dated >= b.micros
            } else {
                dated > b.micros
            }
        });
        let before = self.before.as_ref().is_none_or(|b| {
            if b.inclusive {
                dated <= b.micros
            } else {
                dated < b.micros
            }
        });
        after && before
    }
}

impl Bound {
    pub(super) fn parse(bound: Option<&DateBound>, what: &str) -> Result<Option<Self>> {
        bound
            .map(|b| {
                let micros = b.micros.trim().parse::<i64>().map_err(|_| {
                    StoreError::invalid(format!("{what}: not a microsecond count: {:?}", b.micros))
                })?;
                Ok(Self {
                    micros,
                    inclusive: b.inclusive,
                })
            })
            .transpose()
    }
}

/// `safeChunksFilter(p)`: `chunker_version >= SAFE_FENCE_CHUNKER_VERSION`. A page that records no
/// version fails it, as NULL fails the SQL comparison.
fn safe_chunks(page: &PageRecord) -> bool {
    page.chunker_version
        .is_some_and(|v| v >= SAFE_FENCE_CHUNKER_VERSION)
}

/// The read's trust floor (`trustFloorSql`): none when unset or empty, and a refusal for a name
/// that is no tier.
fn trust_floor(o: &KeywordOptions) -> Result<Option<TrustTier>> {
    parse_trust_floor(o.min_trust.as_deref())
}

/// A `minTrust` name as a trust floor: none when unset or empty, and a refusal for a name that is
/// no tier.
pub(crate) fn parse_trust_floor(name: Option<&str>) -> Result<Option<TrustTier>> {
    match name {
        None | Some("") => Ok(None),
        Some(name) => TrustTier::parse(name).map(Some).ok_or_else(|| {
            StoreError::invalid(format!("minTrust: \"{name}\" names no trust tier"))
        }),
    }
}

/// The page-level predicates, with the source table read once per source.
pub(super) struct PageFilter<'a> {
    options: &'a KeywordOptions,
    dates: DateWindow,
    live_sources: HashMap<String, bool>,
    /// The owner-only sources, read on the first page `exclude_private` judges.
    owner_only: Option<OwnerOnlySources>,
}

impl<'a> PageFilter<'a> {
    pub(super) fn new(options: &'a KeywordOptions) -> Result<Self> {
        Ok(Self {
            options,
            dates: DateWindow::parse(options.after_date.as_ref(), options.before_date.as_ref())?,
            live_sources: HashMap::new(),
            owner_only: None,
        })
    }

    /// Every page predicate of `keywordFilters` and `buildVisibilityClause`.
    pub(super) fn keeps(&mut self, read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
        let o = self.options;
        if page.deleted_at_us.is_some()
            || !served(page)
            || (o.require_safe_chunks && !safe_chunks(page))
            || HIDING_FRONTMATTER_KEYS
                .iter()
                .any(|key| page.frontmatter.contains_key(*key))
        {
            return Ok(false);
        }
        if let Some(policy) = &o.exclude_private {
            if self.owner_only.is_none() {
                self.owner_only = Some(OwnerOnlySources::read(read)?);
            }
            if let Some(owner_only) = &self.owner_only
                && page_hidden_with(read, page, policy, owner_only)?
            {
                return Ok(false);
            }
        }
        if o.page_type.as_ref().is_some_and(|t| *t != page.page_type)
            || o.types
                .as_ref()
                .is_some_and(|ts| !ts.contains(&page.page_type))
            || o.exclude_slugs.contains(&page.slug)
            || o.sources
                .as_ref()
                .is_some_and(|s| !s.contains(&page.source_id))
            || o.hard_excludes
                .iter()
                .any(|p| !p.is_empty() && page.slug.starts_with(p.as_str()))
            || !o
                .where_fields
                .iter()
                .all(|(key, values)| frontmatter_holds(&page.frontmatter, key, values))
        {
            return Ok(false);
        }
        if !self.dates.admits(page) {
            return Ok(false);
        }
        // `JOIN sources s ... AND NOT s.archived`: a page whose source row is gone drops too.
        let live = match self.live_sources.get(&page.source_id) {
            Some(live) => *live,
            None => {
                let live = read_source(read, &page.source_id)?.is_some_and(|s| !s.archived);
                self.live_sources.insert(page.source_id.clone(), live);
                live
            }
        };
        if !live {
            return Ok(false);
        }
        // `pageEligibleSql(p)`: the trust floor, then the flagged-page filter.
        let tier = TrustTier::stored(page.trust_tier.as_deref());
        if let Some(floor) = trust_floor(o)?
            && tier.rank() < floor.rank()
        {
            return Ok(false);
        }
        Ok(!(o.suppress_flagged && activation_suppressed(read, "pages", page.id, tier)?))
    }

    /// The chunk predicates: `detail` low, `language`, `symbolKind`.
    pub(super) fn keeps_chunk(&self, chunk: &ChunkRecord) -> bool {
        let o = self.options;
        (!o.detail_low || chunk.chunk_source == "compiled_truth")
            && o.language
                .as_ref()
                .is_none_or(|l| meta_text(&chunk.meta, "language").as_deref() == Some(l))
            && o.symbol_kind
                .as_ref()
                .is_none_or(|k| meta_text(&chunk.meta, "symbol_type").as_deref() == Some(k))
    }
}

/// `servedTextProjectionFilter`: the page's text projection is current, or the activation
/// sentinel.
pub(crate) fn served(page: &PageRecord) -> bool {
    match page.text_projection_revision.as_deref() {
        Some(r) => r == page.knowledge_revision || r == ACTIVATION_SERVED_REVISION,
        None => false,
    }
}

/// A text column kept in chunk metadata (`cc.language`, `cc.symbol_type`, ...).
fn meta_text(meta: &Map<String, Value>, key: &str) -> Option<String> {
    meta.get(key).and_then(Value::as_str).map(str::to_string)
}

/// jsonb equality of two scalars: numbers compare by value.
fn jsonb_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

/// `frontmatter @> {key: v} OR frontmatter @> {key: [v]}` for any `v` of `values`.
pub(crate) fn frontmatter_holds(
    frontmatter: &Map<String, Value>,
    key: &str,
    values: &[Value],
) -> bool {
    let Some(field) = frontmatter.get(key) else {
        return false;
    };
    values.iter().any(|v| match field {
        Value::Array(items) => items.iter().any(|item| jsonb_eq(item, v)),
        other => jsonb_eq(other, v),
    })
}

/// `buildSourceFactorCase`: 1 for an unverified auto-extracted page, else the factor of the
/// first (longest) prefix the slug starts with, else 1.
pub(super) fn source_factor(page: &PageRecord, boosts: &[(String, f64)]) -> f64 {
    if boosts.is_empty() {
        return 1.0;
    }
    let field = |key: &str| page.frontmatter.get(key).and_then(jsonb_field_text);
    if field("provenance").as_deref() == Some("auto-extracted")
        && field("status").as_deref() == Some("unverified")
    {
        return 1.0;
    }
    boosts
        .iter()
        .find(|(prefix, _)| page.slug.starts_with(prefix.as_str()))
        .map_or(1.0, |(_, factor)| *factor)
}

/// The chunk's `search_vector` (`update_chunk_search_vector`): doc comment and qualified symbol
/// name at weight A, the chunk text at weight B. Cached by those texts (`vector_cache`).
pub(super) fn chunk_vector(chunk: &ChunkRecord) -> Result<Arc<TsVector>> {
    let text = |key: &str| chunk.meta.get(key).and_then(Value::as_str).unwrap_or("");
    let (doc, symbol) = (text("doc_comment"), text("symbol_name_qualified"));
    cached(VectorKind::Chunk, &[doc, symbol, &chunk.chunk_text], || {
        let part = |text: &str, weight: Weight| -> Result<TsVector> {
            Ok(setweight(to_tsvector(&fts_input(text))?, weight))
        };
        let head = concat(&part(doc, Weight::A)?, &part(symbol, Weight::A)?)?;
        concat(&head, &part(&chunk.chunk_text, Weight::B)?)
    })
}

/// The chunk's vector as a search reads it, or `None` for a chunk whose vector cannot be built (a text past the
/// tsvector size cap). SQL never stores such a chunk (its trigger raises in the write, and `check_chunk_vector` raises
/// the same here), but a store written before that check may hold one. It matches nothing; it must not fail the searches
/// that pass over it.
pub(super) fn readable_chunk_vector(chunk: &ChunkRecord) -> Option<Arc<TsVector>> {
    chunk_vector(chunk).ok()
}

/// `[[:space:]]` in a Postgres regular expression.
fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\x0B' | '\x0C' | '\r')
}

/// The `SearchResult` row the keyword statements select, before `rowToSearchResult`.
pub(super) fn result_row(page: &PageRecord, chunk: &ChunkRecord, score: f64, stale: bool) -> Value {
    let field = |key: &str| page.frontmatter.get(key).and_then(jsonb_field_text);
    let message_id = field("message_id").filter(|m| !m.trim_matches(is_space).is_empty());
    let source_subject = message_id
        .as_ref()
        .and_then(|_| field("subject"))
        .filter(|s| !s.is_empty());
    json!({
        "slug": page.slug,
        "page_id": page.id,
        "title": page.title,
        "type": page.page_type,
        "source_id": page.source_id,
        "effective_date": page.effective_date_us.map(iso),
        "effective_date_source": page.effective_date_source,
        "message_id": message_id,
        "thread_id": field("thread_id"),
        "source_subject": source_subject,
        "chunk_id": chunk.id,
        "chunk_index": chunk.chunk_index,
        "chunk_text": chunk.chunk_text,
        "chunk_source": chunk.chunk_source,
        "score": score,
        "stale": stale,
    })
}

/// A whole-number row count, as LIMIT/OFFSET take it.
pub(super) fn row_count(value: f64, what: &str) -> Result<usize> {
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(StoreError::invalid(format!(
            "invalid input syntax for type bigint: \"{value}\""
        )));
    }
    if value < 0.0 {
        return Err(StoreError::invalid(format!("{what} must not be negative")));
    }
    Ok(value.min(usize::MAX as f64) as usize)
}
