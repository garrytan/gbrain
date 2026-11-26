//! The engine graduation drain's blocker reads (`src/core/engine-sql/graduation-drain.ts`, called by
//! `src/core/persistence/graduation-drain.ts` `graduationBlockers`): the requests in flight or under
//! recovery with their worktree's owner, the topology changes and effects under recovery, the host
//! bindings of other hosts, and the OAuth clients bound to a missing source (rust/docs/store/persistence.md,
//! "Graduation blockers"). Failback (`gbrain engine swap --to postgres`) drains a Rust primary through
//! this check. Each read takes one snapshot and writes nothing.
//!
//! SQL semantics kept: ids are lower-case uuid text (`::text`), so text order is uuid order; source ids
//! order bytewise (`COLLATE "C"`); a JSON null recovery is no recovery (`IS NOT NULL` on a jsonb column
//! that holds none); `owner_host_id` is null when the request names no worktree or the worktree is gone
//! (the `LEFT JOIN`); an effect whose request is gone is left out (the inner `JOIN`).

use std::collections::HashMap;

use serde_json::{Value, json};

use super::RequestRecord;
use super::all_requests;
use super::effects::all_effects;
use super::topology::recovering_topology_changes_in;
use super::uuid_param;
use super::worktrees::{
    HOST_BINDING, HostBindingRecord, SOURCE_BINDING, SourceBindingRecord, WORKTREE, WorktreeRecord,
    scan_records,
};
use crate::Store;
use crate::error::Result;
use crate::kv::KvRead;

/// The request states the drain lists whether or not they hold a recovery record.
const PENDING: &[&str] = &["queued", "deferred", "running", "recovering"];

fn has_recovery(value: Option<&Value>) -> bool {
    value.is_some_and(|v| !v.is_null())
}

fn request_worktree(r: &RequestRecord) -> Option<String> {
    r.extra
        .get("worktree_id")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
}

/// `listGraduationPendingRequests()`: the requests queued, deferred, running or recovering, or holding a
/// recovery record, by `sequence`.
pub(crate) fn graduation_pending_requests_in(read: &dyn KvRead) -> Result<Vec<Value>> {
    let owners: HashMap<String, Option<String>> =
        scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")?
            .into_iter()
            .map(|w| {
                (
                    w.id.to_ascii_lowercase(),
                    w.owner_host_id.map(|o| o.to_ascii_lowercase()),
                )
            })
            .collect();
    let mut rows: Vec<RequestRecord> = all_requests(read)?
        .into_iter()
        .filter(|r| PENDING.contains(&r.state.as_str()) || has_recovery(r.extra.get("recovery")))
        .collect();
    rows.sort_by_key(|r| r.sequence);
    Ok(rows
        .iter()
        .map(|r| {
            let owner = request_worktree(r).and_then(|w| owners.get(&w).cloned().flatten());
            json!({
                "request_id": r.request_id.to_ascii_lowercase(),
                "source_id": r.source_id,
                "operation": r.operation,
                "state": r.state,
                "recovering": has_recovery(r.extra.get("recovery")),
                "blocked_reason": r.blocked_reason,
                "owner_host_id": owner,
            })
        })
        .collect())
}

/// `listGraduationEffectRecoveries()`: the effects that hold a recovery record, by effect id, each with
/// its source (the request's when the effect names none) and its request's id.
pub(crate) fn graduation_effect_recoveries_in(read: &dyn KvRead) -> Result<Vec<Value>> {
    let requests: HashMap<String, RequestRecord> = all_requests(read)?
        .into_iter()
        .map(|r| (r.id.to_ascii_lowercase(), r))
        .collect();
    let mut effects = all_effects(read)?;
    effects.retain(|e| has_recovery(e.recovery.as_ref()));
    effects.sort_by_key(|e| e.id);
    Ok(effects
        .iter()
        .filter_map(|e| {
            let r = requests.get(&e.request_id.to_ascii_lowercase())?;
            Some(json!({
                "id": e.id.to_string(),
                "kind": e.kind,
                "state": e.state,
                "error_code": e.error_code,
                "source_id": e.source_id.clone().unwrap_or_else(|| r.source_id.clone()),
                "request_id": r.request_id.to_ascii_lowercase(),
            }))
        })
        .collect())
}

/// `listForeignHostBindings(hostId)`: the host bindings of every host but `hostId`, by worktree then host,
/// each with the byte-first source bound to its worktree (null when none is).
pub(crate) fn foreign_host_bindings_in(read: &dyn KvRead, host_id: &str) -> Result<Vec<Value>> {
    let host = uuid_param(host_id, "hostId")?;
    let mut first_source: HashMap<String, String> = HashMap::new();
    for b in scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")? {
        let slot = first_source
            .entry(b.worktree_id.to_ascii_lowercase())
            .or_insert_with(|| b.source_id.clone());
        if b.source_id.as_bytes() < slot.as_bytes() {
            *slot = b.source_id;
        }
    }
    let mut rows: Vec<(String, String)> =
        scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding")?
            .into_iter()
            .map(|b| {
                (
                    b.worktree_id.to_ascii_lowercase(),
                    b.host_id.to_ascii_lowercase(),
                )
            })
            .filter(|(_, h)| *h != host)
            .collect();
    rows.sort();
    Ok(rows
        .into_iter()
        .map(|(worktree, host)| {
            let source = first_source.get(&worktree).cloned();
            json!({ "worktree_id": worktree, "host_id": host, "source_id": source })
        })
        .collect())
}

impl Store {
    /// `listGraduationPendingRequests()`.
    pub fn list_graduation_pending_requests(&self) -> Result<Vec<Value>> {
        graduation_pending_requests_in(&*self.read()?)
    }

    /// `listGraduationTopologyRecoveries()`.
    pub fn list_graduation_topology_recoveries(&self) -> Result<Vec<Value>> {
        recovering_topology_changes_in(&*self.read()?)
    }

    /// `listGraduationEffectRecoveries()`.
    pub fn list_graduation_effect_recoveries(&self) -> Result<Vec<Value>> {
        graduation_effect_recoveries_in(&*self.read()?)
    }

    /// `listForeignHostBindings(hostId)`.
    pub fn list_foreign_host_bindings(&self, host_id: &str) -> Result<Vec<Value>> {
        foreign_host_bindings_in(&*self.read()?, host_id)
    }

    /// `listDanglingOAuthClients()`: none can exist on this store (removing a source clears the
    /// `bound_source_id` of its clients, `jobs/oauth_clients.rs` `remove_source_rows`), but the read
    /// checks every client against the source records rather than assume it.
    pub fn list_dangling_oauth_clients(&self) -> Result<Vec<Value>> {
        crate::jobs::dangling_oauth_clients_in(&*self.read()?)
    }
}
