//! Page versions: snapshot a page, list its versions.
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
    /// `createVersion(slug, { sourceId? }?)`: snapshots the page and resolves the version row.
    #[napi]
    pub fn create_version<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let scope: gbrain_store::pages::ReadScope = arg(options, "createVersion options")?;
            s.create_version(&slug, scope.source_id.as_deref())
        })
    }

    /// `getVersions(slug, { sourceId?, sourceIds?, limit?, includeBody? }?)`: newest first.
    #[napi]
    pub fn get_versions<'env>(
        &self,
        env: &'env Env,
        slug: String,
        options: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_versions(&slug, &arg(options, "getVersions options")?)
        })
    }
}
