//! Needs-rederive marks: the `needs_rederive` table of the PGLite engine, the derived rows a purge
//! hid until a deriver builds them again from surviving inputs (`src/core/facts/purge-schema.ts`).
//!
//! Members: hideDerivedRows and releaseHiddenMoment (`engine-sql/facts-purge.ts`, called by
//! `facts/derivation-inputs.ts`), and pageAwaitsRederive (`engine-sql/trust-tier-reads.ts`). The
//! projection-eligibility reads that apply `rederiveHiddenSql` ask [`awaits_rederive`].
//!
//! Keys, under `keys::DERIVED_GENERATION` (`h`) with the generation rows (store format 7,
//! rust/docs/store/format.md):
//! - `h 0x0C derived_table \0 derived_id -> MarkRecord`, one row of `needs_rederive`; the key is
//!   its primary key. No part may hold a NUL byte (Postgres `text` refuses one too).
//!
//! A source delete removes the rows whose `source_id` is the source (`ON DELETE CASCADE`); a row
//! with no source stays. That delete reads every row, as the store keeps no index by source.
//!
//! The time rules follow the SQL. `now()` is the transaction's start time, which the store's
//! transaction clock gives. `releaseHiddenMoment` uses `clock_timestamp()`, the wall clock
//! ([`crate::env::Env::clock_micros`]).

use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::facts::purge::DerivationRef;
use crate::kv::{KvRead, KvWrite, collect_prefix};
use crate::links::no_nul;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// The sub-byte of a `needs_rederive` row, keyed by the derived row.
pub(super) const BY_ROW: u8 = 0x0C;
const BY_ROW_HEAD: [u8; 2] = [keys::DERIVED_GENERATION, BY_ROW];

/// One row of `needs_rederive`; the key holds `derived_table` and `derived_id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct MarkRecord {
    #[serde(default)]
    source_id: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    reason: String,
    marked_at_us: i64,
}

/// `hideDerivedRows(rows, { sourceId, requestId, reason })`'s arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HideDerivedRowsArgs {
    pub rows: Vec<DerivationRef>,
    pub source_id: String,
    #[serde(default)]
    pub request_id: Option<String>,
    pub reason: String,
}

fn mark_key(table: &str, id: &str) -> Vec<u8> {
    let mut key = BY_ROW_HEAD.to_vec();
    key.extend_from_slice(table.as_bytes());
    key.push(0);
    key.extend_from_slice(id.as_bytes());
    key
}

/// `rederiveHiddenSql(table, alias)` is false: a `needs_rederive` row names `(table, id)`. The id
/// is the row id as text (`alias.id::text`), so callers pass `id.to_string()`.
pub(crate) fn awaits_rederive(read: &dyn KvRead, table: &str, id: &str) -> Result<bool> {
    Ok(read.get(&mark_key(table, id))?.is_some())
}

/// The `ON DELETE CASCADE` of `needs_rederive.source_id`: drops the rows of `source_id`.
pub(super) fn remove_source_marks(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut doomed = Vec::new();
    for (key, value) in collect_prefix(&*tx, &BY_ROW_HEAD, false, usize::MAX)? {
        let mark: MarkRecord = serde_json::from_slice(&value)?;
        if mark.source_id.as_deref() == Some(source_id) {
            doomed.push(key);
        }
    }
    for key in doomed {
        tx.delete(&key)?;
    }
    Ok(())
}

fn invalid(op: &str, what: impl std::fmt::Display) -> StoreError {
    StoreError::new(INVALID_ARGUMENT, format!("{op}: {what}"))
}

/// The distinct numeric ids of a table group (`ids.filter(/^\d+$/).map(Number)`), each in the
/// range its column binds (`bigint` for facts and takes, `integer` for pages), as Postgres refuses
/// a value outside it.
fn numeric_ids(op: &str, table: &str, ids: &[&str]) -> Result<BTreeSet<u64>> {
    let max = if table == "pages" {
        i32::MAX as u64
    } else {
        i64::MAX as u64
    };
    let mut out = BTreeSet::new();
    for id in ids {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        match id.parse::<u64>() {
            Ok(n) if n <= max => {
                out.insert(n);
            }
            _ => return Err(invalid(op, format!("{table} id {id} is out of range"))),
        }
    }
    Ok(out)
}

