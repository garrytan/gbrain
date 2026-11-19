//! Pages: the `pages` table of the PGLite engine as records keyed `(source_id, slug)`.
//!
//! A page record holds its tags inline. `knowledge_revision` is a UUID that changes when a
//! canonical field changes (type, kind, title, body, timeline, frontmatter, deletion, tags), the
//! way PGLite's `pages_knowledge_revision` trigger does. Dates are stored as microseconds and
//! cross the binding as ISO strings.
//!
//! `list_pages` and `resolve_slugs` scan every page: there are no secondary indexes yet.

use crate::chunks::{ChunkInput, auto_chunks, clear_chunks, replace_chunks};
use crate::env::{Env, iso, parse_iso};
use crate::error::{
    CONSTRAINT_VIOLATION, EMPTY_OVERWRITE, INVALID_SLUG, INVALID_STATE, ORIGIN_CLAIMED,
    PAGE_NOT_FOUND, REVISION_CONFLICT, REVISION_REQUIRED, Result, StoreError,
};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::sources::{DEFAULT_SOURCE, all_sources, require_source};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

/// Frontmatter keys left out of the content hash (`HASH_EPHEMERAL_FRONTMATTER_KEYS`).
const HASH_EPHEMERAL_KEYS: &[&str] = &[
    "captured_at",
    "ingested_at",
    "quarantine",
    "content_flag",
    "embed_skip",
    "atoms_scan_hash",
    "trust_tier",
];

const NEXT_PAGE_ID: &str = "next_page_id";
const NEXT_VERSION_ID: &str = "next_version_id";

/// A text column of `pages` that PGLite lets be NULL: `compiled_truth` and `timeline` (migration v248).
///
/// Contract (shared item 12, nullable page fields):
/// - NULL means the page is a segmented shell: its body lives in segment texts, not in the row. PGLite's
///   `pages_body_storage_chk` makes both body columns NULL exactly when `body_storage = 'segmented'`, and an inline page
///   always holds a string (`''` for an empty body).
/// - Stored as JSON `null` or a string. A record written before this type existed holds a string and reads as one, so
///   FORMAT_VERSION 1 is unchanged.
/// - As `&str` (through `Deref`) a NULL column reads as `""`, the way PGLite's `rowToStalePage` and chunk paths read
///   it: an inline reader such as `auto_chunks` makes no chunks from a shell. Use `is_null` or `as_deref` where NULL
///   and empty differ.
/// - Equality compares the stored value: NULL is not equal to `""`, so a writer that moves a page between segmented
///   and inline sees a change. `putPage` never does: it refuses a shell (`assert_body_inline`, shared item 11).
/// - `to_page` and the version JSON emit NULL as `null`; the TS codec (`store-codec.ts`) turns it back into PGLite's
///   segmented page shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct PageText(Option<String>);

// The page_body family is the first writer and reader of a NULL column; until it lands only the tests call these.
#[cfg_attr(not(test), allow(dead_code))]
impl PageText {
    /// The NULL column of a segmented shell page.
    pub(crate) fn null() -> Self {
        Self(None)
    }

    /// True for the NULL column of a segmented shell page.
    pub(crate) fn is_null(&self) -> bool {
        self.0.is_none()
    }

    /// The stored text, or `None` for NULL.
    pub(crate) fn as_deref(&self) -> Option<&str> {
        self.0.as_deref()
    }
}

impl std::ops::Deref for PageText {
    type Target = str;

    fn deref(&self) -> &str {
        self.0.as_deref().unwrap_or("")
    }
}

impl From<String> for PageText {
    fn from(text: String) -> Self {
        Self(Some(text))
    }
}

impl From<&str> for PageText {
    fn from(text: &str) -> Self {
        Self(Some(text.to_owned()))
    }
}

impl PartialEq<str> for PageText {
    fn eq(&self, other: &str) -> bool {
        self.0.as_deref() == Some(other)
    }
}

impl PartialEq<&str> for PageText {
    fn eq(&self, other: &&str) -> bool {
        self.0.as_deref() == Some(*other)
    }
}

impl PartialEq<String> for PageText {
    fn eq(&self, other: &String) -> bool {
        self.0.as_deref() == Some(other.as_str())
    }
}

/// What is stored for a page.
///
/// Nullable columns (shared item 12): `compiled_truth` and `timeline` are [`PageText`], NULL exactly on a segmented
/// shell page. `content_hash` is `None` on a segmented shell page until its body is published, as PGLite's
/// `createSegmentedPageShell` leaves it; `put_page` always sets it. `chunker_version` is `None` when the store has not
/// recorded one (the safe-chunks fence reads that as unsafe, as SQL reads NULL): `put_page` keeps the stored value and
/// sets none on a new page, chunk writes stamp it (4 on seal, -1 when they change chunks), and it is not part of `to_page`
/// (PGLite's `rowToPage` leaves it out). Each new field reads as NULL from a record written before it existed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PageRecord {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub page_kind: String,
    pub title: String,
    pub compiled_truth: PageText,
    pub timeline: PageText,
    pub frontmatter: Map<String, Value>,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunker_version: Option<i16>,
    #[serde(default)]
    pub source_path: Option<String>,
    pub knowledge_revision: String,
    #[serde(default)]
    pub text_projection_revision: Option<String>,
    pub created_at_us: i64,
    pub updated_at_us: i64,
    #[serde(default)]
    pub deleted_at_us: Option<i64>,
    #[serde(default)]
    pub effective_date_us: Option<i64>,
    #[serde(default)]
    pub effective_date_source: Option<String>,
    #[serde(default)]
    pub import_filename: Option<String>,
    #[serde(default)]
    pub source_kind: Option<String>,
    #[serde(default)]
    pub source_uri: Option<String>,
    #[serde(default)]
    pub ingested_via: Option<String>,
    #[serde(default)]
    pub ingested_at_us: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Who claimed each tag (`tags.tag_source` of PGLite): `added` for an explicit add,
    /// `frontmatter` for an import-owned tag. A tag with no entry is a legacy unclaimed row.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tag_sources: BTreeMap<String, String>,
    /// The page's trust tier (`pages.trust_tier`). `None` is `unknown`, the column default, and
    /// what a record written before the store stamped pages reads as. [`write_page`] sets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_tier: Option<String>,
    /// The write origin JSON of the write that stamped the tier (`pages.write_origin`). `None` is
    /// NULL. [`write_page`] sets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_origin: Option<Value>,
    /// When the page last lost version history (`pages.version_history_gap_at`): a version prune
    /// (`version_prune`) or `createVersion` with `historyGap`. `None` is NULL. Not part of `to_page`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_history_gap_at_us: Option<i64>,
}

fn opt_iso(us: Option<i64>) -> Value {
    us.map_or(Value::Null, |v| Value::String(iso(v)))
}

impl PageRecord {
    /// The `Page` of `src/core/types.ts`, dates as ISO strings.
    pub(crate) fn to_page(&self) -> Value {
        json!({
            "id": self.id,
            "slug": self.slug,
            "source_id": self.source_id,
            "type": self.page_type,
            "page_kind": self.page_kind,
            "title": self.title,
            "compiled_truth": self.compiled_truth,
            "timeline": self.timeline,
            "frontmatter": self.frontmatter,
            "content_hash": self.content_hash,
            "source_path": self.source_path,
            "knowledge_revision": self.knowledge_revision,
            "text_projection_revision": self.text_projection_revision,
            "created_at": iso(self.created_at_us),
            "updated_at": iso(self.updated_at_us),
            "updated_at_iso": iso(self.updated_at_us),
            "deleted_at": opt_iso(self.deleted_at_us),
            "effective_date": opt_iso(self.effective_date_us),
            "effective_date_source": self.effective_date_source,
            "import_filename": self.import_filename,
            "source_kind": self.source_kind,
            "source_uri": self.source_uri,
            "ingested_via": self.ingested_via,
            "ingested_at": opt_iso(self.ingested_at_us),
        })
    }

    /// `to_page` plus the columns families add (`page_columns::add_page_columns`): the page
    /// `getPage`, `readPageSnapshot` and `listPages` return.
    pub(crate) fn to_page_with_columns(&self, read: &dyn KvRead) -> Result<Value> {
        let mut page = self.to_page();
        crate::page_columns::add_page_columns(read, self, &mut page)?;
        Ok(page)
    }
}

/// `PageInput` of `src/core/types.ts`. Dates are ISO strings. `tags` is read only for the content
/// hash: tags are stored by `add_tag` and `remove_tag`, as in PGLite.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PageInput {
    #[serde(rename = "type")]
    pub page_type: String,
    pub title: String,
    pub compiled_truth: String,
    pub timeline: Option<String>,
    pub frontmatter: Option<Map<String, Value>>,
    pub tags: Option<Vec<String>>,
    pub content_hash: Option<String>,
    pub page_kind: Option<String>,
    pub effective_date: Option<String>,
    pub effective_date_source: Option<String>,
    pub import_filename: Option<String>,
    pub source_path: Option<String>,
    pub source_kind: Option<String>,
    pub source_uri: Option<String>,
    pub ingested_via: Option<String>,
}

pub(crate) fn double_option<'de, D, T>(d: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// `PageWriteOptions`. `expected_revision` has three states: absent (`None`), `null`
/// (`Some(None)`, the page must not exist) or a revision (`Some(Some(uuid))`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PutPageOptions {
    pub source_id: Option<String>,
    pub allow_empty_overwrite: bool,
    #[serde(deserialize_with = "double_option")]
    pub expected_revision: Option<Option<String>>,
    pub force: Option<bool>,
    /// Chunks installed with the page, in the same transaction. When absent the page's body is
    /// split by the built-in chunker whenever its chunks are not current.
    pub chunks: Option<Vec<ChunkInput>>,
    /// `false` installs no chunks and seals nothing: the page is written alone, as PGLite's
    /// `putPage` writes it, and whatever chunks it had stay (unread until they are sealed again).
    /// Default true. `chunks` has no effect when this is false.
    pub index: Option<bool>,
}

/// Which pages a read may see. Mirrors `GetPageOpts`: `source_ids` wins when it is not empty.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReadScope {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub include_deleted: bool,
}

/// Options of `addTag` and `addPageTagsById`: the page's source and who claims the tags.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TagOptions {
    pub source_id: Option<String>,
    pub tag_source: Option<String>,
}

