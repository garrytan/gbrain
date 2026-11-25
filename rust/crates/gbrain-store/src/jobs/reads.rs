//! Jobs slice 2: the reads: the sweeps' candidate lists, the stats, the unreviewed-authority list,
//! the retry source row, a delegated client's open-job count, an agent job's source state and the
//! cursor page.

use super::*;
use crate::timeline_queries::timestamptz_text;

/// `hasOverdueWatchdogSuspect` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverdueSpec {
    pub queue: String,
    pub names: Vec<String>,
    pub mark: String,
    pub wait_ms: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JobPageCursor {
    /// `created_at` as epoch microseconds, decimal text.
    pub micros: String,
    pub id: i64,
}

/// `listJobPage` arguments; `limit` is what the TypeScript caller already made `limit + 1`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobPageSpec {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub queue: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub owner_client_id: Option<String>,
    #[serde(default)]
    pub owner_actor: Option<[String; 4]>,
    pub limit: i64,
    #[serde(default)]
    pub cursor: Option<JobPageCursor>,
}

/// `jobActorSql` (types.ts): the accepted grant's actor (`system`, `external_id`, `member`) and
/// audience equal `actor`. `->>` text: a string as is, other JSON as its jsonb text, null or
/// missing as `''`. The audience of an `actingFor` array is its distinct text entries sorted bytewise
/// and joined by `,`; any other present value is `!`; a missing one is `''`.
pub(super) fn actor_matches(row: &JobRecord, actor: &[String; 4]) -> bool {
    let grant = row
        .submission_authority
        .as_ref()
        .and_then(|a| a.get("grant"));
    let text = |key: &str| {
        grant
            .and_then(|g| g.get("actor"))
            .and_then(|a| a.get(key))
            .and_then(jsonb_field_text)
            .unwrap_or_default()
    };
    let audience = match grant.and_then(|g| g.get("actingFor")) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(jsonb_field_text)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .join(","),
        Some(_) => "!".to_string(),
        None => String::new(),
    };
    text("system") == actor[0]
        && text("external_id") == actor[1]
        && text("member") == actor[2]
        && audience == actor[3]
}

/// `submission_authority IS DISTINCT FROM '{"version":1,"kind":"application"}'::jsonb`.
pub(super) fn is_unreviewed(authority: &Option<Value>) -> bool {
    let Some(Value::Object(m)) = authority else {
        return true;
    };
    !(m.len() == 2
        && m.get("version").and_then(Value::as_f64) == Some(1.0)
        && m.get("kind").and_then(Value::as_str) == Some("application"))
}

pub(super) fn live_rows(read: &dyn KvRead) -> Result<Vec<JobRecord>> {
    let mut rows = Vec::new();
    for status in NON_TERMINAL {
        rows.extend(rows_with_status(read, status)?);
    }
    rows.sort_by_key(|r| r.id);
    Ok(rows)
}

fn parse_since(what: &str, since: &str) -> Result<i64> {
    crate::env::parse_iso(since).ok_or_else(|| {
        StoreError::invalid(format!("{what}: since is not an ISO timestamp: {since}"))
    })
}

pub(super) fn hours_us(hours: f64) -> i64 {
    (hours * 3_600_000_000.0).round() as i64
}

#[derive(Default)]
struct TypeStats {
    total: u64,
    completed: u64,
    failed: u64,
    dead: u64,
    /// Sum and count of `finished_at - started_at`, in milliseconds.
    duration_ms: f64,
    durations: u64,
}

#[derive(Default)]
struct Drained {
    completed: u64,
    failed: u64,
    dead: u64,
    cancelled: u64,
}

impl Store {
    /// `handleWaitingTTL`'s scan: ids of `waiting` rows of `name` untouched for `hours`, oldest
    /// `updated_at` first.
    pub fn list_stale_waiting_job_ids(
        &self,
        name: &str,
        hours: f64,
        limit: i64,
    ) -> Result<Vec<i64>> {
        let read = self.read()?;
        let cutoff = self.env.now_micros() - hours_us(hours);
        let mut rows: Vec<JobRecord> = rows_with_status(&*read, "waiting")?
            .into_iter()
            .filter(|r| r.name == name && r.updated_at < cutoff)
            .collect();
        rows.sort_by_key(|r| (r.updated_at, r.id));
        Ok(rows
            .into_iter()
            .take(limit.max(0) as usize)
            .map(|r| r.id)
            .collect())
    }

    /// `countTtlExpiredWaiting`: how many `waiting` rows of `name` are past `hours`.
    pub fn count_ttl_expired_waiting(&self, name: &str, hours: f64) -> Result<usize> {
        let read = self.read()?;
        let cutoff = self.env.now_micros() - hours_us(hours);
        Ok(rows_with_status(&*read, "waiting")?
            .iter()
            .filter(|r| r.name == name && r.updated_at < cutoff)
            .count())
    }

