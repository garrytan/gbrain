//! The three queue reads of `gbrain sources writer status` that the doctor checks share
//! (`listStalledCatchupRows`, `listParkedGroupRows` and `listSourceBindingsForMovement` in
//! `src/core/engine-sql/doctor-persistence.ts`), and the per-binding movement rows
//! (`readSourceMovementRows`, `src/core/engine-sql/applied-watermark-reads.ts`), and the parked
//! effect and Git push hold reads of the doctor's parked-effects check (`countParkedEffects`,
//! `listParkedEffects`, `listGitPushHoldRows`);
//! rust/docs/store/persistence.md, "Writer status".
//!
//! Each read answers what its statement answers on Postgres, from the effect, request, source
//! binding, worktree and source records: the stalled `writer_busy` catch-ups per source, the
//! parked Git targets per source, error code and former binding, and the source bindings with
//! their worktree owner. Text keys sort in byte order (`COLLATE "C"`), a null key last unless
//! the statement says `NULLS FIRST`. Times are ISO text; the TypeScript members make them `Date`s
//! where the SQL engines return one. `now()` is the store clock.

use super::effects::{EffectRecord, all_effects};
use super::projection_queue::parse_timestamptz;
use super::worktrees::{
    HOST_BINDING, HostBindingRecord, SOURCE_BINDING, SourceBindingRecord, WORKTREE, WorktreeRecord,
    scan_records,
};
use super::{
    RequestRecord, all_requests, extra_bool, extra_time, json_text, list_op_checkpoint_records_in,
    sql_like,
};
use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::sources::all_sources;
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

/// `$1::text[] IS NULL OR e.source_id=ANY($1::text[])`: a null source never matches a list.
fn in_scope(source_id: Option<&str>, source_ids: Option<&[String]>) -> bool {
    match source_ids {
        None => true,
        Some(ids) => source_id.is_some_and(|s| ids.iter().any(|id| id == s)),
    }
}

/// `ORDER BY x COLLATE "C"`: byte order, a null last.
fn nulls_last(a: Option<&str>, b: Option<&str>) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => a.as_bytes().cmp(b.as_bytes()),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

/// `ORDER BY x COLLATE "C" NULLS FIRST`.
fn nulls_first(a: Option<&str>, b: Option<&str>) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(a), Some(b)) => a.as_bytes().cmp(b.as_bytes()),
    }
}

/// `e.data->>key`.
fn data_text(e: &EffectRecord, key: &str) -> Option<String> {
    json_text(e.data.get(key))
}

/// `(e.data->>'busy_retries')::int`: a value that is not an integer refuses, as the cast does.
fn busy_retries(e: &EffectRecord) -> Result<Option<i64>> {
    data_text(e, "busy_retries")
        .map(|t| {
            t.trim().parse::<i32>().map(i64::from).map_err(|_| {
                StoreError::invalid(format!("invalid input syntax for type integer: \"{t}\""))
            })
        })
        .transpose()
}

#[derive(Default)]
struct Catchup {
    stalled: i64,
    busy: i64,
    since: Option<i64>,
    retries: Option<i64>,
}

/// `listStalledCatchupRows(sourceIds, stallMs)`: per source, the queued `writer_busy` effects
/// that carry `busy_since`: how many waited longer than `stall_ms`, how many there are, the
/// oldest `busy_since` and the most `busy_retries` (0 when none says).
pub(crate) fn stalled_catchup_rows_in(
    read: &dyn KvRead,
    now: i64,
    source_ids: Option<&[String]>,
    stall_ms: f64,
) -> Result<Vec<Value>> {
    let cutoff = now - (stall_ms * 1000.0).round() as i64;
    let mut groups: Vec<(Option<String>, Catchup)> = Vec::new();
    for e in all_effects(read)? {
        let busy = e.state == "queued"
            && e.error_code.as_deref() == Some("writer_busy")
            && e.data
                .as_object()
                .is_some_and(|d| d.contains_key("busy_since"))
            && in_scope(e.source_id.as_deref(), source_ids);
        if !busy {
            continue;
        }
        let since = data_text(&e, "busy_since")
            .map(|t| parse_timestamptz(&t, "busy_since"))
            .transpose()?;
        let retries = busy_retries(&e)?;
        let at = match groups.iter().position(|(s, _)| *s == e.source_id) {
            Some(at) => at,
            None => {
                groups.push((e.source_id.clone(), Catchup::default()));
                groups.len() - 1
            }
        };
        let g = &mut groups[at].1;
        g.busy += 1;
        if since.is_some_and(|t| t < cutoff) {
            g.stalled += 1;
        }
        g.since = match (g.since, since) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        g.retries = match (g.retries, retries) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        };
    }
    groups.sort_by(|a, b| nulls_last(a.0.as_deref(), b.0.as_deref()));
    Ok(groups
        .into_iter()
        .map(|(source_id, g)| {
            json!({
                "source_id": source_id,
                "stalled": g.stalled,
                "busy": g.busy,
                "since": g.since.map(iso),
                "retries": g.retries.unwrap_or(0),
            })
        })
        .collect())
}

