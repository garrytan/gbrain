//! The consumer's idle probe (`probeIdleWork`, `src/core/engine-sql/persistence-idle-probe.ts`;
//! rust/docs/store/persistence.md, "Idle probe"): whether any worker of this host has work, and
//! where the resident projection window stands.
//!
//! Each term mirrors one worker's selection. The write and effect terms take a row on a worktree
//! only when this host owns the worktree (`write_claim_terms.rs`); the recovery, expired-claim,
//! topology-recovery and overdue-deferred terms join the worktree row the same way.

use super::effect_worker::pg_uuid;
use super::effects::all_effects;
use super::owner_scans::held_overdue;
use super::projection_queue::{
    ProjectionWindowCursor, SegmentedProjectionFilter, list_pending_segmented_projections_in,
    parse_timestamptz, select_projection_window_jobs_in, sources_by_incarnation,
};
use super::topology::topology_recoveries;
use super::worktree_admission::{RefreshRecord, all_refreshes};
use super::worktree_rows::read_worktree_row;
use super::write_claim_terms::{WorktreeClaims, effect_claimable_on_worktree, worktree_of};
use super::{
    ClaimableSpec, all_requests, candidates, claimable, extra_bool, extra_is_null, extra_time,
    foreground_priority, pending,
};
use crate::Store;
use crate::config::read_config;
use crate::env::Env;
use crate::error::Result;
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use crate::pages::read_page;
use serde::Deserialize;
use serde_json::{Value, json};

/// `IdleProbeSpec`: what the consumer knows when it probes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleProbeSpec {
    pub host_id: String,
    #[serde(default)]
    pub excluded_roots: Vec<String>,
    #[serde(default)]
    pub publishing: bool,
    #[serde(default)]
    pub retrying_topologies: Vec<String>,
    #[serde(default)]
    pub lane_roots: Vec<String>,
    pub cursor: ProjectionWindowCursor,
    #[serde(default)]
    pub abandoned_before: Option<String>,
    #[serde(default)]
    pub foreground_priority: Option<bool>,
}