impl TagOptions {
    /// Whether the tags are claimed for the import (`tagSource: 'frontmatter'`); any other named
    /// claim is refused, as the TypeScript type allows no other.
    pub fn frontmatter(&self) -> Result<bool> {
        match self.tag_source.as_deref() {
            None => Ok(false),
            Some(TAG_FRONTMATTER) => Ok(true),
            Some(other) => Err(StoreError::invalid(format!(
                "tagSource must be 'frontmatter' when it is set, not {other:?}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UpdatedKeyset {
    pub updated_at: String,
    pub slug: String,
}

/// `PageFilters`. `sort` is `updated_desc` (default), `updated_asc`, `created_desc` or `slug`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PageFilters {
    #[serde(rename = "type")]
    pub page_type: Option<String>,
    pub tag: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub updated_after: Option<String>,
    #[serde(rename = "updatedAfterKeyset")]
    pub updated_after_keyset: Option<UpdatedKeyset>,
    #[serde(rename = "slugPrefix")]
    pub slug_prefix: Option<String>,
    #[serde(rename = "excludeSlugPrefixes")]
    pub exclude_slug_prefixes: Option<Vec<String>>,
    #[serde(rename = "slugAfter")]
    pub slug_after: Option<String>,
    #[serde(rename = "includeDeleted")]
    pub include_deleted: bool,
    pub sort: Option<String>,
    #[serde(rename = "sourceId")]
    pub source_id: Option<String>,
    #[serde(rename = "sourceIds")]
    pub source_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VersionsOptions {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub limit: Option<usize>,
    /// `false` leaves `compiled_truth` and `timeline` out. Default true.
    pub include_body: Option<bool>,
}

/// A page key given to `lock_page_keys`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PageKey {
    pub source_id: String,
    pub slug: String,
}

/// A page snapshot version, as stored. The body columns and `content_hash` copy the page's, NULL included (PGLite's
/// `page_versions` columns are nullable since v248); a version written before that reads unchanged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct VersionRecord {
    pub id: u64,
    pub page_id: u64,
    pub compiled_truth: PageText,
    pub timeline: PageText,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub tags: Vec<String>,
    pub frontmatter: Map<String, Value>,
    pub source_path: Option<String>,
    #[serde(default)]
    pub content_hash: Option<String>,
    pub knowledge_revision: String,
    pub is_deleted: bool,
    pub snapshot_at_us: i64,
    /// `segmented` on the snapshot of a segmented page (`insertSegmentedVersion`), which references
    /// the page's live body generation instead of copying the body; absent on an inline snapshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_storage: Option<String>,
    /// The body generation a segmented snapshot references: a root of the segment sweep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_generation: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_bytes: Option<i64>,
    /// The page's trust tier when the snapshot was taken (`snapshot_version_trust`); none is
    /// `unknown`. Only `createVersion` returns it: `getVersions` reads no trust columns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_tier: Option<String>,
    /// The page's write origin when the snapshot was taken.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_origin: Option<Value>,
    /// The reason given for the write that replaced the snapshot (`page_versions.change_reason`),
    /// set by `stamp_version_change_reason`; none when no reason was given.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_reason: Option<String>,
    /// `page_versions.successor_pruned`: a prune deleted the version that came next, so a remote
    /// reader is never shown this version's reason (`version_prune::mark_pruned_history`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub successor_pruned: bool,
}

impl VersionRecord {
    fn to_json(&self, include_body: bool) -> Value {
        let mut v = json!({
            "id": self.id,
            "page_id": self.page_id,
            "title": self.title,
            "type": self.page_type,
            "tags": self.tags,
            "frontmatter": self.frontmatter,
            "source_path": self.source_path,
            "content_hash": self.content_hash,
            "knowledge_revision": self.knowledge_revision,
            "is_deleted": self.is_deleted,
            "snapshot_at": iso(self.snapshot_at_us),
        });
        if include_body {
            v["compiled_truth"] = json!(self.compiled_truth);
            v["timeline"] = json!(self.timeline);
        }
        v
    }
}

/// `validateSlug` (`src/core/utils.ts`): returns the slug lower-cased.
pub fn validate_slug(slug: &str) -> Result<String> {
    let bad = |why: &str| {
        Err(StoreError::new(
            INVALID_SLUG,
            format!("Invalid slug: \"{slug}\". {why}"),
        ))
    };
    if slug.is_empty() || slug.starts_with('/') || slug.split('/').any(|segment| segment == "..") {
        return bad("Slugs cannot be empty, start with /, or contain path traversal.");
    }
    if slug
        .chars()
        .any(|c| matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}'))
    {
        return bad("Slugs cannot contain control characters.");
    }
    if slug
        .chars()
        .any(|c| matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
    {
        return bad("Slugs cannot contain bidirectional/RTL override characters.");
    }
    if slug.contains('\\') {
        return bad("Backslashes are not allowed in slugs.");
    }
    let lower = slug.to_lowercase();
    if lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c") {
        return bad("URL-encoded path separators are not allowed in slugs.");
    }
    Ok(lower)
}

fn blank(text: &str) -> bool {
    text.trim().is_empty()
}

/// `sanitizeText`: a NUL byte cannot be stored in text.
pub(crate) fn clean(text: &str) -> String {
    text.replace('\0', "")
}

/// `contentHash` of `src/core/utils.ts`: SHA-256 over
/// `{title, type, compiled_truth, timeline, frontmatter, tags}` as compact JSON, the frontmatter
/// without its ephemeral keys and without `tags`, the tags sorted. Not guaranteed byte-identical
/// to the TypeScript digest for numbers and odd strings; callers that need parity pass
/// `content_hash`.
pub fn content_hash(input: &PageInput) -> String {
    let mut frontmatter = input.frontmatter.clone().unwrap_or_default();
    for key in HASH_EPHEMERAL_KEYS {
        frontmatter.shift_remove(*key);
    }
    let from_frontmatter = frontmatter.shift_remove("tags");
    let raw_tags: Option<Vec<String>> = match (&input.tags, from_frontmatter) {
        (Some(tags), _) => Some(tags.clone()),
        (None, Some(Value::Array(items))) => Some(
            items
                .iter()
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect(),
        ),
        _ => None,
    };
    let mut tags = raw_tags.unwrap_or_default();
    tags.sort();
    let envelope = json!({
        "title": input.title,
        "type": input.page_type,
        "compiled_truth": input.compiled_truth,
        "timeline": input.timeline.clone().unwrap_or_default(),
        "frontmatter": frontmatter,
        "tags": tags,
    });
    let digest = Sha256::digest(serde_json::to_vec(&envelope).unwrap_or_default());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn page_key(source_id: &str, slug: &str) -> Vec<u8> {
    keys::page(source_id, slug)
}

pub(crate) fn read_page(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
) -> Result<Option<PageRecord>> {
    if source_id.contains('\0') || slug.contains('\0') {
        return Ok(None);
    }
    get_json(read, &page_key(source_id, slug))
}

pub(crate) fn read_page_by_id(read: &dyn KvRead, id: u64) -> Result<Option<PageRecord>> {
    let Some(key) = read.get(&keys::page_id(id))? else {
        return Ok(None);
    };
    get_json(read, &key)
}

/// Stores a page record and its id key, keeps its origin key (`o`) in step with it, and calls the
/// page index hook (`page_index::reindex_page`) and the page projection hook
/// (`page_projection::queue_page_projection`) with the record as stored before and after.
///
/// The record's `trust_tier` and `write_origin` are stamped first, as PGLite's
/// `trust_tier_stamp` trigger stamps every row written to `pages` (see [`stamp_page_trust`]).
pub(crate) fn write_page(tx: &mut dyn KvWrite, record: &PageRecord) -> Result<()> {
    write_page_as(tx, record, false)
}

/// `write_page` for a statement that SETs `title` and `timeline` whatever their values: PGLite's search vector trigger
/// (`BEFORE INSERT OR UPDATE OF title, timeline`) then fires also when they are unchanged, and the vector it builds can
/// have grown since (a timeline entry added, an entry's cutoff passed, a lead published), so the check and the
/// sealed search timeline's forgetting run every time.
pub(crate) fn write_page_setting_vector(tx: &mut dyn KvWrite, record: &PageRecord) -> Result<()> {
    write_page_as(tx, record, true)
}

fn write_page_as(tx: &mut dyn KvWrite, record: &PageRecord, sets_vector: bool) -> Result<()> {
    let before = read_page_by_id(&*tx, record.id)?;
    let stamped = stamp_page_trust(before.as_ref(), record)?;
    let record = &stamped;
    // A write that sets the title or timeline fires PGLite's search vector trigger. It builds the vector before the
    // row is stored, and its error ("string is too long for tsvector") aborts the write. A write that does not set
    // them fires it only when they changed.
    if sets_vector
        || before
            .as_ref()
            .is_none_or(|b| b.title != record.title || b.timeline != record.timeline)
    {
        crate::keyword::check_page_vector(&*tx, record)?;
        if before.is_some() {
            forget_search_timeline(tx, record.id)?;
        }
    }
    let key = page_key(&record.source_id, &record.slug);
    put_json(tx, &key, record)?;
    tx.put(&keys::page_id(record.id), &key)?;
    index_origin(tx, before.as_ref(), Some(record))?;
    crate::page_index::reindex_page(tx, before.as_ref(), Some(record))?;
    crate::page_projection::queue_page_projection(tx, before.as_ref(), Some(record))
}

/// `record` with the trust tier and origin PGLite's `trust_tier_stamp` trigger would store, under
/// the write trust context of the open write (`write_trust::stamp_context`).
///
/// A new page (no stored record under its id) is an INSERT: the record's own tier is what the
/// caller supplied, kept only under backfill. A stored page is an UPDATE. No store writer sets a
/// page's tier or origin itself (PGLite's `putPage` and the other page writes leave both columns
/// out of their `SET`), so the update starts from the stored tier and origin, whatever the record
/// carries: a record built before an earlier write in the same transaction restamped the page
/// cannot lower or replace them. The content columns are `TrustTable::Pages.content_columns`, with
/// the frontmatter compared without the trust-ephemeral keys.
fn stamp_page_trust(before: Option<&PageRecord>, record: &PageRecord) -> Result<PageRecord> {
    use crate::trust::{
        OriginStamp, StampRow, TrustTable, TrustTier, page_frontmatter_content, stamp,
    };
    let context = crate::write_trust::stamp_context::current()?;
    let tier_of = |page: &PageRecord| TrustTier::stored(page.trust_tier.as_deref());
    let (row, stored_origin) = match before {
        None => (
            StampRow::Insert {
                supplied: tier_of(record),
            },
            record.write_origin.clone(),
        ),
        Some(old) => {
            let content_changed = old.source_id != record.source_id
                || old.slug != record.slug
                || old.page_type != record.page_type
                || old.page_kind != record.page_kind
                || old.title != record.title
                || old.compiled_truth != record.compiled_truth
                || old.timeline != record.timeline
                || old.deleted_at_us != record.deleted_at_us
                || page_frontmatter_content(&old.frontmatter)
                    != page_frontmatter_content(&record.frontmatter);
            (
                StampRow::Update {
                    old: tier_of(old),
                    new: tier_of(old),
                    content_changed,
                    origin_set: false,
                },
                old.write_origin.clone(),
            )
        }
    };
    let stamped = stamp(&context, TrustTable::Pages, row)?;
    let mut out = record.clone();
    out.trust_tier = (stamped.tier != TrustTier::Unknown).then(|| stamped.tier.as_str().to_owned());
    out.write_origin = match stamped.origin {
        OriginStamp::Keep => stored_origin,
        OriginStamp::Set(origin) => origin,
    };
    Ok(out)
}

/// An origin (`source_path`) in the form PGLite compares two of them: as stored, and on Windows
/// with `\` read as `/` and case folded (`originKey` of `persistence/origin-guard.ts`).
pub(crate) fn origin_key(path: &str) -> String {
    if cfg!(windows) {
        path.replace('\\', "/").to_lowercase()
    } else {
        path.to_owned()
    }
}

/// The origin a page claims: its `source_path` while the page is live and the path is not empty.
pub(crate) fn claimed_origin(page: &PageRecord) -> Option<String> {
    match (&page.source_path, page.deleted_at_us) {
        (Some(path), None) if !path.is_empty() => Some(origin_key(path)),
        _ => None,
    }
}

/// Moves a page's `o` key from what `before` claimed to what `after` claims.
fn index_origin(
    tx: &mut dyn KvWrite,
    before: Option<&PageRecord>,
    after: Option<&PageRecord>,
) -> Result<()> {
    let key = |page: &PageRecord| {
        claimed_origin(page).map(|origin| keys::page_origin(&page.source_id, &origin, page.id))
    };
    let (old, new) = (before.and_then(key), after.and_then(key));
    if old == new {
        return Ok(());
    }
    if let Some(old) = old {
        tx.delete(&old)?;
    }
    match new {
        Some(new) => tx.put(&new, &[]),
        None => Ok(()),
    }
}

/// The slugs of the live pages of `source_id`, other than page `except`, that record `origin`.
fn origin_holders(
    read: &dyn KvRead,
    source_id: &str,
    origin: &str,
    except: Option<u64>,
) -> Result<Vec<String>> {
    let wanted = origin_key(origin);
    let mut ids = Vec::new();
    scan_prefix(
        read,
        &keys::page_origin_prefix(source_id, &wanted),
        false,
        &mut |k, _| {
            ids.extend(k.len().checked_sub(8).and_then(|at| keys::be8(&k[at..])));
            true
        },
    )?;
    let mut slugs = Vec::new();
    for id in ids.into_iter().filter(|id| Some(*id) != except) {
        if let Some(page) = read_page_by_id(read, id)?
            && page.source_id == source_id
            && claimed_origin(&page).as_deref() == Some(wanted.as_str())
        {
            slugs.push(page.slug);
        }
    }
    slugs.sort();
    Ok(slugs)
}

/// `assertOriginUnclaimed` (`persistence/origin-guard.ts`) for a write that leaves page `slug` of
/// `source_id` live: `target` is the page as stored (`None` for an insert) and `source_path` the
/// origin the write records (`None` keeps the stored one). Refuses with `origin_claimed` when
/// another live page of the source records that origin, unless the target is live and already
/// records it. An empty origin is never checked.
pub(crate) fn assert_origin_unclaimed(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
    target: Option<&PageRecord>,
    source_path: Option<&str>,
) -> Result<()> {
    let Some(origin) = source_path
        .or_else(|| target.and_then(|page| page.source_path.as_deref()))
        .filter(|origin| !origin.is_empty())
    else {
        return Ok(());
    };
    if let Some(page) = target
        && page.deleted_at_us.is_none()
        && page.source_path.as_deref().map(origin_key) == Some(origin_key(origin))
    {
        return Ok(());
    }
    let holders = origin_holders(read, source_id, origin, target.map(|page| page.id))?;
    if holders.is_empty() {
        return Ok(());
    }
    Err(StoreError::new(
        ORIGIN_CLAIMED,
        json!({
            "source_id": source_id,
            "source_path": origin,
            "holders": holders,
            "slug": target.map_or(slug, |page| page.slug.as_str()),
        })
        .to_string(),
    ))
}

pub(crate) fn next_id(tx: &mut dyn KvWrite, name: &str) -> Result<u64> {
    let key = keys::meta(name);
    let current = match tx.get(&key)? {
        Some(bytes) => keys::be8(&bytes)
            .ok_or_else(|| StoreError::new(crate::error::STORE_CORRUPT, "bad id counter"))?,
        None => 1,
    };
    tx.put(&key, &(current + 1).to_be_bytes())?;
    Ok(current)
}

pub(crate) fn all_pages(read: &dyn KvRead) -> Result<Vec<PageRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::PAGE], false, &mut |_, v| {
        match serde_json::from_slice::<PageRecord>(v) {
            Ok(record) => out.push(record),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// The sources a read covers: `source_ids` when not empty, else `source_id`, else every source
/// (`default` first).
pub(crate) fn scope_sources(
    read: &dyn KvRead,
    source_id: &Option<String>,
    source_ids: &Option<Vec<String>>,
) -> Result<Vec<String>> {
    if let Some(ids) = source_ids.as_ref().filter(|ids| !ids.is_empty()) {
        return Ok(ids.clone());
    }
    if let Some(id) = source_id.as_ref().filter(|id| !id.is_empty()) {
        return Ok(vec![id.clone()]);
    }
    let mut ids: Vec<String> = all_sources(read)?.into_iter().map(|r| r.id).collect();
    ids.sort_by(|a, b| {
        (b == DEFAULT_SOURCE)
            .cmp(&(a == DEFAULT_SOURCE))
            .then_with(|| a.cmp(b))
    });
    Ok(ids)
}

pub(crate) fn find_in_scope(
    read: &dyn KvRead,
    slug: &str,
    source_id: &Option<String>,
    source_ids: &Option<Vec<String>>,
    include_deleted: bool,
) -> Result<Option<PageRecord>> {
    for id in scope_sources(read, source_id, source_ids)? {
        if let Some(page) = read_page(read, &id, slug)?
            && (include_deleted || page.deleted_at_us.is_none())
        {
            return Ok(Some(page));
        }
    }
    Ok(None)
}

fn parse_date(text: &str, what: &str) -> Result<i64> {
    let full = if text.len() == 10 {
        format!("{text}T00:00:00Z")
    } else {
        text.to_string()
    };
    parse_iso(&full).ok_or_else(|| {
        StoreError::invalid(format!(
            "{what} must be an ISO timestamp ending in Z or YYYY-MM-DD"
        ))
    })
}

/// `assertPageRevision`: the page (deleted or not) must be at the revision the caller expects.
fn assert_revision(existing: Option<&PageRecord>, options: &PutPageOptions) -> Result<()> {
    if let Some(Some(revision)) = &options.expected_revision
        && !crate::env::is_uuid(revision)
    {
        return Err(StoreError::invalid(
            "expectedRevision must be a UUID revision",
        ));
    }
    if options.force == Some(true) && options.expected_revision.is_some() {
        return Err(StoreError::invalid(
            "force and expectedRevision are mutually exclusive",
        ));
    }
    if options.force == Some(true) {
        return Ok(());
    }
    let current = existing.map(|p| p.knowledge_revision.as_str());
    let expected = options
        .expected_revision
        .as_ref()
        .and_then(|e| e.as_deref())
        .map(str::to_lowercase);
    if current != expected.as_deref() {
        let required = options.expected_revision.is_none() && current.is_some();
        return Err(StoreError::new(
            if required {
                REVISION_REQUIRED
            } else {
                REVISION_CONFLICT
            },
            match (current, &options.expected_revision) {
                (None, _) => "The page no longer exists at the expected revision.",
                (Some(_), None) => "The page already exists; an expected revision is required.",
                (Some(_), Some(None)) => {
                    "The page was created after it was read. Read its current revision before retrying."
                }
                _ => {
                    "The page changed after it was read. Read its current revision before retrying."
                }
            },
        ));
    }
    Ok(())
}

/// The message of PGLite's `pages_body_storage_chk`, the CHECK that keeps a segmented page's body columns NULL.
pub(crate) const BODY_STORAGE_CHECK: &str =
    "new row for relation \"pages\" violates check constraint \"pages_body_storage_chk\"";

/// Segmented guard (shared item 11). `putPage` writes the body as one string, and PGLite's `pages_body_storage_chk`
/// refuses that over a segmented page, live or soft-deleted: its `ON CONFLICT` update sets `compiled_truth` and leaves
/// `body_storage = 'segmented'`. A NULL body marks the segmented page here. Runs after the empty-overwrite check, as
/// PGLite's order is; the write stores nothing.
fn assert_body_inline(existing: Option<&PageRecord>) -> Result<()> {
    if existing.is_some_and(|page| page.compiled_truth.is_null()) {
        return Err(StoreError::new(CONSTRAINT_VIOLATION, BODY_STORAGE_CHECK));
    }
    Ok(())
}

/// Inserts or updates a page inside the caller's write transaction. Returns the stored record.
pub(crate) fn put_page_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    slug: &str,
    input: &PageInput,
    options: &PutPageOptions,
) -> Result<PageRecord> {
    let slug = validate_slug(slug)?;
    let source_id = options
        .source_id
        .clone()
        .unwrap_or_else(|| DEFAULT_SOURCE.into());
    require_source(&*tx, &source_id)?;
    let existing = read_page(&*tx, &source_id, &slug)?;
    if options.expected_revision.is_some() || options.force.is_some() {
        assert_revision(existing.as_ref(), options)?;
    }
    if input
        .source_path
        .as_deref()
        .is_some_and(|path| path.contains('\0'))
    {
        return Err(StoreError::invalid(
            "putPage: source_path contains a NUL byte",
        ));
    }
    assert_origin_unclaimed(
        &*tx,
        &source_id,
        &slug,
        existing.as_ref(),
        input.source_path.as_deref(),
    )?;
    // A segmented shell's NULL body is not blank: PGLite refuses an empty write over it too.
    if blank(&input.compiled_truth)
        && !options.allow_empty_overwrite
        && let Some(prior) = existing.as_ref().filter(|p| p.deleted_at_us.is_none())
        && (prior.compiled_truth.is_null() || !blank(&prior.compiled_truth))
    {
        let size = if prior.compiled_truth.is_null() {
            "segmented".to_string()
        } else {
            format!("{} chars", prior.compiled_truth.chars().count())
        };
        return Err(StoreError::new(
            EMPTY_OVERWRITE,
            format!(
                "putPage: refusing to overwrite non-empty page '{slug}' ({size}) with an empty body - likely a read-modify-write that read empty. Pass {{ allowEmptyOverwrite: true }} to force, or deletePage to remove it."
            ),
        ));
    }
    assert_body_inline(existing.as_ref())?;
    let now = env.now_micros();
    let effective_date = input
        .effective_date
        .as_deref()
        .map(|d| parse_date(d, "effective_date"))
        .transpose()?;
    let provenance =
        input.source_kind.is_some() || input.source_uri.is_some() || input.ingested_via.is_some();
    let hash = match &input.content_hash {
        Some(h) if !h.is_empty() => h.clone(),
        _ => content_hash(input),
    };
    let frontmatter = input.frontmatter.clone().unwrap_or_default();
    let title = clean(&input.title);
    let compiled_truth = clean(&input.compiled_truth);
    let timeline = clean(input.timeline.as_deref().unwrap_or(""));
    let page_kind = input.page_kind.clone().unwrap_or_else(|| "markdown".into());

    let record = match existing {
        None => PageRecord {
            id: next_id(tx, NEXT_PAGE_ID)?,
            source_id,
            slug,
            page_type: input.page_type.clone(),
            page_kind,
            title,
            compiled_truth: compiled_truth.into(),
            timeline: timeline.into(),
            frontmatter,
            content_hash: Some(hash),
            chunker_version: None,
            source_path: input.source_path.clone(),
            knowledge_revision: env.new_uuid(),
            text_projection_revision: None,
            created_at_us: now,
            updated_at_us: now,
            deleted_at_us: None,
            effective_date_us: effective_date,
            effective_date_source: input.effective_date_source.clone(),
            import_filename: input.import_filename.clone(),
            source_kind: input.source_kind.clone(),
            source_uri: input.source_uri.clone(),
            ingested_via: input.ingested_via.clone(),
            ingested_at_us: provenance.then_some(now),
            tags: Vec::new(),
            tag_sources: BTreeMap::new(),
            trust_tier: None,
            write_origin: None,
            version_history_gap_at_us: None,
        },
        Some(old) => {
            let canonical_changed = old.page_type != input.page_type
                || old.page_kind != page_kind
                || old.title != title
                || old.compiled_truth != compiled_truth
                || old.timeline != timeline
                || old.frontmatter != frontmatter
                || old.deleted_at_us.is_some();
            let (knowledge_revision, projection) = if canonical_changed {
                (env.new_uuid(), None)
            } else {
                (
                    old.knowledge_revision.clone(),
                    old.text_projection_revision.clone(),
                )
            };
            PageRecord {
                page_type: input.page_type.clone(),
                page_kind,
                title,
                compiled_truth: compiled_truth.into(),
                timeline: timeline.into(),
                frontmatter,
                content_hash: Some(hash),
                knowledge_revision,
                text_projection_revision: projection,
                updated_at_us: now,
                deleted_at_us: None,
                effective_date_us: effective_date.or(old.effective_date_us),
                effective_date_source: input
                    .effective_date_source
                    .clone()
                    .or(old.effective_date_source.clone()),
                import_filename: input
                    .import_filename
                    .clone()
                    .or(old.import_filename.clone()),
                source_path: input.source_path.clone().or(old.source_path.clone()),
                source_kind: input.source_kind.clone().or(old.source_kind.clone()),
                source_uri: input.source_uri.clone().or(old.source_uri.clone()),
                ingested_via: input.ingested_via.clone().or(old.ingested_via.clone()),
                ingested_at_us: if provenance {
                    Some(now)
                } else {
                    old.ingested_at_us
                },
                ..old
            }
        }
    };
    // PGLite's `trg_pages_search_vector` (BEFORE INSERT OR UPDATE OF title, timeline) rewrites the
    // page keyword vector on every `putPage`, also when the values are unchanged.
    write_page_setting_vector(tx, &record)?;
    let mut record = record;
    if options.index == Some(false) {
        return Ok(record);
    }
    match &options.chunks {
        Some(chunks) => replace_chunks(tx, &mut record, chunks, true, false, false)?,
        None if record.text_projection_revision.as_deref()
            != Some(record.knowledge_revision.as_str()) =>
        {
            let chunks = auto_chunks(&record);
            replace_chunks(tx, &mut record, &chunks, true, false, false)?
        }
        None => {}
    }
    Ok(record)
}

fn tag_change(tx: &mut dyn KvWrite, env: &dyn Env, page: &mut PageRecord) -> Result<()> {
    page.knowledge_revision = env.new_uuid();
    page.text_projection_revision = None;
    write_page(tx, page)
}

/// The page move of `updateSlug`: `UPDATE pages SET slug = new, updated_at = now()`. `page` is
/// the record as stored. The page keeps its id, so its chunks, links, tags, timeline and versions
/// follow it with no change. A new slug takes a new `knowledge_revision` and clears
/// `text_projection_revision`, as the `gbrain_advance_page_revision` trigger does; the same slug
/// changes only `updated_at`. `new_slug` goes through `validate_slug`. Refuses with
/// `constraint_violation` when the source already holds a page (live or soft deleted) at the new
/// slug, and the caller then returns the error so the transaction keeps nothing. The caller
/// versions the page before, and records the alias after; this moves only the page.
// aliases (updateSlug) is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn rename_page(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    page: &PageRecord,
    new_slug: &str,
) -> Result<PageRecord> {
    let slug = validate_slug(new_slug)?;
    let mut moved = page.clone();
    moved.updated_at_us = env.now_micros();
    let renamed = slug != page.slug;
    if renamed {
        if read_page(&*tx, &page.source_id, &slug)?.is_some() {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                format!(
                    "duplicate key value violates unique constraint: page \"{slug}\" already exists (source={})",
                    page.source_id
                ),
            ));
        }
        moved.slug = slug;
        moved.knowledge_revision = env.new_uuid();
        moved.text_projection_revision = None;
    }
    // Write the new key before deleting the old one: the page id key then always points at a
    // record that exists.
    write_page(tx, &moved)?;
    if renamed {
        tx.delete(&page_key(&page.source_id, &page.slug))?;
    }
    Ok(moved)
}

const TAG_ADDED: &str = "added";
const TAG_FRONTMATTER: &str = "frontmatter";

/// Adds `tags` to the page with PGLite's claim rules: an explicit add claims each tag `added`; a
/// `frontmatter` claim marks a new tag and adopts only an unclaimed legacy one. A new tag
/// advances the page revision, as PGLite's `tags_knowledge_revision` trigger does; a claim that
/// changes alone does not. Writes the page only when something changed.
fn claim_tags<'a>(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    page: &mut PageRecord,
    tags: impl IntoIterator<Item = &'a str>,
    frontmatter: bool,
) -> Result<()> {
    let mut added = false;
    let mut claimed = false;
    for tag in tags {
        let tag = clean(tag);
        if !page.tags.contains(&tag) {
            page.tags.push(tag.clone());
            added = true;
        }
        let claim = match page.tag_sources.get(&tag) {
            None if frontmatter => TAG_FRONTMATTER,
            Some(_) if frontmatter => continue,
            Some(current) if current == TAG_ADDED => continue,
            _ => TAG_ADDED,
        };
        page.tag_sources.insert(tag, claim.to_string());
        claimed = true;
    }
    if added {
        tag_change(tx, env, page)
    } else if claimed {
        write_page(tx, page)
    } else {
        Ok(())
    }
}

