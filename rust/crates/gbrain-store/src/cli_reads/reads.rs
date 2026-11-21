//! The read-command statements of `src/core/engine-sql/cli-reads-ops.ts`: one batch of the exact
//! phrase scan, the next live page of the scan, the whois candidates, the rank_entities rows and the
//! extraction-pending pages. PGLite and Postgres run SQL; these answer the same rows, in the same
//! order and types, from the store's records.
//!
//! What the store does not keep, and what each read answers for it (rust/docs/store/cli-reads-ops.md):
//! - no page_aliases rows: the whois alias arm finds nothing;
//! - no `body_storage` / `body_bytes`: a page has body text when `compiled_truth` or `timeline` is
//!   not empty;
//! - no private visibility, trust tier or safe-chunk fence: the TypeScript members refuse the
//!   options that need them (`excludePrivate`, `minTrust`, a remote exact scan).
//!
//! Keys: none of its own. It reads the page, page-id, chunk, link and source records.

use super::pg_text::{
    btrim, fm_text, fm_value, is_pg_space, like_contains, pg_lower, regex_char_matches,
    timestamptz_text,
};
use crate::alias_fanout_reads::reject_nul;
use crate::aliases::alias_row_slugs;
use crate::chunks::SAFE_FENCE_CHUNKER_VERSION;
use crate::chunks::{read_chunks, read_segment_view};
use crate::error::{INVALID_ARGUMENT, Result, STORE_CORRUPT, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::kv::KvRead;
use crate::links::out_links;
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::sources::read_source;
use crate::{Store, keys};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// `ACTIVATION_SERVED_REVISION` of `src/core/search/safe-chunks.ts`.
const ACTIVATION_SERVED_REVISION: &str = "00000000-0000-0000-0000-000000000153";
/// `EXACT_SNIPPET_CONTEXT` and `EXACT_SNIPPETS_PER_PAGE` of `src/core/search/exact-scan.ts`.
const SNIPPET_CONTEXT: usize = 80;
const SNIPPETS_PER_PAGE: usize = 3;
/// `MAX_RETIREMENT_HOPS` of `src/core/entities/resolve.ts`.
const MAX_RETIREMENT_HOPS: u32 = 5;
/// `NON_RANKING_LINK_TYPES` of `src/core/link-ranking-policy.ts`.
const NON_RANKING_LINK_TYPES: &[&str] = &["amends"];

// ---------------------------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------------------------

/// `servedTextProjectionFilter`: the current projection, or the pre-activation marker.
pub(super) fn served(page: &PageRecord) -> bool {
    match page.text_projection_revision.as_deref() {
        Some(rev) => rev == page.knowledge_revision || rev == ACTIVATION_SERVED_REVISION,
        None => false,
    }
}

pub(super) fn has_key(page: &PageRecord, key: &str) -> bool {
    page.frontmatter.contains_key(key)
}

/// A PG `LIMIT` / `OFFSET` value.
fn row_count(value: i64, what: &str) -> Result<usize> {
    usize::try_from(value)
        .map_err(|_| StoreError::new(INVALID_ARGUMENT, format!("{what} must not be negative")))
}

/// Source archive flags, read once per source. A page whose source is missing is not joined.
pub(super) struct Sources<'a> {
    read: &'a dyn KvRead,
    archived: HashMap<String, Option<bool>>,
}

impl<'a> Sources<'a> {
    pub(super) fn new(read: &'a dyn KvRead) -> Self {
        Self {
            read,
            archived: HashMap::new(),
        }
    }

    /// `Some(archived)` for an existing source, `None` for a missing one.
    fn archived(&mut self, id: &str) -> Result<Option<bool>> {
        if let Some(known) = self.archived.get(id) {
            return Ok(*known);
        }
        let flag = read_source(self.read, id)?.map(|s| s.archived);
        self.archived.insert(id.to_string(), flag);
        Ok(flag)
    }

    /// `JOIN sources s ... AND NOT s.archived`.
    pub(super) fn live(&mut self, id: &str) -> Result<bool> {
        Ok(self.archived(id)? == Some(false))
    }
}

