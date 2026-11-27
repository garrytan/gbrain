//! The guest marks of guest notes and the owner's promotions of them (rust/docs/store/guest_marks.md,
//! rust/docs/store/guest_promotions.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `Store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `insertGuestMark({ sourceId, slug, audienceMember, groupSlug, senderLabel, writerKind, writerId, requestId })`:
    /// writes the mark of the page at `(sourceId, slug)` and resolves how many rows it wrote (0 or 1).
    #[napi]
    pub fn insert_guest_mark<'env>(
        &self,
        env: &'env Env,
        mark: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_guest_mark(&required(mark, "insertGuestMark")?)
        })
    }

    /// `readGuestMarks(pageIds)`: resolves the mark of each page id that has one, by page id.
    #[napi]
    pub fn read_guest_marks<'env>(
        &self,
        env: &'env Env,
        page_ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        let ids: Vec<u64> = page_ids
            .into_iter()
            .filter_map(|id| u64::try_from(id).ok())
            .collect();
        self.run(env, move |s| s.read_guest_marks(&ids))
    }

    /// `linkGuestPromotion({ guestPageId, targetSource, targetSlug, byKind, byId, requestId })`: relinks or writes the
    /// promotion row of that guest page and target.
    #[napi]
    pub fn link_guest_promotion<'env>(
        &self,
        env: &'env Env,
        link: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.link_guest_promotion(&required(link, "linkGuestPromotion")?)
        })
    }

    /// `readGuestPromotionKept(guestPageId, targetSource, targetSlug)`: whether the link exists and its target page does.
    #[napi]
    pub fn read_guest_promotion_kept<'env>(
        &self,
        env: &'env Env,
        guest_page_id: i64,
        target_source: String,
        target_slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| match u64::try_from(guest_page_id) {
            Ok(id) => s.read_guest_promotion_kept(id, &target_source, &target_slug),
            Err(_) => Ok(false),
        })
    }

    /// `readGuestDeleteCheck(sourceId, slug)`: `{ hidden, guest, kept, writer }` of the page there, or null.
    #[napi]
    pub fn read_guest_delete_check<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_guest_delete_check(&source_id, &slug))
    }

    /// `readGuestRefPages({ ids, keys, exclude_private })`: `{ id, source_id, slug, type, frontmatter }` of each page.
    #[napi]
    pub fn read_guest_ref_pages<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_guest_ref_pages(&required(query, "readGuestRefPages")?)
        })
    }
}
