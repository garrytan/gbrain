//! The belief-ledger half of a purge: the derived rows' streams, the preimage check, the
//! purged-key and carrying-field redactions, the live and version carriers, the page purge's
//! lifetimes and claim inventory, and the derived-hidden keys.
//!
//! One `#[napi] impl Brain` block; each method runs one `gbrain_store` call on the pool through
//! `Brain::run` and resolves plain JSON (src/core/rust-engine/store-members/belief-purge-ledger.ts).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::trust::belief_purge_ledger::{
    BeliefEventRewrite, BeliefPriorRechain, CarrierVersionQuery, DerivedStreamQuery, PreimageQuery,
    RedactPurgedKeys,
};

#[napi]
impl Brain {
    /// `listDerivedStreamSlugs({ sourceId, factIds, takeIds, pageIds })`: resolves `{ ref, slug }` rows.
    #[napi]
    pub fn list_derived_stream_slugs<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: DerivedStreamQuery = required(args, "listDerivedStreamSlugs args")?;
            s.list_derived_stream_slugs(&q)
        })
    }

    /// `listMissingPreimages({ pageIds, revisions })`: resolves the 1-based positions without a version.
    #[napi]
    pub fn list_missing_preimages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: PreimageQuery = required(args, "listMissingPreimages args")?;
            s.list_missing_preimages(&q)
        })
    }

    /// `redactPurgedBeliefKeys({ sourceId, claimFps, lifetimes, legacyClaims })`: resolves the count marked.
    #[napi]
    pub fn redact_purged_belief_keys<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: RedactPurgedKeys = required(args, "redactPurgedBeliefKeys args")?;
            s.redact_purged_belief_keys(&q)
        })
    }

    /// `listBeliefCarrierEvents(sourceId, after)`: resolves the next carrier events.
    #[napi]
    pub fn list_belief_carrier_events<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        after: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_belief_carrier_events(&source_id, after)
        })
    }

    /// `readBeliefEventValue(sourceId, id)`: resolves the event's value, value hash and redacted fields, or null.
    #[napi]
    pub fn read_belief_event_value<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_belief_event_value(&source_id, id))
    }

    /// `rewriteBeliefEventFields({ sourceId, id, value, valueHash, redactedFields })`: resolves null.
    #[napi]
    pub fn rewrite_belief_event_fields<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: BeliefEventRewrite = required(args, "rewriteBeliefEventFields args")?;
            s.rewrite_belief_event_fields(&q)
        })
    }

    /// `rechainBeliefPriorHash({ sourceId, subjectKey, oldHash, newHash, afterId })`: resolves null.
    #[napi]
    pub fn rechain_belief_prior_hash<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: BeliefPriorRechain = required(args, "rechainBeliefPriorHash args")?;
            s.rechain_belief_prior_hash(&q)
        })
    }

    /// `listBeliefQuotingRows(kind, sourceId, after)`: resolves `{ id, slug, text }` rows.
    #[napi]
    pub fn list_belief_quoting_rows<'env>(
        &self,
        env: &'env Env,
        kind: String,
        source_id: String,
        after: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_belief_quoting_rows(&kind, &source_id, after)
        })
    }

    /// `listPageBeliefLifetimes(sourceId, slug, pageId)`: resolves the page's lifetimes.
    #[napi]
    pub fn list_page_belief_lifetimes<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_page_belief_lifetimes(&source_id, &slug, page_id)
        })
    }

    /// `listPagePurgeLiveClaims(sourceId, slug, pageId)`: resolves `{ claim, fp }` rows.
    #[napi]
    pub fn list_page_purge_live_claims<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        page_id: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_page_purge_live_claims(&source_id, &slug, page_id)
        })
    }

    /// `listPageVersionFenceBodies(pageId, after)`: resolves `{ id, compiled_truth, timeline }` rows.
    #[napi]
    pub fn list_page_version_fence_bodies<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        after: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_page_version_fence_bodies(page_id, after)
        })
    }

    /// `listLifetimeClaimEvents(sourceId, lifetimes, after)`: resolves `{ id, claim, claim_fp }` rows.
    #[napi]
    pub fn list_lifetime_claim_events<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        lifetimes: Vec<String>,
        after: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_lifetime_claim_events(&source_id, &lifetimes, after)
        })
    }

    /// `listPurgeCarrierVersions({ sourceId, versionIds, visibility })`: resolves the versions' rows.
    #[napi]
    pub fn list_purge_carrier_versions<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: CarrierVersionQuery = required(args, "listPurgeCarrierVersions args")?;
            s.list_purge_carrier_versions(&q)
        })
    }

    /// `listKnownBeliefSubjectKeys(sourceId, keys)`: resolves the keys with an event in the source.
    #[napi]
    pub fn list_known_belief_subject_keys<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        keys: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_known_belief_subject_keys(&source_id, &keys)
        })
    }
}
