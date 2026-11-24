//! The image seal's statements (src/core/page-state/image-seal.ts `sealImageProjections`, SQL in
//! src/core/engine-sql/projection-rebuild.ts): `gbrain projections drain --images` restores the
//! importer's own seal on `sealable` image pages (`projection_rebuild::sealable_image`).
//!
//! - `listImageSealWindow`: a window of queue jobs after a key (incarnation, then slug in byte
//!   order), at most `limit`, last queued at or before `notAfter` when given, each with its active
//!   source and whether its live page is a sealable image at the job's revision.
//! - `readImageSealPages`: the pages of a group still live at their queued revision and still
//!   sealable images of an active source, with their contextual retrieval stamp.
//! - `listImageSealChunks`: the live chunks of the pages that hold a vector, each with whether the
//!   vector is its text's and of the provenance model (`current`).
//! - `clearImageSealVectors`: clears those vectors and marks the chunks pending.
//! - `sealImagePages`: seals each page still at its revision; the queue hook drops its job. The
//!   store keeps no image vector, so `has_visual` is always false.
//!
//! The TypeScript members refuse a write column other than `embedding`, the one the store keeps.

use super::projection_queue::{all_jobs, parse_timestamptz, sources_by_incarnation};
use super::projection_rebuild::{sealable_image, text_current};
use crate::Store;
use crate::chunks::{in_live_body, read_chunks, read_segment_view, segmented};
use crate::embeddings::remove_chunk_vector;
use crate::env::transaction_clock;
use crate::error::{Result, StoreError};
use crate::pages::{read_page, read_page_by_id, write_page};
use crate::sources::read_source;
use crate::{keys, put_json};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// One page of a seal group (`readImageSealPages`).
#[derive(Debug, Clone, Deserialize)]
pub struct ImageSealRow {
    pub source_id: String,
    pub slug: String,
    pub revision: String,
}

/// A chunk to clear (`clearImageSealVectors`).
#[derive(Debug, Clone, Deserialize)]
pub struct ImageSealChunkRef {
    pub id: f64,
    pub page_id: f64,
}

/// A page to seal (`sealImagePages`).
#[derive(Debug, Clone, Deserialize)]
pub struct ImageSealPageRef {
    pub id: f64,
    pub revision: String,
}

fn whole(value: f64, what: &str) -> Result<u64> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 && value <= u64::MAX as f64 {
        Ok(value as u64)
    } else {
        Err(StoreError::invalid(format!(
            "{what} is not a whole number: {value}"
        )))
    }
}

impl Store {
    /// `listImageSealWindow(after, limit, notAfter)`.
    pub fn list_image_seal_window(
        &self,
        after_incarnation: &str,
        after_slug: &str,
        limit: f64,
        not_after: Option<&str>,
    ) -> Result<Vec<Value>> {
        let limit = whole(limit, "limit")? as usize;
        let not_after = not_after
            .map(|t| parse_timestamptz(t, "notAfter"))
            .transpose()?;
        let read = self.read()?;
        let read = &*read;
        let sources = sources_by_incarnation(read)?;
        let after = (
            after_incarnation.to_lowercase(),
            after_slug.as_bytes().to_vec(),
        );
        let mut jobs: Vec<_> = all_jobs(read)?
            .into_iter()
            .filter(|j| (j.incarnation.to_lowercase(), j.slug.as_bytes().to_vec()) > after)
            .filter(|j| not_after.is_none_or(|at| j.record.updated_at_us <= at))
            .collect();
        jobs.sort_by(|a, b| {
            (a.incarnation.as_str(), a.slug.as_bytes())
                .cmp(&(b.incarnation.as_str(), b.slug.as_bytes()))
        });
        jobs.truncate(limit);
        jobs.into_iter()
            .map(|job| {
                let source = sources.get(&job.incarnation).filter(|s| !s.archived);
                let sealable = match source {
                    Some(source) => match read_page(read, &source.id, &job.slug)? {
                        Some(page) => {
                            page.deleted_at_us.is_none()
                                && page
                                    .knowledge_revision
                                    .eq_ignore_ascii_case(&job.record.revision)
                                && sealable_image(read, &page)?
                        }
                        None => false,
                    },
                    None => false,
                };
                Ok(json!({
                    "source_id": source.map(|s| s.id.clone()),
                    "source_incarnation": job.incarnation,
                    "slug": job.slug,
                    "revision": job.record.revision,
                    "sealable": sealable,
                }))
            })
            .collect()
    }

