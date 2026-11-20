//! Group 5 facts members of the held-fact move and the facts home scan: one `#[napi] impl Brain` block over
//! `gbrain_store::facts::held_moves`.
//!
//! Each method runs one store call on the pool through `Brain::run` and resolves plain JSON. The TypeScript members
//! (src/core/rust-engine/store-members/facts-held.ts) send the arguments of their BrainEngine members, judge the page
//! policy of `readHeldRowVisibility` and turn the ISO times into `Date`s.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::held_moves::{HeldAgeArgs, HeldPageArgs, HeldVisibilityArgs};
use gbrain_store::facts::purge::SourceArgs;

#[napi]
impl Brain {
    /// `heldEntityPageDeleted(args)`: resolves whether the page is soft-deleted.
    #[napi]
    pub fn held_entity_page_deleted<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HeldPageArgs = required(args, "heldEntityPageDeleted args")?;
            s.held_entity_page_deleted(&a)
        })
    }

    /// `heldTargetPageLive(args)`: resolves whether a live page holds the slug.
    #[napi]
    pub fn held_target_page_live<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HeldPageArgs = required(args, "heldTargetPageLive args")?;
            s.held_target_page_live(&a)
        })
    }

    /// `readHeldAccessState(args)`: resolves the one access-state row.
    #[napi]
    pub fn read_held_access_state<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HeldPageArgs = required(args, "readHeldAccessState args")?;
            s.read_held_access_state(&a)
        })
    }

    /// `listHeldMoveRows(args)`: resolves the live held rows.
    #[napi]
    pub fn list_held_move_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceArgs = required(args, "listHeldMoveRows args")?;
            s.list_held_move_rows(&a.source_id)
        })
    }

    /// `listStruckHeldRows(args)`: resolves the struck held rows.
    #[napi]
    pub fn list_struck_held_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceArgs = required(args, "listStruckHeldRows args")?;
            s.list_struck_held_rows(&a.source_id)
        })
    }

    /// `readHeldRowVisibility(args)`: resolves `{ visible }` or null.
    #[napi]
    pub fn read_held_row_visibility<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HeldVisibilityArgs = required(args, "readHeldRowVisibility args")?;
            s.read_held_row_visibility(&a)
        })
    }

    /// `heldMoveDue(args)`: resolves whether a rule makes a move due.
    #[napi]
    pub fn held_move_due<'env>(&self, env: &'env Env, args: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceArgs = required(args, "heldMoveDue args")?;
            s.held_move_due(&a.source_id)
        })
    }

    /// `readHeldConfigValue(name)`: resolves the config value or null.
    #[napi]
    pub fn read_held_config_value<'env>(
        &self,
        env: &'env Env,
        name: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let name: String = required(name, "readHeldConfigValue name")?;
            s.read_held_config_value(&name)
        })
    }

    /// `readHeldPageLocation(args)`: resolves `{ source_path, source_uri }` or null.
    #[napi]
    pub fn read_held_page_location<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HeldPageArgs = required(args, "readHeldPageLocation args")?;
            s.read_held_page_location(&a)
        })
    }

    /// `readHeldVersionsEdited(requestId)`: resolves the count.
    #[napi]
    pub fn read_held_versions_edited<'env>(
        &self,
        env: &'env Env,
        request_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let id: String = required(request_id, "readHeldVersionsEdited requestId")?;
            s.read_held_versions_edited(&id)
        })
    }

    /// `scanUnfencedFactRows(args)`: resolves the unfenced rows with their page flags.
    #[napi]
    pub fn scan_unfenced_fact_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceArgs = required(args, "scanUnfencedFactRows args")?;
            s.scan_unfenced_fact_rows(&a.source_id)
        })
    }

    /// `listHeldFactRows(args)`: resolves the held fence rows with their age.
    #[napi]
    pub fn list_held_fact_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HeldAgeArgs = required(args, "listHeldFactRows args")?;
            s.list_held_fact_rows(&a)
        })
    }

    /// `listFencedFactsOfMissingPages(args)`: resolves `{ id, slug }` rows.
    #[napi]
    pub fn list_fenced_facts_of_missing_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourceArgs = required(args, "listFencedFactsOfMissingPages args")?;
            s.list_fenced_facts_of_missing_pages(&a.source_id)
        })
    }
}
