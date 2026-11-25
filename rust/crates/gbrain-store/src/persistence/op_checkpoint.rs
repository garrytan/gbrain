//! Resumable-op checkpoints: the statements of `src/core/engine-sql/op-checkpoint.ts` and the
//! reads `readOpCheckpointKeys` and `readOpCheckpointRecord` of `engine-sql/write-misc.ts`
//! (rust/docs/store/persistence.md,
//! "Op checkpoints").
//!
//! - The parent: one `op_checkpoints` row per (op, fingerprint), key
//!   `d 0x02 <op> 0x00 <fingerprint>`, the same JSON row as a housekeeping turn
//!   (`housekeeping::HousekeepingRow`), as Postgres keeps both in one table.
//! - The children: one `op_checkpoint_paths` row per (op, fingerprint, path), key
//!   `d 0x07 <op> 0x00 <fingerprint> 0x00 <path>`, empty value. Not `d 0x05` or `d 0x06`: those
//!   hold the `persistence_effects` rows (`d 0x05 <request id> 0x00 <kind>`) and their claim-order
//!   index.
//!
//! Deleting a parent deletes its children, as the Postgres foreign key does (`ON DELETE
//! CASCADE`). The read lists the children in path order and then the parent's array; Postgres
//! lists them in no stated order, and the caller deduplicates them into a set.
//!
//! The purge (`purgeStaleCheckpoints`) scans every `d 0x02` parent, housekeeping turns included,
//! as the Postgres statement scans the one table. It keeps the exemptions whose data the store
//! has (pages, sources and the other checkpoint rows). The store keeps no
//! `source_ingestion_receipts`, so that exemption never holds here.

use super::housekeeping::HousekeepingRow;
use super::projection_queue::parse_timestamptz;
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::read_page_by_id;
use crate::sources::read_source;
use crate::{Store, get_json, keys, put_json};
use serde::Deserialize;
use serde_json::{Value, json};

/// Refuses NUL, which Postgres text cannot hold, so a key part cannot run into the next one.
fn text<'a>(value: &'a str, what: &str) -> Result<&'a str> {
    if value.contains('\0') {
        return Err(StoreError::invalid(format!(
            "an op checkpoint {what} cannot contain NUL"
        )));
    }
    Ok(value)
}

pub(super) fn parent_key(op: &str, fingerprint: &str) -> Result<Vec<u8>> {
    let mut key = vec![keys::PERSISTENCE, super::HOUSEKEEPING];
    key.extend_from_slice(text(op, "op")?.as_bytes());
    key.push(0);
    key.extend_from_slice(text(fingerprint, "fingerprint")?.as_bytes());
    Ok(key)
}

/// `d 0x07 <op> 0x00 <fingerprint> 0x00`: the prefix of one checkpoint's paths.
fn paths_prefix(op: &str, fingerprint: &str) -> Result<Vec<u8>> {
    let mut key = vec![keys::PERSISTENCE, super::CHECKPOINT_PATH];
    key.extend_from_slice(text(op, "op")?.as_bytes());
    key.push(0);
    key.extend_from_slice(text(fingerprint, "fingerprint")?.as_bytes());
    key.push(0);
    Ok(key)
}

fn path_keys(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    scan_prefix(read, prefix, false, &mut |k, _| {
        out.push(k.to_vec());
        true
    })?;
    Ok(out)
}

/// `readOpCheckpointKeys(op, fingerprint)`: `{ keys, corruptParent }`. The children, then the
/// parent's array, deduplicated in first-seen order; a parent whose keys are not an array is
/// skipped and reported, so the children still load.
pub(crate) fn read_op_checkpoint_keys_in(
    read: &dyn KvRead,
    op: &str,
    fingerprint: &str,
) -> Result<Value> {
    let prefix = paths_prefix(op, fingerprint)?;
    let mut keys: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |key: String| {
        if seen.insert(key.clone()) {
            keys.push(key);
        }
    };
    for k in path_keys(read, &prefix)? {
        push(String::from_utf8_lossy(&k[prefix.len()..]).into_owned());
    }
    let mut corrupt_parent = false;
    if let Some(row) = get_json::<HousekeepingRow>(read, &parent_key(op, fingerprint)?)? {
        match &row.completed_keys {
            Value::Array(items) => {
                // `jsonb_array_elements_text`: a string element is its text; any other element is
                // its jsonb text (keys by length then bytes, `", "` and `": "`), and a JSON null is
                // SQL NULL, which the caller skips.
                for item in items {
                    match item {
                        Value::String(s) => push(s.clone()),
                        Value::Null => {}
                        other => push(crate::cli_reads::pg_text::jsonb_text(other)),
                    }
                }
            }
            _ => corrupt_parent = true,
        }
    }
    Ok(json!({ "keys": keys, "corruptParent": corrupt_parent }))
}

/// `writeOpCheckpointKeys(op, fingerprint, keys)`: the parent's keys replaced by `keys`, its
/// stamp now. The children stay.
pub(crate) fn write_op_checkpoint_keys_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    completed: &[String],
) -> Result<()> {
    for key in completed {
        text(key, "key")?;
    }
    put_json(
        tx,
        &parent_key(op, fingerprint)?,
        &HousekeepingRow {
            completed_keys: json!(completed),
            updated_at_us: env.now_micros(),
        },
    )
}

/// `appendOpCheckpointPaths(op, fingerprint, paths)`: the parent created with no keys or its
/// stamp moved to now, then each path not yet banked added.
pub(crate) fn append_op_checkpoint_paths_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    paths: &[String],
) -> Result<()> {
    let parent = parent_key(op, fingerprint)?;
    let prefix = paths_prefix(op, fingerprint)?;
    for path in paths {
        text(path, "path")?;
    }
    let completed_keys = get_json::<HousekeepingRow>(&*tx, &parent)?
        .map_or_else(|| json!([]), |row| row.completed_keys);
    put_json(
        tx,
        &parent,
        &HousekeepingRow {
            completed_keys,
            updated_at_us: env.now_micros(),
        },
    )?;
    for path in paths {
        let mut key = prefix.clone();
        key.extend_from_slice(path.as_bytes());
        tx.put(&key, &[])?;
    }
    Ok(())
}

/// `deleteOpCheckpoint(op, fingerprint)`: the parent and, as the foreign key cascades, its paths.
pub(crate) fn delete_op_checkpoint_in(
    tx: &mut dyn KvWrite,
    op: &str,
    fingerprint: &str,
) -> Result<()> {
    tx.delete(&parent_key(op, fingerprint)?)?;
    delete_op_checkpoint_paths_in(tx, op, fingerprint)
}

/// `deleteOpCheckpointPaths(op, fingerprint)`: the paths only.
pub(crate) fn delete_op_checkpoint_paths_in(
    tx: &mut dyn KvWrite,
    op: &str,
    fingerprint: &str,
) -> Result<()> {
    let prefix = paths_prefix(op, fingerprint)?;
    for key in path_keys(&*tx, &prefix)? {
        tx.delete(&key)?;
    }
    Ok(())
}

