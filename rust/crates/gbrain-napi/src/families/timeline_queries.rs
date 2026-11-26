//! Timeline reads by date (the Life Chronicle reads) and event projections.
//!
//! Store methods for getTimelineForDate, getSince, getOnThisDay, getLastSeen,
//! upsertEventProjection, removeTimelineRows, updateTimelineDetails and
//! insertCanonicalTimelineRows, and the timeline reads
//! of `src/core/engine-sql/timeline-reads.ts` (sampleEffectiveDates, sampleEffectiveDateSources,
//! readMaxTimelineEntryId, listStoredTimelineRowsOrdered, deleteTimelineRows,
//! storedTimelineRowsByPageIds, countSegmentedTimelinePages, countTimelineCommentMarkupRows,
//! listTimelineOrphanPages), and the timeline repair reads of
//! `src/core/engine-sql/timeline-repair-reads.ts` (listTimelineHistoryPages,
//! listTimelineVersionWitnesses, readTimelineVersionBody, listTimelineMarkupRows,
//! listMaterializedMarkerPages, rewriteTimelineRow, listDateBulletPages,
//! listConnectorFencePages).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg, required};
use gbrain_store::timeline_queries;

#[napi]
impl Brain {
    /// `getTimelineForDate(date, { week?, limit?, sourceId?, sourceIds? }?)`:
    /// `ChronicleTimelineRow[]`, earliest first. `date` stays `YYYY-MM-DD`.
    #[napi]
    pub fn get_timeline_for_date<'env>(
        &self,
        env: &'env Env,
        date: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_timeline_for_date(&date, &arg(options, "getTimelineForDate options")?)
        })
    }

    /// `getSince(date, { kind?, limit?, sourceId?, sourceIds? }?)`: `ChronicleTimelineRow[]`,
    /// earliest first.
    #[napi]
    pub fn get_since<'env>(
        &self,
        env: &'env Env,
        date: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_since(&date, &arg(options, "getSince options")?)
        })
    }

    /// `getOnThisDay({ date?, limit?, sourceId?, sourceIds? }?)`: `ChronicleTimelineRow[]`,
    /// newest year first.
    #[napi]
    pub fn get_on_this_day<'env>(
        &self,
        env: &'env Env,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_on_this_day(&arg(options, "getOnThisDay options")?)
        })
    }

    /// `getLastSeen(entitySlug, { asof?, sourceId?, sourceIds? }?)`: `{ last_date,
    /// last_event_slug }`; the shell adds `entity_slug` and `days_ago`.
    #[napi]
    pub fn get_last_seen<'env>(
        &self,
        env: &'env Env,
        entity_slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_last_seen(&entity_slug, &arg(options, "getLastSeen options")?)
        })
    }

    /// `upsertEventProjection({ depthSlug, eventSlug, date, summary, detail?, sourceId? })`:
    /// `{ projected }`.
    #[napi]
    pub fn upsert_event_projection<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.upsert_event_projection(&arg(Some(input), "upsertEventProjection options")?)
        })
    }

    /// `removeTimelineRows(pageId, rows)`: resolves `[{ date, removed }]` for each deleted row.
    #[napi]
    pub fn remove_timeline_rows<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<timeline_queries::TimelineRowRemoval> =
                required(rows, "removeTimelineRows rows")?;
            s.remove_timeline_rows(page_id as i64, &rows)
        })
    }

    /// `updateTimelineDetails(pageId, rows)`: resolves null.
    #[napi]
    pub fn update_timeline_details<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<timeline_queries::TimelineDetailRefresh> =
                required(rows, "updateTimelineDetails rows")?;
            s.update_timeline_details(page_id as i64, &rows)
        })
    }

    /// `insertCanonicalTimelineRows(pageId, rows)`: resolves null.
    #[napi]
    pub fn insert_canonical_timeline_rows<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<timeline_queries::CanonicalTimelineRow> =
                required(rows, "insertCanonicalTimelineRows rows")?;
            s.insert_canonical_timeline_rows(page_id as i64, &rows)
        })
    }

    /// `sampleEffectiveDates()`: `{ future_dated, pre_1990 }`.
    #[napi]
    pub fn sample_effective_dates<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.sample_effective_dates())
    }

    /// `sampleEffectiveDateSources()`: the fallback-dated sample rows, newest first.
    #[napi]
    pub fn sample_effective_date_sources<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.sample_effective_date_sources())
    }

    /// `readMaxTimelineEntryId()`: the largest entry id, or 0.
    #[napi]
    pub fn read_max_timeline_entry_id<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_max_timeline_entry_id())
    }

    /// `listStoredTimelineRowsOrdered(pageId)`: the page's own rows, by date then id.
    #[napi]
    pub fn list_stored_timeline_rows_ordered<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let page_id: i64 = arg(input, "listStoredTimelineRowsOrdered input")?;
            s.list_stored_timeline_rows_ordered(page_id)
        })
    }

    /// `deleteTimelineRows({ pageId, deletions })`: `{ date, removed }[]`.
    #[napi]
    pub fn delete_timeline_rows<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::timeline_queries::DeleteTimelineRowsInput =
                arg(input, "deleteTimelineRows input")?;
            s.delete_timeline_rows(&input)
        })
    }

    /// `storedTimelineRowsByPageIds(pageIds)`: the own rows, by page id then id.
    #[napi]
    pub fn stored_timeline_rows_by_page_ids<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<i64> = arg(input, "storedTimelineRowsByPageIds input")?;
            s.stored_timeline_rows_by_page_ids(&ids)
        })
    }

    /// `countSegmentedTimelinePages({ sourceIds, limit })`: `{ pages, rows, sample }`.
    #[napi]
    pub fn count_segmented_timeline_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::timeline_queries::SegmentedTimelineInput =
                arg(input, "countSegmentedTimelinePages input")?;
            s.count_segmented_timeline_pages(&input)
        })
    }

    /// `countTimelineCommentMarkupRows(sourceIds)`: a count.
    #[napi]
    pub fn count_timeline_comment_markup_rows<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<String> = arg(input, "countTimelineCommentMarkupRows input")?;
            s.count_timeline_comment_markup_rows(&ids)
        })
    }

    /// `listTimelineOrphanPages({ afterId, limit, sourceId? })`: the pages, by id.
    #[napi]
    pub fn list_timeline_orphan_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::timeline_queries::TimelineOrphanInput =
                arg(input, "listTimelineOrphanPages input")?;
            s.list_timeline_orphan_pages(&input)
        })
    }

    /// `listTimelineHistoryPages({ sourceIds, afterId, limit } | { sourceIds, ids })`: the pages, by id.
    #[napi]
    pub fn list_timeline_history_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: timeline_queries::TimelineHistoryInput =
                arg(input, "listTimelineHistoryPages input")?;
            s.list_timeline_history_pages(&input)
        })
    }

    /// `listTimelineVersionWitnesses(sourceId, slug)`: the page's versions, newest first.
    #[napi]
    pub fn list_timeline_version_witnesses<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_timeline_version_witnesses(&source_id, &slug)
        })
    }

    /// `readTimelineVersionBody(pageId, versionId)`: the body and its digests, or null.
    #[napi]
    pub fn read_timeline_version_body<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        version_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_timeline_version_body(page_id as i64, version_id as i64)
        })
    }

    /// `listTimelineMarkupRows({ sourceIds, afterId } | { pageId })`: the rows, by page then id.
    #[napi]
    pub fn list_timeline_markup_rows<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: timeline_queries::TimelineMarkupInput =
                arg(input, "listTimelineMarkupRows input")?;
            s.list_timeline_markup_rows(&input)
        })
    }

    /// `listMaterializedMarkerPages({ sourceIds, afterId })`: the pages, by id.
    #[napi]
    pub fn list_materialized_marker_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: timeline_queries::TimelinePageScanInput =
                arg(input, "listMaterializedMarkerPages input")?;
            s.list_materialized_marker_pages(&input)
        })
    }

    /// `rewriteTimelineRow(pageId, { id, source, summary, detail })`: resolves null.
    #[napi]
    pub fn rewrite_timeline_row<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let row: timeline_queries::TimelineRowRewrite =
                required(row, "rewriteTimelineRow row")?;
            s.rewrite_timeline_row(page_id as i64, &row)
        })
    }

    /// `listDateBulletPages({ sourceIds, afterId, slugs, limit })`: the pages, by id.
    #[napi]
    pub fn list_date_bullet_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: timeline_queries::TimelinePageScanInput =
                arg(input, "listDateBulletPages input")?;
            s.list_date_bullet_pages(&input)
        })
    }

    /// `listConnectorFencePages({ sourceIds, kinds, segmented })`: the pages, by id.
    #[napi]
    pub fn list_connector_fence_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: timeline_queries::ConnectorFenceInput =
                arg(input, "listConnectorFencePages input")?;
            s.list_connector_fence_pages(&input)
        })
    }
}