fn cmp_updated(a: &PageRecord, b: &PageRecord) -> Ordering {
    a.updated_at_us
        .cmp(&b.updated_at_us)
        .then_with(|| a.slug.cmp(&b.slug))
        .then_with(|| a.source_id.cmp(&b.source_id))
        .then_with(|| a.id.cmp(&b.id))
}

impl Store {
    /// `readPageSnapshot(slug, opts)`: `{page, tags, revision, sourceIncarnation, withdrawals}`
    /// or `None` when the page is not visible in the scope.
    pub fn read_page_snapshot(&self, slug: &str, scope: &ReadScope) -> Result<Option<Value>> {
        let read = self.read()?;
        let slug = slug.to_lowercase();
        let Some(page) = find_in_scope(
            &*read,
            &slug,
            &scope.source_id,
            &scope.source_ids,
            scope.include_deleted,
        )?
        else {
            return Ok(None);
        };
        let incarnation = crate::sources::read_source(&*read, &page.source_id)?
            .map(|s| s.incarnation)
            .unwrap_or_default();
        let mut tags = page.tags.clone();
        tags.sort();
        Ok(Some(json!({
            "page": page.to_page_with_columns(&*read)?,
            "tags": tags,
            "revision": page.knowledge_revision,
            "sourceIncarnation": incarnation,
            "withdrawals": [],
        })))
    }

