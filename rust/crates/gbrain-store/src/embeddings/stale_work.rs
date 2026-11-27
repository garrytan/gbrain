//! The `gbrain embed --stale` reads and writes (rust/docs/store/embed-stale-work.md; SQL in
//! `src/core/engine-sql/embed-stale-work.ts`): the archived-source work count, the pending-projection reads, the
//! signature-drift probe and one content-drift batch (the provenance check is `read_page_provenance_complete` in the
//! parent module). They read the page records, their chunks
//! and signatures (the embeddings family's page context), the source records and the page's ledger row.
//!
//! SQL semantics kept: `md5(chunk_text)` is the store's text hash (sha256; `text_hash`), a NULL comparison is false, the
//! archived-work and pending reads look at every chunk record of a page (no generation filter, as the SQL reads
//! `content_chunks` with none), and the drift probe uses the live-body filter.

use super::{EmbedState, PageCtx, drop_vector, page_contexts, text_hash};
use crate::chunks::{ChunkRecord, segmented};
use crate::error::StoreError;
use crate::kv::KvRead;
use crate::pages::PageRecord;
use crate::sources::read_source;
use crate::version_prune::PAGE_INLINE_MAX_BYTES;
use crate::{Result, Store};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

/// The only vector column the store keeps.
const VECTOR_COLUMN: &str = "embedding";

/// Hold reasons that apply at any page size (`budgetRowAppliesFilter`).
const ANY_SIZE_HOLDS: [&str; 3] = ["archive_backfill", "archive_open_day", "call_import"];

fn require_column(column: &str, member: &str) -> Result<()> {
    if column == VECTOR_COLUMN {
        Ok(())
    } else {
        Err(StoreError::invalid(format!(
            "{member}: the store keeps one vector column, `embedding`, not `{column}`"
        )))
    }
}

/// `(p.body_storage = 'segmented' AND p.body_bytes > 0)`.
fn segmented_body(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    Ok(segmented(page)
        && crate::page_body::segmented_body_bytes(read, page.id)?.is_some_and(|b| b > 0))
}

/// `largePageBodyFilter`: a segmented page's `body_bytes`, else the octets of its body columns, over the inline limit. A
/// NULL count is not over it.
fn large_page(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    let bytes = if segmented(page) {
        crate::page_body::segmented_body_bytes(read, page.id)?
    } else {
        page.compiled_truth
            .as_deref()
            .map(|ct| ct.len() as i64 + page.timeline.as_deref().map_or(0, |t| t.len() as i64))
    };
    Ok(bytes.is_some_and(|b| b > PAGE_INLINE_MAX_BYTES as i64))
}

/// `pageBudgetLimitedFilter`: the page has a held or capped budget row that still applies (large, or a reason that applies
/// at any size). The store keeps that row in the page's ledger record (`page_embedding_budget.rs`).
pub(crate) fn budget_limited(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    let Some((state, reason)) = crate::page_embedding_budget::read_state_reason(read, page.id)?
    else {
        return Ok(false);
    };
    Ok(state != "open"
        && (reason
            .as_deref()
            .is_some_and(|r| ANY_SIZE_HOLDS.contains(&r))
            || large_page(read, page)?))
}

/// The page's source record: `Some(archived)`, or `None` when the source row is gone (the SQL JOIN drops the page).
fn source_archived(
    read: &dyn KvRead,
    cache: &mut HashMap<String, Option<bool>>,
    source_id: &str,
) -> Result<Option<bool>> {
    if let Some(state) = cache.get(source_id) {
        return Ok(*state);
    }
    let state = read_source(read, source_id)?.map(|s| s.archived);
    cache.insert(source_id.to_owned(), state);
    Ok(state)
}

/// `c.embedded_text_hash <> md5(c.chunk_text)`: false when the hash is NULL.
fn text_changed(chunk: &ChunkRecord) -> bool {
    chunk
        .embed
        .text_hash
        .as_deref()
        .is_some_and(|h| h != text_hash(&chunk.chunk_text))
}

/// `p.embedding_signature <> $sig OR ($incNull AND p.embedding_signature IS NULL)`, for a non-NULL target.
fn signature_differs(ctx: &PageCtx, target: Option<&str>, include_null: bool) -> bool {
    match target {
        None => false,
        Some(target) => match ctx.signature.as_deref() {
            Some(sig) => sig != target,
            None => include_null,
        },
    }
}

