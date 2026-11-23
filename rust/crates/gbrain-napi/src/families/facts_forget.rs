//! The facts members a forget and a proposal review use: `readFactForForget`, `expireFactSuperseded`,
//! `expireFactAtDate` and `readWithdrawalAnchor`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::forget` call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/facts-forget.ts) refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::forget::{ExpireAtDateArgs, ExpireSupersededArgs, WithdrawalAnchorArgs};

#[napi]
impl Brain {
    /// `expireFactSuperseded(args)`: ends and expires an active fact; resolves null.
    #[napi]
    pub fn expire_fact_superseded<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExpireSupersededArgs = required(args, "expireFactSuperseded args")?;
            s.expire_fact_superseded(&a)
        })
    }

    /// `expireFactAtDate(args)`: ends an active fact on a date and expires it; resolves null.
    #[napi]
    pub fn expire_fact_at_date<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExpireAtDateArgs = required(args, "expireFactAtDate args")?;
            s.expire_fact_at_date(&a)
        })
    }

    /// `readWithdrawalAnchor(args)`: resolves `{ withdrawn }` for a fact of the source, or null.
    #[napi]
    pub fn read_withdrawal_anchor<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: WithdrawalAnchorArgs = required(args, "readWithdrawalAnchor args")?;
            s.read_withdrawal_anchor(&a)
        })
    }
}
