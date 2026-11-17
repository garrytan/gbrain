//! Page operations: batch reads, duplicate lookup, batch soft and hard deletes, the purge of old
//! tombstones, find and count, the domain-bank samplers, the frontmatter marker reads, the date
//! reads and `revertToVersion`. Each is the PGLite query of the same name answered over the page
//! records of `pages.rs`.
//!
//! Members: readPageSnapshotsBatch, findDuplicatePage, findDuplicatePages, deletePages,
//! resolveSlugsByPaths, softDeletePages, purgeDeletedPages, findPages, countPagesBy, getAllSlugs,
//! listAllPageRefs, listPrefixSampledPages, listCorpusSample, getContentFlagsByPageIds,
//! getUnverifiedExtractionPageIds, getPageTimestamps, getEffectiveDates, revertToVersion.
//!
//! Keys: none. Every read scans the page records (`pages::all_pages`), as `list_pages` does; the
//! family tag `keys::PAGE_OPS` (`p`) stays unused until an index is needed, and such an index needs
//! the core `write_page` hook to stay in step.
//!
//! Text compares and sorts in byte order (Postgres `COLLATE "C"`). Dates cross the binding as ISO
//! strings with microseconds.
//!
//! What the store does not hold answers as empty: no page has a `last_retrieved_at` (no retrieval
//! records), no chunk has an embedding (so `representative_chunk_id` is always null), and every
//! page body is inline (no segmented pages, so `revertToVersion` never refuses for one).

use crate::env::{Env, iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::kv::{KvRead, KvWrite};
use crate::pages::{PageRecord, VersionRecord, all_pages, read_page, remove_page, write_page};
use crate::sources::{SourceRecord, all_sources, read_source};
use crate::{Store, get_json, keys};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// `PAGE_SNAPSHOT_BATCH_MAX_BYTES` (`src/core/page-snapshot-batch.ts`).
pub const SNAPSHOT_BATCH_MAX_BYTES: f64 = 32.0 * 1024.0 * 1024.0;

/// `{ sourceId? }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceOption {
    pub source_id: Option<String>,
}

/// A page named by source and slug: `{ slug, source_id }` (also read as `sourceId`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PageRef {
    pub slug: String,
    #[serde(alias = "sourceId")]
    pub source_id: String,
}

/// The `PageReadScope` of the id and ref reads. `live` is true when the caller passed a scope at
/// all: PGLite then adds its live filter (not deleted, not quarantined, source not archived).
/// `exclude_private` (`excludePrivate`) is the page policy `pageReadFilter` adds, as
/// `facts/privacy.rs` `page_hidden` reads it; `None` hides nothing.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PageReadScope {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub live: bool,
    pub exclude_private: Option<PrivacyPolicy>,
}

/// `readPageSnapshotsBatch` options. `absentIsNull` is the caller's: the store answers `null` for
/// every absent page.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SnapshotBatchOptions {
    pub max_bytes: Option<f64>,
    pub include_deleted: bool,
}

/// One `findDuplicatePage` input.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DuplicateQuery {
    pub hash: String,
    pub frontmatter_id: Option<String>,
    pub exclude_slug: Option<String>,
}

/// `purgeDeletedPages` options.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PurgeOptions {
    pub dry_run: bool,
    pub exclude_ids: Option<Vec<i64>>,
}

/// `FindPattern`: `kind` is `name`, `glob` or `prefix`; `like` is an ILIKE pattern with `\`
/// escapes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct FindPattern {
    pub kind: String,
    pub like: String,
}

/// `FindPagesQuery` without `untrusted` (the TypeScript engine refuses it).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FindPagesQuery {
    pub pattern: FindPattern,
    pub types: Option<Vec<String>>,
    pub limit: i64,
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub exclude_slug_prefixes: Option<Vec<String>>,
}

/// `PageCountQuery` without `untrusted`. `since` is an ISO string; `typeGroups` maps each type the
/// caller's grouper saw to its group (the second call of `countPagesBy` with a grouper).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PageCountQuery {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub since: Option<String>,
    pub type_groups: Option<BTreeMap<String, String>>,
}

/// `DomainBankSampleOpts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PrefixSampleOptions {
    pub prefixes: Vec<String>,
    pub exclude_slugs: Option<Vec<String>>,
    pub stale_bias: bool,
    pub stale_threshold_days: Option<f64>,
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
}

/// `CorpusSampleOpts`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CorpusSampleOptions {
    pub n: f64,
    pub exclude_slugs: Option<Vec<String>>,
    pub seed: Option<f64>,
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
}

