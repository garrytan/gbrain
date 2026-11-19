//! Derived generations: the generation ledger of `src/core/generations/publish.ts` and the held
//! fence rows of `generations/fence.ts` (`gbrain_store::generations`).
//!
//! One `#[napi] impl Brain` block per family file; each method runs one `Store` call on the pool
//! through `Brain::run` and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::generations::{ActivationInput, GenerationKey, HeldInput, LedgerItemInput};

#[napi]
impl Brain {
    /// `readLiveGenerationRow(key)`: resolves the live row with its owned items, or null.
    #[napi]
    pub fn read_live_generation_row<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "readLiveGenerationRow key")?;
            s.read_live_generation_row(&key)
        })
    }

    /// `activateGenerationRows(key, liveId, row, items)`: resolves the new live row's id.
    #[napi]
    pub fn activate_generation_rows<'env>(
        &self,
        env: &'env Env,
        key: Value,
        live_id: Option<f64>,
        row: Value,
        items: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "activateGenerationRows key")?;
            let row: ActivationInput = required(row, "activateGenerationRows row")?;
            let items: Vec<LedgerItemInput> = required(items, "activateGenerationRows items")?;
            s.activate_generation_rows(&key, live_id, &row, &items)
        })
    }

    /// `recordHeldGenerationRow(key, row)`: resolves null.
    #[napi]
    pub fn record_held_generation_row<'env>(
        &self,
        env: &'env Env,
        key: Value,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "recordHeldGenerationRow key")?;
            let row: HeldInput = required(row, "recordHeldGenerationRow row")?;
            s.record_held_generation_row(&key, &row)
        })
    }

    /// `listFenceHoldRows(sourceIds, kinds, ownerKey?)`: resolves the held rows, oldest first.
    #[napi]
    pub fn list_fence_hold_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        kinds: Vec<String>,
        owner_key: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_fence_hold_rows(&source_ids, &kinds, owner_key.as_deref())
        })
    }

    /// `clearFenceHoldRows(key)`: resolves null.
    #[napi]
    pub fn clear_fence_hold_rows<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "clearFenceHoldRows key")?;
            s.clear_fence_hold_rows(&key)
        })
    }
}
