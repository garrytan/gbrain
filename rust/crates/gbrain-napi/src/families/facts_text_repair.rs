//! The fact reads and writes of `gbrain repair redacted-facts` and of the `gbrain repair conversation-labels`
//! retirement: one `#[napi] impl Brain` block over `gbrain_store::facts::text_repair`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::text_repair::{
    ExpireWithNote, FactIdsQuery, FactRowQuery, FactTextQuery, FactTextRestoreArgs, PageFactsArgs,
    ProjectedFenceQuery, RedactedFactQuery,
};

#[napi]
impl Brain {
    /// `listRedactedFactCandidates({ sourceIds, ids })`: resolves the active rows whose text holds `[redacted`, by (source, id).
    #[napi]
    pub fn list_redacted_fact_candidates<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RedactedFactQuery = required(query, "listRedactedFactCandidates query")?;
            s.list_redacted_fact_candidates(&a)
        })
    }

    /// `restoreRedactedFactTexts({ sourceId, restores, marker })`: resolves the ids of the rows rewritten, by id.
    #[napi]
    pub fn restore_redacted_fact_texts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactTextRestoreArgs = required(args, "restoreRedactedFactTexts args")?;
            s.restore_redacted_fact_texts(&a)
        })
    }

    /// `listProjectedFenceRows({ sourceId, slug, rowNums, texts })`: resolves the projected row numbers, ascending.
    #[napi]
    pub fn list_projected_fence_rows<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ProjectedFenceQuery = required(query, "listProjectedFenceRows query")?;
            s.list_projected_fence_rows(&a)
        })
    }

    /// `listUnexpiredFactIds({ ids })`: resolves the named facts that are not expired, ascending.
    #[napi]
    pub fn list_unexpired_fact_ids<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactIdsQuery = required(query, "listUnexpiredFactIds query")?;
            s.list_unexpired_fact_ids(&a)
        })
    }

    /// `expireFactWithNote({ sourceId, id, note })`: resolves whether the fact was expired.
    #[napi]
    pub fn expire_fact_with_note<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ExpireWithNote = required(args, "expireFactWithNote args")?;
            s.expire_fact_with_note(&a)
        })
    }

    /// `expirePageFactsBySource({ sourceId, slug, sources })`: resolves how many facts were expired.
    #[napi]
    pub fn expire_page_facts_by_source<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageFactsArgs = required(args, "expirePageFactsBySource args")?;
            s.expire_page_facts_by_source(&a)
        })
    }

    /// `readMaxFactRowNum({ sourceId, slug })`: resolves the page's largest fact row number, or null.
    #[napi]
    pub fn read_max_fact_row_num<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageFactsArgs = required(args, "readMaxFactRowNum args")?;
            s.read_max_fact_row_num(&a)
        })
    }

    /// `hasActiveFactText({ sourceId, slug, fact, visibility })`: resolves whether the page holds that unexpired fact.
    #[napi]
    pub fn has_active_fact_text<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactTextQuery = required(query, "hasActiveFactText query")?;
            s.has_active_fact_text(&a)
        })
    }

    /// `readFactTrustTier(id)`: resolves the stored trust tier of the fact, or null.
    #[napi]
    pub fn read_fact_trust_tier<'env>(
        &self,
        env: &'env Env,
        id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_fact_trust_tier(id))
    }

    /// `listFenceFactRowNums({ sourceId, slug })`: resolves the row numbers of the page's facts, ascending.
    #[napi]
    pub fn list_fence_fact_row_nums<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageFactsArgs = required(args, "listFenceFactRowNums args")?;
            s.list_fence_fact_row_nums(&a)
        })
    }

    /// `readLiveFactRowTier({ sourceId, slug, rowNum, fact })`: resolves `{ id, trust_tier }`, or null.
    #[napi]
    pub fn read_live_fact_row_tier<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactRowQuery = required(query, "readLiveFactRowTier query")?;
            s.read_live_fact_row_tier(&a)
        })
    }
}
