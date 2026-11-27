//! Import members: the page and chunk statements a page import runs around its chunk write (the
//! TypeScript `engine-sql/pages.ts`, `engine-sql/chunks.ts` and `engine-sql/sources.ts`).
//!
//! Members: getPageSealState, refreshPageOrigin, setChunkerVersion, readSourceChunkerVersion,
//! setSourceChunkerVersion, writeTextProjectionSeal, moveChunkIndexes, getChunkReuseRows. `replaceDerivedAliases` is in
//! `aliases.rs`, with the other page alias rows.
//!
//! Each write member has an `_in` function that runs in the caller's write transaction, so a page
//! transaction can run it among its other steps; the `Store` method runs it in a write of its own.
//! PGLite's row locks (`FOR UPDATE`) are plain reads here: the store runs one write at a time.
//!
//! Keys: this family adds none. It reads and writes page records through `pages.rs`, the source
//! record's chunker stamp through `sources.rs`, chunk records
//! and postings under `keys::CHUNK` and `keys::POSTING`, chunk vectors through `embeddings.rs`,
//! the search timeline record, and the contextual retrieval state of `aliases.rs`.
//!
//! Where the store answers differently from PGLite (rust/docs/store/import-members.md):
//!
//! - `moveChunkIndexes` refuses a call that leaves a chunk at a negative index (`invalid_argument`):
//!   a chunk key holds an unsigned index. A parked index inside a call is fine. A Rust brain is
//!   never a managed publication, so its move budget is unbounded and every parked chunk lands.
//! - `getChunkReuseRows` compares the sha256 text hash the store keeps, not md5, and the store
//!   keeps no image or multimodal vector.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::chunks::{ChunkRecord, read_chunks};
use crate::embeddings::{put_chunk_vector, read_chunk_vector, remove_chunk_vector, text_hash};
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT};
use crate::kv::{KvRead, KvWrite};
use crate::pages::{
    assert_origin_unclaimed, read_page, read_page_by_id, record_search_timeline, write_page,
};
use crate::sources::{read_source, source_key};
use crate::{Result, Store, StoreError, keys, put_json};

const DEFAULT_SOURCE: &str = "default";

/// `refreshPageOrigin(slug, opts)`: the page's new origin; `source_uri` NULL keeps the stored one.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOriginRefresh {
    pub source_id: String,
    pub source_path: String,
    #[serde(default)]
    pub source_uri: Option<String>,
}

/// `writeTextProjectionSeal(slug, opts)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextProjectionSeal {
    pub source_id: String,
    pub revision: String,
    pub timeline_text: String,
}

/// One move of `moveChunkIndexes` (`ChunkMove` of `page-state/chunk-moves.ts`). `from` and
/// `vectorless` are the planner's; the statement reads the id, the target and the span.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChunkMove {
    pub id: u64,
    pub to: i64,
    #[serde(default)]
    pub projected_byte_start: Option<i64>,
    #[serde(default)]
    pub projected_byte_end: Option<i64>,
}

/// One row of `getChunkReuseRows` (`ChunkReuseRow` of `src/core/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChunkReuseRow {
    pub chunk_index: u32,
    pub embedding_input_hash: Option<String>,
    pub contextual_retrieval_mode: Option<String>,
    pub text_only: bool,
    pub unembedded: bool,
}

/// Postgres's text-to-`smallint` cast of the bound parameter (`String(version)` in JavaScript).
pub(crate) fn smallint(text: &str) -> Result<i16> {
    let body = text.trim();
    let digits = body.strip_prefix(['-', '+']).unwrap_or(body);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("invalid input syntax for type smallint: \"{text}\""),
        ));
    }
    body.parse::<i16>().map_err(|_| {
        StoreError::new(
            INVALID_ARGUMENT,
            format!("value \"{text}\" is out of range for type smallint"),
        )
    })
}

