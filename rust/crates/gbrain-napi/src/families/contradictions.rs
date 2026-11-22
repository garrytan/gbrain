//! Contradiction-probe runs and the judge cache.
//!
//! One `#[napi] impl Brain` block per family file; each method runs one `Store` call on the pool
//! through `Brain::run` and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::contradictions::{ContradictionCacheInput, ContradictionsRunInput};

#[napi]
impl Brain {
    /// `writeContradictionsRun(row)`: resolves true when it inserted, false when the run_id exists.
    #[napi]
    pub fn write_contradictions_run<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: ContradictionsRunInput = required(row, "writeContradictionsRun row")?;
            s.write_contradictions_run(&row)
        })
    }

    /// `loadContradictionsTrend(days)`: resolves the runs of the last `days` days, newest first.
    /// `ran_at` is microsecond ISO text.
    #[napi]
    pub fn load_contradictions_trend<'env>(
        &self,
        env: &'env Env,
        days: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.load_contradictions_trend(days))
    }

    /// `getContradictionCacheEntry(key)`: resolves the live verdict or null.
    #[napi]
    pub fn get_contradiction_cache_entry<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: ContradictionCacheInput = required(key, "getContradictionCacheEntry key")?;
            s.get_contradiction_cache_entry(&key)
        })
    }

    /// `putContradictionCacheEntry(entry)`: inserts or replaces the verdict; resolves null.
    #[napi]
    pub fn put_contradiction_cache_entry<'env>(
        &self,
        env: &'env Env,
        entry: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let entry: ContradictionCacheInput =
                required(entry, "putContradictionCacheEntry entry")?;
            s.put_contradiction_cache_entry(&entry)
        })
    }

    /// `sweepContradictionCache()`: resolves the number of expired entries deleted.
    #[napi]
    pub fn sweep_contradiction_cache<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.sweep_contradiction_cache())
    }
}
