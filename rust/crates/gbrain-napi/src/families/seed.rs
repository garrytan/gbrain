//! The shadow seed: copies one relation of the primary brain into a fresh store.
//!
//! The method decodes the rows, runs one `Store::import_relation` call on the pool through
//! `Brain::run`, and resolves the import counts as plain JSON (rust/docs/store/seed.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::seed::SeedRow;

#[napi]
impl Brain {
    /// `seedPlan()`: the relations `importRelation` takes, in import order, each with the primary
    /// key columns the caller reads the table by: `[{ relation, key }]`.
    #[napi]
    pub fn seed_plan<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |_| Ok(gbrain_store::seed::plan()))
    }

    /// `importRelation(seedId, relation, rows)`: resolves `{ imported, skipped, dropped,
    /// unmapped_columns, losses }` for the batch.
    #[napi]
    pub fn import_relation<'env>(
        &self,
        env: &'env Env,
        seed_id: String,
        relation: String,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<SeedRow> = required(rows, "importRelation rows")?;
            s.import_relation(&seed_id, &relation, rows)
        })
    }
}
