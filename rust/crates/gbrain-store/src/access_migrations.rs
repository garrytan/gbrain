//! The policy-store migration journal `src/core/access/policy-migrate.ts` keeps
//! (`access_policy_migrations`, v283; SQL in `src/core/engine-sql/access-setup.ts` on PGLite and
//! Postgres), as records of [`crate::access_rules`] under sub-tag [`MIGRATION`].
//!
//! A migration is started for a source that holds access state (the table's foreign key), at
//! phase `started`. Each phase write replaces its phase and receipts; the unfinished read takes the
//! newest migration of a source that has not switched. Every write runs in one `Store::write`.
//!
//! See rust/docs/store/access_rules.md.
use crate::access_rules::{MIGRATION, key, require_state, source_prefix};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::{Store, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// One migration as stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct MigrationRecord {
    id: String,
    source_id: String,
    direction: String,
    phase: String,
    receipts: Value,
    created_at_us: i64,
    /// Breaks a tie between two migrations created in the same microsecond: the later insert wins.
    created_seq: u64,
    updated_at_us: i64,
}

/// An unfinished migration (`AccessMigrationRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccessMigrationRow {
    pub id: String,
    pub phase: String,
    pub direction: String,
    pub receipts: Value,
}

const DIRECTIONS: [&str; 2] = ["to_git", "to_database"];
const PHASES: [&str; 4] = ["started", "exported", "committed", "switched"];

fn migration_key(source_id: &str, id: &str) -> Vec<u8> {
    key(MIGRATION, &[source_id.as_bytes(), id.as_bytes()])
}

/// Every migration, in key order (source, then id).
fn all_migrations(read: &dyn KvRead) -> Result<Vec<MigrationRecord>> {
    let mut out = Vec::new();
    let mut failed = None;
    scan_prefix(
        read,
        &key(MIGRATION, &[]),
        false,
        &mut |_, value| match serde_json::from_slice(value) {
            Ok(record) => {
                out.push(record);
                true
            }
            Err(e) => {
                failed = Some(e);
                false
            }
        },
    )?;
    match failed {
        Some(e) => Err(e.into()),
        None => Ok(out),
    }
}

impl Store {
    /// `readUnfinishedAccessMigration(sourceId)`: the newest migration of the source whose phase
    /// is not `switched`, or `None`.
    pub fn read_unfinished_access_migration(
        &self,
        source_id: &str,
    ) -> Result<Option<AccessMigrationRow>> {
        let read = self.read()?;
        let mut newest: Option<MigrationRecord> = None;
        let mut failed = None;
        scan_prefix(
            &*read,
            &source_prefix(MIGRATION, source_id),
            false,
            &mut |_, value| match serde_json::from_slice::<MigrationRecord>(value) {
                Ok(r) => {
                    if r.phase != "switched"
                        && newest.as_ref().is_none_or(|n| {
                            (r.created_at_us, r.created_seq) > (n.created_at_us, n.created_seq)
                        })
                    {
                        newest = Some(r);
                    }
                    true
                }
                Err(e) => {
                    failed = Some(e);
                    false
                }
            },
        )?;
        if let Some(e) = failed {
            return Err(e.into());
        }
        Ok(newest.map(|r| AccessMigrationRow {
            id: r.id,
            phase: r.phase,
            direction: r.direction,
            receipts: r.receipts,
        }))
    }

