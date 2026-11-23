//! The policy-store migration journal (`access_policy_migrations`, schema migration v283): the four
//! members `src/core/access/policy-migrate.ts` runs (`engine-sql/access-policy-migrations.ts` on
//! PGLite and Postgres), answered from the records under sub-tag [`MIGRATION`] of
//! [`crate::access_rules`] (`0x06 <source> 0 <id>`).
//!
//! The table's checks hold here: a direction is `to_git` or `to_database`, a phase is `started`,
//! `exported`, `committed` or `switched`, an id is unique across sources, and a migration needs its
//! source's access state (the foreign key). `created_at` and `updated_at` are the store clock, in
//! microseconds. `switch_access_migration` runs inside the write transaction the caller holds.
//! See rust/docs/store/access_rules.md.

use crate::access_rules::{MIGRATION, each, invalid, key, require_state, source_prefix};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::keys;
use crate::kv::KvRead;
use crate::{Store, put_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One migration as stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MigrationRecord {
    id: String,
    source_id: String,
    direction: String,
    phase: String,
    receipts: Value,
    created_at_us: i64,
    updated_at_us: i64,
}

impl MigrationRecord {
    fn key(&self) -> Vec<u8> {
        key(MIGRATION, &[self.source_id.as_bytes(), self.id.as_bytes()])
    }
}

/// The unfinished migration of a source, as the journal read returns it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccessMigrationRow {
    pub id: String,
    pub phase: String,
    pub direction: String,
    pub receipts: Value,
}

/// The migration `id`, in whichever source holds it.
fn find(read: &dyn KvRead, id: &str) -> Result<Option<MigrationRecord>> {
    let mut found = None;
    each(
        read,
        &[keys::ACCESS_RULES, MIGRATION],
        |r: MigrationRecord| {
            found = (r.id == id).then_some(r);
            found.is_none()
        },
    )?;
    Ok(found)
}

impl Store {
    /// `readUnfinishedAccessMigration(sourceId)`: the newest migration of the source (by
    /// creation time) whose phase is not `switched`, or `None`.
    pub fn read_unfinished_access_migration(
        &self,
        source_id: &str,
    ) -> Result<Option<AccessMigrationRow>> {
        let read = self.read()?;
        let mut newest: Option<MigrationRecord> = None;
        each(
            &*read,
            &source_prefix(MIGRATION, source_id),
            |r: MigrationRecord| {
                if r.phase != "switched"
                    && newest
                        .as_ref()
                        .is_none_or(|n| r.created_at_us >= n.created_at_us)
                {
                    newest = Some(r);
                }
                true
            },
        )?;
        Ok(newest.map(|r| AccessMigrationRow {
            id: r.id,
            phase: r.phase,
            direction: r.direction,
            receipts: r.receipts,
        }))
    }

