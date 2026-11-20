//! The keyspace catalog (`gbrain_store::keyspaces`): one `#[napi] impl Brain` block. It answers
//! `listCatalogRelations` on the Rust engine, where a SQL engine reads `pg_class`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `keyspaces()`: `{ format_version, keyspaces: [{ tag, family, records, kinds }] }`. The
    /// catalog is fixed by the build; it is read through the open store so a closed brain
    /// refuses the same way every other member does.
    #[napi]
    pub fn keyspaces<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(
            env,
            |_store| Ok(gbrain_store::keyspaces::keyspace_catalog()),
        )
    }
}
