//! The consumer's idle probe (`probeIdleWork`, `src/core/engine-sql/persistence-idle-probe.ts`;
//! rust/docs/store/persistence.md, "Idle probe"): whether any worker of this host has work, and
//! where the resident projection window stands.
//!
//! The write and effect terms read a worktree row through the seam (`worktree_rows.rs`) when a
//! row names one, and the seam refuses `engine_capability_missing` until the binding lands, so the
//! probe never reports "no work" in place of a row it cannot read. The inserts refuse every
//! worktree id, so the recovery and overdue terms that join `persistence_worktrees` find no row;
//! the terms that allow a null worktree are answered as Postgres answers them for one.

use super::effect_worker::pg_uuid;
use super::effects::all_effects;
use super::projection_queue::{
    ProjectionWindowCursor, SegmentedProjectionFilter, list_pending_segmented_projections_in,
    parse_timestamptz, select_projection_window_jobs_in, sources_by_incarnation,
};
use super::worktree_rows::read_worktree_row;
use super::{
    ClaimableSpec, all_requests, candidates, claimable, extra_bool, extra_is_null, extra_time,
    foreground_priority, pending,
};
use crate::Store;
use crate::env::Env;
use crate::error::Result;
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

/// The effect term: a due effect without a worktree, not in recovery, and not waiting on an
/// uncommitted withdrawal mirror of its request (`mirror.state<>'committed'`).
/// A due effect on a worktree depends on its worktree row, which the seam refuses to read
/// until it can (`worktree_rows.rs`), so the probe refuses rather than answer "no work".
fn effect_due(read: &dyn KvRead, now: i64) -> Result<bool> {
    let effects = all_effects(read)?;
    let mut due_now = false;
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
        match (&e.worktree_id, due) {
            (Some(id), true) => {
                read_worktree_row(read, id)?;
            }
            (None, true) => due_now = true,
            _ => {}
        }
    }
    Ok(due_now)
}

/// `probeIdleWork(spec)`: `{ work, projection_work, projection_last, high_water }`.
pub(crate) fn probe_idle_work_in(
    read: &dyn KvRead,
    env: &dyn Env,
    spec: &IdleProbeSpec,
) -> Result<Value> {
    pg_uuid(&spec.host_id)?;
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

    let priority = foreground_priority(read, spec.foreground_priority)?;
    let all = all_requests(read)?;
    let pending = pending(&all);
    let claim_spec = ClaimableSpec {
        exclude_roots: spec.excluded_roots.clone(),
        ..ClaimableSpec::default()
    };
    // Only the rows the claim may take count: a running or recovering row is not write work.
    let write = candidates(read, &all)?.iter().any(|r| {
        claimable(r, &pending, priority, &claim_spec, &spec.lane_roots, now)
            && (spec.publishing || r.blocked_reason.as_deref() != Some("writer_pool_capacity"))
    });
    let expired = all.iter().any(|r| {
        r.state == "running"
            && extra_is_null(r, "recovery")
            && !extra_bool(r, "publication_started")
            && extra_time(r, "claim_expires_at").is_some_and(|t| t < now)
            && extra_is_null(r, "worktree_id")
    });
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
    let work = write || expired || pwork || segmented || stale || effect_due(read, now)?;
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
