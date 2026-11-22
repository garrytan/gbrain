//! The candidate-pool reads of a fact recall served so far: `listSlotRows` (the rest of lane 4's six are rust-5a's).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::recall` call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members (src/core/rust-engine/store-members/facts-recall.ts)
//! resolve the caller's read policy and refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::recall::SlotArgs;

#[napi]
impl Brain {
    /// `listSlotRows(args)`: resolves the active slot rows of the slots.
    #[napi]
    pub fn list_slot_rows<'env>(&self, env: &'env Env, args: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SlotArgs = required(args, "listSlotRows args")?;
            s.list_slot_rows(&a)
        })
    }
}
