//! The shared-skill migration read of `engine-sql/collate-store-reads.ts` (rust/docs/store/shared-skill-members.md).

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `listSharedSkillMigrationRows(sourceId)`: the members that follow the source, by byte of adapter then id.
    #[napi]
    pub fn list_shared_skill_migration_rows<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_shared_skill_migration_rows(&source_id))
    }
}
