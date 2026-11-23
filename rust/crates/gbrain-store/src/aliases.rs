//! Slug renames, slug aliases, page aliases and the contextual retrieval state of pages: the
//! PGLite `slug_aliases`, `slug_rename_history` and `page_aliases` tables and the
//! `pages.contextual_retrieval_mode` / `pages.corpus_generation` columns.
//!
//! Members: updateSlug, resolveSlugWithAlias, resolveSlugWithAliasDetailed, resolveAliases,
//! setPageAliases, replaceDerivedAliases, updatePageContextualRetrievalState, aliasCanonicalRefs.
//!
//! Keys (every record starts with `keys::ALIAS`, `k`; text parts are joined with `0x00`):
//!
//! - `k 0x01 source \0 alias_slug` holds a [`SlugAliasRecord`]: one `slug_aliases` row, unique on
//!   `(source_id, alias_slug)` as in PGLite.
//! - `k 0x05 source \0 canonical_slug \0 alias_slug` is empty: the index a rename reads to repoint
//!   every alias of the old slug at the new one.
//! - `k 0x02 source \0 alias_norm \0 slug \0 origin` is empty: one `page_aliases` row, unique on
//!   `(source_id, alias_norm, slug, origin)` as in PGLite.
//! - `k 0x03 source \0 slug \0 alias_norm \0 origin` is the same row seen from its page, for
//!   `setPageAliases`, `replaceDerivedAliases` and the rename move. A derived row holds its
//!   [`DerivedAliasValue`] (`case_sensitive`, `alias_text`); a frontmatter row is empty, the
//!   column defaults (`false`, NULL). The rename move keeps the value.
//! - `k 0x04 page_id` (8 big-endian bytes) holds the page's [`CrState`].
//! - `k 0x06 source \0 old_slug \0 new_slug` is empty: one `slug_rename_history` row, unique on
//!   `(source_id, old_slug, new_slug)` as in PGLite (migration v285). `created_at` is not kept;
//!   nothing reads it. A lookup by `new_slug` scans the source's rows.
//!
//! Text that holds a NUL byte cannot be part of a key: a write refuses it with
//! `invalid_argument` (Postgres refuses NUL in `text` too) and a read finds nothing.
//!
//! The alias rows hang off `(source, slug)`, not the page id: neither PGLite table has a foreign
//! key to `pages`, so its rows outlive a hard delete of the page and answer again for a page
//! created later at the same slug. [`remove_page_rows`] therefore removes only the contextual
//! retrieval state, which is a column of the page row. `slug_rename_history` has no foreign key to
//! `pages` either, and PGLite's single `deletePage` keeps its rows. The batch purges
//! (`deletePages`, `purgeDeletedPages`) run `scrubPurgedSlugStores`, which drops the page aliases
//! of a purged slug, the slug aliases that resolve to it and the rename rows that end at it;
//! [`scrub_purged_slug_stores`] does that for them here, and [`scrub_purged_rename_history`] is its
//! last step.
//! All three tables cascade from `sources`: [`remove_source_rows`] removes every row of a deleted
//! source.
//!
//! `setPageAliases` writes the `frontmatter` rows and `replaceDerivedAliases` the `declared` and
//! `subject` rows of the mention pass. `resolveAliases` applies PGLite's precedence (frontmatter,
//! then declared, then subject, and a derived alias yields to another page's exact title). Only
//! `updateSlug` writes slug aliases and rename history. The private-provenance policy
//! (`facts/privacy.rs`) reads both through [`read_slug_alias`] and [`renamed_to`].

use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, INVALID_STATE, Result, StoreError};
use crate::facts::{OwnerOnlyCache, PrivacyPolicy};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::page_columns::PageColumns;
use crate::pages::{
    PageRecord, all_pages, read_page, read_page_by_id, rename_page, scope_sources, snapshot_in,
    validate_slug, write_page,
};
use crate::sources::{read_source, require_source};
use crate::trust::{TrustPolicy, TrustTable, TrustTier};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

const SLUG_ALIAS: u8 = 0x01;
const PAGE_ALIAS: u8 = 0x02;
const PAGE_ALIAS_BY_SLUG: u8 = 0x03;
const CR_STATE: u8 = 0x04;
const SLUG_ALIAS_BY_CANONICAL: u8 = 0x05;
const RENAME_HISTORY: u8 = 0x06;

/// The origin `setPageAliases` writes and replaces (the column default).
const FRONTMATTER: &str = "frontmatter";
/// The frontmatter key that hides a page (`QUARANTINE_KEY`).
const QUARANTINE_KEY: &str = "quarantine";
const DEFAULT_SOURCE: &str = "default";

/// One `slug_aliases` row: `alias_slug` (the key) resolves to `canonical_slug`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct SlugAliasRecord {
    pub canonical_slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// A page's contextual retrieval state. No record is both columns NULL.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct CrState {
    pub mode: String,
    /// Written as PGLite writes it; `readPageIndexingState` reads it back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corpus_generation: Option<String>,
}

/// `PageWriteOptions.contextualRetrieval`: the stamp `putPage` writes with the page.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextualRetrievalStamp {
    pub mode: String,
    #[serde(default)]
    pub corpus_generation: Option<String>,
}

/// One row of `replaceDerivedAliases` (`DerivedAliasRow` of `engine-sql/pages.ts`).
#[derive(Debug, Clone, Deserialize)]
pub struct DerivedAliasRow {
    pub alias_norm: String,
    pub origin: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub alias_text: Option<String>,
}

/// The columns of a derived `page_aliases` row the key does not hold, stored on its `0x03` key.
/// The typed reads readPageAliasRows and resolveCaseSensitiveAliases return them (alias_fanout_reads.rs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct DerivedAliasValue {
    #[serde(rename = "c")]
    pub case_sensitive: bool,
    #[serde(rename = "t", default, skip_serializing_if = "Option::is_none")]
    pub alias_text: Option<String>,
}

/// The frontmatter key that marks a page whose chunks get no vectors.
const EMBED_SKIP_KEY: &str = "embed_skip";

/// The origins `page_aliases_origin_check` admits.
const ORIGINS: [&str; 3] = [FRONTMATTER, "declared", "subject"];
/// The origins `replaceDerivedAliases` replaces.
const DERIVED: [&str; 2] = ["declared", "subject"];

/// The scope of `resolveAliases` (`PageReadScope`): a non-empty `sourceIds` wins, then a
/// non-empty `sourceId`, else every source. `exclude_private` is the page policy of
/// `excludePrivate` (`facts/privacy.rs` `page_hidden`), and `min_trust` and `suppress_flagged`
/// are `pageEligibleSql`'s trust floor and flagged-page filter (`trust::TrustPolicy`). As in
/// `readAliases`, they apply both to the page an alias row names and to the page whose title
/// shadows a derived alias.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AliasScope {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub exclude_private: Option<PrivacyPolicy>,
    pub min_trust: Option<String>,
    pub suppress_flagged: bool,
}

/// One page an alias resolves to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AliasRef {
    pub slug: String,
    pub source_id: String,
}

/// The answer of `resolveSlugWithAliasDetailed`, plus how many sources held the alias: the
/// TypeScript member warns once per process when more than one did, as PGLite does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SlugAliasMatch {
    pub canonical_slug: String,
    pub source_id: String,
    pub matches: usize,
}

