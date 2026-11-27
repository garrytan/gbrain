//! The parks and owed-purge records of a derived-origin purge (src/core/engine-sql/origin-holds.ts): `listPurgeOrigins`,
//! `upsertDerivedOriginPark`, `recordOwedPurgeRows` and `deleteOriginHoldRows` (rust/docs/store/label_door.md, "The purge's
//! origin parks and owed-purge records").
//!
//! Both records are `op_checkpoints` parents (`op_checkpoint.rs`, key `d 0x02 <op> 0x00 <page id>`, the same JSON row as a
//! housekeeping turn), whose `completed_keys` is the one-element array `[document]` the SQL statements read at `completed_keys -> 0`:
//!
//! - the park, op `derived-origin-park`: the page, the blocking page, the code and reason, and the owner's purge it holds;
//! - the owed record, op `owed-page-purge`: `{ source_id, page_id, deleted_us, request_id }` for the page's current tombstone,
//!   with `deleted_us` as `floor(extract(epoch FROM deleted_at) * 1000000)::bigint::text`, the tombstone's microseconds in text.
//!
//! Every write runs in one store write, so on a store bound to a purge transaction it is part of that transaction.

use super::housekeeping::HousekeepingRow;
use super::op_checkpoint::{delete_op_checkpoint_in, parent_key};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::label_door::is_origin;
use crate::links::no_nul;
use crate::pages::read_page_by_id;
use crate::{get_json, put_json};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

const PARK_OP: &str = "derived-origin-park";
const OWED_OP: &str = "owed-page-purge";

/// One row of `listPurgeOrigins`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PurgeOrigin {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
}

/// `jsonb` refuses `\u0000`, as the SQL's `$3::text::jsonb` parse does.
pub(super) fn has_nul(v: &Value) -> bool {
    match v {
        Value::String(t) => t.contains('\0'),
        Value::Array(items) => items.iter().any(has_nul),
        Value::Object(map) => map.iter().any(|(k, v)| k.contains('\0') || has_nul(v)),
        _ => false,
    }
}

/// `completed_keys -> 0`: the first element of an array, else none (`->` on anything else is SQL NULL).
pub(super) fn first_doc(row: &HousekeepingRow) -> Option<&Value> {
    match &row.completed_keys {
        Value::Array(items) => items.first(),
        _ => None,
    }
}