    /// `insertAccessMigration({ id, sourceId, direction })`: journals a migration at phase
    /// `started`. Refuses a direction the table does not allow (`invalid_argument`), an id any
    /// source already has (`constraint_violation`) and a source with no access state.
    pub fn insert_access_migration(
        &self,
        id: &str,
        source_id: &str,
        direction: &str,
    ) -> Result<()> {
        if !["to_git", "to_database"].contains(&direction) {
            return Err(invalid(format!(
                "insertAccessMigration: invalid direction {direction:?}"
            )));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            require_state(&*tx, "insertAccessMigration", source_id)?;
            if find(&*tx, id)?.is_some() {
                let message = format!("insertAccessMigration: migration {id:?} already exists");
                return Err(StoreError::new(CONSTRAINT_VIOLATION, message));
            }
            let record = MigrationRecord {
                id: id.into(),
                source_id: source_id.into(),
                direction: direction.into(),
                phase: "started".into(),
                receipts: Value::Object(Default::default()),
                created_at_us: now,
                updated_at_us: now,
            };
            put_json(tx, &record.key(), &record)
        })
    }

    /// `recordAccessMigrationPhase(id, phase, receipts)`: sets the phase and receipts of the
    /// migration and its update time. A phase the table does not allow refuses
    /// (`invalid_argument`) when the migration exists; an unknown id changes nothing, as an
    /// `UPDATE` that matches no row.
    pub fn record_access_migration_phase(
        &self,
        id: &str,
        phase: &str,
        receipts: &Value,
    ) -> Result<()> {
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut record) = find(&*tx, id)? else {
                return Ok(());
            };
            if !["started", "exported", "committed", "switched"].contains(&phase) {
                return Err(invalid(format!(
                    "recordAccessMigrationPhase: invalid phase {phase:?}"
                )));
            }
            record.phase = phase.into();
            record.receipts = receipts.clone();
            record.updated_at_us = now;
            put_json(tx, &record.key(), &record)
        })
    }

    /// `switchAccessMigration(id, receipts)`: marks the migration `switched` with its receipts.
    /// The caller runs it inside the write transaction that switches the store.
    pub fn switch_access_migration(&self, id: &str, receipts: &Value) -> Result<()> {
        self.record_access_migration_phase(id, "switched", receipts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;
    use serde_json::json;

    fn started(s: &Store, source: &str, id: &str) {
        s.insert_access_migration(id, source, "to_git").unwrap();
    }

    #[test]
    fn the_newest_unfinished_migration_of_the_source_is_read() {
        let s = store();
        s.ensure_access_policy_state("default").unwrap();
        assert_eq!(s.read_unfinished_access_migration("default").unwrap(), None);
        started(&s, "default", "mig_a");
        started(&s, "default", "mig_b");
        s.switch_access_migration("mig_b", &json!({})).unwrap();
        started(&s, "default", "mig_c");
        let row = s.read_unfinished_access_migration("default").unwrap();
        assert_eq!(row.as_ref().map(|r| r.id.as_str()), Some("mig_c"));
        s.switch_access_migration("mig_c", &json!({})).unwrap();
        let row = s.read_unfinished_access_migration("default").unwrap();
        assert_eq!(row.map(|r| r.id), Some("mig_a".to_string()));
        assert_eq!(s.read_unfinished_access_migration("other").unwrap(), None);
    }

    #[test]
    fn a_phase_update_keeps_the_receipts_and_the_creation_time() {
        let s = store();
        s.ensure_access_policy_state("default").unwrap();
        started(&s, "default", "mig_a");
        let receipts = json!({ "approved": "abc123" });
        s.record_access_migration_phase("mig_a", "exported", &receipts)
            .unwrap();
        let row = s
            .read_unfinished_access_migration("default")
            .unwrap()
            .unwrap();
        assert_eq!(
            (row.phase.as_str(), row.direction.as_str(), row.receipts),
            ("exported", "to_git", receipts)
        );
        s.record_access_migration_phase("missing", "committed", &json!({}))
            .unwrap();
        s.record_access_migration_phase("missing", "bogus", &json!({}))
            .unwrap();
    }

    /// The store clock stamps the creation time, which a phase update keeps: newest is by creation time, not by id.
    #[test]
    fn newest_is_by_the_creation_time_the_store_clock_stamps() {
        struct At(std::sync::atomic::AtomicI64);
        impl crate::env::Env for At {
            fn now_micros(&self) -> i64 {
                self.0
                    .fetch_add(1_000_000, std::sync::atomic::Ordering::SeqCst)
            }
            fn new_uuid(&self) -> String {
                crate::SystemEnv.new_uuid()
            }
        }
        let env = std::sync::Arc::new(At(std::sync::atomic::AtomicI64::new(1)));
        let s = Store::open_kv(
            crate::test_support::mem_kv(),
            env,
            crate::OpenOptions::default(),
        )
        .unwrap();
        s.ensure_access_policy_state("default").unwrap();
        started(&s, "default", "mig_z");
        started(&s, "default", "mig_y");
        s.record_access_migration_phase("mig_z", "exported", &json!({}))
            .unwrap();
        let row = s.read_unfinished_access_migration("default").unwrap();
        assert_eq!(row.map(|r| r.id), Some("mig_y".to_string()));
    }

    #[test]
    fn the_table_checks_refuse_and_leave_nothing_behind() {
        let s = store();
        s.ensure_access_policy_state("default").unwrap();
        let code = |r: Result<()>| r.unwrap_err().code;
        let invalid = crate::error::INVALID_ARGUMENT;
        assert_eq!(
            code(s.insert_access_migration("mig_x", "default", "sideways")),
            invalid
        );
        assert_eq!(
            code(s.insert_access_migration("mig_x", "work", "to_git")),
            invalid,
            "a source with no access state"
        );
        started(&s, "default", "mig_a");
        assert_eq!(
            code(s.insert_access_migration("mig_a", "default", "to_database")),
            CONSTRAINT_VIOLATION
        );
        assert_eq!(
            code(s.record_access_migration_phase("mig_a", "bogus", &json!({ "x": 1 }))),
            invalid
        );
        let row = s
            .read_unfinished_access_migration("default")
            .unwrap()
            .unwrap();
        assert_eq!((row.phase.as_str(), row.receipts), ("started", json!({})));
    }

    #[test]
    fn a_switched_migration_is_no_longer_unfinished() {
        let s = store();
        s.ensure_access_policy_state("default").unwrap();
        started(&s, "default", "mig_a");
        s.switch_access_migration("mig_a", &json!({ "sync": "ok" }))
            .unwrap();
        assert_eq!(s.read_unfinished_access_migration("default").unwrap(), None);
    }
}
