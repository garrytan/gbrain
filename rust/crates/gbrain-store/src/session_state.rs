//! Ambient recall session state: the `session_context_state` table of the PGLite engine (migration
//! v126), which keeps one row per `(source_id, client_id, session_id)` for the `delta` verb's
//! cursors, the context pack's standing entities and the compaction harvest's checkpoint manifest
//! (`engine-sql/session-state.ts`, callers in `context/session-state.ts`).
//!
//! Members: readSessionContextState, readDeltaSessionRow, readCheckpointManifest,
//! upsertSessionContextRow, writeCheckpointManifest, gcSessionContextRows.
//!
//! Keys (every record starts with `keys::SESSION_STATE`, `x`):
//! - `x 0x01 source_id \0 client_id \0 session_id` -> [`SessionRow`] (JSON).
//!
//! The table has no foreign key, so a page or source delete leaves the rows, as in Postgres; the
//! GC ages them out. Timestamps are kept as microseconds and answered as ISO UTC text at
//! microsecond precision, as the SQL's `to_char` projects them. The jsonb columns are kept as the
//! JSON the caller sent.
//!
//! The GC deletes rows not updated within the age, then keeps the newest `max_rows_per_client`
//! rows of each `(source_id, client_id)`. Postgres breaks an `updated_at` tie in no stated order;
//! the store keeps the lower session id, in byte order.

use crate::alias_fanout_reads::reject_nul;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::persistence::projection_queue::parse_timestamptz;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const ROW: u8 = 0x01;
const DAY_US: f64 = 86_400_000_000.0;

/// One row: the table's columns less the key.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionRow {
    standing_entities: Value,
    surfaced_slugs: Value,
    last_wake_at_us: Option<i64>,
    facts_cursor_at_us: Option<i64>,
    facts_cursor_id: Option<i64>,
    degraded_wakes: i64,
    checkpoint_manifest: Value,
    updated_at_us: i64,
}

impl SessionRow {
    /// The column defaults of a new row.
    fn fresh(now: i64) -> Self {
        SessionRow {
            standing_entities: json!([]),
            surfaced_slugs: json!([]),
            last_wake_at_us: None,
            facts_cursor_at_us: None,
            facts_cursor_id: None,
            degraded_wakes: 0,
            checkpoint_manifest: json!([]),
            updated_at_us: now,
        }
    }
}

/// `upsertSessionContextRow`'s write (`SessionContextWrite` in engine-sql/session-state.ts). A
/// null field keeps the stored value on an update.
#[derive(Debug, Clone, Deserialize)]
pub struct SessionWrite {
    #[serde(default)]
    pub standing_entities: Option<Vec<String>>,
    #[serde(default)]
    pub cursor_slug: Option<String>,
    #[serde(default)]
    pub last_wake_at: Option<String>,
    #[serde(default)]
    pub facts_cursor_at: Option<String>,
    #[serde(default)]
    pub facts_cursor_id: Option<i64>,
    /// `increment`, `reset`, or anything else to keep the counter.
    pub degraded_wakes: String,
}

fn row_key(source_id: &str, client_id: &str, session_id: &str) -> Vec<u8> {
    let mut key = vec![keys::SESSION_STATE, ROW];
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key.extend_from_slice(client_id.as_bytes());
    key.push(0);
    key.extend_from_slice(session_id.as_bytes());
    key
}

fn read_row(
    read: &dyn KvRead,
    source_id: &str,
    client_id: &str,
    session_id: &str,
) -> Result<Option<SessionRow>> {
    get_json(read, &row_key(source_id, client_id, session_id))
}

/// Postgres refuses a NUL in text and the `\u0000` escape in jsonb.
fn reject_nul_in_json(member: &str, value: &Value) -> Result<()> {
    match value {
        Value::String(s) => reject_nul(member, [s.as_str()]),
        Value::Array(items) => items.iter().try_for_each(|v| reject_nul_in_json(member, v)),
        Value::Object(map) => map.iter().try_for_each(|(k, v)| {
            reject_nul(member, [k.as_str()])?;
            reject_nul_in_json(member, v)
        }),
        _ => Ok(()),
    }
}

