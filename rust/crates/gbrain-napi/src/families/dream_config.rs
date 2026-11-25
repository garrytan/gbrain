//! The dream map config members: `ensureDreamMapConfigRow`, `lockDreamMapConfigRow`, `writeDreamMapConfigRow` and
//! `recordDreamBreakerReset`.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::dream_config` call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members (src/core/rust-engine/store-members/dream-config.ts)
//! map the results onto the BrainEngine shapes.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::dream_config::{DreamBreakerResetArgs, DreamMapKeyArgs, DreamMapWriteArgs};

#[napi]
impl Brain {
    /// `ensureDreamMapConfigRow(args)`: creates the row holding `{}` when it is missing; resolves null.
    #[napi]
    pub fn ensure_dream_map_config_row<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DreamMapKeyArgs = required(args, "ensureDreamMapConfigRow args")?;
            s.ensure_dream_map_config_row(&a)
        })
    }

    /// `lockDreamMapConfigRow(args)`: resolves `{ value, now }` or null.
    #[napi]
    pub fn lock_dream_map_config_row<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DreamMapKeyArgs = required(args, "lockDreamMapConfigRow args")?;
            s.lock_dream_map_config_row(&a)
        })
    }

    /// `writeDreamMapConfigRow(args)`: updates an existing row; resolves null.
    #[napi]
    pub fn write_dream_map_config_row<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DreamMapWriteArgs = required(args, "writeDreamMapConfigRow args")?;
            s.write_dream_map_config_row(&a)
        })
    }

    /// `recordDreamBreakerReset(args)`: rewrites the reset map; resolves null.
    #[napi]
    pub fn record_dream_breaker_reset<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DreamBreakerResetArgs = required(args, "recordDreamBreakerReset args")?;
            s.record_dream_breaker_reset(&a)
        })
    }
}
