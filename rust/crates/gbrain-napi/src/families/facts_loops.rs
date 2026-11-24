//! Open loops (`gbrain_store::facts::loops`): `upsertOpenLoop`, `listOpenLoops`,
//! `closeOpenLoop`, `closedLoopWithActiveFact` and `loopFactDrift`; and loop mutes
//! (`gbrain_store::facts::loops::mutes`): `addLoopSuppression`, `removeLoopSuppression`,
//! `listLoopSuppressions`, `listMuteRecheckThreads`, `closeMutedLoops`, `requeueMutedLoops`,
//! `closeThreadLoops` and `settleMuteRecheck`.
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

    /// `countOpenLoopsByCounterpartyEmail(sourceId, emails, loopType)`: resolves `{ email, n }`
    /// per email with any open loop of that type in the source.
    #[napi]
    pub fn count_open_loops_by_counterparty_email<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        emails: Vec<String>,
        loop_type: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_open_loops_by_counterparty_email(&source_id, &emails, &loop_type)
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

    /// `readLoopFactState(loopId)`: resolves `{ loop, fact, shared }` (store `read_loop_fact_state`).
    #[napi]
    pub fn read_loop_fact_state<'env>(
        &self,
        env: &'env Env,
        loop_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_loop_fact_state(loop_id))
    }

    /// `expireSourceFactNow(factId, sourceId)`: resolves whether the active fact was expired.
    #[napi]
    pub fn expire_source_fact_now<'env>(
        &self,
        env: &'env Env,
        fact_id: i64,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.expire_source_fact_now(fact_id, &source_id))
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

    /// `addLoopSuppression(sourceId, kind, value)`: resolves null; a row that exists stays.
    #[napi]
    pub fn add_loop_suppression<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        kind: String,
        value: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.add_loop_suppression(&source_id, &kind, &value)
        })
    }

    /// `removeLoopSuppression(sourceId, kind, value)`: resolves the number of rows removed.
    #[napi]
    pub fn remove_loop_suppression<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        kind: String,
        value: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.remove_loop_suppression(&source_id, &kind, &value)
        })
    }

    /// `listLoopSuppressions(sourceId)`: resolves `{ kind, value }` rows by kind, then value.
    #[napi]
    pub fn list_loop_suppressions<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_loop_suppressions(&source_id))
    }

    /// `listMuteRecheckThreads(sourceId)`: resolves `{ thread_id, page_slug }` rows by thread id.
    #[napi]
    pub fn list_mute_recheck_threads<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_mute_recheck_threads(&source_id))
    }

    /// `closeMutedLoops(sourceId, kind, value, apply)`: resolves the loop ids, ascending.
    #[napi]
    pub fn close_muted_loops<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        kind: String,
        value: String,
        apply: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.close_muted_loops(&source_id, &kind, &value, apply)
        })
    }

    /// `requeueMutedLoops(sourceId, kind, value, apply)`: resolves `{ id, thread_id }` rows by id.
    #[napi]
    pub fn requeue_muted_loops<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        kind: String,
        value: String,
        apply: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.requeue_muted_loops(&source_id, &kind, &value, apply)
        })
    }

    /// `closeThreadLoops(sourceId, threadId, closedBy, only | null)`: resolves the number closed.
    #[napi]
    pub fn close_thread_loops<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        thread_id: String,
        closed_by: String,
        only: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.close_thread_loops(&source_id, &thread_id, &closed_by, only.as_deref())
        })
    }

    /// `settleMuteRecheck(sourceId, threadId)`: resolves the number settled.
    #[napi]
    pub fn settle_mute_recheck<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        thread_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.settle_mute_recheck(&source_id, &thread_id))
    }
}
