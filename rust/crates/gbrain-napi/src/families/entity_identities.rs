//! Entity identity groups: link, unlink, list, the page-group lookup and the canonical twin
//! (rust/docs/store/entity_identities.md).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `linkEntityIdentityRow(input)`: resolves true when the live page was linked, false with no
    /// live page (`IdentityLink`).
    #[napi]
    pub fn link_entity_identity<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::entity_identities::IdentityLink =
                required(input, "linkEntityIdentityRow input")?;
            s.link_entity_identity(&input)
        })
    }

    /// `unlinkEntityIdentityRow(entityId, slug, sourceId)`: resolves true when a membership was
    /// removed.
    #[napi]
    pub fn unlink_entity_identity<'env>(
        &self,
        env: &'env Env,
        entity_id: String,
        slug: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.unlink_entity_identity(&entity_id, &slug, &source_id)
        })
    }

    /// `listEntityIdentityRows(filter)`: resolves the member rows by entity id, canonical first,
    /// source, then slug (`IdentityFilter`).
    #[napi]
    pub fn list_entity_identities<'env>(
        &self,
        env: &'env Env,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let filter: gbrain_store::entity_identities::IdentityFilter =
                required(filter, "listEntityIdentityRows filter")?;
            s.list_entity_identities(&filter)
        })
    }

    /// `readEntityIdentityIdsForPages(sourceIds, slugs)`: resolves `{ entity_id, source_id, slug }`
    /// rows by source then slug.
    #[napi]
    pub fn read_entity_identity_ids_for_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
        slugs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let source_ids: Vec<String> =
                required(source_ids, "readEntityIdentityIdsForPages sourceIds")?;
            let slugs: Vec<String> = required(slugs, "readEntityIdentityIdsForPages slugs")?;
            s.read_entity_identity_ids_for_pages(&source_ids, &slugs)
        })
    }

    /// `readCanonicalTwin(sourceId, slug)`: resolves at most two `{ slug, source_id }` rows.
    #[napi]
    pub fn read_canonical_twin<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_canonical_twin(&source_id, &slug))
    }
}