/// Walks the page-id index from `after + 1` in id order until `f` returns false. Ids are read in
/// slices so the callback can read other records between scans.
pub(super) fn pages_after(
    read: &dyn KvRead,
    after: i64,
    f: &mut dyn FnMut(PageRecord) -> Result<bool>,
) -> Result<()> {
    const SLICE: usize = 256;
    let mut next = match u64::try_from(after) {
        Ok(u64::MAX) => return Ok(()),
        Ok(a) => a + 1,
        Err(_) => 0,
    };
    loop {
        let mut ids = Vec::with_capacity(SLICE);
        let mut malformed = false;
        read.scan(
            &keys::page_id(next),
            &[keys::PAGE_ID + 1],
            false,
            &mut |k, _| {
                match k.get(1..).and_then(keys::be8) {
                    Some(id) if k.len() == 9 => ids.push(id),
                    _ => malformed = true,
                }
                !malformed && ids.len() < SLICE
            },
        )?;
        if malformed {
            return Err(StoreError::new(
                STORE_CORRUPT,
                "a page id key is malformed".to_string(),
            ));
        }
        let full = ids.len() == SLICE;
        for id in ids {
            let Some(page) = read_page_by_id(read, id)? else {
                continue;
            };
            if !f(page)? {
                return Ok(());
            }
            next = id.saturating_add(1);
        }
        if !full || next == u64::MAX {
            return Ok(());
        }
    }
}

/// `EntityTypeFilter` of `src/core/schema-pack/entity-types.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct EntityTypeFilter {
    pub types: Vec<String>,
    pub per_source: Vec<SourceTypes>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SourceTypes {
    pub source_id: String,
    pub types: Vec<String>,
}

impl EntityTypeFilter {
    /// `entityTypePredicateSql`: the first per-source list naming the page's source, else `types`.
    fn admits(&self, page: &PageRecord) -> bool {
        let list = self
            .per_source
            .iter()
            .find(|b| b.source_id == page.source_id)
            .map_or(&self.types, |b| &b.types);
        list.contains(&page.page_type)
    }
}

/// `remote: { excludePrivate, policy }` of the whois and rank_entities statements. With
/// `exclude_private`, `policy` is the page policy the TypeScript member read from the rendered
/// `privatePagesFilterForCaller` fragment (private-provenance.ts `storePagePolicy`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RemoteCaller {
    pub exclude_private: bool,
    /// The caller's page policy (`privatePagesFilterForCaller('p')`) when the member serves
    /// `excludePrivate`. `exclude_private` with no policy refuses.
    pub policy: Option<PrivacyPolicy>,
}

/// The page policy a remote read applies, or None when it reads no private filter. A read that
/// asks for `exclude_private` with no policy is refused: the store never guesses the caller.
fn private_policy<'a>(
    remote: &'a Option<RemoteCaller>,
    member: &str,
) -> Result<Option<&'a PrivacyPolicy>> {
    match remote {
        Some(r) if r.exclude_private => r.policy.as_ref().map(Some).ok_or_else(|| {
            StoreError::new(
                INVALID_ARGUMENT,
                format!("{member}: excludePrivate needs the caller's page policy"),
            )
        }),
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------------------------
// The exact phrase scan
// ---------------------------------------------------------------------------------------------

/// One batch of the exact phrase scan. `words` and `longest` are `phrasePattern`'s words (split on
/// JavaScript whitespace) and its first longest word, computed by the caller.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExactBatchInput {
    pub words: Vec<String>,
    pub longest: String,
    pub case_sensitive: bool,
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub types: Option<Vec<String>>,
    pub slug_prefix: Option<String>,
    pub exclude_slug_prefixes: Vec<String>,
    pub after: i64,
    pub batch_pages: i64,
    /// `remote`: match only chunks past the chunker-version fence (`safeChunksFilter(p)`), and
    /// report a page below it with no match as `unsealed`.
    pub remote: bool,
    /// `excludePrivate`: the caller's page policy (`storePagePolicy` with caller readers).
    pub exclude_private: Option<PrivacyPolicy>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExactSnippet {
    pub chunk_index: u32,
    pub chunk_source: String,
    pub text: String,
}

/// `ExactBatchRow` of `src/core/search/exact-scan.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExactBatchRow {
    pub page_id: u64,
    pub slug: String,
    pub source_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub matching_chunks: Option<u32>,
    pub snippets: Option<Vec<ExactSnippet>>,
    pub gap: Option<&'static str>,
}

enum Token {
    Char(char),
    Space,
}

/// The phrase ARE `w1[[:space:]]+w2...`, each word a literal.
struct Phrase {
    tokens: Vec<Token>,
    case_sensitive: bool,
}

impl Phrase {
    fn new(words: &[String], case_sensitive: bool) -> Self {
        let mut tokens = Vec::new();
        for (i, word) in words.iter().enumerate() {
            if i > 0 {
                tokens.push(Token::Space);
            }
            tokens.extend(word.chars().map(Token::Char));
        }
        Self {
            tokens,
            case_sensitive,
        }
    }