fn timestamp(text: &Option<String>, what: &str) -> Result<Option<i64>> {
    text.as_deref()
        .map(|t| parse_timestamptz(t, what))
        .transpose()
}

impl Store {
    /// `readSessionContextState`: `{ standing_entities, surfaced_slugs, last_wake_at }` of the
    /// row, or null when there is none.
    pub fn read_session_context_state(
        &self,
        source_id: &str,
        client_id: &str,
        session_id: &str,
    ) -> Result<Option<Value>> {
        reject_nul(
            "readSessionContextState",
            [source_id, client_id, session_id],
        )?;
        let read = self.read()?;
        Ok(
            read_row(&*read, source_id, client_id, session_id)?.map(|r| {
                json!({
                    "standing_entities": r.standing_entities,
                    "surfaced_slugs": r.surfaced_slugs,
                    "last_wake_at": r.last_wake_at_us.map(iso),
                })
            }),
        )
    }

    /// `readDeltaSessionRow`: `{ surfaced_slugs, last_wake_at, facts_cursor_at,
    /// facts_cursor_id, degraded_wakes }` of the row, or null when there is none.
    pub fn read_delta_session_row(
        &self,
        source_id: &str,
        client_id: &str,
        session_id: &str,
    ) -> Result<Option<Value>> {
        reject_nul("readDeltaSessionRow", [source_id, client_id, session_id])?;
        let read = self.read()?;
        Ok(
            read_row(&*read, source_id, client_id, session_id)?.map(|r| {
                json!({
                    "surfaced_slugs": r.surfaced_slugs,
                    "last_wake_at": r.last_wake_at_us.map(iso),
                    "facts_cursor_at": r.facts_cursor_at_us.map(iso),
                    "facts_cursor_id": r.facts_cursor_id,
                    "degraded_wakes": r.degraded_wakes,
                })
            }),
        )
    }

    /// `readCheckpointManifest`: `{ checkpoint_manifest }` of the row, or null when there is none.
    pub fn read_checkpoint_manifest(
        &self,
        source_id: &str,
        client_id: &str,
        session_id: &str,
    ) -> Result<Option<Value>> {
        reject_nul("readCheckpointManifest", [source_id, client_id, session_id])?;
        let read = self.read()?;
        Ok(read_row(&*read, source_id, client_id, session_id)?
            .map(|r| json!({ "checkpoint_manifest": r.checkpoint_manifest })))
    }

