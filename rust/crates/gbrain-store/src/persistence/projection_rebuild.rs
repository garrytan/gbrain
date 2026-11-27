//! The members a page projection rebuild calls (`src/core/engine-sql/projection-rebuild.ts`):
//! the queue listing it walks, the reason of one job (its delete is projection_queue.rs
//! `deleteProjectionJob`), the keep plan of the page's chunk
//! vectors and the drained probe of the rebuild statistics. A deferred chunk replacement's reads
//! and chunk writes (`readChunkRowsFingerprint`, `deleteUnkeptChunks`, `listStaleChunkVectors`,
//! `clearChunkVectors`, `readProjectionHead`), the re-seal's pending count
//! (`countPendingTextChunks`) and the segmented probe (`hasSegmentedPage`) are here too; its
//! queue writes are in projection_queue.rs.
//!
//! `readChunkRowsFingerprint` is the store's own opaque value (the sha256 of the page's
//! `id:index` pairs in index order), not Postgres's `hashtext` sum: a caller only compares two
//! values from one engine.
//!
//! A job is drainable when its page is a live inline page (Markdown or code, not segmented) of a
//! source that is not archived (`projectionJobProbes`). A segmented page has both body columns
//! NULL. The store keeps one vector column (`embedding`); the TypeScript members refuse any other
//! column and the drained probe's `media` option before they call the store.

use super::projection_queue::{
    Job, all_jobs, job_at_revision, parse_timestamptz, retry_ready, sources_by_incarnation,
};
use super::uuid_param;
use crate::chunks::{
    ChunkRecord, delete_chunks_matching, in_live_body, read_chunks, read_segment_view, segmented,
};
use crate::cli_reads::pg_text::timestamptz_text;
use crate::embeddings::{remove_chunk_vector, text_hash};
use crate::env::transaction_clock;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use crate::pages::{PageRecord, read_page};
use crate::sources::SourceRecord;
use crate::{Store, keys, put_json};
use serde::Deserialize;
use serde_json::{Value, json};

/// `ACTIVATION_SERVED_REVISION` (`src/core/search/safe-chunks.ts`): the text projection revision of
/// a page search answers for from its pre-upgrade index.
const ACTIVATION_SERVED_REVISION: &str = "00000000-0000-0000-0000-000000000153";

/// A job's position in the walk order (`QueuedProjectionKey`).
#[derive(Debug, Clone, Deserialize)]
pub struct QueuedProjectionKey {
    pub updated_at: String,
    pub source_incarnation: String,
    pub slug: String,
}

/// One source's pages (`QueuedProjectionFilter.pages`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedProjectionPages {
    pub source_id: String,
    pub slugs: Vec<String>,
}

/// What `listQueuedPageProjections` takes (`QueuedProjectionFilter`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedProjectionFilter {
    pub limit: f64,
    #[serde(default)]
    pub retry_cooldown: Option<bool>,
    #[serde(default)]
    pub not_after: Option<String>,
    #[serde(default)]
    pub reasons: Option<Vec<String>>,
    #[serde(default)]
    pub pages: Option<QueuedProjectionPages>,
    #[serde(default)]
    pub after: Option<QueuedProjectionKey>,
    /// `waiting`: only pages search does not answer for yet; any other value: only those it does.
    #[serde(default)]
    pub served: Option<String>,
}

/// One row the resident's window selection probes (`ProjectionWindowCandidate`).
#[derive(Debug, Clone, Deserialize)]
pub struct ProjectionWindowCandidate {
    pub source_incarnation: String,
    pub slug: String,
}

/// A job's exact key (`ProjectionJobKey`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionJobKey {
    pub source_incarnation: String,
    pub slug: String,
    pub revision: String,
}

/// `SAFE_FENCE_CHUNKER_VERSION`: a page whose chunks the safe fence certified.
const SAFE_FENCE_CHUNKER_VERSION: i16 = 4;
/// `BOUNDED_PREFIX_BYTES` (page-window/document.ts): `left()` counts code points.
const BOUNDED_PREFIX_CHARS: usize = 64 * 1024;

/// `importerChunkSql`: the page's live chunks are exactly one, at index 0, an `image_asset` chunk of
/// modality `image`, shorter than the bounded prefix and equal to the page's bounded body prefix
/// (`left(coalesce(compiled_truth, truth_lead), 65536)`), or to its title when that prefix is empty.
fn importer_chunk(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    let view = read_segment_view(read, page.id)?;
    let seg = segmented(page);
    let live: Vec<ChunkRecord> = read_chunks(read, page.id)?
        .into_iter()
        .filter(|c| in_live_body(c, seg, &view))
        .collect();
    let [chunk] = live.as_slice() else {
        return Ok(false);
    };
    let body = match page.compiled_truth.as_deref() {
        Some(text) => text.to_owned(),
        None => crate::page_body::truth_lead(read, page.id)?.unwrap_or_default(),
    };
    let prefix: String = body.chars().take(BOUNDED_PREFIX_CHARS).collect();
    let expected = if prefix.is_empty() {
        page.title.as_str()
    } else {
        prefix.as_str()
    };
    Ok(chunk.chunk_index == 0
        && chunk.chunk_source == "image_asset"
        && chunk.modality == "image"
        && chunk.chunk_text.chars().count() < BOUNDED_PREFIX_CHARS
        && chunk.chunk_text == expected)
}

