//! The drain lease's holder record (`src/core/persistence/sync-lease.ts`) and the resident
//! notifier's live-job read (`src/core/notifier/resident.ts`).
//!
//! The holder record is one `gbrain-drain-lease` row per lease, keyed by the lease token, carrying
//! the holder's kind, id and version under `data.drain_lease_beacon`. No worker serves the queue:
//! the row is written when the lease is taken, renewed with it and deleted on release.

use super::*;

/// `holder.lock_until = now + ttl minutes`, in microseconds.
fn lease_until(now: i64, ttl_minutes: f64) -> i64 {
    now + (ttl_minutes * 60_000_000.0).round() as i64
}

/// The holder records of one lease token, by id.
fn holder_rows(read: &dyn KvRead, lock_token: &str) -> Result<Vec<JobRecord>> {
    let mut rows: Vec<JobRecord> = all_rows(read)?
        .into_iter()
        .filter(|r| r.queue == LEASE_BEACON_QUEUE && r.lock_token.as_deref() == Some(lock_token))
        .collect();
    rows.sort_by_key(|r| r.id);
    Ok(rows)
}

impl Store {
    /// `readLiveJobIds(ids)`: the given ids whose job is waiting, active, delayed,
    /// waiting-children or paused, ascending and once each. A finished or missing job is dropped.
    pub fn read_live_job_ids(&self, ids: &[i64]) -> Result<Vec<i64>> {
        let read = self.read()?;
        let mut live = BTreeSet::new();
        for &id in ids {
            if load(&*read, id)?.is_some_and(|r| NON_TERMINAL.contains(&r.status.as_str())) {
                live.insert(id);
            }
        }
        Ok(live.into_iter().collect())
    }

    /// `readDrainLeaseBeacon(lockToken)`: `data.drain_lease_beacon` of the lease's holder record
    /// (the lowest id when several match), or `None` when no record carries the token or the record
    /// has no beacon.
    pub fn read_drain_lease_beacon(&self, lock_token: &str) -> Result<Option<Value>> {
        let rows = holder_rows(&*self.read()?, lock_token)?;
        Ok(rows
            .first()
            .and_then(|r| r.data.get("drain_lease_beacon"))
            .filter(|v| !v.is_null())
            .cloned())
    }

    /// `writeDrainLeaseHolder(sourceId, lockToken, data, ttlMinutes)`: in one write, deletes every
    /// `sync` holder record of the source (a former holder's) and inserts the new one: active, with
    /// application authority, one attempt, `max_stalled` 0, the lease token, `lock_until` the TTL
    /// ahead, started now, and removed on completion or failure. Returns the new row's id.
    pub fn write_drain_lease_holder(
        &self,
        source_id: &str,
        lock_token: &str,
        data: Value,
        ttl_minutes: f64,
    ) -> Result<i64> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let gone: Vec<JobRecord> = all_rows(tx)?
                .into_iter()
                .filter(|r| {
                    r.queue == LEASE_BEACON_QUEUE
                        && r.name == "sync"
                        && r.data.get("sourceId").and_then(jsonb_field_text).as_deref()
                            == Some(source_id)
                })
                .collect();
            for row in &gone {
                delete_row(tx, row)?;
            }
            let id = next_seq(tx, "job")?;
            let row = JobRecord {
                id,
                name: "sync".into(),
                queue: LEASE_BEACON_QUEUE.into(),
                status: "active".into(),
                priority: 0,
                submission_authority: Some(json!({ "version": 1, "kind": "application" })),
                claim_generation: 0,
                data: data.clone(),
                max_attempts: 1,
                attempts_made: 0,
                attempts_started: 0,
                backoff_type: "exponential".into(),
                backoff_delay: 1000,
                backoff_jitter: 0.2,
                stalled_counter: 0,
                max_stalled: 0,
                lock_token: Some(lock_token.to_owned()),
                lock_until: Some(lease_until(now, ttl_minutes)),
                delay_until: None,
                parent_job_id: None,
                on_child_fail: "fail_parent".into(),
                tokens_input: 0,
                tokens_output: 0,
                tokens_cache_read: 0,
                result: None,
                progress: None,
                error_text: None,
                stacktrace: Some(json!([])),
                depth: 0,
                max_children: None,
                timeout_ms: None,
                lock_duration_ms: None,
                timeout_at: None,
                remove_on_complete: true,
                remove_on_fail: true,
                idempotency_key: None,
                private_queue_owner_job_id: None,
                private_queue_owner_token: None,
                private_queue_lease_until: None,
                created_at: now,
                started_at: Some(now),
                finished_at: None,
                updated_at: now,
                quiet_hours: None,
                stagger_key: None,
                budget_remaining_cents: None,
                budget_owner_job_id: None,
                budget_root_owner_id: None,
                spend_authorization: None,
                spend_claim_token: None,
            };
            save(tx, None, &row)?;
            Ok(id)
        })
    }

    /// `refreshDrainLeaseHolder(lockToken, ttlMinutes)`: moves `lock_until` of the lease's holder
    /// records the TTL ahead and stamps `updated_at`. Returns how many records it renewed.
    pub fn refresh_drain_lease_holder(&self, lock_token: &str, ttl_minutes: f64) -> Result<u32> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let rows = holder_rows(tx, lock_token)?;
            for old in &rows {
                let mut new = old.clone();
                new.lock_until = Some(lease_until(now, ttl_minutes));
                new.updated_at = now;
                save(tx, Some(old), &new)?;
            }
            Ok(rows.len() as u32)
        })
    }

    /// `releaseDrainLeaseHolder(lockToken)`: deletes the lease's holder records. Returns how many.
    pub fn release_drain_lease_holder(&self, lock_token: &str) -> Result<u32> {
        self.write(|tx| {
            let rows = holder_rows(tx, lock_token)?;
            for row in &rows {
                delete_row(tx, row)?;
            }
            Ok(rows.len() as u32)
        })
    }
}
