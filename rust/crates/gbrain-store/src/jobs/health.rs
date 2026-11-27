//! Jobs: the queue health reads (`engine-sql/jobs-health.ts`): what `gbrain doctor`'s queue checks,
//! the advisor's stalled-jobs collector and the submit-time queue probe ask of `minion_jobs`.
//!
//! Each read is the statement its TypeScript caller ran, answered from the job rows: every window
//! and cut-off is an argument, the clock is the store's, read once per call, and a tie the SQL
//! leaves to the planner breaks bytewise (the `COLLATE "C"` the SQL statements now carry). Counts
//! cross the binding as numbers. See rust/docs/store/jobs-health.md.

use super::*;
use crate::facts::like;
use crate::timeline_queries::jsonb_field_text;
use reads::hours_us;

/// The private dream queues' name prefix (`DREAM_INLINE_PRIVATE_QUEUE_PREFIX`).
const DREAM_INLINE: &str = "dream-inline-";
/// A whole number of seconds, as `EXTRACT(EPOCH FROM interval)::int` rounds it.
fn seconds_between(now: i64, then: i64) -> i64 {
    ((now - then) as f64 / 1_000_000.0).round() as i64
}

/// `readQueueHealthSignals` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSpec {
    pub waiting_threshold: f64,
    pub old_waiting_hours: f64,
    pub window_hours: f64,
    pub stalled_after_hours: f64,
}

/// `readQueueDivergence` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DivergenceSpec {
    pub window_hours: f64,
    pub ttl_reason_prefix: String,
}

/// The dream phase a dead subagent's key names: its own key, or the one a release kept in `data`.
fn phase(row: &JobRecord) -> &'static str {
    let key = row.idempotency_key.clone().or_else(|| {
        row.data
            .get("__released_idempotency_key")
            .and_then(jsonb_field_text)
    });
    match key {
        Some(k) if k.starts_with("dream:patterns:") => "patterns",
        Some(k) if k.starts_with("dream:synth") => "synthesize",
        _ => "other",
    }
}

impl Store {
    /// `readQueueHealthSignals(spec)`: `{ stalled, depth, rss_kills, prompt_too_long,
    /// old_embed_backfill }`.
    pub fn read_queue_health_signals(&self, spec: &HealthSpec) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let window = now - hours_us(spec.window_hours);

        let mut stalled: Vec<&JobRecord> = Vec::new();
        let active = rows_with_status(&*read, "active")?;
        let stalled_before = now - hours_us(spec.stalled_after_hours);
        stalled.extend(
            active
                .iter()
                .filter(|r| r.started_at.is_some_and(|s| s < stalled_before)),
        );
        stalled.sort_by_key(|r| (r.started_at, r.id));
        let total = stalled.len();

        let waiting = rows_with_status(&*read, "waiting")?;
        let mut depth: BTreeMap<(&str, &str), u64> = BTreeMap::new();
        for r in &waiting {
            *depth.entry((&r.name, &r.queue)).or_default() += 1;
        }
        let mut deep: Vec<_> = depth
            .into_iter()
            .filter(|(_, n)| (*n as f64) > spec.waiting_threshold)
            .collect();
        deep.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        deep.truncate(5);

        let mut rss_kills = 0u64;
        for status in ["dead", "failed"] {
            rss_kills += rows_with_status(&*read, status)?
                .iter()
                .filter(|r| {
                    r.finished_at.is_some_and(|f| f > window)
                        && r.error_text.as_deref() == Some("aborted: watchdog")
                })
                .count() as u64;
        }

        let mut phases: BTreeMap<&str, u64> = BTreeMap::new();
        for r in rows_with_status(&*read, "dead")? {
            if r.name == "subagent"
                && r.finished_at.is_some_and(|f| f > window)
                && match r.error_text.as_deref() {
                    Some(text) => like(text, "prompt_too_long:%", false)?,
                    None => false,
                }
            {
                *phases.entry(phase(&r)).or_default() += 1;
            }
        }

        let old_before = now - hours_us(spec.old_waiting_hours);
        let mut backfill: BTreeMap<(&str, &str), (u64, i64)> = BTreeMap::new();
        for r in waiting.iter().filter(|r| r.name == "embed-backfill") {
            let e = backfill.entry((&r.name, &r.queue)).or_insert((0, i64::MAX));
            e.0 += 1;
            e.1 = e.1.min(r.created_at);
        }
        let mut old: Vec<_> = backfill
            .into_iter()
            .filter(|(_, (_, oldest))| *oldest < old_before)
            .map(|((name, queue), (n, oldest))| (name, queue, n, seconds_between(now, oldest)))
            .collect();
        old.sort_by(|a, b| b.3.cmp(&a.3).then(a.1.cmp(b.1)));

