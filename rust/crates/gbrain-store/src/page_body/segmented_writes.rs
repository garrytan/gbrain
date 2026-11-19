//! The reads and writes a streamed segmented import (`importStreamedMarkdownFile`) and the
//! segmented re-chunk (`runSegmentedRechunk`) make around the generation flip, each the store's
//! answer to one statement of `src/core/engine-sql/segmented-writes.ts`: the staging state a create
//! checks, the chunk rows a replace's dead preparation left, the live page and its seal, the chunk
//! probes and the stale-row retirement of the projection, the re-chunk's candidates, page row and
//! stored chunks, the page's `updated_at` restore, its trust stamp with the restore a fence
//! append makes of it, and the derivation driver's guarded store. Each write is one
//! `Store::write`.
//!
//! Stale rows. Postgres's `STALE_CHUNKS_SQL` names the chunk rows generation `g` (live occurrences
//! `live`) does not hold. A segment chunk of a live occurrence is stale when its generation is below
//! the newest generation at or below `g` among that occurrence's chunks; one of any other occurrence
//! is stale when its generation is at or below `g` (a later one is a staged write's). An inline chunk
//! (no segment) is always stale, as its NULL `body_generation` is in SQL.

use super::{
    BodyState, SegmentDerivationInput, StagingRecord, in_generation, manifest_rows, page_u64,
    prepare_derivations, put_derivations, read_body_state, staging_id_arg, staging_key,
};
use crate::chunks::{ChunkRecord, delete_chunks_matching, read_chunks};
use crate::env::iso;
use crate::kv::KvRead;
use crate::pages::{
    PageRecord, all_pages, read_page, read_page_by_id, write_page, write_page_setting_trust,
};
use crate::{Result, Store, StoreError, get_json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};

/// `readSegmentedLivePage(pageId)`: the live page a segmented write diffs against.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentedLivePageRow {
    pub id: i64,
    pub body_generation: i64,
    pub body_storage: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub body_flags: Option<Value>,
}

/// `readSegmentedProjectionPage(ref)`: the page row a projection builds from.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentedProjectionPage {
    pub id: i64,
    pub body_generation: i64,
    pub body_bytes: Option<i64>,
    pub knowledge_revision: String,
    pub text_projection_revision: Option<String>,
    pub title: String,
    pub frontmatter: Value,
    pub body_flags: Option<Value>,
    pub timeline_lead: Option<String>,
}

/// `readSegmentedRechunkPage(id)`: the page row a re-chunk plans and flips from.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentedRechunkPage {
    pub id: i64,
    pub slug: String,
    pub source_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub page_kind: String,
    pub frontmatter: Value,
    pub body_generation: i64,
    pub body_flags: Option<Value>,
    pub chunker_version: Option<i64>,
    pub contextual_retrieval_mode: Option<String>,
    pub corpus_generation: Option<String>,
    pub knowledge_revision: String,
    pub sealed: bool,
    pub updated_us: String,
    pub deleted_at: Option<String>,
    pub content_hash: Option<String>,
    pub body_bytes: Option<i64>,
    pub truth_bytes: Option<i64>,
    pub body_lines: Option<i64>,
    pub segment_count: Option<i64>,
    pub segmenter_version: Option<i64>,
    pub truth_lead: Option<String>,
    pub timeline_lead: Option<String>,
}

/// One row of `listOccurrenceChunks(pageId, occurrences)`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OccurrenceChunkRow {
    pub occurrence_id: u64,
    pub chunk_source: String,
    pub chunk_text: String,
    pub raw_byte_start: u64,
    pub raw_byte_end: u64,
    pub projected_byte_start: Option<Value>,
    pub projected_byte_end: Option<Value>,
}

/// `readPageTrustStamp(ref)`: the page's tier and write origin.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageTrustStamp {
    pub id: u64,
    pub trust_tier: String,
    pub write_origin: Option<Value>,
}

/// The page `readPageTrustStamp` names: a live page by `{ sourceId, slug }`, or any page by `{ id }`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageTrustRef {
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub id: Option<i64>,
}

/// The scope of `listSegmentedRechunkCandidates`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RechunkCandidateScope {
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub slug: Option<String>,
}

fn segmented(state: Option<&BodyState>) -> Option<&BodyState> {
    state.filter(|s| s.body_storage == "segmented")
}

fn sealed(page: &PageRecord) -> bool {
    page.text_projection_revision.as_deref() == Some(page.knowledge_revision.as_str())
}

