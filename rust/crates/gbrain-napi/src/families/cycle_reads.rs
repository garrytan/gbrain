//! The cycle, belief and sync reads that ran raw SQL and are now typed members: the propose_takes
//! failure tombstones (rust/docs/store/take-proposals.md), the cycle's changed-page window
//! (cycle-window.md), the identity-downgrade page reads (identity-downgrades.md), the stale-mention
//! scan's page and link reads (mention-scan-reads.md) and the belief ledger's orphan lifetimes
//! (trust.md).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::take_proposals::FailureTombstoneInput;

#[napi]
impl Brain {
    /// `recordFailureTombstone(input)`: resolves true when it inserted, false when the claim is
    /// already recorded for the page, content hash and prompt version.
    #[napi]
    pub fn record_failure_tombstone<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: FailureTombstoneInput = required(input, "recordFailureTombstone input")?;
            s.record_failure_tombstone(&input)
        })
    }

    /// `listFailureTombstones(sourceId, claimPrefix)`: `[{ page_slug, claim_text, prompt_version,
    /// proposed_at }]` by page slug bytes.
    #[napi]
    pub fn list_failure_tombstones<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        claim_prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_failure_tombstones(&source_id, &claim_prefix)
        })
    }

    /// `readCycleListingInstant()`: UTC ISO text with microseconds.
    #[napi]
    pub fn read_cycle_listing_instant<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_cycle_listing_instant())
    }

    /// `listSourceChangedPagesAfter(sourceId, since, slug, limit)`: `[{ slug, updated_at }]`.
    #[napi]
    pub fn list_source_changed_pages_after<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        since: Option<String>,
        slug: String,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_source_changed_pages_after(&source_id, since.as_deref(), &slug, limit as usize)
        })
    }

    /// `readSoftDeletedPageAtOrigin(sourceId, path, slug)`: `{ id, slug, deleted_at }` or `null`.
    #[napi]
    pub fn read_soft_deleted_page_at_origin<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        path: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_soft_deleted_page_at_origin(&source_id, &path, &slug)
        })
    }

    /// `listLivePagesAtOrigin(sourceId, sourcePath)`: `[{ id, slug }]` by slug bytes.
    #[napi]
    pub fn list_live_pages_at_origin<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        source_path: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_live_pages_at_origin(&source_id, &source_path)
        })
    }

    /// `countPageCarryRows(sourceId, slug, pageId)`: `{ facts, links, aliases }`.
    #[napi]
    pub fn count_page_carry_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        page_id: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_page_carry_rows(&source_id, &slug, u64::from(page_id))
        })
    }

    /// `listStaleMentionPages(limit)`: the scanned pages with their body text.
    #[napi]
    pub fn list_stale_mention_pages<'env>(
        &self,
        env: &'env Env,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_stale_mention_pages(u64::from(limit)))
    }

    /// `listStaleMentionLinks(limit)`: the `mentions` links of the scanned pages.
    #[napi]
    pub fn list_stale_mention_links<'env>(
        &self,
        env: &'env Env,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_stale_mention_links(u64::from(limit)))
    }

    /// `listOrphanLifetimes(sourceId, limit, deep)`: `{ count, samples: [{ slug, page_lifetime, reason }] }`.
    #[napi]
    pub fn list_orphan_lifetimes<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        limit: u32,
        deep: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_orphan_lifetimes(&source_id, limit, deep)
        })
    }

    /// `listRootPageSlugsAfter(sourceId, take, held, after)`: `[{ slug }]` in byte order.
    #[napi]
    pub fn list_root_page_slugs_after<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        take: u32,
        held: Vec<String>,
        after: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_root_page_slugs_after(&source_id, take as usize, &held, &after)
        })
    }
}
