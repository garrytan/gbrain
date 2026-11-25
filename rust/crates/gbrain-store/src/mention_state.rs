//! The mention pass's state: the `mention_index_status`, `page_mention_state` and
//! `mention_gazetteer_entries` tables of the SQL engines (migration v206), and the statements the
//! pass runs on them, on `links` and on `page_aliases` (`src/core/engine-sql/mention-pass.ts`,
//! `rust/docs/store/mention-state.md`).
//!
//! Keys (family `META`, names `mention_status`, `mention_page`, `mention_entry`; text parts joined
//! with `0x00`):
//! - `M mention_status \0 source` holds a [`StatusRecord`]: one status row per source.
//! - `M mention_page \0 <page id, 20 digits>` holds a [`PageState`]: one `page_mention_state` row.
//! - `M mention_entry \0 source \0 name_norm \0 target_slug \0 0|1` is empty: one saved entry.
//!
//! The pass's advisory locks (`lockMentionSources`, `lockMentionEntries`) have nothing to take: a
//! store write transaction holds the store's one writer, so no other write runs between them.
//! `FOR SHARE` reads are plain reads for the same reason.
//!
//! A hard page delete removes the page's state row (`ON DELETE CASCADE` of `page_id`), and a source
//! delete removes the source's status row, entries and state rows (`ON DELETE CASCADE` of
//! `source_id`), through `cascade.rs`.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::{LinkRecord, delete_link};
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::sources::{all_sources, read_source};
use crate::{Store, get_json, keys, put_json};

const STATUS: &str = "mention_status";
const PAGE: &str = "mention_page";
const ENTRY: &str = "mention_entry";
/// The states `mention_index_status_state_check` admits.
const STATES: [&str; 4] = ["complete", "pending", "disabled", "failed"];

fn status_key(source: &str) -> Vec<u8> {
    keys::text(keys::META, &[STATUS, source])
}

fn page_key(page_id: u64) -> Vec<u8> {
    keys::text(keys::META, &[PAGE, &format!("{page_id:020}")])
}

fn entry_key(source: &str, name: &str, target: &str, case_sensitive: bool) -> Vec<u8> {
    keys::text(
        keys::META,
        &[
            ENTRY,
            source,
            name,
            target,
            if case_sensitive { "1" } else { "0" },
        ],
    )
}

fn prefix(parts: &[&str]) -> Vec<u8> {
    let mut key = keys::text(keys::META, parts);
    key.push(0);
    key
}

fn refuse_nul(member: &str, parts: &[&str]) -> Result<()> {
    if parts.iter().any(|p| p.contains('\0')) {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{member}: invalid byte sequence for encoding \"UTF8\": 0x00"),
        ));
    }
    Ok(())
}

fn fk_violation(table: &str, constraint: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!(
            "insert or update on table \"{table}\" violates foreign key constraint \"{constraint}\""
        ),
    )
}

/// One `mention_index_status` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct StatusRecord {
    pub generation: i64,
    pub state: String,
    pub pending: i64,
    #[serde(default)]
    pub counted_at_us: Option<i64>,
    #[serde(default)]
    pub last_pass_at_us: Option<i64>,
    #[serde(default)]
    pub policy_fingerprint: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub updated_at_us: i64,
}

/// One `page_mention_state` row.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct PageState {
    pub source_id: String,
    #[serde(default)]
    pub mention_revision: Option<String>,
    #[serde(default)]
    pub mention_version: Option<i64>,
    #[serde(default)]
    pub mention_generation: Option<i64>,
    #[serde(default)]
    pub mentions_scanned_at_us: Option<i64>,
    #[serde(default)]
    pub alias_revision: Option<String>,
    #[serde(default)]
    pub alias_version: Option<i64>,
    #[serde(default)]
    pub aliases_refreshed_at_us: Option<i64>,
}

pub(crate) fn read_status(read: &dyn KvRead, source: &str) -> Result<Option<StatusRecord>> {
    if source.contains('\0') {
        return Ok(None);
    }
    get_json(read, &status_key(source))
}

/// Saves one source's status row (the recount's compare-and-set write, `cli_reads/entities.rs`).
pub(crate) fn put_status(tx: &mut dyn KvWrite, source: &str, record: &StatusRecord) -> Result<()> {
    put_json(tx, &status_key(source), record)
}

