//! Jobs: the reads behind `describeJobs` (`src/core/minions/job-insight.ts`), as one member,
//! `readJobInsight` (engine-sql/jobs-insight.ts): who submitted each job, how many waiting jobs are
//! ahead of it, which active jobs hold the slots of its queue, which live children a parent waits
//! for, which live lease a waiting job is blocked by, whether the caller owns each of them, and the
//! tokens of completed descendants the caller does not own. The spend tree (`mcp_spend_reservations`) is not here: it is the separate member
//! `readJobSpendTree` (`spend.rs`).

use super::reads::{JobOwner, owned_by, owned_or_unfenced};
use super::*;

/// `readJobInsight` arguments. Each list switches its part off when empty (`owner` when `None`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsightSpec {
    /// Every described job.
    #[serde(default)]
    pub job_ids: Vec<i64>,
    /// The `waiting` jobs among them: their queue position is counted.
    #[serde(default)]
    pub waiting_ids: Vec<i64>,
    /// The queues of the waiting jobs: their active holders are listed.
    #[serde(default)]
    pub waiting_queues: Vec<String>,
    /// The `waiting-children` jobs among them: their unfinished children are listed.
    #[serde(default)]
    pub parent_ids: Vec<i64>,
    /// The cycle lock ids a waiting or delayed job would take.
    #[serde(default)]
    pub lock_ids: Vec<String>,
    /// The drain-lease queue: never a slot holder, and where a lease's beacon row lives.
    pub holder_queue: String,
    /// At most this many active holders, across the waiting queues.
    pub holder_limit: i64,
    /// GST-4010: the owner-fenced caller (`owned_by`): each row reads back whether it owns it, and foreign
    /// tokens are summed only when set. `None` is unfenced: every row reads as owned.
    #[serde(default)]
    pub owner: Option<JobOwner>,
}

impl Store {
    /// `readJobInsight(spec)`: `{ meta, ahead, holders, children, locks, foreign_tokens }`, each part
    /// in the order of its SQL (`ORDER BY`), the one read transaction of the call.
    pub fn read_job_insight(&self, spec: &InsightSpec) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let ids = |list: &[i64]| list.iter().copied().collect::<BTreeSet<i64>>();

        // meta: `j LEFT JOIN minion_jobs p ON p.id = j.parent_job_id`.
        let mut meta = Vec::new();
        for id in ids(&spec.job_ids) {
            let Some(row) = load(&*read, id)? else {
                continue;
            };
            let application = row
                .submission_authority
                .as_ref()
                .and_then(|a| a.get("kind"))
                .and_then(jsonb_field_text)
                .is_some_and(|k| k == "application");
            let submitter = if application {
                row.data.get("__submitter").and_then(jsonb_field_text)
            } else {
                None
            };
            // A job with no parent (the `LEFT JOIN` finds none) is owned when unfenced and never owned when fenced.
            let parent_owned = match row.parent_job_id {
                Some(p) => match load(&*read, p)? {
                    Some(p) => owned_or_unfenced(&p, spec.owner.as_ref()),
                    None => spec.owner.is_none(),
                },
                None => spec.owner.is_none(),
            };
            let owned = owned_or_unfenced(&row, spec.owner.as_ref());
            meta.push(json!({
                "id": id, "submitter": submitter, "owned": owned, "parent_owned": parent_owned,
            }));
        }

        let mut ahead = Vec::new();
        let mut holders = Vec::new();
        if !spec.waiting_ids.is_empty() {
            // The count of `waiting` rows of the queue before the job in (priority, created_at, id):
            // the claim index holds exactly those rows, keyed in that order.
            for id in ids(&spec.waiting_ids) {
                let Some(row) = load(&*read, id)? else {
                    continue;
                };
                let (key, mut n) = (claim_key(&row), 0_i64);
                scan_prefix(&*read, &claim_prefix(&row.queue), false, &mut |k, _| {
                    if k < key.as_slice() {
                        n += 1;
                        true
                    } else {
                        false
                    }
                })?;
                ahead.push(json!({ "id": id, "ahead": n }));
            }
            let mut active: Vec<JobRecord> = rows_with_status(&*read, "active")?
                .into_iter()
                .filter(|r| spec.waiting_queues.contains(&r.queue) && r.queue != spec.holder_queue)
                .collect();
            // `ORDER BY started_at ASC NULLS LAST, id ASC LIMIT n`.
            active.sort_by_key(|r| (r.started_at.is_none(), r.started_at, r.id));
            active.truncate(spec.holder_limit.max(0) as usize);
            holders = active
                .iter()
                .map(|r| {
                    json!({
                        "id": r.id, "name": r.name, "queue": r.queue,
                        "owned": owned_or_unfenced(r, spec.owner.as_ref()),
                    })
                })
                .collect();
        }

