//! The CLI import reads (gbrain-store `cli_reads::import`): source records, guest-source checks,
//! page and row trust, the database clock, link metadata, stored timeline rows, revision checks.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `listSourceRecords()`: every source, `default` first, then by id.
    #[napi]
    pub fn list_source_records<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_source_records())
    }

    /// `readSourceIncarnation(sourceId)`: `{ config, incarnation }` or `null`.
    #[napi]
    pub fn read_source_incarnation<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_incarnation(&source_id))
    }

    /// `hasCompanyBrainReceipt(sourceId)`: always false (the store keeps no ingestion receipts).
    #[napi]
    pub fn has_company_brain_receipt<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_company_brain_receipt(&source_id))
    }

    /// `readGuestSourceRow(sourceId)`: never hidden, never a row (the store has no guest_sources).
    #[napi]
    pub fn read_guest_source_row<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_guest_source_row(&source_id))
    }

    /// `listGuestSourceIds(sourceIds)`: the ids whose source config says guest.
    #[napi]
    pub fn list_guest_source_ids<'env>(
        &self,
        env: &'env Env,
        source_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_guest_source_ids(&required::<Vec<String>>(
                source_ids,
                "listGuestSourceIds sourceIds",
            )?)
        })
    }

    /// `hasGuestSource()`: whether any source config says guest.
    #[napi]
    pub fn has_guest_source<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_guest_source())
    }

    /// `readPageTrustRows({ ids?, keys?, includeDeleted? })`: one trust row per page found.
    #[napi]
    pub fn read_page_trust_rows<'env>(
        &self,
        env: &'env Env,
        lookup: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_trust_rows(&arg(lookup, "readPageTrustRows lookup")?)
        })
    }

    /// `readRowTrustRows({ table, ids })`: one trust row per timeline entry found.
    #[napi]
    pub fn read_row_trust_rows<'env>(
        &self,
        env: &'env Env,
        lookup: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_row_trust_rows(&arg(lookup, "readRowTrustRows lookup")?)
        })
    }

    /// `readDatabaseClock()`: the store clock as `YYYY-MM-DDTHH:MM:SS.ffffffZ`.
    #[napi]
    pub fn read_database_clock<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_database_clock())
    }

    /// `listLinkPageMetadataForSlugs(sourceId, slugs)`: the live pages named, by slug.
    #[napi]
    pub fn read_link_page_metadata_for_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_link_page_metadata_for_slugs(&source_id, &slugs)
        })
    }

    /// `listAttendedOriginSlugs(sourceId, slugs?)`: the self-attended origin slugs, by slug.
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

    /// `listLinkPageMetadata(sourceId?)`: live pages by source, then slug.
    #[napi]
    pub fn list_link_page_metadata<'env>(
        &self,
        env: &'env Env,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_link_page_metadata(source_id.as_deref())
        })
    }

    /// `listStoredTimelineRows(sourceId, slug)`: the page's non-event timeline rows, by id.
    #[napi]
    pub fn list_stored_timeline_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_stored_timeline_rows(&source_id, &slug))
    }

    /// `filterPagesAtRevision(refs)`: the live pages still at the named revision.
    #[napi]
    pub fn filter_pages_at_revision<'env>(
        &self,
        env: &'env Env,
        refs: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.filter_pages_at_revision(&required::<Vec<_>>(refs, "filterPagesAtRevision refs")?)
        })
    }
}
