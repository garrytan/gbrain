//! Open loops: the `open_loops` table (src/schema.sql, migrations v144 and v236), in the facts
//! family under the facts tag.
//!
//! Members: `upsertOpenLoop`, `listOpenLoops` and `closeOpenLoop` (src/core/loops/loops-store.ts,
//! SQL in src/core/engine-sql/open-loops.ts), and `closedLoopWithActiveFact` (the `loops_close`
//! retry read) and `loopFactDrift` (the loop-fact retirement scan), SQL in
//! src/core/engine-sql/facts-repair.ts. The other loop statements (thread auto-close, the
//! staleness pass and mutes) still run through `executeRaw` and refuse on this engine.
//!
//! Keys (after `keys::FACT`; a text part ends with a NUL byte, and no text column may hold one):
//! - `F 0x08 id -> LoopRecord`: one row, the `id` primary key (8 big-endian bytes).
//! - `F 0x09 source_id dedup_key -> id`: the `open_loops_dedup` unique key.
//! - meta `next_open_loops_id`: the `BIGSERIAL` sequence. Every upsert takes an id, also one that
//!   lands on an existing row, as `nextval` runs before `ON CONFLICT` looks.
//!
//! Deleting a source removes its loops (`ON DELETE CASCADE`, [`remove_source_rows`]).

use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::jsonb;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::sources::require_source;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// The byte after `keys::FACT` that marks a loop row.
const ROW: u8 = 0x08;
/// The byte after `keys::FACT` that marks the `(source_id, dedup_key)` unique key.
const DEDUP: u8 = 0x09;
pub(crate) const COUNTER: &str = "next_open_loops_id";

/// The table's CHECK lists.
const LOOP_TYPES: [&str; 5] = [
    "commitment_owed_by_me",
    "commitment_owed_to_me",
    "unanswered_inbound",
    "unanswered_outbound",
    "decision_pending",
];
const STATUSES: [&str; 4] = ["open", "done", "dropped", "stale"];
const DETECTORS: [&str; 3] = ["deterministic_thread", "llm_extract", "manual"];

/// `MUTED` and `MUTE_RECHECK` in loops-store.ts: the `closed_by` marks the upsert guard reads.
const MUTED: &str = "muted";
const MUTE_RECHECK: &str = "mute_recheck";

/// What is stored for a loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LoopRecord {
    pub(crate) source_id: String,
    pub(crate) dedup_key: String,
    pub(crate) loop_type: String,
    pub(crate) counterparty_slug: Option<String>,
    pub(crate) counterparty_source_id: Option<String>,
    pub(crate) counterparty_email: Option<String>,
    pub(crate) summary: String,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    pub(crate) evidence: Value,
    pub(crate) thread_id: Option<String>,
    pub(crate) page_slug: Option<String>,
    pub(crate) due_at_us: Option<i64>,
    pub(crate) status: String,
    pub(crate) detector: String,
    pub(crate) confidence: f32,
    pub(crate) fact_id: Option<i64>,
    pub(crate) opened_at_us: i64,
    pub(crate) last_activity_at_us: i64,
    pub(crate) closed_at_us: Option<i64>,
    pub(crate) closed_by: Option<String>,
    pub(crate) created_at_us: i64,
    pub(crate) updated_at_us: i64,
}

/// The input of `upsertOpenLoop`. `counterpartySourceId` is already NULL when the slug is empty
/// or missing (the caller's `$16`); times are ISO text.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenLoopUpsert {
    pub source_id: String,
    pub dedup_key: String,
    pub loop_type: String,
    pub counterparty_slug: Option<String>,
    pub counterparty_source_id: Option<String>,
    pub counterparty_email: Option<String>,
    pub summary: String,
    pub evidence: Value,
    pub thread_id: Option<String>,
    pub page_slug: Option<String>,
    pub due_at: Option<String>,
    pub detector: String,
    pub confidence: Option<f64>,
    pub fact_id: Option<i64>,
    pub last_activity_at: Option<String>,
    pub opened_at: Option<String>,
}