/// Whether a string or object key anywhere in `value` holds NUL: Postgres `jsonb` refuses the
/// `\u0000` escape anywhere in a document.
fn json_has_nul(value: &Value) -> bool {
    match value {
        Value::String(s) => s.contains('\0'),
        Value::Array(items) => items.iter().any(json_has_nul),
        Value::Object(map) => map.iter().any(|(k, v)| k.contains('\0') || json_has_nul(v)),
        _ => false,
    }
}

/// `readOpCheckpointRecords(op, fingerprints)`: each found parent's first completed key
/// (`completed_keys->0`), null when its array is empty, in the order named; a missing parent adds
/// nothing. Postgres answers in no stated order, and the caller keys the records by page.
pub(crate) fn read_op_checkpoint_records_in(
    read: &dyn KvRead,
    op: &str,
    fingerprints: &[String],
) -> Result<Value> {
    let mut out = Vec::new();
    // `fingerprint = ANY($2)` matches a parent once, however often the list names it.
    let mut seen = std::collections::HashSet::new();
    for fingerprint in fingerprints {
        if !seen.insert(fingerprint.as_str()) {
            continue;
        }
        if let Some(row) = get_json::<HousekeepingRow>(read, &parent_key(op, fingerprint)?)? {
            out.push(row.completed_keys.get(0).cloned().unwrap_or(Value::Null));
        }
    }
    Ok(Value::Array(out))
}

/// The parent's `completed_keys` of `(op, fingerprint)`, or `None` when there is no parent row.
pub(crate) fn op_checkpoint_completed_keys(
    read: &dyn KvRead,
    op: &str,
    fingerprint: &str,
) -> Result<Option<Value>> {
    Ok(
        get_json::<HousekeepingRow>(read, &parent_key(op, fingerprint)?)?
            .map(|row| row.completed_keys),
    )
}

/// `readOpCheckpointRecord(op, fingerprint, { freshWithinDays })`: the parent as
/// `{ completed_keys, updated_at, fresh }`, or null. `updated_at` is ISO 8601 with milliseconds,
/// truncated as `to_char(.., 'MS')` truncates; `fresh` compares the stamp with the store clock
/// less `fresh_days` days, null when not asked.
pub(crate) fn read_op_checkpoint_record_in(
    read: &dyn KvRead,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    fresh_days: Option<f64>,
) -> Result<Value> {
    let Some(row) = get_json::<HousekeepingRow>(read, &parent_key(op, fingerprint)?)? else {
        return Ok(Value::Null);
    };
    let full = crate::env::iso(row.updated_at_us);
    let updated_at = format!("{}Z", &full[..full.len() - 4]);
    let fresh = fresh_days.map(|days| {
        // Days to microseconds as Postgres reads `'<days> days'::interval`.
        let window = (days * 86_400_000_000.0).round() as i64;
        row.updated_at_us >= env.now_micros().saturating_sub(window)
    });
    Ok(json!({ "completed_keys": row.completed_keys, "updated_at": updated_at, "fresh": fresh }))
}

/// `listOpCheckpointRecords(op)`: every parent of `op` as `{ fingerprint, completed_keys,
/// updated_at, updated_at_us }`, in fingerprint byte order. `updated_at` is formatted as
/// `read_op_checkpoint_record_in` formats it; `updated_at_us` keeps the full stamp, so a caller can
/// compare two stamps as Postgres compares `updated_at` (the managed-sync orphan classification).
pub(crate) fn list_op_checkpoint_records_in(read: &dyn KvRead, op: &str) -> Result<Value> {
    let mut prefix = vec![keys::PERSISTENCE, super::HOUSEKEEPING];
    prefix.extend_from_slice(text(op, "op")?.as_bytes());
    prefix.push(0);
    let mut out = Vec::new();
    let mut bad = false;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        let fingerprint = std::str::from_utf8(&k[prefix.len()..]).map(str::to_owned);
        match (fingerprint, serde_json::from_slice::<HousekeepingRow>(v)) {
            (Ok(fingerprint), Ok(row)) => {
                let full = crate::env::iso(row.updated_at_us);
                out.push(json!({
                    "fingerprint": fingerprint,
                    "completed_keys": row.completed_keys,
                    "updated_at": format!("{}Z", &full[..full.len() - 4]),
                    "updated_at_us": row.updated_at_us,
                }));
            }
            _ => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            "an op checkpoint row is not readable",
        ));
    }
    Ok(Value::Array(out))
}

/// `writeOpCheckpointRecords(op, rows)`: each row's parent set to `[record]`, stamped now; the
/// children stay. Every row is checked before any is written, so a refused batch writes nothing.
pub(crate) fn write_op_checkpoint_records_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    rows: &[(String, Value)],
) -> Result<()> {
    let mut parents = Vec::with_capacity(rows.len());
    for (fingerprint, record) in rows {
        if json_has_nul(record) {
            return Err(StoreError::invalid(
                "an op checkpoint record cannot contain NUL",
            ));
        }
        parents.push((parent_key(op, fingerprint)?, record));
    }
    let now = env.now_micros();
    for (parent, record) in parents {
        put_json(
            tx,
            &parent,
            &HousekeepingRow {
                completed_keys: json!([record]),
                updated_at_us: now,
            },
        )?;
    }
    Ok(())
}

/// `writeOpCheckpointRecord(op, fingerprint, completedKeys)`: the parent's records replaced and
/// stamped now; `None` deletes the parent and its paths. The records must be a JSON array, as the
/// Postgres CHECK `op_checkpoints_completed_keys_array` requires.
pub(crate) fn write_op_checkpoint_record_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    completed: Option<&Value>,
) -> Result<()> {
    let Some(completed) = completed else {
        return delete_op_checkpoint_in(tx, op, fingerprint);
    };
    if !completed.is_array() {
        return Err(StoreError::invalid(
            "an op checkpoint's completed keys must be a JSON array (op_checkpoints_completed_keys_array)",
        ));
    }
    if json_has_nul(completed) {
        return Err(StoreError::invalid(
            "an op checkpoint's completed keys cannot contain NUL",
        ));
    }
    put_json(
        tx,
        &parent_key(op, fingerprint)?,
        &HousekeepingRow {
            completed_keys: completed.clone(),
            updated_at_us: env.now_micros(),
        },
    )
}

/// `insertOpCheckpointIfAbsent(op, fingerprint, completedKeys)`: `INSERT ... ON CONFLICT (op,
/// fingerprint) DO NOTHING RETURNING 1`. True when this call stored the parent; an existing parent
/// is kept as it is.
pub(crate) fn insert_op_checkpoint_if_absent_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    completed: &Value,
) -> Result<bool> {
    if get_json::<HousekeepingRow>(&*tx, &parent_key(op, fingerprint)?)?.is_some() {
        return Ok(false);
    }
    write_op_checkpoint_record_in(tx, env, op, fingerprint, Some(completed))?;
    Ok(true)
}

