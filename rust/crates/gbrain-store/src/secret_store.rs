//! The secret store (GST-2988): the `secret_store` entries and the `secret_store_occurrence` rows
//! (`src/core/schema-migrations/v324-secret-store.ts`), and the statements of
//! `src/core/engine-sql/secret-store.ts`. rust/docs/store/secret-store.md.
//!
//! Members: findSecretEntryByMac, secretEntryExists, insertSecretEntry, insertSecretOccurrence, readSecretEntry,
//! listSecretOccurrences, listSecretEntrySummaries, countSecretsByRule, listAllowedSecretMacs, listSecretKeysInUse,
//! readSecretStoreSnapshot, insertBackupSecretEntry, readBackupEntryHold, insertBackupSecretOccurrence,
//! deleteUnreferencedSecretEntry, listSecretHoldingPages, countUnreferencedSecretEntries,
//! readRestorePageHit, markSecretEntryAllowed.
//!
//! The crypto stays in TypeScript (`secret-store/keyring.ts`): the store keeps the ciphertext, nonce, tag and MACs it is
//! given and never sees a value.
//!
//! Keys (tag `3`, `keys::SECRET_STORE`, then one byte for the record):
//! - `x 0x01 <entry id>`: an entry (`EntryRecord`), the `secret_store` row.
//! - `x 0x02 <source> \0 <value_mac>` -> entry id: `UNIQUE (source_id, value_mac)`.
//! - `x 0x03 <entry id> \0 <occurrence id be8>`: the entry's occurrences (`secret_store_occurrence_entry_idx`,
//!   `ON DELETE CASCADE` of the entry).
//! - `x 0x04 <occurrence id be8>`: an occurrence (`OccurrenceRecord`), ids from `M next_secret_occurrence_id`.
//! - `x 0x05 <source> \0 <slug> \0 <occurrence id be8>`: occurrences by place (`secret_store_occurrence_page_idx`).
//! - `x 0x06 <page id be8> <occurrence id be8>`: occurrences by page (`page_id ... ON DELETE SET NULL`).
//!
//! Cascades: a hard page delete sets the page's occurrences' `page_id` to none ([`remove_page_rows`]) and the purge
//! (`deletePages`, `purgeDeletedPages`: [`purge_for_deleted_pages`]) then removes the page's occurrences and every entry
//! only they referenced, as `purgeSecretsForSlugs` does. A source delete removes the source's entries with their
//! occurrences ([`remove_source_rows`]). A page rename moves the page's occurrence slugs ([`rename_slug_rows`]).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::cli_reads::pg_text::timestamptz_text;
use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, Result, SOURCE_NOT_FOUND, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::sources::read_source;
use crate::{Store, get_json, keys, put_json};

const ENTRY: u8 = 0x01;
const BY_MAC: u8 = 0x02;
const BY_ENTRY: u8 = 0x03;
const OCCURRENCE: u8 = 0x04;
const BY_SLUG: u8 = 0x05;
const BY_PAGE: u8 = 0x06;
const NEXT_OCCURRENCE_ID: &str = "next_secret_occurrence_id";

const ORIGINS: [&str; 5] = [
    "repair",
    "publish_rebuild",
    "transcript",
    "archive",
    "capture",
];

/// One `secret_store` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EntryRecord {
    id: String,
    source_id: String,
    rule: String,
    ciphertext: String,
    nonce: String,
    tag: String,
    key_id: String,
    key_host: String,
    value_mac: String,
    status: String,
    created_at_us: i64,
    updated_at_us: i64,
}

/// One `secret_store_occurrence` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct OccurrenceRecord {
    entry_id: String,
    source_id: String,
    #[serde(default)]
    page_id: Option<u64>,
    #[serde(default)]
    slug: Option<String>,
    field: String,
    origin: String,
    #[serde(default)]
    commit_sha: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<i64>,
    #[serde(default)]
    pre_field_sha256: Option<String>,
    created_by: String,
    created_at_us: i64,
}

/// `SecretEntryInsert` of `engine-sql/secret-store.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretEntryInsert {
    pub id: String,
    pub source_id: String,
    pub rule: String,
    pub ciphertext: String,
    pub nonce: String,
    pub tag: String,
    pub key_id: String,
    pub key_host: String,
    pub value_mac: String,
}

/// `SecretOccurrenceInsert` of `engine-sql/secret-store.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretOccurrenceInsert {
    pub entry_id: String,
    pub source_id: String,
    #[serde(default)]
    pub page_id: Option<i64>,
    #[serde(default)]
    pub slug: Option<String>,
    pub field: String,
    pub origin: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub line: Option<i64>,
    #[serde(default)]
    pub pre_field_sha256: Option<String>,
    #[serde(default)]
    pub created_by: String,
}

