//! Group 5 facts members, command, cycle and fence reads: one `#[napi] impl Brain` block over `gbrain_store::facts::cycle`.
//!
//! Each method runs one store call on the pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/facts-cycle.ts) apply the argument defaults and refuse the options the store
//! cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::cycle::{
    BucketQuery, BulkDayQuery, EntityFactsQuery, ExtractionOutcomeQuery, FenceRowOccupantQuery,
    MayMatchQuery, PageCoordinate, PageFileOriginQuery, WorldFactCount,
};

#[napi]
impl Brain {
    /// `listActiveFactsForEntity`: resolves `{ fact, context }` rows.
    #[napi]
    pub fn list_active_facts_for_entity<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: EntityFactsQuery = required(args, "listActiveFactsForEntity args")?;
            s.list_active_facts_for_entity(&a)
        })
    }

    /// `listFreshExtractionOutcomes`: resolves `{ slug, source, source_session }` rows.
    #[napi]
    pub fn list_fresh_extraction_outcomes<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExtractionOutcomeQuery = required(args, "listFreshExtractionOutcomes args")?;
            s.list_fresh_extraction_outcomes(&a)
        })
    }

    /// `listFenceRowGroups`: resolves `{ source_id, source_markdown_slug, row_nums, all_expired }` groups.
    #[napi]
    pub fn list_fence_row_groups<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_fence_row_groups())
    }

    /// `readFactSubject(id)`: resolves `{ source_id, slug }`, or null for no such row.
    #[napi]
    pub fn read_fact_subject<'env>(&self, env: &'env Env, id: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let id: f64 = required(id, "readFactSubject id")?;
            s.read_fact_subject(id)
        })
    }

    /// `factsOrAliasesMayMatch({ sourceId, slugTokens, aliasNorms })`: resolves a boolean.
    #[napi]
    pub fn facts_or_aliases_may_match<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: MayMatchQuery = required(args, "factsOrAliasesMayMatch args")?;
            s.facts_or_aliases_may_match(&a)
        })
    }

    /// `readFactForForget(id)`: resolves forget's target columns, or null for no such row.
    #[napi]
    pub fn read_fact_for_forget<'env>(
        &self,
        env: &'env Env,
        id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let id: f64 = required(id, "readFactForForget id")?;
            s.read_fact_for_forget(id)
        })
    }

    /// `listFactsForPage`: resolves the page coordinate's fence-owned rows.
    #[napi]
    pub fn list_facts_for_page<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageCoordinate = required(args, "listFactsForPage args")?;
            s.list_facts_for_page(&a)
        })
    }

    /// `countLegacyFactsPending(sourceId)`: resolves `{ entity_slug, n }` rows.
    #[napi]
    pub fn count_legacy_facts_pending<'env>(
        &self,
        env: &'env Env,
        source_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let id: String = required(source_id, "countLegacyFactsPending sourceId")?;
            s.count_legacy_facts_pending(&id)
        })
    }

    /// `countUnconsolidatedFactsBySource`: resolves `{ source_id, entity_slug, count }` rows.
    #[napi]
    pub fn count_unconsolidated_facts_by_source<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: BucketQuery = required(args, "countUnconsolidatedFactsBySource args")?;
            s.count_unconsolidated_facts_by_source(&a)
        })
    }

    /// `findBulkFactDays`: resolves the bulk days as the statement returns them.
    #[napi]
    pub fn find_bulk_fact_days<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: BulkDayQuery = required(args, "findBulkFactDays args")?;
            s.find_bulk_fact_days(&a)
        })
    }

    /// `maxFenceRowNum`: resolves the largest `row_num`, 0 for none.
    #[napi]
    pub fn max_fence_row_num<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageCoordinate = required(args, "maxFenceRowNum args")?;
            s.max_fence_row_num(&a)
        })
    }

    /// `readPageFileOrigin({ sourceId, slug, includeDeleted })`: resolves `{ source_path, source_uri }`, or null.
    #[napi]
    pub fn read_page_file_origin<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageFileOriginQuery = required(args, "readPageFileOrigin args")?;
            s.read_page_file_origin(&a)
        })
    }

    /// `readLiveStoredBody({ sourceId, slug })`: resolves `{ compiled_truth, timeline }` of the live page, or null.
    #[napi]
    pub fn read_live_stored_body<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageCoordinate = required(args, "readLiveStoredBody args")?;
            s.read_live_stored_body(&a)
        })
    }

    /// `readFenceRowOccupant({ sourceId, slug, rowNum })`: resolves the occupying row's id, or null.
    #[napi]
    pub fn read_fence_row_occupant<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FenceRowOccupantQuery = required(args, "readFenceRowOccupant args")?;
            s.read_fence_row_occupant(&a)
        })
    }

    /// `listStoredFenceFactRows`: resolves `{ row_num, fact }` rows.
    #[napi]
    pub fn list_stored_fence_fact_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageCoordinate = required(args, "listStoredFenceFactRows args")?;
            s.list_stored_fence_fact_rows(&a)
        })
    }

    /// `countWorldFacts`: resolves the number of rows.
    #[napi]
    pub fn count_world_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: WorldFactCount = required(args, "countWorldFacts args")?;
            s.count_world_facts(&a)
        })
    }
}