/// Postgres `->>` on a JSON value: a string as is, `null` as SQL NULL, anything else as its jsonb
/// text form.
fn json_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// The jsonb output form: `{"k": v, "k2": v}` with keys ordered by length, then bytes, and `[1, 2]`.
fn jsonb_text(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(jsonb_text).collect();
            format!("[{}]", parts.join(", "))
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.len().cmp(&b.len()).then_with(|| a.cmp(b)));
            let parts: Vec<String> = keys
                .iter()
                .map(|k| format!("{}: {}", Value::String((*k).clone()), jsonb_text(&map[*k])))
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
        other => other.to_string(),
    }
}

/// `frontmatter ->> key`.
fn fm_text(frontmatter: &Map<String, Value>, key: &str) -> Option<String> {
    frontmatter.get(key).and_then(json_text)
}

/// `COALESCE(effective_date, updated_at, created_at)`.
fn effective_us(page: &PageRecord) -> i64 {
    page.effective_date_us.unwrap_or(page.updated_at_us)
}

fn sources_by_id(read: &dyn KvRead) -> Result<HashMap<String, SourceRecord>> {
    Ok(all_sources(read)?
        .into_iter()
        .map(|s| (s.id.clone(), s))
        .collect())
}

/// `pageReadFilter(alias, scope, params, live)` for the scope fields the store has.
fn passes_read_scope(
    read: &dyn KvRead,
    page: &PageRecord,
    scope: &PageReadScope,
    sources: &HashMap<String, SourceRecord>,
) -> Result<bool> {
    if let Some(ids) = scope.source_ids.as_ref().filter(|ids| !ids.is_empty()) {
        if !ids.contains(&page.source_id) {
            return Ok(false);
        }
    } else if let Some(id) = scope.source_id.as_ref().filter(|id| !id.is_empty())
        && *id != page.source_id
    {
        return Ok(false);
    }
    if let Some(policy) = &scope.exclude_private
        && page_hidden(read, page, policy)?
    {
        return Ok(false);
    }
    if scope.live {
        let unarchived = sources.get(&page.source_id).is_some_and(|s| !s.archived);
        if page.deleted_at_us.is_some()
            || page.frontmatter.contains_key("quarantine")
            || !unarchived
        {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Live pages in unarchived sources, in the source scope (`visiblePages` of
/// `engine-sql/page-lookup.ts`): `source_ids` when not empty, else a non-empty `source_id`.
fn visible(
    page: &PageRecord,
    source_id: &Option<String>,
    source_ids: &Option<Vec<String>>,
    sources: &HashMap<String, SourceRecord>,
) -> bool {
    if page.deleted_at_us.is_some() || !sources.get(&page.source_id).is_some_and(|s| !s.archived) {
        return false;
    }
    if let Some(ids) = source_ids.as_ref().filter(|ids| !ids.is_empty()) {
        return ids.contains(&page.source_id);
    }
    match source_id.as_ref().filter(|id| !id.is_empty()) {
        Some(id) => *id == page.source_id,
        None => true,
    }
}

/// The sampler scope: `source_ids` when given (even empty), else `source_id` when given (even
/// empty), else every source.
fn sample_scope(
    page: &PageRecord,
    source_id: &Option<String>,
    source_ids: &Option<Vec<String>>,
) -> bool {
    match (source_ids, source_id) {
        (Some(ids), _) => ids.contains(&page.source_id),
        (None, Some(id)) => *id == page.source_id,
        (None, None) => true,
    }
}

/// `substring(slug from '^[^/]+/[^/]+')`.
fn slug_prefix(slug: &str) -> Option<&str> {
    let first = slug.find('/')?;
    if first == 0 {
        return None;
    }
    let rest = &slug[first + 1..];
    let second = rest.find('/').unwrap_or(rest.len());
    if second == 0 {
        return None;
    }
    Some(&slug[..first + 1 + second])
}

/// One token of a LIKE pattern.
enum LikeToken {
    Any,
    One,
    Char(char),
}

fn like_tokens(pattern: &str, fold: bool) -> Vec<LikeToken> {
    let mut out = Vec::new();
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        match c {
            '%' => out.push(LikeToken::Any),
            '_' => out.push(LikeToken::One),
            '\\' => {
                // A trailing backslash is an error in Postgres; read it as a literal backslash.
                let lit = chars.next().unwrap_or('\\');
                push_char(&mut out, lit, fold);
            }
            c => push_char(&mut out, c, fold),
        }
    }
    out
}

fn push_char(out: &mut Vec<LikeToken>, c: char, fold: bool) {
    if fold {
        out.extend(c.to_lowercase().map(LikeToken::Char));
    } else {
        out.push(LikeToken::Char(c));
    }
}

/// `text LIKE pattern` (`fold` false) or `text ILIKE pattern` (`fold` true).
fn like(text: &str, pattern: &str, fold: bool) -> bool {
    let tokens = like_tokens(pattern, fold);
    let chars: Vec<char> = if fold {
        text.chars().flat_map(char::to_lowercase).collect()
    } else {
        text.chars().collect()
    };
    // Greedy match with backtracking to the last `%`.
    let (mut t, mut c) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while c < chars.len() {
        match tokens.get(t) {
            Some(LikeToken::Any) => {
                star = Some((t, c));
                t += 1;
            }
            Some(LikeToken::One) => {
                t += 1;
                c += 1;
            }
            Some(LikeToken::Char(p)) if *p == chars[c] => {
                t += 1;
                c += 1;
            }
            _ => match star {
                Some((st, sc)) => {
                    t = st + 1;
                    c = sc + 1;
                    star = Some((st, sc + 1));
                }
                None => return false,
            },
        }
    }
    tokens[t..].iter().all(|tok| matches!(tok, LikeToken::Any))
}

/// The text after the last `/` (`regexp_replace(slug, '^.*/', '')`).
fn last_segment(slug: &str) -> &str {
    slug.rsplit('/').next().unwrap_or(slug)
}

/// Splitmix64: the shuffle of `listCorpusSample`.
struct Shuffle(u64);

impl Shuffle {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

fn shuffle_seed(seed: Option<f64>, env: &dyn Env) -> u64 {
    match seed {
        Some(s) => s.clamp(-1.0, 1.0).to_bits(),
        None => env
            .new_uuid()
            .bytes()
            .fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
                (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
            }),
    }
}

/// `{ page, tags, revision, sourceIncarnation, withdrawals }`, as `Store::read_page_snapshot`.
fn snapshot_json(read: &dyn KvRead, page: &PageRecord) -> Result<Value> {
    let incarnation = read_source(read, &page.source_id)?
        .map(|s| s.incarnation)
        .unwrap_or_default();
    let mut tags = page.tags.clone();
    tags.sort();
    Ok(json!({
        "page": page.to_page_with_columns(read)?,
        "tags": tags,
        "revision": page.knowledge_revision,
        "sourceIncarnation": incarnation,
        "withdrawals": [],
    }))
}

/// A canonical field changed: a new knowledge revision, and the chunks no longer match the text
/// (as `pages::tag_change`).
fn write_changed(tx: &mut dyn KvWrite, env: &dyn Env, page: &mut PageRecord) -> Result<()> {
    page.knowledge_revision = env.new_uuid();
    page.text_projection_revision = None;
    write_page(tx, page)
}

/// The rows PGLite scrubs after a hard delete that name a page outside any foreign key
/// (`scrubPurgedSlugs` and friends), run in the delete's transaction after the pages are gone.
/// Of those stores the store keeps only the eval candidates' `retrieved_slugs`; retrieval logs,
/// ratings, the volunteer log, the gazetteer and write-gate holds do not exist here yet.
fn scrub_purged_slugs(tx: &mut dyn KvWrite, source_id: &str, slugs: &[String]) -> Result<()> {
    crate::eval_capture::remove_retrieved_slugs(tx, source_id, slugs)?;
    Ok(())
}

/// The pages of `source` whose slug is one of `slugs` exactly, deleted or not, once each, in page
/// id order (the order PGLite's `RETURNING` hands back rows of a fresh table).
fn pages_by_slugs(read: &dyn KvRead, source: &str, slugs: &[String]) -> Result<Vec<PageRecord>> {
    let mut seen = HashSet::new();
    let mut pages = Vec::new();
    for slug in slugs {
        if seen.insert(slug.as_str())
            && let Some(page) = read_page(read, source, slug)?
        {
            pages.push(page);
        }
    }
    pages.sort_by_key(|p| p.id);
    Ok(pages)
}

fn find_duplicate_in(
    pages: &[PageRecord],
    source_id: &str,
    query: &DuplicateQuery,
) -> Option<Value> {
    let fm_id = query.frontmatter_id.as_deref();
    pages
        .iter()
        .filter(|p| p.source_id == source_id && p.deleted_at_us.is_none())
        .filter(|p| {
            let id = fm_text(&p.frontmatter, "id");
            p.content_hash == query.hash || (fm_id.is_some() && id.as_deref() == fm_id)
        })
        .filter(|p| query.exclude_slug.as_deref() != Some(p.slug.as_str()))
        .min_by(|a, b| {
            let same = |p: &PageRecord| fm_text(&p.frontmatter, "id").as_deref() == fm_id;
            same(b).cmp(&same(a)).then_with(|| a.id.cmp(&b.id))
        })
        .map(|p| json!({ "slug": p.slug, "id": p.id }))
}

fn domain_bank_row(read: &dyn KvRead, page: &PageRecord) -> Result<Value> {
    let connections = crate::links::in_links(read, page.id)?.len();
    Ok(json!({
        "slug": page.slug,
        "source_id": page.source_id,
        "prefix": slug_prefix(&page.slug),
        "page_id": page.id,
        "title": page.title,
        "compiled_truth": page.compiled_truth,
        "connection_count": connections,
        "last_retrieved_at": Value::Null,
        "representative_chunk_id": Value::Null,
    }))
}

/// The page index hook (`page_index::reindex_page`): keeps this family's index of page fields in
/// step with a page write. Empty until this family indexes a page field.
pub(crate) fn reindex_page(
    _tx: &mut dyn crate::kv::KvWrite,
    _before: Option<&crate::pages::PageRecord>,
    _after: Option<&crate::pages::PageRecord>,
) -> crate::Result<()> {
    Ok(())
}

impl Store {
    /// `getAllSlugs({ sourceId? })`: every slug, soft-deleted pages included, in one source when
    /// `sourceId` is not empty. Sorted and distinct.
    pub fn get_all_slugs(&self, options: &SourceOption) -> Result<Vec<String>> {
        let read = self.read()?;
        let source = options.source_id.as_ref().filter(|s| !s.is_empty());
        let slugs: BTreeSet<String> = all_pages(&*read)?
            .into_iter()
            .filter(|p| source.is_none_or(|s| *s == p.source_id))
            .map(|p| p.slug)
            .collect();
        Ok(slugs.into_iter().collect())
    }

    /// `listAllPageRefs()`: `{ slug, source_id, updated_at }` for every live page, ordered by
    /// `(source_id, slug)`.
    pub fn list_all_page_refs(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none())
            .collect();
        pages.sort_by(|a, b| {
            a.source_id
                .cmp(&b.source_id)
                .then_with(|| a.slug.cmp(&b.slug))
        });
        Ok(pages
            .iter()
            .map(|p| json!({ "slug": p.slug, "source_id": p.source_id, "updated_at": iso(p.updated_at_us) }))
            .collect())
    }

    /// `getPageTimestamps(slugs)`: `{ slug, ts }` for every page with one of the slugs, in any
    /// source and deleted or not, in page id order (the caller keys a map by slug, so a later
    /// source's page wins, as PGLite's row order makes it).
    pub fn get_page_timestamps(&self, slugs: &[String]) -> Result<Vec<Value>> {
        if slugs.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: HashSet<&str> = slugs.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| wanted.contains(p.slug.as_str()))
            .collect();
        pages.sort_by_key(|p| p.id);
        Ok(pages
            .iter()
            .map(|p| json!({ "slug": p.slug, "ts": iso(p.updated_at_us) }))
            .collect())
    }

    /// `getEffectiveDates(refs, scope?)`: `{ slug, source_id, ts }` per ref that names a page,
    /// `ts` = effective date, else updated_at.
    pub fn get_effective_dates(
        &self,
        refs: &[PageRef],
        scope: &PageReadScope,
    ) -> Result<Vec<Value>> {
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let sources = sources_by_id(&*read)?;
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for r in refs {
            if !seen.insert((r.source_id.as_str(), r.slug.as_str())) {
                continue;
            }
            if let Some(page) = read_page(&*read, &r.source_id, &r.slug)?
                && passes_read_scope(&*read, &page, scope, &sources)?
            {
                out.push(json!({
                    "slug": page.slug,
                    "source_id": page.source_id,
                    "ts": iso(effective_us(&page)),
                }));
            }
        }
        Ok(out)
    }

    fn pages_by_ids(&self, ids: &[i64], scope: &PageReadScope) -> Result<Vec<PageRecord>> {
        let read = self.read()?;
        let sources = sources_by_id(&*read)?;
        let wanted: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for id in wanted {
            if let Some(page) = crate::pages::read_page_by_id(&*read, id)?
                && passes_read_scope(&*read, &page, scope, &sources)?
            {
                out.push(page);
            }
        }
        Ok(out)
    }

    /// `getContentFlagsByPageIds(ids, scope?)`: `{ id, reason, detail }` for every page whose
    /// frontmatter `content_flag` has a non-empty `reason`; `detail` is `''` when absent.
    pub fn get_content_flags_by_page_ids(
        &self,
        ids: &[i64],
        scope: &PageReadScope,
    ) -> Result<Vec<Value>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for page in self.pages_by_ids(ids, scope)? {
            let Some(flag) = page.frontmatter.get("content_flag") else {
                continue;
            };
            let field = |k: &str| flag.as_object().and_then(|o| o.get(k)).and_then(json_text);
            let Some(reason) = field("reason").filter(|r| !r.is_empty()) else {
                continue;
            };
            out.push(json!({
                "id": page.id,
                "reason": reason,
                "detail": field("detail").unwrap_or_default(),
            }));
        }
        Ok(out)
    }

    /// `getUnverifiedExtractionPageIds(ids, scope?)`: `{ id, status, unverified }` for every page
    /// with a frontmatter `status`; `unverified` when `provenance` is `auto-extracted` and
    /// `status` is `unverified`.
    pub fn get_unverified_extraction_page_ids(
        &self,
        ids: &[i64],
        scope: &PageReadScope,
    ) -> Result<Vec<Value>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for page in self.pages_by_ids(ids, scope)? {
            let Some(status) = fm_text(&page.frontmatter, "status") else {
                continue;
            };
            let unverified = fm_text(&page.frontmatter, "provenance").as_deref()
                == Some("auto-extracted")
                && status == "unverified";
            out.push(json!({ "id": page.id, "status": status, "unverified": unverified }));
        }
        Ok(out)
    }

    /// `readPageSnapshotsBatch(refs, opts)`: `{ covered, snapshots }`. The first ref is always
    /// covered; each later ref is covered while the body bytes (`compiled_truth` + `timeline`) of
    /// the pages found for the refs before it stay under `maxBytes`. `snapshots[i]` is the snapshot
    /// of covered ref `i`, or `null` when no page matches its exact slug.
    pub fn read_page_snapshots_batch(
        &self,
        refs: &[PageRef],
        options: &SnapshotBatchOptions,
    ) -> Result<Value> {
        let max = options.max_bytes.unwrap_or(SNAPSHOT_BATCH_MAX_BYTES);
        let read = self.read()?;
        let mut prior: u64 = 0;
        let mut snapshots = Vec::new();
        for (i, r) in refs.iter().enumerate() {
            if i > 0 && (prior as f64) >= max {
                break;
            }
            let page = read_page(&*read, &r.source_id, &r.slug)?
                .filter(|p| options.include_deleted || p.deleted_at_us.is_none());
            match page {
                Some(page) => {
                    prior += (page.compiled_truth.len() + page.timeline.len()) as u64;
                    snapshots.push(snapshot_json(&*read, &page)?);
                }
                None => snapshots.push(Value::Null),
            }
        }
        Ok(json!({ "covered": snapshots.len(), "snapshots": snapshots }))
    }

    /// `findDuplicatePage(sourceId, { hash, frontmatterId?, excludeSlug? })`: `{ slug, id }` of the
    /// live page in the source with that content hash or frontmatter `id`, a frontmatter `id` match
    /// first, then the lowest id; or `null`.
    pub fn find_duplicate_page(
        &self,
        source_id: &str,
        query: &DuplicateQuery,
    ) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(find_duplicate_in(&all_pages(&*read)?, source_id, query))
    }

    /// `findDuplicatePages(sourceId, inputs)`: one `findDuplicatePage` answer per input.
    pub fn find_duplicate_pages(
        &self,
        source_id: &str,
        queries: &[DuplicateQuery],
    ) -> Result<Vec<Option<Value>>> {
        if queries.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let pages = all_pages(&*read)?;
        Ok(queries
            .iter()
            .map(|q| find_duplicate_in(&pages, source_id, q))
            .collect())
    }

    /// `softDeletePages(slugs, { sourceId })`: hides each live page of the source whose slug is
    /// given exactly, in one transaction, and returns the slugs it hid. `updated_at` stays.
    pub fn soft_delete_pages(
        &self,
        slugs: &[String],
        options: &SourceOption,
    ) -> Result<Vec<String>> {
        let Some(source) = options.source_id.clone() else {
            return Ok(Vec::new());
        };
        if slugs.is_empty() {
            return Ok(Vec::new());
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut hidden = Vec::new();
            for mut page in pages_by_slugs(&*tx, &source, slugs)? {
                if page.deleted_at_us.is_none() {
                    page.deleted_at_us = Some(now);
                    write_changed(tx, &*self.env, &mut page)?;
                    hidden.push(page.slug);
                }
            }
            Ok(hidden)
        })
    }

    /// `deletePages(slugs, { sourceId })`: removes each page of the source whose slug is given
    /// exactly, deleted or not, with everything that hangs off it, in one transaction. Returns the
    /// slugs it removed.
    pub fn delete_pages(&self, slugs: &[String], options: &SourceOption) -> Result<Vec<String>> {
        let Some(source) = options.source_id.clone() else {
            return Ok(Vec::new());
        };
        if slugs.is_empty() {
            return Ok(Vec::new());
        }
        self.write(|tx| {
            let mut deleted = Vec::new();
            for page in pages_by_slugs(&*tx, &source, slugs)? {
                remove_page(tx, &page)?;
                deleted.push(page.slug);
            }
            scrub_purged_slugs(tx, &source, &deleted)?;
            Ok(deleted)
        })
    }

    /// `purgeDeletedPages(olderThanHours, { dryRun?, excludeIds? })`: the pages soft-deleted more
    /// than `floor(max(0, hours))` hours ago, minus `excludeIds`, ordered by `deleted_at`, then
    /// slug. A dry run returns `{ slugs, count, pages: [{ slug, source_id, deleted_at }] }`; a real
    /// run removes them in one transaction and returns `{ slugs, count }`.
    pub fn purge_deleted_pages(
        &self,
        older_than_hours: f64,
        options: &PurgeOptions,
    ) -> Result<Value> {
        let hours = if older_than_hours.is_nan() {
            0
        } else {
            older_than_hours.floor().max(0.0) as i64
        };
        let excluded: HashSet<i64> = options.exclude_ids.iter().flatten().copied().collect();
        let select = |read: &dyn KvRead, now: i64| -> Result<Vec<PageRecord>> {
            let cutoff = now.saturating_sub(hours.saturating_mul(3_600_000_000));
            let mut pages: Vec<PageRecord> = all_pages(read)?
                .into_iter()
                .filter(|p| p.deleted_at_us.is_some_and(|d| d < cutoff))
                .filter(|p| !excluded.contains(&(p.id as i64)))
                .collect();
            pages.sort_by(|a, b| {
                a.deleted_at_us
                    .cmp(&b.deleted_at_us)
                    .then_with(|| a.slug.cmp(&b.slug))
            });
            Ok(pages)
        };
        if options.dry_run {
            let read = self.read()?;
            let pages = select(&*read, self.env.now_micros())?;
            let rows: Vec<Value> = pages
                .iter()
                .map(|p| json!({ "slug": p.slug, "source_id": p.source_id, "deleted_at": p.deleted_at_us.map(iso) }))
                .collect();
            let slugs: Vec<&str> = pages.iter().map(|p| p.slug.as_str()).collect();
            return Ok(json!({ "slugs": slugs, "count": slugs.len(), "pages": rows }));
        }
        self.write(|tx| {
            let pages = select(&*tx, self.env.now_micros())?;
            let mut by_source: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for page in &pages {
                remove_page(tx, page)?;
                by_source
                    .entry(page.source_id.clone())
                    .or_default()
                    .push(page.slug.clone());
            }
            for (source, slugs) in &by_source {
                scrub_purged_slugs(tx, source, slugs)?;
            }
            let slugs: Vec<&str> = pages.iter().map(|p| p.slug.as_str()).collect();
            Ok(json!({ "slugs": slugs, "count": slugs.len() }))
        })
    }

    /// `resolveSlugsByPaths(paths, { sourceId })`, store half: `{ slug, source_path, live }` for
    /// every page of the source that claims one of the paths, deleted or not, ordered by
    /// `source_path`, then slug. The caller picks one slug per path (`pickCanonicalOrigin`).
    pub fn resolve_slugs_by_paths(
        &self,
        paths: &[String],
        options: &SourceOption,
    ) -> Result<Vec<Value>> {
        let Some(source) = options.source_id.as_ref() else {
            return Ok(Vec::new());
        };
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: HashSet<&str> = paths.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut rows: Vec<(String, String, bool)> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == *source)
            .filter_map(|p| {
                let path = p.source_path.clone()?;
                wanted
                    .contains(path.as_str())
                    .then(|| (path, p.slug, p.deleted_at_us.is_none()))
            })
            .collect();
        rows.sort();
        Ok(rows
            .into_iter()
            .map(|(path, slug, live)| json!({ "slug": slug, "source_path": path, "live": live }))
            .collect())
    }

    /// `findPages(query)`: `{ rows, total }`. A `name` pattern matches the title, or the slug when
    /// its last segment matches too; any other pattern matches the slug or `source_path`. Live
    /// pages in unarchived sources, in the source scope, of one of `types` when given, minus the
    /// slugs under an `excludeSlugPrefixes` prefix. Rows sort by slug, then source; `total` counts
    /// every match before `limit`, or 0 when no row is returned (as PGLite).
    pub fn find_pages(&self, query: &FindPagesQuery) -> Result<Value> {
        if query.limit < 0 {
            return Err(StoreError::invalid("findPages: limit must not be negative"));
        }
        let read = self.read()?;
        let sources = sources_by_id(&*read)?;
        let pattern = &query.pattern.like;
        let name = query.pattern.kind == "name";
        let types = query.types.as_ref().filter(|t| !t.is_empty());
        let hidden: Vec<&String> = query
            .exclude_slug_prefixes
            .iter()
            .flatten()
            .filter(|p| !p.is_empty())
            .collect();
        let mut found: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| visible(p, &query.source_id, &query.source_ids, &sources))
            .filter(|p| {
                if name {
                    like(&p.title, pattern, true)
                        || (like(&p.slug, pattern, true)
                            && like(last_segment(&p.slug), pattern, true))
                } else {
                    like(&p.slug, pattern, true)
                        || p.source_path
                            .as_deref()
                            .is_some_and(|s| like(s, pattern, true))
                }
            })
            .filter(|p| types.is_none_or(|t| t.contains(&p.page_type)))
            .filter(|p| !hidden.iter().any(|h| p.slug.starts_with(h.as_str())))
            .collect();
        found.sort_by(|a, b| {
            a.slug
                .cmp(&b.slug)
                .then_with(|| a.source_id.cmp(&b.source_id))
        });
        let matched = found.len();
        let rows: Vec<Value> = found
            .iter()
            .take(query.limit as usize)
            .map(|p| {
                json!({
                    "slug": p.slug,
                    "source_id": p.source_id,
                    "type": p.page_type,
                    "title": p.title,
                    "source_path": p.source_path,
                    "updated_at": iso(p.updated_at_us),
                })
            })
            .collect();
        // PGLite reads `total` off the first row (`count(*) OVER ()`), so a limit of 0 reports 0.
        let total = if rows.is_empty() { 0 } else { matched };
        Ok(json!({ "rows": rows, "total": total }))
    }

    /// `countPagesBy(query, groupTypes?)`: `{ bySourceType, byTypeGroup, total }` over the visible
    /// pages (as `find_pages`) whose effective date is at or after `since`. Without `typeGroups`,
    /// `total` counts every page and `byTypeGroup` is empty; with it, only pages whose type is in
    /// the mapping count, per group and in `total`. Distinct slugs compare in byte order.
    /// `bySourceType` sorts by source, then type; `byTypeGroup` by group.
    pub fn count_pages_by(&self, query: &PageCountQuery) -> Result<Value> {
        let since = match query.since.as_deref() {
            None => None,
            Some(text) => Some(parse_iso(text).ok_or_else(|| {
                StoreError::invalid(format!("countPagesBy: since is not an ISO date: {text}"))
            })?),
        };
        let read = self.read()?;
        let sources = sources_by_id(&*read)?;
        let pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| visible(p, &query.source_id, &query.source_ids, &sources))
            .filter(|p| since.is_none_or(|s| effective_us(p) >= s))
            .collect();
        let mut by_source_type: BTreeMap<(&str, &str), u64> = BTreeMap::new();
        for p in &pages {
            *by_source_type
                .entry((p.source_id.as_str(), p.page_type.as_str()))
                .or_default() += 1;
        }
        let by_source_type: Vec<Value> = by_source_type
            .iter()
            .map(|((source, kind), n)| json!({ "source_id": source, "type": kind, "pages": n }))
            .collect();
        let Some(groups) = query.type_groups.as_ref() else {
            let distinct: BTreeSet<&str> = pages.iter().map(|p| p.slug.as_str()).collect();
            return Ok(json!({
                "bySourceType": by_source_type,
                "byTypeGroup": [],
                "total": { "pages": pages.len(), "distinct_slugs": distinct.len() },
            }));
        };
        let mut per_group: BTreeMap<&str, (u64, BTreeSet<&str>)> = BTreeMap::new();
        let mut total = (0u64, BTreeSet::new());
        for p in &pages {
            let Some(group) = groups.get(&p.page_type) else {
                continue;
            };
            let entry = per_group.entry(group.as_str()).or_default();
            entry.0 += 1;
            entry.1.insert(p.slug.as_str());
            total.0 += 1;
            total.1.insert(p.slug.as_str());
        }
        let by_group: Vec<Value> = per_group
            .iter()
            .map(|(group, (n, slugs))| json!({ "group": group, "pages": n, "distinct_slugs": slugs.len() }))
            .collect();
        Ok(json!({
            "bySourceType": by_source_type,
            "byTypeGroup": by_group,
            "total": { "pages": total.0, "distinct_slugs": total.1.len() },
        }))
    }

    /// `listPrefixSampledPages(opts)`: one live page per wanted slug prefix (the first two slug
    /// segments), the one with the most inbound links, then the lowest slug; ordered by prefix.
    /// No page has a retrieval date, so `staleBias` ranks every page the same.
    pub fn list_prefix_sampled_pages(&self, options: &PrefixSampleOptions) -> Result<Vec<Value>> {
        if options.prefixes.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: HashSet<&str> = options.prefixes.iter().map(String::as_str).collect();
        let exclude: HashSet<&str> = options
            .exclude_slugs
            .iter()
            .flatten()
            .map(String::as_str)
            .collect();
        let read = self.read()?;
        let mut best: BTreeMap<String, (usize, PageRecord)> = BTreeMap::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || exclude.contains(page.slug.as_str())
                || !sample_scope(&page, &options.source_id, &options.source_ids)
            {
                continue;
            }
            let Some(prefix) = slug_prefix(&page.slug).filter(|p| wanted.contains(p)) else {
                continue;
            };
            let prefix = prefix.to_string();
            let links = crate::links::in_links(&*read, page.id)?.len();
            let better = match best.get(&prefix) {
                None => true,
                Some((n, held)) => match links.cmp(n) {
                    Ordering::Greater => true,
                    Ordering::Less => false,
                    Ordering::Equal => page.slug < held.slug,
                },
            };
            if better {
                best.insert(prefix, (links, page));
            }
        }
        best.values()
            .map(|(_, page)| domain_bank_row(&*read, page))
            .collect()
    }

    /// `listCorpusSample(opts)`: up to `n` live pages picked at random (a seeded shuffle when
    /// `seed` is given, so a seed gives the same pick every time; not Postgres's `random()`
    /// sequence).
    pub fn list_corpus_sample(&self, options: &CorpusSampleOptions) -> Result<Vec<Value>> {
        if options.n.is_nan() || options.n <= 0.0 {
            return Ok(Vec::new());
        }
        let exclude: HashSet<&str> = options
            .exclude_slugs
            .iter()
            .flatten()
            .map(String::as_str)
            .collect();
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && !exclude.contains(p.slug.as_str()))
            .filter(|p| sample_scope(p, &options.source_id, &options.source_ids))
            .collect();
        pages.sort_by_key(|p| p.id);
        let mut rng = Shuffle(shuffle_seed(options.seed, &*self.env));
        for i in (1..pages.len()).rev() {
            let j = (rng.next() % (i as u64 + 1)) as usize;
            pages.swap(i, j);
        }
        pages.truncate(options.n.round().min(usize::MAX as f64) as usize);
        pages.iter().map(|p| domain_bank_row(&*read, p)).collect()
    }

    /// `revertToVersion(slug, versionId, { sourceId? })`: sets `compiled_truth` and `frontmatter`
    /// from the version and `updated_at` to now on each page with that exact slug (in the source
    /// when `sourceId` is not empty, else in every source) that owns the version, deleted or not.
    /// A version the page does not own changes nothing. Like PGLite it writes no version snapshot
    /// and leaves `content_hash` and the other fields alone; the revision changes only when the
    /// body or frontmatter does.
    pub fn revert_to_version(
        &self,
        slug: &str,
        version_id: i64,
        options: &SourceOption,
    ) -> Result<()> {
        let Ok(version_id) = u64::try_from(version_id) else {
            return Ok(());
        };
        let source = options.source_id.clone().filter(|s| !s.is_empty());
        self.write(|tx| {
            let ids: Vec<String> = match &source {
                Some(id) => vec![id.clone()],
                None => all_sources(&*tx)?.into_iter().map(|s| s.id).collect(),
            };
            let now = self.env.now_micros();
            for id in ids {
                let Some(mut page) = read_page(&*tx, &id, slug)? else {
                    continue;
                };
                let Some(version) =
                    get_json::<VersionRecord>(&*tx, &keys::version(page.id, version_id))?
                else {
                    continue;
                };
                let changed = page.compiled_truth != version.compiled_truth
                    || page.frontmatter != version.frontmatter;
                page.compiled_truth = version.compiled_truth;
                page.frontmatter = version.frontmatter;
                page.updated_at_us = now;
                if changed {
                    write_changed(tx, &*self.env, &mut page)?;
                } else {
                    write_page(tx, &page)?;
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_matches_postgres_patterns() {
        assert!(like("people/alice", "%alice%", true));
        assert!(like("People/Alice", "%alice%", true));
        assert!(!like("People/Alice", "%alice%", false));
        assert!(like("people/alice", "people/%", true));
        assert!(!like("company/alice", "people/%", true));
        assert!(like("a_b", "a\\_b", false));
        assert!(!like("axb", "a\\_b", false));
        assert!(like("axb", "a_b", false));
        assert!(like("50%", "50\\%", false));
        assert!(!like("500", "50\\%", false));
        assert!(like("", "%", false));
        assert!(!like("", "_", false));
        assert!(like("acme-example", "%example", true));
        assert!(like("mississippi", "%iss%ppi", false));
        assert!(!like("mississippi", "%iss%ppx", false));
    }

    #[test]
    fn slug_prefix_takes_two_segments() {
        assert_eq!(slug_prefix("notes/a"), Some("notes/a"));
        assert_eq!(slug_prefix("notes/a/b"), Some("notes/a"));
        assert_eq!(slug_prefix("notes"), None);
        assert_eq!(slug_prefix("/a"), None);
        assert_eq!(slug_prefix("notes//a"), None);
    }

    #[test]
    fn json_text_is_the_jsonb_text_form() {
        assert_eq!(json_text(&json!("x")), Some("x".to_string()));
        assert_eq!(json_text(&json!(null)), None);
        assert_eq!(json_text(&json!(12)), Some("12".to_string()));
        assert_eq!(json_text(&json!(true)), Some("true".to_string()));
        assert_eq!(
            json_text(&json!({"bb": [1, 2], "a": "x"})),
            Some("{\"a\": \"x\", \"bb\": [1, 2]}".to_string())
        );
    }
}