/// What `upsertOpenLoop` resolves.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OpenLoopUpsertResult {
    pub id: i64,
    pub created: bool,
    pub applied: bool,
}

/// The filters of `listOpenLoops`. `source_ids` is the list `string_to_array` gives for the
/// joined ids (an empty list matches no row); `None` reads every source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListOpenLoopsOpts {
    pub source_ids: Option<Vec<String>>,
    pub status: Option<String>,
    pub loop_type: Option<String>,
    pub counterparty: Option<String>,
    pub counterparty_source_id: Option<String>,
    pub loop_id: Option<i64>,
    pub limit: Option<f64>,
}

fn row_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::FACT, ROW];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn dedup_key(source_id: &str, dedup: &str) -> Vec<u8> {
    let mut key = keys::text(keys::FACT, &[source_id, dedup]);
    key.insert(1, DEDUP);
    key
}

fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut prefix = keys::text(keys::FACT, &[source_id]);
    prefix.insert(1, DEDUP);
    prefix.push(0);
    prefix
}

fn check(column: &str, value: &str, allowed: &[&str]) -> Result<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            format!(
                "new row for relation \"open_loops\" violates check constraint on {column}: \"{value}\""
            ),
        ))
    }
}

fn time(op: &str, name: &str, text: Option<&str>) -> Result<Option<i64>> {
    match text {
        None => Ok(None),
        Some(t) => parse_iso(t).map(Some).ok_or_else(|| {
            StoreError::invalid(format!(
                "{op}: {name} must be an ISO time ending in Z, not \"{t}\""
            ))
        }),
    }
}

/// A `real` reads back as the shortest text that names the `f32`, as Postgres prints it.
fn real(value: f32) -> Value {
    format!("{value}")
        .parse::<f64>()
        .map(|f| json!(f))
        .unwrap_or(Value::Null)
}

fn row_json(id: u64, r: &LoopRecord) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(id));
    m.insert("source_id".into(), json!(r.source_id));
    m.insert("dedup_key".into(), json!(r.dedup_key));
    m.insert("loop_type".into(), json!(r.loop_type));
    m.insert("counterparty_slug".into(), json!(r.counterparty_slug));
    m.insert("counterparty_email".into(), json!(r.counterparty_email));
    m.insert("summary".into(), json!(r.summary));
    m.insert("evidence".into(), jsonb::ordered(&r.evidence));
    m.insert("thread_id".into(), json!(r.thread_id));
    m.insert("page_slug".into(), json!(r.page_slug));
    m.insert("due_at".into(), json!(r.due_at_us.map(iso)));
    m.insert("status".into(), json!(r.status));
    m.insert("detector".into(), json!(r.detector));
    m.insert("confidence".into(), real(r.confidence));
    m.insert("fact_id".into(), json!(r.fact_id));
    m.insert("opened_at".into(), json!(iso(r.opened_at_us)));
    m.insert("last_activity_at".into(), json!(iso(r.last_activity_at_us)));
    m.insert("closed_at".into(), json!(r.closed_at_us.map(iso)));
    m.insert("closed_by".into(), json!(r.closed_by));
    m.insert("created_at".into(), json!(iso(r.created_at_us)));
    m.insert("updated_at".into(), json!(iso(r.updated_at_us)));
    m.insert(
        "counterparty_source_id".into(),
        json!(r.counterparty_source_id),
    );
    Value::Object(m)
}

fn read_row(read: &dyn KvRead, id: u64) -> Result<Option<LoopRecord>> {
    get_json::<LoopRecord>(read, &row_key(id))
}

/// The shadow seed (`seed.rs`): stores `record`, a loop copied from another engine with its own id,
/// times and status, with its `(source_id, dedup_key)` unique key, where `upsert_open_loop` stores
/// a new one. `false` when the id already holds a loop; the dedup key held by another id is the
/// `open_loops_dedup` violation.
pub(crate) fn seed_open_loop(tx: &mut dyn KvWrite, id: u64, record: &LoopRecord) -> Result<bool> {
    if read_row(&*tx, id)?.is_some() {
        return Ok(false);
    }
    check("loop_type", &record.loop_type, &LOOP_TYPES)?;
    check("status", &record.status, &STATUSES)?;
    check("detector", &record.detector, &DETECTORS)?;
    require_source(tx, &record.source_id)?;
    let dk = dedup_key(&record.source_id, &record.dedup_key);
    if tx.get(&dk)?.is_some() {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "duplicate key value violates unique constraint \"open_loops_dedup\"",
        ));
    }
    put_json(tx, &row_key(id), record)?;
    tx.put(&dk, &id.to_be_bytes())?;
    Ok(true)
}

