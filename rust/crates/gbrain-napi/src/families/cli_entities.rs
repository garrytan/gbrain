//! Entity and mention reads the CLI made through `executeRaw` (`src/core/engine-sql/entity-reads.ts`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readMentionLastPass(sourceId?)`: the last mention pass time, always `null` on the store.
    #[napi]
    pub fn read_mention_last_pass<'env>(
        &self,
        env: &'env Env,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_mention_last_pass(source_id.as_deref()))
    }

    /// `countPagesDueForMentions({ sourceId? })`: the live pages in scope.
    #[napi]
    pub fn count_pages_due_for_mentions<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_pages_due_for_mentions(&required(query, "countPagesDueForMentions query")?)
        })
    }

    /// `readIdentitySiblingCandidates(sourceId, { types, subject, limit, excludeQuarantined? })`.
    #[napi]
    pub fn read_identity_sibling_candidates<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_identity_sibling_candidates(
                &source_id,
                &required(query, "readIdentitySiblingCandidates query")?,
            )
        })
    }

    /// `findExactSlug(sourceId, slugs, retired)`: the first matching slug or `null`; a `null`
    /// `retired` matches live pages either way.
    #[napi]
    pub fn find_exact_slug<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        retired: Option<bool>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.find_exact_slug(&source_id, &slugs, retired))
    }

    /// `findFuzzyEntityCandidates(sourceId, title, fragment)`: up to five `{ slug, title, type,
    /// score }` rows, best pg_trgm score first.
    #[napi]
    pub fn find_fuzzy_entity_candidates<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        title: String,
        fragment: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_fuzzy_entity_candidates(&source_id, &title, &fragment)
        })
    }

    /// `readIgnoredPrivacyLabelPages(sourceId, { slugs } | { since })`: labelled candidate pages.
    #[napi]
    pub fn read_ignored_privacy_label_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        scope: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_ignored_privacy_label_pages(
                &source_id,
                &required(scope, "readIgnoredPrivacyLabelPages scope")?,
            )
        })
    }
}