    /// Every end of a phrase match that starts at `start`, ascending.
    fn ends_at(&self, text: &[char], start: usize) -> Vec<usize> {
        let mut at: Vec<usize> = vec![start];
        for token in &self.tokens {
            let mut next = BTreeSet::new();
            for &p in &at {
                match token {
                    Token::Char(c) => {
                        if p < text.len() && regex_char_matches(*c, text[p], self.case_sensitive) {
                            next.insert(p + 1);
                        }
                    }
                    Token::Space => {
                        let mut q = p;
                        while q < text.len() && is_pg_space(text[q]) {
                            q += 1;
                            next.insert(q);
                        }
                    }
                }
            }
            if next.is_empty() {
                return Vec::new();
            }
            at = next.into_iter().collect();
        }
        at
    }

    /// `regexp_match(text, '.{0,80}' || phrase || '.{0,80}')`: the leftmost-longest match, or
    /// `None` when `text ~ phrase` is false.
    fn snippet(&self, text: &str) -> Option<String> {
        let chars: Vec<char> = text.chars().collect();
        let first = (0..=chars.len()).find(|&s| !self.ends_at(&chars, s).is_empty())?;
        let start = first.saturating_sub(SNIPPET_CONTEXT);
        let last_start = (start + SNIPPET_CONTEXT).min(chars.len());
        let mut end = 0;
        for s in first..=last_start {
            if let Some(&e) = self.ends_at(&chars, s).last() {
                end = end.max((e + SNIPPET_CONTEXT).min(chars.len()));
            }
        }
        Some(chars[start..end].iter().collect())
    }
}

// ---------------------------------------------------------------------------------------------
// whois candidates
// ---------------------------------------------------------------------------------------------

/// `ExactIdentityProbes` of `src/core/engine-sql/exact-identity.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExactIdentityProbes {
    pub title_keys: Vec<String>,
    pub title_raw: String,
    pub basenames: Vec<String>,
    pub alias_keys: Vec<String>,
    pub emails: Vec<String>,
    /// Digit strings a stored `phone` / `phones` value may reduce to.
    pub phones: Vec<String>,
}

/// `ExactIdentityStatementOpts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExactIdentityInput {
    pub probes: ExactIdentityProbes,
    pub source_ids: Vec<String>,
    pub types: EntityTypeFilter,
    pub remote: Option<RemoteCaller>,
    /// Probe only the email, basename and alias arms: no title arm, no phone arm.
    pub emails_only: bool,
    pub limit: i64,
}

/// `ExactIdentityRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExactIdentityRow {
    pub slug: String,
    pub source_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub email: Value,
    pub emails: Value,
    pub phone: Value,
    pub phones: Value,
    pub aliases: Value,
}

/// The phone arm: `frontmatter ? key`, then each element of the value (a scalar counts as a list
/// of one) as `jsonb_array_elements_text` writes it, reduced to its digits, equals a probe.
fn holds_phone(frontmatter: &Map<String, Value>, key: &str, digits: &[String]) -> bool {
    let reduce = |v: &Value| -> Option<String> {
        let text = match v {
            Value::Null => return None,
            Value::String(s) => s.clone(),
            other => crate::jsonb::order(other.clone()).to_string(),
        };
        Some(text.chars().filter(char::is_ascii_digit).collect())
    };
    let elements: Vec<&Value> = match frontmatter.get(key) {
        None => return false,
        Some(Value::Array(items)) => items.iter().collect(),
        Some(v) => vec![v],
    };
    elements
        .into_iter()
        .filter_map(reduce)
        .any(|d| digits.contains(&d))
}