        Ok(json!({
            "stalled": stalled.iter().take(5)
                .map(|r| json!({ "id": r.id, "name": r.name, "total": total }))
                .collect::<Vec<_>>(),
            "depth": deep.iter()
                .map(|((name, queue), n)| json!({ "name": name, "queue": queue, "depth": n }))
                .collect::<Vec<_>>(),
            "rss_kills": rss_kills,
            "prompt_too_long": phases.iter()
                .map(|(p, n)| json!({ "phase": p, "cnt": n }))
                .collect::<Vec<_>>(),
            "old_embed_backfill": old.iter()
                .map(|(name, queue, n, age)| json!({
                    "name": name, "queue": queue, "depth": n, "oldest_age_seconds": age,
                }))
                .collect::<Vec<_>>(),
        }))
    }

    /// `listWaitingByQueue()`: `{ queue, depth, oldest_age_seconds }` per queue with a waiting
    /// job, the deepest first and bytewise by queue on a tie.
    pub fn list_waiting_by_queue(&self) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut queues: BTreeMap<String, (u64, i64)> = BTreeMap::new();
        for r in rows_with_status(&*read, "waiting")? {
            let e = queues.entry(r.queue).or_insert((0, i64::MAX));
            e.0 += 1;
            e.1 = e.1.min(r.created_at);
        }
        let mut rows: Vec<_> = queues.into_iter().collect();
        rows.sort_by_key(|(_, (n, _))| std::cmp::Reverse(*n));
        Ok(Value::Array(
            rows.iter()
                .map(|(queue, (n, oldest))| {
                    json!({
                        "queue": queue, "depth": n, "oldest_age_seconds": seconds_between(now, *oldest),
                    })
                })
                .collect(),
        ))
    }

    /// `readQueueDivergence(spec)`: `{ divergence, ttl_cancelled }`, each by name.
    pub fn read_queue_divergence(&self, spec: &DivergenceSpec) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let window = now - hours_us(spec.window_hours);
        let pattern = format!("{}%", spec.ttl_reason_prefix);
        let mut waiting: BTreeMap<String, u64> = BTreeMap::new();
        let mut intake: BTreeMap<String, u64> = BTreeMap::new();
        let mut completed: BTreeMap<String, u64> = BTreeMap::new();
        let mut ttl: BTreeMap<String, u64> = BTreeMap::new();
        for r in all_rows(&*read)? {
            if r.status == "waiting" {
                *waiting.entry(r.name.clone()).or_default() += 1;
            }
            if r.created_at > window {
                *intake.entry(r.name.clone()).or_default() += 1;
            }
            let finished = r.finished_at.is_some_and(|f| f > window);
            if finished && r.status == "completed" {
                *completed.entry(r.name.clone()).or_default() += 1;
            }
            if finished
                && r.status == "cancelled"
                && match r.error_text.as_deref() {
                    Some(text) => like(text, &pattern, false)?,
                    None => false,
                }
            {
                *ttl.entry(r.name).or_default() += 1;
            }
        }
        Ok(json!({
            "divergence": waiting.iter().map(|(name, w)| json!({
                "name": name,
                "intake": intake.get(name).copied().unwrap_or(0),
                "completed": completed.get(name).copied().unwrap_or(0),
                "waiting": w,
            })).collect::<Vec<_>>(),
            "ttl_cancelled": ttl.iter()
                .map(|(name, n)| json!({ "name": name, "count": n }))
                .collect::<Vec<_>>(),
        }))
    }

    /// `listQueueWedgeCounts()`: per queue (the private dream queues left out) the live-lock active
    /// rows, the waiting rows and the minutes since the latest completion, by queue.
    pub fn list_queue_wedge_counts(&self) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        #[derive(Default)]
        struct Queue {
            active_healthy: u64,
            waiting: u64,
            last_completed: Option<i64>,
        }
        let mut queues: BTreeMap<String, Queue> = BTreeMap::new();
        for r in all_rows(&*read)? {
            if r.queue.starts_with(DREAM_INLINE) {
                continue;
            }
            let q = queues.entry(r.queue).or_default();
            match r.status.as_str() {
                "active" if r.lock_until.is_some_and(|l| l > now) => q.active_healthy += 1,
                "waiting" => q.waiting += 1,
                "completed" => q.last_completed = q.last_completed.max(Some(r.updated_at)),
                _ => {}
            }
        }
        Ok(Value::Array(
            queues
                .iter()
                .map(|(queue, q)| {
                    json!({
                        "queue": queue, "active_healthy": q.active_healthy, "waiting": q.waiting,
                        "mins_since_completion": q.last_completed
                            .map(|t| (now - t) as f64 / 60_000_000.0),
                    })
                })
                .collect(),
        ))
    }

    /// `listPrivateQueueHealth()`: per dream-inline queue, by queue: the smallest `data.source_id`
    /// (bytewise), live-lock active, waiting-class (`waiting` and `delayed`) and paused rows, the
    /// minutes since the oldest waiting-class row and the oldest row's `created_at` in epoch ms.
    pub fn list_private_queue_health(&self) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        #[derive(Default)]
        struct Queue {
            source_id: Option<String>,
            active_healthy: u64,
            waiting: u64,
            paused: u64,
            oldest_waiting: Option<i64>,
            born: Option<i64>,
        }
        let mut queues: BTreeMap<String, Queue> = BTreeMap::new();
        for r in all_rows(&*read)? {
            if !r.queue.starts_with(DREAM_INLINE) {
                continue;
            }
            let source = r.data.get("source_id").and_then(jsonb_field_text);
            let q = queues.entry(r.queue).or_default();
            if let Some(s) = source {
                q.source_id = Some(match q.source_id.take() {
                    Some(have) if have <= s => have,
                    _ => s,
                });
            }
            q.born = Some(q.born.map_or(r.created_at, |b| b.min(r.created_at)));
            match r.status.as_str() {
                "active" if r.lock_until.is_some_and(|l| l > now) => q.active_healthy += 1,
                "waiting" | "delayed" => {
                    q.waiting += 1;
                    q.oldest_waiting = Some(
                        q.oldest_waiting
                            .map_or(r.created_at, |o| o.min(r.created_at)),
                    );
                }
                "paused" => q.paused += 1,
                _ => {}
            }
        }
        Ok(Value::Array(
            queues
                .iter()
                .map(|(queue, q)| {
                    json!({
                        "queue": queue, "source_id": q.source_id,
                        "active_healthy": q.active_healthy, "waiting": q.waiting, "paused": q.paused,
                        "oldest_waiting_minutes": q.oldest_waiting
                            .map(|t| (now - t) as f64 / 60_000_000.0),
                        "birth_epoch_ms": q.born.map(|t| t as f64 / 1000.0),
                    })
                })
                .collect(),
        ))
    }

    /// `readWedgeSignals(queue, handlerNames)`: one queue's `{ stalled, activeHealthy, waiting,
    /// waitingClaimable, lastCompleted, lastCompletedClaimable }`, the two dates as ISO text.
    pub fn read_wedge_signals(&self, queue: &str, handler_names: &[String]) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let (mut stalled, mut active_healthy, mut waiting, mut claimable) =
            (0u64, 0u64, 0u64, 0u64);
        let (mut last, mut last_claimable) = (None::<i64>, None::<i64>);
        for r in all_rows(&*read)? {
            if r.queue != queue {
                continue;
            }
            let handled = handler_names.contains(&r.name);
            match r.status.as_str() {
                "active" if r.lock_until.is_some_and(|l| l < now) => stalled += 1,
                "active" if r.lock_until.is_some_and(|l| l > now) => active_healthy += 1,
                "waiting" => {
                    waiting += 1;
                    claimable += u64::from(handled);
                }
                "delayed" if handled && r.delay_until.is_some_and(|d| d <= now) => claimable += 1,
                "completed" => {
                    last = last.max(Some(r.updated_at));
                    if handled {
                        last_claimable = last_claimable.max(Some(r.updated_at));
                    }
                }
                _ => {}
            }
        }
        Ok(json!({
            "stalled": stalled, "activeHealthy": active_healthy, "waiting": waiting,
            "waitingClaimable": claimable,
            "lastCompleted": last.map(iso),
            "lastCompletedClaimable": last_claimable.map(iso),
        }))
    }

    /// `readOldestWaitingAge(queue)`: the age in whole seconds of the oldest `waiting` job, or
    /// null.
    pub fn read_oldest_waiting_age(&self, queue: &str) -> Result<Option<i64>> {
        let read = self.read()?;
        let now = self.env.now_micros();
        Ok(rows_with_status(&*read, "waiting")?
            .iter()
            .filter(|r| r.queue == queue)
            .map(|r| r.created_at)
            .min()
            .map(|oldest| seconds_between(now, oldest)))
    }

    /// `readUntakenWaitingJobs(name, thresholdHours)`: the queue whose waiting `name` jobs no
    /// worker takes, as `{ queue, waiting, oldest_age_seconds }`, or null. Only jobs with a
    /// submission authority count. A queue qualifies when its oldest such job last became waiting
    /// (`updated_at`) more than `threshold_hours` ago and no job of any name on it is active with a
    /// live lock or started within that time. The oldest wins; equal ages go to the queue by bytes
    /// (the SQL leaves that tie to the planner).
    pub fn read_untaken_waiting_jobs(&self, name: &str, threshold_hours: f64) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let cutoff = now - hours_us(threshold_hours);
        let mut stuck: BTreeMap<String, (u64, i64)> = BTreeMap::new();
        for r in rows_with_status(&*read, "waiting")? {
            if r.name != name || r.submission_authority.is_none() {
                continue;
            }
            let entry = stuck.entry(r.queue).or_insert((0, i64::MAX));
            entry.0 += 1;
            entry.1 = entry.1.min(r.updated_at);
        }
        stuck.retain(|_, (_, oldest)| *oldest < cutoff);
        if stuck.is_empty() {
            return Ok(Value::Null);
        }
        let mut served: BTreeSet<String> = BTreeSet::new();
        for status in STATUSES {
            for r in rows_with_status(&*read, status)? {
                let live = r.status == "active" && r.lock_until.is_some_and(|l| l > now);
                if live || r.started_at.is_some_and(|s| s > cutoff) {
                    served.insert(r.queue);
                }
            }
        }
        let best = stuck
            .into_iter()
            .filter(|(queue, _)| !served.contains(queue))
            .map(|(queue, (waiting, oldest))| (seconds_between(now, oldest), queue, waiting))
            .fold(None::<(i64, String, u64)>, |best, row| match best {
                Some(b) if b.0 >= row.0 => Some(b),
                _ => Some(row),
            });
        Ok(match best {
            Some((age, queue, waiting)) => {
                json!({ "queue": queue, "waiting": waiting, "oldest_age_seconds": age })
            }
            None => Value::Null,
        })
    }

    /// `countWaitingJobs(excludeFactsAbsorb)`: the `waiting` jobs, without the `facts-absorb`
    /// jobs when `exclude_facts_absorb`.
    pub fn count_waiting_jobs(&self, exclude_facts_absorb: bool) -> Result<u64> {
        let read = self.read()?;
        Ok(rows_with_status(&*read, "waiting")?
            .iter()
            .filter(|r| !(exclude_facts_absorb && r.name == "facts-absorb"))
            .count() as u64)
    }

    /// `countWaitingJobsForNames(queue, names)`: the `waiting` jobs of `queue` whose name is in `names` (the minion
    /// worker's stall count). The `waiting` status index lists the ids; each row is read, counted if it matches and
    /// dropped, so no row of another queue or name is kept and no full-queue load happens.
    pub fn count_waiting_jobs_for_names(&self, queue: &str, names: &[String]) -> Result<u64> {
        let read = self.read()?;
        let mut count = 0u64;
        for_each_row_with_status(&*read, "waiting", &mut |r| {
            if r.queue == queue && names.contains(&r.name) {
                count += 1;
            }
        })?;
        Ok(count)
    }

    /// `listStuckActiveJobsByName()`: `{ name, n }` of the active jobs whose lock lapsed or whose
    /// stalled counter reached two, the most first and bytewise by name on a tie.
    pub fn list_stuck_active_jobs_by_name(&self) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut names: BTreeMap<String, u64> = BTreeMap::new();
        for r in rows_with_status(&*read, "active")? {
            if r.lock_until.is_some_and(|l| l < now) || r.stalled_counter >= 2 {
                *names.entry(r.name).or_default() += 1;
            }
        }
        let mut rows: Vec<_> = names.into_iter().collect();
        rows.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        Ok(Value::Array(
            rows.iter()
                .map(|(name, n)| json!({ "name": name, "n": n }))
                .collect(),
        ))
    }
}
