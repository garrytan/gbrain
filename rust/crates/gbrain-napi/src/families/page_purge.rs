//! The reads and tombstone edits of a page purge (src/core/engine-sql/page-purge.ts): the page's claims, link streams,
//! queued purge requests, stored body, mirrored claims, cascade counts, version columns, and the page, fact and take
//! tombstones.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through `Brain::run` and resolves
//! plain JSON (src/core/rust-engine/store-members/page-purge.ts).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listPurgeClaimFacts`: resolves `{ id, fact, source }` of the page's first 1000 facts, by id.
    #[napi]
    pub fn list_purge_claim_facts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_purge_claim_facts(&source_id, &slug))
    }

    /// `listPurgeClaimTakes`: resolves `{ id, claim }` of the page's first 1000 takes, by id.
    #[napi]
    pub fn list_purge_claim_takes<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_purge_claim_takes(page_id))
    }

    /// `listPurgeSegmentClaims`: resolves the text of the page's facts (outcome markers apart) and takes, each once.
    #[napi]
    pub fn list_purge_segment_claims<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_purge_segment_claims(&source_id, &slug, page_id)
        })
    }

    /// `listQueuedPagePurges`: resolves the queued `delete_page` purge requests of the source after a sequence, each with its page id.
    #[napi]
    pub fn list_queued_page_purges<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        after: String,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_queued_page_purges(&source_id, &after, limit)
        })
    }

    /// `listPageLinkStreams`: resolves the slug of the stream of every link to or from the page.
    #[napi]
    pub fn list_page_link_streams<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_page_link_streams(&source_id, page_id))
    }

    /// `readPurgePageBody`: resolves `{ content_hash, body_generation }` of the page, or null.
    #[napi]
    pub fn read_purge_page_body<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_purge_page_body(page_id))
    }

    /// `listPageMirrorFacts`: resolves each distinct claim of the page a purge mirrors: fingerprint, visibility, subject.
    #[napi]
    pub fn list_page_mirror_facts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_page_mirror_facts(&source_id, &slug))
    }

    /// `listPageMirrorTakeHashes`: resolves the fingerprint of each distinct take claim of the page.
    #[napi]
    pub fn list_page_mirror_take_hashes<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_page_mirror_take_hashes(page_id))
    }

    /// `countPageCascadeRows`: resolves how many chunks, versions, takes and timeline entries the page has.
    #[napi]
    pub fn count_page_cascade_rows<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_page_cascade_rows(page_id))
    }

    /// `listPageVersionSourcePaths`: resolves the distinct source paths of the page's versions, up to 64.
    #[napi]
    pub fn list_page_version_source_paths<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_page_version_source_paths(page_id))
    }

    /// `listPageVersionBodiesForPurge`: resolves the page's newest 1000 versions with the columns that give each body its import hash.
    #[napi]
    pub fn list_page_version_bodies_for_purge<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_page_version_bodies_for_purge(page_id))
    }

    /// `insertPageFactPurges`: stores a tombstone for each distinct claim of the page's facts; resolves null.
    #[napi]
    pub fn insert_page_fact_purges<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        request_id: String,
        actor: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_page_fact_purges(&source_id, &slug, &request_id, &actor)
        })
    }

    /// `listPagePurgeTombstones`: resolves `{ content_hash, slug }` of the source's tombstones, newest first.
    #[napi]
    pub fn list_page_purge_tombstones<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_page_purge_tombstones(&source_id, limit)
        })
    }

    /// `listPagePurgeRows`: resolves the tombstones of one source or of all, newest first.
    #[napi]
    pub fn list_page_purge_rows<'env>(
        &self,
        env: &'env Env,
        source_id: Option<String>,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_page_purge_rows(source_id.as_deref(), limit)
        })
    }

    /// `deletePagePurgeTombstones`: removes the slug's tombstones and resolves the request id of each.
    #[napi]
    pub fn delete_page_purge_tombstones<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_page_purge_tombstones(&source_id, &slug)
        })
    }

    /// `deleteFactPurgesByRequests`: removes the source's fact tombstones of the requests and resolves how many.
    #[napi]
    pub fn delete_fact_purges_by_requests<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        request_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_fact_purges_by_requests(&source_id, &request_ids)
        })
    }

    /// `deleteTakePurgesByRequests`: removes the source's take tombstones of the requests and resolves how many.
    #[napi]
    pub fn delete_take_purges_by_requests<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        request_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_take_purges_by_requests(&source_id, &request_ids)
        })
    }
}
