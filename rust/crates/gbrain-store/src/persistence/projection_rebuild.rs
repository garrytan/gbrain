//! The members a page projection rebuild calls (`src/core/engine-sql/projection-rebuild.ts`):
//! the queue listing it walks, the reason of one job (its delete is projection_queue.rs
//! `deleteProjectionJob`), the keep plan of the page's chunk
//! vectors and the drained probe of the rebuild statistics.
//!
//! A job is drainable when its page is a live inline page (Markdown or code, not segmented) of a
//! source that is not archived (`projectionJobProbes`). A segmented page has both body columns
//! NULL. The store keeps one vector column (`embedding`); the TypeScript members refuse any other
//! column and the drained probe's `media` option before they call the store.

use super::projection_queue::{
    Job, all_jobs, job_at_revision, parse_timestamptz, retry_ready, sources_by_incarnation,
};
use super::uuid_param;
use crate::chunks::read_chunks;
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

/// A job's exact key (`ProjectionJobKey`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionJobKey {
    pub source_incarnation: String,
    pub slug: String,
    pub revision: String,
}

/// The live inline page of an active source that `job` names (`projectionJobProbes`).
fn drainable_page(
    read: &dyn KvRead,
    source: Option<&SourceRecord>,
    job: &Job,
) -> Result<Option<PageRecord>> {
    let Some(source) = source.filter(|s| !s.archived) else {
        return Ok(None);
    };
    Ok(read_page(read, &source.id, &job.slug)?.filter(|p| {
        p.deleted_at_us.is_none()
            && (p.page_kind == "markdown" || p.page_kind == "code")
            && !(p.compiled_truth.is_null() && p.timeline.is_null())
    }))
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
fn text_current(chunk: &crate::chunks::ChunkRecord) -> bool {
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

    /// `hasDrainableProjectionJob()`: whether a job of a live inline page of an active source is
    /// queued with a reason other than `rebuild_failed`.
    pub fn has_drainable_projection_job(&self) -> Result<bool> {
        let read = self.read()?;
        let read = &*read;
        let sources = sources_by_incarnation(read)?;
        for job in all_jobs(read)? {
            if job.record.reason != "rebuild_failed"
                && drainable_page(read, sources.get(&job.incarnation), &job)?.is_some()
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
        assert!(store.has_drainable_projection_job().unwrap());
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
        assert!(!store.has_drainable_projection_job().unwrap());
    }
}
