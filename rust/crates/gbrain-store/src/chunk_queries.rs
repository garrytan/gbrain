//! Chunk reads beyond the core chunks family: one page of a page's chunks
//! (`getChunkPage`), batched chunk windows for evidence delivery (`getChunkWindows`), the
//! pages that have a body but no chunks (`countChunklessPagesWithContent`,
//! `listChunklessPagesWithContent`), and the chunk reads and deletes of
//! `src/core/engine-sql/chunk-reads.ts` (`site_reads`).
//!
//! Members: getChunkPage, getChunkWindows, countChunklessPagesWithContent,
//! listChunklessPagesWithContent, findCodeDefinitions, listSymbolTypesForName,
//! findCodeRefChunks, countOversizedEmbedSkips, countOrphanChunks, countCodeChunkPages,
//! codeChunksExist, currentCodeChunksExist, listQualifiedSymbolNames, listWithdrawalChunks,
//! deleteChunksForPages, deleteChunksExcept, listContextualModeCandidates, resolveFrozenHits,
//! listSymbolLanguages, listSupportedChunkIds, listSymbolChunkIds, listWalkChunkRows and readReindexSpendInputs (`walk_reads`).
//!
//! Every member reads records other families own (pages, chunks, sources) through their
//! `pub(crate)` readers; the two deletes remove chunk rows through the chunks family's
//! `pub(crate)` deleters. This family keeps no records of its own: no key starts with
//! `keys::CHUNK_QUERIES` (`c`).
//!
//! A segmented page is one whose body columns are NULL (`PageText::is_null`), the shell PGLite's
//! `createSegmentedPageShell` leaves. Its `body_bytes` lives in the page_body family's private
//! body state, which this family reads through `page_body::segmented_body_bytes`; a NULL
//! `body_bytes` fails `body_bytes > 0` as it does in SQL. A page's chunks are served when its

//! `text_projection_revision` equals its `knowledge_revision`, the same test the SQL engines'
//! served-projection filter makes. See rust/docs/store/chunk_queries.md.

use crate::Store;
use crate::chunks::{
    ChunkRecord, DocumentKey, SAFE_FENCE_CHUNKER_VERSION, in_live_body, keyed_chunks, read_chunks,
    read_segment_view, segmented,
};
use crate::error::Result;
use crate::facts::{OwnerOnlySources, PrivacyPolicy, page_hidden, page_hidden_with};
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages, find_in_scope, read_page_by_id};
use crate::sources::read_source;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

mod segment_regions;
mod site_reads;
mod walk_reads;
pub use segment_regions::SegmentHit;
pub use site_reads::{
    ChunkReadScope, CodeChunksExistInput, CodeSymbolInput, DeleteChunksExceptInput, FrozenHit,
    FrozenHitsInput, QualifiedNamesInput, UnsealedPagesInput, WithdrawalChunksInput, WithdrawalKey,
};
pub(crate) use site_reads::{Policy as PageReadPolicy, served};
pub use walk_reads::{
    ReindexSpendInput, SupportedChunkIdsInput, SymbolChunkIdsInput, SymbolLanguagesInput,
    WalkChunkRowsInput,
};

/// `listChunklessPagesWithContent`'s default batch size.
const DEFAULT_CHUNKLESS_BATCH: u64 = 50;
/// The frontmatter key that hides a page (`QUARANTINE_FILTER_FRAGMENT`).
const QUARANTINE_KEY: &str = "quarantine";
/// The frontmatter key that marks a page whose chunks get no vectors.
const EMBED_SKIP_KEY: &str = "embed_skip";

/// The page's `body_bytes`. The page_body family keeps it in its private body state.
fn body_bytes(read: &dyn KvRead, page: &PageRecord) -> Result<Option<i64>> {
    crate::page_body::segmented_body_bytes(read, page.id)
}

/// The `chunklessPagesWhere` body test: `compiled_truth <> '' OR timeline <> '' OR
/// (body_storage = 'segmented' AND body_bytes > 0)`. A NULL body column fails `<> ''`.
fn has_body(page: &PageRecord, body_bytes: Option<i64>) -> bool {
    !page.compiled_truth.is_empty()
        || !page.timeline.is_empty()
        || (segmented(page) && body_bytes.is_some_and(|b| b > 0))
}