/// [`Store::set_chunker_version`] in the caller's write transaction.
pub(crate) fn set_chunker_version_in(
    tx: &mut dyn KvWrite,
    slug: &str,
    version: &str,
    source_id: &str,
) -> Result<()> {
    let version = smallint(version)?;
    let Some(mut page) = read_page(&*tx, source_id, slug)? else {
        return Ok(());
    };
    if page.chunker_version == Some(version) {
        return Ok(());
    }
    page.chunker_version = Some(version);
    write_page(tx, &page)
}

/// [`Store::refresh_page_origin`] in the caller's write transaction.
pub(crate) fn refresh_page_origin_in(
    tx: &mut dyn KvWrite,
    slug: &str,
    refresh: &PageOriginRefresh,
) -> Result<()> {
    let Some(mut page) = read_page(&*tx, &refresh.source_id, slug)? else {
        return Ok(());
    };
    if page.deleted_at_us.is_some() {
        return Ok(());
    }
    let uri = refresh
        .source_uri
        .clone()
        .or_else(|| page.source_uri.clone());
    if page.source_path.as_deref() == Some(refresh.source_path.as_str()) && page.source_uri == uri {
        return Ok(());
    }
    // PGLite's `pages_live_origin_key` refuses an origin another live page of the source holds.
    assert_origin_unclaimed(
        &*tx,
        &page.source_id,
        &page.slug,
        Some(&page),
        Some(&refresh.source_path),
    )?;
    page.source_path = Some(refresh.source_path.clone());
    page.source_uri = uri;
    write_page(tx, &page)
}

/// [`Store::write_text_projection_seal`] in the caller's write transaction.
pub(crate) fn write_text_projection_seal_in(
    tx: &mut dyn KvWrite,
    slug: &str,
    seal: &TextProjectionSeal,
) -> Result<()> {
    let revision = seal.revision.to_lowercase();
    if !crate::env::is_uuid(&revision) {
        return Err(StoreError::new(
            INVALID_ARGUMENT,
            format!("invalid input syntax for type uuid: \"{}\"", seal.revision),
        ));
    }
    let Some(mut page) = read_page(&*tx, &seal.source_id, slug)? else {
        return Ok(());
    };
    if page.knowledge_revision.to_lowercase() != revision {
        return Ok(());
    }
    page.text_projection_revision = Some(page.knowledge_revision.clone());
    write_page(tx, &page)?;
    record_search_timeline(
        tx,
        page.id,
        &page.knowledge_revision,
        &page.title,
        &seal.timeline_text,
    )
}

/// Where one chunk ends up after the waves: its index and its projected span.
#[derive(Debug, Clone, PartialEq)]
struct Place {
    index: i64,
    start: Option<Value>,
    end: Option<Value>,
}

fn place_of(record: &ChunkRecord) -> Place {
    Place {
        index: i64::from(record.chunk_index),
        start: record.meta.get("projected_byte_start").cloned(),
        end: record.meta.get("projected_byte_end").cloned(),
    }
}

