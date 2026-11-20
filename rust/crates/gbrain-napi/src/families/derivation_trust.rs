//! The derivation trust members: `lowerTrustTier`, `countDerivedRowTaint`, `countDerivedFactTaint`,
//! `stampPageFrontmatter`, and the propagation members `lowerDerivedDependents`,
//! `readTierProjectionPage`, `queuePageProjection` and `locateRetierSubjects`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::trust::derivation` call on
//! the pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/derivation-trust.ts and facts-trust.ts) refuse what the
//! store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::persistence::QueueProjectionSpec;
use gbrain_store::trust::derivation::{FrontmatterStampSpec, LowerTierSpec, TaintCountQuery};
use gbrain_store::trust::propagation::{
    LowerDependentsSpec, RetierSubjectsQuery, TierProjectionQuery,
};

#[napi]
impl Brain {
    /// `lowerTrustTier(spec)`: lowers listed rows of one table; resolves the ids lowered.
    #[napi]
    pub fn lower_trust_tier<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LowerTierSpec = required(spec, "lowerTrustTier spec")?;
            s.lower_trust_tier(&a)
        })
    }

    /// `countDerivedRowTaint(spec)`: resolves `{ derived, external }` for one table.
    #[napi]
    pub fn count_derived_row_taint<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TaintCountQuery = required(spec, "countDerivedRowTaint spec")?;
            s.count_derived_row_taint(&a)
        })
    }

    /// `countDerivedFactTaint()`: resolves `{ derived, external }` for the facts.
    #[napi]
    pub fn count_derived_fact_taint<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_derived_fact_taint())
    }

    /// `stampPageFrontmatter(spec)`: applies one fixed frontmatter stamp.
    #[napi]
    pub fn stamp_page_frontmatter<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FrontmatterStampSpec = required(spec, "stampPageFrontmatter spec")?;
            s.stamp_page_frontmatter(&a)
        })
    }
}

#[napi]
impl Brain {
    /// `lowerDerivedDependents(spec)`: one hop of the derived-tier propagation; resolves the rows lowered.
    #[napi]
    pub fn lower_derived_dependents<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LowerDependentsSpec = required(spec, "lowerDerivedDependents spec")?;
            s.lower_derived_dependents(&a)
        })
    }

    /// `readTierProjectionPage(spec)`: resolves `{ source_id, slug }` or null.
    #[napi]
    pub fn read_tier_projection_page<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TierProjectionQuery = required(spec, "readTierProjectionPage spec")?;
            s.read_tier_projection_page(&a)
        })
    }

    /// `queuePageProjection(spec)`: queues the live page's revision with a reason.
    #[napi]
    pub fn queue_page_projection<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: QueueProjectionSpec = required(spec, "queuePageProjection spec")?;
            s.queue_page_projection_job(&a)
        })
    }

    /// `locateRetierSubjects(spec)`: resolves `{ t, id, source_id, slug }` per listed row.
    #[napi]
    pub fn locate_retier_subjects<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RetierSubjectsQuery = required(spec, "locateRetierSubjects spec")?;
            s.locate_retier_subjects(&a)
        })
    }
}
