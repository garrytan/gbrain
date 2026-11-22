//! Topology changes: the `persistence_topology_changes` rows of
//! `src/core/engine-sql/persistence-claims.ts` (rust/docs/store/persistence.md, "Topology changes").
//!
//! A source lifecycle change (remove, purge, clone, deactivate) records one row per
//! (principal, request id), so a page write cannot reuse a lifecycle request id and a lifecycle
//! retry finds its earlier receipt. Key `d 0x03 <principal_id> 0x00 <request_id>` (both lower-case
//! UUID text), JSON `TopologyChangeRecord`. Rows are never deleted on this engine. Writer
//! deactivation reads the recovering rows and the committed `writer_deactivate` outcomes. The counter
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
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    recovery: Option<Value>,
    recovery_bytes: i64,
    intent_bytes: i64,
    terminal_bytes: i64,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
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
        "recovery": r.recovery.clone().map(crate::jsonb::order),
        "recovery_bytes": r.recovery_bytes,
        "intent_bytes": r.intent_bytes,
        "terminal_bytes": r.terminal_bytes,
        "outcome": r.outcome.clone().map(crate::jsonb::order),
        "created_at": iso(r.created_at_us),
        "updated_at": iso(r.updated_at_us),
    })
}

/// The stopped retire requests writer status lists (`readWriterStatusRows`,
/// `engine-sql/writer-status.ts`): remove and purge changes (of `source_id`, or every source)
/// with no recovery record that are `recovering`, or `failed` because a later lifecycle change
/// superseded them; newest first, at most 20. `created_at` is `created_at::text`.
pub(super) fn retire_requests_in(read: &dyn KvRead, source_id: Option<&str>) -> Result<Vec<Value>> {
    let mut rows: Vec<TopologyChangeRecord> = Vec::new();
    let mut bad = false;
    scan_prefix(
        read,
        &[keys::PERSISTENCE, super::TOPOLOGY],
        false,
        &mut |_, v| {
            match serde_json::from_slice::<TopologyChangeRecord>(v) {
                Ok(r) => rows.push(r),
                Err(_) => bad = true,
            }
            !bad
        },
    )?;
    if bad {
        return Err(StoreError::invalid(
            "a topology change record is not readable",
        ));
    }
    let error = |r: &TopologyChangeRecord| -> Option<String> {
        match r.outcome.as_ref()?.get("error")? {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            other => Some(crate::cli_reads::pg_text::jsonb_text(other)),
        }
    };
    rows.retain(|r| {
        source_id.is_none_or(|s| r.source_id == s)
            && (r.operation == "remove" || r.operation == "purge")
            && r.recovery.is_none()
            && (r.state == "recovering"
                || r.state == "failed" && error(r).as_deref() == Some("source_retire_superseded"))
    });
    rows.sort_by_key(|r| std::cmp::Reverse(r.created_at_us));
    rows.truncate(20);
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "request_id": r.request_id,
                "operation": r.operation,
                "source_id": r.source_id,
                "source_incarnation": r.source_incarnation,
                "state": r.state,
                "error": error(r),
                "created_at": crate::cli_reads::pg_text::timestamptz_text(r.created_at_us),
            })
        })
        .collect())
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

/// The `(id, recovery)` of every topology change with a recovery, for the idle probe's topology
/// recovery term.
pub(crate) fn topology_recoveries(read: &dyn KvRead) -> Result<Vec<(String, Value)>> {
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
    let mut out = Vec::new();
    for row in rows {
        let r = row.map_err(|e| StoreError::invalid(format!("a topology change record: {e}")))?;
        if let Some(recovery) = r.recovery {
            out.push((r.id, recovery));
        }
    }
    Ok(out)
}

