//! A purge's Git effect statements: the effects whose commit message quotes a purged claim, the
//! effects of a purged page, and the rewrite of one effect's data.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::persistence` call on the
//! pool through `Brain::run` and resolves plain JSON (src/core/rust-engine/store-members/purge-effects.ts).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::persistence::{GitEffectsCarryingArgs, PageGitEffectsArgs, PurgeEffectDataArgs};

#[napi]
impl Brain {
    /// `listGitEffectsCarryingReason({ sourceId, needle, escaped, foldedJson })`: resolves the
    /// carrying Git effects in id order.
    #[napi]
    pub fn list_git_effects_carrying_reason<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: GitEffectsCarryingArgs = required(args, "listGitEffectsCarryingReason args")?;
            s.list_git_effects_carrying_reason(&a)
        })
    }

    /// `listPageGitEffectsForStrip({ sourceId, slug })`: resolves the slug's Git effects that
    /// carry a commit line or trailers, in id order.
    #[napi]
    pub fn list_page_git_effects_for_strip<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageGitEffectsArgs = required(args, "listPageGitEffectsForStrip args")?;
            s.list_page_git_effects_for_strip(&a)
        })
    }

    /// `setPurgeEffectData({ effectId, data })`: `data` is the JSON text of the new data.
    #[napi]
    pub fn set_purge_effect_data<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeEffectDataArgs = required(args, "setPurgeEffectData args")?;
            s.set_purge_effect_data(&a)
        })
    }
}