/// `frontmatter @> {key: v}` or `frontmatter @> {key: [v]}`.
fn holds_email(frontmatter: &Map<String, Value>, key: &str, email: &str) -> bool {
    match frontmatter.get(key) {
        Some(Value::String(s)) => s == email,
        Some(Value::Array(items)) => items.iter().any(|i| i.as_str() == Some(email)),
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------------
// rank_entities
// ---------------------------------------------------------------------------------------------

/// `RankEntitiesStatementOpts` of `src/core/engine-sql/graph-rank.ts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RankEntitiesInput {
    pub direction: String,
    pub types: EntityTypeFilter,
    pub source_ids: Option<Vec<String>>,
    pub link_type: Option<String>,
    pub include_mentions: bool,
    pub limit: i64,
    pub folded_cap: i64,
    pub remote: Option<RemoteCaller>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FoldedEntry {
    pub slug: String,
    pub reason: &'static str,
}

/// `RankEntityRow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RankEntityRow {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub source_id: String,
    pub inbound: i64,
    pub outbound: i64,
    pub neighbors: i64,
    pub folded_total: i64,
    pub folded: Option<Vec<FoldedEntry>>,
}

/// `retiredPageSql`: canonical false/no, a superseded_by or merged_into value, or an alias /
/// redirect status word.
fn retired(fm: &Map<String, Value>) -> bool {
    let canonical = pg_lower(&fm_text(fm, "canonical").unwrap_or_default());
    canonical == "false"
        || canonical == "no"
        || !btrim(&fm_text(fm, "superseded_by").unwrap_or_default()).is_empty()
        || !btrim(&fm_text(fm, "merged_into").unwrap_or_default()).is_empty()
        || status_says_redirect(&pg_lower(&fm_text(fm, "status").unwrap_or_default()))
}

/// `status ~ '(^|[^a-z])(alias|redirect|redirected)([^a-z]|$)'` on the lowered status.
fn status_says_redirect(status: &str) -> bool {
    let chars: Vec<char> = status.chars().collect();
    let boundary = |c: Option<&char>| c.is_none_or(|c| !c.is_ascii_lowercase());
    (0..chars.len()).any(|i| {
        (i == 0 || boundary(chars.get(i - 1)))
            && ["alias", "redirect", "redirected"].iter().any(|word| {
                let w: Vec<char> = word.chars().collect();
                chars.get(i..i + w.len()) == Some(&w[..]) && boundary(chars.get(i + w.len()))
            })
    })
}

/// `REDIRECT_TARGET_SQL`: the superseded_by (else merged_into) value as a slug.
fn redirect_target(fm: &Map<String, Value>) -> String {
    let field = |key: &str| {
        fm_text(fm, key)
            .map(|v| btrim(&v).to_string())
            .filter(|v| !v.is_empty())
    };
    let value = field("superseded_by")
        .or_else(|| field("merged_into"))
        .unwrap_or_default();
    let value = value.strip_prefix("[[").unwrap_or(&value);
    let value = value.strip_suffix("]]").unwrap_or(value);
    let value = btrim(value.split('|').next().unwrap_or(""));
    let value = match value.len().checked_sub(3) {
        Some(cut) if value.is_char_boundary(cut) && value[cut..].eq_ignore_ascii_case(".md") => {
            &value[..cut]
        }
        _ => value,
    };
    value.trim_start_matches('/').to_string()
}

/// `FOLD_REASON_SQL`.
fn fold_reason(fm: &Map<String, Value>) -> &'static str {
    if btrim(&fm_text(fm, "superseded_by").unwrap_or_default()).is_empty() {
        "merged_into"
    } else {
        "superseded_by"
    }
}

// ---------------------------------------------------------------------------------------------
// extraction_pending
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtractionPendingInput {
    pub source_ids: Option<Vec<String>>,
    pub source_id: Option<String>,
    pub limit: i64,
    pub offset: i64,
}

/// `ExtractionPendingRow` of `src/core/engine-sql/cli-reads-ops.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExtractionPendingRow {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub source_id: String,
    pub extracted_from: Option<String>,
    pub created_at: String,
}

/// `{ id, slug, source_id }` of `nextLivePageAfter`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LivePageRef {
    pub id: u64,
    pub slug: String,
    pub source_id: String,
}

