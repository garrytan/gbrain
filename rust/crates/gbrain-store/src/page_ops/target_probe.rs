//! The copies of one slug under a read policy (`src/core/engine-sql/collate-target-probe.ts`): explain_target's
//! probe rows and the relational chain's anchors, each by source id in byte order.
//!
//! Members: probeTargetRows, listChainAnchors.
//!
//! Keys: this module adds none. It reads page, source and chunk records through `pages.rs`, `sources.rs` and
//! `chunks.rs`, and judges each page by the parent's read scope (`passes_read_scope`, always live as the statements
//! are).
//!
//! A chunk counts when it belongs to its page's live body (`chunkGenerationFilter`): an inline chunk of a page that
//! is not segmented, or, with `chunk_manifest`, a segmented chunk at or below the page's body generation. The SQL
//! engines also require a live `page_body_manifest` row for a segmented chunk; that manifest is the page_body
//! family's private state, which this module does not read (the same gap `resolveFrozenHits` documents).

use super::{PageReadScope, passes_read_scope, sources_by_id};
use crate::Store;
use crate::chunks::{ChunkRecord, read_chunks, read_segment_view};
use crate::error::Result;
use crate::kv::KvRead;
use crate::pages::{PageRecord, read_page};
use crate::trust::TrustPolicy;
use serde_json::{Value, json};

/// The live copies of `slug` the scope admits, by source id in byte order.
fn admitted_copies(
    read: &dyn KvRead,
    slug: &str,
    scope: &PageReadScope,
) -> Result<Vec<PageRecord>> {
    let sources = sources_by_id(read)?;
    let trust = TrustPolicy::parse(scope.min_trust.as_deref(), scope.suppress_flagged)?;
    let scope = PageReadScope {
        live: true,
        ..scope.clone()
    };
    let mut ids: Vec<&String> = sources.keys().collect();
    ids.sort();
    let mut out = Vec::new();
    for id in ids {
        if let Some(page) = read_page(read, id, slug)?
            && passes_read_scope(read, &page, &scope, &trust, &sources)?
        {
            out.push(page);
        }
    }
    Ok(out)
}

/// `chunkGenerationFilter('p', 'cc', manifest)` over the page's chunks.
fn live_body_chunks(
    read: &dyn KvRead,
    page: &PageRecord,
    chunk_manifest: bool,
) -> Result<Vec<ChunkRecord>> {
    let generation = read_segment_view(read, page.id)?.generation;
    let inline_ok = !(page.compiled_truth.is_null() && page.timeline.is_null());
    Ok(read_chunks(read, page.id)?
        .into_iter()
        .filter(|c| match c.segment {
            None => inline_ok,
            Some(_) => chunk_manifest && c.visible_at(generation),
        })
        .collect())
}

impl Store {
    /// `probeTargetRows(slug, scope, chunkManifest)`: `{ source_id, chunks, embedded, current, chunker_version }` of
    /// each live copy of `slug` the scope admits, by source id in byte order. `chunks` counts the chunks of the
    /// page's live body, `embedded` those with a vector, `current` is whether the text projection is the knowledge
    /// revision, `chunker_version` is null for a page that never recorded one.
    pub fn probe_target_rows(
        &self,
        slug: &str,
        scope: &PageReadScope,
        chunk_manifest: bool,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for page in admitted_copies(&*read, slug, scope)? {
            let chunks = live_body_chunks(&*read, &page, chunk_manifest)?;
            out.push(json!({
                "source_id": page.source_id,
                "chunks": chunks.len(),
                "embedded": chunks.iter().filter(|c| c.embed.has_vector()).count(),
                "current": page.text_projection_revision.as_deref() == Some(page.knowledge_revision.as_str()),
                "chunker_version": page.chunker_version,
            }));
        }
        Ok(out)
    }

    /// `listChainAnchors(slug, scope)`: `{ page_id, source_id }` of each live copy of `slug` the scope admits, by
    /// source id in byte order.
    pub fn list_chain_anchors(&self, slug: &str, scope: &PageReadScope) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(admitted_copies(&*read, slug, scope)?
            .into_iter()
            .map(|p| json!({ "page_id": p.id, "source_id": p.source_id }))
            .collect())
    }
}
