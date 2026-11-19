//! The effect journal: the post-commit work a page write queues (links, Git, embedding,
//! withdrawal mirror, ...), one durable record per `(request, kind)`, and the claim, completion
//! and release statements the TypeScript effect runner sends on a write's path.
//!
//! This ports the statements of `src/core/engine-sql/persistence-effects.ts`, not its SQL. One
//! process owns the brain and the store runs one write transaction at a time, so a claim needs no
//! row lock and a source read needs no share lock. The coordinator that decides what to queue,
//! when to retry and what an outcome says stays TypeScript.
//!
//! Not kept: worktrees, refresh fences and recovery records. They exist for crash recovery of
//! file publication, which this engine does not do. So every effect this store returns has
//! `recovery` null and `recovery_bytes` 0, a claimable effect is always one on no worktree, and
//! the publishing-recovery probe (`requestsStillPublishing`) answers in TypeScript (null).
//!
//! Keys (under `keys::PERSISTENCE`, `d`; documented in `persistence.rs`):
//! - `d E id(be8)`: the effect record, so key order is id order.
//! - `d e request-uuid \0 kind`: the `(request_id, kind)` uniqueness index, value the id (be8).
//! - meta `next_effect_id`: the id counter (ids start at 1, as a `bigserial`).

use crate::config::read_config;
use crate::env::{iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, Result, STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::next_id;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

const EFFECT: u8 = b'E';
const EFFECT_KIND: u8 = b'e';
const NEXT_EFFECT_ID: &str = "next_effect_id";
/// The claim lease `claimEffect` grants (`interval '2 minutes'`).
const CLAIM_LEASE_US: i64 = 2 * 60 * 1_000_000;
const WITHDRAWAL_MIRROR: &str = "withdrawal-mirror";
/// The data keys a completion strips (`data-'retry_slugs'-...`).
const RETRY_KEYS: &[&str] = &[
    "retry_slugs",
    "target_failures",
    "failing_target",
    "busy_retries",
    "busy_since",
    "busy_at",
];
/// The config keys that turn gated (mention-link) effects off.
const AUTO_LINK_KEYS: &[&str] = &["auto_link", "mcp.remote_auto_links"];
/// `edgeTrimSql`: the ASCII blanks, plus the Unicode spaces a UTF-8 database adds.
const EDGE_SPACE: &[char] = &[
    ' ', '\t', '\n', '\u{0B}', '\u{0C}', '\r', '\u{A0}', '\u{1680}', '\u{2000}', '\u{2001}',
    '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}',
    '\u{200A}', '\u{2028}', '\u{2029}', '\u{202F}', '\u{205F}', '\u{3000}', '\u{FEFF}',
];

/// What is stored for an effect: the `persistence_effects` columns this engine keeps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EffectRecord {
    id: u64,
    request_id: String,
    kind: String,
    #[serde(default)]
    revision: Option<String>,
    data: Value,
    source_id: String,
    source_incarnation: String,
    #[serde(default)]
    worktree_id: Option<String>,
    state: String,
    #[serde(default)]
    execution_token: Option<String>,
    #[serde(default)]
    claim_expires_at_us: Option<i64>,
    #[serde(default)]
    claim_owner: Option<Value>,
    attempts: i64,
    next_attempt_at_us: i64,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    outcome: Option<Value>,
    updated_at_us: i64,
}

impl EffectRecord {
    /// `SELECT * FROM persistence_effects`: every column, `recovery` null.
    fn to_row(&self) -> Value {
        json!({
            "id": self.id,
            "request_id": self.request_id,
            "kind": self.kind,
            "revision": self.revision,
            "data": self.data,
            "state": self.state,
            "execution_token": self.execution_token,
            "updated_at": iso(self.updated_at_us),
            "attempts": self.attempts,
            "claim_expires_at": self.claim_expires_at_us.map(iso),
            "error_code": self.error_code,
            "next_attempt_at": iso(self.next_attempt_at_us),
            "outcome": self.outcome,
            "recovery": Value::Null,
            "recovery_bytes": 0,
            "source_id": self.source_id,
            "source_incarnation": self.source_incarnation,
            "worktree_id": self.worktree_id,
            "claim_owner": self.claim_owner,
        })
    }

    fn data_map(&self) -> Option<&Map<String, Value>> {
        self.data.as_object()
    }

    fn parked(&self) -> &[Value] {
        match self.data_map().and_then(|d| d.get("parked")) {
            Some(Value::Array(items)) => items,
            _ => &[],
        }
    }

