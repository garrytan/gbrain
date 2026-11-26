//! The retrieval reflex's page reads and the proactive brief's entity-page read, which the CLI made
//! through `executeRaw` (`src/core/engine-sql/reflex-reads.ts`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

/// The optional page policy a reflex read applies; `null` reads every page.
fn reflex_policy(
    policy: Option<Value>,
    what: &str,
) -> gbrain_store::Result<Option<gbrain_store::facts::PrivacyPolicy>> {
    policy
        .filter(|v| !v.is_null())
        .map(|v| required::<gbrain_store::facts::PrivacyPolicy>(v, what))
        .transpose()
}

#[napi]
impl Brain {
    /// `readReflexLiveKeys(scope, slugs)`: the live (slug, source_id) pairs of the sources at the
    /// slugs; a `null` policy reads every page.
    #[napi]
    pub fn read_reflex_live_keys<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        slugs: Vec<String>,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = reflex_policy(policy, "readReflexLiveKeys policy")?;
            s.read_reflex_live_keys(&source_ids, &slugs, policy.as_ref())
        })
    }

    /// `readReflexPages(scope, match)`: the live pages of the sources the match names, with the
    /// bounded body prefix; a `null` policy reads every page.
    #[napi]
    pub fn read_reflex_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        matcher: Value,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let matcher = required::<gbrain_store::cli_reads::reflex_reads::ReflexPageMatch>(
                matcher,
                "readReflexPages match",
            )?;
            let policy = reflex_policy(policy, "readReflexPages policy")?;
            s.read_reflex_pages(&source_ids, &matcher, policy.as_ref())
        })
    }

    /// `readBriefEntityPages(sourceId, slugs, opts)`: the live pages of the source at the slugs that
    /// the policy and the eligibility admit; a `null` policy reads every page.
    #[napi]
    pub fn read_brief_entity_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        policy: Option<Value>,
        eligibility: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = reflex_policy(policy, "readBriefEntityPages policy")?;
            let eligibility = required::<gbrain_store::cli_reads::reflex_reads::BriefEligibility>(
                eligibility,
                "readBriefEntityPages eligibility",
            )?;
            s.read_brief_entity_pages(&source_id, &slugs, policy.as_ref(), &eligibility)
        })
    }
}
