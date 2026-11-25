//! The dream cycle's reads of the job queue and the cycle locks (`src/core/engine-sql/dream-cycle.ts`):
//! the retriage candidates and status re-check, the live cycle locks, and the synthesize family's
//! job reads. Each method answers what its statement selects; the SQL engines return unordered
//! rows in no set order, and this store returns them in id order.
//!
//! The `LIKE` patterns these statements use end in `%` and hold no other wildcard, so each one is
//! a prefix test.

use super::*;

/// The synthesis key family (`LIKE 'dream:synth-v2:%'`).
const SYNTH_V2: &str = "dream:synth-v2:";
/// A private dream-inline queue (`LIKE 'dream-inline-%'`).
const INLINE_QUEUE: &str = "dream-inline-";
/// A cycle lock id (`LIKE 'gbrain-cycle%'`).
const CYCLE_LOCK: &str = "gbrain-cycle";
const DAY_US: i64 = 86_400_000_000;

/// `COALESCE(NULLIF(data->>'source_id', ''), 'default')`.
fn job_source(data: &Value) -> String {
    data.as_object()
        .and_then(|o| o.get("source_id"))
        .and_then(jsonb_field_text)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".into())
}

/// `data->>'__released_idempotency_key'`.
fn released_key(data: &Value) -> Option<String> {
    data.as_object()
        .and_then(|o| o.get("__released_idempotency_key"))
        .and_then(jsonb_field_text)
}

/// An id an `int[]` bind accepts.
fn int4_ids(op: &str, ids: &[i64]) -> Result<()> {
    match ids.iter().find(|id| i32::try_from(**id).is_err()) {
        Some(id) => Err(StoreError::invalid(format!(
            "{op}: value \"{id}\" is out of range for type integer"
        ))),
        None => Ok(()),
    }
}

fn by_ids(read: &dyn KvRead, ids: &[i64]) -> Result<Vec<JobRecord>> {
    let wanted: BTreeSet<i64> = ids.iter().copied().collect();
    let mut rows = Vec::new();
    for id in wanted {
        if let Some(row) = load(read, id)? {
            rows.push(row);
        }
    }
    Ok(rows)
}

impl Store {
    /// `listDreamQueueCandidates()`: waiting, delayed and paused `subagent` jobs of a dream
    /// synthesis key or a private dream-inline queue: `{ id, queue, status, idempotency_key,
    /// source_id }`.
    pub fn list_dream_queue_candidates(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for status in ["waiting", "delayed", "paused"] {
            rows.extend(rows_with_status(&*read, status)?);
        }
        rows.sort_by_key(|r| r.id);
        Ok(rows
            .into_iter()
            .filter(|r| {
                r.name == "subagent"
                    && (r
                        .idempotency_key
                        .as_deref()
                        .is_some_and(|k| k.starts_with(SYNTH_V2))
                        || r.queue.starts_with(INLINE_QUEUE))
            })
            .map(|r| {
                json!({
                    "id": r.id,
                    "queue": r.queue,
                    "status": r.status,
                    "idempotency_key": r.idempotency_key,
                    "source_id": job_source(&r.data),
                })
            })
            .collect())
    }

    /// `listLiveDreamCycleLocks(graceSecs)`: the `gbrain-cycle%` locks that are unexpired or
    /// refreshed within `graceSecs`: `{ id, acquired_epoch_ms }`, in id order.
    pub fn list_live_dream_cycle_locks(&self, grace_secs: f64) -> Result<Vec<Value>> {
        if !grace_secs.is_finite() {
            return Err(StoreError::invalid(format!(
                "listLiveDreamCycleLocks: the steal grace must be a number, got {grace_secs}"
            )));
        }
        let read = self.read()?;
        let now = self.env.now_micros();
        let refreshed_after = now - (grace_secs * 1_000_000.0).round() as i64;
        let mut rows: Vec<(String, LockRecord)> = all_locks(&*read)?
            .into_iter()
            .filter(|(id, l)| {
                id.starts_with(CYCLE_LOCK)
                    && (l.ttl_expires_at > now
                        || l.last_refreshed_at.is_some_and(|at| at > refreshed_after))
            })
            .collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(rows
            .into_iter()
            .map(|(id, l)| json!({ "id": id, "acquired_epoch_ms": l.acquired_at as f64 / 1000.0 }))
            .collect())
    }