impl Store {
    /// `hideDerivedRows(rows, mark)`: hides each derived row through its table's own inactive state
    /// and marks it `needs_rederive`, table by table in first-seen order, as
    /// `engine-sql/facts-purge.ts` does. A fact of the source expires (`COALESCE(expired_at,
    /// now())`), a take whose page is in the source deactivates, and a page of the source is
    /// soft-deleted now (a page already deleted counts and keeps its time). Any other row is only
    /// marked. A mark keeps an existing row's `source_id`; its `marked_at` is the page's
    /// `deleted_at` for a page hidden now, the existing time when it equals the page's
    /// `deleted_at` (`KEEP_HIDDEN_AT`), and now otherwise. Resolves `{ hidden, markedOnly }`, the
    /// counts per table. A row named twice is refused, as `ON CONFLICT DO UPDATE` refuses it.
    pub fn hide_derived_rows(&self, a: &HideDerivedRowsArgs) -> Result<Value> {
        const OP: &str = "hideDerivedRows";
        no_nul(OP, &[("sourceId", &a.source_id), ("reason", &a.reason)])?;
        if let Some(request_id) = &a.request_id {
            no_nul(OP, &[("requestId", request_id)])?;
        }
        let mut groups: Vec<(&str, Vec<&str>)> = Vec::new();
        let mut seen = BTreeSet::new();
        for row in &a.rows {
            no_nul(OP, &[("table", &row.table), ("id", &row.id)])?;
            if !seen.insert((row.table.as_str(), row.id.as_str())) {
                return Err(invalid(
                    OP,
                    format!("row {}:{} is named twice", row.table, row.id),
                ));
            }
            match groups.iter_mut().find(|(t, _)| *t == row.table) {
                Some((_, ids)) => ids.push(&row.id),
                None => groups.push((&row.table, vec![&row.id])),
            }
        }
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            crate::sources::require_source(&*tx, &a.source_id)?;
            let mut hidden = Map::new();
            let mut marked_only = Map::new();
            for (table, ids) in &groups {
                let numeric = numeric_ids(OP, table, ids)?;
                let mut count = 0usize;
                let mut hidden_now: Vec<(String, i64)> = Vec::new();
                match *table {
                    "facts" => {
                        for id in &numeric {
                            let Some(old) = crate::facts::read_fact(&*tx, *id)? else {
                                continue;
                            };
                            if old.source_id != a.source_id {
                                continue;
                            }
                            count += 1;
                            if old.expired_at_us.is_none() {
                                let mut new = old.clone();
                                new.expired_at_us = Some(now);
                                crate::facts::write_fact(tx, trust, Some(&old), &new)?;
                            }
                        }
                    }
                    "takes" => {
                        for id in &numeric {
                            let Some(mut take) = crate::takes::read_take(&*tx, *id)? else {
                                continue;
                            };
                            let page = crate::pages::read_page_by_id(&*tx, take.page_id)?;
                            if page.is_none_or(|p| p.source_id != a.source_id) {
                                continue;
                            }
                            count += 1;
                            if take.active {
                                // No update trigger moves `updated_at` on takes.
                                take.active = false;
                                crate::takes::store_take(tx, &take)?;
                            }
                        }
                    }
                    "pages" => {
                        for id in &numeric {
                            let Some(mut page) = crate::pages::read_page_by_id(&*tx, *id)? else {
                                continue;
                            };
                            if page.source_id != a.source_id {
                                continue;
                            }
                            count += 1;
                            if page.deleted_at_us.is_none() {
                                page.deleted_at_us = Some(now);
                                crate::pages::tag_change(tx, &*self.env, &mut page)?;
                                hidden_now.push((page.id.to_string(), now));
                            }
                        }
                    }
                    _ => {}
                }
                if count > 0 {
                    hidden.insert((*table).to_string(), json!(count));
                }
                if count < ids.len() {
                    marked_only.insert((*table).to_string(), json!(ids.len() - count));
                }
                for id in ids {
                    let hid_at = hidden_now.iter().find(|(h, _)| h == id).map(|(_, at)| *at);
                    let key = mark_key(table, id);
                    let mark = match get_json::<MarkRecord>(&*tx, &key)? {
                        None => MarkRecord {
                            source_id: Some(a.source_id.clone()),
                            request_id: a.request_id.clone(),
                            reason: a.reason.clone(),
                            marked_at_us: hid_at.unwrap_or(now),
                        },
                        Some(old) => {
                            let marked_at_us = match hid_at {
                                Some(at) => at,
                                None if keeps_hidden_at(&*tx, table, id, old.marked_at_us)? => {
                                    old.marked_at_us
                                }
                                None => now,
                            };
                            MarkRecord {
                                source_id: old.source_id,
                                request_id: a.request_id.clone(),
                                reason: a.reason.clone(),
                                marked_at_us,
                            }
                        }
                    };
                    put_json(tx, &key, &mark)?;
                }
            }
            Ok(json!({ "hidden": hidden, "markedOnly": marked_only }))
        })
    }

    /// `releaseHiddenMoment(pageId)`: when the page's `needs_rederive` row still holds its
    /// `deleted_at`, moves `marked_at` to the wall clock (`clock_timestamp()`), so the automatic
    /// purge no longer reads the page as hidden only by a purge. Inside a transaction that stamped
    /// `deleted_at` itself the store's wall clock can read the same microsecond; the time then moves
    /// one microsecond past it, as two Postgres clock reads never match in practice.
    pub fn release_hidden_moment(&self, page_id: i64) -> Result<Value> {
        let Ok(id) = u64::try_from(page_id) else {
            return Ok(Value::Null);
        };
        self.write(|tx| {
            let key = mark_key("pages", &id.to_string());
            let Some(mut mark) = get_json::<MarkRecord>(&*tx, &key)? else {
                return Ok(());
            };
            let Some(deleted) =
                crate::pages::read_page_by_id(&*tx, id)?.and_then(|p| p.deleted_at_us)
            else {
                return Ok(());
            };
            if mark.marked_at_us != deleted {
                return Ok(());
            }
            let at = self.env.clock_micros();
            mark.marked_at_us = if at == deleted { deleted + 1 } else { at };
            put_json(tx, &key, &mark)
        })?;
        Ok(Value::Null)
    }

    /// `pageAwaitsRederive(pageId)`: the page exists and a `needs_rederive` row names it.
    pub fn page_awaits_rederive(&self, page_id: i64) -> Result<bool> {
        let Ok(id) = u64::try_from(page_id) else {
            return Ok(false);
        };
        let read = self.read()?;
        Ok(crate::pages::read_page_by_id(&*read, id)?.is_some()
            && awaits_rederive(&*read, "pages", &id.to_string())?)
    }

    /// The rows of `needs_rederive`, for tests: `[derived_table, derived_id, source_id, request_id,
    /// reason, marked_at_us]` in key order.
    #[cfg(test)]
    pub(crate) fn needs_rederive_rows(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        collect_prefix(&*read, &BY_ROW_HEAD, false, usize::MAX)?
            .into_iter()
            .map(|(k, v)| {
                let body = &k[2..];
                let split = body.iter().position(|b| *b == 0).unwrap_or(body.len());
                let mark: MarkRecord = serde_json::from_slice(&v)?;
                Ok(json!([
                    String::from_utf8_lossy(&body[..split]),
                    String::from_utf8_lossy(&body[split + 1..]),
                    mark.source_id,
                    mark.request_id,
                    mark.reason,
                    mark.marked_at_us,
                ]))
            })
            .collect()
    }
}

