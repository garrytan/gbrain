//! The phantom redirect's fact, page, timeline and link statements: one `#[napi] impl Brain` block over
//! `gbrain_store::facts::phantom` and `gbrain_store::links::phantom_merge`.
//!
//! Each method runs one store call on the pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/facts-phantom.ts) pass the arguments of each statement as one object, or the
//! one scalar the statement binds.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::cycle::PageCoordinate;
use gbrain_store::facts::phantom::{FactIdsOnPage, MoveFactArgs, RootSlugsQuery};
use gbrain_store::links::phantom_merge::{LinkIdsOnPage, RepointArgs};

#[napi]
impl Brain {
    /// `listPhantomFactRows(sourceId, slug)`: resolves `{ id, row_num }` rows, by id.
    #[napi]
    pub fn list_phantom_fact_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageCoordinate = required(args, "listPhantomFactRows args")?;
            s.list_phantom_fact_rows(&a)
        })
    }

    /// `listCanonicalFenceRowNums(sourceId, slug)`: resolves `{ row_num }` rows, by fact id.
    #[napi]
    pub fn list_canonical_fence_row_nums<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageCoordinate = required(args, "listCanonicalFenceRowNums args")?;
            s.list_canonical_fence_row_nums(&a)
        })
    }

    /// `listActiveFactIdsOfPage(sourceId, slug)`: resolves `{ id }` rows, by id.
    #[napi]
    pub fn list_active_fact_ids_of_page<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageCoordinate = required(args, "listActiveFactIdsOfPage args")?;
            s.list_active_fact_ids_of_page(&a)
        })
    }

    /// `listFactIdsStillOnPage(ids, slug)`: resolves `{ id }` rows, by id.
    #[napi]
    pub fn list_fact_ids_still_on_page<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactIdsOnPage = required(args, "listFactIdsStillOnPage args")?;
            s.list_fact_ids_still_on_page(&a)
        })
    }

    /// `moveFactToPage(sourceId, id, slug, rowNum)`: moves the fact; resolves null.
    #[napi]
    pub fn move_fact_to_page<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: MoveFactArgs = required(args, "moveFactToPage args")?;
            s.move_fact_to_page(&a)
        })
    }

    /// `listOntologyObservationSlugs(sourceId)`: resolves `{ slug }` rows in byte order.
    #[napi]
    pub fn list_ontology_observation_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_ontology_observation_slugs(&source_id))
    }

    /// `listRootPageSlugsAfter(sourceId, take, held, after)`: resolves `{ slug }` rows in byte order.
    #[napi]
    pub fn list_root_page_slugs_after<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RootSlugsQuery = required(args, "listRootPageSlugsAfter args")?;
            s.list_root_page_slugs_after(&a)
        })
    }

    /// `pageHasTimelineEntries(pageId)`: resolves whether the page holds a timeline entry.
    #[napi]
    pub fn page_has_timeline_entries<'env>(
        &self,
        env: &'env Env,
        page_id: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.page_has_timeline_entries(page_id))
    }

    /// `listOwnLinkIds(pageId)`: resolves `{ id }` rows, by id.
    #[napi]
    pub fn list_own_link_ids<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_own_link_ids(page_id))
    }

    /// `listLinkIdsOnPage(ids, pageId)`: resolves `{ id }` rows, by id.
    #[napi]
    pub fn list_link_ids_on_page<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LinkIdsOnPage = required(args, "listLinkIdsOnPage args")?;
            s.list_link_ids_on_page(&a)
        })
    }

    /// `repointInboundLinks(phantomId, canonicalId)`: resolves null.
    #[napi]
    pub fn repoint_inbound_links<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RepointArgs = required(args, "repointInboundLinks args")?;
            s.repoint_inbound_links(&a)
        })
    }

    /// `repointOutboundLinks(phantomId, canonicalId)`: resolves null.
    #[napi]
    pub fn repoint_outbound_links<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RepointArgs = required(args, "repointOutboundLinks args")?;
            s.repoint_outbound_links(&a)
        })
    }
}
