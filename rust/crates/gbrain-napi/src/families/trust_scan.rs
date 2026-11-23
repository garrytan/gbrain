//! The trust scan's state (src/core/engine-sql/trust-scan.ts): one `#[napi] impl Brain` block
//! over `gbrain_store::persistence` (the cursor) and `gbrain_store::trust::scan_state` (the
//! claimed sources and the ceilings); rust/docs/store/trust.md, "Trust scan state".

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};
use gbrain_store::trust::scan_state::ClaimPendingQuery;

#[napi]
impl Brain {
    /// `readTrustScanCursor()`: the cursor row's `completed_keys`, or null.
    #[napi]
    pub fn read_trust_scan_cursor<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_trust_scan_cursor())
    }

    /// `writeTrustScanCursor(completedKeys)`: the cursor row's keys replaced.
    #[napi]
    pub fn write_trust_scan_cursor<'env>(
        &self,
        env: &'env Env,
        completed_keys: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let keys: Vec<Value> = required(completed_keys, "writeTrustScanCursor completedKeys")?;
            s.write_trust_scan_cursor(keys)
        })
    }

    /// `listClaimPendingSourceIds({ connectorKinds })`: the claimed sources whose lift has not
    /// finished, by id.
    #[napi]
    pub fn list_claim_pending_source_ids<'env>(
        &self,
        env: &'env Env,
        args: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let a: ClaimPendingQuery = required(args, "listClaimPendingSourceIds args")?;
            s.list_claim_pending_source_ids(&a)
        })
    }

    /// `readTrustScanCeilings()`: each scanned table's max id.
    #[napi]
    pub fn read_trust_scan_ceilings<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_trust_scan_ceilings())
    }
}
