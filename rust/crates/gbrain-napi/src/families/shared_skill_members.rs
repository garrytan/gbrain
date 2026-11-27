//! Shared-skill membership: the catalog token secret, members and delivery batches that
//! join_brain, sync_brain_skills and leave_brain use, and the catalog rows (policies, heads and
//! revisions) set_skill_policy and the catalog read use.
//!
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`, and
//! resolves plain JSON (rust/docs/store/shared-skill-members.md). Timestamps leave as ISO strings
//! and the shell makes them `Date`s.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `sharedSkillTokenSecret()`: the catalog token secret, minted once for an older brain.
    #[napi]
    pub fn shared_skill_token_secret<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.shared_skill_token_secret())
    }

    /// `readSharedSkillMember(by)`: the member row, or null.
    #[napi]
    pub fn read_shared_skill_member<'env>(
        &self,
        env: &'env Env,
        by: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let by: gbrain_store::shared_skill_members::SharedSkillMemberLookup =
                required(by, "readSharedSkillMember lookup")?;
            s.read_shared_skill_member(&by)
        })
    }

    /// `listSharedMemberMigrationRows(sourceId)`: the members following the source, by adapter.
    #[napi]
    pub fn list_shared_member_migration_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_shared_member_migration_rows(&source_id)
        })
    }

    /// `countSharedSkillMembers()`: every member, active or not.
    #[napi]
    pub fn count_shared_skill_members<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_shared_skill_members())
    }

    /// `enrollSharedSkillMember(spec)`: resolves null.
    #[napi]
    pub fn enroll_shared_skill_member<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: gbrain_store::shared_skill_members::SharedSkillMemberEnroll =
                required(spec, "enrollSharedSkillMember spec")?;
            s.enroll_shared_skill_member(&spec)
        })
    }

    /// `rebindSharedSkillMember(installationId, followPolicy, epoch)`: resolves null.
    #[napi]
    pub fn rebind_shared_skill_member<'env>(
        &self,
        env: &'env Env,
        installation_id: String,
        follow_policy: Value,
        epoch: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.rebind_shared_skill_member(&installation_id, &follow_policy, epoch)
        })
    }

    /// `leaveSharedSkillMember(installationId)`: resolves null.
    #[napi]
    pub fn leave_shared_skill_member<'env>(
        &self,
        env: &'env Env,
        installation_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.leave_shared_skill_member(&installation_id))
    }

    /// `issueSharedSkillDeliveryBatch(spec)`: `{ batch, created, issuedSequence }`, in one write.
    #[napi]
    pub fn issue_shared_skill_delivery_batch<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: gbrain_store::shared_skill_members::SharedSkillBatchIssue =
                required(spec, "issueSharedSkillDeliveryBatch spec")?;
            s.issue_shared_skill_delivery_batch(&spec)
        })
    }

    /// `readSharedSkillDeliveryBatch(token, installationId, epoch)`: the batch, or null.
    #[napi]
    pub fn read_shared_skill_delivery_batch<'env>(
        &self,
        env: &'env Env,
        token: String,
        installation_id: String,
        epoch: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_shared_skill_delivery_batch(&token, &installation_id, epoch)
        })
    }

    /// `acknowledgeSharedSkillDeliveryBatch(spec)`: resolves null, in one write.
    #[napi]
    pub fn acknowledge_shared_skill_delivery_batch<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: gbrain_store::shared_skill_members::SharedSkillBatchAcknowledge =
                required(spec, "acknowledgeSharedSkillDeliveryBatch spec")?;
            s.acknowledge_shared_skill_delivery_batch(&spec)
        })
    }

    /// `listSharedSkillFollowSources(allowed, sourceIds)`: `[{ id, incarnation }]`.
    #[napi]
    pub fn list_shared_skill_follow_sources<'env>(
        &self,
        env: &'env Env,
        allowed: Option<Vec<String>>,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_shared_skill_follow_sources(allowed.as_deref(), source_ids.as_deref())
        })
    }
    /// `writeSharedSkillPolicy(write)`: resolves null.
    #[napi]
    pub fn write_shared_skill_policy<'env>(
        &self,
        env: &'env Env,
        write: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let write: gbrain_store::shared_skill_catalog::SharedSkillPolicyWrite =
                required(write, "writeSharedSkillPolicy write")?;
            s.write_shared_skill_policy(&write)
        })
    }

    /// `readSharedSkillPolicyRow(sourceId, incarnation)`: `{ epoch, policy }`, or null.
    #[napi]
    pub fn read_shared_skill_policy_row<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_shared_skill_policy_row(&source_id, &incarnation)
        })
    }

    /// `writeSharedSkillRevision(write)`: resolves null. The engine member refuses it while shared
    /// publication is disabled (`readSharedSkillPublication`).
    #[napi]
    pub fn write_shared_skill_revision<'env>(
        &self,
        env: &'env Env,
        write: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let write: gbrain_store::shared_skill_catalog::SharedSkillRevisionWrite =
                required(write, "writeSharedSkillRevision write")?;
            s.write_shared_skill_revision(&write)
        })
    }

    /// `readSharedSkillRevision(key)`: the stored revision that is not deleted, or null.
    #[napi]
    pub fn read_shared_skill_revision<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: gbrain_store::shared_skill_catalog::SharedSkillRevisionKey =
                required(key, "readSharedSkillRevision key")?;
            s.read_shared_skill_revision(&key)
        })
    }

    /// `listSharedSkillCatalogHeads(query)`: the matching heads with their current policies.
    #[napi]
    pub fn list_shared_skill_catalog_heads<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: gbrain_store::shared_skill_catalog::SharedSkillHeadQuery =
                required(query, "listSharedSkillCatalogHeads query")?;
            s.list_shared_skill_catalog_heads(&query)
        })
    }
}