/// `upsertFenceTrendRunRecord(op, fingerprint, record)`: `INSERT ... ON CONFLICT (op, fingerprint) DO
/// UPDATE SET completed_keys = jsonb_build_array((EXCLUDED.completed_keys->0) ||
/// jsonb_build_object('day', op_checkpoints.completed_keys->0->'day'))`. A new parent stores
/// `[record]`; an existing one is rewritten as `[record]` carrying the `day` of its first record
/// (null when it has none), so a sync run's rewrite keeps the day of its first write.
pub(crate) fn upsert_fence_trend_run_record_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    record: &Value,
) -> Result<()> {
    let Some(mut next) = record.as_object().cloned() else {
        return Err(StoreError::invalid(
            "a fence trend run record must be a JSON object",
        ));
    };
    if let Some(row) = get_json::<HousekeepingRow>(&*tx, &parent_key(op, fingerprint)?)? {
        let day = row
            .completed_keys
            .get(0)
            .and_then(|first| first.get("day"))
            .cloned()
            .unwrap_or(Value::Null);
        next.insert("day".to_owned(), day);
    }
    write_op_checkpoint_record_in(
        tx,
        env,
        op,
        fingerprint,
        Some(&json!([Value::Object(next)])),
    )
}

/// `(text)::int`: Postgres's int4 input, which allows surrounding white space and a sign and refuses anything else.
fn int4_text(text: &str) -> Result<i64> {
    let trimmed = text.trim_matches(|c: char| c.is_ascii_whitespace());
    trimmed.parse::<i32>().map(i64::from).map_err(|_| {
        StoreError::invalid(format!("invalid input syntax for type integer: \"{text}\""))
    })
}

/// `jsonb ->> key` of a soak counter: the value's text, or `None` for a missing key, a JSON null or a non-object.
fn counter_text(first: &Value, kind: &str) -> Option<String> {
    match first.as_object()?.get(kind)? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// `addSoakCounterEvent(op, day, kind, n)` (engine-sql/soak-counters.ts): the row `(op, day)` becomes
/// `[{ day, kind: n }]` when new; otherwise its first record gets `kind` = `(first->>kind)::int` (0 when absent) + `n`.
/// As in Postgres: `kind` = "day" overwrites the day in a new row, a first record that is NULL leaves `[null]`, an
/// array or scalar first record concatenates (`||`), and a count that is not an int4 or overflows one refuses.
pub(crate) fn add_soak_counter_event_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    day: &str,
    kind: &str,
    n: i64,
) -> Result<()> {
    let n = i32::try_from(n).map_err(|_| StoreError::invalid("integer out of range"))?;
    let completed = match get_json::<HousekeepingRow>(&*tx, &parent_key(op, day)?)? {
        None => {
            let mut record = serde_json::Map::new();
            record.insert("day".to_owned(), json!(day));
            record.insert(kind.to_owned(), json!(n));
            json!([Value::Object(record)])
        }
        Some(row) => {
            let first = row.completed_keys.get(0).cloned().unwrap_or(Value::Null);
            let old = match counter_text(&first, kind) {
                Some(text) => int4_text(&text)?,
                None => 0,
            };
            let sum = i32::try_from(old + i64::from(n))
                .map_err(|_| StoreError::invalid("integer out of range"))?;
            let mut add = serde_json::Map::new();
            add.insert(kind.to_owned(), json!(sum));
            let merged = match first {
                Value::Null => Value::Null,
                Value::Object(mut record) => {
                    record.extend(add);
                    Value::Object(record)
                }
                Value::Array(mut items) => {
                    items.push(Value::Object(add));
                    Value::Array(items)
                }
                scalar => json!([scalar, Value::Object(add)]),
            };
            json!([merged])
        }
    };
    write_op_checkpoint_record_in(tx, env, op, day, Some(&completed))
}

