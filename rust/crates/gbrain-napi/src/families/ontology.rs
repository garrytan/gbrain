//! Ontology dimensions over facts.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::ontology` call on the pool
//! through `Brain::run` and resolves plain JSON (rust/README.md, "The brain store"). The
//! TypeScript members (src/core/rust-engine/store-members/ontology.ts) normalise the dimension,
//! compute the value hash, turn times into ISO text and refuse the options the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::ontology::{OntologyObservation, OntologyQuery};

#[napi]
impl Brain {
    /// `mergeOntologyFact(obs)`: resolves `{ action, factId, supersededId }`.
    #[napi]
    pub fn merge_ontology_fact<'env>(
        &self,
        env: &'env Env,
        obs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let o: OntologyObservation = required(obs, "mergeOntologyFact obs")?;
            s.merge_ontology_fact(&o)
        })
    }

    /// `getOntology(entitySlug, opts)`: resolves the current value of each dimension.
    #[napi]
    pub fn get_ontology<'env>(&self, env: &'env Env, query: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: OntologyQuery = required(query, "getOntology query")?;
            s.get_ontology(&q)
        })
    }

    /// `discoverOntologyDimensions(opts)`: resolves `{ dimension, entities, observations }[]`.
    #[napi]
    pub fn discover_ontology_dimensions<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: OntologyQuery = required(query, "discoverOntologyDimensions query")?;
            s.discover_ontology_dimensions(&q)
        })
    }

    /// `findOntologyConflicts(opts)`: resolves `{ entity_slug, dimension, values }[]`.
    #[napi]
    pub fn find_ontology_conflicts<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: OntologyQuery = required(query, "findOntologyConflicts query")?;
            s.find_ontology_conflicts(&q)
        })
    }

    /// `listOntologyStreamSlugs(sourceId, entitySlug, dimension)`: resolves the open stints'
    /// provenance slugs.
    #[napi]
    pub fn list_ontology_stream_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        entity_slug: String,
        dimension: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_ontology_stream_slugs(&source_id, &entity_slug, &dimension)
        })
    }

    /// `listBeliefStreamSlugs(table, ids)`: resolves each found row's stream slug (or null).
    #[napi]
    pub fn list_belief_stream_slugs<'env>(
        &self,
        env: &'env Env,
        table: String,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "listBeliefStreamSlugs ids")?;
            s.list_belief_stream_slugs(&table, &ids)
        })
    }

    /// `readOntologyRival(sourceId, entitySlug, dimension, excludeId)`: resolves `{ id, trust_tier }`
    /// or null.
    #[napi]
    pub fn read_ontology_rival<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        entity_slug: String,
        dimension: String,
        exclude_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_ontology_rival(&source_id, &entity_slug, &dimension, exclude_id)
        })
    }
}
