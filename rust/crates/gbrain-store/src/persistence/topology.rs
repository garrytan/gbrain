//! Topology changes: the `persistence_topology_changes` rows of
//! `src/core/engine-sql/persistence-claims.ts` (rust/docs/store/persistence.md, "Topology changes").
//!
//! A source lifecycle change (remove, purge, clone, deactivate) records one row per
//! (principal, request id), so a page write cannot reuse a lifecycle request id and a lifecycle
//! retry finds its earlier receipt. Key `d 0x03 <principal_id> 0x00 <request_id>` (both lower-case
//! UUID text), JSON `TopologyChangeRecord`. Rows are never deleted on this engine. The counter
//! charges that go with a lifecycle receipt stay with their callers (topology-receipts.ts).

use super::{uuid_param, violation};
use crate::env::{Env, iso};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// `persistence_topology_changes.state` CHECK.
const TOPOLOGY_STATES: &[&str] = &["recovering", "committed", "failed"];

/// One stored topology change.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TopologyChangeRecord {
    id: String,
    principal_id: String,
    request_id: String,
    digest: String,
    operation: String,
    source_id: String,
    source_incarnation: Option<String>,
    worktree_ids: Vec<String>,
    state: String,
    recovery: Option<Value>,
    recovery_bytes: i64,
    intent_bytes: i64,
    terminal_bytes: i64,
    outcome: Option<Value>,
    created_at_us: i64,
    updated_at_us: i64,
}

/// `insertTopologyChange(input)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyChangeInsert {
    pub principal_id: String,
    pub request_id: String,
    pub digest: String,
    pub operation: String,
    pub source_id: String,
    #[serde(default)]
    pub source_incarnation: Option<String>,
    #[serde(default)]
    pub worktree_ids: Vec<String>,
    pub state: String,
    #[serde(default)]
    pub recovery: Option<Value>,
    #[serde(default)]
    pub recovery_bytes: i64,
    #[serde(default)]
    pub intent_bytes: i64,
    pub terminal_bytes: i64,
    #[serde(default)]
    pub outcome: Option<Value>,
}

fn change_key(principal_id: &str, request_id: &str) -> Vec<u8> {
    let mut key = vec![keys::PERSISTENCE, super::TOPOLOGY];
    key.extend_from_slice(principal_id.as_bytes());
    key.push(0);
    key.extend_from_slice(request_id.as_bytes());
    key
}

fn principal_prefix(principal_id: &str) -> Vec<u8> {
    let mut key = vec![keys::PERSISTENCE, super::TOPOLOGY];
    key.extend_from_slice(principal_id.as_bytes());
    key.push(0);
    key
}

/// The row as `SELECT *` returns it (times as ISO text; the TypeScript member makes them Dates).
fn to_row(r: &TopologyChangeRecord) -> Value {
    json!({
        "id": r.id,
        "principal_id": r.principal_id,
        "request_id": r.request_id,
        "digest": r.digest,
        "operation": r.operation,
        "source_id": r.source_id,
        "source_incarnation": r.source_incarnation,
        "worktree_ids": r.worktree_ids,
        "state": r.state,
        "recovery": r.recovery,
        "recovery_bytes": r.recovery_bytes,
        "intent_bytes": r.intent_bytes,
        "terminal_bytes": r.terminal_bytes,
        "outcome": r.outcome,
        "created_at": iso(r.created_at_us),
        "updated_at": iso(r.updated_at_us),
    })
}

/// The INSERT ... RETURNING * of a lifecycle receipt. The table's CHECKs and its
/// UNIQUE(principal_id, request_id) refuse here as Postgres refuses them.
pub(crate) fn insert_topology_change_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    input: &TopologyChangeInsert,
) -> Result<Value> {
    let principal_id = uuid_param(&input.principal_id, "principalId")?;
    let request_id = uuid_param(&input.request_id, "requestId")?;
    let source_incarnation = match &input.source_incarnation {
        None => None,
        Some(t) => Some(uuid_param(t, "sourceIncarnation")?),
    };
    let worktree_ids = input
        .worktree_ids
        .iter()
        .map(|w| uuid_param(w, "worktreeIds"))
        .collect::<Result<Vec<_>>>()?;
    if !TOPOLOGY_STATES.contains(&input.state.as_str()) {
        return Err(violation(format!(
            "\"{}\" is not a topology change state",
            input.state
        )));
    }
    for (column, value) in [
        ("recovery_bytes", input.recovery_bytes),
        ("intent_bytes", input.intent_bytes),
        ("terminal_bytes", input.terminal_bytes),
    ] {
        if value < 0 {
            return Err(violation(format!("{column} must not be negative")));
        }
    }
    let key = change_key(&principal_id, &request_id);
    if get_json::<TopologyChangeRecord>(&*tx, &key)?.is_some() {
        return Err(violation(format!(
            "a topology change of principal {principal_id} already uses request {request_id}"
        )));
    }
    let now = env.now_micros();
    let record = TopologyChangeRecord {
        id: env.new_uuid(),
        principal_id,
        request_id,
        digest: input.digest.clone(),
        operation: input.operation.clone(),
        source_id: input.source_id.clone(),
        source_incarnation,
        worktree_ids,
        state: input.state.clone(),
        recovery: input.recovery.clone().filter(|v| !v.is_null()),
        recovery_bytes: input.recovery_bytes,
        intent_bytes: input.intent_bytes,
        terminal_bytes: input.terminal_bytes,
        outcome: input.outcome.clone().filter(|v| !v.is_null()),
        created_at_us: now,
        updated_at_us: now,
    };
    put_json(tx, &key, &record)?;
    Ok(to_row(&record))
}

