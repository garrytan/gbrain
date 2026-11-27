//! Jobs: the status reads. Counts and last-run reads over `minion_jobs` (and the page text the facts
//! drain queue points at) for `gbrain status`, `gbrain jobs stats`, the facts drain backlog, the
//! source health report and the sync status report: `src/core/engine-sql/jobs-status.ts`.
//!
//! Every read takes one snapshot of the rows and one reading of the clock, as one Postgres statement
//! reads one `now()`. A time window is in seconds, as TypeScript passes it: `now() - (secs *
//! interval '1 second')`, which is `round(secs * 1e6)` µs. Orders the SQL leaves open carry the
//! tiebreaker named at each member (the statements carry the same one).

use super::*;
use crate::pages::read_page;

/// `countJobsByStatus` filter: a name, a queue and a set of statuses. An absent field matches
/// everything; an empty status list matches nothing (`status = ANY('{}')`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusFilter {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub queue: Option<String>,
    #[serde(default)]
    pub statuses: Option<Vec<String>>,
}

/// `now() - (secs * interval '1 second')`, in µs. The interval keeps whole microseconds.
fn window_cutoff(now: i64, what: &str, secs: f64) -> Result<i64> {
    if !secs.is_finite() {
        return Err(StoreError::invalid(format!(
            "{what}: window {secs} is not a finite number of seconds"
        )));
    }
    Ok(now - (secs * 1_000_000.0).round() as i64)
}

/// A µs span in whole seconds as `::int` rounds a numeric: half away from zero.
fn round_seconds(micros: i64) -> i64 {
    if micros >= 0 {
        (micros + 500_000) / 1_000_000
    } else {
        -((-micros + 500_000) / 1_000_000)
    }
}

/// One token of a LIKE pattern.
pub(super) enum Like {
    /// `%`: any run of characters, empty included.
    Any,
    /// `_`: exactly one character.
    One,
    Char(char),
}

/// A LIKE pattern as Postgres reads it with its default escape: `\` makes the next character
/// literal, and a pattern that ends in a lone `\` is an error.
pub(super) fn like_tokens(pattern: &str) -> Result<Vec<Like>> {
    let mut out = Vec::new();
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        out.push(match c {
            '%' => Like::Any,
            '_' => Like::One,
            '\\' => match chars.next() {
                Some(next) => Like::Char(next),
                None => {
                    return Err(StoreError::invalid(
                        "LIKE pattern must not end with escape character",
                    ));
                }
            },
            other => Like::Char(other),
        });
    }
    Ok(out)
}

