//! The doctor access reads served from the store (`gbrain-store` `access_doctor`, rust/docs/store/access-doctor.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listPagesReadByNobody(spec)`: `[{ source_id, slug, readers }]` by (source, slug), for
    /// `{ by: 'labelled', live }` or `{ by: 'rule', sourceId, prefix, admitted }`.
    #[napi]
    pub fn list_pages_read_by_nobody<'env>(
        &self,
        env: &'env Env,
        spec: serde_json::Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_pages_read_by_nobody(&required(spec, "listPagesReadByNobody spec")?)
        })
    }

    /// `ownerOnlyGuarded()`: whether the brain holds an owner-only source or an owner-only mark.
    #[napi]
    pub fn owner_only_guarded<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| s.owner_only_guarded())
    }
}