fn page_by_id(read: &dyn KvRead, id: i64) -> Result<Option<PageRecord>> {
    Ok(page_u64(id)
        .map(|id| read_page_by_id(read, id))
        .transpose()?
        .flatten())
}

fn live_page(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Option<PageRecord>> {
    Ok(read_page(read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none()))
}

/// The ids of the page's chunk rows generation `generation` (live occurrences `live`) does not
/// hold, in Postgres's order: by occurrence, then the inline rows.
fn stale_chunk_ids(chunks: &[ChunkRecord], generation: i64, live: &[i64]) -> Vec<u64> {
    let live: HashSet<i64> = live.iter().copied().collect();
    let mut newest: BTreeMap<u64, u64> = BTreeMap::new();
    for place in chunks.iter().filter_map(|c| c.segment) {
        if i64::try_from(place.body_generation).is_ok_and(|g| g <= generation) {
            let slot = newest
                .entry(place.occurrence_id)
                .or_insert(place.body_generation);
            *slot = (*slot).max(place.body_generation);
        }
    }
    let mut by_occurrence: BTreeMap<u64, Vec<u64>> = BTreeMap::new();
    let mut inline = Vec::new();
    for chunk in chunks {
        let Some(place) = chunk.segment else {
            inline.push(chunk.id);
            continue;
        };
        let generation_of = i64::try_from(place.body_generation).unwrap_or(i64::MAX);
        let stale = if i64::try_from(place.occurrence_id).is_ok_and(|o| live.contains(&o)) {
            newest
                .get(&place.occurrence_id)
                .is_some_and(|bound| place.body_generation < *bound)
        } else {
            generation_of <= generation
        };
        if stale {
            by_occurrence
                .entry(place.occurrence_id)
                .or_default()
                .push(chunk.id);
        }
    }
    by_occurrence
        .into_values()
        .flatten()
        .chain(inline)
        .collect()
}

impl Store {
    /// `lockBodyStagingState(stagingId)`: the staging's state, `None` when no staging has that id.
    /// The store's writes are serialized, so the read needs no row lock.
    pub fn lock_body_staging_state(&self, staging_id: &str) -> Result<Option<String>> {
        let id = staging_id_arg(staging_id)?;
        let read = self.read()?;
        let staging: Option<StagingRecord> = get_json(&*read, &staging_key(&id))?;
        Ok(staging.map(|s| s.state))
    }

    /// `deleteUnstagedSegmentChunks(pageId, generation, keepIndexes)`: deletes the page's segment
    /// chunk rows of `generation` whose `chunk_index` is not in `keep_indexes` (a dead preparation's
    /// rows) and returns how many went.
    pub fn delete_unstaged_segment_chunks(
        &self,
        page_id: i64,
        generation: i64,
        keep_indexes: &[i64],
    ) -> Result<usize> {
        let Some(page) = page_u64(page_id) else {
            return Ok(0);
        };
        let keep: BTreeSet<i64> = keep_indexes.iter().copied().collect();
        self.write(|tx| {
            Ok(delete_chunks_matching(tx, page, &|c| {
                c.segment.is_some_and(|p| {
                    i64::try_from(p.body_generation).is_ok_and(|g| g == generation)
                }) && !keep.contains(&i64::from(c.chunk_index))
            })?
            .len())
        })
    }

    /// `readSegmentedLivePage(pageId)`: `None` when no page has that id (deleted pages included).
    pub fn read_segmented_live_page(&self, page_id: i64) -> Result<Option<SegmentedLivePageRow>> {
        let read = self.read()?;
        let Some(page) = page_by_id(&*read, page_id)? else {
            return Ok(None);
        };
        let state = read_body_state(&*read, page.id)?;
        let state = state.as_ref();
        Ok(Some(SegmentedLivePageRow {
            id: page_id,
            body_generation: state.map_or(0, |s| s.body_generation),
            body_storage: state.map_or_else(|| "inline".into(), |s| s.body_storage.clone()),
            title: page.title,
            page_type: page.page_type,
            body_flags: state.and_then(|s| s.body_flags.clone()),
        }))
    }

    /// `readSegmentedSealed(sourceId, slug)`: whether the live page's text projection is sealed at
    /// its revision; false when there is no live page.
    pub fn read_segmented_sealed(&self, source_id: &str, slug: &str) -> Result<bool> {
        let read = self.read()?;
        Ok(live_page(&*read, source_id, slug)?.is_some_and(|p| sealed(&p)))
    }

    /// `listChunkedOccurrences(pageId, occurrences, generation)`: the occurrences (input order,
    /// repeats kept) that have a segment chunk row at or below `generation`.
    pub fn list_chunked_occurrences(
        &self,
        page_id: i64,
        occurrences: &[i64],
        generation: i64,
    ) -> Result<Vec<i64>> {
        if occurrences.is_empty() {
            return Ok(Vec::new());
        }
        let Some(page) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let chunked: HashSet<u64> = read_chunks(&*read, page)?
            .iter()
            .filter_map(|c| c.segment)
            .filter(|p| i64::try_from(p.body_generation).is_ok_and(|g| g <= generation))
            .map(|p| p.occurrence_id)
            .collect();
        Ok(occurrences
            .iter()
            .copied()
            .filter(|o| u64::try_from(*o).is_ok_and(|o| chunked.contains(&o)))
            .collect())
    }

    /// `hasStaleSegmentChunks(pageId, generation, live)`: the page stores a chunk row generation
    /// `generation` does not hold (module docs).
    pub fn has_stale_segment_chunks(
        &self,
        page_id: i64,
        generation: i64,
        live: &[i64],
    ) -> Result<bool> {
        let Some(page) = page_u64(page_id) else {
            return Ok(false);
        };
        let read = self.read()?;
        Ok(!stale_chunk_ids(&read_chunks(&*read, page)?, generation, live).is_empty())
    }

    /// `retireStaleSegmentChunks(pageId, generation, live, maxRows)`: deletes up to `max_rows` of
    /// the stale chunk rows (module docs) and returns how many went.
    pub fn retire_stale_segment_chunks(
        &self,
        page_id: i64,
        generation: i64,
        live: &[i64],
        max_rows: i64,
    ) -> Result<usize> {
        let Some(page) = page_u64(page_id) else {
            return Ok(0);
        };
        let max = usize::try_from(max_rows).unwrap_or(0);
        self.write(|tx| {
            let ids: HashSet<u64> = stale_chunk_ids(&read_chunks(&*tx, page)?, generation, live)
                .into_iter()
                .take(max)
                .collect();
            if ids.is_empty() {
                return Ok(0);
            }
            Ok(delete_chunks_matching(tx, page, &|c| ids.contains(&c.id))?.len())
        })
    }

    /// `readSegmentedProjectionPage(sourceId, slug)`: the live segmented page, `None` otherwise.
    pub fn read_segmented_projection_page(
        &self,
        source_id: &str,
        slug: &str,
    ) -> Result<Option<SegmentedProjectionPage>> {
        let read = self.read()?;
        let Some(page) = live_page(&*read, source_id, slug)? else {
            return Ok(None);
        };
        let state = read_body_state(&*read, page.id)?;
        let Some(state) = segmented(state.as_ref()) else {
            return Ok(None);
        };
        Ok(Some(SegmentedProjectionPage {
            id: page_id_i64(page.id)?,
            body_generation: state.body_generation,
            body_bytes: state.body_bytes,
            knowledge_revision: page.knowledge_revision,
            text_projection_revision: page.text_projection_revision,
            title: page.title,
            frontmatter: Value::Object(page.frontmatter),
            body_flags: state.body_flags.clone(),
            timeline_lead: state.timeline_lead.clone(),
        }))
    }

    /// `listSegmentedRechunkCandidates(chunkerVersion, scope)`: ids of the live, sealed segmented
    /// pages whose chunker version is below `chunker_version`, by source, then slug. A page with no
    /// recorded version (NULL) is not one, as in SQL.
    pub fn list_segmented_rechunk_candidates(
        &self,
        chunker_version: i64,
        scope: &RechunkCandidateScope,
    ) -> Result<Vec<i64>> {
        let read = self.read()?;
        let mut found: Vec<(String, String, i64)> = Vec::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || !sealed(&page)
                || !page
                    .chunker_version
                    .is_some_and(|v| i64::from(v) < chunker_version)
                || scope
                    .source_id
                    .as_deref()
                    .is_some_and(|s| !s.is_empty() && s != page.source_id)
                || scope
                    .slug
                    .as_deref()
                    .is_some_and(|s| !s.is_empty() && s != page.slug)
            {
                continue;
            }
            if segmented(read_body_state(&*read, page.id)?.as_ref()).is_none() {
                continue;
            }
            found.push((page.source_id, page.slug, page_id_i64(page.id)?));
        }
        found.sort();
        Ok(found.into_iter().map(|(_, _, id)| id).collect())
    }

    /// `readSegmentedRechunkPage(id)`: the segmented page with that id (deleted pages included),
    /// `None` otherwise.
    pub fn read_segmented_rechunk_page(
        &self,
        page_id: i64,
    ) -> Result<Option<SegmentedRechunkPage>> {
        let read = self.read()?;
        let Some(page) = page_by_id(&*read, page_id)? else {
            return Ok(None);
        };
        let state = read_body_state(&*read, page.id)?;
        let Some(state) = segmented(state.as_ref()) else {
            return Ok(None);
        };
        Ok(Some(SegmentedRechunkPage {
            id: page_id,
            contextual_retrieval_mode: crate::aliases::contextual_retrieval_mode(&*read, page.id)?,
            corpus_generation: crate::aliases::corpus_generation(&*read, page.id)?,
            sealed: sealed(&page),
            updated_us: page.updated_at_us.to_string(),
            deleted_at: page.deleted_at_us.map(iso),
            slug: page.slug,
            source_id: page.source_id,
            title: page.title,
            page_type: page.page_type,
            page_kind: page.page_kind,
            frontmatter: Value::Object(page.frontmatter),
            body_generation: state.body_generation,
            body_flags: state.body_flags.clone(),
            chunker_version: page.chunker_version.map(i64::from),
            knowledge_revision: page.knowledge_revision,
            content_hash: page.content_hash,
            body_bytes: state.body_bytes,
            truth_bytes: state.truth_bytes,
            body_lines: state.body_lines,
            segment_count: state.segment_count,
            segmenter_version: state.segmenter_version,
            truth_lead: state.truth_lead.clone(),
            timeline_lead: state.timeline_lead.clone(),
        }))
    }

    /// `listOccurrenceChunks(pageId, occurrences)`: the visible chunk rows of those occurrences
    /// (Postgres's `chunkGenerationFilter`: at or below the page's generation, the occurrence in
    /// that generation's manifest), by occurrence, then local ordinal.
    pub fn list_occurrence_chunks(
        &self,
        page_id: i64,
        occurrences: &[i64],
    ) -> Result<Vec<OccurrenceChunkRow>> {
        let Some(page) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        if read_page_by_id(&*read, page)?.is_none() {
            return Ok(Vec::new());
        }
        let generation = read_body_state(&*read, page)?.map_or(0, |s| s.body_generation);
        let wanted: HashSet<i64> = occurrences.iter().copied().collect();
        let in_manifest: HashSet<i64> = manifest_rows(&*read, page)?
            .into_iter()
            .map(|(_, r)| r)
            .filter(|r| in_generation(r, generation))
            .map(|r| r.occurrence_id)
            .collect();
        let mut rows: Vec<(u64, u32, OccurrenceChunkRow)> = Vec::new();
        for chunk in read_chunks(&*read, page)? {
            let Some(place) = chunk.segment else { continue };
            let Ok(occurrence) = i64::try_from(place.occurrence_id) else {
                continue;
            };
            if !wanted.contains(&occurrence)
                || !in_manifest.contains(&occurrence)
                || !i64::try_from(place.body_generation).is_ok_and(|g| g <= generation)
            {
                continue;
            }
            let meta = |key: &str| chunk.meta.get(key).cloned();
            rows.push((
                place.occurrence_id,
                place.local_ordinal,
                OccurrenceChunkRow {
                    occurrence_id: place.occurrence_id,
                    projected_byte_start: meta("projected_byte_start"),
                    projected_byte_end: meta("projected_byte_end"),
                    chunk_source: chunk.chunk_source,
                    chunk_text: chunk.chunk_text,
                    raw_byte_start: place.raw_byte_start,
                    raw_byte_end: place.raw_byte_end,
                },
            ));
        }
        rows.sort_by_key(|(o, ordinal, _)| (*o, *ordinal));
        Ok(rows.into_iter().map(|(_, _, row)| row).collect())
    }

    /// `restorePageUpdatedAt(pageId, updatedUs)`: sets the page's `updated_at` to `updated_us`
    /// microseconds since the epoch (a re-chunk is not an edit). A missing page is a no-op.
    pub fn restore_page_updated_at(&self, page_id: i64, updated_us: &str) -> Result<()> {
        let micros: i64 = updated_us.parse().map_err(|_| {
            StoreError::invalid(format!(
                "restorePageUpdatedAt updatedUs: {updated_us:?} is not an integer"
            ))
        })?;
        self.write(|tx| {
            let Some(mut page) = page_by_id(&*tx, page_id)? else {
                return Ok(());
            };
            page.updated_at_us = micros;
            write_page(tx, &page)
        })
    }

    /// `storeSegmentDerivationRuns(pageId, generation, rows)`: the derivation driver's guarded
    /// store (`storeRuns` in `segment-derive.ts`). Inserts or replaces every row on `page_id` as
    /// `upsertSegmentDerivations` does, only while the page is segmented at `generation`; otherwise
    /// writes nothing and returns false. Postgres reads the page row `FOR SHARE` in the insert, so
    /// a purge, rewrite or demotion that moves the generation first leaves nothing written; one
    /// `Store::write` gives the same order. A missing page returns false.
    pub fn store_segment_derivation_runs(
        &self,
        page_id: i64,
        generation: i64,
        rows: &[SegmentDerivationInput],
    ) -> Result<bool> {
        let rows: Vec<SegmentDerivationInput> = rows
            .iter()
            .map(|row| SegmentDerivationInput {
                page_id,
                ..row.clone()
            })
            .collect();
        let prepared = prepare_derivations(&rows)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(page) = page_by_id(&*tx, page_id)? else {
                return Ok(false);
            };
            let live = read_body_state(&*tx, page.id)?
                .is_some_and(|s| s.body_storage == "segmented" && s.body_generation == generation);
            if !live || prepared.is_empty() {
                return Ok(live);
            }
            put_derivations(tx, &prepared, now)?;
            Ok(true)
        })
    }

    /// `readPageTrustStamp(ref)`: the page's `trust_tier` (`unknown` when none is stored) and
    /// `write_origin`. `{ sourceId, slug }` names a live page, `{ id }` any page.
    pub fn read_page_trust_stamp(&self, page: &PageTrustRef) -> Result<Option<PageTrustStamp>> {
        let read = self.read()?;
        let record = match (page.id, page.source_id.as_deref(), page.slug.as_deref()) {
            (Some(id), _, _) => page_by_id(&*read, id)?,
            (None, Some(source_id), Some(slug)) => live_page(&*read, source_id, slug)?,
            _ => {
                return Err(StoreError::invalid(
                    "readPageTrustStamp: name the page by id or by sourceId and slug",
                ));
            }
        };
        Ok(record.map(|p| PageTrustStamp {
            id: p.id,
            trust_tier: p.trust_tier.unwrap_or_else(|| "unknown".into()),
            write_origin: p.write_origin,
        }))
    }

    /// `restorePageTrustStamp(pageId, trustTier, writeOrigin)`: sets the page's tier and origin
    /// back to what a fence append read before its page write (`withPageTierKept`), through the
    /// trust stamp as PGLite's trigger runs it on that `UPDATE`: a lowering always holds, a raise
    /// holds only under a promotion that covers it (`gbrain.write_trust_promotion`) and is refused
    /// with no write trust declared. Nothing else of the page changes. A missing page is a no-op.
    pub fn restore_page_trust_stamp(
        &self,
        page_id: i64,
        trust_tier: &str,
        write_origin: Option<Value>,
    ) -> Result<()> {
        use crate::trust::TrustTier;
        let tier = TrustTier::parse(trust_tier).ok_or_else(|| {
            StoreError::invalid(format!(
                "restorePageTrustStamp trustTier: {trust_tier:?} is not a trust tier"
            ))
        })?;
        let write_origin = write_origin.filter(|origin| !origin.is_null());
        self.write(|tx| {
            let Some(mut page) = page_by_id(&*tx, page_id)? else {
                return Ok(());
            };
            page.trust_tier = (tier != TrustTier::Unknown).then(|| tier.as_str().to_owned());
            page.write_origin = write_origin.clone();
            write_page_setting_trust(tx, &page)
        })
    }
}

