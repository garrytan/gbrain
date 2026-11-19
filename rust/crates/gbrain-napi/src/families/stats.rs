//! Brain statistics, health and the ingest log.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store"). The TypeScript members
//! (`src/core/rust-engine/store-members/stats.ts`) resolve the scope, config and schema-pack
//! inputs and finish the arithmetic PGLite does in TypeScript.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `getStats({ scope })`: resolves `BrainStats`.
    #[napi]
    pub fn get_stats<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_stats(&arg(options, "getStats options")?)
        })
    }

    /// `getHealth({ scope, entityTypes })`: resolves the store counters, the linkable pages and
    /// `most_connected`.
    #[napi]
    pub fn get_health<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_health(&arg(options, "getHealth options")?)
        })
    }

    /// `logIngest({ source_id?, source_type, source_ref, pages_updated_json, summary })`.
    #[napi]
    pub fn log_ingest<'env>(&self, env: &'env Env, entry: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.log_ingest(&required(entry, "logIngest entry")?)
        })
    }

    /// `getIngestLog({ limit?, sourceIds? })`: resolves rows newest first.
    #[napi]
    pub fn get_ingest_log<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_ingest_log(&arg(options, "getIngestLog options")?)
        })
    }

    /// `listEnrichCandidates({ types, thinThreshold, order, limit, enrichedAfter?, scope })`.
    #[napi]
    pub fn list_enrich_candidates<'env>(
        &self,
        env: &'env Env,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_enrich_candidates(&required(options, "listEnrichCandidates options")?)
        })
    }

    /// `findAnomalies({ scope, baselineStartUs, sinceUs, sinceEndUs })`: resolves the baseline
    /// day counts and today's cohorts.
    #[napi]
    pub fn find_anomalies<'env>(
        &self,
        env: &'env Env,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_anomalies(&required(options, "findAnomalies options")?)
        })
    }
}
