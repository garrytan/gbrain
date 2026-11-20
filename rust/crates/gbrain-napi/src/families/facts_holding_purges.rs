//! `insertHoldingPagePurges`: the tombstones a fact purge stores under the holding pages of the facts it removes.
//!
//! One `#[napi] impl Brain` block; the method runs one `gbrain_store::facts::holding_purges` call on the pool through
//! `Brain::run` and resolves null. The TypeScript member
//! (src/core/rust-engine/store-members/facts-holding-purges.ts) sends the arguments of its BrainEngine member.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::holding_purges::HoldingPagePurgeArgs;

#[napi]
impl Brain {
    /// `insertHoldingPagePurges(args)`: stores the holding page tombstones; resolves null.
    #[napi]
    pub fn insert_holding_page_purges<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HoldingPagePurgeArgs = required(args, "insertHoldingPagePurges args")?;
            s.insert_holding_page_purges(&a).map(|_| Value::Null)
        })
    }
}