#[derive(Default)]
struct Parked {
    effects: BTreeSet<i64>,
    targets: i64,
    rule: Option<String>,
    worktrees: BTreeSet<Option<String>>,
    requests: BTreeSet<String>,
}

/// `listParkedGroupRows(sourceIds)`: the parked targets of the failed `targets_parked` Git effects
/// that are not settled, joined to their request, per source, the target's error code and the
/// effect's former binding (`binding_changed` when the source lives on under another binding,
/// `source_replaced` when it does not, null while the effect's binding holds): the effect and
/// target counts, the least rule, the effects' worktrees, the first five request ids and the
/// source's current worktree.
pub(crate) fn parked_group_rows_in(
    read: &dyn KvRead,
    source_ids: Option<&[String]>,
) -> Result<Vec<Value>> {
    let requests: BTreeMap<String, RequestRecord> = all_requests(read)?
        .into_iter()
        .map(|r| (r.id.clone(), r))
        .collect();
    let bindings: BTreeMap<String, SourceBindingRecord> =
        scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?
            .into_iter()
            .map(|b| (b.source_id.clone(), b))
            .collect();
    let sources = all_sources(read)?;
    let former_of = |e: &EffectRecord| -> Option<&'static str> {
        let held = match &e.worktree_id {
            None => true,
            Some(w) => e
                .source_id
                .as_ref()
                .and_then(|s| bindings.get(s))
                .is_some_and(|b| {
                    b.worktree_id.eq_ignore_ascii_case(w)
                        && e.source_incarnation
                            .as_deref()
                            .is_some_and(|i| b.source_incarnation.eq_ignore_ascii_case(i))
                }),
        };
        if held {
            return None;
        }
        let lives = sources.iter().any(|s| {
            Some(s.id.as_str()) == e.source_id.as_deref()
                && !s.archived
                && e.source_incarnation
                    .as_deref()
                    .is_some_and(|i| s.incarnation.eq_ignore_ascii_case(i))
        });
        Some(if lives {
            "binding_changed"
        } else {
            "source_replaced"
        })
    };
    type Key = (Option<String>, Option<String>, Option<&'static str>);
    let mut groups: Vec<(Key, Parked)> = Vec::new();
    for e in all_effects(read)? {
        let parked = match e.data.get("parked") {
            Some(Value::Array(items)) => items,
            _ => continue,
        };
        let eligible = e.kind == "git"
            && e.state == "failed"
            && e.error_code.as_deref() == Some("targets_parked")
            && !e
                .data
                .as_object()
                .is_some_and(|d| d.contains_key("settled"))
            && in_scope(e.source_id.as_deref(), source_ids);
        let Some(r) = requests.get(&e.request_id).filter(|_| eligible) else {
            continue;
        };
        let former = former_of(&e);
        for p in parked {
            let field = |k: &str| json_text(p.as_object().and_then(|o| o.get(k)));
            let key: Key = (e.source_id.clone(), field("error_code"), former);
            let at = match groups.iter().position(|(k, _)| *k == key) {
                Some(at) => at,
                None => {
                    groups.push((key, Parked::default()));
                    groups.len() - 1
                }
            };
            let g = &mut groups[at].1;
            g.effects.insert(e.id);
            g.targets += 1;
            if let Some(rule) = field("rule")
                && g.rule
                    .as_ref()
                    .is_none_or(|least| rule.as_bytes() < least.as_bytes())
            {
                g.rule = Some(rule);
            }
            g.worktrees
                .insert(e.worktree_id.as_ref().map(|w| w.to_lowercase()));
            g.requests.insert(r.request_id.to_lowercase());
        }
    }
    groups.sort_by(|(a, _), (b, _)| {
        nulls_last(a.0.as_deref(), b.0.as_deref())
            .then_with(|| nulls_last(a.1.as_deref(), b.1.as_deref()))
            .then_with(|| nulls_first(a.2, b.2))
    });
    Ok(groups
        .into_iter()
        .map(|((source_id, code, former), g)| {
            // `array_agg(DISTINCT ...)` sorts its values, a null last.
            let mut worktrees: Vec<Option<String>> = g.worktrees.into_iter().collect();
            worktrees.sort_by(|a, b| nulls_last(a.as_deref(), b.as_deref()));
            let current = source_id
                .as_ref()
                .and_then(|s| bindings.get(s))
                .map(|b| b.worktree_id.clone());
            json!({
                "source_id": source_id,
                "code": code,
                "former": former,
                "effects": g.effects.len(),
                "targets": g.targets,
                "rule": g.rule,
                "worktree_ids": worktrees,
                "current_worktree_id": current,
                "requests": g.requests.into_iter().take(5).collect::<Vec<_>>(),
            })
        })
        .collect())
}

