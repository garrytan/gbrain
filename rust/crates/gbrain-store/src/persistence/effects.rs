//! Publication effects: the `persistence_effects` rows a publication queues
//! (`insertPublicationEffects`, `src/core/engine-sql/persistence-journal.ts`), and the effect
//! bytes the request's completion sizes (rust/docs/store/persistence.md, "Publication effects").
//!
//! Keys:
//!
//! | Key | Record |
//! |---|---|
//! | `d 0x05 <request id> 0x00 <kind>` | one `persistence_effects` row (`EffectRecord`), JSON |
//! | `d 0x06 <id, 8 bytes big-endian>` | the claim-order index: the request id and kind of effect `id` |
//!
//! `(request_id, kind)` is the row's unique key, as `UNIQUE(request_id,kind)` is on Postgres. The
//! id is the bigserial: one more than the largest id the index holds.
//!
//! Every kind is stored. Which kinds a worker may claim is the claim statement's choice, not the
//! insert's.

use super::{request_by_id, violation};
use crate::config::read_config;
use crate::env::{Env, is_uuid, iso};
use crate::error::{Result, STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::{get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The byte after `keys::PERSISTENCE` of an effect row.
const EFFECT: u8 = 0x05;
/// The byte after `keys::PERSISTENCE` of the claim-order index.
const EFFECT_ORDER: u8 = 0x06;

/// `REMOTE_AUTO_LINKS_CONFIG_KEY`: with `auto_link`, the config rows that gate a `gated` effect.
pub(crate) const REMOTE_AUTO_LINKS_KEY: &str = "mcp.remote_auto_links";

/// One `persistence_effects` row; the key holds `request_id` and `kind`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct EffectRecord {
    pub id: i64,
    pub request_id: String,
    pub kind: String,
    pub revision: Option<String>,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    pub data: Value,
    pub state: String,
    pub execution_token: Option<String>,
    pub updated_at_us: i64,
    pub source_id: Option<String>,
    pub source_incarnation: Option<String>,
    pub worktree_id: Option<String>,
    pub claim_expires_at_us: Option<i64>,
    pub next_attempt_at_us: i64,
    pub attempts: i64,
    pub error_code: Option<String>,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub outcome: Option<Value>,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub recovery: Option<Value>,
    pub recovery_bytes: i64,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub claim_owner: Option<Value>,
}

impl EffectRecord {
    /// The row as Postgres returns `SELECT * FROM persistence_effects`, in column order.
    pub(crate) fn to_row(&self) -> Value {
        json!({
            "id": self.id.to_string(),
            "request_id": self.request_id,
            "kind": self.kind,
            "revision": self.revision,
            "data": crate::jsonb::order(self.data.clone()),
            "state": self.state,
            "execution_token": self.execution_token,
            "updated_at": iso(self.updated_at_us),
            "source_id": self.source_id,
            "source_incarnation": self.source_incarnation,
            "worktree_id": self.worktree_id,
            "claim_expires_at": self.claim_expires_at_us.map(iso),
            "next_attempt_at": iso(self.next_attempt_at_us),
            "attempts": self.attempts,
            "error_code": self.error_code,
            "outcome": self.outcome.clone().map(crate::jsonb::order),
            "recovery": self.recovery.clone().map(crate::jsonb::order),
            "recovery_bytes": self.recovery_bytes.to_string(),
            "claim_owner": self.claim_owner.clone().map(crate::jsonb::order),
        })
    }

    /// `EFFECT_BYTES_SQL`: `octet_length(data::text)+octet_length(kind)+1024`.
    pub(crate) fn bytes(&self) -> i64 {
        crate::cli_reads::pg_text::jsonb_text(&self.data).len() as i64
            + self.kind.len() as i64
            + 1024
    }
}

/// One effect a publication queues (`QueuedPublicationEffect`).
#[derive(Debug, Clone, Deserialize)]
pub struct QueuedEffect {
    pub kind: Option<String>,
    pub data: Option<Value>,
    #[serde(default)]
    pub gated: Option<bool>,
}

/// `insertPublicationEffects(spec)`: the request's identity columns and its effects in queue order.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationEffectsSpec {
    pub request_id: String,
    pub revision: Option<String>,
    pub source_id: String,
    pub source_incarnation: String,
    pub worktree_id: Option<String>,
    pub effects: Vec<QueuedEffect>,
}

