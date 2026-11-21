//! The belief side of a purge: the source purge epoch, the ledger presence probe, the purge
//! receipt's ledger read, the purge's
//! suppression writes, the restore replay's tombstones and the purge receipt's tombstone count.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON (src/core/rust-engine/store-members/belief-purge.ts).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::PagePurgeUpsert;
use gbrain_store::trust::belief_purge::{PurgeRedactionInsert, PurgeRedactionRelease};

#[napi]
impl Brain {
    /// `bumpSourcePurgeEpoch(sourceId)`: resolves the new epoch, or null for an unknown source.
    #[napi]
    pub fn bump_source_purge_epoch<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.bump_source_purge_epoch(&source_id))
    }

    /// `hasBeliefEvents(sourceId)`: resolves whether the source has any belief event.
    #[napi]
    pub fn has_belief_events<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_belief_events(&source_id))
    }

    /// `listBeliefEventsForPurgeProbe(sourceId, after)`: resolves the next 1000 events of the
    /// source after id `after` that have a recorded value, in id order.
    #[napi]
    pub fn list_belief_events_for_purge_probe<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        after: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_belief_events_for_purge_probe(&source_id, after)
        })
    }

    /// `registerPurgeRedaction(row)`: records the suppression unless it exists; resolves null.
    #[napi]
    pub fn register_purge_redaction<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeRedactionInsert = required(row, "registerPurgeRedaction row")?;
            s.register_purge_redaction(&a)
        })
    }

    /// `releasePurgeRedactionsForField(row)`: resolves the purge request of each released row.
    #[napi]
    pub fn release_purge_redactions_for_field<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgeRedactionRelease = required(row, "releasePurgeRedactionsForField row")?;
            s.release_purge_redactions_for_field(&a)
        })
    }

    /// `countPagePurgeTombstones(sourceId, slug)`: resolves how many tombstones name the slug.
    #[napi]
    pub fn count_page_purge_tombstones<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_page_purge_tombstones(&source_id, &slug)
        })
    }

    /// `replayPagePurges(row)`: stores the replay's page purge tombstones; resolves null.
    #[napi]
    pub fn replay_page_purges<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PagePurgeUpsert = required(row, "replayPagePurges row")?;
            s.replay_page_purges(&a)
        })
    }
}