/// `text LIKE pattern`, case sensitive, anchored at both ends, matching by character.
pub(super) fn like_matches(text: &str, pattern: &[Like]) -> bool {
    let text: Vec<char> = text.chars().collect();
    let (mut t, mut p) = (0, 0);
    // Where the last `%` was seen in the pattern, and the text position it has consumed up to.
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        match pattern.get(p) {
            Some(Like::Any) => {
                star = Some((p, t));
                p += 1;
            }
            Some(Like::One) => {
                t += 1;
                p += 1;
            }
            Some(Like::Char(c)) if *c == text[t] => {
                t += 1;
                p += 1;
            }
            _ => match star {
                Some((sp, st)) => {
                    star = Some((sp, st + 1));
                    p = sp + 1;
                    t = st + 1;
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|tok| matches!(tok, Like::Any))
}

fn cycle_row(row: &JobRecord) -> Value {
    json!({
        "finished_at": row.finished_at.map(iso),
        "name": row.name,
        "status": row.status,
        "started_at": row.started_at.map(iso),
        "result": row.result.as_ref().map(ordered),
    })
}

impl Store {
    /// `readLastAutopilotCycles`: `{ full, targeted }`, each the newest completed row (`autopilot-cycle`;
    /// `autopilot-%`) in `finished_at DESC NULLS LAST, id DESC` order, or null.
    pub fn read_last_autopilot_cycles(&self) -> Result<Value> {
        let read = self.read()?;
        let completed = rows_with_status(&*read, "completed")?;
        let newest = |keep: &dyn Fn(&str) -> bool| {
            // A missing `finished_at` sorts last (None is the smallest key), then the larger id.
            completed
                .iter()
                .filter(|r| keep(&r.name))
                .max_by_key(|r| (r.finished_at, r.id))
                .map(cycle_row)
        };
        Ok(json!({
            "full": newest(&|name| name == "autopilot-cycle"),
            "targeted": newest(&|name| name.starts_with("autopilot-")),
        }))
    }

    /// `countJobsByStatus`: `{ status, count }` per status with a match, in status (bytewise) order.
    pub fn count_jobs_by_status(&self, filter: &StatusFilter) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut counts: BTreeMap<String, i64> = BTreeMap::new();
        if filter.name.is_none() && filter.queue.is_none() && filter.statuses.is_none() {
            // No filter: the status index counts without loading a row.
            for status in STATUSES {
                let n = ids_under(&*read, &status_prefix(status))?.len() as i64;
                if n > 0 {
                    counts.insert(status.to_string(), n);
                }
            }
        } else {
            let statuses: BTreeSet<String> = match &filter.statuses {
                Some(list) => list.iter().cloned().collect(),
                None => STATUSES.iter().map(|s| s.to_string()).collect(),
            };
            for status in statuses {
                let n = rows_with_status(&*read, &status)?
                    .iter()
                    .filter(|r| filter.name.as_ref().is_none_or(|n| *n == r.name))
                    .filter(|r| filter.queue.as_ref().is_none_or(|q| *q == r.queue))
                    .count() as i64;
                if n > 0 {
                    counts.insert(status, n);
                }
            }
        }
        Ok(counts
            .into_iter()
            .map(|(status, count)| json!({ "status": status, "count": count }))
            .collect())
    }

    /// `readWaitingQueueDepths`: per queue with `waiting` rows its depth and the age of its oldest
    /// row in seconds (rounded), deepest first, then by queue name (bytewise).
    pub fn read_waiting_queue_depths(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut queues: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for row in rows_with_status(&*read, "waiting")? {
            let entry = queues.entry(row.queue).or_insert((0, row.created_at));
            entry.0 += 1;
            entry.1 = entry.1.min(row.created_at);
        }
        let mut rows: Vec<(String, i64, i64)> = queues
            .into_iter()
            .map(|(queue, (depth, oldest))| (queue, depth, round_seconds(now - oldest)))
            .collect();
        rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(rows
            .into_iter()
            .map(|(queue, depth, age)| {
                json!({ "queue": queue, "depth": depth, "oldest_waiting_age_seconds": age })
            })
            .collect())
    }

    /// `listRecentSourceCycleFailures`: dead or failed `autopilot-cycle` rows that finished after `cutoff` (ISO),
    /// grouped by `data->>'source_id'` (jsonb text, spaced as Postgres spaces it, for a value that is not a string; null or
    /// absent is skipped; one row at a time is read and folded into its source, nothing else is kept): the count
    /// and the last `finished_at` as ISO text, by source id (bytewise). A row whose `result->>'job_outcome'` is
    /// `phase_failed` does not count; `source_id` narrows to one source.
    pub fn list_recent_source_cycle_failures(
        &self,
        cutoff: &str,
        source_id: Option<&str>,
    ) -> Result<Vec<Value>> {
        let cutoff = crate::env::parse_iso(cutoff).ok_or_else(|| {
            StoreError::invalid(format!(
                "listRecentSourceCycleFailures: cutoff is not an ISO timestamp: {cutoff}"
            ))
        })?;
        let read = self.read()?;
        let mut sources: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for status in ["dead", "failed"] {
            // Each row is read, folded into its source's aggregate and dropped: only the per-source counts stay.
            for_each_row_with_status(&*read, status, &mut |row| {
                if row.name != "autopilot-cycle" {
                    return;
                }
                let outcome = row.result.as_ref().and_then(|r| r.get("job_outcome"));
                if outcome.and_then(Value::as_str) == Some("phase_failed") {
                    return;
                }
                let Some(id) = row.data.get("source_id").and_then(jsonb_field_text) else {
                    return;
                };
                if source_id.is_some_and(|want| want != id) {
                    return;
                }
                let Some(finished) = row.finished_at.filter(|f| *f > cutoff) else {
                    return;
                };
                let entry = sources.entry(id).or_insert((0, finished));
                entry.0 += 1;
                entry.1 = entry.1.max(finished);
            })?;
        }
        Ok(sources
            .into_iter()
            .map(|(id, (count, last))| json!({ "source_id": id, "fail_count": count, "last_failed_at": iso(last) }))
            .collect())
    }

    /// `readLastCompletedJobAt`: the largest `updated_at` among `completed` rows, as ISO text, or null.
    pub fn read_last_completed_job_at(&self) -> Result<Value> {
        let read = self.read()?;
        let last = rows_with_status(&*read, "completed")?
            .iter()
            .map(|r| r.updated_at)
            .max();
        Ok(json!(last.map(iso)))
    }

    /// `readLastFinishedJobAt(name)`: the latest `finished_at` of the `completed` rows named `name`,
    /// as `to_char(.. AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` (seconds, truncated), or null.
    pub fn read_last_finished_job_at(&self, name: &str) -> Result<Value> {
        let read = self.read()?;
        let last = rows_with_status(&*read, "completed")?
            .iter()
            .filter(|r| r.name == name)
            .filter_map(|r| r.finished_at)
            .max();
        Ok(json!(last.map(|at| {
            let full = iso(at);
            format!("{}Z", &full[..19])
        })))
    }

    /// `countTtlCancelledByName`: `cancelled` rows whose `error_text` matches the LIKE pattern and whose
    /// `finished_at` is after `now - within`, counted by name: most first, then by name (bytewise).
    pub fn count_ttl_cancelled_by_name(
        &self,
        reason_like: &str,
        within_seconds: f64,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let cutoff = window_cutoff(
            self.env.now_micros(),
            "countTtlCancelledByName",
            within_seconds,
        )?;
        let pattern = like_tokens(reason_like)?;
        let mut counts: BTreeMap<String, i64> = BTreeMap::new();
        for row in rows_with_status(&*read, "cancelled")? {
            let matches = row
                .error_text
                .as_deref()
                .is_some_and(|text| like_matches(text, &pattern));
            if matches && row.finished_at.is_some_and(|f| f > cutoff) {
                *counts.entry(row.name).or_insert(0) += 1;
            }
        }
        let mut rows: Vec<(String, i64)> = counts.into_iter().collect();
        rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(rows
            .into_iter()
            .map(|(name, count)| json!({ "name": name, "count": count }))
            .collect())
    }

    /// `readWaitingScopeState`: always one answer. The target is the job `job_id` when it has `name`
    /// and `queue`; its scope is `COALESCE(data->>'sourceId', data->>'source_id')`. `waiting` counts the
    /// `waiting` rows of the name and queue in the same scope (NULL equals NULL); `live_id` and `age_min`
    /// are set only when the target is `active` with `lock_until > now`: its id, and `floor` of its age
    /// in minutes (null without `started_at`). No target counts nothing.
    pub fn read_waiting_scope_state(&self, name: &str, queue: &str, job_id: i64) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let target = load(&*read, job_id)?.filter(|t| t.name == name && t.queue == queue);
        let Some(target) = target else {
            return Ok(json!({ "waiting": 0, "live_id": null, "age_min": null }));
        };
        let scope = target.scope_source();
        let waiting = rows_with_status(&*read, "waiting")?
            .iter()
            .filter(|r| r.name == name && r.queue == queue && r.scope_source() == scope)
            .count();
        let live = target.status == "active" && target.lock_until.is_some_and(|l| l > now);
        let live_id = live.then_some(target.id);
        let age_min = live
            .then(|| target.started_at.map(|s| (now - s).div_euclid(60_000_000)))
            .flatten();
        Ok(json!({ "waiting": waiting, "live_id": live_id, "age_min": age_min }))
    }

    /// `countRecentCompletedJobs`: `completed` rows of `name` with `finished_at > now - within`.
    pub fn count_recent_completed_jobs(&self, name: &str, within_seconds: f64) -> Result<i64> {
        let read = self.read()?;
        let cutoff = window_cutoff(
            self.env.now_micros(),
            "countRecentCompletedJobs",
            within_seconds,
        )?;
        Ok(rows_with_status(&*read, "completed")?
            .iter()
            .filter(|r| r.name == name && r.finished_at.is_some_and(|f| f > cutoff))
            .count() as i64)
    }

    /// `listRecentFailedJobErrors`: `{ id, last_error }` of every `dead` or `failed` row with
    /// `updated_at > now - within`, by id.
    pub fn list_recent_failed_job_errors(&self, within_seconds: f64) -> Result<Vec<Value>> {
        let read = self.read()?;
        let cutoff = window_cutoff(
            self.env.now_micros(),
            "listRecentFailedJobErrors",
            within_seconds,
        )?;
        let mut rows = rows_with_status(&*read, "dead")?;
        rows.extend(rows_with_status(&*read, "failed")?);
        rows.retain(|r| r.updated_at > cutoff);
        rows.sort_by_key(|r| r.id);
        Ok(rows
            .into_iter()
            .map(|r| json!({ "id": r.id, "last_error": r.error_text }))
            .collect())
    }

    /// `listBudgetOwners` (the rows it starts from): `{ owner_id, remaining_cents }` of the newest five rows that own
    /// their budget (`budget_owner_job_id` is the row's id, `budget_remaining_cents` set) and are not `completed`,
    /// `failed`, `dead` or `cancelled`, newest id first. The spend total needs the budget log, which this store does
    /// not keep, so the JS member refuses when any row comes back.
    pub fn list_budget_owner_jobs(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows = all_rows(&*read)?;
        rows.retain(|r| {
            r.budget_remaining_cents.is_some()
                && r.budget_owner_job_id == Some(r.id)
                && !matches!(
                    r.status.as_str(),
                    "completed" | "failed" | "dead" | "cancelled"
                )
        });
        rows.sort_by_key(|r| std::cmp::Reverse(r.id));
        Ok(rows
            .into_iter()
            .take(5)
            .map(|r| json!({ "owner_id": r.id, "remaining_cents": r.budget_remaining_cents }))
            .collect())
    }

    /// `readQueuedPageChars`: the average of `LEAST(length(compiled_truth), max_chars)` over the
    /// `waiting` and `delayed` rows of `name` and `queue`, each joined to the page named by
    /// `data.slug` in source `data.sourceId` (`default` when absent). A row with no slug or no page
    /// adds nothing; a page whose `compiled_truth` is NULL (a segmented shell) counts as `max_chars`
    /// (`LEAST` skips a NULL); a deleted page still counts (the statement never read `deleted_at`).
    /// Null when no row joins.
    pub fn read_queued_page_chars(&self, name: &str, queue: &str, max_chars: i64) -> Result<Value> {
        let read = self.read()?;
        let mut jobs = rows_with_status(&*read, "waiting")?;
        jobs.extend(rows_with_status(&*read, "delayed")?);
        let (mut total, mut n) = (0i64, 0i64);
        for job in jobs.iter().filter(|j| j.name == name && j.queue == queue) {
            let Some(slug) = job.data.get("slug").and_then(jsonb_field_text) else {
                continue;
            };
            let source = job
                .data
                .get("sourceId")
                .and_then(jsonb_field_text)
                .unwrap_or_else(|| "default".to_string());
            let Some(page) = read_page(&*read, &source, &slug)? else {
                continue;
            };
            total += match page.compiled_truth.as_deref() {
                Some(text) => (text.chars().count() as i64).min(max_chars),
                None => max_chars,
            };
            n += 1;
        }
        Ok(if n == 0 {
            Value::Null
        } else {
            json!(total as f64 / n as f64)
        })
    }

    /// `readSourceJobCounts`: per `data.sourceId` over the `sync` and `embed-backfill` rows that
    /// name one: failures (`failed`/`dead`) created after `now - within`, live depth
    /// (`waiting`/`active`/`delayed`), embed-backfill rows `active`, and embed-backfill rows
    /// `waiting`/`delayed`/`waiting-children`. By source id (bytewise).
    pub fn read_source_job_counts(&self, failed_within_seconds: f64) -> Result<Vec<Value>> {
        let read = self.read()?;
        let cutoff = window_cutoff(
            self.env.now_micros(),
            "readSourceJobCounts",
            failed_within_seconds,
        )?;
        let mut sources: BTreeMap<String, [i64; 4]> = BTreeMap::new();
        for row in all_rows(&*read)? {
            if row.name != "sync" && row.name != "embed-backfill" {
                continue;
            }
            let Some(source) = row.data.get("sourceId").and_then(jsonb_field_text) else {
                continue;
            };
            let counts = sources.entry(source).or_insert([0; 4]);
            let status = row.status.as_str();
            let backfill = row.name == "embed-backfill";
            if matches!(status, "failed" | "dead") && row.created_at > cutoff {
                counts[0] += 1;
            }
            if matches!(status, "waiting" | "active" | "delayed") {
                counts[1] += 1;
            }
            if backfill && status == "active" {
                counts[2] += 1;
            }
            if backfill && matches!(status, "waiting" | "delayed" | "waiting-children") {
                counts[3] += 1;
            }
        }
        Ok(sources
            .into_iter()
            .map(|(source_id, c)| {
                json!({
                    "source_id": source_id, "failed_24h": c[0], "queue_depth": c[1],
                    "backfill_active": c[2], "backfill_queued": c[3],
                })
            })
            .collect())
    }

    /// `readEmbedBackfillBySource`: per requested source with an `embed-backfill` row: rows
    /// `waiting`/`delayed`/`waiting-children`, rows `active`, and the largest `finished_at` of a
    /// `completed` row (null when none). By source id (bytewise).
    pub fn read_embed_backfill_by_source(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let wanted: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let mut sources: BTreeMap<String, (i64, i64, Option<i64>)> = BTreeMap::new();
        for row in all_rows(&*read)? {
            if row.name != "embed-backfill" {
                continue;
            }
            let Some(source) = row.data.get("sourceId").and_then(jsonb_field_text) else {
                continue;
            };
            if !wanted.contains(source.as_str()) {
                continue;
            }
            let entry = sources.entry(source).or_insert((0, 0, None));
            match row.status.as_str() {
                "waiting" | "delayed" | "waiting-children" => entry.0 += 1,
                "active" => entry.1 += 1,
                "completed" => entry.2 = entry.2.max(row.finished_at),
                _ => {}
            }
        }
        Ok(sources
            .into_iter()
            .map(|(source_id, (queued, active, last))| {
                json!({
                    "source_id": source_id, "queued": queued, "active": active,
                    "last_completed_at": last.map(iso),
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn like(text: &str, pattern: &str) -> bool {
        like_matches(text, &like_tokens(pattern).unwrap())
    }

    #[test]
    fn like_follows_postgres() {
        assert!(like("waiting_ttl_expired: 72h", "waiting_ttl_expired%"));
        assert!(like("waitingXttlXexpired", "waiting_ttl_expired%"));
        assert!(!like("waitingXttlXexpired", "waiting\\_ttl\\_expired%"));
        assert!(like("waiting_ttl_expired", "waiting\\_ttl\\_expired%"));
        assert!(!like("WAITING_TTL_EXPIRED", "waiting_ttl_expired%"));
        assert!(!like("a waiting_ttl_expired", "waiting_ttl_expired%"));
        assert!(like("", "%"));
        assert!(!like("", "_"));
        assert!(like("ab", "%b"));
        assert!(like("abab", "%ab"));
        assert!(!like("abac", "%ab"));
        assert!(like("é", "_"));
        assert!(like("a%b", "a\\%b"));
        assert!(!like("axb", "a\\%b"));
        assert!(like("x", "%x%%"));
        assert!(like_tokens("abc\\").is_err());
    }

    #[test]
    fn whole_seconds_round_half_away_from_zero() {
        assert_eq!(round_seconds(499_999), 0);
        assert_eq!(round_seconds(500_000), 1);
        assert_eq!(round_seconds(1_499_999), 1);
        assert_eq!(round_seconds(1_500_000), 2);
        assert_eq!(round_seconds(-500_000), -1);
        assert_eq!(round_seconds(-499_999), 0);
    }
}