/// `SecretBackupEntryRow`: an entry as a backup keeps it, timestamps as UTC ISO text.
#[derive(Debug, Clone, Deserialize)]
pub struct BackupEntry {
    pub id: String,
    pub source_id: String,
    pub rule: String,
    pub ciphertext: String,
    pub nonce: String,
    pub tag: String,
    pub key_id: String,
    pub key_host: String,
    pub value_mac: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

/// `SecretBackupOccurrenceRow`.
#[derive(Debug, Clone, Deserialize)]
pub struct BackupOccurrence {
    pub entry_id: String,
    pub source_id: String,
    #[serde(default)]
    pub slug: Option<String>,
    pub field: String,
    pub origin: String,
    #[serde(default)]
    pub commit_sha: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub line: Option<i64>,
    #[serde(default)]
    pub pre_field_sha256: Option<String>,
    pub created_by: String,
    pub created_at: String,
}

fn entry_key(id: &str) -> Vec<u8> {
    let mut key = vec![keys::SECRET_STORE, ENTRY];
    key.extend_from_slice(id.as_bytes());
    key
}

fn mac_prefix(source_id: &str) -> Vec<u8> {
    let mut key = vec![keys::SECRET_STORE, BY_MAC];
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key
}

fn mac_key(source_id: &str, mac: &str) -> Vec<u8> {
    let mut key = mac_prefix(source_id);
    key.extend_from_slice(mac.as_bytes());
    key
}

fn by_entry_prefix(entry_id: &str) -> Vec<u8> {
    let mut key = vec![keys::SECRET_STORE, BY_ENTRY];
    key.extend_from_slice(entry_id.as_bytes());
    key.push(0);
    key
}

fn by_entry_key(entry_id: &str, occurrence: u64) -> Vec<u8> {
    let mut key = by_entry_prefix(entry_id);
    key.extend_from_slice(&occurrence.to_be_bytes());
    key
}

fn occurrence_key(occurrence: u64) -> Vec<u8> {
    let mut key = vec![keys::SECRET_STORE, OCCURRENCE];
    key.extend_from_slice(&occurrence.to_be_bytes());
    key
}

fn by_slug_prefix(source_id: &str, slug: &str) -> Vec<u8> {
    let mut key = vec![keys::SECRET_STORE, BY_SLUG];
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key.extend_from_slice(slug.as_bytes());
    key.push(0);
    key
}

fn by_slug_key(source_id: &str, slug: &str, occurrence: u64) -> Vec<u8> {
    let mut key = by_slug_prefix(source_id, slug);
    key.extend_from_slice(&occurrence.to_be_bytes());
    key
}

fn by_page_prefix(page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::SECRET_STORE, BY_PAGE];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn by_page_key(page_id: u64, occurrence: u64) -> Vec<u8> {
    let mut key = by_page_prefix(page_id);
    key.extend_from_slice(&occurrence.to_be_bytes());
    key
}

fn violation(message: impl Into<String>) -> StoreError {
    StoreError::new(CONSTRAINT_VIOLATION, message)
}

fn no_nul(what: &str, values: &[&str]) -> Result<()> {
    if values.iter().any(|v| v.contains('\0')) {
        return Err(StoreError::invalid(format!(
            "secret store: {what} cannot contain a NUL byte"
        )));
    }
    Ok(())
}

fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `^[a-z0-9_]{1,64}$`.
fn is_rule(text: &str) -> bool {
    (1..=64).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// The CHECK constraints of `secret_store`.
fn check_entry(e: &EntryRecord) -> Result<()> {
    no_nul(
        "an entry column",
        &[
            &e.id,
            &e.source_id,
            &e.rule,
            &e.ciphertext,
            &e.nonce,
            &e.tag,
            &e.key_id,
            &e.key_host,
            &e.value_mac,
            &e.status,
        ],
    )?;
    let id_ok = e.id.strip_prefix("ss_").is_some_and(|hex| is_hex(hex, 12));
    if !id_ok {
        return Err(violation("secret_store_id_check"));
    }
    if !is_rule(&e.rule) {
        return Err(violation("secret_store_rule_check"));
    }
    if !is_hex(&e.key_id, 16) {
        return Err(violation("secret_store_key_id_check"));
    }
    if !is_hex(&e.value_mac, 64) {
        return Err(violation("secret_store_value_mac_check"));
    }
    if e.status != "active" && e.status != "allowed" {
        return Err(violation("secret_store_status_check"));
    }
    Ok(())
}

/// The CHECK constraints of `secret_store_occurrence`.
fn check_occurrence(o: &OccurrenceRecord) -> Result<()> {
    no_nul(
        "an occurrence column",
        &[
            &o.entry_id,
            &o.source_id,
            o.slug.as_deref().unwrap_or(""),
            &o.field,
            &o.origin,
            o.commit_sha.as_deref().unwrap_or(""),
            o.path.as_deref().unwrap_or(""),
            o.pre_field_sha256.as_deref().unwrap_or(""),
            &o.created_by,
        ],
    )?;
    if !ORIGINS.contains(&o.origin.as_str()) {
        return Err(violation("secret_store_occurrence_origin_check"));
    }
    if o.pre_field_sha256
        .as_deref()
        .is_some_and(|h| !is_hex(h, 64))
    {
        return Err(violation("secret_store_occurrence_pre_field_sha256_check"));
    }
    Ok(())
}

fn read_entry(read: &dyn KvRead, id: &str) -> Result<Option<EntryRecord>> {
    if id.contains('\0') {
        return Ok(None);
    }
    get_json(read, &entry_key(id))
}

fn read_occurrence(read: &dyn KvRead, id: u64) -> Result<Option<OccurrenceRecord>> {
    get_json(read, &occurrence_key(id))
}

fn entry_json(e: &EntryRecord) -> Value {
    json!({
        "id": e.id, "source_id": e.source_id, "rule": e.rule, "ciphertext": e.ciphertext, "nonce": e.nonce, "tag": e.tag,
        "key_id": e.key_id, "key_host": e.key_host, "value_mac": e.value_mac, "status": e.status,
        "created_at": timestamptz_text(e.created_at_us),
    })
}

/// Every entry, in id order.
fn all_entries(read: &dyn KvRead) -> Result<Vec<EntryRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &[keys::SECRET_STORE, ENTRY], false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

/// The occurrence ids of one entry, in id order.
fn entry_occurrence_ids(read: &dyn KvRead, entry_id: &str) -> Result<Vec<u64>> {
    let prefix = by_entry_prefix(entry_id);
    let mut out = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, _| {
        if let Some(id) = keys::be8(&k[prefix.len()..]) {
            out.push(id);
        }
        true
    })?;
    Ok(out)
}

/// The occurrences of one entry with their ids, in id order.
fn entry_occurrences(read: &dyn KvRead, entry_id: &str) -> Result<Vec<(u64, OccurrenceRecord)>> {
    let mut out = Vec::new();
    for id in entry_occurrence_ids(read, entry_id)? {
        if let Some(record) = read_occurrence(read, id)? {
            out.push((id, record));
        }
    }
    Ok(out)
}

fn put_occurrence(tx: &mut dyn KvWrite, id: u64, o: &OccurrenceRecord) -> Result<()> {
    put_json(tx, &occurrence_key(id), o)?;
    tx.put(&by_entry_key(&o.entry_id, id), &[])?;
    if let Some(slug) = &o.slug {
        tx.put(&by_slug_key(&o.source_id, slug, id), &[])?;
    }
    if let Some(page) = o.page_id {
        tx.put(&by_page_key(page, id), &[])?;
    }
    Ok(())
}

fn delete_occurrence(tx: &mut dyn KvWrite, id: u64, o: &OccurrenceRecord) -> Result<()> {
    tx.delete(&occurrence_key(id))?;
    tx.delete(&by_entry_key(&o.entry_id, id))?;
    if let Some(slug) = &o.slug {
        tx.delete(&by_slug_key(&o.source_id, slug, id))?;
    }
    if let Some(page) = o.page_id {
        tx.delete(&by_page_key(page, id))?;
    }
    Ok(())
}

fn delete_entry(tx: &mut dyn KvWrite, e: &EntryRecord) -> Result<()> {
    tx.delete(&entry_key(&e.id))?;
    tx.delete(&mac_key(&e.source_id, &e.value_mac))
}

fn put_entry(tx: &mut dyn KvWrite, e: &EntryRecord) -> Result<()> {
    put_json(tx, &entry_key(&e.id), e)?;
    tx.put(&mac_key(&e.source_id, &e.value_mac), e.id.as_bytes())
}

fn entry_id_by_mac(read: &dyn KvRead, source_id: &str, mac: &str) -> Result<Option<String>> {
    if source_id.contains('\0') || mac.contains('\0') {
        return Ok(None);
    }
    Ok(read
        .get(&mac_key(source_id, mac))?
        .map(|id| String::from_utf8_lossy(&id).into_owned()))
}

/// Whether `text` holds `<REDACTED:[a-z0-9_]{1,64}:id>` (`pageHoldsSql`'s marker pattern; `id` is an `ss_` id).
pub(crate) fn holds_marker(text: &str, id: &str) -> bool {
    const OPEN: &str = "<REDACTED:";
    let tail = format!(":{id}>");
    let mut from = 0;
    while let Some(found) = text[from..].find(OPEN) {
        let start = from + found + OPEN.len();
        let rest = &text[start..];
        let rule = rest
            .bytes()
            .take_while(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
            .count();
        if (1..=64).contains(&rule) && rest[rule..].starts_with(&tail) {
            return true;
        }
        from += found + 1;
    }
    false
}

/// `pageHoldsSql('p', id)`: whether the page's inline columns, raw data, timeline rows, takes, outgoing link contexts or
/// facts hold the marker of entry `id`.
fn page_holds(read: &dyn KvRead, page: &PageRecord, id: &str) -> Result<bool> {
    let frontmatter = serde_json::to_string(&Value::Object(page.frontmatter.clone()))?;
    let inline = format!(
        "{} {} {} {}",
        page.title,
        page.compiled_truth.as_deref().unwrap_or(""),
        page.timeline.as_deref().unwrap_or(""),
        frontmatter
    );
    if holds_marker(&inline, id) {
        return Ok(true);
    }
    let stores =
        crate::repair_secret_spans::page_stores(read, page.id, &page.source_id, &page.slug)?;
    let hit = |text: String| holds_marker(&text, id);
    let some = |t: &Option<String>| t.clone().unwrap_or_default();
    Ok(stores.raw_data.iter().any(|d| hit(d.to_string()))
        || stores
            .timeline
            .iter()
            .any(|e| hit(format!("{} {} {}", e.summary, e.detail, e.source)))
        || stores.takes.iter().any(|t| {
            hit(format!(
                "{} {} {}",
                t.claim,
                some(&t.source),
                some(&t.resolved_source)
            ))
        })
        || stores.links.iter().any(|l| hit(l.context.clone()))
        || stores.facts.iter().any(|f| {
            hit(format!(
                "{} {} {}",
                f.fact,
                some(&f.context),
                some(&f.value)
            ))
        }))
}

/// Whether a purge of the page `page_id` at (`source_id`, `slug`) would delete a sealed original: an occurrence of the
/// source on no commit, on the page (or on no page at the slug), whose entry has no other occurrence that is on a commit
/// or on a live page (the concept rebuild's stated check, `secret_store_occurrence`).
pub(crate) fn page_holds_last_original(
    read: &dyn KvRead,
    page_id: u64,
    source_id: &str,
    slug: &str,
) -> Result<bool> {
    let ours = |o: &OccurrenceRecord| {
        o.source_id == source_id
            && o.commit_sha.is_none()
            && (o.page_id == Some(page_id)
                || (o.page_id.is_none() && o.slug.as_deref() == Some(slug)))
    };
    let mut candidates: BTreeSet<u64> = BTreeSet::new();
    let page_prefix = by_page_prefix(page_id);
    scan_prefix(read, &page_prefix, false, &mut |k, _| {
        if let Some(id) = keys::be8(&k[page_prefix.len()..]) {
            candidates.insert(id);
        }
        true
    })?;
    if !source_id.contains('\0') && !slug.contains('\0') {
        let slug_prefix = by_slug_prefix(source_id, slug);
        scan_prefix(read, &slug_prefix, false, &mut |k, _| {
            if let Some(id) = keys::be8(&k[slug_prefix.len()..]) {
                candidates.insert(id);
            }
            true
        })?;
    }
    for id in candidates {
        let Some(o) = read_occurrence(read, id)? else {
            continue;
        };
        if !ours(&o) {
            continue;
        }
        let mut kept_elsewhere = false;
        for other in entry_occurrence_ids(read, &o.entry_id)? {
            let Some(k) = read_occurrence(read, other)? else {
                continue;
            };
            if ours(&k) {
                continue;
            }
            let live = match k.page_id {
                Some(page) => {
                    read_page_by_id(read, page)?.is_some_and(|p| p.deleted_at_us.is_none())
                }
                None => match k.slug.as_deref() {
                    Some(s) => crate::pages::read_page(read, &k.source_id, s)?
                        .is_some_and(|p| p.deleted_at_us.is_none()),
                    None => false,
                },
            };
            if k.commit_sha.is_some() || live {
                kept_elsewhere = true;
                break;
            }
        }
        if !kept_elsewhere {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The page-level occurrence ids of page `page_id` (those recorded on the page, not on a commit): what a purge reads
/// before it deletes the page, since the delete clears their `page_id`.
pub(crate) fn page_occurrence_ids(read: &dyn KvRead, page_id: u64) -> Result<Vec<u64>> {
    let prefix = by_page_prefix(page_id);
    let mut ids = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, _| {
        if let Some(id) = keys::be8(&k[prefix.len()..]) {
            ids.push(id);
        }
        true
    })?;
    let mut out = Vec::new();
    for id in ids {
        if read_occurrence(read, id)?.is_some_and(|o| o.commit_sha.is_none()) {
            out.push(id);
        }
    }
    Ok(out)
}

/// `page_id ... ON DELETE SET NULL`: a page deleted for good keeps its occurrences with no page
/// (`cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    let prefix = by_page_prefix(page.id);
    let mut ids = Vec::new();
    scan_prefix(&*tx, &prefix, false, &mut |k, _| {
        if let Some(id) = keys::be8(&k[prefix.len()..]) {
            ids.push(id);
        }
        true
    })?;
    for id in ids {
        tx.delete(&by_page_key(page.id, id))?;
        if let Some(mut o) = read_occurrence(&*tx, id)? {
            o.page_id = None;
            put_json(tx, &occurrence_key(id), &o)?;
        }
    }
    Ok(())
}

/// `source_id ... ON DELETE CASCADE`: a source delete removes the source's entries and their occurrences
/// (`cascade::remove_source_rows`).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    if source_id.contains('\0') {
        return Ok(());
    }
    let prefix = mac_prefix(source_id);
    let mut ids = Vec::new();
    scan_prefix(&*tx, &prefix, false, &mut |_, v| {
        ids.push(String::from_utf8_lossy(v).into_owned());
        true
    })?;
    for id in ids {
        for (occurrence, record) in entry_occurrences(&*tx, &id)? {
            delete_occurrence(tx, occurrence, &record)?;
        }
        if let Some(entry) = read_entry(&*tx, &id)? {
            delete_entry(tx, &entry)?;
        }
    }
    Ok(())
}

/// `moveSlugBindings`' occurrence statement: a page renamed from `old` to `new` takes the occurrences recorded under
/// its old slug, except one another live page owns under that slug and one recorded on a commit
/// (`cascade::rename_slug_rows`, after the page row moved).
pub(crate) fn rename_slug_rows(
    tx: &mut dyn KvWrite,
    source_id: &str,
    old: &str,
    new: &str,
) -> Result<()> {
    if old == new || [source_id, old, new].iter().any(|t| t.contains('\0')) {
        return Ok(());
    }
    let prefix = by_slug_prefix(source_id, old);
    let mut ids = Vec::new();
    scan_prefix(&*tx, &prefix, false, &mut |k, _| {
        if let Some(id) = keys::be8(&k[prefix.len()..]) {
            ids.push(id);
        }
        true
    })?;
    for id in ids {
        let Some(mut o) = read_occurrence(&*tx, id)? else {
            continue;
        };
        if o.commit_sha.is_some() {
            continue;
        }
        let owned = match o.page_id {
            None => true,
            Some(page) => read_page_by_id(&*tx, page)?
                .is_some_and(|p| p.source_id == source_id && (p.slug == old || p.slug == new)),
        };
        if !owned {
            continue;
        }
        tx.delete(&by_slug_key(source_id, old, id))?;
        o.slug = Some(new.to_owned());
        put_occurrence(tx, id, &o)?;
    }
    Ok(())
}

/// The purge cascade (`purgeSecretsForSlugs`): removes the page occurrences of `slugs` in `source_id` that no live page
/// outside the purged set owns, and those named by id in `on_pages`, then every entry they pointed at that no
/// occurrence references. Returns how many occurrences and entries went.
pub(crate) fn purge(
    tx: &mut dyn KvWrite,
    source_id: &str,
    slugs: &[String],
    on_pages: &BTreeSet<u64>,
) -> Result<(u64, u64)> {
    if source_id.contains('\0') {
        return Ok((0, 0));
    }
    let mut candidates: BTreeSet<u64> = on_pages.clone();
    for slug in slugs.iter().filter(|s| !s.contains('\0')) {
        let prefix = by_slug_prefix(source_id, slug);
        scan_prefix(&*tx, &prefix, false, &mut |k, _| {
            if let Some(id) = keys::be8(&k[prefix.len()..]) {
                candidates.insert(id);
            }
            true
        })?;
    }
    let mut gone: Vec<(u64, OccurrenceRecord)> = Vec::new();
    for id in candidates {
        let Some(o) = read_occurrence(&*tx, id)? else {
            continue;
        };
        if o.source_id != source_id || o.commit_sha.is_some() {
            continue;
        }
        let named = on_pages.contains(&id);
        let by_slug = o.slug.as_ref().is_some_and(|s| slugs.contains(s)) && {
            match o.page_id {
                None => true,
                Some(page) => match read_page_by_id(&*tx, page)? {
                    None => true,
                    Some(p) => p.source_id == source_id && slugs.contains(&p.slug),
                },
            }
        };
        if named || by_slug {
            gone.push((id, o));
        }
    }
    if gone.is_empty() {
        return Ok((0, 0));
    }
    let entry_ids: BTreeSet<String> = gone.iter().map(|(_, o)| o.entry_id.clone()).collect();
    for (id, o) in &gone {
        delete_occurrence(tx, *id, o)?;
    }
    let mut entries = 0;
    for id in entry_ids {
        if entry_occurrence_ids(&*tx, &id)?.is_empty()
            && let Some(entry) = read_entry(&*tx, &id)?
        {
            delete_entry(tx, &entry)?;
            entries += 1;
        }
    }
    Ok((gone.len() as u64, entries))
}

/// `deletePages` and `purgeDeletedPages`: the purge for the pages they just removed, run after the pages are gone;
/// `occurrences` are the page-level occurrence ids read before the delete.
pub(crate) fn purge_for_deleted_pages(
    tx: &mut dyn KvWrite,
    source_id: &str,
    slugs: &[String],
    occurrences: &BTreeSet<u64>,
) -> Result<()> {
    purge(tx, source_id, slugs, occurrences).map(|_| ())
}

fn parse_us(what: &str, text: &str) -> Result<i64> {
    parse_iso(text).ok_or_else(|| {
        StoreError::invalid(format!(
            "secret store: {what} {text:?} is not a UTC ISO timestamp"
        ))
    })
}

/// `to_char(.. 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`: UTC ISO text truncated to milliseconds.
fn iso_ms(us: i64) -> String {
    let full = iso(us);
    format!("{}Z", &full[..23])
}

fn id_of(value: i64) -> Option<u64> {
    u64::try_from(value).ok()
}

impl Store {
    /// `findSecretEntryByMac(sourceId, mac)`: the id of the entry that holds this (source, value MAC), or `None`.
    pub fn find_secret_entry_by_mac(&self, source_id: &str, mac: &str) -> Result<Option<String>> {
        let read = self.read()?;
        entry_id_by_mac(&*read, source_id, mac)
    }

