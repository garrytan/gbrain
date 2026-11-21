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

    /// `findExactBasenameCandidates(sourceId, slugs)`: at most two live slugs, in slug byte order.
    #[napi]
    pub fn find_exact_basename_candidates<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_exact_basename_candidates(&source_id, &slugs)
        })
    }

    /// `readRetirementHop(sourceId, slug, policy)`: the live page with its retirement and redirect
    /// target, or `null`; a `null` policy reads every page.
    #[napi]
    pub fn read_retirement_hop<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = policy
                .map(|v| {
                    required::<gbrain_store::facts::PrivacyPolicy>(v, "readRetirementHop policy")
                })
                .transpose()?;
            s.read_retirement_hop(&source_id, &slug, policy.as_ref())
        })
    }

    /// `readEntityCardRows(sourceId, match, policy)`: the entity card's candidate rows; a `null`
    /// policy reads every page.
    #[napi]
    pub fn read_entity_card_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        matcher: Value,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let matcher = required::<gbrain_store::cli_reads::entities::EntityCardMatch>(
                matcher,
                "readEntityCardRows match",
            )?;
            let policy = policy
                .map(|v| {
                    required::<gbrain_store::facts::PrivacyPolicy>(v, "readEntityCardRows policy")
                })
                .transpose()?;
            s.read_entity_card_rows(&source_id, &matcher, policy.as_ref())
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

    /// `listUnretiredPagesBySlugPattern(sourceId, patterns, limit)`: live, unretired pages by slug.
    #[napi]
    pub fn list_unretired_pages_by_slug_pattern<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        patterns: Vec<String>,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        let limit = u64::try_from(limit).unwrap_or(0);
        self.run(env, move |s| {
            s.list_unretired_pages_by_slug_pattern(&source_id, &patterns, limit)
        })
    }

    /// `listNameVariantCandidates(sourceId, { types, slugPatterns, probes, limit })`.
    #[napi]
    pub fn list_name_variant_candidates<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_name_variant_candidates(
                &source_id,
                &required(query, "listNameVariantCandidates query")?,
            )
        })
    }

    /// `listVisibleNameVariantCandidates(sourceId, query, policy)`: the candidates under the page
    /// policy; a `null` policy reads every page.
    #[napi]
    pub fn list_visible_name_variant_candidates<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        query: Value,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query = required(query, "listVisibleNameVariantCandidates query")?;
            let policy = policy
                .map(|v| {
                    required::<gbrain_store::facts::PrivacyPolicy>(
                        v,
                        "listVisibleNameVariantCandidates policy",
                    )
                })
                .transpose()?;
            s.list_visible_name_variant_candidates(&source_id, &query, policy.as_ref())
        })
    }

    /// `listNameVariantCardCandidates(sourceId, query, policy)`: the candidates as entity-card
    /// rows with their probe hits; a `null` policy reads every page.
    #[napi]
    pub fn list_name_variant_card_candidates<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        query: Value,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query = required(query, "listNameVariantCardCandidates query")?;
            let policy = policy
                .map(|v| {
                    required::<gbrain_store::facts::PrivacyPolicy>(
                        v,
                        "listNameVariantCardCandidates policy",
                    )
                })
                .transpose()?;
            s.list_name_variant_card_candidates(&source_id, &query, policy.as_ref())
        })
    }

    /// `readVisibleVariantPages(sourceId, slugs, policy)`: the live pages at `slugs` in list order;
    /// a `null` policy reads every page.
    #[napi]
    pub fn read_visible_variant_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = policy
                .map(|v| {
                    required::<gbrain_store::facts::PrivacyPolicy>(
                        v,
                        "readVisibleVariantPages policy",
                    )
                })
                .transpose()?;
            s.read_visible_variant_pages(&source_id, &slugs, policy.as_ref())
        })
    }

    /// `countDistinctInboundLinkers(sourceIds, slugs)`: distinct inbound linkers per page.
    #[napi]
    pub fn count_distinct_inbound_linkers<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_distinct_inbound_linkers(&source_ids, &slugs)
        })
    }
}
