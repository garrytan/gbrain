//! Writer status: the reads of `gbrain sources writer status` (rust/docs/store/persistence.md,
//! "Writer status").
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readWriterDiagnosticRows(abandonedCutoff, excludedOrigins)`.
    #[napi]
    pub fn writer_diagnostic_rows<'env>(
        &self,
        env: &'env Env,
        abandoned_cutoff: Option<String>,
        excluded_origins: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.writer_diagnostic_rows(abandoned_cutoff.as_deref(), &excluded_origins)
        })
    }

    /// `readWriterStatusRows(hostId, sourceId)`.
    #[napi]
    pub fn writer_status_rows<'env>(
        &self,
        env: &'env Env,
        host_id: Option<String>,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.writer_status_rows(host_id.as_deref(), source_id.as_deref())
        })
    }

    /// `listOnboardingSources(sourceId)`.
    #[napi]
    pub fn onboarding_sources<'env>(
        &self,
        env: &'env Env,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.onboarding_sources(source_id.as_deref()))
    }

    /// `listBlockingEffectRows(sourceId, limit, recoveringOnly)`.
    #[napi]
    pub fn blocking_effect_rows<'env>(
        &self,
        env: &'env Env,
        source_id: Option<String>,
        limit: u32,
        recovering_only: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.blocking_effect_rows(source_id.as_deref(), limit as usize, recovering_only)
        })
    }

    /// `listStalledCatchupRows(sourceIds, stallMs)`.
    #[napi]
    pub fn stalled_catchup_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
        stall_ms: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.stalled_catchup_rows(source_ids.as_deref(), stall_ms)
        })
    }

    /// `listParkedGroupRows(sourceIds)`.
    #[napi]
    pub fn parked_group_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.parked_group_rows(source_ids.as_deref()))
    }

    /// `listSourceBindingsForMovement(sourceIds)`.
    #[napi]
    pub fn movement_binding_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.movement_binding_rows(source_ids.as_deref()))
    }

    /// `readSourceMovementRows(binding)`: `{ watermark, head, hold }`.
    #[napi]
    pub fn source_movement_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        worktree_id: String,
        source_incarnation: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.source_movement_rows(&source_id, &worktree_id, &source_incarnation)
        })
    }

    /// `readLiveSyncJobId(sourceId)`: the job id, or null.
    #[napi]
    pub fn live_sync_job_id<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.live_sync_job_id(&source_id))
    }

    /// `countParkedEffects(sourceIds)`.
    #[napi]
    pub fn parked_effect_count<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.parked_effect_count(source_ids.as_deref()))
    }

    /// `listParkedEffects(sourceIds)`.
    #[napi]
    pub fn parked_effect_rows<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.parked_effect_rows(source_ids.as_deref()))
    }

    /// `listGitPushHoldRows(codes, sourceIds)`.
    #[napi]
    pub fn git_push_hold_rows<'env>(
        &self,
        env: &'env Env,
        codes: Vec<String>,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.git_push_hold_rows(&codes, source_ids.as_deref())
        })
    }
}
