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
//! Keys: this file keeps none. The only records under `keys::PAGE_OPS` (`p`) are the retrieval
//! records of `page_ops/retrievals.rs`. Every read scans the page records (`pages::all_pages`), as
//! `list_pages` does; an index of page fields under `p` needs the core `write_page` hook to stay in
//! step.
//!
//! Text compares and sorts in byte order (Postgres `COLLATE "C"`). Dates cross the binding as ISO
//! strings with microseconds.
//!
//! `last_retrieved_at` is the page's retrieval record (`page_ops/retrievals.rs`, bumpPageRetrievals).
//! A sampled page's `representative_chunk_id` is its lowest-index embedded chunk.
//!
//! Segmented pages (a NULL body, `pages::PageText`): `readPageSnapshotsBatch` sends the NULL body
//! on and counts it as 0 bytes, as PGLite's `sum(octet_length(...))` skips it; the samplers leave
//! the page out (`body_storage = 'inline'`); `revertToVersion` refuses `page_body_segmented` when the
//! page or the version is segmented, before it writes anything.
//!
//! `purgeDeletedPages` keeps the tombstones PGLite's derived and atom retirement holds keep
//! (`PurgeHolds`); rust/docs/store/page_ops.md cites each rule and names the two `op_checkpoints`
//! holds it does not apply.

