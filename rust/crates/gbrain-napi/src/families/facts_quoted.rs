//! The slot-history read: `listReadablePageSlugs`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::quoted` call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members (src/core/rust-engine/store-members/facts-quoted.ts)
//! resolve the caller's read policy.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::quoted::ReadablePageSlugsQuery;

#[napi]
impl Brain {
    /// `listReadablePageSlugs({ sourceId, slugs, scope, limit })`: resolves the admitted slugs.
    #[napi]
    pub fn list_readable_page_slugs<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ReadablePageSlugsQuery = required(args, "listReadablePageSlugs args")?;
            s.list_readable_page_slugs(&a)
        })
    }
}