/// `aliasCanonicalRefs(refs, policy)`. The TypeScript member reads the policy as
/// `pageReadFilter('p', policy, !!policy)` does: `source_ids` is its source clause (a non-empty
/// `sourceIds`, else a non-empty `sourceId`, else none), `live` is `!!policy`, and
/// `exclude_private` is the page policy of `excludePrivate` (`facts/privacy.rs` `page_hidden`), and
/// `min_trust` and `suppress_flagged` are `pageEligibleSql`'s trust floor and flagged-page filter
/// over the page's stored tier and write-gate receipts (`trust::TrustPolicy`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AliasCanonicalQuery {
    pub refs: Vec<AliasRef>,
    pub source_ids: Option<Vec<String>>,
    pub live: bool,
    pub exclude_private: Option<PrivacyPolicy>,
    pub min_trust: Option<String>,
    pub suppress_flagged: bool,
}

fn key(sub: u8, parts: &[&str]) -> Vec<u8> {
    let mut key = vec![keys::ALIAS, sub];
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            key.push(0);
        }
        key.extend_from_slice(part.as_bytes());
    }
    key
}

/// `key(sub, parts)` followed by the separator, so a scan does not match a longer last part.
fn prefix(sub: u8, parts: &[&str]) -> Vec<u8> {
    let mut key = key(sub, parts);
    key.push(0);
    key
}

fn cr_key(page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::ALIAS, CR_STATE];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn has_nul(parts: &[&str]) -> bool {
    parts.iter().any(|p| p.contains('\0'))
}

/// Refuses text a key cannot hold, before anything is written.
fn refuse_nul(member: &str, parts: &[&str]) -> Result<()> {
    if has_nul(parts) {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("{member}: invalid byte sequence for encoding \"UTF8\": 0x00"),
        ));
    }
    Ok(())
}

/// The text parts after `prefix` in `key`, split on the separator.
fn tail(key: &[u8], prefix_len: usize) -> Vec<String> {
    key[prefix_len..]
        .split(|b| *b == 0)
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .collect()
}