/// `protectedBodyFilter` of an inline page: a protected marker in either body column.
fn protected_body(page: &PageRecord) -> bool {
    crate::pages::has_protected_text(&page.compiled_truth)
        || crate::pages::has_protected_text(&page.timeline)
}

/// `sealableImageSql`: a live, unprotected inline image page the importer sealed at or after the
/// safe-chunk fence.
pub(crate) fn sealable_image(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    Ok(page.page_kind == "image"
        && !segmented(page)
        && !protected_body(page)
        && page.chunker_version.unwrap_or(0) >= SAFE_FENCE_CHUNKER_VERSION
        && importer_chunk(read, page)?)
}

/// The live inline page of an active source that `job` names (`projectionJobProbes`).
fn drainable_page(
    read: &dyn KvRead,
    source: Option<&SourceRecord>,
    job: &Job,
) -> Result<Option<PageRecord>> {
    drainable_page_with(read, source, job, false)
}

/// `projectionJobProbes({ media })`: the live inline Markdown or code page of an active source that
/// `job` names, or with `media` also a sealable image page (`sealableImageSql`).
fn drainable_page_with(
    read: &dyn KvRead,
    source: Option<&SourceRecord>,
    job: &Job,
    media: bool,
) -> Result<Option<PageRecord>> {
    let Some(source) = source.filter(|s| !s.archived) else {
        return Ok(None);
    };
    let Some(page) = read_page(read, &source.id, &job.slug)?.filter(|p| p.deleted_at_us.is_none())
    else {
        return Ok(None);
    };
    let inline = (page.page_kind == "markdown" || page.page_kind == "code") && !segmented(&page);
    Ok((inline || (media && sealable_image(read, &page)?)).then_some(page))
}

/// `chunkModelMatchesSql('model', provenanceModel, vector_dims(col) = dims)`: the chunk's label is
/// the model (NULL matching NULL), or the model's bare tail with a vector of the column's width.
fn model_matches(chunk: &crate::chunks::ChunkRecord, model: Option<&str>, dims: u32) -> bool {
    let label = chunk.meta.get("model").and_then(Value::as_str);
    if label == model {
        return true;
    }
    let (Some(label), Some(model)) = (label, model) else {
        return false;
    };
    let tail = model.split_once(':').map_or(model, |(_, tail)| tail);
    label == tail && chunk.embed.has_vector() && chunk.embed.dims == dims
}

/// `embedded_text_hash IS NOT DISTINCT FROM md5(chunk_text)` (the store keeps sha256).
pub(super) fn text_current(chunk: &crate::chunks::ChunkRecord) -> bool {
    chunk.embed.text_hash.as_deref() == Some(text_hash(&chunk.chunk_text).as_str())
}

fn id_of(value: f64, what: &str) -> Result<u64> {
    if value.is_finite() && value >= 0.0 && value.fract() == 0.0 {
        Ok(value as u64)
    } else {
        Err(StoreError::invalid(format!("{what} is not an id: {value}")))
    }
}

