//! The recursive code walk's two chunk reads, the two-pass walk's symbol chunk lookup and the
//! paid reindex's spend read (`src/core/engine-sql/chunk-reads.ts` `listSymbolLanguages`,
//! `listSupportedChunkIds` and `listSymbolChunkIds`,
//! `src/core/engine-sql/remediation-records.ts` `readReindexSpendInputs`).
//!
//! `listSymbolLanguages` models `codeReadFilter([], {})`: a live, unquarantined page of a live
//! source whose text projection is served. It does not filter `page_kind`, as the SQL does not.
//! `listSupportedChunkIds` reads any stored chunk row, as the SQL does: the edge read that named
//! the ids already applied the walk's visibility. `readReindexSpendInputs` counts the live markdown
//! pages whose chunker version is below the fence (a NULL version is not below it, as in SQL) or
//! whose contextual retrieval mode is NULL, and sums `LENGTH(compiled_truth) + LENGTH(timeline)` in
//! characters; a page with a NULL body column adds nothing to the sum but is still counted.

use super::site_reads::{ChunkReadScope, Policy, served};
use crate::Store;
use crate::chunks::{ChunkRecord, read_chunks};
use crate::error::Result;
use crate::pages::all_pages;
use crate::timeline_queries::jsonb_field_text;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `listSymbolLanguages(sourceId, qualified)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SymbolLanguagesInput {
    pub source_id: String,
    pub qualified: String,
}

/// `listSupportedChunkIds(chunkIds, languages)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SupportedChunkIdsInput {
    pub chunk_ids: Vec<i64>,
    pub languages: Vec<String>,
}

/// `listSymbolChunkIds(symbols, { sourceId?, limit })`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SymbolChunkIdsInput {
    pub symbols: Vec<String>,
    pub source_id: Option<String>,
    pub limit: u64,
}

/// `readReindexSpendInputs(chunkerVersion, type)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReindexSpendInput {
    pub chunker_version: i64,
    #[serde(rename = "type")]
    pub page_type: Option<String>,
}

fn meta_text(chunk: &ChunkRecord, key: &str) -> Option<String> {
    chunk.meta.get(key).and_then(jsonb_field_text)
}

