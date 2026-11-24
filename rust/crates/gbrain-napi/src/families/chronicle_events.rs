//! The Life Chronicle event members of `src/core/engine-sql/chronicle-events.ts` that the store
//! answers: readChronicleDepthRow, listRetiredGenerationItemKeys, listEventProjectionRows,
//! listPageContentHashes, listLiveGenerationItems, readEventProjectionId, pageSlugExists,
//! deleteEventProjections, restoreEventProjection, listOrphanedChronicleOwners and
//! listChronicleEventSlotRows.
//!
//! One `#[napi] impl Brain` block; each method takes one spec object, runs one `Store` call on the
//! pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/chronicle-events.ts) answer the two chronicle ledger reads
//! themselves.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::generations::{
    ChronicleSlugSpec, ChronicleSlugsSpec, GenerationKey, OrphanedOwnersSpec, PageContentHashQuery,
    RetiredItemKeysSpec,
};
use gbrain_store::timeline_queries::{
    EventProjectionIdSpec, EventProjectionRestoreSpec, EventProjectionRowsSpec,
    EventProjectionSlugsSpec,
};

#[napi]
impl Brain {
    /// `readChronicleDepthRow(spec)`: resolves `{ id, live }` or null.
    #[napi]
    pub fn read_chronicle_depth_row<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ChronicleSlugSpec = required(spec, "readChronicleDepthRow spec")?;
            s.read_chronicle_depth_row(&a)
        })
    }

    /// `listRetiredGenerationItemKeys(spec)`: resolves the retired keys.
    #[napi]
    pub fn list_retired_generation_item_keys<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: RetiredItemKeysSpec = required(spec, "listRetiredGenerationItemKeys spec")?;
            s.list_retired_generation_item_keys(&a)
        })
    }

    /// `listEventProjectionRows(spec)`: resolves `[{ event_page_id, date, summary, detail }]`.
    #[napi]
    pub fn list_event_projection_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: EventProjectionRowsSpec = required(spec, "listEventProjectionRows spec")?;
            s.list_event_projection_rows(&a)
        })
    }

    /// `listPageContentHashes(spec)`: resolves `[{ slug, content_hash }]`.
    #[napi]
    pub fn list_page_content_hashes<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageContentHashQuery = required(spec, "listPageContentHashes spec")?;
            s.list_page_content_hashes(&a)
        })
    }

    /// `listLiveGenerationItems(spec)`: resolves `[{ item_key, identity_hash }]`.
    #[napi]
    pub fn list_live_generation_items<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: GenerationKey = required(spec, "listLiveGenerationItems spec")?;
            s.list_live_generation_items(&a)
        })
    }

    /// `readEventProjectionId(spec)`: resolves the entry id or null.
    #[napi]
    pub fn read_event_projection_id<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: EventProjectionIdSpec = required(spec, "readEventProjectionId spec")?;
            s.read_event_projection_id(&a)
        })
    }

    /// `pageSlugExists(spec)`: resolves a boolean.
    #[napi]
    pub fn page_slug_exists<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ChronicleSlugSpec = required(spec, "pageSlugExists spec")?;
            s.page_slug_exists(&a)
        })
    }

    /// `deleteEventProjections(spec)`: resolves null.
    #[napi]
    pub fn delete_event_projections<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: EventProjectionSlugsSpec = required(spec, "deleteEventProjections spec")?;
            s.delete_event_projections(&a)
        })
    }

    /// `restoreEventProjection(spec)`: resolves null.
    #[napi]
    pub fn restore_event_projection<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: EventProjectionRestoreSpec = required(spec, "restoreEventProjection spec")?;
            s.restore_event_projection(&a)
        })
    }

    /// `listOrphanedChronicleOwners(spec)`: resolves the owner keys.
    #[napi]
    pub fn list_orphaned_chronicle_owners<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: OrphanedOwnersSpec = required(spec, "listOrphanedChronicleOwners spec")?;
            s.list_orphaned_chronicle_owners(&a)
        })
    }

    /// `listChronicleCoverageGapRows()`: resolves `[{ type, effective_date, effective_date_source, fm_date, fm_start }]`.
    #[napi]
    pub fn list_chronicle_coverage_gap_rows<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_chronicle_coverage_gap_rows())
    }

    /// `listChronicleEventSlotRows(spec)`: resolves `[{ slug, when, where, kind }]`.
    #[napi]
    pub fn list_chronicle_event_slot_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ChronicleSlugsSpec = required(spec, "listChronicleEventSlotRows spec")?;
            s.list_chronicle_event_slot_rows(&a)
        })
    }
}