    /// `putPage(slug, page, opts)`: the stored `Page`.
    pub fn put_page(
        &self,
        slug: &str,
        input: &PageInput,
        options: &PutPageOptions,
    ) -> Result<Value> {
        self.write(|tx| Ok(put_page_in(tx, &*self.env, slug, input, options)?.to_page()))
    }

    /// `listPages(filters)`. Scans every page.
    pub fn list_pages(&self, filters: &PageFilters) -> Result<Vec<Value>> {
        let limit = filters.limit.filter(|l| *l > 0).unwrap_or(100);
        let offset = filters.offset.unwrap_or(0);
        let after = match &filters.updated_after_keyset {
            Some(k) => Some((
                parse_date(&k.updated_at, "updatedAfterKeyset.updatedAt")?,
                Some(k.slug.clone()),
            )),
            None => filters
                .updated_after
                .as_deref()
                .map(|d| parse_date(d, "updated_after"))
                .transpose()?
                .map(|t| (t, None)),
        };
        let sources: Option<BTreeSet<&str>> = match (&filters.source_ids, &filters.source_id) {
            (Some(ids), _) if !ids.is_empty() => Some(ids.iter().map(String::as_str).collect()),
            (_, Some(id)) if !id.is_empty() => Some(BTreeSet::from([id.as_str()])),
            _ => None,
        };
        let excluded: Vec<&str> = filters
            .exclude_slug_prefixes
            .iter()
            .flatten()
            .map(String::as_str)
            .filter(|p| !p.is_empty())
            .collect();
        // One snapshot serves the page scan and the family columns.
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                (filters.include_deleted || p.deleted_at_us.is_none())
                    && filters.page_type.as_ref().is_none_or(|t| &p.page_type == t)
                    && filters.tag.as_ref().is_none_or(|t| p.tags.contains(t))
                    && sources
                        .as_ref()
                        .is_none_or(|s| s.contains(p.source_id.as_str()))
                    && filters
                        .slug_prefix
                        .as_ref()
                        .is_none_or(|x| p.slug.starts_with(x.as_str()))
                    && !excluded.iter().any(|x| p.slug.starts_with(x))
                    && filters
                        .slug_after
                        .as_ref()
                        .is_none_or(|x| p.slug.as_str() > x.as_str())
                    && match &after {
                        None => true,
                        Some((ts, None)) => p.updated_at_us > *ts,
                        Some((ts, Some(slug))) => {
                            p.updated_at_us > *ts
                                || (p.updated_at_us == *ts && p.slug.as_str() > slug.as_str())
                        }
                    }
            })
            .collect();
        match filters.sort.as_deref() {
            Some("updated_asc") => pages.sort_by(cmp_updated),
            Some("created_desc") => pages.sort_by(|a, b| {
                b.created_at_us
                    .cmp(&a.created_at_us)
                    .then_with(|| b.id.cmp(&a.id))
            }),
            Some("slug") => pages.sort_by(|a, b| {
                a.slug
                    .cmp(&b.slug)
                    .then_with(|| a.source_id.cmp(&b.source_id))
                    .then_with(|| a.id.cmp(&b.id))
            }),
            _ => pages.sort_by(|a, b| cmp_updated(b, a)),
        }
        pages
            .iter()
            .skip(offset)
            .take(limit)
            .map(|page| page.to_page_with_columns(&*read))
            .collect()
    }

    /// Number of live pages, optionally in one source.
    pub fn count_pages(&self, source_id: Option<&str>) -> Result<u64> {
        Ok(all_pages(&*self.read()?)?
            .iter()
            .filter(|p| p.deleted_at_us.is_none() && source_id.is_none_or(|s| p.source_id == s))
            .count() as u64)
    }

    /// `lockPageKeys(keys)`: one process owns the brain and one write transaction runs at a time,
    /// so every key is already held. The call checks that the keys are well formed.
    pub fn lock_page_keys(&self, keys: &[PageKey]) -> Result<()> {
        for key in keys {
            validate_slug(&key.slug)?;
            if key.source_id.is_empty() || key.source_id.contains('\0') {
                return Err(StoreError::invalid("a page key needs a sourceId"));
            }
        }
        Ok(())
    }

    /// `resolveSlugs(partial, opts)`, the exact half: the live slug equal to `partial`, as PGLite
    /// answers first. When no live page has that slug PGLite goes on to a trigram match on titles
    /// (and an `ILIKE` on slugs), which this store does not have, so the answer is the empty list
    /// and means only "no exact match": the caller must not take it for "nothing resembles it".
    pub fn resolve_slugs(&self, partial: &str, scope: &ReadScope) -> Result<Vec<String>> {
        let read = self.read()?;
        let sources: Option<BTreeSet<String>> = match (&scope.source_ids, &scope.source_id) {
            (Some(ids), _) if !ids.is_empty() => Some(ids.iter().cloned().collect()),
            (_, Some(id)) if !id.is_empty() => Some(BTreeSet::from([id.clone()])),
            _ => None,
        };
        let exact = all_pages(&*read)?.into_iter().find(|p| {
            p.deleted_at_us.is_none()
                && p.slug == partial
                && sources.as_ref().is_none_or(|s| s.contains(&p.source_id))
        });
        Ok(exact.map(|p| vec![p.slug]).unwrap_or_default())
    }

    /// `softDeletePage`: hides the page. `None` when no live page matches. With no `source_id` it
    /// hides the slug in every source, in one transaction, as PGLite's `UPDATE ... WHERE slug = $1`
    /// does. The slug is matched as written (stored slugs are lower case, so `Notes/A` matches
    /// nothing), as PGLite matches it.
    pub fn soft_delete_page(&self, slug: &str, source_id: Option<&str>) -> Result<Option<String>> {
        self.write(|tx| {
            let sources = scope_sources(&*tx, &source_id.map(String::from), &None)?;
            let now = self.env.now_micros();
            let mut hidden = None;
            for id in sources {
                if let Some(mut page) = read_page(&*tx, &id, slug)?
                    && page.deleted_at_us.is_none()
                {
                    page.deleted_at_us = Some(now);
                    tag_change(tx, &*self.env, &mut page)?;
                    hidden.get_or_insert(page.slug);
                }
            }
            Ok(hidden)
        })
    }

    /// `restorePage`: brings a soft-deleted page back; with no `source_id`, in every source. False
    /// when none matches. The slug is matched as written, as in `soft_delete_page`.
    pub fn restore_page(&self, slug: &str, source_id: Option<&str>) -> Result<bool> {
        self.write(|tx| {
            let sources = scope_sources(&*tx, &source_id.map(String::from), &None)?;
            let now = self.env.now_micros();
            let mut tombstones = Vec::new();
            for id in sources {
                if let Some(page) = read_page(&*tx, &id, slug)?
                    && page.deleted_at_us.is_some()
                {
                    tombstones.push(page);
                }
            }
            // `assertRevivalUnclaimed`: every page checked, in source order, before any revives.
            tombstones.sort_by(|a, b| a.source_id.cmp(&b.source_id));
            for page in &tombstones {
                assert_origin_unclaimed(&*tx, &page.source_id, &page.slug, Some(page), None)?;
            }
            let mut restored = false;
            for mut page in tombstones {
                page.deleted_at_us = None;
                page.updated_at_us = now;
                tag_change(tx, &*self.env, &mut page)?;
                restored = true;
            }
            Ok(restored)
        })
    }

    /// `deletePage`: removes the page row for good, with its versions. Only the one source named
    /// (`default` when none is), as PGLite's hard delete does; the slug is matched as written.
    pub fn delete_page(&self, slug: &str, source_id: Option<&str>) -> Result<()> {
        self.write(|tx| {
            let source = source_id.unwrap_or(DEFAULT_SOURCE);
            if let Some(page) = read_page(&*tx, source, slug)? {
                remove_page(tx, &page)?;
            }
            Ok(())
        })
    }

    /// `getTags(slug, opts)`, sorted.
    pub fn get_tags(&self, slug: &str, scope: &ReadScope) -> Result<Vec<String>> {
        let read = self.read()?;
        let page = find_in_scope(
            &*read,
            &slug.to_lowercase(),
            &scope.source_id,
            &scope.source_ids,
            true,
        )?;
        let mut tags = page.map(|p| p.tags).unwrap_or_default();
        tags.sort();
        Ok(tags)
    }

    /// `addTag`: `page_not_found` when the page does not exist. An explicit add claims the tag
    /// (`added`); a `frontmatter` add claims a new tag and adopts only an unclaimed one. A tag the
    /// page has keeps the page revision.
    pub fn add_tag(&self, slug: &str, tag: &str, source_id: Option<&str>) -> Result<()> {
        self.add_tag_claimed(slug, tag, source_id, false)
    }

    /// `addTag(slug, tag, { sourceId?, tagSource? })`: `add_tag` with the claim `tagSource` names.
    pub fn add_tag_claimed(
        &self,
        slug: &str,
        tag: &str,
        source_id: Option<&str>,
        frontmatter: bool,
    ) -> Result<()> {
        self.write(|tx| {
            let source = source_id.unwrap_or(DEFAULT_SOURCE);
            let Some(mut page) = read_page(&*tx, source, &slug.to_lowercase())? else {
                return Err(StoreError::new(
                    PAGE_NOT_FOUND,
                    format!("addTag failed: page \"{slug}\" (source={source}) not found"),
                ));
            };
            claim_tags(tx, &*self.env, &mut page, [tag], frontmatter)
        })
    }

    /// `addPageTagsById(pageId, tags, { tagSource? })`: `add_tag_claimed` for many tags of one
    /// page named by id. No tags change nothing; `page_not_found` when no page has the id (PGLite
    /// refuses the insert on its foreign key).
    pub fn add_page_tags_by_id(
        &self,
        page_id: u64,
        tags: &[String],
        frontmatter: bool,
    ) -> Result<()> {
        if tags.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            let Some(mut page) = read_page_by_id(&*tx, page_id)? else {
                return Err(StoreError::new(
                    PAGE_NOT_FOUND,
                    format!("addPageTagsById failed: no page has id {page_id}"),
                ));
            };
            claim_tags(
                tx,
                &*self.env,
                &mut page,
                tags.iter().map(String::as_str),
                frontmatter,
            )
        })
    }

    /// `pruneFrontmatterTags(slug, keep, { sourceId? })`: removes the page's `frontmatter` tags
    /// that are not in `keep`; explicitly added and unclaimed tags stay. No error when the page is
    /// absent.
    pub fn prune_frontmatter_tags(
        &self,
        slug: &str,
        keep: &[String],
        source_id: Option<&str>,
    ) -> Result<()> {
        self.write(|tx| {
            let source = source_id.unwrap_or(DEFAULT_SOURCE);
            let Some(mut page) = read_page(&*tx, source, &slug.to_lowercase())? else {
                return Ok(());
            };
            let pruned: Vec<String> = page
                .tags
                .iter()
                .filter(|t| {
                    page.tag_sources.get(*t).map(String::as_str) == Some(TAG_FRONTMATTER)
                        && !keep.contains(t)
                })
                .cloned()
                .collect();
            if pruned.is_empty() {
                return Ok(());
            }
            page.tags.retain(|t| !pruned.contains(t));
            for tag in &pruned {
                page.tag_sources.remove(tag);
            }
            tag_change(tx, &*self.env, &mut page)
        })
    }

    /// `removeTag`: no error when the page or the tag is absent.
    pub fn remove_tag(&self, slug: &str, tag: &str, source_id: Option<&str>) -> Result<()> {
        self.write(|tx| {
            let source = source_id.unwrap_or(DEFAULT_SOURCE);
            if let Some(mut page) = read_page(&*tx, source, &slug.to_lowercase())?
                && page.tags.iter().any(|t| t == tag)
            {
                page.tags.retain(|t| t != tag);
                page.tag_sources.remove(tag);
                tag_change(tx, &*self.env, &mut page)?;
            }
            Ok(())
        })
    }

    /// `createVersion(slug, {sourceId})`: snapshots the page as it is. A segmented page (NULL body)
    /// is refused with `invalid_state` before anything is written: PGLite versions it as a reference
    /// to its live body generation, which pins that generation's manifest rows against the segment
    /// sweep, and this store keeps no such reference.
    pub fn create_version(&self, slug: &str, source_id: Option<&str>) -> Result<Value> {
        self.write(|tx| {
            let source = source_id.unwrap_or(DEFAULT_SOURCE);
            let Some(page) = read_page(&*tx, source, &slug.to_lowercase())? else {
                return Err(StoreError::new(
                    PAGE_NOT_FOUND,
                    format!("createVersion failed: page \"{slug}\" (source={source}) not found"),
                ));
            };
            if page.compiled_truth.is_null() {
                return Err(StoreError::new(
                    INVALID_STATE,
                    format!("createVersion refuses segmented page {slug} (source={source})"),
                ));
            }
            Ok(snapshot_in(tx, &*self.env, &page)?.to_json(true))
        })
    }

    /// `getVersions(slug, opts)`, newest first.
    pub fn get_versions(&self, slug: &str, options: &VersionsOptions) -> Result<Vec<Value>> {
        let read = self.read()?;
        let slug = slug.to_lowercase();
        let include_body = options.include_body.unwrap_or(true);
        let mut rows: Vec<VersionRecord> = Vec::new();
        let sources = scope_sources(&*read, &options.source_id, &options.source_ids)?;
        for id in sources {
            if let Some(page) = read_page(&*read, &id, &slug)? {
                scan_prefix(
                    &*read,
                    &keys::version_prefix(page.id),
                    false,
                    &mut |_, v| {
                        if let Ok(row) = serde_json::from_slice::<VersionRecord>(v) {
                            rows.push(row);
                        }
                        true
                    },
                )?;
            }
        }
        rows.sort_by_key(|a| std::cmp::Reverse(a.id));
        if let Some(limit) = options.limit {
            rows.truncate(limit);
        }
        Ok(rows.iter().map(|r| r.to_json(include_body)).collect())
    }
}