        // children: not finished, by id.
        let mut children = Vec::new();
        for parent in ids(&spec.parent_ids) {
            for id in ids_under(&*read, &child_prefix(parent))? {
                if let Some(row) = load(&*read, id)?.filter(|r| !is_terminal(&r.status)) {
                    children.push((id, parent, owned_or_unfenced(&row, spec.owner.as_ref())));
                }
            }
        }
        children.sort_by_key(|c| c.0);
        let children: Vec<Value> = children
            .into_iter()
            .map(|(id, parent, owned)| json!({ "id": id, "parent_job_id": parent, "owned": owned }))
            .collect();

        let locks = self.insight_locks(&*read, spec, now)?;

        // The tokens of completed descendants the caller does not own, per described job: the walk follows the
        // completed children the caller owns (to depth 20), and every completed child of a node it reached that
        // the caller does not own is summed.
        let mut foreign = Vec::new();
        if let Some(owner) = &spec.owner {
            for root in ids(&spec.job_ids) {
                if load(&*read, root)?.is_none() {
                    continue;
                }
                let (mut seen, mut i, mut o, mut c) = (false, 0_i64, 0_i64, 0_i64);
                let mut level = vec![root];
                for depth in 0..=20 {
                    let mut next = Vec::new();
                    for node in &level {
                        for id in ids_under(&*read, &child_prefix(*node))? {
                            let Some(row) = load(&*read, id)? else {
                                continue;
                            };
                            if row.status != "completed" {
                                continue;
                            }
                            if owned_or_unfenced(&row, Some(owner)) {
                                next.push(id);
                            } else {
                                seen = true;
                                i += i64::from(row.tokens_input);
                                o += i64::from(row.tokens_output);
                                c += i64::from(row.tokens_cache_read);
                            }
                        }
                    }
                    // The walk reaches depth 20 at most: the children of a node there are still summed.
                    if depth == 20 || next.is_empty() {
                        break;
                    }
                    level = next;
                }
                if seen {
                    foreign.push(json!({ "parent_job_id": root, "i": i, "o": o, "c": c }));
                }
            }
        }

        Ok(json!({
            "meta": meta, "ahead": ahead, "holders": holders, "children": children,
            "locks": locks, "foreign_tokens": foreign,
        }))
    }

    /// The unexpired leases among `spec.lock_ids`, one row per beacon row claimed under the lease's
    /// token (one row with no beacon when there is none), by lock id then beacon id; each with the
    /// beacon record and whether the caller owns the job it names.
    fn insight_locks(&self, read: &dyn KvRead, spec: &InsightSpec, now: i64) -> Result<Vec<Value>> {
        let mut live = Vec::new();
        for id in spec.lock_ids.iter().collect::<BTreeSet<_>>() {
            if let Some(l) =
                get_json::<LockRecord>(read, &lock_key(id))?.filter(|l| l.ttl_expires_at > now)
            {
                live.push((id.clone(), l));
            }
        }
        if live.is_empty() {
            return Ok(Vec::new());
        }
        let mut beacons: Vec<JobRecord> = all_rows(read)?
            .into_iter()
            .filter(|r| r.queue == spec.holder_queue && r.lock_token.is_some())
            .collect();
        beacons.sort_by_key(|r| r.id);
        let mut out = Vec::new();
        for (id, l) in live {
            let mine: Vec<Option<&JobRecord>> = {
                let m: Vec<_> = beacons
                    .iter()
                    .filter(|b| b.lock_token.as_deref() == Some(l.acquisition_token.as_str()))
                    .map(Some)
                    .collect();
                if m.is_empty() { vec![None] } else { m }
            };
            for b in mine {
                let beacon = b.and_then(|b| b.data.get("drain_lease_beacon")).cloned();
                // `h.id::text = beacon->>'id'`, when the beacon's kind is `job`: whether the caller owns that job
                // (always, unfenced; never when no job is named, fenced).
                let holder: Option<JobRecord> = match &beacon {
                    Some(v)
                        if v.get("kind").and_then(jsonb_field_text).as_deref() == Some("job") =>
                    {
                        match v.get("id").and_then(jsonb_field_text) {
                            Some(text) => match text.parse::<i64>() {
                                Ok(n) if n.to_string() == text => load(read, n)?,
                                _ => None,
                            },
                            None => None,
                        }
                    }
                    _ => None,
                };
                let holder_owned = spec
                    .owner
                    .as_ref()
                    .is_none_or(|o| holder.as_ref().is_some_and(|h| owned_by(h, o)));
                out.push(json!({
                    "id": id, "holder_pid": l.holder_pid, "holder_host": l.holder_host,
                    "acquired_at": iso(l.acquired_at), "ttl_expires_at": iso(l.ttl_expires_at),
                    "beacon": beacon, "holder_owned": holder_owned,
                }));
            }
        }
        Ok(out)
    }
}
