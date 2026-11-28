//! Replica acks and diverged-tail recovery for TypeScript (multi-user mode with the commit log;
//! rust/docs/store/commit-log.md, "Replica acks" and "Diverged tail recovery"), for the served layer's replica gate
//! (`src/core/rust-engine/served/replica-gate.ts`) and the follower session (`follower-serve.ts`):
//!
//! - `Brain#attachReplica(id)` -> `{ id, generation, attached_at_us }` (idempotent: an attached id keeps its generation);
//! - `Brain#detachReplica(id, reason)` -> whether a detach was committed;
//! - `Brain#reportReplicaAck(id, generation, cursor, lineage | null)` -> the replica's acked cursor after the report;
//! - `Brain#replicaCover(position)` -> `{ required, covered, acked_through }`;
//! - `Brain#replicaAckSettings()` -> `{ timeout_ms, max_waiters }`;
//! - `Follower#lineage()` -> the timelines its log went through after its first one (sent with a replica's cursor);
//! - `Follower#notePrimaryAcked(position)` -> whether the mark moved;
//! - `Follower#exportDivergedTail(dir, lineage)` and `Follower#allowInstallOver(dir)` -> the export's header.
//!
//! Store refusals keep their codes (`invalid_state`, `diverged_tail`, `export_no_space`, ...). The blocking
//! `Store::wait_replicated` stays off this surface: a pool worker held for an ack could starve the send loop that
//! brings the ack, so TypeScript waits on its own ack event instead.

use gbrain_store::StoreError;
use gbrain_store::commit_log::{CommitPosition, Timeline};
use gbrain_store::replica::ReplicaCover;
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::{Value, json};

use super::follower::{Follower, lineage_in_store, position_in_store, position_out_store};
use crate::store_binding::Brain;

fn cover_out(c: &ReplicaCover) -> Result<Value, StoreError> {
    Ok(json!({
        "required": c.required,
        "covered": c.covered,
        "acked_through": c.acked_through.map(position_out_store).transpose()?,
    }))
}

fn lineage_arg(v: Option<Value>) -> Result<Option<Vec<Timeline>>, StoreError> {
    v.filter(|l| !l.is_null())
        .map(|l| lineage_in_store(&l))
        .transpose()
}

#[napi]
impl Brain {
    /// `attachReplica(id)`: module docs.
    #[napi]
    pub fn attach_replica<'env>(&self, env: &'env Env, id: String) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.attach_replica(&id))
    }

    /// `detachReplica(id, reason)`: module docs.
    #[napi]
    pub fn detach_replica<'env>(
        &self,
        env: &'env Env,
        id: String,
        reason: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.detach_replica(&id, &reason))
    }

    /// `reportReplicaAck(id, generation, cursor, lineage | null)`: module docs.
    #[napi]
    pub fn report_replica_ack<'env>(
        &self,
        env: &'env Env,
        id: String,
        generation: f64,
        cursor: Value,
        lineage: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            if !(generation.fract() == 0.0 && (1.0..9_007_199_254_740_992.0).contains(&generation))
            {
                return Err(StoreError::new(
                    gbrain_store::error::INVALID_ARGUMENT,
                    format!("generation must be a positive integer below 2^53, not {generation}"),
                ));
            }
            let cursor: CommitPosition = position_in_store(&cursor, "cursor")?;
            let lineage = lineage_arg(lineage)?;
            let acked = s.report_replica_ack(&id, generation as u64, cursor, lineage.as_deref())?;
            position_out_store(acked)
        })
    }

    /// `replicaCover(position)`: module docs.
    #[napi]
    pub fn replica_cover<'env>(
        &self,
        env: &'env Env,
        position: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let at = position_in_store(&position, "position")?;
            cover_out(&s.replica_cover(at)?)
        })
    }

    /// `replicaAckSettings()`: module docs.
    #[napi]
    pub fn replica_ack_settings<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, |s| {
            let set = s.replica_ack_settings();
            Ok(json!({ "timeout_ms": set.timeout_ms, "max_waiters": set.max_waiters }))
        })
    }
}

#[napi]
impl Follower {
    /// `lineage()`: module docs.
    #[napi]
    pub fn lineage<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run_store(env, |f| lineage_value(&f.lineage()))
    }

    /// `notePrimaryAcked(position)`: module docs.
    #[napi]
    pub fn note_primary_acked<'env>(
        &self,
        env: &'env Env,
        position: Value,
    ) -> napi::Result<Object<'env>> {
        self.run_store(env, move |f| {
            let at = position_in_store(&position, "position")?;
            Ok(json!(f.note_primary_acked(at)?))
        })
    }

    /// `exportDivergedTail(dir, lineage)`: module docs.
    #[napi]
    pub fn export_diverged_tail<'env>(
        &self,
        env: &'env Env,
        dir: String,
        lineage: Value,
    ) -> napi::Result<Object<'env>> {
        self.run_store(env, move |f| {
            let theirs = lineage_in_store(&lineage)?;
            let header = f.export_diverged_tail(std::path::Path::new(&dir), &theirs)?;
            header_out(&header)
        })
    }

    /// `allowInstallOver(dir)`: module docs.
    #[napi]
    pub fn allow_install_over<'env>(
        &self,
        env: &'env Env,
        dir: String,
    ) -> napi::Result<Object<'env>> {
        self.run_store(env, move |f| {
            header_out(&f.allow_install_over(std::path::Path::new(&dir))?)
        })
    }
}

fn lineage_value(l: &[Timeline]) -> Result<Value, StoreError> {
    l.iter()
        .map(|t| Ok(json!({ "id": t.id, "from": position_out_store(t.from)? })))
        .collect::<Result<Vec<Value>, StoreError>>()
        .map(Value::Array)
}

fn header_out(h: &gbrain_store::diverged_tail::TailHeader) -> Result<Value, StoreError> {
    let lineage = lineage_value;
    Ok(json!({
        "brain_id": h.brain_id,
        "fork": position_out_store(h.fork)?,
        "cursor": position_out_store(h.cursor)?,
        "mine_lineage": lineage(&h.mine_lineage)?,
        "theirs_lineage": lineage(&h.theirs_lineage)?,
        "trimmed_through": h.trimmed_through.map(position_out_store).transpose()?,
        "records": h.records,
    }))
}
