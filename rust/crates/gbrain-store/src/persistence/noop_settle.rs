//! The no-op embedding settle pass (`src/core/engine-sql/persistence-embedding-noop-settle.ts`;
//! rust/docs/store/persistence.md, "No-op embedding settle"): the four statements that settle, in
//! bulk, queued page embedding effects whose chunks already carry current vectors.
//!
//! The candidate read admits an effect with no worktree, or one on a worktree this host owns
//! (`worktree_rows.rs`) whose refresh fence is clear and that no effect or write recovers
//! (`write_claim_terms.rs`, `effect_claimable_on_worktree`). The window's `FOR UPDATE SKIP LOCKED` and the candidates' `FOR SHARE OF p` are skipped while explicit transactions
//! hold the writer (`serialized_transactions`; `lockNoopEmbeddingWindow` asserts it).

use super::all_requests;
use super::effect_worker::{effect_id, pg_uuid, without};
use super::effects::{all_effects, effect_by_id, max_effect_id, write_effect};
use super::worktree_admission::{RefreshRecord, all_refreshes};
use super::write_claim_terms::effect_claimable_on_worktree;
use crate::Store;
use crate::chunks::read_chunks;
use crate::embeddings::{read_signature, text_hash};
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::kv::{KvRead, KvWrite};
use crate::pages::read_page_by_id;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

/// The keys a plain page effect never carries (`NOT (e.data ? '...')`).
const NOT_PLAIN: [&str; 4] = ["targets", "source_scan", "retry_slugs", "parked"];
/// What the settle drops from `data`: `data-'retry_slugs'-'target_failures'-'failing_target'`.
const SETTLE_DROPS: [&str; 3] = ["retry_slugs", "target_failures", "failing_target"];

/// `readNoopEmbeddingCandidates`' spec.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoopSettleCandidateSpec {
    pub host_id: String,
    pub signature: String,
    #[serde(default)]
    pub expected_model: Option<String>,
    pub window: Vec<String>,
    pub page_ids: Vec<i64>,
}

/// `(e.data->>'page_id')::int`: null when absent or JSON null; a number or string the integer
/// cast accepts; anything else refuses as the cast does.
pub(super) fn page_id_of(data: &Value) -> Result<Option<i64>> {
    let text = match data.get("page_id") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    let value = text.trim().parse::<i64>().map_err(|_| {
        StoreError::invalid(format!("invalid input syntax for type integer: \"{text}\""))
    })?;
    if i32::try_from(value).is_err() {
        return Err(StoreError::invalid(format!(
            "value \"{text}\" is out of range for type integer"
        )));
    }
    Ok(Some(value))
}

/// The unattempted queued embedding effects past `from`, in id order.
fn unattempted_after(read: &dyn KvRead, from: i64) -> Result<Vec<super::effects::EffectRecord>> {
    Ok(all_effects(read)?
        .into_iter()
        .filter(|e| {
            e.id > from
                && e.kind == "embedding"
                && e.state == "queued"
                && e.attempts == 0
                && e.recovery.is_none()
        })
        .collect())
}

pub(crate) fn probe_noop_embedding_settle_in(read: &dyn KvRead, from: &str) -> Result<bool> {
    let from = effect_id(from)?;
    Ok(!unattempted_after(read, from)?.is_empty())
}

pub(crate) fn lock_noop_embedding_window_in(
    read: &dyn KvRead,
    from: &str,
    limit: i64,
) -> Result<Value> {
    let newest = max_effect_id(read)?;
    let from = effect_id(from)?;
    if limit < 0 {
        return Err(StoreError::invalid("LIMIT must not be negative"));
    }
    let mut rows = Vec::new();
    for e in unattempted_after(read, from)?
        .into_iter()
        .take(usize::try_from(limit).unwrap_or(usize::MAX))
    {
        rows.push(json!({ "id": e.id.to_string(), "page_id": page_id_of(&e.data)? }));
    }
    Ok(json!({ "newest": newest.to_string(), "rows": rows }))
}

