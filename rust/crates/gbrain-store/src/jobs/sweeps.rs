//! Jobs slice 2: the multi-row writes: the delayed promotion, the cancel cascade, the two timeout
//! kills and the prune.

use super::reads::actor_matches;
use super::synthesis_completions;
use super::*;

/// `cancelJobs` options (`queue.ts` `cancelJobs`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelOpts {
    /// Stamped as `error_text` on the root ids only (`COALESCE(reason, error_text)`).
    #[serde(default)]
    pub reason: Option<String>,
    /// A root must be in one of these statuses.
    #[serde(default)]
    pub root_statuses: Option<Vec<String>>,
    /// The owner fence: `data->>'__owner_client_id'` and the actor must match.
    #[serde(default)]
    pub owner_client_id: Option<String>,
    #[serde(default)]
    pub owner_actor: Option<[String; 4]>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneSpec {
    pub statuses: Vec<String>,
    pub older_than: String,
    #[serde(default)]
    pub dry_run: bool,
}

/// `count`: the rows a dry run counts or a prune deletes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneOutcome {
    pub count: usize,
}

/// The depth cap of the cancel cascade (`descendants.d < 100`).
const CASCADE_DEPTH: usize = 100;

fn is_live(status: &str) -> bool {
    NON_TERMINAL.contains(&status)
}

/// `killJobs`: `child_done` to each live parent (in row order), then each parent that is left with
/// no open child resolved, ascending.
fn kill_tail(
    tx: &mut dyn KvWrite,
    rows: &[JobRecord],
    outcome: &str,
    error: &str,
    now: i64,
) -> Result<()> {
    let mut parents = BTreeSet::new();
    for r in rows {
        if let Some(parent) = r.parent_job_id {
            parents.insert(parent);
            post_child_done(tx, parent, child_done(r, None, outcome, Some(error)), now)?;
        }
    }
    for parent in parents {
        resolve_parent(tx, parent, now)?;
    }
    Ok(())
}

