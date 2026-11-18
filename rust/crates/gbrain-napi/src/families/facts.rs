//! Facts and their supersession chains.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::facts` call on the pool
//! through `Brain::run` and resolves plain JSON (rust/README.md, "The brain store"). The
//! TypeScript members (src/core/rust-engine/store-members/facts.ts) apply the defaults and
//! clamps and refuse the options the store cannot answer.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::{
    DuplicateQuery, ExpireFactArgs, FactQuery, FenceTarget, InsertFactArgs, InsertFactsArgs,
    PageDeleteArgs, SupersessionQuery, TrajectoryQuery, UnattributedQuery,
};

#[napi]
impl Brain {
    /// `insertFact(input, ctx)`: resolves `{ id, status }`.
    #[napi]
    pub fn insert_fact<'env>(&self, env: &'env Env, args: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: InsertFactArgs = required(args, "insertFact args")?;
            s.insert_fact(&a)
        })
    }

    /// `insertFacts(rows, ctx, opts)`: resolves `{ inserted, ids, warnings, deleted }`.
    #[napi]
    pub fn insert_facts<'env>(&self, env: &'env Env, args: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: InsertFactsArgs = required(args, "insertFacts args")?;
            s.insert_facts(&a)
        })
    }

    /// `deleteFactsForPage(slug, source_id, opts)`: resolves the number of rows deleted.
    #[napi]
    pub fn delete_facts_for_page<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageDeleteArgs = required(args, "deleteFactsForPage args")?;
            s.delete_facts_for_page(&a)
        })
    }

    /// `expireFact(id, opts)`: resolves true when an unexpired row changed.
    #[napi]
    pub fn expire_fact<'env>(&self, env: &'env Env, args: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExpireFactArgs = required(args, "expireFact args")?;
            s.expire_fact(&a)
        })
    }

    /// `listFactsByEntity`: resolves fact rows (times are microsecond ISO text).
    #[napi]
    pub fn list_facts_by_entity<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactQuery = required(query, "listFactsByEntity query")?;
            s.list_facts_by_entity(&a)
        })
    }

    /// `listFactsSince`: resolves fact rows, newest first.
    #[napi]
    pub fn list_facts_since<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactQuery = required(query, "listFactsSince query")?;
            s.list_facts_since(&a)
        })
    }

    /// `listFactsKeyset`: resolves fact rows after the keyset, oldest first.
    #[napi]
    pub fn list_facts_keyset<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactQuery = required(query, "listFactsKeyset query")?;
            s.list_facts_keyset(&a)
        })
    }

    /// `listFactsBySession`: resolves fact rows, newest first.
    #[napi]
    pub fn list_facts_by_session<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactQuery = required(query, "listFactsBySession query")?;
            s.list_facts_by_session(&a)
        })
    }

    /// `listSupersessions`: resolves the rows that have a successor.
    #[napi]
    pub fn list_supersessions<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SupersessionQuery = required(query, "listSupersessions query")?;
            s.list_supersessions(&a)
        })
    }

    /// `findCandidateDuplicates` (the recency, cosine and keyword arms): resolves the entity's
    /// candidate rows.
    #[napi]
    pub fn find_candidate_duplicates<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DuplicateQuery = required(query, "findCandidateDuplicates query")?;
            s.find_candidate_duplicates(&a)
        })
    }

    /// `findTrajectory`: resolves trajectory points, oldest first.
    #[napi]
    pub fn find_trajectory<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TrajectoryQuery = required(query, "findTrajectory query")?;
            s.find_trajectory(&a)
        })
    }

    /// `countUnconsolidatedFacts(source_id)`: resolves the count.
    #[napi]
    pub fn count_unconsolidated_facts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_unconsolidated_facts(&source_id))
    }

    /// `listFenceRetireCandidates({ sourceId, slug, incoming })`: the before-state of each fence row the
    /// incoming fence does not hold. The opened ids come from the store's write trust context
    /// (`applyWriteTrust`): an opened row moves in place and is no candidate.
    #[napi]
    pub fn list_fence_retire_candidates<'env>(
        &self,
        env: &'env Env,
        target: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let t: FenceTarget = required(target, "listFenceRetireCandidates target")?;
            s.list_fence_retire_candidates(&t, &s.fence_context())
        })
    }

    /// `consolidateFact(id, takeId)`: resolves null.
    #[napi]
    pub fn consolidate_fact<'env>(
        &self,
        env: &'env Env,
        id: f64,
        take_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.consolidate_fact(id, take_id))
    }

    /// `listUnattributedFacts` (src/core/review-lists.ts): resolves the unattributed rows, newest
    /// first.
    #[napi]
    pub fn list_unattributed_facts<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UnattributedQuery = required(query, "listUnattributedFacts query")?;
            s.list_unattributed_facts(&a)
        })
    }

    /// `pageCollapseFacts(ids, bodyIds)`: resolves one `{ id, target, body_chars, body, lead }` row
    /// per page found, by id.
    #[napi]
    pub fn page_collapse_facts<'env>(
        &self,
        env: &'env Env,
        ids: Value,
        body_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = required(ids, "pageCollapseFacts ids")?;
            let body_ids: Vec<i64> = required(body_ids, "pageCollapseFacts bodyIds")?;
            s.page_collapse_facts(&ids, &body_ids)
        })
    }

    /// `getFactsHealth(source_id)`: resolves the counts and the top entities.
    #[napi]
    pub fn get_facts_health<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_facts_health(&source_id))
    }

    /// `migrateFactsToCanonical(phantomSlug, canonicalSlug, sourceId)`: resolves the rows moved.
    #[napi]
    pub fn migrate_facts_to_canonical<'env>(
        &self,
        env: &'env Env,
        phantom_slug: String,
        canonical_slug: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.migrate_facts_to_canonical(&phantom_slug, &canonical_slug, &source_id)
        })
    }
}
