//! The held-concept rebuild's reads and link carry (`gbrain_store::concept_rebuild`; SQL in
//! `src/core/engine-sql/concept-rebuild.ts`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store"). Page ids arrive as JSON numbers
//! (`integer` in the SQL), so one outside it is refused by the store as the cast refuses it.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use gbrain_store::concept_rebuild::{MemberRevision, StatedKindLists};
use gbrain_store::facts::PrivacyPolicy;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readHeldConcept(pageId)`: `{ deleted_us }` while the tombstone is held, else `null`.
    #[napi]
    pub fn read_held_concept<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        owed_op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_held_concept(required(page_id, "readHeldConcept pageId")?, &owed_op)
        })
    }

    /// `isConceptStillHeld(pageId, deletedUs)`.
    #[napi]
    pub fn is_concept_still_held<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        deleted_us: String,
        owed_op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.is_concept_still_held(
                required(page_id, "isConceptStillHeld pageId")?,
                &deleted_us,
                &owed_op,
            )
        })
    }

    /// `lockHeldConcept(pageId, sourceId, slug, deletedUs)`.
    #[napi]
    pub fn lock_held_concept<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        source_id: String,
        slug: String,
        deleted_us: String,
        owed_op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.lock_held_concept(
                required(page_id, "lockHeldConcept pageId")?,
                &source_id,
                &slug,
                &deleted_us,
                &owed_op,
            )
        })
    }

    /// `lockLiveConceptMembers(sourceId, members)`: how many members are live at their revision.
    #[napi]
    pub fn lock_live_concept_members<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        members: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.lock_live_concept_members(
                &source_id,
                &required::<Vec<MemberRevision>>(members, "lockLiveConceptMembers members")?,
            )
        })
    }

    /// `listLiveConceptMemberRevisions(sourceId, slugs)`.
    #[napi]
    pub fn list_live_concept_member_revisions<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_live_concept_member_revisions(&source_id, &slugs)
        })
    }

    /// `listConceptIncomingLinks(pageId)`: `to_jsonb`-shaped link rows.
    #[napi]
    pub fn list_concept_incoming_links<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_concept_incoming_links(required(page_id, "listConceptIncomingLinks pageId")?)
        })
    }

    /// `carryConceptIncomingLinks(sourceId, slug, incoming, oldId)`: `{ id, carried }`, or `null`.
    #[napi]
    pub fn carry_concept_incoming_links<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        incoming: Value,
        old_id: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.carry_concept_incoming_links(
                &source_id,
                &slug,
                &required::<Vec<Value>>(incoming, "carryConceptIncomingLinks incoming")?,
                required(old_id, "carryConceptIncomingLinks oldId")?,
            )
        })
    }

    /// `readTombstoneWindow(pageId, hours)`: `{ until, past }`, or `null`.
    #[napi]
    pub fn read_tombstone_window<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        hours: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_tombstone_window(required(page_id, "readTombstoneWindow pageId")?, hours)
        })
    }

    /// `readConceptStatedKinds(pageId, sourceId, slug, lists)`: `{ kinds, lead, segmented }`.
    #[napi]
    pub fn read_concept_stated_kinds<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        source_id: String,
        slug: String,
        lists: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_concept_stated_kinds(
                required(page_id, "readConceptStatedKinds pageId")?,
                &source_id,
                &slug,
                &required::<StatedKindLists>(lists, "readConceptStatedKinds lists")?,
            )
        })
    }

    /// `readRebuildAccess(pageId, openPolicy)`: the page's access, or `null`.
    #[napi]
    pub fn read_rebuild_access<'env>(
        &self,
        env: &'env Env,
        page_id: Value,
        open_policy: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_rebuild_access(
                required(page_id, "readRebuildAccess pageId")?,
                &required::<PrivacyPolicy>(open_policy, "readRebuildAccess policy")?,
            )
        })
    }

    /// `readHeldConceptRows(owedOp, privateAliases, memberPolicy)`: the held concepts with their privacy marks.
    #[napi]
    pub fn read_held_concept_rows<'env>(
        &self,
        env: &'env Env,
        owed_op: String,
        private_aliases: bool,
        member_policy: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_held_concept_rows(
                &owed_op,
                private_aliases,
                &required::<PrivacyPolicy>(member_policy, "readHeldConceptRows policy")?,
            )
        })
    }
}
