//! Doctor search-and-knowledge reads: the typed members that replace the raw SQL of the `gbrain doctor` checks
//! dangling_aliases, type_proliferation, person_title_duplicates, markdown_body_completeness,
//! link_resolution_opportunity, hidden_by_search_policy, image_embedding_coverage, text_projection_readiness and
//! extract_atoms_backlog (store side: `gbrain_store::cli_reads::doctor_search`, docs in
//! `rust/docs/store/cli-reads-doctor-search.md`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use serde_json::Value;

use crate::store_binding::{Brain, arg};

#[napi]
impl Brain {
    /// `listOrphanedAliasCounts`.
    #[napi]
    pub fn list_orphaned_alias_counts<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_orphaned_alias_counts())
    }

    /// `readSoftDeletedAliasCounts`.
    #[napi]
    pub fn read_soft_deleted_alias_counts<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_soft_deleted_alias_counts())
    }

    /// `listPageTypePairs`.
    #[napi]
    pub fn list_page_type_pairs<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_page_type_pairs())
    }

    /// `listTruncatedMarkdownBodies`.
    #[napi]
    pub fn list_truncated_markdown_bodies<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_truncated_markdown_bodies())
    }

    /// `countSegmentedMarkdownBodies`.
    #[napi]
    pub fn count_segmented_markdown_bodies<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_segmented_markdown_bodies())
    }

    /// `listRecentPageBodies`.
    #[napi]
    pub fn list_recent_page_bodies<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_recent_page_bodies(source_ids))
    }

    /// `countSegmentedRecentPages`.
    #[napi]
    pub fn count_segmented_recent_pages<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_segmented_recent_pages(source_ids))
    }

    /// `countPagesHiddenByPrefix`.
    #[napi]
    pub fn count_pages_hidden_by_prefix<'env>(
        &self,
        env: &'env Env,
        pattern: String,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_pages_hidden_by_prefix(pattern, source_ids)
        })
    }

    /// `listGitImageHoldCounts`.
    #[napi]
    pub fn list_git_image_hold_counts<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_git_image_hold_counts(source_ids))
    }

    /// `countAtomExtractionBacklog`: the pages awaiting atom extraction.
    #[napi]
    pub fn count_atom_extraction_backlog<'env>(
        &self,
        env: &'env Env,
        query: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: gbrain_store::link_queries::AtomBacklogQuery =
                arg(query, "countAtomExtractionBacklog query")?;
            s.count_atom_extraction_backlog(&query)
        })
    }

    /// `readAtomPageIdentity(sourceId, slug, contentHash)`: `{ id, incarnation, knowledge_revision }` or null.
    #[napi]
    pub fn read_atom_page_identity<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        content_hash: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_atom_page_identity(&source_id, &slug, &content_hash)
        })
    }

    /// `writeAtomPageState(pin, failIncrement, tombstone)`: the row's fail count, or null when the page changed.
    #[napi]
    pub fn write_atom_page_state<'env>(
        &self,
        env: &'env Env,
        pin: Option<Value>,
        fail_increment: i32,
        tombstone: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let pin: gbrain_store::atom_state::AtomPagePin = arg(pin, "writeAtomPageState pin")?;
            s.write_atom_page_state(&pin, fail_increment, tombstone)
        })
    }

    /// `recordAtomPagePartial(pin, maxInputChars)`: the page id, or null when the page changed.
    #[napi]
    pub fn record_atom_page_partial<'env>(
        &self,
        env: &'env Env,
        pin: Option<Value>,
        max_input_chars: i32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let pin: gbrain_store::atom_state::AtomPagePin = arg(pin, "recordAtomPagePartial pin")?;
            s.record_atom_page_partial(&pin, max_input_chars)
        })
    }

    /// `recordAtomTranscriptPartial(sourceId, filePath, contentHash, maxInputChars)`: resolves null.
    #[napi]
    pub fn record_atom_transcript_partial<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        file_path: String,
        content_hash: String,
        max_input_chars: i32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.record_transcript_partial(&source_id, &file_path, &content_hash, max_input_chars)
        })
    }

    /// `stampAtomTranscriptTombstone(sourceId, filePath, contentHash)`: resolves null.
    #[napi]
    pub fn stamp_atom_transcript_tombstone<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        file_path: String,
        content_hash: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.stamp_transcript_tombstone(&source_id, &file_path, &content_hash)
        })
    }

    /// `strikeAtomTranscript(sourceId, filePath, contentHash)`: the transcript's failure count.
    #[napi]
    pub fn strike_atom_transcript<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        file_path: String,
        content_hash: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.strike_transcript(&source_id, &file_path, &content_hash)
        })
    }

    /// `listTombstonedTranscripts(sourceId, hashes)`: `{ file_path, content_hash }` rows.
    #[napi]
    pub fn list_tombstoned_transcripts<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        hashes: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_tombstoned_transcripts(&source_id, &hashes)
        })
    }

    /// `listConversationPageFrontmatter(sourceId)`: `{ slug, frontmatter }` rows.
    #[napi]
    pub fn list_conversation_page_frontmatter<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_conversation_page_frontmatter(&source_id)
        })
    }

    /// `readLivePageSourcePath(sourceId, slug)`: `{ source_path }` or null.
    #[napi]
    pub fn read_live_page_source_path<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_live_page_source_path(&source_id, &slug)
        })
    }

    /// `listExtractablePages(query)`: the pages awaiting atom extraction in one source, newest first.
    #[napi]
    pub fn list_extractable_pages<'env>(
        &self,
        env: &'env Env,
        query: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: gbrain_store::link_queries::ExtractablePageQuery =
                arg(query, "listExtractablePages query")?;
            s.list_extractable_pages(&query)
        })
    }

    /// `listAtomSourceHashes(sourceId, hashes)`: the hashes a live, unmanaged atom of the source carries.
    #[napi]
    pub fn list_atom_source_hashes<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        hashes: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_atom_source_hashes(&source_id, &hashes))
    }

    /// `listSourcePageAtomTitles(sourceId, sourceSlug)`: the live atoms bound to one source page.
    #[napi]
    pub fn list_source_page_atom_titles<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        source_slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_source_page_atom_titles(&source_id, &source_slug)
        })
    }

    /// `readProjectionBacklog`: a coverage scope: the projection queue by class.
    #[napi]
    pub fn read_projection_backlog<'env>(
        &self,
        env: &'env Env,
        scope: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::link_queries::CoverageScope =
                arg(scope, "readProjectionBacklog scope")?;
            s.read_projection_backlog(&scope)
        })
    }
}