/// A uuid column reads back in lowercase whatever case it was written in, so every key holds the
/// lowercase spelling of the request id.
fn effect_prefix(request_id: &str) -> Vec<u8> {
    let mut key = vec![keys::PERSISTENCE, EFFECT];
    key.extend_from_slice(request_id.to_ascii_lowercase().as_bytes());
    key.push(0);
    key
}

fn effect_key(request_id: &str, kind: &str) -> Vec<u8> {
    let mut key = effect_prefix(request_id);
    key.extend_from_slice(kind.as_bytes());
    key
}

fn order_key(id: i64) -> Vec<u8> {
    let mut key = vec![keys::PERSISTENCE, EFFECT_ORDER];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// The claim-order index entry: which row effect `id` is.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct OrderEntry {
    request_id: String,
    kind: String,
}

/// The largest effect id stored, or 0.
pub(super) fn max_effect_id(read: &dyn KvRead) -> Result<i64> {
    let mut last = 0i64;
    scan_prefix(
        read,
        &[keys::PERSISTENCE, EFFECT_ORDER],
        true,
        &mut |key, _| {
            if let Some(bytes) = key.get(2..10).and_then(|b| <[u8; 8]>::try_from(b).ok()) {
                last = i64::from_be_bytes(bytes);
            }
            false
        },
    )?;
    Ok(last)
}

/// The effects of one request, in kind order.
pub(crate) fn request_effects(read: &dyn KvRead, request_id: &str) -> Result<Vec<EffectRecord>> {
    let mut out = Vec::new();
    let mut bad = None;
    scan_prefix(read, &effect_prefix(request_id), false, &mut |_, value| {
        match serde_json::from_slice::<EffectRecord>(value) {
            Ok(record) => out.push(record),
            Err(e) => bad = Some(e.to_string()),
        }
        true
    })?;
    if let Some(e) = bad {
        return Err(StoreError::new(
            STORE_CORRUPT,
            format!("unreadable effect row: {e}"),
        ));
    }
    Ok(out)
}

/// Every stored effect, in id order (the claim-order index).
pub(crate) fn all_effects(read: &dyn KvRead) -> Result<Vec<EffectRecord>> {
    let mut entries = Vec::new();
    scan_prefix(
        read,
        &[keys::PERSISTENCE, EFFECT_ORDER],
        false,
        &mut |_, value| {
            entries.push(serde_json::from_slice::<OrderEntry>(value));
            true
        },
    )?;
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let entry = entry.map_err(|e| {
            StoreError::new(STORE_CORRUPT, format!("unreadable effect order entry: {e}"))
        })?;
        if let Some(record) =
            get_json::<EffectRecord>(read, &effect_key(&entry.request_id, &entry.kind))?
        {
            out.push(record);
        }
    }
    Ok(out)
}

/// Effect `id`, or none.
pub(crate) fn effect_by_id(read: &dyn KvRead, id: i64) -> Result<Option<EffectRecord>> {
    let Some(entry) = get_json::<OrderEntry>(read, &order_key(id))? else {
        return Ok(None);
    };
    get_json(read, &effect_key(&entry.request_id, &entry.kind))
}

/// Stores an updated effect row under its key (its id and kind never change).
pub(crate) fn write_effect(tx: &mut dyn KvWrite, record: &EffectRecord) -> Result<()> {
    put_json(tx, &effect_key(&record.request_id, &record.kind), record)
}

/// `SUM(EFFECT_BYTES_SQL)` and `bool_or(state<>'committed')` over a request's effects.
pub(crate) fn effect_totals(read: &dyn KvRead, request_id: &str) -> Result<(i64, bool)> {
    let effects = request_effects(read, request_id)?;
    Ok((
        effects.iter().map(EffectRecord::bytes).sum(),
        effects.iter().any(|e| e.state != "committed"),
    ))
}