impl Store {
    /// `listQueuedPageProjections(filter)`: the jobs of live inline pages of active sources,
    /// filtered, in walk order (`updated_at`, incarnation, slug bytes), at most `limit`.
    pub fn list_queued_page_projections(
        &self,
        filter: &QueuedProjectionFilter,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let read = &*read;
        let now = self.env.now_micros();
        let not_after = filter
            .not_after
            .as_deref()
            .map(|t| parse_timestamptz(t, "notAfter"))
            .transpose()?;
        let after = match &filter.after {
            Some(key) => Some((
                parse_timestamptz(&key.updated_at, "after.updated_at")?,
                uuid_param(&key.source_incarnation, "after.source_incarnation")?,
                key.slug.as_bytes().to_vec(),
            )),
            None => None,
        };
        let sources = sources_by_incarnation(read)?;
        let mut rows = Vec::new();
        for job in all_jobs(read)? {
            let r = &job.record;
            let keep = (filter.retry_cooldown != Some(true) || retry_ready(r, now))
                && not_after.is_none_or(|at| r.updated_at_us <= at)
                && filter
                    .reasons
                    .as_ref()
                    .is_none_or(|rs| rs.contains(&r.reason))
                && filter
                    .pages
                    .as_ref()
                    .is_none_or(|p| p.slugs.contains(&job.slug))
                && after.as_ref().is_none_or(|(us, inc, slug)| {
                    (
                        r.updated_at_us,
                        job.incarnation.as_str(),
                        job.slug.as_bytes(),
                    ) > (*us, inc.as_str(), slug.as_slice())
                });
            if !keep {
                continue;
            }
            let source = sources.get(&job.incarnation);
            if filter
                .pages
                .as_ref()
                .is_some_and(|p| source.is_none_or(|s| s.id != p.source_id))
            {
                continue;
            }
            let Some(page) = drainable_page(read, source, &job)? else {
                continue;
            };
            if let Some(served) = &filter.served {
                let answering =
                    page.text_projection_revision.as_deref() == Some(ACTIVATION_SERVED_REVISION);
                if answering == (served == "waiting") {
                    continue;
                }
            }
            rows.push((page, job));
        }
        rows.sort_by(|(_, a), (_, b)| {
            (a.record.updated_at_us, &a.incarnation, a.slug.as_bytes()).cmp(&(
                b.record.updated_at_us,
                &b.incarnation,
                b.slug.as_bytes(),
            ))
        });
        let limit = if filter.limit.is_finite() && filter.limit >= 0.0 {
            filter.limit as usize
        } else {
            0
        };
        Ok(rows
            .into_iter()
            .take(limit)
            .map(|(page, j)| {
                json!({
                    "source_id": page.source_id,
                    "source_incarnation": j.incarnation,
                    "slug": j.slug,
                    "revision": j.record.revision,
                    "page_kind": page.page_kind,
                    "updated_at": timestamptz_text(j.record.updated_at_us),
                })
            })
            .collect())
    }

    /// `readProjectionJobReason(key)`: the reason of the job, or `None` when no job of that
    /// revision is queued.
    pub fn read_projection_job_reason(&self, key: &ProjectionJobKey) -> Result<Option<String>> {
        let job = super::projection_queue::ProjectionJobRef {
            source_incarnation: key.source_incarnation.clone(),
            slug: key.slug.clone(),
            revision: key.revision.clone(),
        };
        Ok(job_at_revision(&*self.read()?, &job)?.map(|(_, record)| record.reason))
    }

    /// `readChunkKeepState(pageId, provenanceModel, column)`: each chunk of the page with its
    /// embedding input hash and whether its vector is current (present, from the chunk's text as it
    /// is now, labelled with the model or its bare tail at the column's width `dims`).
    pub fn read_chunk_keep_state(
        &self,
        page_id: f64,
        model: Option<&str>,
        dims: u32,
    ) -> Result<Vec<Value>> {
        let page_id = id_of(page_id, "pageId")?;
        Ok(read_chunks(&*self.read()?, page_id)?
            .iter()
            .map(|c| {
                let movable = c.embed.has_vector() && text_current(c) && model_matches(c, model, dims);
                json!({ "id": c.id, "embedding_input_hash": c.embed.input_hash, "movable": movable })
            })
            .collect())
    }