/// `->>` of a document's field: a string is its text, JSON null and a missing field are SQL NULL, anything else its JSON text.
pub(super) fn field_text(doc: &Value, name: &str) -> Option<String> {
    match doc.get(name) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

impl Store {
    /// `listPurgeOrigins(ids, recheckParked)`: the pages among `ids` that are privacy origins, by id; unless `recheck_parked`,
    /// the ones an origin park holds are left out.
    pub fn list_purge_origins(
        &self,
        ids: &[i64],
        recheck_parked: bool,
        honor_aliases: bool,
    ) -> Result<Vec<PurgeOrigin>> {
        let read = self.read()?;
        let read: &dyn KvRead = &*read;
        let wanted: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let mut out = Vec::new();
        for id in wanted {
            let Some(page) = read_page_by_id(read, id)? else {
                continue;
            };
            if !is_origin(read, &page, honor_aliases)? {
                continue;
            }
            if !recheck_parked
                && get_json::<HousekeepingRow>(read, &parent_key(PARK_OP, &id.to_string())?)?
                    .is_some()
            {
                continue;
            }
            out.push(PurgeOrigin {
                id: page.id,
                source_id: page.source_id.clone(),
                slug: page.slug.clone(),
            });
        }
        Ok(out)
    }

    /// `upsertDerivedOriginPark(pageId, park)`: the park document stored as `[park]`, stamped now. A park of the same page that
    /// held an owner's purge (`held_request_id`) keeps it and its tombstone (`held_deleted_us`) when the new document names no
    /// `held_request_id`; otherwise the new document replaces the old.
    pub fn upsert_derived_origin_park(&self, page_id: i64, park: &Value) -> Result<()> {
        if has_nul(park) {
            return Err(StoreError::invalid(
                "an op checkpoint document cannot contain NUL",
            ));
        }
        let key = parent_key(PARK_OP, &page_id.to_string())?;
        self.write(|tx| {
            let mut doc = park.clone();
            if let Some(old) = get_json::<HousekeepingRow>(&*tx, &key)? {
                let kept = first_doc(&old)
                    .and_then(Value::as_object)
                    .filter(|o| o.contains_key("held_request_id"));
                if let (Some(old_doc), Some(new_doc)) = (kept, doc.as_object_mut())
                    && !new_doc.contains_key("held_request_id")
                {
                    // `jsonb_strip_nulls(jsonb_build_object(...))` over the two held fields, merged over the new document.
                    let mut held = Map::new();
                    for name in ["held_request_id", "held_deleted_us"] {
                        match old_doc.get(name) {
                            None | Some(Value::Null) => {}
                            Some(v) => {
                                held.insert(name.to_string(), v.clone());
                            }
                        }
                    }
                    new_doc.extend(held);
                }
            }
            put_json(
                tx,
                &key,
                &HousekeepingRow {
                    completed_keys: json!([crate::jsonb::ordered(&doc)]),
                    updated_at_us: self.env.now_micros(),
                },
            )
        })
    }

    /// `recordOwedPurgeRows(pageId, requestId)`: `{ owed, held }`. The owed record of the page's current tombstone (none for a
    /// page that is not one; a record already for that tombstone stays), and the park that holds `request_id` bound to the tombstone.
    pub fn record_owed_purge_rows(&self, page_id: i64, request_id: &str) -> Result<Value> {
        no_nul("recordOwedPurgeRows", &[("requestId", request_id)])?;
        let Ok(id) = u64::try_from(page_id) else {
            return Ok(json!({ "owed": 0, "held": 0 }));
        };
        self.write(|tx| {
            let tombstone = match read_page_by_id(&*tx, id)? {
                Some(page) => page.deleted_at_us.map(|at| (page.source_id.clone(), page.id, at)),
                None => None,
            };
            let Some((source_id, page_id, deleted_at_us)) = tombstone else {
                return Ok(json!({ "owed": 0, "held": 0 }));
            };
            // `floor(extract(epoch FROM deleted_at) * 1000000)::bigint::text`.
            let deleted_us = deleted_at_us.to_string();
            let fingerprint = id.to_string();
            let mut owed = 0;
            let owed_key = parent_key(OWED_OP, &fingerprint)?;
            let current = get_json::<HousekeepingRow>(&*tx, &owed_key)?;
            let same = current
                .as_ref()
                .and_then(first_doc)
                .and_then(|doc| field_text(doc, "deleted_us"))
                .is_some_and(|old| old == deleted_us);
            if !same {
                let doc = json!({ "source_id": source_id, "page_id": page_id, "deleted_us": deleted_us, "request_id": request_id });
                put_json(
                    tx,
                    &owed_key,
                    &HousekeepingRow {
                        completed_keys: json!([crate::jsonb::ordered(&doc)]),
                        updated_at_us: self.env.now_micros(),
                    },
                )?;
                owed = 1;
            }
            let mut held = 0;
            let park_key = parent_key(PARK_OP, &fingerprint)?;
            if let Some(mut park) = get_json::<HousekeepingRow>(&*tx, &park_key)? {
                let holds = first_doc(&park)
                    .filter(|doc| doc.is_object())
                    .and_then(|doc| field_text(doc, "held_request_id"))
                    .is_some_and(|held_id| held_id == request_id);
                if holds && let Value::Array(items) = &mut park.completed_keys
                    && let Some(Value::Object(doc)) = items.first_mut()
                {
                    doc.insert("held_deleted_us".into(), Value::String(deleted_us.clone()));
                    park.completed_keys = crate::jsonb::ordered(&park.completed_keys);
                    park.updated_at_us = self.env.now_micros();
                    put_json(tx, &park_key, &park)?;
                    held = 1;
                }
            }
            Ok(json!({ "owed": owed, "held": held }))
        })
    }

    /// `deleteOriginHoldRows(op, pageIds)`: removes the records of `op` (the park or the owed record) for these pages, and how
    /// many it removed. Any other op is refused.
    pub fn delete_origin_hold_rows(&self, op: &str, page_ids: &[i64]) -> Result<i64> {
        if op != PARK_OP && op != OWED_OP {
            return Err(StoreError::invalid(format!(
                "deleteOriginHoldRows: op must be {PARK_OP} or {OWED_OP}, not {op}"
            )));
        }
        self.write(|tx| {
            let mut removed = 0;
            for id in page_ids {
                let fingerprint = id.to_string();
                if tx.get(&parent_key(op, &fingerprint)?)?.is_some() {
                    removed += 1;
                }
                delete_op_checkpoint_in(tx, op, &fingerprint)?;
            }
            Ok(removed)
        })
    }
}