/// `listSourceBindingsForMovement(sourceIds)`: each source binding whose source still has the
/// bound incarnation, with its worktree's owner, by source id in byte order.
pub(crate) fn movement_binding_rows_in(
    read: &dyn KvRead,
    source_ids: Option<&[String]>,
) -> Result<Vec<Value>> {
    let worktrees: BTreeMap<String, WorktreeRecord> =
        scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")?
            .into_iter()
            .map(|w| (w.id.to_lowercase(), w))
            .collect();
    let sources = all_sources(read)?;
    let mut bindings = scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?;
    bindings.retain(|b| {
        in_scope(Some(&b.source_id), source_ids)
            && sources.iter().any(|s| {
                s.id == b.source_id && s.incarnation.eq_ignore_ascii_case(&b.source_incarnation)
            })
    });
    bindings.sort_by(|a, b| a.source_id.as_bytes().cmp(b.source_id.as_bytes()));
    Ok(bindings
        .iter()
        .filter_map(|b| {
            let w = worktrees.get(&b.worktree_id.to_lowercase())?;
            Some(json!({
                "source_id": b.source_id,
                "worktree_id": b.worktree_id,
                "source_incarnation": b.source_incarnation,
                "owner_host_id": w.owner_host_id,
            }))
        })
        .collect())
}

/// The `persistence_requests.worktree_id` of a request, as stored.
fn request_worktree(r: &RequestRecord) -> Option<&str> {
    r.extra.get("worktree_id").and_then(Value::as_str)
}

/// `COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'`.
fn managed_sync(r: &RequestRecord) -> bool {
    sql_like(
        &json_text(r.intent.get("kind")).unwrap_or_default(),
        "managed_sync_%",
    )
}

/// `(completed_keys->0->>key)::int`: null when absent, a refusal when not an integer.
fn hold_int(first: Option<&Value>, key: &str) -> Result<Value> {
    match json_text(first.and_then(|f| f.get(key))) {
        None => Ok(Value::Null),
        Some(t) => t.trim().parse::<i32>().map(|n| json!(n)).map_err(|_| {
            StoreError::invalid(format!("invalid input syntax for type integer: \"{t}\""))
        }),
    }
}

