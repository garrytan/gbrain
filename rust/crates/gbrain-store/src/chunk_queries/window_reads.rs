//! The two chunk reads of `get_page` (`src/core/ops/get-page-body.ts`), as the members of
//! `src/core/engine-sql/page-window-chunks.ts` run them (rust/docs/store/page-window-chunks.md):
//! `readWindowChunk`, the chunk a `body: 'window'` read with `around_chunk_id` centers on, and
//! `countPageChunks`, the chunk and embedding counts of a `body: 'none'` read.
//!
//! Both read the chunks of the page's live body, `chunkGenerationFilter` (`chunks::in_live_body`):
//! an inline chunk of a page that is not segmented, or a segmented chunk at or below the page's body
//! generation whose occurrence is live. A page id with no page reads as no chunks, as the SQL's
//! `EXISTS (SELECT 1 FROM pages gp WHERE gp.id = page_id ...)` makes it. Nothing here writes.

use crate::Store;
use crate::chunks::{ChunkRecord, keyed_chunks, segmented};
use crate::error::Result;
use crate::kv::KvRead;
use crate::pages::read_page_by_id;
use serde_json::{Value, json};

/// The chunks of page `page_id` in its live body; none for a page id that names no page.
fn live_chunks(read: &dyn KvRead, page_id: i64) -> Result<Vec<ChunkRecord>> {
    if page_id < 0 {
        return Ok(Vec::new());
    }
    let Some(page) = read_page_by_id(read, page_id as u64)? else {
        return Ok(Vec::new());
    };
    Ok(keyed_chunks(read, page.id, Some(segmented(&page)))?
        .into_iter()
        .map(|(_, chunk)| chunk)
        .collect())
}

impl Store {
    /// `readWindowChunk(chunkId, pageId)`: `{ chunk_text, chunk_source, occurrence_id,
    /// projected_byte_start, projected_byte_end }` of text chunk `chunk_id` of the page, or none
    /// (`SELECT ... FROM content_chunks WHERE id = $1 AND page_id = $2 AND COALESCE(modality, 'text')
    /// = 'text' AND <chunkGenerationProbe>`). `occurrence_id` is null on an inline chunk, and a span
    /// end is null when the chunk has no stored span.
    pub fn read_window_chunk(&self, chunk_id: i64, page_id: i64) -> Result<Option<Value>> {
        if chunk_id < 0 {
            return Ok(None);
        }
        let chunk = live_chunks(&*self.read()?, page_id)?
            .into_iter()
            .find(|c| c.id == chunk_id as u64 && c.modality == "text");
        Ok(chunk.map(|c| {
            json!({
                "chunk_text": c.chunk_text,
                "chunk_source": c.chunk_source,
                "occurrence_id": c.segment.map_or(Value::Null, |place| json!(place.occurrence_id)),
                "projected_byte_start": c.meta.get("projected_byte_start").cloned().unwrap_or(Value::Null),
                "projected_byte_end": c.meta.get("projected_byte_end").cloned().unwrap_or(Value::Null),
            })
        }))
    }

    /// `countPageChunks(pageId)`: `{ total, embedded }`, the page's live-body chunks and how many
    /// of them have a vector (`count(*)`, `count(*) FILTER (WHERE embedded_at IS NOT NULL)`).
    pub fn count_page_chunks(&self, page_id: i64) -> Result<Value> {
        let chunks = live_chunks(&*self.read()?, page_id)?;
        let embedded = chunks
            .iter()
            .filter(|c| c.embed.embedded_at_us.is_some())
            .count();
        Ok(json!({ "total": chunks.len(), "embedded": embedded }))
    }
}

#[cfg(test)]
mod tests {
    use crate::chunks::{ChunkInput, UpsertChunksOptions};
    use crate::pages::{PageInput, PutPageOptions};
    use serde_json::{Map, json};

    fn input(index: u32, text: &str, start: u64, end: u64) -> ChunkInput {
        let mut rest = Map::new();
        rest.insert("projected_byte_start".into(), json!(start));
        rest.insert("projected_byte_end".into(), json!(end));
        ChunkInput {
            chunk_index: index,
            chunk_text: text.into(),
            chunk_source: Some("compiled_truth".into()),
            modality: None,
            rest,
        }
    }

    #[test]
    fn the_window_chunk_and_the_counts_answer_as_their_sql_does() {
        let store = crate::test_support::store();
        let page = PageInput {
            page_type: "note".into(),
            title: "Window".into(),
            compiled_truth: "alpha line\nbeta line\n".into(),
            ..PageInput::default()
        };
        let row = store
            .put_page("notes/window", &page, &PutPageOptions::default())
            .unwrap();
        let page_id = row["id"].as_i64().unwrap();
        store
            .upsert_chunks(
                "notes/window",
                &[input(0, "alpha line", 0, 10), input(1, "beta line", 11, 20)],
                &UpsertChunksOptions {
                    seal: true,
                    ..UpsertChunksOptions::default()
                },
            )
            .unwrap();
        let ids: Vec<i64> = store
            .get_chunks("notes/window", &Default::default())
            .unwrap()
            .iter()
            .map(|c| c["id"].as_i64().unwrap())
            .collect();
        assert_eq!(ids.len(), 2);
        assert_eq!(
            store.read_window_chunk(ids[1], page_id).unwrap(),
            Some(json!({
                "chunk_text": "beta line", "chunk_source": "compiled_truth", "occurrence_id": null,
                "projected_byte_start": 11, "projected_byte_end": 20,
            }))
        );
        // Another page's id, an unknown chunk, a negative id and an unknown page read as no chunk.
        assert_eq!(
            store.read_window_chunk(ids[1], page_id + 1000).unwrap(),
            None
        );
        assert_eq!(
            store.read_window_chunk(ids[1] + 1000, page_id).unwrap(),
            None
        );
        assert_eq!(store.read_window_chunk(-1, page_id).unwrap(), None);
        assert_eq!(
            store.count_page_chunks(page_id).unwrap(),
            json!({ "total": 2, "embedded": 0 })
        );
        assert_eq!(
            store.count_page_chunks(page_id + 1000).unwrap(),
            json!({ "total": 0, "embedded": 0 })
        );
        assert_eq!(
            store.count_page_chunks(-1).unwrap(),
            json!({ "total": 0, "embedded": 0 })
        );
    }
}
