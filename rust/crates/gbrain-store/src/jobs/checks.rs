//! The queue reads the doctor checks and the dream breaker make: stalled embed-backfill sources,
//! how the brain-wide maintenance job and its dream children died, facts-absorb jobs that are still
//! dead, who holds legacy submission authority, what queued paid jobs spend under, build-skew
//! stacktrace lines, dead dream submissions per key, and the dead-write retry's facts-absorb rows
//! (rust/docs/store/jobs-checks.md). Each matches `src/core/engine-sql/jobs-checks.ts`.

use super::reads::{hours_us, is_unreviewed, live_rows};
use super::status::{Like, like_matches, like_tokens};
use super::*;
use crate::env::parse_iso;
use crate::timeline_queries::timestamptz_text;
use std::cmp::Reverse;

/// `readGlobalMaintenanceDeaths` arguments.
#[derive(Debug, Clone, Deserialize)]
pub struct DeathsSpec {
    pub deaths: i64,
}

/// `listFactsAbsorbJobsStillDead` arguments.
#[derive(Debug, Clone, Deserialize)]
pub struct StillDeadSpec {
    pub hours: f64,
    pub limit: i64,
}

/// `readQueuedSpendRows` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedSpendSpec {
    pub legacy_prefixes: BTreeMap<String, Vec<String>>,
    pub wait_ms: f64,
}

/// `listBuildSkewStacktraceLines` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSkewSpec {
    pub prefix: String,
    pub window_hours: f64,
    pub scan_jobs: i64,
}

/// `countDeadDreamSubmissionRows` arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadDreamSpec {
    /// `[synthesize prefix, patterns prefix]`.
    pub key_prefixes: [String; 2],
    pub patterns_source_prefix: String,
    pub synth_file_prefix: String,
    /// `{ base key: ISO time }`.
    #[serde(default)]
    pub resets: BTreeMap<String, Value>,
    pub window_hours: f64,
}

/// `listFactsAbsorbJobsByKeyPrefix` arguments.
#[derive(Debug, Clone, Deserialize)]
pub struct KeyPrefixSpec {
    pub prefix: String,
    #[serde(default)]
    pub keys: Vec<String>,
}

/// `jsonb ? 'key'`: an object has the key, an array holds the string, a string scalar is it.
fn jsonb_has(value: &Value, key: &str) -> bool {
    match value {
        Value::Object(m) => m.contains_key(key),
        Value::Array(items) => items.iter().any(|i| i.as_str() == Some(key)),
        Value::String(s) => s == key,
        _ => false,
    }
}

/// The key a subagent child is judged by: its idempotency key, else the one a release stashed.
fn child_key(row: &JobRecord) -> Option<String> {
    row.idempotency_key.clone().or_else(|| {
        row.data
            .get("__released_idempotency_key")
            .and_then(jsonb_field_text)
    })
}

/// `finished_at DESC NULLS LAST, id DESC`.
fn newest_first(a: &JobRecord) -> (bool, Reverse<i64>, Reverse<i64>) {
    (
        a.finished_at.is_none(),
        Reverse(a.finished_at.unwrap_or(0)),
        Reverse(a.id),
    )
}

/// `bool_and(status = 'dead' AND error_text ~ 'timeout exceeded')` kept when it is true: a row that
/// is not dead is false; a dead row with no error text is NULL, which `bool_and` skips; a group of
/// only NULLs is NULL. The pattern is a case-sensitive substring.
fn all_timed_out<'a>(rows: impl Iterator<Item = (&'a str, Option<&'a str>)>) -> bool {
    let (mut any_true, mut any_false) = (false, false);
    for (status, error) in rows {
        match (status == "dead", error) {
            (false, _) => any_false = true,
            (true, None) => {}
            (true, Some(text)) if text.contains("timeout exceeded") => any_true = true,
            (true, Some(_)) => any_false = true,
        }
    }
    any_true && !any_false
}

fn terminal_rows(read: &dyn KvRead) -> Result<Vec<JobRecord>> {
    let mut rows = Vec::new();
    for status in TERMINAL {
        rows.extend(rows_with_status(read, status)?);
    }
    Ok(rows)
}

