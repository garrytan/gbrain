//! Wanted links: link references whose target page does not exist yet (src/core/wanted-links.ts).
//! PGLite and Postgres keep them in the `wanted_links` table and run the SQL in
//! `src/core/engine-sql/wanted-links.ts` and `src/core/wanted-links-store.ts`; these answer the same
//! members from the store's records (rust/docs/store/wanted-links.md).
//!
//! Members: lockRegisteredSourceIds, replaceWantedLinkRows, and the store read of
//! listWantedPages (lane 2 wires its BrainEngine member).
//!
//! Keys: the family's records sit under the link_queries tag, so a source delete through
//! `link_queries::remove_source_rows` (every key under `q <source> \0`) removes them:
//!
//! ```text
//! q <origin source_id> \0 W <origin page id BE8> <producer> \0 <ref_kind> \0 <target_source_id> \0 <target_ref>
//! ```
//!
//! The value is a JSON `WantedRecord`. `M wanted_link_id` is the id counter. A hard page delete
//! removes the page's records through `cascade::remove_page_rows`, which calls `remove_page_rows`
//! (Postgres `wanted_links.origin_page_id` is `ON DELETE CASCADE`).

use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, all_pages, next_id, read_page, read_page_by_id};
use crate::sources::read_source;
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// The sub-tag after `q <source> \0` that marks a wanted-link record.
const WANTED: u8 = b'W';
pub(crate) const ID_COUNTER: &str = "wanted_link_id";
const PRODUCERS: [&str; 2] = ["body", "frontmatter"];
const REF_KINDS: [&str; 2] = ["slug", "name"];

/// What is stored for one wanted link (one `wanted_links` row).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct WantedRecord {
    pub id: u64,
    pub origin_page_id: u64,
    pub source_id: String,
    pub producer: String,
    pub ref_kind: String,
    pub target_source_id: String,
    pub target_ref: String,
    pub link_type: String,
    pub context: String,
    /// `None` is `-infinity`: the slug target was a live page when the row was written.
    pub checked_at_us: Option<i64>,
    pub first_seen_at_us: i64,
}

/// One row of `replaceWantedLinkRows` (`WantedLinkRowInput` of `src/core/engine.ts`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct WantedLinkRowInput {
    pub producer: String,
    pub ref_kind: String,
    pub target_source_id: String,
    pub target_ref: String,
    pub link_type: String,
    pub context: String,
}

/// The origin argument of `replaceWantedLinkRows`: `{ pageId, sourceId }`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WantedLinkOrigin {
    pub page_id: u64,
    pub source_id: String,
}

/// `WantedLinkRowsReplacement`: the rows of `producers`, with `readAt` stamped on every name row.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WantedLinkRowsReplacement {
    pub rows: Vec<WantedLinkRowInput>,
    pub producers: Vec<String>,
    pub read_at: Option<String>,
}

/// The options of `listWantedPages`. `excludePrivate` carries the page policy
/// (`privatePagesFilterForCaller`) the origins and the name matches are judged by.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WantedPagesQuery {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub exclude_private: Option<crate::facts::PrivacyPolicy>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// A page reference in a wanted row.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct WantedPageRef {
    pub slug: String,
    pub source_id: String,
}

/// One missing target, as `listWantedPages` returns it (`WantedPageRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WantedPageRow {
    pub target: String,
    pub target_source_id: String,
    pub ref_kind: String,
    pub referenced_by: u64,
    pub sample_origins: Vec<WantedPageRef>,
    pub link_types: Vec<String>,
    pub existing_matches: Vec<WantedPageRef>,
    /// Millisecond ISO, as `Date#toISOString` gives it.
    pub first_seen: String,
    /// Millisecond ISO, or `pending` when every row of the target is still `-infinity`.
    pub last_checked: String,
}

/// `listWantedPages`: the page of rows and the number of targets.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WantedPages {
    pub total: u64,
    pub rows: Vec<WantedPageRow>,
}

fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut key = vec![keys::LINK_QUERIES];
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key
}