/// `getChunkPage(slug, { sourceId | sourceIds, fromIndex, limit, excludePrivate, requireSafeChunks })`.
/// The TypeScript member resolves the scope to named sources before it calls the store (`sourceIds`
/// when it names more than one, else `sourceId`),
/// `excludePrivate` to the store page policy (`storePagePolicy`), `null` when the read does not
/// ask for it, and `requireSafeChunks` to `requiresSafeChunks(opts)` (an `excludePrivate` read
/// asks for safe chunks unless it says otherwise).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChunkPageOptions {
    pub source_id: String,
    /// The sources of a read over several sources; when not empty they replace `source_id`.
    pub source_ids: Vec<String>,
    pub from_index: f64,
    pub limit: f64,
    pub exclude_private: Option<PrivacyPolicy>,
    pub require_safe_chunks: bool,
}

/// One `ChunkWindowRequest`: an inclusive `chunk_index` range of one page.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ChunkWindowRequest {
    pub page_id: i64,
    pub from_index: i64,
    pub to_index: i64,
    pub priority: i64,
}

/// `ChunkWindowOpts`, the part the store reads. `maxRows` arrives floored and not negative.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChunkWindowOptions {
    pub source_id: Option<String>,
    pub source_ids: Option<Vec<String>>,
    pub chunk_sources: Vec<String>,
    pub max_rows: u64,
    /// The store page policy of `excludePrivate` (`storePagePolicy`), `null` when not asked for.
    pub exclude_private: Option<PrivacyPolicy>,
    /// `requiresSafeChunks(opts)`: only pages past the chunker-version fence are authorized.
    pub require_safe_chunks: bool,
}

/// `{ sourceId?, batchSize?, afterPageId? }` of the chunkless reads.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChunklessOptions {
    pub source_id: Option<String>,
    pub batch_size: Option<u64>,
    pub after_page_id: Option<i64>,
}

/// The page's chunks describe its current text (`text_projection_revision IS NOT DISTINCT FROM knowledge_revision`), as
/// `chunklessPagesWhere` tests it: the v153 activation marker counts as not sealed there. The served reads
/// (`getChunkPage`, `getChunkWindows`) use `servedTextProjectionFilter`, which also serves the marker (`served`).
fn sealed(page: &PageRecord) -> bool {
    page.text_projection_revision.as_deref() == Some(page.knowledge_revision.as_str())
}

/// `safeChunksFilter('p')`: `chunker_version >= SAFE_FENCE_CHUNKER_VERSION`. A page that records
/// no version fails it, as NULL fails the SQL comparison.
pub(crate) fn safe_chunks(page: &PageRecord) -> bool {
    page.chunker_version
        .is_some_and(|v| v >= SAFE_FENCE_CHUNKER_VERSION)
}

fn source_archived(
    read: &dyn KvRead,
    cache: &mut HashMap<String, bool>,
    source_id: &str,
) -> Result<bool> {
    if let Some(archived) = cache.get(source_id) {
        return Ok(*archived);
    }
    let archived = read_source(read, source_id)?.is_some_and(|s| s.archived);
    cache.insert(source_id.to_string(), archived);
    Ok(archived)
}

/// `chunklessPagesWhere`: a live, not quarantined page with a body and no chunk rows, whose
/// chunks are not sealed or which carries `embed_skip`. A source id of `''` scopes nothing, as
/// the SQL engines' truthiness test does.
fn chunkless_pages(read: &dyn KvRead, source_id: Option<&str>) -> Result<Vec<PageRecord>> {
    let mut out = Vec::new();
    for page in all_pages(read)? {
        if source_id.is_some_and(|s| !s.is_empty() && s != page.source_id)
            || page.deleted_at_us.is_some()
            || !has_body(&page, body_bytes(read, &page)?)
            || page.frontmatter.contains_key(QUARANTINE_KEY)
            || (sealed(&page) && !page.frontmatter.contains_key(EMBED_SKIP_KEY))
            || !read_chunks(read, page.id)?.is_empty()
        {
            continue;
        }
        out.push(page);
    }
    out.sort_by_key(|p| p.id);
    Ok(out)
}

