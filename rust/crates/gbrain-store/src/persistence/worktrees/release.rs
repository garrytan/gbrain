//! Writer activation, deactivation and the pre-activation claim release: the store work of
//! `src/core/engine-sql/writer-release.ts` (rust/docs/store/persistence.md, "Writer release").
//!
//! The brain mode is one record, `d 0x09 0x04` (`BrainModeRecord`, JSON): `enabled`, `mode_epoch`
//! and the first activation time. A brain with no record is classic (`enabled` false) at epoch 1,
//! the `persistence_brain` column defaults. Activation and deactivation move the epoch by one.
//!
//! A release retires worktrees (state `retired`, the row is kept) and deletes their bindings, as
//! the SQL does. The reads return the rows the SQL returns; the blocker texts, the checks and the
//! error texts stay in the TypeScript persistence files. This engine serializes its write
//! transactions, so the SQL row locks have no counterpart here.

use super::super::effects::{EffectRecord, all_effects};
use super::super::topology::{committed_outcomes_in, recovering_topology_rows_in};
use super::super::{CounterRecord, all_requests, extra_is_null, read_counter, write_counter};
use super::{
    HOST_BINDING, HostBindingRecord, SOURCE_BINDING, SourceBindingRecord, WORKTREE, WorktreeRecord,
    kind_text, scan_records, worktree_key,
};
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::jobs::release_lock_rows;
use crate::journal::RequestRecord;
use crate::kv::{KvRead, KvWrite};
use crate::pages::{PageRecord, all_pages};
use crate::sources::{all_sources, read_source};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

const BRAIN_MODE: u8 = 0x04;

/// The request states that keep the brain from quiescing (`BLOCKING_REQUESTS_SQL`).
const OUTSTANDING: [&str; 4] = ["queued", "deferred", "running", "recovering"];

/// The `persistence_brain` columns a writer activation changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct BrainModeRecord {
    pub(crate) enabled: bool,
    pub(crate) mode_epoch: i64,
    #[serde(default)]
    pub(crate) activated_at_us: Option<i64>,
}

impl Default for BrainModeRecord {
    fn default() -> Self {
        Self {
            enabled: false,
            mode_epoch: 1,
            activated_at_us: None,
        }
    }
}

fn brain_mode_key() -> Vec<u8> {
    vec![keys::PERSISTENCE, super::super::WORKTREES, BRAIN_MODE]
}

/// The stored brain mode, or the column defaults.
pub(crate) fn brain_mode_in(read: &dyn KvRead) -> Result<BrainModeRecord> {
    Ok(get_json::<BrainModeRecord>(read, &brain_mode_key())?.unwrap_or_default())
}

/// `setBrainEnabled(enabled)`: moves the epoch by one and returns it as text. Turning managed
/// persistence on records the first activation time. A store with no brain id has no brain row
/// to update and refuses.
pub(crate) fn set_brain_enabled_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    brain_id: &str,
    enabled: bool,
) -> Result<String> {
    if brain_id.is_empty() {
        return Err(StoreError::invalid(
            "this brain has no persistence brain row",
        ));
    }
    let mut mode = brain_mode_in(&*tx)?;
    mode.enabled = enabled;
    mode.mode_epoch += 1;
    if enabled && mode.activated_at_us.is_none() {
        mode.activated_at_us = Some(env.now_micros());
    }
    put_json(tx, &brain_mode_key(), &mode)?;
    Ok(mode.mode_epoch.to_string())
}

/// `releaseBindings(worktreeIds)`: retires the named worktrees (every worktree with `None`),
/// deletes every source binding and deletes the host bindings of the retired worktrees.
pub(crate) fn release_worktree_bindings_in(
    tx: &mut dyn KvWrite,
    worktree_ids: Option<&[String]>,
) -> Result<()> {
    let named =
        |id: &str| worktree_ids.is_none_or(|ids| ids.iter().any(|w| w.eq_ignore_ascii_case(id)));
    for mut w in scan_records::<WorktreeRecord>(&*tx, WORKTREE, "worktree")? {
        if named(&w.id) && w.state != "retired" {
            w.state = "retired".into();
            put_json(tx, &worktree_key(&w.id), &w)?;
        }
    }
    for b in scan_records::<SourceBindingRecord>(&*tx, SOURCE_BINDING, "source binding")? {
        tx.delete(&super::source_binding_key(&b.source_id))?;
    }
    for h in scan_records::<HostBindingRecord>(&*tx, HOST_BINDING, "host binding")? {
        if named(&h.worktree_id) {
            tx.delete(&super::host_binding_key(&h.worktree_id, &h.host_id))?;
        }
    }
    Ok(())
}

