//! The cycle, belief and sync reads that ran raw SQL and are now typed members: the cycle's
//! changed-page window (cycle-window.md) and the belief ledger's orphan lifetimes (trust.md). The propose_takes failure tombstones are
//! `insertTakeProposal` and `listTakeProposalTombstones` (takes/proposals.rs), and the stale-mention
//! scan is `readStaleMentionScan` (list_reads.rs).
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
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
}
