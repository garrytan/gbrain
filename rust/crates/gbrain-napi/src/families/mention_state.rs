//! The mention pass's statements and the gazetteer, extract snapshot and explain reads
//! (store side: `gbrain_store::mention_state` and `gbrain_store::cli_reads::mention_reads`, docs in
//! `rust/docs/store/mention-state.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use gbrain_store::mention_state::{
    DerivedAliasInput, EntryKeyRow, MentionStatusPatch, PageRevisionInput,
};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listMentionSourceIds`.
    #[napi]
    pub fn list_mention_source_ids<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_mention_source_ids())
    }

    /// `writeMentionIndexStatus`.
    #[napi]
    pub fn write_mention_index_status<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        patch: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let patch: MentionStatusPatch = required(patch, "writeMentionIndexStatus patch")?;
            s.write_mention_index_status(&source_id, &patch)
        })
    }

    /// `listMentionLinkOrigins`.
    #[napi]
    pub fn list_mention_link_origins<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_mention_link_origins(&source_id))
    }

    /// `deleteSourceMentionLinks`.
    #[napi]
    pub fn delete_source_mention_links<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        origins: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_source_mention_links(&source_id, origins.as_deref())
        })
    }

    /// `clearMentionSourceIndex`.
    #[napi]
    pub fn clear_mention_source_index<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.clear_mention_source_index(&source_id))
    }

    /// `listStaleDerivedAliasSlugs`.
    #[napi]
    pub fn list_stale_derived_alias_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        types: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_stale_derived_alias_slugs(&source_id, &types)
        })
    }

    /// `deleteDerivedAliasesForSlugs`.
    #[napi]
    pub fn delete_derived_aliases_for_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_derived_aliases_for_slugs(&source_id, &slugs)
        })
    }

    /// `listAliasDuePages`.
    #[napi]
    pub fn list_alias_due_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        types: Vec<String>,
        after: i64,
        version: i64,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_alias_due_pages(&source_id, &types, after, version, limit)
        })
    }

    /// `listDerivedAliasRows`.
    #[napi]
    pub fn list_derived_alias_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_derived_alias_rows(&source_id, &slugs))
    }

    /// `readMentionPageRevisions`.
    #[napi]
    pub fn read_mention_page_revisions<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_mention_page_revisions(&ids))
    }

    /// `insertDerivedAliasRows`.
    #[napi]
    pub fn insert_derived_alias_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<DerivedAliasInput> = required(rows, "insertDerivedAliasRows rows")?;
            s.insert_derived_alias_rows(&source_id, &rows)
        })
    }

    /// `upsertPageAliasState`.
    #[napi]
    pub fn upsert_page_alias_state<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        pages: Value,
        version: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let pages: Vec<PageRevisionInput> = required(pages, "upsertPageAliasState pages")?;
            s.upsert_page_alias_state(&source_id, &pages, version)
        })
    }

    /// `listMentionCandidatePages`.
    #[napi]
    pub fn list_mention_candidate_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        after: i64,
        limit: i64,
        patterns: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_mention_candidate_pages(&source_ids, after, limit, patterns.as_deref())
        })
    }

    /// `listGazetteerEntryKeys`.
    #[napi]
    pub fn list_gazetteer_entry_keys<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_gazetteer_entry_keys(&source_id))
    }

    /// `listMentionLinkersOfTargets`.
    #[napi]
    pub fn list_mention_linkers_of_targets<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_mention_linkers_of_targets(&source_id, &slugs)
        })
    }

    /// `applyGazetteerEntryChanges`.
    #[napi]
    pub fn apply_gazetteer_entry_changes<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        removed: Value,
        added: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let removed: Vec<EntryKeyRow> =
                required(removed, "applyGazetteerEntryChanges removed")?;
            let added: Vec<EntryKeyRow> = required(added, "applyGazetteerEntryChanges added")?;
            s.apply_gazetteer_entry_changes(&source_id, &removed, &added)
        })
    }

    /// `resetMentionRevisions`.
    #[napi]
    pub fn reset_mention_revisions<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
        page_ids: Option<Vec<i64>>,
        after_page_id: Option<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.reset_mention_revisions(source_ids.as_deref(), page_ids.as_deref(), after_page_id)
        })
    }

    /// `readMentionGenerations`.
    #[napi]
    pub fn read_mention_generations<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_mention_generations(&source_ids))
    }

    /// `listMentionDuePages`.
    #[napi]
    pub fn list_mention_due_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        version: i64,
        after: i64,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_mention_due_pages(&source_id, version, after, limit)
        })
    }

    /// `listPageOutLinks`.
    #[napi]
    pub fn list_page_out_links<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_page_out_links(&ids))
    }

    /// `deleteLinksById`.
    #[napi]
    pub fn delete_links_by_id<'env>(
        &self,
        env: &'env Env,
        ids: Vec<i64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_links_by_id(&ids))
    }

    /// `upsertPageMentionState`.
    #[napi]
    pub fn upsert_page_mention_state<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        pages: Value,
        version: i64,
        generation: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let pages: Vec<PageRevisionInput> = required(pages, "upsertPageMentionState pages")?;
            s.upsert_page_mention_state(&source_id, &pages, version, &generation)
        })
    }

    /// `readMentionStatusStates`.
    #[napi]
    pub fn read_mention_status_states<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_mention_status_states(&source_ids))
    }

    /// `readMentionPolicyFingerprints`.
    #[napi]
    pub fn read_mention_policy_fingerprints<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_mention_policy_fingerprints(&source_ids)
        })
    }

    /// `resetSourceMentionIndexRevisions`.
    #[napi]
    pub fn reset_source_mention_index_revisions<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.reset_source_mention_index_revisions(&source_id)
        })
    }

    /// `listLivePageSourceIds`.
    #[napi]
    pub fn list_live_page_source_ids<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_live_page_source_ids())
    }

    /// `listGazetteerPages`.
    #[napi]
    pub fn list_gazetteer_pages<'env>(
        &self,
        env: &'env Env,
        types: Vec<String>,
        handle_keys: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_gazetteer_pages(&types, &handle_keys))
    }

    /// `listGazetteerAliases`.
    #[napi]
    pub fn list_gazetteer_aliases<'env>(
        &self,
        env: &'env Env,
        types: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_gazetteer_aliases(&types))
    }

    /// `readPageStampTimes`.
    #[napi]
    pub fn read_page_stamp_times<'env>(
        &self,
        env: &'env Env,
        slugs: Vec<String>,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_stamp_times(&slugs, &source_ids))
    }

    /// `readPageRevisionForShare`.
    #[napi]
    pub fn read_page_revision_for_share<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_revision_for_share(&source_id, &slug)
        })
    }

    /// `readExplainPage`.
    #[napi]
    pub fn read_explain_page<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_explain_page(&source_id, &slug))
    }

    /// `readExplainScanPage`.
    #[napi]
    pub fn read_explain_scan_page<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        version: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_explain_scan_page(&source_id, &slug, version)
        })
    }

    /// `countMentionLinksTo`.
    #[napi]
    pub fn count_mention_links_to<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        source_id: String,
        targets: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_mention_links_to(page_id, &source_id, &targets)
        })
    }

    /// `readPageNameText`.
    #[napi]
    pub fn read_page_name_text<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_page_name_text(&source_id, &slug))
    }

    /// `listFrontmatterAliasNorms`.
    #[napi]
    pub fn list_frontmatter_alias_norms<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_frontmatter_alias_norms(&source_id, &slug)
        })
    }

    /// `listRejectedDeclarationPages`.
    #[napi]
    pub fn list_rejected_declaration_pages<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        types: Vec<String>,
        pattern: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_rejected_declaration_pages(&source_id, &types, &pattern)
        })
    }

    /// `readSegmentedPageSealed`.
    #[napi]
    pub fn read_segmented_page_sealed<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_segmented_page_sealed(&source_id, &slug)
        })
    }

    /// `storeSegmentDerivationsIfLive`: rows written.
    #[napi]
    pub fn store_segment_derivations_if_live<'env>(
        &self,
        env: &'env Env,
        page_id: i64,
        generation: i64,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<gbrain_store::page_body::SegmentDerivationInput> =
                required(rows, "storeSegmentDerivationsIfLive rows")?;
            s.store_segment_derivations_if_live(page_id, generation, &rows)
        })
    }
}