/// One `listChunklessPagesWithContent` row. A segmented page's NULL body columns read as `''`, as
/// the SQL engines' `?? ''` maps them.
fn chunkless_row(page: &PageRecord) -> Value {
    json!({
        "id": page.id,
        "slug": page.slug,
        "source_id": page.source_id,
        "compiled_truth": &*page.compiled_truth,
        "timeline": &*page.timeline,
    })
}

fn chunk_window_row(chunk: &ChunkRecord, prio: i64) -> Value {
    json!({
        "kind": "chunk",
        "page_id": chunk.page_id,
        "prio": prio,
        "chunk_id": chunk.id,
        "chunk_index": chunk.chunk_index,
        "chunk_text": chunk.chunk_text,
        "chunk_source": chunk.chunk_source,
        "projected_byte_start": chunk.meta.get("projected_byte_start").cloned().unwrap_or(Value::Null),
        "projected_byte_end": chunk.meta.get("projected_byte_end").cloned().unwrap_or(Value::Null),
        // The manifest occurrence of a segmented chunk; an inline chunk has none.
        "occurrence_id": chunk.segment.map_or(Value::Null, |place| json!(place.occurrence_id)),
    })
}

impl Store {
    /// `getChunkPage(slug, opts)`: the page's chunks with `fromIndex <= chunk_index <
    /// fromIndex + limit` in index order, the page's chunk count and its highest chunk index
    /// (`null` with no chunks). The page is read as `getChunks` reads it: the slug as written, a
    /// soft-deleted page like a live one, and no chunks unless they are served (sealed, or the v153 activation marker). Under
    /// `excludePrivate` a page the page policy hides, and under `requireSafeChunks` a page short of
    /// the chunker-version fence, reads as a page with no chunks, as `chunkReadWhere`'s
    /// `privatePagesFilterForCaller('p')` and `safeChunksFilter('p')` make it. A scope of several
    /// sources reads the page of this slug in each: the count is their sum, the range applies to
    /// each page, and the chunks merge in document order with the source id breaking a tie.
    pub fn get_chunk_page(&self, slug: &str, options: &ChunkPageOptions) -> Result<Value> {
        let read = self.read()?;
        let mut sources = if options.source_ids.is_empty() {
            vec![options.source_id.clone()]
        } else {
            options.source_ids.clone()
        };
        let mut seen = std::collections::HashSet::new();
        sources.retain(|id| seen.insert(id.clone()));
        // `chunkVisibleFilter` and `chunkDocumentOrder`: the chunks of the live generation in document order.
        let mut pages: Vec<(String, Vec<(DocumentKey, ChunkRecord)>)> = Vec::new();
        for source in sources {
            let Some(page) = find_in_scope(&*read, slug, &Some(source), &None, true)? else {
                continue;
            };
            if !served(&page) || (options.require_safe_chunks && !safe_chunks(&page)) {
                continue;
            }
            if let Some(policy) = &options.exclude_private
                && page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            let chunks = keyed_chunks(&*read, page.id, None)?;
            if !chunks.is_empty() {
                pages.push((page.source_id.clone(), chunks));
            }
        }
        // A segmented page's `chunk_index` is an insertion sequence (retired chunks leave gaps, an insertion lands
        // last), so when any page read is segmented the range is over positions in each page's order and the max
        // index is the largest page's count less one, as the SQL engines' `bool_or(segmented)` makes it; otherwise
        // it is over the index.
        let total: usize = pages.iter().map(|(_, chunks)| chunks.len()).sum();
        let by_position = pages
            .iter()
            .any(|(_, chunks)| chunks.iter().any(|(_, c)| c.segment.is_some()));
        let max = if by_position {
            pages
                .iter()
                .map(|(_, chunks)| chunks.len())
                .max()
                .and_then(|most| most.checked_sub(1))
                .map(|last| last as u32)
        } else {
            pages
                .iter()
                .flat_map(|(_, chunks)| chunks.iter().map(|(_, c)| c.chunk_index))
                .max()
        };
        let to = options.from_index + options.limit;
        let mut picked: Vec<(DocumentKey, &str, &ChunkRecord)> = Vec::new();
        for (source, chunks) in &pages {
            for (position, (key, c)) in chunks.iter().enumerate() {
                let at = if by_position {
                    position as f64
                } else {
                    f64::from(c.chunk_index)
                };
                if at >= options.from_index && at < to {
                    picked.push((*key, source.as_str(), c));
                }
            }
        }
        // `ORDER BY chunkDocumentOrder, p.source_id COLLATE "C"`.
        picked.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
        let page_chunks: Vec<Value> = picked.iter().map(|(_, _, c)| c.to_chunk(None)).collect();
        Ok(json!({ "chunks": page_chunks, "total_chunks": total, "max_chunk_index": max }))
    }