/// `regexp_replace(key, ':c[0-9]+of[0-9]+$', '')`: drops a trailing `:c<n>of<m>` chunk suffix.
fn strip_chunk_suffix(key: &str) -> &str {
    let Some(at) = key.rfind(':') else {
        return key;
    };
    let tail = &key[at + 1..];
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    match tail.strip_prefix('c').and_then(|t| t.split_once("of")) {
        Some((a, b)) if digits(a) && digits(b) => &key[..at],
        _ => key,
    }
}

/// The transcript name of a `...:filename:<name>:<hash>` key.
fn filename_of(key: &str) -> Option<&str> {
    let mut parts = key.rsplitn(4, ':');
    let (_hash, name, tag, _rest) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    (tag == "filename").then_some(name)
}

fn facts_absorb_json(row: &JobRecord) -> Value {
    json!({
        "id": row.id,
        "idempotency_key": row.idempotency_key.clone(),
        "status": row.status,
        "error_text": row.error_text,
        "slug": row.data.get("slug").and_then(jsonb_field_text),
        "source_id": source_of(row, "sourceId"),
        "finished_at": row.finished_at.map(iso),
    })
}

/// `COALESCE(data->>'<field>', 'default')`.
fn source_of(row: &JobRecord, field: &str) -> String {
    row.data
        .get(field)
        .and_then(jsonb_field_text)
        .unwrap_or_else(|| "default".into())
}

impl Store {
    /// `listStalledEmbedBackfillSources`: the distinct `sourceId` of failed or dead `embed-backfill`
    /// rows whose progress has a `stall` key, bytewise with a missing source last.
    pub fn list_stalled_embed_backfill_sources(&self) -> Result<Vec<Option<String>>> {
        let read = self.read()?;
        let mut sources = BTreeSet::new();
        for status in ["failed", "dead"] {
            for row in rows_with_status(&*read, status)? {
                if row.name == "embed-backfill"
                    && row.progress.as_ref().is_some_and(|p| jsonb_has(p, "stall"))
                {
                    sources.insert(row.data.get("sourceId").and_then(jsonb_field_text));
                }
            }
        }
        // `None` sorts first in an `Option`; the SQL puts NULL last.
        let mut named: Vec<Option<String>> = sources.iter().flatten().cloned().map(Some).collect();
        if sources.contains(&None) {
            named.push(None);
        }
        Ok(named)
    }

    /// `readGlobalMaintenanceDeaths`: the last `deaths` finished maintenance jobs, and the dream
    /// phases whose last `deaths` finished children all died at their subagent timeout.
    pub fn read_global_maintenance_deaths(&self, spec: &DeathsSpec) -> Result<Value> {
        let read = self.read()?;
        let want = spec.deaths.max(0) as usize;
        let rows = terminal_rows(&*read)?;
        let mut recent: Vec<&JobRecord> = rows
            .iter()
            .filter(|r| r.name == "autopilot-global-maintenance")
            .collect();
        recent.sort_by_key(|r| newest_first(r));
        let recent: Vec<Value> = recent
            .into_iter()
            .take(want)
            .map(|r| json!({ "id": r.id, "status": r.status, "error_text": r.error_text }))
            .collect();

        let mut phases: BTreeMap<&str, Vec<&JobRecord>> = BTreeMap::new();
        for row in rows.iter().filter(|r| r.name == "subagent") {
            let Some(key) = child_key(row) else {
                continue;
            };
            if key.starts_with("dream:patterns:") {
                phases.entry("patterns").or_default().push(row);
            } else if key.starts_with("dream:synth") {
                phases.entry("synthesize").or_default().push(row);
            }
        }
        let mut child_timeouts = Vec::new();
        for (phase, mut group) in phases {
            group.sort_by_key(|r| newest_first(r));
            group.truncate(want);
            if group.len() != want {
                continue;
            }
            if !all_timed_out(
                group
                    .iter()
                    .map(|r| (r.status.as_str(), r.error_text.as_deref())),
            ) {
                continue;
            }
            let last = group.iter().filter_map(|r| r.finished_at).max();
            child_timeouts.push(json!({
                "phase": phase,
                "deaths": group.len(),
                "last_at": last.map(timestamptz_text),
            }));
        }
        Ok(json!({ "recent": recent, "child_timeouts": child_timeouts }))
    }