/// Every status row, by source in byte order.
pub(crate) fn all_statuses(read: &dyn KvRead) -> Result<Vec<(String, StatusRecord)>> {
    let p = prefix(&[STATUS]);
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(read, &p, false, &mut |k, v| {
        match serde_json::from_slice::<StatusRecord>(v) {
            Ok(r) => out.push((String::from_utf8_lossy(&k[p.len()..]).into_owned(), r)),
            Err(e) => bad = Some(e),
        }
        bad.is_none()
    })?;
    if let Some(e) = bad {
        return Err(e.into());
    }
    Ok(out)
}

pub(crate) fn read_page_state(read: &dyn KvRead, page_id: u64) -> Result<Option<PageState>> {
    get_json(read, &page_key(page_id))
}

/// Every state row with its page id.
pub(crate) fn all_page_states(read: &dyn KvRead) -> Result<Vec<(u64, PageState)>> {
    let p = prefix(&[PAGE]);
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(read, &p, false, &mut |k, v| {
        let id = std::str::from_utf8(&k[p.len()..])
            .ok()
            .and_then(|t| t.parse::<u64>().ok());
        match (id, serde_json::from_slice::<PageState>(v)) {
            (Some(id), Ok(s)) => out.push((id, s)),
            (_, Err(e)) => bad = Some(e),
            (None, Ok(_)) => {}
        }
        bad.is_none()
    })?;
    if let Some(e) = bad {
        return Err(e.into());
    }
    Ok(out)
}

/// The pass's due test (`DUE_PREDICATE`): no state, or state behind the page's content or `version`.
pub(crate) fn mention_due(state: Option<&PageState>, page: &PageRecord, version: i64) -> bool {
    match state {
        None => true,
        Some(s) => {
            s.mention_revision.as_deref() != Some(page.knowledge_revision.as_str())
                || s.mention_version != Some(version)
        }
    }
}

/// The alias due test: state behind the page's content or `version` (a page with no state is due).
pub(crate) fn alias_due(state: Option<&PageState>, page: &PageRecord, version: i64) -> bool {
    match state {
        None => true,
        Some(s) => {
            s.alias_revision.as_deref() != Some(page.knowledge_revision.as_str())
                || s.alias_version != Some(version)
        }
    }
}

/// The saved entries of `source`, as `(name_norm, target_slug, case_sensitive)`, in key order.
fn source_entries(read: &dyn KvRead, source: &str) -> Result<Vec<(String, String, bool)>> {
    let p = prefix(&[ENTRY, source]);
    let mut out = Vec::new();
    scan_prefix(read, &p, false, &mut |k, _| {
        let parts: Vec<String> = k[p.len()..]
            .split(|b| *b == 0)
            .map(|x| String::from_utf8_lossy(x).into_owned())
            .collect();
        if let [name, target, cs] = parts.as_slice() {
            out.push((name.clone(), target.clone(), cs == "1"));
        }
        true
    })?;
    Ok(out)
}

/// The gazetteer entries of `source` whose target is `slug`, every name and case flag (a page purge receipt's
/// `slug_key` probe, `SELECT 1 FROM mention_gazetteer_entries WHERE source_id = $1 AND target_slug = $2`).
pub(crate) fn count_for_target(read: &dyn KvRead, source: &str, slug: &str) -> Result<usize> {
    if source.contains('\0') {
        return Ok(0);
    }
    Ok(source_entries(read, source)?
        .iter()
        .filter(|(_, target, _)| target == slug)
        .count())
}

