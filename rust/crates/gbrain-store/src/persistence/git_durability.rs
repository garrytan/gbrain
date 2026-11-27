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
use super::worktrees::{
    HOST_BINDING, HostBindingRecord, host_binding_key, read_host_record, scan_records,
};
use super::{json_text, request_by_id};
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
    /// `PARKED_PUSH_REQUESTS_SQL`: the requests of a worktree whose failed Git effect is held on one of
    /// `codes`; distinct `{ source_id, id, request_id, slug }` rows in byte order of source, request id
    /// and journal id.
    ParkedPushRequests {
        worktree_id: String,
        codes: Vec<String>,
    },
    /// `FORMER_WORKTREE_HOLDS_SQL`: the one aggregate row over a source's held failed Git effects bound
    /// to another worktree than `worktree_id`.
    FormerWorktreeHolds {
        source_id: String,
        worktree_id: String,
        codes: Vec<String>,
    },
    /// `HOST_BINDING_PATHS_SQL`: the local path of every host binding, in key order.
    HostBindingPaths {},
    /// `FAILED_GIT_WORKTREES_SQL`: each worktree (lower-case uuid text) with a failed Git effect, once,
    /// in byte order.
    FailedGitWorktrees {},
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
    /// `REQUEUE_PARKED_EFFECT_SQL`: queues a failed effect again with `data`, when it is still failed on
    /// `error_code`, unclaimed and without a recovery; `{ state: "queued" }`, or null when it was not.
    RequeueParkedEffect {
        id: String,
        data: Value,
        error_code: Option<String>,
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

/// `e.error_code=ANY($codes) OR e.error_code='targets_parked' AND EXISTS (SELECT 1 FROM
/// jsonb_array_elements(COALESCE(e.data->'parked','[]')) p WHERE p->>'error_code'=ANY($codes))`: the code
/// that holds the effect, if any. `holding_codes` lists every parked target's code among `codes`.
fn held_codes(e: &EffectRecord, codes: &[String]) -> Result<Vec<String>> {
    let mut held = Vec::new();
    if let Some(code) = e.error_code.as_deref()
        && codes.iter().any(|c| c == code)
    {
        held.push(code.to_string());
    }
    if e.error_code.as_deref() == Some("targets_parked") {
        match e.data.get("parked") {
            None | Some(Value::Null) => {}
            Some(Value::Array(items)) => {
                for item in items {
                    if let Some(code) = json_text(item.get("error_code"))
                        && codes.contains(&code)
                    {
                        held.push(code);
                    }
                }
            }
            Some(Value::Object(_)) => {
                return Err(StoreError::invalid(
                    "cannot extract elements from an object".to_string(),
                ));
            }
            Some(_) => {
                return Err(StoreError::invalid(
                    "cannot extract elements from a scalar".to_string(),
                ));
            }
        }
    }
    Ok(held)
}

/// The predicates both parked-push reads share: a failed, unsettled Git effect.
fn failed_git(e: &EffectRecord) -> bool {
    e.kind == "git"
        && e.state == "failed"
        && e.data
            .as_object()
            .is_none_or(|m| !m.contains_key("settled"))
}

fn parked_push_requests_in(read: &dyn KvRead, worktree: &str, codes: &[String]) -> Result<Value> {
    let worktree = pg_uuid(worktree)?;
    let mut rows: Vec<(String, String, String, String)> = Vec::new();
    for e in all_effects(read)? {
        if e.worktree_id.as_deref().map(str::to_lowercase).as_deref() != Some(worktree.as_str())
            || !failed_git(&e)
            || e.recovery.is_some()
            || held_codes(&e, codes)?.is_empty()
        {
            continue;
        }
        let Some(request) = request_by_id(read, &e.request_id)? else {
            continue;
        };
        let row = (
            e.source_id.clone().unwrap_or_default(),
            request.request_id.to_lowercase(),
            request.id.to_lowercase(),
            request.slug.clone(),
        );
        if !rows.contains(&row) {
            rows.push(row);
        }
    }
    rows.sort_by(|a, b| {
        (a.0.as_bytes(), a.1.as_bytes(), a.2.as_bytes()).cmp(&(
            b.0.as_bytes(),
            b.1.as_bytes(),
            b.2.as_bytes(),
        ))
    });
    Ok(Value::Array(
        rows.into_iter()
            .map(|(source_id, request_id, id, slug)| {
                json!({ "source_id": source_id, "id": id, "request_id": request_id, "slug": slug })
            })
            .collect(),
    ))
}

fn former_worktree_holds_in(
    read: &dyn KvRead,
    source: &str,
    worktree: &str,
    codes: &[String],
) -> Result<Value> {
    let worktree = pg_uuid(worktree)?;
    let mut effects = 0i64;
    let mut code: Option<String> = None;
    let mut worktrees: Vec<Option<String>> = Vec::new();
    let mut requests: Vec<String> = Vec::new();
    for e in all_effects(read)? {
        let own = e.worktree_id.as_deref().map(str::to_lowercase);
        if e.source_id.as_deref() != Some(source)
            || own.as_deref() == Some(worktree.as_str())
            || !failed_git(&e)
        {
            continue;
        }
        let held = held_codes(&e, codes)?;
        if held.is_empty() {
            continue;
        }
        let Some(request) = request_by_id(read, &e.request_id)? else {
            continue;
        };
        effects += 1;
        // `CASE WHEN e.error_code=ANY($2) THEN e.error_code ELSE min(parked code) END`, then `min` over all.
        let own_code = match e.error_code.as_deref() {
            Some(c) if codes.iter().any(|x| x == c) => Some(c.to_string()),
            _ => held.iter().min().cloned(),
        };
        if let Some(c) = own_code
            && code.as_ref().is_none_or(|best| c < *best)
        {
            code = Some(c);
        }
        if !worktrees.contains(&own) {
            worktrees.push(own);
        }
        let public = request.request_id.to_lowercase();
        if !requests.contains(&public) {
            requests.push(public);
        }
    }
    if effects == 0 {
        return Ok(json!({ "effects": 0, "code": null, "worktree_ids": null, "requests": null }));
    }
    // `array_agg(DISTINCT x)` sorts, nulls last.
    worktrees.sort_by(|a, b| match (a, b) {
        (Some(x), Some(y)) => x.as_bytes().cmp(y.as_bytes()),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    requests.sort();
    requests.truncate(5);
    Ok(json!({ "effects": effects, "code": code, "worktree_ids": worktrees, "requests": requests }))
}

fn requeue_parked_effect_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    id: &str,
    data: &Value,
    error_code: Option<&str>,
) -> Result<Value> {
    let wanted = pg_bigint(id)?;
    let now = env.now_micros();
    let Some(mut e) = all_effects(&*tx)?.into_iter().find(|e| e.id == wanted) else {
        return Ok(Value::Null);
    };
    if e.state != "failed"
        || e.error_code.as_deref() != error_code
        || e.execution_token.is_some()
        || e.recovery.is_some()
    {
        return Ok(Value::Null);
    }
    e.state = "queued".into();
    e.data = data.clone();
    e.error_code = None;
    e.next_attempt_at_us = now;
    e.claim_expires_at_us = None;
    e.claim_owner = None;
    e.updated_at_us = now;
    write_effect(tx, &e)?;
    Ok(json!({ "state": "queued" }))
}

pub(crate) fn git_durability_rows_in(read: &dyn KvRead, what: &GitDurabilityRead) -> Result<Value> {
    match what {
        GitDurabilityRead::PlanCatchUp {
            worktree_id,
            source_id,
            source_incarnation,
            reason,
        } => plan_catch_up_in(read, worktree_id, source_id, source_incarnation, reason),
        GitDurabilityRead::ParkedPushRequests { worktree_id, codes } => {
            parked_push_requests_in(read, worktree_id, codes)
        }
        GitDurabilityRead::FormerWorktreeHolds {
            source_id,
            worktree_id,
            codes,
        } => former_worktree_holds_in(read, source_id, worktree_id, codes),
        GitDurabilityRead::HostBindingPaths {} => host_binding_paths_in(read),
        GitDurabilityRead::FailedGitWorktrees {} => failed_git_worktrees_in(read),
    }
}

fn host_binding_paths_in(read: &dyn KvRead) -> Result<Value> {
    let bindings: Vec<HostBindingRecord> = scan_records(read, HOST_BINDING, "host binding")?;
    Ok(Value::Array(
        bindings
            .into_iter()
            .map(|b| Value::String(b.local_path))
            .collect(),
    ))
}

fn failed_git_worktrees_in(read: &dyn KvRead) -> Result<Value> {
    let mut worktrees: Vec<String> = Vec::new();
    for e in all_effects(read)? {
        if e.kind != "git" || e.state != "failed" {
            continue;
        }
        let Some(worktree) = e.worktree_id.as_deref() else {
            continue;
        };
        let worktree = worktree.to_lowercase();
        if !worktrees.contains(&worktree) {
            worktrees.push(worktree);
        }
    }
    worktrees.sort();
    Ok(Value::Array(
        worktrees.into_iter().map(Value::String).collect(),
    ))
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
        GitDurabilityWrite::RequeueParkedEffect {
            id,
            data,
            error_code,
        } => requeue_parked_effect_in(tx, env, id, data, error_code.as_deref()),
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
