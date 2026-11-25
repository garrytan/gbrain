//! Jobs slice 2: the writes on one job, the sweeps, the inbox, the private queues, the reads and
//! the attachments (rust/docs/store/jobs.md). Same shape as the slice 1 methods in `../jobs.rs`.

use gbrain_store::jobs::{
    AttachmentInput, CancelOpts, DelayOpts, JobPageSpec, OverdueSpec, PruneSpec, TokenDelta,
};
use napi::Env;
use napi::bindgen_prelude::Object;
use napi_derive::napi;
use serde_json::Value;

use super::job_id;
use crate::store_binding::{Brain, arg, required};
use gbrain_store::error::StoreError;
use gbrain_store::leases::LeaseToken;

/// A list of job ids from JavaScript.
fn job_ids(ids: Vec<f64>, what: &str) -> Result<Vec<i64>, StoreError> {
    ids.into_iter().map(|id| job_id(id, what)).collect()
}

/// A count or limit from JavaScript: a whole number.
fn whole(n: f64, what: &str) -> Result<i64, StoreError> {
    if n.fract() != 0.0 || !n.is_finite() || n.abs() > 9_007_199_254_740_991.0 {
        return Err(StoreError::invalid(format!(
            "{what}: {n} is not a whole number"
        )));
    }
    Ok(n as i64)
}

#[napi]
impl Brain {
    // ---------------------------------------------------------------- writes on one job

