//! Managed Git durability: the catch-up plan and re-queue of a worktree's Git effects that
//! completed skipped while durability was off, and the host binding's recorded setting
//! (`gitDurabilityStore()`, `src/core/engine-sql/git-durability.ts`; rust/docs/store/managed-mode.md).
//!
//! The effects are the publication effect records (`effects.rs`), the setting is the host
//! binding's `git_durability` field (`worktrees.rs`). Each statement answers what its Postgres
//! text answers; the store commits durably and an explicit transaction holds the store's writer,
//! so the statement's lock timeout has nothing to bound.

use super::effect_worker::pg_uuid;
use super::effects::{EffectRecord, all_effects, write_effect};
use super::json_text;
use super::worktrees::{host_binding_key, read_host_record};
use crate::env::Env;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite};
use crate::put_json;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// `persistence_host_bindings.git_durability` CHECK (null is allowed).
const SETTINGS: &[&str] = &["enabled", "disabled"];

/// One read of `gitDurabilityStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GitDurabilityRead {
    /// `GIT_DURABILITY_PLAN_SQL`: per file (`data->>'relative_path'`), the newest committed Git
    /// effect of the worktree, source and incarnation whose outcome says `reason`, with no
    /// recovery, no claim and no `source_scan`; in byte order of the path.
    PlanCatchUp {
        worktree_id: String,
        source_id: String,
        source_incarnation: String,
        reason: String,
    },
}

/// One write of `gitDurabilityStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GitDurabilityWrite {
    /// `GIT_DURABILITY_REQUEUE_SQL`: queues again each named effect that still matches the plan's
    /// predicates; the ids it queued.
    RequeueCatchUp {
        ids: Vec<String>,
        worktree_id: String,
        source_incarnation: String,
        reason: String,
    },
    /// `GIT_DURABILITY_SET_SQL`: records the setting on one host binding; `{ git_durability }`, or
    /// null when no binding matched.
    SetHostBinding {
        worktree_id: String,
        host_id: String,
        setting: Option<String>,
    },
}

/// `(text)::boolean`, as Postgres reads a boolean's text.
fn pg_bool(text: &str) -> Result<bool> {
    match text.trim().to_ascii_lowercase().as_str() {
        "t" | "true" | "y" | "yes" | "on" | "1" => Ok(true),
        "f" | "false" | "n" | "no" | "off" | "0" => Ok(false),
        _ => Err(StoreError::invalid(format!(
            "invalid input syntax for type boolean: \"{text}\""
        ))),
    }
}

/// `(text)::int`, as Postgres reads an integer's text.
fn pg_int(text: &str) -> Result<i64> {
    text.trim().parse::<i32>().map(i64::from).map_err(|_| {
        StoreError::invalid(format!("invalid input syntax for type integer: \"{text}\""))
    })
}

/// `$1::text[]::bigint[]`.
fn pg_bigint(text: &str) -> Result<i64> {
    text.trim().parse::<i64>().map_err(|_| {
        StoreError::invalid(format!("invalid input syntax for type bigint: \"{text}\""))
    })
}

/// The predicates the plan and the re-queue share (the source id only in the plan).
fn skipped(e: &EffectRecord, worktree: &str, incarnation: &str, reason: &str) -> bool {
    e.worktree_id.as_deref() == Some(worktree)
        && e.source_incarnation
            .as_deref()
            .is_some_and(|i| i.eq_ignore_ascii_case(incarnation))
        && e.kind == "git"
        && e.state == "committed"
        && json_text(e.outcome.as_ref().and_then(|o| o.get("reason"))).as_deref() == Some(reason)
        && e.recovery.is_none()
        && e.execution_token.is_none()
}

fn plan_catch_up_in(
    read: &dyn KvRead,
    worktree: &str,
    source: &str,
    incarnation: &str,
    reason: &str,
) -> Result<Value> {
    let worktree = pg_uuid(worktree)?;
    let incarnation = pg_uuid(incarnation)?;
    // The newest effect per path: the statement's DISTINCT ON ... ORDER BY path, id DESC.
    let mut newest: BTreeMap<Vec<u8>, &EffectRecord> = BTreeMap::new();
    let effects = all_effects(read)?;
    for e in &effects {
        if e.source_id.as_deref() != Some(source) || !skipped(e, &worktree, &incarnation, reason) {
            continue;
        }
        let scan = match json_text(e.data.get("source_scan")) {
            None => false,
            Some(text) => pg_bool(&text)?,
        };
        let Some(path) = json_text(e.data.get("relative_path")) else {
            continue;
        };
        if scan {
            continue;
        }
        let slot = newest.entry(path.into_bytes()).or_insert(e);
        if e.id > slot.id {
            *slot = e;
        }
    }
    Ok(Value::Array(
        newest
            .into_values()
            .map(|e| {
                json!({
                    "id": e.id.to_string(),
                    "request_id": e.request_id,
                    "relative_path": json_text(e.data.get("relative_path")),
                    "slug": json_text(e.data.get("slug")),
                })
            })
            .collect(),
    ))
}

