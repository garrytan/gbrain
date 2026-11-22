//! Group 5 facts members, relink attempts: one `#[napi] impl Brain` block over
//! `gbrain_store::facts::relink`, the `fact_relink_attempts` table
//! (src/core/engine-sql/fact-relink-attempts.ts, and `countFactRelinkOutcomes` of
//! src/core/engine-sql/facts-doctor.ts).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::relink::{AttemptInput, UpsertOptions};

#[napi]
impl Brain {
    /// `upsertFactRelinkAttempt(sourceId, attempt, opts)`: records the fact's latest attempt;
    /// resolves null.
    #[napi]
    pub fn upsert_fact_relink_attempt<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        attempt: Value,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let attempt: AttemptInput = required(attempt, "upsertFactRelinkAttempt attempt")?;
            let opts: UpsertOptions = required(opts, "upsertFactRelinkAttempt opts")?;
            s.upsert_fact_relink_attempt(&source_id, &attempt, &opts)
        })
    }

    /// `listFactRelinkOutcomes(sourceId, factIds, outcomes)`: resolves `{ fact_id, outcome }` rows
    /// by fact id.
    #[napi]
    pub fn list_fact_relink_outcomes<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        fact_ids: Value,
        outcomes: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fact_ids: Vec<f64> = required(fact_ids, "listFactRelinkOutcomes factIds")?;
            let outcomes: Vec<String> = required(outcomes, "listFactRelinkOutcomes outcomes")?;
            s.list_fact_relink_outcomes(&source_id, &fact_ids, &outcomes)
        })
    }

    /// `deleteFactRelinkMemos(sourceId, tier, targetSlug)`: resolves null.
    #[napi]
    pub fn delete_fact_relink_memos<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        tier: String,
        target_slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_fact_relink_memos(&source_id, &tier, &target_slug)
        })
    }

    /// `countFactRelinkOutcomes(sourceIds)`: resolves `{ outcome, tier, n }` rows.
    #[napi]
    pub fn count_fact_relink_outcomes<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let source_ids: Vec<String> =
                required(source_ids, "countFactRelinkOutcomes sourceIds")?;
            s.count_fact_relink_outcomes(&source_ids)
        })
    }
}
