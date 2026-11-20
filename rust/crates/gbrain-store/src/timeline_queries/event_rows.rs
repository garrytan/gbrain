//! The event projection rows of the Life Chronicle event adapter
//! (`src/core/generations/adapters/chronicle-events.ts`) and its publication
//! (`chronicle/publish.ts`): listEventProjectionRows, readEventProjectionId,
//! deleteEventProjections and restoreEventProjection (`engine-sql/chronicle-events.ts`), over the
//! entries and the event index of the parent module.
//!
//! These are internal reads and writes of derived rows, not caller timeline reads, so they take
//! no page read policy and read soft-deleted pages as Postgres does. Order: the projection rows
//! answer by date, then event page id, where Postgres orders by date only.

use super::{event_index_key, event_index_prefix, event_index_value, indexed_entry};
use crate::Store;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::{read_page, read_page_by_id};
use crate::takes::{int4, not_null};
use crate::timeline::{
    TimelineReceipt, TimelineRecord, TimelineTrust, next_entry_id, parse_date, put_entry,
    recompute_latest, remove_entry,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `listEventProjectionRows(eventPageIds)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventProjectionRowsSpec {
    pub event_page_ids: Vec<f64>,
}

/// `readEventProjectionId(eventPageId, date)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventProjectionIdSpec {
    pub event_page_id: f64,
    pub date: String,
}

/// `deleteEventProjections(sourceId, slugs)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventProjectionSlugsSpec {
    pub source_id: String,
    pub slugs: Vec<String>,
}

/// `restoreEventProjection(row)`. `summary` and `detail` may be null, as a stored preimage may
/// hold null; the insert then fails on the column's NOT NULL.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventProjectionRestoreSpec {
    pub depth_page_id: f64,
    pub date: String,
    pub source: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    pub event_page_id: f64,
}

/// An `integer` (int4) page id; refused as `invalid_argument` as the parameter cast refuses it.
fn page_id(op: &str, column: &str, value: f64) -> Result<i32> {
    int4(&json!(value), op, column)?
        .ok_or_else(|| StoreError::invalid(format!("{op}: {column} is required")))
}

/// The projections indexed for `event_page_id`, by date.
fn projections_of(
    read: &dyn KvRead,
    event_page_id: u64,
) -> Result<Vec<(Vec<u8>, Option<TimelineRecord>)>> {
    let prefix = event_index_prefix(event_page_id);
    let mut rows: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, v| {
        rows.push((k.to_vec(), v.to_vec()));
        true
    })?;
    rows.into_iter()
        .map(|(key, value)| {
            let date = String::from_utf8_lossy(&key[prefix.len()..]).into_owned();
            Ok((key, indexed_entry(read, &value, event_page_id, &date)?))
        })
        .collect()
}

/// Writes the projection of `event_id` on `date` with depth page `depth_id`: inserts entry `id`,
/// or, when the event index names a stored projection, updates its page, source, summary and
/// detail and keeps its id and `created_at` (`ON CONFLICT (event_page_id, date) DO UPDATE`).
/// `date` is already parsed. Shared by `upsertEventProjection` and `restoreEventProjection`.
#[allow(clippy::too_many_arguments)]
pub(super) fn put_event_projection(
    tx: &mut dyn KvWrite,
    depth_id: u64,
    event_id: u64,
    date: &str,
    source: &str,
    summary: &str,
    detail: &str,
    id: u64,
    now: i64,
) -> Result<()> {
    let index = event_index_key(event_id, date);
    let old = match tx.get(&index)? {
        Some(value) => indexed_entry(&*tx, &value, event_id, date)?,
        None => None,
    };
    let new = match &old {
        Some(old) => TimelineRecord {
            page_id: depth_id,
            source: source.to_string(),
            summary: summary.to_string(),
            detail: detail.to_string(),
            ..old.clone()
        },
        None => TimelineRecord {
            id,
            page_id: depth_id,
            date: date.to_string(),
            source: source.to_string(),
            summary: summary.to_string(),
            detail: detail.to_string(),
            event_page_id: Some(event_id),
            created_at_us: now,
            receipt: TimelineReceipt::default(),
            trust: TimelineTrust::default(),
        },
    };
    put_entry(tx, old.as_ref(), &new)?;
    tx.put(&index, &event_index_value(&new))
}