    /// `readLastFailedGlobalMaintenanceJob`: the newest maintenance job that ended failed, dead or
    /// cancelled after `since`, with how many did and the earliest of their finish times.
    pub fn read_last_failed_global_maintenance_job(
        &self,
        since: Option<&str>,
    ) -> Result<Option<Value>> {
        let cut = match since {
            None => None,
            Some(text) => Some(parse_iso(text).ok_or_else(|| {
                StoreError::invalid(format!(
                    "readLastFailedGlobalMaintenanceJob: since is not an ISO timestamp: {text}"
                ))
            })?),
        };
        let read = self.read()?;
        let mut rows = Vec::new();
        for status in ["failed", "dead", "cancelled"] {
            rows.extend(rows_with_status(&*read, status)?);
        }
        rows.retain(|r| {
            r.name == "autopilot-global-maintenance"
                && cut.is_none_or(|c| r.finished_at.is_some_and(|f| f > c))
        });
        rows.sort_by_key(newest_first);
        let earliest = rows.iter().filter_map(|r| r.finished_at).min();
        Ok(rows.first().map(|r| {
            json!({
                "id": r.id, "status": r.status, "error_text": r.error_text,
                "total": rows.len(), "since": earliest.map(timestamptz_text),
            })
        }))
    }

    /// `listFactsAbsorbJobsStillDead`: dead or failed `facts-absorb` jobs inside the window that no
    /// later completed job for the same page and source superseded, newest `limit` and the count.
    pub fn list_facts_absorb_jobs_still_dead(&self, spec: &StillDeadSpec) -> Result<Value> {
        let read = self.read()?;
        let cutoff = self.env.now_micros() - hours_us(spec.hours);
        let mut done: HashMap<(String, String), i64> = HashMap::new();
        for row in rows_with_status(&*read, "completed")? {
            if row.name != "facts-absorb" {
                continue;
            }
            if let Some(slug) = row.data.get("slug").and_then(jsonb_field_text) {
                let best = done.entry((slug, source_of(&row, "sourceId"))).or_insert(0);
                *best = (*best).max(row.id);
            }
        }
        let mut rows = Vec::new();
        for status in ["dead", "failed"] {
            rows.extend(rows_with_status(&*read, status)?);
        }
        rows.retain(|r| {
            r.name == "facts-absorb"
                && r.finished_at.unwrap_or(r.updated_at) >= cutoff
                && !r
                    .data
                    .get("slug")
                    .and_then(jsonb_field_text)
                    .is_some_and(|slug| {
                        done.get(&(slug, source_of(r, "sourceId")))
                            .is_some_and(|k| *k > r.id)
                    })
        });
        rows.sort_by_key(|r| Reverse(r.id));
        let jobs: Vec<Value> = rows
            .iter()
            .take(spec.limit.max(0) as usize)
            .map(|r| {
                json!({
                    "id": r.id,
                    "slug": r.data.get("slug").and_then(jsonb_field_text),
                    "source_id": source_of(r, "sourceId"),
                    "status": r.status,
                })
            })
            .collect();
        // The SQL counts in a window over the rows it returns: no rows, no total.
        let total = if jobs.is_empty() { 0 } else { rows.len() };
        Ok(json!({ "total": total, "jobs": jobs }))
    }