/// `replaceOpCheckpointAtVersion(op, fingerprint, completedKeys, expected)`: `UPDATE ... WHERE op=$1
/// AND fingerprint=$2 AND (completed_keys->0->>'v')::int = $4 RETURNING 1`. True when the parent's
/// first record held `v` = `expected` and this call replaced the records. A `v` that is not an
/// integer refuses, as the `::int` cast does; a missing `v` matches nothing.
pub(crate) fn replace_op_checkpoint_at_version_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    completed: &Value,
    expected: i64,
) -> Result<bool> {
    let Some(row) = get_json::<HousekeepingRow>(&*tx, &parent_key(op, fingerprint)?)? else {
        return Ok(false);
    };
    let version = match row.completed_keys.get(0).and_then(|first| first.get("v")) {
        None | Some(Value::Null) => return Ok(false),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    let Ok(version) = version.trim().parse::<i32>() else {
        return Err(StoreError::invalid(format!(
            "invalid input syntax for type integer: \"{version}\""
        )));
    };
    if i64::from(version) != expected {
        return Ok(false);
    }
    write_op_checkpoint_record_in(tx, env, op, fingerprint, Some(completed))?;
    Ok(true)
}

const DAY_US: f64 = 86_400_000_000.0;

/// The ops the purge never deletes (`op NOT IN (...)` and each `op<>'...'` of the statement).
const NEVER_PURGED: &[&str] = &[
    "managed-atoms",
    "managed-atoms-generation",
    "managed-connector",
    "managed-connector-retry",
    "managed-connector-state",
    "managed-connector-migration",
    "connector-hold-retry",
    "connector-db-cursor",
    "stuck-recovery-resolution",
    "sync-admission",
    "purge-deleted-park",
    "derived-origin-park",
    "owed-page-purge",
    "managed-sync-failure",
];

/// The ops kept while their source incarnation lives: the Git sync holds and their records, the plain-directory agreement rows (`PLAIN_DIRECTORY_AGREED_OP`), the
/// fence census and repair rows (`FENCE_CANDIDATE_OP`, `FENCE_SCAN_OP`, `FENCE_REPAIR_ATTEMPT_OP`,
/// `FENCE_UNCOMMITTED_OP`) and the managed sync pass rows (`SYNC_PASS_ROW_OPS`).
const KEPT_WITH_INCARNATION: &[&str] = &[
    "sync-hold",
    "sync-hold-retry",
    "sync-import-provenance",
    "plain-directory-agreed",
    "sync-hold-summary",
    "sync-conversions",
    "fence-candidate",
    "fence-scan",
    "fence-repair-attempt",
    "fence-repair-uncommitted",
    "managed-sync-pass",
    "sync-origin-deleted",
    "sync-deletes-withheld",
    "sync-pass-cost",
];

/// `SYNC_DELETE_TOMBSTONE_OP`.
const SYNC_DELETE_TOMBSTONE: &str = "sync-delete-tombstone";

/// One parent the purge reads: its op, fingerprint, first completed key and stamp.
struct Parent {
    key: Vec<u8>,
    op: String,
    fingerprint: String,
    first: Option<Value>,
    updated_at_us: i64,
}

impl Parent {
    /// `completed_keys->0->>'<name>'`: the text of a field of the first key, `None` for SQL NULL.
    fn field(&self, name: &str) -> Option<String> {
        match self.first.as_ref()?.get(name)? {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            other => Some(other.to_string()),
        }
    }

    /// `COALESCE(completed_keys->0->>'done','false')<>'true'`.
    fn not_done(&self) -> bool {
        self.field("done").as_deref().unwrap_or("false") != "true"
    }
}

/// Whether the page whose id text is `fingerprint` has `deleted_at` equal to the time `at`
/// (`p.deleted_at = (...->>'deleted_at')::timestamptz`). `at` is read as `::timestamptz` reads the
/// forms the writers store: the Postgres writer's jsonb text, with the session's offset
/// (`2026-11-19T17:05:00.123456+00:00`), and ISO with `Z`. A time the store cannot read counts as
/// equal, so the row stays (Postgres would refuse the whole purge).
fn page_deleted_at(read: &dyn KvRead, fingerprint: &str, at: Option<String>) -> Result<bool> {
    let Some(at) = at else {
        return Ok(false);
    };
    let Some(id) = fingerprint
        .parse::<u64>()
        .ok()
        .filter(|id| id.to_string() == fingerprint)
    else {
        return Ok(false);
    };
    let Some(page) = read_page_by_id(read, id)? else {
        return Ok(false);
    };
    Ok(match parse_timestamptz(&at, "deleted_at") {
        Ok(at) => page.deleted_at_us == Some(at),
        Err(_) => true,
    })
}

/// Whether an exemption keeps `p` (the `AND NOT (...)` clauses of the statement).
fn exempt(read: &dyn KvRead, p: &Parent, parents: &[Parent]) -> Result<bool> {
    let op = p.op.as_str();
    if NEVER_PURGED.contains(&op) {
        return Ok(true);
    }
    if op == SYNC_DELETE_TOMBSTONE {
        return page_deleted_at(read, &p.fingerprint, p.field("deleted_at"));
    }
    if op == "sync-identity-downgrade" {
        return Ok(p.field("disposition").is_none()
            && page_deleted_at(read, &p.fingerprint, p.field("old_deleted_at"))?);
    }
    if KEPT_WITH_INCARNATION.contains(&op) {
        if op == "sync-hold-summary" {
            // `COALESCE((...->>'count')::int,0)=0`; a count the store cannot read keeps the row.
            let count = match p.field("count") {
                None => 0,
                Some(text) => match text.trim().parse::<i32>() {
                    Ok(n) => n,
                    Err(_) => return Ok(true),
                },
            };
            if count == 0 {
                return Ok(false);
            }
        }
        let (Some(source_id), Some(incarnation)) = (p.field("source_id"), p.field("incarnation"))
        else {
            return Ok(false);
        };
        return Ok(read_source(read, &source_id)?.is_some_and(|s| s.incarnation == incarnation));
    }
    if op == "managed-sync" {
        return Ok(p.not_done()
            || parents
                .iter()
                .any(|f| f.op == "managed-sync-failure" && f.fingerprint == p.fingerprint));
    }
    if op == "managed-sync-manifest" {
        return Ok(parents.iter().any(|c| {
            c.op == "managed-sync"
                && c.field("runId").as_deref() == Some(p.fingerprint.as_str())
                && c.not_done()
        }));
    }
    Ok(false)
}

/// `purgeStaleCheckpoints(ttlDays)`: deletes each parent stamped before `now - ttlDays` days that
/// no exemption keeps, and its paths, and returns how many parents it deleted. The exemptions read
/// the rows as they were before the purge, as the Postgres statement's snapshot does.
pub(crate) fn purge_stale_checkpoints_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    ttl_days: f64,
) -> Result<i64> {
    if !ttl_days.is_finite() {
        return Err(StoreError::invalid(
            "purgeStaleCheckpoints ttlDays must be a finite number",
        ));
    }
    let cutoff = env.now_micros() as f64 - ttl_days * DAY_US;
    let prefix = [keys::PERSISTENCE, super::HOUSEKEEPING];
    let mut parents = Vec::new();
    scan_prefix(&*tx, &prefix, false, &mut |k, v| {
        let rest = &k[prefix.len()..];
        let Some(nul) = rest.iter().position(|b| *b == 0) else {
            return true;
        };
        // A row the store cannot read is kept.
        let Ok(row) = serde_json::from_slice::<HousekeepingRow>(v) else {
            return true;
        };
        parents.push(Parent {
            key: k.to_vec(),
            op: String::from_utf8_lossy(&rest[..nul]).into_owned(),
            fingerprint: String::from_utf8_lossy(&rest[nul + 1..]).into_owned(),
            first: row.completed_keys.get(0).cloned(),
            updated_at_us: row.updated_at_us,
        });
        true
    })?;
    let mut stale = Vec::new();
    for p in &parents {
        if (p.updated_at_us as f64) < cutoff && !exempt(&*tx, p, &parents)? {
            stale.push(p);
        }
    }
    for p in &stale {
        tx.delete(&p.key)?;
        delete_op_checkpoint_paths_in(tx, &p.op, &p.fingerprint)?;
    }
    Ok(stale.len() as i64)
}

/// The op of a page's atom generation ledger (`ATOM_GENERATION_OP`).
const ATOM_GENERATION_OP: &str = "managed-atoms-generation";
/// The op of a completed managed atom run.
const MANAGED_ATOMS_OP: &str = "managed-atoms";

/// `recordAtomGenerationBump(sourceId, incarnation, pageId, keepContentHash, keepGeneration)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AtomGenerationBump {
    pub source_id: String,
    pub incarnation: String,
    pub page_id: i64,
    pub keep_content_hash: Option<String>,
    pub keep_generation: Option<i64>,
}

/// `completed_keys->0->>field` of a checkpoint row.
fn first_key_text(row: &HousekeepingRow, field: &str) -> Option<String> {
    row.completed_keys
        .get(0)
        .and_then(|first| first.get(field))
        .and_then(crate::timeline_queries::jsonb_field_text)
}

impl Store {
    /// `readAtomGeneration(pageId, contentHash)`: of the page's `managed-atoms-generation` ledger row, `keep_generation`
    /// when `keep` is `contentHash`, else `generation`, as a number (`Number(text ?? 0)`); 0 with no row.
    pub fn read_atom_generation(&self, page_id: i64, content_hash: &str) -> Result<f64> {
        let read = self.read()?;
        let Some(row) = get_json::<HousekeepingRow>(
            &*read,
            &parent_key(ATOM_GENERATION_OP, &page_id.to_string())?,
        )?
        else {
            return Ok(0.0);
        };
        let field = if first_key_text(&row, "keep").as_deref() == Some(content_hash) {
            "keep_generation"
        } else {
            "generation"
        };
        Ok(match first_key_text(&row, field) {
            None => 0.0,
            Some(text) => text.trim().parse::<f64>().unwrap_or(f64::NAN),
        })
    }

