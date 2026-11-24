//! The reads and writes of a segmented replace of a page body that ran through `executeRaw`, each the store's
//! answer to one statement of `src/core/engine-sql/segmented-writes.ts`: the chunk probe a replace's preparation and
//! a projection make, the stale-row probe and retirement of the projection, and the page row a projection builds.
//! Retirement is one `Store::write`.
//!
//! Owner: the segmented-write lane (`rust-engine/fingerprint-v3`, commit 8d915c28e8), which holds the whole module
//! (staging lock, re-chunk reads, trust stamp, derivation store). The functions here are copied from it unchanged.
//!
//! Stale rows. Postgres's `STALE_CHUNKS_SQL` names the chunk rows generation `g` (live occurrences
//! `live`) does not hold. A segment chunk of a live occurrence is stale when its generation is below
//! the newest generation at or below `g` among that occurrence's chunks; one of any other occurrence
//! is stale when its generation is at or below `g` (a later one is a staged write's). An inline chunk
//! (no segment) is always stale, as its NULL `body_generation` is in SQL.

use super::{BodyState, page_u64, read_body_state};
use crate::chunks::{ChunkRecord, delete_chunks_matching, read_chunks};
use crate::kv::KvRead;
use crate::pages::{PageRecord, read_page};
use crate::{Result, Store, StoreError};
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

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

fn segmented(state: Option<&BodyState>) -> Option<&BodyState> {
    state.filter(|s| s.body_storage == "segmented")
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
}

fn page_id_i64(id: u64) -> Result<i64> {
    i64::try_from(id).map_err(|_| StoreError::invalid("page id out of range"))
}

#[cfg(test)]
mod tests {
    use super::super::segment_chunk_tests::{chunk, published, second_generation};

    #[test]
    fn the_projection_page_reads_back_the_live_segmented_page() {
        let store = crate::test_support::store();
        let id = published(&store);
        assert_eq!(
            store
                .read_segmented_projection_page("default", "notes/none")
                .unwrap(),
            None
        );
        let page = store
            .read_segmented_projection_page("default", "notes/a")
            .unwrap()
            .unwrap();
        assert_eq!(
            (page.id, page.body_generation, page.body_bytes),
            (id, 1, Some(8))
        );
        assert_eq!(page.text_projection_revision, None);
        store
            .seal_segmented_page(id, "", Some(&page.knowledge_revision))
            .unwrap();
        let sealed = store
            .read_segmented_projection_page("default", "notes/a")
            .unwrap()
            .unwrap();
        assert_eq!(
            sealed.text_projection_revision.as_deref(),
            Some(page.knowledge_revision.as_str())
        );
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
}
