//! Core edit notices (`gbrain_store::core_edit_notices`): `insertCoreEditNotice`,
//! `listPendingCoreEditNotices`, `readOldestPendingCoreEditNotice`,
//! `findCoreEditNoticeIdByRevision`, `ackCoreEditNotices` and `blankPurgeCoreEditNotices`.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store"). Ids are JavaScript numbers.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `insertCoreEditNotice({ sourceId, slug, pageId | null, revision | null, baseRevision | null,
    /// baseText | null, actor })`: stores a pending notice stamped now and resolves its id.
    #[napi]
    pub fn insert_core_edit_notice<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input = required(input, "insertCoreEditNotice input")?;
            s.insert_core_edit_notice(&input)
        })
    }

    /// `listPendingCoreEditNotices(sourceIds | null)`: resolves `{ source_id, slug, revision,
    /// actor, created_at }` for the newest pending notice of each page, in byte order of source
    /// then slug, at most 50. `created_at` is `timestamptz::text`.
    #[napi]
    pub fn list_pending_core_edit_notices<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_pending_core_edit_notices(source_ids.as_deref())
        })
    }

    /// `readOldestPendingCoreEditNotice(sourceId, slug)`: resolves `{ base_text, actor,
    /// created_at }` of the page's pending notice with the lowest id, or null.
    #[napi]
    pub fn read_oldest_pending_core_edit_notice<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_oldest_pending_core_edit_notice(&source_id, &slug)
        })
    }

    /// `findCoreEditNoticeIdByRevision(sourceId, slug, revision)`: resolves the highest id among
    /// the page's notices (pending or acknowledged) with that revision, or null.
    #[napi]
    pub fn find_core_edit_notice_id_by_revision<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        revision: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_core_edit_notice_id_by_revision(&source_id, &slug, &revision)
        })
    }

    /// `ackCoreEditNotices(sourceId, slug, maxId | null)`: acknowledges the page's pending
    /// notices (those with an id up to `maxId` when it is given) and resolves how many.
    #[napi]
    pub fn ack_core_edit_notices<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        max_id: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.ack_core_edit_notices(&source_id, &slug, max_id)
        })
    }

    /// `blankPurgeCoreEditNotices(sourceId, loweredFact)`: clears the base text of the source's
    /// notices whose lowered base text holds the fact and resolves how many.
    #[napi]
    pub fn blank_purge_core_edit_notices<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        lowered_fact: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.blank_purge_core_edit_notices(&source_id, &lowered_fact)
        })
    }
}
