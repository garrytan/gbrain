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
use gbrain_store::error::StoreError;
use gbrain_store::facts::{
    DuplicateQuery, ExpireFactArgs, ExpireFactUntilArgs, FactQuery, FactRestore, FactSourcePrefix,
    FenceTarget, InsertFactArgs, InsertFactsArgs, PageDeleteArgs, SupersessionQuery,
    TrajectoryQuery, UnattributedQuery,
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

    /// `expireFactUntil(id, until)`: resolves true when an unexpired row changed.
    #[napi]
    pub fn expire_fact_until<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExpireFactUntilArgs = required(args, "expireFactUntil args")?;
            s.expire_fact_until(&a)
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

    /// `readFactPreimages(sourceId, ids)`: resolves the before-state of each fact of `ids` in the source,
    /// in id order.
    #[napi]
    pub fn read_fact_preimages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids = whole_ids("readFactPreimages", &ids)?;
            s.read_fact_preimages(&source_id, &ids)
        })
    }

    /// `listFactIdsBySourcePrefix({ sourceId, slug, sourcePrefix })`: resolves the ids of the page's
    /// facts whose `source` starts with the prefix, by id.
    #[napi]
    pub fn list_fact_ids_by_source_prefix<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactSourcePrefix = required(args, "listFactIdsBySourcePrefix args")?;
            s.list_fact_ids_by_source_prefix(&a)
        })
    }

    /// `expireFactRows(sourceId, ids)`: resolves how many live facts of `ids` it ended.
    #[napi]
    pub fn expire_fact_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids = whole_ids("expireFactRows", &ids)?;
            s.expire_fact_rows(&source_id, &ids)
        })
    }

    /// `restoreFactPreimage(sourceId, preimage)`: resolves whether the fact's before-state was put
    /// back.
    #[napi]
    pub fn restore_fact_preimage<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        preimage: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let preimage: FactRestore = required(preimage, "restoreFactPreimage preimage")?;
            s.restore_fact_preimage(&source_id, &preimage)
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

    /// `moveKeptFactRows(sourceId, slug, ids, claimed)`: resolves once the claimed rows moved.
    #[napi]
    pub fn move_kept_fact_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        ids: Vec<f64>,
        claimed: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.move_kept_fact_rows(&source_id, &slug, &ids, &claimed)
        })
    }
}

/// A JS number past 2^31 reaches serde as a float, so each fact id is checked as a whole number here.
fn whole_ids(op: &str, ids: &[f64]) -> Result<Vec<i64>, StoreError> {
    ids.iter()
        .map(|id| {
            if id.fract() == 0.0 && id.abs() <= 9_007_199_254_740_991.0 {
                Ok(*id as i64)
            } else {
                Err(StoreError::invalid(format!(
                    "{op}: fact ids must be whole numbers: {id}"
                )))
            }
        })
        .collect()
}
