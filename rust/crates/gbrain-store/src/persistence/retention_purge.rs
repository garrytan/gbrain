//! The retention purge's bookkeeping (src/core/engine-sql/retention-purge.ts; rust/docs/store/label_door.md, "The retention
//! purge's bookkeeping"): the stale-hold release, the owed-purge listing, the three prunes, the managed purge's failure
//! records, the two candidate reads and the carry's expiring-origin read.
//!
//! The records are `op_checkpoints` parents (`op_checkpoint.rs`, key `d 0x02 <op> 0x00 <fingerprint>`), whose document is
//! `completed_keys -> 0`:
//!
//! - the derived-origin park (op `derived-origin-park`) and the owed-purge record (op `owed-page-purge`), keyed by page id
//!   (`origin_holds.rs`);
//! - the managed purge's failure record (op `purge-deleted-park`), keyed by `[source, slug, deleted_us]`, whose document
//!   names the tombstone it is for (`source_id`, `slug`, `deleted_us`).
//!
//! `deleted_us` is the tombstone's `deleted_at` in microseconds as text, as the statements compute it. A record joins its page
//! only when its fingerprint is the page id's text exactly (`o.fingerprint = p.id::text`). Every write runs in one store
//! write, so on a store bound to a purge transaction it is part of that transaction.

use super::housekeeping::HousekeepingRow;
use super::op_checkpoint::{delete_op_checkpoint_in, parent_key};
use super::origin_holds::{field_text, first_doc, has_nul};
use super::projection_queue::parse_timestamptz;
use crate::Store;
use crate::cli_reads::pg_text::timestamptz_text;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::label_door::is_origin;
use crate::links::no_nul;
use crate::page_ops::PurgeHolds;
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::sources::read_source;
use crate::{get_json, put_json};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::HashSet;

const PARK_OP: &str = "derived-origin-park";
const IDENTITY_DOWNGRADE_OP: &str = "sync-identity-downgrade";
const HOUR_US: f64 = 3_600_000_000.0;

/// One managed purge candidate (`listManagedPurgeCandidates`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ManagedPurgeCandidate {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    pub cutoff: String,
    pub deleted_us: String,
}

/// One parked origin a manual purge counts as released (`listReleasedPurgeOrigins`); `deleted_at` is ISO text.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReleasedPurgeOrigin {
    pub slug: String,
    pub source_id: String,
    pub deleted_at: String,
}

/// One soft-deleted origin the carry judges (`listExpiringOriginPages`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ExpiringOrigin {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
}

/// The new fields of `recordPurgeFailureRecord`: `first` is the `[park]` JSON text the first failure stores.
#[derive(Debug, Clone)]
pub struct PurgeFailureRow {
    pub op: String,
    pub key: String,
    pub first: String,
    pub code: Option<String>,
    pub reason: String,
    pub failed_at: String,
    pub version: String,
}

