//! Orphan connector checkpoints (src/core/engine-sql/repair-bookkeeping.ts): one `#[napi] impl
//! Brain` block over `gbrain_store::persistence` (rust/docs/store/repair-bookkeeping.md).

use gbrain_store::persistence::OrphanBounds;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

/// `$n::integer` of a JS number: Postgres rounds a fraction to the nearest integer.
fn days(min_age_days: Option<f64>) -> Option<i64> {
    min_age_days.map(|d| d.round() as i64)
}

#[napi]
impl Brain {
    /// `listOrphanConnectorCheckpoints(loadable, bounds, limit)`: `[{ op, fingerprint, updated_at }]`.
    #[napi]
    pub fn list_orphan_connector_checkpoints<'env>(
        &self,
        env: &'env Env,
        loadable: Value,
        before: Option<String>,
        min_age_days: Option<f64>,
        state_op: String,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let loadable: Vec<String> =
                required(loadable, "listOrphanConnectorCheckpoints loadable")?;
            let bounds = OrphanBounds {
                before: before.as_deref(),
                min_age_days: days(min_age_days),
                state_op: &state_op,
            };
            s.list_orphan_connector_checkpoints(&loadable, &bounds, limit)
        })
    }

    /// `countConnectorCheckpointsKeyed(keys)`: how many connector checkpoints carry one of the keys.
    #[napi]
    pub fn count_connector_checkpoints_keyed<'env>(
        &self,
        env: &'env Env,
        keys: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let keys: Vec<String> = required(keys, "countConnectorCheckpointsKeyed keys")?;
            s.count_connector_checkpoints_keyed(&keys)
        })
    }

    /// `deleteOrphanConnectorCheckpoint(row, loadable, bounds)`: true when the row was deleted.
    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn delete_orphan_connector_checkpoint<'env>(
        &self,
        env: &'env Env,
        op: String,
        fingerprint: String,
        updated_at: String,
        loadable: Value,
        before: Option<String>,
        min_age_days: Option<f64>,
        state_op: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let loadable: Vec<String> =
                required(loadable, "deleteOrphanConnectorCheckpoint loadable")?;
            let bounds = OrphanBounds {
                before: before.as_deref(),
                min_age_days: days(min_age_days),
                state_op: &state_op,
            };
            s.delete_orphan_connector_checkpoint(&op, &fingerprint, &updated_at, &loadable, &bounds)
        })
    }
}
