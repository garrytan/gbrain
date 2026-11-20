//! The withdrawal check a prepared import runs on a malformed facts fence: `hasWithdrawnFenceClaim`.
//!
//! One `#[napi] impl Brain` block; the method decodes the claims, runs one
//! `gbrain_store::facts::withdrawal_fence` call on the pool through `Brain::run` and resolves a boolean.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `hasWithdrawnFenceClaim(sourceId, [{ claim, visibility }], subject | null)`: resolves a boolean.
    #[napi]
    pub fn has_withdrawn_fence_claim<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        claims: Value,
        subject: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let claims: Vec<gbrain_store::facts::withdrawal_fence::FenceClaim> =
                required(claims, "hasWithdrawnFenceClaim claims")?;
            s.has_withdrawn_fence_claim(&source_id, &claims, subject.as_deref())
        })
    }
}
