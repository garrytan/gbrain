//! Jobs slice 2: the private-queue reads and the lease renewal (`queue.ts` `reconcilePrivateQueue`,
//! `renewPrivateQueueLease`, `listOwnedPrivateQueues`, `classifyPrivateQueueForRecovery`).

use super::reads::live_rows;
use super::*;

/// `classifyPrivateQueueForRecovery`'s one aggregate row, over the live rows of the queue.
#[derive(Debug, Clone, Serialize)]
pub struct PrivateQueueState {
    pub active_healthy: usize,
    /// Distinct owner job ids, ascending.
    pub owner_ids: Vec<i64>,
    pub metadata_rows: usize,
    pub live_owner_rows: usize,
    pub nonterminal_owner_rows: usize,
    pub max_lease_until: Option<String>,
    pub future_lease_rows: usize,
    pub recently_touched: usize,
}

/// `updated_at > now() - interval '120 seconds'`.
const RECENT_US: i64 = 120_000_000;

impl Store {
    /// The live rows of one queue, by id (`reconcilePrivateQueue`'s scan).
    pub fn list_open_job_ids_in_queue(&self, queue: &str) -> Result<Vec<i64>> {
        let read = self.read()?;
        Ok(live_rows(&*read)?
            .into_iter()
            .filter(|r| r.queue == queue)
            .map(|r| r.id)
            .collect())
    }

    /// `renewPrivateQueueLease`: the live rows of `queue` under `owner_token` get their lease
    /// pushed to `now + lease_ms` (never shortened). Returns how many.
    pub fn renew_private_queue_lease(
        &self,
        queue: &str,
        owner_token: &str,
        lease_ms: f64,
    ) -> Result<usize> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let until = now + ms_to_us(lease_ms);
            let mut renewed = 0;
            for old in live_rows(tx)? {
                if old.queue != queue
                    || old.private_queue_owner_token.as_deref() != Some(owner_token)
                {
                    continue;
                }
                let mut new = old.clone();
                new.private_queue_lease_until =
                    Some(old.private_queue_lease_until.unwrap_or(0).max(until));
                new.updated_at = now;
                save(tx, Some(&old), &new)?;
                renewed += 1;
            }
            Ok(renewed)
        })
    }

    /// The `startup recovery` scan: queues starting with `prefix` that have live rows, at least
    /// one carrying owner metadata (an owner id or a lease), oldest first (`min(created_at)`, then
    /// name), at most `max_queues`.
    pub fn list_owned_private_queues(&self, prefix: &str, max_queues: i64) -> Result<Vec<String>> {
        let read = self.read()?;
        // queue -> (min created_at, has metadata)
        let mut queues: BTreeMap<String, (i64, bool)> = BTreeMap::new();
        for r in live_rows(&*read)? {
            if !r.queue.starts_with(prefix) {
                continue;
            }
            let meta =
                r.private_queue_owner_job_id.is_some() || r.private_queue_lease_until.is_some();
            let e = queues.entry(r.queue).or_insert((i64::MAX, false));
            e.0 = e.0.min(r.created_at);
            e.1 |= meta;
        }
        let mut ordered: Vec<(i64, String)> = queues
            .into_iter()
            .filter(|(_, (_, meta))| *meta)
            .map(|(q, (created, _))| (created, q))
            .collect();
        ordered.sort();
        Ok(ordered
            .into_iter()
            .take(max_queues.max(0) as usize)
            .map(|(_, q)| q)
            .collect())
    }

    /// `classifyPrivateQueueForRecovery`'s query. An owner id with no row counts in neither owner
    /// count (the `LEFT JOIN`).
    pub fn read_private_queue_state(&self, queue: &str) -> Result<PrivateQueueState> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let rows: Vec<JobRecord> = live_rows(&*read)?
            .into_iter()
            .filter(|r| r.queue == queue)
            .collect();
        let owner_ids: BTreeSet<i64> = rows
            .iter()
            .filter_map(|r| r.private_queue_owner_job_id)
            .collect();
        let (mut live_owner_rows, mut nonterminal_owner_rows) = (0, 0);
        for id in &owner_ids {
            if let Some(o) = load(&*read, *id)? {
                if o.status == "active" && o.lock_until.is_some_and(|l| l > now) {
                    live_owner_rows += 1;
                }
                if NON_TERMINAL.contains(&o.status.as_str()) {
                    nonterminal_owner_rows += 1;
                }
            }
        }
        Ok(PrivateQueueState {
            active_healthy: rows
                .iter()
                .filter(|r| r.status == "active" && r.lock_until.is_some_and(|l| l > now))
                .count(),
            owner_ids: owner_ids.into_iter().collect(),
            metadata_rows: rows
                .iter()
                .filter(|r| {
                    r.private_queue_owner_job_id.is_some() || r.private_queue_lease_until.is_some()
                })
                .count(),
            live_owner_rows,
            nonterminal_owner_rows,
            max_lease_until: rows
                .iter()
                .filter_map(|r| r.private_queue_lease_until)
                .max()
                .map(crate::env::iso),
            future_lease_rows: rows
                .iter()
                .filter(|r| r.private_queue_lease_until.is_some_and(|l| l > now))
                .count(),
            recently_touched: rows
                .iter()
                .filter(|r| r.updated_at > now - RECENT_US)
                .count(),
        })
    }
}