/// Every key under `prefix`, with the text parts after it.
fn scan_tails(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<(Vec<u8>, Vec<String>)>> {
    let mut out = Vec::new();
    scan_prefix(read, prefix, false, &mut |k, _| {
        out.push((k.to_vec(), tail(k, prefix.len())));
        true
    })?;
    Ok(out)
}

/// The `(alias_norm, origin)` rows of the page at `(source, slug)`.
fn page_alias_rows(read: &dyn KvRead, source: &str, slug: &str) -> Result<Vec<(String, String)>> {
    Ok(
        scan_tails(read, &prefix(PAGE_ALIAS_BY_SLUG, &[source, slug]))?
            .into_iter()
            .filter_map(|(_, parts)| match parts.as_slice() {
                [alias, origin] => Some((alias.clone(), origin.clone())),
                _ => None,
            })
            .collect(),
    )
}

/// The slugs of every `page_aliases` row of `alias` in `source`, any origin, in byte order. The
/// rows outlive their page, so a caller that wants pages joins each slug to the page there.
pub(crate) fn alias_row_slugs(
    read: &dyn KvRead,
    source: &str,
    alias: &str,
) -> Result<BTreeSet<String>> {
    if has_nul(&[source, alias]) {
        return Ok(BTreeSet::new());
    }
    Ok(scan_tails(read, &prefix(PAGE_ALIAS, &[source, alias]))?
        .into_iter()
        .filter_map(|(_, parts)| match parts.as_slice() {
            [slug, _origin] => Some(slug.clone()),
            _ => None,
        })
        .collect())
}

fn put_page_alias(
    tx: &mut dyn KvWrite,
    source: &str,
    alias: &str,
    slug: &str,
    origin: &str,
) -> Result<()> {
    tx.put(&key(PAGE_ALIAS, &[source, alias, slug, origin]), &[])?;
    tx.put(
        &key(PAGE_ALIAS_BY_SLUG, &[source, slug, alias, origin]),
        &[],
    )
}

fn delete_page_alias(
    tx: &mut dyn KvWrite,
    source: &str,
    alias: &str,
    slug: &str,
    origin: &str,
) -> Result<()> {
    tx.delete(&key(PAGE_ALIAS, &[source, alias, slug, origin]))?;
    tx.delete(&key(PAGE_ALIAS_BY_SLUG, &[source, slug, alias, origin]))
}

/// The shadow follow (`seed/follow.rs`): removes the `slug_aliases` row of `alias` in `source`.
/// `false` when there is none.
pub(crate) fn remove_slug_alias(tx: &mut dyn KvWrite, source: &str, alias: &str) -> Result<bool> {
    if read_slug_alias(&*tx, source, alias)?.is_none() {
        return Ok(false);
    }
    delete_slug_alias(tx, source, alias)?;
    Ok(true)
}

/// The shadow follow: removes the `page_aliases` row `(source, alias, slug, origin)`. `false` when
/// there is none.
pub(crate) fn remove_page_alias(
    tx: &mut dyn KvWrite,
    source: &str,
    alias: &str,
    slug: &str,
    origin: &str,
) -> Result<bool> {
    if has_nul(&[source, alias, slug, origin])
        || tx
            .get(&key(PAGE_ALIAS, &[source, alias, slug, origin]))?
            .is_none()
    {
        return Ok(false);
    }
    delete_page_alias(tx, source, alias, slug, origin)?;
    Ok(true)
}

/// The shadow follow: removes the `slug_rename_history` row `(source, old, new)`. `false` when
/// there is none.
pub(crate) fn remove_rename(
    tx: &mut dyn KvWrite,
    source: &str,
    old: &str,
    new: &str,
) -> Result<bool> {
    if has_nul(&[source, old, new]) || tx.get(&rename_key(source, old, new))?.is_none() {
        return Ok(false);
    }
    tx.delete(&rename_key(source, old, new))?;
    Ok(true)
}

/// The shadow seed (`seed.rs`): stores a `slug_aliases` row copied from another engine. `false` when
/// `(source, alias)` already holds one.
pub(crate) fn seed_slug_alias(
    tx: &mut dyn KvWrite,
    source: &str,
    alias: &str,
    record: &SlugAliasRecord,
) -> Result<bool> {
    refuse_nul(
        "seed slug_aliases",
        &[source, alias, &record.canonical_slug],
    )?;
    if read_slug_alias(&*tx, source, alias)?.is_some() {
        return Ok(false);
    }
    put_slug_alias(tx, source, alias, record)?;
    Ok(true)
}

/// The shadow seed (`seed.rs`): stores a `page_aliases` row copied from another engine. `false` when
/// the row is already stored.
pub(crate) fn seed_page_alias(
    tx: &mut dyn KvWrite,
    source: &str,
    alias: &str,
    slug: &str,
    origin: &str,
    value: &DerivedAliasValue,
) -> Result<bool> {
    refuse_nul(
        "seed page_aliases",
        &[
            source,
            alias,
            slug,
            origin,
            value.alias_text.as_deref().unwrap_or(""),
        ],
    )?;
    if tx
        .get(&key(PAGE_ALIAS, &[source, alias, slug, origin]))?
        .is_some()
    {
        return Ok(false);
    }
    put_page_alias(tx, source, alias, slug, origin)?;
    if origin != FRONTMATTER {
        put_json(
            tx,
            &key(PAGE_ALIAS_BY_SLUG, &[source, slug, alias, origin]),
            value,
        )?;
    }
    Ok(true)
}

/// The shadow seed (`seed.rs`): stores a `slug_rename_history` row copied from another engine, the one key
/// `recordRenameAlias` writes for it and nothing else (the alias rows are their own relation). `false` when the row is
/// already stored.
pub(crate) fn seed_rename(
    tx: &mut dyn KvWrite,
    source: &str,
    old: &str,
    new: &str,
) -> Result<bool> {
    refuse_nul("seed slug_rename_history", &[source, old, new])?;
    let key = rename_key(source, old, new);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    tx.put(&key, &[])?;
    Ok(true)
}

/// The shadow seed (`seed.rs`): stores a page's `contextual_retrieval_mode` and `corpus_generation`
/// as another engine holds them.
pub(crate) fn seed_cr_state(
    tx: &mut dyn KvWrite,
    page_id: u64,
    mode: String,
    corpus_generation: Option<String>,
) -> Result<()> {
    let state = CrState {
        mode,
        corpus_generation,
    };
    put_json(tx, &cr_key(page_id), &state)
}

/// The `slug_aliases` row of `alias` in `source`, if any.
pub(crate) fn read_slug_alias(
    read: &dyn KvRead,
    source: &str,
    alias: &str,
) -> Result<Option<SlugAliasRecord>> {
    if has_nul(&[source, alias]) {
        return Ok(None);
    }
    get_json(read, &key(SLUG_ALIAS, &[source, alias]))
}

fn put_slug_alias(
    tx: &mut dyn KvWrite,
    source: &str,
    alias: &str,
    record: &SlugAliasRecord,
) -> Result<()> {
    if let Some(old) = read_slug_alias(&*tx, source, alias)? {
        tx.delete(&key(
            SLUG_ALIAS_BY_CANONICAL,
            &[source, &old.canonical_slug, alias],
        ))?;
    }
    put_json(tx, &key(SLUG_ALIAS, &[source, alias]), record)?;
    tx.put(
        &key(
            SLUG_ALIAS_BY_CANONICAL,
            &[source, &record.canonical_slug, alias],
        ),
        &[],
    )
}

fn delete_slug_alias(tx: &mut dyn KvWrite, source: &str, alias: &str) -> Result<()> {
    if let Some(old) = read_slug_alias(&*tx, source, alias)? {
        tx.delete(&key(
            SLUG_ALIAS_BY_CANONICAL,
            &[source, &old.canonical_slug, alias],
        ))?;
        tx.delete(&key(SLUG_ALIAS, &[source, alias]))?;
    }
    Ok(())
}

/// Every `new_slug` of the `slug_rename_history` rows of `old` in `source`, in key order.
pub(crate) fn renamed_to(read: &dyn KvRead, source: &str, old: &str) -> Result<Vec<String>> {
    if has_nul(&[source, old]) {
        return Ok(Vec::new());
    }
    Ok(scan_tails(read, &prefix(RENAME_HISTORY, &[source, old]))?
        .into_iter()
        .filter_map(|(_, parts)| match parts.as_slice() {
            [new] => Some(new.clone()),
            _ => None,
        })
        .collect())
}

/// Every `(old_slug, new_slug)` row of `source`, in key order.
fn rename_rows(read: &dyn KvRead, source: &str) -> Result<Vec<(String, String)>> {
    Ok(scan_tails(read, &prefix(RENAME_HISTORY, &[source]))?
        .into_iter()
        .filter_map(|(_, parts)| match parts.as_slice() {
            [old, new] => Some((old.clone(), new.clone())),
            _ => None,
        })
        .collect())
}

fn rename_key(source: &str, old: &str, new: &str) -> Vec<u8> {
    key(RENAME_HISTORY, &[source, old, new])
}

/// The `slug_rename_history` half of `recordRenameAlias(source, old, new)`
/// (src/core/page-state/rename-alias.ts), its four statements in order, before the alias half:
/// 1. `INSERT ... SELECT source_id, alias_slug, canonical_slug FROM slug_aliases WHERE alias_slug
///    = new ON CONFLICT DO NOTHING`: keeps the alias the rename is about to drop.
/// 2. `DELETE ... h WHERE h.new_slug = old AND EXISTS (o WHERE o.old_slug = h.old_slug AND
///    o.new_slug = new)`: a row that would repeat an existing one after the move goes.
/// 3. `UPDATE ... SET new_slug = new WHERE new_slug = old`: rows that ended at the old slug follow
///    the page.
/// 4. `INSERT (source, old, new) ON CONFLICT DO NOTHING`.
fn record_rename_history(tx: &mut dyn KvWrite, source: &str, old: &str, new: &str) -> Result<()> {
    if let Some(dropped) = read_slug_alias(&*tx, source, new)? {
        tx.put(&rename_key(source, new, &dropped.canonical_slug), &[])?;
    }
    let rows = rename_rows(&*tx, source)?;
    let taken: BTreeSet<&str> = rows
        .iter()
        .filter(|(_, n)| n == new)
        .map(|(o, _)| o.as_str())
        .collect();
    for (o, _) in rows.iter().filter(|(_, n)| n == old) {
        if taken.contains(o.as_str()) {
            tx.delete(&rename_key(source, o, old))?;
        }
    }
    for (o, _) in rename_rows(&*tx, source)?.iter().filter(|(_, n)| n == old) {
        tx.delete(&rename_key(source, o, old))?;
        tx.put(&rename_key(source, o, new), &[])?;
    }
    tx.put(&rename_key(source, old, new), &[])
}

/// The three stores of `scrubPurgedSlugStores` this family keeps, in the order of its
/// `SLUG_STORES` list (src/core/persistence/purge-slug-stores.ts:6): `page_aliases` by `slug`,
/// `slug_aliases` by `canonical_slug` (an alias spelled like a purged slug that names another page
/// stays), then `slug_rename_history` by `new_slug`. `deletePages` and `purgeDeletedPages`
/// (`page_ops::scrub_purged_slugs`) call it in the purge's transaction, after the pages are gone,
/// as src/core/engine-sql/pages.ts:237 and :397 do. A single `deletePage` and a soft delete keep
/// every row.
pub(crate) fn scrub_purged_slug_stores(
    tx: &mut dyn KvWrite,
    source: &str,
    slugs: &[String],
) -> Result<()> {
    if has_nul(&[source]) {
        return Ok(());
    }
    for slug in slugs.iter().filter(|s| !has_nul(&[s.as_str()])) {
        for (alias, origin) in page_alias_rows(&*tx, source, slug)? {
            delete_page_alias(tx, source, &alias, slug, &origin)?;
        }
    }
    for slug in slugs.iter().filter(|s| !has_nul(&[s.as_str()])) {
        for (_, parts) in scan_tails(&*tx, &prefix(SLUG_ALIAS_BY_CANONICAL, &[source, slug]))? {
            if let [alias] = parts.as_slice() {
                delete_slug_alias(tx, source, alias)?;
            }
        }
    }
    scrub_purged_rename_history(tx, source, slugs)?;
    Ok(())
}

/// `scrubPurgedSlugStores` on `slug_rename_history`: drops the rows of `source` that end at a
/// purged slug (a row from a purged slug to another page stays).
pub(crate) fn scrub_purged_rename_history(
    tx: &mut dyn KvWrite,
    source: &str,
    slugs: &[String],
) -> Result<u64> {
    if has_nul(&[source]) {
        return Ok(0);
    }
    let mut removed = 0;
    for (old, new) in rename_rows(&*tx, source)? {
        if slugs.contains(&new) {
            tx.delete(&rename_key(source, &old, &new))?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// `recordRenameAlias(source, old, new)`: the rename history first ([`record_rename_history`]),
/// then on `slug_aliases`: drops the alias spelled like the new
/// slug (a page owns that slug now), repoints every alias of the old slug at the new one, then
/// upserts `old -> new` with notes `rename` (an existing row keeps its notes, as `ON CONFLICT DO
/// UPDATE SET canonical_slug` does).
fn record_rename_alias(tx: &mut dyn KvWrite, source: &str, old: &str, new: &str) -> Result<()> {
    if old == new {
        return Ok(());
    }
    record_rename_history(tx, source, old, new)?;
    delete_slug_alias(tx, source, new)?;
    for (_, parts) in scan_tails(&*tx, &prefix(SLUG_ALIAS_BY_CANONICAL, &[source, old]))? {
        let [alias] = parts.as_slice() else {
            continue;
        };
        if let Some(mut record) = read_slug_alias(&*tx, source, alias)? {
            record.canonical_slug = new.to_string();
            put_slug_alias(tx, source, alias, &record)?;
        }
    }
    let record = match read_slug_alias(&*tx, source, old)? {
        Some(existing) => SlugAliasRecord {
            canonical_slug: new.to_string(),
            notes: existing.notes,
        },
        None => SlugAliasRecord {
            canonical_slug: new.to_string(),
            notes: Some("rename".to_string()),
        },
    };
    put_slug_alias(tx, source, old, &record)
}

/// The `page_aliases` part of `moveSlugBindings(source, old, new)`: rows of the new slug that
/// repeat an old-slug row (same alias and origin) yield, then every old-slug row moves to the new
/// slug.
fn move_page_aliases(tx: &mut dyn KvWrite, source: &str, old: &str, new: &str) -> Result<()> {
    if old == new {
        return Ok(());
    }
    for (alias, origin) in page_alias_rows(&*tx, source, old)? {
        let value = tx
            .get(&key(PAGE_ALIAS_BY_SLUG, &[source, old, &alias, &origin]))?
            .unwrap_or_default();
        delete_page_alias(tx, source, &alias, old, &origin)?;
        put_page_alias(tx, source, &alias, new, &origin)?;
        if !value.is_empty() {
            tx.put(
                &key(PAGE_ALIAS_BY_SLUG, &[source, new, &alias, &origin]),
                &value,
            )?;
        }
    }
    Ok(())
}

fn read_cr(read: &dyn KvRead, page_id: u64) -> Result<Option<CrState>> {
    get_json(read, &cr_key(page_id))
}

/// Writes the stamp `putPage` was given for the page it just wrote. A `none` mode writes nothing,
/// as PGLite's `putPage` leaves both columns alone for it (`engine-sql/pages.ts`).
pub(crate) fn stamp_contextual_retrieval(
    tx: &mut dyn KvWrite,
    page_id: u64,
    stamp: &ContextualRetrievalStamp,
) -> Result<()> {
    if stamp.mode == "none" {
        return Ok(());
    }
    let generation = stamp.corpus_generation.as_deref();
    refuse_nul("putPage", &[&stamp.mode, generation.unwrap_or("")])?;
    let state = CrState {
        mode: stamp.mode.clone(),
        corpus_generation: generation.map(str::to_string),
    };
    put_json(tx, &cr_key(page_id), &state)
}

/// The page's `corpus_generation` column: `None` when it has no state or the state has none (NULL).
pub(crate) fn corpus_generation(read: &dyn KvRead, page_id: u64) -> Result<Option<String>> {
    Ok(read_cr(read, page_id)?.and_then(|state| state.corpus_generation))
}

/// The page's `contextual_retrieval_mode` column: `None` when it has no state (NULL).
pub(crate) fn contextual_retrieval_mode(read: &dyn KvRead, page_id: u64) -> Result<Option<String>> {
    Ok(read_cr(read, page_id)?.map(|state| state.mode))
}

/// Deletes this family's records of a page that is deleted for good (`cascade::remove_page_rows`):
/// its contextual retrieval state. Its alias rows stay, as PGLite's do (module docs).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    tx.delete(&cr_key(page.id))
}

/// Deletes this family's records of a source that is deleted (`cascade::remove_source_rows`), as
/// Postgres's `ON DELETE CASCADE` on `slug_aliases`, `slug_rename_history` and `page_aliases` does:
/// every slug alias, rename row and page alias of the source, and the contextual retrieval state of any page still in it (core
/// removes the source's pages first, which already drops theirs through [`remove_page_rows`]).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    if has_nul(&[source_id]) {
        return Ok(());
    }
    for sub in [
        SLUG_ALIAS,
        SLUG_ALIAS_BY_CANONICAL,
        RENAME_HISTORY,
        PAGE_ALIAS,
        PAGE_ALIAS_BY_SLUG,
    ] {
        for (key, _) in scan_tails(&*tx, &prefix(sub, &[source_id]))? {
            tx.delete(&key)?;
        }
    }
    for page in all_pages(&*tx)? {
        if page.source_id == source_id {
            tx.delete(&cr_key(page.id))?;
        }
    }
    Ok(())
}

/// Adds this family's `getPage` columns to a page (`page_columns::add_page_columns`):
/// `contextual_retrieval_mode` when the page has a state. A page with none reads as its
/// `PAGE_ROW_DEFAULTS` value, `null` (`store-codec.ts`).
pub(crate) fn page_columns(
    read: &dyn KvRead,
    page: &PageRecord,
    columns: &mut PageColumns,
) -> Result<()> {
    if let Some(state) = read_cr(read, page.id)? {
        columns.set("contextual_retrieval_mode", Value::String(state.mode));
    }
    Ok(())
}

/// The rank of an origin in `readAliases`: frontmatter answers before declared, declared before
/// subject.
fn origin_rank(origin: &str) -> u8 {
    match origin {
        "subject" => 2,
        "declared" => 1,
        _ => 0,
    }
}

/// `pageReadFilter(..., live = true)` without a privacy or trust filter: not soft deleted, not
/// quarantined, and its source is not archived.
fn live_page(read: &dyn KvRead, source: &str, slug: &str) -> Result<Option<PageRecord>> {
    let Some(page) = read_page(read, source, slug)? else {
        return Ok(None);
    };
    if page.deleted_at_us.is_some() || page.frontmatter.contains_key(QUARANTINE_KEY) {
        return Ok(None);
    }
    let archived = read_source(read, source)?.is_none_or(|s| s.archived);
    Ok((!archived).then_some(page))
}

/// [`Store::replace_derived_aliases`] in the caller's write transaction.
pub(crate) fn replace_derived_aliases_in(
    tx: &mut dyn KvWrite,
    slug: &str,
    source_id: &str,
    aliases: &[DerivedAliasRow],
) -> Result<()> {
    const MEMBER: &str = "replaceDerivedAliases";
    refuse_nul(MEMBER, &[slug, source_id])?;
    for row in aliases {
        refuse_nul(MEMBER, &[&row.alias_norm, &row.origin])?;
        refuse_nul(MEMBER, &[row.alias_text.as_deref().unwrap_or("")])?;
        if !ORIGINS.contains(&row.origin.as_str()) {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                "new row for relation \"page_aliases\" violates check constraint \"page_aliases_origin_check\"",
            ));
        }
    }
    for (alias, origin) in page_alias_rows(&*tx, source_id, slug)? {
        if DERIVED.contains(&origin.as_str()) {
            delete_page_alias(tx, source_id, &alias, slug, &origin)?;
        }
    }
    if aliases.is_empty() {
        return Ok(());
    }
    require_source(&*tx, source_id)?;
    for row in aliases {
        let by_slug = key(
            PAGE_ALIAS_BY_SLUG,
            &[source_id, slug, &row.alias_norm, &row.origin],
        );
        if tx.get(&by_slug)?.is_some() {
            continue;
        }
        put_page_alias(tx, source_id, &row.alias_norm, slug, &row.origin)?;
        if row.origin != FRONTMATTER {
            let value = DerivedAliasValue {
                case_sensitive: row.case_sensitive,
                alias_text: row.alias_text.clone(),
            };
            put_json(tx, &by_slug, &value)?;
        }
    }
    Ok(())
}