/// The window's live projection work: a selected job whose source is not archived and whose page
/// is live markdown or code (`pwork`).
fn projection_work(read: &dyn KvRead, rows: &[Value]) -> Result<bool> {
    let sources = sources_by_incarnation(read)?;
    for row in rows {
        let (Some(inc), Some(slug)) = (row["source_incarnation"].as_str(), row["slug"].as_str())
        else {
            continue;
        };
        let Some(source) = sources.get(inc).filter(|s| !s.archived) else {
            continue;
        };
        let live = read_page(read, &source.id, slug)?.is_some_and(|p| {
            p.deleted_at_us.is_none() && matches!(p.page_kind.as_str(), "markdown" | "code")
        });
        if live {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether host `host` owns worktree `w` (`JOIN persistence_worktrees w ... w.owner_host_id=host`).
fn owns(read: &dyn KvRead, w: &str, host: &str) -> Result<bool> {
    Ok(read_worktree_row(read, w)?.is_some_and(|row| row.owned_by(Some(host))))
}

/// The effect term: a due effect, not in recovery, not waiting on an uncommitted withdrawal mirror
/// of its request (`mirror.state<>'committed'`), and, on a worktree, one this host may claim.
fn effect_due(
    read: &dyn KvRead,
    host: &str,
    requests: &[RequestRecord],
    refreshes: &[RefreshRecord],
    now: i64,
) -> Result<bool> {
    let effects = all_effects(read)?;
    for e in &effects {
        let due = e.state == "queued"
            || (e.state == "running" && e.claim_expires_at_us.is_some_and(|t| t < now));
        let due = due
            && e.next_attempt_at_us <= now
            && e.recovery.is_none()
            && (e.kind == "withdrawal-mirror"
                || !effects.iter().any(|m| {
                    m.request_id == e.request_id
                        && m.kind == "withdrawal-mirror"
                        && m.state != "committed"
                }));
        if !due {
            continue;
        }
        let claimable = match &e.worktree_id {
            None => true,
            Some(w) => effect_claimable_on_worktree(read, w, host, &effects, requests, refreshes)?,
        };
        if claimable {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The effect recovery term: an effect in recovery on a worktree this host owns, due now.
fn effect_recovery(read: &dyn KvRead, host: &str, now: i64) -> Result<bool> {
    for e in all_effects(read)? {
        if let Some(w) = &e.worktree_id
            && e.recovery.is_some()
            && e.next_attempt_at_us <= now
            && owns(read, w, host)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The topology recovery term: a change in recovery whose `recovery.worktreeId` names a worktree
/// this host owns, and that did not just fail to finish. The id is cast `::uuid` as there.
fn topology_recovery(read: &dyn KvRead, host: &str, retrying: &[String]) -> Result<bool> {
    for (id, recovery) in topology_recoveries(read)? {
        let Some(w) = super::json_text(recovery.get("worktreeId")) else {
            continue;
        };
        let w = pg_uuid(&w)?;
        if owns(read, &w, host)? && !retrying.contains(&id) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `MAX_WAIT_SQL`: the configured refresh-barrier wait limit in ms, else 15 minutes.
fn max_wait_ms(read: &dyn KvRead) -> Result<f64> {
    let configured = read_config(read, "persistence.refresh_barrier_max_wait_ms")?.filter(|v| {
        let b = v.as_bytes();
        (1..=15).contains(&b.len())
            && (b'1'..=b'9').contains(&b[0])
            && b.iter().all(u8::is_ascii_digit)
    });
    Ok(configured.map_or(900_000.0, |v| v.parse::<f64>().unwrap_or(900_000.0)))
}

/// `overdueDeferredWorkSql(host)`: a deferred write on a worktree this host owns, past its limit
/// behind a refresh or an import (`owner_scans.rs`, `held_overdue`).
fn overdue_deferred(
    read: &dyn KvRead,
    host: &str,
    all: &[RequestRecord],
    now: i64,
) -> Result<bool> {
    let mut wait: Option<f64> = None;
    for r in all
        .iter()
        .filter(|r| r.state == "deferred" && worktree_of(r).is_some())
    {
        let wait = match wait {
            Some(v) => v,
            None => *wait.insert(max_wait_ms(read)?),
        };
        if held_overdue(read, r, host, wait, now, "refresh")?
            || held_overdue(read, r, host, wait, now, "import")?
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `probeIdleWork(spec)`: `{ work, projection_work, projection_last, high_water }`.
pub(crate) fn probe_idle_work_in(
    read: &dyn KvRead,
    env: &dyn Env,
    spec: &IdleProbeSpec,
) -> Result<Value> {
    let abandoned = spec
        .abandoned_before
        .as_deref()
        .map(|t| parse_timestamptz(t, "abandonedBefore"))
        .transpose()?;
    let now = env.now_micros();
    let rows = select_projection_window_jobs_in(read, env, &spec.cursor, true)?;
    let high_water = rows
        .first()
        .map_or(Value::Null, |r| r["high_water"].clone());
    let projection_last = rows.iter().rfind(|r| r["lane"] == "window").map_or(
        Value::Null,
        |r| json!({ "source_incarnation": r["source_incarnation"], "slug": r["slug"] }),
    );
    let pwork = projection_work(read, &rows)?;

    let host = pg_uuid(&spec.host_id)?;
    let priority = foreground_priority(read, spec.foreground_priority)?;
    let all = all_requests(read)?;
    let pending = pending(&all);
    let worktrees = WorktreeClaims::new(read, &all)?;
    let claim_spec = ClaimableSpec {
        host_id: Some(host.clone()),
        exclude_roots: spec.excluded_roots.clone(),
        ..ClaimableSpec::default()
    };
    // Only the rows the claim may take count: a running or recovering row is not write work.
    let mut write = false;
    for r in candidates(read, &all)? {
        if (spec.publishing || r.blocked_reason.as_deref() != Some("writer_pool_capacity"))
            && claimable(
                r,
                &pending,
                &worktrees,
                priority,
                &claim_spec,
                &spec.lane_roots,
                now,
            )?
        {
            write = true;
            break;
        }
    }
    let mut recovery = false;
    for r in &all {
        if let Some(w) = worktree_of(r)
            && !extra_is_null(r, "recovery")
            && !spec.excluded_roots.contains(&w)
            && owns(read, &w, &host)?
        {
            recovery = true;
            break;
        }
    }
    let mut expired = false;
    for r in &all {
        if r.state == "running"
            && extra_is_null(r, "recovery")
            && !extra_bool(r, "publication_started")
            && extra_time(r, "claim_expires_at").is_some_and(|t| t < now)
            && worktree_of(r).map_or(Ok(true), |w| owns(read, &w, &host))?
        {
            expired = true;
            break;
        }
    }
    let segmented = !list_pending_segmented_projections_in(
        read,
        env,
        &SegmentedProjectionFilter {
            limit: 1.0,
            ..SegmentedProjectionFilter::default()
        },
    )?
    .is_empty();
    let stale = match abandoned {
        None => false,
        Some(cutoff) => {
            all.iter().any(|r| {
                r.state == "running"
                    && extra_is_null(r, "recovery")
                    && !extra_bool(r, "publication_started")
                    && r.updated_at_us < cutoff
            }) || all_effects(read)?
                .iter()
                .any(|e| e.state == "running" && e.recovery.is_none() && e.updated_at_us < cutoff)
        }
    };
    let work = write
        || recovery
        || expired
        || effect_due(read, &host, &all, &all_refreshes(read)?, now)?
        || effect_recovery(read, &host, now)?
        || pwork
        || segmented
        || topology_recovery(read, &host, &spec.retrying_topologies)?
        || overdue_deferred(read, &host, &all, now)?
        || stale;
    Ok(json!({
        "work": work,
        "projection_work": pwork,
        "projection_last": projection_last,
        "high_water": high_water,
    }))
}

impl Store {
    /// `probeIdleWork(spec)`.
    pub fn probe_idle_work(&self, spec: &IdleProbeSpec) -> Result<Value> {
        probe_idle_work_in(&*self.read()?, &*self.env, spec)
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::store;
    use serde_json::json;

    const HOST: &str = "a0000000-0000-4000-8000-0000000000a1";

    fn probe(s: &crate::Store) -> bool {
        let inc = s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
        let spec: super::IdleProbeSpec = serde_json::from_value(json!({
            "hostId": HOST, "cursor": { "after": { "source_incarnation": inc, "slug": "" }, "highWater": null },
        }))
        .unwrap();
        s.probe_idle_work(&spec).unwrap()["work"].as_bool().unwrap()
    }

    #[test]
    fn a_running_write_is_no_claimable_work() {
        let s = store();
        assert!(!probe(&s));
        let inc = s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
        let input: crate::persistence::WriteRequestInsert = serde_json::from_value(json!({
            "principalKind": "local_cli", "principalId": "p1", "requestId": "b0000000-0000-4000-8000-0000000000e1",
            "operation": "put_page", "sourceId": "default", "sourceIncarnation": inc, "slug": "notes/a", "digest": "d",
            "intent": {}, "authority": {}, "intentBytes": 1, "terminalReservation": 4096, "targetKind": "page",
            "protocolVersion": 1, "admitterVersion": "v", "counterKeys": [], "state": "queued",
        }))
        .unwrap();
        let id = s.insert_write_request(&input).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(probe(&s), "a queued write is work");
        let claimed = s
            .stamp_write_claim(&crate::persistence::ClaimStamp {
                id,
                token: "c0000000-0000-4000-8000-0000000000c1".into(),
                lease_ms: 30_000.0,
                phase_json: None,
            })
            .unwrap();
        assert_eq!(claimed.unwrap()["state"], json!("running"));
        assert!(
            !probe(&s),
            "a running write under a live lease is not claimable work"
        );
    }
}