/// Removes every loop of a source, for the source delete.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut doomed = Vec::new();
    scan_prefix(tx, &source_prefix(source_id), false, &mut |k, v| {
        doomed.push((k.to_vec(), keys::be8(v)));
        true
    })?;
    for (k, id) in doomed {
        tx.delete(&k)?;
        if let Some(id) = id {
            tx.delete(&row_key(id))?;
        }
    }
    Ok(())
}

impl Store {
    /// `upsertOpenLoop`: inserts the loop, or updates the row with its `(source_id, dedup_key)`
    /// when that row is open, the new activity is newer, or an unmute queued it, and a mute does
    /// not hold it for the same counterparty email. `created` is true for a new row; `applied` is
    /// false when the guard kept the existing row.
    pub fn upsert_open_loop(&self, input: &OpenLoopUpsert) -> Result<OpenLoopUpsertResult> {
        let op = "upsertOpenLoop";
        let opt = |v: &Option<String>| v.clone().unwrap_or_default();
        no_nul(
            op,
            &[
                ("sourceId", &input.source_id),
                ("dedupKey", &input.dedup_key),
                ("loopType", &input.loop_type),
                ("counterpartySlug", &opt(&input.counterparty_slug)),
                ("counterpartySourceId", &opt(&input.counterparty_source_id)),
                ("counterpartyEmail", &opt(&input.counterparty_email)),
                ("summary", &input.summary),
                ("threadId", &opt(&input.thread_id)),
                ("pageSlug", &opt(&input.page_slug)),
                ("detector", &input.detector),
            ],
        )?;
        check("loop_type", &input.loop_type, &LOOP_TYPES)?;
        check("detector", &input.detector, &DETECTORS)?;
        let due_at_us = time(op, "dueAt", input.due_at.as_deref())?;
        let last = time(op, "lastActivityAt", input.last_activity_at.as_deref())?;
        let opened = time(op, "openedAt", input.opened_at.as_deref())?;
        let now = self.env.now_micros();
        let last_activity_at_us = last.unwrap_or(now);
        let opened_at_us = opened.unwrap_or(now);
        let confidence = input.confidence.unwrap_or(1.0);
        let narrowed = confidence as f32;
        // JSON cannot carry a NaN or an infinity, but a direct Rust caller can; either one, like a
        // finite value past the REAL range, would store a row that no longer deserializes.
        if !narrowed.is_finite() {
            return Err(StoreError::new(
                crate::error::INVALID_ARGUMENT,
                if confidence.is_finite() {
                    format!("{op}: \"{confidence}\" is out of range for type real")
                } else {
                    format!("{op}: confidence {confidence} is not a finite number")
                },
            ));
        }
        let confidence = narrowed;
        self.write(|tx| {
            require_source(tx, &input.source_id)?;
            let new_id = next_id(tx, COUNTER)?;
            let dk = dedup_key(&input.source_id, &input.dedup_key);
            let existing = match tx.get(&dk)? {
                Some(bytes) => Some(keys::be8(&bytes).ok_or_else(|| {
                    StoreError::new(crate::error::STORE_CORRUPT, "bad open loop dedup key")
                })?),
                None => None,
            };
            let Some(id) = existing else {
                let record = LoopRecord {
                    source_id: input.source_id.clone(),
                    dedup_key: input.dedup_key.clone(),
                    loop_type: input.loop_type.clone(),
                    counterparty_slug: input.counterparty_slug.clone(),
                    counterparty_source_id: input.counterparty_source_id.clone(),
                    counterparty_email: input.counterparty_email.clone(),
                    summary: input.summary.clone(),
                    evidence: jsonb::order(input.evidence.clone()),
                    thread_id: input.thread_id.clone(),
                    page_slug: input.page_slug.clone(),
                    due_at_us,
                    status: "open".into(),
                    detector: input.detector.clone(),
                    confidence,
                    fact_id: input.fact_id,
                    opened_at_us,
                    last_activity_at_us,
                    closed_at_us: None,
                    closed_by: None,
                    created_at_us: now,
                    updated_at_us: now,
                };
                put_json(tx, &row_key(new_id), &record)?;
                tx.put(&dk, &new_id.to_be_bytes())?;
                return Ok(OpenLoopUpsertResult {
                    id: new_id as i64,
                    created: true,
                    applied: true,
                });
            };
            let mut r = read_row(tx, id)?.ok_or_else(|| {
                StoreError::new(
                    crate::error::STORE_CORRUPT,
                    "open loop dedup key names no row",
                )
            })?;
            let reopens = r.status == "open"
                || last_activity_at_us > r.last_activity_at_us
                || r.closed_by.as_deref() == Some(MUTE_RECHECK);
            let unmuted = r.closed_by.as_deref() != Some(MUTED)
                || r.counterparty_email != input.counterparty_email;
            if !(reopens && unmuted) {
                return Ok(OpenLoopUpsertResult {
                    id: id as i64,
                    created: false,
                    applied: false,
                });
            }
            r.opened_at_us = if r.status == "open" {
                r.opened_at_us.min(opened_at_us)
            } else {
                opened_at_us
            };
            r.status = "open".into();
            r.loop_type = input.loop_type.clone();
            if input.counterparty_slug.is_some() {
                r.counterparty_source_id = input.counterparty_source_id.clone();
            }
            r.counterparty_slug = input.counterparty_slug.clone().or(r.counterparty_slug);
            r.counterparty_email = input.counterparty_email.clone().or(r.counterparty_email);
            r.summary = input.summary.clone();
            r.evidence = jsonb::order(input.evidence.clone());
            r.page_slug = input.page_slug.clone().or(r.page_slug);
            r.due_at_us = due_at_us.or(r.due_at_us);
            r.confidence = confidence;
            r.fact_id = input.fact_id.or(r.fact_id);
            r.last_activity_at_us = r.last_activity_at_us.max(last_activity_at_us);
            r.closed_at_us = None;
            r.closed_by = None;
            r.updated_at_us = now;
            put_json(tx, &row_key(id), &r)?;
            Ok(OpenLoopUpsertResult {
                id: id as i64,
                created: false,
                applied: true,
            })
        })
    }