    /// `insertAccessMigration(id, sourceId, direction)`: a migration at phase `started` with no
    /// receipts. Refuses a source with no access state, a direction the table does not allow and
    /// an id any source already used.
    pub fn insert_access_migration(
        &self,
        id: &str,
        source_id: &str,
        direction: &str,
    ) -> Result<()> {
        if !DIRECTIONS.contains(&direction) {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                format!(
                    "insertAccessMigration: direction {direction:?} is not to_git or to_database"
                ),
            ));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            require_state(&*tx, "insertAccessMigration", source_id)?;
            let all = all_migrations(&*tx)?;
            if all.iter().any(|r| r.id == id) {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("insertAccessMigration: migration {id:?} already exists"),
                ));
            }
            let created_seq = all.iter().map(|r| r.created_seq + 1).max().unwrap_or(0);
            let record = MigrationRecord {
                id: id.into(),
                source_id: source_id.into(),
                direction: direction.into(),
                phase: "started".into(),
                receipts: Value::Object(Map::new()),
                created_at_us: now,
                created_seq,
                updated_at_us: now,
            };
            put_json(tx, &migration_key(source_id, id), &record)
        })
    }

    /// `recordAccessMigrationPhase(id, phase, receipts)` and `switchAccessMigration(id, receipts)`
    /// (`phase` `switched`): sets the phase and receipts of migration `id`. A missing id changes
    /// nothing; a phase the table does not allow refuses.
    pub fn record_access_migration_phase(
        &self,
        id: &str,
        phase: &str,
        receipts: &Value,
    ) -> Result<()> {
        if !PHASES.contains(&phase) {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                format!("recordAccessMigrationPhase: phase {phase:?} is not a migration phase"),
            ));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut r) = all_migrations(&*tx)?.into_iter().find(|r| r.id == id) else {
                return Ok(());
            };
            r.phase = phase.into();
            r.receipts = receipts.clone();
            r.updated_at_us = now;
            put_json(tx, &migration_key(&r.source_id, id), &r)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{MigrationRecord, all_migrations};
    use crate::Store;
    use crate::error::CONSTRAINT_VIOLATION;
    use crate::test_support::{store, store_on};
    use serde_json::json;

    fn with_state(store: &Store) {
        store.ensure_access_policy_state("default").unwrap();
    }

    #[test]
    fn the_unfinished_migration_is_the_newest_that_has_not_switched() {
        let store = store();
        assert!(
            store
                .insert_access_migration("m1", "default", "to_git")
                .is_err(),
            "a source with no access state refuses"
        );
        with_state(&store);
        assert!(
            store
                .read_unfinished_access_migration("default")
                .unwrap()
                .is_none()
        );
        store
            .insert_access_migration("m1", "default", "to_git")
            .unwrap();
        store
            .insert_access_migration("m2", "default", "to_database")
            .unwrap();
        let row = store
            .read_unfinished_access_migration("default")
            .unwrap()
            .unwrap();
        assert_eq!(
            (row.id.as_str(), row.phase.as_str(), row.direction.as_str()),
            ("m2", "started", "to_database")
        );
        assert_eq!(row.receipts, json!({}));
        store
            .record_access_migration_phase("m2", "committed", &json!({ "desired": "abc" }))
            .unwrap();
        let row = store
            .read_unfinished_access_migration("default")
            .unwrap()
            .unwrap();
        assert_eq!(
            (row.phase.as_str(), row.receipts.clone()),
            ("committed", json!({ "desired": "abc" }))
        );
        store
            .record_access_migration_phase("m2", "switched", &json!({}))
            .unwrap();
        assert_eq!(
            store
                .read_unfinished_access_migration("default")
                .unwrap()
                .unwrap()
                .id,
            "m1"
        );
        store
            .record_access_migration_phase("m1", "switched", &json!({}))
            .unwrap();
        assert!(
            store
                .read_unfinished_access_migration("default")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_migration_write_the_table_refuses_writes_nothing() {
        let store = store();
        with_state(&store);
        assert!(
            store
                .insert_access_migration("m1", "default", "sideways")
                .is_err()
        );
        store
            .insert_access_migration("m1", "default", "to_git")
            .unwrap();
        assert!(
            store
                .insert_access_migration("m1", "default", "to_git")
                .is_err(),
            "an id is used once"
        );
        assert!(
            store
                .record_access_migration_phase("m1", "done", &json!({}))
                .is_err()
        );
        store
            .record_access_migration_phase("missing", "exported", &json!({}))
            .unwrap();
        let row = store
            .read_unfinished_access_migration("default")
            .unwrap()
            .unwrap();
        assert_eq!((row.id.as_str(), row.phase.as_str()), ("m1", "started"));
    }

    /// A clock that moves one second per call, so creation order and update order are visible.
    struct Stepping(std::sync::atomic::AtomicI64);

    impl crate::env::Env for Stepping {
        fn now_micros(&self) -> i64 {
            self.0
                .fetch_add(1_000_000, std::sync::atomic::Ordering::SeqCst)
        }
        fn new_uuid(&self) -> String {
            String::new()
        }
    }

    fn record(store: &Store, id: &str) -> MigrationRecord {
        let read = store.read().unwrap();
        all_migrations(&*read)
            .unwrap()
            .into_iter()
            .find(|r| r.id == id)
            .unwrap()
    }

    #[test]
    fn an_id_one_source_used_is_refused_for_another() {
        let store = store();
        with_state(&store);
        store
            .upsert_source(&serde_json::from_value(json!({ "id": "work" })).unwrap())
            .unwrap();
        store.ensure_access_policy_state("work").unwrap();
        store
            .insert_access_migration("m1", "default", "to_git")
            .unwrap();
        let refused = store.insert_access_migration("m1", "work", "to_git");
        assert_eq!(refused.unwrap_err().code, CONSTRAINT_VIOLATION);
        assert!(
            store
                .read_unfinished_access_migration("work")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_switch_keeps_its_receipts_and_stamps_its_update_time() {
        let store = store_on(std::sync::Arc::new(Stepping(1.into())));
        with_state(&store);
        store
            .insert_access_migration("m1", "default", "to_git")
            .unwrap();
        let receipts = json!({ "desired": "abc", "sync": "ok" });
        store
            .record_access_migration_phase("m1", "switched", &receipts)
            .unwrap();
        let r = record(&store, "m1");
        assert_eq!((r.phase.as_str(), r.receipts), ("switched", receipts));
        assert!(
            r.updated_at_us > r.created_at_us,
            "the switch is a later write"
        );
    }

    #[test]
    fn newest_is_by_creation_time_even_when_ids_are_in_reverse_key_order() {
        let store = store_on(std::sync::Arc::new(Stepping(1.into())));
        with_state(&store);
        for id in ["mig_z", "mig_y"] {
            store
                .insert_access_migration(id, "default", "to_git")
                .unwrap();
        }
        let created = record(&store, "mig_z").created_at_us;
        store
            .record_access_migration_phase("mig_z", "exported", &json!({}))
            .unwrap();
        assert_eq!(
            record(&store, "mig_z").created_at_us,
            created,
            "an update keeps it"
        );
        let row = store.read_unfinished_access_migration("default").unwrap();
        assert_eq!(row.map(|r| r.id), Some("mig_y".to_string()));
    }
}
