//! The reads of `gbrain sources writer status` (`src/core/engine-sql/writer-status.ts`;
//! rust/docs/store/persistence.md, "Writer status"): the writer diagnostics row sets, the status
//! bindings and stopped retire requests, the onboarding sources and the blocking effects.
//!
//! Each read answers what its statement answers on Postgres, from the request, counter, effect,
//! worktree, binding, topology and source records. Text keys sort in byte order (`COLLATE "C"`).
//! Times are ISO text; the TypeScript members make them `Date`s where the SQL engines return one.
//! `now()` is the store clock.

use super::effects::all_effects;
use super::topology::retire_requests_in;
use super::worktrees::{
    HOST_BINDING, HostBindingRecord, SOURCE_BINDING, SourceBindingRecord, WORKTREE, WorktreeRecord,
    kind_text, scan_records,
};
use super::{
    OUTSTANDING_STATES, RequestRecord, all_counters, all_requests, extra_bool, extra_i64,
    extra_is_null, extra_time, json_text, uuid_param,
};
use crate::env::iso;
use crate::error::Result;
use crate::kv::KvRead;
use crate::sources::all_sources;
use crate::{Store, jsonb};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn outstanding(r: &RequestRecord) -> bool {
    OUTSTANDING_STATES.contains(&r.state.as_str())
}

fn extra_text(r: &RequestRecord, column: &str) -> Option<String> {
    json_text(r.extra.get(column))
}

fn worktree_of(r: &RequestRecord) -> Option<&str> {
    r.extra.get("worktree_id").and_then(Value::as_str)
}

/// `EXTRACT(EPOCH FROM interval)*1000` cast to bigint: milliseconds, rounded half away from zero.
fn age_ms(now: i64, then: i64) -> i64 {
    ((now - then) as f64 / 1000.0).round() as i64
}

