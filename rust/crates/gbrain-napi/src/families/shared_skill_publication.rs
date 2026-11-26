//! Shared-skill publication on a Rust brain: the activation flag, the pack row and the reads and
//! checks put_skill makes inside its transaction (gbrain-store `shared_skill_publication.rs`).
//!
//! Each method decodes its arguments, runs one `Store` call through `Brain::run`, and resolves
//! plain JSON (rust/docs/store/shared-skill-members.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::shared_skill_publication as ssp;

#[napi]
impl Brain {
    /// `readSharedSkillPublication()`: the activation flag `{skill_bundles_enabled, writer_protocol_floor}`.
    #[napi]
    pub fn read_shared_skill_publication<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_shared_skill_publication())
    }

    /// `activateSharedSkillPublication(dryRun)`: activates shared publication, or names what keeps it from activating.
    #[napi]
    pub fn activate_shared_skill_publication<'env>(
        &self,
        env: &'env Env,
        dry_run: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.activate_shared_skill_publication(dry_run))
    }

    /// `readSharedSkillSource(sourceId)`: the source a publication binds, with its aliases, or null.
    #[napi]
    pub fn read_shared_skill_source<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_shared_skill_source(&source_id))
    }

    /// `readSharedSkillPack(key)`: the source incarnation's pack row, or null.
    #[napi]
    pub fn read_shared_skill_pack<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: ssp::SharedSkillSourceKey = required(key, "readSharedSkillPack key")?;
            s.read_shared_skill_pack(&key)
        })
    }

    /// `listSharedSkillHeadKeys(query)`: the pack's head keys in name order.
    #[napi]
    pub fn list_shared_skill_head_keys<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: ssp::SharedSkillPackHeads =
                required(query, "listSharedSkillHeadKeys query")?;
            s.list_shared_skill_head_keys(&query)
        })
    }

    /// `readSharedSkillHeadRevisions(query)`: the revision rows the named heads point at.
    #[napi]
    pub fn read_shared_skill_head_revisions<'env>(
        &self,
        env: &'env Env,
        query: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let query: ssp::SharedSkillPackHeads =
                required(query, "readSharedSkillHeadRevisions query")?;
            s.read_shared_skill_head_revisions(&query)
        })
    }

    /// `checkSharedSkillPublication(check)`: the in-transaction pack and head checks, the prune and the capacity.
    #[napi]
    pub fn check_shared_skill_publication<'env>(
        &self,
        env: &'env Env,
        check: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let check: ssp::SharedSkillPublicationCheck =
                required(check, "checkSharedSkillPublication check")?;
            s.check_shared_skill_publication(&check)
        })
    }

    /// `writeSharedSkillPack(write)`: the pack upsert; resolves null.
    #[napi]
    pub fn write_shared_skill_pack<'env>(
        &self,
        env: &'env Env,
        write: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let write: ssp::SharedSkillPackWrite = required(write, "writeSharedSkillPack write")?;
            s.write_shared_skill_pack(&write)
        })
    }

    /// `readSharedSkillRetention(key)`: the source's retention counts.
    #[napi]
    pub fn read_shared_skill_retention<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let key: ssp::SharedSkillSourceKey = required(key, "readSharedSkillRetention key")?;
            s.read_shared_skill_retention(&key)
        })
    }
}