impl Store {
    /// `setPageAliases(slug, sourceId, aliasNorms)`: replaces the page's `frontmatter` alias rows
    /// with the non-empty, distinct `aliasNorms`. Derived rows stay. The page need not exist; the
    /// source must when there is a row to insert (`source_not_found`, the foreign key).
    pub fn set_page_aliases(
        &self,
        slug: &str,
        source_id: &str,
        alias_norms: &[String],
    ) -> Result<()> {
        let mut uniq: Vec<&str> = Vec::new();
        for alias in alias_norms.iter().map(String::as_str) {
            if !alias.is_empty() && !uniq.contains(&alias) {
                uniq.push(alias);
            }
        }
        refuse_nul("setPageAliases", &[slug, source_id])?;
        refuse_nul("setPageAliases", &uniq)?;
        self.write(|tx| {
            if !uniq.is_empty() {
                require_source(&*tx, source_id)?;
            }
            for (alias, origin) in page_alias_rows(&*tx, source_id, slug)? {
                if origin == FRONTMATTER {
                    delete_page_alias(tx, source_id, &alias, slug, &origin)?;
                }
            }
            for alias in &uniq {
                put_page_alias(tx, source_id, alias, slug, FRONTMATTER)?;
            }
            Ok(())
        })
    }

    /// `replaceDerivedAliases(slug, sourceId, aliases)`: deletes the page's `declared` and
    /// `subject` rows, then inserts `aliases` in order; a row whose `(alias_norm, origin)` the page
    /// already holds is skipped (`ON CONFLICT DO NOTHING`), so the first of two equal rows wins
    /// and a `frontmatter` row keeps its own. An empty list only deletes. Refusals: NUL in any text
    /// (`invalid_argument`), an origin `page_aliases_origin_check` does not admit
    /// (`constraint_violation`) and, when there is a row to insert, a missing source
    /// (`source_not_found`, the foreign key). Nothing is written on a refusal.
    pub fn replace_derived_aliases(
        &self,
        slug: &str,
        source_id: &str,
        aliases: &[DerivedAliasRow],
    ) -> Result<()> {
        self.write(|tx| replace_derived_aliases_in(tx, slug, source_id, aliases))
    }

