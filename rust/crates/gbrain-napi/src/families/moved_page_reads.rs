//! The page reads of the moved-pages verdict and of `gbrain repair moved-pages`' apply recheck: one `#[napi] impl
//! Brain` block over `gbrain_store::moved_page_reads`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listLivePagesBySourcePaths(sourceId, excludeId, paths)`: resolves `[{ id, slug, revision, source_path }]` by id.
    #[napi]
    pub fn list_live_pages_by_source_paths<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        exclude_id: i64,
        paths: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_live_pages_by_source_paths(&source_id, exclude_id, &paths)
        })
    }

    /// `listLivePagesByFileName(sourceId, excludeId, name)`: resolves at most five `{ slug, source_path }` by slug.
    #[napi]
    pub fn list_live_pages_by_file_name<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        exclude_id: i64,
        name: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_live_pages_by_file_name(&source_id, exclude_id, &name)
        })
    }

    /// `listLivePagesSharingFrontmatterId(sourceId, pageId)`: resolves at most five slugs, by slug.
    #[napi]
    pub fn list_live_pages_sharing_frontmatter_id<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_live_pages_sharing_frontmatter_id(&source_id, page_id)
        })
    }

    /// `readMeetingPage(sourceId, meetingId)`: resolves the live page of the source holding the meeting,
    /// `{ slug, source_path }` with the lowest id, or null (`gbrain_store::meeting_pages`).
    #[napi]
    pub fn read_meeting_page<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        meeting_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_meeting_page(&source_id, &meeting_id))
    }

    /// `listAttendanceMatches(sourceId, slugs, name)`: resolves at most two slugs of the live person pages of the
    /// source the attendee name can mean (`gbrain_store::meeting_pages`).
    #[napi]
    pub fn list_attendance_matches<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
        name: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_attendance_matches(&source_id, &slugs, &name)
        })
    }

    /// `hasSegmentedHistory(pageId)`: resolves whether the page or a version of it is stored in segments.
    #[napi]
    pub fn has_segmented_history<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_segmented_history(page_id))
    }

    /// `readLivePagesByIds(sourceId, ids)`: resolves the named live pages of the source with their revision and path.
    #[napi]
    pub fn read_live_pages_by_ids<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_live_pages_by_ids(&source_id, &ids))
    }
}