fn unsealed(page: &PageRecord) -> bool {
    page.text_projection_revision.as_deref() != Some(page.knowledge_revision.as_str())
}

/// The arguments of `countArchivedEmbeddingWork`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedWorkOptions {
    pub source_id: Option<String>,
    pub signature: Option<String>,
    pub include_null_signature: bool,
    pub include_unsealed: bool,
    /// The active vector column; null reads every chunk as missing its vector.
    pub column: Option<String>,
}

/// The stale rule of a pending-projection scope.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingStaleRule {
    pub column: String,
    pub signature: Option<String>,
    pub include_null_signature: bool,
}

/// `PendingProjectionScope`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingScope {
    pub source_id: Option<String>,
    pub existing_chunks_only: bool,
    pub active_sources_only: bool,
    pub stale: Option<PendingStaleRule>,
}

/// The arguments of `hasEmbeddingSignatureDrift`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureDriftOptions {
    pub column: String,
    pub signature: String,
    pub source_id: Option<String>,
    pub include_null_signature: bool,
    pub null_signature_only: bool,
}

/// The arguments of `invalidateContentDriftChunks`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftWindow {
    pub column: String,
    pub after_chunk_id: u64,
    pub limit: u64,
    pub source_id: Option<String>,
}

impl PendingScope {
    /// `pendingProjectionWhere`; `archived` is the page's source state (`None` drops the page, as the JOIN does).
    fn matches(&self, read: &dyn KvRead, ctx: &PageCtx, archived: Option<bool>) -> Result<bool> {
        let Some(archived) = archived else {
            return Ok(false);
        };
        if !ctx.live() || ctx.embed_skip() || !unsealed(&ctx.page) {
            return Ok(false);
        }
        if self
            .source_id
            .as_deref()
            .is_some_and(|id| id != ctx.page.source_id)
        {
            return Ok(false);
        }
        if self.active_sources_only && archived {
            return Ok(false);
        }
        let seg_body = segmented_body(read, &ctx.page)?;
        if self.existing_chunks_only && !seg_body && ctx.chunks.is_empty() {
            return Ok(false);
        }
        if let Some(rule) = &self.stale {
            let eligible = seg_body
                || ctx.chunks.iter().any(|c| {
                    !c.embed.has_vector()
                        || text_changed(c)
                        || signature_differs(
                            ctx,
                            rule.signature.as_deref(),
                            rule.include_null_signature,
                        )
                });
            if !eligible {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn check_column(&self, member: &str) -> Result<()> {
        match &self.stale {
            Some(rule) => require_column(&rule.column, member),
            None => Ok(()),
        }
    }
}

impl Store {
    /// The pages of `scope` in page id order with their source state.
    fn pending_pages(&self, scope: &PendingScope) -> Result<Vec<(PageCtx, bool)>> {
        let read = self.read()?;
        let mut sources = HashMap::new();
        let mut out = Vec::new();
        for ctx in page_contexts(&*read)? {
            let archived = source_archived(&*read, &mut sources, &ctx.page.source_id)?;
            if scope.matches(&*read, &ctx, archived)? {
                out.push((ctx, archived == Some(true)));
            }
        }
        Ok(out)
    }

    /// `countArchivedEmbeddingWork(opts)`: live, non-embed_skip pages of archived sources with embedding work: unsealed
    /// (with `includeUnsealed`), a chunk with no vector, a vector of other text or another signature, or text and no chunk
    /// at all on a page that is not quarantined.
    pub fn count_archived_embedding_work(&self, options: &ArchivedWorkOptions) -> Result<u64> {
        if let Some(column) = options.column.as_deref() {
            require_column(column, "countArchivedEmbeddingWork")?;
        }
        let read = self.read()?;
        let mut sources = HashMap::new();
        let mut n = 0;
        for ctx in page_contexts(&*read)? {
            if source_archived(&*read, &mut sources, &ctx.page.source_id)? != Some(true)
                || !ctx.live()
                || ctx.embed_skip()
                || options
                    .source_id
                    .as_deref()
                    .is_some_and(|id| id != ctx.page.source_id)
            {
                continue;
            }
            let has_text = |t: Option<&str>| t.is_some_and(|t| !t.is_empty());
            let work = (options.include_unsealed && unsealed(&ctx.page))
                || ctx.chunks.iter().any(|c| {
                    options.column.is_none()
                        || !c.embed.has_vector()
                        || text_changed(c)
                        || signature_differs(
                            &ctx,
                            options.signature.as_deref(),
                            options.include_null_signature,
                        )
                })
                || ((has_text(ctx.page.compiled_truth.as_deref())
                    || has_text(ctx.page.timeline.as_deref())
                    || segmented_body(&*read, &ctx.page)?)
                    && !ctx.quarantined()
                    && ctx.chunks.is_empty());
            if work {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `countEmbedPendingProjections(scope)`.
    pub fn count_embed_pending_projections(&self, scope: &PendingScope) -> Result<u64> {
        scope.check_column("countEmbedPendingProjections")?;
        Ok(self.pending_pages(scope)?.len() as u64)
    }

    /// `listEmbedPendingProjections(scope, limit)`: `[{ source_id, slug, page_kind }]` in active sources, by page id.
    pub fn list_embed_pending_projections(
        &self,
        scope: &PendingScope,
        limit: u64,
    ) -> Result<Vec<Value>> {
        scope.check_column("listEmbedPendingProjections")?;
        Ok(self
            .pending_pages(scope)?
            .into_iter()
            .filter(|(_, archived)| !archived)
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .map(|(ctx, _)| json!({ "source_id": ctx.page.source_id, "slug": ctx.page.slug, "page_kind": ctx.page.page_kind }))
            .collect())
    }

    /// `listEmbedProjectionRepairPages(scope, afterPageId, limit)`: `[{ slug, source_id, id }]` in active sources after page id
    /// `after`, markdown, code or segmented, by page id.
    pub fn list_embed_projection_repair_pages(
        &self,
        scope: &PendingScope,
        after: u64,
        limit: u64,
    ) -> Result<Vec<Value>> {
        scope.check_column("listEmbedProjectionRepairPages")?;
        Ok(self
            .pending_pages(scope)?
            .into_iter()
            .filter(|(ctx, archived)| {
                !archived
                    && ctx.page.id > after
                    && (ctx.page.page_kind == "markdown" || ctx.page.page_kind == "code" || segmented(&ctx.page))
            })
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .map(|(ctx, _)| json!({ "slug": ctx.page.slug, "source_id": ctx.page.source_id, "id": ctx.page.id }))
            .collect())
    }

    /// `listUnembeddedChunkIndexes(slug, sourceId)`: the chunk indexes of the page's live body (`chunkGenerationFilter`)
    /// with no vector, ascending. The SQL does not filter on the page's deleted state, so a soft-deleted page answers too;
    /// an unknown page answers none.
    pub fn list_unembedded_chunk_indexes(&self, slug: &str, source_id: &str) -> Result<Vec<u32>> {
        let read = self.read()?;
        let mut out: Vec<u32> = Vec::new();
        for ctx in page_contexts(&*read)? {
            if ctx.page.slug == slug && ctx.page.source_id == source_id {
                out.extend(
                    ctx.live_body()
                        .filter(|c| !c.embed.has_vector())
                        .map(|c| c.chunk_index),
                );
            }
        }
        out.sort_unstable();
        Ok(out)
    }

    /// `sumEmbedBackfillChars(sourceId, all)`: the characters (`length`) of live pages' chunks, only those with no
    /// vector unless `all`, and, unless `all`, of live pages with no chunk record at all: `length(compiled_truth) +
    /// length(timeline)`, which is NULL (not summed) when either column is NULL. `source_id` narrows both to one source.
    /// With `all` the chunkless sum is not read and answers 0.
    pub fn sum_embed_backfill_chars(&self, source_id: Option<&str>, all: bool) -> Result<Value> {
        let read = self.read()?;
        let (mut chunk_chars, mut chunkless_chars) = (0u64, 0u64);
        for ctx in page_contexts(&*read)? {
            if ctx.page.deleted_at_us.is_some()
                || source_id.is_some_and(|id| id != ctx.page.source_id)
            {
                continue;
            }
            chunk_chars += ctx
                .chunks
                .iter()
                .filter(|c| all || !c.embed.has_vector())
                .map(|c| c.chunk_text.chars().count() as u64)
                .sum::<u64>();
            if !all
                && ctx.chunks.is_empty()
                && let (Some(truth), Some(timeline)) = (
                    ctx.page.compiled_truth.as_deref(),
                    ctx.page.timeline.as_deref(),
                )
            {
                chunkless_chars += (truth.chars().count() + timeline.chars().count()) as u64;
            }
        }
        Ok(json!({ "chunk_chars": chunk_chars, "chunkless_chars": chunkless_chars }))
    }

    /// `readPageIsSegmented(pageId)`: whether the page (live or soft-deleted) keeps its body in segments.
    pub fn read_page_is_segmented(&self, page_id: u64) -> Result<bool> {
        let read = self.read()?;
        Ok(crate::pages::read_page_by_id(&*read, page_id)?.is_some_and(|p| segmented(&p)))
    }

    /// `hasEmbeddingSignatureDrift(opts)`: a live, non-embed_skip, not budget-limited page of a live source whose signature
    /// matches the rule and that has a live-body chunk with a vector.
    pub fn has_embedding_signature_drift(&self, options: &SignatureDriftOptions) -> Result<bool> {
        require_column(&options.column, "hasEmbeddingSignatureDrift")?;
        let read = self.read()?;
        let mut sources = HashMap::new();
        for ctx in page_contexts(&*read)? {
            let sig_matches = match ctx.signature.as_deref() {
                None => options.null_signature_only || options.include_null_signature,
                Some(sig) => !options.null_signature_only && sig != options.signature,
            };
            if !sig_matches
                || !ctx.live()
                || ctx.embed_skip()
                || options
                    .source_id
                    .as_deref()
                    .is_some_and(|id| id != ctx.page.source_id)
                || source_archived(&*read, &mut sources, &ctx.page.source_id)? != Some(false)
                || !ctx.live_body().any(|c| c.embed.has_vector())
                || budget_limited(&*read, &ctx.page)?
            {
                continue;
            }
            return Ok(true);
        }
        Ok(false)
    }

    /// `invalidateContentDriftChunks(window)`: examines the next `limit` chunk records after id `after` in id order and drops
    /// the vector of each one whose text changed since it was embedded, on a live, non-embed_skip, not budget-limited page of
    /// a live source (and of `sourceId`). Returns `{ last_id, checked, drifted }`; `last_id` is null when no chunk is left.
    pub fn invalidate_content_drift_chunks(&self, window: &DriftWindow) -> Result<Value> {
        require_column(&window.column, "invalidateContentDriftChunks")?;
        if window.limit < 1 {
            return Err(StoreError::invalid(format!(
                "invalid content-drift batch window: after {}, limit {}",
                window.after_chunk_id, window.limit
            )));
        }
        let now_us = self.env.now_micros();
        self.write(|tx| {
            let mut sources = HashMap::new();
            let mut rows: Vec<(u64, u64)> = Vec::new();
            let mut contexts: HashMap<u64, PageCtx> = HashMap::new();
            for ctx in page_contexts(&*tx)? {
                for chunk in &ctx.chunks {
                    if chunk.id > window.after_chunk_id {
                        rows.push((chunk.id, ctx.page.id));
                    }
                }
                contexts.insert(ctx.page.id, ctx);
            }
            rows.sort_unstable();
            rows.truncate(usize::try_from(window.limit).unwrap_or(usize::MAX));
            let last_id = rows.last().map(|(id, _)| *id);
            let checked = rows.len() as u64;
            let mut drifted = 0u64;
            for (chunk_id, page_id) in rows {
                let Some(ctx) = contexts.get(&page_id) else {
                    continue;
                };
                if !ctx.live()
                    || ctx.embed_skip()
                    || window
                        .source_id
                        .as_deref()
                        .is_some_and(|id| id != ctx.page.source_id)
                    || source_archived(&*tx, &mut sources, &ctx.page.source_id)? != Some(false)
                    || budget_limited(&*tx, &ctx.page)?
                {
                    continue;
                }
                let Some(mut chunk) = ctx.chunks.iter().find(|c| c.id == chunk_id).cloned() else {
                    continue;
                };
                if !chunk.embed.has_vector() || !text_changed(&chunk) {
                    continue;
                }
                let embed = EmbedState {
                    dims: 0,
                    embedded_at_us: None,
                    text_hash: None,
                    pending_since_us: Some(now_us),
                    ..chunk.embed.clone()
                };
                drop_vector(tx, &mut chunk, embed)?;
                drifted += 1;
            }
            Ok(json!({ "last_id": last_id, "checked": checked, "drifted": drifted }))
        })
    }
}
