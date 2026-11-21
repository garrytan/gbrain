//! The fact purge's transaction statements that read and delete facts, takes and pages by id: one `#[napi] impl Brain`
//! block over `gbrain_store::facts::purge_tx` (src/core/engine-sql/facts-purge.ts). Each method decodes its arguments,
//! runs one `Store` call on the pool through `Brain::run`, and resolves plain JSON. The TypeScript members are in
//! src/core/rust-engine/store-members/facts-purge-tx.ts.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::purge_journal::BlockedPublicationQuery;
use gbrain_store::facts::purge_tx::{
    PurgeHoldsArgs, PurgeIdsArgs, PurgePageBodyArgs, PurgeProposalsArgs, PurgeReceiptsArgs,
    PurgeSourceIdsArgs, PurgeVersionBodyArgs, RedactReasonsArgs,
};
use gbrain_store::generations::needs_rederive::MarkRederiveArgs;
use gbrain_store::page_body::{SegmentedVersionsQuery, UnreferencedTextsArgs};

#[napi]
impl Brain {
    /// `listPurgeStreamSlugs({ ids })`: resolves the distinct stream slugs, in byte order.
    #[napi]
    pub fn list_purge_stream_slugs<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeIdsArgs = required(args, "listPurgeStreamSlugs args")?;
            s.list_purge_stream_slugs(&a)
        })
    }

    /// `deletePurgedFacts({ sourceId, ids })`: resolves how many facts it deleted.
    #[napi]
    pub fn delete_purged_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeSourceIdsArgs = required(args, "deletePurgedFacts args")?;
            s.delete_purged_facts(&a)
        })
    }

    /// `listPurgedPageRevisions({ sourceId, ids })`: resolves `[{ id, slug, knowledge_revision }]` by slug.
    #[napi]
    pub fn list_purged_page_revisions<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeSourceIdsArgs = required(args, "listPurgedPageRevisions args")?;
            s.list_purged_page_revisions(&a)
        })
    }

    /// `listPagesForPurgeRewrite({ sourceId, ids })`: resolves whole page rows with `purge_tags`, by slug.
    #[napi]
    pub fn list_pages_for_purge_rewrite<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeSourceIdsArgs = required(args, "listPagesForPurgeRewrite args")?;
            s.list_pages_for_purge_rewrite(&a)
        })
    }

    /// `deletePurgedTakes({ ids })`: resolves how many takes it deleted.
    #[napi]
    pub fn delete_purged_takes<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeIdsArgs = required(args, "deletePurgedTakes args")?;
            s.delete_purged_takes(&a)
        })
    }

    /// `deletePurgeTrustProposals({ sourceId, factIds, takeIds })`: resolves how many proposals it deleted.
    #[napi]
    pub fn delete_purge_trust_proposals<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeProposalsArgs = required(args, "deletePurgeTrustProposals args")?;
            s.delete_purge_trust_proposals(&a)
        })
    }

    /// `deletePurgeOpenLoops({ sourceId, ids })`: resolves how many loops it deleted.
    #[napi]
    pub fn delete_purge_open_loops<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeSourceIdsArgs = required(args, "deletePurgeOpenLoops args")?;
            s.delete_purge_open_loops(&a)
        })
    }

    /// `deletePurgeWriteGateHolds({ sourceId, factHash })`: resolves the deleted hold ids as text.
    #[napi]
    pub fn delete_purge_write_gate_holds<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeHoldsArgs = required(args, "deletePurgeWriteGateHolds args")?;
            s.delete_purge_write_gate_holds(&a)
        })
    }

    /// `deletePurgeWriteGateReceipts({ factIds, takeIds, holdIds })`: resolves how many receipts it deleted.
    #[napi]
    pub fn delete_purge_write_gate_receipts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeReceiptsArgs = required(args, "deletePurgeWriteGateReceipts args")?;
            s.delete_purge_write_gate_receipts(&a)
        })
    }

    /// `updatePageBodyForPurge`: resolves null.
    #[napi]
    pub fn update_page_body_for_purge<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgePageBodyArgs = required(args, "updatePageBodyForPurge args")?;
            s.update_page_body_for_purge(&a)
        })
    }

    /// `setPurgeVersionBody`: resolves null.
    #[napi]
    pub fn set_purge_version_body<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeVersionBodyArgs = required(args, "setPurgeVersionBody args")?;
            s.set_purge_version_body(&a)
        })
    }

    /// `redactVersionChangeReasons`: resolves the redacted version ids, in id order.
    #[napi]
    pub fn redact_version_change_reasons<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RedactReasonsArgs = required(args, "redactVersionChangeReasons args")?;
            s.redact_version_change_reasons(&a)
        })
    }

    /// `deletePurgedChunks`: resolves how many chunks it deleted.
    #[napi]
    pub fn delete_purged_chunks<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeIdsArgs = required(args, "deletePurgedChunks args")?;
            s.delete_purged_chunks(&a)
        })
    }

    /// `expireDerivedFacts`: resolves how many facts it touched.
    #[napi]
    pub fn expire_derived_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeSourceIdsArgs = required(args, "expireDerivedFacts args")?;
            s.expire_derived_facts(&a)
        })
    }

    /// `deactivateDerivedTakes`: resolves how many takes it touched.
    #[napi]
    pub fn deactivate_derived_takes<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeSourceIdsArgs = required(args, "deactivateDerivedTakes args")?;
            s.deactivate_derived_takes(&a)
        })
    }

    /// `softDeleteDerivedPages`: resolves `[{ id, now }]`, the pages this call hid first.
    #[napi]
    pub fn soft_delete_derived_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeSourceIdsArgs = required(args, "softDeleteDerivedPages args")?;
            s.soft_delete_derived_pages(&a)
        })
    }

    /// `findPurgeBlockedPublication({ sourceId, slugs, ownRequest })`: resolves `{ request_id, slug, state }` or null.
    #[napi]
    pub fn find_purge_blocked_publication<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: BlockedPublicationQuery = required(args, "findPurgeBlockedPublication args")?;
            s.find_purge_blocked_publication(&a)
        })
    }

    /// `markNeedsRederive({ table, ids, sourceId, requestId, reason, hiddenNow })`: resolves null.
    #[napi]
    pub fn mark_needs_rederive<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: MarkRederiveArgs = required(args, "markNeedsRederive args")?;
            s.mark_needs_rederive(&a)
        })
    }

    /// `pageAwaitsRederive(pageId)`: resolves whether a purge marked the page in `needs_rederive`.
    #[napi]
    pub fn page_awaits_rederive<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.page_awaits_rederive(page_id))
    }

    /// `listSegmentedVersionsForPurge({ sourceId, needle, pageIds, after })`: resolves the version rows, in id order.
    #[napi]
    pub fn list_segmented_versions_for_purge<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SegmentedVersionsQuery = required(args, "listSegmentedVersionsForPurge args")?;
            s.list_segmented_versions_for_purge(&a)
        })
    }

    /// `abortPurgedStagings(stagingIds)`: resolves the page ids of the stagings it aborted.
    #[napi]
    pub fn abort_purged_stagings<'env>(
        &self,
        env: &'env Env,
        staging_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.abort_purged_stagings(&staging_ids))
    }

    /// `deleteUnreferencedPurgedTexts({ sourceId, replaced, claim, fenced })`: resolves how many texts it deleted.
    #[napi]
    pub fn delete_unreferenced_purged_texts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UnreferencedTextsArgs = required(args, "deleteUnreferencedPurgedTexts args")?;
            s.delete_unreferenced_purged_texts(&a)
        })
    }
}