    /// `resolveAliases(aliasNorms, scope)`: each alias that names a live page in the scope, with
    /// the pages it names, aliases in byte order and pages by source then slug. Under the scope's
    /// privacy policy, trust floor and flagged-page filter a page they drop names nothing. Within
    /// a source only the best origin of the remaining rows answers, and a derived alias yields to
    /// another live page the scope may read whose lower-cased title is the alias. A trust tier
    /// name that is no tier refuses with `invalid_argument`.
    pub fn resolve_aliases(
        &self,
        alias_norms: &[String],
        scope: &AliasScope,
    ) -> Result<Vec<(String, Vec<AliasRef>)>> {
        if alias_norms.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let trust = TrustPolicy::parse(scope.min_trust.as_deref(), scope.suppress_flagged)?;
        // The owner-only sources are read once per call, on the first page it judges.
        let owner_only = RefCell::new(OwnerOnlyCache::default());
        let readable = |page: &PageRecord| -> Result<bool> {
            if let Some(policy) = &scope.exclude_private
                && owner_only.borrow_mut().page_hidden(&*read, page, policy)?
            {
                return Ok(false);
            }
            let tier = TrustTier::stored(page.trust_tier.as_deref());
            trust.admits(&*read, "pages", page.id, tier)
        };
        let sources: BTreeSet<String> = scope_sources(&*read, &scope.source_id, &scope.source_ids)?
            .into_iter()
            .collect();
        let aliases: BTreeSet<&str> = alias_norms
            .iter()
            .map(String::as_str)
            .filter(|a| !a.contains('\0'))
            .collect();
        // Titles of the live pages the scope may read, per source, read only when a derived row
        // needs them.
        let mut titles: Option<BTreeMap<String, Vec<(String, String)>>> = None;
        let mut out = Vec::new();
        for alias in aliases {
            let mut refs: Vec<AliasRef> = Vec::new();
            for source in &sources {
                if source.contains('\0') {
                    continue;
                }
                // (rank, slug), live pages only.
                let mut rows: Vec<(u8, String)> = Vec::new();
                for (_, parts) in scan_tails(&*read, &prefix(PAGE_ALIAS, &[source, alias]))? {
                    let [slug, origin] = parts.as_slice() else {
                        continue;
                    };
                    let Some(page) = live_page(&*read, source, slug)? else {
                        continue;
                    };
                    if !readable(&page)? {
                        continue;
                    }
                    let rank = origin_rank(origin);
                    if rank > 0 {
                        let titles = match &mut titles {
                            Some(t) => t,
                            None => titles.insert(live_titles(&*read, &readable)?),
                        };
                        let shadowed = titles.get(source).is_some_and(|pages| {
                            pages.iter().any(|(s, title)| title == alias && s != slug)
                        });
                        if shadowed {
                            continue;
                        }
                    }
                    rows.push((rank, slug.clone()));
                }
                let Some(best) = rows.iter().map(|(rank, _)| *rank).min() else {
                    continue;
                };
                let slugs: BTreeSet<String> = rows
                    .into_iter()
                    .filter(|(rank, _)| *rank == best)
                    .map(|(_, slug)| slug)
                    .collect();
                refs.extend(slugs.into_iter().map(|slug| AliasRef {
                    slug,
                    source_id: source.clone(),
                }));
            }
            if !refs.is_empty() {
                out.push((alias.to_string(), refs));
            }
        }
        Ok(out)
    }

