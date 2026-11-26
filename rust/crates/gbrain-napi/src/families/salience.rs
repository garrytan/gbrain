//! Emotional weight and salience of pages.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON. The shell resolves defaults first (window boundary, limit clamp, recency
//! map) and turns dates and the score map into what PGLite returns.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};
use gbrain_store::salience;

#[napi]
impl Brain {
    /// `batchLoadEmotionalInputs(slugs?)`: `{slug, source_id, tags, takes}` per page.
    #[napi]
    pub fn batch_load_emotional_inputs<'env>(
        &self,
        env: &'env Env,
        slugs: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let slugs: Option<Vec<String>> = arg(slugs, "batchLoadEmotionalInputs slugs")?;
            s.batch_load_emotional_inputs(slugs.as_deref())
        })
    }

    /// `setEmotionalWeightBatch(rows)`: resolves the number of pages changed.
    #[napi]
    pub fn set_emotional_weight_batch<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<salience::EmotionalWeightRow> =
                required(rows, "setEmotionalWeightBatch rows")?;
            s.set_emotional_weight_batch(&rows)
        })
    }

    /// `getRecentSalience(opts)`: the resolved options (see `RecentSalienceOptions`).
    #[napi]
    pub fn get_recent_salience<'env>(
        &self,
        env: &'env Env,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let options: salience::RecentSalienceOptions =
                required(options, "getRecentSalience options")?;
            s.get_recent_salience(&options)
        })
    }

    /// `getSalienceScores(refs, opts)`: `{slug, source_id, score}` rows.
    #[napi]
    pub fn get_salience_scores<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: salience::SalienceScoresInput = required(input, "getSalienceScores input")?;
            s.get_salience_scores(&input)
        })
    }

    /// `countZeroWeightWithTakes()`: `{ zero_weight_with_takes, nonzero_weight }`.
    #[napi]
    pub fn count_zero_weight_with_takes<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_zero_weight_with_takes())
    }
}
