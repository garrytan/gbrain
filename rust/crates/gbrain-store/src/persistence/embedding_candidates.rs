//! The embedding effects `gbrain repair embedding-effects` settles (`listEmbeddingCandidates`,
//! `src/core/engine-sql/persistence-effect-scans.ts`; rust/docs/store/persistence.md, "Embedding
//! candidates").
//!
//! A candidate is an embedding effect of a committed request with no recovery and no execution
//! token that failed, or that is queued and was last updated over an hour ago or was re-queued by
//! a repair (`data ? 'repair_requeued_at'`). A failed effect whose code is one of the codes never
//! retried is left out, and so is a failed effect with no code: the SQL's
//! `NOT (e.state='failed' AND e.error_code IN (...))` is null there, which `WHERE` drops.

use super::effects::all_effects;
use super::noop_settle::page_id_of;
use super::request_by_id;
use crate::Store;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::pages::{all_pages, read_page_by_id};
use crate::repair_scans::chars;
use crate::sources::read_source;
use serde_json::{Value, json};

/// `interval '1 hour'` in microseconds.
const HOUR_US: i64 = 3_600_000_000;

/// The characters of page `id` (`length(compiled_truth) + length(COALESCE(timeline,''))`), or none
/// when no page has the id.
fn page_chars(read: &dyn KvRead, id: Option<i64>) -> Result<Option<u64>> {
    let Some(id) = id.and_then(|id| u64::try_from(id).ok()) else {
        return Ok(None);
    };
    Ok(read_page_by_id(read, id)?.map(|page| chars(&page)))
}

/// The `chars` column: the page effect's page, the sum over a targeted effect's targets (a target
/// named twice counts twice, as the join counts it), or the sum over the source's live pages.
fn effect_chars(read: &dyn KvRead, data: &Value, source_id: Option<&str>) -> Result<u64> {
    if data.get("page_id").is_some() {
        return Ok(page_chars(read, page_id_of(data)?)?.unwrap_or(0));
    }
    if let Some(targets) = data.get("targets") {
        let Some(targets) = targets.as_array() else {
            return Err(StoreError::invalid(
                "cannot extract elements from a scalar".to_string(),
            ));
        };
        let mut sum = 0;
        for target in targets {
            sum += page_chars(read, page_id_of(target)?)?.unwrap_or(0);
        }
        return Ok(sum);
    }
    let Some(source_id) = source_id else {
        return Ok(0);
    };
    Ok(all_pages(read)?
        .iter()
        .filter(|p| p.source_id == source_id && p.deleted_at_us.is_none())
        .map(chars)
        .sum())
}

/// `embeddingCandidateWhere(neverRetried)` without the source scope: an embedding effect with no recovery and no
/// claim, failed (with an error code outside `never_retried`) or queued over an hour or re-queued by a repair, whose
/// request committed. Returns the effect and its request.
fn stale_embedding_effects(
    read: &dyn KvRead,
    now_us: i64,
    never_retried: &[&str],
) -> Result<Vec<(super::effects::EffectRecord, crate::journal::RequestRecord)>> {
    let mut out = Vec::new();
    for e in all_effects(read)? {
        if e.kind != "embedding" || e.recovery.is_some() || e.execution_token.is_some() {
            continue;
        }
        let stale = match e.state.as_str() {
            "failed" => e
                .error_code
                .as_deref()
                .is_some_and(|code| !never_retried.contains(&code)),
            "queued" => {
                e.updated_at_us < now_us - HOUR_US || e.data.get("repair_requeued_at").is_some()
            }
            _ => false,
        };
        if !stale {
            continue;
        }
        let Some(r) = request_by_id(read, &e.request_id)? else {
            continue;
        };
        if r.state == "committed" {
            out.push((e, r));
        }
    }
    out.sort_by_key(|(e, _)| e.id);
    Ok(out)
}

/// The codes doctor's `stale_embedding_effects` never counts (`EMBEDDING_NEVER_RETRIED`, engine-sql/doctor-persistence.ts).
const DOCTOR_NEVER_RETRIED: [&str; 2] = ["targets_parked", "embedding_zero_norm"];

