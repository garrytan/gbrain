//! The page visibility guards a remote page write runs (`src/core/engine-sql/page-visibility.ts`), and the owner-only
//! mark state (`src/core/engine-sql/owner-only-marks.ts`).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use gbrain_store::page_visibility::PageRef;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `ownerOnlyMarkTriggers` (the store side): `{ closed, rowSecurity, held, closedLogins }`.
    #[napi]
    pub fn owner_only_mark_state<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.owner_only_mark_state())
    }

    /// `readPageHiddenFromCaller(sourceId, slug, policy)`: whether the page row fails `policy`.
    #[napi]
    pub fn read_page_hidden_from_caller<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        policy: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_page_hidden_from_caller(
                &source_id,
                &slug,
                &required(policy, "readPageHiddenFromCaller policy")?,
            )
        })
    }

    /// `readWriteVisibilityProbe(sourceId, slug, policy)`: the opening read of a remote page write's visibility check.
    #[napi]
    pub fn read_write_visibility_probe<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        policy: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_write_visibility_probe(
                &source_id,
                &slug,
                &required(policy, "readWriteVisibilityProbe policy")?,
            )
        })
    }

    /// `readCallerPageAccess(pages, policy)`: the pairs that name a page row, and whether each reads.
    #[napi]
    pub fn read_caller_page_access<'env>(
        &self,
        env: &'env Env,
        pages: Value,
        policy: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_caller_page_access(
                &required::<Vec<PageRef>>(pages, "readCallerPageAccess pages")?,
                &required(policy, "readCallerPageAccess policy")?,
            )
        })
    }
}