/// The whitespace `btrim` strips in the gate (ASCII space and controls, and the Unicode spaces the
/// statement lists when the server encoding is UTF8).
fn gate_space(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Whether a config value turns a switch off: trimmed, ASCII letters lowered, one of
/// `false`, `0`, `no`, `off`.
fn switched_off(value: &str) -> bool {
    let lowered = value.trim_matches(gate_space).to_ascii_lowercase();
    matches!(lowered.as_str(), "false" | "0" | "no" | "off")
}

fn uuid_cast(text: &str) -> Result<()> {
    if is_uuid(text) {
        Ok(())
    } else {
        Err(StoreError::invalid(format!(
            "invalid input syntax for type uuid: \"{text}\""
        )))
    }
}

/// `insertPublicationEffects(spec)`: inserts each effect not gated off and not already queued for
/// the request; returns the kinds it inserted, in queue order.
pub(crate) fn insert_publication_effects_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    spec: &PublicationEffectsSpec,
) -> Result<Vec<String>> {
    uuid_cast(&spec.request_id)?;
    let request_id = spec.request_id.to_ascii_lowercase();
    if let Some(revision) = &spec.revision {
        uuid_cast(revision)?;
    }
    uuid_cast(&spec.source_incarnation)?;
    if let Some(worktree) = &spec.worktree_id {
        uuid_cast(worktree)?;
    }
    let gated_off = {
        let mut off = false;
        for key in ["auto_link", REMOTE_AUTO_LINKS_KEY] {
            if read_config(&*tx, key)?.is_some_and(|v| switched_off(&v)) {
                off = true;
            }
        }
        off
    };
    let mut kinds = Vec::new();
    if spec
        .effects
        .iter()
        .any(|e| !(e.gated == Some(true) && gated_off))
        && request_by_id(&*tx, &spec.request_id)?.is_none()
    {
        return Err(violation(format!(
            "insert or update on table \"persistence_effects\" violates foreign key constraint \"persistence_effects_request_id_fkey\": request {} is not present",
            spec.request_id
        )));
    }
    let now = env.now_micros();
    let mut next_id = max_effect_id(&*tx)?;
    for effect in &spec.effects {
        if effect.gated == Some(true) && gated_off {
            continue;
        }
        let Some(kind) = effect.kind.clone() else {
            return Err(violation(
                "null value in column \"kind\" of relation \"persistence_effects\" violates not-null constraint",
            ));
        };
        let data = match &effect.data {
            Some(Value::Null) | None => {
                return Err(violation(
                    "null value in column \"data\" of relation \"persistence_effects\" violates not-null constraint",
                ));
            }
            Some(data) => data.clone(),
        };
        let key = effect_key(&request_id, &kind);
        if get_json::<EffectRecord>(&*tx, &key)?.is_some() {
            continue;
        }
        if spec.worktree_id.is_some() {
            return Err(violation(
                "insert or update on table \"persistence_effects\" violates foreign key constraint \"persistence_effects_worktree_id_fkey\": no persistence worktree exists on this engine",
            ));
        }
        next_id += 1;
        let record = EffectRecord {
            id: next_id,
            request_id: request_id.clone(),
            kind: kind.clone(),
            revision: spec.revision.as_ref().map(|r| r.to_ascii_lowercase()),
            data,
            state: "queued".into(),
            execution_token: None,
            updated_at_us: now,
            source_id: Some(spec.source_id.clone()),
            source_incarnation: Some(spec.source_incarnation.to_ascii_lowercase()),
            worktree_id: spec.worktree_id.as_ref().map(|w| w.to_ascii_lowercase()),
            claim_expires_at_us: None,
            next_attempt_at_us: now,
            attempts: 0,
            error_code: None,
            outcome: None,
            recovery: None,
            recovery_bytes: 0,
            claim_owner: None,
        };
        put_json(tx, &key, &record)?;
        put_json(
            tx,
            &order_key(next_id),
            &OrderEntry {
                request_id: request_id.clone(),
                kind: kind.clone(),
            },
        )?;
        kinds.push(kind);
    }
    Ok(kinds)
}

/// The kinds a managed-request withdrawal queues, in insert order (`WITHDRAWAL_EFFECTS_SQL`).
const WITHDRAWAL_EFFECT_KINDS: [&str; 3] = ["withdrawal-mirror", "git", "embedding"];

/// `insertWithdrawalEffects(spec)`: a withdrawal's request, its source and the data every effect carries.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WithdrawalEffectsSpec {
    pub request_id: String,
    pub source_id: String,
    pub data: Value,
}

