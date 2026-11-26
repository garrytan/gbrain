//! Binding reads of `gbrain doctor` (orphan_bindings, the consumer diagnostics): the worktree, host binding and source
//! binding rows `worktrees.rs` keeps (rust/docs/store/persistence.md, "Binding reads"; SQL in
//! `src/core/engine-sql/doctor-persistence.ts`). Each read takes one snapshot and has no keys of its own.
//!
//! SQL semantics kept: ids are lower-case uuid text (`::text`), source ids order bytewise (`COLLATE "C"`), a NULL
//! `owner_host_id` matches no `<> $1` term, and `created_at::text` is Postgres's timestamptz text.

use std::collections::{BTreeMap, HashMap};

use serde_json::{Value, json};

use super::all_requests;
use super::uuid_param;
use super::worktrees::{
    HOST_BINDING, HostBindingRecord, SOURCE_BINDING, SourceBindingRecord, WORKTREE, WorktreeRecord,
    scan_records,
};
use crate::Store;
use crate::cli_reads::pg_text::timestamptz_text;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::sources::all_sources;

/// The request states `pending_requests` counts.
const PENDING: &[&str] = &["queued", "deferred", "running", "recovering"];

/// `listOrphanBindingRows(limit)`: source bindings whose source is gone (`source_removed`) or whose source carries
/// another incarnation (`incarnation_replaced`), by source id, at most `limit` when given; `pending_requests` counts
/// the binding's source and incarnation requests still in flight.
pub(crate) fn orphan_binding_rows_in(read: &dyn KvRead, limit: Option<i64>) -> Result<Vec<Value>> {
    let sources: HashMap<String, String> = all_sources(read)?
        .into_iter()
        .map(|s| (s.id, s.incarnation))
        .collect();
    let requests = all_requests(read)?;
    let cap = match limit {
        Some(n) if n != 0 => Some(
            usize::try_from(n).map_err(|_| StoreError::invalid("limit must not be negative"))?,
        ),
        _ => None,
    };
    let mut out = Vec::new();
    for b in scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")? {
        if cap.is_some_and(|c| out.len() >= c) {
            break;
        }
        let reason = match sources.get(&b.source_id) {
            None => "source_removed",
            Some(inc) if !inc.eq_ignore_ascii_case(&b.source_incarnation) => "incarnation_replaced",
            Some(_) => continue,
        };
        let pending = requests
            .iter()
            .filter(|r| {
                r.source_id == b.source_id
                    && r.source_incarnation
                        .eq_ignore_ascii_case(&b.source_incarnation)
                    && PENDING.contains(&r.state.as_str())
            })
            .count();
        out.push(json!({
            "source_id": b.source_id,
            "source_incarnation": b.source_incarnation.to_lowercase(),
            "worktree_id": b.worktree_id.to_lowercase(),
            "reason": reason,
            "pending_requests": pending,
        }));
    }
    Ok(out)
}

/// `listWorktreeIds()`: every stored worktree id (the SQL has no `ORDER BY`; the store answers in key order).
pub(crate) fn worktree_ids_in(read: &dyn KvRead) -> Result<Vec<String>> {
    Ok(scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")?
        .into_iter()
        .map(|w| w.id.to_lowercase())
        .collect())
}

/// `listOwnerBindings(hostId)`: worktrees a host other than `host_id` owns, not `recovering`, each with its owner's
/// host binding path and its source ids (bytewise; null when it binds none), oldest first. A worktree with no host
/// binding for its owner is left out (the inner join).
pub(crate) fn owner_bindings_in(read: &dyn KvRead, host_id: &str) -> Result<Vec<Value>> {
    let host = uuid_param(host_id, "hostId")?;
    let hosts: HashMap<(String, String), HostBindingRecord> =
        scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding")?
            .into_iter()
            .map(|h| ((h.worktree_id.to_lowercase(), h.host_id.to_lowercase()), h))
            .collect();
    let mut sources: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for b in scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")? {
        sources
            .entry(b.worktree_id.to_lowercase())
            .or_default()
            .push(b.source_id);
    }
    let mut rows: Vec<(i64, String, Value)> = Vec::new();
    for w in scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")? {
        let Some(owner) = w.owner_host_id.as_deref().map(str::to_lowercase) else {
            continue;
        };
        if owner == host || w.state == "recovering" {
            continue;
        }
        let id = w.id.to_lowercase();
        let Some(binding) = hosts.get(&(id.clone(), owner.clone())) else {
            continue;
        };
        let mut ids = sources.get(&id).cloned().unwrap_or_default();
        ids.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        let source_ids = if ids.is_empty() {
            Value::Null
        } else {
            json!(ids)
        };
        rows.push((
            w.created_at_us,
            id.clone(),
            json!({
                "worktree_id": id,
                "owner_host_id": owner,
                "local_path": binding.local_path,
                "created_at": timestamptz_text(w.created_at_us),
                "source_ids": source_ids,
            }),
        ));
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    Ok(rows.into_iter().map(|(_, _, v)| v).collect())
}

impl Store {
    /// `listOrphanBindingRows(limit)`.
    pub fn list_orphan_binding_rows(&self, limit: Option<i64>) -> Result<Vec<Value>> {
        orphan_binding_rows_in(&*self.read()?, limit)
    }

    /// `listWorktreeIds()`.
    pub fn list_worktree_ids(&self) -> Result<Vec<String>> {
        worktree_ids_in(&*self.read()?)
    }

    /// `listOwnerBindings(hostId)`.
    pub fn list_owner_bindings(&self, host_id: &str) -> Result<Vec<Value>> {
        owner_bindings_in(&*self.read()?, host_id)
    }
}