pub(crate) fn snapshot_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    page: &PageRecord,
) -> Result<VersionRecord> {
    let id = next_id(tx, NEXT_VERSION_ID)?;
    let mut tags = page.tags.clone();
    tags.sort();
    let segmented = crate::page_body::segmented_reference(&*tx, page.id)?;
    // `snapshot_version_trust`: the snapshot copies the page's stamped tier and origin. No store
    // caller supplies its own, so the backfill branch never applies.
    let (tier, write_origin) = crate::trust::snapshot_version(
        &crate::write_trust::stamp_context::current()?,
        crate::trust::TrustTier::stored(page.trust_tier.as_deref()),
        page.write_origin.as_ref(),
        None,
    );
    let row = VersionRecord {
        id,
        page_id: page.id,
        compiled_truth: page.compiled_truth.clone(),
        timeline: page.timeline.clone(),
        title: page.title.clone(),
        page_type: page.page_type.clone(),
        tags,
        frontmatter: page.frontmatter.clone(),
        source_path: page.source_path.clone(),
        content_hash: page.content_hash.clone(),
        knowledge_revision: page.knowledge_revision.clone(),
        is_deleted: page.deleted_at_us.is_some(),
        snapshot_at_us: env.now_micros(),
        body_storage: segmented.map(|_| "segmented".to_string()),
        body_generation: segmented.map(|(generation, _)| generation),
        body_bytes: segmented.and_then(|(_, bytes)| bytes),
        trust_tier: (tier != crate::trust::TrustTier::Unknown).then(|| tier.as_str().to_owned()),
        write_origin,
        change_reason: None,
        successor_pruned: false,
    };
    put_json(tx, &keys::version(page.id, id), &row)?;
    Ok(row)
}

