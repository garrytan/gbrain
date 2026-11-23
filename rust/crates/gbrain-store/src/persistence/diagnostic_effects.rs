//! Effect and binding reads of the persistence doctor and writer status
//! (`src/core/engine-sql/doctor-persistence.ts`; rust/docs/store/cli-reads-doctor-per.md): the stalled
//! catch-ups (`listStalledCatchupRows`), the parked Git target groups (`listParkedGroupRows`) and the
//! source bindings a sync-movement read compares (`listSourceBindingsForMovement`).
//!
//! Each read answers what its statement answers on Postgres, from the effect, request, worktree,
//! binding and source records. Text keys sort in byte order (`COLLATE "C"`); `now()` is the store clock.
//!
//! Where the store differs from Postgres: a `busy_since` that is not a timestamp or a `busy_retries`
//! that is not an integer refuses the read (Postgres raises on the cast too), and `min(rule)` takes
//! the byte-least rule where Postgres takes the least in the database collation (the rules gbrain
//! writes are lower-case ASCII words, which sort alike).

use super::effects::{EffectRecord, all_effects};
use super::projection_queue::parse_timestamptz;
use super::worktrees::{
    SOURCE_BINDING, SourceBindingRecord, WORKTREE, WorktreeRecord, scan_records,
};
use super::{all_requests, json_text};
use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::sources::all_sources;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// `$1::text[] IS NULL OR e.source_id=ANY($1::text[])`.
fn in_scope(source_ids: Option<&[String]>, source: Option<&str>) -> bool {
    match source_ids {
        None => true,
        Some(ids) => source.is_some_and(|s| ids.iter().any(|id| id == s)),
    }
}

/// `e.data->>'busy_retries'` cast to int, or `None` for SQL null.
fn busy_retries(e: &EffectRecord) -> Result<Option<i64>> {
    match json_text(e.data.get("busy_retries")) {
        None => Ok(None),
        Some(text) => {
            text.trim().parse::<i64>().map(Some).map_err(|_| {
                StoreError::invalid(format!("busy_retries is not an integer: {text:?}"))
            })
        }
    }
}

/// `listStalledCatchupRows(sourceIds, stallMs)`: per source, the queued `writer_busy` effects that
/// carry `busy_since`, how many of them waited longer than `stall_ms`, the oldest `busy_since` and
/// the most busy retries; by source id in byte order.
pub(crate) fn list_stalled_catchup_rows_in(
    read: &dyn KvRead,
    now: i64,
    source_ids: Option<&[String]>,
    stall_ms: f64,
) -> Result<Value> {
    #[derive(Default)]
    struct Group {
        stalled: i64,
        busy: i64,
        since: Option<i64>,
        retries: Option<i64>,
    }
    let cutoff = now as f64 - stall_ms * 1000.0;
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for e in all_effects(read)? {
        if e.state != "queued" || e.error_code.as_deref() != Some("writer_busy") {
            continue;
        }
        let Some(since) = e.data.get("busy_since") else {
            continue;
        };
        if !in_scope(source_ids, e.source_id.as_deref()) {
            continue;
        }
        let since = match json_text(Some(since)) {
            Some(text) => Some(parse_timestamptz(&text, "busy_since")?),
            None => None,
        };
        let retries = busy_retries(&e)?;
        let g = groups
            .entry(e.source_id.clone().unwrap_or_default())
            .or_default();
        g.busy += 1;
        if let Some(since) = since {
            if (since as f64) < cutoff {
                g.stalled += 1;
            }
            g.since = Some(g.since.map_or(since, |s| s.min(since)));
        }
        if let Some(r) = retries {
            g.retries = Some(g.retries.map_or(r, |m| m.max(r)));
        }
    }
    Ok(Value::Array(
        groups
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
            .collect(),
    ))
}