    /// `listOpenLoops`: the loops that pass every filter, newest activity first, then id
    /// descending, at most `limit` (clamped to 1..=1000, 200 by default; a fraction rounds as a
    /// `LIMIT` does).
    pub fn list_open_loops(&self, opts: &ListOpenLoopsOpts) -> Result<Vec<Value>> {
        let op = "listOpenLoops";
        for (name, v) in [
            ("status", &opts.status),
            ("loopType", &opts.loop_type),
            ("counterparty", &opts.counterparty),
            ("counterpartySourceId", &opts.counterparty_source_id),
        ] {
            no_nul(op, &[(name, v.as_deref().unwrap_or(""))])?;
        }
        let limit = opts.limit.unwrap_or(200.0).clamp(1.0, 1000.0).round() as usize;
        let read = self.read()?;
        let mut rows: Vec<(u64, LoopRecord)> = Vec::new();
        let mut failed = None;
        scan_prefix(&*read, &[keys::FACT, ROW], false, &mut |k, v| {
            let Some(id) = k.get(2..).and_then(keys::be8) else {
                return true;
            };
            match serde_json::from_slice::<LoopRecord>(v) {
                Ok(r) => rows.push((id, r)),
                Err(e) => {
                    failed = Some(e);
                    return false;
                }
            }
            true
        })?;
        if let Some(e) = failed {
            return Err(StoreError::invalid(format!("{op}: corrupt record: {e}")));
        }
        rows.retain(|(id, r)| {
            opts.source_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&r.source_id))
                && opts.status.as_ref().is_none_or(|s| *s == r.status)
                && opts.loop_type.as_ref().is_none_or(|t| *t == r.loop_type)
                && opts.counterparty.as_ref().is_none_or(|c| {
                    let slug = r.counterparty_slug.as_ref() == Some(c)
                        && opts.counterparty_source_id.as_ref().is_none_or(|cs| {
                            r.counterparty_source_id.as_ref().unwrap_or(&r.source_id) == cs
                        });
                    slug || r.counterparty_email.as_ref() == Some(c)
                })
                && opts.loop_id.is_none_or(|l| l == *id as i64)
        });
        rows.sort_by(|(a_id, a), (b_id, b)| {
            b.last_activity_at_us
                .cmp(&a.last_activity_at_us)
                .then(b_id.cmp(a_id))
        });
        Ok(rows
            .iter()
            .take(limit)
            .map(|(id, r)| row_json(*id, r))
            .collect())
    }

    /// `closeOpenLoop`: closes the open loop `id` (in `source_id` when given) as `status`, by
    /// `closed_by`, now. `None` when no open loop matches.
    pub fn close_open_loop(
        &self,
        source_id: Option<&str>,
        id: i64,
        status: &str,
        closed_by: &str,
    ) -> Result<Option<Value>> {
        no_nul(
            "closeOpenLoop",
            &[
                ("sourceId", source_id.unwrap_or("")),
                ("status", status),
                ("closedBy", closed_by),
            ],
        )?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Ok(uid) = u64::try_from(id) else {
                return Ok(None);
            };
            let Some(mut r) = read_row(tx, uid)? else {
                return Ok(None);
            };
            if r.status != "open" || source_id.is_some_and(|s| s != r.source_id) {
                return Ok(None);
            }
            check("status", status, &STATUSES)?;
            r.status = status.into();
            r.closed_at_us = Some(now);
            r.closed_by = Some(closed_by.into());
            r.updated_at_us = now;
            put_json(tx, &row_key(uid), &r)?;
            Ok(Some(row_json(uid, &r)))
        })
    }

    /// `closedLoopWithActiveFact`: loop `loop_id` (in `source_id` when given) when it is closed
    /// (`done` or `dropped`) and its commitment fact exists with no `expired_at`, as
    /// `{ id, status, fact_id }`. `None` otherwise, also for a loop with no fact.
    pub fn closed_loop_with_active_fact(
        &self,
        source_id: Option<&str>,
        loop_id: i64,
    ) -> Result<Option<Value>> {
        no_nul(
            "closedLoopWithActiveFact",
            &[("sourceId", source_id.unwrap_or(""))],
        )?;
        let Ok(uid) = u64::try_from(loop_id) else {
            return Ok(None);
        };
        let read = self.read()?;
        let Some(r) = read_row(&*read, uid)? else {
            return Ok(None);
        };
        if !matches!(r.status.as_str(), "done" | "dropped")
            || source_id.is_some_and(|s| s != r.source_id)
        {
            return Ok(None);
        }
        let Some(fact_id) = r.fact_id else {
            return Ok(None);
        };
        let Ok(fid) = u64::try_from(fact_id) else {
            return Ok(None);
        };
        let active = super::read_fact(&*read, fid)?.is_some_and(|f| f.expired_at_us.is_none());
        Ok(active.then(|| json!({ "id": uid, "status": r.status, "fact_id": fact_id })))
    }

    /// `loopFactDrift(sourceIds, loopId)`: the closed (`done` or `dropped`) loops of the sources
    /// (only `loop_id` when given) whose commitment fact, in the loop's own source, has no
    /// `expired_at` and no `open` loop referencing it, as `{ loop_id, source_id, fact_id, status,
    /// slug }` in id order. `slug` is the fact's `source_markdown_slug`.
    pub fn loop_fact_drift(
        &self,
        source_ids: &[String],
        loop_id: Option<i64>,
    ) -> Result<Vec<Value>> {
        let op = "loopFactDrift";
        for source in source_ids {
            no_nul(op, &[("sourceIds", source)])?;
        }
        let read = self.read()?;
        let rows = all_rows(&*read, op)?;
        let held: std::collections::BTreeSet<i64> = rows
            .iter()
            .filter(|(_, r)| r.status == "open")
            .filter_map(|(_, r)| r.fact_id)
            .collect();
        let mut out = Vec::new();
        for (id, r) in &rows {
            if !source_ids.contains(&r.source_id)
                || !matches!(r.status.as_str(), "done" | "dropped")
                || loop_id.is_some_and(|l| l != *id as i64)
            {
                continue;
            }
            let Some(fact_id) = r.fact_id else { continue };
            if held.contains(&fact_id) {
                continue;
            }
            let Ok(fid) = u64::try_from(fact_id) else {
                continue;
            };
            let Some(f) = super::read_fact(&*read, fid)? else {
                continue;
            };
            if f.source_id != r.source_id || f.expired_at_us.is_some() {
                continue;
            }
            out.push(json!({
                "loop_id": id,
                "source_id": r.source_id,
                "fact_id": fact_id,
                "status": r.status,
                "slug": f.source_markdown_slug,
            }));
        }
        Ok(out)
    }
}

