//! The timeline part of the twin merge (`mergeTwinInto`, src/core/engine-sql/twin-merge.ts
//! `moveTwinPageRows`): the twin's rows and the event projections that name it move to the survivor.
//!
//! In statement order:
//! 1. A row of the twin that repeats a survivor row (same date, summary and source) is deleted; the
//!    rest move to the survivor (`page_id`), keeping id, `created_at` and detail.
//! 2. A projection of the twin as event page whose date the survivor already has is deleted; the
//!    rest name the survivor (`event_page_id`).
//!
//! A moved row is rewritten through [`put_entry`] with the old row as its preimage, as an `UPDATE`
//! is; the event index follows each row it names, and the newest `created_at` of the pages the rows
//! left is recomputed.

use super::{event_index_key, event_index_value, indexed_entry};
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::timeline::{TimelineRecord, put_entry, recompute_latest, remove_entry};
use std::collections::BTreeSet;

/// The timeline rows of `page_id` (event projections included), in key order.
fn rows_of(read: &dyn KvRead, page_id: u64) -> Result<Vec<TimelineRecord>> {
    let mut rows = Vec::new();
    let mut failure = None;
    scan_prefix(read, &keys::timeline_prefix(page_id), false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(row) => rows.push(row),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(rows), Err)
}

/// Drops the event index entry of `entry` when it still names that entry.
fn unindex(tx: &mut dyn KvWrite, entry: &TimelineRecord) -> Result<()> {
    let Some(event) = entry.event_page_id else {
        return Ok(());
    };
    let index = event_index_key(event, &entry.date);
    if tx.get(&index)?.as_deref() == Some(event_index_value(entry).as_slice()) {
        tx.delete(&index)?;
    }
    Ok(())
}

/// Whether the twin holds a timeline row or an event projection the move would point at the survivor.
pub(crate) fn twin_has_timeline(read: &dyn KvRead, twin: u64) -> Result<bool> {
    Ok(!rows_of(read, twin)?.is_empty()
        || super::event_rows::projections_of(read, twin)?
            .iter()
            .any(|(_, entry)| entry.is_some()))
}

/// Moves the twin's timeline rows and event projections to the survivor (see the module doc).
pub(crate) fn move_twin_timeline(tx: &mut dyn KvWrite, twin: u64, survivor: u64) -> Result<()> {
    let mut touched: BTreeSet<u64> = BTreeSet::from([twin]);
    let kept = rows_of(&*tx, survivor)?;
    for old in rows_of(&*tx, twin)? {
        let repeats = kept
            .iter()
            .any(|o| o.date == old.date && o.summary == old.summary && o.source == old.source);
        if repeats {
            unindex(tx, &old)?;
            remove_entry(tx, &old)?;
            continue;
        }
        let new = TimelineRecord {
            page_id: survivor,
            ..old.clone()
        };
        let indexed = old.event_page_id.map(|e| event_index_key(e, &old.date));
        let points_here = match &indexed {
            Some(index) => tx.get(index)?.as_deref() == Some(event_index_value(&old).as_slice()),
            None => false,
        };
        put_entry(tx, Some(&old), &new)?;
        if let (Some(index), true) = (indexed, points_here) {
            tx.put(&index, &event_index_value(&new))?;
        }
    }
    for (key, entry) in super::event_rows::projections_of(&*tx, twin)? {
        let Some(old) = entry else {
            continue;
        };
        let taken = match tx.get(&event_index_key(survivor, &old.date))? {
            Some(value) => indexed_entry(&*tx, &value, survivor, &old.date)?.is_some(),
            None => false,
        };
        tx.delete(&key)?;
        if taken {
            remove_entry(tx, &old)?;
            touched.insert(old.page_id);
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