    /// `aliasCanonicalRefs(refs, policy)` (engine-sql/search-reads.ts): each distinct ref that is
    /// the `canonical_slug` of some `slug_aliases` row in its source and names a page there, as
    /// `{ source_id, canonical_slug }`, by source then slug in byte order. With no policy any page
    /// row answers, soft-deleted ones too, as the SQL's join does; under a policy the page must be
    /// in the source list, live (not soft-deleted, not quarantined, its source not archived) and,
    /// under `exclude_private`, pass the page policy. A ref holding a NUL byte names nothing.
    pub fn alias_canonical_refs(&self, query: &AliasCanonicalQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let trust = TrustPolicy::parse(query.min_trust.as_deref(), query.suppress_flagged)?;
        let mut owner_only = OwnerOnlyCache::default();
        let refs: BTreeSet<(&str, &str)> = query
            .refs
            .iter()
            .map(|r| (r.source_id.as_str(), r.slug.as_str()))
            .filter(|(source, slug)| !has_nul(&[source, slug]))
            .collect();
        let mut out = Vec::new();
        for (source, slug) in refs {
            let mut aliased = false;
            scan_prefix(
                &*read,
                &prefix(SLUG_ALIAS_BY_CANONICAL, &[source, slug]),
                false,
                &mut |_, _| {
                    aliased = true;
                    false
                },
            )?;
            if !aliased {
                continue;
            }
            let page = if query.live {
                live_page(&*read, source, slug)?
            } else {
                read_page(&*read, source, slug)?
            };
            let Some(page) = page else {
                continue;
            };
            if query
                .source_ids
                .as_ref()
                .is_some_and(|ids| !ids.iter().any(|id| id == source))
            {
                continue;
            }
            if let Some(policy) = &query.exclude_private
                && owner_only.page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            let tier = TrustTier::stored(page.trust_tier.as_deref());
            if !trust.admits(&*read, "pages", page.id, tier)? {
                continue;
            }
            out.push(serde_json::json!({"source_id": source, "canonical_slug": slug}));
        }
        Ok(out)
    }

    /// `resolveSlugWithAliasDetailed(slug, sources)`: the `slug_aliases` row of `slug` in the first
    /// source, in the given order, that has one; `None` when none does or `sources` is empty.
    pub fn resolve_slug_with_alias_detailed(
        &self,
        slug: &str,
        sources: &[String],
    ) -> Result<Option<SlugAliasMatch>> {
        let read = self.read()?;
        let mut seen: BTreeSet<&str> = BTreeSet::new();
        let mut found: Vec<(&str, SlugAliasRecord)> = Vec::new();
        for source in sources {
            if !seen.insert(source.as_str()) {
                continue;
            }
            if let Some(record) = read_slug_alias(&*read, source, slug)? {
                found.push((source.as_str(), record));
            }
        }
        let matches = found.len();
        Ok(found
            .into_iter()
            .next()
            .map(|(source, record)| SlugAliasMatch {
                canonical_slug: record.canonical_slug,
                source_id: source.to_string(),
                matches,
            }))
    }

