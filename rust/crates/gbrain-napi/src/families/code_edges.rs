//! Code call edges between chunks and symbols.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON. The shell resolves defaults first (`source_id ?? 'default'`, the limit
//! clamps, the source scope, the bare-name opt-in) and maps each row through `rowToCodeEdge`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::code_edges;

#[napi]
impl Brain {
    /// `addCodeEdges(edges)`: resolves the number of rows inserted.
    #[napi]
    pub fn add_code_edges<'env>(&self, env: &'env Env, edges: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let edges: Vec<code_edges::CodeEdgeInput> = required(edges, "addCodeEdges edges")?;
            s.add_code_edges(&edges)
        })
    }

    /// `deleteCodeEdgesForChunks(chunkIds)`: resolves null.
    #[napi]
    pub fn delete_code_edges_for_chunks<'env>(
        &self,
        env: &'env Env,
        chunk_ids: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let ids: Vec<Value> = required(chunk_ids, "deleteCodeEdgesForChunks chunkIds")?;
            s.delete_code_edges_for_chunks(&ids)
        })
    }

    /// `getCallersOf(name, opts)`: the resolved lookup (see `EdgeLookup`).
    #[napi]
    pub fn get_callers_of<'env>(
        &self,
        env: &'env Env,
        lookup: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let lookup: code_edges::EdgeLookup = required(lookup, "getCallersOf lookup")?;
            s.get_callers_of(&lookup)
        })
    }

    /// `getCalleesOf(name, opts)`: the resolved lookup (see `EdgeLookup`).
    #[napi]
    pub fn get_callees_of<'env>(
        &self,
        env: &'env Env,
        lookup: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let lookup: code_edges::EdgeLookup = required(lookup, "getCalleesOf lookup")?;
            s.get_callees_of(&lookup)
        })
    }

    /// `getEdgesByChunk(chunkId, opts)`: the resolved options (see `ChunkEdgesOptions`).
    #[napi]
    pub fn get_edges_by_chunk<'env>(
        &self,
        env: &'env Env,
        options: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let options: code_edges::ChunkEdgesOptions =
                required(options, "getEdgesByChunk options")?;
            s.get_edges_by_chunk(&options)
        })
    }
}