fn page_id_i64(id: u64) -> Result<i64> {
    i64::try_from(id).map_err(|_| StoreError::invalid("page id out of range"))
}

#[cfg(test)]
mod tests {
    use super::super::segment_chunk_tests::{
        STAGING, STAGING_2, chunk, flip, published, second_generation,
    };
    use super::*;
    use serde_json::json;

    fn revision(store: &Store, id: i64) -> (String, Option<String>) {
        let page = read_page_by_id(&*store.read().unwrap(), id as u64)
            .unwrap()
            .unwrap();
        (page.knowledge_revision, page.text_projection_revision)
    }

    #[test]
    fn the_staging_state_and_the_live_page_read_back() {
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .set_body_staging_state(STAGING, "committed", &Default::default())
            .unwrap();
        assert_eq!(
            store.lock_body_staging_state(STAGING).unwrap().as_deref(),
            Some("committed")
        );
        assert_eq!(
            store
                .lock_body_staging_state("99999999-9999-4999-8999-999999999999")
                .unwrap(),
            None
        );
        let live = store.read_segmented_live_page(id).unwrap().unwrap();
        assert_eq!(
            (
                live.body_generation,
                live.body_storage.as_str(),
                live.title.as_str()
            ),
            (1, "segmented", "Flipped")
        );
        assert_eq!(store.read_segmented_live_page(9_999).unwrap(), None);
        assert!(!store.read_segmented_sealed("default", "notes/a").unwrap());
        let (rev, _) = revision(&store, id);
        store.seal_segmented_page(id, "", Some(&rev)).unwrap();
        assert!(store.read_segmented_sealed("default", "notes/a").unwrap());
        assert!(
            !store
                .read_segmented_sealed("default", "notes/none")
                .unwrap()
        );
        let page = store
            .read_segmented_projection_page("default", "notes/a")
            .unwrap()
            .unwrap();
        assert_eq!(
            (page.id, page.body_generation, page.body_bytes),
            (id, 1, Some(8))
        );
        let rechunk = store.read_segmented_rechunk_page(id).unwrap().unwrap();
        assert!(rechunk.sealed && rechunk.deleted_at.is_none());
        assert_eq!(rechunk.body_lines, Some(2));
    }