fn in_sources(source_ids: Option<&[String]>, source_id: &str) -> bool {
    source_ids.is_none_or(|ids| ids.iter().any(|id| id == source_id))
}

pub(crate) fn list_embedding_candidates_in(
    read: &dyn KvRead,
    now_us: i64,
    source_ids: &[String],
    never_retried: &[String],
) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for e in all_effects(read)? {
        if e.kind != "embedding" || e.recovery.is_some() || e.execution_token.is_some() {
            continue;
        }
        let stale = match e.state.as_str() {
            "failed" => e
                .error_code
                .as_deref()
                .is_some_and(|code| !never_retried.iter().any(|c| c == code)),
            "queued" => {
                e.updated_at_us < now_us - HOUR_US || e.data.get("repair_requeued_at").is_some()
            }
            _ => false,
        };
        if !stale {
            continue;
        }
        let Some(r) = request_by_id(read, &e.request_id)? else {
            continue;
        };
        if r.state != "committed" {
            continue;
        }
        let in_scope = source_ids.contains(&r.source_id)
            || read_source(read, &r.source_id)?
                .is_none_or(|s| s.incarnation != r.source_incarnation);
        if !in_scope {
            continue;
        }
        out.push(json!({
            "effect_id": e.id.to_string(),
            "source_id": r.source_id,
            "slug": r.slug,
            "request_id": r.request_id,
            "state": e.state,
            "attempts": e.attempts,
            "chars": effect_chars(read, &e.data, e.source_id.as_deref())?,
        }));
    }
    Ok(out)
}

impl Store {
    /// `readStaleEmbeddingCounts(sourceIds)`: `{ count, failed, requeued }` over the stale embedding effects of committed
    /// requests (`sourceIds` narrows them by the request's source): all, the failed, and the queued ones a repair re-queued.
    pub fn read_stale_embedding_counts(&self, source_ids: Option<&[String]>) -> Result<Value> {
        let rows =
            stale_embedding_effects(&*self.read()?, self.env.now_micros(), &DOCTOR_NEVER_RETRIED)?;
        let rows: Vec<_> = rows
            .into_iter()
            .filter(|(_, r)| in_sources(source_ids, &r.source_id))
            .collect();
        let failed = rows.iter().filter(|(e, _)| e.state == "failed").count();
        let requeued = rows
            .iter()
            .filter(|(e, _)| e.state == "queued" && e.data.get("repair_requeued_at").is_some())
            .count();
        Ok(json!({ "count": rows.len(), "failed": failed, "requeued": requeued }))
    }

    /// `listStaleEmbeddingEffects(sourceIds)`: the first 10 of those effects by effect id, as
    /// `{ effect_id, source_id, slug, request_id, state, updated_at }` (`updated_at` as `timestamptz::text`).
    pub fn list_stale_embedding_effects(
        &self,
        source_ids: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        let rows =
            stale_embedding_effects(&*self.read()?, self.env.now_micros(), &DOCTOR_NEVER_RETRIED)?;
        Ok(rows
            .into_iter()
            .filter(|(_, r)| in_sources(source_ids, &r.source_id))
            .take(10)
            .map(|(e, r)| {
                json!({
                    "effect_id": e.id.to_string(),
                    "source_id": r.source_id,
                    "slug": r.slug,
                    "request_id": r.request_id,
                    "state": e.state,
                    "updated_at": crate::cli_reads::pg_text::timestamptz_text(e.updated_at_us),
                })
            })
            .collect())
    }

    /// `listEmbeddingCandidates(sourceIds, neverRetried)`: the stale queued and failed embedding
    /// effects of committed requests on `source_ids`, or on a removed or replaced source
    /// incarnation, in effect id order.
    pub fn list_embedding_candidates(
        &self,
        source_ids: &[String],
        never_retried: &[String],
    ) -> Result<Vec<Value>> {
        list_embedding_candidates_in(
            &*self.read()?,
            self.env.now_micros(),
            source_ids,
            never_retried,
        )
    }
}
