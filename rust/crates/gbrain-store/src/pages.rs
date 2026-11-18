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
    EMPTY_OVERWRITE, INVALID_SLUG, PAGE_NOT_FOUND, REVISION_CONFLICT, REVISION_REQUIRED, Result,
    StoreError,
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

/// What is stored for a page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PageRecord {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub page_kind: String,
    pub title: String,
    pub compiled_truth: String,
    pub timeline: String,
    pub frontmatter: Map<String, Value>,
    pub content_hash: String,
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

/// A page snapshot version, as stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct VersionRecord {
    pub id: u64,
    pub page_id: u64,
    pub compiled_truth: String,
    pub timeline: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub tags: Vec<String>,
    pub frontmatter: Map<String, Value>,
    pub source_path: Option<String>,
    pub content_hash: String,
    pub knowledge_revision: String,
    pub is_deleted: bool,
    pub snapshot_at_us: i64,
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
            v["compiled_truth"] = Value::String(self.compiled_truth.clone());
            v["timeline"] = Value::String(self.timeline.clone());
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

pub(crate) fn write_page(tx: &mut dyn KvWrite, record: &PageRecord) -> Result<()> {
    let key = page_key(&record.source_id, &record.slug);
    put_json(tx, &key, record)?;
    tx.put(&keys::page_id(record.id), &key)
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
    if blank(&input.compiled_truth)
        && !options.allow_empty_overwrite
        && let Some(prior) = existing.as_ref().filter(|p| p.deleted_at_us.is_none())
        && !blank(&prior.compiled_truth)
    {
        return Err(StoreError::new(
            EMPTY_OVERWRITE,
            format!(
                "putPage: refusing to overwrite non-empty page '{slug}' ({} chars) with an empty body - likely a read-modify-write that read empty. Pass {{ allowEmptyOverwrite: true }} to force, or deletePage to remove it.",
                prior.compiled_truth.chars().count()
            ),
        ));
    }
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
            compiled_truth,
            timeline,
            frontmatter,
            content_hash: hash,
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
                compiled_truth,
                timeline,
                frontmatter,
                content_hash: hash,
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
    write_page(tx, &record)?;
    let mut record = record;
    if options.index == Some(false) {
        return Ok(record);
    }
    match &options.chunks {
        Some(chunks) => replace_chunks(tx, &mut record, chunks, true, false)?,
        None if record.text_projection_revision.as_deref()
            != Some(record.knowledge_revision.as_str()) =>
        {
            let chunks = auto_chunks(&record);
            replace_chunks(tx, &mut record, &chunks, true, false)?
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
            "page": page.to_page(),
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
        let mut pages: Vec<PageRecord> = all_pages(&*self.read()?)?
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
        Ok(pages
            .iter()
            .skip(offset)
            .take(limit)
            .map(PageRecord::to_page)
            .collect())
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
            let mut restored = false;
            for id in sources {
                if let Some(mut page) = read_page(&*tx, &id, slug)?
                    && page.deleted_at_us.is_some()
                {
                    page.deleted_at_us = None;
                    page.updated_at_us = now;
                    tag_change(tx, &*self.env, &mut page)?;
                    restored = true;
                }
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

    /// `createVersion(slug, {sourceId})`: snapshots the page as it is.
    pub fn create_version(&self, slug: &str, source_id: Option<&str>) -> Result<Value> {
        self.write(|tx| {
            let source = source_id.unwrap_or(DEFAULT_SOURCE);
            let Some(page) = read_page(&*tx, source, &slug.to_lowercase())? else {
                return Err(StoreError::new(
                    PAGE_NOT_FOUND,
                    format!("createVersion failed: page \"{slug}\" (source={source}) not found"),
                ));
            };
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
    };
    put_json(tx, &keys::version(page.id, id), &row)?;
    Ok(row)
}

/// Deletes a page and everything that hangs off it.
pub(crate) fn remove_page(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    let mut doomed = Vec::new();
    scan_prefix(&*tx, &keys::version_prefix(page.id), false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    for key in doomed {
        tx.delete(&key)?;
    }
    clear_chunks(tx, page.id)?;
    crate::links::remove_page_links(tx, page.id)?;
    crate::timeline::remove_page_timeline(tx, page.id)?;
    crate::cascade::remove_page_rows(tx, page)?;
    tx.delete(&keys::page(&page.source_id, &page.slug))?;
    tx.delete(&keys::page_id(page.id))
}