fn page_prefix(source_id: &str, page_id: u64) -> Vec<u8> {
    let mut key = source_prefix(source_id);
    key.push(WANTED);
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

fn row_key(source_id: &str, page_id: u64, row: &WantedLinkRowInput) -> Vec<u8> {
    let mut key = page_prefix(source_id, page_id);
    for (i, part) in [
        &row.producer,
        &row.ref_kind,
        &row.target_source_id,
        &row.target_ref,
    ]
    .into_iter()
    .enumerate()
    {
        if i > 0 {
            key.push(0);
        }
        key.extend_from_slice(part.as_bytes());
    }
    key
}

fn constraint(message: impl Into<String>) -> StoreError {
    StoreError::new(CONSTRAINT_VIOLATION, message)
}

/// Every wanted record of one origin page.
fn page_records(
    read: &dyn KvRead,
    source_id: &str,
    page_id: u64,
) -> Result<Vec<(Vec<u8>, WantedRecord)>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(
        read,
        &page_prefix(source_id, page_id),
        false,
        &mut |k, v| {
            match serde_json::from_slice(v) {
                Ok(record) => out.push((k.to_vec(), record)),
                Err(e) => failure = Some(e),
            }
            failure.is_none()
        },
    )?;
    match failure {
        Some(e) => Err(e.into()),
        None => Ok(out),
    }
}

/// Every wanted record in the store.
pub(crate) fn all_records(read: &dyn KvRead) -> Result<Vec<WantedRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::LINK_QUERIES], false, &mut |k, v| {
        let Some(nul) = k.iter().skip(1).position(|b| *b == 0) else {
            return true;
        };
        if k.get(nul + 2) != Some(&WANTED) {
            return true;
        }
        match serde_json::from_slice(v) {
            Ok(record) => out.push(record),
            Err(e) => failure = Some(e),
        }
        failure.is_none()
    })?;
    match failure {
        Some(e) => Err(e.into()),
        None => Ok(out),
    }
}

fn live_page(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Option<PageRecord>> {
    Ok(read_page(read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none()))
}

fn basename(slug: &str) -> &str {
    slug.rsplit('/').next().unwrap_or(slug)
}

fn iso_ms(micros: i64) -> String {
    let full = iso(micros);
    format!("{}Z", &full[..full.len() - 4])
}

/// Deletes the wanted records of a page that is hard-deleted (`cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    for (key, _) in page_records(&*tx, &page.source_id, page.id)? {
        tx.delete(&key)?;
    }
    Ok(())
}

/// Deletes the wanted records whose origin is in a source that is deleted. The link_queries
/// family's `remove_source_rows` deletes these keys with the rest of `q <source> \0`; this is for
/// a caller that removes only this family's records.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut prefix = source_prefix(source_id);
    prefix.push(WANTED);
    let mut doomed = Vec::new();
    scan_prefix(&*tx, &prefix, false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    for key in doomed {
        tx.delete(&key)?;
    }
    Ok(())
}

/// The origin page ids whose wanted target now exists and changed after the origin last resolved
/// it: the store's answer to `wantedOriginIsStale` in `src/core/engine-sql/pages.ts`, for the
/// family that serves stale extraction. `producers` limits the rows to those producers.
pub(crate) fn stale_origin_page_ids(
    read: &dyn KvRead,
    producers: Option<&[String]>,
) -> Result<BTreeSet<u64>> {
    let records: Vec<WantedRecord> = all_records(read)?
        .into_iter()
        .filter(|r| producers.is_none_or(|p| p.contains(&r.producer)))
        .collect();
    let mut out = BTreeSet::new();
    if records.is_empty() {
        return Ok(out);
    }
    let newer = |page: &PageRecord, record: &WantedRecord| {
        record
            .checked_at_us
            .is_none_or(|checked| page.updated_at_us > checked)
    };
    let names: Vec<&WantedRecord> = records.iter().filter(|r| r.ref_kind == "name").collect();
    let live_by_basename: BTreeMap<(String, String), Vec<PageRecord>> = if names.is_empty() {
        BTreeMap::new()
    } else {
        let mut map: BTreeMap<(String, String), Vec<PageRecord>> = BTreeMap::new();
        for page in all_pages(read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none())
        {
            map.entry((page.source_id.clone(), basename(&page.slug).to_string()))
                .or_default()
                .push(page);
        }
        map
    };
    for record in &records {
        if let Some(page) = live_page(read, &record.target_source_id, &record.target_ref)?
            && newer(&page, record)
        {
            out.insert(record.origin_page_id);
            continue;
        }
        if record.ref_kind == "name"
            && live_by_basename
                .get(&(record.target_source_id.clone(), record.target_ref.clone()))
                .is_some_and(|pages| pages.iter().any(|p| newer(p, record)))
        {
            out.insert(record.origin_page_id);
        }
    }
    Ok(out)
}

