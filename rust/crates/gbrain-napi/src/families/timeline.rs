//! Timeline entries of a page.
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
    /// `addTimelineEntry(slug, { date, source?, summary, detail? }, { skipExistenceCheck?,
    /// sourceId? }?)`: resolves true when it inserted, false for a duplicate.
    #[napi]
    pub fn add_timeline_entry<'env>(
        &self,
        env: &'env Env,
        slug: String,
        entry: Value,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let entry: gbrain_store::timeline::TimelineInput =
                required(entry, "addTimelineEntry entry")?;
            s.add_timeline_entry(&slug, &entry, &arg(options, "addTimelineEntry options")?)
        })
    }

    /// `addTimelineEntriesBatch(entries)`: resolves the number of entries inserted.
    #[napi]
    pub fn add_timeline_entries_batch<'env>(
        &self,
        env: &'env Env,
        entries: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let entries: Vec<gbrain_store::timeline::TimelineBatchInput> =
                required(entries, "addTimelineEntriesBatch entries")?;
            s.add_timeline_entries_batch(&entries)
        })
    }

    /// `readNewestTimelineEntryId(sourceId, slug, date, summary)`: resolves the newest matching
    /// entry's id, or null.
    #[napi]
    pub fn read_newest_timeline_entry_id<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        date: String,
        summary: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_newest_timeline_entry_id(&source_id, &slug, &date, &summary)
        })
    }

    /// `getTimeline(slug, { limit?, sourceId?, sourceIds?, after?, before? }?)`: newest first.
    /// `date` is `YYYY-MM-DD` and `created_at` an ISO string; the shell makes them `Date`s.
    #[napi]
    pub fn get_timeline<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_timeline(&slug, &arg(options, "getTimeline options")?)
        })
    }
}
