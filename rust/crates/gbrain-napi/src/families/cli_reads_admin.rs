//! The admin operations' page read (`listVisiblePageSlugs`):
//! `gbrain_store::cli_reads::admin_reads` (rust/docs/store/admin-reads.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `listVisiblePageSlugs(slugs, sourceIds, policy)`: resolves the visible slugs in byte order;
    /// a `null` source list reads every source and a `null` policy hides nothing.
    #[napi]
    pub fn list_visible_page_slugs<'env>(
        &self,
        env: &'env Env,
        slugs: Vec<String>,
        source_ids: Option<Vec<String>>,
        policy: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let policy = policy
                .map(|v| {
                    required::<gbrain_store::facts::PrivacyPolicy>(v, "listVisiblePageSlugs policy")
                })
                .transpose()?;
            s.list_visible_page_slugs(&slugs, source_ids.as_deref(), policy.as_ref())
        })
    }
}
