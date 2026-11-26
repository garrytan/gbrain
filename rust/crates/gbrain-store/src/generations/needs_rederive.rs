//! The re-derive queue: the `needs_rederive` table of the PGLite engine (`src/core/facts/derivation-inputs.ts`).
//!
//! A purge that reaches a derived row through its recorded inputs (`derivation_inputs`, `derivation_inputs.rs`) hides
//! the row through its table's own inactive state and marks it here (`hideDerivedRows`). A marked row never surfaces on
//! a read that applies `rederiveHiddenSql` (`src/core/eligibility/sql.ts`): `projectionEligibleSql` for facts, takes and
//! timeline rows, `getVersions` and `pageAwaitsRederive` for pages. Those reads ask [`is_marked`].
//!
//! Member: `markNeedsRederive(table, ids, sourceId, requestId, reason, hiddenNow)` (`MARK_NEEDS_REDERIVE_SQL`).
//!
//! Keys, under `keys::DERIVED_GENERATION` (`h`) with the derivation inputs:
//! - `h 0x0C derived_table \0 derived_id -> RederiveRecord`, one row; the key is its primary key. No part may hold a
//!   NUL byte (Postgres `text` refuses one too).
//!
//! A source delete removes the rows whose `source_id` is the source (`ON DELETE CASCADE`); a row with no source stays.

use crate::env::is_uuid;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite, collect_prefix};
use crate::links::no_nul;
use crate::pages::read_page_by_id;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The sub-byte of a `needs_rederive` row.
const REDERIVE: u8 = 0x0C;

/// One row of `needs_rederive`; the key holds `derived_table` and `derived_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct RederiveRecord {
    #[serde(default)]
    source_id: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    reason: String,
    marked_at_us: i64,
}

/// `markNeedsRederive({ table, ids, sourceId, requestId, reason, hiddenNow })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkRederiveArgs {
    pub table: String,
    pub ids: Vec<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    pub reason: String,
    pub hidden_now: Vec<String>,
}

fn row_key(table: &str, id: &str) -> Vec<u8> {
    let mut key = vec![keys::DERIVED_GENERATION, REDERIVE];
    key.extend_from_slice(table.as_bytes());
    key.push(0);
    key.extend_from_slice(id.as_bytes());
    key
}

/// `EXISTS (SELECT 1 FROM needs_rederive WHERE derived_table = table AND derived_id = id::text)`.
pub(crate) fn is_marked(read: &dyn KvRead, table: &str, id: u64) -> Result<bool> {
    Ok(read.get(&row_key(table, &id.to_string()))?.is_some())
}

/// `marked_at` of the `needs_rederive` row (`table`, `id`), in microseconds; `None` when the row is not there.
pub(crate) fn marked_at(read: &dyn KvRead, table: &str, id: u64) -> Result<Option<i64>> {
    Ok(get_json::<RederiveRecord>(read, &row_key(table, &id.to_string()))?.map(|r| r.marked_at_us))
}

/// Removes the rows of a deleted source (`needs_rederive.source_id -> sources ON DELETE CASCADE`).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let rows = collect_prefix(
        &*tx,
        &[keys::DERIVED_GENERATION, REDERIVE],
        false,
        usize::MAX,
    )?;
    for (key, value) in rows {
        let row: RederiveRecord = serde_json::from_slice(&value)?;
        if row.source_id.as_deref() == Some(source_id) {
            tx.delete(&key)?;
        }
    }
    Ok(())
}

/// `(SELECT p.deleted_at FROM pages p WHERE p.id::text = id)`: the page whose id reads as `id`, if any.
fn page_deleted_at(read: &dyn KvRead, id: &str) -> Result<Option<Option<i64>>> {
    let Ok(page_id) = id.parse::<u64>() else {
        return Ok(None);
    };
    if page_id.to_string() != id {
        return Ok(None);
    }
    Ok(read_page_by_id(read, page_id)?.map(|p| p.deleted_at_us))
}

impl Store {
    /// `pageAwaitsRederive(pageId)`: a page with this id exists and a purge marked it in `needs_rederive`.
    pub fn page_awaits_rederive(&self, page_id: i64) -> Result<bool> {
        let Ok(id) = u64::try_from(page_id) else {
            return Ok(false);
        };
        let read = self.read()?;
        Ok(read_page_by_id(&*read, id)?.is_some() && is_marked(&*read, "pages", id)?)
    }