/// The shadow seed (`seed.rs`): stores `record`, a wanted link copied from another engine with its
/// own id, `checked_at` and `first_seen_at`, under the row key `replace_rows_in` writes. `false`
/// when the key already holds that id; the key held by another id is the
/// `wanted_links_reference_unique` violation. The caller checked the origin page and the source.
pub(crate) fn seed_wanted(tx: &mut dyn KvWrite, record: &WantedRecord) -> Result<bool> {
    if !PRODUCERS.contains(&record.producer.as_str())
        || !REF_KINDS.contains(&record.ref_kind.as_str())
    {
        return Err(constraint(format!(
            "new row for relation \"wanted_links\" violates a check constraint: producer {:?}, ref_kind {:?}",
            record.producer, record.ref_kind
        )));
    }
    let key = row_key(
        &record.source_id,
        record.origin_page_id,
        &WantedLinkRowInput {
            producer: record.producer.clone(),
            ref_kind: record.ref_kind.clone(),
            target_source_id: record.target_source_id.clone(),
            target_ref: record.target_ref.clone(),
            ..Default::default()
        },
    );
    if let Some(bytes) = tx.get(&key)? {
        let stored: WantedRecord = serde_json::from_slice(&bytes)?;
        if stored.id == record.id {
            return Ok(false);
        }
        return Err(constraint(
            "duplicate key value violates unique constraint \"wanted_links_reference_unique\"",
        ));
    }
    put_json(tx, &key, record)?;
    Ok(true)
}

/// Replaces one origin's wanted rows for `replacement.producers` inside the caller's write: the
/// statements of `replaceWantedLinkRows`. Returns the number of rows written.
pub(crate) fn replace_rows_in(
    tx: &mut dyn KvWrite,
    now_us: i64,
    origin_page_id: u64,
    origin_source_id: &str,
    replacement: &WantedLinkRowsReplacement,
) -> Result<u64> {
    if replacement.producers.is_empty() {
        return Ok(0);
    }
    for row in &replacement.rows {
        for (name, text) in [
            ("producer", &row.producer),
            ("ref_kind", &row.ref_kind),
            ("target_source_id", &row.target_source_id),
            ("target_ref", &row.target_ref),
            ("link_type", &row.link_type),
            ("context", &row.context),
        ] {
            if text.contains('\0') {
                return Err(StoreError::new(
                    INVALID_ARGUMENT,
                    format!("replaceWantedLinkRows: {name} must not contain a NUL byte"),
                ));
            }
        }
        if !PRODUCERS.contains(&row.producer.as_str()) {
            return Err(constraint(format!(
                "replaceWantedLinkRows: producer must be body or frontmatter, not {:?}",
                row.producer
            )));
        }
        if !REF_KINDS.contains(&row.ref_kind.as_str()) {
            return Err(constraint(format!(
                "replaceWantedLinkRows: ref_kind must be slug or name, not {:?}",
                row.ref_kind
            )));
        }
    }
    let page = read_page_by_id(&*tx, origin_page_id)?.ok_or_else(|| {
        constraint(format!(
            "replaceWantedLinkRows: origin page {origin_page_id} does not exist"
        ))
    })?;
    if page.source_id != origin_source_id {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!(
                "replaceWantedLinkRows: origin page {origin_page_id} is in source {}, not {origin_source_id}",
                page.source_id
            ),
        ));
    }
    if read_source(&*tx, origin_source_id)?.is_none() {
        return Err(constraint(format!(
            "replaceWantedLinkRows: source {origin_source_id} does not exist"
        )));
    }
    let mut keyed = BTreeMap::new();
    for row in &replacement.rows {
        let key = row_key(origin_source_id, origin_page_id, row);
        if keyed.insert(key, row).is_some() {
            return Err(constraint(
                "replaceWantedLinkRows: two rows name the same reference (ON CONFLICT DO UPDATE cannot affect a row a second time)",
            ));
        }
    }
    let read_at = match &replacement.read_at {
        Some(text) => Some(parse_iso(text).ok_or_else(|| {
            StoreError::new(
                INVALID_ARGUMENT,
                "replaceWantedLinkRows: readAt must be an ISO timestamp ending in Z",
            )
        })?),
        None => None,
    };
    let existing = page_records(&*tx, origin_source_id, origin_page_id)?;
    for (key, record) in &existing {
        if replacement.producers.contains(&record.producer) && !keyed.contains_key(key) {
            tx.delete(key)?;
        }
    }
    let existing: BTreeMap<Vec<u8>, WantedRecord> = existing.into_iter().collect();
    for (key, row) in &keyed {
        let checked_at_us = if row.ref_kind == "slug"
            && live_page(&*tx, &row.target_source_id, &row.target_ref)?.is_some()
        {
            None
        } else if row.ref_kind == "name" {
            Some(read_at.ok_or_else(|| {
                constraint(
                    "replaceWantedLinkRows: a name row needs readAt (checked_at is NOT NULL)",
                )
            })?)
        } else {
            Some(now_us)
        };
        let (id, first_seen_at_us) = match existing.get(key) {
            Some(old) => (old.id, old.first_seen_at_us),
            None => (next_id(tx, ID_COUNTER)?, now_us),
        };
        let record = WantedRecord {
            id,
            origin_page_id,
            source_id: origin_source_id.to_string(),
            producer: row.producer.clone(),
            ref_kind: row.ref_kind.clone(),
            target_source_id: row.target_source_id.clone(),
            target_ref: row.target_ref.clone(),
            link_type: row.link_type.clone(),
            context: row.context.clone(),
            checked_at_us,
            first_seen_at_us,
        };
        put_json(tx, key, &record)?;
    }
    Ok(keyed.len() as u64)
}