/// `scrubPurgedNameStores` on `mention_gazetteer_entries` (src/core/persistence/purge-name-stores.ts): deletes the
/// entries of `source` whose target is one of the purged `slugs`, every name and case flag, and returns how many went
/// (`DELETE .. WHERE source_id = $1 AND target_slug = ANY($2) RETURNING 1`). Entries have no foreign key to pages, so a
/// hard page delete calls this; a soft delete keeps them, because restore_page can bring the page back.
pub(crate) fn scrub_purged_entries(
    tx: &mut dyn KvWrite,
    source: &str,
    slugs: &[String],
) -> Result<u64> {
    if source.contains('\0') || slugs.is_empty() {
        return Ok(0);
    }
    let mut removed = 0;
    for (name, target, cs) in source_entries(&*tx, source)? {
        if slugs.contains(&target) {
            tx.delete(&entry_key(source, &name, &target, cs))?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// The `mention_gazetteer_entries` rows a purge verification probes (facts/purge_probe.rs `table_rows`): every saved
/// entry of every source, with its `source_id`, `name_norm` and `target_slug` as text.
pub(crate) fn purge_probe_rows(
    read: &dyn KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow};
    let mut sources = BTreeSet::new();
    let p = prefix(&[ENTRY]);
    scan_prefix(read, &p, false, &mut |k, _| {
        if let Some(source) = k[p.len()..].split(|b| *b == 0).next() {
            sources.insert(String::from_utf8_lossy(source).into_owned());
        }
        true
    })?;
    let mut out = Vec::new();
    for source in sources {
        for (name, target, _) in source_entries(read, &source)? {
            out.push(ProbeRow {
                cells: vec![
                    ("source_id", ProbeCell::text(&source)),
                    ("name_norm", ProbeCell::text(&name)),
                    ("target_slug", ProbeCell::text(&target)),
                ],
                source_id: Some(source.clone()),
            });
        }
    }
    Ok(out)
}

/// The page's `page_mention_state` row, for a hard page delete.
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    tx.delete(&page_key(page.id))
}

/// Every mention record of a deleted source.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    if source_id.contains('\0') {
        return Ok(());
    }
    tx.delete(&status_key(source_id))?;
    for (name, target, cs) in source_entries(&*tx, source_id)? {
        tx.delete(&entry_key(source_id, &name, &target, cs))?;
    }
    for (id, state) in all_page_states(&*tx)? {
        if state.source_id == source_id {
            tx.delete(&page_key(id))?;
        }
    }
    Ok(())
}

fn require_source(read: &dyn KvRead, source: &str, table: &str, constraint: &str) -> Result<()> {
    if read_source(read, source)?.is_none() {
        return Err(fk_violation(table, constraint));
    }
    Ok(())
}

/// The plain-mention test of the pass: `link_source = 'mentions'` and no kind or `plain`.
fn plain_mention(link: &LinkRecord) -> bool {
    link.link_source.as_deref() == Some("mentions")
        && link.link_kind.as_deref().is_none_or(|k| k == "plain")
}

/// Every link record leaving `page_id`.
fn out_links(read: &dyn KvRead, page_id: u64) -> Result<Vec<LinkRecord>> {
    crate::links::out_links(read, page_id)
}

/// `writeMentionIndexStatus(sourceId, patch)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionStatusPatch {
    pub state: String,
    #[serde(default)]
    pub pending: Option<i64>,
    #[serde(default)]
    pub last_pass_at: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub bump_generation: bool,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub set_fingerprint: bool,
}

/// A page and the revision the caller read it at.
#[derive(Debug, Clone, Deserialize)]
pub struct PageRevisionInput {
    pub id: i64,
    pub revision: String,
}

/// One derived alias row to insert.
#[derive(Debug, Clone, Deserialize)]
pub struct DerivedAliasInput {
    pub slug: String,
    pub alias_norm: String,
    pub origin: String,
    pub case_sensitive: bool,
    #[serde(default)]
    pub alias_text: Option<String>,
}

/// One saved gazetteer entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntryKeyRow {
    pub source_id: String,
    pub name_norm: String,
    pub target_slug: String,
    pub case_sensitive: bool,
}

/// A page the alias refresh or the reconcile reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DuePageRow {
    pub id: u64,
    pub slug: String,
    pub source_id: String,
    pub revision: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub compiled_truth: Option<String>,
    pub timeline: Option<String>,
    pub mention_ignore: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frontmatter: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_storage: Option<String>,
}

/// A candidate page of the added-name prefilter.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CandidatePageRow {
    pub id: u64,
    pub slug: String,
    pub source_id: String,
    pub body_storage: String,
    /// Null when `patterns` were given and the page is neither segmented nor matches one (the batch still counts it).
    pub body: Option<String>,
    pub mention_ignore: Value,
}

/// An outbound link of a reconciled page.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OutLinkRow {
    pub id: u64,
    pub from_page_id: u64,
    pub to_slug: String,
    pub to_source_id: String,
    pub plain: bool,
}

/// A derived alias row of a page.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DerivedAliasRowOut {
    pub slug: String,
    pub alias_norm: String,
    pub origin: String,
    pub case_sensitive: bool,
    pub alias_text: Option<String>,
}

/// `pages.body_storage` of a page: `segmented` or `inline`.
pub(crate) fn body_storage(read: &dyn KvRead, page: &PageRecord) -> Result<&'static str> {
    Ok(
        if crate::page_body::purge_scan::page_is_segmented(read, page.id)? {
            "segmented"
        } else {
            "inline"
        },
    )
}

/// `frontmatter->'mention_ignore'`: the value, or JSON null when the key is absent.
fn mention_ignore(page: &PageRecord) -> Value {
    crate::cli_reads::pg_text::fm_value(&page.frontmatter, "mention_ignore")
}