/// The amounts `addPersistenceCounters(key, delta)` adds; an absent column adds 0.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(default)]
pub struct CounterDelta {
    pub lifetime_ids: i64,
    pub terminal_bytes: i64,
    pub outstanding_count: i64,
    pub intent_bytes: i64,
    pub recovery_bytes: i64,
}

/// `addPersistenceCounters(key, delta)`: one UPDATE of an existing row (a missing row changes
/// nothing); a column that would go below zero refuses as the CHECK does.
pub(crate) fn add_persistence_counters_in(
    tx: &mut dyn KvWrite,
    key: &str,
    delta: &CounterDelta,
) -> Result<()> {
    let Some(c) = read_counter(&*tx, key)? else {
        return Ok(());
    };
    let next = CounterRecord {
        lifetime_ids: c.lifetime_ids + delta.lifetime_ids,
        terminal_bytes: c.terminal_bytes + delta.terminal_bytes,
        outstanding_count: c.outstanding_count + delta.outstanding_count,
        intent_bytes: c.intent_bytes + delta.intent_bytes,
        recovery_bytes: c.recovery_bytes + delta.recovery_bytes,
    };
    write_counter(tx, key, &next)
}

/// One read of `writerReleaseStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReleaseRead {
    BlockingRequests {
        limit: usize,
    },
    RecoveringTopologyChanges,
    ReleaseEffects {
        which: String,
    },
    HasRecoveringEffect,
    LiveLeases,
    LiveWorktreeRoots,
    ClaimRoots,
    BoundSourceIds,
    SourceBindingCount,
    LiveBoundSourceCount,
    ConfiguredSources,
    SourceLocalPaths,
    HostBindingRoots,
    RetiredDeactivations,
    BrainMode,
    /// The activation preview's drift audit (persistence/reconcile-audit.ts): the source's live markdown pages after
    /// `after`, by slug, at most `limit`.
    AuditPages {
        #[serde(rename = "sourceId")]
        source_id: String,
        after: String,
        limit: usize,
    },
}

fn has_value(v: &Option<Value>) -> bool {
    v.as_ref().is_some_and(|v| !v.is_null())
}

/// jsonb `data ? 'settled'`: an object key, an array string element or the string itself.
fn has_settled(data: &Value) -> bool {
    match data {
        Value::Object(map) => map.contains_key("settled"),
        Value::Array(items) => items.iter().any(|v| v.as_str() == Some("settled")),
        Value::String(s) => s == "settled",
        _ => false,
    }
}

fn live_incarnation(read: &dyn KvRead, source_id: &str, incarnation: &str) -> Result<bool> {
    Ok(read_source(read, source_id)?.is_some_and(|s| s.incarnation == incarnation && !s.archived))
}

/// The effects joined to their requests by the request's internal id, by effect id.
fn joined_effects(read: &dyn KvRead) -> Result<Vec<(EffectRecord, RequestRecord)>> {
    let requests: HashMap<String, RequestRecord> = all_requests(read)?
        .into_iter()
        .map(|r| (r.id.clone(), r))
        .collect();
    let mut rows: Vec<(EffectRecord, RequestRecord)> = all_effects(read)?
        .into_iter()
        .filter_map(|e| requests.get(&e.request_id).cloned().map(|r| (e, r)))
        .collect();
    rows.sort_by_key(|(e, _)| e.id);
    Ok(rows)
}

fn effect_source(e: &EffectRecord, r: &RequestRecord) -> String {
    e.source_id.clone().unwrap_or_else(|| r.source_id.clone())
}

/// Each row's host roots by local path, one row with a null root when it has none.
fn with_roots(
    hosts: &[HostBindingRecord],
    worktree_id: &str,
    row: impl Fn(Value) -> Value,
) -> Vec<Value> {
    let mut roots: Vec<&str> = hosts
        .iter()
        .filter(|h| h.worktree_id == worktree_id)
        .map(|h| h.local_path.as_str())
        .collect();
    roots.sort_unstable();
    if roots.is_empty() {
        return vec![row(Value::Null)];
    }
    roots.into_iter().map(|root| row(json!(root))).collect()
}