impl Store {
    /// `scanExactBatch`: the next `batch_pages` pages in scope after `after`, in id order, each with
    /// its matching chunks or why its text could not be read. `None` when the phrase has no word.
    pub fn scan_exact_batch(&self, input: &ExactBatchInput) -> Result<Option<Vec<ExactBatchRow>>> {
        if input.words.is_empty() {
            return Ok(None);
        }
        let limit = row_count(input.batch_pages, "LIMIT")?;
        let read = self.read()?;
        let mut sources = Sources::new(&*read);
        let scope: Option<&Vec<String>> = match (&input.source_ids, &input.source_id) {
            (Some(ids), _) if !ids.is_empty() => Some(ids),
            _ => None,
        };
        let one_source = input
            .source_id
            .as_deref()
            .filter(|s| !s.is_empty() && scope.is_none());
        let types = input.types.as_ref().filter(|t| !t.is_empty());
        let prefix = input.slug_prefix.as_deref().filter(|p| !p.is_empty());
        let mut batch = Vec::new();
        if limit > 0 {
            pages_after(&*read, input.after, &mut |page| {
                let in_scope = page.deleted_at_us.is_none()
                    && !has_key(&page, "quarantine")
                    && !has_key(&page, "pinned_question")
                    && scope.is_none_or(|ids| ids.contains(&page.source_id))
                    && one_source.is_none_or(|s| s == page.source_id)
                    && types.is_none_or(|t| t.contains(&page.page_type))
                    && prefix.is_none_or(|p| page.slug.starts_with(p))
                    && !input
                        .exclude_slug_prefixes
                        .iter()
                        .any(|p| !p.is_empty() && page.slug.starts_with(p.as_str()));
                if in_scope
                    && sources.live(&page.source_id)?
                    && match &input.exclude_private {
                        Some(policy) => !page_hidden(&*read, &page, policy)?,
                        None => true,
                    }
                {
                    batch.push(page);
                }
                Ok(batch.len() < limit)
            })?;
        }
        let phrase = Phrase::new(&input.words, input.case_sensitive);
        let mut rows = Vec::with_capacity(batch.len());
        for page in batch {
            let generation = read_segment_view(&*read, page.id)?.generation;
            let visible: Vec<_> = if served(&page) {
                read_chunks(&*read, page.id)?
                    .into_iter()
                    .filter(|c| c.visible_at(generation))
                    .collect()
            } else {
                Vec::new()
            };
            // `safeChunksFilter(p)`; a record with no version is below the fence (Postgres stores 1).
            let sealed = page.chunker_version.unwrap_or(0) >= SAFE_FENCE_CHUNKER_VERSION;
            let mut count = 0u32;
            let mut snippets = Vec::new();
            for chunk in visible.iter().filter(|_| sealed || !input.remote) {
                if !like_contains(&chunk.chunk_text, &input.longest, input.case_sensitive) {
                    continue;
                }
                let Some(text) = phrase.snippet(&chunk.chunk_text) else {
                    continue;
                };
                count += 1;
                if snippets.len() < SNIPPETS_PER_PAGE {
                    snippets.push(ExactSnippet {
                        chunk_index: chunk.chunk_index,
                        chunk_source: chunk.chunk_source.clone(),
                        text,
                    });
                }
            }
            let has_body = !page.compiled_truth.is_empty() || !page.timeline.is_empty();
            let gap = if count > 0 {
                None
            } else if input.remote && !sealed {
                Some("unsealed")
            } else if !served(&page) {
                Some("projection_pending")
            } else if visible.is_empty() && has_body {
                Some("unchunked")
            } else {
                None
            };
            rows.push(ExactBatchRow {
                page_id: page.id,
                slug: page.slug,
                source_id: page.source_id,
                title: page.title,
                page_type: page.page_type,
                matching_chunks: (count > 0).then_some(count),
                snippets: (count > 0).then_some(snippets),
                gap,
            });
        }
        Ok(Some(rows))
    }

    /// `nextLivePageAfter`: the first live page after `after` in id order, in any source.
    pub fn next_live_page_after(&self, after: i64) -> Result<Option<LivePageRef>> {
        let read = self.read()?;
        let mut found = None;
        pages_after(&*read, after, &mut |page| {
            if page.deleted_at_us.is_none() {
                found = Some(LivePageRef {
                    id: page.id,
                    slug: page.slug,
                    source_id: page.source_id,
                });
                return Ok(false);
            }
            Ok(true)
        })?;
        Ok(found)
    }