/// `listParkedGroupRows(sourceIds)`: the parked targets of failed, unsettled Git effects (one row per
/// element of `data.parked`), grouped by source, parked error code and former binding; by source id,
/// code and former binding in byte order, a null former binding first.
pub(crate) fn list_parked_group_rows_in(
    read: &dyn KvRead,
    source_ids: Option<&[String]>,
) -> Result<Value> {
    // The key of a group: source id, code and former binding, each SQL null as `None`.
    type Key = (Option<String>, Option<String>, Option<String>);
    #[derive(Default)]
    struct Group {
        effects: BTreeSet<i64>,
        targets: i64,
        rule: Option<String>,
        worktrees: BTreeSet<Option<String>>,
        requests: BTreeSet<String>,
    }
    let requests: HashMap<String, String> = all_requests(read)?
        .into_iter()
        .map(|r| (r.id, r.request_id))
        .collect();
    let bindings: Vec<SourceBindingRecord> = scan_records(read, SOURCE_BINDING, "source binding")?;
    let sources = all_sources(read)?;
    let mut groups: BTreeMap<Key, Group> = BTreeMap::new();
    for e in all_effects(read)? {
        if e.kind != "git"
            || e.state != "failed"
            || e.error_code.as_deref() != Some("targets_parked")
            || e.data.get("settled").is_some()
            || !in_scope(source_ids, e.source_id.as_deref())
        {
            continue;
        }
        let Some(Value::Array(parked)) = e.data.get("parked") else {
            continue;
        };
        // The JOIN persistence_requests r ON r.id=e.request_id.
        let Some(request_id) = requests.get(&e.request_id) else {
            continue;
        };
        let incarnation = e.source_incarnation.as_deref();
        let former = match &e.worktree_id {
            None => None,
            Some(w)
                if bindings.iter().any(|b| {
                    Some(b.source_id.as_str()) == e.source_id.as_deref()
                        && &b.worktree_id == w
                        && Some(b.source_incarnation.as_str()) == incarnation
                }) =>
            {
                None
            }
            Some(_)
                if sources.iter().any(|s| {
                    Some(s.id.as_str()) == e.source_id.as_deref()
                        && !s.archived
                        && Some(s.incarnation.as_str()) == incarnation
                }) =>
            {
                Some("binding_changed".to_owned())
            }
            Some(_) => Some("source_replaced".to_owned()),
        };
        for p in parked {
            let code = json_text(p.get("error_code"));
            let rule = json_text(p.get("rule"));
            let g = groups
                .entry((e.source_id.clone(), code, former.clone()))
                .or_default();
            g.effects.insert(e.id);
            g.targets += 1;
            if let Some(rule) = rule {
                g.rule = Some(match g.rule.take() {
                    Some(least) if least <= rule => least,
                    _ => rule,
                });
            }
            g.worktrees.insert(e.worktree_id.clone());
            g.requests.insert(request_id.clone());
        }
    }
    let mut rows: Vec<(Key, Group)> = groups.into_iter().collect();
    // ORDER BY source_id, code, former COLLATE "C" NULLS FIRST: a null source id or code sorts last
    // (ascending), a null former binding first.
    rows.sort_by(|((sa, ca, fa), _), ((sb, cb, fb), _)| {
        let nulls_last = |a: &Option<String>, b: &Option<String>| match (a, b) {
            (Some(a), Some(b)) => a.as_bytes().cmp(b.as_bytes()),
            (None, None) => std::cmp::Ordering::Equal,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(_), None) => std::cmp::Ordering::Less,
        };
        nulls_last(sa, sb)
            .then_with(|| nulls_last(ca, cb))
            .then_with(|| match (fa, fb) {
                (Some(a), Some(b)) => a.as_bytes().cmp(b.as_bytes()),
                (None, None) => std::cmp::Ordering::Equal,
                (None, Some(_)) => std::cmp::Ordering::Less,
                (Some(_), None) => std::cmp::Ordering::Greater,
            })
    });
    Ok(Value::Array(
        rows.into_iter()
            .map(|((source_id, code, former), g)| {
                let current = source_id.as_deref().and_then(|s| {
                    bindings
                        .iter()
                        .find(|b| b.source_id == s)
                        .map(|b| b.worktree_id.clone())
                });
                // array_agg(DISTINCT x) lists the values ascending, a null last.
                let mut worktrees: Vec<Option<String>> = g.worktrees.into_iter().collect();
                worktrees.sort_by(|a, b| match (a, b) {
                    (Some(a), Some(b)) => a.as_bytes().cmp(b.as_bytes()),
                    (None, None) => std::cmp::Ordering::Equal,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (Some(_), None) => std::cmp::Ordering::Less,
                });
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
            .collect(),
    ))
}

/// `listSourceBindingsForMovement(sourceIds)`: each binding whose source exists at the bound
/// incarnation and whose worktree exists, with the worktree's owner host; by source id in byte order.
pub(crate) fn list_source_bindings_for_movement_in(
    read: &dyn KvRead,
    source_ids: Option<&[String]>,
) -> Result<Value> {
    let sources = all_sources(read)?;
    let worktrees: HashMap<String, WorktreeRecord> =
        scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")?
            .into_iter()
            .map(|w| (w.id.clone(), w))
            .collect();
    let mut rows: Vec<(String, Value)> = Vec::new();
    for b in scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")? {
        if !in_scope(source_ids, Some(&b.source_id))
            || !sources
                .iter()
                .any(|s| s.id == b.source_id && s.incarnation == b.source_incarnation)
        {
            continue;
        }
        let Some(w) = worktrees.get(&b.worktree_id) else {
            continue;
        };
        rows.push((
            b.source_id.clone(),
            json!({
                "source_id": b.source_id,
                "worktree_id": b.worktree_id,
                "source_incarnation": b.source_incarnation,
                "owner_host_id": w.owner_host_id,
            }),
        ));
    }
    rows.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Ok(Value::Array(rows.into_iter().map(|(_, row)| row).collect()))
}

impl Store {
    /// `listSourceBindingsForMovement(sourceIds)`.
    pub fn list_source_bindings_for_movement(
        &self,
        source_ids: Option<&[String]>,
    ) -> Result<Value> {
        list_source_bindings_for_movement_in(&*self.read()?, source_ids)
    }

    /// `listStalledCatchupRows(sourceIds, stallMs)`.
    pub fn list_stalled_catchup_rows(
        &self,
        source_ids: Option<&[String]>,
        stall_ms: f64,
    ) -> Result<Value> {
        list_stalled_catchup_rows_in(&*self.read()?, self.env.now_micros(), source_ids, stall_ms)
    }

    /// `listParkedGroupRows(sourceIds)`.
    pub fn list_parked_group_rows(&self, source_ids: Option<&[String]>) -> Result<Value> {
        list_parked_group_rows_in(&*self.read()?, source_ids)
    }
}
