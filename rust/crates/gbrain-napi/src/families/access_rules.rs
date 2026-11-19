//! Folder access state: the folder rules, pending prefixes, access state and policy revisions of
//! schema migration v283 (rust/docs/store/access_rules.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `readFolderAccess(readers)`: `{ rules: [{ source_id, rule_id, readable_by }], coverage:
    /// [{ source_id, prefix }] }`, the rules whose readers name any of `readers` and the distinct
    /// pending prefixes.
    #[napi]
    pub fn read_folder_access<'env>(
        &self,
        env: &'env Env,
        readers: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_folder_access(&readers))
    }

    /// `listAppliedPolicyRevisions()`: `[{ source_id, rev }]` for each source with access state.
    #[napi]
    pub fn list_applied_policy_revisions<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_applied_policy_revisions())
    }

    /// `isFolderRestricted(sourceId, slug)`: whether a folder rule or a pending prefix covers it.
    #[napi]
    pub fn is_folder_restricted<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.is_folder_restricted(&source_id, &slug))
    }

    /// `putAccessPolicyState(sourceId)`: records that the source holds access state.
    #[napi]
    pub fn put_access_policy_state<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.put_access_policy_state(&source_id))
    }

    /// `putAccessRule({ source_id, rule_id, prefix, readable_by, revision, covers_derived? })`.
    #[napi]
    pub fn put_access_rule<'env>(&self, env: &'env Env, rule: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.put_access_rule(required(rule, "putAccessRule")?)
        })
    }

    /// `putAccessPendingCoverage({ source_id, prefix, reason, revision? })`.
    #[napi]
    pub fn put_access_pending_coverage<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.put_access_pending_coverage(required(row, "putAccessPendingCoverage")?)
        })
    }

    /// `putAccessPolicyRevision({ source_id, revision, applied })`.
    #[napi]
    pub fn put_access_policy_revision<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.put_access_policy_revision(required(row, "putAccessPolicyRevision")?)
        })
    }
}