/// `insertWithdrawalEffects(spec)`: one `withdrawal-mirror`, `git` and `embedding` row for the
/// request, each stamped with the source's incarnation and a null worktree (no worktree binds a
/// source on this engine). An unknown source inserts nothing; a kind already queued is kept.
/// Returns the kinds inserted, in insert order.
pub(crate) fn insert_withdrawal_effects_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    spec: &WithdrawalEffectsSpec,
) -> Result<Vec<String>> {
    uuid_cast(&spec.request_id)?;
    // The id as Postgres stores a uuid (canonical lowercase), so the mirror gate and the order index find it.
    let request_id = spec.request_id.to_ascii_lowercase();
    if spec.data.is_null() {
        return Err(violation(
            "null value in column \"data\" of relation \"persistence_effects\" violates not-null constraint",
        ));
    }
    let Some(source) = crate::sources::read_source(&*tx, &spec.source_id)? else {
        return Ok(Vec::new());
    };
    let mut missing = Vec::new();
    for kind in WITHDRAWAL_EFFECT_KINDS {
        if get_json::<EffectRecord>(&*tx, &effect_key(&request_id, kind))?.is_none() {
            missing.push(kind);
        }
    }
    if !missing.is_empty() && request_by_id(&*tx, &request_id)?.is_none() {
        return Err(violation(format!(
            "insert or update on table \"persistence_effects\" violates foreign key constraint \"persistence_effects_request_id_fkey\": request {} is not present",
            spec.request_id
        )));
    }
    let now = env.now_micros();
    let mut next_id = max_effect_id(&*tx)?;
    for kind in &missing {
        next_id += 1;
        let record = EffectRecord {
            id: next_id,
            request_id: request_id.clone(),
            kind: (*kind).into(),
            revision: None,
            data: spec.data.clone(),
            state: "queued".into(),
            execution_token: None,
            updated_at_us: now,
            source_id: Some(source.id.clone()),
            source_incarnation: Some(source.incarnation.clone()),
            worktree_id: None,
            claim_expires_at_us: None,
            next_attempt_at_us: now,
            attempts: 0,
            error_code: None,
            outcome: None,
            recovery: None,
            recovery_bytes: 0,
            claim_owner: None,
        };
        put_json(tx, &effect_key(&request_id, kind), &record)?;
        put_json(
            tx,
            &order_key(next_id),
            &OrderEntry {
                request_id: request_id.clone(),
                kind: (*kind).into(),
            },
        )?;
    }
    Ok(missing.into_iter().map(String::from).collect())
}

impl crate::Store {
    /// `insertPublicationEffects(spec)`: the kinds inserted, in queue order.
    pub fn insert_publication_effects(&self, spec: &PublicationEffectsSpec) -> Result<Vec<String>> {
        self.write(|tx| insert_publication_effects_in(tx, &*self.env, spec))
    }

    /// `insertWithdrawalEffects(spec)`: the kinds inserted, in insert order. Inside `transaction`
    /// this write is the withdrawal's own store write.
    pub fn insert_withdrawal_effects(&self, spec: &WithdrawalEffectsSpec) -> Result<Vec<String>> {
        self.write(|tx| insert_withdrawal_effects_in(tx, &*self.env, spec))
    }

    /// The effects of one request as `SELECT * FROM persistence_effects WHERE request_id=$1 ORDER BY id`.
    pub fn read_request_effects(&self, request_id: &str) -> Result<Vec<Value>> {
        let mut effects = request_effects(&*self.read()?, request_id)?;
        effects.sort_by_key(|e| e.id);
        Ok(effects.iter().map(EffectRecord::to_row).collect())
    }

    /// `readRequestEffects(requestId, kind)`: `{ kind, state, error_code, outcome, recovering }` for each
    /// effect of the request in kind order, or only its `kind` effect when one is named. A request id that
    /// is not a uuid refuses, as `$1::uuid` does.
    pub fn read_request_effect_states(
        &self,
        request_id: &str,
        kind: Option<&str>,
    ) -> Result<Vec<Value>> {
        uuid_cast(request_id)?;
        let effects = request_effects(&*self.read()?, request_id)?;
        Ok(effects
            .iter()
            .filter(|e| kind.is_none_or(|k| e.kind == k))
            .map(|e| {
                json!({
                    "kind": e.kind,
                    "state": e.state,
                    "error_code": e.error_code,
                    "outcome": e.outcome.clone().map(crate::jsonb::order),
                    "recovering": e.recovery.is_some(),
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_gate_reads_a_switch_as_postgres_does() {
        for off in ["false", " OFF ", "\u{A0}No\u{3000}", "0", "\tfalse\n"] {
            assert!(switched_off(off), "{off:?}");
        }
        for on in ["true", "1", "yes", "", "f", "nope", "ﬀ"] {
            assert!(!switched_off(on), "{on:?}");
        }
    }

    #[test]
    fn the_claim_order_key_sorts_by_id() {
        assert!(order_key(2) < order_key(10));
        assert!(order_key(255) < order_key(256));
    }
}
