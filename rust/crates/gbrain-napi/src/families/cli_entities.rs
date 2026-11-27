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

    /// `readMentionIndexStatus({ sourceIds })`: the status rows of those sources, always empty on the store.
    #[napi]
    pub fn read_mention_index_status<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::cli_reads::entities::MentionIndexStatusQuery =
                required(query, "readMentionIndexStatus query")?;
            s.read_mention_index_status(&q)
        })
    }

    /// `countMentionDueSince({ sourceId, since })`: the source's live pages written at or after `since`.
    #[napi]
    pub fn count_mention_due_since<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::cli_reads::entities::MentionDueSinceQuery =
                required(query, "countMentionDueSince query")?;
            s.count_mention_due_since(&q)
        })
    }

    /// `recountMentionIndexStatus({ sourceId, pending, fingerprint, expectedFingerprint })`: a
    /// no-op, since the store keeps no status rows.
    #[napi]
    pub fn recount_mention_index_status<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::cli_reads::entities::MentionIndexRecount =
                required(query, "recountMentionIndexStatus query")?;
            s.recount_mention_index_status(&q)
        })
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

    /// `readSiblingGroupRows(sourceId, slugs, policy)`: the live pages at `slugs` with their
    /// identity; a `null` policy reads every page.
    #[napi]
    pub fn read_sibling_group_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = policy
                .map(|v| {
                    required::<gbrain_store::facts::PrivacyPolicy>(v, "readSiblingGroupRows policy")
                })
                .transpose()?;
            s.read_sibling_group_rows(&source_id, &slugs, policy.as_ref())
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

    /// `readLiveSlugs(sourceId, slugs, limit)`: the live pages among `slugs`, each once; a `null`
    /// `limit` reads them all.
    #[napi]
    pub fn read_live_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        limit: Option<u32>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_live_slugs(&source_id, &slugs, limit.map(|n| n as usize))
        })
    }

    /// `readLivePageTypes(sourceId, slugs, policy)`: the live pages among `slugs` with their types
    /// that the policy admits, each once; a `null` policy reads every page.
    #[napi]
    pub fn read_live_page_types<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = policy
                .map(|v| {
                    required::<gbrain_store::facts::PrivacyPolicy>(v, "readLivePageTypes policy")
                })
                .transpose()?;
            s.read_live_page_types(&source_id, &slugs, policy.as_ref())
        })
    }

    /// `readTrigramCandidates(sourceId, arm, titleLc, slugFragment, policy)`: one resolver arm's
    /// title-similarity candidates, best first; a `null` policy reads every page.
    #[napi]
    pub fn read_trigram_candidates<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        arm: String,
        title_lc: String,
        slug_fragment: String,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = policy
                .map(|v| {
                    required::<gbrain_store::facts::PrivacyPolicy>(
                        v,
                        "readTrigramCandidates policy",
                    )
                })
                .transpose()?;
            s.read_trigram_candidates(&source_id, &arm, &title_lc, &slug_fragment, policy.as_ref())
        })
    }

    /// `readPrefixCandidates(sourceId, patterns, limit)`: the prefix candidates with their
    /// connection counts, most connected first.
    #[napi]
    pub fn read_prefix_candidates<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        patterns: Vec<String>,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_prefix_candidates(&source_id, &patterns, limit as usize)
        })
    }

    /// `readPrefixDirs(sourceId, patterns)`: the distinct entity directories of the prefix pages,
    /// at most two.
    #[napi]
    pub fn read_prefix_dirs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        patterns: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_prefix_dirs(&source_id, &patterns))
    }

    /// `readNamedEntitySlugs(sourceId, slugs, policy)`: the named live, non-retired pages the
    /// policy admits, by slug, at most five; a `null` policy reads every page.
    #[napi]
    pub fn read_named_entity_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = policy
                .map(|v| {
                    required::<gbrain_store::facts::PrivacyPolicy>(v, "readNamedEntitySlugs policy")
                })
                .transpose()?;
            s.read_named_entity_slugs(&source_id, &slugs, policy.as_ref())
        })
    }

    /// `readPrefixTitleMatches(sourceId, patterns, title)`: the prefix pages titled `title`,
    /// ignoring case, at most three.
    #[napi]
    pub fn read_prefix_title_matches<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        patterns: Vec<String>,
        title: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_prefix_title_matches(&source_id, &patterns, &title)
        })
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

    /// `readLivePageFrontmatter(sourceId, slug)`: the live page's type and frontmatter, or null.
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

    #[napi]
    pub fn read_live_page_frontmatter<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_live_page_frontmatter(&source_id, &slug)
        })
    }

    /// `readEntityAnchoredPages(sourceId, entitySlug)`: the live entity page and its anchored pages.
    #[napi]
    pub fn read_entity_anchored_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        entity_slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_entity_anchored_pages(&source_id, &entity_slug)
        })
    }

    /// `readTextMentionPages(sourceIds, slugs)`: the live pages at the slugs in the sources.
    #[napi]
    pub fn read_text_mention_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_text_mention_pages(&source_ids, &slugs))
    }

    /// `readPageTitlesById(ids)`: the title of each page id, deleted or not.
    #[napi]
    pub fn read_page_titles_by_id<'env>(
        &self,
        env: &'env Env,
        ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_titles_by_id(&required::<Vec<i64>>(ids, "readPageTitlesById ids")?)
        })
    }

    /// `readImageSealProbe(sourceId, slug)`: `{ has_visual }` of a sealed image page, or `null`.
    #[napi]
    pub fn read_image_seal_probe<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_image_seal_probe(&source_id, &slug))
    }

    /// `readPageChunkerVersion(pageId)`: `{ chunker_version }` of the page record, or `null`.
    #[napi]
    pub fn read_page_chunker_version<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_chunker_version(required::<i64>(page_id, "readPageChunkerVersion pageId")?)
        })
    }

    /// `readPrefixAnchoredPages(sourceId, prefix)`: the newest live pages under the slug prefix.
    #[napi]
    pub fn read_prefix_anchored_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_prefix_anchored_pages(&source_id, &prefix)
        })
    }
}
