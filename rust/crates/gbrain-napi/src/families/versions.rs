//! Page versions: snapshot a page, list its versions, stamp the reason a write gave on the
//! versions it archived, cap a holding page's versions.
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
    /// `createVersion(slug, { sourceId?, reason?, historyGap? }?)`: snapshots the page and resolves
    /// the version row; `reason` is the snapshot's change reason, and `historyGap` records that the
    /// page lost history first.
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