    /// `secretEntryExists(id)`.
    pub fn secret_entry_exists(&self, id: &str) -> Result<bool> {
        let read = self.read()?;
        Ok(read_entry(&*read, id)?.is_some())
    }

    /// `insertSecretEntry(row, conflict)`: stores one entry with status `active` stamped now and returns its id, or
    /// `None` when the conflict clause skipped it: `any` skips an id or a (source, value) another entry holds; `value`
    /// skips only a (source, value) another entry holds, and an id clash still refuses (`constraint_violation`). The
    /// CHECK constraints refuse first; an unknown source refuses `source_not_found`, as the foreign key does.
    pub fn insert_secret_entry(
        &self,
        row: &SecretEntryInsert,
        conflict: &str,
    ) -> Result<Option<String>> {
        if conflict != "value" && conflict != "any" {
            return Err(StoreError::invalid(format!(
                "insertSecretEntry: conflict must be value or any, not {conflict:?}"
            )));
        }
        let now = self.env.now_micros();
        let record = EntryRecord {
            id: row.id.clone(),
            source_id: row.source_id.clone(),
            rule: row.rule.clone(),
            ciphertext: row.ciphertext.clone(),
            nonce: row.nonce.clone(),
            tag: row.tag.clone(),
            key_id: row.key_id.clone(),
            key_host: row.key_host.clone(),
            value_mac: row.value_mac.clone(),
            status: "active".to_owned(),
            created_at_us: now,
            updated_at_us: now,
        };
        check_entry(&record)?;
        self.write(|tx| {
            let id_held = read_entry(&*tx, &record.id)?.is_some();
            let mac_held = entry_id_by_mac(&*tx, &record.source_id, &record.value_mac)?.is_some();
            if mac_held || (id_held && conflict == "any") {
                return Ok(None);
            }
            if id_held {
                return Err(violation(
                    "duplicate key value violates unique constraint secret_store_pkey",
                ));
            }
            if read_source(&*tx, &record.source_id)?.is_none() {
                return Err(StoreError::new(
                    SOURCE_NOT_FOUND,
                    format!("secret store: no source '{}'", record.source_id),
                ));
            }
            put_entry(tx, &record)?;
            Ok(Some(record.id.clone()))
        })
    }