    #[test]
    fn chunk_probes_and_retirement_follow_the_stale_rows_of_postgres() {
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .stage_segment_chunks(id, 1, &[chunk(1, 0, "one"), chunk(2, 0, "two")])
            .unwrap();
        second_generation(&store, id);
        assert_eq!(
            store
                .list_chunked_occurrences(id, &[2, 1, 9, 2, 3], 1)
                .unwrap(),
            vec![2, 1, 2]
        );
        assert_eq!(
            store.list_chunked_occurrences(id, &[3, 9], 2).unwrap(),
            vec![3, 9]
        );
        // At generation 1 every row of it is live; the staged generation-2 rows are above it.
        assert!(!store.has_stale_segment_chunks(id, 1, &[1, 2]).unwrap());
        // At generation 2 (live 1 and 3) occurrence 2's row and the orphan occurrence 9's are stale.
        assert!(store.has_stale_segment_chunks(id, 2, &[1, 3]).unwrap());
        assert_eq!(
            store
                .retire_stale_segment_chunks(id, 2, &[1, 3], 1)
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .retire_stale_segment_chunks(id, 2, &[1, 3], 10)
                .unwrap(),
            1
        );
        assert_eq!(
            store
                .retire_stale_segment_chunks(id, 2, &[1, 3], 10)
                .unwrap(),
            0
        );
        assert!(!store.has_stale_segment_chunks(id, 2, &[1, 3]).unwrap());
        assert_eq!(
            store
                .list_chunked_occurrences(id, &[1, 2, 3, 9], 2)
                .unwrap(),
            vec![1, 3]
        );
    }

