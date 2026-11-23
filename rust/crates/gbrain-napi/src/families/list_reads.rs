//! The page-list, slug-source, access and connector-status reads that ran as raw SQL in their
//! callers (rust/docs/store/list-reads.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use serde_json::Value;

use crate::store_binding::{Brain, arg, required};

#[napi]
impl Brain {
    /// `readRetainedSources(sourceIds)`: the listed source ids whose worktree holds a recovery
    /// record, by id.
    #[napi]
    pub fn read_retained_sources<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_retained_sources(&source_ids))
    }

    /// `listLiveSlugSourceIds(slug)`: the sources holding a live page at `slug`, by id.
    #[napi]
    pub fn list_live_slug_source_ids<'env>(
        &self,
        env: &'env Env,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_live_slug_source_ids(&slug))
    }

    /// `resolveChainAnchorRows(slug, scope)`: `[{ id, source_id }]` of the live copies the read scope
    /// admits, by source.
    #[napi]
    pub fn resolve_chain_anchor_rows<'env>(
        &self,
        env: &'env Env,
        slug: String,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.resolve_chain_anchor_rows(&slug, &arg(scope, "scope")?)
        })
    }

    /// `probeTargetRows(slug, scope, chunkManifest)`: `[{ source_id, chunks, embedded, current,
    /// chunker_version }]` by source.
    #[napi]
    pub fn probe_target_rows<'env>(
        &self,
        env: &'env Env,
        slug: String,
        scope: Option<Value>,
        chunk_manifest: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.probe_target_rows(&slug, &arg(scope, "scope")?, chunk_manifest)
        })
    }

    /// `readCompanyBrainEvidenceRows(sourceId)`: `{ owner, decision, page }`, each a row or `null`.
    #[napi]
    pub fn read_company_brain_evidence_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_company_brain_evidence_rows(&source_id))
    }

    /// `listCardRows(query)`: `{ total, cards }` of the storage shelf.
    #[napi]
    pub fn list_card_rows<'env>(&self, env: &'env Env, query: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_card_rows(&required(query, "query")?))
    }

    /// `readShelfPageRows(sourceId)`: `[{ slug, title, type, frontmatter }]` by slug.
    #[napi]
    pub fn read_shelf_page_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_shelf_page_rows(&source_id))
    }

    /// `readFirstLiveSlugAtPath(path)`: the slug, or `null`.
    #[napi]
    pub fn read_first_live_slug_at_path<'env>(
        &self,
        env: &'env Env,
        path: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_first_live_slug_at_path(&path))
    }

    /// `listPathTwinSlugs(sourceId, paths)`: `[{ source_path, slugs }]`.
    #[napi]
    pub fn list_path_twin_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        paths: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_path_twin_slugs(&source_id, &paths))
    }

    /// `listLiveSlugOrigins(slugs, sourceId)`: `[{ slug, source_path }]` by (source, slug).
    #[napi]
    pub fn list_live_slug_origins<'env>(
        &self,
        env: &'env Env,
        slugs: Vec<String>,
        source_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_live_slug_origins(&slugs, source_id.as_deref())
        })
    }

    /// `probeRetypeRows(query)`: `{ count, sample }`.
    #[napi]
    pub fn probe_retype_rows<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.probe_retype_rows(&required(query, "query")?)
        })
    }

    /// `listAliasCandidatePages(type, sourceId, limit)`: `[{ slug, compiled_truth, frontmatter }]`.
    #[napi]
    pub fn list_alias_candidate_pages<'env>(
        &self,
        env: &'env Env,
        page_type: String,
        source_id: String,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_alias_candidate_pages(&page_type, &source_id, limit)
        })
    }

    /// `listLinkCandidatePages(type, sourceId, limit)`: `[{ slug, compiled_truth, frontmatter }]`.
    #[napi]
    pub fn list_link_candidate_pages<'env>(
        &self,
        env: &'env Env,
        page_type: String,
        source_id: Option<String>,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_link_candidate_pages(&page_type, source_id.as_deref(), limit)
        })
    }

    /// `countLivePagesByType(scope)`: `[{ type, n }]`.
    #[napi]
    pub fn count_live_pages_by_type<'env>(
        &self,
        env: &'env Env,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_live_pages_by_type(&arg(scope, "scope")?)
        })
    }

    /// `listTypeOrphanRows(scope, undeclared, limit)`: `[{ slug, source_id, type }]`.
    #[napi]
    pub fn list_type_orphan_rows<'env>(
        &self,
        env: &'env Env,
        scope: Option<Value>,
        undeclared: Vec<String>,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_type_orphan_rows(&arg(scope, "scope")?, &undeclared, limit)
        })
    }

    /// `readStaleMentionScan(limit)`: `{ pages, links }`.
    #[napi]
    pub fn read_stale_mention_scan<'env>(
        &self,
        env: &'env Env,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_stale_mention_scan(limit))
    }

    /// `readClockMillisText()`: the store clock in whole milliseconds, as text.
    #[napi]
    pub fn read_clock_millis_text<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_clock_millis_text())
    }

    /// `listLiveSourceIncarnations(ids)`: `[{ id, incarnation }]`.
    #[napi]
    pub fn list_live_source_incarnations<'env>(
        &self,
        env: &'env Env,
        ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_live_source_incarnations(&ids))
    }

    /// `readAttendanceWindow(sourceId, afterSlug, limit)`: `[{ id, slug, source_id, type, revision, deleted }]`.
    #[napi]
    pub fn read_attendance_window<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        after_slug: String,
        limit: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_attendance_window(&source_id, &after_slug, limit)
        })
    }

    /// `listEmailAliasPages(aliasNorm, sourceId)`: `[{ slug, source_id }]`, at most two.
    #[napi]
    pub fn list_email_alias_pages<'env>(
        &self,
        env: &'env Env,
        alias_norm: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_email_alias_pages(&alias_norm, &source_id)
        })
    }

    /// `readChatCensusRows(query)`: `[{ source_id, chat_pages, channels }]` by source.
    #[napi]
    pub fn read_chat_census_rows<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_chat_census_rows(&required(query, "query")?)
        })
    }

    /// `readWhoCanReadRows(slug, sourceId, form)`: `[{ slug, source_id, type, frontmatter, folder_rule_ids, owner_only }]`.
    #[napi]
    pub fn read_who_can_read_rows<'env>(
        &self,
        env: &'env Env,
        slug: String,
        source_id: Option<String>,
        form: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let form = required(Value::String(form), "form")?;
            s.read_who_can_read_rows(&slug, source_id.as_deref(), form)
        })
    }

    /// `readPageAccessAllowed(sourceId, slug, identity, policy)`: a boolean.
    #[napi]
    pub fn read_page_access_allowed<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        identity: Vec<String>,
        policy: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_access_allowed(&source_id, &slug, &identity, &required(policy, "policy")?)
        })
    }

    /// `readPageFolderRulesAllowed(sourceId, slug, satisfied, policy)`: a boolean.
    #[napi]
    pub fn read_page_folder_rules_allowed<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        satisfied: Vec<String>,
        policy: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_folder_rules_allowed(
                &source_id,
                &slug,
                &satisfied,
                &required(policy, "policy")?,
            )
        })
    }

    /// `countLineageClosingRules(ruleIds, sourceId)`: a count.
    #[napi]
    pub fn count_lineage_closing_rules<'env>(
        &self,
        env: &'env Env,
        rule_ids: Vec<String>,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_lineage_closing_rules(&rule_ids, &source_id)
        })
    }

    /// `readForecastPredictions(query)`: the journal's predictions by (source, slug, row).
    #[napi]
    pub fn read_forecast_predictions<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_forecast_predictions(&required(query, "query")?)
        })
    }

    /// `readPredictionLedgerEvents(sourceIds, slugs)`: `[{ source_id, slug, event_type, subject_key, at }]` by id.
    #[napi]
    pub fn read_prediction_ledger_events<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        slugs: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_prediction_ledger_events(&source_ids, &slugs)
        })
    }

    /// `readBeliefCoverageEvents(sourceId)`: the coverage events of the current incarnation by id.
    #[napi]
    pub fn read_belief_coverage_events<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_belief_coverage_events(&source_id))
    }

    /// `findCardRows(query)`: the ranked shelf cards, at most 500.
    #[napi]
    pub fn find_card_rows<'env>(&self, env: &'env Env, query: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.find_card_rows(&required(query, "query")?))
    }
}
