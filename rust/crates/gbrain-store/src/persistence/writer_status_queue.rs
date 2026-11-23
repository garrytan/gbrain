//! The three queue reads of `gbrain sources writer status` that the doctor checks share
//! (`listStalledCatchupRows`, `listParkedGroupRows` and `listSourceBindingsForMovement` in
//! `src/core/engine-sql/doctor-persistence.ts`; rust/docs/store/persistence.md, "Writer status").
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
    SOURCE_BINDING, SourceBindingRecord, WORKTREE, WorktreeRecord, scan_records,
};
use super::{RequestRecord, all_requests, json_text};
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
            if let Some(rule) = field("rule") {
                if g.rule
                    .as_ref()
                    .is_none_or(|least| rule.as_bytes() < least.as_bytes())
                {
                    g.rule = Some(rule);
                }
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
}