// ---------------------------------------------------------------------------------------------
// Search timeline: the timeline text of the page keyword vector.
//
// PGLite's page `search_vector` is the title (weight A) plus
// `left(sanitizeRemoteBody(timeline), 65536)` (weight C), set when the page's chunks are sealed
// (`sealPageTextProjection`). The sanitizer is TypeScript only, so `sealChunks` sends its output
// with the seal (`UpsertChunksOptions::search_timeline`) and the store keeps it here, under
// `M page_search_timeline/<page id>`, with the `knowledge_revision` it was sealed at.
//
// - `search_timeline` reads it. The text describes the page's current text when its `revision`
//   equals the page's `text_projection_revision` (the seal that wrote it is the current seal).
// - A seal without the text (the store's own `putPage` index path) writes nothing.
// - Every write that sets the title or timeline deletes it (`forget_search_timeline`), as PGLite's
//   `trg_pages_search_vector` (BEFORE INSERT OR UPDATE OF title, timeline) puts the trigger form
//   back: `put_page_in` on every call, `write_page` when either value changed, and a family
//   whose PGLite SQL sets either column with an unchanged value calls it itself. Only a later
//   seal with the text writes the record again.
// - A hard page delete removes it (`remove_page`).

const SEARCH_TIMELINE: &str = "page_search_timeline";

/// Characters of the sanitized timeline the page keyword vector reads (`PAGE_TIMELINE_FTS_MAX_CHARS`).
pub(crate) const SEARCH_TIMELINE_MAX_CHARS: usize = 65_536;

/// The timeline text of a page's keyword vector, as the last seal that sent it left it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SearchTimeline {
    /// The page's `knowledge_revision` at that seal.
    pub revision: String,
    /// `sanitizeRemoteBody(timeline)`, NUL removed, cut to `SEARCH_TIMELINE_MAX_CHARS` characters.
    pub timeline: String,
}

fn search_timeline_key(page_id: u64) -> Vec<u8> {
    keys::meta(&format!("{SEARCH_TIMELINE}/{page_id}"))
}

/// The search timeline of page `page_id`, or `None` when no seal sent one.
// The keyword family (`searchTitles`) is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn search_timeline(read: &dyn KvRead, page_id: u64) -> Result<Option<SearchTimeline>> {
    get_json(read, &search_timeline_key(page_id))
}

/// Records `timeline` (already sanitized by TypeScript) as the search timeline of page `page_id`
/// at `revision`, for a page titled `title`; refuses a vector past the tsvector size cap. Removes NUL (Postgres text holds none) and keeps the first
/// `SEARCH_TIMELINE_MAX_CHARS` characters, as `left(…, 65536)` does.
pub(crate) fn record_search_timeline(
    tx: &mut dyn KvWrite,
    page_id: u64,
    revision: &str,
    title: &str,
    timeline: &str,
) -> Result<()> {
    let timeline: String = timeline
        .chars()
        .filter(|c| *c != '\0')
        .take(SEARCH_TIMELINE_MAX_CHARS)
        .collect();
    // `pageSearchVectorSql` builds the vector in the seal's statement, and its error aborts the seal.
    crate::keyword::check_sealed_page_vector(title, &timeline)?;
    let record = SearchTimeline {
        revision: revision.to_owned(),
        timeline,
    };
    put_json(tx, &search_timeline_key(page_id), &record)
}

/// Deletes the search timeline of page `page_id`: the write sets the title or timeline, so PGLite's
/// search vector trigger replaces the sealed vector until the next seal.
pub(crate) fn forget_search_timeline(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    tx.delete(&search_timeline_key(page_id))
}

