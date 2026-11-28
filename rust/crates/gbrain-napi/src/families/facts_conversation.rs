//! Group 5 facts members, conversation fact publication and relink: one `#[napi] impl Brain`
//! block over `gbrain_store::facts::conversation` and `gbrain_store::facts::conversation_reads`
//! (src/core/engine-sql/facts-conversation.ts).
//!
//! Each method runs one store call on the pool through `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::conversation::{
    ClearPageArgs, ConversationPageArgs, WindowKeyArgs, WindowKeysArgs, WindowMoveArgs,
    WindowStampArgs,
};
use gbrain_store::facts::conversation_reads::{
    BatchRequestArgs, CounterArgs, EmbeddedAmongArgs, OntologyTwinArgs, PagesToExtractArgs,
    SameClaimArgs, SlotValueArgs, SourceArgs, SourceSlugsArgs, SpentRequestArgs, StoredEntryArgs,
    TombstoneMatchArgs,
};

#[napi]
impl Brain {
    /// `readNewestConversationFactId`: resolves the newest conversation fact id, or null.
    #[napi]
    pub fn read_newest_conversation_fact_id<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ConversationPageArgs = required(args, "readNewestConversationFactId args")?;
            s.read_newest_conversation_fact_id(&a)
        })
    }

    /// `maxConversationRowNum`: resolves the largest row number, or null.
    #[napi]
    pub fn max_conversation_row_num<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ConversationPageArgs = required(args, "maxConversationRowNum args")?;
            s.max_conversation_row_num(&a)
        })
    }

    /// `listHeldFactSlots`: resolves `{ entity_slug, dimension, value_hash, valid_from }` rows.
    #[napi]
    pub fn list_held_fact_slots<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ConversationPageArgs = required(args, "listHeldFactSlots args")?;
            s.list_held_fact_slots(&a)
        })
    }

    /// `countActiveConversationFacts`: resolves a count.
    #[napi]
    pub fn count_active_conversation_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ConversationPageArgs = required(args, "countActiveConversationFacts args")?;
            s.count_active_conversation_facts(&a)
        })
    }

    /// `countPageConversationFacts`: resolves a count.
    #[napi]
    pub fn count_page_conversation_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ConversationPageArgs = required(args, "countPageConversationFacts args")?;
            s.count_page_conversation_facts(&a)
        })
    }

    /// `countConversationWindowFacts`: resolves a count.
    #[napi]
    pub fn count_conversation_window_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: WindowKeyArgs = required(args, "countConversationWindowFacts args")?;
            s.count_conversation_window_facts(&a)
        })
    }

    /// `countConversationFactsOutsideWindows`: resolves a count.
    #[napi]
    pub fn count_conversation_facts_outside_windows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: WindowKeysArgs = required(args, "countConversationFactsOutsideWindows args")?;
            s.count_conversation_facts_outside_windows(&a)
        })
    }

    /// `stampConversationSourceWindows`: resolves null.
    #[napi]
    pub fn stamp_conversation_source_windows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: WindowStampArgs = required(args, "stampConversationSourceWindows args")?;
            s.stamp_conversation_source_windows(&a)
        })
    }

    /// `moveConversationSourceWindows`: resolves null.
    #[napi]
    pub fn move_conversation_source_windows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: WindowMoveArgs = required(args, "moveConversationSourceWindows args")?;
            s.move_conversation_source_windows(&a)
        })
    }

    /// `deleteConversationOutcomeRows`: resolves the `{ id }` rows deleted.
    #[napi]
    pub fn delete_conversation_outcome_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ConversationPageArgs = required(args, "deleteConversationOutcomeRows args")?;
            s.delete_conversation_outcome_rows(&a)
        })
    }

    /// `clearConversationPageFacts`: resolves the rows removed from the active batch.
    #[napi]
    pub fn clear_conversation_page_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClearPageArgs = required(args, "clearConversationPageFacts args")?;
            s.clear_conversation_page_facts(&a)
        })
    }

    /// `findSpentConversationRequest`: resolves `{ request_id }` or null.
    #[napi]
    pub fn find_spent_conversation_request<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SpentRequestArgs = required(args, "findSpentConversationRequest args")?;
            s.find_spent_conversation_request(&a)
        })
    }

    /// `listConversationBatchRequests`: resolves `{ id, request_id, state, error_code, members }` rows.
    #[napi]
    pub fn list_conversation_batch_requests<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: BatchRequestArgs = required(args, "listConversationBatchRequests args")?;
            s.list_conversation_batch_requests(&a)
        })
    }

    /// `readStoredConversationEntry`: resolves the stored entry or null.
    #[napi]
    pub fn read_stored_conversation_entry<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: StoredEntryArgs = required(args, "readStoredConversationEntry args")?;
            s.read_stored_conversation_entry(&a)
        })
    }

    /// `readPrincipalCounters`: resolves `{ outstanding_count, terminal_bytes, lifetime_ids }` or null.
    #[napi]
    pub fn read_principal_counters<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: CounterArgs = required(args, "readPrincipalCounters args")?;
            s.read_principal_counters(&a)
        })
    }

    /// `countConversationPagesToExtract`: resolves a count.
    #[napi]
    pub fn count_conversation_pages_to_extract<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PagesToExtractArgs = required(args, "countConversationPagesToExtract args")?;
            s.count_conversation_pages_to_extract(&a)
        })
    }

    /// `listMergedEntityAliases`: resolves `{ alias_slug, canonical_slug }` rows.
    #[napi]
    pub fn list_merged_entity_aliases<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceSlugsArgs = required(args, "listMergedEntityAliases args")?;
            s.list_merged_entity_aliases(&a)
        })
    }

    /// `listEntityHintPages`: resolves `{ slug, type, frontmatter, retired, folder_restricted }` rows.
    #[napi]
    pub fn list_entity_hint_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceSlugsArgs = required(args, "listEntityHintPages args")?;
            s.list_entity_hint_pages(&a)
        })
    }

    /// `readRelinkSource`: resolves `{ incarnation, archived, local_path, kind }` or null.
    #[napi]
    pub fn read_relink_source<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceArgs = required(args, "readRelinkSource args")?;
            s.read_relink_source(&a)
        })
    }

    /// `readReextractOutcomeRow`: resolves `{ id, hash }` or null.
    #[napi]
    pub fn read_reextract_outcome_row<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ConversationPageArgs = required(args, "readReextractOutcomeRow args")?;
            s.read_reextract_outcome_row(&a)
        })
    }

    /// `readConversationSlotValueHash`: resolves `{ value_hash }` or null.
    #[napi]
    pub fn read_conversation_slot_value_hash<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SlotValueArgs = required(args, "readConversationSlotValueHash args")?;
            s.read_conversation_slot_value_hash(&a)
        })
    }

    /// `listPurgeTombstoneMatches`: resolves `{ ord }` rows.
    #[napi]
    pub fn list_purge_tombstone_matches<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TombstoneMatchArgs = required(args, "listPurgeTombstoneMatches args")?;
            s.list_purge_tombstone_matches(&a)
        })
    }

    /// `findSameClaimFenceRow`: resolves `{ id, visibility }` or null.
    #[napi]
    pub fn find_same_claim_fence_row<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SameClaimArgs = required(args, "findSameClaimFenceRow args")?;
            s.find_same_claim_fence_row(&a)
        })
    }

    /// `findOntologyTwin`: resolves `{ id }` or null.
    #[napi]
    pub fn find_ontology_twin<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: OntologyTwinArgs = required(args, "findOntologyTwin args")?;
            s.find_ontology_twin(&a)
        })
    }

    /// `listUnbackedConversationRows`: resolves relink rows with their entity.
    #[napi]
    pub fn list_unbacked_conversation_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceSlugsArgs = required(args, "listUnbackedConversationRows args")?;
            s.list_unbacked_conversation_rows(&a)
        })
    }

    /// `listUnlinkedConversationRows`: resolves relink rows.
    #[napi]
    pub fn list_unlinked_conversation_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceSlugsArgs = required(args, "listUnlinkedConversationRows args")?;
            s.list_unlinked_conversation_rows(&a)
        })
    }

    /// `listClearedRelinkedFacts`: resolves `{ fact, entity_slug, context, carried }` rows.
    #[napi]
    pub fn list_cleared_relinked_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ConversationPageArgs = required(args, "listClearedRelinkedFacts args")?;
            s.list_cleared_relinked_facts(&a)
        })
    }

    /// `countEmbeddedFactsAmong`: resolves a count.
    #[napi]
    pub fn count_embedded_facts_among<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: EmbeddedAmongArgs = required(args, "countEmbeddedFactsAmong args")?;
            s.count_embedded_facts_among(&a)
        })
    }
}
