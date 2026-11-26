//! Core edit notices: the `core_edit_notices` table (src/core/core-memory-schema.ts, migration v213), the one-line
//! "a remote principal edited a core page; the owner has not looked yet" rows. The core guard writes one in the same
//! transaction as the edit, `gbrain core diff` reads the oldest pending one for its base text, `gbrain core ack` and
//! `gbrain core remove` close them, and the doctor, `core status` and the core block list the pending pages.
//!
//! Members: `insertCoreEditNotice` (the INSERT of `record` in src/core/persistence/core-guard.ts),
//! `listPendingCoreEditNotices` (`listPendingCoreEditNotices`, src/core/engine-sql/trust-tier-reads.ts),
//! `readOldestPendingCoreEditNotice`, `findCoreEditNoticeIdByRevision` and `ackCoreEditNotices` (the statements of
//! src/commands/core.ts) and `blankPurgeCoreEditNotices` (`blankPurgeCoreEditNotices`, src/core/engine-sql/facts-purge.ts).
//! The purge paths that scrub or probe the table (`page_purge_sweep.rs`, `purge_store_probe.rs`, `purge_claim_probe.rs`,
//! `concept_rebuild.rs`, the source delete in `cascade.rs`) call the helpers below. rust/docs/store/core-edit-notices.md
//! names each statement a member mirrors.
//!
//! Keys (tag `keys::CORE_EDIT_NOTICE`; a text part ends with a NUL byte, and no text column may hold one):
//! - `2 0x01 id -> NoticeRecord`: one row, the `id` primary key (8 big-endian bytes).
//! - `2 0x02 source_id \0 slug \0 id -> 0x01 | 0x00`: the per-page index, one entry per row, pending (`0x01`, `acked_at IS
//!   NULL`) or acknowledged (`0x00`). It plays `core_edit_notices_pending_idx (source_id, slug, id) WHERE acked_at IS NULL`
//!   and also serves the page's acknowledged rows. Every write goes through [`put_notice`], which writes the row and its
//!   entry together, so the flag never differs from `acked_at`.
//! - meta `next_core_edit_notices_id`: the `BIGSERIAL` sequence. An id is never reused, also after the row is deleted.
//!
//! The table has no foreign key: a notice names a source and a slug as text, outlives a rename and is removed only by the
//! page purge sweep (`deletePurgedSlugStoreRows`) or the source delete (`removedSourceScrubCtes`).

use crate::Store;
use crate::cli_reads::pg_text::{pg_lower, timestamptz_text};
use crate::error::{Result, STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::{get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// The byte after `keys::CORE_EDIT_NOTICE` that marks a notice row.
const ROW: u8 = 0x01;
/// The byte after `keys::CORE_EDIT_NOTICE` that marks a per-page index entry.
const BY_PAGE: u8 = 0x02;
/// The index value of a pending row.
const PENDING: u8 = 0x01;
/// The index value of an acknowledged row.
const ACKED: u8 = 0x00;
/// The id counter (`core_edit_notices_id_seq`).
pub(crate) const COUNTER: &str = "next_core_edit_notices_id";
/// `LIMIT 50` of `listPendingCoreEditNotices`.
const LIST_LIMIT: usize = 50;

/// What is stored for a notice.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct NoticeRecord {
    pub(crate) source_id: String,
    pub(crate) slug: String,
    pub(crate) page_id: Option<i64>,
    pub(crate) revision: Option<String>,
    pub(crate) base_revision: Option<String>,
    pub(crate) base_text: Option<String>,
    pub(crate) actor: String,
    pub(crate) created_at_us: i64,
    pub(crate) acked_at_us: Option<i64>,
}

/// The input of `insertCoreEditNotice`: the seven columns the core guard names (`created_at` is now, `acked_at` is
/// NULL, `id` is the next one).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoreEditNoticeInput {
    pub source_id: String,
    pub slug: String,
    pub page_id: Option<i64>,
    pub revision: Option<String>,
    pub base_revision: Option<String>,
    pub base_text: Option<String>,
    pub actor: String,
}

