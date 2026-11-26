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
use gbrain_store::generations::{
    ActivationInput, ActivationRecordInput, GenerationKey, GenerationPageRowsQuery, HeldInput,
    LedgerItemInput, RepairFilter,
};

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

    /// `readGenerationRestored(key)`: resolves whether the key's live row is a restore.
    #[napi]
    pub fn read_generation_restored<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "readGenerationRestored key")?;
            s.read_generation_restored(&key)
        })
    }

    /// `clearTieHeldGenerationRows(sourceId, kind, ownerPrefix)`: resolves null.
    #[napi]
    pub fn clear_tie_held_generation_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        kind: String,
        owner_prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.clear_tie_held_generation_rows(&source_id, &kind, &owner_prefix)
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

    /// `recordGenerationActivation(key, row)`: resolves null; `row.members` is JSON text.
    #[napi]
    pub fn record_generation_activation<'env>(
        &self,
        env: &'env Env,
        key: Value,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "recordGenerationActivation key")?;
            let row: ActivationRecordInput = required(row, "recordGenerationActivation row")?;
            s.record_generation_activation(&key, &row)
        })
    }

    /// `markGenerationActivated(activationId, generationId)`: resolves null.
    #[napi]
    pub fn mark_generation_activated<'env>(
        &self,
        env: &'env Env,
        activation_id: String,
        generation_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.mark_generation_activated(&activation_id, generation_id)
        })
    }

    /// `readGenerationActivationState(activationId, slug, sourceId)`: resolves
    /// `{ state, generation_state, pending }` or null.
    #[napi]
    pub fn read_generation_activation_state<'env>(
        &self,
        env: &'env Env,
        activation_id: String,
        slug: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_generation_activation_state(&activation_id, &slug, &source_id)
        })
    }

    /// `settleGenerationMember(activationId, slug)`: resolves null.
    #[napi]
    pub fn settle_generation_member<'env>(
        &self,
        env: &'env Env,
        activation_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.settle_generation_member(&activation_id, &slug)
        })
    }

    /// `listPendingGenerationMembers(sourceIds, kind)`: resolves the pending member rows.
    #[napi]
    pub fn list_pending_generation_members<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        kind: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_pending_generation_members(&source_ids, kind.as_deref())
        })
    }

    /// `listGenerationOrphanCandidates(sourceIds, kind)`: resolves the orphan candidate rows.
    #[napi]
    pub fn list_generation_orphan_candidates<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        kind: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_generation_orphan_candidates(&source_ids, kind.as_deref())
        })
    }

    /// `readGenerationItemsByIds(ids)`: resolves the ledger items of those generations.
    #[napi]
    pub fn read_generation_items_by_ids<'env>(
        &self,
        env: &'env Env,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_generation_items_by_ids(&ids))
    }

    /// `listUnmatchedGenerationRows(sourceIds, kind, filter)`: resolves the live rows with
    /// unmatched predecessors.
    #[napi]
    pub fn list_unmatched_generation_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        kind: String,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let filter: RepairFilter = required(filter, "listUnmatchedGenerationRows filter")?;
            s.list_unmatched_generation_rows(&source_ids, &kind, &filter)
        })
    }

    /// `listRestorableGenerationRows(sourceIds, kind, filter)`: resolves the live rows with their
    /// superseded predecessors.
    #[napi]
    pub fn list_restorable_generation_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        kind: String,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let filter: RepairFilter = required(filter, "listRestorableGenerationRows filter")?;
            s.list_restorable_generation_rows(&source_ids, &kind, &filter)
        })
    }

    /// `listHeldGenerationRows(sourceIds, kind, filter)`: resolves the held rows.
    #[napi]
    pub fn list_held_generation_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        kind: String,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let filter: RepairFilter = required(filter, "listHeldGenerationRows filter")?;
            s.list_held_generation_rows(&source_ids, &kind, &filter)
        })
    }

    /// `readHeldGenerationProposal(id)`: resolves `{ proposal, hold_id }` or null.
    #[napi]
    pub fn read_held_generation_proposal<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_held_generation_proposal(id))
    }

    /// `listRecordedFenceItemKeys(key, itemKeys)`: resolves the recorded keys of `itemKeys`.
    #[napi]
    pub fn list_recorded_fence_item_keys<'env>(
        &self,
        env: &'env Env,
        key: Value,
        item_keys: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "listRecordedFenceItemKeys key")?;
            s.list_recorded_fence_item_keys(&key, &item_keys)
        })
    }

    /// `hasBodylessPageVersion(sourceId, slug)`: resolves whether a version has no body.
    #[napi]
    pub fn has_bodyless_page_version<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_bodyless_page_version(&source_id, &slug))
    }

    /// `listFenceVersionBodies(sourceId, slug, before, limit)`: resolves one batch of the
    /// versions that carry a facts fence, newest first.
    #[napi]
    pub fn list_fence_version_bodies<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        before: Option<f64>,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_fence_version_bodies(&source_id, &slug, before, limit)
        })
    }

    /// `readGenerationFenceBlocks(ids)`: resolves `{ id, fence }` per generation.
    #[napi]
    pub fn read_generation_fence_blocks<'env>(
        &self,
        env: &'env Env,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_generation_fence_blocks(&ids))
    }

    /// `listOwnedGenerationItems(ids)`: resolves the items those generations still own.
    #[napi]
    pub fn list_owned_generation_items<'env>(
        &self,
        env: &'env Env,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_owned_generation_items(&ids))
    }

    /// `readLiveGenerationId(key)`: resolves `{ id }` of the live generation, or null.
    #[napi]
    pub fn read_live_generation_id<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: GenerationKey = required(key, "readLiveGenerationId key")?;
            s.read_live_generation_id(&key)
        })
    }

    /// `readGenerationPageRows(query)`: resolves the page rows the query selects, by slug.
    #[napi]
    pub fn read_generation_page_rows<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: GenerationPageRowsQuery = required(query, "readGenerationPageRows query")?;
            s.read_generation_page_rows(&query)
        })
    }

    /// `readAtomOriginInput(sourceId, slug)`: resolves the live page origin's input row, or null.
    #[napi]
    pub fn read_atom_origin_input<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_atom_origin_input(&source_id, &slug))
    }

    /// `listProducerVersionRows(sourceId, slugs, producer)`: resolves the stored versions the
    /// producer wrote of those pages.
    #[napi]
    pub fn list_producer_version_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        producer: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_producer_version_rows(&source_id, &slugs, &producer)
        })
    }

    /// `listAtomWriteReceipts(sourceId, slugs)`: resolves the committed managed atom write
    /// receipts with content of those pages.
    #[napi]
    pub fn list_atom_write_receipts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_atom_write_receipts(&source_id, &slugs))
    }

    /// `listRetiredFenceItems(sourceIds, onlySourceId, onlySlug)`: resolves the retired fence items with a preimage of
    /// the unproven, unheld page fence generations (`gbrain repair lost-fence-rows`).
    #[napi]
    pub fn list_retired_fence_items<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        only_source_id: Option<String>,
        only_slug: Option<String>,
    ) -> napi::Result<Object<'env>> {
        let only = only_source_id.zip(only_slug);
        self.run(env, move |s| s.list_retired_fence_items(&source_ids, only))
    }
}