    /// `readLegacyJobAuthority`: the live jobs whose authority is not the application authority,
    /// the first ten active ids, and the finished keyed jobs with no authority, by status.
    pub fn read_legacy_job_authority(&self) -> Result<Value> {
        let read = self.read()?;
        let live: Vec<Value> = live_rows(&*read)?
            .into_iter()
            .filter(|r| is_unreviewed(&r.submission_authority))
            .map(|r| {
                json!({
                    "id": r.id,
                    "status": r.status,
                    "submission_authority": r.submission_authority.as_ref().map(jsonb),
                    "legacy_authority_is_null": r.submission_authority.is_none(),
                })
            })
            .collect();
        let mut active: Vec<i64> = ids_under(&*read, &status_prefix("active"))?;
        active.sort_unstable();
        active.truncate(10);
        let mut by_status: BTreeMap<String, usize> = BTreeMap::new();
        for row in terminal_rows(&*read)? {
            if row.submission_authority.is_none() && row.idempotency_key.is_some() {
                *by_status.entry(row.status).or_default() += 1;
            }
        }
        let terminal_keyed: Vec<Value> = by_status
            .into_iter()
            .map(|(status, count)| json!({ "status": status, "count": count }))
            .collect();
        Ok(json!({ "live": live, "active_ids": active, "terminal_keyed": terminal_keyed }))
    }

    /// `readQueuedSpendRows`: queued jobs by name and spend basis, and the spend-authorized waiting
    /// rows older than `wait_ms`.
    pub fn read_queued_spend_rows(&self, spec: &QueuedSpendSpec) -> Result<Value> {
        let read = self.read()?;
        // Each prefix is a LIKE pattern followed by `%`, as the SQL reads it: `_` matches any one character.
        let legacy_patterns: BTreeMap<&str, Vec<Vec<Like>>> = spec
            .legacy_prefixes
            .iter()
            .map(|(name, prefixes)| {
                let patterns = prefixes
                    .iter()
                    .map(|p| like_tokens(&format!("{p}%")))
                    .collect::<Result<Vec<_>>>()?;
                Ok((name.as_str(), patterns))
            })
            .collect::<Result<_>>()?;
        let mut counts: BTreeMap<(String, bool, Option<String>), usize> = BTreeMap::new();
        for status in ["waiting", "delayed", "paused", "waiting-children"] {
            for row in rows_with_status(&*read, status)? {
                let basis = match &row.spend_authorization {
                    Some(spend) => spend.get("kind").and_then(jsonb_field_text),
                    None => {
                        let legacy = row.idempotency_key.as_ref().is_some_and(|key| {
                            legacy_patterns
                                .get(row.name.as_str())
                                .is_some_and(|patterns| {
                                    patterns.iter().any(|p| like_matches(key, p))
                                })
                        });
                        Some(
                            if legacy {
                                "legacy_default"
                            } else {
                                "unrecorded"
                            }
                            .to_string(),
                        )
                    }
                };
                // Bytewise by name, then by basis with NULL last.
                *counts
                    .entry((row.name.clone(), basis.is_none(), basis))
                    .or_default() += 1;
            }
        }
        let by_basis: Vec<Value> = counts
            .into_iter()
            .map(|((name, _, basis), n)| json!({ "name": name, "basis": basis, "n": n }))
            .collect();
        let cutoff = self.env.now_micros() - (spec.wait_ms * 1000.0).round() as i64;
        let mut waiting: Vec<i64> = rows_with_status(&*read, "waiting")?
            .into_iter()
            .filter(|r| r.spend_authorization.is_some() && r.updated_at < cutoff)
            .map(|r| r.id)
            .collect();
        waiting.sort_unstable();
        Ok(json!({ "by_basis": by_basis, "waiting_ids": waiting }))
    }

    /// `listBuildSkewStacktraceLines`: the stacktrace lines `LIKE prefix || '%'` of the newest
    /// `scan_jobs` array-stacktrace jobs updated inside the window, newest job first.
    pub fn list_build_skew_stacktrace_lines(&self, spec: &BuildSkewSpec) -> Result<Vec<Value>> {
        let pattern = like_tokens(&format!("{}%", spec.prefix))?;
        let read = self.read()?;
        let cutoff = self.env.now_micros() - hours_us(spec.window_hours);
        let mut rows: Vec<JobRecord> = all_rows(&*read)?
            .into_iter()
            .filter(|r| r.updated_at > cutoff && matches!(r.stacktrace, Some(Value::Array(_))))
            .collect();
        rows.sort_by_key(|r| Reverse(r.id));
        rows.truncate(spec.scan_jobs.max(0) as usize);
        let mut out = Vec::new();
        for row in &rows {
            if let Some(Value::Array(lines)) = &row.stacktrace {
                for line in lines.iter().filter_map(jsonb_field_text) {
                    if like_matches(&line, &pattern) {
                        out.push(json!({ "id": row.id, "line": line }));
                    }
                }
            }
        }
        Ok(out)
    }