impl Store {
    /// `lockRegisteredSourceIds(sourceIds)`: the registered ids among `sourceIds`, sorted, once
    /// each. The store's write is already exclusive, so nothing is locked.
    pub fn lock_registered_source_ids(&self, source_ids: &[String]) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut out = BTreeSet::new();
        for id in source_ids {
            if !id.contains('\0') && read_source(&*read, id)?.is_some() {
                out.insert(id.clone());
            }
        }
        Ok(out.into_iter().collect())
    }

    /// `replaceWantedLinkRows(origin, replacement)`: rows of `producers` that `rows` does not name
    /// are deleted; every row of `rows` is written, keeping its id and first_seen. Returns the
    /// number of rows written.
    ///
    /// Errors: `constraint_violation` for a missing origin page or source, a producer or ref kind
    /// outside the schema's CHECK, two rows with the same reference, or a name row with no
    /// `readAt`; `invalid_argument` for NUL text, a bad `readAt` or an origin page in another
    /// source.
    pub fn replace_wanted_link_rows(
        &self,
        origin_page_id: u64,
        origin_source_id: &str,
        replacement: &WantedLinkRowsReplacement,
    ) -> Result<u64> {
        let now = self.env.now_micros();
        self.write(|tx| replace_rows_in(tx, now, origin_page_id, origin_source_id, replacement))
    }

    /// The store read of `listWantedPages`: missing targets, most-referenced first. Only live
    /// origins count, a target that is a live page is left out, and scope applies to the origin.
    /// Under `excludePrivate`, an origin the page policy hides does not count and a hidden page is
    /// no name match; a hidden live page still keeps its slug out of the targets, as in the SQL.
    pub fn list_wanted_pages(&self, query: &WantedPagesQuery) -> Result<WantedPages> {
        let read = self.read()?;
        let hidden = |page: &PageRecord| -> Result<bool> {
            match &query.exclude_private {
                Some(policy) => crate::facts::page_hidden(&*read, page, policy),
                None => Ok(false),
            }
        };
        let scope: Option<BTreeSet<&str>> = match (&query.source_ids, &query.source_id) {
            (Some(ids), _) if !ids.is_empty() => Some(ids.iter().map(String::as_str).collect()),
            (_, Some(id)) if !id.is_empty() => Some(BTreeSet::from([id.as_str()])),
            _ => None,
        };
        struct Group {
            ref_kind: String,
            origins: BTreeSet<WantedPageRef>,
            link_types: BTreeSet<String>,
            first_seen: i64,
            last_checked: Option<i64>,
        }
        let mut groups: BTreeMap<(String, String), Group> = BTreeMap::new();
        let mut origins: BTreeMap<u64, Option<PageRecord>> = BTreeMap::new();
        for record in all_records(&*read)? {
            let origin = match origins.get(&record.origin_page_id) {
                Some(found) => found.clone(),
                None => {
                    let found = match read_page_by_id(&*read, record.origin_page_id)?
                        .filter(|p| p.deleted_at_us.is_none())
                    {
                        Some(page) if hidden(&page)? => None,
                        found => found,
                    };
                    origins.insert(record.origin_page_id, found.clone());
                    found
                }
            };
            let Some(origin) = origin else { continue };
            if scope
                .as_ref()
                .is_some_and(|s| !s.contains(origin.source_id.as_str()))
            {
                continue;
            }
            if live_page(&*read, &record.target_source_id, &record.target_ref)?.is_some() {
                continue;
            }
            let group = groups
                .entry((record.target_source_id.clone(), record.target_ref.clone()))
                .or_insert_with(|| Group {
                    ref_kind: record.ref_kind.clone(),
                    origins: BTreeSet::new(),
                    link_types: BTreeSet::new(),
                    first_seen: record.first_seen_at_us,
                    last_checked: record.checked_at_us,
                });
            if record.ref_kind < group.ref_kind {
                group.ref_kind = record.ref_kind.clone();
            }
            group.origins.insert(WantedPageRef {
                slug: origin.slug.clone(),
                source_id: origin.source_id.clone(),
            });
            if !record.link_type.is_empty() {
                group.link_types.insert(record.link_type.clone());
            }
            group.first_seen = group.first_seen.min(record.first_seen_at_us);
            group.last_checked = group.last_checked.max(record.checked_at_us);
        }
        let total = groups.len() as u64;
        let mut ordered: Vec<((String, String), Group)> = groups.into_iter().collect();
        ordered.sort_by(|(ka, a), (kb, b)| {
            b.origins
                .len()
                .cmp(&a.origins.len())
                .then_with(|| ka.cmp(kb))
        });
        let offset = query.offset.unwrap_or(0).max(0) as usize;
        let limit = query.limit.map_or(usize::MAX, |l| l.max(0) as usize);
        let page: Vec<_> = ordered.into_iter().skip(offset).take(limit).collect();
        let needs_matches = page.iter().any(|(_, g)| g.ref_kind == "name");
        let live = if needs_matches {
            all_pages(&*read)?
                .into_iter()
                .filter(|p| p.deleted_at_us.is_none())
                .collect()
        } else {
            Vec::new()
        };
        let mut rows = Vec::with_capacity(page.len());
        for ((target_source_id, target), group) in page {
            let mut existing_matches = Vec::new();
            if group.ref_kind == "name" {
                let mut found: Vec<&PageRecord> = live
                    .iter()
                    .filter(|p| p.source_id == target_source_id && basename(&p.slug) == target)
                    .collect();
                found.sort_by(|a, b| a.slug.cmp(&b.slug));
                for p in found {
                    if existing_matches.len() == 3 {
                        break;
                    }
                    if !hidden(p)? {
                        existing_matches.push(WantedPageRef {
                            slug: p.slug.clone(),
                            source_id: p.source_id.clone(),
                        });
                    }
                }
            }
            let mut sample: Vec<WantedPageRef> = group.origins.iter().cloned().collect();
            sample.sort_by(|a, b| {
                a.slug
                    .cmp(&b.slug)
                    .then_with(|| a.source_id.cmp(&b.source_id))
            });
            sample.truncate(3);
            rows.push(WantedPageRow {
                referenced_by: group.origins.len() as u64,
                target,
                target_source_id,
                ref_kind: group.ref_kind,
                sample_origins: sample,
                link_types: group.link_types.into_iter().collect(),
                existing_matches,
                first_seen: iso_ms(group.first_seen),
                last_checked: group
                    .last_checked
                    .map_or_else(|| "pending".to_string(), iso_ms),
            });
        }
        Ok(WantedPages { total, rows })
    }
}