/// `writerReleaseStore()`'s reads: the rows of the SQL each one replaces.
pub(crate) fn writer_release_rows_in(
    read: &dyn KvRead,
    env: &dyn Env,
    what: &ReleaseRead,
) -> Result<Value> {
    let bindings = || scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding");
    let hosts = || scan_records::<HostBindingRecord>(read, HOST_BINDING, "host binding");
    Ok(match what {
        ReleaseRead::BlockingRequests { limit } => {
            let mut rows: Vec<RequestRecord> = all_requests(read)?
                .into_iter()
                .filter(|r| {
                    OUTSTANDING.contains(&r.state.as_str()) || !extra_is_null(r, "recovery")
                })
                .collect();
            rows.sort_by_key(|r| r.sequence);
            Value::Array(
                rows.iter()
                    .take(*limit)
                    .map(|r| {
                        json!({
                            "request_id": r.request_id,
                            "source_id": r.source_id,
                            "slug": r.slug,
                            "operation": r.operation,
                            "state": r.state,
                            "recovering": !extra_is_null(r, "recovery"),
                        })
                    })
                    .collect(),
            )
        }
        ReleaseRead::RecoveringTopologyChanges => Value::Array(recovering_topology_rows_in(read)?),
        ReleaseRead::ReleaseEffects { which } => {
            let failed = match which.as_str() {
                "failed" => true,
                "blocking" => false,
                _ => {
                    return Err(StoreError::invalid(
                        "releaseEffects takes blocking or failed",
                    ));
                }
            };
            let mut rows = Vec::new();
            for (e, r) in joined_effects(read)? {
                let keep = if failed {
                    e.state == "failed" && !has_value(&e.recovery) && !has_settled(&e.data)
                } else {
                    e.state == "queued" || e.state == "running" || has_value(&e.recovery)
                };
                if !keep {
                    continue;
                }
                rows.push(json!({
                    "effect_id": e.id.to_string(),
                    "kind": e.kind,
                    "state": e.state,
                    "source_id": effect_source(&e, &r),
                    "request_id": r.request_id,
                    "error_code": e.error_code,
                    "recovering": has_value(&e.recovery),
                    "source_live": live_incarnation(read, &r.source_id, &r.source_incarnation)?,
                }));
                if rows.len() == 50 {
                    break;
                }
            }
            Value::Array(rows)
        }
        ReleaseRead::HasRecoveringEffect => {
            json!(all_effects(read)?.iter().any(|e| has_value(&e.recovery)))
        }
        ReleaseRead::LiveLeases => Value::Array(release_lock_rows(read, env.now_micros())?),
        ReleaseRead::LiveWorktreeRoots => {
            let hosts = hosts()?;
            let mut rows = Vec::new();
            for w in scan_records::<WorktreeRecord>(read, WORKTREE, "worktree")? {
                if w.state != "retired" {
                    rows.extend(with_roots(
                        &hosts,
                        &w.id,
                        |root| json!({ "id": w.id, "root": root }),
                    ));
                }
            }
            Value::Array(rows)
        }
        ReleaseRead::ClaimRoots => {
            let hosts = hosts()?;
            let mut rows = Vec::new();
            for b in bindings()? {
                rows.extend(with_roots(&hosts, &b.worktree_id, |root| {
                    json!({ "source_id": b.source_id, "worktree_id": b.worktree_id, "root": root })
                }));
            }
            Value::Array(rows)
        }
        ReleaseRead::BoundSourceIds => Value::Array(
            bindings()?
                .into_iter()
                .map(|b| json!(b.source_id))
                .collect(),
        ),
        ReleaseRead::SourceBindingCount => json!(bindings()?.len()),
        ReleaseRead::LiveBoundSourceCount => {
            let mut n = 0usize;
            for b in bindings()? {
                if live_incarnation(read, &b.source_id, &b.source_incarnation)? {
                    n += 1;
                }
            }
            json!(n)
        }
        ReleaseRead::ConfiguredSources => {
            let mut sources = all_sources(read)?;
            sources.retain(|s| !s.archived);
            sources.sort_by(|a, b| a.id.as_bytes().cmp(b.id.as_bytes()));
            Value::Array(
                sources
                    .iter()
                    .map(|s| {
                        json!({
                            "id": s.id,
                            "incarnation": s.incarnation,
                            "local_path": s.local_path,
                            "kind": kind_text(&s.config),
                        })
                    })
                    .collect(),
            )
        }
        ReleaseRead::SourceLocalPaths => Value::Array(
            all_sources(read)?
                .into_iter()
                .filter_map(|s| s.local_path.map(Value::String))
                .collect(),
        ),
        ReleaseRead::HostBindingRoots => {
            Value::Array(hosts()?.into_iter().map(|h| json!(h.local_path)).collect())
        }
        ReleaseRead::RetiredDeactivations => {
            Value::Array(committed_outcomes_in(read, "writer_deactivate")?)
        }
        ReleaseRead::BrainMode => {
            let mode = brain_mode_in(read)?;
            json!({ "enabled": mode.enabled, "mode_epoch": mode.mode_epoch.to_string() })
        }
        ReleaseRead::AuditPages {
            source_id,
            after,
            limit,
        } => {
            let mut pages: Vec<PageRecord> = all_pages(read)?
                .into_iter()
                .filter(|p| {
                    p.source_id == *source_id
                        && p.deleted_at_us.is_none()
                        && p.page_kind == "markdown"
                        && p.slug.as_bytes() > after.as_bytes()
                })
                .collect();
            pages.sort_by(|a, b| a.slug.as_bytes().cmp(b.slug.as_bytes()));
            Value::Array(
                pages
                    .iter()
                    .take(*limit)
                    .map(|p| {
                        // octet_length of a NULL (segmented) body is NULL, and so is the sum.
                        let bytes = p.compiled_truth.as_deref().map(|truth| {
                            truth.len()
                                + p.timeline.len()
                                + Value::Object(p.frontmatter.clone()).to_string().len()
                        });
                        json!({
                            "slug": p.slug,
                            "source_path": p.source_path,
                            "source_uri": p.source_uri,
                            "database_only_reason": Value::Null,
                            "bytes": bytes,
                        })
                    })
                    .collect(),
            )
        }
    })
}

