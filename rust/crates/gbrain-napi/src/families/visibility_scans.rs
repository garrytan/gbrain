//! The preview reads of `gbrain repair visibility`: one `#[napi] impl Brain` block over
//! `gbrain_store::facts::visibility_scans` (src/core/engine-sql/visibility-scans.ts and facts-repair.ts).
//!
//! Each method decodes `{ sourceIds, ids?, slugs? }`, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON rows (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::open_facts_scans::OpenFactsArgs;
use gbrain_store::facts::private_label_scans::{ClearDependentsArgs, LabelScanArgs};
use gbrain_store::facts::visibility_scans::{OpenTwinArgs, VisibilityScanArgs};

#[napi]
impl Brain {
    /// `listOpenFactsWindow({ sourceId, createdBefore, ids, after, upper, classes, limit })`: the eligible facts of the window.
    #[napi]
    pub fn list_open_facts_window<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: OpenFactsArgs = required(args, "listOpenFactsWindow args")?;
            s.list_open_facts_window(&a)
        })
    }

    /// `countOpenFactReasons({ sourceId, createdBefore, ids })`: `[{ cls, reason, n }]`.
    #[napi]
    pub fn count_open_fact_reasons<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: OpenFactsArgs = required(args, "countOpenFactReasons args")?;
            s.count_open_fact_reasons(&a)
        })
    }

    /// `listLabelledPages({ sourceIds, after, ids })`: the pages a label makes private.
    #[napi]
    pub fn list_labelled_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LabelScanArgs = required(args, "listLabelledPages args")?;
            s.list_labelled_pages(&a)
        })
    }

    /// `listLiveLabelRows({ ids })`: the live rows of the named pages.
    #[napi]
    pub fn list_live_label_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LabelScanArgs = required(args, "listLiveLabelRows args")?;
            s.list_live_label_rows(&a)
        })
    }

    /// `listContextualRetrievalModes({ ids })`: `[{ id, mode }]`.
    #[napi]
    pub fn list_contextual_retrieval_modes<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LabelScanArgs = required(args, "listContextualRetrievalModes args")?;
            s.list_contextual_retrieval_modes(&a)
        })
    }

    /// `listUnembeddedChunkPages({ ids })`: the page ids.
    #[napi]
    pub fn list_unembedded_chunk_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LabelScanArgs = required(args, "listUnembeddedChunkPages args")?;
            s.list_unembedded_chunk_pages(&a)
        })
    }

    /// `listClearDependents({ ids, sourceIds, slugs, keys, honorAliases })`: `[{ id, cleared_id, category }]`.
    #[napi]
    pub fn list_clear_dependents<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClearDependentsArgs = required(args, "listClearDependents args")?;
            s.list_clear_dependents(&a)
        })
    }

    /// `listOpenTwinRows({ pages, outside, honorAliases })`: `[{ source_id, slug, twin_of, n }]`.
    #[napi]
    pub fn list_open_twin_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: OpenTwinArgs = required(args, "listOpenTwinRows args")?;
            s.list_open_twin_rows(&a)
        })
    }

    /// `listAtomLineageRows({ sourceIds, ids })`: the live atoms with their origin.
    #[napi]
    pub fn list_atom_lineage_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: VisibilityScanArgs = required(args, "listAtomLineageRows args")?;
            s.list_atom_lineage_rows(&a)
        })
    }

    /// `listChronicleEventVisibilityRows({ sourceIds, ids })`: the Life Chronicle events with their origin.
    #[napi]
    pub fn list_chronicle_event_visibility_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: VisibilityScanArgs = required(args, "listChronicleEventVisibilityRows args")?;
            s.list_chronicle_event_visibility_rows(&a)
        })
    }

    /// `listAliasOnlyPrivatePages({ sourceIds, ids })`: the pages a privacy alias alone makes private.
    #[napi]
    pub fn list_alias_only_private_pages<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: VisibilityScanArgs = required(args, "listAliasOnlyPrivatePages args")?;
            s.list_alias_only_private_pages(&a)
        })
    }

    /// `listConceptLineageRows({ sourceIds, ids })`: the live synthesized concepts.
    #[napi]
    pub fn list_concept_lineage_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: VisibilityScanArgs = required(args, "listConceptLineageRows args")?;
            s.list_concept_lineage_rows(&a)
        })
    }

    /// `listConceptInputRows({ ids })`: `[{ concept_id, atom_id, linked }]`.
    #[napi]
    pub fn list_concept_input_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: VisibilityScanArgs = required(args, "listConceptInputRows args")?;
            s.list_concept_input_rows(&a)
        })
    }

    /// `listNamedVisibilityRows({ sourceIds, slugs })`: the named live pages with their visibility and guard.
    #[napi]
    pub fn list_named_visibility_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: VisibilityScanArgs = required(args, "listNamedVisibilityRows args")?;
            s.list_named_visibility_rows(&a)
        })
    }
}
