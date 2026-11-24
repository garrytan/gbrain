//! The timeline half of the twin merge's `moveTwinPageChildren` (src/core/engine-sql/twin-merge-moves.ts), in its
//! four statements' order:
//!
//! 1. delete the twin's own entries (a row of the twin page, an event projection it holds included) that the survivor
//!    repeats on `(date, summary, source)`;
//! 2. move the rest to the survivor page (`page_id`);
//! 3. delete the entries that project the twin as their event page when the survivor already has an event entry on
//!    that date;
//! 4. point the rest at the survivor as their event page (`event_page_id`).
//!
//! Every write goes through the core timeline helpers: `remove_entry` (the `E` key and the `D` key it still holds) and
//! `put_entry` (a moved entry's stamps, as the update trigger leaves them, and the `D` key's unique check), and the event
//! index (`u 0x01 event date`) follows each moved or removed projection. The `G` key of every page that lost or gained
//! an entry is recomputed from the rows it holds, as `MAX(created_at)` is.

use std::collections::BTreeSet;

use super::{event_index_key, event_index_prefix, event_index_value, indexed_entry};
use crate::error::Result;
use crate::keys;
use crate::kv::{KvWrite, scan_prefix};
use crate::timeline::{TimelineRecord, put_entry, recompute_latest, remove_entry};

/// The entries of page `page_id`, event projections included, by key (date, id).
pub(super) fn page_entries(
    tx: &dyn crate::kv::KvRead,
    page_id: u64,
) -> Result<Vec<TimelineRecord>> {
    let mut raw = Vec::new();
    scan_prefix(tx, &keys::timeline_prefix(page_id), false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(crate::error::StoreError::from))
        .collect()
}

/// The projections of `event_page_id` the event index names, with the date each is indexed under, by date.
pub(super) fn projections(
    tx: &dyn crate::kv::KvRead,
    event_page_id: u64,
) -> Result<Vec<TimelineRecord>> {
    let prefix = event_index_prefix(event_page_id);
    let mut rows = Vec::new();
    scan_prefix(tx, &prefix, false, &mut |k, v| {
        rows.push((k[prefix.len()..].to_vec(), v.to_vec()));
        true
    })?;
    let mut out = Vec::new();
    for (date, value) in rows {
        let date = String::from_utf8_lossy(&date).into_owned();
        if let Some(entry) = indexed_entry(tx, &value, event_page_id, &date)? {
            out.push(entry);
        }
    }
    Ok(out)
}

/// Drops the event index row of `entry` when it still names the entry.
fn drop_index_row(tx: &mut dyn KvWrite, entry: &TimelineRecord) -> Result<()> {
    if let Some(event) = entry.event_page_id {
        let key = event_index_key(event, &entry.date);
        if tx.get(&key)?.as_deref() == Some(event_index_value(entry).as_slice()) {
            tx.delete(&key)?;
        }
    }
    Ok(())
}

/// The foreign key a timeline move onto a missing survivor would break, in statement order: `page_id` when the twin
/// holds an entry, else `event_page_id` when an event projection names it, else none.
pub(crate) fn twin_timeline_reference(
    read: &dyn crate::kv::KvRead,
    twin: u64,
) -> Result<Option<&'static str>> {
    if !page_entries(read, twin)?.is_empty() {
        return Ok(Some("page_id"));
    }
    Ok((!projections(read, twin)?.is_empty()).then_some("event_page_id"))
}

/// Moves the twin's timeline entries to the survivor (the module docs). The caller has refused equal ids.
pub(crate) fn move_twin_timeline(tx: &mut dyn KvWrite, twin: u64, survivor: u64) -> Result<()> {
    let mut touched: BTreeSet<u64> = BTreeSet::from([twin, survivor]);
    let held = page_entries(&*tx, survivor)?;
    let mut moving = Vec::new();
    for entry in page_entries(&*tx, twin)? {
        let repeated = held.iter().any(|o| {
            o.date == entry.date && o.summary == entry.summary && o.source == entry.source
        });
        if repeated {
            drop_index_row(tx, &entry)?;
            remove_entry(tx, &entry)?;
        } else {
            moving.push(entry);
        }
    }
    for old in moving {
        let new = TimelineRecord {
            page_id: survivor,
            ..old.clone()
        };
        put_entry(tx, Some(&old), &new)?;
        if let Some(event) = new.event_page_id {
            tx.put(&event_index_key(event, &new.date), &event_index_value(&new))?;
        }
    }
    let held_dates: BTreeSet<String> = projections(&*tx, survivor)?
        .into_iter()
        .map(|e| e.date)
        .collect();
    for old in projections(&*tx, twin)? {
        drop_index_row(tx, &old)?;
        if held_dates.contains(&old.date) {
            touched.insert(old.page_id);
            remove_entry(tx, &old)?;
            continue;
        }
        let new = TimelineRecord {
            event_page_id: Some(survivor),
            ..old.clone()
        };
        put_entry(tx, Some(&old), &new)?;
        tx.put(
            &event_index_key(survivor, &new.date),
            &event_index_value(&new),
        )?;
    }
    for page in touched {
        recompute_latest(tx, page)?;
    }
    Ok(())
}
