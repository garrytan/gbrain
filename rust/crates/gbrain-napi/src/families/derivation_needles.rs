//! The derivation-claim normalizer of `engine-sql/collate-store-reads.ts` (rust/docs/store/facts.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `normalizeDerivationClaims(claims)`: the distinct, non-empty folded normalized claims, by byte.
    #[napi]
    pub fn normalize_derivation_claims<'env>(
        &self,
        env: &'env Env,
        claims: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.normalize_derivation_claims(&claims))
    }
}