    /// `listExactIdentityCandidates`: pages matching a title, slug-basename, page-alias or email
    /// probe inside `source_ids`, by (source_id, slug). A probe or source id holding a NUL byte is
    /// refused, as Postgres refuses it in a text parameter.
    pub fn list_exact_identity_candidates(
        &self,
        input: &ExactIdentityInput,
    ) -> Result<Vec<ExactIdentityRow>> {
        const MEMBER: &str = "listExactIdentityCandidates";
        let policy = private_policy(&input.remote, MEMBER)?;
        let limit = row_count(input.limit, "LIMIT")?;
        let probes = &input.probes;
        reject_nul(
            MEMBER,
            [&probes.title_raw]
                .into_iter()
                .chain(&probes.title_keys)
                .chain(&probes.basenames)
                .chain(&probes.alias_keys)
                .chain(&probes.emails)
                .chain(&probes.phones)
                .chain(&input.source_ids)
                .map(String::as_str),
        )?;
        let read = self.read()?;
        let mut sources = Sources::new(&*read);
        let raw_key = pg_lower(&probes.title_raw);
        // The title arm runs only with a title key or a raw title; a contact match never matches names.
        let title_arm =
            !input.emails_only && (!probes.title_keys.is_empty() || !probes.title_raw.is_empty());
        let phone_arm = !input.emails_only && !probes.phones.is_empty();
        // The alias arm: `page_aliases.alias_norm = key` joined to the page at the row's slug.
        let mut aliased: BTreeSet<(String, String)> = BTreeSet::new();
        for source in &input.source_ids {
            for alias in &probes.alias_keys {
                for slug in alias_row_slugs(&*read, source, alias)? {
                    aliased.insert((source.clone(), slug));
                }
            }
        }
        let mut found: BTreeMap<(Vec<u8>, Vec<u8>), ExactIdentityRow> = BTreeMap::new();
        for page in all_pages(&*read)? {
            if !input.source_ids.contains(&page.source_id) {
                continue;
            }
            let title = pg_lower(&page.title);
            let basename = page.slug.rsplit('/').next().unwrap_or("");
            let hit = (title_arm && (title == raw_key || probes.title_keys.contains(&title)))
                || (phone_arm
                    && (holds_phone(&page.frontmatter, "phone", &probes.phones)
                        || holds_phone(&page.frontmatter, "phones", &probes.phones)))
                || probes.basenames.iter().any(|b| b == basename)
                || aliased.contains(&(page.source_id.clone(), page.slug.clone()))
                || probes.emails.iter().any(|e| {
                    holds_email(&page.frontmatter, "email", e)
                        || holds_email(&page.frontmatter, "emails", e)
                });
            if !hit
                || page.deleted_at_us.is_some()
                || sources.archived(&page.source_id)? != Some(false)
                || !input.types.admits(&page)
                || (input.remote.is_some() && has_key(&page, "quarantine"))
            {
                continue;
            }
            // The privacy filter is a WHERE clause: it runs before LIMIT.
            if let Some(policy) = policy
                && page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            let key = (
                page.source_id.clone().into_bytes(),
                page.slug.clone().into_bytes(),
            );
            found.insert(
                key,
                ExactIdentityRow {
                    email: fm_value(&page.frontmatter, "email"),
                    emails: fm_value(&page.frontmatter, "emails"),
                    phone: fm_value(&page.frontmatter, "phone"),
                    phones: fm_value(&page.frontmatter, "phones"),
                    aliases: fm_value(&page.frontmatter, "aliases"),
                    slug: page.slug,
                    source_id: page.source_id,
                    title: page.title,
                    page_type: page.page_type,
                },
            );
        }
        Ok(found.into_values().take(limit).collect())
    }