/// `readWriterDiagnosticRows(abandonedCutoff, excludedOrigins)`:
/// `{ worktrees, counters, blockers, queue, effects, failures }`.
pub(crate) fn writer_diagnostic_rows_in(
    read: &dyn KvRead,
    now: i64,
    abandoned_cutoff: Option<i64>,
    excluded_origins: &[String],
) -> Result<Value> {
    let mut requests = all_requests(read)?;
    requests.sort_by_key(|r| r.sequence);
    let effects = all_effects(read)?;
    let counters = all_counters(read)?;
    let counter_of: BTreeMap<&str, i64> = counters
        .iter()
        .map(|(k, c)| (k.as_str(), c.recovery_bytes))
        .collect();

    let mut worktrees = scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")?;
    worktrees.sort_by(|a, b| a.id.cmp(&b.id));
    let worktrees: Vec<Value> = worktrees
        .iter()
        .map(|w| {
            let mine: Vec<&RequestRecord> = requests
                .iter()
                .filter(|r| worktree_of(r) == Some(w.id.as_str()))
                .collect();
            let count = |state: &str| mine.iter().filter(|r| r.state == state).count();
            json!({
                "id": w.id,
                "owner_host_id": w.owner_host_id,
                "owner_epoch": w.owner_epoch.to_string(),
                "topology_generation": w.topology_generation.to_string(),
                "state": w.state,
                "heartbeat_at": w.heartbeat_at_us.map(iso),
                "queued": count("queued"),
                "running": count("running"),
                "recovering": count("recovering"),
                "oldest_request_at": mine.iter().filter(|r| outstanding(r)).map(|r| r.created_at_us).min().map(iso),
                "last_completed_sequence": mine.iter().filter(|r| r.state == "committed").map(|r| r.sequence).max().map(|s| s.to_string()),
                "recovery_bytes": counter_of.get(format!("worktree:{}", w.id).as_str()).copied().unwrap_or(0).to_string(),
                "recovering_effects": effects.iter().filter(|e| e.worktree_id.as_deref() == Some(w.id.as_str()) && e.recovery.is_some()).count(),
            })
        })
        .collect();

    let mut counters = counters;
    counters.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let counters: Vec<Value> = counters
        .iter()
        .map(|(key, c)| {
            json!({
                "key": key,
                "outstanding_count": c.outstanding_count.to_string(),
                "intent_bytes": c.intent_bytes.to_string(),
                "lifetime_ids": c.lifetime_ids.to_string(),
                "terminal_bytes": c.terminal_bytes.to_string(),
                "recovery_bytes": c.recovery_bytes.to_string(),
            })
        })
        .collect();

    let blockers: Vec<Value> = requests
        .iter()
        .filter(|r| outstanding(r) || r.blocked_reason.is_some() || !extra_is_null(r, "recovery"))
        .take(100)
        .map(|r| {
            let expires = extra_time(r, "claim_expires_at");
            let abandoned = abandoned_cutoff.is_some_and(|cutoff| {
                r.state == "running" && extra_is_null(r, "recovery") && r.updated_at_us < cutoff
            });
            json!({
                "request_id": r.request_id,
                "worktree_id": worktree_of(r),
                "source_id": r.source_id,
                "state": r.state,
                "blocked_reason": r.blocked_reason,
                "error_code": r.error_code,
                "created_at": iso(r.created_at_us),
                "claim_phase": r.extra.get("claim_phase").cloned().filter(|v| !v.is_null()).map(jsonb::order),
                "execution_token": extra_text(r, "execution_token"),
                "claim_lapsed": expires.map(|e| e < now),
                "publication_started": extra_bool(r, "publication_started"),
                "operation": r.operation,
                "intent_kind": json_text(r.intent.get("kind")),
                "preparation_attempts": extra_i64(r, "preparation_attempts"),
                "id": r.id,
                "abandoned": abandoned,
            })
        })
        .collect();

    let mut by_state: BTreeMap<&str, Vec<&RequestRecord>> = BTreeMap::new();
    for r in requests.iter().filter(|r| outstanding(r)) {
        by_state.entry(r.state.as_str()).or_default().push(r);
    }
    let queue: Vec<Value> = by_state
        .iter()
        .map(|(state, rows)| {
            let oldest = rows.iter().map(|r| r.created_at_us).min();
            json!({
                "state": state,
                "count": rows.len(),
                "intent_bytes": rows.iter().map(|r| extra_i64(r, "intent_bytes")).sum::<i64>().to_string(),
                "oldest_request_at": oldest.map(iso),
                "oldest_age_ms": oldest.map(|o| age_ms(now, o).to_string()),
            })
        })
        .collect();

    let created: BTreeMap<&str, i64> = requests
        .iter()
        .map(|r| (r.id.as_str(), r.created_at_us))
        .collect();
    let mut groups: BTreeMap<(&str, &str), (usize, i64)> = BTreeMap::new();
    for e in &effects {
        let settled = e
            .data
            .as_object()
            .is_some_and(|d| d.contains_key("settled"));
        let Some(at) = created.get(e.request_id.as_str()) else {
            continue;
        };
        if e.state == "committed" || settled {
            continue;
        }
        let g = groups
            .entry((e.kind.as_str(), e.state.as_str()))
            .or_insert((0, i64::MAX));
        g.0 += 1;
        g.1 = g.1.min(*at);
    }
    let effect_rows: Vec<Value> = groups
        .iter()
        .map(|((kind, state), (count, oldest))| {
            json!({ "kind": kind, "state": state, "count": count, "oldest_at": iso(*oldest) })
        })
        .collect();

    let failures: Vec<Value> = requests
        .iter()
        .rev()
        .filter(|r| {
            let Some(detail) = r.extra.get("error_detail").filter(|v| !v.is_null()) else {
                return false;
            };
            let origin = json_text(detail.get("origin")).unwrap_or_default();
            !excluded_origins.contains(&origin)
        })
        .take(20)
        .map(|r| {
            json!({
                "request_id": r.request_id,
                "operation": r.operation,
                "source_id": r.source_id,
                "state": r.state,
                "error_code": r.error_code,
                "error_detail": r.extra.get("error_detail").cloned().map(jsonb::order),
                "completed_at": r.completed_at_us.map(iso),
            })
        })
        .collect();

    Ok(json!({
        "worktrees": worktrees,
        "counters": counters,
        "blockers": blockers,
        "queue": queue,
        "effects": effect_rows,
        "failures": failures,
    }))
}

/// `readWriterStatusRows(hostId, sourceId)`: `{ bindings, topology_requests }`.
pub(crate) fn writer_status_rows_in(
    read: &dyn KvRead,
    host_id: Option<&str>,
    source_id: Option<&str>,
) -> Result<Value> {
    let host = host_id.map(|h| uuid_param(h, "hostId")).transpose()?;
    let worktrees: BTreeMap<String, WorktreeRecord> =
        scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")?
            .into_iter()
            .map(|w| (w.id.clone(), w))
            .collect();
    let hosts: Vec<HostBindingRecord> = match &host {
        Some(h) => scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding")?
            .into_iter()
            .filter(|b| &b.host_id == h)
            .collect(),
        None => Vec::new(),
    };
    let mut bindings = scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?;
    bindings.retain(|b| source_id.is_none_or(|s| b.source_id == s));
    bindings.sort_by(|a, b| a.source_id.as_bytes().cmp(b.source_id.as_bytes()));
    let manifest_text =
        |w: &WorktreeRecord, key: &str| json_text(w.manifest.as_ref().and_then(|m| m.get(key)));
    let bindings: Vec<Value> = bindings
        .iter()
        .filter_map(|b| {
            let w = worktrees.get(&b.worktree_id)?;
            let h = hosts.iter().find(|h| h.worktree_id == b.worktree_id);
            let durability = h.and_then(|h| h.git_durability.clone());
            let state = match durability.as_deref() {
                Some("enabled") => "on",
                Some("disabled") => "off",
                _ => "unknown",
            };
            Some(json!({
                "source_id": b.source_id,
                "source_incarnation": b.source_incarnation,
                "worktree_id": b.worktree_id,
                "relative_path": b.relative_path,
                "topology_generation": b.topology_generation.to_string(),
                "owner_host_id": w.owner_host_id,
                "owner_epoch": w.owner_epoch.to_string(),
                "state": w.state,
                "manifest_digest": manifest_text(w, "digest"),
                "prepared_at": manifest_text(w, "prepared_at"),
                "local_path": h.map(|h| h.local_path.clone()),
                "git_durability": durability,
                "git_durability_state": state,
            }))
        })
        .collect();
    Ok(json!({
        "bindings": bindings,
        "topology_requests": retire_requests_in(read, source_id)?,
    }))
}