    /// `readDreamJobStatus(id)`: `{ status }`, or `None` when the job is gone.
    pub fn read_dream_job_status(&self, id: i64) -> Result<Option<Value>> {
        Ok(load(&*self.read()?, id)?.map(|r| json!({ "status": r.status })))
    }

    /// `listDreamJobCreatedAt(ids)`: `{ id, created_at }` of each job in `ids` (an `int[]`).
    pub fn list_dream_job_created_at(&self, ids: &[i64]) -> Result<Vec<Value>> {
        int4_ids("listDreamJobCreatedAt", ids)?;
        Ok(by_ids(&*self.read()?, ids)?
            .into_iter()
            .map(|r| json!({ "id": r.id, "created_at": iso(r.created_at) }))
            .collect())
    }

    /// `listCompletedSynthJobs(key)`: `{ id, idempotency_key }` of each completed job of `key` or
    /// one of its chunks (`key:c...`), by id.
    pub fn list_completed_synth_jobs(&self, key: &str) -> Result<Vec<Value>> {
        let chunk = format!("{key}:c");
        let mut rows = rows_with_status(&*self.read()?, "completed")?;
        rows.sort_by_key(|r| r.id);
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                let k = r.idempotency_key?;
                (k == key || k.starts_with(&chunk))
                    .then(|| json!({ "id": r.id, "idempotency_key": k }))
            })
            .collect())
    }

    /// `countCoalescibleSynthJobs(keys)`: the jobs under `keys` that are not cancelled or dead.
    pub fn count_coalescible_synth_jobs(&self, keys: &[String]) -> Result<i64> {
        if keys.is_empty() {
            return Ok(0);
        }
        let wanted: HashSet<&str> = keys.iter().map(String::as_str).collect();
        Ok(all_rows(&*self.read()?)?
            .iter()
            .filter(|r| {
                r.idempotency_key
                    .as_deref()
                    .is_some_and(|k| wanted.contains(k))
                    && r.status != "cancelled"
                    && r.status != "dead"
            })
            .count() as i64)
    }

    /// `listWaitingChildJobIds(queue)`: `{ id }` of the waiting or delayed jobs of `queue`.
    pub fn list_waiting_child_job_ids(&self, queue: &str) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows = rows_with_status(&*read, "waiting")?;
        rows.extend(rows_with_status(&*read, "delayed")?);
        rows.sort_by_key(|r| r.id);
        Ok(rows
            .into_iter()
            .filter(|r| r.queue == queue)
            .map(|r| json!({ "id": r.id }))
            .collect())
    }

    /// `listDreamChildJobTimings(ids)`: the timestamps and token counts of each job in `ids`.
    pub fn list_dream_child_job_timings(&self, ids: &[i64]) -> Result<Vec<Value>> {
        Ok(by_ids(&*self.read()?, ids)?
            .into_iter()
            .map(|r| {
                json!({
                    "created_at": iso(r.created_at),
                    "started_at": r.started_at.map(iso),
                    "finished_at": r.finished_at.map(iso),
                    "tokens_input": r.tokens_input,
                    "tokens_output": r.tokens_output,
                    "tokens_cache_read": r.tokens_cache_read,
                })
            })
            .collect())
    }

    /// `countRecentDreamSynthSubmissions(sourceId)`: the `subagent` jobs of a dream synthesis key
    /// (or a released one) of `sourceId` created in the last 24 hours, not counting cancelled ones.
    pub fn count_recent_dream_synth_submissions(&self, source_id: &str) -> Result<i64> {
        let cutoff = self.env.now_micros() - DAY_US;
        Ok(all_rows(&*self.read()?)?
            .iter()
            .filter(|r| {
                let synth = match r.idempotency_key.as_deref() {
                    Some(k) => k.starts_with(SYNTH_V2),
                    None => released_key(&r.data).is_some_and(|k| k.starts_with(SYNTH_V2)),
                };
                r.name == "subagent"
                    && synth
                    && job_source(&r.data) == source_id
                    && r.status != "cancelled"
                    && r.created_at > cutoff
            })
            .count() as i64)
    }
}