/// [`Store::move_chunk_indexes`] in the caller's write transaction.
pub(crate) fn move_chunk_indexes_in(
    tx: &mut dyn KvWrite,
    page_id: u64,
    waves: &[Vec<ChunkMove>],
) -> Result<()> {
    if waves.iter().all(Vec::is_empty) {
        return Ok(());
    }
    let records: BTreeMap<u64, ChunkRecord> = read_chunks(&*tx, page_id)?
        .into_iter()
        .map(|record| (record.id, record))
        .collect();
    let mut places: BTreeMap<u64, Place> = records
        .iter()
        .map(|(id, record)| (*id, place_of(record)))
        .collect();
    for wave in waves {
        // `UPDATE ... FROM unnest(...)`: an id named twice in one wave moves once.
        let mut moved = BTreeSet::new();
        for m in wave {
            let Some(place) = places.get_mut(&m.id) else {
                continue;
            };
            if !moved.insert(m.id) {
                continue;
            }
            place.index = m.to;
            if m.to >= 0 {
                place.start = m.projected_byte_start.map(|n| json!(n));
                place.end = m.projected_byte_end.map(|n| json!(n));
            }
        }
        let mut seen = BTreeSet::new();
        if !places.values().all(|place| seen.insert(place.index)) {
            return Err(StoreError::new(
                CONSTRAINT_VIOLATION,
                "duplicate key value violates unique constraint \"idx_chunks_page_index\"",
            ));
        }
    }
    let mut changed = Vec::new();
    for (id, place) in &places {
        let record = &records[id];
        if *place == place_of(record) {
            continue;
        }
        let index = u32::try_from(place.index).map_err(|_| {
            StoreError::new(
                INVALID_ARGUMENT,
                format!(
                    "moveChunkIndexes: chunk {id} would end at index {}; the store keeps chunk indexes from 0",
                    place.index
                ),
            )
        })?;
        changed.push((record, index, place));
    }
    if changed.is_empty() {
        return Ok(());
    }
    // Every moved chunk leaves its old keys before any takes its new ones, so a swap never collides.
    let mut vectors = Vec::with_capacity(changed.len());
    for (record, _, _) in &changed {
        tx.delete(&keys::chunk(page_id, record.chunk_index))?;
        let vector = read_chunk_vector(&*tx, page_id, record.chunk_index)?;
        if vector.is_some() {
            remove_chunk_vector(tx, page_id, record.chunk_index)?;
        }
        vectors.push(vector);
    }
    for ((record, index, place), vector) in changed.into_iter().zip(vectors) {
        let mut moved = record.clone();
        moved.chunk_index = index;
        for (key, value) in [
            ("projected_byte_start", &place.start),
            ("projected_byte_end", &place.end),
        ] {
            match value {
                Some(value) => moved.meta.insert(key.into(), value.clone()),
                None => moved.meta.remove(key),
            };
        }
        put_json(tx, &keys::chunk(page_id, index), &moved)?;
        if let Some(stored) = vector {
            put_chunk_vector(
                tx,
                page_id,
                index,
                &stored.model,
                stored.embedded_at_us,
                &stored.vector,
            )?;
        }
    }
    Ok(())
}

/// The seal state of a page by id: `None` when it is gone, deleted or segmented.
fn page_seal_state(read: &dyn KvRead, page_id: u64) -> Result<Option<i16>> {
    let Some(page) = read_page_by_id(read, page_id)? else {
        return Ok(None);
    };
    let segmented = page.compiled_truth.is_null() && page.timeline.is_null();
    if page.deleted_at_us.is_some() || segmented {
        return Ok(None);
    }
    // A record written before the store recorded a version reads as PGLite's new-page default, 0.
    Ok(Some(page.chunker_version.unwrap_or(0)))
}

fn chunk_reuse_rows(read: &dyn KvRead, slug: &str, source_id: &str) -> Result<Vec<ChunkReuseRow>> {
    let Some(page) = read_page(read, source_id, slug)? else {
        return Ok(Vec::new());
    };
    let mode = crate::aliases::contextual_retrieval_mode(read, page.id)?;
    let mut rows: Vec<ChunkReuseRow> = read_chunks(read, page.id)?
        .into_iter()
        .map(|chunk| {
            let embed = &chunk.embed;
            ChunkReuseRow {
                chunk_index: chunk.chunk_index,
                text_only: embed.text_hash.as_deref()
                    == Some(text_hash(&chunk.chunk_text).as_str()),
                unembedded: !embed.has_vector()
                    && embed.input_hash.is_none()
                    && embed.text_hash.is_none(),
                embedding_input_hash: embed.input_hash.clone(),
                contextual_retrieval_mode: mode.clone(),
            }
        })
        .collect();
    rows.sort_by_key(|row| row.chunk_index);
    Ok(rows)
}