    /// `updatePageContextualRetrievalState(slug, sourceId, mode, corpusGeneration)`: stamps the
    /// live page at `(sourceId, slug)` and sets its `updated_at`; anything else is left alone. The
    /// knowledge revision does not move (neither column is in the revision trigger's list). Moving a
    /// page from the `title` or `per_chunk_synopsis` tier to `none` resets what the tier embedded, as
    /// the SQL engines do: the page's `embedding_signature` goes, and every chunk with a vector loses
    /// it, its embed time and its text and input hashes and is stamped pending now
    /// (`embeddings::reset_page_vectors`, which raises the vector generation). An `embed_skip` page
    /// keeps both, as does a page that had no tier.
    pub fn update_page_contextual_retrieval_state(
        &self,
        slug: &str,
        source_id: &str,
        mode: &str,
        corpus_generation: Option<&str>,
    ) -> Result<()> {
        refuse_nul(
            "updatePageContextualRetrievalState",
            &[slug, source_id, mode, corpus_generation.unwrap_or("")],
        )?;
        self.write(|tx| {
            let Some(mut page) =
                read_page(&*tx, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
            else {
                return Ok(());
            };
            let now = self.env.now_micros();
            let old_mode = read_cr(&*tx, page.id)?.map(|cr| cr.mode);
            if mode == "none"
                && matches!(old_mode.as_deref(), Some("title" | "per_chunk_synopsis"))
                && !page.frontmatter.contains_key(EMBED_SKIP_KEY)
            {
                crate::embeddings::reset_page_vectors(tx, page.id, now)?;
            }
            let state = CrState {
                mode: mode.to_string(),
                corpus_generation: corpus_generation.map(str::to_string),
            };
            put_json(tx, &cr_key(page.id), &state)?;
            page.updated_at_us = now;
            write_page(tx, &page)
        })
    }

    /// `updateSlug(oldSlug, newSlug, { sourceId })`: moves the page at `(sourceId ?? 'default',
    /// oldSlug)`, soft-deleted or not, to `newSlug`, and returns the number of pages moved (0 when
    /// there is none). The page is versioned as it stood first, then moved by
    /// `pages::rename_page`; a real move records `old -> new` in the rename history and the slug aliases, moves the records
    /// other families key by slug (`cascade::rename_slug_rows`) and moves the page's alias rows. `invalid_slug` for a bad new slug, `constraint_violation` when the new
    /// slug is taken; either keeps nothing. A segmented page (NULL body) is refused with `invalid_state` before anything
    /// is written, as `create_version` refuses it: PGLite versions it as a reference to its live body generation, and
    /// this store keeps no such reference, so the version would hold no body.
    pub fn update_slug(
        &self,
        old_slug: &str,
        new_slug: &str,
        source_id: Option<&str>,
    ) -> Result<u64> {
        let new_slug = validate_slug(new_slug)?;
        let source = source_id.unwrap_or(DEFAULT_SOURCE);
        // #9735: a move only re-keys the page and the facts that name it, so both keep their tier
        // (`withTrustKeep(tx, ['pages', 'facts'])` in `engine-sql/pages.ts` `updateSlug`).
        let mut trust = self.write_trust()?;
        for table in [TrustTable::Pages, TrustTable::Facts] {
            if !trust.keep.contains(&table) {
                trust.keep.push(table);
            }
        }
        let trust = &trust;
        self.write(|tx| {
            let _keep = crate::write_trust::stamp_context::open(trust.clone());
            let Some(page) = read_page(&*tx, source, old_slug)? else {
                return Ok(0);
            };
            if page.compiled_truth.is_null() {
                return Err(StoreError::new(
                    INVALID_STATE,
                    format!("updateSlug refuses segmented page {old_slug} (source={source})"),
                ));
            }
            snapshot_in(tx, &*self.env, &page)?;
            // The snapshot's prune can record a history gap on the page: move the page as stored.
            let page = read_page_by_id(&*tx, page.id)?.unwrap_or(page);
            let moved = rename_page(tx, &*self.env, &page, &new_slug)?;
            if moved.slug != page.slug {
                record_rename_alias(tx, source, &page.slug, &moved.slug)?;
                // `moveSlugBindings`: the other families' records keyed by slug (steps 1-6), then
                // this family's page aliases (steps 7-8).
                crate::cascade::rename_slug_rows(tx, trust, source, &page.slug, &moved.slug)?;
                move_page_aliases(tx, source, &page.slug, &moved.slug)?;
            }
            Ok(1)
        })
    }
}

/// `(slug, lower(title))` of every live page `readable` admits, per source.
fn live_titles(
    read: &dyn KvRead,
    readable: &dyn Fn(&PageRecord) -> Result<bool>,
) -> Result<BTreeMap<String, Vec<(String, String)>>> {
    let mut out: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    let mut archived: BTreeMap<String, bool> = BTreeMap::new();
    for page in all_pages(read)? {
        if page.deleted_at_us.is_some() || page.frontmatter.contains_key(QUARANTINE_KEY) {
            continue;
        }
        let gone = match archived.get(&page.source_id) {
            Some(gone) => *gone,
            None => {
                let gone = read_source(read, &page.source_id)?.is_none_or(|s| s.archived);
                archived.insert(page.source_id.clone(), gone);
                gone
            }
        };
        if !gone && readable(&page)? {
            out.entry(page.source_id.clone())
                .or_default()
                .push((page.slug.clone(), page.title.to_lowercase()));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_keep_each_part_apart() {
        assert_eq!(key(PAGE_ALIAS, &["s", "a", "p", "o"]), b"k\x02s\0a\0p\0o");
        assert_eq!(prefix(PAGE_ALIAS_BY_SLUG, &["s", "p"]), b"k\x03s\0p\0");
        assert_eq!(cr_key(1), b"k\x04\0\0\0\0\0\0\0\x01");
        assert_eq!(
            tail(b"k\x03s\0p\0al\0frontmatter", 6),
            ["al", "frontmatter"]
        );
    }

    /// Every key of this family, as `(sub tag, rest)`, in key order.
    fn family_keys(store: &Store) -> Vec<Vec<u8>> {
        let read = store.read().unwrap();
        let mut out = Vec::new();
        scan_prefix(&*read, &[keys::ALIAS], false, &mut |k, _| {
            out.push(k.to_vec());
            true
        })
        .unwrap();
        out
    }

    #[test]
    fn a_source_delete_removes_every_record_of_that_source_only() {
        use crate::pages::{PageInput, PutPageOptions};
        use crate::sources::SourceInput;
        let store = crate::test_support::store();
        // `other` is a prefix of `other2`: the scan must stop at the separator.
        for id in ["other", "other2"] {
            let input: SourceInput =
                serde_json::from_value(json!({ "id": id, "name": id, "config": {} })).unwrap();
            store.upsert_source(&input).unwrap();
        }
        let input = PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        let fill = |source: &str| {
            let options: PutPageOptions =
                serde_json::from_value(json!({ "sourceId": source })).unwrap();
            store.put_page("a", &input, &options).unwrap();
            store
                .set_page_aliases("a", source, &["ay".to_string()])
                .unwrap();
            store
                .update_page_contextual_retrieval_state("a", source, "title", None)
                .unwrap();
            assert_eq!(store.update_slug("a", "b", Some(source)).unwrap(), 1);
        };
        fill("default");
        let kept = family_keys(&store);
        assert_eq!(kept.len(), 6);
        fill("other2");
        let both = family_keys(&store);
        fill("other");
        assert_eq!(family_keys(&store).len(), 18);
        store.write(|tx| remove_source_rows(tx, "other")).unwrap();
        assert_eq!(family_keys(&store), both);
        store
            .write(|tx| {
                remove_source_rows(tx, "other2")?;
                remove_source_rows(tx, "nowhere")?;
                remove_source_rows(tx, "a\0b")
            })
            .unwrap();
        assert_eq!(family_keys(&store), kept);
    }

    fn derived(alias: &str, origin: &str, case_sensitive: bool, text: &str) -> DerivedAliasRow {
        DerivedAliasRow {
            alias_norm: alias.into(),
            origin: origin.into(),
            case_sensitive,
            alias_text: Some(text.into()),
        }
    }

    /// `(alias, origin, value)` of every row of the page, sorted.
    fn rows_with_values(
        store: &Store,
        slug: &str,
    ) -> Vec<(String, String, Option<DerivedAliasValue>)> {
        let read = store.read().unwrap();
        let mut rows: Vec<_> = page_alias_rows(&*read, "default", slug)
            .unwrap()
            .into_iter()
            .map(|(alias, origin)| {
                let value: Option<DerivedAliasValue> = get_json(
                    &*read,
                    &key(PAGE_ALIAS_BY_SLUG, &["default", slug, &alias, &origin]),
                )
                .unwrap_or(None);
                (alias, origin, value)
            })
            .collect();
        rows.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
        rows
    }

    #[test]
    fn derived_aliases_replace_only_the_derived_rows_and_the_first_row_wins() {
        let store = crate::test_support::store();
        store
            .set_page_aliases("a", "default", &["fm".to_string()])
            .unwrap();
        store
            .replace_derived_aliases(
                "a",
                "default",
                &[
                    derived("x", "declared", true, "X1"),
                    derived("x", "declared", false, "X2"),
                    derived("fm", FRONTMATTER, false, "F"),
                    derived("", "subject", false, ""),
                ],
            )
            .unwrap();
        let value = |c: bool, t: &str| {
            Some(DerivedAliasValue {
                case_sensitive: c,
                alias_text: Some(t.into()),
            })
        };
        assert_eq!(
            rows_with_values(&store, "a"),
            vec![
                ("".into(), "subject".into(), value(false, "")),
                ("fm".into(), FRONTMATTER.into(), None),
                ("x".into(), "declared".into(), value(true, "X1")),
            ]
        );
        let bad = store
            .replace_derived_aliases("a", "default", &[derived("y", "weird", false, "Y")])
            .unwrap_err();
        assert_eq!(bad.code, CONSTRAINT_VIOLATION);
        assert_eq!(
            rows_with_values(&store, "a").len(),
            3,
            "a refusal writes nothing"
        );
        let missing = store
            .replace_derived_aliases("a", "nosrc", &[derived("y", "declared", false, "Y")])
            .unwrap_err();
        assert_eq!(missing.code, crate::error::SOURCE_NOT_FOUND);
        store.replace_derived_aliases("a", "nosrc", &[]).unwrap();
        // A rename carries the derived row's columns with it.
        let input = crate::pages::PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..crate::pages::PageInput::default()
        };
        store
            .put_page("a", &input, &crate::pages::PutPageOptions::default())
            .unwrap();
        assert_eq!(store.update_slug("a", "b", None).unwrap(), 1);
        assert_eq!(
            rows_with_values(&store, "b")[2],
            ("x".into(), "declared".into(), value(true, "X1"))
        );
        store.replace_derived_aliases("b", "default", &[]).unwrap();
        assert_eq!(
            rows_with_values(&store, "b"),
            vec![("fm".into(), FRONTMATTER.into(), None)]
        );
    }

    #[test]
    fn a_slug_move_keeps_the_page_tier_whatever_the_mover_declares() {
        let store = crate::test_support::store();
        let declare = |tier: &str| {
            let names =
                ["gbrain.write_trust_tier", "gbrain.write_trust_promotion"].map(String::from);
            store
                .apply_write_trust(&names, &[tier.to_string(), tier.to_string()])
                .unwrap();
        };
        let tier = |slug: &str| {
            let read = store.read().unwrap();
            read_page(&*read, "default", slug)
                .unwrap()
                .unwrap()
                .trust_tier
        };
        let input = crate::pages::PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..crate::pages::PageInput::default()
        };
        declare("agent_written");
        store
            .put_page("a", &input, &crate::pages::PutPageOptions::default())
            .unwrap();
        assert_eq!(tier("a").as_deref(), Some("agent_written"));
        // An owner-tier mover does not raise the page; a mover with no declared tier does not lower it.
        declare("operator_curated");
        assert_eq!(store.update_slug("a", "b", None).unwrap(), 1);
        assert_eq!(tier("b").as_deref(), Some("agent_written"));
        store.clear_write_trust();
        assert_eq!(store.update_slug("b", "c", None).unwrap(), 1);
        assert_eq!(tier("c").as_deref(), Some("agent_written"));
    }

    /// A derived alias yields to a live page titled with it; under a privacy policy a page the policy
    /// hides is not one (the `titleFilter` of `readAliases`).
    #[test]
    fn a_private_title_shadows_a_derived_alias_only_without_the_policy() {
        use crate::pages::{PageInput, PutPageOptions};
        let store = crate::test_support::store();
        let put = |slug: &str, title: &str, frontmatter: serde_json::Value| {
            let input: PageInput = serde_json::from_value(json!({
                "type": "note", "title": title, "compiled_truth": "body", "frontmatter": frontmatter,
            }))
            .unwrap();
            store
                .put_page(slug, &input, &PutPageOptions::default())
                .unwrap();
        };
        put("companies/acme", "Acme Co", json!({}));
        put(
            "notes/acme-title",
            "Acme",
            json!({ "visibility": "private" }),
        );
        put("companies/beta", "Beta Co", json!({}));
        put("notes/beta-title", "Beta", json!({}));
        store
            .write(|tx| {
                put_page_alias(tx, "default", "acme", "companies/acme", "declared")?;
                put_page_alias(tx, "default", "beta", "companies/beta", "declared")
            })
            .unwrap();
        let names = ["acme".to_string(), "beta".to_string()];
        let answer = |scope: serde_json::Value| {
            let scope: AliasScope = serde_json::from_value(scope).unwrap();
            store
                .resolve_aliases(&names, &scope)
                .unwrap()
                .into_iter()
                .map(|(alias, refs)| (alias, refs.into_iter().map(|r| r.slug).collect::<Vec<_>>()))
                .collect::<Vec<_>>()
        };
        assert!(answer(json!({})).is_empty());
        assert_eq!(
            answer(
                json!({ "excludePrivate": { "honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn" } })
            ),
            vec![("acme".to_string(), vec!["companies/acme".to_string()])]
        );
        // With the privacy part of the policy off, nothing is hidden by `visibility`, so the title shadows again.
        assert!(
            answer(json!({ "excludePrivate": { "honorAliases": true, "entityPrivacy": false, "ownerOnly": "fn" } }))
                .is_empty()
        );
    }

    #[test]
    fn a_rename_keeps_a_row_the_new_slug_already_had_once() {
        let store = crate::test_support::store();
        let aliases = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        store
            .set_page_aliases("a", "default", &aliases(&["ay", "shared"]))
            .unwrap();
        store
            .set_page_aliases("b", "default", &aliases(&["shared", "bee"]))
            .unwrap();
        let input = crate::pages::PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..crate::pages::PageInput::default()
        };
        store
            .put_page("a", &input, &crate::pages::PutPageOptions::default())
            .unwrap();
        assert_eq!(store.update_slug("a", "b", None).unwrap(), 1);
        let read = store.read().unwrap();
        assert!(page_alias_rows(&*read, "default", "a").unwrap().is_empty());
        let mut rows = page_alias_rows(&*read, "default", "b").unwrap();
        rows.sort();
        let expected: Vec<(String, String)> = ["ay", "bee", "shared"]
            .iter()
            .map(|a| (a.to_string(), FRONTMATTER.to_string()))
            .collect();
        assert_eq!(rows, expected);
        // Both key spaces hold each row once: 3 rows, 2 keys each.
        let mut count = 0;
        for sub in [PAGE_ALIAS, PAGE_ALIAS_BY_SLUG] {
            scan_prefix(&*read, &[keys::ALIAS, sub], false, &mut |_, _| {
                count += 1;
                true
            })
            .unwrap();
        }
        assert_eq!(count, 6);
    }