impl Store {
    /// `listEventProjectionRows(eventPageIds)`: `{ event_page_id, date, summary, detail }` of
    /// every projection of the event pages `eventPageIds`, by date.
    pub fn list_event_projection_rows(&self, spec: &EventProjectionRowsSpec) -> Result<Vec<Value>> {
        const OP: &str = "listEventProjectionRows";
        let mut ids = BTreeSet::new();
        for id in &spec.event_page_ids {
            if let Ok(id) = u64::try_from(page_id(OP, "eventPageIds", *id)?) {
                ids.insert(id);
            }
        }
        let read = self.read()?;
        let mut rows = Vec::new();
        for id in ids {
            for (_, entry) in projections_of(&*read, id)? {
                if let Some(entry) = entry {
                    rows.push((entry.date.clone(), id, entry));
                }
            }
        }
        rows.sort_by(|a, b| (&a.0, a.1).cmp(&(&b.0, b.1)));
        Ok(rows
            .into_iter()
            .map(|(date, id, entry)| {
                json!({ "event_page_id": id, "date": date, "summary": entry.summary, "detail": entry.detail })
            })
            .collect())
    }

    /// `readEventProjectionId(eventPageId, date)`: the id of the projection of the event page on
    /// `date`, or null. A bad date fails.
    pub fn read_event_projection_id(&self, spec: &EventProjectionIdSpec) -> Result<Option<u64>> {
        const OP: &str = "readEventProjectionId";
        let date = parse_date(&spec.date)?;
        let Ok(event_page_id) = u64::try_from(page_id(OP, "eventPageId", spec.event_page_id)?)
        else {
            return Ok(None);
        };
        let read = self.read()?;
        let Some(value) = read.get(&event_index_key(event_page_id, &date))? else {
            return Ok(None);
        };
        Ok(indexed_entry(&*read, &value, event_page_id, &date)?.map(|entry| entry.id))
    }