/// Every chunk of the page carries a vector of its current text from `model`
/// (`cc.<vector> IS NOT NULL AND cc.embedded_at IS NOT NULL AND cc.embedded_text_hash IS NOT
/// DISTINCT FROM md5(cc.chunk_text) AND cc.model IS NOT DISTINCT FROM $model`).
fn chunks_current(read: &dyn KvRead, page_id: u64, model: Option<&str>) -> Result<bool> {
    for chunk in read_chunks(read, page_id)? {
        let current = chunk.embed.has_vector()
            && chunk.embed.embedded_at_us.is_some()
            && chunk.embed.text_hash.as_deref() == Some(text_hash(&chunk.chunk_text).as_str())
            && chunk.meta.get("model").and_then(Value::as_str) == model;
        if !current {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(crate) fn read_noop_embedding_candidates_in(
    read: &dyn KvRead,
    env: &dyn Env,
    spec: &NoopSettleCandidateSpec,
) -> Result<Vec<Value>> {
    let host = pg_uuid(&spec.host_id)?;
    let window = spec
        .window
        .iter()
        .map(|id| effect_id(id))
        .collect::<Result<HashSet<_>>>()?;
    let pages: HashSet<i64> = spec.page_ids.iter().copied().collect();
    let now = env.now_micros();
    let effects = all_effects(read)?;
    let mut terms: Option<(Vec<RequestRecord>, Vec<RefreshRecord>)> = None;
    let mut out = Vec::new();
    for e in effects.iter().filter(|e| window.contains(&e.id)) {
        let Some(page_id) = page_id_of(&e.data)? else {
            continue;
        };
        if !pages.contains(&page_id)
            || e.next_attempt_at_us > now
            || NOT_PLAIN.iter().any(|k| e.data.get(*k).is_some())
        {
            continue;
        }
        if let Some(w) = e.worktree_id.as_deref().map(str::to_lowercase) {
            let (requests, refreshes) = match &terms {
                Some(t) => t,
                None => terms.insert((all_requests(read)?, all_refreshes(read)?)),
            };
            if !effect_claimable_on_worktree(read, &w, &host, &effects, requests, refreshes)? {
                continue;
            }
        }
        if effects.iter().any(|m| {
            m.request_id == e.request_id && m.kind == "withdrawal-mirror" && m.state != "committed"
        }) {
            continue;
        }
        let Some(page) = u64::try_from(page_id)
            .ok()
            .map(|id| read_page_by_id(read, id))
            .transpose()?
            .flatten()
        else {
            continue;
        };
        let live = Some(&page.source_id) == e.source_id.as_ref()
            && page.deleted_at_us.is_none()
            && e.revision.as_deref() == Some(page.knowledge_revision.as_str())
            && page.text_projection_revision.as_deref() == Some(page.knowledge_revision.as_str());
        if !live
            || read_signature(read, page.id)?.as_deref() != Some(spec.signature.as_str())
            || !chunks_current(read, page.id, spec.expected_model.as_deref())?
        {
            continue;
        }
        out.push(json!({
            "id": e.id.to_string(),
            "kind": e.kind,
            "source_id": e.source_id,
            "source_incarnation": e.source_incarnation,
            "worktree_id": e.worktree_id,
        }));
    }
    Ok(out)
}

pub(crate) fn settle_noop_embedding_rows_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    ids: &[String],
) -> Result<Vec<Value>> {
    let ids = ids
        .iter()
        .map(|id| effect_id(id))
        .collect::<Result<Vec<_>>>()?;
    let now = env.now_micros();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if !seen.insert(id) {
            continue;
        }
        let Some(mut e) = effect_by_id(&*tx, id)? else {
            continue;
        };
        if e.state != "queued" || e.recovery.is_some() {
            continue;
        }
        e.state = "committed".into();
        e.error_code = None;
        e.attempts += 1;
        e.data = without(&e.data, &SETTLE_DROPS);
        e.execution_token = None;
        e.claim_expires_at_us = None;
        e.claim_owner = None;
        e.outcome = Some(json!({}));
        e.updated_at_us = now;
        write_effect(tx, &e)?;
        out.push(json!({ "id": e.id.to_string(), "request_id": e.request_id }));
    }
    Ok(out)
}

impl Store {
    /// `probeNoopEmbeddingSettle(from)`.
    pub fn probe_noop_embedding_settle(&self, from: &str) -> Result<bool> {
        probe_noop_embedding_settle_in(&*self.read()?, from)
    }

    /// `lockNoopEmbeddingWindow({ from, limit })`: `{ newest, rows }`.
    /// In multi-user mode it passes through its row in `lock_skips::MULTIUSER_PROVEN` (read set, `lock_noop_embedding_window_never_hands_one_effect_to_two_settlers`): a concurrent writer of what the lock protected refuses the commit `write_conflict`.
    pub fn lock_noop_embedding_window(&self, from: &str, limit: i64) -> Result<Value> {
        self.assert_serialized_transactions("lockNoopEmbeddingWindow")?;
        lock_noop_embedding_window_in(&*self.read()?, from, limit)
    }

    /// `readNoopEmbeddingCandidates(spec)`.
    pub fn read_noop_embedding_candidates(
        &self,
        spec: &NoopSettleCandidateSpec,
    ) -> Result<Vec<Value>> {
        read_noop_embedding_candidates_in(&*self.read()?, &*self.env, spec)
    }

    /// `settleNoopEmbeddingRows(ids)`: the settled effects as `{ id, request_id }`.
    pub fn settle_noop_embedding_rows(&self, ids: &[String]) -> Result<Vec<Value>> {
        self.write(|tx| settle_noop_embedding_rows_in(tx, &*self.env, ids))
    }
}