/// The fact ids every loop of every source names (`EXISTS (SELECT 1 FROM open_loops l WHERE
/// l.fact_id = f.id)`), whatever its status.
pub(crate) fn loop_fact_ids(
    read: &dyn KvRead,
    op: &str,
) -> Result<std::collections::BTreeSet<u64>> {
    Ok(all_rows(read, op)?
        .into_iter()
        .filter_map(|(_, r)| r.fact_id.and_then(|id| u64::try_from(id).ok()))
        .collect())
}

/// Every loop row, in id order (the key order of `F 0x08 id`).
fn all_rows(read: &dyn KvRead, op: &str) -> Result<Vec<(u64, LoopRecord)>> {
    let mut rows = Vec::new();
    let mut failed = None;
    scan_prefix(read, &[keys::FACT, ROW], false, &mut |k, v| {
        let Some(id) = k.get(2..).and_then(keys::be8) else {
            return true;
        };
        match serde_json::from_slice::<LoopRecord>(v) {
            Ok(r) => rows.push((id, r)),
            Err(e) => {
                failed = Some(e);
                return false;
            }
        }
        true
    })?;
    if let Some(e) = failed {
        return Err(StoreError::invalid(format!("{op}: corrupt record: {e}")));
    }
    Ok(rows)
}

/// The shadow follow (`seed/follow.rs`): removes the loop `id` with its dedup key. `false` when
/// there is none.
pub(crate) fn remove_open_loop(tx: &mut dyn KvWrite, id: u64) -> Result<bool> {
    let Some(old) = read_row(&*tx, id)? else {
        return Ok(false);
    };
    let dk = dedup_key(&old.source_id, &old.dedup_key);
    if tx.get(&dk)?.is_some_and(|v| keys::be8(&v) == Some(id)) {
        tx.delete(&dk)?;
    }
    tx.delete(&row_key(id))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::INVALID_ARGUMENT;
    use crate::sources::SourceInput;
    use crate::test_support::store;

    const T1: &str = "2026-03-01T10:00:00Z";
    const T2: &str = "2026-03-02T10:00:00Z";

    fn source(s: &Store, id: &str) {
        s.upsert_source(&SourceInput {
            id: id.into(),
            ..SourceInput::default()
        })
        .unwrap();
    }

    fn input(source_id: &str, key: &str, at: &str) -> OpenLoopUpsert {
        serde_json::from_value(json!({
            "sourceId": source_id, "dedupKey": key, "loopType": "unanswered_inbound",
            "counterpartyEmail": "a@example.com", "summary": "s", "evidence": [],
            "detector": "deterministic_thread", "lastActivityAt": at, "openedAt": at,
        }))
        .unwrap()
    }

    #[test]
    fn a_confidence_past_the_real_range_refuses_and_leaves_the_row() {
        let s = store();
        source(&s, "src");
        s.upsert_open_loop(&input("src", "k", T1)).unwrap();
        for bad in [1e39, -1e39, f64::INFINITY, f64::NEG_INFINITY, f64::NAN] {
            let mut again = input("src", "k", T2);
            again.confidence = Some(bad);
            let err = s.upsert_open_loop(&again).unwrap_err();
            assert_eq!(err.code, INVALID_ARGUMENT, "{err:?}");
            assert!(err.message.contains("for type real") || err.message.contains("finite"));
            let mut fresh = input("src", "other", T2);
            fresh.confidence = Some(bad);
            assert!(s.upsert_open_loop(&fresh).is_err());
        }
        // the stored row still reads, and so does the listing
        assert_eq!(s.upsert_open_loop(&input("src", "k", T2)).unwrap().id, 1);
    }

    #[test]
    fn upsert_reopens_only_on_newer_activity() {
        let s = store();
        source(&s, "src");
        let first = s.upsert_open_loop(&input("src", "k", T1)).unwrap();
        assert_eq!(
            first,
            OpenLoopUpsertResult {
                id: 1,
                created: true,
                applied: true
            }
        );
        let closed = s
            .close_open_loop(Some("src"), 1, "done", "manual")
            .unwrap()
            .unwrap();
        assert_eq!(closed["status"], "done");
        assert!(
            s.close_open_loop(Some("src"), 1, "done", "manual")
                .unwrap()
                .is_none()
        );
        // Same activity: the closed row stays closed, and the sequence still moves.
        let kept = s.upsert_open_loop(&input("src", "k", T1)).unwrap();
        assert_eq!(
            kept,
            OpenLoopUpsertResult {
                id: 1,
                created: false,
                applied: false
            }
        );
        let reopened = s.upsert_open_loop(&input("src", "k", T2)).unwrap();
        assert_eq!(
            reopened,
            OpenLoopUpsertResult {
                id: 1,
                created: false,
                applied: true
            }
        );
        let other = s.upsert_open_loop(&input("src", "k2", T1)).unwrap();
        assert_eq!(other.id, 4);
        let rows = s.list_open_loops(&ListOpenLoopsOpts::default()).unwrap();
        let ids: Vec<_> = rows.iter().map(|r| r["id"].as_i64().unwrap()).collect();
        assert_eq!(ids, vec![1, 4]);
        assert_eq!(rows[0]["status"], "open");
        assert_eq!(rows[0]["closed_by"], Value::Null);
    }

    #[test]
    fn closed_loop_with_active_fact_needs_a_closed_loop_and_a_live_fact() {
        use crate::facts::{ExpireFactArgs, InsertFactArgs, NewFactInput};
        let s = store();
        source(&s, "src");
        let fact = |text: &str| -> i64 {
            let args = InsertFactArgs {
                input: NewFactInput {
                    fact: Some(text.into()),
                    source: Some("test".into()),
                    ..NewFactInput::default()
                },
                source_id: "src".into(),
                supersede_id: None,
            };
            s.insert_fact(&args).unwrap()["id"].as_i64().unwrap()
        };
        let live = fact("send the deck");
        let gone = fact("call back");
        let mut a = input("src", "a", T1);
        a.fact_id = Some(live);
        let mut b = input("src", "b", T1);
        b.fact_id = Some(gone);
        let a = s.upsert_open_loop(&a).unwrap().id;
        let b = s.upsert_open_loop(&b).unwrap().id;
        let none = s.upsert_open_loop(&input("src", "c", T1)).unwrap().id;
        // Still open: no row.
        assert!(s.closed_loop_with_active_fact(None, a).unwrap().is_none());
        for id in [a, b, none] {
            s.close_open_loop(None, id, "done", "manual")
                .unwrap()
                .unwrap();
        }
        s.expire_fact(&ExpireFactArgs {
            id: gone as f64,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            s.closed_loop_with_active_fact(Some("src"), a).unwrap(),
            Some(json!({ "id": a, "status": "done", "fact_id": live }))
        );
        assert!(
            s.closed_loop_with_active_fact(Some("other"), a)
                .unwrap()
                .is_none()
        );
        assert!(s.closed_loop_with_active_fact(None, b).unwrap().is_none());
        assert!(
            s.closed_loop_with_active_fact(None, none)
                .unwrap()
                .is_none()
        );
        assert!(s.closed_loop_with_active_fact(None, -1).unwrap().is_none());
    }

    #[test]
    fn loop_fact_drift_lists_closed_loops_whose_fact_no_open_loop_holds() {
        use crate::facts::{ExpireFactArgs, InsertFactArgs, NewFactInput};
        let s = store();
        source(&s, "src");
        let fact = |text: &str| -> i64 {
            let args = InsertFactArgs {
                input: NewFactInput {
                    fact: Some(text.into()),
                    source: Some("test".into()),
                    ..NewFactInput::default()
                },
                source_id: "src".into(),
                supersede_id: None,
            };
            s.insert_fact(&args).unwrap()["id"].as_i64().unwrap()
        };
        let (live, held, gone) = (fact("send the deck"), fact("call back"), fact("old"));
        let with_fact = |key: &str, fact_id: Option<i64>| {
            let mut i = input("src", key, T1);
            i.fact_id = fact_id;
            s.upsert_open_loop(&i).unwrap().id
        };
        let done = with_fact("done", Some(live));
        let closed_held = with_fact("held-closed", Some(held));
        let _open_held = with_fact("held-open", Some(held));
        let expired = with_fact("expired", Some(gone));
        let no_fact = with_fact("none", None);
        let dropped = with_fact("dropped", Some(live));
        s.close_open_loop(None, done, "done", "manual")
            .unwrap()
            .unwrap();
        s.close_open_loop(None, dropped, "dropped", "manual")
            .unwrap()
            .unwrap();
        for id in [closed_held, expired, no_fact] {
            s.close_open_loop(None, id, "done", "manual")
                .unwrap()
                .unwrap();
        }
        s.expire_fact(&ExpireFactArgs {
            id: gone as f64,
            ..Default::default()
        })
        .unwrap();
        let ids = |rows: Vec<Value>| -> Vec<i64> {
            rows.iter()
                .map(|r| r["loop_id"].as_i64().unwrap())
                .collect()
        };
        let src = vec!["src".to_string()];
        assert_eq!(
            ids(s.loop_fact_drift(&src, None).unwrap()),
            vec![done, dropped]
        );
        assert_eq!(
            s.loop_fact_drift(&src, Some(dropped)).unwrap(),
            vec![
                json!({ "loop_id": dropped, "source_id": "src", "fact_id": live,
                "status": "dropped", "slug": null })
            ]
        );
        assert!(
            s.loop_fact_drift(&src, Some(closed_held))
                .unwrap()
                .is_empty()
        );
        assert!(
            s.loop_fact_drift(&["other".to_string()], None)
                .unwrap()
                .is_empty()
        );
        assert!(s.loop_fact_drift(&[], None).unwrap().is_empty());
        assert_eq!(
            s.loop_fact_drift(&["a\0b".to_string()], None)
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
    }

    #[test]
    fn check_constraints_and_source_cascade() {
        let s = store();
        source(&s, "src");
        let mut bad = input("src", "k", T1);
        bad.loop_type = "nope".into();
        assert_eq!(
            s.upsert_open_loop(&bad).unwrap_err().code,
            CONSTRAINT_VIOLATION
        );
        s.upsert_open_loop(&input("src", "k", T1)).unwrap();
        assert_eq!(
            s.close_open_loop(None, 1, "bogus", "x").unwrap_err().code,
            CONSTRAINT_VIOLATION
        );
        assert!(s.close_open_loop(None, 9, "bogus", "x").unwrap().is_none());
        let only_none = ListOpenLoopsOpts {
            source_ids: Some(vec![]),
            ..Default::default()
        };
        assert!(s.list_open_loops(&only_none).unwrap().is_empty());
        s.write(|tx| crate::cascade::remove_source_rows(tx, "src"))
            .unwrap();
        assert!(
            s.list_open_loops(&ListOpenLoopsOpts::default())
                .unwrap()
                .is_empty()
        );
    }
}
