//! The legacy_slug_spellings doctor check's page scan served from the store (`gbrain-store`
//! `slug_spelling_repair`). The TypeScript member (`src/core/rust-engine/store-members/slug-spelling-repair.ts`)
//! answers the row-security read without a call: the store has no row-level security.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listSlugSpellingCandidates(afterId, limit)`: resolves `[{ id, source_id, slug }]` in id order.
    #[napi]
    pub fn list_slug_spelling_candidates<'env>(
        &self,
        env: &'env Env,
        after_id: f64,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            if !(after_id.is_finite() && after_id >= 0.0 && after_id.fract() == 0.0) {
                return Err(gbrain_store::error::StoreError::invalid(format!(
                    "listSlugSpellingCandidates afterId must be a non-negative integer, got {after_id}"
                )));
            }
            s.list_slug_spelling_candidates(after_id as u64, limit as usize)
        })
    }
}