    /// `insertSecretOccurrence(o)`: records where a marker was put, stamped now. The entry must exist and a named page
    /// must exist (the foreign keys); the CHECK constraints refuse a bad origin or hash.
    pub fn insert_secret_occurrence(&self, o: &SecretOccurrenceInsert) -> Result<()> {
        let record = OccurrenceRecord {
            entry_id: o.entry_id.clone(),
            source_id: o.source_id.clone(),
            page_id: o.page_id.and_then(id_of),
            slug: o.slug.clone(),
            field: o.field.clone(),
            origin: o.origin.clone(),
            commit_sha: o.commit.clone(),
            path: o.path.clone(),
            line: o.line,
            pre_field_sha256: o.pre_field_sha256.clone(),
            created_by: o.created_by.clone(),
            created_at_us: self.env.now_micros(),
        };
        if o.page_id.is_some() && record.page_id.is_none() {
            return Err(violation("secret_store_occurrence_page_id_fkey"));
        }
        check_occurrence(&record)?;
        self.write(|tx| {
            if read_entry(&*tx, &record.entry_id)?.is_none() {
                return Err(violation("secret_store_occurrence_entry_id_fkey"));
            }
            if let Some(page) = record.page_id
                && read_page_by_id(&*tx, page)?.is_none()
            {
                return Err(violation("secret_store_occurrence_page_id_fkey"));
            }
            let id = tx.allocate(&keys::meta(NEXT_OCCURRENCE_ID), 1)?;
            put_occurrence(tx, id, &record)
        })
    }

