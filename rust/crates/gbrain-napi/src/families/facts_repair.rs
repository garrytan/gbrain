//! Group 5 facts members, repair classifiers and loop retirement: one `#[napi] impl Brain` block over `gbrain_store::facts::repair`.
//!
//! Eight members are served, countLabelFacts with the label line the TypeScript member reads into its
//! literal labels, countPurgedPageFacts over the `page_purges` ledger, listUnwithdrawnFacts over the
//! derived generation ledger (`gbrain_store::facts::generations`, both read only) and
//! listExtractorFactsForClassification, which reads the write journal's requests
//! (`gbrain_store::facts::extractor_classify`); the two loop reads live in `facts_loops.rs`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::facts::extractor_classify::ExtractorClassificationQuery;
use gbrain_store::facts::generations::UnwithdrawnArgs;
use gbrain_store::facts::repair::{
    ClassifyArgs, LabelCountArgs, PurgedCandidatesArgs, PurgedCountArgs, TwinArgs, WorldFactArgs,
};
use gbrain_store::facts::repair_home::{HeldHomeArgs, HomeSourceArgs, SnapshotArgs};
use gbrain_store::facts::repair_previews::{DuplicateRowsArgs, SourcesArgs, ValidDayArgs};
use gbrain_store::write_guards::PageByPathArgs;