    #[test]
    fn a_dead_preparations_rows_go_and_the_staged_ones_stay() {
        let store = crate::test_support::store();
        let id = published(&store);
        let staged = store
            .stage_segment_chunks(id, 2, &[chunk(1, 0, "dead")])
            .unwrap();
        second_generation(&store, id);
        let indexes: Vec<i64> = read_chunks(&*store.read().unwrap(), id as u64)
            .unwrap()
            .iter()
            .filter(|c| c.segment.is_some_and(|p| p.occurrence_id == 3))
            .map(|c| i64::from(c.chunk_index))
            .collect();
        assert_eq!(staged.len(), 1);
        assert_eq!(
            store
                .delete_unstaged_segment_chunks(id, 2, &indexes)
                .unwrap(),
            2
        );
        let left: Vec<u64> = read_chunks(&*store.read().unwrap(), id as u64)
            .unwrap()
            .iter()
            .filter_map(|c| c.segment.map(|p| p.occurrence_id))
            .collect();
        assert_eq!(left, vec![3]);
    }

    #[test]
    fn a_materializing_flip_keeps_the_revision_and_the_seal_and_any_other_flip_advances_it() {
        let store = crate::test_support::store();
        let id = published(&store);
        let (rev, _) = revision(&store, id);
        store.seal_segmented_page(id, "", Some(&rev)).unwrap();
        second_generation(&store, id);
        let mut input = flip(id, 1, STAGING_2, 9, json!({"closeOccurrences": [2]}));
        input.keep_revision = Some(rev.clone());
        store.flip_body_generation(&input).unwrap();
        assert_eq!(revision(&store, id), (rev.clone(), Some(rev.clone())));
        assert_eq!(
            store
                .read_segmented_rechunk_page(id)
                .unwrap()
                .unwrap()
                .body_generation,
            2
        );

        // A setting naming another revision, or a flip that changes the title, advances it.
        let store = crate::test_support::store();
        let id = published(&store);
        let (rev, _) = revision(&store, id);
        second_generation(&store, id);
        let mut input = flip(
            id,
            1,
            STAGING_2,
            9,
            json!({"closeOccurrences": [2], "meta": {"type": "note", "title": "Renamed"}}),
        );
        input.keep_revision = Some(rev.clone());
        store.flip_body_generation(&input).unwrap();
        let (after, sealed) = revision(&store, id);
        assert_ne!(after, rev);
        assert_eq!(sealed, None);
    }