    /// `getStats`' queries: counts by status; per-name intake since `since`; per-name outflow
    /// since `since` (by `finished_at`); the waiting depth; the stalled count; and the wedge
    /// signature of `queue`.
    pub fn read_job_stats(&self, since: &str, queue: &str) -> Result<Value> {
        let since = parse_since("readJobStats", since)?;
        let read = self.read()?;
        let now = self.env.now_micros();
        let rows = all_rows(&*read)?;
        let mut by_status: BTreeMap<&str, u64> = BTreeMap::new();
        let mut types: BTreeMap<&str, TypeStats> = BTreeMap::new();
        let mut drained: BTreeMap<&str, Drained> = BTreeMap::new();
        let mut depth: BTreeMap<&str, (u64, i64)> = BTreeMap::new();
        let mut stalled = 0u64;
        let (mut active_healthy, mut waiting, mut last_completed) = (0u64, 0u64, None::<i64>);
        for r in &rows {
            *by_status.entry(&r.status).or_default() += 1;
            if r.created_at >= since {
                let t = types.entry(&r.name).or_default();
                t.total += 1;
                match r.status.as_str() {
                    "completed" => t.completed += 1,
                    "failed" => t.failed += 1,
                    "dead" => t.dead += 1,
                    _ => {}
                }
                if let (Some(f), Some(s)) = (r.finished_at, r.started_at) {
                    t.duration_ms += (f - s) as f64 / 1000.0;
                    t.durations += 1;
                }
            }
            if is_terminal(&r.status) && r.finished_at.is_some_and(|f| f >= since) {
                let d = drained.entry(&r.name).or_default();
                match r.status.as_str() {
                    "completed" => d.completed += 1,
                    "failed" => d.failed += 1,
                    "dead" => d.dead += 1,
                    _ => d.cancelled += 1,
                }
            }
            if r.status == "waiting" {
                let d = depth.entry(&r.name).or_insert((0, i64::MAX));
                d.0 += 1;
                d.1 = d.1.min(r.created_at);
            }
            if r.status == "active" && r.lock_until.is_some_and(|l| l < now) {
                stalled += 1;
            }
            if r.queue == queue {
                if r.status == "active" && r.lock_until.is_some_and(|l| l > now) {
                    active_healthy += 1;
                }
                if r.status == "waiting" {
                    waiting += 1;
                }
                if r.status == "completed" {
                    last_completed = last_completed.max(Some(r.updated_at));
                }
            }
        }
        Ok(json!({
            "by_status": by_status.iter().map(|(s, c)| json!({ "status": s, "count": c })).collect::<Vec<_>>(),
            "types": types.iter().map(|(n, t)| json!({
                "name": n, "total": t.total, "completed": t.completed, "failed": t.failed, "dead": t.dead,
                "avg_duration_ms": (t.durations > 0).then(|| t.duration_ms / t.durations as f64),
            })).collect::<Vec<_>>(),
            "drained": drained.iter().map(|(n, d)| json!({
                "name": n, "completed": d.completed, "failed": d.failed, "dead": d.dead, "cancelled": d.cancelled,
            })).collect::<Vec<_>>(),
            "depth": depth.iter().map(|(n, (count, oldest))| json!({
                "name": n, "waiting_now": count, "oldest_waiting_seconds": (now - oldest) as f64 / 1_000_000.0,
            })).collect::<Vec<_>>(),
            "stalled": stalled,
            "wedge": {
                "active_healthy": active_healthy,
                "waiting": waiting,
                "last_completed": last_completed.map(timestamptz_text),
            },
        }))
    }