/// `listOnboardingSources(sourceId)`: the active sources (one, or all) as
/// `{ id, local_path, incarnation, kind }`, by id in byte order.
pub(crate) fn onboarding_sources_in(
    read: &dyn KvRead,
    source_id: Option<&str>,
) -> Result<Vec<Value>> {
    let mut sources = all_sources(read)?;
    sources.retain(|s| !s.archived && source_id.is_none_or(|id| s.id == id));
    sources.sort_by(|a, b| a.id.as_bytes().cmp(b.id.as_bytes()));
    Ok(sources
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "local_path": s.local_path,
                "incarnation": s.incarnation,
                "kind": kind_text(&s.config),
            })
        })
        .collect())
}

/// `listBlockingEffectRows(sourceId, limit, recoveringOnly)`: effects holding a recovery record,
/// or (unless `recovering_only`) queued or running, joined to their request; by id, at most `limit`.
pub(crate) fn blocking_effect_rows_in(
    read: &dyn KvRead,
    source_id: Option<&str>,
    limit: usize,
    recovering_only: bool,
) -> Result<Vec<Value>> {
    let requests: BTreeMap<String, RequestRecord> = all_requests(read)?
        .into_iter()
        .map(|r| (r.id.clone(), r))
        .collect();
    let mut effects = all_effects(read)?;
    effects.sort_by_key(|e| e.id);
    Ok(effects
        .iter()
        .filter_map(|e| {
            let r = requests.get(&e.request_id)?;
            let source = e.source_id.clone().unwrap_or_else(|| r.source_id.clone());
            let blocking = e.recovery.is_some()
                || (!recovering_only && (e.state == "queued" || e.state == "running"));
            (blocking && source_id.is_none_or(|s| source == s)).then(|| {
                json!({
                    "effect_id": e.id.to_string(),
                    "kind": e.kind,
                    "state": e.state,
                    "recovering": e.recovery.is_some(),
                    "source_id": source,
                    "slug": r.slug,
                    "request_id": r.request_id,
                    "attempts": e.attempts,
                    "next_attempt_at": iso(e.next_attempt_at_us),
                })
            })
        })
        .take(limit)
        .collect())
}

impl Store {
    /// `readWriterDiagnosticRows(abandonedCutoff, excludedOrigins)`; the cutoff is ISO text.
    pub fn writer_diagnostic_rows(
        &self,
        abandoned_cutoff: Option<&str>,
        excluded_origins: &[String],
    ) -> Result<Value> {
        let cutoff = abandoned_cutoff
            .map(|c| {
                crate::env::parse_iso(c).ok_or_else(|| {
                    crate::error::StoreError::invalid("abandonedCutoff is not an ISO timestamp")
                })
            })
            .transpose()?;
        writer_diagnostic_rows_in(
            &*self.read()?,
            self.env.now_micros(),
            cutoff,
            excluded_origins,
        )
    }

    /// `readWriterStatusRows(hostId, sourceId)`.
    pub fn writer_status_rows(
        &self,
        host_id: Option<&str>,
        source_id: Option<&str>,
    ) -> Result<Value> {
        writer_status_rows_in(&*self.read()?, host_id, source_id)
    }

    /// `listOnboardingSources(sourceId)`.
    pub fn onboarding_sources(&self, source_id: Option<&str>) -> Result<Vec<Value>> {
        onboarding_sources_in(&*self.read()?, source_id)
    }

    /// `listBlockingEffectRows(sourceId, limit, recoveringOnly)`.
    pub fn blocking_effect_rows(
        &self,
        source_id: Option<&str>,
        limit: usize,
        recovering_only: bool,
    ) -> Result<Vec<Value>> {
        blocking_effect_rows_in(&*self.read()?, source_id, limit, recovering_only)
    }
}