    /// `getChunkWindows(requests, opts)`: the flat page and chunk rows of the SQL engines' UNION
    /// (`kind` `page` or `chunk`), which the TypeScript member groups with `mapChunkWindowRows`.
    /// A requested page is authorized when it is in scope, live, served (sealed, or the v153 marker), in a source that is not
    /// archived, not quarantined, under `excludePrivate` not hidden by the page policy and, under
    /// `requireSafeChunks`, past the chunker-version fence; the others are absent. Chunk rows of the authorized pages
    /// come from the chunk sources asked for, are text chunks inside some requested range, and
    /// are cut at `maxRows + 1` in `(prio, page_id, chunk_index)` order.
    pub fn get_chunk_windows(
        &self,
        requests: &[ChunkWindowRequest],
        options: &ChunkWindowOptions,
    ) -> Result<Vec<Value>> {
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let scope: Option<Vec<&str>> = match &options.source_ids {
            Some(ids) if !ids.is_empty() => Some(ids.iter().map(String::as_str).collect()),
            _ => options
                .source_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| vec![s]),
        };
        // page id -> lowest priority asked for it.
        let mut prio: BTreeMap<i64, i64> = BTreeMap::new();
        for r in requests {
            prio.entry(r.page_id)
                .and_modify(|p| *p = (*p).min(r.priority))
                .or_insert(r.priority);
        }
        let mut archived = HashMap::new();
        let mut page_rows = Vec::new();
        let mut chunk_rows: Vec<(i64, u64, u32, Value)> = Vec::new();
        let owner_only = options
            .exclude_private
            .as_ref()
            .map(|_| OwnerOnlySources::read(&*read))
            .transpose()?;
        for (&page_id, &page_prio) in &prio {
            let Ok(id) = u64::try_from(page_id) else {
                continue;
            };
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            if scope
                .as_ref()
                .is_some_and(|s| !s.contains(&page.source_id.as_str()))
                || page.deleted_at_us.is_some()
                || !served(&page)
                || source_archived(&*read, &mut archived, &page.source_id)?
                || page.frontmatter.contains_key(QUARANTINE_KEY)
            {
                continue;
            }
            // `excludePrivate` and `requireSafeChunks` take the page out of the authorized set.
            if options.require_safe_chunks && !safe_chunks(&page) {
                continue;
            }
            if let (Some(policy), Some(owner_only)) = (&options.exclude_private, &owner_only)
                && page_hidden_with(&*read, &page, policy, owner_only)?
            {
                continue;
            }
            // `sealed`: `COALESCE(chunker_version, 0) >= SAFE_FENCE_CHUNKER_VERSION`: a page that records no version is
            // not sealed. Only a sealed page gives chunk rows.
            let page_sealed = page.chunker_version.unwrap_or(0) >= SAFE_FENCE_CHUNKER_VERSION;
            // `chunkGenerationFilter`: only the live body's chunks answer, and bound the page's max index.
            let view = read_segment_view(&*read, page.id)?;
            let chunks: Vec<ChunkRecord> = read_chunks(&*read, page.id)?
                .into_iter()
                .filter(|c| in_live_body(c, segmented(&page), &view))
                .collect();
            let max = chunks.iter().map(|c| c.chunk_index).max();
            for chunk in &chunks {
                let index = i64::from(chunk.chunk_index);
                if page_sealed
                    && options.chunk_sources.contains(&chunk.chunk_source)
                    && chunk.modality == "text"
                    && requests.iter().any(|r| {
                        r.page_id == page_id && r.from_index <= index && index <= r.to_index
                    })
                {
                    chunk_rows.push((
                        page_prio,
                        page.id,
                        chunk.chunk_index,
                        chunk_window_row(chunk, page_prio),
                    ));
                }
            }
            page_rows.push(json!({
                "kind": "page",
                "page_id": page.id,
                "slug": page.slug,
                "source_id": page.source_id,
                "type": page.page_type,
                "revision": page.knowledge_revision,
                "sealed": page_sealed,
                "segmented": segmented(&page),
                "prio": page_prio,
                "max_chunk_index": max,
                "compiled_truth": page.compiled_truth,
                "timeline": page.timeline,
            }));
        }
        chunk_rows.sort_by_key(|row| (row.0, row.1, row.2));
        let cap = usize::try_from(options.max_rows.saturating_add(1)).unwrap_or(usize::MAX);
        page_rows.extend(chunk_rows.into_iter().take(cap).map(|row| row.3));
        Ok(page_rows)
    }

    /// `countChunklessPagesWithContent({ sourceId? })`.
    pub fn count_chunkless_pages_with_content(&self, options: &ChunklessOptions) -> Result<u64> {
        let read = self.read()?;
        Ok(chunkless_pages(&*read, options.source_id.as_deref())?.len() as u64)
    }

    /// `listChunklessPagesWithContent({ sourceId?, batchSize?, afterPageId? })`: `{ id, slug,
    /// source_id, compiled_truth, timeline }` rows in page-id order after `afterPageId`, at most
    /// `batchSize` (default 50).
    pub fn list_chunkless_pages_with_content(
        &self,
        options: &ChunklessOptions,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let limit = usize::try_from(options.batch_size.unwrap_or(DEFAULT_CHUNKLESS_BATCH))
            .unwrap_or(usize::MAX);
        Ok(chunkless_pages(&*read, options.source_id.as_deref())?
            .into_iter()
            .filter(|p| {
                options
                    .after_page_id
                    .is_none_or(|after| i128::from(p.id) > i128::from(after))
            })
            .take(limit)
            .map(|p| chunkless_row(&p))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PageText, PutPageOptions, read_page, write_page};
    use crate::test_support::store;

    fn put(store: &Store, slug: &str, body: &str) -> PageRecord {
        let input: PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": body, "timeline": ""
        }))
        .unwrap();
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        read_page(&*store.read().unwrap(), "default", slug)
            .unwrap()
            .unwrap()
    }

    /// The shell PGLite's `createSegmentedPageShell` leaves: NULL body columns, no content hash,
    /// chunker version 0.
    fn make_shell(store: &Store, slug: &str) -> PageRecord {
        store
            .write(|tx| {
                let mut page = read_page(&*tx, "default", slug)?.unwrap();
                page.compiled_truth = PageText::null();
                page.timeline = PageText::null();
                page.content_hash = None;
                page.chunker_version = Some(0);
                write_page(tx, &page)?;
                Ok(page)
            })
            .unwrap()
    }

    #[test]
    fn a_segmented_page_has_a_body_only_when_its_body_bytes_are_positive() {
        let store = store();
        put(&store, "notes/big", "body");
        let shell = make_shell(&store, "notes/big");
        assert!(segmented(&shell));
        assert!(has_body(&shell, Some(10)));
        assert!(!has_body(&shell, Some(0)), "a fresh shell has body_bytes 0");
        assert!(!has_body(&shell, None), "NULL > 0 is not true");
        // This shell has no body state (`make_shell` only nulls the columns), so its body_bytes is NULL and it is not
        // chunkless-with-content. A published body reads through `page_body::segmented_body_bytes`
        // (test/engine-parity/chunk-page-segmented.test.ts).

        let options = ChunklessOptions::default();
        assert_eq!(
            store.count_chunkless_pages_with_content(&options).unwrap(),
            0
        );
        assert!(
            store
                .list_chunkless_pages_with_content(&options)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_chunkless_row_sends_an_empty_string_for_a_null_body_column() {
        let store = store();
        let shell = {
            put(&store, "notes/big", "body");
            make_shell(&store, "notes/big")
        };
        let row = chunkless_row(&shell);
        assert_eq!(row["compiled_truth"], json!(""));
        assert_eq!(row["timeline"], json!(""));
        assert_eq!(row["slug"], json!("notes/big"));
    }

    /// Minder's row 2 on #9730: a page that carries the v153 activation marker keeps serving its chunks through
    /// `getChunkPage` and `getChunkWindows` (`servedTextProjectionFilter`), and still counts as not sealed for the
    /// chunkless reads (`IS DISTINCT FROM knowledge_revision`).
    #[test]
    fn the_v153_activation_marker_serves_chunks_but_does_not_seal() {
        let store = store();
        let page = put(&store, "notes/kept", "kept body");
        store
            .write(|tx| {
                let mut p = read_page(&*tx, "default", "notes/kept")?.unwrap();
                p.text_projection_revision = Some("00000000-0000-0000-0000-000000000153".into());
                write_page(tx, &p)
            })
            .unwrap();
        let read = store.read().unwrap();
        let marked = read_page(&*read, "default", "notes/kept").unwrap().unwrap();
        drop(read);
        assert!(served(&marked) && !sealed(&marked));
        let chunk_page = store
            .get_chunk_page(
                "notes/kept",
                &ChunkPageOptions {
                    source_id: "default".into(),
                    source_ids: Vec::new(),
                    from_index: 0.0,
                    limit: 10.0,
                    exclude_private: None,
                    require_safe_chunks: false,
                },
            )
            .unwrap();
        assert_eq!(chunk_page["total_chunks"], json!(1), "{chunk_page}");
        let requests = [ChunkWindowRequest {
            page_id: i64::try_from(page.id).unwrap(),
            from_index: 0,
            to_index: 10,
            priority: 0,
        }];
        let options = ChunkWindowOptions {
            chunk_sources: vec!["compiled_truth".into()],
            max_rows: 100,
            ..Default::default()
        };
        let rows = store.get_chunk_windows(&requests, &options).unwrap();
        // The page is authorized; whether it also gives chunk rows depends on its chunker version, not the marker.
        assert!(rows.iter().any(|r| r["kind"] == "page"), "{rows:?}");
    }

    #[test]
    fn a_chunk_window_page_row_says_segmented_and_unsealed_for_a_shell() {
        let store = store();
        let inline = put(&store, "notes/inline", "inline body");
        let shell = {
            put(&store, "notes/big", "big body");
            make_shell(&store, "notes/big")
        };
        let requests: Vec<ChunkWindowRequest> = [inline.id, shell.id]
            .iter()
            .map(|&id| ChunkWindowRequest {
                page_id: i64::try_from(id).unwrap(),
                from_index: 0,
                to_index: 10,
                priority: 0,
            })
            .collect();
        let options = ChunkWindowOptions {
            chunk_sources: vec!["compiled_truth".into()],
            max_rows: 100,
            ..Default::default()
        };
        let rows = store.get_chunk_windows(&requests, &options).unwrap();
        let page_row = |id: u64| {
            rows.iter()
                .find(|r| r["kind"] == "page" && r["page_id"] == json!(id))
                .cloned()
        };
        let inline_row = page_row(inline.id).expect("the inline page is authorized");
        assert_eq!(inline_row["segmented"], json!(false));
        assert_eq!(inline_row["compiled_truth"], json!("inline body"));
        if let Some(shell_row) = page_row(shell.id) {
            assert_eq!(shell_row["segmented"], json!(true));
            assert_eq!(shell_row["sealed"], json!(false));
            assert_eq!(shell_row["compiled_truth"], Value::Null);
            assert!(
                !rows
                    .iter()
                    .any(|r| r["kind"] == "chunk" && r["page_id"] == json!(shell.id)),
                "an unsealed page gives no chunk rows"
            );
        } else {
            panic!("the shell page is authorized: {rows:?}");
        }
    }
}