    /// `countDeadDreamSubmissionRows`: dead (and paid-cancelled) dream subagent jobs that finished
    /// inside the window, counted per base key as distinct queues.
    pub fn count_dead_dream_submission_rows(&self, spec: &DeadDreamSpec) -> Result<Vec<Value>> {
        let read = self.read()?;
        let cutoff = self.env.now_micros() - hours_us(spec.window_hours);
        let [synth, patterns] = &spec.key_prefixes;
        let mut rows = Vec::new();
        for status in ["dead", "cancelled"] {
            rows.extend(rows_with_status(&*read, status)?);
        }
        #[derive(Default)]
        struct Group {
            queues: BTreeSet<String>,
            contents: BTreeSet<String>,
            last: i64,
        }
        let mut groups: BTreeMap<String, Group> = BTreeMap::new();
        for row in rows {
            let ended = row.name == "subagent"
                && row.finished_at.is_some_and(|f| f > cutoff)
                && (row.status == "dead"
                    || (row.status == "cancelled" && row.tokens_input + row.tokens_output > 0));
            let (Some(finished), true, Some(key)) = (row.finished_at, ended, child_key(&row))
            else {
                continue;
            };
            let base = strip_chunk_suffix(&key).to_string();
            let source = source_of(&row, "source_id");
            let dead = row.status == "dead";
            let mut counted: Vec<(String, Option<String>)> = Vec::new();
            if dead && base.starts_with(synth.as_str()) {
                counted.push((base.clone(), Some(base.clone())));
            }
            if base.starts_with(patterns.as_str()) {
                counted.push((format!("{}{source}", spec.patterns_source_prefix), None));
            }
            let transcript =
                filename_of(&base).filter(|_| dead && base.starts_with(synth.as_str()));
            if let Some(name) = transcript {
                counted.push((
                    format!("{}{source}:{name}", spec.synth_file_prefix),
                    Some(base.clone()),
                ));
            }
            for (group_key, content) in counted {
                let reset = match spec.resets.get(&group_key).and_then(jsonb_field_text) {
                    None => i64::MIN,
                    Some(at) => parse_iso(&at).ok_or_else(|| {
                        StoreError::invalid(format!(
                            "countDeadDreamSubmissionRows: reset for {group_key} is not an ISO timestamp: {at}"
                        ))
                    })?,
                };
                if finished <= reset {
                    continue;
                }
                let group = groups.entry(group_key).or_default();
                group.queues.insert(row.queue.clone());
                group.contents.extend(content);
                group.last = group.last.max(finished);
            }
        }
        let mut out: Vec<(String, Group)> = groups
            .into_iter()
            .filter(|(key, g)| {
                !key.starts_with(spec.synth_file_prefix.as_str()) || g.contents.len() > 1
            })
            .collect();
        // `BTreeMap` already ordered the keys bytewise; the sort is stable.
        out.sort_by_key(|(_, g)| Reverse(g.queues.len()));
        Ok(out
            .into_iter()
            .map(|(key, g)| {
                json!({
                    "base_key": key,
                    "dead_submissions": g.queues.len(),
                    "last_dead_at": timestamptz_text(g.last),
                })
            })
            .collect())
    }

    /// `listFactsAbsorbJobsByKeyPrefix`: `facts-absorb` rows whose key is `LIKE prefix || '%'` and that
    /// are dead or whose key is in `keys`, by id.
    pub fn list_facts_absorb_jobs_by_key_prefix(&self, spec: &KeyPrefixSpec) -> Result<Vec<Value>> {
        let pattern = like_tokens(&format!("{}%", spec.prefix))?;
        let read = self.read()?;
        let mut rows: Vec<JobRecord> = all_rows(&*read)?
            .into_iter()
            .filter(|r| {
                r.name == "facts-absorb"
                    && r.idempotency_key.as_ref().is_some_and(|k| {
                        like_matches(k, &pattern) && (r.status == "dead" || spec.keys.contains(k))
                    })
            })
            .collect();
        rows.sort_by_key(|r| r.id);
        Ok(rows.iter().map(facts_absorb_json).collect())
    }

