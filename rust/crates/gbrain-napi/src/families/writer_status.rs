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
}
