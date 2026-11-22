//! Resumable-op checkpoints: the statements of `src/core/engine-sql/op-checkpoint.ts` and the
//! read `readOpCheckpointKeys` of `engine-sql/write-misc.ts` (rust/docs/store/persistence.md,
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
                // its JSON text, and a JSON null is SQL NULL, which the caller skips.
                for item in items {
                    match item {
                        Value::String(s) => push(s.clone()),
                        Value::Null => {}
                        other => push(other.to_string()),
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

/// The ops kept while their source incarnation lives: the Git sync holds and their records, the
/// fence census and repair rows (`FENCE_CANDIDATE_OP`, `FENCE_SCAN_OP`, `FENCE_REPAIR_ATTEMPT_OP`,
/// `FENCE_UNCOMMITTED_OP`) and the managed sync pass rows (`SYNC_PASS_ROW_OPS`).
const KEPT_WITH_INCARNATION: &[&str] = &[
    "sync-hold",
    "sync-hold-retry",
    "sync-import-provenance",
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

impl Store {
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
        let store = crate::test_support::store_with_env(clock.clone());
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
        let store = crate::test_support::store_with_env(clock.clone());
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
}