    /// `readSecretEntry(id)`: the entry as stored, or `None`.
    pub fn read_secret_entry(&self, id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(read_entry(&*read, id)?.as_ref().map(entry_json))
    }

    /// `listSecretOccurrences(entryId)`: the entry's places, in recording order.
    pub fn list_secret_occurrences(&self, entry_id: &str) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(entry_occurrences(&*read, entry_id)?
            .iter()
            .map(|(_, o)| {
                json!({
                    "page_id": o.page_id, "source_id": o.source_id, "slug": o.slug, "field": o.field, "origin": o.origin,
                    "commit_sha": o.commit_sha, "path": o.path, "line": o.line, "created_at": timestamptz_text(o.created_at_us),
                })
            })
            .collect())
    }

    /// `listSecretEntrySummaries({ sourceId, slug, limit })`: entries of the source (or every source) that occur at the
    /// slug (when given), oldest first then by id, at most `limit`, each with its occurrence count and distinct slugs.
    pub fn list_secret_entry_summaries(
        &self,
        source_id: Option<&str>,
        slug: Option<&str>,
        limit: i64,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut entries = all_entries(&*read)?;
        entries.sort_by(|a, b| (a.created_at_us, &a.id).cmp(&(b.created_at_us, &b.id)));
        let mut out = Vec::new();
        for e in entries {
            if source_id.is_some_and(|s| s != e.source_id) {
                continue;
            }
            let occurrences = entry_occurrences(&*read, &e.id)?;
            if slug.is_some_and(|s| {
                !occurrences
                    .iter()
                    .any(|(_, o)| o.slug.as_deref() == Some(s))
            }) {
                continue;
            }
            let slugs: BTreeSet<&str> = occurrences
                .iter()
                .filter_map(|(_, o)| o.slug.as_deref())
                .collect();
            let mut row = entry_json(&e);
            let Value::Object(map) = &mut row else {
                continue;
            };
            for dropped in ["ciphertext", "nonce", "tag", "value_mac"] {
                map.remove(dropped);
            }
            map.insert("occurrences".into(), json!(occurrences.len()));
            map.insert("slugs".into(), json!(slugs));
            out.push(row);
            if i64::try_from(out.len()).is_ok_and(|n| n >= limit) {
                break;
            }
        }
        Ok(out)
    }