    /// `recordAtomGenerationBump(...)`: upserts the page's ledger row `[{ generation, keep, keep_generation }]`
    /// (generation 1, or the stored one plus 1), stamped now, and deletes the `managed-atoms` checkpoints of the source's
    /// page whose `contentHash` is not the kept one. The store keeps no `extract_atoms_page_state` rows, so that
    /// statement deletes nothing here.
    pub fn record_atom_generation_bump(&self, a: &AtomGenerationBump) -> Result<()> {
        let _ = &a.incarnation;
        let fingerprint = a.page_id.to_string();
        self.write(|tx| {
            let key = parent_key(ATOM_GENERATION_OP, &fingerprint)?;
            let generation = match get_json::<HousekeepingRow>(&*tx, &key)? {
                None => 1,
                Some(row) => match first_key_text(&row, "generation") {
                    None => 1,
                    Some(text) => text.trim().parse::<i64>().map_err(|_| {
                        StoreError::invalid(format!("invalid input syntax for type integer: \"{text}\""))
                    })? + 1,
                },
            };
            let record = crate::jsonb::order(json!({
                "generation": generation, "keep": a.keep_content_hash, "keep_generation": a.keep_generation,
            }));
            write_op_checkpoint_record_in(tx, &*self.env, ATOM_GENERATION_OP, &fingerprint, Some(&json!([record])))?;
            let mut prefix = vec![keys::PERSISTENCE, super::HOUSEKEEPING];
            prefix.extend_from_slice(MANAGED_ATOMS_OP.as_bytes());
            prefix.push(0);
            let mut gone: Vec<String> = Vec::new();
            let mut bad = false;
            scan_prefix(&*tx, &prefix, false, &mut |k, v| {
                match (std::str::from_utf8(&k[prefix.len()..]), serde_json::from_slice::<HousekeepingRow>(v)) {
                    (Ok(fp), Ok(row)) => {
                        if first_key_text(&row, "sourceId").as_deref() == Some(a.source_id.as_str())
                            && first_key_text(&row, "kind").as_deref() == Some("page")
                            && first_key_text(&row, "pageId").as_deref() == Some(fingerprint.as_str())
                            && first_key_text(&row, "contentHash") != a.keep_content_hash
                        {
                            gone.push(fp.to_string());
                        }
                    }
                    _ => bad = true,
                }
                !bad
            })?;
            if bad {
                return Err(StoreError::new(crate::error::STORE_CORRUPT, "an op checkpoint row is not readable"));
            }
            for fp in gone {
                delete_op_checkpoint_in(tx, MANAGED_ATOMS_OP, &fp)?;
            }
            Ok(())
        })
    }

    /// `readOpCheckpointDoc(op, fingerprint)`: the one JSON document the parent holds
    /// (`completed_keys -> 0`), or JSON null when there is no parent, its keys are not an array or
    /// the array is empty. The propose_takes failure ledger keeps its record this way.
    pub fn read_op_checkpoint_doc(&self, op: &str, fingerprint: &str) -> Result<Value> {
        let row = get_json::<HousekeepingRow>(&*self.read()?, &parent_key(op, fingerprint)?)?;
        Ok(row
            .and_then(|r| match r.completed_keys {
                Value::Array(mut items) if !items.is_empty() => Some(items.swap_remove(0)),
                _ => None,
            })
            .unwrap_or(Value::Null))
    }

    /// `writeOpCheckpointDoc(op, fingerprint, doc)`: the parent's keys replaced by `[doc]`, its
    /// stamp now (`ON CONFLICT ... DO UPDATE`). The children stay.
    pub fn write_op_checkpoint_doc(&self, op: &str, fingerprint: &str, doc: &Value) -> Result<()> {
        let key = parent_key(op, fingerprint)?;
        fn has_nul(v: &Value) -> bool {
            match v {
                Value::String(t) => t.contains('\0'),
                Value::Array(items) => items.iter().any(has_nul),
                Value::Object(map) => map.iter().any(|(k, v)| k.contains('\0') || has_nul(v)),
                _ => false,
            }
        }
        // jsonb refuses `\u0000`, as the SQL's `$3::jsonb` parse does.
        if has_nul(doc) {
            return Err(StoreError::invalid(
                "an op checkpoint document cannot contain NUL",
            ));
        }
        self.write(|tx| {
            put_json(
                tx,
                &key,
                &HousekeepingRow {
                    completed_keys: json!([crate::jsonb::ordered(doc)]),
                    updated_at_us: self.env.now_micros(),
                },
            )
        })
    }
    /// `readOpCheckpointRecord(op, fingerprint, { freshWithinDays })`.
    pub fn read_op_checkpoint_record(
        &self,
        op: &str,
        fingerprint: &str,
        fresh_days: Option<f64>,
    ) -> Result<Value> {
        read_op_checkpoint_record_in(&*self.read()?, &*self.env, op, fingerprint, fresh_days)
    }

    /// `listOpCheckpointRecords(op)`.
    pub fn list_op_checkpoint_records(&self, op: &str) -> Result<Value> {
        list_op_checkpoint_records_in(&*self.read()?, op)
    }

    /// `writeOpCheckpointRecord(op, fingerprint, completedKeys)`.
    pub fn write_op_checkpoint_record(
        &self,
        op: &str,
        fingerprint: &str,
        completed: Option<&Value>,
    ) -> Result<()> {
        self.write(|tx| write_op_checkpoint_record_in(tx, &*self.env, op, fingerprint, completed))
    }

    /// `insertOpCheckpointIfAbsent(op, fingerprint, completedKeys)`.
    pub fn insert_op_checkpoint_if_absent(
        &self,
        op: &str,
        fingerprint: &str,
        completed: &Value,
    ) -> Result<bool> {
        self.write(|tx| {
            insert_op_checkpoint_if_absent_in(tx, &*self.env, op, fingerprint, completed)
        })
    }

    /// `upsertFenceTrendRunRecord(op, fingerprint, record)`.
    pub fn upsert_fence_trend_run_record(
        &self,
        op: &str,
        fingerprint: &str,
        record: &Value,
    ) -> Result<()> {
        self.write(|tx| upsert_fence_trend_run_record_in(tx, &*self.env, op, fingerprint, record))
    }

    /// `addSoakCounterEvent(op, day, kind, n)`.
    pub fn add_soak_counter_event(&self, op: &str, day: &str, kind: &str, n: i64) -> Result<()> {
        self.write(|tx| add_soak_counter_event_in(tx, &*self.env, op, day, kind, n))
    }

    /// `replaceOpCheckpointAtVersion(op, fingerprint, completedKeys, expected)`.
    pub fn replace_op_checkpoint_at_version(
        &self,
        op: &str,
        fingerprint: &str,
        completed: &Value,
        expected: i64,
    ) -> Result<bool> {
        self.write(|tx| {
            replace_op_checkpoint_at_version_in(
                tx,
                &*self.env,
                op,
                fingerprint,
                completed,
                expected,
            )
        })
    }

    /// `readOpCheckpointKeys(op, fingerprint)`.
    pub fn read_op_checkpoint_keys(&self, op: &str, fingerprint: &str) -> Result<Value> {
        read_op_checkpoint_keys_in(&*self.read()?, op, fingerprint)
    }

    /// `writeOpCheckpointKeys(op, fingerprint, keys)`.
    pub fn write_op_checkpoint_keys(
        &self,
        op: &str,
        fingerprint: &str,
        completed: &[String],
    ) -> Result<()> {
        self.write(|tx| write_op_checkpoint_keys_in(tx, &*self.env, op, fingerprint, completed))
    }

    /// `appendOpCheckpointPaths(op, fingerprint, paths)`.
    pub fn append_op_checkpoint_paths(
        &self,
        op: &str,
        fingerprint: &str,
        paths: &[String],
    ) -> Result<()> {
        self.write(|tx| append_op_checkpoint_paths_in(tx, &*self.env, op, fingerprint, paths))
    }

