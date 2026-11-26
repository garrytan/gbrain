//! The write journal: brain identity, local writers, write admission and receipts.
//!
//! One `#[napi] impl Brain` block per family file; `families/mod.rs` lists every family once.
//! Each method decodes its arguments, runs one `Store` call on the pool through `Brain::run`,
//! and resolves plain JSON (rust/README.md, "The brain store").

use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use gbrain_store::persistence::{Settle, TrueUpReservation, WriteRequestInsert};

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

    /// `readWriteRequestsByRequestId(requestId)`: at most two `persistence_requests` rows with this
    /// request id, from any principal.
    #[napi]
    pub fn read_write_requests_by_request_id<'env>(
        &self,
        env: &'env Env,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_write_requests_by_request_id(&request_id)
        })
    }

    /// `listWriteRequestRows(principal, sourceId, filter)`: the principal's request rows in one live
    /// source, newest sequence first, through the filter's cursor and fences.
    #[napi]
    pub fn list_write_request_rows<'env>(
        &self,
        env: &'env Env,
        principal: Value,
        source_id: String,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_write_request_rows(
                &required(principal, "listWriteRequestRows principal")?,
                &source_id,
                &required(filter, "listWriteRequestRows filter")?,
            )
        })
    }

    /// `listIncarnationRequests(filter)`: the request rows of one source incarnation through the
    /// filter's fences, by sequence (the dream cycle's two journal reads).
    #[napi]
    pub fn list_incarnation_requests<'env>(
        &self,
        env: &'env Env,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_incarnation_requests(&required(filter, "listIncarnationRequests filter")?)
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

    /// `listWriteRequestsByRequestIds(requestIds)`: the request rows by sequence.
    #[napi]
    pub fn list_write_requests_by_request_ids<'env>(
        &self,
        env: &'env Env,
        request_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_write_requests_by_request_ids(&request_ids)
        })
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

    /// `insertWriteRequestGroup(rows)`: the stored rows in order, inserted in one store write
    /// (`WriteRequestInsert[]`); a refusal at any row keeps none.
    #[napi]
    pub fn insert_write_request_group<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_write_request_group(&required::<Vec<WriteRequestInsert>>(
                rows,
                "insertWriteRequestGroup rows",
            )?)
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

    /// `compactTerminalIntent(compaction)`: the compacted row, or `null` for an unknown id.
    #[napi]
    pub fn compact_terminal_intent<'env>(
        &self,
        env: &'env Env,
        compaction: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.compact_terminal_intent(&required(compaction, "compactTerminalIntent compaction")?)
        })
    }

    /// `cancelWriteRow(cancellation)`: `{ status, row }`, or `null` when the row does not exist.
    #[napi]
    pub fn cancel_write_row<'env>(
        &self,
        env: &'env Env,
        cancellation: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.cancel_write_row(&required(cancellation, "cancelWriteRow cancellation")?)
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

    /// `insertPublicationEffects(spec)`: the kinds inserted, in queue order.
    #[napi]
    pub fn insert_publication_effects<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_publication_effects(&required(spec, "insertPublicationEffects spec")?)
        })
    }

    /// `insertWithdrawalEffects({ requestId, sourceId, data })`: the kinds inserted, in insert order.
    #[napi]
    pub fn insert_withdrawal_effects<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_withdrawal_effects(&required(spec, "insertWithdrawalEffects spec")?)
        })
    }

    /// `insertRemirrorEffects({ requestId, sourceId, data })`: the kinds inserted, in insert order.
    #[napi]
    pub fn insert_remirror_effects<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.insert_remirror_effects(&required(spec, "insertRemirrorEffects spec")?)
        })
    }

    /// `readRemirrorEffects(requestId)`: the request's effect states the segmented-mirror apply waits
    /// on, in kind order.
    #[napi]
    pub fn read_remirror_effects<'env>(
        &self,
        env: &'env Env,
        request_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_remirror_effects(&request_id))
    }

    /// `releaseUnpublishedClaim({ id, token, reason, charge })`: `true` when the claim was released.
    #[napi]
    pub fn release_unpublished_claim<'env>(
        &self,
        env: &'env Env,
        release: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.release_unpublished_claim(&required(release, "releaseUnpublishedClaim release")?)
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

    /// `hasClaimableWrite({ hostId, excludeRoots, priority })`.
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

    /// `selectClaimableWrite({ hostId, excludeRoots, fifoRoots, laneRoots, nonce, syncSeen, priority,
    /// leaseHolder })`: the request row `claimNextWrite` claims next, or `null`.
    #[napi]
    pub fn select_claimable_write<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.select_claimable_write(&required(spec, "selectClaimableWrite spec")?)
        })
    }

    /// `selectClaimableLaneHead({ hostId, worktreeId, run, seenSequence, nonce, priority })`: the lane head
    /// `claimNextLaneHead` claims next, or `null`.
    #[napi]
    pub fn select_claimable_lane_head<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.select_claimable_lane_head(&required(spec, "selectClaimableLaneHead spec")?)
        })
    }

    /// `stampLaneHeadClaim({ id, token, leaseMs, phaseJson })`: the claimed row with `seen_sequence`, or `null`.
    #[napi]
    pub fn stamp_lane_head_claim<'env>(
        &self,
        env: &'env Env,
        stamp: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.stamp_lane_head_claim(&required(stamp, "stampLaneHeadClaim stamp")?)
        })
    }

    /// `chargeTransientInterruption({ id, token, baseMs, maxMs })`: `{ transient_interruptions }`, or `null`.
    #[napi]
    pub fn charge_transient_interruption<'env>(
        &self,
        env: &'env Env,
        charge: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.charge_transient_interruption(&required(
                charge,
                "chargeTransientInterruption charge",
            )?)
        })
    }

    /// `reclaimReleasedWrite({ id, token, leaseMs, phaseJson })`: the claimed row, or `null`.
    #[napi]
    pub fn reclaim_released_write<'env>(
        &self,
        env: &'env Env,
        stamp: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.reclaim_released_write(&required(stamp, "reclaimReleasedWrite stamp")?)
        })
    }

    /// `readCounterRows(keys)`: the counter rows that exist, in key order, unlocked.
    #[napi]
    pub fn read_counter_rows<'env>(
        &self,
        env: &'env Env,
        keys: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_counter_rows(&required::<Vec<String>>(keys, "readCounterRows keys")?)
        })
    }

    /// `readAdmissionRate(principal)`: the first request id and the latest admissions' sample;
    /// both principal arguments null samples the whole brain.
    #[napi]
    pub fn read_admission_rate<'env>(
        &self,
        env: &'env Env,
        principal_kind: Option<String>,
        principal_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let principal = principal_kind.as_deref().zip(principal_id.as_deref());
            s.read_admission_rate(principal)
        })
    }

    /// `countOutstandingBySource(principalKind, principalId)`: `[{ source_id, n }]`, most first.
    #[napi]
    pub fn count_outstanding_by_source<'env>(
        &self,
        env: &'env Env,
        principal_kind: String,
        principal_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_outstanding_by_source(&principal_kind, &principal_id)
        })
    }

    /// `readWorktreeAdmission(worktreeId, sourceId, sourceIncarnation, topologyGeneration)`:
    /// `{ worktree, refresh, bound }`. The generation arrives as text (null for none).
    #[napi]
    pub fn read_worktree_admission<'env>(
        &self,
        env: &'env Env,
        worktree_id: String,
        source_id: String,
        source_incarnation: String,
        topology_generation: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_worktree_admission(&gbrain_store::persistence::WorktreeAdmissionKey {
                worktree_id,
                source_id,
                source_incarnation,
                topology_generation,
            })
        })
    }

    /// `completeSyncedRefresh(refreshId)`: true when a `syncing` refresh was completed.
    #[napi]
    pub fn complete_synced_refresh<'env>(
        &self,
        env: &'env Env,
        refresh_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.complete_synced_refresh(&refresh_id))
    }

    /// `hasDeferralRoom(worktreeId, liveMs)`: whether no live consumer on the owner host lacks the capability.
    #[napi]
    pub fn has_deferral_room<'env>(
        &self,
        env: &'env Env,
        worktree_id: String,
        live_ms: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_deferral_room(&worktree_id, live_ms as i64)
        })
    }

    /// `readRefreshTiming(refreshId)`: `{ elapsed_ms, typical_ms }` or null.
    #[napi]
    pub fn read_refresh_timing<'env>(
        &self,
        env: &'env Env,
        refresh_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_refresh_timing(&refresh_id))
    }

    /// `countHeldBehindImport(sourceId, principalKind, principalId)`: `{ count, bytes }`; a null principal counts every one.
    #[napi]
    pub fn count_held_behind_import<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        principal_kind: Option<String>,
        principal_id: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let principal = principal_kind.as_deref().zip(principal_id.as_deref());
            s.count_held_behind_import(&source_id, principal)
        })
    }

    /// `readWriteWatermarkRow`'s journal half for one source incarnation (null for an absent source).
    #[napi]
    pub fn read_request_watermark<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_request_watermark(&source_id, incarnation.as_deref())
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

    /// `listLaterPersistenceRequests(sourceId, incarnation, slug, sequence)`: the live and committed
    /// request rows on the slug after the sequence (decimal text), in sequence order.
    #[napi]
    pub fn list_later_persistence_requests<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        incarnation: String,
        slug: String,
        sequence: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_later_persistence_requests(&source_id, &incarnation, &slug, &sequence)
        })
    }

    /// `listCommittedOutputRequests(requestIds, sourceId, incarnation)`: `{ request }` per committed
    /// `put_page` row, newest sequence first.
    #[napi]
    pub fn list_committed_output_requests<'env>(
        &self,
        env: &'env Env,
        request_ids: Vec<String>,
        source_id: String,
        incarnation: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_committed_output_requests(&request_ids, &source_id, &incarnation)
        })
    }

    #[napi]
    pub fn list_true_up_requests<'env>(
        &self,
        env: &'env Env,
        ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_true_up_requests(&ids))
    }

    /// `trueUpReservations(rows)`: the bytes the true-up gave back, as text.
    #[napi]
    pub fn true_up_reservations<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.true_up_reservations(&required::<Vec<TrueUpReservation>>(
                rows,
                "trueUpReservations rows",
            )?)
        })
    }

    /// `listGatedMirrorRequests(hostId, gateCode, allowedCodes)`: the requests to requeue.
    #[napi]
    pub fn list_gated_mirror_requests<'env>(
        &self,
        env: &'env Env,
        host_id: String,
        gate_code: String,
        allowed_codes: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_gated_mirror_requests(&host_id, &gate_code, &allowed_codes)
        })
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

    /// `readRequestEffects(requestId, kind)`: the request's effect states in kind order, or only
    /// its `kind` effect.
    #[napi]
    pub fn read_request_effects<'env>(
        &self,
        env: &'env Env,
        request_id: String,
        kind: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_request_effect_states(&request_id, kind.as_deref())
        })
    }

    /// `readStaleEmbeddingCounts(sourceIds | null)`: `{ count, failed, requeued }` over doctor's stale embedding effects.
    #[napi]
    pub fn read_stale_embedding_counts<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_stale_embedding_counts(source_ids.as_deref())
        })
    }

    /// `listStaleEmbeddingEffects(sourceIds | null)`: the first 10 of them by effect id.
    #[napi]
    pub fn list_stale_embedding_effects<'env>(
        &self,
        env: &'env Env,
        source_ids: Option<Vec<String>>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_stale_embedding_effects(source_ids.as_deref())
        })
    }

    /// `listEmbeddingCandidates(sourceIds, neverRetried)`: the stale queued and failed embedding
    /// effects `gbrain repair embedding-effects` settles, in effect id order.
    #[napi]
    pub fn list_embedding_candidates<'env>(
        &self,
        env: &'env Env,
        source_ids: Vec<String>,
        never_retried: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_embedding_candidates(&source_ids, &never_retried)
        })
    }

    /// `selectClaimableEffect(hostId, deadOwners)`: the next effect to claim as its row, or `null`.
    #[napi]
    pub fn select_claimable_effect<'env>(
        &self,
        env: &'env Env,
        host_id: String,
        dead_owners: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.select_claimable_effect(&host_id, &dead_owners)
        })
    }

    /// `stampEffectClaim({ id, token, ownerJson })`: the claimed row, or `null`.
    #[napi]
    pub fn stamp_effect_claim<'env>(
        &self,
        env: &'env Env,
        claim: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.stamp_effect_claim(&required(claim, "stampEffectClaim claim")?)
        })
    }

    /// `claimEffectRecovery({ id, token, ownerJson })`: the claimed row, or `null` when the effect holds no recovery.
    #[napi]
    pub fn claim_effect_recovery<'env>(
        &self,
        env: &'env Env,
        claim: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.claim_effect_recovery(&required(claim, "claimEffectRecovery claim")?)
        })
    }

    /// `claimCoalescedGitEffects({ hostId, worktreeId, limit, deadOwners, ownerJson })`: the claimed rows.
    #[napi]
    pub fn claim_coalesced_git_effects<'env>(
        &self,
        env: &'env Env,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.claim_coalesced_git_effects(&required(input, "claimCoalescedGitEffects input")?)
        })
    }

    /// `readMirrorGateRows(requestIds)`: the withdrawal mirrors that gate these requests.
    #[napi]
    pub fn read_mirror_gate_rows<'env>(
        &self,
        env: &'env Env,
        request_ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_mirror_gate_rows(&request_ids))
    }

    /// `hasRearmableTargets(requestIds, code)`: whether a target parked under `code` waits on a
    /// committed withdrawal mirror.
    #[napi]
    pub fn has_rearmable_targets<'env>(
        &self,
        env: &'env Env,
        request_ids: Vec<String>,
        code: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_rearmable_targets(&request_ids, &code))
    }

    /// `readHeadBlockerRows({ ids, priority })`: one head-blocker probe row per queued request
    /// asked about (`src/core/engine-sql/head-blocker.ts`).
    #[napi]
    pub fn read_head_blocker_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_head_blocker_rows(&required(spec, "readHeadBlockerRows spec")?)
        })
    }

    /// `readIncompleteSyncReceipt(spec)`: the request id of a receipt that blocks a managed sync
    /// run's checkpoint, or null (`src/core/engine-sql/checkpoint-validation.ts`).
    #[napi]
    pub fn read_incomplete_sync_receipt<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_incomplete_sync_receipt(&required(spec, "readIncompleteSyncReceipt spec")?)
        })
    }

    /// `readOpenPassWork(spec)`: the request id of the work that blocks a pass stamp, or null.
    #[napi]
    pub fn read_open_pass_work<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_open_pass_work(&required(spec, "readOpenPassWork spec")?)
        })
    }

    /// `readIncompleteSyncReceiptRows(spec)`: up to 20 receipts that block the run's checkpoint.
    #[napi]
    pub fn read_incomplete_sync_receipt_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_incomplete_sync_receipt_rows(&required(
                spec,
                "readIncompleteSyncReceiptRows spec",
            )?)
        })
    }

    /// `readIdentityDowngradeRows({ op, sourceIds })`: the open identity-downgrade records, oldest
    /// first, each with the live slugs at its new path (`src/core/engine-sql/sync-status-reads.ts`).
    #[napi]
    pub fn read_identity_downgrade_rows<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_identity_downgrade_rows(&required(spec, "readIdentityDowngradeRows spec")?)
        })
    }

    /// `readIdentityDowngradeOldPage(sourceId, path, slug)`: the soft-deleted page an identity
    /// downgrade record names, or null.
    #[napi]
    pub fn read_identity_downgrade_old_page<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        path: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_identity_downgrade_old_page(&source_id, &path, &slug)
        })
    }

    /// `countIdentityDowngradeCarry(sourceId, slug, pageId)`: the facts, links and aliases an old
    /// page carries.
    #[napi]
    pub fn count_identity_downgrade_carry<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        page_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.count_identity_downgrade_carry(&source_id, &slug, page_id.max(0.0) as u64)
        })
    }

    /// `readIdentityRemedySide(sourceId, pageId, slug)`: one page of the source by id (when given)
    /// or slug, deleted or not, or null.
    #[napi]
    pub fn read_identity_remedy_side<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        page_id: Option<f64>,
        slug: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_identity_remedy_side(
                &source_id,
                page_id.filter(|id| *id >= 1.0).map(|id| id as u64),
                slug.as_deref(),
            )
        })
    }

    /// `probeIdleWork(spec)`: whether any worker of this host has work, and where the resident
    /// projection window stands (`{ work, projection_work, projection_last, high_water }`).
    #[napi]
    pub fn probe_idle_work<'env>(&self, env: &'env Env, spec: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.probe_idle_work(&required(spec, "probeIdleWork spec")?)
        })
    }

    /// `probeNoopEmbeddingSettle(from)`: whether an unattempted queued embedding effect lies past
    /// effect id `from`.
    #[napi]
    pub fn probe_noop_embedding_settle<'env>(
        &self,
        env: &'env Env,
        from: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.probe_noop_embedding_settle(&from))
    }

    /// `lockNoopEmbeddingWindow({ from, limit })`: the newest effect id and the next `limit`
    /// unattempted embedding effects past `from` (`{ newest, rows }`).
    #[napi]
    pub fn lock_noop_embedding_window<'env>(
        &self,
        env: &'env Env,
        from: String,
        limit: i64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.lock_noop_embedding_window(&from, limit))
    }

    /// `readNoopEmbeddingCandidates(spec)`: the window effects with nothing left to embed.
    #[napi]
    pub fn read_noop_embedding_candidates<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_noop_embedding_candidates(&required(spec, "readNoopEmbeddingCandidates spec")?)
        })
    }

    /// `settleNoopEmbeddingRows(ids)`: settles these queued effects; `[{ id, request_id }]`.
    #[napi]
    pub fn settle_noop_embedding_rows<'env>(
        &self,
        env: &'env Env,
        ids: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.settle_noop_embedding_rows(&ids))
    }

    /// One effect settle statement, `action` naming the member (`renewEffectClaim`,
    /// `advanceEffectRow`, `completeEffectRow`, `retryEffectRow`, `retryBusyEffectRow`,
    /// `requeueEffectRow`, `parkEffectRow`, `failEffectRow`): `true` when it matched the claim.
    #[napi]
    pub fn settle_effect<'env>(
        &self,
        env: &'env Env,
        action: String,
        settle: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let action = match action.as_str() {
                "renewEffectClaim" => Settle::Renew,
                "advanceEffectRow" => Settle::Advance,
                "completeEffectRow" => Settle::Complete,
                "retryEffectRow" => Settle::Retry,
                "retryBusyEffectRow" => Settle::RetryBusy,
                "requeueEffectRow" => Settle::Requeue,
                "parkEffectRow" => Settle::Park,
                "failEffectRow" => Settle::Fail,
                other => {
                    return Err(gbrain_store::error::StoreError::invalid(format!(
                        "unknown effect settle member {other}"
                    )));
                }
            };
            s.settle_effect(action, &required(settle, "effect settle")?)
        })
    }

    /// `listOverdueHeldWrites(hostId, maxWaitMs, hold)`: the deferred writes on owned worktrees
    /// past their hold.
    #[napi]
    pub fn list_overdue_held_writes<'env>(
        &self,
        env: &'env Env,
        host_id: String,
        max_wait_ms: f64,
        hold: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_overdue_held_writes(&host_id, max_wait_ms, &hold)
        })
    }

    /// `lockOverdueHold(hold)`: whether the hold still stands (a refresh unreleased, or an
    /// import still pending and overdue).
    #[napi]
    pub fn lock_overdue_hold<'env>(
        &self,
        env: &'env Env,
        hold: String,
        id: Option<String>,
        import_from: Option<String>,
        max_wait_ms: Option<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let wait = max_wait_ms.unwrap_or(0.0);
            s.lock_overdue_hold(&hold, id.as_deref(), import_from.as_deref(), wait)
        })
    }

    /// `listOwnerRecoveryHeads(hostId, excluded)`: the oldest recovering write of each owned
    /// worktree not in `excluded`.
    #[napi]
    pub fn list_owner_recovery_heads<'env>(
        &self,
        env: &'env Env,
        host_id: String,
        excluded: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_owner_recovery_heads(&host_id, &excluded)
        })
    }

    /// `listResumableRefreshes(hostId, budgetMs)`: the interrupted refreshes of the host's worktrees;
    /// the sync budget marks a row stale once it has not moved for that long.
    #[napi]
    pub fn list_resumable_refreshes<'env>(
        &self,
        env: &'env Env,
        host_id: String,
        budget_ms: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_resumable_refreshes(&host_id, budget_ms))
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
    pub fn read_receipt_compaction_window<'env>(
        &self,
        env: &'env Env,
        hours: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_receipt_compaction_window(hours))
    }

    #[napi]
    pub fn list_receipt_compaction_candidates<'env>(
        &self,
        env: &'env Env,
        states: Vec<String>,
        cutoff: String,
        max_sequence: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_receipt_compaction_candidates(&states, &cutoff, &max_sequence)
        })
    }

    #[napi]
    pub fn count_kept_failed_receipts<'env>(
        &self,
        env: &'env Env,
        cutoff: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_kept_failed_receipts(&cutoff))
    }

    /// `readWriterVersionCutoff()`: the brain's creation time as ISO text, or `null`.
    #[napi]
    pub fn read_writer_version_cutoff<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_writer_version_cutoff())
    }

    /// `listWriterVersions(limit)`: `{ role, host_id, principal, version, last_seen }` rows.
    #[napi]
    pub fn list_writer_versions<'env>(
        &self,
        env: &'env Env,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_writer_versions(limit))
    }

    /// `recentWriterVersions(days)`: the same rows with a `requests` count.
    #[napi]
    pub fn recent_writer_versions<'env>(
        &self,
        env: &'env Env,
        days: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.recent_writer_versions(days))
    }

    /// `readSegmentedGateEvidence(days)`: every writer the segmented-storage gate saw in the
    /// last `days`, newest first.
    #[napi]
    pub fn read_segmented_gate_evidence<'env>(
        &self,
        env: &'env Env,
        days: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_segmented_gate_evidence(days))
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

    /// `claimSegmentedProjection({ sourceId, slug }, claim)`: `claimed`, `held` or `absent`.
    #[napi]
    pub fn claim_segmented_projection<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        claim: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.claim_segmented_projection(&source_id, &slug, &claim)
        })
    }

    /// `renewSegmentedProjectionClaim({ sourceId, slug }, claim)`: false when the job no longer
    /// carries the claim.
    #[napi]
    pub fn renew_segmented_projection_claim<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        claim: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.renew_segmented_projection_claim(&source_id, &slug, &claim)
        })
    }

    /// `releaseSegmentedProjectionClaim({ sourceId, slug }, claim)`.
    #[napi]
    pub fn release_segmented_projection_claim<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        claim: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.release_segmented_projection_claim(&source_id, &slug, &claim)
        })
    }

    /// `listQueuedPageProjections(filter)`: `{ source_id, source_incarnation, slug, revision,
    /// page_kind, updated_at }` rows in walk order.
    #[napi]
    pub fn list_queued_page_projections<'env>(
        &self,
        env: &'env Env,
        filter: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_queued_page_projections(&required(filter, "listQueuedPageProjections filter")?)
        })
    }

    /// `readProjectionJobReason(key)`: the job's reason, or `null`.
    #[napi]
    pub fn read_projection_job_reason<'env>(
        &self,
        env: &'env Env,
        key: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_projection_job_reason(&required(key, "readProjectionJobReason key")?)
        })
    }

    /// `deleteProjectionJob({ sourceIncarnation, slug, revision })`.
    #[napi]
    pub fn delete_projection_job<'env>(
        &self,
        env: &'env Env,
        job: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_projection_job(&required(job, "deleteProjectionJob job")?)
        })
    }

    /// `markProjectionRebuildFailed({ sourceIncarnation, slug, revision })`.
    #[napi]
    pub fn mark_projection_rebuild_failed<'env>(
        &self,
        env: &'env Env,
        job: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.mark_projection_rebuild_failed(&required(job, "markProjectionRebuildFailed job")?)
        })
    }

    /// `readChunkKeepState(pageId, provenanceModel, column)`: the `embedding` column's width is
    /// `dims`. `{ id, embedding_input_hash, movable }` rows.
    #[napi]
    pub fn read_chunk_keep_state<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        model: Option<String>,
        dims: u32,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_chunk_keep_state(page_id, model.as_deref(), dims)
        })
    }

    /// `clearUnkeptChunkVectors(pageId, provenanceModel, column, currentIds)`: resolves null.
    #[napi]
    pub fn clear_unkept_chunk_vectors<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        model: Option<String>,
        dims: u32,
        current_ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.clear_unkept_chunk_vectors(page_id, model.as_deref(), dims, &current_ids)
        })
    }

    /// `hasDrainableProjectionJob()`: whether a drainable job is queued.
    #[napi]
    pub fn has_drainable_projection_job<'env>(
        &self,
        env: &'env Env,
        media: Option<bool>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_drainable_projection_job(media.unwrap_or(false))
        })
    }

    /// `readChunkRowsFingerprint(pageId)`: the store's opaque value of the page's chunk rows.
    #[napi]
    pub fn read_chunk_rows_fingerprint<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_chunk_rows_fingerprint(page_id))
    }

    /// `deleteUnkeptChunks(pageId, keptIds)`: resolves null.
    #[napi]
    pub fn delete_unkept_chunks<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        kept_ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.delete_unkept_chunks(page_id, &kept_ids))
    }

    /// `listStaleChunkVectors(pageId, provenanceModel, column, currentIds)`: the `embedding`
    /// column's width is `dims`. Chunk ids in chunk order.
    #[napi]
    pub fn list_stale_chunk_vectors<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        model: Option<String>,
        dims: u32,
        current_ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_stale_chunk_vectors(page_id, model.as_deref(), dims, &current_ids)
        })
    }

    /// `clearChunkVectors(pageId, column, ids)`: resolves null.
    #[napi]
    pub fn clear_chunk_vectors<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
        ids: Vec<f64>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.clear_chunk_vectors(page_id, &ids))
    }

    /// `countPendingTextChunks(pageId, column)`: `{ chunks, chars }` of the `embedding` column.
    #[napi]
    pub fn count_pending_text_chunks<'env>(
        &self,
        env: &'env Env,
        page_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_pending_text_chunks(page_id))
    }

    /// `probeProjectionWindowCandidates(candidates)`: `{ i, source_id, archived, page_kind,
    /// body_storage }` per candidate, in candidate order.
    #[napi]
    pub fn probe_projection_window_candidates<'env>(
        &self,
        env: &'env Env,
        candidates: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.probe_projection_window_candidates(&required::<
                Vec<gbrain_store::persistence::ProjectionWindowCandidate>,
            >(
                candidates,
                "probeProjectionWindowCandidates candidates",
            )?)
        })
    }

    /// `readProjectionHead(sourceId, slug)`: `{ id, revision, sealed }` or null.
    #[napi]
    pub fn read_projection_head<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_projection_head(&source_id, &slug))
    }

    /// `isDeferredReplacementHeld(sourceId, slug, revision, claim)`.
    #[napi]
    pub fn is_deferred_replacement_held<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        revision: String,
        claim: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.is_deferred_replacement_held(&source_id, &slug, &revision, &claim)
        })
    }

    /// `renewDeferredReplacementClaim({ sourceIncarnation, slug, revision }, claim)`.
    #[napi]
    pub fn renew_deferred_replacement_claim<'env>(
        &self,
        env: &'env Env,
        job: Value,
        claim: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.renew_deferred_replacement_claim(
                &required(job, "renewDeferredReplacementClaim job")?,
                &claim,
            )
        })
    }

    /// `listProjectionDrainPreview(limit)`: the preview rows.
    #[napi]
    pub fn list_projection_drain_preview<'env>(
        &self,
        env: &'env Env,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_projection_drain_preview(limit))
    }

    /// `hasQueuedProjectionWork()`.
    #[napi]
    pub fn has_queued_projection_work<'env>(
        &self,
        env: &'env Env,
        media: Option<bool>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.has_queued_projection_work(media.unwrap_or(false))
        })
    }

    /// `listImageSealWindow(afterIncarnation, afterSlug, limit, notAfter)`.
    #[napi]
    pub fn list_image_seal_window<'env>(
        &self,
        env: &'env Env,
        after_incarnation: String,
        after_slug: String,
        limit: f64,
        not_after: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_image_seal_window(&after_incarnation, &after_slug, limit, not_after.as_deref())
        })
    }

    /// `readImageSealPages(rows)`.
    #[napi]
    pub fn read_image_seal_pages<'env>(
        &self,
        env: &'env Env,
        rows: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let rows: Vec<gbrain_store::persistence::ImageSealRow> =
                required(rows, "readImageSealPages rows")?;
            s.read_image_seal_pages(&rows)
        })
    }

    /// `listImageSealChunks(pageIds, provenanceModel)`.
    #[napi]
    pub fn list_image_seal_chunks<'env>(
        &self,
        env: &'env Env,
        page_ids: Vec<f64>,
        provenance_model: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_image_seal_chunks(&page_ids, provenance_model.as_deref())
        })
    }

    /// `clearImageSealVectors(chunks)`.
    #[napi]
    pub fn clear_image_seal_vectors<'env>(
        &self,
        env: &'env Env,
        chunks: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let chunks: Vec<gbrain_store::persistence::ImageSealChunkRef> =
                required(chunks, "clearImageSealVectors chunks")?;
            s.clear_image_seal_vectors(&chunks)
        })
    }

    /// `sealImagePages(pages)`.
    #[napi]
    pub fn seal_image_pages<'env>(
        &self,
        env: &'env Env,
        pages: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let pages: Vec<gbrain_store::persistence::ImageSealPageRef> =
                required(pages, "sealImagePages pages")?;
            s.seal_image_pages(&pages)
        })
    }

    /// `readDrainRunStart()`: the store clock as `now()::text`.
    #[napi]
    pub fn read_drain_run_start<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_drain_run_start())
    }

    /// `isDrainClockPast(runStart)`.
    #[napi]
    pub fn is_drain_clock_past<'env>(
        &self,
        env: &'env Env,
        run_start: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.is_drain_clock_past(&run_start))
    }

    /// `queuePageProjectionJob(sourceId, slug, reason)`.
    #[napi]
    pub fn queue_page_projection_job<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
        reason: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.queue_page_projection_job(&source_id, &slug, &reason)
        })
    }

    /// `releaseDeferredReplacementClaim(slug, claim)`.
    #[napi]
    pub fn release_deferred_replacement_claim<'env>(
        &self,
        env: &'env Env,
        slug: String,
        claim: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.release_deferred_replacement_claim(&slug, &claim)
        })
    }

    /// `hasSegmentedPage(sourceId, slug)`.
    #[napi]
    pub fn has_segmented_page<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        slug: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.has_segmented_page(&source_id, &slug))
    }

    /// `rekeyProjectionJob({ sourceIncarnation, slug, revision }, revision)`.
    #[napi]
    pub fn rekey_projection_job<'env>(
        &self,
        env: &'env Env,
        job: Value,
        revision: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.rekey_projection_job(&required(job, "rekeyProjectionJob job")?, &revision)
        })
    }

    /// `stampDeferredProjectionJob({ sourceIncarnation, slug, revision }, requeue)`.
    #[napi]
    pub fn stamp_deferred_projection_job<'env>(
        &self,
        env: &'env Env,
        job: Value,
        requeue: bool,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.stamp_deferred_projection_job(
                &required(job, "stampDeferredProjectionJob job")?,
                requeue,
            )
        })
    }

    /// `touchUnclaimedProjectionJob({ sourceIncarnation, slug, revision })`.
    #[napi]
    pub fn touch_unclaimed_projection_job<'env>(
        &self,
        env: &'env Env,
        job: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.touch_unclaimed_projection_job(&required(job, "touchUnclaimedProjectionJob job")?)
        })
    }

    /// `deferProjectionJob({ sourceIncarnation, slug, revision })`: whether a job was queued.
    #[napi]
    pub fn defer_projection_job<'env>(
        &self,
        env: &'env Env,
        job: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.defer_projection_job(&required(job, "deferProjectionJob job")?)
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

    /// `readOwnerHostBinding(worktreeId)`: the owner host's binding `local_path`, or null.
    #[napi]
    pub fn read_owner_host_binding<'env>(
        &self,
        env: &'env Env,
        worktree_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_owner_host_binding(&worktree_id))
    }

    /// `listTopologyRecoveries(hostId, after, limit)`: this host's topology changes in recovery,
    /// in id order after `after`.
    #[napi]
    pub fn list_topology_recoveries<'env>(
        &self,
        env: &'env Env,
        host_id: String,
        after: Option<String>,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_topology_recoveries(&host_id, after.as_deref(), limit)
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

    /// `readTopologyChangeDigest(requestId, sourceId)`: the digest text, or `null`.
    #[napi]
    pub fn read_topology_change_digest<'env>(
        &self,
        env: &'env Env,
        request_id: String,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_topology_change_digest(&request_id, &source_id)
        })
    }
}
