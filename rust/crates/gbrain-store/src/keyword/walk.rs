//! The pages and chunks a chunk-grain keyword member reads, from the scan or from the keyword
//! index (`index.rs`), with each member's own admission predicates in its own order
//! (docs/plans/rust-keyword-index.md, D4a).
//!
//! The scan visits every page in `P` key order with each admitted chunk's full vector. The index
//! visits only the pages of the candidate chunks and of the `full_pages` (the handle arm, which
//! admits every chunk of a page), each candidate chunk with its sparse vector and each full page's
//! chunks with their full vectors. A page is admitted before any of its chunks is read, so a hidden
//! page contributes nothing; only its postings, which hold no text, were read.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use super::filters::{PageFilter, readable_chunk_vector, served};
use super::index::{Doc, Postings, basename, serves};
use super::tsearch::{TsQuery, TsVector};
use crate::chunks::{ChunkRecord, read_chunks, read_segment_view};
use crate::error::Result;
use crate::get_json;
use crate::keys::{self, KW_CHUNK_POSTING};
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages, read_page_by_id};

/// Where a member's chunks come from.
pub(super) enum ChunkSource {
    Scan,
    Index {
        postings: Postings,
        /// The candidate chunks, ascending.
        chunks: Vec<Doc>,
        /// Pages whose every chunk is read with its full vector.
        full_pages: BTreeSet<u64>,
    },
}

impl ChunkSource {
    /// The index source when the index serves `read` and every query of `matches` has a
    /// candidate bound, else the scan. `extra` are the other queries the member evaluates on a
    /// chunk (rank and phrase queries): their lexemes join the sparse vectors. `full_pages` is
    /// `None` when the full pages cannot be read from the index (the member scans).
    pub(super) fn plan(
        read: &dyn KvRead,
        matches: &[&TsQuery],
        extra: &[&TsQuery],
        full_pages: impl FnOnce(&dyn KvRead) -> Result<Option<BTreeSet<u64>>>,
    ) -> Result<Self> {
        if !serves(read)? {
            return Ok(ChunkSource::Scan);
        }
        let Some(full_pages) = full_pages(read)? else {
            return Ok(ChunkSource::Scan);
        };
        let all: Vec<&TsQuery> = matches.iter().chain(extra).copied().collect();
        let postings = Postings::read(read, KW_CHUNK_POSTING, &all)?;
        let Some(chunks) = postings.candidates_of(matches) else {
            return Ok(ChunkSource::Scan);
        };
        #[cfg(test)]
        super::index::tests::served_by_index();
        Ok(ChunkSource::Index {
            postings,
            chunks,
            full_pages,
        })
    }
}

/// A member's admission predicates.
pub(super) struct Admit<'f, 'o> {
    /// `PageFilter::keeps` and `keeps_chunk`; `None`: only `served` (the rarity statement).
    pub filter: Option<&'f mut PageFilter<'o>>,
    /// Only `modality = 'text'` chunks.
    pub text_only: bool,
    /// Only pages whose slug basename is one of these (the handles-only statement).
    pub basenames: Option<&'f [String]>,
}

impl Admit<'_, '_> {
    fn page(&mut self, read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
        let kept = match self.filter.as_deref_mut() {
            Some(filter) => filter.keeps(read, page)?,
            None => served(page),
        };
        Ok(kept
            && self
                .basenames
                .is_none_or(|names| names.iter().any(|h| h == basename(&page.slug))))
    }

    fn chunk(&self, chunk: &ChunkRecord, generation: u64) -> bool {
        chunk.visible_at(generation)
            && (!self.text_only || chunk.modality == "text")
            && self.filter.as_deref().is_none_or(|f| f.keeps_chunk(chunk))
    }
}

/// The order the pages are visited in.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum PageOrder {
    /// Any order: the member sorts its own result.
    Any,
    /// `P` key order (source, then slug), as the scan reads them.
    Key,
}

/// An admitted page's admitted chunks, each with the vector its member evaluates.
pub(super) type PageChunks = Vec<(ChunkRecord, Arc<TsVector>)>;

/// Every admitted chunk with a readable vector, ascending by chunk index within its page, for
/// every admitted page; `visit` returns false to stop. A page with no such chunk is visited with
/// an empty list.
pub(super) fn walk_chunks(
    read: &dyn KvRead,
    source: &ChunkSource,
    order: PageOrder,
    admit: &mut Admit<'_, '_>,
    visit: &mut dyn FnMut(PageRecord, PageChunks) -> Result<bool>,
) -> Result<()> {
    let full = |page: &PageRecord, admit: &Admit<'_, '_>| -> Result<PageChunks> {
        let generation = read_segment_view(read, page.id)?.generation;
        Ok(read_chunks(read, page.id)?
            .into_iter()
            .filter(|c| admit.chunk(c, generation))
            .filter_map(|c| readable_chunk_vector(&c).map(|v| (c, v)))
            .collect())
    };
    let ChunkSource::Index {
        postings,
        chunks,
        full_pages,
    } = source
    else {
        for page in all_pages(read)? {
            if !admit.page(read, &page)? {
                continue;
            }
            let chunks = full(&page, admit)?;
            if !visit(page, chunks)? {
                break;
            }
        }
        return Ok(());
    };
    let mut by_page: BTreeMap<u64, Vec<u32>> = BTreeMap::new();
    for &(page, index) in chunks {
        if !full_pages.contains(&page) {
            by_page.entry(page).or_default().push(index);
        }
    }
    for &page in full_pages {
        by_page.entry(page).or_default();
    }
    let mut pages = Vec::with_capacity(by_page.len());
    for (id, indexes) in by_page {
        if let Some(page) = read_page_by_id(read, id)? {
            pages.push((page, indexes));
        }
    }
    if order == PageOrder::Key {
        pages.sort_by_cached_key(|(p, _)| keys::page(&p.source_id, &p.slug));
    }
    for (page, indexes) in pages {
        if !admit.page(read, &page)? {
            continue;
        }
        let chunks = if full_pages.contains(&page.id) {
            full(&page, admit)?
        } else {
            let generation = read_segment_view(read, page.id)?.generation;
            let mut out = Vec::with_capacity(indexes.len());
            for index in indexes {
                let Some(chunk) = get_json::<ChunkRecord>(read, &keys::chunk(page.id, index))?
                else {
                    continue;
                };
                if admit.chunk(&chunk, generation) {
                    out.push((chunk, postings.sparse((page.id, index))));
                }
            }
            out
        };
        if !visit(page, chunks)? {
            break;
        }
    }
    Ok(())
}

/// Every admitted chunk of every admitted page, in `P` key order, without reading a vector: the CJK
/// members (`keyword/cjk.rs`) match the chunk text itself (`LIKE` / `ILIKE`), so a chunk whose
/// vector cannot be built still matches, and the keyword index, which holds lexemes, cannot narrow
/// them. A page with no admitted chunk is visited with an empty list; `visit` returns false to stop.
pub(super) fn walk_text_chunks(
    read: &dyn KvRead,
    admit: &mut Admit<'_, '_>,
    visit: &mut dyn FnMut(PageRecord, Vec<ChunkRecord>) -> Result<bool>,
) -> Result<()> {
    for page in all_pages(read)? {
        if !admit.page(read, &page)? {
            continue;
        }
        let generation = read_segment_view(read, page.id)?.generation;
        let chunks = read_chunks(read, page.id)?
            .into_iter()
            .filter(|c| admit.chunk(c, generation))
            .collect();
        if !visit(page, chunks)? {
            break;
        }
    }
    Ok(())
}