/// Deletes a page and everything that hangs off it.
pub(crate) fn remove_page(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    // Before its links go: the marks are what keeps a concept derived from an owner-only page owner-only (v322).
    crate::owner_only_marks::mark_before_delete(tx, page)?;
    let mut doomed = Vec::new();
    scan_prefix(&*tx, &keys::version_prefix(page.id), false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    for key in doomed {
        tx.delete(&key)?;
    }
    clear_chunks(tx, page.id)?;
    forget_search_timeline(tx, page.id)?;
    crate::links::remove_page_links(tx, page.id)?;
    crate::timeline::remove_page_timeline(tx, page.id)?;
    crate::timeline_queries::remove_event_projections(tx, page.id)?;
    crate::cascade::remove_page_rows(tx, page)?;
    let stored = read_page_by_id(&*tx, page.id)?;
    let stored = stored.as_ref().unwrap_or(page);
    index_origin(tx, Some(stored), None)?;
    crate::page_index::reindex_page(tx, Some(stored), None)?;
    crate::page_projection::queue_page_projection(tx, Some(stored), None)?;
    tx.delete(&keys::page(&page.source_id, &page.slug))?;
    tx.delete(&keys::page_id(page.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(store: &Store, slug: &str) -> PageRecord {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        read_page(&*store.read().unwrap(), DEFAULT_SOURCE, slug)
            .unwrap()
            .unwrap()
    }

    /// Turns a stored page into a segmented shell the way PGLite's `createSegmentedPageShell` leaves it: NULL body
    /// columns and no content hash. The page_body family writes these; the test writes the record directly.
    fn make_shell(store: &Store, slug: &str) -> PageRecord {
        store
            .write(|tx| {
                let mut page = read_page(&*tx, DEFAULT_SOURCE, slug)?.unwrap();
                page.compiled_truth = PageText::null();
                page.timeline = PageText::null();
                page.content_hash = None;
                page.chunker_version = Some(0);
                write_page(tx, &page)?;
                Ok(page)
            })
            .unwrap()
    }

    #[test]
    fn a_page_record_written_before_nullable_fields_reads_and_writes_back_unchanged() {
        let legacy = json!({
            "id": 7, "source_id": "default", "slug": "a", "type": "note", "page_kind": "markdown", "title": "A",
            "compiled_truth": "body", "timeline": "", "frontmatter": {}, "content_hash": "abc",
            "source_path": null, "knowledge_revision": "r1", "text_projection_revision": null,
            "created_at_us": 1, "updated_at_us": 2, "deleted_at_us": null, "effective_date_us": null,
            "effective_date_source": null, "import_filename": null, "source_kind": null, "source_uri": null,
            "ingested_via": null, "ingested_at_us": null, "tags": []
        });
        let page: PageRecord = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(page.compiled_truth, "body");
        assert_eq!(page.timeline, "");
        assert!(!page.timeline.is_null());
        assert_eq!(page.content_hash.as_deref(), Some("abc"));
        assert_eq!(page.chunker_version, None);
        assert_eq!(serde_json::to_value(&page).unwrap(), legacy);
        let shown = page.to_page();
        assert_eq!(shown["compiled_truth"], "body");
        assert_eq!(shown["content_hash"], "abc");
        assert!(shown.get("chunker_version").is_none());

        let legacy_version = json!({
            "id": 1, "page_id": 7, "compiled_truth": "body", "timeline": "", "title": "A", "type": "note",
            "tags": [], "frontmatter": {}, "source_path": null, "content_hash": "abc",
            "knowledge_revision": "r1", "is_deleted": false, "snapshot_at_us": 3
        });
        let version: VersionRecord = serde_json::from_value(legacy_version.clone()).unwrap();
        assert_eq!(version.compiled_truth, "body");
        assert_eq!(serde_json::to_value(&version).unwrap(), legacy_version);
    }

    #[test]
    fn page_text_reads_null_as_empty_text_but_never_equals_it() {
        let null = PageText::null();
        assert!(null.is_null());
        assert_eq!(null.as_deref(), None);
        assert_eq!(&*null, "");
        assert_ne!(null, *"");
        assert_ne!(null, PageText::from(String::new()));
        assert_eq!(serde_json::to_value(&null).unwrap(), Value::Null);
        let text = PageText::from("x");
        assert_eq!(text, "x");
        assert_eq!(text, String::from("x"));
        assert_eq!(
            serde_json::from_value::<PageText>(Value::Null).unwrap(),
            null
        );
        assert!(crate::chunks::auto_chunks(&PageRecord {
            compiled_truth: null.clone(),
            timeline: null,
            ..serde_json::from_value(json!({
                "id": 1, "source_id": "default", "slug": "s", "type": "note", "page_kind": "markdown", "title": "S",
                "compiled_truth": null, "timeline": null, "frontmatter": {}, "knowledge_revision": "r",
                "created_at_us": 0, "updated_at_us": 0
            }))
            .unwrap()
        })
        .is_empty());
    }

    #[test]
    fn update_slug_refuses_a_segmented_page_and_moves_nothing() {
        let store = crate::test_support::store();
        put(&store, "big");
        make_shell(&store, "big");
        let err = store.update_slug("big", "big-2", None).unwrap_err();
        assert_eq!(err.code, crate::error::INVALID_STATE);
        assert_eq!(
            err.message,
            "updateSlug refuses segmented page big (source=default)"
        );
        let scope = ReadScope::default();
        assert!(store.read_page_snapshot("big", &scope).unwrap().is_some());
        assert!(store.read_page_snapshot("big-2", &scope).unwrap().is_none());
        assert!(
            store
                .get_versions("big", &VersionsOptions::default())
                .unwrap()
                .is_empty()
        );
        // An inline page still renames.
        put(&store, "small");
        assert_eq!(store.update_slug("small", "small-2", None).unwrap(), 1);
    }

    #[test]
    fn create_version_refuses_a_segmented_page_and_writes_no_version() {
        let store = crate::test_support::store();
        put(&store, "big");
        make_shell(&store, "big");
        let err = store.create_version("big", None).unwrap_err();
        assert_eq!(err.code, crate::error::INVALID_STATE);
        assert_eq!(
            err.message,
            "createVersion refuses segmented page big (source=default)"
        );
        assert!(
            store
                .get_versions("big", &VersionsOptions::default())
                .unwrap()
                .is_empty()
        );
        // An inline page still versions.
        put(&store, "small");
        assert_eq!(
            store.create_version("small", None).unwrap()["title"],
            "small"
        );
    }

    #[test]
    fn an_impossible_effective_date_is_refused_and_writes_nothing() {
        let store = crate::test_support::store();
        for bad in ["2026-02-30", "2026-02-30T00:00:00Z", "2026-13-01"] {
            let input = PageInput {
                page_type: "note".into(),
                title: "dated".into(),
                compiled_truth: "body".into(),
                effective_date: Some(bad.into()),
                ..PageInput::default()
            };
            let err = store
                .put_page("dated", &input, &PutPageOptions::default())
                .unwrap_err();
            assert_eq!(err.code, crate::error::INVALID_ARGUMENT, "{bad}");
            assert!(
                read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "dated")
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn a_segmented_shell_page_reads_back_with_null_body_and_content_hash() {
        let store = crate::test_support::store();
        put(&store, "big");
        let shell = make_shell(&store, "big");
        let read = store.read().unwrap();
        let stored = read_page(&*read, DEFAULT_SOURCE, "big").unwrap().unwrap();
        assert!(stored.compiled_truth.is_null() && stored.timeline.is_null());
        assert_eq!(stored.content_hash, None);
        assert_eq!(stored.chunker_version, Some(0));
        assert_eq!(stored.knowledge_revision, shell.knowledge_revision);
        drop(read);
        let snapshot = store
            .read_page_snapshot("big", &ReadScope::default())
            .unwrap()
            .unwrap();
        let page = &snapshot["page"];
        assert_eq!(page["content_hash"], Value::Null);
        assert_eq!(page["compiled_truth"], Value::Null);
        assert_eq!(page["timeline"], Value::Null);
        assert!(page.get("chunker_version").is_none());
        let listed = store.list_pages(&PageFilters::default()).unwrap();
        assert_eq!(listed[0]["content_hash"], Value::Null);
        assert_eq!(listed[0]["compiled_truth"], Value::Null);
    }

    #[test]
    fn put_page_keeps_the_stored_chunker_version_and_a_shell_is_not_versioned() {
        let store = crate::test_support::store();
        put(&store, "inline");
        store
            .write(|tx| {
                let mut page = read_page(&*tx, DEFAULT_SOURCE, "inline")?.unwrap();
                page.chunker_version = Some(3);
                write_page(tx, &page)
            })
            .unwrap();
        let again = put(&store, "inline");
        assert_eq!(
            again.chunker_version,
            Some(3),
            "put_page keeps the stored chunker_version"
        );
        // A segmented shell is not versioned: a NULL-body snapshot would keep no body at all
        // (create_version_refuses_a_segmented_page_and_writes_no_version pins the refusal).
        put(&store, "big");
        make_shell(&store, "big");
        assert_eq!(
            store.create_version("big", None).unwrap_err().code,
            INVALID_STATE
        );
    }

    #[test]
    fn an_empty_write_over_a_shell_is_refused() {
        let store = crate::test_support::store();
        put(&store, "big");
        make_shell(&store, "big");
        let empty = PageInput {
            page_type: "note".into(),
            title: "big".into(),
            ..PageInput::default()
        };
        let refused = store
            .put_page("big", &empty, &PutPageOptions::default())
            .unwrap_err();
        assert_eq!(refused.code, EMPTY_OVERWRITE);
        assert!(refused.message.contains("(segmented)"));
        let allowed = PutPageOptions {
            allow_empty_overwrite: true,
            ..PutPageOptions::default()
        };
        // Allowed, the write reaches PGLite's body CHECK, which refuses it too (item 11).
        let checked = store.put_page("big", &empty, &allowed).unwrap_err();
        assert_eq!(checked.code, CONSTRAINT_VIOLATION);
        assert_eq!(checked.message, BODY_STORAGE_CHECK);
        let page = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "big")
            .unwrap()
            .unwrap();
        assert!(page.compiled_truth.is_null());
    }

    #[test]
    fn a_body_write_over_a_shell_is_refused_by_the_body_check_and_stores_nothing() {
        let store = crate::test_support::store();
        put(&store, "seg");
        let shell = make_shell(&store, "seg");
        let body = PageInput {
            page_type: "note".into(),
            title: "seg".into(),
            compiled_truth: "a whole body".into(),
            ..PageInput::default()
        };
        let live = store
            .put_page("seg", &body, &PutPageOptions::default())
            .unwrap_err();
        assert_eq!(live.code, CONSTRAINT_VIOLATION);
        assert_eq!(live.message, BODY_STORAGE_CHECK);
        let after = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "seg")
            .unwrap()
            .unwrap();
        assert_eq!(after.knowledge_revision, shell.knowledge_revision);
        assert!(after.compiled_truth.is_null() && after.timeline.is_null());
        assert_eq!(after.content_hash, None);
        // A soft-deleted shell refuses too: PGLite's update revives the row and hits the same CHECK.
        store.soft_delete_page("seg", None).unwrap();
        let deleted = store
            .put_page("seg", &body, &PutPageOptions::default())
            .unwrap_err();
        assert_eq!(deleted.code, CONSTRAINT_VIOLATION);
        let still = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "seg")
            .unwrap()
            .unwrap();
        assert!(still.deleted_at_us.is_some() && still.compiled_truth.is_null());
        // An inline page is unaffected.
        put(&store, "plain");
        store
            .put_page("plain", &body, &PutPageOptions::default())
            .unwrap();
    }

    #[test]
    fn rename_page_moves_the_page_and_keeps_its_id() {
        let store = crate::test_support::store();
        put(&store, "old");
        store.add_tag("old", "t", None).unwrap();
        let before = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "old")
            .unwrap()
            .unwrap();
        let moved = store
            .write(|tx| rename_page(tx, &*store.env, &before, "New/Place"))
            .unwrap();
        assert_eq!(moved.slug, "new/place");
        assert_eq!(moved.id, before.id);
        assert_ne!(moved.knowledge_revision, before.knowledge_revision);
        assert_eq!(moved.text_projection_revision, None);
        assert!(moved.updated_at_us >= before.updated_at_us);
        let read = store.read().unwrap();
        assert!(read_page(&*read, DEFAULT_SOURCE, "old").unwrap().is_none());
        let stored = read_page_by_id(&*read, before.id).unwrap().unwrap();
        assert_eq!(stored.slug, "new/place");
        assert_eq!(stored.tags, vec!["t".to_string()]);
        assert_eq!(
            store.get_tags("new/place", &ReadScope::default()).unwrap(),
            vec!["t".to_string()]
        );
    }

    #[test]
    fn rename_page_to_the_same_slug_keeps_the_revision() {
        let store = crate::test_support::store();
        let before = put(&store, "same");
        let moved = store
            .write(|tx| rename_page(tx, &*store.env, &before, "same"))
            .unwrap();
        assert_eq!(moved.knowledge_revision, before.knowledge_revision);
        assert_eq!(
            moved.text_projection_revision,
            before.text_projection_revision
        );
        assert!(
            read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "same")
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn rename_page_refuses_a_taken_or_bad_slug_and_keeps_nothing() {
        let store = crate::test_support::store();
        let a = put(&store, "a");
        put(&store, "b");
        let taken = store
            .write(|tx| rename_page(tx, &*store.env, &a, "b"))
            .unwrap_err();
        assert_eq!(taken.code, CONSTRAINT_VIOLATION);
        let bad = store
            .write(|tx| rename_page(tx, &*store.env, &a, ""))
            .unwrap_err();
        assert_eq!(bad.code, INVALID_SLUG);
        let read = store.read().unwrap();
        let stored = read_page(&*read, DEFAULT_SOURCE, "a").unwrap().unwrap();
        assert_eq!(stored.knowledge_revision, a.knowledge_revision);
        assert_eq!(
            read_page(&*read, DEFAULT_SOURCE, "b")
                .unwrap()
                .unwrap()
                .title,
            "b"
        );
    }

    fn put_at(store: &Store, slug: &str, path: Option<&str>, source: Option<&str>) -> Result<()> {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            source_path: path.map(String::from),
            ..PageInput::default()
        };
        let options = PutPageOptions {
            source_id: source.map(String::from),
            ..PutPageOptions::default()
        };
        store.put_page(slug, &input, &options).map(|_| ())
    }

    fn origin_keys(store: &Store) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        scan_prefix(
            &*store.read().unwrap(),
            &[keys::PAGE_ORIGIN],
            false,
            &mut |k, _| {
                out.push(k.to_vec());
                true
            },
        )
        .unwrap();
        out
    }

    fn holders(error: &StoreError) -> Value {
        assert_eq!(error.code, ORIGIN_CLAIMED);
        serde_json::from_str(&error.message).unwrap()
    }

    #[test]
    fn a_second_live_page_cannot_record_a_page_origin() {
        let store = crate::test_support::store();
        put_at(&store, "a", Some("notes/a.md"), None).unwrap();
        let refused = put_at(&store, "b", Some("notes/a.md"), None).unwrap_err();
        assert_eq!(
            holders(&refused),
            json!({"source_id": "default", "source_path": "notes/a.md", "holders": ["a"], "slug": "b"})
        );
        // A refused write stores nothing.
        assert!(
            read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "b")
                .unwrap()
                .is_none()
        );
        // Writing the holder again without a path keeps its path; writing it with its own path
        // is not a second claim.
        put_at(&store, "a", None, None).unwrap();
        put_at(&store, "a", Some("notes/a.md"), None).unwrap();
        let a = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "a")
            .unwrap()
            .unwrap();
        assert_eq!(a.source_path.as_deref(), Some("notes/a.md"));
        // An empty path is never a claim.
        put_at(&store, "c", Some(""), None).unwrap();
        put_at(&store, "d", Some(""), None).unwrap();
        // Another source may record the same path.
        store
            .upsert_source(&crate::sources::SourceInput {
                id: "other".into(),
                ..Default::default()
            })
            .unwrap();
        put_at(&store, "b", Some("notes/a.md"), Some("other")).unwrap();
        assert_eq!(origin_keys(&store).len(), 2);
    }

    #[test]
    fn a_soft_deleted_page_frees_its_origin_and_cannot_take_it_back() {
        let store = crate::test_support::store();
        put_at(&store, "a", Some("notes/a.md"), None).unwrap();
        store.soft_delete_page("a", None).unwrap();
        assert!(origin_keys(&store).is_empty());
        put_at(&store, "b", Some("notes/a.md"), None).unwrap();
        // Reviving the tombstone, by restore or by a write, would make a second live claimant.
        let restore = store.restore_page("a", None).unwrap_err();
        assert_eq!(holders(&restore)["holders"], json!(["b"]));
        assert_eq!(holders(&restore)["slug"], json!("a"));
        let revive = put_at(&store, "a", None, None).unwrap_err();
        assert_eq!(holders(&revive)["source_path"], json!("notes/a.md"));
        let a = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "a")
            .unwrap()
            .unwrap();
        assert!(a.deleted_at_us.is_some());
        // Once the claimant is gone for good, the tombstone comes back with its origin.
        store.delete_page("b", None).unwrap();
        assert!(origin_keys(&store).is_empty());
        assert!(store.restore_page("a", None).unwrap());
        assert_eq!(origin_keys(&store).len(), 1);
    }

    #[test]
    fn a_renamed_page_keeps_one_origin_key() {
        let store = crate::test_support::store();
        put_at(&store, "a", Some("notes/a.md"), None).unwrap();
        let before = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "a")
            .unwrap()
            .unwrap();
        store
            .write(|tx| rename_page(tx, &*store.env, &before, "z"))
            .unwrap();
        assert_eq!(origin_keys(&store).len(), 1);
        let refused = put_at(&store, "b", Some("notes/a.md"), None).unwrap_err();
        assert_eq!(holders(&refused)["holders"], json!(["z"]));
    }

    fn seal(store: &Store, slug: &str, search_timeline: Option<&str>) {
        let options = crate::chunks::UpsertChunksOptions {
            seal: true,
            search_timeline: search_timeline.map(str::to_owned),
            ..crate::chunks::UpsertChunksOptions::default()
        };
        store.upsert_chunks(slug, &[], &options).unwrap();
    }

    fn stored_timeline(store: &Store, page_id: u64) -> Option<SearchTimeline> {
        search_timeline(&*store.read().unwrap(), page_id).unwrap()
    }

    #[test]
    fn a_seal_keeps_the_search_timeline_and_a_title_or_timeline_write_forgets_it() {
        let store = crate::test_support::store();
        let page = put(&store, "a");
        assert_eq!(stored_timeline(&store, page.id), None);

        // NUL goes; the cut counts characters, not bytes.
        let long = format!("é\0{}", "x".repeat(SEARCH_TIMELINE_MAX_CHARS));
        seal(&store, "a", Some(&long));
        let sealed = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "a")
            .unwrap()
            .unwrap();
        let kept = stored_timeline(&store, page.id).unwrap();
        assert_eq!(kept.revision, page.knowledge_revision);
        assert_eq!(
            sealed.text_projection_revision.as_deref(),
            Some(kept.revision.as_str())
        );
        assert_eq!(kept.timeline.chars().count(), SEARCH_TIMELINE_MAX_CHARS);
        assert!(kept.timeline.starts_with("éx"));

        // A write that does not seal, or a seal that sends no text, keeps the record.
        let unsealed = crate::chunks::UpsertChunksOptions {
            search_timeline: Some("ignored".into()),
            ..crate::chunks::UpsertChunksOptions::default()
        };
        store.upsert_chunks("a", &[], &unsealed).unwrap();
        seal(&store, "a", None);
        assert_eq!(stored_timeline(&store, page.id), Some(kept.clone()));

        // A putPage sets the title and timeline, so the record goes, also when nothing changed.
        let same = PageInput {
            page_type: "note".into(),
            title: "a".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page("a", &same, &PutPageOptions::default())
            .unwrap();
        let unchanged = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "a")
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.knowledge_revision, kept.revision);
        assert_eq!(stored_timeline(&store, page.id), None);
        seal(&store, "a", Some(&long));
        assert_eq!(stored_timeline(&store, page.id), Some(kept.clone()));

        // A new revision: the record goes, and the store's own seal does not write it again.
        let input = PageInput {
            page_type: "note".into(),
            title: "a".into(),
            compiled_truth: "new body".into(),
            ..PageInput::default()
        };
        store
            .put_page("a", &input, &PutPageOptions::default())
            .unwrap();
        let moved = read_page(&*store.read().unwrap(), DEFAULT_SOURCE, "a")
            .unwrap()
            .unwrap();
        assert_ne!(moved.knowledge_revision, kept.revision);
        assert_eq!(
            moved.text_projection_revision.as_deref(),
            Some(moved.knowledge_revision.as_str())
        );
        assert_eq!(stored_timeline(&store, page.id), None);

        seal(&store, "a", Some("2026-01-01 event"));
        let resealed = stored_timeline(&store, page.id).unwrap();
        assert_eq!(resealed.revision, moved.knowledge_revision);
        assert_eq!(resealed.timeline, "2026-01-01 event");

        // A write through `write_page` that changes the title forgets it; one that keeps both
        // values (a tag change, a soft delete) keeps it.
        store
            .write(|tx| {
                let mut page = read_page(&*tx, DEFAULT_SOURCE, "a")?.unwrap();
                page.updated_at_us += 1;
                write_page(tx, &page)
            })
            .unwrap();
        assert_eq!(stored_timeline(&store, page.id), Some(resealed));
        store
            .write(|tx| {
                let mut page = read_page(&*tx, DEFAULT_SOURCE, "a")?.unwrap();
                page.title = "renamed title".into();
                write_page(tx, &page)
            })
            .unwrap();
        assert_eq!(stored_timeline(&store, page.id), None);
        seal(&store, "a", Some("2026-01-01 event"));

        store.delete_page("a", None).unwrap();
        assert_eq!(stored_timeline(&store, page.id), None);
    }
}
