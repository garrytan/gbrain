//! The derivation trust members: `lowerTrustTier`, `countDerivedRowTaint` and `stampPageFrontmatter`
//! (`countDerivedFactTaint` is `facts_trust_owner.rs`).
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
use gbrain_store::trust::derivation::{FrontmatterStampSpec, LowerTierSpec, TaintCountQuery};

#[napi]
impl Brain {
    /// `lowerTrustTier(spec)`: lowers listed pages; resolves the ids lowered.
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
