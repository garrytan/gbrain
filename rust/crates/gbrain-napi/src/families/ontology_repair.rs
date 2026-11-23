//! Group 5 facts members, the ontology re-key and repair statements: one `#[napi] impl Brain` block over
//! `gbrain_store::facts::ontology_repair` (src/core/engine-sql/ontology-repair.ts).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and resolves plain JSON
//! (rust/README.md, "The brain store"). A re-key move arrives as the names of its closed shapes.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::ontology_repair::{IdsArgs, RekeyArgs, RepointArgs, RestoreArgs};

#[napi]
impl Brain {
    /// `listRekeyLosers({ sourceId, where, entity, sms, params })`: resolves `[{ id, keep }]` by id.
    #[napi]
    pub fn list_rekey_losers<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RekeyArgs = required(args, "listRekeyLosers args")?;
            s.list_rekey_losers(&a)
        })
    }

    /// `repointSupersededToKept({ ids, keeps })`: resolves null.
    #[napi]
    pub fn repoint_superseded_to_kept<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RepointArgs = required(args, "repointSupersededToKept args")?;
            s.repoint_superseded_to_kept(&a)
        })
    }

    /// `clearOntologySlots({ ids })`: resolves null.
    #[napi]
    pub fn clear_ontology_slots<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: IdsArgs = required(args, "clearOntologySlots args")?;
            s.clear_ontology_slots(&a)
        })
    }

    /// `deleteRekeyLosers({ ids })`: resolves null.
    #[napi]
    pub fn delete_rekey_losers<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: IdsArgs = required(args, "deleteRekeyLosers args")?;
            s.delete_rekey_losers(&a)
        })
    }

    /// `restoreOntologyFact({ id, sourceId, rowNum, page, expiredAt })`: resolves `[{ id, expired }]`, none when the row changed.
    #[napi]
    pub fn restore_ontology_fact<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RestoreArgs = required(args, "restoreOntologyFact args")?;
            s.restore_ontology_fact(&a)
        })
    }
}