fn requeue_catch_up_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    ids: &[String],
    worktree: &str,
    incarnation: &str,
    reason: &str,
) -> Result<Value> {
    let wanted = ids
        .iter()
        .map(|id| pg_bigint(id))
        .collect::<Result<Vec<i64>>>()?;
    let worktree = pg_uuid(worktree)?;
    let incarnation = pg_uuid(incarnation)?;
    let now = env.now_micros();
    let mut queued = Vec::new();
    for mut e in all_effects(&*tx)? {
        if !wanted.contains(&e.id) || !skipped(&e, &worktree, &incarnation, reason) {
            continue;
        }
        let count = match json_text(e.data.get("durability_catch_up")) {
            None => 0,
            Some(text) => pg_int(&text)?,
        };
        e.state = "queued".into();
        e.execution_token = None;
        e.claim_expires_at_us = None;
        e.claim_owner = None;
        e.error_code = None;
        e.outcome = None;
        e.next_attempt_at_us = now;
        e.updated_at_us = now;
        // `data||jsonb_build_object(...)`: an object gains or replaces the key.
        match &mut e.data {
            Value::Object(map) => {
                map.insert("durability_catch_up".into(), json!(count + 1));
            }
            other => *other = json!({ "durability_catch_up": count + 1 }),
        }
        write_effect(tx, &e)?;
        queued.push(Value::String(e.id.to_string()));
    }
    Ok(Value::Array(queued))
}

fn set_host_binding_in(
    tx: &mut dyn KvWrite,
    worktree: &str,
    host: &str,
    setting: Option<&str>,
) -> Result<Value> {
    let worktree = pg_uuid(worktree)?;
    let host = pg_uuid(host)?;
    if let Some(value) = setting
        && !SETTINGS.contains(&value)
    {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            "new row for relation \"persistence_host_bindings\" violates check constraint \"persistence_host_bindings_git_durability_check\"",
        ));
    }
    let Some(mut binding) = read_host_record(&*tx, &worktree, &host)? else {
        return Ok(Value::Null);
    };
    binding.git_durability = setting.map(str::to_string);
    put_json(tx, &host_binding_key(&worktree, &host), &binding)?;
    Ok(json!({ "git_durability": binding.git_durability }))
}

pub(crate) fn git_durability_rows_in(read: &dyn KvRead, what: &GitDurabilityRead) -> Result<Value> {
    match what {
        GitDurabilityRead::PlanCatchUp {
            worktree_id,
            source_id,
            source_incarnation,
            reason,
        } => plan_catch_up_in(read, worktree_id, source_id, source_incarnation, reason),
    }
}

pub(crate) fn git_durability_write_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    what: &GitDurabilityWrite,
) -> Result<Value> {
    match what {
        GitDurabilityWrite::RequeueCatchUp {
            ids,
            worktree_id,
            source_incarnation,
            reason,
        } => requeue_catch_up_in(tx, env, ids, worktree_id, source_incarnation, reason),
        GitDurabilityWrite::SetHostBinding {
            worktree_id,
            host_id,
            setting,
        } => set_host_binding_in(tx, worktree_id, host_id, setting.as_deref()),
    }
}

impl crate::Store {
    /// One `gitDurabilityStore()` read (`GitDurabilityRead`) as JSON.
    pub fn git_durability_rows(&self, what: &GitDurabilityRead) -> Result<Value> {
        git_durability_rows_in(&*self.read()?, what)
    }

    /// One `gitDurabilityStore()` write (`GitDurabilityWrite`); its result as JSON.
    pub fn git_durability_write(&self, what: &GitDurabilityWrite) -> Result<Value> {
        self.write(|tx| git_durability_write_in(tx, &*self.env, what))
    }
}