    /// `readOpCheckpointRecords(op, fingerprints)`.
    pub fn read_op_checkpoint_records(&self, op: &str, fingerprints: &[String]) -> Result<Value> {
        read_op_checkpoint_records_in(&*self.read()?, op, fingerprints)
    }

    /// `writeOpCheckpointRecords(op, rows)`.
    pub fn write_op_checkpoint_records(&self, op: &str, rows: &[(String, Value)]) -> Result<()> {
        self.write(|tx| write_op_checkpoint_records_in(tx, &*self.env, op, rows))
    }

    /// `deleteOpCheckpoint(op, fingerprint)`.
    pub fn delete_op_checkpoint(&self, op: &str, fingerprint: &str) -> Result<()> {
        self.write(|tx| delete_op_checkpoint_in(tx, op, fingerprint))
    }

    /// `deleteOpCheckpointPaths(op, fingerprint)`.
    pub fn delete_op_checkpoint_paths(&self, op: &str, fingerprint: &str) -> Result<()> {
        self.write(|tx| delete_op_checkpoint_paths_in(tx, op, fingerprint))
    }

    /// `purgeStaleCheckpoints(ttlDays)`.
    pub fn purge_stale_checkpoints(&self, ttl_days: f64) -> Result<i64> {
        self.write(|tx| purge_stale_checkpoints_in(tx, &*self.env, ttl_days))
    }
}

#[cfg(test)]
mod tests {
    use crate::keys;
    use crate::kv::scan_prefix;
    use crate::test_support::store;
    use serde_json::json;

    /// The bytes after `keys::PERSISTENCE` of the `persistence_effects` rows (`d 0x05 <request id>
    /// 0x00 <kind>`) and their claim-order index (`d 0x06 <id>`), `effects.rs`.
    const EFFECT_FAMILIES: [u8; 2] = [0x05, 0x06];