/// `readTopologyChange(principalId, requestId)`: the row, or null.
pub(crate) fn read_topology_change_in(
    read: &dyn KvRead,
    principal_id: &str,
    request_id: &str,
) -> Result<Option<Value>> {
    let principal_id = uuid_param(principal_id, "principalId")?;
    let request_id = uuid_param(request_id, "requestId")?;
    Ok(
        get_json::<TopologyChangeRecord>(read, &change_key(&principal_id, &request_id))?
            .map(|r| to_row(&r)),
    )
}

/// `findTopologyChanges(principalId, requestIds)`: the first of `requestIds` (in key order, as
/// LIMIT 1 without ORDER BY takes any one) a topology change of `principalId` used, as
/// `[{ request_id }]`, or [].
pub(crate) fn find_topology_changes_in(
    read: &dyn KvRead,
    principal_id: &str,
    request_ids: &[String],
) -> Result<Vec<Value>> {
    let principal_id = uuid_param(principal_id, "principalId")?;
    let wanted = request_ids
        .iter()
        .map(|r| uuid_param(r, "requestIds"))
        .collect::<Result<std::collections::BTreeSet<_>>>()?;
    let prefix = principal_prefix(&principal_id);
    let mut found: Option<String> = None;
    let mut bad = false;
    scan_prefix(read, &prefix, false, &mut |k, _| {
        match std::str::from_utf8(&k[prefix.len()..]) {
            Ok(request) if wanted.contains(request) => found = Some(request.to_string()),
            Ok(_) => {}
            Err(_) => bad = true,
        }
        found.is_none() && !bad
    })?;
    if bad {
        return Err(StoreError::invalid("a topology change key is not UTF-8"));
    }
    Ok(found
        .map(|request| vec![json!({ "request_id": request })])
        .unwrap_or_default())
}

/// The capacity forecast's topology rows (`CAPACITY_TOPOLOGY_SQL`): one row per (local-writer
/// scope, UTC day) of the changes created after `window_start`. Gross and net are both the
/// summed `terminal_bytes`; the recent sums count changes created after `recent_start`.
pub(crate) fn topology_capacity_days(
    read: &dyn KvRead,
    window_start: i64,
    recent_start: i64,
) -> Result<Vec<Value>> {
    let mut rows = Vec::new();
    scan_prefix(
        read,
        &[keys::PERSISTENCE, super::TOPOLOGY],
        false,
        &mut |_, v| {
            rows.push(serde_json::from_slice::<TopologyChangeRecord>(v));
            true
        },
    )?;
    let mut by_day: std::collections::BTreeMap<(String, String), [i64; 4]> = Default::default();
    for row in rows {
        let r = row.map_err(|e| StoreError::invalid(format!("a topology change record: {e}")))?;
        if r.created_at_us <= window_start {
            continue;
        }
        let scope = format!("principal:local_cli:{}", r.principal_id);
        let sums = by_day
            .entry((scope, iso(r.created_at_us)[..10].to_string()))
            .or_default();
        sums[0] += 1;
        sums[1] += r.terminal_bytes;
        if r.created_at_us > recent_start {
            sums[2] += 1;
            sums[3] += r.terminal_bytes;
        }
    }
    Ok(by_day
        .into_iter()
        .map(|((scope, day), [ids, bytes, recent_ids, recent_bytes])| {
            json!({
                "scope": scope,
                "day": day,
                "ids": ids.to_string(),
                "gross": bytes.to_string(),
                "net": bytes.to_string(),
                "recent_ids": recent_ids.to_string(),
                "recent_gross": recent_bytes.to_string(),
                "recent_net": recent_bytes.to_string(),
            })
        })
        .collect())
}

impl Store {
    /// `insertTopologyChange(input)`: the stored row.
    pub fn insert_topology_change(&self, input: &TopologyChangeInsert) -> Result<Value> {
        self.write(|tx| insert_topology_change_in(tx, &*self.env, input))
    }

    /// `readTopologyChange(principalId, requestId)`.
    pub fn read_topology_change(
        &self,
        principal_id: &str,
        request_id: &str,
    ) -> Result<Option<Value>> {
        read_topology_change_in(&*self.read()?, principal_id, request_id)
    }

    /// `findTopologyChanges(principalId, requestIds)`.
    pub fn find_topology_changes(
        &self,
        principal_id: &str,
        request_ids: &[String],
    ) -> Result<Vec<Value>> {
        find_topology_changes_in(&*self.read()?, principal_id, request_ids)
    }
}
