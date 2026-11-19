//! Open loops (`gbrain_store::facts::loops`): `upsertOpenLoop`, `listOpenLoops`,
//! `closeOpenLoop`, `closedLoopWithActiveFact` and `loopFactDrift`.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `upsertOpenLoop(loop)`: resolves `{ id, created, applied }`. Times are ISO text ending
    /// in `Z`.
    #[napi]
    pub fn upsert_open_loop<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input = required(input, "upsertOpenLoop loop")?;
            s.upsert_open_loop(&input)
        })
    }

    /// `listOpenLoops(opts)`: resolves the rows, newest activity first. Times are ISO text.
    #[napi]
    pub fn list_open_loops<'env>(&self, env: &'env Env, opts: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts = required(opts, "listOpenLoops opts")?;
            s.list_open_loops(&opts)
        })
    }

    /// `closeOpenLoop(sourceId | null, id, status, closedBy)`: resolves the closed row, or null.
    #[napi]
    pub fn close_open_loop<'env>(
        &self,
        env: &'env Env,
        source_id: Option<String>,
        id: i64,
        status: String,
        closed_by: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.close_open_loop(source_id.as_deref(), id, &status, &closed_by)
        })
    }

    /// `closedLoopWithActiveFact(sourceId | null, loopId)`: resolves `{ id, status, fact_id }`
    /// for a closed loop whose fact is still active, or null.
    #[napi]
    pub fn closed_loop_with_active_fact<'env>(
        &self,
        env: &'env Env,
        source_id: Option<String>,
        loop_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.closed_loop_with_active_fact(source_id.as_deref(), loop_id)
        })
    }

    /// `loopFactDrift(sourceIds, loopId | null)`: resolves the closed loops whose commitment fact
    /// is still active and held by no open loop, in id order.
    #[napi]
    pub fn loop_fact_drift<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        loop_id: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.loop_fact_drift(&source_ids, loop_id))
    }
}
