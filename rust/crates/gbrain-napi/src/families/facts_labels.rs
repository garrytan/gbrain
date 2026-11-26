//! The preview reads of `gbrain repair conversation-labels`: one `#[napi] impl Brain` block over
//! `gbrain_store::facts::label_repair`. The TypeScript members (`store-members/label-repair-reads.ts`) read the label
//! line into literal labels, so the store evaluates no regular expression.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::label_repair::{AuditMarkerArgs, LabelFactArgs};

#[napi]
impl Brain {
    /// `listLabelFactCandidates({ sourceIds, slug, segmentSource, labels, terminalSource, nonExtractableSource })`:
    /// resolves the candidates with their evidence, in (source, page, id) order.
    #[napi]
    pub fn list_label_fact_candidates<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LabelFactArgs = required(args, "listLabelFactCandidates args")?;
            s.list_label_fact_candidates(&a)
        })
    }

    /// `listSegmentedLabelPages({ sourceIds, segmentSource, terminalSource, nonExtractableSource })`: resolves the
    /// undecided segmented pages and their fact counts, in page id order.
    #[napi]
    pub fn list_segmented_label_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LabelFactArgs = required(args, "listSegmentedLabelPages args")?;
            s.list_segmented_label_pages(&a)
        })
    }

    /// `hasActiveAuditMarker({ sourceId, slug, sources })`: resolves whether the page holds an active fact of one of
    /// `sources`.
    #[napi]
    pub fn has_active_audit_marker<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: AuditMarkerArgs = required(args, "hasActiveAuditMarker args")?;
            s.has_active_audit_marker(&a)
        })
    }
}