    /// `deleteEventProjections(sourceId, slugs)`: deletes every projection whose event page is at
    /// a slug of `slugs` in `sourceId` (soft-deleted pages count), with its `D` key when that
    /// still points at it and its index row, then recomputes `G` of each depth page touched.
    pub fn delete_event_projections(&self, spec: &EventProjectionSlugsSpec) -> Result<()> {
        const OP: &str = "deleteEventProjections";
        no_nul(OP, &[("sourceId", &spec.source_id)])?;
        let mut slugs = BTreeSet::new();
        for slug in &spec.slugs {
            no_nul(OP, &[("slugs", slug)])?;
            slugs.insert(slug.as_str());
        }
        if slugs.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            let mut touched = BTreeSet::new();
            for slug in &slugs {
                let Some(event) = read_page(&*tx, &spec.source_id, slug)? else {
                    continue;
                };
                for (index, entry) in projections_of(&*tx, event.id)? {
                    if let Some(entry) = entry {
                        remove_entry(tx, &entry)?;
                        touched.insert(entry.page_id);
                    }
                    tx.delete(&index)?;
                }
            }
            for page_id in touched {
                recompute_latest(tx, page_id)?;
            }
            Ok(())
        })
    }

    /// `restoreEventProjection(row)`: `INSERT ... VALUES ... ON CONFLICT (event_page_id, date) DO
    /// UPDATE` of summary, detail, page and source. A null summary or detail fails the NOT NULL,
    /// a missing depth or event page fails the foreign key, and a bad date fails first. The
    /// serial is taken on the conflict path too, and the update keeps the entry's id and
    /// `created_at`.
    pub fn restore_event_projection(&self, spec: &EventProjectionRestoreSpec) -> Result<()> {
        const OP: &str = "restoreEventProjection";
        let depth = page_id(OP, "depthPageId", spec.depth_page_id)?;
        let event = page_id(OP, "eventPageId", spec.event_page_id)?;
        let date = parse_date(&spec.date)?;
        let summary = spec
            .summary
            .as_deref()
            .ok_or_else(|| not_null("timeline_entries", "summary"))?;
        let detail = spec
            .detail
            .as_deref()
            .ok_or_else(|| not_null("timeline_entries", "detail"))?;
        no_nul(
            OP,
            &[
                ("source", &spec.source),
                ("summary", summary),
                ("detail", detail),
            ],
        )?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let id = next_entry_id(tx)?;
            for (column, value) in [("page_id", depth), ("event_page_id", event)] {
                let found = match u64::try_from(value) {
                    Ok(value) => read_page_by_id(&*tx, value)?.is_some(),
                    Err(_) => false,
                };
                if !found {
                    return Err(StoreError::new(
                        CONSTRAINT_VIOLATION,
                        format!(
                            "insert or update on table \"timeline_entries\" violates foreign key constraint on {column}: page {value} does not exist"
                        ),
                    ));
                }
            }
            put_event_projection(
                tx,
                depth as u64,
                event as u64,
                &date,
                &spec.source,
                summary,
                detail,
                id,
                now,
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::INVALID_ARGUMENT;
    use crate::keys;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;
    use crate::timeline::latest_entry_micros;

    fn every_index_row(read: &dyn KvRead) -> usize {
        let mut n = 0;
        scan_prefix(
            read,
            &[keys::TIMELINE_QUERIES, super::super::EVENT_INDEX],
            false,
            &mut |_, _| {
                n += 1;
                true
            },
        )
        .unwrap();
        n
    }

    fn page(store: &Store, slug: &str) -> u64 {
        let input: PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": "body",
        }))
        .unwrap();
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap()["id"]
            .as_u64()
            .unwrap()
    }

    fn restore(depth: u64, event: u64, date: &str, summary: &str) -> EventProjectionRestoreSpec {
        EventProjectionRestoreSpec {
            depth_page_id: depth as f64,
            date: date.into(),
            source: format!("life-chronicle:event:{event}"),
            summary: Some(summary.into()),
            detail: Some(format!("detail {summary}")),
            event_page_id: event as f64,
        }
    }

    fn rows(store: &Store, ids: &[u64]) -> Vec<Value> {
        store
            .list_event_projection_rows(&EventProjectionRowsSpec {
                event_page_ids: ids.iter().map(|id| *id as f64).collect(),
            })
            .unwrap()
    }

    fn id_of(store: &Store, event: u64, date: &str) -> Option<u64> {
        store
            .read_event_projection_id(&EventProjectionIdSpec {
                event_page_id: event as f64,
                date: date.into(),
            })
            .unwrap()
    }

    #[test]
    fn restore_inserts_then_updates_in_place_and_rows_read_by_date() {
        let store = store();
        let depth = page(&store, "people/a");
        let other = page(&store, "people/b");
        let e1 = page(&store, "events/1");
        let e2 = page(&store, "events/2");
        store
            .restore_event_projection(&restore(depth, e1, "2026-03-02", "one"))
            .unwrap();
        store
            .restore_event_projection(&restore(depth, e2, "2026-03-01", "two"))
            .unwrap();
        let first = id_of(&store, e1, "2026-03-02").unwrap();
        store
            .restore_event_projection(&restore(other, e1, "2026/03/02", "uno"))
            .unwrap();
        assert_eq!(id_of(&store, e1, "2026-03-02"), Some(first));
        assert_eq!(id_of(&store, e1, "2026-03-03"), None);
        assert_eq!(
            rows(&store, &[e1, e2, e1, 999]),
            vec![
                json!({ "event_page_id": e2, "date": "2026-03-01", "summary": "two", "detail": "detail two" }),
                json!({ "event_page_id": e1, "date": "2026-03-02", "summary": "uno", "detail": "detail uno" }),
            ]
        );
        let read = store.read().unwrap();
        assert!(latest_entry_micros(&*read, other).unwrap().is_some());
    }

    #[test]
    fn restore_refuses_null_columns_missing_pages_and_bad_dates() {
        let store = store();
        let depth = page(&store, "people/a");
        let event = page(&store, "events/1");
        let mut spec = restore(depth, event, "2026-03-02", "one");
        spec.detail = None;
        assert_eq!(
            store.restore_event_projection(&spec).unwrap_err().code,
            CONSTRAINT_VIOLATION
        );
        assert_eq!(
            store
                .restore_event_projection(&restore(depth, 999, "2026-03-02", "one"))
                .unwrap_err()
                .code,
            CONSTRAINT_VIOLATION
        );
        assert_eq!(
            store
                .restore_event_projection(&restore(depth, event, "march", "one"))
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
        let mut fraction = restore(depth, event, "2026-03-02", "one");
        fraction.depth_page_id = 1.5;
        assert_eq!(
            store.restore_event_projection(&fraction).unwrap_err().code,
            INVALID_ARGUMENT
        );
        assert!(rows(&store, &[event]).is_empty());
    }

    #[test]
    fn delete_removes_projections_of_the_slugs_and_lowers_latest() {
        let store = store();
        let depth = page(&store, "people/a");
        let e1 = page(&store, "events/1");
        let e2 = page(&store, "events/2");
        store
            .restore_event_projection(&restore(depth, e1, "2026-03-02", "one"))
            .unwrap();
        store
            .restore_event_projection(&restore(depth, e2, "2026-03-01", "two"))
            .unwrap();
        store.soft_delete_page("events/1", None).unwrap();
        let spec = |slugs: &[&str]| EventProjectionSlugsSpec {
            source_id: "default".into(),
            slugs: slugs.iter().map(|s| s.to_string()).collect(),
        };
        store
            .delete_event_projections(&spec(&["events/1", "events/z"]))
            .unwrap();
        assert_eq!(id_of(&store, e1, "2026-03-02"), None);
        assert_eq!(rows(&store, &[e1, e2]).len(), 1);
        store
            .delete_event_projections(&spec(&["events/2"]))
            .unwrap();
        let read = store.read().unwrap();
        assert_eq!(every_index_row(&*read), 0);
        assert_eq!(latest_entry_micros(&*read, depth).unwrap(), None);
    }
}