impl Store {
    /// `promoteDelayed`: every `delayed` row whose `delay_until` has passed goes to `waiting`.
    pub fn promote_delayed_jobs(&self) -> Result<Vec<Value>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut out = Vec::new();
            for old in rows_with_status(tx, "delayed")? {
                if !old.delay_until.is_some_and(|d| d <= now) {
                    continue;
                }
                let mut new = old.clone();
                new.status = "waiting".into();
                new.delay_until = None;
                new.started_at = None;
                new.lock_token = None;
                new.lock_until = None;
                new.updated_at = now;
                save(tx, Some(&old), &new)?;
                out.push(new.to_json());
            }
            Ok(out)
        })
    }

    /// `cancelJobs`: the seed rows (existing, in `root_statuses`, passing the owner fence) and
    /// their descendants to depth 100, those still live set `cancelled`; then a `child_done`
    /// (`outcome: 'cancelled'`) to each cancelled row's live parent, and every such parent with no
    /// open child resolved. Returns the cancelled rows by id.
    pub fn cancel_jobs(&self, ids: &[i64], opts: &CancelOpts) -> Result<Vec<Value>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let roots: BTreeSet<i64> = ids.iter().copied().collect();
            let actor = opts.owner_actor.clone().unwrap_or_default();
            let mut seen = BTreeSet::new();
            let mut frontier = Vec::new();
            for id in &roots {
                let Some(row) = load(tx, *id)? else { continue };
                let status_ok = opts
                    .root_statuses
                    .as_ref()
                    .is_none_or(|s| s.contains(&row.status));
                let owner_ok = opts.owner_client_id.as_ref().is_none_or(|c| {
                    row.data
                        .get("__owner_client_id")
                        .and_then(jsonb_field_text)
                        .as_ref()
                        == Some(c)
                        && actor_matches(&row, &actor)
                });
                if status_ok && owner_ok && seen.insert(*id) {
                    frontier.push(*id);
                }
            }
            for _ in 0..CASCADE_DEPTH {
                let mut next = Vec::new();
                for id in &frontier {
                    for child in ids_under(tx, &child_prefix(*id))? {
                        if seen.insert(child) {
                            next.push(child);
                        }
                    }
                }
                frontier = next;
            }
            let mut cancelled = Vec::new();
            for id in &seen {
                let Some(old) = load(tx, *id)?.filter(|r| is_live(&r.status)) else {
                    continue;
                };
                let mut new = old.clone();
                new.status = "cancelled".into();
                new.lock_token = None;
                new.lock_until = None;
                if roots.contains(id)
                    && let Some(reason) = &opts.reason
                {
                    new.error_text = Some(reason.clone());
                }
                new.finished_at = Some(now);
                new.updated_at = now;
                save(tx, Some(&old), &new)?;
                cancelled.push(new);
            }
            let mut parents = BTreeSet::new();
            for r in &cancelled {
                if let Some(parent) = r.parent_job_id {
                    parents.insert(parent);
                    let payload = child_done(r, None, "cancelled", Some("cancelled"));
                    post_child_done(tx, parent, payload, now)?;
                }
            }
            for parent in parents {
                resolve_parent(tx, parent, now)?;
            }
            Ok(cancelled.iter().map(JobRecord::to_json).collect())
        })
    }

    /// `handleTimeouts`: an `active`, leased row past its `timeout_at` goes `dead` (`timeout
    /// exceeded`); its live parent hears `child_done` and wakes. `remove_on_fail` does not apply.
    pub fn kill_timed_out_jobs(&self) -> Result<Vec<Value>> {
        self.kill_timed_out_jobs_fenced(None)
    }

    /// `kill_timed_out_jobs` under the caller's host fence: the sweeping worker must hold its lease, and each job it
    /// ends loses its claim epoch in the same write (`lease_lost` otherwise, nothing ended).
    pub fn kill_timed_out_jobs_fenced(&self, fence: Option<&LeaseToken>) -> Result<Vec<Value>> {
        self.write(|tx| {
            fence::begin(self, tx, fence, "kill_timed_out_jobs")?;
            let now = self.lease_clock();
            kill_where(self, tx, fence, now, "timeout exceeded", |r| {
                r.timeout_at.is_some_and(|t| t < now) && r.lock_until.is_some_and(|l| l > now)
            })
        })
    }

    /// `handleWallClockTimeouts`: an `active` row running longer than twice its `timeout_ms` (or
    /// twice its lease for `max_stalled` stalls) goes `dead` (`wall-clock timeout exceeded`).
    pub fn kill_wall_clock_jobs(&self, lock_duration_ms: f64) -> Result<Vec<Value>> {
        self.kill_wall_clock_jobs_fenced(lock_duration_ms, None)
    }

    /// `kill_wall_clock_jobs` under the caller's host fence (see `kill_timed_out_jobs_fenced`).
    pub fn kill_wall_clock_jobs_fenced(
        &self,
        lock_duration_ms: f64,
        fence: Option<&LeaseToken>,
    ) -> Result<Vec<Value>> {
        self.write(|tx| {
            fence::begin(self, tx, fence, "kill_wall_clock_jobs")?;
            let now = self.lease_clock();
            kill_where(self, tx, fence, now, "wall-clock timeout exceeded", |r| {
                let Some(started) = r.started_at else {
                    return false;
                };
                let threshold = match r.timeout_ms {
                    Some(t) => f64::from(t) * 2.0,
                    None => {
                        r.lock_duration_ms.map_or(lock_duration_ms, f64::from)
                            * 2.0
                            * f64::from(r.max_stalled.max(1))
                    }
                };
                (now - started) as f64 / 1000.0 > threshold
            })
        })
    }

    /// `prune`: rows in `statuses` last updated before `olderThan`. `dryRun` only counts. A
    /// completed dream-synthesis child (`subagent`, `dream:synth%` key) goes into the
    /// `dream_synthesis_completions` archive (`synthesis_completions.rs`) in the delete's
    /// transaction, as the SQL engines' `archived` CTE does.
    pub fn prune_jobs(&self, spec: &PruneSpec) -> Result<PruneOutcome> {
        let older = crate::env::parse_iso(&spec.older_than).ok_or_else(|| {
            StoreError::invalid(format!(
                "pruneJobs: olderThan is not an ISO timestamp: {}",
                spec.older_than
            ))
        })?;
        let statuses: BTreeSet<&str> = spec.statuses.iter().map(String::as_str).collect();
        let pick = |read: &dyn KvRead| -> Result<Vec<JobRecord>> {
            let mut rows = Vec::new();
            for status in &statuses {
                rows.extend(
                    rows_with_status(read, status)?
                        .into_iter()
                        .filter(|r| r.updated_at < older),
                );
            }
            Ok(rows)
        };
        if spec.dry_run {
            return Ok(PruneOutcome {
                count: pick(&*self.read()?)?.len(),
            });
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let rows = pick(&*tx)?;
            for row in &rows {
                synthesis_completions::archive_pruned(tx, row, now)?;
            }
            for row in &rows {
                // An earlier delete of this batch may have changed this row (a SET NULL): reload.
                if let Some(current) = load(tx, row.id)? {
                    delete_row(tx, &current)?;
                }
            }
            Ok(PruneOutcome { count: rows.len() })
        })
    }
}

/// The shared `UPDATE ... SET status = 'dead'` of both timeout kills, then `killJobs`.
fn kill_where(
    store: &Store,
    tx: &mut dyn KvWrite,
    fence: Option<&LeaseToken>,
    now: i64,
    error: &str,
    due: impl Fn(&JobRecord) -> bool,
) -> Result<Vec<Value>> {
    let mut dead = Vec::new();
    for old in rows_with_status(tx, "active")? {
        if old.queue == LEASE_BEACON_QUEUE || !due(&old) {
            continue;
        }
        let mut new = old.clone();
        new.status = "dead".into();
        new.error_text = Some(error.into());
        new.attempts_made = old.attempts_made + 1;
        new.lock_token = None;
        new.lock_until = None;
        new.finished_at = Some(now);
        new.updated_at = now;
        save(tx, Some(&old), &new)?;
        // The claim ends with the job: its epoch record goes in the same write.
        fence::claim_ended(store, tx, CLAIM_JOB, &old.id.to_string(), fence)?;
        dead.push(new);
    }
    kill_tail(tx, &dead, "timeout", error, now)?;
    Ok(dead.iter().map(JobRecord::to_json).collect())
}