impl Store {
    /// `listSymbolLanguages(sourceId, qualified)`: the distinct languages, in byte order.
    pub fn list_symbol_languages(&self, input: &SymbolLanguagesInput) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut policy = Policy::new(&*read);
        let scope = ChunkReadScope::default();
        let mut languages: BTreeSet<String> = BTreeSet::new();
        for page in all_pages(&*read)? {
            if page.source_id != input.source_id
                || !served(&page)
                || !policy.passes(&page, &scope)?
            {
                continue;
            }
            for chunk in read_chunks(&*read, page.id)? {
                if meta_text(&chunk, "symbol_name_qualified").as_deref()
                    != Some(input.qualified.as_str())
                {
                    continue;
                }
                if let Some(language) = meta_text(&chunk, "language") {
                    languages.insert(language);
                }
            }
        }
        Ok(languages.into_iter().collect())
    }

    /// `listSupportedChunkIds(chunkIds, languages)`: the ids, in id order.
    pub fn list_supported_chunk_ids(&self, input: &SupportedChunkIdsInput) -> Result<Vec<u64>> {
        if input.chunk_ids.is_empty() || input.languages.is_empty() {
            return Ok(Vec::new());
        }
        let wanted: BTreeSet<u64> = input
            .chunk_ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let read = self.read()?;
        let mut found: BTreeSet<u64> = BTreeSet::new();
        for page in all_pages(&*read)? {
            for chunk in read_chunks(&*read, page.id)? {
                if wanted.contains(&chunk.id)
                    && meta_text(&chunk, "language")
                        .is_some_and(|language| input.languages.contains(&language))
                {
                    found.insert(chunk.id);
                }
            }
        }
        Ok(found.into_iter().collect())
    }

    /// `listSymbolChunkIds(symbols, { sourceId?, limit })`: chunk ids whose qualified symbol is one of `symbols`,
    /// on pages of the source when one is named, in id order, at most `limit`. Any stored chunk row, as the SQL reads.
    pub fn list_symbol_chunk_ids(&self, input: &SymbolChunkIdsInput) -> Result<Vec<u64>> {
        if input.symbols.is_empty() || input.limit == 0 {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let mut found: BTreeSet<u64> = BTreeSet::new();
        for page in all_pages(&*read)? {
            if input
                .source_id
                .as_ref()
                .is_some_and(|source| *source != page.source_id)
            {
                continue;
            }
            for chunk in read_chunks(&*read, page.id)? {
                if meta_text(&chunk, "symbol_name_qualified")
                    .is_some_and(|qualified| input.symbols.contains(&qualified))
                {
                    found.insert(chunk.id);
                }
            }
        }
        let limit = usize::try_from(input.limit).unwrap_or(usize::MAX);
        Ok(found.into_iter().take(limit).collect())
    }

    /// `readReindexSpendInputs(chunkerVersion, type)`: `{ pages, chars }`.
    pub fn read_reindex_spend_inputs(&self, input: &ReindexSpendInput) -> Result<Value> {
        let read = self.read()?;
        let (mut pages, mut chars) = (0u64, 0u64);
        for page in all_pages(&*read)? {
            if page.page_kind != "markdown"
                || page.deleted_at_us.is_some()
                || input
                    .page_type
                    .as_ref()
                    .is_some_and(|t| *t != page.page_type)
            {
                continue;
            }
            let lags = page
                .chunker_version
                .is_some_and(|v| i64::from(v) < input.chunker_version);
            if !lags && crate::aliases::contextual_retrieval_mode(&*read, page.id)?.is_some() {
                continue;
            }
            pages += 1;
            if let (Some(body), Some(timeline)) =
                (page.compiled_truth.as_deref(), page.timeline.as_deref())
            {
                chars += (body.chars().count() + timeline.chars().count()) as u64;
            }
        }
        Ok(json!({ "pages": pages, "chars": chars }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunks::{ChunkInput, UpsertChunksOptions};
    use crate::pages::{PageInput, PutPageOptions, ReadScope};
    use crate::test_support::store;
    use serde_json::Map;

    /// A sealed code page with one chunk per `(qualified, language)`; returns the chunk ids in index order.
    fn code(store: &Store, slug: &str, kind: &str, symbols: &[(&str, &str)]) -> Vec<u64> {
        let input = PageInput {
            page_type: "code".into(),
            page_kind: Some(kind.into()),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        let chunks: Vec<ChunkInput> = symbols
            .iter()
            .enumerate()
            .map(|(i, (qualified, language))| {
                let mut rest = Map::new();
                rest.insert("symbol_name_qualified".into(), json!(qualified));
                rest.insert("language".into(), json!(language));
                ChunkInput {
                    chunk_index: i as u32,
                    chunk_text: format!("fn {qualified}"),
                    rest,
                    ..ChunkInput::default()
                }
            })
            .collect();
        let options = UpsertChunksOptions {
            seal: true,
            ..UpsertChunksOptions::default()
        };
        store.upsert_chunks(slug, &chunks, &options).unwrap();
        let mut rows = store
            .get_chunks(
                slug,
                &serde_json::from_value::<ReadScope>(json!({ "includeUnsealed": true })).unwrap(),
            )
            .unwrap();
        rows.sort_by_key(|c| c["chunk_index"].as_u64());
        rows.iter().map(|c| c["id"].as_u64().unwrap()).collect()
    }

    #[test]
    fn languages_are_distinct_sorted_and_scoped_to_the_symbol_and_source() {
        let store = store();
        code(
            &store,
            "a",
            "code",
            &[("m.f", "typescript"), ("m.g", "rust")],
        );
        code(&store, "b", "markdown", &[("m.f", "cobol")]);
        code(&store, "c", "code", &[("m.f", "typescript")]);
        let read = |qualified: &str, source: &str| {
            store
                .list_symbol_languages(&SymbolLanguagesInput {
                    source_id: source.into(),
                    qualified: qualified.into(),
                })
                .unwrap()
        };
        assert_eq!(read("m.f", "default"), vec!["cobol", "typescript"]);
        assert_eq!(read("m.g", "default"), vec!["rust"]);
        assert!(read("m.none", "default").is_empty());
        assert!(read("m.f", "other").is_empty());
    }

    #[test]
    fn supported_ids_keep_only_named_chunks_in_a_listed_language() {
        let store = store();
        let ids = code(
            &store,
            "a",
            "code",
            &[("m.f", "typescript"), ("m.g", "cobol"), ("m.h", "rust")],
        );
        let got = store
            .list_supported_chunk_ids(&SupportedChunkIdsInput {
                chunk_ids: vec![ids[2] as i64, ids[1] as i64, ids[0] as i64, -1, 999_999],
                languages: vec!["typescript".into(), "rust".into()],
            })
            .unwrap();
        assert_eq!(got, vec![ids[0], ids[2]]);
        let none = store
            .list_supported_chunk_ids(&SupportedChunkIdsInput {
                chunk_ids: ids.iter().map(|id| *id as i64).collect(),
                languages: vec![],
            })
            .unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn symbol_chunk_ids_are_in_id_order_scoped_and_bounded() {
        let store = store();
        let a = code(
            &store,
            "a",
            "code",
            &[("m.f", "typescript"), ("m.g", "rust"), ("m.f", "rust")],
        );
        let read = |symbols: &[&str], source: Option<&str>, limit: u64| {
            store
                .list_symbol_chunk_ids(&SymbolChunkIdsInput {
                    symbols: symbols.iter().map(|s| s.to_string()).collect(),
                    source_id: source.map(str::to_string),
                    limit,
                })
                .unwrap()
        };
        assert_eq!(read(&["m.f"], None, 50), vec![a[0], a[2]]);
        assert_eq!(read(&["m.f", "m.g"], Some("default"), 50), a);
        assert_eq!(read(&["m.f", "m.g"], Some("default"), 2), vec![a[0], a[1]]);
        assert!(read(&["m.f"], Some("other"), 50).is_empty());
        assert!(read(&[], None, 50).is_empty());
    }

    #[test]
    fn spend_counts_lagging_markdown_pages_and_their_characters() {
        let store = store();
        let put = |slug: &str, page_type: &str, kind: &str, body: &str, timeline: &str| {
            let input = PageInput {
                page_type: page_type.into(),
                page_kind: Some(kind.into()),
                title: slug.into(),
                compiled_truth: body.into(),
                timeline: Some(timeline.into()),
                ..PageInput::default()
            };
            store
                .put_page(slug, &input, &PutPageOptions::default())
                .unwrap();
        };
        put("a", "note", "markdown", "héllo", "");
        put("b", "concept", "markdown", "more", "and");
        put("c", "code", "code", "not counted", "");
        let read = |page_type: Option<&str>| {
            store
                .read_reindex_spend_inputs(&ReindexSpendInput {
                    chunker_version: 4,
                    page_type: page_type.map(str::to_string),
                })
                .unwrap()
        };
        assert_eq!(read(None), json!({ "pages": 2, "chars": 12 }));
        assert_eq!(read(Some("note")), json!({ "pages": 1, "chars": 5 }));
        assert_eq!(read(Some("missing")), json!({ "pages": 0, "chars": 0 }));
    }
}
