//! Graph walks over links.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};

#[napi]
impl Brain {
    /// `traverseGraph(slug, depth?, { sourceId?, sourceIds?, frontierCap? }?)`: `GraphNode[]`.
    /// `depth` and `frontierCap` must be integers.
    #[napi]
    pub fn traverse_graph<'env>(
        &self,
        env: &'env Env,
        slug: String,
        depth: Option<Value>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let depth: Option<i64> = arg(depth, "traverseGraph depth")?;
            s.traverse_graph(&slug, depth, &arg(options, "traverseGraph options")?)
        })
    }

    /// `traversePaths(slug, { depth?, linkType?, direction?, sourceId?, sourceIds? }?)`:
    /// `GraphPath[]`.
    #[napi]
    pub fn traverse_paths<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.traverse_paths(&slug, &arg(options, "traversePaths options")?)
        })
    }

    /// `traversePathsDetailed(slug, opts?)`: `{ paths, truncated }`.
    #[napi]
    pub fn traverse_paths_detailed<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.traverse_paths_detailed(&slug, &arg(options, "traversePathsDetailed options")?)
        })
    }
}