    /// `rankEntities`: entity pages ranked by distinct in-scope edges, retired pages folded into the
    /// live page their redirect chain reaches.
    pub fn rank_entities(&self, input: &RankEntitiesInput) -> Result<Vec<RankEntityRow>> {
        let policy = private_policy(&input.remote, "rankEntities")?;
        let limit = row_count(input.limit, "LIMIT")?;
        let folded_cap = row_count(input.folded_cap, "LIMIT")?;
        let key_of: fn(i64, i64) -> i64 = match input.direction.as_str() {
            "in" => |i, _| i,
            "out" => |_, o| o,
            "both" => |i, o| i + o,
            other => {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("rankEntities: direction must be in, out or both, got {other:?}"),
                ));
            }
        };
        let read = self.read()?;
        let mut sources = Sources::new(&*read);
        let mut pages: HashMap<u64, PageRecord> = HashMap::new();
        for page in all_pages(&*read)? {
            let readable = page.deleted_at_us.is_none()
                && input
                    .source_ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&page.source_id))
                && (input.remote.is_none()
                    || (!has_key(&page, "quarantine") && sources.live(&page.source_id)?))
                && match policy {
                    Some(policy) => !page_hidden(&*read, &page, policy)?,
                    None => true,
                };
            if readable {
                pages.insert(page.id, page);
            }
        }
        // retired: readable pages with their redirect target.
        let targets: HashMap<u64, String> = pages
            .values()
            .filter(|p| retired(&p.frontmatter))
            .map(|p| (p.id, redirect_target(&p.frontmatter)))
            .collect();
        let readable_at = |source: &str, slug: &str| -> Result<Option<u64>> {
            Ok(read_page(&*read, source, slug)?
                .map(|p| p.id)
                .filter(|id| pages.contains_key(id)))
        };
        // chain + fold: the first hop whose target is readable, not retired and not the start.
        let mut fold: HashMap<u64, u64> = HashMap::new();
        for (&start, first) in &targets {
            let source = &pages[&start].source_id;
            let mut target = first.clone();
            let mut hop = 1;
            while !target.is_empty() {
                let next = readable_at(source, &target)?;
                if let Some(t) = next
                    && t != start
                    && !targets.contains_key(&t)
                {
                    fold.insert(start, t);
                    break;
                }
                if hop >= MAX_RETIREMENT_HOPS {
                    break;
                }
                match next.and_then(|id| targets.get(&id)) {
                    Some(t) => target = t.clone(),
                    None => break,
                }
                hop += 1;
            }
        }
        // edges: distinct (folded from, folded to, link_type) over readable endpoints.
        let mut edges: BTreeSet<(u64, u64, String)> = BTreeSet::new();
        let mut from_ids: Vec<u64> = pages.keys().copied().collect();
        from_ids.sort_unstable();
        for from in from_ids {
            for link in out_links(&*read, from)? {
                if link.from_page_id == link.to_page_id
                    || !pages.contains_key(&link.to_page_id)
                    || NON_RANKING_LINK_TYPES.contains(&link.link_type.as_str())
                    || (!input.include_mentions && link.link_source.as_deref() == Some("mentions"))
                    || input
                        .link_type
                        .as_ref()
                        .is_some_and(|t| *t != link.link_type)
                    || (input.remote.is_some()
                        && link.origin_page_id.is_some_and(|o| !pages.contains_key(&o)))
                {
                    continue;
                }
                let src = fold
                    .get(&link.from_page_id)
                    .copied()
                    .unwrap_or(link.from_page_id);
                let dst = fold
                    .get(&link.to_page_id)
                    .copied()
                    .unwrap_or(link.to_page_id);
                edges.insert((src, dst, link.link_type));
            }
        }
        // d: per node, inbound / outbound edge counts and distinct neighbours.
        let mut degree: HashMap<u64, (i64, i64, BTreeSet<u64>)> = HashMap::new();
        for (src, dst, _) in &edges {
            if src == dst {
                continue;
            }
            let d = degree.entry(*dst).or_default();
            d.0 += 1;
            d.2.insert(*src);
            let s = degree.entry(*src).or_default();
            s.1 += 1;
            s.2.insert(*dst);
        }
        let mut folded_into: HashMap<u64, Vec<&PageRecord>> = HashMap::new();
        for (retired_id, target) in &fold {
            folded_into
                .entry(*target)
                .or_default()
                .push(&pages[retired_id]);
        }
        let mut rows: Vec<RankEntityRow> = Vec::new();
        for (node, (inbound, outbound, others)) in degree {
            let page = &pages[&node];
            if !input.types.admits(page) || key_of(inbound, outbound) <= 0 {
                continue;
            }
            let mut retired_pages = folded_into.remove(&node).unwrap_or_default();
            retired_pages.sort_by(|a, b| a.slug.as_bytes().cmp(b.slug.as_bytes()));
            let folded: Vec<FoldedEntry> = retired_pages
                .iter()
                .take(folded_cap)
                .map(|p| FoldedEntry {
                    slug: p.slug.clone(),
                    reason: fold_reason(&p.frontmatter),
                })
                .collect();
            rows.push(RankEntityRow {
                slug: page.slug.clone(),
                title: page.title.clone(),
                page_type: page.page_type.clone(),
                source_id: page.source_id.clone(),
                inbound,
                outbound,
                neighbors: others.len() as i64,
                folded_total: retired_pages.len() as i64,
                folded: (!folded.is_empty()).then_some(folded),
            });
        }
        rows.sort_by(|a, b| {
            key_of(b.inbound, b.outbound)
                .cmp(&key_of(a.inbound, a.outbound))
                .then_with(|| a.slug.as_bytes().cmp(b.slug.as_bytes()))
                .then_with(|| a.source_id.as_bytes().cmp(b.source_id.as_bytes()))
        });
        rows.truncate(limit);
        Ok(rows)
    }

    /// `listExtractionPendingPages`: unverified auto-extracted pages visible in the scope, newest
    /// first. PGLite leaves the order of equal `created_at` values open; the store breaks the tie
    /// by page id, newest first.
    pub fn list_extraction_pending_pages(
        &self,
        input: &ExtractionPendingInput,
    ) -> Result<Vec<ExtractionPendingRow>> {
        let limit = row_count(input.limit, "LIMIT")?;
        let offset = row_count(input.offset, "OFFSET")?;
        let read = self.read()?;
        let mut sources = Sources::new(&*read);
        let scope: Option<Vec<String>> = match (&input.source_ids, &input.source_id) {
            (Some(ids), _) if !ids.is_empty() => Some(ids.clone()),
            (_, Some(id)) if !id.is_empty() => Some(vec![id.clone()]),
            _ => None,
        };
        let mut found = Vec::new();
        for page in all_pages(&*read)? {
            let fm = &page.frontmatter;
            if fm_text(fm, "provenance").as_deref() != Some("auto-extracted")
                || fm_text(fm, "status").as_deref() != Some("unverified")
                || page.deleted_at_us.is_some()
                || !served(&page)
                || has_key(&page, "quarantine")
                || has_key(&page, "pinned_question")
                || scope
                    .as_ref()
                    .is_some_and(|ids| !ids.contains(&page.source_id))
                || !sources.live(&page.source_id)?
            {
                continue;
            }
            found.push(page);
        }
        found.sort_by(|a, b| b.created_at_us.cmp(&a.created_at_us).then(b.id.cmp(&a.id)));
        Ok(found
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|page| ExtractionPendingRow {
                extracted_from: fm_text(&page.frontmatter, "source"),
                created_at: timestamptz_text(page.created_at_us),
                slug: page.slug,
                title: page.title,
                page_type: page.page_type,
                source_id: page.source_id,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fm(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn phrase(words: &[&str], cs: bool) -> Phrase {
        Phrase::new(&words.iter().map(|w| w.to_string()).collect::<Vec<_>>(), cs)
    }

    #[test]
    fn redirect_target_reads_wiki_links_paths_and_md() {
        assert_eq!(
            redirect_target(&fm(json!({"superseded_by": "[[people/x|X]]"}))),
            "people/x"
        );
        assert_eq!(
            redirect_target(&fm(json!({"superseded_by": " people/x.MD "}))),
            "people/x"
        );
        assert_eq!(
            redirect_target(&fm(json!({"merged_into": "//people/y"}))),
            "people/y"
        );
        assert_eq!(
            redirect_target(&fm(json!({"superseded_by": "  ", "merged_into": "b"}))),
            "b"
        );
        assert_eq!(redirect_target(&fm(json!({"superseded_by": 5}))), "5");
        assert_eq!(
            redirect_target(&fm(json!({"superseded_by": ["a"]}))),
            "[\"a\"]"
        );
        assert_eq!(redirect_target(&fm(json!({"superseded_by": "[a]"}))), "[a]");
        assert_eq!(redirect_target(&fm(json!({"superseded_by": "a]]"}))), "a");
        assert_eq!(
            redirect_target(&fm(json!({"superseded_by": "[[ a | b ]]"}))),
            "a"
        );
        // btrim strips spaces only: a tab stays.
        assert_eq!(redirect_target(&fm(json!({"superseded_by": "\tx"}))), "\tx");
    }

    #[test]
    fn retired_pages_follow_retired_page_sql() {
        assert!(retired(&fm(json!({"canonical": false}))));
        assert!(retired(&fm(json!({"canonical": "No"}))));
        assert!(!retired(&fm(json!({"canonical": true}))));
        assert!(retired(&fm(json!({"status": "Redirected to x"}))));
        assert!(retired(&fm(json!({"status": "alias"}))));
        assert!(!retired(&fm(json!({"status": "aliased"}))));
        assert!(!retired(&fm(json!({"status": "redirects"}))));
        assert!(retired(&fm(json!({"status": "is-alias"}))));
        assert!(!retired(&fm(json!({"superseded_by": "   "}))));
        assert!(retired(&fm(json!({"merged_into": "x"}))));
        assert_eq!(fold_reason(&fm(json!({"merged_into": "x"}))), "merged_into");
        assert_eq!(
            fold_reason(&fm(json!({"superseded_by": "y", "merged_into": "x"}))),
            "superseded_by"
        );
    }

    #[test]
    fn phrase_matches_whitespace_runs_and_case() {
        let p = phrase(&["the", "Needle"], false);
        assert_eq!(
            p.snippet("a THE \n\t needle b").as_deref(),
            Some("a THE \n\t needle b")
        );
        assert!(p.snippet("the\u{A0}needle").is_none());
        assert!(p.snippet("the\u{85}needle").is_some());
        assert!(
            phrase(&["the", "Needle"], true)
                .snippet("the needle")
                .is_none()
        );
    }

    #[test]
    fn snippet_is_the_leftmost_longest_match_with_context() {
        let p = phrase(&["x"], true);
        let text = format!("{}x{}x{}", "a".repeat(100), "b".repeat(50), "c".repeat(100));
        // Starts 80 before the first x (the second x is out of the leading window's reach), then
        // the trailing `.{0,80}` takes the next 80 characters, the second x among them.
        let s = p.snippet(&text).unwrap();
        assert_eq!(
            s,
            format!("{}x{}x{}", "a".repeat(80), "b".repeat(50), "c".repeat(29))
        );
        let short = format!("{}x{}x{}", "a".repeat(10), "b".repeat(20), "c".repeat(100));
        assert_eq!(
            p.snippet(&short).unwrap(),
            format!("{}x{}x{}", "a".repeat(10), "b".repeat(20), "c".repeat(80))
        );
    }

    #[test]
    fn email_containment_takes_a_string_or_an_array_member() {
        let page = fm(json!({"email": ["a@x"], "emails": "b@x"}));
        assert!(holds_email(&page, "email", "a@x"));
        assert!(holds_email(&page, "emails", "b@x"));
        assert!(!holds_email(&page, "emails", "a@x"));
        assert!(!holds_email(
            &fm(json!({"email": [["a@x"]]})),
            "email",
            "a@x"
        ));
    }
}
