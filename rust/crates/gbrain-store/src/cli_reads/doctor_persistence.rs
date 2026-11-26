//! Doctor persistence reads: the typed members that replace the raw SQL of the persistence checks of
//! `gbrain doctor` (SQL in `src/core/engine-sql/doctor-persistence.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-per.md`).
//!
//! Each read takes one snapshot of the request journal (`persistence_requests`) or of the counters and
//! answers the rows the SQL answers, with the same column types: a `::text` column is a string, a
//! `::int` column a number, a `timestamptz::text` column its PostgreSQL text. `now()` is the store
//! clock, read once per call, and every interval is computed from it in microseconds, as the SQL
//! computes them in UTC. Requests are never deleted on this engine, so a read walks them all.

use crate::Store;
use crate::cli_reads::pg_text::timestamptz_text;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::pages::read_page;
use crate::persistence::topology::topology_terminal_bytes;
use crate::persistence::{
    all_counters, all_requests, and3, extra_bool, extra_i64, extra_is_null, extra_time, json_text,
    sql_like, worktree_owner_host,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// `r.error_message LIKE 'Publication failed (P0001)%'`.
const OPAQUE_PUBLICATION_FAILURE: &str = "Publication failed (P0001)%";
const SECOND_US: i64 = 1_000_000;
const DAY_US: i64 = 86_400 * SECOND_US;

type Request = crate::journal::RequestRecord;

fn micros(seconds: f64) -> i64 {
    (seconds * SECOND_US as f64).round() as i64
}

/// `numeric::bigint` rounds half away from zero.
fn round_ms(diff_us: i64) -> i64 {
    if diff_us >= 0 {
        (diff_us + 500) / 1000
    } else {
        -((-diff_us + 500) / 1000)
    }
}

fn is_counter_scope(key: &str) -> bool {
    key == "brain" || key.starts_with("principal:")
}

fn worktree_of(r: &Request) -> Option<&str> {
    r.extra.get("worktree_id").and_then(Value::as_str)
}

fn claim_lapsed(r: &Request, now: i64) -> Option<bool> {
    extra_time(r, "claim_expires_at").map(|t| t < now)
}

fn error_origin(r: &Request) -> Option<String> {
    json_text(r.extra.get("error_detail").and_then(|d| d.get("origin")))
}

/// `GUARD_REFUSAL_SQL('r')`.
fn guard_refusal(r: &Request) -> bool {
    r.state == "failed"
        && (r.error_code.as_deref() == Some("writer_coordinator_required")
            || (r.error_code.as_deref() == Some("storage_error")
                && r.error_message
                    .as_deref()
                    .is_some_and(|m| sql_like(m, OPAQUE_PUBLICATION_FAILURE))))
}

/// `DRIFT_REFUSAL_SQL('r')`.
fn drift_refusal(r: &Request) -> bool {
    r.state == "conflict" && r.error_code.as_deref() == Some("source_changed")
}

fn refused(r: &Request) -> bool {
    guard_refusal(r) || drift_refusal(r)
}

/// A `$n::bigint` sequence parameter; sequences start at 1, so a negative floor admits every one.
fn sequence_arg(text: &str) -> Result<u64> {
    let n: i64 = text
        .trim()
        .parse()
        .map_err(|_| StoreError::invalid(format!("'{text}' is not a bigint")))?;
    Ok(n.max(0) as u64)
}

/// The requests of `source_id` that left a `source_changed` receipt with `message`, as distinct slugs.
fn drift_receipt_slugs(
    read: &dyn KvRead,
    source_id: &str,
    message: &str,
    keep: &dyn Fn(u64) -> bool,
) -> Result<Vec<String>> {
    let mut slugs: Vec<String> = all_requests(read)?
        .into_iter()
        .filter(|r| {
            keep(r.sequence)
                && r.source_id == source_id
                && r.state == "conflict"
                && r.error_code.as_deref() == Some("source_changed")
                && r.error_message.as_deref() == Some(message)
        })
        .map(|r| r.slug)
        .collect();
    slugs.sort();
    slugs.dedup();
    Ok(slugs)
}

impl Store {
    /// `listCapacityCounters()`: the brain and principal counter rows, every column as text, in key order.
    pub fn list_capacity_counters(&self) -> Result<Vec<Value>> {
        Ok(all_counters(&*self.read()?)?
            .into_iter()
            .filter(|(key, _)| is_counter_scope(key))
            .map(|(key, c)| {
                json!({
                    "key": key,
                    "outstanding_count": c.outstanding_count.to_string(),
                    "intent_bytes": c.intent_bytes.to_string(),
                    "lifetime_ids": c.lifetime_ids.to_string(),
                    "terminal_bytes": c.terminal_bytes.to_string(),
                    "recovery_bytes": c.recovery_bytes.to_string(),
                })
            })
            .collect())
    }

    /// `listLifetimeCounters()`: `{ key, lifetime_ids }` of the brain and principal counters, in key order.
    pub fn list_lifetime_counters(&self) -> Result<Vec<Value>> {
        Ok(all_counters(&*self.read()?)?
            .into_iter()
            .filter(|(key, _)| is_counter_scope(key))
            .map(|(key, c)| json!({ "key": key, "lifetime_ids": c.lifetime_ids.to_string() }))
            .collect())
    }

    /// `countPersistenceRequestRows(false)`: `{ rows }`, the exact row count as text.
    pub fn count_persistence_request_rows(&self) -> Result<Value> {
        let n = all_requests(&*self.read()?)?.len();
        Ok(json!({ "rows": n.to_string() }))
    }

    /// `readAdmissionSample(principal)`: of the newest 10,000 requests (of the principal when given),
    /// those created in the last 7 days and the oldest of them.
    pub fn read_admission_sample(&self, principal: Option<(&str, &str)>) -> Result<Value> {
        let now = self.env.now_micros();
        let mut requests = all_requests(&*self.read()?)?;
        if let Some((kind, id)) = principal {
            requests.retain(|r| r.principal_kind == kind && r.principal_id == id);
        }
        requests.sort_by_key(|r| std::cmp::Reverse(r.sequence));
        requests.truncate(10_000);
        let inside: Vec<i64> = requests
            .iter()
            .map(|r| r.created_at_us)
            .filter(|t| *t >= now - 7 * DAY_US)
            .collect();
        Ok(json!({
            "admissions": inside.len(),
            "oldest": inside.iter().min().map(|t| timestamptz_text(*t)),
        }))
    }

    /// `listOutstandingHolders(principal)`: the three sources holding the most outstanding slots, the
    /// most requests ten minutes old or older first, then the most slots, then the source id.
    pub fn list_outstanding_holders(&self, principal: Option<(&str, &str)>) -> Result<Vec<Value>> {
        let now = self.env.now_micros();
        let mut by_source: BTreeMap<String, (u64, u64)> = BTreeMap::new();
        for r in all_requests(&*self.read()?)? {
            if !crate::persistence::OUTSTANDING_STATES.contains(&r.state.as_str()) {
                continue;
            }
            if let Some((kind, id)) = principal
                && !(r.principal_kind == kind && r.principal_id == id)
            {
                continue;
            }
            let entry = by_source.entry(r.source_id).or_default();
            entry.0 += 1;
            if r.created_at_us <= now - 600 * SECOND_US {
                entry.1 += 1;
            }
        }
        let mut rows: Vec<(String, u64, u64)> = by_source
            .into_iter()
            .map(|(s, (n, st))| (s, n, st))
            .collect();
        rows.sort_by(|a, b| b.2.cmp(&a.2).then(b.1.cmp(&a.1)).then(a.0.cmp(&b.0)));
        rows.truncate(3);
        Ok(rows
            .into_iter()
            .map(|(source_id, n, stalled)| json!({ "source_id": source_id, "n": n, "stalled": stalled }))
            .collect())
    }

    /// `listRunningRequestStalls(maxClaimMs)`: the oldest 100 running requests with the claim state,
    /// the age, whether their root settled a request inside `max_claim_ms` and the queue behind them.
    pub fn list_running_request_stalls(&self, max_claim_ms: f64) -> Result<Vec<Value>> {
        let now = self.env.now_micros();
        let window_start = now - micros(max_claim_ms / 1000.0);
        let mut all = all_requests(&*self.read()?)?;
        all.sort_by_key(|r| r.sequence);
        let mut rows = Vec::new();
        for r in all.iter().filter(|r| r.state == "running").take(100) {
            let wt = worktree_of(r);
            let progressed = all.iter().any(|q| {
                let same_root = match wt {
                    Some(w) => worktree_of(q) == Some(w),
                    None => worktree_of(q).is_none() && q.source_id == r.source_id,
                };
                same_root
                    && matches!(
                        q.state.as_str(),
                        "committed" | "conflict" | "failed" | "cancelled"
                    )
                    && q.completed_at_us.is_some_and(|c| c >= window_start)
                    && extra_is_null(q, "recovery")
                    && !extra_bool(q, "compacted")
            });
            let waiting = match wt {
                Some(w) => all
                    .iter()
                    .filter(|q| {
                        worktree_of(q) == Some(w) && q.state == "queued" && q.sequence > r.sequence
                    })
                    .count(),
                None => 0,
            };
            rows.push(json!({
                "request_id": r.request_id,
                "source_id": r.source_id,
                "worktree_id": wt,
                "operation": r.operation,
                "intent_kind": json_text(r.intent.get("kind")),
                "state": r.state,
                "claim_phase": r.extra.get("claim_phase").cloned().unwrap_or(Value::Null),
                "execution_token": r.extra.get("execution_token").and_then(Value::as_str),
                "claim_lapsed": claim_lapsed(r, now),
                "publication_started": extra_bool(r, "publication_started"),
                "request_age_ms": round_ms(now - r.created_at_us).to_string(),
                "no_root_progress": !progressed,
                "waiting": waiting,
            }));
        }
        Ok(rows)
    }

    /// `readMaxRequestSequence()`: the newest request sequence as text, `None` on an empty journal.
    pub fn read_max_request_sequence(&self) -> Result<Option<String>> {
        Ok(all_requests(&*self.read()?)?
            .iter()
            .map(|r| r.sequence)
            .max()
            .map(|s| s.to_string()))
    }

    /// `listRecentDriftReceiptSlugs(sourceId, floor, message)`: up to 100 slugs with a `source_changed`
    /// receipt after sequence `floor`, each row with the total of such slugs.
    pub fn list_recent_drift_receipt_slugs(
        &self,
        source_id: &str,
        floor: &str,
        message: &str,
    ) -> Result<Vec<Value>> {
        let floor = sequence_arg(floor)?;
        let slugs = drift_receipt_slugs(&*self.read()?, source_id, message, &|s| s > floor)?;
        let total = slugs.len();
        Ok(slugs
            .into_iter()
            .take(100)
            .map(|slug| json!({ "slug": slug, "total": total }))
            .collect())
    }

    /// `listOlderDriftReceiptSlugs(sourceId, floor, message)`: up to 101 slugs with a `source_changed`
    /// receipt at or below sequence `floor`. The timeout bound of the SQL has nothing to bound here.
    pub fn list_older_drift_receipt_slugs(
        &self,
        source_id: &str,
        floor: &str,
        message: &str,
    ) -> Result<Vec<Value>> {
        let floor = sequence_arg(floor)?;
        let slugs = drift_receipt_slugs(&*self.read()?, source_id, message, &|s| s <= floor)?;
        Ok(slugs
            .into_iter()
            .take(101)
            .map(|slug| json!({ "slug": slug }))
            .collect())
    }

    /// `listRefusalBreakerRows(sourceId, windowHours, threshold, limit)`: the `submit_job` slugs of the
    /// source refused `threshold` times or more with one write and code inside the window.
    pub fn list_refusal_breaker_rows(
        &self,
        source_id: &str,
        window_hours: f64,
        threshold: i64,
        limit: i64,
    ) -> Result<Vec<Value>> {
        let now = self.env.now_micros();
        let since = now - micros(window_hours * 3600.0);
        let mut requests: Vec<Request> = all_requests(&*self.read()?)?
            .into_iter()
            .filter(|r| {
                r.source_id == source_id
                    && !r.intent.is_null()
                    && !extra_bool(r, "compacted")
                    && r.operation == "submit_job"
                    && (r.state == "failed" || r.state == "conflict")
                    && r.error_code.is_some()
                    && r.completed_at_us.is_some_and(|c| c > since)
            })
            .collect();
        requests.sort_by_key(|r| r.sequence);
        type Key = (String, String, String);
        let mut groups: BTreeMap<Key, Vec<&Request>> = BTreeMap::new();
        for r in &requests {
            groups
                .entry((
                    r.slug.clone(),
                    r.digest.clone(),
                    r.error_code.clone().unwrap_or_default(),
                ))
                .or_default()
                .push(r);
        }
        let mut rows: Vec<Value> = Vec::new();
        for ((slug, _, code), group) in groups {
            if (group.len() as i64) < threshold {
                continue;
            }
            let Some(last) = group.last() else { continue };
            rows.push(json!({
                "slug": slug,
                "error_code": code,
                "refusals": group.len().to_string(),
                "last_request_id": last.request_id,
                "cause": error_origin(last),
            }));
        }
        rows.sort_by(|a, b| a["slug"].as_str().cmp(&b["slug"].as_str()));
        rows.truncate(limit.max(0) as usize);
        Ok(rows)
    }

    /// `readCounterDrift(clampedKey)`: each brain and principal terminal-bytes counter beside the
    /// request receipts and topology changes charged to it, and the true-up clamp setting.
    pub fn read_counter_drift(&self, clamped_key: &str) -> Result<Vec<Value>> {
        let (counters, requests, topology) = {
            let read = self.read()?;
            (
                all_counters(&*read)?,
                all_requests(&*read)?,
                topology_terminal_bytes(&*read)?,
            )
        };
        // key -> (request rows, request bytes, topology rows, topology bytes)
        let mut scopes: BTreeMap<String, [i64; 4]> = BTreeMap::new();
        for r in &requests {
            let s = scopes
                .entry(format!("principal:{}:{}", r.principal_kind, r.principal_id))
                .or_default();
            s[0] += 1;
            s[1] += extra_i64(r, "terminal_reservation");
        }
        for (principal_id, bytes) in &topology {
            let s = scopes
                .entry(format!("principal:local_cli:{principal_id}"))
                .or_default();
            s[2] += 1;
            s[3] += bytes;
        }
        let mut total = [0i64; 4];
        for s in scopes.values() {
            for (t, v) in total.iter_mut().zip(s) {
                *t += v;
            }
        }
        scopes.insert("brain".into(), total);
        let clamped = self.get_config(clamped_key)?;
        Ok(counters
            .into_iter()
            .filter(|(key, _)| is_counter_scope(key))
            .map(|(key, c)| {
                let [req_rows, req_bytes, topo_rows, topo_bytes] =
                    scopes.get(&key).copied().unwrap_or_default();
                json!({
                    "key": key,
                    "counter": c.terminal_bytes.to_string(),
                    "req_rows": req_rows.to_string(),
                    "req_bytes": req_bytes.to_string(),
                    "topo_rows": topo_rows.to_string(),
                    "topo_bytes": topo_bytes.to_string(),
                    "clamped": clamped,
                })
            })
            .collect())
    }

    /// `readPublicationRefusals()`: `{ guard, trigger, opaque }`, the writes of the last 7 days the
    /// database refused.
    pub fn read_publication_refusals(&self) -> Result<Value> {
        let since = self.env.now_micros() - 7 * DAY_US;
        let (mut guard, mut trigger, mut opaque) = (0, 0, 0);
        for r in all_requests(&*self.read()?)? {
            if !matches!(r.state.as_str(), "failed" | "conflict" | "recovering") {
                continue;
            }
            if r.completed_at_us.unwrap_or(r.updated_at_us) <= since {
                continue;
            }
            let origin = error_origin(&r);
            if r.error_code.as_deref() == Some("writer_coordinator_required")
                && origin.as_deref() == Some("database_guard")
            {
                guard += 1;
            }
            if origin.as_deref() == Some("database_trigger") {
                trigger += 1;
            }
            if extra_is_null(&r, "error_detail")
                && r.error_message
                    .as_deref()
                    .is_some_and(|m| sql_like(m, OPAQUE_PUBLICATION_FAILURE))
            {
                opaque += 1;
            }
        }
        Ok(json!({ "guard": guard, "trigger": trigger, "opaque": opaque }))
    }

    /// `listRunningClaimOwners(hostId)`: the first 500 running claims that record an owner, on worktrees `host_id`
    /// owns or on no worktree (`r.worktree_id IS NULL OR w.owner_host_id=$1`). A request naming a worktree this host
    /// does not own, or one with no row, is not this host's to judge. With `host_id` `None` (managed mode held back
    /// for the caller) only the claims on no worktree are listed, as before worktree owners were read.
    pub fn list_running_claim_owners(&self, host_id: Option<&str>) -> Result<Vec<Value>> {
        let host = host_id.map(str::to_lowercase);
        let now = self.env.now_micros();
        let read = self.read()?;
        let mut requests = all_requests(&*read)?;
        requests.sort_by_key(|r| r.sequence);
        let mut rows = Vec::new();
        for r in requests.iter().filter(|r| r.state == "running") {
            let Some(owner) = r.extra.get("claim_phase").and_then(|p| p.get("owner")) else {
                continue;
            };
            let this_hosts = match worktree_of(r) {
                None => true,
                Some(worktree) => match &host {
                    Some(host) => {
                        worktree_owner_host(&*read, worktree)?.as_deref() == Some(host.as_str())
                    }
                    None => false,
                },
            };
            if this_hosts {
                rows.push(json!({ "source_id": r.source_id, "owner": owner, "lapsed": claim_lapsed(r, now) }));
            }
            if rows.len() == 500 {
                break;
            }
        }
        Ok(rows)
    }

    /// `listLocalEditAdoptions()`: per source, the `put_page` writes committed in the last 24 hours
    /// that adopted a local edit, with the distinct paths in order (a missing path last).
    pub fn list_local_edit_adoptions(&self) -> Result<Vec<Value>> {
        let since = self.env.now_micros() - DAY_US;
        let mut by_source: BTreeMap<String, (i64, Vec<String>, bool)> = BTreeMap::new();
        for r in all_requests(&*self.read()?)? {
            let Some(adopted) = r
                .outcome
                .as_ref()
                .and_then(|o| o.as_object())
                .and_then(|o| o.get("adopted_local_edit"))
            else {
                continue;
            };
            if r.state != "committed"
                || r.operation != "put_page"
                || !r.completed_at_us.is_some_and(|c| c > since)
            {
                continue;
            }
            let entry = by_source.entry(r.source_id).or_default();
            entry.0 += 1;
            match json_text(adopted.get("path")) {
                Some(path) => entry.1.push(path),
                None => entry.2 = true,
            }
        }
        Ok(by_source
            .into_iter()
            .map(|(source_id, (adoptions, mut paths, missing))| {
                paths.sort();
                paths.dedup();
                let mut out: Vec<Value> = paths.into_iter().map(Value::String).collect();
                if missing {
                    out.push(Value::Null);
                }
                json!({ "source_id": source_id, "adoptions": adoptions, "paths": out })
            })
            .collect())
    }

    /// `listCallerRefusalRows(sourceIds, operations)`: the caller writes of the sources that a
    /// managed-writer guard or a file drift refused and whose receipt keeps its intent, by sequence,
    /// with whether the intent pins its target and whether its expected revision is no longer the
    /// page's.
    pub fn list_caller_refusal_rows(
        &self,
        source_ids: &[String],
        operations: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut requests = all_requests(&*read)?;
        requests.sort_by_key(|r| r.sequence);
        let mut rows = Vec::new();
        for r in requests.iter().filter(|r| {
            source_ids.contains(&r.source_id)
                && !extra_bool(r, "compacted")
                && !r.intent.is_null()
                && refused(r)
                && operations.contains(&r.operation)
                && !(r.operation == "put_page"
                    && r.intent.as_object().is_some_and(|o| o.contains_key("kind")))
        }) {
            let unpinned = r.operation == "remember"
                && !matches!(r.intent.get("entity_slug"), Some(Value::String(_)));
            let expected = r.intent.get("expected_revision");
            // `jsonb_typeof(..) = 'string'` is NULL when the key is missing.
            let typed = expected.map(|v| v.is_string());
            let differs = json_text(expected) != read_live_revision(&*read, &r.source_id, &r.slug)?;
            let stale = and3(Some(r.operation == "put_page"), and3(typed, Some(differs)));
            rows.push(json!({
                "id": r.id,
                "request_id": r.request_id,
                "source_id": r.source_id,
                "slug": r.slug,
                "operation": r.operation,
                "digest": r.digest,
                "sequence": r.sequence.to_string(),
                "reason": if r.state == "conflict" { "source_changed" } else { "writer_guard" },
                "unpinned": unpinned,
                "stale_revision": stale,
            }));
        }
        Ok(rows)
    }

    /// `countCompactedCallerRefusals(sourceIds, operations)`: the refused receipts of the sources that
    /// compaction already emptied.
    pub fn count_compacted_caller_refusals(
        &self,
        source_ids: &[String],
        operations: &[String],
    ) -> Result<u64> {
        Ok(all_requests(&*self.read()?)?
            .iter()
            .filter(|r| {
                source_ids.contains(&r.source_id)
                    && extra_bool(r, "compacted")
                    && refused(r)
                    && operations.contains(&r.operation)
            })
            .count() as u64)
    }

    /// `listRecentWriterVersions(days)`: the committed requests published in the last `days`, per
    /// admitting host, principal and version (by creation) and per publishing host, principal and
    /// version (by publication), newest first. The migration cutoff is the epoch on this engine
    /// (`readWriterVersionCutoff`), so every request counts, and a request on a worktree has no
    /// owner row to name a host the request itself does not.
    pub fn list_recent_writer_versions(&self, days: f64) -> Result<Vec<Value>> {
        let since = self.env.now_micros() - micros(days * 86400.0);
        // (role, host, principal, version) -> (last seen, requests)
        type Key = (&'static str, Option<String>, String, Option<String>);
        let mut groups: BTreeMap<Key, (i64, i64)> = BTreeMap::new();
        for r in all_requests(&*self.read()?)? {
            let publication = extra_time(&r, "published_at").or(r.completed_at_us);
            if r.state != "committed" || !publication.is_some_and(|p| p >= since) {
                continue;
            }
            let text = |column: &str| {
                r.extra
                    .get(column)
                    .and_then(Value::as_str)
                    .map(str::to_string)
            };
            let principal = format!("{}:{}", r.principal_kind, r.principal_id);
            let mut note = |key: Key, seen: i64| {
                let g = groups.entry(key).or_insert((seen, 0));
                g.0 = g.0.max(seen);
                g.1 += 1;
            };
            note(
                (
                    "admitter",
                    text("admitter_host_id"),
                    principal.clone(),
                    text("admitter_version"),
                ),
                r.created_at_us,
            );
            if let Some(p) = publication {
                note(
                    (
                        "consumer",
                        text("consumer_host_id"),
                        principal,
                        text("consumer_version"),
                    ),
                    p,
                );
            }
        }
        let mut rows: Vec<(Key, (i64, i64))> = groups.into_iter().collect();
        rows.sort_by_key(|(_, (seen, _))| std::cmp::Reverse(*seen));
        Ok(rows
            .into_iter()
            .map(|((role, host_id, principal, version), (seen, requests))| {
                json!({
                    "role": role,
                    "host_id": host_id,
                    "principal": principal,
                    "version": version,
                    "last_seen": iso(seen),
                    "requests": requests,
                })
            })
            .collect())
    }
}

/// `pages.knowledge_revision::text` of the live page of the source, `None` when there is none.
fn read_live_revision(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Option<String>> {
    Ok(read_page(read, source_id, slug)?
        .filter(|p| p.deleted_at_us.is_none())
        .map(|p| p.knowledge_revision))
}