    #[test]
    fn rename_history_keeps_dropped_aliases_and_follows_the_page() {
        let store = crate::test_support::store();
        let input = crate::pages::PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..crate::pages::PageInput::default()
        };
        let put = |slug: &str| {
            store
                .put_page(slug, &input, &crate::pages::PutPageOptions::default())
                .unwrap();
        };
        let rows = || {
            let read = store.read().unwrap();
            rename_rows(&*read, "default").unwrap()
        };
        let pair = |o: &str, n: &str| (o.to_string(), n.to_string());
        put("x");
        assert_eq!(store.update_slug("x", "d", None).unwrap(), 1);
        assert_eq!(rows(), [pair("x", "d")]);
        // A second page leaves `x` for `b`: the alias `x -> b` replaces `x -> d`, both rows stay.
        put("x");
        assert_eq!(store.update_slug("x", "b", None).unwrap(), 1);
        assert_eq!(rows(), [pair("x", "b"), pair("x", "d")]);
        // A single page delete keeps the rows that end at it, as PGLite's plain DELETE does.
        store.delete_page("d", None).unwrap();
        assert_eq!(rows().len(), 2);
        // `b -> d`: `x -> b` would repeat `x -> d` once moved, so it goes (statement 2).
        assert_eq!(store.update_slug("b", "d", None).unwrap(), 1);
        assert_eq!(rows(), [pair("b", "d"), pair("x", "d")]);
        // A page renamed onto `b` drops the alias `b -> d`; the history still answers for `b`.
        put("e");
        assert_eq!(store.update_slug("e", "b", None).unwrap(), 1);
        let read = store.read().unwrap();
        assert!(read_slug_alias(&*read, "default", "b").unwrap().is_none());
        assert_eq!(renamed_to(&*read, "default", "b").unwrap(), ["d"]);
        assert_eq!(renamed_to(&*read, "default", "e").unwrap(), ["b"]);
        drop(read);
        // `d -> f`: every row that ended at `d` follows the page (statement 3).
        assert_eq!(store.update_slug("d", "f", None).unwrap(), 1);
        assert_eq!(
            rows(),
            [
                pair("b", "f"),
                pair("d", "f"),
                pair("e", "b"),
                pair("x", "f")
            ]
        );
        let removed = store
            .write(|tx| scrub_purged_rename_history(tx, "default", &["f".to_string()]))
            .unwrap();
        assert_eq!(removed, 3);
        assert_eq!(rows(), [pair("e", "b")]);
    }

    #[test]
    fn origins_rank_frontmatter_first() {
        assert!(origin_rank(FRONTMATTER) < origin_rank("declared"));
        assert!(origin_rank("declared") < origin_rank("subject"));
    }
}
