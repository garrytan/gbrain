//! The extract_facts fence reconcile and deleted-page expiry: one `#[napi] impl Brain` block over
//! `gbrain_store::facts::cycle_fence`.
//!
//! Each method runs one store call on the pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/facts-cycle-fence.ts) pass the arguments of each statement as one object.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::cycle_fence::{
    CoordinateArgs, DeletedPageQuery, FactIdsInSource, FactInSource, FenceCellsArgs,
    SupersededByArgs,
};

#[napi]
impl Brain {
    /// `listDeletedPageSlugsWithActiveFacts(sourceId)`: resolves `{ slug }` rows in byte order.
    #[napi]
    pub fn list_deleted_page_slugs_with_active_facts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_deleted_page_slugs_with_active_facts(&source_id)
        })
    }

    /// `listFenceRowSupersession`: resolves `{ id, row_num, expired_at, superseded_by }` rows, by id.
    #[napi]
    pub fn list_fence_row_supersession<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: CoordinateArgs = required(args, "listFenceRowSupersession args")?;
            s.list_fence_row_supersession(&a)
        })
    }

    /// `setFactSupersededBy`: sets or clears `superseded_by`; resolves null.
    #[napi]
    pub fn set_fact_superseded_by<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SupersededByArgs = required(args, "setFactSupersededBy args")?;
            s.set_fact_superseded_by(&a)
        })
    }

    /// `expireFactInPlace`: expires the row where it stands; resolves null.
    #[napi]
    pub fn expire_fact_in_place<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactInSource = required(args, "expireFactInPlace args")?;
            s.expire_fact_in_place(&a)
        })
    }

    /// `expireAndDetachFact`: expires the row and drops its row number; resolves null.
    #[napi]
    pub fn expire_and_detach_fact<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactInSource = required(args, "expireAndDetachFact args")?;
            s.expire_and_detach_fact(&a)
        })
    }

    /// `updateFenceFactCells`: writes a fence row's cells onto the fact; resolves null.
    #[napi]
    pub fn update_fence_fact_cells<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FenceCellsArgs = required(args, "updateFenceFactCells args")?;
            s.update_fence_fact_cells(&a)
        })
    }

    /// `listHeldWideningFactIds`: resolves `{ id }` for each proposal that holds a fact narrower.
    #[napi]
    pub fn list_held_widening_fact_ids<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactIdsInSource = required(args, "listHeldWideningFactIds args")?;
            s.list_held_widening_fact_ids(&a)
        })
    }

    /// `listExpirableFactIdsOfDeletedPage`: resolves `{ id }` of the deleted page's unexpired fence rows.
    #[napi]
    pub fn list_expirable_fact_ids_of_deleted_page<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DeletedPageQuery = required(args, "listExpirableFactIdsOfDeletedPage args")?;
            s.list_expirable_fact_ids_of_deleted_page(&a)
        })
    }

    /// `readDeletedPageBody`: resolves the deleted page's body, or null.
    #[napi]
    pub fn read_deleted_page_body<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: CoordinateArgs = required(args, "readDeletedPageBody args")?;
            s.read_deleted_page_body(&a)
        })
    }

    /// `expireFactsByIds`: resolves `{ id }` of each row it expired.
    #[napi]
    pub fn expire_facts_by_ids<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: FactIdsInSource = required(args, "expireFactsByIds args")?;
            s.expire_facts_by_ids(&a)
        })
    }
}