    /// `queueFamilyStats`: one line per queue family (the private queues under `prefix` fold into
    /// one family named `prefix` without its last character), by family in byte order.
    pub fn read_queue_family_stats(&self, since: &str, prefix: &str) -> Result<Vec<Value>> {
        let since = parse_since("readQueueFamilyStats", since)?;
        let read = self.read()?;
        let mut family_name = prefix.to_string();
        family_name.pop();
        #[derive(Default)]
        struct Family<'a> {
            queues: BTreeSet<&'a str>,
            waiting: u64,
            active: u64,
            total: u64,
            completed: u64,
            failed: u64,
            dead: u64,
        }
        let rows = all_rows(&*read)?;
        let mut families: BTreeMap<&str, Family> = BTreeMap::new();
        for r in &rows {
            let recent = r.created_at >= since;
            if !(recent || r.status == "waiting" || r.status == "active") {
                continue;
            }
            let key = if r.queue.starts_with(prefix) {
                family_name.as_str()
            } else {
                r.queue.as_str()
            };
            let f = families.entry(key).or_default();
            f.queues.insert(&r.queue);
            match r.status.as_str() {
                "waiting" => f.waiting += 1,
                "active" => f.active += 1,
                _ => {}
            }
            if recent {
                f.total += 1;
                match r.status.as_str() {
                    "completed" => f.completed += 1,
                    "failed" => f.failed += 1,
                    "dead" => f.dead += 1,
                    _ => {}
                }
            }
        }
        Ok(families
            .iter()
            .map(|(queue, f)| {
                json!({
                    "queue": queue, "queues": f.queues.len(), "waiting_now": f.waiting,
                    "active_now": f.active, "total": f.total, "completed": f.completed,
                    "failed": f.failed, "dead": f.dead,
                })
            })
            .collect())
    }

    /// `hasOverdueWatchdogSuspect`: a `waiting` row of the queue with an authority, a name in
    /// `names`, the mark, and `updated_at` at least `waitMs` old.
    pub fn has_overdue_watchdog_suspect(&self, spec: &OverdueSpec) -> Result<bool> {
        if spec.names.is_empty() {
            return Ok(false);
        }
        let read = self.read()?;
        let cutoff = self.env.now_micros() - ms_to_us(spec.wait_ms);
        for id in ids_under(&*read, &claim_prefix(&spec.queue))? {
            if let Some(r) = load(&*read, id)?
                && r.status == "waiting"
                && r.submission_authority.is_some()
                && spec.names.contains(&r.name)
                && r.marked(&spec.mark)
                && r.updated_at <= cutoff
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `UNREVIEWED_LIVE_JOBS_WHERE`: live rows whose authority is not exactly
    /// `{"version":1,"kind":"application"}` (a NULL authority is distinct), by id.
    pub fn list_unreviewed_jobs(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(live_rows(&*read)?
            .into_iter()
            .filter(|r| is_unreviewed(&r.submission_authority))
            .map(|r| {
                json!({
                    "id": r.id,
                    "submission_authority": r.submission_authority.as_ref().map(ordered),
                })
            })
            .collect())
    }

    /// `admitDelegatedRetry`'s read: `{ name, data }` of a `failed` or `dead` row.
    pub fn get_failed_job_for_retry(&self, id: i64) -> Result<Option<Value>> {
        Ok(load(&*self.read()?, id)?
            .filter(|r| r.status == "failed" || r.status == "dead")
            .map(|r| json!({ "name": r.name, "data": ordered(&r.data) })))
    }

    /// `countOpenJobsByOwner`: how many `subagent` rows in a non-terminal status carry
    /// `data->>'__owner_client_id' = client_id` (a delegated client's open slots, across queues).
    pub fn count_open_jobs_by_owner(&self, client_id: &str) -> Result<usize> {
        let read = self.read()?;
        let mut n = 0;
        for status in NON_TERMINAL {
            n += rows_with_status(&*read, status)?
                .iter()
                .filter(|r| {
                    r.name == "subagent"
                        && r.data
                            .get("__owner_client_id")
                            .and_then(jsonb_field_text)
                            .as_deref()
                            == Some(client_id)
                })
                .count();
        }
        Ok(n)
    }

    /// `readJobSourceState(sourceId)`: `{ archived, created_at, local_path, config }` of the source a
    /// remote job was accepted against, or `None` when no source has that id. The job authority
    /// checks compare `created_at` with the stamp the job froze, so a source deleted and created
    /// again denies the job; a generic job (sync, import, lint) also reads the registered root and
    /// config it runs under.
    pub fn read_job_source_state(&self, source_id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(crate::sources::read_source(&*read, source_id)?.map(|s| {
            json!({
                "archived": s.archived,
                "created_at": iso(s.created_at_us),
                "local_path": s.local_path,
                "config": s.config,
            })
        }))
    }

    /// `listJobPage`: rows newest first (`created_at DESC, id DESC`) after the cursor tuple, each
    /// with `created_us` (`created_at` as epoch microseconds text), at most `limit`.
    pub fn list_job_page(&self, spec: &JobPageSpec) -> Result<Vec<Value>> {
        let cursor = match &spec.cursor {
            None => None,
            Some(c) => Some((
                c.micros.parse::<i128>().map_err(|_| {
                    StoreError::invalid(format!("listJobPage: bad cursor micros {}", c.micros))
                })?,
                c.id,
            )),
        };
        let read = self.read()?;
        let mut rows = match &spec.status {
            Some(status) => rows_with_status(&*read, status)?,
            None => all_rows(&*read)?,
        };
        let actor = spec.owner_actor.clone().unwrap_or_default();
        rows.retain(|r| {
            spec.queue.as_ref().is_none_or(|q| &r.queue == q)
                && spec.name.as_ref().is_none_or(|n| &r.name == n)
                && cursor.is_none_or(|c| (i128::from(r.created_at), r.id) < c)
                && spec.owner_client_id.as_ref().is_none_or(|c| {
                    r.data
                        .get("__owner_client_id")
                        .and_then(jsonb_field_text)
                        .as_ref()
                        == Some(c)
                        && actor_matches(r, &actor)
                })
        });
        rows.sort_by_key(|r| std::cmp::Reverse((r.created_at, r.id)));
        Ok(rows
            .into_iter()
            .take(spec.limit.max(0) as usize)
            .map(|r| {
                let mut json = r.to_json();
                json["created_us"] = json!(r.created_at.to_string());
                json
            })
            .collect())
    }
}