#[napi]
impl Brain {
    /// `listExtractorFactsForClassification({ sourceIds, slug })`: resolves the expired fenceless
    /// extractor facts with their evidence, in (source, page, id) order.
    #[napi]
    pub fn list_extractor_facts_for_classification<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let q: ExtractorClassificationQuery =
                required(args, "listExtractorFactsForClassification args")?;
            s.list_extractor_facts_for_classification(&q)
        })
    }

    /// `listSessionFactsForClassification({ sourceIds, lanes, ids })`: resolves the fact rows.
    #[napi]
    pub fn list_session_facts_for_classification<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClassifyArgs = required(args, "listSessionFactsForClassification args")?;
            s.list_session_facts_for_classification(&a)
        })
    }

    /// `listSessionFactTwins({ ids, lanes })`: resolves `{ id, owner_twin, twin_sessions }` per fact.
    #[napi]
    pub fn list_session_fact_twins<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: TwinArgs = required(args, "listSessionFactTwins args")?;
            s.list_session_fact_twins(&a)
        })
    }

    /// `listCapturedFactsForClassification({ sourceIds, lanes, ids })`: resolves the fact rows with
    /// their fingerprint and `legit_twin`.
    #[napi]
    pub fn list_captured_facts_for_classification<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClassifyArgs = required(args, "listCapturedFactsForClassification args")?;
            s.list_captured_facts_for_classification(&a)
        })
    }

    /// `listWorldFactsFromPrivateSources({ sourceIds, ids, honorAliases })`: resolves the world facts
    /// held in or extracted from a private page, with `readable`.
    #[napi]
    pub fn list_world_facts_from_private_sources<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: WorldFactArgs = required(args, "listWorldFactsFromPrivateSources args")?;
            s.list_world_facts_from_private_sources(&a)
        })
    }

    /// `countLabelFacts({ sourceIds, limit, segmentSource, contextContains, labels, terminalSource,
    /// nonExtractableSource })`: resolves how many label facts there are, at most `limit`.
    #[napi]
    pub fn count_label_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: LabelCountArgs = required(args, "countLabelFacts args")?;
            s.count_label_facts(&a)
        })
    }

    /// `countPurgedPageFacts({ sourceIds, limit })`: resolves one boolean per counted fact, at most
    /// `limit`: whether a purge record of its page is the evidence.
    #[napi]
    pub fn count_purged_page_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgedCountArgs = required(args, "countPurgedPageFacts args")?;
            s.count_purged_page_facts(&a)
        })
    }

    /// `listUnwithdrawnFacts({ sourceIds, slug, fenceKind })`: resolves the rows of the SQL.
    #[napi]
    pub fn list_unwithdrawn_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: UnwithdrawnArgs = required(args, "listUnwithdrawnFacts args")?;
            s.list_unwithdrawn_facts(&a)
        })
    }

    /// `listClosedConsolidationTies({ sourceIds })`: resolves the facts consolidation closed at their own instant, with their partners.
    #[napi]
    pub fn list_closed_consolidation_ties<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourcesArgs = required(args, "listClosedConsolidationTies args")?;
            s.list_closed_consolidation_ties(&a)
        })
    }

    /// `listPagelessEntityFacts({ sourceIds })`: resolves each entity slug with no live page: its database-only fact ids and its fenced count.
    #[napi]
    pub fn list_pageless_entity_facts<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourcesArgs = required(args, "listPagelessEntityFacts args")?;
            s.list_pageless_entity_facts(&a)
        })
    }

    /// `listOntologyFactCandidates({ sourceIds })`: resolves the ontology rows with the fence step's signature and their flags.
    #[napi]
    pub fn list_ontology_fact_candidates<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SourcesArgs = required(args, "listOntologyFactCandidates args")?;
            s.list_ontology_fact_candidates(&a)
        })
    }

    /// `listDuplicateFactRows({ sourceIds, excludedSources })`: resolves the facts that share a fingerprint with another active fact.
    #[napi]
    pub fn list_duplicate_fact_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: DuplicateRowsArgs = required(args, "listDuplicateFactRows args")?;
            s.list_duplicate_fact_rows(&a)
        })
    }

    /// `listFactsOnValidDay({ sourceId, day })`: resolves the unexpired facts whose `valid_from` falls on the UTC day.
    #[napi]
    pub fn list_facts_on_valid_day<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ValidDayArgs = required(args, "listFactsOnValidDay args")?;
            s.list_facts_on_valid_day(&a)
        })
    }

    /// `readLivePageByPath({ sourceId, path })`: resolves `{ id, slug }` of the live page that records the path, or null.
    #[napi]
    pub fn read_live_page_by_path<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PageByPathArgs = required(args, "readLivePageByPath args")?;
            s.read_live_page_by_path(&a)
        })
    }

    /// `listPurgedPageFactCandidates({ sourceIds, ids })`: resolves the gone-page facts with their exclusion flags and purge evidence.
    #[napi]
    pub fn list_purged_page_fact_candidates<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: PurgedCandidatesArgs = required(args, "listPurgedPageFactCandidates args")?;
            s.list_purged_page_fact_candidates(&a)
        })
    }

    /// `listFactsHomeCandidates({ sourceId })`: resolves the active facts with no fence position, with whether the entity has a live and a deleted page.
    #[napi]
    pub fn list_facts_home_candidates<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HomeSourceArgs = required(args, "listFactsHomeCandidates args")?;
            s.list_facts_home_candidates(&a)
        })
    }

    /// `listHeldHomeRows({ sourceId, days })`: resolves the fence rows held on a holding page that name an entity.
    #[napi]
    pub fn list_held_home_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HeldHomeArgs = required(args, "listHeldHomeRows args")?;
            s.list_held_home_rows(&a)
        })
    }

    /// `listOrphanedFenceRows({ sourceId })`: resolves `{ id, slug }` of each active fence row whose page is not live.
    #[napi]
    pub fn list_orphaned_fence_rows<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: HomeSourceArgs = required(args, "listOrphanedFenceRows args")?;
            s.list_orphaned_fence_rows(&a)
        })
    }

    /// `readFactSnapshots({ sourceId, ids })`: resolves `{ id, value }` of each named fact, the value as the SQL's `jsonb_build_object`.
    #[napi]
    pub fn read_fact_snapshots<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: SnapshotArgs = required(args, "readFactSnapshots args")?;
            s.read_fact_snapshots(&a)
        })
    }
}
