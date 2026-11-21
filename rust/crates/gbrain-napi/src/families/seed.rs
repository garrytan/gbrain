//! The shadow seed: copies one relation of the primary brain into a fresh store.
//!
//! The method decodes the rows, runs one `Store::import_relation` call on the pool through
//! `Brain::run`, and resolves the import counts as plain JSON (rust/docs/store/seed.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::error::StoreError;
use gbrain_store::seed::{DigestInput, KeyInput, SeedRow, fact_fingerprints};

/// A generation from JS: a non-negative whole number a double holds exactly.
fn generation(value: f64) -> Result<u64, StoreError> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= 9_007_199_254_740_991.0
    {
        Ok(value as u64)
    } else {
        Err(StoreError::invalid(
            "generation must be a non-negative whole number",
        ))
    }
}

#[napi]
impl Brain {
    /// `seedPlan()`: the relations `importRelation` takes, in import order, each with the primary
    /// key columns the caller reads the table by: `[{ relation, key }]`.
    #[napi]
    pub fn seed_plan<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |_| Ok(gbrain_store::seed::plan()))
    }

    /// `importRelation(seedId, relation, rows, digests?)`: resolves `{ imported, skipped, dropped,
    /// unmapped_columns, losses }` for the batch. `digests` (`[{ sort, digest }]`, hex, one per
    /// row) also store a generation 0 digest entry per row.
    #[napi]
    pub fn import_relation<'env>(
        &self,
        env: &'env Env,
        seed_id: String,
        relation: String,
        rows: Value,
        digests: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<SeedRow> = required(rows, "importRelation rows")?;
            match digests {
                Some(digests) if !digests.is_null() => {
                    let digests: Vec<DigestInput> = required(digests, "importRelation digests")?;
                    s.import_relation_with_digests(&seed_id, &relation, rows, &digests)
                }
                _ => s.import_relation(&seed_id, &relation, rows),
            }
        })
    }

    /// `replaceRelationRows(seedId, relation, generation, keys, rows, digests)`: resolves
    /// `{ upserted, deleted, skipped_older, dropped, unmapped_columns, losses }`.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn replace_relation_rows<'env>(
        &self,
        env: &'env Env,
        seed_id: String,
        relation: String,
        generation_number: f64,
        keys: Value,
        rows: Value,
        digests: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let generation = generation(generation_number)?;
            let keys: Vec<KeyInput> = required(keys, "replaceRelationRows keys")?;
            let rows: Vec<SeedRow> = required(rows, "replaceRelationRows rows")?;
            let digests: Vec<DigestInput> = required(digests, "replaceRelationRows digests")?;
            s.replace_relation_rows(&seed_id, &relation, generation, &keys, &rows, &digests)
        })
    }

    /// `replaceInterval(seedId, relation, generation, lo, hi, rows, digests)`: resolves the same
    /// shape. `lo` (inclusive) and `hi` (exclusive) are hex sort keys; `null` is unbounded.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn replace_interval<'env>(
        &self,
        env: &'env Env,
        seed_id: String,
        relation: String,
        generation_number: f64,
        lo: Option<String>,
        hi: Option<String>,
        rows: Value,
        digests: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let generation = generation(generation_number)?;
            let rows: Vec<SeedRow> = required(rows, "replaceInterval rows")?;
            let digests: Vec<DigestInput> = required(digests, "replaceInterval digests")?;
            s.replace_interval(
                &seed_id,
                &relation,
                generation,
                lo.as_deref(),
                hi.as_deref(),
                &rows,
                &digests,
            )
        })
    }

    /// `relationDigest(seedId, relation, lo, hi)`: resolves `{ rows, digest }` over the digest
    /// entries with a sort key in `[lo, hi)`.
    #[napi]
    pub fn relation_digest<'env>(
        &self,
        env: &'env Env,
        seed_id: String,
        relation: String,
        lo: Option<String>,
        hi: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.relation_digest(&seed_id, &relation, lo.as_deref(), hi.as_deref())
        })
    }

    /// `factFingerprints(texts)`: resolves `[{ fingerprint, fingerprint_v1 }]`, one per text.
    #[napi]
    pub fn fact_fingerprints<'env>(
        &self,
        env: &'env Env,
        texts: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |_| Ok(fact_fingerprints(&texts)))
    }
}