impl Store {
    /// `getPageSealState(pageId)`: `Some(chunker_version)` of a live, unsegmented page, a page
    /// with none reading 0; `None` when the page is gone, soft deleted or segmented.
    pub fn get_page_seal_state(&self, page_id: u64) -> Result<Option<i16>> {
        page_seal_state(&*self.read()?, page_id)
    }

    /// `refreshPageOrigin(slug, { sourceId, sourcePath, sourceUri? })`: sets a live page's
    /// `source_path` and, when given, `source_uri`. A missing or soft-deleted page, or one that
    /// already holds both, changes nothing. An origin another live page of the source holds is
    /// refused with `origin_claimed`, as `pages_live_origin_key` refuses it.
    pub fn refresh_page_origin(&self, slug: &str, refresh: &PageOriginRefresh) -> Result<()> {
        self.write(|tx| refresh_page_origin_in(tx, slug, refresh))
    }

    /// `setChunkerVersion(slug, version, { sourceId })`: stamps the page's chunker version, live
    /// or soft deleted. `version` is the parameter as JavaScript binds it (`String(version)`), cast
    /// to `smallint` as Postgres casts it. A missing page changes nothing.
    pub fn set_chunker_version(
        &self,
        slug: &str,
        version: &str,
        source_id: Option<&str>,
    ) -> Result<()> {
        let source_id = source_id.unwrap_or(DEFAULT_SOURCE);
        self.write(|tx| set_chunker_version_in(tx, slug, version, source_id))
    }

    /// `readSourceChunkerVersion(sourceId)`: the chunker version the source's last full sync
    /// stamped, or `None` before the first stamp and for an unknown source.
    pub fn read_source_chunker_version(&self, source_id: &str) -> Result<Option<String>> {
        Ok(read_source(&*self.read()?, source_id)?.and_then(|r| r.chunker_version))
    }