use crate::env::{Env, iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::facts::{OwnerOnlyCache, PrivacyPolicy};
use crate::kv::{KvRead, KvWrite};
use crate::pages::{PageRecord, VersionRecord, all_pages, read_page, remove_page, write_page};
use crate::sources::{SourceRecord, all_sources, read_source};
use crate::trust::{TrustPolicy, TrustTier};
use crate::{Store, get_json, keys};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

mod atom_restore;
mod relational;
pub(crate) mod retrievals;
mod stale_atoms;
pub(crate) use retrievals::remove_page_rows;

/// The code `revertToVersion` refuses with when the page or the version is segmented. The
/// TypeScript member turns it into PGLite's `segmentedRevertRefusal`.
pub const PAGE_BODY_SEGMENTED: &str = "page_body_segmented";

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
/// `exclude_private` is the page policy of `excludePrivate` (`facts/privacy.rs` `page_hidden`; the
/// owner-only sources are read once per read, `OwnerOnlyCache`);
/// `min_trust` and `suppress_flagged` are `pageEligibleSql`'s trust floor and flagged-page filter
/// over the page's stored tier and write-gate receipts (`trust::TrustPolicy`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PageReadScope {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub live: bool,
    pub exclude_private: Option<PrivacyPolicy>,
    pub min_trust: Option<String>,
    pub suppress_flagged: bool,
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

/// `FindPagesQuery`. `untrusted` is a remote caller's read policy as a `PageReadScope` (`live`,
/// `excludePrivate`, `minTrust`, `suppressFlagged`); when set, a found page must also pass it, as
/// PGLite's `pageReadFilter(.., live)` does (so a quarantined page is hidden too).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FindPagesQuery {
    pub pattern: FindPattern,
    pub types: Option<Vec<String>>,
    pub limit: i64,
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub exclude_slug_prefixes: Option<Vec<String>>,
    pub untrusted: Option<PageReadScope>,
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
            keys.sort_by(|a, b| crate::jsonb::key_cmp(a, b));
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

/// The pages of `pages` that `pageReadFilter(alias, scope, params, live)` admits, in their order
/// (the reads of `list_reads.rs` that take a caller's read policy).
pub(crate) fn pages_in_read_scope(
    read: &dyn KvRead,
    pages: Vec<PageRecord>,
    scope: &PageReadScope,
) -> Result<Vec<PageRecord>> {
    let sources = sources_by_id(read)?;
    let trust = TrustPolicy::parse(scope.min_trust.as_deref(), scope.suppress_flagged)?;
    let mut owner_only = OwnerOnlyCache::default();
    let mut kept = Vec::with_capacity(pages.len());
    for page in pages {
        if passes_read_scope(read, &page, scope, &trust, &sources, &mut owner_only)? {
            kept.push(page);
        }
    }
    Ok(kept)
}

/// `pageReadFilter(alias, scope, params, live)`: the source clause, the page policy, the trust
/// policy and, with `live`, the live filter.
fn passes_read_scope(
    read: &dyn KvRead,
    page: &PageRecord,
    scope: &PageReadScope,
    trust: &TrustPolicy,
    sources: &HashMap<String, SourceRecord>,
    owner_only: &mut OwnerOnlyCache,
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
    if scope.live {
        let unarchived = sources.get(&page.source_id).is_some_and(|s| !s.archived);
        if page.deleted_at_us.is_some()
            || page.frontmatter.contains_key("quarantine")
            || !unarchived
        {
            return Ok(false);
        }
    }
    if let Some(policy) = &scope.exclude_private
        && owner_only.page_hidden(read, page, policy)?
    {
        return Ok(false);
    }
    trust.admits(
        read,
        "pages",
        page.id,
        TrustTier::stored(page.trust_tier.as_deref()),
    )
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

/// `{ page, tags, revision, sourceIncarnation, withdrawals }` (and the global purge fields, and
/// `bodyGeneration` of a segmented page), as
/// `Store::read_page_snapshot`.
fn snapshot_json(read: &dyn KvRead, page: &PageRecord) -> Result<Value> {
    let incarnation = read_source(read, &page.source_id)?
        .map(|s| s.incarnation)
        .unwrap_or_default();
    let mut tags = page.tags.clone();
    tags.sort();
    let mut snapshot = json!({
        "page": page.to_page_with_columns(read)?,
        "tags": tags,
        "revision": page.knowledge_revision,
        "sourceIncarnation": incarnation,
    });
    if let Value::Object(fields) = &mut snapshot {
        fields.extend(crate::page_withdrawals::snapshot_withdrawals(
            read,
            &page.source_id,
            &page.slug,
            false,
        )?);
        crate::pages::add_body_generation(read, page, fields)?;
    }
    Ok(snapshot)
}

/// A canonical field changed: a new knowledge revision, and the chunks no longer match the text
/// (as `pages::tag_change`).
pub(crate) fn write_changed(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    page: &mut PageRecord,
) -> Result<()> {
    page.knowledge_revision = env.new_uuid();
    page.text_projection_revision = None;
    write_page(tx, page)
}

/// The rows PGLite scrubs after a hard delete that name a page outside any foreign key
/// (`scrubPurgedSlugs` and friends), run in the delete's transaction after the pages are gone.
/// The store keeps the eval candidates' `retrieved_slugs` (`scrubPurgedSlugs`), of `scrubPurgedNameStores` the mention
/// gazetteer (`mention_state::scrub_purged_entries`), the volunteer log (`volunteer_events::scrub_purged_slugs`) and the
/// retrieval logs, ratings and weights (`retrieval_feedback::scrub_purged_slugs`) and, of `scrubPurgedSlugStores`, the
/// take proposals (with their idempotency entries and nudges), the open loops (with their dedupe keys), the page aliases,
/// slug aliases and rename history, scrubbed in PGLite's order (src/core/engine-sql/pages.ts deletePages). Core-edit
/// notices and write-gate holds are not scrubbed here.
fn scrub_purged_slugs(
    tx: &mut dyn KvWrite,
    source_id: &str,
    slugs: &[String],
    secret_occurrences: &BTreeSet<u64>,
) -> Result<()> {
    crate::eval_capture::remove_retrieved_slugs(tx, source_id, slugs)?;
    crate::mention_state::scrub_purged_entries(tx, source_id, slugs)?;
    crate::volunteer_events::scrub_purged_slugs(tx, source_id, slugs)?;
    crate::retrieval_feedback::scrub_purged_slugs(tx, source_id, slugs)?;
    // `deletePurgedSlugStoreRows` (engine-sql/purge-slug-stores.ts SLUG_STORE_DELETES), in its order: the take proposals
    // and open loops filed under the slug, then the aliases and rename history.
    let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
    crate::takes::proposals::remove_for_slugs(tx, source_id, &wanted)?;
    crate::facts::loops::remove_for_slugs(tx, source_id, &wanted)?;
    crate::aliases::scrub_purged_slug_stores(tx, source_id, slugs)?;
    crate::secret_store::purge_for_deleted_pages(tx, source_id, slugs, secret_occurrences)?;
    Ok(())
}

/// `DERIVED_RETIRED_BY` (`src/core/persistence/derived-retirement-hold.ts:19`): the `retired_by`
/// stamps a derived writer puts on the pages it retires.
const DERIVED_RETIRED_BY: [&str; 7] = [
    "extract-atoms",
    "managed-reextract",
    "stale-atoms",
    "life-chronicle",
    "generation-restore",
    "synthesis-resynthesis",
    "synthesis-cleanup",
];

/// `ATOM_REEXTRACT_RETIRED_BY` and `ATOM_RESTORE_HOLD_DAYS`
/// (`src/core/persistence/atom-retirement-hold.ts:25,28`).
const ATOM_REEXTRACT_RETIRED_BY: &str = "managed-reextract";
const ATOM_RESTORE_HOLD_DAYS: i64 = 30;

/// `GENERATION_BOUNDS.restoreDays` (`src/core/generations/config.ts:12`).
const RESTORE_DAYS_KEY: &str = "generations.restore_days";
const RESTORE_DAYS_MIN: i64 = 3;
const RESTORE_DAYS_MAX: i64 = 365;
const RESTORE_DAYS_FALLBACK: i64 = 30;

/// One day of PGLite's `interval '1 day'`. PGLite runs in `Etc/GMT0`, so a day is always 24 hours.
const DAY_US: i64 = 86_400_000_000;

/// `RESTORE_DAYS_SQL` (`src/core/generations/config.ts:59`): the `generations.restore_days` config
/// value when it is 1 to 3 ASCII digits naming 3 to 365 days, else 30.
fn restore_days(read: &dyn KvRead) -> Result<i64> {
    let value = crate::config::read_config(read, RESTORE_DAYS_KEY)?;
    let days = value
        .filter(|v| (1..=3).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|d| (RESTORE_DAYS_MIN..=RESTORE_DAYS_MAX).contains(d));
    Ok(days.unwrap_or(RESTORE_DAYS_FALLBACK))
}

/// `NULLIF(frontmatter->>key, '')`.
fn fm_nonempty(page: &PageRecord, key: &str) -> Option<String> {
    fm_text(&page.frontmatter, key).filter(|v| !v.is_empty())
}

/// The origin key of `atomRetirementsSql` (`atom-retirement-hold.ts:31`): `slug:<source_slug>`, else
/// `path:<source_path>`, else none.
fn atom_origin_key(page: &PageRecord) -> Option<String> {
    if let Some(slug) = fm_nonempty(page, "source_slug") {
        Some(format!("slug:{slug}"))
    } else {
        fm_nonempty(page, "source_path").map(|path| format!("path:{path}"))
    }
}

/// The stripped source hash of `atomRetirementsSql` (`atom-retirement-hold.ts:30`): `source_hash`
/// (empty when absent) with one leading `pending:` removed.
fn atom_hash(page: &PageRecord) -> String {
    let hash = fm_text(&page.frontmatter, "source_hash").unwrap_or_default();
    match hash.strip_prefix("pending:") {
        Some(rest) => rest.to_string(),
        None => hash,
    }
}

/// An atom no import wrote (`notImported`, `atom-retirement-hold.ts:33`).
fn atom_not_imported(page: &PageRecord) -> bool {
    page.page_type == "atom" && fm_nonempty(page, "imported_from").is_none()
}

/// The ids of the restorable re-extraction retirements of `atomRetirementsSql('true')`
/// (`atom-retirement-hold.ts:41-69`): a soft-deleted, non-imported atom stamped
/// `retired_by: managed-reextract` with an origin key, whose `source_slug` origin (when it names one)
/// is a live page of the same source, that no live non-imported atom of the same source and origin
/// replaced with a different hash, and whose hash is the hash of the origin's latest retirement
/// (`retired_at` text descending, NULL last, then id descending).
pub(crate) fn restorable_atoms(pages: &[PageRecord]) -> HashSet<u64> {
    let live_slugs: HashSet<(&str, &str)> = pages
        .iter()
        .filter(|p| p.deleted_at_us.is_none())
        .map(|p| (p.source_id.as_str(), p.slug.as_str()))
        .collect();
    let mut live_hashes: HashMap<(&str, String), HashSet<String>> = HashMap::new();
    for page in pages
        .iter()
        .filter(|p| p.deleted_at_us.is_none() && atom_not_imported(p))
    {
        if let Some(key) = atom_origin_key(page) {
            live_hashes
                .entry((page.source_id.as_str(), key))
                .or_default()
                .insert(atom_hash(page));
        }
    }
    let retired: Vec<(&PageRecord, String, String)> = pages
        .iter()
        .filter(|p| {
            p.deleted_at_us.is_some()
                && atom_not_imported(p)
                && fm_text(&p.frontmatter, "retired_by").as_deref()
                    == Some(ATOM_REEXTRACT_RETIRED_BY)
        })
        .filter_map(|p| atom_origin_key(p).map(|key| (p, key, atom_hash(p))))
        .collect();
    let mut latest: HashMap<(&str, &str), (Option<String>, u64, &str)> = HashMap::new();
    for (page, key, hash) in &retired {
        let rank = (
            fm_text(&page.frontmatter, "retired_at"),
            page.id,
            hash.as_str(),
        );
        let slot = latest.entry((page.source_id.as_str(), key.as_str()));
        let entry = slot.or_insert_with(|| rank.clone());
        // `retired_at DESC NULLS LAST, id DESC`: a later text wins, any text beats NULL, then the higher id.
        let newer = match (&rank.0, &entry.0) {
            (Some(a), Some(b)) => a.as_bytes().cmp(b.as_bytes()).then(rank.1.cmp(&entry.1)),
            (Some(_), None) => Ordering::Greater,
            (None, Some(_)) => Ordering::Less,
            (None, None) => rank.1.cmp(&entry.1),
        };
        if newer == Ordering::Greater {
            *entry = rank;
        }
    }
    retired
        .iter()
        .filter(|(page, key, hash)| {
            let origin_live = fm_nonempty(page, "source_slug")
                .is_none_or(|slug| live_slugs.contains(&(page.source_id.as_str(), slug.as_str())));
            let replaced = live_hashes
                .get(&(page.source_id.as_str(), key.clone()))
                .is_some_and(|hashes| hashes.iter().any(|h| h != hash));
            let is_latest = latest
                .get(&(page.source_id.as_str(), key.as_str()))
                .is_some_and(|l| l.2 == hash.as_str());
            origin_live && !replaced && is_latest
        })
        .map(|(page, _, _)| page.id)
        .collect()
}

/// The purge holds that read only the page rows and `config`, at `now` (PGLite's statement clock): the
/// derived retirement hold (`derivedRetirementPurgeHold`, `derived-retirement-hold.ts:38-41`) and the
/// atom retirement hold (`atomRetirementPurgeHold`, `atom-retirement-hold.ts:80-84`). Each window is
/// open while `deleted_at > now - days`. The two `op_checkpoints` holds are applied by the retention
/// purge's candidate reads (`persistence/retention_purge.rs`), not by `purge_deleted_pages`: see
/// `rust/docs/store/page_ops.md`.
pub(crate) struct PurgeHolds {
    now: i64,
    restore_days: i64,
    restorable_atoms: HashSet<u64>,
}

impl PurgeHolds {
    pub(crate) fn read(read: &dyn KvRead, pages: &[PageRecord], now: i64) -> Result<Self> {
        Ok(Self {
            now,
            restore_days: restore_days(read)?,
            restorable_atoms: restorable_atoms(pages),
        })
    }

    pub(crate) fn holds(&self, page: &PageRecord) -> bool {
        let Some(deleted) = page.deleted_at_us else {
            return false;
        };
        let within = |days: i64| deleted > self.now.saturating_sub(days.saturating_mul(DAY_US));
        let stamp = fm_text(&page.frontmatter, "retired_by").unwrap_or_default();
        let derived = DERIVED_RETIRED_BY.contains(&stamp.as_str()) && within(self.restore_days);
        let atom = page.page_type == "atom"
            && stamp == ATOM_REEXTRACT_RETIRED_BY
            && within(ATOM_RESTORE_HOLD_DAYS)
            && self.restorable_atoms.contains(&page.id);
        derived || atom
    }
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
            p.content_hash.as_deref() == Some(query.hash.as_str())
                || (fm_id.is_some() && id.as_deref() == fm_id)
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
    let retrieved = retrievals::last_retrieved_us(read, page.id)?.map(iso);
    Ok(json!({
        "slug": page.slug,
        "source_id": page.source_id,
        "prefix": slug_prefix(&page.slug),
        "page_id": page.id,
        "title": page.title,
        "compiled_truth": page.compiled_truth,
        "connection_count": connections,
        "last_retrieved_at": retrieved,
        "representative_chunk_id": representative_chunk(read, page.id)?,
    }))
}

/// The samplers' `representative_chunk_id`: the id of the page's lowest-index chunk that has an
/// embedding (`cc.embedding IS NOT NULL ORDER BY cc.chunk_index LIMIT 1`), or null.
fn representative_chunk(read: &dyn KvRead, page_id: u64) -> Result<Value> {
    Ok(crate::chunks::read_chunks(read, page_id)?
        .into_iter()
        .filter(|c| c.embed.dims > 0)
        .min_by_key(|c| c.chunk_index)
        .map_or(Value::Null, |c| json!(c.id)))
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

    /// `listMarkdownPageSlugs(sourceId)`: the slugs of the source's markdown pages, soft-deleted pages included, by
    /// byte order (`ORDER BY slug COLLATE "C"`).
    pub fn list_markdown_page_slugs(&self, source_id: &str) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut slugs: Vec<String> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.page_kind == "markdown")
            .map(|p| p.slug)
            .collect();
        slugs.sort();
        Ok(slugs)
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
        let trust = TrustPolicy::parse(scope.min_trust.as_deref(), scope.suppress_flagged)?;
        let mut owner_only = OwnerOnlyCache::default();
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for r in refs {
            if !seen.insert((r.source_id.as_str(), r.slug.as_str())) {
                continue;
            }
            if let Some(page) = read_page(&*read, &r.source_id, &r.slug)?
                && passes_read_scope(&*read, &page, scope, &trust, &sources, &mut owner_only)?
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
        let trust = TrustPolicy::parse(scope.min_trust.as_deref(), scope.suppress_flagged)?;
        let mut owner_only = OwnerOnlyCache::default();
        let wanted: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for id in wanted {
            if let Some(page) = crate::pages::read_page_by_id(&*read, id)?
                && passes_read_scope(&*read, &page, scope, &trust, &sources, &mut owner_only)?
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
                    // The page enters a fact purge's derivation sweep's scope: the sweep checks it again before it ends.
                    crate::page_body::derivation_sweep::note_scope_entry(
                        tx,
                        &page.source_id,
                        page.id,
                    )?;
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
            let mut secrets = BTreeSet::new();
            for page in pages_by_slugs(&*tx, &source, slugs)? {
                secrets.extend(crate::secret_store::page_occurrence_ids(&*tx, page.id)?);
                remove_page(tx, &page)?;
                deleted.push(page.slug);
            }
            scrub_purged_slugs(tx, &source, &deleted, &secrets)?;
            Ok(deleted)
        })
    }

    /// `purgeDeletedPages(olderThanHours, { dryRun?, excludeIds? })`: the pages soft-deleted more
    /// than `floor(hours)` hours ago (an age that is NaN, negative or not finite is refused with
    /// `invalid_argument` before anything is read or written), minus `excludeIds` and the pages a retirement hold
    /// keeps (`PurgeHolds`), ordered by `deleted_at`, then slug. Each purged page goes through
    /// `remove_page` and `scrub_purged_slugs`, as `deletePages` does. A dry run returns
    /// `{ slugs, count, pages: [{ slug, source_id, deleted_at }] }`; a real run removes them in one
    /// transaction and returns the same three fields.
    pub fn purge_deleted_pages(
        &self,
        older_than_hours: f64,
        options: &PurgeOptions,
    ) -> Result<Value> {
        // Refuse an age that is not a finite number of hours, 0 or more (NaN, a negative number,
        // ±Infinity) before anything is read or written: NaN used to read as 0 hours and purge every
        // tombstone. The SQL engines refuse the same inputs (src/core/engine-errors.ts PurgeAgeError).
        if !older_than_hours.is_finite() || older_than_hours < 0.0 {
            return Err(StoreError::invalid(format!(
                "purgeDeletedPages: the age must be a finite number of hours, 0 or more; got {older_than_hours}. Nothing was purged."
            )));
        }
        let hours = older_than_hours.floor() as i64;
        let excluded: HashSet<i64> = options.exclude_ids.iter().flatten().copied().collect();
        let select = |read: &dyn KvRead, now: i64| -> Result<Vec<PageRecord>> {
            let cutoff = now.saturating_sub(hours.saturating_mul(3_600_000_000));
            let all = all_pages(read)?;
            let holds = PurgeHolds::read(read, &all, now)?;
            let mut pages: Vec<PageRecord> = all
                .into_iter()
                .filter(|p| p.deleted_at_us.is_some_and(|d| d < cutoff))
                .filter(|p| !excluded.contains(&(p.id as i64)))
                .filter(|p| !holds.holds(p))
                .collect();
            pages.sort_by(|a, b| {
                a.deleted_at_us
                    .cmp(&b.deleted_at_us)
                    .then_with(|| a.slug.cmp(&b.slug))
            });
            Ok(pages)
        };
        // Both paths name the pages (slug, source, deleted_at): the destructive caller scrubs their journal text.
        let answer = |pages: &[PageRecord]| {
            let rows: Vec<Value> = pages
                .iter()
                .map(|p| json!({ "slug": p.slug, "source_id": p.source_id, "deleted_at": p.deleted_at_us.map(iso) }))
                .collect();
            let slugs: Vec<&str> = pages.iter().map(|p| p.slug.as_str()).collect();
            json!({ "slugs": slugs, "count": slugs.len(), "pages": rows })
        };
        if options.dry_run {
            let read = self.read()?;
            return Ok(answer(&select(&*read, self.env.now_micros())?));
        }
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let pages = select(&*tx, self.env.now_micros())?;
            let mut by_source: BTreeMap<String, Vec<String>> = BTreeMap::new();
            let mut texts = BTreeSet::new();
            let mut secrets: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
            for page in &pages {
                texts.extend(crate::page_body::page_text_refs(&*tx, page.id)?);
                secrets
                    .entry(page.source_id.clone())
                    .or_default()
                    .extend(crate::secret_store::page_occurrence_ids(&*tx, page.id)?);
                remove_page(tx, page)?;
                by_source
                    .entry(page.source_id.clone())
                    .or_default()
                    .push(page.slug.clone());
            }
            for (source, slugs) in &by_source {
                crate::page_body::delete_slug_stagings(tx, source, slugs)?;
            }
            crate::page_body::delete_purged_texts(tx, &texts)?;
            let now = self.env.now_micros();
            for (source, slugs) in &by_source {
                scrub_purged_slugs(
                    tx,
                    source,
                    slugs,
                    &secrets.remove(source).unwrap_or_default(),
                )?;
                crate::facts::expire_gone_page_facts(tx, trust, source, slugs, now)?;
            }
            Ok(answer(&pages))
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
        if let Some(scope) = &query.untrusted {
            let trust = TrustPolicy::parse(scope.min_trust.as_deref(), scope.suppress_flagged)?;
            let mut kept = Vec::with_capacity(found.len());
            let mut owner_only = OwnerOnlyCache::default();
            for page in found {
                if passes_read_scope(&*read, &page, scope, &trust, &sources, &mut owner_only)? {
                    kept.push(page);
                }
            }
            found = kept;
        }
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

    /// `listPrefixSampledPages(opts)`: one live inline page per wanted slug prefix (the first two slug
    /// segments), ordered by prefix. With `staleBias`, a page never retrieved comes first, then one
    /// last retrieved over `staleThresholdDays` (default 90) ago; then the most inbound links, then
    /// the lowest slug.
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
        let days = options.stale_threshold_days.unwrap_or(90.0).round();
        let stale_before = self.env.now_micros() - (days * 86_400_000_000.0) as i64;
        let mut best: BTreeMap<String, ((u8, usize), PageRecord)> = BTreeMap::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || page.compiled_truth.is_null()
                || exclude.contains(page.slug.as_str())
                || !sample_scope(&page, &options.source_id, &options.source_ids)
            {
                continue;
            }
            let Some(prefix) = slug_prefix(&page.slug).filter(|p| wanted.contains(p)) else {
                continue;
            };
            let prefix = prefix.to_string();
            let stale = if options.stale_bias {
                match retrievals::last_retrieved_us(&*read, page.id)? {
                    None => 2,
                    Some(at) if at < stale_before => 1,
                    Some(_) => 0,
                }
            } else {
                0
            };
            let links = (stale, crate::links::in_links(&*read, page.id)?.len());
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

    /// `listCorpusSample(opts)`: up to `n` live inline pages picked at random (a seeded shuffle when
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
            .filter(|p| p.deleted_at_us.is_none() && !p.compiled_truth.is_null())
            .filter(|p| !exclude.contains(p.slug.as_str()))
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
    /// body or frontmatter does. When any page it would revert, or its version, is segmented (a NULL
    /// body), it refuses `page_body_segmented` and writes nothing, as PGLite's first query does.
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
            let mut found = Vec::new();
            for id in ids {
                let Some(page) = read_page(&*tx, &id, slug)? else {
                    continue;
                };
                let Some(version) =
                    get_json::<VersionRecord>(&*tx, &keys::version(page.id, version_id))?
                else {
                    continue;
                };
                if page.compiled_truth.is_null() || version.compiled_truth.is_null() {
                    return Err(StoreError::new(
                        PAGE_BODY_SEGMENTED,
                        format!(
                            "Page {slug} or its version {version_id} is stored in segments, so revert_version cannot restore it yet; nothing was changed."
                        ),
                    ));
                }
                found.push((page, version));
            }
            let now = self.env.now_micros();
            for (mut page, version) in found {
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

    // Segmented pages (shared item 12). No member writes a segmented shell yet (the page_body family
    // does), so these tests turn a stored page into one directly, as `pages.rs` tests do.

    use crate::error::StoreError;
    use crate::pages::{PageInput, PageText, PutPageOptions};
    use crate::sources::DEFAULT_SOURCE;
    use crate::test_support::store;

    fn put(store: &Store, slug: &str, source: Option<&str>) {
        let input: PageInput = serde_json::from_value(
            json!({"type": "note", "title": slug, "compiled_truth": "body"}),
        )
        .unwrap();
        let options = PutPageOptions {
            source_id: source.map(str::to_string),
            ..PutPageOptions::default()
        };
        store.put_page(slug, &input, &options).unwrap();
    }

    fn shell(store: &Store, source: &str, slug: &str) {
        store
            .write(|tx| {
                let mut page = read_page(&*tx, source, slug)?.unwrap();
                page.compiled_truth = PageText::null();
                page.timeline = PageText::null();
                page.content_hash = None;
                write_page(tx, &page)
            })
            .unwrap();
    }

    fn page(store: &Store, source: &str, slug: &str) -> PageRecord {
        read_page(&*store.read().unwrap(), source, slug)
            .unwrap()
            .unwrap()
    }

    fn version_id(store: &Store, slug: &str) -> i64 {
        store.create_version(slug, None).unwrap()["id"]
            .as_i64()
            .unwrap()
    }

    fn page_ref(slug: &str) -> PageRef {
        PageRef {
            slug: slug.into(),
            source_id: DEFAULT_SOURCE.into(),
        }
    }

    #[test]
    fn a_snapshot_batch_sends_a_segmented_body_as_null_and_counts_it_as_no_bytes() {
        let store = store();
        put(&store, "notes/a", None);
        put(&store, "notes/b", None);
        shell(&store, DEFAULT_SOURCE, "notes/a");
        // The shell's body is 0 bytes, so a 1-byte budget still covers the ref after it.
        let options = SnapshotBatchOptions {
            max_bytes: Some(1.0),
            include_deleted: false,
        };
        let batch = store
            .read_page_snapshots_batch(&[page_ref("notes/a"), page_ref("notes/b")], &options)
            .unwrap();
        assert_eq!(batch["covered"], 2);
        let shell_page = &batch["snapshots"][0]["page"];
        assert_eq!(shell_page["compiled_truth"], Value::Null);
        assert_eq!(shell_page["timeline"], Value::Null);
        assert_eq!(shell_page["content_hash"], Value::Null);
        assert_eq!(batch["snapshots"][1]["page"]["compiled_truth"], "body");
    }

    #[test]
    fn the_samplers_leave_segmented_pages_out() {
        let store = store();
        put(&store, "notes/a/1", None);
        put(&store, "notes/a/2", None);
        put(&store, "notes/b/1", None);
        // The lowest slug wins a prefix; as a shell it must not be a candidate at all.
        shell(&store, DEFAULT_SOURCE, "notes/a/1");
        shell(&store, DEFAULT_SOURCE, "notes/b/1");
        let picked = store
            .list_prefix_sampled_pages(&PrefixSampleOptions {
                prefixes: vec!["notes/a".into(), "notes/b".into()],
                ..PrefixSampleOptions::default()
            })
            .unwrap();
        let slugs: Vec<&str> = picked.iter().map(|r| r["slug"].as_str().unwrap()).collect();
        assert_eq!(slugs, ["notes/a/2"]);
        let sample = store
            .list_corpus_sample(&CorpusSampleOptions {
                n: 10.0,
                seed: Some(0.5),
                ..CorpusSampleOptions::default()
            })
            .unwrap();
        let slugs: Vec<&str> = sample.iter().map(|r| r["slug"].as_str().unwrap()).collect();
        assert_eq!(slugs, ["notes/a/2"]);
    }

    fn refused(result: Result<()>) -> StoreError {
        let error = result.unwrap_err();
        assert_eq!(error.code, PAGE_BODY_SEGMENTED);
        error
    }

    #[test]
    fn revert_refuses_a_segmented_page_and_writes_nothing() {
        let store = store();
        put(&store, "notes/a", None);
        let version = version_id(&store, "notes/a");
        shell(&store, DEFAULT_SOURCE, "notes/a");
        let before = page(&store, DEFAULT_SOURCE, "notes/a");
        let error = refused(store.revert_to_version("notes/a", version, &SourceOption::default()));
        assert_eq!(
            error.message,
            format!(
                "Page notes/a or its version {version} is stored in segments, so revert_version cannot restore it yet; nothing was changed."
            )
        );
        let after = page(&store, DEFAULT_SOURCE, "notes/a");
        assert!(after.compiled_truth.is_null());
        assert_eq!(after.updated_at_us, before.updated_at_us);
        assert_eq!(after.knowledge_revision, before.knowledge_revision);
    }

    #[test]
    fn the_samplers_name_the_first_embedded_chunk() {
        let store = store();
        store.set_config("embedding_dimensions", "3").unwrap();
        put(&store, "notes/a/1", None);
        put(&store, "notes/b/1", None);
        let chunk = |index: u32, vector: Option<[f32; 3]>| {
            let mut rest = serde_json::Map::new();
            if let Some(v) = vector {
                rest.insert("embedding".into(), json!(v));
                rest.insert("model".into(), json!("embed-m1"));
            }
            crate::chunks::ChunkInput {
                chunk_index: index,
                chunk_text: format!("text {index}"),
                rest,
                ..crate::chunks::ChunkInput::default()
            }
        };
        store
            .upsert_chunks(
                "notes/a/1",
                &[
                    chunk(0, None),
                    chunk(1, Some([1.0, 0.0, 0.0])),
                    chunk(2, Some([0.0, 1.0, 0.0])),
                ],
                &crate::chunks::UpsertChunksOptions::default(),
            )
            .unwrap();
        store
            .upsert_chunks(
                "notes/b/1",
                &[chunk(0, None)],
                &crate::chunks::UpsertChunksOptions::default(),
            )
            .unwrap();
        let a = page(&store, DEFAULT_SOURCE, "notes/a/1");
        let read = store.read().unwrap();
        let first_embedded = crate::chunks::read_chunks(&*read, a.id)
            .unwrap()
            .into_iter()
            .find(|c| c.chunk_index == 1)
            .unwrap()
            .id;
        drop(read);
        let representatives = |rows: Vec<Value>| -> Vec<(String, Value)> {
            let mut out: Vec<(String, Value)> = rows
                .iter()
                .map(|r| {
                    (
                        r["slug"].as_str().unwrap().to_string(),
                        r["representative_chunk_id"].clone(),
                    )
                })
                .collect();
            out.sort_by(|x, y| x.0.cmp(&y.0));
            out
        };
        let want = vec![
            ("notes/a/1".to_string(), json!(first_embedded)),
            ("notes/b/1".to_string(), Value::Null),
        ];
        let picked = store
            .list_prefix_sampled_pages(&PrefixSampleOptions {
                prefixes: vec!["notes/a".into(), "notes/b".into()],
                ..PrefixSampleOptions::default()
            })
            .unwrap();
        assert_eq!(representatives(picked), want);
        let sample = store
            .list_corpus_sample(&CorpusSampleOptions {
                n: 10.0,
                seed: Some(0.5),
                ..CorpusSampleOptions::default()
            })
            .unwrap();
        assert_eq!(representatives(sample), want);
    }

    #[test]
    fn revert_refuses_a_segmented_version_of_an_inline_page() {
        let store = store();
        put(&store, "notes/a", None);
        shell(&store, DEFAULT_SOURCE, "notes/a");
        let version = version_id(&store, "notes/a");
        // The page is inline again; only the version is segmented.
        store
            .write(|tx| {
                let mut page = read_page(&*tx, DEFAULT_SOURCE, "notes/a")?.unwrap();
                page.compiled_truth = "inline".into();
                page.timeline = "".into();
                write_page(tx, &page)
            })
            .unwrap();
        let before = page(&store, DEFAULT_SOURCE, "notes/a");
        refused(store.revert_to_version("notes/a", version, &SourceOption::default()));
        let after = page(&store, DEFAULT_SOURCE, "notes/a");
        assert_eq!(after.compiled_truth, "inline");
        assert_eq!(after.updated_at_us, before.updated_at_us);
    }

    #[test]
    fn revert_without_a_source_checks_only_the_pages_that_own_the_version() {
        let store = store();
        let other = serde_json::from_value(json!({"id": "other"})).unwrap();
        store.upsert_source(&other).unwrap();
        put(&store, "notes/a", None);
        let version = version_id(&store, "notes/a");
        put(&store, "notes/a", Some("other"));
        shell(&store, "other", "notes/a");
        // The other source's page does not own the version, so it is not a target and does not refuse.
        store
            .revert_to_version("notes/a", version, &SourceOption::default())
            .unwrap();
        // Scoped to the default source, the inline page reverts.
        store
            .revert_to_version(
                "notes/a",
                version,
                &SourceOption {
                    source_id: Some(DEFAULT_SOURCE.into()),
                },
            )
            .unwrap();
        shell(&store, DEFAULT_SOURCE, "notes/a");
        refused(store.revert_to_version("notes/a", version, &SourceOption::default()));
    }

    // The retirement purge holds. A test sets `deleted_at` directly to stand a tombstone days in the
    // past, since no member writes one with an older clock.

    const HOUR_US: i64 = 3_600_000_000;

    fn put_fm(store: &Store, slug: &str, page_type: &str, frontmatter: Value) -> u64 {
        let input: PageInput = serde_json::from_value(json!({
            "type": page_type, "title": slug, "compiled_truth": "body", "frontmatter": frontmatter
        }))
        .unwrap();
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        page(store, DEFAULT_SOURCE, slug).id
    }

    /// Soft-deletes `slug` as if `days_ago` days (plus an hour, so the clock cannot cross a window
    /// boundary during the test) had passed since.
    fn tombstone(store: &Store, slug: &str, days_ago: i64) {
        let at = store.env.now_micros() - days_ago * DAY_US - HOUR_US;
        store
            .write(|tx| {
                let mut page = read_page(&*tx, DEFAULT_SOURCE, slug)?.unwrap();
                page.deleted_at_us = Some(at);
                write_page(tx, &page)
            })
            .unwrap();
    }

    fn purged(store: &Store, options: Value) -> Vec<String> {
        let out = store
            .purge_deleted_pages(0.0, &serde_json::from_value(options).unwrap())
            .unwrap();
        let mut slugs: Vec<String> = out["slugs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        slugs.sort();
        slugs
    }

    fn atom(origin: &str, hash: &str, retired_at: &str) -> Value {
        json!({ "retired_by": "managed-reextract", "source_slug": origin, "source_hash": hash, "retired_at": retired_at })
    }

    #[test]
    fn the_purge_keeps_a_derived_retirement_for_the_restore_window() {
        let store = store();
        for (slug, stamp) in [
            ("notes/fresh", json!("extract-atoms")),
            ("notes/old", json!("life-chronicle")),
            ("notes/plain", json!(null)),
            ("notes/other", json!("someone-else")),
            ("notes/listed", json!(["extract-atoms"])),
        ] {
            put_fm(&store, slug, "note", json!({ "retired_by": stamp }));
        }
        tombstone(&store, "notes/fresh", 29);
        tombstone(&store, "notes/old", 30);
        for slug in ["notes/plain", "notes/other", "notes/listed"] {
            tombstone(&store, slug, 0);
        }
        let dry = purged(&store, json!({ "dryRun": true }));
        assert_eq!(
            dry,
            ["notes/listed", "notes/old", "notes/other", "notes/plain"]
        );
        assert_eq!(purged(&store, json!({})), dry);
        assert!(
            read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "notes/fresh")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn the_restore_window_reads_generations_restore_days_with_the_pglite_fallback() {
        for (value, held) in [
            (None, true),
            (Some("3"), false),
            (Some("003"), false),
            (Some("365"), true),
            (Some("2"), true),
            (Some("366"), true),
            (Some("0005"), true),
            (Some("5 "), true),
            (Some("abc"), true),
        ] {
            let store = store();
            put_fm(
                &store,
                "notes/r",
                "note",
                json!({ "retired_by": "stale-atoms" }),
            );
            tombstone(&store, "notes/r", 4);
            if let Some(v) = value {
                store.set_config(RESTORE_DAYS_KEY, v).unwrap();
            }
            let kept = purged(&store, json!({ "dryRun": true })).is_empty();
            assert_eq!(kept, held, "restore_days {value:?}");
        }
    }

    #[test]
    fn a_hold_window_is_open_only_while_deleted_at_is_after_its_start() {
        let now = 1_000 * DAY_US;
        let holds = PurgeHolds {
            now,
            restore_days: 5,
            restorable_atoms: HashSet::from([7]),
        };
        let mut record = {
            let store = store();
            put_fm(
                &store,
                "atoms/a",
                "atom",
                json!({ "retired_by": "extract-atoms" }),
            );
            page(&store, DEFAULT_SOURCE, "atoms/a")
        };
        record.deleted_at_us = Some(now - 5 * DAY_US);
        assert!(!holds.holds(&record), "deleted exactly at the window start");
        record.deleted_at_us = Some(now - 5 * DAY_US + 1);
        assert!(holds.holds(&record));
        record.id = 7;
        record.frontmatter = atom("notes/o", "h", "t").as_object().unwrap().clone();
        record.deleted_at_us = Some(now - 30 * DAY_US);
        assert!(!holds.holds(&record), "an atom deleted exactly 30 days ago");
        record.deleted_at_us = Some(now - 30 * DAY_US + 1);
        assert!(
            holds.holds(&record),
            "the atom hold outlasts a 5-day restore window"
        );
        record.id = 8;
        assert!(!holds.holds(&record), "an atom that is not restorable");
    }

    #[test]
    fn the_purge_keeps_a_restorable_atom_for_30_days_past_a_short_restore_window() {
        let store = store();
        store.set_config(RESTORE_DAYS_KEY, "3").unwrap();
        put_fm(&store, "notes/origin", "note", json!({}));
        put_fm(
            &store,
            "atoms/held",
            "atom",
            atom("notes/origin", "pending:h1", "2026-01-02"),
        );
        put_fm(
            &store,
            "atoms/stale",
            "atom",
            atom("notes/origin", "h1", "2026-01-01"),
        );
        put_fm(
            &store,
            "atoms/expired",
            "atom",
            atom("notes/origin", "h1", "2026-01-01"),
        );
        tombstone(&store, "atoms/held", 10);
        tombstone(&store, "atoms/stale", 10);
        tombstone(&store, "atoms/expired", 30);
        // A retirement older than the origin's latest one is still restorable when its hash is the latest hash.
        assert_eq!(purged(&store, json!({ "dryRun": true })), ["atoms/expired"]);
    }

    #[test]
    fn the_purge_releases_an_atom_that_cannot_be_restored() {
        /// A case name, the retired atom's frontmatter, and an optional second atom of the same origin.
        type Case<'a> = (&'a str, Value, Option<(&'a str, Value)>);
        let cases: [Case; 6] = [
            ("origin gone", atom("notes/gone", "h1", "t"), None),
            (
                "no origin",
                json!({ "retired_by": "managed-reextract", "source_hash": "h1" }),
                None,
            ),
            (
                "imported",
                json!({ "retired_by": "managed-reextract", "source_slug": "notes/origin", "source_hash": "h1", "imported_from": "x" }),
                None,
            ),
            (
                "replaced",
                atom("notes/origin", "h1", "t"),
                Some((
                    "atoms/live",
                    json!({ "source_slug": "notes/origin", "source_hash": "h2" }),
                )),
            ),
            (
                "not latest",
                atom("notes/origin", "h1", "2026-01-01"),
                Some(("atoms/newer", atom("notes/origin", "h2", "2026-01-02"))),
            ),
            (
                "latest by id",
                atom("notes/origin", "h1", "t"),
                Some(("atoms/newer", atom("notes/origin", "h2", "t"))),
            ),
        ];
        for (name, frontmatter, other) in cases {
            let store = store();
            store.set_config(RESTORE_DAYS_KEY, "3").unwrap();
            put_fm(&store, "notes/origin", "note", json!({}));
            put_fm(&store, "atoms/a", "atom", frontmatter);
            tombstone(&store, "atoms/a", 10);
            if let Some((slug, fm)) = other {
                put_fm(&store, slug, "atom", fm.clone());
                if fm.get("retired_by").is_some() {
                    tombstone(&store, slug, 10);
                }
            }
            let out = purged(&store, json!({ "dryRun": true }));
            assert!(out.contains(&"atoms/a".to_string()), "{name}: {out:?}");
        }
    }

    #[test]
    fn a_live_atom_with_the_same_hash_does_not_replace_a_retirement() {
        let store = store();
        store.set_config(RESTORE_DAYS_KEY, "3").unwrap();
        put_fm(&store, "notes/origin", "note", json!({}));
        put_fm(&store, "atoms/a", "atom", atom("notes/origin", "h1", "t"));
        put_fm(
            &store,
            "atoms/live",
            "atom",
            json!({ "source_slug": "notes/origin", "source_hash": "pending:h1" }),
        );
        tombstone(&store, "atoms/a", 10);
        assert!(purged(&store, json!({ "dryRun": true })).is_empty());
    }
}
