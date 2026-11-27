//! The page embedding reads around a page's lease (`src/core/engine-sql/page-spend.ts`): the chunk indexes of a page's
//! live rows with no vector (`listVectorlessChunkIndexes`).
//!
//! The name and argument list are the ones the segment-embed lane typed (origin/rust-engine/segment-embed, commits
//! 3ebc7aab90 and 76c4c4d3be); that lane's file of this name also serves the lease, the per-page spend ledgers and
//! the hold reads, which this branch does not move.

use super::{page_u64, segmented_embedding::visible_chunks};
use crate::pages::read_page_by_id;
use crate::{Result, Store};

impl Store {
    /// `listVectorlessChunkIndexes(pageId, column)`: the page's visible rows with no vector.
    pub fn list_vectorless_chunk_indexes(&self, page_id: i64) -> Result<Vec<i64>> {
        let Some(id) = page_u64(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        if read_page_by_id(&*read, id)?.is_none() {
            return Ok(Vec::new());
        }
        Ok(visible_chunks(&*read, id)?
            .into_iter()
            .filter(|c| !c.embed.has_vector())
            .map(|c| i64::from(c.chunk_index))
            .collect())
    }
}