/// `listTopologyRecoveries(hostId, after, limit)` (topology-recovery.ts `recoverSourceTopologies`): the
/// changes with a recovery whose `recovery.worktreeId` names a worktree host `host` owns, after id `after`
/// when given, in id order, at most `limit`. A `worktreeId` that is not a uuid refuses, as the
/// `(c.recovery->>'worktreeId')::uuid` join does; one that names no worktree, or none of this host's,
/// is left out. Ids are lower-case uuid text, so text order is uuid order.
pub(crate) fn topology_recoveries_of_host(
    read: &dyn KvRead,
    host: &str,
    after: Option<&str>,
    limit: f64,
) -> Result<Vec<Value>> {
    let host = super::effect_worker::pg_uuid(host)?;
    super::effect_scans::limit_count(limit)?;
    let after = after.map(super::effect_worker::pg_uuid).transpose()?;
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
    let mut owned = Vec::new();
    for row in rows {
        let r = row.map_err(|e| StoreError::invalid(format!("a topology change record: {e}")))?;
        let Some(recovery) = &r.recovery else {
            continue;
        };
        let Some(w) = super::json_text(recovery.get("worktreeId")) else {
            continue;
        };
        let w = super::effect_worker::pg_uuid(&w)?;
        if after.as_deref().is_some_and(|a| r.id.as_str() <= a) {
            continue;
        }
        let ours = super::worktree_rows::read_worktree_row(read, &w)?
            .is_some_and(|row| row.owned_by(Some(&host)));
        if ours {
            owned.push(r);
        }
    }
    owned.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(owned.iter().take(limit as usize).map(to_row).collect())
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

fn all_changes(read: &dyn KvRead) -> Result<Vec<TopologyChangeRecord>> {
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
    rows.into_iter()
        .map(|r| r.map_err(|e| StoreError::invalid(format!("a topology change record: {e}"))))
        .collect()
}

/// The writer-deactivation blocker read (`engine-sql/writer-release.ts`
/// `recoveringTopologyChanges`): the first 20 changes that are recovering or hold a recovery
/// record, oldest first. `admission` is a recovering change with no recovery record; `automatic`
/// is one whose outcome says `expired_only` (as text, `true`).
pub(crate) fn recovering_topology_rows_in(read: &dyn KvRead) -> Result<Vec<Value>> {
    let has_recovery = |r: &TopologyChangeRecord| r.recovery.as_ref().is_some_and(|v| !v.is_null());
    let mut rows: Vec<TopologyChangeRecord> = all_changes(read)?
        .into_iter()
        .filter(|r| r.state == "recovering" || has_recovery(r))
        .collect();
    rows.sort_by_key(|r| r.created_at_us);
    Ok(rows
        .iter()
        .take(20)
        .map(|r| {
            let expired_only = r.outcome.as_ref().and_then(|o| o.get("expired_only"));
            let automatic = match expired_only {
                Some(Value::Bool(b)) => *b,
                Some(Value::String(s)) => s == "true",
                _ => false,
            };
            json!({
                "id": r.id,
                "operation": r.operation,
                "source_id": r.source_id,
                "request_id": r.request_id,
                "admission": r.state == "recovering" && !has_recovery(r),
                "automatic": automatic,
            })
        })
        .collect())
}

/// `listRetiredDeactivations()` (`engine-sql/connect-gate.ts`): the outcome of every committed
/// change of `operation`, in key order, as `{ outcome }`.
pub(crate) fn committed_outcomes_in(read: &dyn KvRead, operation: &str) -> Result<Vec<Value>> {
    Ok(all_changes(read)?
        .into_iter()
        .filter(|r| r.operation == operation && r.state == "committed")
        .map(|r| json!({ "outcome": r.outcome.map(crate::jsonb::order) }))
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

    /// `listTopologyRecoveries(hostId, after, limit)`: this host's changes in recovery, in id order.
    pub fn list_topology_recoveries(
        &self,
        host_id: &str,
        after: Option<&str>,
        limit: f64,
    ) -> Result<Vec<Value>> {
        topology_recoveries_of_host(&*self.read()?, host_id, after, limit)
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

/// Every stored topology change as (principal id, `terminal_bytes`), for `readCounterDrift`
/// (cli_reads/doctor_persistence.rs).
pub(crate) fn topology_terminal_bytes(read: &dyn KvRead) -> Result<Vec<(String, i64)>> {
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
    rows.into_iter()
        .map(|row| {
            let r =
                row.map_err(|e| StoreError::invalid(format!("a topology change record: {e}")))?;
            Ok((r.principal_id, r.terminal_bytes))
        })
        .collect()
}

/// The `persistence_topology_changes` rows a fact purge's inventory probe searches (crate::facts::purge_probe).
pub(crate) fn purge_probe_rows(
    read: &dyn KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow, json_rows};
    Ok(
        json_rows::<TopologyChangeRecord>(read, &[keys::PERSISTENCE, super::TOPOLOGY])?
            .into_iter()
            .map(|r| ProbeRow {
                cells: vec![
                    ("recovery", ProbeCell::opt_jsonb(r.recovery.as_ref())),
                    ("outcome", ProbeCell::opt_jsonb(r.outcome.as_ref())),
                ],
                source_id: Some(r.source_id),
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::super::worktree_rows::rows::put_worktree;
    use super::TopologyChangeInsert;
    use crate::test_support::store;
    use serde_json::{Value, json};

    const HOST: &str = "a0000000-0000-4000-8000-0000000000a1";
    const OTHER: &str = "a0000000-0000-4000-8000-0000000000a2";
    const MINE: &str = "f0000000-0000-4000-8000-0000000000a1";
    const THEIRS: &str = "f0000000-0000-4000-8000-0000000000a2";
    const PRINCIPAL: &str = "c0000000-0000-4000-8000-0000000000c1";

    fn change(s: &crate::Store, n: u8, recovery: Option<Value>) -> String {
        let input: TopologyChangeInsert = serde_json::from_value(json!({
            "principalId": PRINCIPAL, "requestId": format!("b0000000-0000-4000-8000-0000000000{n:02x}"),
            "digest": "d", "operation": "clone", "sourceId": "default", "state": "recovering",
            "recovery": recovery, "terminalBytes": 0, "outcome": null,
        }))
        .unwrap();
        s.insert_topology_change(&input).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn ids(rows: &[Value]) -> Vec<String> {
        rows.iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn lists_only_this_hosts_recoveries_in_id_order_after_the_cursor_up_to_the_limit() {
        let s = store();
        s.write(|tx| {
            put_worktree(tx, MINE, Some(HOST), "active")?;
            put_worktree(tx, THEIRS, Some(OTHER), "active")
        })
        .unwrap();
        let mut mine: Vec<String> = (1..=3)
            .map(|n| change(&s, n, Some(json!({ "worktreeId": MINE }))))
            .collect();
        change(&s, 4, Some(json!({ "worktreeId": THEIRS })));
        change(&s, 5, None);
        change(
            &s,
            6,
            Some(json!({ "worktreeId": "f0000000-0000-4000-8000-0000000000ff" })),
        );
        change(&s, 7, Some(json!({ "stage": "/x" })));
        mine.sort();
        assert_eq!(
            ids(&s.list_topology_recoveries(HOST, None, 16.0).unwrap()),
            mine
        );
        assert_eq!(
            ids(&s.list_topology_recoveries(HOST, None, 2.0).unwrap()),
            mine[..2].to_vec()
        );
        assert_eq!(
            ids(&s
                .list_topology_recoveries(HOST, Some(&mine[0]), 16.0)
                .unwrap()),
            mine[1..].to_vec()
        );
        assert!(
            s.list_topology_recoveries(HOST, Some(&mine[2]), 16.0)
                .unwrap()
                .is_empty()
        );
        let row = &s.list_topology_recoveries(HOST, None, 1.0).unwrap()[0];
        assert_eq!(row["recovery"], json!({ "worktreeId": MINE }));
        assert_eq!(row["state"], json!("recovering"));
        assert_eq!(
            ids(&s.list_topology_recoveries(OTHER, None, 16.0).unwrap()).len(),
            1
        );
    }

    #[test]
    fn a_worktree_id_or_cursor_that_is_not_a_uuid_refuses_as_the_cast_does() {
        let s = store();
        assert!(
            s.list_topology_recoveries(HOST, None, 2.0)
                .unwrap()
                .is_empty()
        );
        let bad = s.list_topology_recoveries("nope", None, 2.0).unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
        let bad = s
            .list_topology_recoveries(HOST, Some("x"), 2.0)
            .unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"x\"");
        let bad = s.list_topology_recoveries(HOST, None, 1.5).unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type bigint: \"1.5\"");
        change(&s, 1, Some(json!({ "worktreeId": "w" })));
        let bad = s.list_topology_recoveries(HOST, None, 2.0).unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"w\"");
    }
}
