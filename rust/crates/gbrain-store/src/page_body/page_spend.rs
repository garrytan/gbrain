//! The page embedding reads around a page's lease (`src/core/engine-sql/page-spend.ts`): the chunk indexes of a page's
//! live rows with no vector (`listVectorlessChunkIndexes`).
//!
//! The name and argument list are the ones the segment-embed lane typed (origin/rust-engine/segment-embed, commits
//! 3ebc7aab90 and 76c4c4d3be); that lane's file of this name also serves the lease, the per-page spend ledgers and
//! the hold reads, which this branch does not move.

use super::page_u64;
use crate::chunks::{keyed_chunks, segmented};
use crate::pages::read_page_by_id;
use crate::{Result, Store};

impl Store {
    /// `listVectorlessChunkIndexes(pageId, column)`: the indexes of the page's live-body rows
    /// (`chunkGenerationFilter`) that hold no vector, in document order. A page id that names no
    /// page answers none. The store keeps one vector column, so the shell refuses any other
    /// `column` before this call.
    pub fn list_vectorless_chunk_indexes(&self, page_id: i64) -> Result<Vec<i64>> {
        let Some(id) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let Some(page) = read_page_by_id(&*read, id)? else {
            return Ok(Vec::new());
        };
        Ok(keyed_chunks(&*read, id, Some(segmented(&page)))?
            .into_iter()
            .map(|(_, chunk)| chunk)
            .filter(|c| !c.embed.has_vector())
            .map(|c| i64::from(c.chunk_index))
            .collect())
    }
}
