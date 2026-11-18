//! Group 5 facts members, repair classifiers and loop retirement: one `#[napi] impl Brain` block over `gbrain_store::facts::repair`.
//!
//! Four members are served; the five that read `open_loops`, `fact_withdrawals`, `persistence_requests`,
//! `page_purges` or the derived-generation tables are left to the TypeScript member table, which refuses them.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::repair::{ClassifyArgs, TwinArgs, WorldFactArgs};

#[napi]
impl Brain {
    /// `listSessionFactsForClassification({ sourceIds, lanes, ids })`: resolves the fact rows.
    #[napi]
    pub fn list_session_facts_for_classification<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClassifyArgs = required(args, "listSessionFactsForClassification args")?;
            s.list_session_facts_for_classification(&a)
        })
    }

    /// `listSessionFactTwins({ ids, lanes })`: resolves `{ id, owner_twin, twin_sessions }` per fact.
    #[napi]
    pub fn list_session_fact_twins<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TwinArgs = required(args, "listSessionFactTwins args")?;
            s.list_session_fact_twins(&a)
        })
    }

    /// `listCapturedFactsForClassification({ sourceIds, lanes, ids })`: resolves the fact rows with
    /// their fingerprint and `legit_twin`.
    #[napi]
    pub fn list_captured_facts_for_classification<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClassifyArgs = required(args, "listCapturedFactsForClassification args")?;
            s.list_captured_facts_for_classification(&a)
        })
    }

    /// `listWorldFactsFromPrivateSources({ sourceIds, ids, honorAliases })`: resolves the world facts
    /// held in or extracted from a private page, with `readable`.
    #[napi]
    pub fn list_world_facts_from_private_sources<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: WorldFactArgs = required(args, "listWorldFactsFromPrivateSources args")?;
            s.list_world_facts_from_private_sources(&a)
        })
    }
}