    /// `setSourceChunkerVersion(sourceId, version)`: stamps the source's chunker version. An
    /// unknown source changes nothing. Returns whether the source exists.
    pub fn set_source_chunker_version(&self, source_id: &str, version: &str) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, source_id)? else {
                return Ok(false);
            };
            record.chunker_version = Some(version.to_owned());
            put_json(tx, &source_key(source_id), &record)?;
            Ok(true)
        })
    }

    /// `writeTextProjectionSeal(slug, { sourceId, revision, timelineText })`: when the page's
    /// revision is `revision`, seals its text projection there and records `timelineText` as the
    /// timeline its keyword vector reads. A page whose revision moved on, or a missing page,
    /// changes nothing; a revision that is not a uuid is refused, as the `::uuid` cast refuses it.
    pub fn write_text_projection_seal(&self, slug: &str, seal: &TextProjectionSeal) -> Result<()> {
        self.write(|tx| write_text_projection_seal_in(tx, slug, seal))
    }

    /// `moveChunkIndexes(pageId, waves)`: moves chunks of the page, wave by wave, to new indexes
    /// with their postings and vectors. A landed chunk takes the move's span (NULL when the move
    /// has none); a parked one (negative target) keeps its own. An id the page does not hold is
    /// ignored. A wave that leaves two chunks at one index is refused (`constraint_violation`, the
    /// unique index); so is a call that leaves a chunk parked (`invalid_argument`, module docs).
    pub fn move_chunk_indexes(&self, page_id: u64, waves: &[Vec<ChunkMove>]) -> Result<()> {
        self.write(|tx| move_chunk_indexes_in(tx, page_id, waves))
    }

    /// `getChunkReuseRows(slug, { sourceId })`: every stored chunk of the page, soft deleted or
    /// not, by chunk index, with the flags the import's vector-reuse gate reads.
    pub fn get_chunk_reuse_rows(
        &self,
        slug: &str,
        source_id: Option<&str>,
    ) -> Result<Vec<ChunkReuseRow>> {
        chunk_reuse_rows(&*self.read()?, slug, source_id.unwrap_or(DEFAULT_SOURCE))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunks::{ChunkInput, UpsertChunksOptions};
    use crate::error::ORIGIN_CLAIMED;
    use crate::pages::PageInput;

    fn put(store: &Store, slug: &str, source_path: Option<&str>) -> u64 {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: format!("{slug} body"),
            source_path: source_path.map(str::to_owned),
            ..Default::default()
        };
        let page = store
            .put_page(
                slug,
                &input,
                // As the TypeScript `putPage` writes it: no chunks and no seal.
                &crate::pages::PutPageOptions {
                    index: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        page["id"].as_u64().unwrap()
    }

    fn chunk(index: u32, text: &str, extra: Value) -> ChunkInput {
        let mut input = ChunkInput {
            chunk_index: index,
            chunk_text: text.into(),
            ..Default::default()
        };
        if let Value::Object(map) = extra {
            input.rest = map;
        }
        input
    }

    fn seal(store: &Store, slug: &str, chunks: Vec<ChunkInput>) {
        let options = UpsertChunksOptions {
            seal: true,
            ..Default::default()
        };
        store.upsert_chunks(slug, &chunks, &options).unwrap();
    }

    fn page(store: &Store, slug: &str) -> crate::pages::PageRecord {
        read_page(&*store.read().unwrap(), DEFAULT_SOURCE, slug)
            .unwrap()
            .unwrap()
    }

    /// `(index, text, span start, has vector)` of each stored chunk, by index.
    fn layout(store: &Store, page_id: u64) -> Vec<(u32, String, Option<Value>, bool)> {
        let read = store.read().unwrap();
        let mut out: Vec<_> = read_chunks(&*read, page_id)
            .unwrap()
            .into_iter()
            .map(|c| {
                let vector = read_chunk_vector(&*read, page_id, c.chunk_index)
                    .unwrap()
                    .is_some();
                (
                    c.chunk_index,
                    c.chunk_text,
                    c.meta.get("projected_byte_start").cloned(),
                    vector,
                )
            })
            .collect();
        out.sort_by_key(|row| row.0);
        out
    }

    /// The chunk index keyword search finds `term` at on page `page_id` (the live keyword index).
    fn postings(store: &Store, term: &str, page_id: u64) -> Vec<u32> {
        store
            .search_keyword(term, &crate::search::SearchOptions::default())
            .unwrap()
            .iter()
            .filter(|row| row["page_id"].as_u64() == Some(page_id))
            .map(|row| row["chunk_index"].as_u64().unwrap() as u32)
            .collect()
    }

    #[test]
    fn smallint_matches_the_postgres_cast() {
        assert_eq!(smallint("4").unwrap(), 4);
        assert_eq!(smallint("-3").unwrap(), -3);
        assert_eq!(smallint("32767").unwrap(), 32767);
        assert_eq!(smallint("-32768").unwrap(), -32768);
        let range = smallint("40000").unwrap_err();
        assert_eq!(range.code, INVALID_ARGUMENT);
        assert_eq!(
            range.message,
            "value \"40000\" is out of range for type smallint"
        );
        assert_eq!(
            smallint("1.5").unwrap_err().message,
            "invalid input syntax for type smallint: \"1.5\""
        );
        for bad in ["", "-", "NaN", "Infinity", "1e+21"] {
            assert!(
                smallint(bad)
                    .unwrap_err()
                    .message
                    .starts_with("invalid input syntax")
            );
        }
    }

    #[test]
    fn seal_state_reads_zero_until_a_version_is_set_and_none_for_a_gone_page() {
        let store = crate::test_support::store();
        let id = put(&store, "notes/a", None);
        assert_eq!(store.get_page_seal_state(id).unwrap(), Some(0));
        assert_eq!(store.get_page_seal_state(id + 99).unwrap(), None);
        store.set_chunker_version("notes/a", "4", None).unwrap();
        assert_eq!(store.get_page_seal_state(id).unwrap(), Some(4));
        store
            .set_chunker_version("notes/a", "-3", Some("default"))
            .unwrap();
        assert_eq!(store.get_page_seal_state(id).unwrap(), Some(-3));
        store
            .set_chunker_version("notes/missing", "4", None)
            .unwrap();
        let err = store
            .set_chunker_version("notes/a", "40000", None)
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
        assert_eq!(store.get_page_seal_state(id).unwrap(), Some(-3));
        store.soft_delete_page("notes/a", None).unwrap();
        assert_eq!(store.get_page_seal_state(id).unwrap(), None);
        // The stamp reaches a soft-deleted page too.
        store.set_chunker_version("notes/a", "2", None).unwrap();
        assert_eq!(page(&store, "notes/a").chunker_version, Some(2));
    }

    #[test]
    fn refresh_origin_sets_a_live_page_and_keeps_the_uri_when_none_is_given() {
        let store = crate::test_support::store();
        put(&store, "notes/a", None);
        put(&store, "notes/b", Some("b.md"));
        let refresh = |path: &str, uri: Option<&str>| PageOriginRefresh {
            source_id: DEFAULT_SOURCE.into(),
            source_path: path.into(),
            source_uri: uri.map(str::to_owned),
        };
        store
            .refresh_page_origin("notes/a", &refresh("a.md", Some("file://a")))
            .unwrap();
        store
            .refresh_page_origin("notes/a", &refresh("c.md", None))
            .unwrap();
        let a = page(&store, "notes/a");
        assert_eq!(a.source_path.as_deref(), Some("c.md"));
        assert_eq!(a.source_uri.as_deref(), Some("file://a"));
        let claimed = store
            .refresh_page_origin("notes/a", &refresh("b.md", None))
            .unwrap_err();
        assert_eq!(claimed.code, ORIGIN_CLAIMED);
        store
            .refresh_page_origin("notes/zz", &refresh("z.md", None))
            .unwrap();
        store.soft_delete_page("notes/a", None).unwrap();
        store
            .refresh_page_origin("notes/a", &refresh("d.md", None))
            .unwrap();
        assert_eq!(page(&store, "notes/a").source_path.as_deref(), Some("c.md"));
    }

    #[test]
    fn text_seal_lands_only_at_the_current_revision() {
        let store = crate::test_support::store();
        put(&store, "notes/a", None);
        let before = page(&store, "notes/a");
        let timeline = |store: &Store| {
            crate::pages::search_timeline(&*store.read().unwrap(), before.id)
                .unwrap()
                .map(|t| t.timeline)
        };
        let seal = |rev: &str| TextProjectionSeal {
            source_id: DEFAULT_SOURCE.into(),
            revision: rev.into(),
            timeline_text: "a timeline".into(),
        };
        let bad = store
            .write_text_projection_seal("notes/a", &seal("nope"))
            .unwrap_err();
        assert_eq!(bad.code, INVALID_ARGUMENT);
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
        store
            .write_text_projection_seal("notes/a", &seal("f0000000-0000-4000-8000-0000000000f1"))
            .unwrap();
        assert_eq!(timeline(&store), None, "a stale revision writes nothing");
        assert_eq!(
            page(&store, "notes/a").text_projection_revision,
            before.text_projection_revision
        );
        store
            .write_text_projection_seal("notes/a", &seal(&before.knowledge_revision.to_uppercase()))
            .unwrap();
        assert_eq!(
            page(&store, "notes/a").text_projection_revision.as_deref(),
            Some(before.knowledge_revision.as_str())
        );
        assert_eq!(timeline(&store).as_deref(), Some("a timeline"));
    }

    #[test]
    fn moves_carry_postings_vectors_and_spans_through_a_parked_swap() {
        let store = crate::test_support::store();
        let id = put(&store, "notes/a", None);
        let dims = crate::chunks::embedding_dimensions(&*store.read().unwrap()).unwrap();
        let vector = json!(vec![0.1; dims]);
        seal(
            &store,
            "notes/a",
            vec![
                chunk(
                    0,
                    "alpha zero",
                    json!({ "embedding": vector, "model": "m", "projected_byte_start": 1 }),
                ),
                chunk(1, "beta one", json!({})),
            ],
        );
        let ids: Vec<u64> = {
            let mut chunks = read_chunks(&*store.read().unwrap(), id).unwrap();
            chunks.sort_by_key(|c| c.chunk_index);
            chunks.iter().map(|c| c.id).collect()
        };
        let mv = |id: u64, to: i64, start: Option<i64>| ChunkMove {
            id,
            to,
            projected_byte_start: start,
            projected_byte_end: None,
        };
        let dup = store
            .move_chunk_indexes(id, &[vec![mv(ids[0], 1, None)]])
            .unwrap_err();
        assert_eq!(dup.code, CONSTRAINT_VIOLATION);
        store
            .move_chunk_indexes(
                id,
                &[
                    vec![mv(ids[0], -2, Some(7))],
                    vec![mv(ids[1], 0, Some(5)), mv(999, 3, None)],
                    vec![mv(ids[0], 1, None)],
                ],
            )
            .unwrap();
        assert_eq!(
            layout(&store, id),
            vec![
                (0, "beta one".into(), Some(json!(5)), false),
                (1, "alpha zero".into(), None, true),
            ]
        );
        assert_eq!(postings(&store, "alpha", id), vec![1]);
        assert_eq!(postings(&store, "beta", id), vec![0]);
        let parked = store
            .move_chunk_indexes(id, &[vec![mv(ids[0], -5, None)]])
            .unwrap_err();
        assert_eq!(parked.code, INVALID_ARGUMENT);
        assert_eq!(layout(&store, id)[1].0, 1, "a refused call writes nothing");
        store.move_chunk_indexes(id, &[]).unwrap();
        store
            .move_chunk_indexes(id + 50, &[vec![mv(ids[0], 3, None)]])
            .unwrap();
    }

    #[test]
    fn reuse_rows_flag_text_only_and_unembedded_chunks() {
        let store = crate::test_support::store();
        put(&store, "notes/a", None);
        let dims = crate::chunks::embedding_dimensions(&*store.read().unwrap()).unwrap();
        seal(
            &store,
            "notes/a",
            vec![
                chunk(1, "beta one", json!({})),
                chunk(
                    0,
                    "alpha zero",
                    json!({ "embedding": vec![0.1; dims], "model": "m", "embedding_input_hash": "h0" }),
                ),
            ],
        );
        let rows = store.get_chunk_reuse_rows("notes/a", None).unwrap();
        assert_eq!(
            rows,
            vec![
                ChunkReuseRow {
                    chunk_index: 0,
                    embedding_input_hash: Some("h0".into()),
                    contextual_retrieval_mode: None,
                    text_only: true,
                    unembedded: false,
                },
                ChunkReuseRow {
                    chunk_index: 1,
                    embedding_input_hash: None,
                    contextual_retrieval_mode: None,
                    text_only: false,
                    unembedded: true,
                },
            ]
        );
        assert!(
            store
                .get_chunk_reuse_rows("notes/zz", Some("default"))
                .unwrap()
                .is_empty()
        );
        assert_eq!(store.read_source_chunker_version("default").unwrap(), None);
    }

    #[test]
    fn source_chunker_version_reads_the_last_stamp_and_skips_an_unknown_source() {
        let store = crate::test_support::store();
        assert_eq!(store.read_source_chunker_version("default").unwrap(), None);
        assert!(store.set_source_chunker_version("default", "7").unwrap());
        assert!(
            store
                .set_source_chunker_version("default", "8;lua=1")
                .unwrap()
        );
        assert_eq!(
            store
                .read_source_chunker_version("default")
                .unwrap()
                .as_deref(),
            Some("8;lua=1")
        );
        assert!(!store.set_source_chunker_version("missing", "9").unwrap());
        assert_eq!(store.read_source_chunker_version("missing").unwrap(), None);
        assert_eq!(store.read_source_chunker_version("bad\0id").unwrap(), None);
    }
}