    /// `upsertSessionContextRow`: inserts the row or updates it as the single SQL statement does;
    /// returns the stored `degraded_wakes`.
    pub fn upsert_session_context_row(
        &self,
        source_id: &str,
        client_id: &str,
        session_id: &str,
        write: &SessionWrite,
    ) -> Result<i64> {
        const MEMBER: &str = "upsertSessionContextRow";
        reject_nul(MEMBER, [source_id, client_id, session_id])?;
        if let Some(entities) = &write.standing_entities {
            reject_nul(MEMBER, entities.iter().map(String::as_str))?;
        }
        if let Some(slug) = &write.cursor_slug {
            reject_nul(MEMBER, [slug.as_str()])?;
        }
        let last_wake = timestamp(&write.last_wake_at, "lastWakeAt")?;
        let facts_at = timestamp(&write.facts_cursor_at, "factsCursor.at")?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let key = row_key(source_id, client_id, session_id);
            let row = match get_json::<SessionRow>(&*tx, &key)? {
                None => SessionRow {
                    standing_entities: json!(write.standing_entities.clone().unwrap_or_default()),
                    surfaced_slugs: json!(write.cursor_slug.iter().collect::<Vec<_>>()),
                    last_wake_at_us: last_wake,
                    facts_cursor_at_us: facts_at,
                    facts_cursor_id: write.facts_cursor_id,
                    degraded_wakes: i64::from(write.degraded_wakes == "increment"),
                    ..SessionRow::fresh(now)
                },
                Some(old) => SessionRow {
                    standing_entities: match &write.standing_entities {
                        Some(e) => json!(e),
                        None => old.standing_entities,
                    },
                    surfaced_slugs: match &write.cursor_slug {
                        Some(s) => json!([s]),
                        None => old.surfaced_slugs,
                    },
                    last_wake_at_us: last_wake.or(old.last_wake_at_us),
                    facts_cursor_at_us: facts_at.or(old.facts_cursor_at_us),
                    facts_cursor_id: if facts_at.is_none() {
                        old.facts_cursor_id
                    } else {
                        write.facts_cursor_id
                    },
                    degraded_wakes: match write.degraded_wakes.as_str() {
                        "increment" => old
                            .degraded_wakes
                            .checked_add(1)
                            .filter(|n| *n <= i64::from(i32::MAX))
                            .ok_or_else(|| {
                                StoreError::invalid(format!("{MEMBER}: integer out of range"))
                            })?,
                        "reset" => 0,
                        _ => old.degraded_wakes,
                    },
                    checkpoint_manifest: old.checkpoint_manifest,
                    updated_at_us: now,
                },
            };
            let wakes = row.degraded_wakes;
            put_json(tx, &key, &row)?;
            Ok(wakes)
        })
    }

    /// `writeCheckpointManifest`: replaces the row's manifest, creating the row with the column
    /// defaults when there is none.
    pub fn write_checkpoint_manifest(
        &self,
        source_id: &str,
        client_id: &str,
        session_id: &str,
        manifest: Value,
    ) -> Result<()> {
        const MEMBER: &str = "writeCheckpointManifest";
        reject_nul(MEMBER, [source_id, client_id, session_id])?;
        reject_nul_in_json(MEMBER, &manifest)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let key = row_key(source_id, client_id, session_id);
            let mut row =
                get_json::<SessionRow>(&*tx, &key)?.unwrap_or_else(|| SessionRow::fresh(now));
            row.checkpoint_manifest = manifest.clone();
            row.updated_at_us = now;
            put_json(tx, &key, &row)
        })
    }

    /// `gcSessionContextRows`: deletes the rows not updated in `older_than_days` days (a fraction
    /// is part of a day), then the oldest rows past `max_rows_per_client` per
    /// `(source_id, client_id)`, newest kept.
    pub fn gc_session_context_rows(
        &self,
        older_than_days: f64,
        max_rows_per_client: i64,
    ) -> Result<()> {
        if !older_than_days.is_finite() {
            return Err(StoreError::invalid(format!(
                "gcSessionContextRows: invalid input syntax for type interval: \"{older_than_days} days\""
            )));
        }
        let now = self.env.now_micros();
        let cutoff = now - (older_than_days * DAY_US).round() as i64;
        self.write(|tx| {
            // (key, client lane, updated_at) of every row, in key order: a lane's rows are adjacent.
            let mut rows: Vec<(Vec<u8>, Vec<u8>, i64)> = Vec::new();
            let mut bad: Option<StoreError> = None;
            scan_prefix(&*tx, &[keys::SESSION_STATE, ROW], false, &mut |k, v| {
                match serde_json::from_slice::<SessionRow>(v) {
                    Ok(row) => {
                        let tail = &k[2..];
                        let lane_end = tail
                            .iter()
                            .enumerate()
                            .filter(|(_, b)| **b == 0)
                            .nth(1)
                            .map_or(tail.len(), |(i, _)| i);
                        rows.push((k.to_vec(), tail[..lane_end].to_vec(), row.updated_at_us));
                        true
                    }
                    Err(e) => {
                        bad = Some(e.into());
                        false
                    }
                }
            })?;
            if let Some(e) = bad {
                return Err(e);
            }
            let mut kept: Vec<&(Vec<u8>, Vec<u8>, i64)> = Vec::new();
            for row in &rows {
                if row.2 < cutoff {
                    tx.delete(&row.0)?;
                } else {
                    kept.push(row);
                }
            }
            let mut start = 0;
            while start < kept.len() {
                let lane = &kept[start].1;
                let end = kept[start..]
                    .iter()
                    .position(|r| &r.1 != lane)
                    .map_or(kept.len(), |n| start + n);
                let mut group: Vec<&&(Vec<u8>, Vec<u8>, i64)> = kept[start..end].iter().collect();
                group.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
                let cap = usize::try_from(max_rows_per_client.max(0)).unwrap_or(usize::MAX);
                for row in group.into_iter().skip(cap) {
                    tx.delete(&row.0)?;
                }
                start = end;
            }
            Ok(())
        })
    }
}
