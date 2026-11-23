//! Vector search: `searchVector` and `searchTakesVector`.
//!
//! Each method takes the query vector as plain numbers (the shell sends `Array.from(embedding)`)
//! and the resolved options, runs one `Store` call on the pool through `Brain::run`, and resolves
//! plain JSON rows. A score PGLite returns as `NaN` arrives as `null`; the shell maps it back.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, arg};

#[napi]
impl Brain {
    /// `searchVector(embedding, opts)`: the resolved filter (see `VectorSearchOptions`).
    #[napi]
    pub fn search_vector<'env>(
        &self,
        env: &'env Env,
        query: Vec<f64>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.search_vector(&query, &arg(options, "searchVector options")?)
        })
    }

    /// `searchTakesVector(embedding, opts)`: the resolved filter (see `TakesVectorOptions`).
    #[napi]
    pub fn search_takes_vector<'env>(
        &self,
        env: &'env Env,
        query: Vec<f64>,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.search_takes_vector(&query, &arg(options, "searchTakesVector options")?)
        })
    }
}