    /// The dead-owner test of `DEAD_OWNER_EFFECT_SQL`: running, no recovery, the stamp's token is
    /// the claim's, and `pid:nonce:start` of its owner (nulls skipped, as `concat_ws`) is listed.
    fn held_by_dead_owner(&self, dead_owners: &[String]) -> bool {
        if self.state != "running" {
            return false;
        }
        let Some(owner) = self.claim_owner.as_ref().and_then(Value::as_object) else {
            return false;
        };
        let token = owner.get("token").and_then(text_of);
        if token.is_none() || token.as_deref() != self.execution_token.as_deref() {
            return false;
        }
        let who = owner.get("owner").and_then(Value::as_object);
        let parts: Vec<String> = ["pid", "nonce", "start"]
            .iter()
            .filter_map(|k| who.and_then(|o| o.get(*k)).and_then(text_of))
            .collect();
        let key = parts.join(":");
        dead_owners.contains(&key)
    }

    /// `completeEffect`'s update: failed `targets_parked` with parked targets, else committed;
    /// the retry keys stripped, the claim cleared, the outcome stored.
    fn complete(&mut self, outcome: &Value, now: i64) {
        let parked = !self.parked().is_empty();
        self.state = if parked { "failed" } else { "committed" }.into();
        self.error_code = parked.then(|| "targets_parked".into());
        if let Value::Object(data) = &mut self.data {
            for key in RETRY_KEYS {
                data.remove(*key);
            }
        }
        self.execution_token = None;
        self.claim_expires_at_us = None;
        self.claim_owner = None;
        self.outcome = Some(outcome.clone());
        self.updated_at_us = now;
    }
}

/// The text `->>` gives for a JSON value: a string as itself, null as absent, anything else as
/// its JSON text.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// One effect `queueEffects` inserts; a `gated` one is skipped while mention auto-linking is off.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct QueuedEffect {
    pub kind: String,
    pub data: Value,
    pub gated: Option<bool>,
}

/// `EffectQueue`: the effects one publication queues, with the request columns each row copies.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EffectQueue {
    pub request_id: String,
    pub revision: Option<String>,
    pub source_id: String,
    pub source_incarnation: String,
    pub worktree_id: Option<String>,
    pub queued: Vec<QueuedEffect>,
}

/// One claimed effect `completeEffects` finishes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct EffectClaimRef {
    pub id: Value,
    pub token: Option<String>,
}

fn effect_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::PERSISTENCE, EFFECT];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn kind_prefix(request_id: &str) -> Vec<u8> {
    let mut key = vec![keys::PERSISTENCE, EFFECT_KIND];
    key.extend_from_slice(request_id.as_bytes());
    key.push(0);
    key
}

fn kind_key(request_id: &str, kind: &str) -> Vec<u8> {
    let mut key = kind_prefix(request_id);
    key.extend_from_slice(kind.as_bytes());
    key
}

