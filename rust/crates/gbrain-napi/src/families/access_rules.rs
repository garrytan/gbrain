//! Folder access state: the folder rules, pending prefixes, access state and policy revisions of
//! schema migration v283, and the policy members `src/core/access/policy.ts` runs
//! (rust/docs/store/access_rules.md).
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

fn whole(n: f64, what: &str) -> Result<i64, gbrain_store::error::StoreError> {
    if n.is_finite() && n.fract() == 0.0 {
        Ok(n as i64)
    } else {
        Err(gbrain_store::error::StoreError::invalid(format!(
            "{what}: expected a whole number, got {n}"
        )))
    }
}

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

    /// `readAccessStoreConfig(sourceId)`: `{ store }` or null for a missing source.
    #[napi]
    pub fn read_access_store_config<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_access_store_config(&source_id))
    }

    /// `writeAccessStoreConfig(sourceId, store)`.
    #[napi]
    pub fn write_access_store_config<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        store: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.write_access_store_config(&source_id, &store)
        })
    }

    /// `ensureAccessPolicyState(sourceId)`.
    #[napi]
    pub fn ensure_access_policy_state<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.ensure_access_policy_state(&source_id))
    }

    /// `lockAccessPolicy(sourceId)`: one statement under the writer gate.
    #[napi]
    pub fn lock_access_policy<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.lock_access_policy(&source_id))
    }

    /// `listAccessRules(sourceId)`: `[{ rule_id, prefix, readable_by, covers_derived }]`.
    #[napi]
    pub fn list_access_rules<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_access_rules(&source_id))
    }

    /// `readAccessPolicyRevisions(query)`: the revision rows, times as text.
    #[napi]
    pub fn read_access_policy_revisions<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_access_policy_revisions(&required(query, "readAccessPolicyRevisions")?)
        })
    }

    /// `listAccessCoverage(sourceId)`: `[{ prefix, reason, revision, detail }]`.
    #[napi]
    pub fn list_access_coverage<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_access_coverage(&source_id))
    }

    /// `readAccessStateUnreadable()`: always false.
    #[napi]
    pub fn read_access_state_unreadable<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_access_state_unreadable())
    }

    /// `applyAccessRuleChanges(sourceId, { remove, insert, pending, revision, actor })`.
    #[napi]
    pub fn apply_access_rule_changes<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        changes: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.apply_access_rule_changes(&source_id, &required(changes, "applyAccessRuleChanges")?)
        })
    }

    /// `restampAccessWindow(sourceId, after, batch)`: `{ last, scanned, changed }`.
    #[napi]
    pub fn restamp_access_window<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        after: f64,
        batch: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let after = whole(after, "restampAccessWindow after")?.max(0) as u64;
            let batch = whole(batch, "restampAccessWindow batch")?.max(0) as usize;
            s.restamp_access_window(&source_id, after, batch)
        })
    }

    /// `countAccessFolderDrift(sourceId)`: the pages whose kept rule ids differ from the rules now.
    #[napi]
    pub fn count_access_folder_drift<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_access_folder_drift(&source_id))
    }

    /// `finishAccessRestamp(sourceId)`: the pages restamped.
    #[napi]
    pub fn finish_access_restamp<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.finish_access_restamp(&source_id))
    }

    /// `insertAccessPolicyRevision(row)`.
    #[napi]
    pub fn insert_access_policy_revision<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_access_policy_revision(&required(row, "insertAccessPolicyRevision")?)
        })
    }

    /// `markAccessRevisionsApplied(sourceId, upTo?)`.
    #[napi]
    pub fn mark_access_revisions_applied<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        up_to: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let up_to = up_to
                .map(|u| whole(u, "markAccessRevisionsApplied upTo"))
                .transpose()?;
            s.mark_access_revisions_applied(&source_id, up_to)
        })
    }

    /// `approveAccessPolicyRevision(sourceId, revision, actor)`.
    #[napi]
    pub fn approve_access_policy_revision<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        revision: f64,
        actor: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.approve_access_policy_revision(
                &source_id,
                whole(revision, "approveAccessPolicyRevision revision")?,
                &actor,
            )
        })
    }

    /// `hasAccessPolicyState(sourceId)`.
    #[napi]
    pub fn has_access_policy_state<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_access_policy_state(&source_id))
    }

    /// `listAccessPrefixSlugs(sourceId, prefixes)`: live slugs under any prefix, by slug.
    #[napi]
    pub fn list_access_prefix_slugs<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        prefixes: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_access_prefix_slugs(&source_id, &prefixes)
        })
    }

    /// `readAccessPolicyMarks(sourceId, operationId?)`: `{ applied, approved, operation? }`.
    #[napi]
    pub fn read_access_policy_marks<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        operation_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_access_policy_marks(&source_id, operation_id.as_deref())
        })
    }

    /// `replaceAccessInvalidCoverage(sourceId, prefixes, detail)`.
    #[napi]
    pub fn replace_access_invalid_coverage<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        prefixes: Vec<String>,
        detail: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.replace_access_invalid_coverage(&source_id, &prefixes, &detail)
        })
    }

    /// `readUnfinishedAccessMigration(sourceId)`: `{ id, phase, direction, receipts }` or null.
    #[napi]
    pub fn read_unfinished_access_migration<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_unfinished_access_migration(&source_id))
    }

    /// `insertAccessMigration(id, sourceId, direction)`.
    #[napi]
    pub fn insert_access_migration<'env>(
        &self,
        env: &'env Env,
        id: String,
        source_id: String,
        direction: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_access_migration(&id, &source_id, &direction)
        })
    }

    /// `recordAccessMigrationPhase(id, phase, receipts)`; `switchAccessMigration` passes `switched`.
    #[napi]
    pub fn record_access_migration_phase<'env>(
        &self,
        env: &'env Env,
        id: String,
        phase: String,
        receipts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.record_access_migration_phase(&id, &phase, &receipts)
        })
    }
}
