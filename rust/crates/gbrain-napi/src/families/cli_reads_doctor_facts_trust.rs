//! The doctor facts, fence and trust reads served from the store (`gbrain-store` `cli_reads::doctor_facts_trust`,
//! `jobs::checks`). The TypeScript members (`src/core/rust-engine/store-members/doctor-facts-trust.ts`) answer the
//! relations the store keeps no writer for (rust/docs/store/cli-reads-doctor-facts-trust.md) without a call.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `countConversationPipelinePages({ types, slug_patterns })`: resolves the count.
    #[napi]
    pub fn count_conversation_pipeline_pages<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_conversation_pipeline_pages(&required(
                input,
                "countConversationPipelinePages input",
            )?)
        })
    }

    /// `listPersistentWriterContention(reason)`: resolves `[{ source_id, n, oldest }]`.
    #[napi]
    pub fn list_persistent_writer_contention<'env>(
        &self,
        env: &'env Env,
        reason: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_persistent_writer_contention(&reason))
    }
}

#[napi]
impl Brain {
    /// `countRowTrustTiers({ table })`: resolves `[{ tier, n }]`.
    #[napi]
    pub fn count_row_trust_tiers<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_row_trust_tiers(&required(input, "countRowTrustTiers input")?)
        })
    }

    /// `countClaimLiftedRows({ table })`: resolves the count.
    #[napi]
    pub fn count_claim_lifted_rows<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_claim_lifted_rows(&required(input, "countClaimLiftedRows input")?)
        })
    }

    /// `countLegacyUnknownBySource({ ceilings, sourceIds })`: resolves `[{ source_id, n }]`.
    #[napi]
    pub fn count_legacy_unknown_by_source<'env>(
        &self,
        env: &'env Env,
        input: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_legacy_unknown_by_source(&required(input, "countLegacyUnknownBySource input")?)
        })
    }
}