/// `KEEP_HIDDEN_AT`: an existing `pages` row keeps its time while a page with that id holds it as
/// its `deleted_at`.
fn keeps_hidden_at(read: &dyn KvRead, table: &str, id: &str, marked_at_us: i64) -> Result<bool> {
    if table != "pages" {
        return Ok(false);
    }
    let Some(n) = id.parse::<u64>().ok().filter(|n| n.to_string() == id) else {
        return Ok(false);
    };
    Ok(crate::pages::read_page_by_id(read, n)?
        .is_some_and(|p| p.deleted_at_us == Some(marked_at_us)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;

    fn page(store: &Store, slug: &str) -> u64 {
        let input: PageInput = serde_json::from_value(json!({
            "type": "concept", "title": slug, "compiled_truth": "body",
        }))
        .unwrap();
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        let read = store.read().unwrap();
        crate::pages::read_page(&*read, "default", slug)
            .unwrap()
            .unwrap()
            .id
    }

    fn hide(store: &Store, rows: &[(&str, &str)]) -> Result<Value> {
        let args: HideDerivedRowsArgs = serde_json::from_value(json!({
            "rows": rows.iter().map(|(t, i)| json!({"table": t, "id": i})).collect::<Vec<_>>(),
            "sourceId": "default",
            "requestId": null,
            "reason": "purge",
        }))
        .unwrap();
        store.hide_derived_rows(&args)
    }

    #[test]
    fn a_page_is_hidden_and_marked_and_another_table_is_only_marked() {
        let store = store();
        let id = page(&store, "concepts/a");
        let out = hide(
            &store,
            &[
                ("pages", &id.to_string()),
                ("timeline_entries", "9"),
                ("pages", "777"),
            ],
        )
        .unwrap();
        assert_eq!(
            out,
            json!({"hidden": {"pages": 1}, "markedOnly": {"pages": 1, "timeline_entries": 1}})
        );
        assert!(store.page_awaits_rederive(id as i64).unwrap());
        assert!(!store.page_awaits_rederive(777).unwrap());
        let read = store.read().unwrap();
        let p = crate::pages::read_page_by_id(&*read, id).unwrap().unwrap();
        let rows = store.needs_rederive_rows().unwrap();
        assert_eq!(rows.len(), 3);
        let own = rows.iter().find(|r| r[1] == json!(id.to_string())).unwrap();
        assert_eq!(own[5], json!(p.deleted_at_us.unwrap()));
        assert!(awaits_rederive(&*read, "timeline_entries", "9").unwrap());
    }

    #[test]
    fn release_moves_the_time_off_the_delete_time_once() {
        let store = store();
        let id = page(&store, "concepts/b");
        hide(&store, &[("pages", &id.to_string())]).unwrap();
        store.release_hidden_moment(id as i64).unwrap();
        let first = store.needs_rederive_rows().unwrap()[0][5].clone();
        let read = store.read().unwrap();
        let deleted = crate::pages::read_page_by_id(&*read, id)
            .unwrap()
            .unwrap()
            .deleted_at_us
            .unwrap();
        drop(read);
        assert_ne!(first, json!(deleted));
        // A second mark of a released page is stamped now; a second release changes nothing.
        store.release_hidden_moment(id as i64).unwrap();
        assert_eq!(store.needs_rederive_rows().unwrap()[0][5], first);
    }

    #[test]
    fn a_row_named_twice_and_an_out_of_range_page_id_are_refused() {
        let store = store();
        assert_eq!(
            hide(&store, &[("facts", "1"), ("facts", "1")])
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
        assert_eq!(
            hide(&store, &[("pages", "2147483648")]).unwrap_err().code,
            INVALID_ARGUMENT
        );
        // Another table binds no id, so a large one is only marked.
        assert!(hide(&store, &[("timeline_entries", "2147483648")]).is_ok());
    }

    #[test]
    fn a_source_delete_drops_its_marks() {
        let store = store();
        hide(&store, &[("timeline_entries", "1")]).unwrap();
        store
            .write(|tx| remove_source_marks(tx, "default"))
            .unwrap();
        assert!(store.needs_rederive_rows().unwrap().is_empty());
    }
}
