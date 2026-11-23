//! The rechecks and writes of `gbrain repair` applies: one `#[napi] impl Brain` block over
//! `gbrain_store::facts::repair_applies` (src/core/engine-sql/repair-applies.ts).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and resolves plain JSON
//! (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::repair_applies::{
    AccessKeyArgs, ClaimDateArgs, CommittedRestoreArgs, DuplicateArgs, ExtractorRestoreArgs,
    FenceRowArgs, TieArgs,
};

#[napi]
impl Brain {
    /// `restoreConsolidationTie(tie)`: resolves whether it reopened the fact.
    #[napi]
    pub fn restore_consolidation_tie<'env>(
        &self,
        env: &'env Env,
        tie: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TieArgs = required(tie, "restoreConsolidationTie tie")?;
            s.restore_consolidation_tie(&a)
        })
    }

    /// `listLiveDuplicateRows({ sourceId, ids, visibility, fingerprint })`: resolves `[{ id, entity_slug, row_num,
    /// source_markdown_slug }]`.
    #[napi]
    pub fn list_live_duplicate_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DuplicateArgs = required(args, "listLiveDuplicateRows args")?;
            s.list_live_duplicate_rows(&a)
        })
    }

    /// `supersedeDuplicateFacts({ sourceId, ids, keptId, visibility, fingerprint })`: resolves the changed ids.
    #[napi]
    pub fn supersede_duplicate_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DuplicateArgs = required(args, "supersedeDuplicateFacts args")?;
            s.supersede_duplicate_facts(&a)
        })
    }

    /// `linkStruckDuplicateFacts({ sourceId, ids, keptId })`: resolves the changed ids.
    #[napi]
    pub fn link_struck_duplicate_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DuplicateArgs = required(args, "linkStruckDuplicateFacts args")?;
            s.link_struck_duplicate_facts(&a)
        })
    }

    /// `listCommittedRestorePages({ sourceIds, slugs, hash, requestIds })`: resolves `[{ source_id, slug }]`.
    #[napi]
    pub fn list_committed_restore_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: CommittedRestoreArgs = required(args, "listCommittedRestorePages args")?;
            s.list_committed_restore_pages(&a)
        })
    }

    /// `listActivePositionedFactIds(ids)`: resolves the ids.
    #[napi]
    pub fn list_active_positioned_fact_ids<'env>(
        &self,
        env: &'env Env,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_active_positioned_fact_ids(&ids))
    }

    /// `readFactRestorePage(sourceId, slug)`: resolves `{ id, compiled_truth, max_row }` or null.
    #[napi]
    pub fn read_fact_restore_page<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_fact_restore_page(&source_id, &slug))
    }

    /// `restoreExtractorFact({ sourceId, id, rowNum, expiredAt })`: resolves whether it restored the fact.
    #[napi]
    pub fn restore_extractor_fact<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExtractorRestoreArgs = required(args, "restoreExtractorFact args")?;
            s.restore_extractor_fact(&a)
        })
    }

    /// `moveFactClaimDates({ sourceId, rows })`: resolves the moved ids.
    #[napi]
    pub fn move_fact_claim_dates<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClaimDateArgs = required(args, "moveFactClaimDates args")?;
            s.move_fact_claim_dates(&a)
        })
    }

    /// `expireApprovedFacts({ sourceId, ids })`: resolves the expired ids.
    #[napi]
    pub fn expire_approved_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DuplicateArgs = required(args, "expireApprovedFacts args")?;
            s.expire_approved_facts(&a)
        })
    }

    /// `tightenDatabaseFactVisibility({ sourceId, ids })`: resolves the changed ids.
    #[napi]
    pub fn tighten_database_fact_visibility<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DuplicateArgs = required(args, "tightenDatabaseFactVisibility args")?;
            s.tighten_database_fact_visibility(&a)
        })
    }

    /// `detachFenceRowFacts({ sourceId, slug, rowNum })`: resolves the changed ids.
    #[napi]
    pub fn detach_fence_row_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FenceRowArgs = required(args, "detachFenceRowFacts args")?;
            s.detach_fence_row_facts(&a)
        })
    }

    /// `hasDatabaseOnlyClaim({ sourceId, entitySlug, fact })`: resolves whether such a fact exists.
    #[napi]
    pub fn has_database_only_claim<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FenceRowArgs = required(args, "hasDatabaseOnlyClaim args")?;
            s.has_database_only_claim(&a)
        })
    }

    /// `listPageAccessKeys({ ids, honorAliases })`: resolves `[{ id, readers, folder, readable_by, world }]`.
    #[napi]
    pub fn list_page_access_keys<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: AccessKeyArgs = required(args, "listPageAccessKeys args")?;
            s.list_page_access_keys(&a)
        })
    }

    /// `readSourceCloneRow(sourceId)`: resolves `{ local_path, config }` or null.
    #[napi]
    pub fn read_source_clone_row<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_clone_row(&source_id))
    }
}