    /// `listDeadFactsAbsorbJobsByKeys`: the dead `facts-absorb` rows whose key is in `keys`, by id.
    pub fn list_dead_facts_absorb_jobs_by_keys(&self, keys: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows: Vec<JobRecord> = rows_with_status(&*read, "dead")?
            .into_iter()
            .filter(|r| {
                r.name == "facts-absorb"
                    && r.idempotency_key.as_ref().is_some_and(|k| keys.contains(k))
            })
            .collect();
        rows.sort_by_key(|r| r.id);
        Ok(rows.iter().map(facts_absorb_json).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{AdmitSpec, CancelOpts, ClaimSpec};

    #[test]
    fn timeout_verdict_follows_bool_and() {
        let dead = |e: Option<&'static str>| ("dead", e);
        let t = Some("job timeout exceeded after 60s");
        assert!(all_timed_out([dead(t), dead(t)].into_iter()));
        // A dead row with no error text is NULL: skipped, not false.
        assert!(all_timed_out([dead(t), dead(None)].into_iter()));
        // A group of only NULLs is NULL: not kept.
        assert!(!all_timed_out([dead(None), dead(None)].into_iter()));
        assert!(!all_timed_out([dead(t), ("failed", t)].into_iter()));
        assert!(!all_timed_out(
            [dead(t), dead(Some("Timeout Exceeded"))].into_iter()
        ));
        assert!(!all_timed_out(std::iter::empty()));
    }

    #[test]
    fn chunk_suffix_and_filename_follow_the_patterns() {
        assert_eq!(strip_chunk_suffix("k:c1of3"), "k");
        assert_eq!(strip_chunk_suffix("k:c12of30"), "k");
        assert_eq!(strip_chunk_suffix("k:cof3"), "k:cof3");
        assert_eq!(strip_chunk_suffix("k:c1of"), "k:c1of");
        assert_eq!(strip_chunk_suffix("k:c1of3x"), "k:c1of3x");
        assert_eq!(strip_chunk_suffix("k:c1of3:c2of4"), "k:c1of3");
        assert_eq!(strip_chunk_suffix("c1of3"), "c1of3");
        assert_eq!(filename_of("a:filename:n:h"), Some("n"));
        assert_eq!(filename_of("a:filename::h"), Some(""));
        assert_eq!(filename_of(":filename:n:h"), Some("n"));
        assert_eq!(filename_of("filename:n:h"), None);
        assert_eq!(filename_of("a:filename:x:n:h"), None);
        assert_eq!(filename_of("a:file:n:h"), None);
    }

    #[test]
    fn jsonb_has_matches_object_keys_array_strings_and_string_scalars() {
        assert!(jsonb_has(&json!({"stall": 1}), "stall"));
        assert!(!jsonb_has(&json!({"x": {"stall": 1}}), "stall"));
        assert!(jsonb_has(&json!(["a", "stall"]), "stall"));
        assert!(!jsonb_has(&json!([1, null]), "stall"));
        assert!(jsonb_has(&json!("stall"), "stall"));
        assert!(!jsonb_has(&json!(true), "stall"));
    }

    /// A job of `name` admitted with an application authority and the given key.
    fn admit(store: &Store, name: &str, key: Option<&str>) -> i64 {
        let spec: AdmitSpec = serde_json::from_value(json!({
            "maxSpawnDepth": 5,
            "insert": {
                "name": name, "queue": "default", "status": "waiting", "priority": 0, "data": {},
                "max_attempts": 3, "backoff_type": "exponential", "backoff_delay": 1000,
                "backoff_jitter": 0.2, "on_child_fail": "fail_parent", "remove_on_complete": false,
                "remove_on_fail": false, "idempotency_key": key,
                "submission_authority": {"version": 1, "kind": "application"},
            },
        }))
        .unwrap();
        store.admit_job(&spec).unwrap().row["id"].as_i64().unwrap()
    }

    fn cancel(store: &Store, id: i64) {
        let opts: CancelOpts = serde_json::from_value(json!({})).unwrap();
        store.cancel_jobs(&[id], &opts).unwrap();
    }

    /// Rewrites a stored row in place, as a row from before the protocol trigger would look.
    fn rewrite(store: &Store, id: i64, mut f: impl FnMut(&mut JobRecord)) {
        store
            .write(|tx| {
                let mut row = load(tx, id)?.expect("the row exists");
                f(&mut row);
                put_json(tx, &job_key(id), &row)
            })
            .unwrap();
    }

    #[test]
    fn a_row_with_no_authority_is_live_unreviewed_and_a_finished_keyed_one_is_counted() {
        let store = crate::test_support::store();
        let live = admit(&store, "legacy", Some("legacy:1"));
        let app = admit(&store, "app", Some("app:1"));
        let done = admit(&store, "legacy-done", Some("legacy:2"));
        let unkeyed = admit(&store, "legacy-unkeyed", None);
        let kept = admit(&store, "app-done", Some("app:2"));
        for id in [done, unkeyed, kept] {
            cancel(&store, id);
        }
        for id in [live, done, unkeyed] {
            rewrite(&store, id, |r| r.submission_authority = None);
        }
        let read = store.read_legacy_job_authority().unwrap();
        assert_eq!(read["live"].as_array().unwrap().len(), 1);
        assert_eq!(read["live"][0]["id"], live);
        assert_eq!(read["live"][0]["legacy_authority_is_null"], true);
        assert_eq!(read["live"][0]["submission_authority"], Value::Null);
        assert_eq!(
            read["terminal_keyed"],
            json!([{"status": "cancelled", "count": 1}])
        );
        assert_ne!(live, app);
    }

    #[test]
    fn a_dead_child_with_no_error_text_does_not_veto_the_phase() {
        let store = crate::test_support::store();
        let claim = |token: &str| -> ClaimSpec {
            serde_json::from_value(json!({
                "lockToken": token, "lockDurationMs": 30000, "queue": "default",
                "names": ["subagent"], "suspectMark": "watchdog_suspect",
                "handlerTimeouts": {}, "handlerLockDurations": {},
                "legacySpend": {"groupId": "00000000-0000-4000-8000-000000000001", "capUsd": 5},
            }))
            .unwrap()
        };
        let mut ids = Vec::new();
        for i in 0..2 {
            let id = admit(
                &store,
                "subagent",
                Some(&format!("dream:patterns:source:s:{i}")),
            );
            let token = format!("t{i}");
            store.claim_next_job(&claim(&token)).unwrap().unwrap();
            store
                .fail_job(id, &token, "x: timeout exceeded", "dead", None, None)
                .unwrap();
            ids.push(id);
        }
        let read = |deaths| {
            store
                .read_global_maintenance_deaths(&DeathsSpec { deaths })
                .unwrap()["child_timeouts"]
                .clone()
        };
        rewrite(&store, ids[0], |r| r.error_text = None);
        assert_eq!(
            read(2).as_array().unwrap().len(),
            1,
            "a NULL error is skipped"
        );
        rewrite(&store, ids[1], |r| r.error_text = None);
        assert_eq!(read(2), json!([]), "a group of NULLs is not kept");
    }

    #[test]
    fn a_failed_job_with_no_finish_time_is_counted_but_never_after_a_cut() {
        let store = crate::test_support::store();
        let id = admit(&store, "autopilot-global-maintenance", None);
        cancel(&store, id);
        rewrite(&store, id, |r| r.finished_at = None);
        let all = store
            .read_last_failed_global_maintenance_job(None)
            .unwrap()
            .unwrap();
        assert_eq!(
            (
                all["id"].clone(),
                all["total"].clone(),
                all["since"].clone()
            ),
            (json!(id), json!(1), Value::Null)
        );
        let cut = store.read_last_failed_global_maintenance_job(Some("2000-01-01T00:00:00.000Z"));
        assert!(cut.unwrap().is_none(), "NULL > cut is not true");
    }
}
