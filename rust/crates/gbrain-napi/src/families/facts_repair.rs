//! Group 5 facts members, repair classifiers and loop retirement: one `#[napi] impl Brain` block over `gbrain_store::facts::repair`.
//!
//! Seven members are served, countLabelFacts with the label line the TypeScript member reads into its
//! literal labels, countPurgedPageFacts over the `page_purges` ledger and listUnwithdrawnFacts over the
//! derived generation ledger (`gbrain_store::facts::generations`, both read only). The one that reads
//! `persistence_requests` is left to the TypeScript member table, which refuses it; the two loop reads
//! live in `facts_loops.rs`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::generations::UnwithdrawnArgs;
use gbrain_store::facts::repair::{
    ClassifyArgs, LabelCountArgs, PurgedCountArgs, TwinArgs, WorldFactArgs,
};

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

    /// `countLabelFacts({ sourceIds, limit, segmentSource, contextContains, labels, terminalSource,
    /// nonExtractableSource })`: resolves how many label facts there are, at most `limit`.
    #[napi]
    pub fn count_label_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LabelCountArgs = required(args, "countLabelFacts args")?;
            s.count_label_facts(&a)
        })
    }

    /// `countPurgedPageFacts({ sourceIds, limit })`: resolves one boolean per counted fact, at most
    /// `limit`: whether a purge record of its page is the evidence.
    #[napi]
    pub fn count_purged_page_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgedCountArgs = required(args, "countPurgedPageFacts args")?;
            s.count_purged_page_facts(&a)
        })
    }

    /// `listUnwithdrawnFacts({ sourceIds, slug, fenceKind })`: resolves the rows of the SQL.
    #[napi]
    pub fn list_unwithdrawn_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UnwithdrawnArgs = required(args, "listUnwithdrawnFacts args")?;
            s.list_unwithdrawn_facts(&a)
        })
    }
}