/// A caller's effect id (`string | number`) as the stored id; `None` for one no effect can have.
pub fn effect_id(value: &Value) -> Option<u64> {
    match value {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn read_effect(read: &dyn KvRead, id: u64) -> Result<Option<EffectRecord>> {
    get_json(read, &effect_key(id))
}

fn write_effect(tx: &mut dyn KvWrite, record: &EffectRecord) -> Result<()> {
    put_json(tx, &effect_key(record.id), record)
}

fn all_effects(read: &dyn KvRead) -> Result<Vec<EffectRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::PERSISTENCE, EFFECT], false, &mut |_, v| {
        match serde_json::from_slice::<EffectRecord>(v) {
            Ok(record) => out.push(record),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    match failure {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

/// The effects of one request, in kind order.
fn request_effects(read: &dyn KvRead, request_id: &str) -> Result<Vec<EffectRecord>> {
    if request_id.contains('\0') {
        return Ok(Vec::new());
    }
    let mut ids = Vec::new();
    let mut failure = None;
    scan_prefix(read, &kind_prefix(request_id), false, &mut |_, v| {
        match keys::be8(v) {
            Some(id) => ids.push(id),
            None => failure = Some(StoreError::new(STORE_CORRUPT, "bad effect index")),
        }
        failure.is_none()
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(record) = read_effect(read, id)? {
            out.push(record);
        }
    }
    Ok(out)
}

/// Whether `auto_link` or `mcp.remote_auto_links`, edge-trimmed and ASCII-lowercased, is off.
fn auto_links_off(read: &dyn KvRead) -> Result<bool> {
    for key in AUTO_LINK_KEYS {
        if let Some(value) = read_config(read, key)? {
            let value = value.trim_matches(EDGE_SPACE).to_ascii_lowercase();
            if matches!(value.as_str(), "false" | "0" | "no" | "off") {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

impl Store {
    /// `selectClaimableEffect(hostId, deadOwners)`: the next claimable effect (queued, running
    /// with an expired lease, or running under a claim whose owner is listed in `dead_owners`),
    /// due now, on no worktree, and not behind its request's unfinished withdrawal mirror unless
    /// it is that mirror; the first by `(next_attempt_at, id)`, or `None`. `host_id` names the
    /// worktree owner in TypeScript; with no worktrees kept it changes nothing.
    pub fn select_claimable_effect(
        &self,
        _host_id: &str,
        dead_owners: &[String],
    ) -> Result<Option<Value>> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let effects = all_effects(&*read)?;
        let mirror_open: std::collections::HashSet<&str> = effects
            .iter()
            .filter(|e| {
                e.kind == WITHDRAWAL_MIRROR && matches!(e.state.as_str(), "queued" | "running")
            })
            .map(|e| e.request_id.as_str())
            .collect();
        let best = effects
            .iter()
            .filter(|e| {
                let claimable = e.state == "queued"
                    || e.state == "running" && e.claim_expires_at_us.is_some_and(|at| at < now)
                    || e.held_by_dead_owner(dead_owners);
                claimable
                    && e.next_attempt_at_us <= now
                    && e.worktree_id.is_none()
                    && (e.kind == WITHDRAWAL_MIRROR || !mirror_open.contains(e.request_id.as_str()))
            })
            .min_by_key(|e| (e.next_attempt_at_us, e.id));
        Ok(best.map(EffectRecord::to_row))
    }

    /// `claimEffect(id, token, claimOwnerJson)`: running under `token`, the owner stamp stored as
    /// JSON, a 2-minute lease and one more attempt; the claimed row, or `None` for an unknown id.
    pub fn claim_effect(
        &self,
        id: &Value,
        token: &str,
        claim_owner_json: &str,
    ) -> Result<Option<Value>> {
        let owner: Value = serde_json::from_str(claim_owner_json)
            .map_err(|e| StoreError::invalid(format!("claimEffect claimOwnerJson: {e}")))?;
        let Some(id) = effect_id(id) else {
            return Ok(None);
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut record) = read_effect(&*tx, id)? else {
                return Ok(None);
            };
            record.state = "running".into();
            record.execution_token = Some(token.to_string());
            record.claim_owner = Some(owner);
            record.claim_expires_at_us = Some(now + CLAIM_LEASE_US);
            record.attempts += 1;
            record.updated_at_us = now;
            write_effect(tx, &record)?;
            Ok(Some(record.to_row()))
        })
    }

    /// `queueEffects(queue)`: inserts the queued effects in order, keeping an effect of the
    /// request that has the kind already, and skipping a gated one while auto-linking is off; the
    /// kinds inserted. An unknown request is `constraint_violation` (the foreign key).
    pub fn queue_effects(&self, queue: &EffectQueue) -> Result<Vec<String>> {
        if queue.queued.is_empty() {
            return Ok(Vec::new());
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            if queue.request_id.contains('\0')
                || tx.get(&keys::request(&queue.request_id))?.is_none()
            {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!("effect request {} does not exist", queue.request_id),
                ));
            }
            let links_off = auto_links_off(&*tx)?;
            let mut inserted = Vec::new();
            for effect in &queue.queued {
                if effect.gated == Some(true) && links_off {
                    continue;
                }
                if effect.kind.contains('\0') {
                    return Err(StoreError::invalid("an effect kind must not contain NUL"));
                }
                let index = kind_key(&queue.request_id, &effect.kind);
                if tx.get(&index)?.is_some() {
                    continue;
                }
                let id = next_id(tx, NEXT_EFFECT_ID)?;
                let record = EffectRecord {
                    id,
                    request_id: queue.request_id.clone(),
                    kind: effect.kind.clone(),
                    revision: queue.revision.clone(),
                    data: effect.data.clone(),
                    source_id: queue.source_id.clone(),
                    source_incarnation: queue.source_incarnation.clone(),
                    worktree_id: queue.worktree_id.clone(),
                    state: "queued".into(),
                    execution_token: None,
                    claim_expires_at_us: None,
                    claim_owner: None,
                    attempts: 0,
                    next_attempt_at_us: now,
                    error_code: None,
                    outcome: None,
                    updated_at_us: now,
                };
                write_effect(tx, &record)?;
                tx.put(&index, &id.to_be_bytes())?;
                inserted.push(effect.kind.clone());
            }
            Ok(inserted)
        })
    }

    /// `releaseAbandonedEffectClaims(cutoff)`: every running effect last written before `cutoff`
    /// goes back to queued, its claim cleared and due now at the latest; how many.
    pub fn release_abandoned_effect_claims(&self, cutoff: &str) -> Result<u64> {
        let cutoff = parse_iso(cutoff).ok_or_else(|| {
            StoreError::invalid(format!(
                "releaseAbandonedEffectClaims cutoff {cutoff:?} is not ISO"
            ))
        })?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut released = 0;
            for mut record in all_effects(&*tx)? {
                if record.state != "running" || record.updated_at_us >= cutoff {
                    continue;
                }
                record.state = "queued".into();
                record.execution_token = None;
                record.claim_expires_at_us = None;
                record.claim_owner = None;
                record.next_attempt_at_us = record.next_attempt_at_us.min(now);
                write_effect(tx, &record)?;
                released += 1;
            }
            Ok(released)
        })
    }

    /// `listMirrorGates(requestIds)`: the withdrawal-mirror effects of these requests that have
    /// not committed, or committed with recorded publications (`data.published`), as
    /// `{ request_id, state, data }`, in request then kind order.
    pub fn list_mirror_gates(&self, request_ids: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut ids: Vec<&String> = request_ids.iter().collect();
        ids.sort();
        ids.dedup();
        let mut out = Vec::new();
        for request_id in ids {
            for e in request_effects(&*read, request_id)? {
                let published = e.data_map().is_some_and(|d| d.contains_key("published"));
                if e.kind == WITHDRAWAL_MIRROR && (e.state != "committed" || published) {
                    out.push(
                        json!({ "request_id": e.request_id, "state": e.state, "data": e.data }),
                    );
                }
            }
        }
        Ok(out)
    }

    /// `completeEffect(id, token, outcome)`: completes the effect claimed with `token`; false
    /// when no effect holds that claim (a null token never matches).
    pub fn complete_effect(
        &self,
        id: &Value,
        token: Option<&str>,
        outcome: &Value,
    ) -> Result<bool> {
        let refs = [EffectClaimRef {
            id: id.clone(),
            token: token.map(str::to_string),
        }];
        Ok(self.complete_effects(&refs, outcome)? == 1)
    }

    /// `completeEffects(rows, outcome)`: `complete_effect` over each row with one outcome; how
    /// many still held their claim.
    pub fn complete_effects(&self, rows: &[EffectClaimRef], outcome: &Value) -> Result<u64> {
        if rows.is_empty() {
            return Ok(0);
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut done = 0;
            for row in rows {
                let (Some(id), Some(token)) = (effect_id(&row.id), row.token.as_deref()) else {
                    continue;
                };
                let Some(mut record) = read_effect(&*tx, id)? else {
                    continue;
                };
                if record.execution_token.as_deref() != Some(token) {
                    continue;
                }
                record.complete(outcome, now);
                write_effect(tx, &record)?;
                done += 1;
            }
            Ok(done)
        })
    }

    /// `hasRearmableEffects(requestIds)`: whether one of these requests has an unclaimed Git or
    /// embedding effect (queued or failed, not settled) with a target parked under
    /// `withdrawal_mirror_failed`, while the request's withdrawal mirror has committed.
    pub fn has_rearmable_effects(&self, request_ids: &[String]) -> Result<bool> {
        let read = self.read()?;
        for request_id in request_ids {
            let effects = request_effects(&*read, request_id)?;
            let mirrored = effects
                .iter()
                .any(|m| m.kind == WITHDRAWAL_MIRROR && m.state == "committed");
            if !mirrored {
                continue;
            }
            let rearmable = effects.iter().any(|e| {
                matches!(e.kind.as_str(), "git" | "embedding")
                    && matches!(e.state.as_str(), "queued" | "failed")
                    && e.execution_token.is_none()
                    && !e.data_map().is_some_and(|d| d.contains_key("settled"))
                    && e.parked().iter().any(|p| {
                        p.get("error_code").and_then(Value::as_str)
                            == Some("withdrawal_mirror_failed")
                    })
            });
            if rearmable {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