fn due_row(read: &dyn KvRead, page: &PageRecord, with_frontmatter: bool) -> Result<DuePageRow> {
    Ok(DuePageRow {
        id: page.id,
        slug: page.slug.clone(),
        source_id: page.source_id.clone(),
        revision: page.knowledge_revision.clone(),
        title: page.title.clone(),
        page_type: page.page_type.clone(),
        compiled_truth: page.compiled_truth.as_deref().map(str::to_owned),
        timeline: page.timeline.as_deref().map(str::to_owned),
        mention_ignore: if with_frontmatter {
            Value::Null
        } else {
            mention_ignore(page)
        },
        frontmatter: with_frontmatter.then(|| Value::Object(page.frontmatter.clone())),
        body_storage: if with_frontmatter {
            None
        } else {
            Some(body_storage(read, page)?.to_owned())
        },
    })
}

fn ids_of(ids: &[i64]) -> HashSet<u64> {
    ids.iter().filter_map(|i| u64::try_from(*i).ok()).collect()
}

/// The `$n::text` of a bigint generation; refuses text Postgres's `::bigint` refuses.
fn parse_generation(text: &str) -> Result<i64> {
    text.trim().parse::<i64>().map_err(|_| {
        StoreError::new(
            INVALID_ARGUMENT,
            format!("invalid input syntax for type bigint: \"{text}\""),
        )
    })
}

impl Store {
    /// `listMentionSourceIds()`: every source id, in byte order.
    pub fn list_mention_source_ids(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut ids: Vec<String> = all_sources(&*read)?.into_iter().map(|s| s.id).collect();
        ids.sort();
        Ok(ids
            .into_iter()
            .map(|id| serde_json::json!({ "id": id }))
            .collect())
    }