    /// `clearUnkeptChunkVectors(pageId, provenanceModel, column, currentIds)`: clears the vector and
    /// the embedding record of each chunk of the page whose label does not match, whose recorded
    /// text hash is not its text's, or whose id is not in `current_ids`, and marks it pending.
    pub fn clear_unkept_chunk_vectors(
        &self,
        page_id: f64,
        model: Option<&str>,
        dims: u32,
        current_ids: &[f64],
    ) -> Result<()> {
        let page_id = id_of(page_id, "pageId")?;
        let current: Vec<u64> = current_ids
            .iter()
            .map(|id| id_of(*id, "currentIds"))
            .collect::<Result<_>>()?;
        self.write(|tx| {
            let now = transaction_clock::transaction_now().ok_or_else(|| {
                StoreError::invalid("clearUnkeptChunkVectors ran outside a store write transaction")
            })?;
            for mut chunk in read_chunks(&*tx, page_id)? {
                let drifted = chunk.embed.text_hash.is_some() && !text_current(&chunk);
                if model_matches(&chunk, model, dims) && !drifted && current.contains(&chunk.id) {
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
            Ok(())
        })
    }

    /// `readChunkInputHashes(pageId)`: every stored chunk of the page with its recorded embedding input hash,
    /// `{ id, embedding_input_hash }` (the contextual-mode proof read, page-state/contextual-proof.ts).
    pub fn read_chunk_input_hashes(&self, page_id: f64) -> Result<Vec<Value>> {
        let page_id = id_of(page_id, "pageId")?;
        Ok(read_chunks(&*self.read()?, page_id)?
            .iter()
            .map(|c| json!({ "id": c.id, "embedding_input_hash": c.embed.input_hash }))
            .collect())
    }

    /// `clearChunkEmbeddingsByIds(pageId, column, ids)`: clears the vector and its embedding record on each named
    /// chunk of the page and marks it pending now (`embedding_pending_since=now()`).
    pub fn clear_chunk_embeddings_by_ids(&self, page_id: f64, ids: &[f64]) -> Result<()> {
        let page_id = id_of(page_id, "pageId")?;
        let ids: Vec<u64> = ids
            .iter()
            .map(|id| id_of(*id, "ids"))
            .collect::<Result<_>>()?;
        self.write(|tx| {
            let now = transaction_clock::transaction_now().ok_or_else(|| {
                StoreError::invalid(
                    "clearChunkEmbeddingsByIds ran outside a store write transaction",
                )
            })?;
            for mut chunk in read_chunks(&*tx, page_id)? {
                if !ids.contains(&chunk.id) {
                    continue;
                }
                chunk.embed.dims = 0;
                chunk.embed.embedded_at_us = None;
                chunk.embed.text_hash = None;
                chunk.embed.input_hash = None;
                chunk.embed.pending_since_us = Some(now);
                put_json(tx, &keys::chunk(chunk.page_id, chunk.chunk_index), &chunk)?;
                remove_chunk_vector(tx, chunk.page_id, chunk.chunk_index)?;
            }
            Ok(())
        })
    }

    /// `writeChunkInputHashes(pageId, ids, hashes)`: records each hash as the embedding input hash of the chunk of
    /// the page with the id at the same position (`FROM unnest(ids, hashes)`).
    pub fn write_chunk_input_hashes(
        &self,
        page_id: f64,
        ids: &[f64],
        hashes: &[String],
    ) -> Result<()> {
        let page_id = id_of(page_id, "pageId")?;
        if ids.len() != hashes.len() {
            return Err(StoreError::invalid(
                "writeChunkInputHashes: ids and hashes differ in length",
            ));
        }
        let mut proof: std::collections::BTreeMap<u64, &str> = std::collections::BTreeMap::new();
        for (id, hash) in ids.iter().zip(hashes) {
            if hash.contains('\0') {
                return Err(StoreError::invalid(
                    "writeChunkInputHashes: a hash holds a NUL byte",
                ));
            }
            proof.entry(id_of(*id, "ids")?).or_insert(hash.as_str());
        }
        self.write(|tx| {
            for mut chunk in read_chunks(&*tx, page_id)? {
                let Some(hash) = proof.get(&chunk.id) else {
                    continue;
                };
                chunk.embed.input_hash = Some((*hash).to_string());
                put_json(tx, &keys::chunk(chunk.page_id, chunk.chunk_index), &chunk)?;
            }
            Ok(())
        })
    }

    /// `readChunkRowsFingerprint(pageId)`: the page's chunk rows as `id:index` pairs, hashed.
    pub fn read_chunk_rows_fingerprint(&self, page_id: f64) -> Result<String> {
        let page_id = id_of(page_id, "pageId")?;
        let chunks = read_chunks(&*self.read()?, page_id)?;
        let pairs: Vec<String> = chunks
            .iter()
            .map(|c| format!("{}:{}", c.id, c.chunk_index))
            .collect();
        Ok(format!("{}:{}", chunks.len(), text_hash(&pairs.join(","))))
    }

    /// `deleteUnkeptChunks(pageId, keptIds)`: deletes each chunk row of the page whose id is not
    /// in `kept_ids`, with its postings, vector and dependent rows.
    pub fn delete_unkept_chunks(&self, page_id: f64, kept_ids: &[f64]) -> Result<()> {
        let page_id = id_of(page_id, "pageId")?;
        let kept: Vec<u64> = kept_ids
            .iter()
            .map(|id| id_of(*id, "keptIds"))
            .collect::<Result<_>>()?;
        self.write(|tx| {
            delete_chunks_matching(tx, page_id, &|c| !kept.contains(&c.id))?;
            Ok(())
        })
    }

    /// `listStaleChunkVectors(pageId, provenanceModel, column, currentIds)`: the ids, in chunk
    /// order, of the page's chunks holding a vector that is of another model, embedded from other
    /// text, or not in `current_ids`.
    pub fn list_stale_chunk_vectors(
        &self,
        page_id: f64,
        model: Option<&str>,
        dims: u32,
        current_ids: &[f64],
    ) -> Result<Vec<u64>> {
        let page_id = id_of(page_id, "pageId")?;
        let current: Vec<u64> = current_ids
            .iter()
            .map(|id| id_of(*id, "currentIds"))
            .collect::<Result<_>>()?;
        let mut chunks = read_chunks(&*self.read()?, page_id)?;
        chunks.sort_by_key(|c| c.chunk_index);
        Ok(chunks
            .iter()
            .filter(|c| {
                let drifted = c.embed.text_hash.is_some() && !text_current(c);
                c.embed.has_vector()
                    && (!model_matches(c, model, dims) || drifted || !current.contains(&c.id))
            })
            .map(|c| c.id)
            .collect())
    }

    /// `clearChunkVectors(pageId, column, ids)`: clears the vector and the embedding record of the
    /// page's chunks `ids` and marks them pending.
    pub fn clear_chunk_vectors(&self, page_id: f64, ids: &[f64]) -> Result<()> {
        let page_id = id_of(page_id, "pageId")?;
        let ids: Vec<u64> = ids
            .iter()
            .map(|id| id_of(*id, "ids"))
            .collect::<Result<_>>()?;
        self.write(|tx| {
            let now = transaction_clock::transaction_now().ok_or_else(|| {
                StoreError::invalid("clearChunkVectors ran outside a store write transaction")
            })?;
            for mut chunk in read_chunks(&*tx, page_id)? {
                if !ids.contains(&chunk.id) {
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
            Ok(())
        })
    }

    /// `countPendingTextChunks(pageId, column)`: `{ chunks, chars }`, how many of the page's text
    /// chunks have no vector and their length in characters (Postgres `length`).
    pub fn count_pending_text_chunks(&self, page_id: f64) -> Result<Value> {
        let page_id = id_of(page_id, "pageId")?;
        let pending: Vec<ChunkRecord> = read_chunks(&*self.read()?, page_id)?
            .into_iter()
            .filter(|c| c.modality == "text" && !c.embed.has_vector())
            .collect();
        let chars: usize = pending.iter().map(|c| c.chunk_text.chars().count()).sum();
        Ok(json!({ "chunks": pending.len(), "chars": chars }))
    }

    /// `probeProjectionWindowCandidates(candidates)`: for each candidate, at its index `i`, the
    /// source of its incarnation (`source_id`, `archived`, archived or not) and that source's live
    /// page at its slug (`page_kind`, `body_storage`); each part is null when it is missing.
    pub fn probe_projection_window_candidates(
        &self,
        candidates: &[ProjectionWindowCandidate],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let read = &*read;
        let sources = sources_by_incarnation(read)?;
        let mut rows = Vec::with_capacity(candidates.len());
        for (i, candidate) in candidates.iter().enumerate() {
            let incarnation = uuid_param(&candidate.source_incarnation, "source_incarnation")?;
            let source = sources.get(&incarnation);
            let page = match source {
                Some(s) => {
                    read_page(read, &s.id, &candidate.slug)?.filter(|p| p.deleted_at_us.is_none())
                }
                None => None,
            };
            rows.push(json!({
                "i": i,
                "source_id": source.map(|s| s.id.clone()),
                "archived": source.map(|s| s.archived),
                "page_kind": page.as_ref().map(|p| p.page_kind.clone()),
                "body_storage": page.as_ref().map(|p| if segmented(p) { "segmented" } else { "inline" }),
            }));
        }
        Ok(rows)
    }

    /// `readProjectionHead(sourceId, slug)`: `{ id, revision, sealed }` of the live page, or null.
    pub fn read_projection_head(&self, source_id: &str, slug: &str) -> Result<Value> {
        let page =
            read_page(&*self.read()?, source_id, slug)?.filter(|p| p.deleted_at_us.is_none());
        Ok(page.map_or(Value::Null, |p| {
            let sealed =
                p.text_projection_revision.as_deref() == Some(p.knowledge_revision.as_str());
            json!({ "id": p.id, "revision": p.knowledge_revision, "sealed": sealed })
        }))
    }

    /// `hasSegmentedPage(sourceId, slug)`: whether the page is a live segmented page.
    pub fn has_segmented_page(&self, source_id: &str, slug: &str) -> Result<bool> {
        Ok(read_page(&*self.read()?, source_id, slug)?
            .is_some_and(|p| p.deleted_at_us.is_none() && segmented(&p)))
    }

    /// `listProjectionDrainPreview(limit)`: the jobs a media drain takes (`projectionJobProbes` with
    /// `media`: live inline Markdown or code pages of active sources, or sealable images), images
    /// next, then pages search answers for from their pre-upgrade index, then by time, incarnation and
    /// slug (byte order), at most `limit`.
    pub fn list_projection_drain_preview(&self, limit: f64) -> Result<Vec<Value>> {
        let read = self.read()?;
        let read = &*read;
        let sources = sources_by_incarnation(read)?;
        let mut rows = Vec::new();
        for job in all_jobs(read)? {
            let source = sources.get(&job.incarnation);
            let Some(page) = drainable_page_with(read, source, &job, true)? else {
                continue;
            };
            let rank: u8 = if page.page_kind != "markdown" && page.page_kind != "code" {
                1
            } else if page.text_projection_revision.as_deref() == Some(ACTIVATION_SERVED_REVISION) {
                2
            } else {
                0
            };
            let source_id = source.map(|s| s.id.clone()).unwrap_or_default();
            rows.push((
                rank,
                job.record.updated_at_us,
                job.incarnation.clone(),
                job.slug.clone(),
                source_id,
                page.page_kind.clone(),
                job.record.reason.clone(),
            ));
        }
        rows.sort_by(|a, b| {
            (a.0, a.1, &a.2, a.3.as_bytes()).cmp(&(b.0, b.1, &b.2, b.3.as_bytes()))
        });
        let take = if limit.is_finite() && limit >= 1.0 {
            limit as usize
        } else {
            1
        };
        Ok(rows
            .into_iter()
            .take(take)
            .map(|(_, at, _, slug, source_id, page_kind, reason)| {
                json!({ "source_id": source_id, "slug": slug, "page_kind": page_kind, "reason": reason, "updated_at": timestamptz_text(at) })
            })
            .collect())
    }

    /// `hasQueuedProjectionWork({ media })`: whether any job, whatever its reason, names a live inline
    /// page of an active source (with `media`, or a sealable image: `projectionJobProbes`) or a live
    /// segmented page of one (`SEGMENTED_JOB_PROBES`): the work a limited drain left.
    pub fn has_queued_projection_work(&self, media: bool) -> Result<bool> {
        let read = self.read()?;
        let read = &*read;
        let sources = sources_by_incarnation(read)?;
        for job in all_jobs(read)? {
            let Some(source) = sources.get(&job.incarnation).filter(|s| !s.archived) else {
                continue;
            };
            if drainable_page_with(read, Some(source), &job, media)?.is_some()
                || read_page(read, &source.id, &job.slug)?
                    .is_some_and(|p| p.deleted_at_us.is_none() && segmented(&p))
            {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `hasDrainableProjectionJob({ media })`: whether a job of a live inline page of an active
    /// source (with `media`, or a sealable image) is queued with a reason other than `rebuild_failed`.
    pub fn has_drainable_projection_job(&self, media: bool) -> Result<bool> {
        let read = self.read()?;
        let read = &*read;
        let sources = sources_by_incarnation(read)?;
        for job in all_jobs(read)? {
            if job.record.reason != "rebuild_failed"
                && drainable_page_with(read, sources.get(&job.incarnation), &job, media)?.is_some()
            {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};

    fn job_ref(key: &ProjectionJobKey) -> super::super::projection_queue::ProjectionJobRef {
        super::super::projection_queue::ProjectionJobRef {
            source_incarnation: key.source_incarnation.clone(),
            slug: key.slug.clone(),
            revision: key.revision.clone(),
        }
    }

    fn put(store: &Store, slug: &str) {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        let options = PutPageOptions {
            index: Some(false),
            ..PutPageOptions::default()
        };
        store.put_page(slug, &input, &options).unwrap();
    }

    fn filter(v: Value) -> QueuedProjectionFilter {
        serde_json::from_value(v).unwrap()
    }

    fn slugs(rows: &[Value]) -> Vec<&str> {
        rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
    }

    #[test]
    fn an_image_page_is_sealable_only_with_the_importer_chunk_at_the_safe_fence() {
        let store = crate::test_support::store();
        let image = |slug: &str, body: &str, chunk: &str, version: i16| {
            let input = PageInput {
                page_type: "note".into(),
                title: slug.into(),
                compiled_truth: body.into(),
                page_kind: Some("image".into()),
                ..PageInput::default()
            };
            let options = PutPageOptions {
                index: Some(false),
                ..PutPageOptions::default()
            };
            store.put_page(slug, &input, &options).unwrap();
            let c: crate::chunks::ChunkInput = serde_json::from_value(json!({
                "chunk_index": 0, "chunk_text": chunk, "chunk_source": "image_asset", "modality": "image" })).unwrap();
            store
                .upsert_chunks(slug, &[c], &Default::default())
                .unwrap();
            store
                .set_chunker_version(slug, &version.to_string(), None)
                .unwrap();
        };
        image("sealable", "Photo of a heron", "Photo of a heron", 4);
        image("changed", "Photo of an ibex", "an older caption", 4);
        image("pre-fence", "Photo of a lynx", "Photo of a lynx", 3);
        let backlog = store
            .read_projection_backlog(&crate::link_queries::CoverageScope::default())
            .unwrap();
        assert_eq!((backlog.sealable, backlog.reimport), (1, 2));
        assert!(store.has_drainable_projection_job(true).unwrap());
        assert!(!store.has_drainable_projection_job(false).unwrap());
        assert_eq!(
            slugs(&store.list_projection_drain_preview(10.0).unwrap()),
            ["sealable"]
        );
    }

    #[test]
    fn the_drain_reads_count_the_queue_and_list_its_rows() {
        let store = crate::test_support::store();
        for slug in ["a", "b"] {
            put(&store, slug);
        }
        let backlog = store
            .read_projection_backlog(&crate::link_queries::CoverageScope::default())
            .unwrap();
        assert_eq!(backlog.pending, 2);
        assert!(backlog.oldest.is_some_and(|o| o >= 0.0));
        assert!(backlog.as_of.ends_with("+00"));
        let other: crate::link_queries::CoverageScope =
            serde_json::from_value(json!({ "sourceId": "other" })).unwrap();
        let none = store.read_projection_backlog(&other).unwrap();
        assert_eq!((none.pending, none.oldest), (0, None));
        let preview = store.list_projection_drain_preview(1.0).unwrap();
        assert_eq!(slugs(&preview), ["a"]);
        assert_eq!(store.list_projection_drain_preview(0.0).unwrap().len(), 1);
        assert!(store.has_queued_projection_work(false).unwrap());
        // The drain clock: a run start reads back as `now()::text`, and the clock is not past a later time.
        let start = store.read_drain_run_start().unwrap();
        assert!(start.ends_with("+00"));
        assert!(!store.is_drain_clock_past("2999-01-01 00:00:00+00").unwrap());
        assert!(store.is_drain_clock_past("2000-01-01T00:00:00Z").unwrap());
        assert!(store.is_drain_clock_past("not a time").is_err());
    }

    #[test]
    fn the_listing_walks_live_inline_pages_and_applies_its_filters() {
        let store = crate::test_support::store();
        for slug in ["a", "b", "c"] {
            put(&store, slug);
        }
        let all = store
            .list_queued_page_projections(&filter(json!({ "limit": 10 })))
            .unwrap();
        assert_eq!(slugs(&all), ["a", "b", "c"]);
        assert_eq!(all[0]["source_id"], "default");
        assert_eq!(all[0]["page_kind"], "markdown");
        let picked = store
            .list_queued_page_projections(&filter(json!({
                "limit": 10, "pages": { "sourceId": "default", "slugs": ["c", "a"] }
            })))
            .unwrap();
        assert_eq!(slugs(&picked), ["a", "c"]);
        let elsewhere = store
            .list_queued_page_projections(&filter(json!({
                "limit": 10, "pages": { "sourceId": "other", "slugs": ["a"] }
            })))
            .unwrap();
        assert!(elsewhere.is_empty());
        let after = store
            .list_queued_page_projections(&filter(json!({ "limit": 10, "after": {
                "updated_at": all[0]["updated_at"], "source_incarnation": all[0]["source_incarnation"],
                "slug": "a",
            } })))
            .unwrap();
        assert_eq!(slugs(&after), ["b", "c"]);
        let one = store
            .list_queued_page_projections(&filter(json!({ "limit": 1 })))
            .unwrap();
        assert_eq!(slugs(&one), ["a"]);
        let none = store
            .list_queued_page_projections(&filter(
                json!({ "limit": 10, "reasons": ["rebuild_failed"] }),
            ))
            .unwrap();
        assert!(none.is_empty());
        let served = store
            .list_queued_page_projections(&filter(json!({ "limit": 10, "served": "answering" })))
            .unwrap();
        assert!(served.is_empty());
        let waiting = store
            .list_queued_page_projections(&filter(json!({ "limit": 10, "served": "waiting" })))
            .unwrap();
        assert_eq!(waiting.len(), 3);
        assert!(store.has_drainable_projection_job(false).unwrap());
    }

    #[test]
    fn the_window_probe_finds_each_candidates_source_and_live_page() {
        let store = crate::test_support::store();
        put(&store, "a");
        put(&store, "gone");
        let incarnation = store
            .list_queued_page_projections(&filter(json!({ "limit": 1 })))
            .unwrap()
            .remove(0)["source_incarnation"]
            .as_str()
            .unwrap()
            .to_uppercase();
        store.soft_delete_page("gone", Some("default")).unwrap();
        let candidate = |source_incarnation: &str, slug: &str| ProjectionWindowCandidate {
            source_incarnation: source_incarnation.into(),
            slug: slug.into(),
        };
        let rows = store
            .probe_projection_window_candidates(&[
                candidate(&incarnation, "a"),
                candidate(&incarnation, "gone"),
                candidate("00000000-0000-0000-0000-000000000001", "a"),
            ])
            .unwrap();
        assert_eq!(
            rows,
            [
                json!({ "i": 0, "source_id": "default", "archived": false, "page_kind": "markdown", "body_storage": "inline" }),
                json!({ "i": 1, "source_id": "default", "archived": false, "page_kind": null, "body_storage": null }),
                json!({ "i": 2, "source_id": null, "archived": null, "page_kind": null, "body_storage": null }),
            ]
        );
        assert!(
            store
                .probe_projection_window_candidates(&[candidate("nope", "a")])
                .is_err()
        );
        assert!(
            store
                .probe_projection_window_candidates(&[])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_job_reads_and_deletes_only_at_its_revision() {
        let store = crate::test_support::store();
        put(&store, "a");
        let row = store
            .list_queued_page_projections(&filter(json!({ "limit": 1 })))
            .unwrap()
            .remove(0);
        let key = |revision: &str| ProjectionJobKey {
            source_incarnation: row["source_incarnation"].as_str().unwrap().to_owned(),
            slug: "a".into(),
            revision: revision.into(),
        };
        let stale = key("00000000-0000-0000-0000-000000000001");
        assert_eq!(store.read_projection_job_reason(&stale).unwrap(), None);
        store.delete_projection_job(&job_ref(&stale)).unwrap();
        let live = key(row["revision"].as_str().unwrap());
        assert_eq!(
            store.read_projection_job_reason(&live).unwrap().as_deref(),
            Some("canonical_change")
        );
        store.delete_projection_job(&job_ref(&live)).unwrap();
        assert_eq!(store.read_projection_job_reason(&live).unwrap(), None);
        assert!(!store.has_drainable_projection_job(false).unwrap());
    }

    #[test]
    fn a_deferred_replacement_reads_its_head_and_rows_and_clears_stale_vectors() {
        let store = crate::test_support::store();
        put(&store, "a");
        let head = store.read_projection_head("default", "a").unwrap();
        let page_id = head["id"].as_f64().unwrap();
        assert!(head["revision"].is_string());
        assert_eq!(head["sealed"], false);
        assert_eq!(
            store.read_projection_head("default", "none").unwrap(),
            Value::Null
        );
        assert!(!store.has_segmented_page("default", "a").unwrap());
        assert!(!store.has_segmented_page("default", "none").unwrap());
        let stored = |store: &Store| read_chunks(&*store.read().unwrap(), page_id as u64).unwrap();
        let chunk = |index: u32, text: &str, vector: bool| {
            let mut input = crate::chunks::ChunkInput {
                chunk_index: index,
                chunk_text: text.into(),
                ..crate::chunks::ChunkInput::default()
            };
            if vector {
                input
                    .rest
                    .insert("embedding".into(), json!(vec![0.5; 1536]));
                input.rest.insert("model".into(), json!("other-model"));
            }
            input
        };
        store
            .upsert_chunks(
                "a",
                &[
                    chunk(0, "one", true),
                    chunk(1, "twö!", false),
                    chunk(2, "three", true),
                ],
                &crate::chunks::UpsertChunksOptions::default(),
            )
            .unwrap();
        let rows = stored(&store);
        assert_eq!(rows.len(), 3);
        // Only the text chunk without a vector is pending; chars counts characters, not bytes.
        assert_eq!(
            store.count_pending_text_chunks(page_id).unwrap(),
            json!({ "chunks": 1, "chars": 4 })
        );
        let before = store.read_chunk_rows_fingerprint(page_id).unwrap();
        assert_eq!(before, store.read_chunk_rows_fingerprint(page_id).unwrap());
        let ids: Vec<f64> = rows.iter().map(|c| c.id as f64).collect();
        // Another model's vectors are stale; the chunk without a vector is not.
        assert_eq!(
            store
                .list_stale_chunk_vectors(page_id, Some("m"), 1536, &ids)
                .unwrap(),
            [rows[0].id, rows[2].id]
        );
        assert_eq!(
            store
                .list_stale_chunk_vectors(page_id, Some("other-model"), 1536, &ids[..1])
                .unwrap(),
            [rows[2].id]
        );
        store.delete_unkept_chunks(page_id, &ids[..2]).unwrap();
        assert_eq!(stored(&store).len(), 2);
        assert_ne!(before, store.read_chunk_rows_fingerprint(page_id).unwrap());
        store.clear_chunk_vectors(page_id, &ids[..1]).unwrap();
        let after = stored(&store);
        assert!(!after[0].embed.has_vector());
        assert!(after[0].embed.pending_since_us.is_some());
        assert_eq!(
            store.count_pending_text_chunks(page_id).unwrap(),
            json!({ "chunks": 2, "chars": 7 })
        );
        assert!(
            store
                .list_stale_chunk_vectors(page_id, Some("m"), 1536, &ids)
                .unwrap()
                .is_empty()
        );
        assert!(store.delete_unkept_chunks(1.5, &[]).is_err());
        assert!(store.count_pending_text_chunks(1.5).is_err());
    }
}