fn row_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::CORE_EDIT_NOTICE, ROW];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// `2 0x02 source \0`: every index entry of a source.
fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut prefix = keys::text(keys::CORE_EDIT_NOTICE, &[source_id]);
    prefix.insert(1, BY_PAGE);
    prefix.push(0);
    prefix
}

/// `2 0x02 source \0 slug \0`: every index entry of a page.
fn page_prefix(source_id: &str, slug: &str) -> Vec<u8> {
    let mut prefix = keys::text(keys::CORE_EDIT_NOTICE, &[source_id, slug]);
    prefix.insert(1, BY_PAGE);
    prefix.push(0);
    prefix
}

fn index_key(source_id: &str, slug: &str, id: u64) -> Vec<u8> {
    let mut key = page_prefix(source_id, slug);
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// The slug and id of an index key under `source_prefix`.
fn parse_index(key: &[u8], prefix_len: usize) -> Option<(&str, u64)> {
    let rest = key.get(prefix_len..)?;
    let split = rest.iter().position(|b| *b == 0)?;
    let slug = std::str::from_utf8(&rest[..split]).ok()?;
    let id = keys::be8(&rest[split + 1..])?;
    Some((slug, id))
}

/// The source, slug and id of an index key.
fn parse_full_index(key: &[u8]) -> Option<(&str, &str, u64)> {
    let rest = key.get(2..)?;
    let split = rest.iter().position(|b| *b == 0)?;
    let source = std::str::from_utf8(&rest[..split]).ok()?;
    let (slug, id) = parse_index(key, 2 + split + 1)?;
    Some((source, slug, id))
}

fn corrupt(what: &str) -> StoreError {
    StoreError::new(STORE_CORRUPT, format!("core edit notice: {what}"))
}

fn read_notice(read: &dyn KvRead, id: u64) -> Result<Option<NoticeRecord>> {
    get_json::<NoticeRecord>(read, &row_key(id))
}

/// Writes the row and its index entry, the flag following `acked_at_us`.
fn put_notice(tx: &mut dyn KvWrite, id: u64, record: &NoticeRecord) -> Result<()> {
    put_json(tx, &row_key(id), record)?;
    let flag = if record.acked_at_us.is_none() {
        PENDING
    } else {
        ACKED
    };
    tx.put(&index_key(&record.source_id, &record.slug, id), &[flag])
}

/// Deletes the row and its index entry; false when there was no row.
fn delete_notice(tx: &mut dyn KvWrite, id: u64) -> Result<bool> {
    let Some(record) = read_notice(&*tx, id)? else {
        return Ok(false);
    };
    tx.delete(&index_key(&record.source_id, &record.slug, id))?;
    tx.delete(&row_key(id))?;
    Ok(true)
}

/// The entries of one page, `(id, pending)` in id order.
fn page_entries(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Vec<(u64, bool)>> {
    let prefix = page_prefix(source_id, slug);
    let mut entries = Vec::new();
    let mut bad = false;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        match keys::be8(&k[prefix.len()..]) {
            Some(id) => entries.push((id, v == [PENDING])),
            None => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(corrupt("a bad index key"));
    }
    Ok(entries)
}

/// The ids of every row of a source, in (slug, id) order.
fn source_ids(read: &dyn KvRead, source_id: &str) -> Result<Vec<u64>> {
    let prefix = source_prefix(source_id);
    let mut ids = Vec::new();
    let mut bad = false;
    scan_prefix(read, &prefix, false, &mut |k, _| {
        match parse_index(k, prefix.len()) {
            Some((_, id)) => ids.push(id),
            None => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(corrupt("a bad index key"));
    }
    Ok(ids)
}

/// The shadow seed (`seed/history.rs`): stores `record`, a notice copied from another engine with its own id, times and
/// acknowledgement. `false` when the id already holds a notice.
pub(crate) fn seed_core_edit_notice(
    tx: &mut dyn KvWrite,
    id: u64,
    record: &NoticeRecord,
) -> Result<bool> {
    if read_notice(&*tx, id)?.is_some() {
        return Ok(false);
    }
    no_nul(
        "seed core_edit_notices",
        &[
            ("source_id", &record.source_id),
            ("slug", &record.slug),
            ("actor", &record.actor),
        ],
    )?;
    put_notice(tx, id, record)?;
    Ok(true)
}

/// The shadow follower's remove of the row `id`; false when there is none.
pub(crate) fn remove_core_edit_notice(tx: &mut dyn KvWrite, id: u64) -> Result<bool> {
    delete_notice(tx, id)
}

/// A page purge's scrub (`deletePurgedSlugStoreRows` on `core_edit_notices`, `DELETE ... WHERE source_id = $1 AND slug =
/// ANY($2)`): deletes the notices of `source_id` on one of `slugs`, acknowledged ones too; how many.
pub(crate) fn remove_for_slugs(
    tx: &mut dyn KvWrite,
    source_id: &str,
    slugs: &BTreeSet<&str>,
) -> Result<u64> {
    let mut removed = 0;
    for slug in slugs {
        for (id, _) in page_entries(&*tx, source_id, slug)? {
            removed += u64::from(delete_notice(tx, id)?);
        }
    }
    Ok(removed)
}

/// A page purge receipt's `slug_key` probe (`SELECT 1 FROM core_edit_notices WHERE source_id = .. AND slug = ..`): how
/// many notices of `source_id` are filed under `slug`, acknowledged ones included.
pub(crate) fn count_for_slug(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<usize> {
    Ok(page_entries(read, source_id, slug)?.len())
}

/// A fact purge receipt's `claim_text` probe (`strpos(lower(base_text), claim) > 0`): how many notices of `source_id`
/// hold the lowered `claim` in their base text, at most `cap`. A NULL base text never matches.
pub(crate) fn count_claim_text(
    read: &dyn KvRead,
    source_id: &str,
    claim: &str,
    cap: usize,
) -> Result<usize> {
    // One pass over the source's index, reading each row as it comes and stopping at `cap`, so a probe that finds its
    // matches early reads no further history.
    let prefix = source_prefix(source_id);
    let mut count = 0;
    let mut failure: Option<StoreError> = None;
    scan_prefix(read, &prefix, false, &mut |k, _| {
        let Some((_, id)) = parse_index(k, prefix.len()) else {
            failure = Some(corrupt("a bad index key"));
            return false;
        };
        match read_notice(read, id) {
            Ok(Some(record)) => {
                if record
                    .base_text
                    .as_deref()
                    .is_some_and(|t| pg_lower(t).contains(claim))
                {
                    count += 1;
                }
                count < cap
            }
            Ok(None) => {
                failure = Some(corrupt("an index entry names no row"));
                false
            }
            Err(e) => {
                failure = Some(e);
                false
            }
        }
    })?;
    match failure {
        Some(e) => Err(e),
        None => Ok(count),
    }
}

/// The concept rebuild's stated-store read (`SELECT 1 FROM core_edit_notices c WHERE c.source_id = $2 AND c.slug = $3`):
/// whether any notice is filed on the page.
pub(crate) fn has_for_slug(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<bool> {
    let mut found = false;
    scan_prefix(read, &page_prefix(source_id, slug), false, &mut |_, _| {
        found = true;
        false
    })?;
    Ok(found)
}

/// A source delete's scrub (`scrub_core_edit_notices` of `removedSourceScrubCtes`): deletes every notice of the source.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for id in source_ids(&*tx, source_id)? {
        delete_notice(tx, id)?;
    }
    Ok(())
}

fn no_nul_opt(op: &str, name: &str, value: &Option<String>) -> Result<()> {
    no_nul(op, &[(name, value.as_deref().unwrap_or(""))])
}

impl Store {
    /// `insertCoreEditNotice`: stores a pending notice stamped now, with the next id; the id.
    pub fn insert_core_edit_notice(&self, input: &CoreEditNoticeInput) -> Result<u64> {
        let op = "insertCoreEditNotice";
        no_nul(
            op,
            &[
                ("sourceId", &input.source_id),
                ("slug", &input.slug),
                ("actor", &input.actor),
            ],
        )?;
        no_nul_opt(op, "revision", &input.revision)?;
        no_nul_opt(op, "baseRevision", &input.base_revision)?;
        no_nul_opt(op, "baseText", &input.base_text)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let id = next_id(tx, COUNTER)?;
            let record = NoticeRecord {
                source_id: input.source_id.clone(),
                slug: input.slug.clone(),
                page_id: input.page_id,
                revision: input.revision.clone(),
                base_revision: input.base_revision.clone(),
                base_text: input.base_text.clone(),
                actor: input.actor.clone(),
                created_at_us: now,
                acked_at_us: None,
            };
            put_notice(tx, id, &record)?;
            Ok(id)
        })
    }

    /// `listPendingCoreEditNotices(sourceIds)`: for each page with a pending notice, its newest pending one as `{ source_id,
    /// slug, revision, actor, created_at }`, pages in byte order of (source, slug), at most 50. `source_ids` limits it to
    /// those sources (`source_id = ANY($1)`; an empty list matches none); `None` reads every source. `created_at` is
    /// `timestamptz::text`.
    pub fn list_pending_core_edit_notices(
        &self,
        source_ids: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        let op = "listPendingCoreEditNotices";
        if let Some(ids) = source_ids {
            for id in ids {
                no_nul(op, &[("sourceIds", id)])?;
            }
        }
        let read = self.read()?;
        // The index prefixes to walk, in byte order: the whole family, or each wanted source.
        let prefixes: Vec<Vec<u8>> = match source_ids {
            None => vec![vec![keys::CORE_EDIT_NOTICE, BY_PAGE]],
            Some(ids) => ids
                .iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .map(|s| source_prefix(s))
                .collect(),
        };
        // (source, slug, newest pending id) of each page with a pending notice, in key order.
        let mut pages: Vec<(String, String, u64)> = Vec::new();
        // The page being walked, and the newest pending id seen on it.
        let mut current: Option<(String, String, Option<u64>)> = None;
        let mut bad = false;
        'walk: for prefix in &prefixes {
            let mut full = false;
            scan_prefix(&*read, prefix, false, &mut |k, v| {
                let Some((source, slug, id)) = parse_full_index(k) else {
                    bad = true;
                    return false;
                };
                let same = current
                    .as_ref()
                    .is_some_and(|(s, l, _)| s == source && l == slug);
                if !same {
                    if let Some((s, l, Some(newest))) = current.take() {
                        pages.push((s, l, newest));
                        if pages.len() >= LIST_LIMIT {
                            full = true;
                            return false;
                        }
                    }
                    current = Some((source.to_string(), slug.to_string(), None));
                }
                if v == [PENDING]
                    && let Some((_, _, newest)) = current.as_mut()
                {
                    *newest = Some(id);
                }
                true
            })?;
            if bad {
                return Err(corrupt("a bad index key"));
            }
            if full {
                current = None;
                break 'walk;
            }
        }
        if let Some((s, l, Some(newest))) = current {
            pages.push((s, l, newest));
        }
        pages.truncate(LIST_LIMIT);
        let mut out = Vec::with_capacity(pages.len());
        for (source, slug, id) in pages {
            let r =
                read_notice(&*read, id)?.ok_or_else(|| corrupt("an index entry names no row"))?;
            out.push(json!({
                "source_id": source,
                "slug": slug,
                "revision": r.revision,
                "actor": r.actor,
                "created_at": timestamptz_text(r.created_at_us),
            }));
        }
        Ok(out)
    }

    /// `readOldestPendingCoreEditNotice(sourceId, slug)`: the pending notice of the page with the lowest id as `{
    /// base_text, actor, created_at }`; `None` when the page has none.
    pub fn read_oldest_pending_core_edit_notice(
        &self,
        source_id: &str,
        slug: &str,
    ) -> Result<Option<Value>> {
        no_nul(
            "readOldestPendingCoreEditNotice",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        let Some((id, _)) = page_entries(&*read, source_id, slug)?
            .into_iter()
            .find(|(_, pending)| *pending)
        else {
            return Ok(None);
        };
        let r = read_notice(&*read, id)?.ok_or_else(|| corrupt("an index entry names no row"))?;
        Ok(Some(json!({
            "base_text": r.base_text,
            "actor": r.actor,
            "created_at": timestamptz_text(r.created_at_us),
        })))
    }

    /// `findCoreEditNoticeIdByRevision(sourceId, slug, revision)`: the highest id among the page's notices, pending or
    /// acknowledged, whose revision is `revision`; `None` when no notice has it.
    pub fn find_core_edit_notice_id_by_revision(
        &self,
        source_id: &str,
        slug: &str,
        revision: &str,
    ) -> Result<Option<u64>> {
        no_nul(
            "findCoreEditNoticeIdByRevision",
            &[
                ("sourceId", source_id),
                ("slug", slug),
                ("revision", revision),
            ],
        )?;
        let read = self.read()?;
        for (id, _) in page_entries(&*read, source_id, slug)?.into_iter().rev() {
            let r =
                read_notice(&*read, id)?.ok_or_else(|| corrupt("an index entry names no row"))?;
            if r.revision.as_deref() == Some(revision) {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    /// `ackCoreEditNotices(sourceId, slug, maxId)`: acknowledges the page's pending notices now, those with an id up to
    /// `max_id` when it is given; how many.
    pub fn ack_core_edit_notices(
        &self,
        source_id: &str,
        slug: &str,
        max_id: Option<i64>,
    ) -> Result<u64> {
        no_nul(
            "ackCoreEditNotices",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut acked = 0;
            for (id, pending) in page_entries(&*tx, source_id, slug)? {
                let wanted =
                    pending && max_id.is_none_or(|m| i64::try_from(id).is_ok_and(|i| i <= m));
                if !wanted {
                    continue;
                }
                let mut r =
                    read_notice(&*tx, id)?.ok_or_else(|| corrupt("an index entry names no row"))?;
                r.acked_at_us = Some(now);
                put_notice(tx, id, &r)?;
                acked += 1;
            }
            Ok(acked)
        })
    }

    /// `blankPurgeCoreEditNotices(sourceId, loweredFact)`: clears the base text of the source's notices whose lowered base
    /// text holds `lowered_fact` (`strpos(lower(base_text), $2) > 0`; a NULL base text never matches, an empty fact
    /// matches every other one); how many.
    pub fn blank_purge_core_edit_notices(
        &self,
        source_id: &str,
        lowered_fact: &str,
    ) -> Result<u64> {
        no_nul(
            "blankPurgeCoreEditNotices",
            &[("sourceId", source_id), ("loweredFact", lowered_fact)],
        )?;
        self.write(|tx| {
            let mut blanked = 0;
            for id in source_ids(&*tx, source_id)? {
                let mut r =
                    read_notice(&*tx, id)?.ok_or_else(|| corrupt("an index entry names no row"))?;
                if r.base_text
                    .as_deref()
                    .is_some_and(|t| pg_lower(t).contains(lowered_fact))
                {
                    r.base_text = None;
                    put_notice(tx, id, &r)?;
                    blanked += 1;
                }
            }
            Ok(blanked)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::{SourceInput, delete_source_incarnation_in, read_source};
    use crate::test_support::store;

    fn input(source: &str, slug: &str, revision: &str) -> CoreEditNoticeInput {
        serde_json::from_value(json!({
            "sourceId": source, "slug": slug, "revision": revision, "actor": "remote:agent",
        }))
        .unwrap()
    }

    fn source(s: &Store, id: &str) {
        let input: SourceInput =
            serde_json::from_value(json!({ "id": id, "name": id, "config": {} })).unwrap();
        s.upsert_source(&input).unwrap();
    }

    #[test]
    fn a_source_removed_by_incarnation_takes_its_notices_and_a_stale_incarnation_takes_nothing() {
        let s = store();
        source(&s, "gone");
        s.insert_core_edit_notice(&input("gone", "core/a", "r1"))
            .unwrap();
        s.insert_core_edit_notice(&input("default", "core/a", "r1"))
            .unwrap();
        let incarnation = read_source(&*s.read().unwrap(), "gone")
            .unwrap()
            .unwrap()
            .incarnation;
        // The managed lifecycle's remove checks the incarnation first: a different one deletes nothing.
        let wrong = "00000000-0000-4000-8000-000000000000";
        assert!(
            !s.write(|tx| delete_source_incarnation_in(tx, "gone", wrong))
                .unwrap()
        );
        assert_eq!(s.list_pending_core_edit_notices(None).unwrap().len(), 2);
        assert!(
            s.write(|tx| delete_source_incarnation_in(tx, "gone", &incarnation))
                .unwrap()
        );
        let left = s.list_pending_core_edit_notices(None).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0]["source_id"], "default");
    }

    #[test]
    fn the_rescrub_after_a_removal_deletes_notices_written_since() {
        let s = store();
        // A notice filed on a source after the row went (a write that held a lock while the delete ran).
        s.insert_core_edit_notice(&input("gone", "core/a", "r1"))
            .unwrap();
        s.insert_core_edit_notice(&input("default", "core/a", "r1"))
            .unwrap();
        s.write(|tx| crate::sources::rescrub_removed_source_in(tx, "gone"))
            .unwrap();
        let left = s.list_pending_core_edit_notices(None).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0]["source_id"], "default");
    }

    /// Counts the index and row entries a read visits.
    struct Counted<'a>(&'a dyn KvRead, std::cell::Cell<usize>);
    impl KvRead for Counted<'_> {
        fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
            self.1.set(self.1.get() + 1);
            self.0.get(key)
        }
        fn scan(
            &self,
            start: &[u8],
            end: &[u8],
            reverse: bool,
            f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
        ) -> Result<()> {
            self.0.scan(start, end, reverse, &mut |k, v| {
                self.1.set(self.1.get() + 1);
                f(k, v)
            })
        }
    }

    #[test]
    fn a_capped_claim_probe_stops_reading_at_its_cap() {
        let s = store();
        for n in 0..50 {
            let mut row = input("default", &format!("core/p{n:02}"), "r1");
            row.base_text = Some("Alice works at Acme".into());
            s.insert_core_edit_notice(&row).unwrap();
        }
        let read = s.read().unwrap();
        let counted = Counted(&*read, std::cell::Cell::new(0));
        assert_eq!(count_claim_text(&counted, "default", "acme", 2).unwrap(), 2);
        // Two index entries and their two rows: the 48 later notices are never visited.
        assert_eq!(counted.1.get(), 4);
        assert_eq!(
            count_claim_text(&*read, "default", "acme", 1000).unwrap(),
            50
        );
        assert_eq!(
            count_claim_text(&*read, "default", "nobody", 1000).unwrap(),
            0
        );
    }

    #[test]
    fn the_index_flag_follows_acknowledgement() {
        let s = store();
        let id = s
            .insert_core_edit_notice(&input("default", "core/a", "r1"))
            .unwrap();
        let flag = |s: &Store| {
            s.read()
                .unwrap()
                .get(&index_key("default", "core/a", id))
                .unwrap()
        };
        assert_eq!(flag(&s), Some(vec![PENDING]));
        s.ack_core_edit_notices("default", "core/a", None).unwrap();
        assert_eq!(flag(&s), Some(vec![ACKED]));
        // Blanking rewrites the row through the one writer, so the flag stays what `acked_at` says.
        s.blank_purge_core_edit_notices("default", "").unwrap();
        assert_eq!(flag(&s), Some(vec![ACKED]));
        let row = read_notice(&*s.read().unwrap(), id).unwrap().unwrap();
        assert!(row.acked_at_us.is_some() && row.base_text.is_none());
    }

    #[test]
    fn a_bad_index_key_is_a_corrupt_store_not_a_silent_skip() {
        let s = store();
        s.insert_core_edit_notice(&input("default", "core/a", "r1"))
            .unwrap();
        // A key under the index prefix whose tail is not eight id bytes.
        let mut bad = page_prefix("default", "core/b");
        bad.extend_from_slice(&[1, 2, 3]);
        s.write(|tx| tx.put(&bad, &[PENDING])).unwrap();
        assert_eq!(
            s.list_pending_core_edit_notices(None).unwrap_err().code,
            STORE_CORRUPT
        );
        assert_eq!(
            s.read_oldest_pending_core_edit_notice("default", "core/b")
                .unwrap_err()
                .code,
            STORE_CORRUPT
        );
        // The good page still reads.
        assert!(
            s.read_oldest_pending_core_edit_notice("default", "core/a")
                .unwrap()
                .is_some()
        );
    }
}
