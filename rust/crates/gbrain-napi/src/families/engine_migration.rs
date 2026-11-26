//! Engine migration: the source-side reads of `gbrain migrate --to <engine>`
//! (rust/docs/store/engine-migration.md). Same shape as `ops.rs`.

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;

use crate::store_binding::Brain;

#[napi]
impl Brain {
    /// `readEngineMigrationHistory()`: `{ held, pageVersions }`.
    #[napi]
    pub fn read_engine_migration_history<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_engine_migration_history())
    }

    /// `readMigrationRows(table)` for `facts` and `open_loops`: `{ columns, rows }`.
    #[napi]
    pub fn read_migration_rows<'env>(
        &self,
        env: &'env Env,
        table: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_migration_rows(&table))
    }

    /// `listManualLinkTransitions(sourceId, slug)`: the page's manual dated statements.
    #[napi]
    pub fn list_manual_link_transitions<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_manual_link_transitions(&source_id, &slug)
        })
    }

    /// `countLiveTimelineEntries()`: the timeline rows of live pages.
    #[napi]
    pub fn count_live_timeline_entries<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_live_timeline_entries())
    }
}
