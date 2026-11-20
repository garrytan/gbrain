//! The page-set reads of the core commands (`src/core/engine-sql/collate-page-reads.ts`): one `#[napi] impl Brain`
//! block over `gbrain_store::collate_sets` (rust/docs/store/collate_sets.md).
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};
use gbrain_store::facts::PrivacyPolicy;

#[napi]
impl Brain {
    /// `readPageSizeRows(sourceId, maxBytes, slugs)`: the size-state rows of one source.
    #[napi]
    pub fn read_page_size_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        max_bytes: i64,
        slugs: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_size_rows(&source_id, max_bytes, slugs.as_deref())
        })
    }

    /// `listChatChannelCensus(sourceIds, chatTypes, dmTypes, policy?, fast)`: one row per source.
    #[napi]
    pub fn list_chat_channel_census<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        chat_types: Vec<String>,
        dm_types: Vec<String>,
        policy: Option<Value>,
        fast: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy: Option<PrivacyPolicy> = arg(policy, "listChatChannelCensus policy")?;
            s.list_chat_channel_census(&source_ids, &chat_types, &dm_types, policy.as_ref(), fast)
        })
    }

    /// `listLinkPageMetadataForSlugs(sourceId, slugs)`: the link resolver's page rows.
    #[napi]
    pub fn list_link_page_metadata_for_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_link_page_metadata_for_slugs(&source_id, &slugs)
        })
    }

    /// `listAttendedOriginSlugs(sourceId, slugs)`: `{ slug }` rows.
    #[napi]
    pub fn list_attended_origin_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_attended_origin_slugs(&source_id, slugs.as_deref())
        })
    }

    /// `readCompanyBrainEvidenceRows(sourceId)`: `{ owner, decision, page }`.
    #[napi]
    pub fn read_company_brain_evidence_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_company_brain_evidence_rows(&source_id))
    }

    /// `listShelfPageRows(sourceId)`: the shelf's page rows.
    #[napi]
    pub fn list_shelf_page_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_shelf_page_rows(&source_id))
    }

    /// `listCardRows(sourceId, cardType, status, store, onSourceMachine, limit, offset)`: `{ cards, total }`.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn list_card_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        card_type: String,
        status: Option<String>,
        store: Option<String>,
        on_source_machine: Option<bool>,
        limit: i64,
        offset: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_card_rows(
                &source_id,
                &card_type,
                status.as_deref(),
                store.as_deref(),
                on_source_machine,
                limit,
                offset,
            )
        })
    }

    /// `findCardRows(sourceId, cardType, query, aliasNorm, terms, status, store, onSourceMachine)`: the ranked card rows.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn find_card_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        card_type: String,
        query: String,
        alias_norm: String,
        terms: Vec<String>,
        status: Option<String>,
        store: Option<String>,
        on_source_machine: Option<bool>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_card_rows(
                &source_id,
                &card_type,
                &query,
                &alias_norm,
                &terms,
                status.as_deref(),
                store.as_deref(),
                on_source_machine,
            )
        })
    }

    /// `listLiveSourceIncarnations(sourceIds)`: `{ id, incarnation }` rows.
    #[napi]
    pub fn list_live_source_incarnations<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_live_source_incarnations(&source_ids))
    }

    /// `listAttendanceScanWindow(sourceId, afterSlug, limit)`: the scan window's page pins.
    #[napi]
    pub fn list_attendance_scan_window<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        after_slug: String,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_attendance_scan_window(&source_id, &after_slug, limit)
        })
    }
}
