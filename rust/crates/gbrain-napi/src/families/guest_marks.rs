//! The guest marks of guest notes (rust/docs/store/guest_marks.md).
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
}