impl Store {
    /// One `writerReleaseStore()` read (`ReleaseRead`) as JSON.
    pub fn writer_release_rows(&self, what: &ReleaseRead) -> Result<Value> {
        writer_release_rows_in(&*self.read()?, &*self.env, what)
    }

    /// `pauseManagedPersistence()`: one store write. Reads the brain mode and the count of recorded
    /// topology changes and turns `enabled` off with no epoch bump; returns the prior
    /// `{ enabled, mode_epoch, topology_changes }` (the epoch and count as text). Nothing else moves.
    pub fn pause_managed_persistence(&self) -> Result<Value> {
        let brain_id = self.brain_id().to_string();
        self.write(|tx| {
            if brain_id.is_empty() {
                return Err(StoreError::invalid(
                    "this brain has no persistence brain row",
                ));
            }
            let mut mode = brain_mode_in(&*tx)?;
            let changes = topology_change_count(&*tx)?;
            let prior = json!({ "enabled": mode.enabled, "mode_epoch": mode.mode_epoch.to_string(), "topology_changes": changes.to_string() });
            mode.enabled = false;
            put_json(tx, &brain_mode_key(), &mode)?;
            Ok(prior)
        })
    }

    /// `restoreManagedPersistence({ enabled, mode_epoch, topology_changes })`: one compare-and-set
    /// write. Puts `enabled` back only while the brain mode is still paused (`enabled` false) at
    /// `mode_epoch` and the store holds `topology_changes` topology changes; otherwise a real
    /// activation or deactivation ran during the pause (a deactivation of a disabled brain records a
    /// topology change without moving the epoch), and nothing is written. True when it wrote.
    pub fn restore_managed_persistence(
        &self,
        enabled: bool,
        mode_epoch: &str,
        topology_changes: &str,
    ) -> Result<bool> {
        let whole = |name: &str, v: &str| -> Result<u64> {
            v.parse().map_err(|_| {
                StoreError::invalid(format!(
                    "restoreManagedPersistence: {name} is not a whole number: {v}"
                ))
            })
        };
        let epoch = i64::try_from(whole("mode_epoch", mode_epoch)?).map_err(|_| {
            StoreError::invalid("restoreManagedPersistence: mode_epoch is out of range")
        })?;
        let changes = whole("topology_changes", topology_changes)?;
        self.write(|tx| {
            let mut mode = brain_mode_in(&*tx)?;
            if mode.enabled || mode.mode_epoch != epoch || topology_change_count(&*tx)? != changes {
                return Ok(false);
            }
            mode.enabled = enabled;
            put_json(tx, &brain_mode_key(), &mode)?;
            Ok(true)
        })
    }

    /// Turns managed persistence on or off; returns the new mode epoch as text.
    pub fn set_brain_enabled(&self, enabled: bool) -> Result<String> {
        let brain_id = self.brain_id().to_string();
        self.write(|tx| set_brain_enabled_in(tx, &*self.env, &brain_id, enabled))
    }

    /// Retires the named worktrees (every worktree with `None`) and deletes their bindings.
    pub fn release_worktree_bindings(&self, worktree_ids: Option<&[String]>) -> Result<()> {
        self.write(|tx| release_worktree_bindings_in(tx, worktree_ids))
    }

    /// Adds `delta` to the counter row `key`; a missing row changes nothing.
    pub fn add_persistence_counters(&self, key: &str, delta: &CounterDelta) -> Result<()> {
        self.write(|tx| add_persistence_counters_in(tx, key, delta))
    }
}

/// How many topology changes the store holds (`SELECT count(*) FROM persistence_topology_changes`).
fn topology_change_count(read: &dyn crate::kv::KvRead) -> Result<u64> {
    let mut n = 0u64;
    crate::kv::scan_prefix(
        read,
        &[crate::keys::PERSISTENCE, crate::persistence::TOPOLOGY],
        false,
        &mut |_, _| {
            n += 1;
            true
        },
    )?;
    Ok(n)
}
