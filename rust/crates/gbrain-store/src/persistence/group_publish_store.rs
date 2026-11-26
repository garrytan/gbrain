//! Grouped publication (`groupPublishStore()`, `src/core/engine-sql/group-publish-store.ts`; rust/docs/store/managed-mode.md):
//! the owner's claim of a group's followers, the renewal and dispatch marks of the group's claims, the group's recovery
//! check, its publication mark, its one-step completion, and the source roots an import checks its paths against.
//!
//! Each kind answers what its Postgres statement answers, from the request, effect, counter, source and binding records.
//!
//! Locks. The statements' row locks (`FOR UPDATE`) are no reads here; the TypeScript member does not call them. Their
//! guarantee holds another way: an explicit transaction is Serialized (it holds the store's writer, so no other commit
//! interleaves with what it read), and under optimistic transactions every record read below is in the transaction's read
//! set, so a racing change aborts the commit with `write_conflict` instead of being missed. The claim compare-and-set
//! checks (execution token, state `running`) stay in each kind. No file lock, no process-wide mutex and no busy error is added.
//!
//! The group completion applies the single completion (`complete_write_row_in`) to each member in order, in the caller's
//! transaction, and stops at the first member that does not fit, so the caller sees fewer rows than members and rolls the
//! group back, as the one statement's row count tells it.