    /// `countSecretsByRule(sourceId)`: entries and occurrences per rule, by rule.
    pub fn count_secrets_by_rule(&self, source_id: Option<&str>) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut by_rule: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        for e in all_entries(&*read)? {
            if source_id.is_some_and(|s| s != e.source_id) {
                continue;
            }
            let count = entry_occurrence_ids(&*read, &e.id)?.len() as u64;
            let slot = by_rule.entry(e.rule.clone()).or_default();
            slot.0 += 1;
            slot.1 += count;
        }
        Ok(by_rule
            .into_iter()
            .map(|(rule, (entries, occurrences))| json!({ "rule": rule, "entries": entries, "occurrences": occurrences }))
            .collect())
    }

    /// `listAllowedSecretMacs(sourceId)`: the key id and MAC of every restored entry of the source, or (no source) of
    /// every source in (key id, MAC) order.
    pub fn list_allowed_secret_macs(&self, source_id: Option<&str>) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows: Vec<(String, String)> = all_entries(&*read)?
            .into_iter()
            .filter(|e| e.status == "allowed" && source_id.is_none_or(|s| s == e.source_id))
            .map(|e| (e.key_id, e.value_mac))
            .collect();
        if source_id.is_none() {
            rows.sort();
        }
        Ok(rows
            .into_iter()
            .map(|(key_id, value_mac)| json!({ "key_id": key_id, "value_mac": value_mac }))
            .collect())
    }

    /// `listSecretKeysInUse()`: entries per (key id, host), by key id then host.
    pub fn list_secret_keys_in_use(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut counts: BTreeMap<(String, String), u64> = BTreeMap::new();
        for e in all_entries(&*read)? {
            *counts.entry((e.key_id, e.key_host)).or_default() += 1;
        }
        Ok(counts
            .into_iter()
            .map(|((key_id, key_host), entries)| json!({ "key_id": key_id, "key_host": key_host, "entries": entries }))
            .collect())
    }

    /// `readSecretStoreSnapshot()`: every entry and occurrence from one snapshot. A place on a page carries the slug of
    /// the page its `page_id` names now (of the same source), a place on a commit its own slug.
    pub fn read_secret_store_snapshot(&self) -> Result<Value> {
        let read = self.read()?;
        let entries: Vec<Value> = all_entries(&*read)?
            .iter()
            .map(|e| {
                json!({
                    "id": e.id, "source_id": e.source_id, "rule": e.rule, "ciphertext": e.ciphertext, "nonce": e.nonce,
                    "tag": e.tag, "key_id": e.key_id, "key_host": e.key_host, "value_mac": e.value_mac, "status": e.status,
                    "created_at": iso_ms(e.created_at_us), "updated_at": iso_ms(e.updated_at_us),
                })
            })
            .collect();
        let mut raw = Vec::new();
        scan_prefix(
            &*read,
            &[keys::SECRET_STORE, OCCURRENCE],
            false,
            &mut |k, v| {
                raw.push((k.to_vec(), v.to_vec()));
                true
            },
        )?;
        let mut occurrences = Vec::new();
        for (_, value) in raw {
            let o: OccurrenceRecord = serde_json::from_slice(&value)?;
            let slug = if o.commit_sha.is_none() {
                let joined = match o.page_id {
                    Some(page) => read_page_by_id(&*read, page)?
                        .filter(|p| p.source_id == o.source_id)
                        .map(|p| p.slug),
                    None => None,
                };
                joined.or_else(|| o.slug.clone())
            } else {
                o.slug.clone()
            };
            occurrences.push(json!({
                "entry_id": o.entry_id, "source_id": o.source_id, "page_id": o.page_id, "slug": slug, "field": o.field,
                "origin": o.origin, "commit_sha": o.commit_sha, "path": o.path, "line": o.line,
                "pre_field_sha256": o.pre_field_sha256, "created_by": o.created_by, "created_at": iso_ms(o.created_at_us),
            }));
        }
        Ok(json!({ "entries": entries, "occurrences": occurrences }))
    }

    /// `insertBackupSecretEntry(row)`: stores a backed-up entry with its status and timestamps unless the id or the
    /// (source, value) is held, and only for a source this brain has; true when it did.
    pub fn insert_backup_secret_entry(&self, row: &BackupEntry) -> Result<bool> {
        let record = EntryRecord {
            id: row.id.clone(),
            source_id: row.source_id.clone(),
            rule: row.rule.clone(),
            ciphertext: row.ciphertext.clone(),
            nonce: row.nonce.clone(),
            tag: row.tag.clone(),
            key_id: row.key_id.clone(),
            key_host: row.key_host.clone(),
            value_mac: row.value_mac.clone(),
            status: row.status.clone(),
            created_at_us: parse_us("created_at", &row.created_at)?,
            updated_at_us: parse_us("updated_at", &row.updated_at)?,
        };
        check_entry(&record)?;
        self.write(|tx| {
            if read_source(&*tx, &record.source_id)?.is_none()
                || read_entry(&*tx, &record.id)?.is_some()
                || entry_id_by_mac(&*tx, &record.source_id, &record.value_mac)?.is_some()
            {
                return Ok(false);
            }
            put_entry(tx, &record)?;
            Ok(true)
        })
    }

    /// `readBackupEntryHold(id, sourceId, mac)`: whether the entry under `id` holds this (source, value MAC); `None`
    /// when no entry has the id.
    pub fn read_backup_entry_hold(
        &self,
        id: &str,
        source_id: &str,
        mac: &str,
    ) -> Result<Option<bool>> {
        let read = self.read()?;
        Ok(read_entry(&*read, id)?.map(|e| e.source_id == source_id && e.value_mac == mac))
    }

    /// `insertBackupSecretOccurrence(o, pageId)`: stores a backed-up occurrence once. Its page is the one holding
    /// `page_id` or, with none, the page at its slug; a page place (no commit, a slug) needs `page_id` to name a page of
    /// the source at that slug; a row equal to the millisecond is not written twice. True when written.
    pub fn insert_backup_secret_occurrence(
        &self,
        o: &BackupOccurrence,
        page_id: Option<i64>,
    ) -> Result<bool> {
        let created = parse_us("created_at", &o.created_at)?;
        let given = page_id.and_then(id_of);
        let check = OccurrenceRecord {
            entry_id: o.entry_id.clone(),
            source_id: o.source_id.clone(),
            page_id: None,
            slug: o.slug.clone(),
            field: o.field.clone(),
            origin: o.origin.clone(),
            commit_sha: o.commit_sha.clone(),
            path: o.path.clone(),
            line: o.line,
            pre_field_sha256: o.pre_field_sha256.clone(),
            created_by: o.created_by.clone(),
            created_at_us: created,
        };
        check_occurrence(&check)?;
        self.write(|tx| {
            let holds_slug = match given {
                Some(page) => read_page_by_id(&*tx, page)?.is_some_and(|p| {
                    Some(&p.slug) == o.slug.as_ref() && p.source_id == o.source_id
                }),
                None => false,
            };
            if !(o.commit_sha.is_some() || o.slug.is_none() || holds_slug) {
                return Ok(false);
            }
            let page = match (given, &o.slug) {
                (Some(page), _) => Some(page),
                (None, Some(slug)) => read_page(&*tx, &o.source_id, slug)?.map(|p| p.id),
                (None, None) => None,
            };
            let duplicate = entry_occurrences(&*tx, &o.entry_id)?.iter().any(|(_, x)| {
                x.source_id == o.source_id
                    && x.slug == o.slug
                    && x.field == o.field
                    && x.commit_sha == o.commit_sha
                    && x.path == o.path
                    && x.line == o.line
                    && x.origin == o.origin
                    && x.pre_field_sha256 == o.pre_field_sha256
                    && x.created_by == o.created_by
                    && x.created_at_us - x.created_at_us.rem_euclid(1000) == created
            });
            if duplicate {
                return Ok(false);
            }
            if read_entry(&*tx, &o.entry_id)?.is_none() {
                return Err(violation("secret_store_occurrence_entry_id_fkey"));
            }
            let id = tx.allocate(&keys::meta(NEXT_OCCURRENCE_ID), 1)?;
            put_occurrence(
                tx,
                id,
                &OccurrenceRecord {
                    page_id: page,
                    ..check.clone()
                },
            )?;
            Ok(true)
        })
    }

    /// `deleteUnreferencedSecretEntry(id)`: deletes the entry when no occurrence references it; true when it did.
    pub fn delete_unreferenced_secret_entry(&self, id: &str) -> Result<bool> {
        self.write(|tx| {
            let Some(entry) = read_entry(&*tx, id)? else {
                return Ok(false);
            };
            if !entry_occurrence_ids(&*tx, id)?.is_empty() {
                return Ok(false);
            }
            delete_entry(tx, &entry)?;
            Ok(true)
        })
    }

    /// `listSecretHoldingPages(sourceId, slugs, id)`: each page of the source at one of these slugs, a tombstone
    /// included, with whether it is stored in segments and whether its inline stores hold entry `id`'s marker. In slug
    /// order.
    pub fn list_secret_holding_pages(
        &self,
        source_id: &str,
        slugs: &[String],
        id: &str,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut wanted: Vec<&String> = slugs.iter().collect();
        wanted.sort();
        wanted.dedup();
        let mut out = Vec::new();
        for slug in wanted {
            let Some(page) = read_page(&*read, source_id, slug)? else {
                continue;
            };
            let segmented = crate::page_body::read_body_state(&*read, page.id)?
                .is_some_and(|s| s.body_storage == "segmented");
            out.push(json!({
                "id": page.id, "slug": page.slug, "segmented": segmented, "holds": page_holds(&*read, &page, id)?,
            }));
        }
        Ok(out)
    }

    /// `countUnreferencedSecretEntries()`.
    pub fn count_unreferenced_secret_entries(&self) -> Result<u64> {
        let read = self.read()?;
        let mut n = 0;
        for e in all_entries(&*read)? {
            if entry_occurrence_ids(&*read, &e.id)?.is_empty() {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `readRestorePageHit(sourceId, slug, marker)`: the live page's revision and whether its title, body, timeline or
    /// frontmatter holds `marker` (a segmented page counts as a hit); `None` without a live page.
    pub fn read_restore_page_hit(
        &self,
        source_id: &str,
        slug: &str,
        marker: &str,
    ) -> Result<Option<Value>> {
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(None);
        };
        let segmented = crate::page_body::read_body_state(&*read, page.id)?
            .is_some_and(|s| s.body_storage == "segmented");
        let frontmatter = serde_json::to_string(&Value::Object(page.frontmatter.clone()))?;
        let text = format!(
            "{}{}{}{}",
            page.title,
            page.compiled_truth.as_deref().unwrap_or(""),
            page.timeline.as_deref().unwrap_or(""),
            frontmatter
        );
        Ok(Some(json!({
            "revision": page.knowledge_revision,
            "hit": segmented || text.contains(marker),
        })))
    }

    /// `markSecretEntryAllowed(id)`: the entry becomes `allowed` and is stamped updated now; an unknown id changes
    /// nothing.
    pub fn mark_secret_entry_allowed(&self, id: &str) -> Result<()> {
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut entry) = read_entry(&*tx, id)? else {
                return Ok(());
            };
            entry.status = "allowed".to_owned();
            entry.updated_at_us = now;
            put_json(tx, &entry_key(id), &entry)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "ss_0123456789ab";

    #[test]
    fn a_marker_is_the_pattern_page_holds_sql_matches_and_no_other() {
        let marker = |rule: &str, id: &str| format!("<REDACTED:{rule}:{id}>");
        assert!(holds_marker(&marker("github_token", ID), ID));
        assert!(holds_marker(&format!("a {} b", marker("a", ID)), ID));
        // A rule is 1 to 64 of [a-z0-9_], and a rule that is not one starts no marker.
        assert!(holds_marker(&marker(&"a".repeat(64), ID), ID));
        assert!(!holds_marker(&marker(&"a".repeat(65), ID), ID));
        assert!(!holds_marker(&marker("", ID), ID));
        assert!(!holds_marker(&marker("Upper", ID), ID));
        // Another entry's id, a prefix of the id, and a plain marker with no id do not match.
        assert!(!holds_marker(&marker("r", "ss_ba9876543210"), ID));
        assert!(!holds_marker(&marker("r", &format!("{ID}0")), ID));
        assert!(!holds_marker("<REDACTED:github_token>", ID));
        // The first `<REDACTED:` that does not match does not hide a later one.
        assert!(holds_marker(
            &format!("<REDACTED:bad id> {}", marker("r", ID)),
            ID
        ));
        assert!(holds_marker(&format!("<REDACTED:<REDACTED:x:{ID}>"), ID));
        assert!(!holds_marker("", ID));
    }

    #[test]
    fn the_snapshot_clock_is_utc_iso_truncated_to_milliseconds() {
        assert_eq!(iso_ms(1_763_500_000_123_999), "2025-11-18T21:06:40.123Z");
        assert_eq!(iso_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            parse_us("t", &iso_ms(1_763_500_000_123_999)).unwrap(),
            1_763_500_000_123_000
        );
        assert!(parse_us("t", "nope").is_err());
    }
}
