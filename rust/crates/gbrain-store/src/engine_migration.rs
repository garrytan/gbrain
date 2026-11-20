//! Engine migration: the source-side reads of `gbrain migrate --to <engine>`
//! (`engine-sql/engine-migration.ts`), so a Rust brain can be the brain a migration moves.
//!
//! - `readEngineMigrationHistory`: the write history the legacy copier refuses to discard. The
//!   store keeps write requests (`J`) and fact withdrawals (`t 0x01`); it records no belief events
//!   and no worktrees, so those two tables never hold rows here. Page versions are the `V` keys.
//! - `readMigrationRows('facts' | 'open_loops' | 'loop_suppressions')`: every fact row as
//!   `SELECT *` reads it (the single-fact decision's row, `embedding` as vector text), every loop
//!   row and every loop mute, by id. `sources` is composed in TypeScript.
//! - `countLiveTimelineEntries`: the timeline rows of live pages.
//!
//! `listManualLinkTransitions` lives with the transitions (`link_queries/link_temporal.rs`).
//! See rust/docs/store/engine-migration.md.

use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::facts::FactRecord;
use crate::facts::doctor::every_fact;
use crate::facts::loops::mutes::{SUPPRESSION_COLUMNS, migration_rows as suppression_rows};
use crate::facts::loops::{all_rows, row_json};
use crate::facts::purge::select_star;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::all_pages;
use crate::trust::withdrawals::WITHDRAWAL;
use crate::{Store, keys};
use serde_json::{Value, json};

/// Whether any key starts with `prefix`.
fn any_under(read: &dyn KvRead, prefix: &[u8]) -> Result<bool> {
    let mut found = false;
    scan_prefix(read, prefix, false, &mut |_, _| {
        found = true;
        false
    })?;
    Ok(found)
}

/// How many keys start with `prefix`.
fn count_under(read: &dyn KvRead, prefix: &[u8]) -> Result<u64> {
    let mut n = 0u64;
    scan_prefix(read, prefix, false, &mut |_, _| {
        n += 1;
        true
    })?;
    Ok(n)
}

/// `{ columns, rows }`: `columns` are the keys of a row, in the row's order.
fn table(columns: Vec<String>, rows: Vec<Value>) -> Value {
    json!({ "columns": columns, "rows": rows })
}

fn keys_of(row: &Value) -> Vec<String> {
    row.as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

impl Store {
    /// `readEngineMigrationHistory()`: `{ held, pageVersions }`. `held` names, in the order the
    /// refusal does, the history tables with a row: `persistence_requests` (a write request is
    /// recorded) and `fact_withdrawals` (a withdrawal is recorded).
    pub fn read_engine_migration_history(&self) -> Result<Value> {
        let read = self.read()?;
        let mut held = Vec::new();
        if any_under(&*read, &[keys::REQUEST])? {
            held.push("persistence_requests");
        }
        if any_under(&*read, &[keys::TRUST, WITHDRAWAL])? {
            held.push("fact_withdrawals");
        }
        let page_versions = count_under(&*read, &[keys::VERSION])?;
        Ok(json!({ "held": held, "pageVersions": page_versions }))
    }

    /// `readMigrationRows(table)` for `facts`, `open_loops` and `loop_suppressions`: every row by
    /// id with every column the store keeps. Another table refuses `INVALID_ARGUMENT`.
    pub fn read_migration_rows(&self, table_name: &str) -> Result<Value> {
        let read = self.read()?;
        match table_name {
            "facts" => {
                let mut facts = every_fact(&*read)?;
                facts.sort_by_key(|r| r.id);
                let rows: Vec<Value> = facts.iter().map(select_star).collect();
                Ok(table(keys_of(&select_star(&FactRecord::default())), rows))
            }
            "open_loops" => {
                let mut loops = all_rows(&*read, "readMigrationRows")?;
                loops.sort_by_key(|(id, _)| *id);
                let rows: Vec<Value> = loops.iter().map(|(id, r)| row_json(*id, r)).collect();
                Ok(table(
                    LOOP_COLUMNS.iter().map(|c| (*c).to_string()).collect(),
                    rows,
                ))
            }
            "loop_suppressions" => Ok(table(
                SUPPRESSION_COLUMNS
                    .iter()
                    .map(|c| (*c).to_string())
                    .collect(),
                suppression_rows(&*read)?,
            )),
            other => Err(StoreError::new(
                INVALID_ARGUMENT,
                format!(
                    "readMigrationRows: the store reads facts, open_loops and loop_suppressions, not {other}"
                ),
            )),
        }
    }

    /// `countLiveTimelineEntries()`: the timeline rows of pages that are not soft-deleted.
    pub fn count_live_timeline_entries(&self) -> Result<u64> {
        let read = self.read()?;
        let mut n = 0u64;
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_none() {
                n += count_under(&*read, &keys::timeline_prefix(page.id))?;
            }
        }
        Ok(n)
    }
}

/// The `open_loops` columns `row_json` emits, in its order.
const LOOP_COLUMNS: [&str; 22] = [
    "id",
    "source_id",
    "dedup_key",
    "loop_type",
    "counterparty_slug",
    "counterparty_email",
    "summary",
    "evidence",
    "thread_id",
    "page_slug",
    "due_at",
    "status",
    "detector",
    "confidence",
    "fact_id",
    "opened_at",
    "last_activity_at",
    "closed_at",
    "closed_by",
    "created_at",
    "updated_at",
    "counterparty_source_id",
];
