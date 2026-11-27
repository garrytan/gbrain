//! The retention purge's bookkeeping (src/core/engine-sql/retention-purge.ts): the stale-hold release, the owed-purge listing,
//! the three prunes, the managed purge's failure records, the two candidate reads and the carry's expiring-origin read.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store::persistence` call on the pool through `Brain::run` and
//! resolves plain JSON (src/core/rust-engine/store-members/retention-purge.ts).

use gbrain_store::persistence::PurgeFailureRow;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `releaseStaleOriginParkHolds(op)`: drops the stale owner holds of the parks; resolves null.
    #[napi]
    pub fn release_stale_origin_park_holds<'env>(
        &self,
        env: &'env Env,
        op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.release_stale_origin_park_holds(&op))
    }

    /// `listOwedPurgeRecords(op)`: resolves `[{ owed }]`, the records whose tombstone still exists, by fingerprint.
    #[napi]
    pub fn list_owed_purge_records<'env>(
        &self,
        env: &'env Env,
        op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_owed_purge_records(&op))
    }

    /// `pruneOwedPurgeRecords(op)`: resolves null.
    #[napi]
    pub fn prune_owed_purge_records<'env>(
        &self,
        env: &'env Env,
        op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.prune_owed_purge_records(&op))
    }

    /// `pruneOriginParkRecords(op)`: resolves null.
    #[napi]
    pub fn prune_origin_park_records<'env>(
        &self,
        env: &'env Env,
        op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.prune_origin_park_records(&op))
    }

    /// `prunePurgeParkRecords(op)`: resolves null.
    #[napi]
    pub fn prune_purge_park_records<'env>(
        &self,
        env: &'env Env,
        op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.prune_purge_park_records(&op))
    }

    /// `recordPurgeFailureRecord(row)`: stores or bumps the failure record; resolves null.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn record_purge_failure_record<'env>(
        &self,
        env: &'env Env,
        op: String,
        key: String,
        first: String,
        code: Option<String>,
        reason: String,
        failed_at: String,
        version: String,
    ) -> napi::Result<Object<'env>> {
        let row = PurgeFailureRow {
            op,
            key,
            first,
            code,
            reason,
            failed_at,
            version,
        };
        self.run(env, move |s| s.record_purge_failure_record(&row))
    }

    /// `deletePurgeParkRecord(op, key)`: resolves null.
    #[napi]
    pub fn delete_purge_park_record<'env>(
        &self,
        env: &'env Env,
        op: String,
        key: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_purge_park_record(&op, &key))
    }

    /// `markPurgeParksInactive(op, sourceId)`: resolves null.
    #[napi]
    pub fn mark_purge_parks_inactive<'env>(
        &self,
        env: &'env Env,
        op: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.mark_purge_parks_inactive(&op, &source_id))
    }

    /// `dropRearmedPurgeParks(op, sourceId)`: resolves how many records it removed.
    #[napi]
    pub fn drop_rearmed_purge_parks<'env>(
        &self,
        env: &'env Env,
        op: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.drop_rearmed_purge_parks(&op, &source_id))
    }

    /// `listReleasedPurgeOrigins(release, excludeIds, hours)`: resolves `[{ slug, source_id, deleted_at }]`.
    #[napi]
    pub fn list_released_purge_origins<'env>(
        &self,
        env: &'env Env,
        release: Vec<i64>,
        exclude_ids: Vec<i64>,
        hours: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_released_purge_origins(&release, &exclude_ids, &hours)
        })
    }

    /// `listManagedPurgeCandidates(hours, release, hold)`: resolves `[{ id, source_id, slug, cutoff, deleted_us }]`.
    #[napi]
    pub fn list_managed_purge_candidates<'env>(
        &self,
        env: &'env Env,
        hours: String,
        release: Vec<i64>,
        hold: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_managed_purge_candidates(&hours, &release, &hold)
        })
    }

    /// `listExpiringOriginPages(hours)`: resolves `[{ id, source_id, slug }]`, by id.
    #[napi]
    pub fn list_expiring_origin_pages<'env>(
        &self,
        env: &'env Env,
        hours: String,
        honor_aliases: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_expiring_origin_pages(&hours, honor_aliases)
        })
    }

    /// `listRederiveHeldConceptIds()`: resolves the held concept tombstones' ids, by id.
    #[napi]
    pub fn list_rederive_held_concept_ids<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_rederive_held_concept_ids())
    }

    /// `listExpiredPages(hours)`: resolves `[{ id, source_id, slug }]`, by id.
    #[napi]
    pub fn list_expired_pages<'env>(
        &self,
        env: &'env Env,
        hours: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_expired_pages(&hours))
    }

    /// `listExpiredPageIds(hours)`: resolves the expired tombstones' ids, by id.
    #[napi]
    pub fn list_expired_page_ids<'env>(
        &self,
        env: &'env Env,
        hours: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_expired_page_ids(&hours))
    }

    /// `listOwedExpiredPages(ids, hours)`: resolves `[{ id, source_id, slug }]`, oldest first.
    #[napi]
    pub fn list_owed_expired_pages<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
        hours: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_owed_expired_pages(&ids, &hours))
    }
}
