//! Link temporal state: the store methods of src/core/engine-sql/link-temporal.ts
//! (rust/docs/store/link_temporal.md). Each takes one JSON input and resolves plain JSON.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};

#[napi]
impl Brain {
    /// `readLinkRelationshipEvidence`: `{ keys, originPolicy }`: `{ assertions, transitions, existing }`.
    #[napi]
    pub fn read_link_relationship_evidence<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::EvidenceInput =
                arg(input, "readLinkRelationshipEvidence input")?;
            s.read_link_relationship_evidence(&input)
        })
    }

    /// `writeLinkRelationshipState`: `{ upserts, removals, changed }`: the rows written or removed.
    #[napi]
    pub fn write_link_relationship_state<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::StateWrite =
                arg(input, "writeLinkRelationshipState input")?;
            s.write_link_relationship_state(&input)
        })
    }

    /// `linkRelationshipKeysForPages`: `{ pageIds, linkTypes }`: relationship keys.
    #[napi]
    pub fn link_relationship_keys_for_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::KeysForPagesInput =
                arg(input, "linkRelationshipKeysForPages input")?;
            s.link_relationship_keys_for_pages(&input)
        })
    }

    /// `staleLinkRelationshipKeys`: `{ limit, linkTypes }`: relationship keys, oldest first.
    #[napi]
    pub fn stale_link_relationship_keys<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::StaleKeysInput =
                arg(input, "staleLinkRelationshipKeys input")?;
            s.stale_link_relationship_keys(&input)
        })
    }

    /// `linkRelationshipKeysForOrigin`: `{ pageId, linkTypes }`: relationship keys.
    #[napi]
    pub fn link_relationship_keys_for_origin<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::KeysForOriginInput =
                arg(input, "linkRelationshipKeysForOrigin input")?;
            s.link_relationship_keys_for_origin(&input)
        })
    }

    /// `linkRelationshipKeysTouching`: `{ pairs, fromPages, linkTypes }`: relationship keys.
    #[napi]
    pub fn link_relationship_keys_touching<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::KeysTouchingInput =
                arg(input, "linkRelationshipKeysTouching input")?;
            s.link_relationship_keys_touching(&input)
        })
    }

    /// `applyLinkTemporalRows`: one origin page's evidence: `{ inserted, liveTargets, keysAfter }`.
    #[napi]
    pub fn apply_link_temporal_rows<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ApplyTemporalInput =
                arg(input, "applyLinkTemporalRows input")?;
            s.apply_link_temporal_rows(&input)
        })
    }

    /// `writeManualLinkTransitions`: `{ rel, rows }`: `{ inserted, key }`.
    #[napi]
    pub fn write_manual_link_transitions<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ManualWriteInput =
                arg(input, "writeManualLinkTransitions input")?;
            s.write_manual_link_transitions(&input)
        })
    }

    /// `removeManualLinkTransitions`: `{ from, to, linkType?, sourceId, databaseOnly? }`: one key per row removed.
    #[napi]
    pub fn remove_manual_link_transitions<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ManualRelationship =
                arg(input, "removeManualLinkTransitions input")?;
            s.remove_manual_link_transitions(&input)
        })
    }

    /// `listRelationshipNoteRows`: `{ subjects, excludePrivate }`: note rows.
    #[napi]
    pub fn list_relationship_note_rows<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::NoteRowsInput =
                arg(input, "listRelationshipNoteRows input")?;
            s.list_relationship_note_rows(&input)
        })
    }

    /// `edgeValidityCounts`: `{ sourceIds, staleLimit }`: `{ byStatus, stale, proposals }`.
    #[napi]
    pub fn edge_validity_counts<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::EdgeValidityInput =
                arg(input, "edgeValidityCounts input")?;
            s.edge_validity_counts(&input)
        })
    }

    /// `listPageStatusByRef`: `{ refs, excludePrivate, includeQuarantined }`: status rows.
    #[napi]
    pub fn list_page_status_by_ref<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::PageStatusInput =
                arg(input, "listPageStatusByRef input")?;
            s.list_page_status_by_ref(&input)
        })
    }

    /// `listRecordMetadataRows`: `{ pageIds, referrerSources, excludePrivate, includeQuarantined, scope }`: `{ status, links }`.
    #[napi]
    pub fn list_record_metadata_rows<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::RecordMetadataInput =
                arg(input, "listRecordMetadataRows input")?;
            s.list_record_metadata_rows(&input)
        })
    }

    /// `readReferrerGroupRows`: `{ targetSources, targetSlugs, referrerSources, storedTypes, canonicalTypes,
    /// excludePrivate, minTrust, suppressFlagged, includeQuarantined, perGroup }`: referrer rows.
    #[napi]
    pub fn read_referrer_group_rows<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ReferrerGroupInput =
                arg(input, "readReferrerGroupRows input")?;
            s.read_referrer_group_rows(&input)
        })
    }

    /// `readPageReferenceDate`: the live page's reference date as UTC microsecond text, or null.
    #[napi]
    pub fn read_page_reference_date<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_reference_date(&source_id, &slug))
    }

    /// `readReferrerPageDetails`: `{ ids }`: the card details of each page id that exists.
    #[napi]
    pub fn read_referrer_page_details<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ReferrerPageDetailsInput =
                arg(input, "readReferrerPageDetails input")?;
            s.read_referrer_page_details(&input)
        })
    }

    /// `readReferrerTargetCounts`: `{ targetSources, targetSlugs, targetIndexes, referrerSources, storedTypes,
    /// canonicalTypes, recordTypes, excludePrivate, minTrust, suppressFlagged, includeQuarantined }`: count rows.
    #[napi]
    pub fn read_referrer_target_counts<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ReferrerTargetCountInput =
                arg(input, "readReferrerTargetCounts input")?;
            s.read_referrer_target_counts(&input)
        })
    }

    /// `listReferrerTargetSources`: `{ slug, sources }`: the sources holding a live page with the slug.
    #[napi]
    pub fn list_referrer_target_sources<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ReferrerTargetSourcesInput =
                arg(input, "listReferrerTargetSources input")?;
            s.list_referrer_target_sources(&input)
        })
    }

    /// `countReferrerRows`: `{ targetSources, targetSlugs, referrerSources, storedTypes, canonicalTypes,
    /// excludePrivate, type, minTrust, suppressFlagged, includeQuarantined }`: the referrer total.
    #[napi]
    pub fn count_referrer_rows<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ReferrerRowInput =
                arg(input, "countReferrerRows input")?;
            s.count_referrer_rows(&input)
        })
    }

    /// `readReferrerRows`: `countReferrerRows`'s input plus `{ cursor, limit }`: one referrer page.
    #[napi]
    pub fn read_referrer_rows<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ReferrerRowInput =
                arg(input, "readReferrerRows input")?;
            s.read_referrer_rows(&input)
        })
    }

    /// `readReferrerTypes`: `countReferrerRows`'s input (`type` ignored): the distinct
    /// `{ canonical_type, type }` pairs of the referrers.
    #[napi]
    pub fn read_referrer_types<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ReferrerRowInput =
                arg(input, "readReferrerTypes input")?;
            s.read_referrer_types(&input)
        })
    }

    /// `readReferrerRecordCandidates`: `readReferrerTargetCounts`'s input plus `{ perTarget }`: the record candidates.
    #[napi]
    pub fn read_referrer_record_candidates<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ReferrerRecordCandidateInput =
                arg(input, "readReferrerRecordCandidates input")?;
            s.read_referrer_record_candidates(&input)
        })
    }

    /// `readReferrerRecordPages`: `{ ids }`: the title and date source of each page id that exists.
    #[napi]
    pub fn read_referrer_record_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::ReferrerPageDetailsInput =
                arg(input, "readReferrerRecordPages input")?;
            s.read_referrer_record_pages(&input)
        })
    }

    /// `countSearchVectorRows`: `{ pages, chunks }`.
    #[napi]
    pub fn count_search_vector_rows<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_search_vector_rows())
    }

    /// `countPendingProjectionPages`: `{ scope, relevance }`: `{ total, could_affect, capped,
    /// top_counted?, could_affect_images }`.
    #[napi]
    pub fn count_pending_projection_pages<'env>(
        &self,
        env: &'env Env,
        input: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: gbrain_store::link_queries::PendingCountInput =
                arg(input, "countPendingProjectionPages input")?;
            s.count_pending_projection_pages(&input)
        })
    }

    /// `projectionRebuildProgress`: a coverage scope: `{ done, total, pages_per_second }` or null.
    #[napi]
    pub fn projection_rebuild_progress<'env>(
        &self,
        env: &'env Env,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::link_queries::CoverageScope =
                arg(scope, "projectionRebuildProgress scope")?;
            s.projection_rebuild_progress(&scope)
        })
    }

    /// `readProjectionReadinessGeneration`: the generation the probe's cached answer depends on, or null
    /// inside a transaction.
    #[napi]
    pub fn read_projection_readiness_generation<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.projection_readiness_generation())
    }

    /// `readHealthMemoClock`: the brain and its commit sequence.
    #[napi]
    pub fn read_health_memo_clock<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.health_memo_clock())
    }

    /// `readProjectionReadiness`: a coverage scope: `{ pending, by_design }`.
    #[napi]
    pub fn read_projection_readiness<'env>(
        &self,
        env: &'env Env,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::link_queries::CoverageScope =
                arg(scope, "readProjectionReadiness scope")?;
            s.read_projection_readiness(&scope)
        })
    }
}