/// Every parent of `op` as `(fingerprint, row)`, in key order (the fingerprint's byte order).
fn records(read: &dyn KvRead, op: &str) -> Result<Vec<(String, HousekeepingRow)>> {
    // `d 0x02 <op> 0x00`: the parent key of an empty fingerprint is the prefix of every fingerprint.
    let prefix = parent_key(op, "")?;
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        let fingerprint = std::str::from_utf8(&k[prefix.len()..]).map(str::to_owned);
        match (fingerprint, serde_json::from_slice::<HousekeepingRow>(v)) {
            (Ok(fingerprint), Ok(row)) => out.push((fingerprint, row)),
            (Err(e), _) => failure = Some(StoreError::invalid(e.to_string())),
            (_, Err(e)) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// The page `o.fingerprint = p.id::text` joins: none unless the fingerprint is the id's canonical text.
fn page_of(read: &dyn KvRead, fingerprint: &str) -> Result<Option<PageRecord>> {
    match fingerprint.parse::<u64>() {
        Ok(id) if id.to_string() == fingerprint => read_page_by_id(read, id),
        _ => Ok(None),
    }
}

/// `floor(extract(epoch FROM deleted_at) * 1000000)::bigint::text`, or none for a live page.
fn deleted_us(page: &PageRecord) -> Option<String> {
    page.deleted_at_us.map(|at| at.to_string())
}

/// `OWED_TOMBSTONE`: the record's page is a tombstone whose `deleted_us` is the record's.
fn owed_tombstone(read: &dyn KvRead, fingerprint: &str, row: &HousekeepingRow) -> Result<bool> {
    let recorded = first_doc(row).and_then(|doc| field_text(doc, "deleted_us"));
    Ok(page_of(read, fingerprint)?
        .and_then(|page| deleted_us(&page))
        .is_some_and(|us| Some(us) == recorded))
}

/// `LIVE_TOMBSTONE`: the page the record names (`source_id`, `slug`) is a tombstone whose `deleted_us` is the record's.
fn live_tombstone(read: &dyn KvRead, row: &HousekeepingRow) -> Result<bool> {
    let Some(doc) = first_doc(row) else {
        return Ok(false);
    };
    let (Some(source), Some(slug), Some(recorded)) = (
        field_text(doc, "source_id"),
        field_text(doc, "slug"),
        field_text(doc, "deleted_us"),
    ) else {
        return Ok(false);
    };
    Ok(read_page(read, &source, &slug)?
        .and_then(|page| deleted_us(&page))
        .is_some_and(|us| us == recorded))
}

/// `now() - ($n || ' hours')::interval` in microseconds. The bind is the hour count as text; text that is not a number
/// refuses, as the interval cast does.
fn cutoff_us(now: i64, hours: &str) -> Result<i64> {
    let parsed = hours.trim().parse::<f64>().ok().filter(|h| h.is_finite());
    let Some(h) = parsed else {
        return Err(StoreError::invalid(format!(
            "invalid input syntax for type interval: \"{hours} hours\""
        )));
    };
    Ok(now.saturating_sub((h * HOUR_US).round() as i64))
}

/// `jsonb || jsonb`: two objects merge (the right side's keys win), two arrays concatenate, and otherwise a non-array
/// side is wrapped as a one-element array first. A missing left side is SQL NULL, and NULL `||` anything is NULL.
fn jsonb_concat(left: Option<&Value>, right: Value) -> Value {
    let Some(left) = left else {
        return Value::Null;
    };
    match (left, right) {
        (Value::Object(a), Value::Object(b)) => {
            let mut merged = a.clone();
            merged.extend(b);
            Value::Object(merged)
        }
        (Value::Array(a), Value::Array(b)) => Value::Array(a.iter().cloned().chain(b).collect()),
        (Value::Array(a), b) => Value::Array(a.iter().cloned().chain([b]).collect()),
        (a, Value::Array(b)) => Value::Array([a.clone()].into_iter().chain(b).collect()),
        (a, b) => json!([a, b]),
    }
}

/// The holds a released-origin read keeps (`identityDowngradePurgeHold`, `atomRetirementPurgeHold`,
/// `derivedRetirementPurgeHold`): true when one of them keeps `page`.
struct RetentionHolds {
    retirement: PurgeHolds,
}

impl RetentionHolds {
    fn read(read: &dyn KvRead, pages: &[PageRecord], now: i64) -> Result<Self> {
        Ok(Self {
            retirement: PurgeHolds::read(read, pages, now)?,
        })
    }

    /// The identity-downgrade record of the page is open: no `disposition`, and the page is soft-deleted at the record's
    /// `old_deleted_at` instant. Text the timestamptz cast cannot parse refuses, as the cast does.
    fn identity_downgrade_open(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
        let Some(row) = get_json::<HousekeepingRow>(
            read,
            &parent_key(IDENTITY_DOWNGRADE_OP, &page.id.to_string())?,
        )?
        else {
            return Ok(false);
        };
        let Some(doc) = first_doc(&row) else {
            return Ok(false);
        };
        if field_text(doc, "disposition").is_some() {
            return Ok(false);
        }
        let Some(at) = field_text(doc, "old_deleted_at") else {
            return Ok(false);
        };
        let at = parse_timestamptz(&at, "old_deleted_at").map_err(|_| {
            StoreError::invalid(format!(
                "invalid input syntax for type timestamp with time zone: \"{at}\""
            ))
        })?;
        Ok(page.deleted_at_us == Some(at))
    }

    fn holds(&self, read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
        Ok(self.retirement.holds(page) || Self::identity_downgrade_open(read, page)?)
    }
}

/// A store id list (`$n::int[]`) as a set; a negative id names no page.
fn id_set(ids: &[i64]) -> HashSet<u64> {
    ids.iter()
        .filter_map(|id| u64::try_from(*id).ok())
        .collect()
}

/// Deletes every parent of `op` `doomed` picks, with its paths; how many it deleted.
fn delete_where(
    tx: &mut dyn KvWrite,
    op: &str,
    doomed: &mut dyn FnMut(&dyn KvRead, &str, &HousekeepingRow) -> Result<bool>,
) -> Result<usize> {
    let mut removed = 0;
    for (fingerprint, row) in records(&*tx, op)? {
        if doomed(&*tx, &fingerprint, &row)? {
            delete_op_checkpoint_in(tx, op, &fingerprint)?;
            removed += 1;
        }
    }
    Ok(removed)
}

impl Store {
    /// `releaseStaleOriginParkHolds(op)`: each park of `op` whose page exists and whose document holds `held_deleted_us`
    /// loses `held_request_id` and `held_deleted_us`, stamped now, once the page is live or its tombstone is not the held
    /// one. A held tombstone that is JSON null is released only by a live page (`<> NULL` is not true).
    pub fn release_stale_origin_park_holds(&self, op: &str) -> Result<()> {
        no_nul("releaseStaleOriginParkHolds", &[("op", op)])?;
        self.write(|tx| {
            for (fingerprint, row) in records(&*tx, op)? {
                let Some(page) = page_of(&*tx, &fingerprint)? else {
                    continue;
                };
                let Some(doc_value) = first_doc(&row) else {
                    continue;
                };
                let Some(doc) = doc_value.as_object() else {
                    continue;
                };
                if !doc.contains_key("held_deleted_us") {
                    continue;
                }
                let stale = match deleted_us(&page) {
                    None => true,
                    Some(us) => {
                        field_text(doc_value, "held_deleted_us").is_some_and(|held| held != us)
                    }
                };
                if !stale {
                    continue;
                }
                let mut kept: Map<String, Value> = doc.clone();
                kept.remove("held_request_id");
                kept.remove("held_deleted_us");
                put_json(
                    tx,
                    &parent_key(op, &fingerprint)?,
                    &HousekeepingRow {
                        completed_keys: json!([crate::jsonb::ordered(&Value::Object(kept))]),
                        updated_at_us: self.env.now_micros(),
                    },
                )?;
            }
            Ok(())
        })
    }

    /// `listOwedPurgeRecords(op)`: `{ owed }` (the stored document) for each record of `op` whose tombstone still exists as
    /// recorded, by fingerprint.
    pub fn list_owed_purge_records(&self, op: &str) -> Result<Vec<Value>> {
        no_nul("listOwedPurgeRecords", &[("op", op)])?;
        let read = self.read()?;
        let read: &dyn KvRead = &*read;
        let mut out = Vec::new();
        for (fingerprint, row) in records(read, op)? {
            if owed_tombstone(read, &fingerprint, &row)? {
                out.push(json!({ "owed": first_doc(&row).cloned().unwrap_or(Value::Null) }));
            }
        }
        Ok(out)
    }

    /// `pruneOwedPurgeRecords(op)`: removes the records of `op` whose tombstone was removed, restored or deleted again.
    pub fn prune_owed_purge_records(&self, op: &str) -> Result<()> {
        no_nul("pruneOwedPurgeRecords", &[("op", op)])?;
        self.write(|tx| {
            delete_where(tx, op, &mut |read, fingerprint, row| {
                Ok(!owed_tombstone(read, fingerprint, row)?)
            })
            .map(drop)
        })
    }

    /// `pruneOriginParkRecords(op)`: removes the parks of `op` whose page is not a tombstone (restored, purged or never one).
    pub fn prune_origin_park_records(&self, op: &str) -> Result<()> {
        no_nul("pruneOriginParkRecords", &[("op", op)])?;
        self.write(|tx| {
            delete_where(tx, op, &mut |read, fingerprint, _| {
                Ok(!page_of(read, fingerprint)?.is_some_and(|p| p.deleted_at_us.is_some()))
            })
            .map(drop)
        })
    }

    /// `prunePurgeParkRecords(op)`: removes the failure records of `op` whose tombstone was purged, restored or deleted again.
    pub fn prune_purge_park_records(&self, op: &str) -> Result<()> {
        no_nul("prunePurgeParkRecords", &[("op", op)])?;
        self.write(|tx| {
            delete_where(tx, op, &mut |read, _, row| Ok(!live_tombstone(read, row)?)).map(drop)
        })
    }

    /// `recordPurgeFailureRecord(row)`: the first failure stores `first` (JSON text, parsed as `::jsonb`); a repeat merges
    /// `{ failures: failures + 1, code, reason, failed_at, version }` into the stored document. Both stamp now.
    pub fn record_purge_failure_record(&self, row: &PurgeFailureRow) -> Result<()> {
        no_nul(
            "recordPurgeFailureRecord",
            &[
                ("op", &row.op),
                ("key", &row.key),
                ("code", row.code.as_deref().unwrap_or("")),
                ("reason", &row.reason),
                ("failedAt", &row.failed_at),
                ("version", &row.version),
            ],
        )?;
        let first: Value = serde_json::from_str(&row.first).map_err(|_| {
            StoreError::invalid(format!("invalid input syntax for type json: {}", row.first))
        })?;
        if has_nul(&first) {
            return Err(StoreError::invalid(
                "unsupported Unicode escape sequence: \\u0000 cannot be converted to text",
            ));
        }
        let key = parent_key(&row.op, &row.key)?;
        self.write(|tx| {
            let completed_keys = match get_json::<HousekeepingRow>(&*tx, &key)? {
                None => crate::jsonb::ordered(&first),
                Some(old) => {
                    let doc = first_doc(&old);
                    // `COALESCE((completed_keys->0->>'failures')::int, 0) + 1`; text the int cast refuses refuses here.
                    let failures = match doc.and_then(|d| field_text(d, "failures")) {
                        None => 0,
                        Some(text) => text.trim().parse::<i32>().map_err(|_| {
                            StoreError::invalid(format!(
                                "invalid input syntax for type integer: \"{text}\""
                            ))
                        })?,
                    };
                    let fields = json!({
                        "failures": i64::from(failures) + 1,
                        "code": row.code,
                        "reason": row.reason,
                        "failed_at": row.failed_at,
                        "version": row.version,
                    });
                    json!([crate::jsonb::ordered(&jsonb_concat(doc, fields))])
                }
            };
            put_json(
                tx,
                &key,
                &HousekeepingRow {
                    completed_keys,
                    updated_at_us: self.env.now_micros(),
                },
            )
        })
    }

    /// `deletePurgeParkRecord(op, key)`: removes the record and its paths.
    pub fn delete_purge_park_record(&self, op: &str, key: &str) -> Result<()> {
        no_nul("deletePurgeParkRecord", &[("op", op), ("key", key)])?;
        self.write(|tx| delete_op_checkpoint_in(tx, op, key))
    }

    /// `markPurgeParksInactive(op, sourceId)`: each record of `op` for `source_id` with no `inactive_seen` gets
    /// `inactive_seen: true`. The statement sets no `updated_at`, so the stamp stays.
    pub fn mark_purge_parks_inactive(&self, op: &str, source_id: &str) -> Result<()> {
        no_nul(
            "markPurgeParksInactive",
            &[("op", op), ("sourceId", source_id)],
        )?;
        self.write(|tx| {
            for (fingerprint, mut row) in records(&*tx, op)? {
                let Some(doc) = first_doc(&row) else {
                    continue;
                };
                if field_text(doc, "source_id").as_deref() != Some(source_id)
                    || field_text(doc, "inactive_seen").is_some()
                {
                    continue;
                }
                let merged = jsonb_concat(Some(doc), json!({ "inactive_seen": true }));
                row.completed_keys = json!([crate::jsonb::ordered(&merged)]);
                put_json(tx, &parent_key(op, &fingerprint)?, &row)?;
            }
            Ok(())
        })
    }

    /// `dropRearmedPurgeParks(op, sourceId)`: removes the records of `op` for `source_id` whose `inactive_seen` reads
    /// `'true'`, and how many it removed.
    pub fn drop_rearmed_purge_parks(&self, op: &str, source_id: &str) -> Result<i64> {
        no_nul(
            "dropRearmedPurgeParks",
            &[("op", op), ("sourceId", source_id)],
        )?;
        self.write(|tx| {
            let removed = delete_where(tx, op, &mut |_, _, row| {
                Ok(first_doc(row).is_some_and(|doc| {
                    field_text(doc, "source_id").as_deref() == Some(source_id)
                        && field_text(doc, "inactive_seen").as_deref() == Some("true")
                }))
            })?;
            Ok(removed as i64)
        })
    }

    /// `listReleasedPurgeOrigins(release, excludeIds, hours)`: the tombstones among `release` and not in `exclude_ids`,
    /// deleted before now minus `hours`, that no identity-downgrade, atom-retirement or derived-retirement hold keeps
    /// (the origin park and the archived source are not checked: these are the origins the run releases), by id.
    pub fn list_released_purge_origins(
        &self,
        release: &[i64],
        exclude_ids: &[i64],
        hours: &str,
    ) -> Result<Vec<ReleasedPurgeOrigin>> {
        let read = self.read()?;
        let read: &dyn KvRead = &*read;
        let now = self.env.now_micros();
        let cutoff = cutoff_us(now, hours)?;
        let wanted = id_set(release);
        let excluded = id_set(exclude_ids);
        let mut pages: Vec<PageRecord> = Vec::new();
        for id in &wanted {
            if excluded.contains(id) {
                continue;
            }
            if let Some(page) = read_page_by_id(read, *id)?
                && page.deleted_at_us.is_some_and(|at| at < cutoff)
            {
                pages.push(page);
            }
        }
        pages.sort_by_key(|p| p.id);
        let holds = RetentionHolds::read(read, &all_pages(read)?, now)?;
        let mut out = Vec::new();
        for page in pages {
            if holds.holds(read, &page)? {
                continue;
            }
            out.push(ReleasedPurgeOrigin {
                slug: page.slug.clone(),
                source_id: page.source_id.clone(),
                deleted_at: page.deleted_at_us.map(iso).unwrap_or_default(),
            });
        }
        Ok(out)
    }

    /// `listManagedPurgeCandidates(hours, release, hold)`: the tombstones deleted before now minus `hours` whose source exists
    /// and is not archived, that no identity-downgrade, atom-retirement or derived-retirement hold keeps, whose origin park
    /// is absent or whose id is in `release`, and whose id is not in `hold`. Ordered by `deleted_at`, then source and slug in
    /// byte order; `cutoff` is the cutoff as `timestamptz::text`.
    pub fn list_managed_purge_candidates(
        &self,
        hours: &str,
        release: &[i64],
        hold: &[i64],
    ) -> Result<Vec<ManagedPurgeCandidate>> {
        let read = self.read()?;
        let read: &dyn KvRead = &*read;
        let now = self.env.now_micros();
        let cutoff = cutoff_us(now, hours)?;
        let released = id_set(release);
        let held = id_set(hold);
        let all = all_pages(read)?;
        let holds = RetentionHolds::read(read, &all, now)?;
        let mut picked: Vec<&PageRecord> = Vec::new();
        for page in &all {
            if !page.deleted_at_us.is_some_and(|at| at < cutoff) || held.contains(&page.id) {
                continue;
            }
            if !read_source(read, &page.source_id)?.is_some_and(|s| !s.archived) {
                continue;
            }
            if holds.holds(read, page)? {
                continue;
            }
            let parked =
                get_json::<HousekeepingRow>(read, &parent_key(PARK_OP, &page.id.to_string())?)?
                    .is_some();
            if parked && !released.contains(&page.id) {
                continue;
            }
            picked.push(page);
        }
        picked.sort_by(|a, b| {
            a.deleted_at_us
                .cmp(&b.deleted_at_us)
                .then_with(|| a.source_id.as_bytes().cmp(b.source_id.as_bytes()))
                .then_with(|| a.slug.as_bytes().cmp(b.slug.as_bytes()))
        });
        let cutoff_text = timestamptz_text(cutoff);
        Ok(picked
            .into_iter()
            .map(|page| ManagedPurgeCandidate {
                id: page.id,
                source_id: page.source_id.clone(),
                slug: page.slug.clone(),
                cutoff: cutoff_text.clone(),
                deleted_us: deleted_us(page).unwrap_or_default(),
            })
            .collect())
    }

    /// `listExpiringOriginPages(hours)`: the tombstones deleted before now minus `hours` that are privacy origins (an atom,
    /// or a page the privacy rules hide, `is_origin`), by id.
    pub fn list_expiring_origin_pages(
        &self,
        hours: &str,
        honor_aliases: bool,
    ) -> Result<Vec<ExpiringOrigin>> {
        let read = self.read()?;
        let read: &dyn KvRead = &*read;
        let cutoff = cutoff_us(self.env.now_micros(), hours)?;
        let mut out = Vec::new();
        let mut pages = all_pages(read)?;
        pages.sort_by_key(|p| p.id);
        for page in pages {
            if !page.deleted_at_us.is_some_and(|at| at < cutoff)
                || !is_origin(read, &page, honor_aliases)?
            {
                continue;
            }
            out.push(ExpiringOrigin {
                id: page.id,
                source_id: page.source_id,
                slug: page.slug,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonb_concat_merges_objects_and_wraps_the_rest_as_postgres_does() {
        assert_eq!(
            jsonb_concat(Some(&json!({ "a": 1, "b": 1 })), json!({ "b": 2 })),
            json!({ "a": 1, "b": 2 })
        );
        assert_eq!(jsonb_concat(None, json!({ "b": 2 })), Value::Null);
        assert_eq!(
            jsonb_concat(Some(&json!([1])), json!({ "b": 2 })),
            json!([1, { "b": 2 }])
        );
        assert_eq!(
            jsonb_concat(Some(&json!("x")), json!({ "b": 2 })),
            json!(["x", { "b": 2 }])
        );
    }

    #[test]
    fn the_cutoff_is_now_minus_the_hours_and_text_that_is_no_number_refuses() {
        assert_eq!(
            cutoff_us(10 * 3_600_000_000, "2").unwrap(),
            8 * 3_600_000_000
        );
        assert_eq!(cutoff_us(0, " 0 ").unwrap(), 0);
        assert!(cutoff_us(0, "two").is_err());
        assert!(cutoff_us(0, "NaN").is_err());
    }
}
