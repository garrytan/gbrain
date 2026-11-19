//! Facts and their supersession chains.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts` call on the pool
//! through `Brain::run` and resolves plain JSON (rust/README.md, "The brain store"). The
//! TypeScript members (src/core/rust-engine/store-members/facts.ts) apply the defaults and
//! clamps and refuse the options the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `pageCollapseFacts(ids, bodyIds)`: resolves one `{ id, target, body_chars, body, lead }` row
    /// per page found, by id.
    #[napi]
    pub fn page_collapse_facts<'env>(
        &self,
        env: &'env Env,
        ids: Value,
        body_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "pageCollapseFacts ids")?;
            let body_ids: Vec<i64> = required(body_ids, "pageCollapseFacts bodyIds")?;
            s.page_collapse_facts(&ids, &body_ids)
        })
    }
}
