//! The six candidate-pool reads of a fact recall: `readFactsEmbeddingColumn`, `listNearestFacts`, `listSlotRows`,
//! `listPoolUnbackedKeys`, `listCallOffCueFacts` and `listPoolEntityPairs`, and `readFactWrittenDates` (memory_recall's dates).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts::recall` call on the pool through
//! `Brain::run` and resolves plain JSON. The TypeScript members (src/core/rust-engine/store-members/facts-recall.ts)
//! resolve the caller's read policy and refuse what the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::recall::{CueArgs, NearestArgs, PairsArgs, SlotArgs, UnbackedArgs};

#[napi]
impl Brain {
    /// `readFactsEmbeddingColumn()`: resolves `{ type, dims }`.
    #[napi]
    pub fn read_facts_embedding_column<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_facts_embedding_column())
    }

    /// `listFactSourcePages(ids)`: resolves `[{ id, page_id, slug, title, type }]`, the holding page of each fact.
    #[napi]
    pub fn list_fact_source_pages<'env>(
        &self,
        env: &'env Env,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_fact_source_pages(&ids))
    }

    /// `readFactWrittenDates(ids)`: resolves `[{ id, d }]`, the UTC day (`YYYY-MM-DD`) each named fact is valid from.
    #[napi]
    pub fn read_fact_written_dates<'env>(
        &self,
        env: &'env Env,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_fact_written_dates(&ids))
    }

    /// `listTypedClaimFactsAtPages(pageSlugs, entitySlugs)`: resolves the typed-claim facts held on those pages about
    /// those entities, `valid_from` as ISO text.
    #[napi]
    pub fn list_typed_claim_facts_at_pages<'env>(
        &self,
        env: &'env Env,
        page_slugs: Vec<String>,
        entity_slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_typed_claim_facts_at_pages(&page_slugs, &entity_slugs)
        })
    }

    /// `listNearestFacts(args)`: resolves the pool rows nearest the vector, each with its `similarity`.
    #[napi]
    pub fn list_nearest_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: NearestArgs = required(args, "listNearestFacts args")?;
            s.list_nearest_facts(&a)
        })
    }

    /// `listSlotRows(args)`: resolves the active slot rows of the slots.
    #[napi]
    pub fn list_slot_rows<'env>(&self, env: &'env Env, args: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SlotArgs = required(args, "listSlotRows args")?;
            s.list_slot_rows(&a)
        })
    }

    /// `listPoolUnbackedKeys(args)`: resolves the `{ source_id, entity_slug }` pairs with no live page.
    #[napi]
    pub fn list_pool_unbacked_keys<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UnbackedArgs = required(args, "listPoolUnbackedKeys args")?;
            s.list_pool_unbacked_keys(&a)
        })
    }

    /// `listCallOffCueFacts(args)`: resolves the newest call-off cue rows per pair.
    #[napi]
    pub fn list_call_off_cue_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: CueArgs = required(args, "listCallOffCueFacts args")?;
            s.list_call_off_cue_facts(&a)
        })
    }

    /// `listPoolEntityPairs(args)`: resolves the distinct `{ source_id, entity_slug }` pairs of the pool.
    #[napi]
    pub fn list_pool_entity_pairs<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PairsArgs = required(args, "listPoolEntityPairs args")?;
            s.list_pool_entity_pairs(&a)
        })
    }
}
