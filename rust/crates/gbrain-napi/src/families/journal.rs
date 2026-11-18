//! The write journal: brain identity, local writers, write admission and receipts.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use crate::store_binding::{Brain, required};

#[napi]
impl Brain {
    /// `getBrainIdentity()`: `{ brain_id }`.
    #[napi]
    pub fn get_brain_identity<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.get_brain_identity())
    }

    /// `registerLocalWriter({ id, lane, credentialHash, grantCeiling? })`: the writer row.
    /// Idempotent; `writer_rejected` for a revoked row or a lane or credential mismatch.
    #[napi]
    pub fn register_local_writer<'env>(
        &self,
        env: &'env Env,
        writer: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.register_local_writer(&required(writer, "registerLocalWriter writer")?)
        })
    }

    /// `insertLocalWriterRow({ id, lane, credentialHash, grantCeiling? })`: `true` when this call
    /// stored the row, `false` when the id or the credential hash is already registered.
    #[napi]
    pub fn insert_local_writer_row<'env>(
        &self,
        env: &'env Env,
        writer: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_local_writer_row(&required(writer, "insertLocalWriterRow writer")?)
        })
    }

    /// `readLocalWriter(id)`: the writer row or `null`.
    #[napi]
    pub fn read_local_writer<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_local_writer(&id))
    }

    /// `revokeLocalWriter(id)`: `true` when the registration exists.
    #[napi]
    pub fn revoke_local_writer<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.revoke_local_writer(&id))
    }

    /// `admitWrite(admission, limits?)`: the stored `WriteRequest`, state `queued` when new.
    #[napi]
    pub fn admit_write<'env>(
        &self,
        env: &'env Env,
        admission: Value,
        limits: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let limits = match limits {
                None | Some(Value::Null) => None,
                Some(v) => Some(required(v, "admitWrite limits")?),
            };
            s.admit_write(&required(admission, "admitWrite admission")?, limits)
        })
    }

    /// `getWriteRequest(principal, requestId)`: the stored `WriteRequest` or `null`.
    #[napi]
    pub fn get_write_request<'env>(
        &self,
        env: &'env Env,
        principal: Value,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_write_request(
                &required(principal, "getWriteRequest principal")?,
                &request_id,
            )
        })
    }

    /// `getWriteReceipt(principal, requestId)`: `receiptFor` of the stored request or `null`.
    #[napi]
    pub fn get_write_receipt<'env>(
        &self,
        env: &'env Env,
        principal: Value,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_write_receipt(
                &required(principal, "getWriteReceipt principal")?,
                &request_id,
            )
        })
    }

    /// `finishWrite(principal, requestId, { state, outcome?, errorCode?, errorMessage?,
    /// blockedReason? })`: ends a request in a terminal state and resolves its receipt.
    #[napi]
    pub fn finish_write<'env>(
        &self,
        env: &'env Env,
        principal: Value,
        request_id: String,
        finish: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.finish_write(
                &required(principal, "finishWrite principal")?,
                &request_id,
                &required(finish, "finishWrite finish")?,
            )
        })
    }

    /// `journalOutstanding()`: `{ brain, principals }`, counts of unfinished requests.
    #[napi]
    pub fn journal_outstanding<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.journal_outstanding())
    }

    /// `submitPageMutation({ principal, requestId?, clientRequestId?, sourceIncarnation?, slug,
    /// page, options?, authority? }, limits?)`: admits, applies and commits a page write in one
    /// transaction and resolves its receipt.
    #[napi]
    pub fn submit_page_mutation<'env>(
        &self,
        env: &'env Env,
        mutation: Value,
        limits: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let limits = match limits {
                None | Some(Value::Null) => None,
                Some(v) => Some(required(v, "submitPageMutation limits")?),
            };
            s.submit_page_mutation(&required(mutation, "submitPageMutation mutation")?, limits)
        })
    }

    // The TypeScript journal members (`gbrain_store::persistence`).

    /// `lockPersistenceCounters(keys)`: the named counter rows in key order, created at zero.
    #[napi]
    pub fn lock_persistence_counters<'env>(
        &self,
        env: &'env Env,
        keys: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.lock_persistence_counters(&required::<Vec<String>>(
                keys,
                "lockPersistenceCounters keys",
            )?)
        })
    }

    /// `readWriteRequest(principal, requestId)`: the full `persistence_requests` row or `null`.
    #[napi]
    pub fn read_write_request<'env>(
        &self,
        env: &'env Env,
        principal: Value,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_write_request(
                &required(principal, "readWriteRequest principal")?,
                &request_id,
            )
        })
    }

    /// `readWriteRequestById(id)` and `lockWriteRequest(id)`: the row or `null`.
    #[napi]
    pub fn read_write_request_by_id<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_write_request_by_id(&id))
    }

    /// `insertWriteRequest(row)`: the stored row (`WriteRequestInsert`).
    #[napi]
    pub fn insert_write_request<'env>(
        &self,
        env: &'env Env,
        row: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_write_request(&required(row, "insertWriteRequest row")?)
        })
    }

    /// `stampWriteClaim({ id, token, leaseMs, phaseJson })`: the claimed row or `null`.
    #[napi]
    pub fn stamp_write_claim<'env>(
        &self,
        env: &'env Env,
        stamp: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.stamp_write_claim(&required(stamp, "stampWriteClaim stamp")?)
        })
    }

    /// `completeWriteRow(completion)`: the completed row, or `null` when the result does not fit.
    #[napi]
    pub fn complete_write_row<'env>(
        &self,
        env: &'env Env,
        completion: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.complete_write_row(&required(completion, "completeWriteRow completion")?)
        })
    }

    /// `renewWriteClaim({ id, token, leaseMs, phaseJson })`: `true` while the claim is held.
    #[napi]
    pub fn renew_write_claim<'env>(
        &self,
        env: &'env Env,
        stamp: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.renew_write_claim(&required(stamp, "renewWriteClaim stamp")?)
        })
    }

    #[napi]
    pub fn expire_stale_write_claims<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.expire_stale_write_claims(&required(spec, "expireStaleWriteClaims spec")?)
        })
    }

    /// `hasClaimableWrite({ excludeRoots, priority })`.
    #[napi]
    pub fn has_claimable_write<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_claimable_write(&required(spec, "hasClaimableWrite spec")?)
        })
    }

    #[napi]
    pub fn read_source_membership<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_source_membership(&source_id))
    }

    /// `claimHousekeepingTurn(claim)`: true when this host now holds the turn.
    #[napi]
    pub fn claim_housekeeping_turn<'env>(
        &self,
        env: &'env Env,
        claim: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.claim_housekeeping_turn(&required(claim, "claimHousekeepingTurn claim")?)
        })
    }

    #[napi]
    pub fn complete_housekeeping_turn<'env>(
        &self,
        env: &'env Env,
        turn: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.complete_housekeeping_turn(&required(turn, "completeHousekeepingTurn turn")?)
        })
    }

    /// `readReceiptBudget(retentionKey, floorDays)`: `{ retention, used, cutoff }`.
    #[napi]
    pub fn read_receipt_budget<'env>(
        &self,
        env: &'env Env,
        retention_key: String,
        floor_days: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_receipt_budget(&retention_key, floor_days)
        })
    }

    #[napi]
    pub fn list_reservations_after<'env>(
        &self,
        env: &'env Env,
        after: String,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_reservations_after(&after, limit))
    }

    #[napi]
    pub fn list_true_up_requests<'env>(
        &self,
        env: &'env Env,
        ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_true_up_requests(&ids))
    }

    /// `listGatedMirrorRequests(hostId)`: the requests to requeue; `[]` (no worktree here).
    #[napi]
    pub fn list_gated_mirror_requests<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_gated_mirror_requests(&host_id))
    }

    /// `listEffectRecoveries(hostId, after, limit)`: the effects with a recovery due; `[]` (no
    /// worktree here).
    #[napi]
    pub fn list_effect_recoveries<'env>(
        &self,
        env: &'env Env,
        host_id: String,
        after: Option<String>,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_effect_recoveries(&host_id, after.as_deref(), limit)
        })
    }

    /// `selectClaimableEffect(hostId)`: the next effect to claim; `null` (no effect is recorded
    /// here).
    #[napi]
    pub fn select_claimable_effect<'env>(
        &self,
        env: &'env Env,
        host_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.select_claimable_effect(&host_id))
    }

    #[napi]
    pub fn list_compactable_receipts<'env>(
        &self,
        env: &'env Env,
        retention_days: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_compactable_receipts(retention_days))
    }

    #[napi]
    pub fn read_capacity_forecast_inputs<'env>(
        &self,
        env: &'env Env,
        light: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_capacity_forecast_inputs(light))
    }

    /// `listPendingSegmentedProjections(filter)`: `{ source_id, source_incarnation, slug, revision }`
    /// rows, oldest first.
    #[napi]
    pub fn list_pending_segmented_projections<'env>(
        &self,
        env: &'env Env,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_pending_segmented_projections(&required(
                filter,
                "listPendingSegmentedProjections filter",
            )?)
        })
    }

    /// `selectProjectionWindowJobs(cursor, retryCooldown)`: the recency lane, then the key window;
    /// one row of nulls carrying the high water when no job is selected.
    #[napi]
    pub fn select_projection_window_jobs<'env>(
        &self,
        env: &'env Env,
        cursor: Value,
        retry_cooldown: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.select_projection_window_jobs(
                &required(cursor, "selectProjectionWindowJobs cursor")?,
                retry_cooldown,
            )
        })
    }

    /// `insertTopologyChange(input)`: the stored row.
    #[napi]
    pub fn insert_topology_change<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_topology_change(&required(input, "insertTopologyChange input")?)
        })
    }

    /// `readTopologyChange(principalId, requestId)`: the row, or null.
    #[napi]
    pub fn read_topology_change<'env>(
        &self,
        env: &'env Env,
        principal_id: String,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_topology_change(&principal_id, &request_id)
        })
    }

    /// `findTopologyChanges(principalId, requestIds)`: `[{ request_id }]` or [].
    #[napi]
    pub fn find_topology_changes<'env>(
        &self,
        env: &'env Env,
        principal_id: String,
        request_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.find_topology_changes(&principal_id, &request_ids)
        })
    }
}