/// `readSourceMovementRows(binding)`: the three statements readSourceMovement runs for one source
/// binding. `watermark` is always one row (`MOVEMENT_WATERMARK_SQL`): the newest committed
/// managed-sync completion under the incarnation, and how many managed-sync requests are queued or
/// running and since when. `head` is the worktree's head unfinished request, the running one first,
/// then by sequence, or null. `hold` is the git hold summary's counters for the source and
/// incarnation, or null.
pub(crate) fn source_movement_rows_in(
    read: &dyn KvRead,
    now: i64,
    source_id: &str,
    worktree_id: &str,
    source_incarnation: &str,
) -> Result<Value> {
    let requests = all_requests(read)?;
    let on_worktree = |r: &&RequestRecord| {
        request_worktree(r).is_some_and(|w| w.eq_ignore_ascii_case(worktree_id))
    };
    // `ORDER BY r.completed_at DESC LIMIT 1`: a null completion sorts first.
    let committed: Vec<Option<i64>> = requests
        .iter()
        .filter(on_worktree)
        .filter(|r| {
            r.state == "committed"
                && r.source_incarnation
                    .eq_ignore_ascii_case(source_incarnation)
                && managed_sync(r)
        })
        .map(|r| r.completed_at_us)
        .collect();
    let last_commit = if committed.iter().any(Option::is_none) {
        None
    } else {
        committed.iter().flatten().max().copied()
    };
    let admitted: Vec<&RequestRecord> = requests
        .iter()
        .filter(on_worktree)
        .filter(|r| (r.state == "queued" || r.state == "running") && managed_sync(r))
        .collect();
    let head = requests
        .iter()
        .filter(on_worktree)
        .filter(|r| matches!(r.state.as_str(), "queued" | "running" | "recovering"))
        .min_by_key(|r| (r.state != "running", r.sequence))
        .map(|r| {
            json!({
                "request_id": r.request_id.to_lowercase(),
                "state": r.state,
                "claim_phase": r.extra.get("claim_phase").cloned().unwrap_or(Value::Null),
                "execution_token": r.extra.get("execution_token").and_then(Value::as_str),
                "claim_lapsed": extra_time(r, "claim_expires_at").is_some_and(|t| t < now),
                "publication_started": extra_bool(r, "publication_started"),
            })
        });
    let mut hold = Value::Null;
    if let Value::Array(rows) = list_op_checkpoint_records_in(read, "sync-hold-summary")? {
        for row in &rows {
            let first = row["completed_keys"].get(0);
            let text = |k: &str| json_text(first.and_then(|f| f.get(k)));
            if text("source_id").as_deref() == Some(source_id)
                && text("incarnation").as_deref() == Some(source_incarnation)
            {
                hold = json!({
                    "count": hold_int(first, "count")?,
                    "stalled": hold_int(first, "stalled")?,
                    "fences": hold_int(first, "fences")?,
                    "concurrent": hold_int(first, "concurrent")?,
                    "updated_at": row["updated_at_us"].as_i64().map(iso),
                });
                break;
            }
        }
    }
    Ok(json!({
        "watermark": {
            "last_commit_at": last_commit.map(iso),
            "admitted": admitted.len(),
            "admitted_since": admitted.iter().map(|r| r.created_at_us).min().map(iso),
        },
        "head": head,
        "hold": hold,
    }))
}

/// `readLiveSyncJobId(sourceId)` (`LIVE_SYNC_JOB_SQL`): the active `sync` job, outside the drain
/// lease queue, whose lock is live and that drains `source_id` (its `sourceId` or `source_id`, or,
/// when it names none, its `repoPath`: none for `default`, else the source's path); by `started_at`
/// (a null last), then id.
pub(crate) fn live_sync_job_id_in(
    read: &dyn KvRead,
    now: i64,
    source_id: &str,
) -> Result<Option<i64>> {
    let local_path = all_sources(read)?
        .into_iter()
        .find(|s| s.id == source_id)
        .and_then(|s| s.local_path);
    let mut jobs: Vec<_> = crate::jobs::active_job_rows(read)?
        .into_iter()
        .filter(|j| {
            let text = |k: &str| json_text(j.data.get(k));
            let named = text("sourceId").or_else(|| text("source_id"));
            let drains = match named {
                Some(named) => named == source_id,
                None => match text("repoPath") {
                    None => source_id == "default",
                    Some(repo) => local_path.as_deref() == Some(repo.as_str()),
                },
            };
            j.name == "sync"
                && j.lock_until.is_some_and(|l| l > now)
                && j.queue != "gbrain-drain-lease"
                && drains
        })
        .collect();
    jobs.sort_by_key(|j| (j.started_at.is_none(), j.started_at, j.id));
    Ok(jobs.first().map(|j| j.id))
}

/// `e.data ? key`.
fn data_has(e: &EffectRecord, key: &str) -> bool {
    e.data.as_object().is_some_and(|d| d.contains_key(key))
}

