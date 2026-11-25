//! Page versions: snapshot a page, list its versions, stamp the reason a write gave on the
//! versions it archived, cap a holding page's versions, and list and replace the stored reasons a
//! purge left (`gbrain repair purged-change-reasons`, `gbrain_store::repair_versions`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `createVersion(slug, { sourceId?, reason?, reasonSource?, historyGap? }?)`: snapshots the page
    /// and resolves the version row; `reason` is the snapshot's change reason (dropped when a purge
    /// tombstoned its `reasonSource` (commit, path)), and `historyGap` records that the page lost
    /// history first.
    #[napi]
    pub fn create_version<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let o: gbrain_store::pages::CreateVersionOptions =
                arg(options, "createVersion options")?;
            s.create_version_opts(&slug, &o)
        })
    }

    /// `getVersions(slug, { sourceId?, sourceIds?, limit?, includeBody?, excludePrivate? }?)`: newest first.
    #[napi]
    pub fn get_versions<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_versions(&slug, &arg(options, "getVersions options")?)
        })
    }

    /// `readLatestVersionId(pageId)`: resolves the page's newest version id, or null.
    #[napi]
    pub fn read_latest_version_id<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_latest_version_id(page_id))
    }

    /// `pruneHoldingPageVersions(pageId)`: resolves how many versions the holding-page cap deleted.
    #[napi]
    pub fn prune_holding_page_versions<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.prune_holding_page_versions(page_id))
    }

    /// `readLatestVersionIdAtTier(pageId, tier)`: resolves the page's newest version id stamped
    /// with the tier, or null.
    #[napi]
    pub fn read_latest_version_id_at_tier<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        tier: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_latest_version_id_at_tier(page_id, &tier)
        })
    }

    /// `stampVersionChangeReason({ pageId, afterVersionId, reason })`: resolves how many versions
    /// took the reason.
    #[napi]
    pub fn stamp_version_change_reason<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: gbrain_store::pages::VersionReasonStamp =
                required(spec, "stampVersionChangeReason spec")?;
            s.stamp_version_change_reason(&a)
        })
    }

    /// `listVersionsByChangeReason({ sourceId, reasons })`: resolves the source's versions whose change reason is one
    /// of `reasons`, by version id (`gbrain repair purged-change-reasons`).
    #[napi]
    pub fn list_versions_by_change_reason<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::repair_versions::VersionReasonQuery =
                required(query, "listVersionsByChangeReason query")?;
            s.list_versions_by_change_reason(&q)
        })
    }

    /// `replaceVersionChangeReasons({ sourceId, rows, replacement })`: resolves the ids of the versions that still held
    /// the reason they were named with and now hold `replacement`.
    #[napi]
    pub fn replace_version_change_reasons<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::repair_versions::VersionReasonReplace =
                required(spec, "replaceVersionChangeReasons spec")?;
            s.replace_version_change_reasons(&q)
        })
    }

    /// `listRetainedVersionBodies({ pageId, limit })`: resolves the page's retained inline bodies, newest first
    /// (`gbrain repair redacted-facts`).
    #[napi]
    pub fn list_retained_version_bodies<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::repair_versions::RetainedBodiesQuery =
                required(query, "listRetainedVersionBodies query")?;
            s.list_retained_version_bodies(&q)
        })
    }

    /// `listOverwriteCandidates({ sourceId, slugs, limit })`: resolves the versions a managed sync import archived over a database edit, newest first.
    #[napi]
    pub fn list_overwrite_candidates<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::repair_versions::OverwriteCandidateQuery =
                required(query, "listOverwriteCandidates query")?;
            s.list_overwrite_candidates(&q)
        })
    }

    /// `listVersionsAfter({ pageIds, afterId })`: resolves the later versions of the pages with their writing request and content, by id.
    #[napi]
    pub fn list_versions_after<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::repair_versions::VersionsAfterQuery =
                required(query, "listVersionsAfter query")?;
            s.list_versions_after(&q)
        })
    }

    /// `listOverwriteLivePages({ pageIds })`: resolves the revision of each page, its writing request, content and tags.
    #[napi]
    pub fn list_overwrite_live_pages<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::repair_versions::VersionsAfterQuery =
                required(query, "listOverwriteLivePages query")?;
            s.list_overwrite_live_pages(&q)
        })
    }

    /// `readPageVersionRow(versionId, pageId)`: resolves the whole version row, or null.
    #[napi]
    pub fn read_page_version_row<'env>(
        &self,
        env: &'env Env,
        version_id: i64,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_version_row(version_id, page_id))
    }

    /// `readVersionContent({ versionId, pageId })`: resolves the content columns of the version, or null.
    #[napi]
    pub fn read_version_content<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::repair_versions::VersionContentQuery =
                required(query, "readVersionContent query")?;
            s.read_version_content(&q)
        })
    }

    /// `readArchivedVersionBody({ pageId, receiptId })`: resolves the newest version of the page the request archived
    /// (`{ id, body_storage, compiled_truth, timeline }`), or null.
    #[napi]
    pub fn read_archived_version_body<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::repair_versions::ArchivedBodyQuery =
                required(query, "readArchivedVersionBody query")?;
            s.read_archived_version_body(&q)
        })
    }

    /// `listInlineVersionTexts(pageId)`: resolves the page's inline version bodies and timelines, by id.
    #[napi]
    pub fn list_inline_version_texts<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_inline_version_texts(page_id))
    }

    /// `movePageVersions(fromPageId, toPageId)`: resolves the moved version ids in id order.
    #[napi]
    pub fn move_page_versions<'env>(
        &self,
        env: &'env Env,
        from_page_id: i64,
        to_page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.move_page_versions(from_page_id, to_page_id))
    }

    /// `listPurgeVersionBodies({ sourceId, pageIds, after, needle, escaped })`: one batch of the
    /// inline versions a fact purge redacts, in id order.
    #[napi]
    pub fn list_purge_version_bodies<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: gbrain_store::purge_version_bodies::PurgeVersionBodyQuery =
                required(query, "listPurgeVersionBodies query")?;
            s.list_purge_version_bodies(&q)
        })
    }
}