use super::effect_worker::pg_uuid;
use super::effects::all_effects;
use super::op_checkpoint::{
    delete_op_checkpoint_in, insert_op_checkpoint_if_absent_in, op_checkpoint_completed_keys,
};
use super::worktree_admission::released_deferred_in;
use super::worktrees::{SourceBindingRecord, read_host_record, source_binding_key};
use super::write_claim_terms::worktree_of;
use super::{
    WriteCompletion, all_requests, complete_write_row_in, extra_i64, extra_is_null, extra_time,
    read_counter, request_by_id, write_counter,
};
use crate::env::{Env, iso};
use crate::error::{Result, StoreError};
use crate::journal::{RequestRecord, write_request};
use crate::kv::{KvRead, KvWrite};
use crate::sources::all_sources;
use crate::{Store, get_json};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimMember {
    pub id: String,
    pub token: String,
    #[serde(default)]
    pub stamp: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionMember {
    pub id: String,
    pub token: String,
    pub outcome: String,
    pub need: i64,
    pub principal_key: String,
    pub retained: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryMember {
    pub id: String,
    pub token: String,
    pub record: Value,
    pub bytes: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRecovery {
    pub id: String,
    pub record: Value,
}

/// One read of `groupPublishStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GroupRead {
    RecoveryBlocked {
        worktree_id: String,
        excluded: Vec<String>,
    },
    ImportRoots {
        host_id: String,
    },
    ImportCheckpoints {
        op: String,
        fingerprints: Vec<String>,
    },
}

/// One write of `groupPublishStore()`, named by `kind`; its result is JSON.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum GroupWrite {
    ClaimFollowers {
        worktree_id: String,
        head_sequence: String,
        group: String,
        max: i64,
        lease_ms: f64,
        owner: Value,
    },
    RenewClaims {
        members: Vec<ClaimMember>,
        lease_ms: f64,
    },
    MarkDispatched {
        members: Vec<ClaimMember>,
    },
    StartPublication {
        members: Vec<ClaimMember>,
    },
    CompleteGroup {
        members: Vec<CompletionMember>,
        version: String,
        host_id: Option<String>,
    },
    RecordRecoveries {
        members: Vec<RecoveryMember>,
        total: i64,
        counter_keys: Vec<String>,
    },
    ClearRecoveries {
        resolved: Vec<ResolvedRecovery>,
        counter_keys: Vec<String>,
        worktree_id: Option<String>,
    },
    InsertImportCheckpoints {
        op: String,
        fingerprints: Vec<String>,
        docs: Vec<String>,
    },
    DeleteImportCheckpoints {
        op: String,
        fingerprints: Vec<String>,
        docs: Vec<String>,
    },
}

fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn is_string(v: Option<&Value>) -> bool {
    v.is_some_and(Value::is_string)
}

/// `GROUP_KEY_SQL` / `publicationGroupKey` over a stored request.
fn group_key(r: &RequestRecord) -> Option<String> {
    let intent = &r.intent;
    if is_string(intent.get("group")) {
        return Some(format!("sync:{}", text(intent.get("group"))?));
    }
    let kind = text(intent.get("kind"));
    let kind = kind.as_deref();
    let op = r.operation.as_str();
    if op == "submit_job"
        && kind == Some("managed_maintenance_page")
        && is_string(intent.get("maintenance_batch"))
    {
        return Some(format!(
            "maintenance:{}",
            text(intent.get("maintenance_batch"))?
        ));
    }
    let atom = matches!(kind, Some("managed_atom_page" | "managed_atom_delete"))
        || (kind == Some("managed_generation_activate")
            && text(intent.pointer("/key/kind")).as_deref() == Some("atom"));
    if op == "submit_job" && atom && is_string(intent.get("activationId")) {
        return Some(format!("generation:{}", text(intent.get("activationId"))?));
    }
    if op == "put_page"
        && kind == Some("managed_file_import")
        && is_string(intent.get("import_batch"))
    {
        return Some(format!("import:{}", text(intent.get("import_batch"))?));
    }
    if matches!(op, "put_page" | "add_timeline_entry")
        && intent.get("kind").is_none()
        && is_string(intent.pointer("/page_batch/id"))
    {
        return Some(format!("batch:{}", text(intent.pointer("/page_batch/id"))?));
    }
    None
}

fn holds_claim(r: &RequestRecord, token: &str) -> bool {
    r.state == "running"
        && r.extra
            .get("execution_token")
            .and_then(Value::as_str)
            .is_some_and(|t| same(t, token))
}

/// `jsonb_set(stamp::jsonb,'{token}',to_jsonb(token::text))`.
fn stamped(stamp: &str, token: &str) -> Result<Value> {
    let mut phase: Value = serde_json::from_str(stamp)
        .map_err(|_| StoreError::invalid("invalid input syntax for type json"))?;
    if let Value::Object(map) = &mut phase {
        map.insert("token".into(), json!(token.to_lowercase()));
    }
    Ok(phase)
}

pub(crate) fn group_rows_in(read: &dyn KvRead, what: &GroupRead) -> Result<Value> {
    match what {
        GroupRead::RecoveryBlocked {
            worktree_id,
            excluded,
        } => {
            let w = pg_uuid(worktree_id)?;
            let skipped: Vec<String> = excluded
                .iter()
                .map(|id| pg_uuid(id))
                .collect::<Result<_>>()?;
            let request = all_requests(read)?.iter().any(|r| {
                worktree_of(r).is_some_and(|x| x == w)
                    && !skipped.iter().any(|id| same(id, &r.id))
                    && !extra_is_null(r, "recovery")
            });
            let effect = all_effects(read)?.iter().any(|e| {
                e.worktree_id.as_deref().is_some_and(|x| same(x, &w)) && e.recovery.is_some()
            });
            Ok(json!(request || effect))
        }
        GroupRead::ImportCheckpoints { op, fingerprints } => {
            let mut out = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for fingerprint in fingerprints {
                if !seen.insert(fingerprint.as_str()) {
                    continue;
                }
                if let Some(completed) = op_checkpoint_completed_keys(read, op, fingerprint)? {
                    out.push(json!({ "fingerprint": fingerprint, "completed_keys": completed }));
                }
            }
            Ok(Value::Array(out))
        }
        GroupRead::ImportRoots { host_id } => {
            let host = pg_uuid(host_id)?;
            let mut out = Vec::new();
            for s in all_sources(read)?.into_iter().filter(|s| !s.archived) {
                let binding = get_json::<SourceBindingRecord>(read, &source_binding_key(&s.id))?
                    .filter(|b| same(&b.source_incarnation, &s.incarnation));
                let (worktree_path, relative_path) = match &binding {
                    Some(b) => (
                        read_host_record(read, &b.worktree_id.to_lowercase(), &host)?
                            .map(|h| h.local_path),
                        Some(b.relative_path.clone()),
                    ),
                    None => (None, None),
                };
                out.push(
                    json!({ "id": s.id, "local_path": s.local_path, "worktree_path": worktree_path,
                    "relative_path": if worktree_path.is_some() { relative_path } else { None } }),
                );
            }
            Ok(Value::Array(out))
        }
    }
}

pub(crate) fn group_write_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    what: &GroupWrite,
) -> Result<Value> {
    let now = env.now_micros();
    match what {
        GroupWrite::ClaimFollowers {
            worktree_id,
            head_sequence,
            group,
            max,
            lease_ms,
            owner,
        } => {
            let w = pg_uuid(worktree_id)?;
            let after: u64 = head_sequence
                .trim()
                .parse()
                .map_err(|_| StoreError::invalid("invalid input syntax for type bigint"))?;
            let all = all_requests(&*tx)?;
            let mut candidates: Vec<&RequestRecord> = Vec::new();
            for r in all
                .iter()
                .filter(|r| worktree_of(r).is_some_and(|x| x == w) && r.sequence > after)
            {
                if matches!(r.state.as_str(), "queued" | "running" | "recovering")
                    || !extra_is_null(r, "recovery")
                    || released_deferred_in(&*tx, r)?
                {
                    candidates.push(r);
                }
            }
            candidates.sort_by_key(|r| r.sequence);
            candidates.truncate(usize::try_from(*max).unwrap_or(0));
            let ends_prefix = |r: &RequestRecord| {
                group_key(r).as_deref() != Some(group.as_str())
                    || r.state != "queued"
                    || !extra_is_null(r, "recovery")
                    || extra_time(r, "next_attempt_at").is_some_and(|t| t > now)
                    || extra_i64(r, "transient_interruptions") > 0
            };
            let bound = candidates
                .iter()
                .filter(|r| ends_prefix(r))
                .map(|r| r.sequence)
                .min();
            let mut claimed = Vec::new();
            for r in candidates
                .iter()
                .filter(|r| bound.is_none_or(|b| r.sequence < b))
            {
                if group_key(r).as_deref() != Some(group.as_str())
                    || r.state != "queued"
                    || !extra_is_null(r, "recovery")
                {
                    break;
                }
                let mut record = (*r).clone();
                let previous = record
                    .extra
                    .get("claim_phase")
                    .cloned()
                    .unwrap_or(Value::Null);
                let token = env.new_uuid();
                record.state = "running".into();
                record.updated_at_us = now;
                record.blocked_reason = None;
                record.extra.insert("execution_token".into(), json!(token));
                record.extra.insert(
                    "claim_expires_at".into(),
                    json!(iso(now + (lease_ms * 1000.0).round() as i64)),
                );
                record.extra.insert(
                    "claim_phase".into(),
                    json!({ "token": token, "owner": owner, "claimed_at": iso(now) }),
                );
                claimed.push((record, previous));
            }
            let mut rows = Vec::new();
            for (record, previous) in &claimed {
                write_request(tx, record)?;
                let mut row = record.to_row();
                row["previous_claim_phase"] = previous.clone();
                rows.push(row);
            }
            Ok(Value::Array(rows))
        }
        GroupWrite::RenewClaims { members, lease_ms } => {
            let mut held = Vec::new();
            for m in members {
                let Some(mut r) = request_by_id(&*tx, &m.id)? else {
                    continue;
                };
                if !holds_claim(&r, &m.token) {
                    continue;
                }
                r.updated_at_us = now;
                r.extra.insert(
                    "claim_expires_at".into(),
                    json!(iso(now + (lease_ms * 1000.0).round() as i64)),
                );
                if let Some(stamp) = &m.stamp {
                    r.extra
                        .insert("claim_phase".into(), stamped(stamp, &m.token)?);
                }
                write_request(tx, &r)?;
                held.push(json!(r.id));
            }
            Ok(Value::Array(held))
        }
        GroupWrite::MarkDispatched { members } => {
            let mut marked = Vec::new();
            for m in members {
                let Some(mut r) = request_by_id(&*tx, &m.id)? else {
                    continue;
                };
                if !holds_claim(&r, &m.token) {
                    continue;
                }
                let stamp = m.stamp.as_deref().unwrap_or("null");
                r.extra
                    .insert("claim_phase".into(), stamped(stamp, &m.token)?);
                write_request(tx, &r)?;
                marked.push(json!(r.id));
            }
            Ok(Value::Array(marked))
        }
        GroupWrite::StartPublication { members } => {
            let mut started = Vec::new();
            for m in members {
                let Some(mut r) = request_by_id(&*tx, &m.id)? else {
                    continue;
                };
                if !holds_claim(&r, &m.token) {
                    continue;
                }
                r.extra.insert("publication_started".into(), json!(true));
                write_request(tx, &r)?;
                started.push(json!(r.id));
            }
            Ok(Value::Array(started))
        }
        GroupWrite::RecordRecoveries {
            members,
            total,
            counter_keys,
        } => {
            // All or nothing: the counters are reserved only when every member qualifies, as the statement does.
            let mut ready = Vec::new();
            for m in members {
                let Some(r) = request_by_id(&*tx, &m.id)? else {
                    continue;
                };
                if holds_claim(&r, &m.token) && extra_is_null(&r, "recovery") {
                    ready.push((r, m));
                }
            }
            if ready.len() == members.len() {
                for (mut r, m) in ready.clone() {
                    r.updated_at_us = now;
                    r.extra
                        .insert("recovery".into(), crate::jsonb::order(m.record.clone()));
                    r.extra.insert("recovery_bytes".into(), json!(m.bytes));
                    write_request(tx, &r)?;
                }
                for key in counter_keys {
                    if let Some(mut c) = read_counter(&*tx, key)? {
                        c.recovery_bytes += *total;
                        write_counter(tx, key, &c)?;
                    }
                }
            }
            Ok(Value::Array(
                ready.iter().map(|(r, _)| json!(r.id)).collect(),
            ))
        }
        GroupWrite::ClearRecoveries {
            resolved,
            counter_keys,
            worktree_id,
        } => {
            let w = worktree_id.as_deref().map(pg_uuid).transpose()?;
            let mut cleared = Vec::new();
            let mut freed = 0i64;
            for m in resolved {
                let Some(mut r) = request_by_id(&*tx, &m.id)? else {
                    continue;
                };
                let same_record = r.extra.get("recovery").is_some_and(|stored| {
                    crate::jsonb::order(stored.clone()) == crate::jsonb::order(m.record.clone())
                });
                let same_worktree = worktree_of(&r) == w;
                if same_record
                    && same_worktree
                    && matches!(
                        r.state.as_str(),
                        "committed" | "conflict" | "failed" | "cancelled"
                    )
                {
                    freed += extra_i64(&r, "recovery_bytes");
                    r.extra.insert("recovery".into(), Value::Null);
                    r.extra.insert("recovery_bytes".into(), json!(0));
                    r.blocked_reason = None;
                    write_request(tx, &r)?;
                    cleared.push(json!(r.id));
                }
            }
            for key in counter_keys {
                if let Some(mut c) = read_counter(&*tx, key)? {
                    c.recovery_bytes -= freed;
                    write_counter(tx, key, &c)?;
                }
            }
            Ok(Value::Array(cleared))
        }
        GroupWrite::InsertImportCheckpoints {
            op,
            fingerprints,
            docs,
        } => {
            for (fingerprint, doc) in fingerprints.iter().zip(docs) {
                let completed: Value = serde_json::from_str(doc)
                    .map_err(|_| StoreError::invalid("invalid input syntax for type json"))?;
                // The doc is the array of completed keys, `[record]`, as the parent keeps it.
                insert_op_checkpoint_if_absent_in(tx, env, op, fingerprint, &completed)?;
            }
            Ok(Value::Null)
        }
        GroupWrite::DeleteImportCheckpoints {
            op,
            fingerprints,
            docs,
        } => {
            for (fingerprint, doc) in fingerprints.iter().zip(docs) {
                let expected = crate::jsonb::order(
                    serde_json::from_str::<Value>(doc)
                        .map_err(|_| StoreError::invalid("invalid input syntax for type json"))?,
                );
                let stored =
                    op_checkpoint_completed_keys(&*tx, op, fingerprint)?.map(crate::jsonb::order);
                if stored.as_ref() == Some(&expected) {
                    delete_op_checkpoint_in(tx, op, fingerprint)?;
                }
            }
            Ok(Value::Null)
        }
        GroupWrite::CompleteGroup {
            members,
            version,
            host_id,
        } => {
            let mut done = Vec::new();
            for m in members {
                let Some(r) = request_by_id(&*tx, &m.id)? else {
                    break;
                };
                if !holds_claim(&r, &m.token) {
                    break;
                }
                let outcome: Value = serde_json::from_str(&m.outcome)
                    .map_err(|_| StoreError::invalid("invalid input syntax for type json"))?;
                let completion = WriteCompletion {
                    id: m.id.clone(),
                    state: "committed".into(),
                    outcome,
                    error_code: None,
                    error_message: None,
                    consumer_version: version.clone(),
                    consumer_host_id: host_id.clone(),
                    error_detail: Value::Null,
                    result_bytes: m.need,
                    counter_keys: vec!["brain".into(), m.principal_key.clone()],
                    intent_bytes: extra_i64(&r, "intent_bytes"),
                    retained_bytes: m.retained,
                    terminal_reservation: extra_i64(&r, "terminal_reservation"),
                    probe_purges: false,
                    // No fence yet: managed mode is not served on a multi-user store until its claims take I-5 leases.
                    fence: None,
                };
                let Some(mut row) = complete_write_row_in(tx, env, &completion)? else {
                    break;
                };
                row["principal_key"] = json!(m.principal_key);
                done.push(row);
            }
            Ok(Value::Array(done))
        }
    }
}

impl Store {
    /// One `groupPublishStore()` read (`GroupRead`) as JSON.
    pub fn group_rows(&self, what: &GroupRead) -> Result<Value> {
        group_rows_in(&*self.read()?, what)
    }

    /// One `groupPublishStore()` write (`GroupWrite`); its result as JSON.
    pub fn group_write(&self, what: &GroupWrite) -> Result<Value> {
        self.write(|tx| group_write_in(tx, &*self.env, what))
    }
}