/// `e.data ? 'parked' AND NOT (e.data ? 'settled')`, and in `source_ids` when given.
fn parked_unsettled(e: &EffectRecord, source_ids: Option<&[String]>) -> bool {
    data_has(e, "parked")
        && !data_has(e, "settled")
        && source_ids.is_none_or(|ids| in_scope(e.source_id.as_deref(), Some(ids)))
}

/// `countParkedEffects(sourceIds)`: the effects that recorded a parked target and are not settled.
pub(crate) fn parked_effect_count_in(
    read: &dyn KvRead,
    source_ids: Option<&[String]>,
) -> Result<i64> {
    Ok(all_effects(read)?
        .iter()
        .filter(|e| parked_unsettled(e, source_ids))
        .count() as i64)
}

/// `listParkedEffects(sourceIds)`: the first 20 of those effects by id, each with its request
/// (`to_jsonb(r)`), source, kind, state, parked targets and whether the binding it was parked under
/// is gone (`former_binding`, false for an effect on no worktree).
pub(crate) fn parked_effect_rows_in(
    read: &dyn KvRead,
    source_ids: Option<&[String]>,
) -> Result<Vec<Value>> {
    let requests: BTreeMap<String, RequestRecord> = all_requests(read)?
        .into_iter()
        .map(|r| (r.id.clone(), r))
        .collect();
    let bindings: BTreeMap<String, SourceBindingRecord> =
        scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?
            .into_iter()
            .map(|b| (b.source_id.clone(), b))
            .collect();
    let mut effects = all_effects(read)?;
    effects.sort_by_key(|e| e.id);
    Ok(effects
        .iter()
        .filter(|e| parked_unsettled(e, source_ids))
        .filter_map(|e| {
            let r = requests.get(&e.request_id)?;
            let held = match &e.worktree_id {
                None => true,
                Some(w) => e
                    .source_id
                    .as_ref()
                    .and_then(|s| bindings.get(s))
                    .is_some_and(|b| {
                        b.worktree_id.eq_ignore_ascii_case(w)
                            && e.source_incarnation
                                .as_deref()
                                .is_some_and(|i| b.source_incarnation.eq_ignore_ascii_case(i))
                    }),
            };
            Some(json!({
                "request": r.to_row(),
                "source_id": e.source_id,
                "kind": e.kind,
                "state": e.state,
                "parked": crate::jsonb::order(e.data.get("parked").cloned().unwrap_or(Value::Null)),
                "former_binding": !held,
            }))
        })
        .take(20)
        .collect())
}