    /// `readImageSealPages(rows)`.
    pub fn read_image_seal_pages(&self, rows: &[ImageSealRow]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let read = &*read;
        let mut out = Vec::new();
        for row in rows {
            if read_source(read, &row.source_id)?.is_none_or(|s| s.archived) {
                continue;
            }
            let Some(page) = read_page(read, &row.source_id, &row.slug)? else {
                continue;
            };
            if page.deleted_at_us.is_some()
                || !page.knowledge_revision.eq_ignore_ascii_case(&row.revision)
                || !sealable_image(read, &page)?
            {
                continue;
            }
            out.push(json!({
                "id": page.id,
                "revision": page.knowledge_revision,
                "title": page.title,
                "mode": crate::aliases::contextual_retrieval_mode(read, page.id)?,
                "corpus_generation": crate::aliases::corpus_generation(read, page.id)?,
            }));
        }
        Ok(out)
    }

    /// `listImageSealChunks(pageIds, column, provenanceModel)`.
    pub fn list_image_seal_chunks(
        &self,
        page_ids: &[f64],
        model: Option<&str>,
    ) -> Result<Vec<Value>> {
        let ids: BTreeSet<u64> = page_ids
            .iter()
            .map(|id| whole(*id, "pageIds"))
            .collect::<Result<_>>()?;
        let read = self.read()?;
        let read = &*read;
        let mut out = Vec::new();
        for id in ids {
            let Some(page) = read_page_by_id(read, id)? else {
                continue;
            };
            let view = read_segment_view(read, id)?;
            let seg = segmented(&page);
            for chunk in read_chunks(read, id)? {
                if !chunk.embed.has_vector() || !in_live_body(&chunk, seg, &view) {
                    continue;
                }
                let label = chunk.meta.get("model").and_then(Value::as_str);
                let current = text_current(&chunk) && label == model;
                out.push(json!({
                    "id": chunk.id, "page_id": chunk.page_id, "chunk_text": chunk.chunk_text,
                    "chunk_source": chunk.chunk_source, "embedding_input_hash": chunk.embed.input_hash,
                    "current": current,
                }));
            }
        }
        Ok(out)
    }

    /// `clearImageSealVectors(column, chunks)`.
    pub fn clear_image_seal_vectors(&self, chunks: &[ImageSealChunkRef]) -> Result<()> {
        let wanted: Vec<(u64, u64)> = chunks
            .iter()
            .map(|c| Ok((whole(c.page_id, "page_id")?, whole(c.id, "id")?)))
            .collect::<Result<_>>()?;
        let pages: BTreeSet<u64> = wanted.iter().map(|(page, _)| *page).collect();
        self.write(|tx| {
            let now = transaction_clock::transaction_now().ok_or_else(|| {
                StoreError::invalid("clearImageSealVectors ran outside a store write transaction")
            })?;
            for page in &pages {
                for mut chunk in read_chunks(&*tx, *page)? {
                    if !wanted.contains(&(*page, chunk.id)) {
                        continue;
                    }
                    chunk.embed.dims = 0;
                    chunk.embed.embedded_at_us = None;
                    chunk.embed.text_hash = None;
                    chunk.embed.input_hash = None;
                    chunk.embed.pending_since_us = chunk.embed.pending_since_us.or(Some(now));
                    put_json(tx, &keys::chunk(chunk.page_id, chunk.chunk_index), &chunk)?;
                    remove_chunk_vector(tx, chunk.page_id, chunk.chunk_index)?;
                }
            }
            Ok(())
        })
    }

    /// `sealImagePages(pages)`.
    pub fn seal_image_pages(&self, pages: &[ImageSealPageRef]) -> Result<Vec<Value>> {
        let refs: Vec<(u64, String)> = pages
            .iter()
            .map(|p| Ok((whole(p.id, "id")?, p.revision.to_lowercase())))
            .collect::<Result<_>>()?;
        self.write(|tx| {
            let mut out = Vec::new();
            for (id, revision) in &refs {
                let Some(mut page) = read_page_by_id(&*tx, *id)? else {
                    continue;
                };
                if page.knowledge_revision.to_lowercase() != *revision {
                    continue;
                }
                page.text_projection_revision = Some(page.knowledge_revision.clone());
                write_page(tx, &page)?;
                out.push(json!({ "has_visual": false }));
            }
            Ok(out)
        })
    }
}
