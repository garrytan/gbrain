//! The doctor brain reads served from the store (`gbrain-store` `cli_reads::doctor_brain`). The TypeScript
//! members (`src/core/rust-engine/store-members/doctor-brain.ts`) answer the checkpoint relations the store keeps no
//! writer for (rust/docs/store/cli-reads-doctor-brain.md) without a call.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listInterimStoredObjectCounts({ type, shelfSourceId, prefix, adoptedTag })`: resolves `[{ source_id, n }]`.
    #[napi]
    pub fn list_interim_stored_object_counts<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_interim_stored_object_counts(&required(
                input,
                "listInterimStoredObjectCounts input",
            )?)
        })
    }

    /// `readOldestSourceCreatedAt()`: resolves the earliest source `created_at` as ISO text, or null.
    #[napi]
    pub fn read_oldest_source_created_at<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_oldest_source_created_at())
    }

    /// `listVisibilityCandidatePages(sourceIds | null)`: resolves `[{ source_id, slug, frontmatter }]`.
    #[napi]
    pub fn list_visibility_candidate_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_visibility_candidate_pages(source_ids.as_deref())
        })
    }

    /// `listContentBlockedReceipts()`: the failed request each unfinished managed-sync cursor waits on.
    #[napi]
    pub fn list_content_blocked_receipts<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_content_blocked_receipts())
    }

    /// `countVisibilityNoncanonicalHolds` / `countReadersNoncanonicalHolds`: the holds of `holdOp`
    /// recording `code` for an unarchived source at its incarnation.
    #[napi]
    pub fn count_noncanonical_holds<'env>(
        &self,
        env: &'env Env,
        hold_op: String,
        code: String,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_noncanonical_holds(&hold_op, &code, source_ids.as_deref())
        })
    }

    /// `listReaderCandidatePages(sourceIds)`: live pages with a misspelled `readable_by` key.
    #[napi]
    pub fn list_reader_candidate_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_reader_candidate_pages(source_ids.as_deref())
        })
    }
}