/// The shadow follow (`seed/follow.rs`): removes the wanted record `id` of the origin page. `false`
/// when there is none.
pub(crate) fn remove_wanted(
    tx: &mut dyn KvWrite,
    source_id: &str,
    origin_page_id: u64,
    id: u64,
) -> Result<bool> {
    let Some((key, _)) = page_records(&*tx, source_id, origin_page_id)?
        .into_iter()
        .find(|(_, r)| r.id == id)
    else {
        return Ok(false);
    };
    tx.delete(&key)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::sources::SourceInput;
    use crate::{OpenOptions, Store};
    use serde_json::json;
    use std::path::PathBuf;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open(name: &str) -> (Dir, Store) {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/unit-tmp")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open_dir(&dir.join("brain"), OpenOptions::default()).unwrap();
        (Dir(dir), store)
    }

    fn page(store: &Store, source: &str, slug: &str) -> u64 {
        let input: PageInput =
            serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "x"}))
                .unwrap();
        let options: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
        let out = store.put_page(slug, &input, &options).unwrap();
        out["id"].as_u64().unwrap()
    }

    fn source(store: &Store, id: &str) {
        let input: SourceInput = serde_json::from_value(json!({"id": id})).unwrap();
        store.upsert_source(&input).unwrap();
    }

    fn replacement(rows: serde_json::Value, producers: &[&str]) -> WantedLinkRowsReplacement {
        serde_json::from_value(json!({
            "rows": rows, "producers": producers, "readAt": "2026-01-02T03:04:05.678Z"
        }))
        .unwrap()
    }

    fn row(producer: &str, kind: &str, target: &str) -> serde_json::Value {
        json!({"producer": producer, "ref_kind": kind, "target_source_id": "default",
            "target_ref": target, "link_type": "", "context": ""})
    }

    fn raw_rows(store: &Store, source: &str, page_id: u64) -> usize {
        page_records(&*store.read().unwrap(), source, page_id)
            .unwrap()
            .len()
    }

    #[test]
    fn replace_keeps_first_seen_and_deletes_only_named_producers() {
        let (_d, store) = open("wl-replace");
        let origin = page(&store, "default", "notes/a");
        let first = replacement(
            json!([
                row("body", "slug", "missing/x"),
                row("frontmatter", "name", "Ghost")
            ]),
            &["body", "frontmatter"],
        );
        assert_eq!(
            store
                .replace_wanted_link_rows(origin, "default", &first)
                .unwrap(),
            2
        );
        let before = store
            .list_wanted_pages(&WantedPagesQuery::default())
            .unwrap();
        let body_only = replacement(json!([]), &["body"]);
        assert_eq!(
            store
                .replace_wanted_link_rows(origin, "default", &body_only)
                .unwrap(),
            0
        );
        let after = store
            .list_wanted_pages(&WantedPagesQuery::default())
            .unwrap();
        assert_eq!(after.total, 1);
        assert_eq!(after.rows[0].target, "Ghost");
        assert_eq!(after.rows[0].last_checked, "2026-01-02T03:04:05.678Z");
        let ghost = before.rows.iter().find(|r| r.target == "Ghost").unwrap();
        assert_eq!(after.rows[0].first_seen, ghost.first_seen);
    }

    #[test]
    fn replace_refuses_duplicates_and_missing_origins() {
        let (_d, store) = open("wl-refuse");
        let origin = page(&store, "default", "notes/a");
        let dup = replacement(
            json!([row("body", "slug", "x"), row("body", "slug", "x")]),
            &["body"],
        );
        let err = store
            .replace_wanted_link_rows(origin, "default", &dup)
            .unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION);
        let one = replacement(json!([row("body", "slug", "x")]), &["body"]);
        let err = store
            .replace_wanted_link_rows(origin + 99, "default", &one)
            .unwrap_err();
        assert_eq!(err.code, CONSTRAINT_VIOLATION);
        assert_eq!(raw_rows(&store, "default", origin), 0);
    }

    #[test]
    fn live_slug_target_is_pending_and_hidden_until_deleted() {
        let (_d, store) = open("wl-pending");
        let origin = page(&store, "default", "notes/a");
        page(&store, "default", "notes/b");
        let rows = replacement(json!([row("body", "slug", "notes/b")]), &["body"]);
        store
            .replace_wanted_link_rows(origin, "default", &rows)
            .unwrap();
        assert_eq!(
            store
                .list_wanted_pages(&WantedPagesQuery::default())
                .unwrap()
                .total,
            0
        );
        store.delete_page("notes/b", None).unwrap();
        let listed = store
            .list_wanted_pages(&WantedPagesQuery::default())
            .unwrap();
        assert_eq!(listed.rows[0].last_checked, "pending");
    }

    #[test]
    fn page_hard_delete_removes_its_wanted_rows() {
        let (_d, store) = open("wl-page-delete");
        let origin = page(&store, "default", "notes/a");
        let rows = replacement(json!([row("body", "slug", "missing/x")]), &["body"]);
        store
            .replace_wanted_link_rows(origin, "default", &rows)
            .unwrap();
        assert_eq!(raw_rows(&store, "default", origin), 1);
        store.delete_page("notes/a", None).unwrap();
        assert_eq!(
            raw_rows(&store, "default", origin),
            0,
            "cascade::remove_page_rows must call wanted_links::remove_page_rows"
        );
    }

    #[test]
    fn source_delete_removes_wanted_rows_of_that_source_only() {
        let (_d, store) = open("wl-source-delete");
        source(&store, "team");
        let kept = page(&store, "default", "notes/a");
        let gone = page(&store, "team", "notes/a");
        let rows = replacement(json!([row("body", "slug", "missing/x")]), &["body"]);
        store
            .replace_wanted_link_rows(kept, "default", &rows)
            .unwrap();
        store.replace_wanted_link_rows(gone, "team", &rows).unwrap();
        store.write(|tx| remove_source_rows(tx, "team")).unwrap();
        assert_eq!(raw_rows(&store, "team", gone), 0);
        assert_eq!(raw_rows(&store, "default", kept), 1);
    }

    // The cascade's link_queries step deletes every key under `q <source> \0`.
    #[test]
    fn source_delete_through_the_cascade_removes_wanted_rows_of_that_source_only() {
        let (_d, store) = open("wl-source-cascade");
        source(&store, "team");
        let kept = page(&store, "default", "notes/a");
        let gone = page(&store, "team", "notes/a");
        let rows = replacement(json!([row("body", "slug", "missing/x")]), &["body"]);
        store
            .replace_wanted_link_rows(kept, "default", &rows)
            .unwrap();
        store.replace_wanted_link_rows(gone, "team", &rows).unwrap();
        store
            .write(|tx| crate::cascade::remove_source_rows(tx, "team"))
            .unwrap();
        assert_eq!(
            raw_rows(&store, "team", gone),
            0,
            "link_queries::remove_source_rows must delete every key under q <source> \\0"
        );
        assert_eq!(raw_rows(&store, "default", kept), 1);
    }

    #[test]
    fn stale_origins_follow_target_updates() {
        let (_d, store) = open("wl-stale");
        let origin = page(&store, "default", "notes/a");
        let rows = replacement(
            json!([
                row("body", "slug", "notes/b"),
                row("frontmatter", "name", "c")
            ]),
            &["body", "frontmatter"],
        );
        store
            .replace_wanted_link_rows(origin, "default", &rows)
            .unwrap();
        let read = store.read().unwrap();
        assert!(stale_origin_page_ids(&*read, None).unwrap().is_empty());
        drop(read);
        page(&store, "default", "people/c");
        let read = store.read().unwrap();
        assert_eq!(
            stale_origin_page_ids(&*read, None).unwrap(),
            BTreeSet::from([origin])
        );
        let body = ["body".to_string()];
        assert!(
            stale_origin_page_ids(&*read, Some(&body))
                .unwrap()
                .is_empty()
        );
    }
}