    /// `writeMentionIndexStatus(sourceId, patch)`: insert or update the source's status row.
    pub fn write_mention_index_status(
        &self,
        source_id: &str,
        patch: &MentionStatusPatch,
    ) -> Result<()> {
        const MEMBER: &str = "writeMentionIndexStatus";
        refuse_nul(
            MEMBER,
            &[
                source_id,
                &patch.state,
                patch.fingerprint.as_deref().unwrap_or(""),
                patch.error.as_deref().unwrap_or(""),
            ],
        )?;
        if !STATES.contains(&patch.state.as_str()) {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                "new row for relation \"mention_index_status\" violates check constraint \"mention_index_status_state_check\"",
            ));
        }
        let last_pass = match patch.last_pass_at.as_deref() {
            None => None,
            Some(t) => Some(crate::env::parse_iso(t).ok_or_else(|| {
                StoreError::new(
                    INVALID_ARGUMENT,
                    format!("invalid input syntax for type timestamp with time zone: \"{t}\""),
                )
            })?),
        };
        let now = crate::env::transaction_clock::transaction_now()
            .unwrap_or_else(|| self.env.now_micros());
        self.write(|tx| {
            require_source(
                &*tx,
                source_id,
                "mention_index_status",
                "mention_index_status_source_id_fkey",
            )?;
            let bump = i64::from(patch.bump_generation);
            let record = match read_status(&*tx, source_id)? {
                None => StatusRecord {
                    generation: bump,
                    state: patch.state.clone(),
                    pending: patch.pending.unwrap_or(0),
                    counted_at_us: Some(now),
                    last_pass_at_us: last_pass,
                    policy_fingerprint: patch.fingerprint.clone(),
                    error: patch.error.clone(),
                    updated_at_us: now,
                },
                Some(old) => StatusRecord {
                    generation: old.generation + bump,
                    state: patch.state.clone(),
                    pending: patch.pending.unwrap_or(old.pending),
                    counted_at_us: if patch.pending.is_none() {
                        old.counted_at_us
                    } else {
                        Some(now)
                    },
                    last_pass_at_us: last_pass.or(old.last_pass_at_us),
                    policy_fingerprint: if patch.set_fingerprint {
                        patch.fingerprint.clone()
                    } else {
                        old.policy_fingerprint
                    },
                    error: patch.error.clone(),
                    updated_at_us: now,
                },
            };
            put_json(tx, &status_key(source_id), &record)
        })
    }

    /// `listMentionLinkOrigins(sourceId)`: the slugs of the source's pages holding a plain mention
    /// link, in byte order.
    pub fn list_mention_link_origins(&self, source_id: &str) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut slugs = BTreeSet::new();
        for page in all_pages(&*read)? {
            if page.source_id != source_id {
                continue;
            }
            if out_links(&*read, page.id)?.iter().any(plain_mention) {
                slugs.insert(page.slug.clone());
            }
        }
        Ok(slugs
            .into_iter()
            .map(|slug| serde_json::json!({ "slug": slug }))
            .collect())
    }

    /// `deleteSourceMentionLinks(sourceId, origins)`: delete the plain mention links leaving the
    /// source's pages (those in `origins` when given); the deleted ids, in id order.
    pub fn delete_source_mention_links(
        &self,
        source_id: &str,
        origins: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        self.write(|tx| {
            let mut deleted = Vec::new();
            for page in all_pages(&*tx)? {
                if page.source_id != source_id || origins.is_some_and(|o| !o.contains(&page.slug)) {
                    continue;
                }
                for link in out_links(&*tx, page.id)? {
                    if plain_mention(&link) {
                        delete_link(tx, &link)?;
                        deleted.push(link.id);
                    }
                }
            }
            deleted.sort_unstable();
            Ok(deleted
                .into_iter()
                .map(|id| serde_json::json!({ "id": id }))
                .collect())
        })
    }

    /// `clearMentionSourceIndex(sourceId)`: the source's derived aliases, entries and page state.
    pub fn clear_mention_source_index(&self, source_id: &str) -> Result<()> {
        self.write(|tx| {
            crate::aliases::delete_source_derived_aliases(tx, source_id)?;
            if source_id.contains('\0') {
                return Ok(());
            }
            for (name, target, cs) in source_entries(&*tx, source_id)? {
                tx.delete(&entry_key(source_id, &name, &target, cs))?;
            }
            for (id, state) in all_page_states(&*tx)? {
                if state.source_id == source_id {
                    tx.delete(&page_key(id))?;
                }
            }
            Ok(())
        })
    }

    /// `listStaleDerivedAliasSlugs(sourceId, types)`: slugs of the source's derived alias rows
    /// whose page is missing, deleted or not of `types`, in byte order.
    pub fn list_stale_derived_alias_slugs(
        &self,
        source_id: &str,
        types: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut slugs = BTreeSet::new();
        for (slug, _, _, _) in crate::aliases::source_derived_alias_rows(&*read, source_id)? {
            let stale = match read_page(&*read, source_id, &slug)? {
                None => true,
                Some(p) => p.deleted_at_us.is_some() || !types.contains(&p.page_type),
            };
            if stale {
                slugs.insert(slug);
            }
        }
        Ok(slugs
            .into_iter()
            .map(|slug| serde_json::json!({ "slug": slug }))
            .collect())
    }

    /// `deleteDerivedAliasesForSlugs(sourceId, slugs)`.
    pub fn delete_derived_aliases_for_slugs(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<()> {
        self.write(|tx| {
            for slug in slugs {
                crate::aliases::delete_page_derived_aliases(tx, source_id, slug)?;
            }
            Ok(())
        })
    }

    /// `listAliasDuePages(sourceId, types, after, version, limit)`: inline live pages of `types`
    /// after id `after` whose derived aliases are behind, by id.
    pub fn list_alias_due_pages(
        &self,
        source_id: &str,
        types: &[String],
        after: i64,
        version: i64,
        limit: i64,
    ) -> Result<Vec<DuePageRow>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.source_id == source_id
                    && p.deleted_at_us.is_none()
                    && types.contains(&p.page_type)
            })
            .filter(|p| i64::try_from(p.id).is_ok_and(|id| id > after))
            .collect();
        pages.sort_by_key(|p| p.id);
        let mut out = Vec::new();
        for p in pages {
            if out.len() as i64 >= limit.max(0) {
                break;
            }
            if body_storage(&*read, &p)? != "inline" {
                continue;
            }
            if alias_due(read_page_state(&*read, p.id)?.as_ref(), &p, version) {
                out.push(due_row(&*read, &p, true)?);
            }
        }
        Ok(out)
    }

    /// `listDerivedAliasRows(sourceId, slugs)`: the derived alias rows of `slugs`.
    pub fn list_derived_alias_rows(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<DerivedAliasRowOut>> {
        let read = self.read()?;
        let wanted: HashSet<&str> = slugs.iter().map(String::as_str).collect();
        Ok(
            crate::aliases::source_derived_alias_rows(&*read, source_id)?
                .into_iter()
                .filter(|(slug, _, _, _)| wanted.contains(slug.as_str()))
                .map(|(slug, alias_norm, origin, value)| DerivedAliasRowOut {
                    slug,
                    alias_norm,
                    origin,
                    case_sensitive: value.case_sensitive,
                    alias_text: value.alias_text,
                })
                .collect(),
        )
    }

    /// `readMentionPageRevisions(ids, opts)`: the revision of each live page in `ids`, by id.
    pub fn read_mention_page_revisions(&self, ids: &[i64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut wanted: Vec<u64> = ids_of(ids).into_iter().collect();
        wanted.sort_unstable();
        let mut out = Vec::new();
        for id in wanted {
            if let Some(p) = read_page_by_id(&*read, id)?
                && p.deleted_at_us.is_none()
            {
                out.push(serde_json::json!({ "id": p.id, "revision": p.knowledge_revision }));
            }
        }
        Ok(out)
    }

    /// `insertDerivedAliasRows(sourceId, rows)`: rows already present are kept.
    pub fn insert_derived_alias_rows(
        &self,
        source_id: &str,
        rows: &[DerivedAliasInput],
    ) -> Result<()> {
        self.write(|tx| {
            for r in rows {
                crate::aliases::insert_derived_alias_row(
                    tx,
                    source_id,
                    &r.slug,
                    &r.alias_norm,
                    &r.origin,
                    r.case_sensitive,
                    r.alias_text.as_deref(),
                )?;
            }
            Ok(())
        })
    }

    /// `upsertPageAliasState(sourceId, pages, version)`.
    pub fn upsert_page_alias_state(
        &self,
        source_id: &str,
        pages: &[PageRevisionInput],
        version: i64,
    ) -> Result<()> {
        let now = crate::env::transaction_clock::transaction_now()
            .unwrap_or_else(|| self.env.now_micros());
        self.upsert_page_states(source_id, pages, |s, revision| {
            s.alias_revision = Some(revision);
            s.alias_version = Some(version);
            s.aliases_refreshed_at_us = Some(now);
        })
    }

    /// `upsertPageMentionState(sourceId, pages, version, generation)`.
    pub fn upsert_page_mention_state(
        &self,
        source_id: &str,
        pages: &[PageRevisionInput],
        version: i64,
        generation: &str,
    ) -> Result<()> {
        let generation = parse_generation(generation)?;
        let now = crate::env::transaction_clock::transaction_now()
            .unwrap_or_else(|| self.env.now_micros());
        self.upsert_page_states(source_id, pages, |s, revision| {
            s.mention_revision = Some(revision);
            s.mention_version = Some(version);
            s.mention_generation = Some(generation);
            s.mentions_scanned_at_us = Some(now);
        })
    }

    fn upsert_page_states(
        &self,
        source_id: &str,
        pages: &[PageRevisionInput],
        set: impl Fn(&mut PageState, String),
    ) -> Result<()> {
        refuse_nul("upsertPageMentionState", &[source_id])?;
        for p in pages {
            if uuid_text(&p.revision).is_none() {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("invalid input syntax for type uuid: \"{}\"", p.revision),
                ));
            }
        }
        self.write(|tx| {
            for p in pages {
                let Ok(id) = u64::try_from(p.id) else {
                    return Err(fk_violation(
                        "page_mention_state",
                        "page_mention_state_page_id_fkey",
                    ));
                };
                let mut state = match read_page_state(&*tx, id)? {
                    Some(s) => s,
                    None => {
                        if read_page_by_id(&*tx, id)?.is_none() {
                            return Err(fk_violation(
                                "page_mention_state",
                                "page_mention_state_page_id_fkey",
                            ));
                        }
                        require_source(
                            &*tx,
                            source_id,
                            "page_mention_state",
                            "page_mention_state_source_id_fkey",
                        )?;
                        PageState {
                            source_id: source_id.to_owned(),
                            ..PageState::default()
                        }
                    }
                };
                set(&mut state, uuid_text(&p.revision).unwrap_or_default());
                put_json(tx, &page_key(id), &state)?;
            }
            Ok(())
        })
    }

    /// `listMentionCandidatePages(sourceIds, after, limit, patterns)`: the next `limit` live pages of `sourceIds`
    /// after id `after`, by id, whether they match or not (so one statement never reads a whole source looking
    /// for a rare name); with `patterns`, a page that is neither segmented nor has lowered text LIKE one of them
    /// comes back with a null body.
    pub fn list_mention_candidate_pages(
        &self,
        source_ids: &[String],
        after: i64,
        limit: i64,
        patterns: Option<&[String]>,
    ) -> Result<Vec<CandidatePageRow>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && source_ids.contains(&p.source_id))
            .filter(|p| i64::try_from(p.id).is_ok_and(|id| id > after))
            .collect();
        pages.sort_by_key(|p| p.id);
        pages.truncate(usize::try_from(limit.max(0)).unwrap_or(usize::MAX));
        let mut out = Vec::new();
        for p in pages {
            let storage = body_storage(&*read, &p)?;
            let mut shown = true;
            if let Some(patterns) = patterns
                && storage != "segmented"
            {
                let lowered = crate::cli_reads::pg_text::pg_lower(&format!(
                    "{} {} {}",
                    p.title, &*p.compiled_truth, &*p.timeline
                ));
                shown = false;
                for pattern in patterns {
                    if crate::facts::like(&lowered, pattern, false)? {
                        shown = true;
                        break;
                    }
                }
            }
            // `E'\\n\\n'` in the SQL: two newlines between the title, the body and the timeline.
            let body =
                shown.then(|| format!("{}\n\n{}\n\n{}", p.title, &*p.compiled_truth, &*p.timeline));
            out.push(CandidatePageRow {
                id: p.id,
                slug: p.slug.clone(),
                source_id: p.source_id.clone(),
                body_storage: storage.to_owned(),
                body,
                mention_ignore: mention_ignore(&p),
            });
        }
        Ok(out)
    }

    /// `listGazetteerEntryKeys(sourceId)`: the source's saved entries.
    pub fn list_gazetteer_entry_keys(&self, source_id: &str) -> Result<Vec<EntryKeyRow>> {
        if source_id.contains('\0') {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        Ok(source_entries(&*read, source_id)?
            .into_iter()
            .map(|(name_norm, target_slug, case_sensitive)| EntryKeyRow {
                source_id: source_id.to_owned(),
                name_norm,
                target_slug,
                case_sensitive,
            })
            .collect())
    }

    /// `listMentionLinkersOfTargets(sourceId, slugs)`: the pages with a mention link to one of
    /// `slugs` in the source, by id.
    pub fn list_mention_linkers_of_targets(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let targets: HashSet<u64> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && slugs.contains(&p.slug))
            .map(|p| p.id)
            .collect();
        let mut from = BTreeSet::new();
        for page in all_pages(&*read)? {
            for link in out_links(&*read, page.id)? {
                if link.link_source.as_deref() == Some("mentions")
                    && targets.contains(&link.to_page_id)
                {
                    from.insert(link.from_page_id);
                }
            }
        }
        Ok(from
            .into_iter()
            .map(|id| serde_json::json!({ "id": id }))
            .collect())
    }

    /// `applyGazetteerEntryChanges(sourceId, removed, added)`.
    pub fn apply_gazetteer_entry_changes(
        &self,
        source_id: &str,
        removed: &[EntryKeyRow],
        added: &[EntryKeyRow],
    ) -> Result<()> {
        const MEMBER: &str = "applyGazetteerEntryChanges";
        refuse_nul(MEMBER, &[source_id])?;
        for k in removed.iter().chain(added) {
            refuse_nul(MEMBER, &[&k.name_norm, &k.target_slug])?;
        }
        self.write(|tx| {
            for k in removed {
                tx.delete(&entry_key(
                    source_id,
                    &k.name_norm,
                    &k.target_slug,
                    k.case_sensitive,
                ))?;
            }
            if !added.is_empty() {
                require_source(
                    &*tx,
                    source_id,
                    "mention_gazetteer_entries",
                    "mention_gazetteer_entries_source_id_fkey",
                )?;
            }
            for k in added {
                tx.put(
                    &entry_key(source_id, &k.name_norm, &k.target_slug, k.case_sensitive),
                    &[],
                )?;
            }
            Ok(())
        })
    }

    /// `resetMentionRevisions(by)`: clear `mention_revision` of every state row of `source_ids`, or of
    /// the rows of `page_ids`. With `after_page_id` the source rows are only those after that page
    /// id (the tail a deadline-stopped scan did not read), plus the `page_ids` rows.
    pub fn reset_mention_revisions(
        &self,
        source_ids: Option<&[String]>,
        page_ids: Option<&[i64]>,
        after_page_id: Option<i64>,
    ) -> Result<()> {
        let ids = page_ids.map(ids_of);
        self.write(|tx| {
            for (id, mut state) in all_page_states(&*tx)? {
                let hit = source_ids.is_some_and(|s| {
                    s.contains(&state.source_id)
                        && after_page_id.is_none_or(|after| after < 0 || id > after as u64)
                }) || ids.as_ref().is_some_and(|i| i.contains(&id));
                if hit {
                    state.mention_revision = None;
                    put_json(tx, &page_key(id), &state)?;
                }
            }
            Ok(())
        })
    }

    /// `resetSourceMentionIndexRevisions(sourceId)`: clear both revisions of the source's state rows.
    pub fn reset_source_mention_index_revisions(&self, source_id: &str) -> Result<()> {
        self.write(|tx| {
            for (id, mut state) in all_page_states(&*tx)? {
                if state.source_id == source_id {
                    state.mention_revision = None;
                    state.alias_revision = None;
                    put_json(tx, &page_key(id), &state)?;
                }
            }
            Ok(())
        })
    }

    /// `readMentionGenerations(sourceIds, lock)`: each source's generation as text.
    pub fn read_mention_generations(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(all_statuses(&*read)?
            .into_iter()
            .filter(|(s, _)| source_ids.contains(s))
            .map(|(s, r)| serde_json::json!({ "source_id": s, "generation": r.generation.to_string() }))
            .collect())
    }

    /// `readMentionStatusStates(sourceIds)`.
    pub fn read_mention_status_states(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(all_statuses(&*read)?
            .into_iter()
            .filter(|(s, _)| source_ids.contains(s))
            .map(|(s, r)| serde_json::json!({ "source_id": s, "state": r.state }))
            .collect())
    }

    /// `readMentionPolicyFingerprints(sourceIds)`.
    pub fn read_mention_policy_fingerprints(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(all_statuses(&*read)?
            .into_iter()
            .filter(|(s, _)| source_ids.contains(s))
            .map(|(s, r)| serde_json::json!({ "source_id": s, "policy_fingerprint": r.policy_fingerprint }))
            .collect())
    }

    /// `listMentionDuePages(sourceId, version, after, limit)`: live pages due for the pass, by id.
    pub fn list_mention_due_pages(
        &self,
        source_id: &str,
        version: i64,
        after: i64,
        limit: i64,
    ) -> Result<Vec<DuePageRow>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.deleted_at_us.is_none())
            .filter(|p| i64::try_from(p.id).is_ok_and(|id| id > after))
            .collect();
        pages.sort_by_key(|p| p.id);
        let mut out = Vec::new();
        for p in pages {
            if out.len() as i64 >= limit.max(0) {
                break;
            }
            if mention_due(read_page_state(&*read, p.id)?.as_ref(), &p, version) {
                out.push(due_row(&*read, &p, false)?);
            }
        }
        Ok(out)
    }

    /// `listPageOutLinks(ids)`: every link leaving the pages in `ids`, with its target.
    pub fn list_page_out_links(&self, ids: &[i64]) -> Result<Vec<OutLinkRow>> {
        let read = self.read()?;
        let mut wanted: Vec<u64> = ids_of(ids).into_iter().collect();
        wanted.sort_unstable();
        let mut out = Vec::new();
        let mut targets: BTreeMap<u64, Option<PageRecord>> = BTreeMap::new();
        for id in wanted {
            for link in out_links(&*read, id)? {
                if let std::collections::btree_map::Entry::Vacant(slot) =
                    targets.entry(link.to_page_id)
                {
                    slot.insert(read_page_by_id(&*read, link.to_page_id)?);
                }
                if let Some(Some(t)) = targets.get(&link.to_page_id) {
                    out.push(OutLinkRow {
                        id: link.id,
                        from_page_id: link.from_page_id,
                        to_slug: t.slug.clone(),
                        to_source_id: t.source_id.clone(),
                        plain: plain_mention(&link),
                    });
                }
            }
        }
        Ok(out)
    }

    /// `deleteLinksById(ids)`.
    pub fn delete_links_by_id(&self, ids: &[i64]) -> Result<()> {
        let wanted = ids_of(ids);
        if wanted.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            for page in all_pages(&*tx)? {
                for link in out_links(&*tx, page.id)? {
                    if wanted.contains(&link.id) {
                        delete_link(tx, &link)?;
                    }
                }
            }
            Ok(())
        })
    }
}

/// The canonical text of a UUID (`rev::uuid` then `::text`): lowercase, hyphenated; `None` when the
/// text is not a UUID Postgres accepts in its common forms.
fn uuid_text(text: &str) -> Option<String> {
    let hex: String = text
        .trim()
        .trim_start_matches('{')
        .trim_end_matches('}')
        .chars()
        .filter(|c| *c != '-')
        .collect();
    if hex.len() != 32 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let h = hex.to_ascii_lowercase();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}