    /// `markNeedsRederive`: `MARK_NEEDS_REDERIVE_SQL`. Each id is marked with the reason and request; a new mark's
    /// `marked_at` is the `deleted_at` of the page with that id when the id is in `hiddenNow` (the pages this transaction
    /// just hid), else now. On a row already marked, an id in `hiddenNow` takes the new moment; any other keeps a page's
    /// moment while the page is still deleted at it (`KEEP_HIDDEN_AT`), else is stamped now. An empty list writes
    /// nothing; an id named twice fails as `ON CONFLICT DO UPDATE` does.
    pub fn mark_needs_rederive(&self, a: &MarkRederiveArgs) -> Result<()> {
        const OP: &str = "markNeedsRederive";
        if a.ids.is_empty() {
            return Ok(());
        }
        no_nul(
            OP,
            &[("table", a.table.as_str()), ("reason", a.reason.as_str())],
        )?;
        for id in a.ids.iter().chain(&a.hidden_now) {
            no_nul(OP, &[("id", id.as_str())])?;
        }
        let request_id = match a.request_id.as_deref() {
            None => None,
            Some(text) if is_uuid(text) => Some(text.to_lowercase()),
            Some(text) => {
                return Err(StoreError::invalid(format!(
                    "{OP}: invalid input syntax for type uuid: \"{text}\""
                )));
            }
        };
        let mut seen = BTreeSet::new();
        if a.ids.iter().any(|id| !seen.insert(id.as_str())) {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                "ON CONFLICT DO UPDATE command cannot affect row a second time",
            ));
        }
        let hidden: BTreeSet<&str> = a.hidden_now.iter().map(String::as_str).collect();
        let now = self.env.now_micros();
        self.write(|tx| {
            // The foreign key is checked only on a row the statement inserts: `ON CONFLICT DO UPDATE` keeps the stored
            // `source_id`, so a mark of a row already queued never reads the source.
            let source_exists = match &a.source_id {
                None => true,
                Some(source) => {
                    no_nul(OP, &[("sourceId", source.as_str())])?;
                    crate::sources::read_source(&*tx, source)?.is_some()
                }
            };
            for id in &a.ids {
                let fresh = if hidden.contains(id.as_str()) {
                    page_deleted_at(&*tx, id)?.flatten().unwrap_or(now)
                } else {
                    now
                };
                let key = row_key(&a.table, id);
                let marked_at_us = match get_json::<RederiveRecord>(&*tx, &key)? {
                    None => fresh,
                    Some(_) if hidden.contains(id.as_str()) => fresh,
                    Some(old) => {
                        let kept = a.table == "pages"
                            && page_deleted_at(&*tx, id)?.flatten() == Some(old.marked_at_us);
                        if kept { old.marked_at_us } else { now }
                    }
                };
                let row = RederiveRecord {
                    source_id: a.source_id.clone(),
                    request_id: request_id.clone(),
                    reason: a.reason.clone(),
                    marked_at_us,
                };
                // `ON CONFLICT ... DO UPDATE SET reason, request_id, marked_at`: the source stays the first one.
                let row = match get_json::<RederiveRecord>(&*tx, &key)? {
                    Some(old) => RederiveRecord { source_id: old.source_id, ..row },
                    None if !source_exists => {
                        return Err(StoreError::new(
                            CONSTRAINT_VIOLATION,
                            "insert or update on table \"needs_rederive\" violates foreign key constraint \"needs_rederive_source_id_fkey\"",
                        ));
                    }
                    None => row,
                };
                put_json(tx, &key, &row)?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mark(store: &Store, source: Option<&str>, ids: &[&str], hidden: &[&str]) -> Result<()> {
        let args: MarkRederiveArgs = serde_json::from_value(json!({
            "table": "facts", "ids": ids, "sourceId": source, "requestId": null, "reason": "purged", "hiddenNow": hidden,
        }))
        .unwrap();
        store.mark_needs_rederive(&args)
    }

    #[test]
    fn a_mark_names_each_row_once_and_a_source_delete_removes_its_rows() {
        let store = crate::test_support::store();
        let source: crate::sources::SourceInput =
            serde_json::from_value(json!({ "id": "side", "config": {} })).unwrap();
        store.upsert_source(&source).unwrap();
        mark(&store, Some("default"), &["1", "2"], &[]).unwrap();
        mark(&store, Some("side"), &["3"], &[]).unwrap();
        mark(&store, None, &[], &[]).unwrap();
        let marked = |id: u64| is_marked(&*store.read().unwrap(), "facts", id).unwrap();
        assert!(marked(1) && marked(2) && marked(3) && !marked(4));
        let twice = mark(&store, Some("default"), &["5", "5"], &[]).unwrap_err();
        assert!(
            twice
                .to_string()
                .contains("cannot affect row a second time"),
            "{twice}"
        );
        assert!(!marked(5), "a refused mark writes nothing");
        let unknown = mark(&store, Some("no-such-source"), &["6"], &[]).unwrap_err();
        assert!(
            unknown
                .to_string()
                .contains("needs_rederive_source_id_fkey"),
            "{unknown}"
        );
        // A row already queued keeps its source, so its source is not checked again.
        mark(&store, Some("no-such-source"), &["1"], &[]).unwrap();
        store
            .write(|tx| crate::cascade::remove_source_rows(tx, "side"))
            .unwrap();
        assert!(marked(1) && !marked(3));
    }
}
