//! The shadow seed: copies one relation of the primary brain into a fresh store.
//!
//! The method decodes the rows, runs one `Store::import_relation` call on the pool through
//! `Brain::run`, and resolves the import counts as plain JSON (rust/docs/store/seed.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;
use std::collections::BTreeMap;

use crate::store_binding::{Brain, required};
use gbrain_store::error::StoreError;
use gbrain_store::seed::{DigestInput, KeyInput, SeedRow, fact_fingerprints};

/// A non-negative whole number from JS that a double holds exactly.
fn whole_number(value: f64, what: &str) -> Result<u64, StoreError> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= 9_007_199_254_740_991.0
    {
        Ok(value as u64)
    } else {
        Err(StoreError::invalid(format!(
            "{what} must be a non-negative whole number"
        )))
    }
}

/// A generation from JS.
fn generation(value: f64) -> Result<u64, StoreError> {
    whole_number(value, "generation")
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
    /// `{ upserted, deleted, skipped_older, displaced, dropped, unmapped_columns, losses }`.
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

    /// `relationEntries(seedId, relation, lo, hi, limit)`: resolves `[{ sort, digest, generation }]`,
    /// the digest entries with a sort key in `[lo, hi)` in sort order, at most `limit` (1 to 5000).
    #[napi]
    pub fn relation_entries<'env>(
        &self,
        env: &'env Env,
        seed_id: String,
        relation: String,
        lo: Option<String>,
        hi: Option<String>,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let limit = whole_number(limit, "limit")?;
            s.relation_entries(&seed_id, &relation, lo.as_deref(), hi.as_deref(), limit)
        })
    }

    /// `allocatorCheck(seedId, primaryMax)`: resolves `[{ relation, counter, primary_max, ok }]` for
    /// every relation that keeps an id counter. `primaryMax` is `{ [relation]: text | null }`.
    #[napi]
    pub fn allocator_check<'env>(
        &self,
        env: &'env Env,
        seed_id: String,
        primary_max: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let primary_max: BTreeMap<String, Option<String>> =
                required(primary_max, "allocatorCheck primaryMax")?;
            s.allocator_check(&seed_id, &primary_max)
        })
    }

    /// `allocatorAdvance(seedId, primaryFloor)`: raises every id counter to at least the floor, the
    /// primary's highest id as text, and resolves the `allocatorCheck` report taken after the
    /// write. `primaryFloor` is `{ [relation]: text | null }`; a counter is never lowered.
    #[napi]
    pub fn allocator_advance<'env>(
        &self,
        env: &'env Env,
        seed_id: String,
        primary_floor: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let floors: BTreeMap<String, Option<String>> =
                required(primary_floor, "allocatorAdvance primaryFloor")?;
            s.allocator_advance(&seed_id, &floors)
        })
    }
}