    #[test]
    fn rechunk_candidates_are_the_live_sealed_segmented_pages_below_the_version() {
        let store = crate::test_support::store();
        let id = published(&store);
        assert!(
            store
                .list_segmented_rechunk_candidates(4, &RechunkCandidateScope::default())
                .unwrap()
                .is_empty()
        );
        let (rev, _) = revision(&store, id);
        store.seal_segmented_page(id, "", Some(&rev)).unwrap();
        let version = store
            .read_segmented_rechunk_page(id)
            .unwrap()
            .unwrap()
            .chunker_version
            .unwrap();
        assert_eq!(
            store
                .list_segmented_rechunk_candidates(version + 1, &RechunkCandidateScope::default())
                .unwrap(),
            vec![id]
        );
        assert!(
            store
                .list_segmented_rechunk_candidates(version, &RechunkCandidateScope::default())
                .unwrap()
                .is_empty()
        );
        let other = RechunkCandidateScope {
            slug: Some("notes/b".into()),
            source_id: None,
        };
        assert!(
            store
                .list_segmented_rechunk_candidates(version + 1, &other)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn listed_chunks_are_the_visible_rows_in_occurrence_order() {
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .stage_segment_chunks(
                id,
                1,
                &[
                    chunk(2, 1, "two-b"),
                    chunk(2, 0, "two-a"),
                    chunk(1, 0, "one"),
                ],
            )
            .unwrap();
        second_generation(&store, id);
        let texts: Vec<String> = store
            .list_occurrence_chunks(id, &[2, 1, 3, 9])
            .unwrap()
            .into_iter()
            .map(|r| r.chunk_text)
            .collect();
        assert_eq!(texts, vec!["one", "two-a", "two-b"]);
    }

    #[test]
    fn updated_at_restores_and_the_trust_stamp_reads_back() {
        let store = crate::test_support::store();
        let id = published(&store);
        store
            .restore_page_updated_at(id, "1700000000123456")
            .unwrap();
        let page = store.read_segmented_rechunk_page(id).unwrap().unwrap();
        assert_eq!(page.updated_us, "1700000000123456");
        assert!(store.restore_page_updated_at(id, "x").is_err());
        let by_slug = PageTrustRef {
            source_id: Some("default".into()),
            slug: Some("notes/a".into()),
            id: None,
        };
        let by_id = PageTrustRef {
            source_id: None,
            slug: None,
            id: Some(id),
        };
        let stamp = store.read_page_trust_stamp(&by_slug).unwrap().unwrap();
        assert_eq!(stamp.id, id as u64);
        assert_eq!(store.read_page_trust_stamp(&by_id).unwrap(), Some(stamp));
        assert!(
            store
                .read_page_trust_stamp(&PageTrustRef {
                    source_id: None,
                    slug: None,
                    id: None
                })
                .is_err()
        );
    }

    #[test]
    fn a_trust_restore_lowers_freely_raises_only_under_a_promotion_and_changes_nothing_else() {
        let store = crate::test_support::store();
        let id = published(&store);
        let by_id = PageTrustRef {
            source_id: None,
            slug: None,
            id: Some(id),
        };
        let stamp = |store: &Store| store.read_page_trust_stamp(&by_id).unwrap().unwrap();
        let page = store.read_segmented_rechunk_page(id).unwrap().unwrap();
        assert_eq!(stamp(&store).trust_tier, "unknown");
        // A raise with no write trust declared is refused and leaves the page alone.
        let err = store
            .restore_page_trust_stamp(id, "operator_curated", Some(json!({"channel": "owner"})))
            .unwrap_err();
        assert_eq!(err.code, crate::trust::TRUST_RAISE_REFUSED);
        assert_eq!(stamp(&store).trust_tier, "unknown");
        // Under a promotion that covers it, the raise holds with the restored origin.
        store
            .apply_write_trust(
                &["gbrain.write_trust_promotion".into()],
                &["operator_curated".into()],
            )
            .unwrap();
        store
            .restore_page_trust_stamp(id, "operator_curated", Some(json!({"channel": "owner"})))
            .unwrap();
        let raised = stamp(&store);
        assert_eq!(raised.trust_tier, "operator_curated");
        assert_eq!(raised.write_origin, Some(json!({"channel": "owner"})));
        store.clear_write_trust();
        // A lowering needs nothing; a null origin is stored as none.
        store
            .restore_page_trust_stamp(id, "agent_written", Some(Value::Null))
            .unwrap();
        let lowered = stamp(&store);
        assert_eq!(lowered.trust_tier, "agent_written");
        assert_eq!(lowered.write_origin, None);
        // Nothing else of the page moved: not its revision, its seal or its updated_at.
        assert_eq!(
            store.read_segmented_rechunk_page(id).unwrap().unwrap(),
            page
        );
        assert!(store.restore_page_trust_stamp(id, "nope", None).is_err());
        store
            .restore_page_trust_stamp(999_999, "agent_written", None)
            .unwrap();
    }

    #[test]
    fn a_guarded_derivation_store_writes_only_at_the_live_generation() {
        let store = crate::test_support::store();
        let id = published(&store);
        let row = |occ: i64, output: Value| -> SegmentDerivationInput {
            serde_json::from_value(json!({
                "pageId": 0, "kind": "links", "occurrenceId": occ, "version": 1,
                "segmentSha256": "ab".repeat(32), "contextHash": "cd".repeat(32), "state": "done",
                "output": output, "receipt": null,
            }))
            .unwrap()
        };
        let stored = |store: &Store| -> Vec<(i64, Value)> {
            store
                .read_segment_derivations(id, &Default::default())
                .unwrap()
                .into_iter()
                .map(|r| (r["occurrenceId"].as_i64().unwrap(), r["output"].clone()))
                .collect()
        };
        assert!(
            store
                .store_segment_derivation_runs(
                    id,
                    1,
                    &[row(1, json!({ "a": 1 })), row(2, json!({ "run": 1 }))]
                )
                .unwrap()
        );
        assert_eq!(
            stored(&store),
            vec![(1, json!({ "a": 1 })), (2, json!({ "run": 1 }))]
        );
        assert!(
            store
                .store_segment_derivation_runs(id, 1, &[row(1, json!({ "a": 2 }))])
                .unwrap()
        );
        assert_eq!(stored(&store)[0], (1, json!({ "a": 2 })));
        assert!(
            !store
                .store_segment_derivation_runs(id, 2, &[row(3, json!({}))])
                .unwrap()
        );
        assert!(
            !store
                .store_segment_derivation_runs(9_999, 1, &[row(3, json!({}))])
                .unwrap()
        );
        assert_eq!(stored(&store).len(), 2);
        second_generation(&store, id);
        store
            .flip_body_generation(&flip(id, 1, STAGING_2, 9, json!({"closeOccurrences": [2]})))
            .unwrap();
        assert!(
            !store
                .store_segment_derivation_runs(id, 1, &[row(3, json!({}))])
                .unwrap()
        );
        assert_eq!(stored(&store).len(), 2);
        let mut bad = row(4, json!({}));
        bad.kind = "nope".into();
        assert_eq!(
            store
                .store_segment_derivation_runs(id, 2, &[bad])
                .unwrap_err()
                .code,
            crate::error::CONSTRAINT_VIOLATION
        );
    }
}