/// `listGitPushHoldRows(codes, sourceIds)`: the Git effects queued, running or failed, with no
/// recovery and not settled, whose code is one of `codes` (a parked effect's code is its first
/// parked target's code that is one of them), per source and worktree by source id in byte order:
/// the worktree's first host path in byte order, whether the source is bound elsewhere now, how
/// many retry and how many are parked, the codes in byte order and the oldest request.
pub(crate) fn git_push_hold_rows_in(
    read: &dyn KvRead,
    codes: &[String],
    source_ids: Option<&[String]>,
) -> Result<Vec<Value>> {
    let requests: BTreeMap<String, RequestRecord> = all_requests(read)?
        .into_iter()
        .map(|r| (r.id.clone(), r))
        .collect();
    let bindings = scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?;
    let hosts = scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding")?;
    let listed = |c: &str| codes.iter().any(|x| x == c);
    #[derive(Default)]
    struct Hold {
        retrying: i64,
        parked: i64,
        codes: BTreeSet<String>,
        oldest: Option<i64>,
    }
    type Key = (Option<String>, Option<String>);
    let mut groups: Vec<(Key, Hold)> = Vec::new();
    for e in all_effects(read)? {
        let held = e.kind == "git"
            && matches!(e.state.as_str(), "queued" | "running" | "failed")
            && e.recovery.is_none()
            && !data_has(&e, "settled")
            && in_scope(e.source_id.as_deref(), source_ids);
        let Some(r) = requests.get(&e.request_id).filter(|_| held) else {
            continue;
        };
        let code = if e.error_code.as_deref() == Some("targets_parked") {
            match e.data.get("parked") {
                Some(Value::Array(items)) => items
                    .iter()
                    .filter_map(|p| json_text(p.as_object().and_then(|o| o.get("error_code"))))
                    .find(|c| listed(c)),
                _ => None,
            }
        } else {
            e.error_code.clone()
        };
        let Some(code) = code.filter(|c| listed(c)) else {
            continue;
        };
        let key: Key = (
            e.source_id.clone(),
            e.worktree_id.as_ref().map(|w| w.to_lowercase()),
        );
        let at = match groups.iter().position(|(k, _)| *k == key) {
            Some(at) => at,
            None => {
                groups.push((key, Hold::default()));
                groups.len() - 1
            }
        };
        let g = &mut groups[at].1;
        if e.state == "failed" {
            g.parked += 1;
        } else {
            g.retrying += 1;
        }
        g.codes.insert(code);
        g.oldest = Some(g.oldest.map_or(r.created_at_us, |o| o.min(r.created_at_us)));
    }
    groups.sort_by(|(a, _), (b, _)| nulls_last(a.0.as_deref(), b.0.as_deref()));
    Ok(groups
        .into_iter()
        .map(|((source_id, worktree), g)| {
            let root = worktree.as_ref().and_then(|w| {
                hosts
                    .iter()
                    .filter(|h| h.worktree_id.eq_ignore_ascii_case(w))
                    .map(|h| h.local_path.clone())
                    .min_by(|a, b| a.as_bytes().cmp(b.as_bytes()))
            });
            let bound = bindings.iter().any(|b| {
                Some(b.source_id.as_str()) == source_id.as_deref()
                    && worktree
                        .as_deref()
                        .is_some_and(|w| b.worktree_id.eq_ignore_ascii_case(w))
            });
            json!({
                "source_id": source_id,
                "root": root,
                "former_worktree": !bound,
                "retrying": g.retrying,
                "parked": g.parked,
                "codes": g.codes.into_iter().collect::<Vec<_>>(),
                "oldest_at": g.oldest.map(iso),
            })
        })
        .collect())
}

impl Store {
    /// `listStalledCatchupRows(sourceIds, stallMs)`.
    pub fn stalled_catchup_rows(
        &self,
        source_ids: Option<&[String]>,
        stall_ms: f64,
    ) -> Result<Vec<Value>> {
        stalled_catchup_rows_in(&*self.read()?, self.env.now_micros(), source_ids, stall_ms)
    }

    /// `listParkedGroupRows(sourceIds)`.
    pub fn parked_group_rows(&self, source_ids: Option<&[String]>) -> Result<Vec<Value>> {
        parked_group_rows_in(&*self.read()?, source_ids)
    }

    /// `listSourceBindingsForMovement(sourceIds)`.
    pub fn movement_binding_rows(&self, source_ids: Option<&[String]>) -> Result<Vec<Value>> {
        movement_binding_rows_in(&*self.read()?, source_ids)
    }

    /// `readSourceMovementRows(binding)`.
    pub fn source_movement_rows(
        &self,
        source_id: &str,
        worktree_id: &str,
        source_incarnation: &str,
    ) -> Result<Value> {
        source_movement_rows_in(
            &*self.read()?,
            self.env.now_micros(),
            source_id,
            worktree_id,
            source_incarnation,
        )
    }

    /// `readLiveSyncJobId(sourceId)`.
    pub fn live_sync_job_id(&self, source_id: &str) -> Result<Option<i64>> {
        live_sync_job_id_in(&*self.read()?, self.env.now_micros(), source_id)
    }

    /// `countParkedEffects(sourceIds)`.
    pub fn parked_effect_count(&self, source_ids: Option<&[String]>) -> Result<i64> {
        parked_effect_count_in(&*self.read()?, source_ids)
    }

    /// `listParkedEffects(sourceIds)`.
    pub fn parked_effect_rows(&self, source_ids: Option<&[String]>) -> Result<Vec<Value>> {
        parked_effect_rows_in(&*self.read()?, source_ids)
    }

    /// `listGitPushHoldRows(codes, sourceIds)`.
    pub fn git_push_hold_rows(
        &self,
        codes: &[String],
        source_ids: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        git_push_hold_rows_in(&*self.read()?, codes, source_ids)
    }
}