    #[test]
    fn a_checkpoint_path_key_never_falls_in_the_effect_key_range() {
        // An op and fingerprint spelled as an effect's request id and kind: the path key then has
        // the same bytes after its family byte as that effect's key.
        let (op, fingerprint) = ("8f14e45f-ceea-467f-a0e6-f3c1c4a5b6d7", "page_write");
        let path = super::paths_prefix(op, fingerprint).unwrap();
        for family in EFFECT_FAMILIES {
            let mut effect = vec![keys::PERSISTENCE, family];
            effect.extend_from_slice(op.as_bytes());
            effect.push(0);
            effect.extend_from_slice(fingerprint.as_bytes());
            assert!(
                !path.starts_with(&[keys::PERSISTENCE, family]),
                "a checkpoint path key uses the effect family byte {family:#04x}"
            );
            assert!(!path.starts_with(&effect) && !effect.starts_with(&path));
        }
        let store = store();
        store
            .append_op_checkpoint_paths(op, fingerprint, &[String::from("a.md")])
            .unwrap();
        let read = store.read().unwrap();
        for family in EFFECT_FAMILIES {
            let mut seen = 0;
            scan_prefix(&*read, &[keys::PERSISTENCE, family], false, &mut |_, _| {
                seen += 1;
                true
            })
            .unwrap();
            assert_eq!(
                seen, 0,
                "an effect scan of {family:#04x} reads a checkpoint path"
            );
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_stopped_op_reads_back_its_paths_and_keys_and_a_clear_leaves_nothing() {
        let store = store();
        let none = json!({ "keys": [], "corruptParent": false });
        assert_eq!(store.read_op_checkpoint_keys("embed", "f1").unwrap(), none);
        store
            .append_op_checkpoint_paths("embed", "f1", &strings(&["b", "a"]))
            .unwrap();
        // A banked path appended again is a no-op.
        store
            .append_op_checkpoint_paths("embed", "f1", &strings(&["a"]))
            .unwrap();
        store
            .write_op_checkpoint_keys("embed", "f1", &strings(&["b", "c"]))
            .unwrap();
        assert_eq!(
            store.read_op_checkpoint_keys("embed", "f1").unwrap(),
            json!({ "keys": ["a", "b", "c"], "corruptParent": false })
        );
        // Another fingerprint, and another op with this fingerprint, read nothing of it.
        assert_eq!(store.read_op_checkpoint_keys("embed", "f").unwrap(), none);
        assert_eq!(
            store.read_op_checkpoint_keys("extract", "f1").unwrap(),
            none
        );
        // An append keeps the parent's keys.
        store
            .append_op_checkpoint_paths("embed", "f1", &strings(&["d"]))
            .unwrap();
        assert_eq!(
            store.read_op_checkpoint_keys("embed", "f1").unwrap()["keys"],
            json!(["a", "b", "d", "c"])
        );
        store.delete_op_checkpoint_paths("embed", "f1").unwrap();
        assert_eq!(
            store.read_op_checkpoint_keys("embed", "f1").unwrap()["keys"],
            json!(["b", "c"])
        );
        store
            .append_op_checkpoint_paths("embed", "f1", &strings(&["e"]))
            .unwrap();
        store.delete_op_checkpoint("embed", "f1").unwrap();
        assert_eq!(store.read_op_checkpoint_keys("embed", "f1").unwrap(), none);
    }

    /// A clock the test moves; identifiers come from the system.
    struct Clock(std::sync::atomic::AtomicI64);

    impl crate::env::Env for Clock {
        fn now_micros(&self) -> i64 {
            self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
        fn new_uuid(&self) -> String {
            crate::env::SystemEnv.new_uuid()
        }
    }

    #[test]
    fn the_purge_deletes_a_stale_checkpoint_and_its_paths_and_keeps_fresh_and_exempt_ones() {
        use super::{HousekeepingRow, parent_key};
        use crate::env::Env;
        use std::sync::Arc;
        use std::sync::atomic::Ordering;

        const DAY: i64 = 86_400_000_000;
        let clock = Arc::new(Clock(std::sync::atomic::AtomicI64::new(
            1_800_000_000_000_000,
        )));
        let store = crate::test_support::store_on(clock.clone());
        let incarnation = crate::sources::read_source(&*store.read().unwrap(), "default")
            .unwrap()
            .unwrap()
            .incarnation;
        // A parent whose first completed key is `first`, stamped now.
        let put = |op: &str, fingerprint: &str, first: serde_json::Value| {
            let now = clock.now_micros();
            store
                .write(|tx| {
                    crate::put_json(
                        tx,
                        &parent_key(op, fingerprint).unwrap(),
                        &HousekeepingRow {
                            completed_keys: json!([first]),
                            updated_at_us: now,
                        },
                    )
                })
                .unwrap();
        };
        store
            .append_op_checkpoint_paths("embed", "old", &strings(&["a.md", "b.md"]))
            .unwrap();
        put("connector-hold-retry", "kept", json!("x"));
        put("managed-sync", "running", json!({ "done": false }));
        put("managed-sync", "finished", json!({ "done": true }));
        put("managed-sync", "failed", json!({ "done": true }));
        put("managed-sync-failure", "failed", json!({}));
        put(
            "managed-sync",
            "run-1",
            json!({ "done": false, "runId": "manifest-1" }),
        );
        put("managed-sync-manifest", "manifest-1", json!({}));
        put("managed-sync-manifest", "manifest-2", json!({}));
        let live = json!({ "source_id": "default", "incarnation": incarnation });
        put("sync-hold", "live", live.clone());
        put(
            "sync-hold",
            "gone",
            json!({ "source_id": "default", "incarnation": "other" }),
        );
        put(
            "sync-hold-summary",
            "empty",
            json!({ "source_id": "default", "incarnation": incarnation, "count": 0 }),
        );
        put(
            "sync-hold-summary",
            "counted",
            json!({ "source_id": "default", "incarnation": incarnation, "count": 2 }),
        );
        put(
            "sync-delete-tombstone",
            "999",
            json!({ "deleted_at": "2026-01-01T00:00:00Z" }),
        );

        // Nothing is seven days old yet.
        assert_eq!(store.purge_stale_checkpoints(7.0).unwrap(), 0);
        clock.0.fetch_add(8 * DAY, Ordering::SeqCst);
        store
            .write_op_checkpoint_keys("embed", "fresh", &strings(&["c.md"]))
            .unwrap();

        // Deleted: embed/old, managed-sync/finished, managed-sync-manifest/manifest-2,
        // sync-hold/gone, sync-hold-summary/empty and the tombstone with no page.
        assert_eq!(store.purge_stale_checkpoints(7.0).unwrap(), 6);
        let none = json!({ "keys": [], "corruptParent": false });
        assert_eq!(store.read_op_checkpoint_keys("embed", "old").unwrap(), none);
        assert_eq!(
            store.read_op_checkpoint_keys("embed", "fresh").unwrap()["keys"],
            json!(["c.md"])
        );
        let read = store.read().unwrap();
        let mut left = Vec::new();
        scan_prefix(
            &*read,
            &[keys::PERSISTENCE, super::super::HOUSEKEEPING],
            false,
            &mut |k, _| {
                left.push(String::from_utf8_lossy(&k[2..]).replace('\0', "/"));
                true
            },
        )
        .unwrap();
        assert_eq!(
            left,
            [
                "connector-hold-retry/kept",
                "embed/fresh",
                "managed-sync/failed",
                "managed-sync/run-1",
                "managed-sync/running",
                "managed-sync-failure/failed",
                "managed-sync-manifest/manifest-1",
                "sync-hold/live",
                "sync-hold-summary/counted",
            ]
        );
        let mut paths = 0;
        scan_prefix(
            &*read,
            &[keys::PERSISTENCE, super::super::CHECKPOINT_PATH],
            false,
            &mut |_, _| {
                paths += 1;
                true
            },
        )
        .unwrap();
        assert_eq!(paths, 0, "the stale checkpoint's paths go with it");
        drop(read);
        assert!(store.purge_stale_checkpoints(f64::NAN).is_err());
    }

    #[test]
    fn the_purge_keeps_a_sync_delete_tombstone_while_its_page_has_the_recorded_deleted_at() {
        use super::{HousekeepingRow, parent_key};
        use crate::env::{Env, iso};
        use crate::pages::{PageInput, PutPageOptions, read_page};
        use std::sync::Arc;
        use std::sync::atomic::Ordering;

        const DAY: i64 = 86_400_000_000;
        // A clock with microseconds, as Postgres's `now()` has.
        let clock = Arc::new(Clock(std::sync::atomic::AtomicI64::new(
            1_800_000_000_123_456,
        )));
        let store = crate::test_support::store_on(clock.clone());
        // Writes `slug`, soft-deletes it and returns its id and `deleted_at`.
        let deleted = |slug: &str| -> (u64, i64) {
            let input: PageInput = serde_json::from_value(
                json!({ "type": "note", "title": slug, "compiled_truth": "body" }),
            )
            .unwrap();
            store
                .put_page(slug, &input, &PutPageOptions::default())
                .unwrap();
            store.soft_delete_page(slug, None).unwrap().unwrap();
            let page = read_page(&*store.read().unwrap(), "default", slug)
                .unwrap()
                .unwrap();
            (page.id, page.deleted_at_us.unwrap())
        };
        let put = |op: &str, fingerprint: &str, first: serde_json::Value| {
            let now = clock.now_micros();
            store
                .write(|tx| {
                    crate::put_json(
                        tx,
                        &parent_key(op, fingerprint).unwrap(),
                        &HousekeepingRow {
                            completed_keys: json!([first]),
                            updated_at_us: now,
                        },
                    )
                })
                .unwrap();
        };
        let tombstone = |fingerprint: &str, deleted_at: &str| {
            put(
                "sync-delete-tombstone",
                fingerprint,
                json!({ "deleted_at": deleted_at }),
            )
        };

        let (open, open_at) = deleted("notes/open");
        tombstone(&open.to_string(), &iso(open_at));
        // The millisecond form `Date#toISOString` gives names the same time when it has no
        // microseconds; this page's `deleted_at` has them, so the millisecond form does not match.
        let (ms, ms_at) = deleted("notes/ms");
        tombstone(&ms.to_string(), &iso(ms_at - ms_at.rem_euclid(1_000)));
        let (moved, moved_at) = deleted("notes/moved");
        tombstone(&moved.to_string(), &iso(moved_at - 1));
        let (restored, restored_at) = deleted("notes/restored");
        tombstone(&restored.to_string(), &iso(restored_at));
        assert!(store.restore_page("notes/restored", None).unwrap());
        // A fingerprint that is not the exact text of a page id names no page.
        let (padded, padded_at) = deleted("notes/padded");
        tombstone(&format!("0{padded}"), &iso(padded_at));
        // The form the Postgres writer stores (`jsonb_build_object('deleted_at', p.deleted_at)`): the
        // session's offset, here UTC and Pacific. Each names its page's `deleted_at`.
        let offset_form = |us: i64, zone: &str, zone_us: i64| {
            iso(us + zone_us).trim_end_matches('Z').to_string() + zone
        };
        let (utc, utc_at) = deleted("notes/utc");
        tombstone(&utc.to_string(), &offset_form(utc_at, "+00:00", 0));
        let (pacific, pacific_at) = deleted("notes/pacific");
        let pst = -8 * 3_600_000_000;
        tombstone(
            &pacific.to_string(),
            &offset_form(pacific_at, "-08:00", pst),
        );
        // The same form one microsecond off names another time.
        let (utc_moved, utc_moved_at) = deleted("notes/utc-moved");
        tombstone(
            &utc_moved.to_string(),
            &offset_form(utc_moved_at + 1, "+00:00", 0),
        );
        // A time the store cannot read keeps the record (Postgres fails the whole purge).
        let (unread, _) = deleted("notes/unread");
        tombstone(&unread.to_string(), "not a time");
        // An identity downgrade with no disposition is kept the same way, on `old_deleted_at`.
        let (down, down_at) = deleted("notes/down");
        put(
            "sync-identity-downgrade",
            &down.to_string(),
            json!({ "old_deleted_at": iso(down_at) }),
        );
        let (decided, decided_at) = deleted("notes/decided");
        put(
            "sync-identity-downgrade",
            &decided.to_string(),
            json!({ "old_deleted_at": iso(decided_at), "disposition": "kept" }),
        );

        clock.0.fetch_add(8 * DAY, Ordering::SeqCst);
        // Deleted: the millisecond, moved, restored, padded and offset-form moved tombstones and the
        // decided downgrade.
        assert_eq!(store.purge_stale_checkpoints(7.0).unwrap(), 6);
        let read = store.read().unwrap();
        let mut left = Vec::new();
        scan_prefix(
            &*read,
            &[keys::PERSISTENCE, super::super::HOUSEKEEPING],
            false,
            &mut |k, _| {
                left.push(String::from_utf8_lossy(&k[2..]).replace('\0', "/"));
                true
            },
        )
        .unwrap();
        left.sort();
        let mut want = vec![
            format!("sync-delete-tombstone/{open}"),
            format!("sync-delete-tombstone/{utc}"),
            format!("sync-delete-tombstone/{pacific}"),
            format!("sync-delete-tombstone/{unread}"),
            format!("sync-identity-downgrade/{down}"),
        ];
        want.sort();
        assert_eq!(left, want);
    }

    #[test]
    fn a_checkpoint_part_with_nul_is_refused() {
        let store = store();
        assert!(store.read_op_checkpoint_keys("embed\0x", "f").is_err());
        assert!(
            store
                .append_op_checkpoint_paths("embed", "f", &strings(&["a\0b"]))
                .is_err()
        );
        assert!(
            store
                .write_op_checkpoint_keys("embed", "f", &strings(&["a\0b"]))
                .is_err()
        );
    }

    #[test]
    fn a_checkpoint_document_reads_back_and_keeps_the_paths() {
        let s = store();
        assert_eq!(s.read_op_checkpoint_doc("op", "fp").unwrap(), json!(null));
        s.append_op_checkpoint_paths("op", "fp", &strings(&["a"]))
            .unwrap();
        assert_eq!(s.read_op_checkpoint_doc("op", "fp").unwrap(), json!(null));
        s.write_op_checkpoint_doc("op", "fp", &json!({"pages": {"x": 3}}))
            .unwrap();
        assert_eq!(
            s.read_op_checkpoint_doc("op", "fp").unwrap(),
            json!({"pages": {"x": 3}})
        );
        assert!(
            s.write_op_checkpoint_doc("op", "fp", &json!({"k": "a\u{0}b"}))
                .is_err()
        );
    }

    #[test]
    fn a_record_write_replaces_the_parent_keeps_the_paths_and_reads_back_its_first_key() {
        let store = store();
        let rows = |items: &[(&str, serde_json::Value)]| -> Vec<(String, serde_json::Value)> {
            items
                .iter()
                .map(|(f, v)| (f.to_string(), v.clone()))
                .collect()
        };
        store
            .append_op_checkpoint_paths("prov", "p1", &strings(&["kept.md"]))
            .unwrap();
        store
            .write_op_checkpoint_records(
                "prov",
                &rows(&[
                    ("p1", json!({ "page_id": 1 })),
                    ("p2", json!({ "page_id": 2 })),
                ]),
            )
            .unwrap();
        store
            .write_op_checkpoint_records("prov", &rows(&[("p1", json!({ "page_id": 11 }))]))
            .unwrap();
        store
            .write_op_checkpoint_keys("prov", "empty", &[])
            .unwrap();
        let read = store
            .read_op_checkpoint_records("prov", &strings(&["p1", "p2", "p1", "empty", "absent"]))
            .unwrap();
        assert_eq!(read, json!([{ "page_id": 11 }, { "page_id": 2 }, null]));
        // The paths stay, as the Postgres upsert leaves `op_checkpoint_paths` alone.
        assert_eq!(
            store.read_op_checkpoint_keys("prov", "p1").unwrap()["keys"],
            json!(["kept.md", "{\"page_id\": 11}"])
        );
        // A NUL anywhere in a record refuses the whole batch.
        assert!(
            store
                .write_op_checkpoint_records(
                    "prov",
                    &rows(&[("p3", json!({ "ok": 1 })), ("p4", json!({ "k\u{0}": 1 }))]),
                )
                .is_err()
        );
        assert_eq!(
            store
                .read_op_checkpoint_records("prov", &strings(&["p3"]))
                .unwrap(),
            json!([])
        );
    }

    #[test]
    fn a_record_reads_back_with_its_stamp_and_freshness_and_a_null_write_deletes_it() {
        let store = store();
        assert_eq!(
            store
                .read_op_checkpoint_record("repair", "f", Some(7.0))
                .unwrap(),
            serde_json::Value::Null
        );
        let records = json!([{ "kind": "k", "cursor": { "id": 3 }, "run_id": "r" }]);
        store
            .write_op_checkpoint_record("repair", "f", Some(&records))
            .unwrap();
        let row = store
            .read_op_checkpoint_record("repair", "f", Some(7.0))
            .unwrap();
        assert_eq!(row["completed_keys"], records);
        assert_eq!(row["fresh"], json!(true));
        let stamp = row["updated_at"].as_str().unwrap();
        assert_eq!(stamp.len(), "2026-01-01T00:00:00.000Z".len(), "{stamp}");
        assert!(stamp.ends_with('Z'));
        assert_eq!(
            store
                .read_op_checkpoint_record("repair", "f", None)
                .unwrap()["fresh"],
            serde_json::Value::Null
        );
        // A record element reads back through `readOpCheckpointKeys` as its jsonb text.
        assert_eq!(
            store.read_op_checkpoint_keys("repair", "f").unwrap()["keys"],
            json!([r#"{"kind": "k", "cursor": {"id": 3}, "run_id": "r"}"#])
        );
        // Another fingerprint and another op read nothing.
        assert_eq!(
            store
                .read_op_checkpoint_record("repair", "g", None)
                .unwrap(),
            serde_json::Value::Null
        );
        assert_eq!(
            store.read_op_checkpoint_record("embed", "f", None).unwrap(),
            serde_json::Value::Null
        );
        store
            .append_op_checkpoint_paths("repair", "f", &strings(&["p"]))
            .unwrap();
        store
            .write_op_checkpoint_record("repair", "f", None)
            .unwrap();
        assert_eq!(
            store
                .read_op_checkpoint_record("repair", "f", None)
                .unwrap(),
            serde_json::Value::Null
        );
        assert_eq!(
            store.read_op_checkpoint_keys("repair", "f").unwrap()["keys"],
            json!([])
        );
        // A second delete is a no-op.
        store
            .write_op_checkpoint_record("repair", "f", None)
            .unwrap();
    }

    #[test]
    fn a_record_that_is_not_an_array_or_holds_nul_is_refused() {
        let store = store();
        assert!(
            store
                .write_op_checkpoint_record("repair", "f", Some(&json!({ "a": 1 })))
                .is_err()
        );
        assert!(
            store
                .write_op_checkpoint_record("repair", "f", Some(&json!([{ "a\0": 1 }])))
                .is_err()
        );
        assert!(
            store
                .write_op_checkpoint_record("repair", "f", Some(&json!(["x\0"])))
                .is_err()
        );
        assert_eq!(
            store
                .read_op_checkpoint_record("repair", "f", None)
                .unwrap(),
            serde_json::Value::Null
        );
    }
}
