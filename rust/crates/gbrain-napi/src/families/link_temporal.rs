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

    /// `countSearchVectorRows`: `{ pages, chunks }`.
    #[napi]
    pub fn count_search_vector_rows<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_search_vector_rows())
    }
}
