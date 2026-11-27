//! The member handover preview reads (gbrain-store `handover_reads`, `jobs::doctor_credentials`): the pages whose
//! readers name the leaver, the pages a rule prefix covers, and the member page, fact and credential counts
//! (src/core/rust-engine/store-members/handover-reads.ts).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listHandoverReaderPages(principals, limit)`: `[{ id, source_id, slug, frontmatter }]` by source and slug.
    #[napi]
    pub fn list_handover_reader_pages<'env>(
        &self,
        env: &'env Env,
        principals: Vec<String>,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_handover_reader_pages(&principals, limit)
        })
    }

    /// `listHandoverPrefixPages(sourceId, prefix)`: `[{ source_id, slug, frontmatter }]` of the pages the prefix covers.
    #[napi]
    pub fn list_handover_prefix_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_handover_prefix_pages(&source_id, &prefix)
        })
    }

    /// `countMemberPage(slug)`: the live pages with this slug.
    #[napi]
    pub fn count_member_page<'env>(
        &self,
        env: &'env Env,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_member_page(&slug))
    }

    /// `countMemberPageFacts(slug)`: the facts kept on a live page with this slug.
    #[napi]
    pub fn count_member_page_facts<'env>(
        &self,
        env: &'env Env,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_member_page_facts(&slug))
    }

    /// `countMemberBoundCredentials(memberId)`: the member's live tokens plus its OAuth clients.
    #[napi]
    pub fn count_member_bound_credentials<'env>(
        &self,
        env: &'env Env,
        member_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_member_bound_credentials(&member_id))
    }
}
