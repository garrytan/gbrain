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

    /// `heldGenerationRowsForInput(key, pin)`: resolves the held rows of that input.
    #[napi]
    pub fn held_generation_rows_for_input<'env>(
        &self,
        env: &'env Env,
        key: Value,
        pin: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "heldGenerationRowsForInput key")?;
            s.held_generation_rows_for_input(&key, &pin)
        })
    }

    /// `readHeldGenerationContext(key, holdId)`: resolves `{ held_context }` or null.
    #[napi]
    pub fn read_held_generation_context<'env>(
        &self,
        env: &'env Env,
        key: Value,
        hold_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "readHeldGenerationContext key")?;
            s.read_held_generation_context(&key, &hold_id)
        })
    }

    /// `liveGenerationForOperation(operationId)`: resolves the generation number or null.
    #[napi]
    pub fn live_generation_for_operation<'env>(
        &self,
        env: &'env Env,
        operation_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.live_generation_for_operation(&operation_id))
    }

    /// `countGenerationAttempt(key, holdId, code)`: resolves `{ attempts, codes }`.
    #[napi]
    pub fn count_generation_attempt<'env>(
        &self,
        env: &'env Env,
        key: Value,
        hold_id: String,
        code: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "countGenerationAttempt key")?;
            s.count_generation_attempt(&key, &hold_id, &code)
        })
    }

    /// `clearGenerationAttempts(holdId)`: resolves null.
    #[napi]
    pub fn clear_generation_attempts<'env>(
        &self,
        env: &'env Env,
        hold_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.clear_generation_attempts(&hold_id))
    }

    /// `readGenerationValve(key, windowKey)`: resolves `{ retired, owned }`.
    #[napi]
    pub fn read_generation_valve<'env>(
        &self,
        env: &'env Env,
        key: Value,
        window_key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "readGenerationValve key")?;
            s.read_generation_valve(&key, &window_key)
        })
    }

    /// `bumpGenerationValve(key, windowKey, retired)`: resolves null.
    #[napi]
    pub fn bump_generation_valve<'env>(
        &self,
        env: &'env Env,
        key: Value,
        window_key: String,
        retired: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "bumpGenerationValve key")?;
            s.bump_generation_valve(&key, &window_key, retired)
        })
    }

    /// `scrubGenerationPageRows(sourceId, kinds, slug)`: resolves
    /// `{ derived_generation_items, derived_generations }`.
    #[napi]
    pub fn scrub_generation_page_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        kinds: Vec<String>,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.scrub_generation_page_rows(&source_id, &kinds, &slug)
        })
    }

    /// `scrubGenerationTextRows(sourceId, needles)`: resolves
    /// `{ derived_generation_items, derived_generations }`.
    #[napi]
    pub fn scrub_generation_text_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        needles: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.scrub_generation_text_rows(&source_id, &needles)
        })
    }
}