    /// `deleteTerminalJob(id)`: whether a terminal row was deleted (with its cascade).
    #[napi]
    pub fn delete_terminal_job<'env>(&self, env: &'env Env, id: f64) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_terminal_job(job_id(id, "deleteTerminalJob")?)
        })
    }

    /// `pauseJob(id)`: the paused row, or null.
    #[napi]
    pub fn pause_job<'env>(&self, env: &'env Env, id: f64) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.pause_job(job_id(id, "pauseJob")?))
    }

    /// `resumeJob(id)`: the resumed row, or null.
    #[napi]
    pub fn resume_job<'env>(&self, env: &'env Env, id: f64) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.resume_job(job_id(id, "resumeJob")?))
    }

    /// `failParentJob(parentId, errorText)`: the failed parent, or null.
    #[napi]
    pub fn fail_parent_job<'env>(
        &self,
        env: &'env Env,
        parent_id: f64,
        error_text: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.fail_parent_job(job_id(parent_id, "failParentJob")?, &error_text)
        })
    }

    /// `resolveParentJob(parentId)`: the woken parent, or null.
    #[napi]
    pub fn resolve_parent_job<'env>(
        &self,
        env: &'env Env,
        parent_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.resolve_parent_job(job_id(parent_id, "resolveParentJob")?)
        })
    }

    /// `resolveStrandedParents()`: how many parents were woken.
    #[napi]
    pub fn resolve_stranded_parents<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.resolve_stranded_parents())
    }

    /// `detachChildJob(childId)`: resolves null.
    #[napi]
    pub fn detach_child_job<'env>(
        &self,
        env: &'env Env,
        child_id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.detach_child_job(job_id(child_id, "detachChildJob")?)
        })
    }

    /// `updateJobProgress(id, lockToken, progress, fence?)`: whether the fenced update applied.
    #[napi]
    pub fn update_job_progress<'env>(
        &self,
        env: &'env Env,
        id: f64,
        lock_token: String,
        progress: Value,
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "updateJobProgress fence")?;
            s.update_job_progress_fenced(
                job_id(id, "updateJobProgress")?,
                &lock_token,
                &progress,
                fence.as_ref(),
            )
        })
    }

    /// `addJobTokens(id, lockToken, { input, output, cache_read }, fence?)`: whether it applied.
    #[napi]
    pub fn add_job_tokens<'env>(
        &self,
        env: &'env Env,
        id: f64,
        lock_token: String,
        tokens: Value,
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let tokens: TokenDelta = required(tokens, "addJobTokens tokens")?;
            let fence: Option<LeaseToken> = arg(fence, "addJobTokens fence")?;
            s.add_job_tokens_fenced(
                job_id(id, "addJobTokens")?,
                &lock_token,
                &tokens,
                fence.as_ref(),
            )
        })
    }

    /// `delayActiveJob(id, lockToken, { errorText, delayMs, appendStack, clearTimeout })`: the
    /// delayed row, or null.
    #[napi]
    pub fn delay_active_job<'env>(
        &self,
        env: &'env Env,
        id: f64,
        lock_token: String,
        opts: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: DelayOpts = required(opts, "delayActiveJob opts")?;
            s.delay_active_job(job_id(id, "delayActiveJob")?, &lock_token, &opts)
        })
    }

    /// `delayHeldClaim(id, lockToken, delayMs)`: whether a row held by this token went back to
    /// `delayed` (the worker's pause release and quiet-hours deferral).
    #[napi]
    pub fn delay_held_claim<'env>(
        &self,
        env: &'env Env,
        id: f64,
        lock_token: String,
        delay_ms: f64,
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "delayHeldClaim fence")?;
            s.delay_held_claim_fenced(
                job_id(id, "delayHeldClaim")?,
                &lock_token,
                delay_ms,
                fence.as_ref(),
            )
        })
    }

    /// `releaseWatchdogClaim(id, lockToken, errorText, mark)`: whether the claim was released.
    #[napi]
    pub fn release_watchdog_claim<'env>(
        &self,
        env: &'env Env,
        id: f64,
        lock_token: String,
        error_text: String,
        mark: String,
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "releaseWatchdogClaim fence")?;
            s.release_watchdog_claim_fenced(
                job_id(id, "releaseWatchdogClaim")?,
                &lock_token,
                &error_text,
                &mark,
                fence.as_ref(),
            )
        })
    }

    /// `markJobWatchdogSuspect(id, mark)`: resolves null.
    #[napi]
    pub fn mark_job_watchdog_suspect<'env>(
        &self,
        env: &'env Env,
        id: f64,
        mark: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.mark_job_watchdog_suspect(job_id(id, "markJobWatchdogSuspect")?, &mark)
        })
    }

    /// `retryJobUpdate(id)`: the requeued row, or null.
    #[napi]
    pub fn retry_job_update<'env>(&self, env: &'env Env, id: f64) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.retry_job_update(job_id(id, "retryJobUpdate")?)
        })
    }

    // ---------------------------------------------------------------- sweeps

    /// `promoteDelayedJobs()`: the promoted rows.
    #[napi]
    pub fn promote_delayed_jobs<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.promote_delayed_jobs())
    }

    /// `cancelJobs(ids, { reason, rootStatuses, ownerClientId, ownerActor })`: the cancelled rows,
    /// descendants included.
    #[napi]
    pub fn cancel_jobs<'env>(
        &self,
        env: &'env Env,
        ids: Vec<f64>,
        opts: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let opts: CancelOpts = arg(opts, "cancelJobs opts")?;
            s.cancel_jobs(&job_ids(ids, "cancelJobs")?, &opts)
        })
    }

    /// `killTimedOutJobs(fence?)`: the rows killed for `timeout_at`.
    #[napi]
    pub fn kill_timed_out_jobs<'env>(
        &self,
        env: &'env Env,
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "killTimedOutJobs fence")?;
            s.kill_timed_out_jobs_fenced(fence.as_ref())
        })
    }

    /// `killWallClockJobs(lockDurationMs, fence?)`: the rows killed for the wall-clock bound.
    #[napi]
    pub fn kill_wall_clock_jobs<'env>(
        &self,
        env: &'env Env,
        lock_duration_ms: f64,
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "killWallClockJobs fence")?;
            s.kill_wall_clock_jobs_fenced(lock_duration_ms, fence.as_ref())
        })
    }

    /// `pruneJobs({ statuses, olderThan, dryRun })`: `{ count }`. A pruned completed dream
    /// synthesis child's key goes into the `dream_synthesis_completions` archive first.
    #[napi]
    pub fn prune_jobs<'env>(&self, env: &'env Env, spec: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: PruneSpec = required(spec, "pruneJobs spec")?;
            s.prune_jobs(&spec)
        })
    }

    /// `listSynthesisCompletionKeys(sourceId, keyPrefix)`: the completed synthesis keys of the
    /// source, live jobs and archive together, each once, sorted.
    #[napi]
    pub fn list_synthesis_completion_keys<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        key_prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_synthesis_completion_keys(&source_id, &key_prefix)
        })
    }

    /// `listRecentSynthesisCompletions(sourceId, hours)`: `[{ idempotency_key, at }]` with `at`
    /// ISO, live jobs then archive rows.
    #[napi]
    pub fn list_recent_synthesis_completions<'env>(
        &self,
        env: &'env Env,
        source_id: String,
        hours: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_recent_synthesis_completions(&source_id, hours)
        })
    }

    // ---------------------------------------------------------------- inbox

    /// `postInboxMessage(jobId, sender, payload)`: the inbox row.
    #[napi]
    pub fn post_inbox_message<'env>(
        &self,
        env: &'env Env,
        job_id_arg: f64,
        sender: String,
        payload: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.post_inbox_message(job_id(job_id_arg, "postInboxMessage")?, &sender, &payload)
        })
    }

    /// `readJobInbox(jobId, lockToken, fence?)`: the rows marked read.
    #[napi]
    pub fn read_job_inbox<'env>(
        &self,
        env: &'env Env,
        job_id_arg: f64,
        lock_token: String,
        fence: Option<Value>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let fence: Option<LeaseToken> = arg(fence, "readJobInbox fence")?;
            s.read_job_inbox_fenced(
                job_id(job_id_arg, "readJobInbox")?,
                &lock_token,
                fence.as_ref(),
            )
        })
    }

    /// `readChildCompletions(parentId, lockToken, since)`: the `child_done` payloads.
    #[napi]
    pub fn read_child_completions<'env>(
        &self,
        env: &'env Env,
        parent_id: f64,
        lock_token: String,
        since: Option<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.read_child_completions(
                job_id(parent_id, "readChildCompletions")?,
                &lock_token,
                since.as_deref(),
            )
        })
    }

    // ---------------------------------------------------------------- private queues

    /// `listOpenJobIdsInQueue(queue)`: the live job ids.
    #[napi]
    pub fn list_open_job_ids_in_queue<'env>(
        &self,
        env: &'env Env,
        queue: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_open_job_ids_in_queue(&queue))
    }

    /// `renewPrivateQueueLease(queue, ownerToken, leaseMs)`: how many rows were renewed.
    #[napi]
    pub fn renew_private_queue_lease<'env>(
        &self,
        env: &'env Env,
        queue: String,
        owner_token: String,
        lease_ms: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.renew_private_queue_lease(&queue, &owner_token, lease_ms)
        })
    }

    /// `listOwnedPrivateQueues(prefix, maxQueues)`: queue names, oldest first.
    #[napi]
    pub fn list_owned_private_queues<'env>(
        &self,
        env: &'env Env,
        prefix: String,
        max_queues: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_owned_private_queues(&prefix, whole(max_queues, "listOwnedPrivateQueues")?)
        })
    }

    /// `readPrivateQueueState(queue)`: the recovery classifier's aggregate row.
    #[napi]
    pub fn read_private_queue_state<'env>(
        &self,
        env: &'env Env,
        queue: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_private_queue_state(&queue))
    }

    // ---------------------------------------------------------------- reads

    /// `listStaleWaitingJobIds(name, hours, limit)`: ids, oldest `updated_at` first.
    #[napi]
    pub fn list_stale_waiting_job_ids<'env>(
        &self,
        env: &'env Env,
        name: String,
        hours: f64,
        limit: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_stale_waiting_job_ids(&name, hours, whole(limit, "listStaleWaitingJobIds")?)
        })
    }

    /// `listUnfinishedJobsByName(names)`: `{ id, name, status }` of every unfinished job of those names, by id.
    #[napi]
    pub fn list_unfinished_jobs_by_name<'env>(
        &self,
        env: &'env Env,
        names: Vec<String>,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_unfinished_jobs_by_name(&names))
    }

    /// `countTtlExpiredWaiting(name, hours)`: a count.
    #[napi]
    pub fn count_ttl_expired_waiting<'env>(
        &self,
        env: &'env Env,
        name: String,
        hours: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_ttl_expired_waiting(&name, hours))
    }

    /// `readJobStats(since, queue)`: `{ by_status, types, drained, depth, stalled, wedge }`.
    #[napi]
    pub fn read_job_stats<'env>(
        &self,
        env: &'env Env,
        since: String,
        queue: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_job_stats(&since, &queue))
    }

    /// `readQueueFamilyStats(since, prefix)`: one row per queue family.
    #[napi]
    pub fn read_queue_family_stats<'env>(
        &self,
        env: &'env Env,
        since: String,
        prefix: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_queue_family_stats(&since, &prefix))
    }

    /// `hasOverdueWatchdogSuspect({ queue, names, mark, waitMs })`: a boolean.
    #[napi]
    pub fn has_overdue_watchdog_suspect<'env>(
        &self,
        env: &'env Env,
        spec: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: OverdueSpec = required(spec, "hasOverdueWatchdogSuspect spec")?;
            s.has_overdue_watchdog_suspect(&spec)
        })
    }

    /// `listUnreviewedJobs()`: `{ id, submission_authority }` of the live rows to review.
    #[napi]
    pub fn list_unreviewed_jobs<'env>(&self, env: &'env Env) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.list_unreviewed_jobs())
    }

    /// `getFailedJobForRetry(id)`: `{ name, data }` of a failed or dead row, or null.
    #[napi]
    pub fn get_failed_job_for_retry<'env>(
        &self,
        env: &'env Env,
        id: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_failed_job_for_retry(job_id(id, "getFailedJobForRetry")?)
        })
    }

    /// `countOpenJobsByOwner(clientId)`: a count.
    #[napi]
    pub fn count_open_jobs_by_owner<'env>(
        &self,
        env: &'env Env,
        client_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.count_open_jobs_by_owner(&client_id))
    }

    /// `readJobSourceState(sourceId)`: `{ archived, created_at, local_path, config }` or null.
    #[napi]
    pub fn read_job_source_state<'env>(
        &self,
        env: &'env Env,
        source_id: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| s.read_job_source_state(&source_id))
    }

    /// `listJobPage({ status, queue, name, ownerClientId, ownerActor, limit, cursor })`: rows with
    /// `created_us`.
    #[napi]
    pub fn list_job_page<'env>(&self, env: &'env Env, spec: Value) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let spec: JobPageSpec = required(spec, "listJobPage spec")?;
            s.list_job_page(&spec)
        })
    }

    // ---------------------------------------------------------------- attachments

    /// `listJobAttachmentNames(jobId)`: filenames, or null when the job does not exist.
    #[napi]
    pub fn list_job_attachment_names<'env>(
        &self,
        env: &'env Env,
        job_id_arg: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_job_attachment_names(job_id(job_id_arg, "listJobAttachmentNames")?)
        })
    }

    /// `insertJobAttachment(jobId, { filename, content_type, content_b64, size_bytes, sha256 })`:
    /// the attachment's metadata.
    #[napi]
    pub fn insert_job_attachment<'env>(
        &self,
        env: &'env Env,
        job_id_arg: f64,
        input: Value,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            let input: AttachmentInput = required(input, "insertJobAttachment input")?;
            s.insert_job_attachment(job_id(job_id_arg, "insertJobAttachment")?, &input)
        })
    }

    /// `listJobAttachments(jobId)`: metadata rows.
    #[napi]
    pub fn list_job_attachments<'env>(
        &self,
        env: &'env Env,
        job_id_arg: f64,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.list_job_attachments(job_id(job_id_arg, "listJobAttachments")?)
        })
    }

    /// `getJobAttachment(jobId, filename)`: metadata plus `content_b64`, or null.
    #[napi]
    pub fn get_job_attachment<'env>(
        &self,
        env: &'env Env,
        job_id_arg: f64,
        filename: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.get_job_attachment(job_id(job_id_arg, "getJobAttachment")?, &filename)
        })
    }

    /// `deleteJobAttachment(jobId, filename)`: whether a row was removed.
    #[napi]
    pub fn delete_job_attachment<'env>(
        &self,
        env: &'env Env,
        job_id_arg: f64,
        filename: String,
    ) -> napi::Result<Object<'env>> {
        self.run(env, move |s| {
            s.delete_job_attachment(job_id(job_id_arg, "deleteJobAttachment")?, &filename)
        })
    }
}
