//! Jobs: the Minion job queue, cycle locks, spend and rate leases, and wake subscriptions.
//!
//! Built so far (jobs slices 1 and 2): the `minion_jobs`, `minion_inbox`, `minion_attachments` and
//! `gbrain_cycle_locks` tables of the PGLite engine, as `src/core/engine-sql/jobs.ts`,
//! `cycle-locks.ts` and `src/core/minions/queue.ts` run them. The spend reservations and the
//! lease-pressure log are built (the `spend` submodule). The wake subscription tables (watches,
//! crons, cron runs, terms, forgets) are the `wake` submodule, as `src/core/engine-sql/jobs-wake.ts`
//! runs them. Rate leases are not built: TypeScript reaches that table through `executeRaw`, which
//! the Rust engine refuses.
//!
//! Members (slice 1, here): admitJob, getJob, listJobs, claimNextJob, renewJobLease, completeJob,
//! failJob, reclaimStalledJobs; acquireCycleLock, refreshCycleLock, releaseCycleLock,
//! readCycleLocks, deleteCycleLock, deleteCycleLockIfStale, assertCycleLease. Slice 2 lives in the
//! submodules: `mutations` (writes on one job), `sweeps` (cancel, kill, prune, promote), `inbox`,
//! `private_queues`, `reads` (stats and lists) and `attachments`. `synthesis_completions` keeps the
//! `dream_synthesis_completions` archive the prune writes, under its own tag `f`, with the two
//! dream-cycle reads of it (listSynthesisCompletionKeys, listRecentSynthesisCompletions). `insight`
//! is the one read behind `describeJobs` (readJobInsight). `spend` keeps the spend reservations and the
//! lease-pressure log (group C: the writes and reads of both, and the job spend tree).
//! is the one read behind `describeJobs` (readJobInsight). `subagent` holds the transcript and tool
//! ledger of a subagent job (17 members, rust/docs/store/jobs-subagent.md).
//!
//! See docs/designs/RUST_ENGINE_INTERFACES.md ("jobs (core)") and rust/docs/store/jobs.md.
//!
//! Keys: every record of this family starts with `keys::JOBS` (`m`). The bytes after the tag:
//! - `m 0x00 name -> i64`: the last id of each id sequence (`job`, `inbox`, ...) a kept write took.
//!   The ids come from the allocator `M next_jobs_seq_<name>`, which never rolls back (`next_seq`).
//! - `m 0x01 id -> JobRecord`: one job row.
//! - `m 0x02 queue \0 priority created id`: the claim index, `waiting` rows only, in claim order
//!   (priority ascending, then age, then id).
//! - `m 0x03 parent id`: the children of a parent.
//! - `m 0x04 idempotency_key -> id`: the partial unique index on `idempotency_key`.
//! - `m 0x05 job id`: the inbox rows of a job (`InboxRecord`).
//! - `m 0x06 status \0 id`: every row by status (the stall sweep, the quota and cap counts).
//! - `m 0x07 lock_id -> LockRecord`: one cycle lock lease.
//! - `m 0x08 job id -> AttachmentRecord`: the `minion_attachments` rows of a job (sequence `attachment`).
//! - `m 0x09 owner id`: the rows whose `private_queue_owner_job_id` is that owner (the `ON DELETE SET NULL`).
//! - `m 0x10`..`0x17`: the wake tables, laid out in `wake.rs` (0x12 is unused).
//! - `m 0x20 reservation_uuid -> record`: one spend reservation (`mcp_spend_reservations`); `0x21 job
//!   reservation_uuid` indexes it by job, `0x22 expires_at reservation_uuid` by expiry (pending only).
//!   `0x24 id -> record` is one lease-pressure row (sequence `lease_pressure`), `0x25 bounced_at id` its time
//!   order and `0x26 job id` its job. The layout is in `spend.rs`; `0x27` indexes the open holds by owner, and
//!   `0x28`/`0x29` (the spend ledger, `spend_log.rs`), `0x2A` (the whole client row, `oauth_clients.rs`), `0x2B` (the
//!   token row, `access_tokens.rs`) and `0x2C` (an OAuth token by hash, `oauth_tokens.rs`) and `0x2D` (an OAuth code by hash,
//!   `oauth_codes.rs`) follow. The credential binding reads and writes (`credential_binding.rs`) use the 0x2A and 0x2B
//!   records and keep none of their own.
//! - `m 0x18..=0x1C`: the subagent messages, tool rows and their three indexes (see `subagent.rs`).
//!
//! Integers are big-endian; a signed one has its sign bit flipped so byte order is numeric order.
//!
//! Time: every timestamp is UTC microseconds from the store's clock, read once per call, as one
//! Postgres transaction reads one `now()`. A millisecond duration becomes `round(ms * 1000)` µs.
//!
//! Two claims never take the same `waiting` row, which is what `FOR UPDATE SKIP LOCKED` gives the
//! SQL engines. With one writer, the write transaction is the lock. With concurrent writes on, a
//! claim reads the claim index up to the row it takes; when another claim, completion or
//! submission commits a change to that part of the index first, the claim conflicts and runs
//! again on the new state, so it takes the next job. `FOR KEY SHARE` on a lease (the fence) has
//! nothing to wait for here, so `assertCycleLease` is a read.
//!
//! Deleting a job does what the foreign keys do: its inbox rows go (`ON DELETE CASCADE`) and its
//! children's `parent_job_id` becomes NULL (`ON DELETE SET NULL`). The other two self-references
//! (`private_queue_owner_job_id`, `budget_owner_job_id`): a row that names the deleted job as its
//! private-queue owner has it set to NULL (`updated_at` untouched); nothing here writes a budget
//! owner. A job's attachments, subagent messages and subagent tool rows go with it
//! (`ON DELETE CASCADE`).

mod access_tokens;
mod attachments;
mod checks;
mod client_grants;
mod credential_binding;
mod drain_lease;
mod facts_extraction;
mod health;
mod inbox;
mod insight;
mod mutations;
mod oauth_clients;
mod oauth_codes;
mod oauth_revocation;
mod oauth_tokens;
mod private_queues;
mod reads;
mod spend;
mod spend_log;
mod status;
mod subagent;
mod sweeps;
pub(crate) mod synthesis_completions;
pub(crate) mod wake;

pub(crate) use access_tokens::bind_token_member;
pub use access_tokens::{TokenGrantColumns, TokenInsert};
pub use attachments::AttachmentInput;
pub(crate) use attachments::purge_probe_attachment_rows;
pub use checks::{
    BuildSkewSpec, DeadDreamSpec, DeathsSpec, KeyPrefixSpec, QueuedSpendSpec, StillDeadSpec,
};
pub use client_grants::{
    GrantAudit, GrantAuditInsert, GrantPersist, JobGrantSource, RegisterAudit,
};
pub use credential_binding::{CredentialBinding, CredentialKind, CredentialLookup};
pub use health::{DivergenceSpec, HealthSpec};
pub(crate) use inbox::purge_probe_inbox_rows;
pub use insight::InsightSpec;
use mutations::add_token;
pub use mutations::{DelayOpts, TokenDelta};
pub(crate) use oauth_clients::remove_source_rows as remove_oauth_source_rows;
pub use oauth_clients::{ClientInsert, ClientPatch, ClientPatchGuard};
pub(crate) use oauth_clients::{carry_over_format_5_clients, remove_client, seed_client};
pub use oauth_codes::OauthCodeInsert;
pub use oauth_tokens::OauthTokenInsert;
pub use private_queues::PrivateQueueState;
pub use reads::{JobPageCursor, JobPageSpec, OverdueSpec};
pub use spend::{ExpireScope, LeaseFilter, LeaseInsert, SpendInsert, SpendTreeSpec};
pub(crate) use spend::{SeedReservation, remove_reservation, seed_reservation};
pub use spend_log::{ClientReserve, GroupReserve, LogInsert};
pub(crate) use spend_log::{SeedLog, remove_log, seed_log};
pub use status::StatusFilter;
pub use subagent::{FailureFallback, MessageInsert, ToolInsert, ToolStart, ToolTarget};
pub(crate) use subagent::{purge_probe_message_rows, purge_probe_tool_rows};
pub use sweeps::{CancelOpts, PruneOutcome, PruneSpec};
pub use wake::{
    CronRunInput, EndSpec, ForgetClaimSpec, ForgetSettle, WatchFilter, WatchInsert, WatchSettle,
};

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, Result, StoreError};
use crate::jsonb::ordered;
use crate::keys;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::timeline_queries::jsonb_field_text;
use crate::{Store, get_json, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const SEQ: u8 = 0x00;
const JOB: u8 = 0x01;
const CLAIM: u8 = 0x02;
const CHILD: u8 = 0x03;
const KEY: u8 = 0x04;
const INBOX: u8 = 0x05;
const STATUS: u8 = 0x06;
const LOCK: u8 = 0x07;
const ATTACH: u8 = 0x08;
const OWNED: u8 = 0x09;

/// `LEASE_BEACON_QUEUE` (src/core/minions/protected-names.ts): the drain-lease holder records.
pub const LEASE_BEACON_QUEUE: &str = "gbrain-drain-lease";
/// The error-text prefix of a co-runner requeue (engine-sql/jobs.ts `CO_RUNNER_STALL`).
pub const CO_RUNNER_STALL: &str = "worker_stalled_with_co_runners: ";
/// The `error_text` of a job the stall sweep kills.
pub const MAX_STALLED_TEXT: &str = "max stalled count exceeded";

const TERMINAL: [&str; 4] = ["completed", "failed", "dead", "cancelled"];
const NON_TERMINAL: [&str; 5] = ["waiting", "active", "delayed", "waiting-children", "paused"];
const STATUSES: [&str; 9] = [
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed",
    "dead",
    "cancelled",
    "waiting-children",
    "paused",
];

fn is_terminal(status: &str) -> bool {
    TERMINAL.contains(&status)
}

fn ms_to_us(ms: f64) -> i64 {
    (ms * 1000.0).round() as i64
}

fn signed_key(v: i64) -> [u8; 8] {
    ((v as u64) ^ (1 << 63)).to_be_bytes()
}

fn prefix(sub: u8) -> Vec<u8> {
    vec![keys::JOBS, sub]
}

fn job_key(id: i64) -> Vec<u8> {
    let mut k = prefix(JOB);
    k.extend_from_slice(&signed_key(id));
    k
}

fn claim_prefix(queue: &str) -> Vec<u8> {
    let mut k = prefix(CLAIM);
    k.extend_from_slice(queue.as_bytes());
    k.push(0);
    k
}

fn claim_key(job: &JobRecord) -> Vec<u8> {
    let mut k = claim_prefix(&job.queue);
    k.extend_from_slice(&((job.priority as u32) ^ (1 << 31)).to_be_bytes());
    k.extend_from_slice(&signed_key(job.created_at));
    k.extend_from_slice(&signed_key(job.id));
    k
}

fn child_prefix(parent: i64) -> Vec<u8> {
    let mut k = prefix(CHILD);
    k.extend_from_slice(&signed_key(parent));
    k
}

fn child_key(parent: i64, id: i64) -> Vec<u8> {
    let mut k = child_prefix(parent);
    k.extend_from_slice(&signed_key(id));
    k
}

fn idem_key(key: &str) -> Vec<u8> {
    let mut k = prefix(KEY);
    k.extend_from_slice(key.as_bytes());
    k
}

fn inbox_prefix(job_id: i64) -> Vec<u8> {
    let mut k = prefix(INBOX);
    k.extend_from_slice(&signed_key(job_id));
    k
}

fn status_prefix(status: &str) -> Vec<u8> {
    let mut k = prefix(STATUS);
    k.extend_from_slice(status.as_bytes());
    k.push(0);
    k
}

fn status_key(status: &str, id: i64) -> Vec<u8> {
    let mut k = status_prefix(status);
    k.extend_from_slice(&signed_key(id));
    k
}

fn attach_prefix(job: i64) -> Vec<u8> {
    let mut k = prefix(ATTACH);
    k.extend_from_slice(&signed_key(job));
    k
}

fn attach_key(job: i64, id: i64) -> Vec<u8> {
    let mut k = attach_prefix(job);
    k.extend_from_slice(&signed_key(id));
    k
}

fn owned_prefix(owner: i64) -> Vec<u8> {
    let mut k = prefix(OWNED);
    k.extend_from_slice(&signed_key(owner));
    k
}

fn owned_key(owner: i64, id: i64) -> Vec<u8> {
    let mut k = owned_prefix(owner);
    k.extend_from_slice(&signed_key(id));
    k
}

/// The id prefix of every page embedding lease (page-embedding-lease.ts `PAGE_EMBEDDING_LEASE_PREFIX`).
const PAGE_EMBEDDING_LEASE_PREFIX: &str = "embed-page:";

fn lock_key(id: &str) -> Vec<u8> {
    let mut k = prefix(LOCK);
    k.extend_from_slice(id.as_bytes());
    k
}

/// The acquisition token of cycle lock `id` while its lease is live (`ttl_expires_at > now`), as
/// `gbrain_cycle_locks.acquisition_token::text`: what `sync status`'s pinned-pass probe joins
/// (persistence/sync-admission-sql.ts `effectProbes`).
pub(crate) fn live_lock_token(read: &dyn KvRead, id: &str, now: i64) -> Result<Option<String>> {
    Ok(get_json::<LockRecord>(read, &lock_key(id))?
        .filter(|l| l.ttl_expires_at > now)
        .map(|l| l.acquisition_token))
}

fn last_id(key: &[u8]) -> Option<i64> {
    let tail: [u8; 8] = key.get(key.len().checked_sub(8)?..)?.try_into().ok()?;
    Some((u64::from_be_bytes(tail) ^ (1 << 63)) as i64)
}

/// The next id of sequence `name`. The id comes from the store's allocator (`M next_jobs_seq_<name>`,
/// `KvWrite::allocate`), which never rolls back: an id handed out inside a transaction or savepoint
/// that rolls back is not handed out again, as with Postgres `nextval`. The allocator starts at the
/// last id the JSON record (`m 0x00 name`) holds, so a brain written before it continues from there;
/// the JSON record keeps the last id handed out in a kept write.
fn next_seq(tx: &mut dyn KvWrite, name: &str) -> Result<i64> {
    let mut k = prefix(SEQ);
    k.extend_from_slice(name.as_bytes());
    let floor = u64::try_from(get_json::<i64>(tx, &k)?.unwrap_or(0) + 1)
        .map_err(|_| StoreError::new(crate::error::STORE_CORRUPT, "bad job id sequence"))?;
    let counter = keys::meta(&format!("next_jobs_seq_{name}"));
    let first = tx.allocate(&counter, 0)?;
    if first < floor {
        tx.allocate(&counter, floor - first)?;
    }
    let next = i64::try_from(tx.allocate(&counter, 1)?)
        .map_err(|_| StoreError::new(crate::error::STORE_CORRUPT, "bad job id sequence"))?;
    put_json(tx, &k, &next)?;
    Ok(next)
}

/// Raises the sequence `name` so the next [`next_seq`] returns a value above `id` (the shadow
/// seed, which copies rows with their ids).
pub(crate) fn raise_seq(tx: &mut dyn KvWrite, name: &str, id: i64) -> Result<()> {
    let mut k = prefix(SEQ);
    k.extend_from_slice(name.as_bytes());
    if get_json::<i64>(tx, &k)?.unwrap_or(0) < id {
        put_json(tx, &k, &id)?;
    }
    Ok(())
}

/// The last value of the sequence `name` (0 when it has not been used), read only.
pub(crate) fn read_seq(read: &dyn KvRead, name: &str) -> Result<i64> {
    let mut k = prefix(SEQ);
    k.extend_from_slice(name.as_bytes());
    Ok(get_json::<i64>(read, &k)?.unwrap_or(0))
}

/// One `minion_jobs` row. Timestamps are µs; JSON columns are kept as given.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobRecord {
    pub id: i64,
    pub name: String,
    pub queue: String,
    pub status: String,
    pub priority: i32,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub submission_authority: Option<Value>,
    pub claim_generation: i64,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    pub data: Value,
    pub max_attempts: i32,
    pub attempts_made: i32,
    pub attempts_started: i32,
    pub backoff_type: String,
    pub backoff_delay: i32,
    pub backoff_jitter: f32,
    pub stalled_counter: i32,
    pub max_stalled: i32,
    pub lock_token: Option<String>,
    pub lock_until: Option<i64>,
    pub delay_until: Option<i64>,
    pub parent_job_id: Option<i64>,
    pub on_child_fail: String,
    pub tokens_input: i32,
    pub tokens_output: i32,
    pub tokens_cache_read: i32,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub result: Option<Value>,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub progress: Option<Value>,
    pub error_text: Option<String>,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub stacktrace: Option<Value>,
    pub depth: i32,
    pub max_children: Option<i32>,
    pub timeout_ms: Option<i32>,
    pub lock_duration_ms: Option<i32>,
    pub timeout_at: Option<i64>,
    pub remove_on_complete: bool,
    pub remove_on_fail: bool,
    pub idempotency_key: Option<String>,
    pub private_queue_owner_job_id: Option<i64>,
    pub private_queue_owner_token: Option<String>,
    pub private_queue_lease_until: Option<i64>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub updated_at: i64,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub quiet_hours: Option<Value>,
    pub stagger_key: Option<String>,
    pub budget_remaining_cents: Option<i32>,
    pub budget_owner_job_id: Option<i64>,
    pub budget_root_owner_id: Option<i64>,
    #[serde(default, deserialize_with = "crate::jsonb::de_opt_value")]
    pub spend_authorization: Option<Value>,
    pub spend_claim_token: Option<i64>,
}

impl JobRecord {
    /// The row as `SELECT *` returns it, in column order: timestamps as µs ISO text (the
    /// TypeScript member turns them into `Date`s, as PGLite's row parser does), JSON columns in
    /// `jsonb` key order.
    pub fn to_json(&self) -> Value {
        let t = |v: Option<i64>| v.map(iso);
        let j = |v: &Option<Value>| v.as_ref().map(ordered);
        // `real` prints its shortest float4 form; read back as a double that is the same text.
        let jitter: f64 = format!("{}", self.backoff_jitter).parse().unwrap_or(0.0);
        let mut m = Map::new();
        let mut put = |k: &str, v: Value| {
            m.insert(k.to_string(), v);
        };
        put("id", json!(self.id));
        put("name", json!(self.name));
        put("queue", json!(self.queue));
        put("status", json!(self.status));
        put("priority", json!(self.priority));
        put("submission_authority", json!(j(&self.submission_authority)));
        put("claim_generation", json!(self.claim_generation));
        put("data", ordered(&self.data));
        put("max_attempts", json!(self.max_attempts));
        put("attempts_made", json!(self.attempts_made));
        put("attempts_started", json!(self.attempts_started));
        put("backoff_type", json!(self.backoff_type));
        put("backoff_delay", json!(self.backoff_delay));
        put("backoff_jitter", json!(jitter));
        put("stalled_counter", json!(self.stalled_counter));
        put("max_stalled", json!(self.max_stalled));
        put("lock_token", json!(self.lock_token));
        put("lock_until", json!(t(self.lock_until)));
        put("delay_until", json!(t(self.delay_until)));
        put("parent_job_id", json!(self.parent_job_id));
        put("on_child_fail", json!(self.on_child_fail));
        put("tokens_input", json!(self.tokens_input));
        put("tokens_output", json!(self.tokens_output));
        put("tokens_cache_read", json!(self.tokens_cache_read));
        put("result", json!(j(&self.result)));
        put("progress", json!(j(&self.progress)));
        put("error_text", json!(self.error_text));
        put("stacktrace", json!(j(&self.stacktrace)));
        put("depth", json!(self.depth));
        put("max_children", json!(self.max_children));
        put("timeout_ms", json!(self.timeout_ms));
        put("lock_duration_ms", json!(self.lock_duration_ms));
        put("timeout_at", json!(t(self.timeout_at)));
        put("remove_on_complete", json!(self.remove_on_complete));
        put("remove_on_fail", json!(self.remove_on_fail));
        put("idempotency_key", json!(self.idempotency_key));
        put(
            "private_queue_owner_job_id",
            json!(self.private_queue_owner_job_id),
        );
        put(
            "private_queue_owner_token",
            json!(self.private_queue_owner_token),
        );
        put(
            "private_queue_lease_until",
            json!(t(self.private_queue_lease_until)),
        );
        put("created_at", json!(iso(self.created_at)));
        put("started_at", json!(t(self.started_at)));
        put("finished_at", json!(t(self.finished_at)));
        put("updated_at", json!(iso(self.updated_at)));
        put("quiet_hours", json!(j(&self.quiet_hours)));
        put("stagger_key", json!(self.stagger_key));
        put("budget_remaining_cents", json!(self.budget_remaining_cents));
        put("budget_owner_job_id", json!(self.budget_owner_job_id));
        put("budget_root_owner_id", json!(self.budget_root_owner_id));
        put("spend_authorization", json!(j(&self.spend_authorization)));
        put("spend_claim_token", json!(self.spend_claim_token));
        Value::Object(m)
    }

    /// `COALESCE(stacktrace, '[]'::jsonb) @> jsonb_build_array(mark)`.
    fn marked(&self, mark: &str) -> bool {
        match &self.stacktrace {
            Some(Value::Array(items)) => items.iter().any(|v| v.as_str() == Some(mark)),
            Some(Value::String(s)) => s == mark,
            _ => false,
        }
    }

    /// `COALESCE(data->>'sourceId', data->>'source_id')`.
    fn scope_source(&self) -> Option<String> {
        let field = |k: &str| self.data.get(k).and_then(jsonb_field_text);
        field("sourceId").or_else(|| field("source_id"))
    }

    /// `status = 'waiting' OR (status = 'active' AND lock_until > now())`.
    fn pending(&self, now: i64) -> bool {
        self.status == "waiting"
            || (self.status == "active" && self.lock_until.is_some_and(|l| l > now))
    }

    fn append_stack(&mut self, entry: Value) {
        let mut items = match self.stacktrace.take() {
            Some(Value::Array(items)) => items,
            Some(other) => vec![other],
            None => Vec::new(),
        };
        items.push(entry);
        self.stacktrace = Some(Value::Array(items));
    }
}

/// One `minion_inbox` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct InboxRecord {
    id: i64,
    job_id: i64,
    sender: String,
    #[serde(deserialize_with = "crate::jsonb::de_value")]
    payload: Value,
    sent_at: i64,
    read_at: Option<i64>,
}

/// One `gbrain_cycle_locks` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LockRecord {
    holder_pid: i64,
    holder_host: Option<String>,
    acquired_at: i64,
    ttl_expires_at: i64,
    last_refreshed_at: Option<i64>,
    acquisition_token: String,
}

// ---------------------------------------------------------------- inputs

/// `JobInsertValues` (engine-sql/jobs.ts): the defaults are already applied by the queue.
#[derive(Debug, Clone, Deserialize)]
pub struct JobInsert {
    pub name: String,
    pub queue: String,
    pub status: String,
    pub priority: i32,
    #[serde(default)]
    pub data: Value,
    pub max_attempts: i32,
    pub backoff_type: String,
    pub backoff_delay: i32,
    pub backoff_jitter: f32,
    #[serde(default)]
    pub delay_until: Option<String>,
    #[serde(default)]
    pub parent_job_id: Option<i64>,
    pub on_child_fail: String,
    #[serde(default)]
    pub max_children: Option<i32>,
    #[serde(default)]
    pub timeout_ms: Option<i32>,
    #[serde(default)]
    pub lock_duration_ms: Option<i32>,
    pub remove_on_complete: bool,
    pub remove_on_fail: bool,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub quiet_hours: Option<Value>,
    #[serde(default)]
    pub stagger_key: Option<String>,
    #[serde(default)]
    pub submission_authority: Option<Value>,
    /// The spend record as JSON text, or null.
    #[serde(default)]
    pub spend_authorization: Option<String>,
    #[serde(default)]
    pub max_stalled: Option<i32>,
    /// The private-queue owner columns, stored as given (an owner job must exist).
    #[serde(default)]
    pub private_queue_owner_job_id: Option<i64>,
    #[serde(default)]
    pub private_queue_owner_token: Option<String>,
    #[serde(default)]
    pub private_queue_lease_until: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamCoalesce {
    pub param_hash: String,
    #[serde(default)]
    pub max_age_hours: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backpressure {
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub max_pending: Option<f64>,
    #[serde(default)]
    pub max_waiting: Option<f64>,
}

/// `AdmitJobSpec` minus the caller policy (the TypeScript member refuses the delegated hooks).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmitSpec {
    pub insert: JobInsert,
    #[serde(default)]
    pub param_coalesce: Option<ParamCoalesce>,
    #[serde(default)]
    pub quota_max_waiting: Option<f64>,
    #[serde(default)]
    pub backpressure: Option<Backpressure>,
    pub max_spawn_depth: i64,
    /// Stop after the idempotency and parameter coalesce and answer `capacity` with nothing written,
    /// so a caller can run a delegated client's capacity check at the place the SQL engines run it
    /// (after the coalesce, before the quota), then admit again in the same transaction.
    #[serde(default)]
    pub capacity_check: bool,
}

/// What `admit_job` did. `conflict` means an existing row is held under another submission
/// authority: nothing was written, and the caller's coalesce rule decides the refusal.
#[derive(Debug, Clone, Serialize)]
pub struct AdmitOutcome {
    pub outcome: &'static str,
    pub row: Value,
    pub audit: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilter {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub queue: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub owner_client_id: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySpend {
    pub group_id: String,
    pub cap_usd: f64,
}

/// `ClaimJobSpec`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimSpec {
    pub lock_token: String,
    pub lock_duration_ms: f64,
    pub queue: String,
    pub names: Vec<String>,
    #[serde(default)]
    pub exclude_names: Option<Vec<String>>,
    #[serde(default)]
    pub exclude_watchdog_suspects: bool,
    /// `WATCHDOG_SUSPECT_MARK`, sent by the TypeScript member.
    #[serde(default)]
    pub suspect_mark: Option<String>,
    /// A marked job requeued at least this long ago leads the order, or blocks a busy worker.
    #[serde(default)]
    pub suspect_wait_ms: Option<f64>,
    #[serde(default)]
    pub handler_timeouts: HashMap<String, Value>,
    #[serde(default)]
    pub handler_lock_durations: HashMap<String, Value>,
    pub legacy_spend: LegacySpend,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockAcquire {
    pub holder_pid: i64,
    #[serde(default)]
    pub holder_host: Option<String>,
    pub acquisition_token: String,
    pub ttl_minutes: f64,
    pub steal_grace_seconds: f64,
}

/// `takePageEmbeddingLease` opts (page-embedding-lease.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageLeaseTake {
    pub holder_pid: i64,
    pub holder_host: String,
    pub acquisition_token: String,
    pub ttl_minutes: f64,
}

/// `renewPageEmbeddingLease` and `releasePageEmbeddingLease` opts: the lease fences on its token alone.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageLeaseHolder {
    pub acquisition_token: String,
    #[serde(default)]
    pub ttl_minutes: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockHolder {
    pub holder_pid: i64,
    pub acquisition_token: String,
    #[serde(default)]
    pub ttl_minutes: Option<f64>,
    #[serde(default)]
    pub max_age_seconds: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "by", rename_all = "camelCase")]
pub enum LockFilter {
    #[serde(rename = "id", rename_all = "camelCase")]
    Id { lock_id: String },
    #[serde(rename = "ids", rename_all = "camelCase")]
    Ids { lock_ids: Vec<String> },
    #[serde(rename = "stale")]
    Stale,
    #[serde(rename = "all")]
    All,
}

// ---------------------------------------------------------------- row access

fn load(read: &dyn KvRead, id: i64) -> Result<Option<JobRecord>> {
    get_json(read, &job_key(id))
}

fn ids_under(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<i64>> {
    let mut ids = Vec::new();
    scan_prefix(read, prefix, false, &mut |k, _| {
        if let Some(id) = last_id(k) {
            ids.push(id);
        }
        true
    })?;
    Ok(ids)
}

fn rows_with_status(read: &dyn KvRead, status: &str) -> Result<Vec<JobRecord>> {
    let mut rows = Vec::new();
    for id in ids_under(read, &status_prefix(status))? {
        if let Some(row) = load(read, id)? {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// The `minion_jobs` rows a fact purge's inventory probe searches (crate::facts::purge_probe).
pub(crate) fn purge_probe_job_rows(
    read: &dyn KvRead,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow};
    Ok(all_rows(read)?
        .into_iter()
        .map(|r| ProbeRow {
            source_id: None,
            cells: vec![
                ("data", ProbeCell::jsonb(&r.data)),
                ("result", ProbeCell::opt_jsonb(r.result.as_ref())),
                ("error_text", ProbeCell::opt_text(r.error_text.as_deref())),
            ],
        })
        .collect())
}

fn all_rows(read: &dyn KvRead) -> Result<Vec<JobRecord>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        &prefix(JOB),
        false,
        &mut |_, v| match serde_json::from_slice(v) {
            Ok(row) => {
                rows.push(row);
                true
            }
            Err(e) => {
                bad = Some(e);
                false
            }
        },
    )?;
    if let Some(e) = bad {
        return Err(e.into());
    }
    Ok(rows)
}

/// Writes `new`, keeping every index in step with the row it replaces (`old`).
fn save(tx: &mut dyn KvWrite, old: Option<&JobRecord>, new: &JobRecord) -> Result<()> {
    if let Some(old) = old {
        unindex(tx, old)?;
    }
    tx.put(&status_key(&new.status, new.id), b"")?;
    if new.status == "waiting" {
        tx.put(&claim_key(new), b"")?;
    }
    if let Some(parent) = new.parent_job_id {
        tx.put(&child_key(parent, new.id), b"")?;
    }
    if let Some(owner) = new.private_queue_owner_job_id {
        tx.put(&owned_key(owner, new.id), b"")?;
    }
    if let Some(key) = &new.idempotency_key {
        put_json(tx, &idem_key(key), &new.id)?;
    }
    put_json(tx, &job_key(new.id), new)
}

fn unindex(tx: &mut dyn KvWrite, old: &JobRecord) -> Result<()> {
    tx.delete(&status_key(&old.status, old.id))?;
    if old.status == "waiting" {
        tx.delete(&claim_key(old))?;
    }
    if let Some(parent) = old.parent_job_id {
        tx.delete(&child_key(parent, old.id))?;
    }
    if let Some(owner) = old.private_queue_owner_job_id {
        tx.delete(&owned_key(owner, old.id))?;
    }
    if let Some(key) = &old.idempotency_key {
        tx.delete(&idem_key(key))?;
    }
    Ok(())
}

/// `DELETE FROM minion_jobs WHERE id = $1`, with the foreign keys' cascade and SET NULL (which leaves
/// the children's `updated_at` alone).
fn delete_row(tx: &mut dyn KvWrite, row: &JobRecord) -> Result<()> {
    unindex(tx, row)?;
    tx.delete(&job_key(row.id))?;
    let inbox = inbox_prefix(row.id);
    let mut keys = Vec::new();
    scan_prefix(tx, &inbox, false, &mut |k, _| {
        keys.push(k.to_vec());
        true
    })?;
    for k in keys {
        tx.delete(&k)?;
    }
    let mut attachments = Vec::new();
    scan_prefix(tx, &attach_prefix(row.id), false, &mut |k, _| {
        attachments.push(k.to_vec());
        true
    })?;
    for k in attachments {
        tx.delete(&k)?;
    }
    subagent::delete_job_rows(tx, row.id)?;
    for child in ids_under(tx, &child_prefix(row.id))? {
        if let Some(old) = load(tx, child)? {
            let mut new = old.clone();
            new.parent_job_id = None;
            save(tx, Some(&old), &new)?;
        }
    }
    for owned in ids_under(tx, &owned_prefix(row.id))? {
        if let Some(old) = load(tx, owned)? {
            let mut new = old.clone();
            new.private_queue_owner_job_id = None;
            save(tx, Some(&old), &new)?;
        }
    }
    spend::detach_job(tx, row.id)
}

fn live_children(read: &dyn KvRead, parent: i64) -> Result<usize> {
    let mut live = 0;
    for id in ids_under(read, &child_prefix(parent))? {
        if load(read, id)?.is_some_and(|c| !is_terminal(&c.status)) {
            live += 1;
        }
    }
    Ok(live)
}

/// `CHILD_DONE_SQL`: posts to the parent's inbox while the parent is not finished.
fn post_child_done(tx: &mut dyn KvWrite, parent: i64, payload: Value, now: i64) -> Result<()> {
    let Some(p) = load(tx, parent)? else {
        return Ok(());
    };
    if is_terminal(&p.status) {
        return Ok(());
    }
    let id = next_seq(tx, "inbox")?;
    let mut k = inbox_prefix(parent);
    k.extend_from_slice(&signed_key(id));
    let record = InboxRecord {
        id,
        job_id: parent,
        sender: "minions".into(),
        payload,
        sent_at: now,
        read_at: None,
    };
    put_json(tx, &k, &record)
}

/// `RESOLVE_PARENT_SQL`: a `waiting-children` parent with no open child goes back to `waiting`.
fn resolve_parent(tx: &mut dyn KvWrite, parent: i64, now: i64) -> Result<()> {
    let Some(old) = load(tx, parent)? else {
        return Ok(());
    };
    if old.status != "waiting-children" || live_children(tx, parent)? > 0 {
        return Ok(());
    }
    let mut new = old.clone();
    new.status = "waiting".into();
    new.started_at = None;
    new.updated_at = now;
    save(tx, Some(&old), &new)
}

fn child_done(
    row: &JobRecord,
    result: Option<&Value>,
    outcome: &str,
    error: Option<&str>,
) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), json!("child_done"));
    m.insert("child_id".into(), json!(row.id));
    m.insert("job_name".into(), json!(row.name));
    m.insert("result".into(), result.cloned().unwrap_or(Value::Null));
    m.insert("outcome".into(), json!(outcome));
    if let Some(error) = error {
        m.insert("error".into(), json!(error));
    }
    Value::Object(m)
}

fn worker_of(token: Option<&str>) -> Option<&str> {
    let token = token?;
    token.find(':').map(|i| &token[..i])
}

fn check_insert(v: &JobInsert) -> Result<()> {
    let bad = |what: &str| {
        Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            format!("minion_jobs check: {what}"),
        ))
    };
    // A NUL byte is not valid text in Postgres, and the claim index uses it as the queue separator.
    if v.queue.contains('\0') {
        return bad("queue");
    }
    if !["fixed", "exponential"].contains(&v.backoff_type.as_str()) {
        return bad("backoff_type");
    }
    if !["fail_parent", "remove_dep", "ignore", "continue"].contains(&v.on_child_fail.as_str()) {
        return bad("on_child_fail");
    }
    if !STATUSES.contains(&v.status.as_str()) {
        return bad("status");
    }
    if !(0.0..=1.0).contains(&v.backoff_jitter) {
        return bad("backoff_jitter");
    }
    if v.lock_duration_ms
        .is_some_and(|l| !(5000..=3_600_000).contains(&l))
    {
        return bad("lock_duration_ms");
    }
    if v.max_children.is_some_and(|m| m <= 0) {
        return bad("max_children");
    }
    if v.timeout_ms.is_some_and(|t| t <= 0) {
        return bad("timeout_ms");
    }
    if v.max_attempts < 1 || v.max_stalled.is_some_and(|m| m < 0) {
        return bad("max_attempts/max_stalled");
    }
    Ok(())
}

fn parse_time(what: &str, text: &Option<String>) -> Result<Option<i64>> {
    match text {
        None => Ok(None),
        Some(t) => crate::env::parse_iso(t).map(Some).ok_or_else(|| {
            StoreError::new(
                INVALID_ARGUMENT,
                format!("{what}: not an ISO timestamp: {t}"),
            )
        }),
    }
}

/// `data || '{"__released_idempotency_key": key}'::jsonb` (engine-sql/jobs.ts `releaseIdempotencyKey`): an
/// object gains the key; an array gains the object as its last element; any other value becomes a
/// two-element array of the value and the object, as jsonb concatenation does.
fn with_released_key(data: Value, key: &str) -> Value {
    let marker = json!({ "__released_idempotency_key": key });
    match data {
        Value::Object(mut map) => {
            map.insert("__released_idempotency_key".into(), json!(key));
            Value::Object(map)
        }
        Value::Array(mut items) => {
            items.push(marker);
            Value::Array(items)
        }
        other => Value::Array(vec![other, marker]),
    }
}

/// The coalesce rule (`coalesceDecision`) for a row stored here: a row under another submission
/// authority is a conflict the caller refuses; a dead or cancelled row's key is released; any
/// other row is returned. A row with a NULL authority (written before the authority cutover) is
/// released when dead or cancelled, returned when completed or failed and the caller is an
/// `application`, and otherwise a conflict (the caller raises `legacyJobAuthorityError`).
enum Decision {
    Coalesce,
    Release,
    Conflict,
}

fn decide(row: &JobRecord, caller: Option<&Value>) -> Decision {
    let releasable = row.status == "dead" || row.status == "cancelled";
    if row.submission_authority.is_none() {
        let application = caller
            .and_then(|a| a.get("kind"))
            .and_then(Value::as_str)
            .is_some_and(|k| k == "application");
        return if releasable {
            Decision::Release
        } else if (row.status == "completed" || row.status == "failed") && application {
            Decision::Coalesce
        } else {
            Decision::Conflict
        };
    }
    if row.submission_authority.as_ref() != caller {
        Decision::Conflict
    } else if releasable {
        Decision::Release
    } else {
        Decision::Coalesce
    }
}

enum Step {
    Done(AdmitOutcome),
    Conflict(Value),
    /// `capacity_check`: no coalesce answered, and the caller's capacity check runs next.
    Capacity,
}

impl Store {
    // ------------------------------------------------------------ admission

    /// `admitJob`: the idempotency fast path, the parameter coalesce, the name quota, the
    /// backpressure caps, the parent checks, the insert and the parent flip, in one write.
    ///
    /// A NULL submission authority is stored as NULL; the private-queue owner columns are stored as
    /// given. Errors: `constraint_violation` for a row a `minion_jobs` CHECK refuses or an owner
    /// job that does not exist (the foreign key),
    /// `admission_refused` (message `queue_quota_exceeded:<name>:<waiting>:<max>`) at the quota,
    /// and `invalid_state` for the parent refusals the SQL engines raise as plain errors.
    pub fn admit_job(&self, spec: &AdmitSpec) -> Result<AdmitOutcome> {
        let v = &spec.insert;
        let authority = v.submission_authority.clone().filter(|a| !a.is_null());
        check_insert(v)?;
        let spend =
            match &v.spend_authorization {
                None => None,
                Some(text) => Some(serde_json::from_str::<Value>(text).map_err(|e| {
                    StoreError::invalid(format!("admitJob spend_authorization: {e}"))
                })?),
            };
        let delay_until = parse_time("admitJob delay_until", &v.delay_until)?;
        let lease_until = parse_time(
            "admitJob private_queue_lease_until",
            &v.private_queue_lease_until,
        )?;
        // A conflict or a capacity stop keeps nothing: the statement is dropped (rolled back on its
        // own, or a statement of the open transaction on a bound store), and the outcome is answered.
        let mut undone: Option<AdmitOutcome> = None;
        let result = self.write(|tx| {
            let now = self.env.now_micros();
            let stop = match admit_in(
                tx,
                spec,
                authority.as_ref(),
                spend.clone(),
                (delay_until, lease_until),
                now,
            )? {
                Step::Done(outcome) => return Ok(outcome),
                // A key released before the conflict stays held.
                Step::Conflict(row) => AdmitOutcome {
                    outcome: "conflict",
                    row,
                    audit: None,
                },
                // The caller admits again after its check.
                Step::Capacity => AdmitOutcome {
                    outcome: "capacity",
                    row: Value::Null,
                    audit: None,
                },
            };
            undone = Some(stop);
            Err(StoreError::invalid(
                "admitJob: the admission stopped and keeps nothing",
            ))
        });
        match (result, undone) {
            (Ok(outcome), _) | (Err(_), Some(outcome)) => Ok(outcome),
            (Err(error), None) => Err(error),
        }
    }

    pub fn get_job(&self, id: i64) -> Result<Option<Value>> {
        Ok(load(&*self.read()?, id)?.map(|r| r.to_json()))
    }

    /// `readJobDataByIdempotencyKey(key)`: `{ data }` of the row holding `key` (any status), or None. Mirrors
    /// `SELECT data FROM minion_jobs WHERE idempotency_key = $1`; the key index names at most one row.
    pub fn job_data_by_idempotency_key(&self, key: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        let Some(id) = get_json::<i64>(&*read, &idem_key(key))? else {
            return Ok(None);
        };
        Ok(load(&*read, id)?
            .filter(|r| r.idempotency_key.as_deref() == Some(key))
            .map(|r| json!({ "data": r.data })))
    }

    /// `coalesceOnIdempotencyKey(key, authority)`: the idempotency fast path of `admitJob` on its own, in one
    /// write. `{ outcome: 'none' }` when no row holds `key`; `{ outcome: 'coalesced', row }` when the row is
    /// returned; `{ outcome: 'released' }` after a dead or cancelled row's key was freed (kept in its data as
    /// `__released_idempotency_key`); `{ outcome: 'conflict', row }` for a row the caller must refuse, with
    /// nothing written. Mirrors engine-sql/jobs.ts `coalesceOnIdempotencyKey` under the rule of `decide`.
    pub fn coalesce_on_idempotency_key(
        &self,
        key: &str,
        authority: Option<&Value>,
    ) -> Result<Value> {
        let authority = authority.filter(|a| !a.is_null());
        // `self.write`, not a write of its own: inside an engine transaction (POST /ingest runs this in one) the step
        // is a statement of that transaction.
        self.write(|tx| {
            let existing = match get_json::<i64>(&*tx, &idem_key(key))? {
                Some(id) => load(&*tx, id)?.filter(|r| r.idempotency_key.as_deref() == Some(key)),
                None => None,
            };
            let Some(existing) = existing else {
                return Ok(json!({ "outcome": "none" }));
            };
            match decide(&existing, authority) {
                Decision::Coalesce => {
                    Ok(json!({ "outcome": "coalesced", "row": existing.to_json() }))
                }
                Decision::Conflict => {
                    Ok(json!({ "outcome": "conflict", "row": existing.to_json() }))
                }
                Decision::Release => {
                    let mut new = existing.clone();
                    new.idempotency_key = None;
                    new.data = with_released_key(std::mem::take(&mut new.data), key);
                    save(tx, Some(&existing), &new)?;
                    Ok(json!({ "outcome": "released" }))
                }
            }
        })
    }

    /// `listJobs`: every given (non-empty) filter, newest first (ties by id, newest first), 50 from 0
    /// by default.
    pub fn list_jobs(&self, filter: &ListFilter) -> Result<Vec<Value>> {
        let read = self.read()?;
        let given = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
        let (status, queue, name, owner) = (
            given(&filter.status),
            given(&filter.queue),
            given(&filter.name),
            given(&filter.owner_client_id),
        );
        let mut rows = match &status {
            Some(status) => rows_with_status(&*read, status)?,
            None => all_rows(&*read)?,
        };
        rows.retain(|r| {
            queue.as_ref().is_none_or(|q| &r.queue == q)
                && name.as_ref().is_none_or(|n| &r.name == n)
                && owner.as_ref().is_none_or(|c| {
                    r.data
                        .get("__owner_client_id")
                        .and_then(jsonb_field_text)
                        .as_ref()
                        == Some(c)
                })
        });
        rows.sort_by_key(|r| std::cmp::Reverse((r.created_at, r.id)));
        let offset = filter.offset.unwrap_or(0).max(0) as usize;
        let limit = filter.limit.unwrap_or(50).max(0) as usize;
        Ok(rows
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|r| r.to_json())
            .collect())
    }

    // ------------------------------------------------------------ claim and lease

    /// `claimNextJob`: the first `waiting` row of `names` in `queue` by priority then age, stamped
    /// with the lease, the resolved timeout and lease, the attempt and the spend fence.
    pub fn claim_next_job(&self, spec: &ClaimSpec) -> Result<Option<Value>> {
        if spec.names.is_empty() {
            return Ok(None);
        }
        if (spec.exclude_watchdog_suspects || spec.suspect_wait_ms.is_some())
            && spec.suspect_mark.is_none()
        {
            return Err(StoreError::invalid(
                "claimNextJob: excludeWatchdogSuspects and suspectWaitMs need suspectMark",
            ));
        }
        let names: HashSet<&str> = spec.names.iter().map(String::as_str).collect();
        let excluded: HashSet<&str> = spec
            .exclude_names
            .iter()
            .flatten()
            .map(String::as_str)
            .collect();
        self.write(|tx| {
            let now = self.env.now_micros();
            // `overdue`: marked, and last touched at least `suspectWaitMs` ago.
            let overdue_cutoff = spec.suspect_wait_ms.map(|w| now - ms_to_us(w));
            let overdue = |row: &JobRecord| {
                overdue_cutoff.is_some_and(|c| {
                    spec.suspect_mark.as_deref().is_some_and(|m| row.marked(m))
                        && row.updated_at <= c
                })
            };
            let mut picked = None;
            let mut first_overdue = None;
            for id in ids_under(tx, &claim_prefix(&spec.queue))? {
                let Some(row) = load(tx, id)?.filter(|r| r.queue == spec.queue) else {
                    continue;
                };
                let eligible =
                    row.submission_authority.is_some() && names.contains(row.name.as_str());
                if eligible && overdue(&row) {
                    // A busy worker (excluding suspects) claims nothing while one waits overdue.
                    if spec.exclude_watchdog_suspects {
                        return Ok(None);
                    }
                    if !excluded.contains(row.name.as_str()) {
                        first_overdue.get_or_insert_with(|| row.clone());
                    }
                }
                let suspect = spec.exclude_watchdog_suspects
                    && spec.suspect_mark.as_deref().is_some_and(|m| row.marked(m));
                if eligible && !excluded.contains(row.name.as_str()) && !suspect && picked.is_none()
                {
                    picked = Some(row);
                    if spec.suspect_wait_ms.is_none() {
                        break;
                    }
                }
            }
            // `ORDER BY overdue DESC, priority, created_at`: an overdue row (that the exclusions
            // allow) leads.
            if first_overdue.is_some() {
                picked = first_overdue;
            }
            let Some(old) = picked else { return Ok(None) };
            let mut new = old.clone();
            let lookup = |map: &HashMap<String, Value>| {
                map.get(&old.name).and_then(Value::as_i64).map(|v| v as i32)
            };
            let lease = old
                .lock_duration_ms
                .or_else(|| lookup(&spec.handler_lock_durations));
            let timeout = old.timeout_ms.or_else(|| lookup(&spec.handler_timeouts));
            new.status = "active".into();
            new.claim_generation = old.claim_generation + 1;
            new.spend_claim_token = Some(old.claim_generation + 1);
            if old.spend_authorization.is_none() && legacy_spend_row(&old) {
                new.spend_authorization = Some(legacy_spend_record(&old, &spec.legacy_spend, now));
            }
            new.lock_token = Some(spec.lock_token.clone());
            match lease {
                None => {
                    new.lock_until = Some(now + ms_to_us(spec.lock_duration_ms));
                    new.lock_duration_ms = None;
                }
                Some(l) => {
                    let clamped = l.clamp(5000, 3_600_000);
                    new.lock_until = Some(now + ms_to_us(f64::from(clamped)));
                    new.lock_duration_ms = Some(clamped);
                }
            }
            new.timeout_ms = timeout;
            new.timeout_at = timeout.map(|t| now + ms_to_us(f64::from(t)));
            new.attempts_started = old.attempts_started + 1;
            new.started_at = old.started_at.or(Some(now));
            new.updated_at = now;
            save(tx, Some(&old), &new)?;
            Ok(Some(new.to_json()))
        })
    }

    /// `renewJobLease`: pushes the lease of an active row this token holds; false otherwise.
    pub fn renew_job_lease(
        &self,
        id: i64,
        lock_token: &str,
        lock_duration_ms: f64,
    ) -> Result<bool> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let Some(old) = load(tx, id)? else {
                return Ok(false);
            };
            if old.status != "active" || old.lock_token.as_deref() != Some(lock_token) {
                return Ok(false);
            }
            let mut new = old.clone();
            new.lock_until = Some(now + ms_to_us(lock_duration_ms));
            new.updated_at = now;
            save(tx, Some(&old), &new)?;
            Ok(true)
        })
    }

    // ------------------------------------------------------------ finish

    /// `completeJob`: the completed row (before a `remove_on_complete` delete), or None when the
    /// token no longer holds an active row.
    pub fn complete_job(
        &self,
        id: i64,
        lock_token: &str,
        result: Option<&Value>,
    ) -> Result<Option<Value>> {
        let result = result.filter(|r| !r.is_null());
        self.write(|tx| {
            let now = self.env.now_micros();
            let Some(old) = load(tx, id)? else {
                return Ok(None);
            };
            if old.status != "active" || old.lock_token.as_deref() != Some(lock_token) {
                return Ok(None);
            }
            let mut row = old.clone();
            row.status = "completed".into();
            row.result = result.cloned();
            row.finished_at = Some(now);
            row.lock_token = None;
            row.lock_until = None;
            row.updated_at = now;
            save(tx, Some(&old), &row)?;
            if let Some(parent) = row.parent_job_id {
                let tokens = [row.tokens_input, row.tokens_output, row.tokens_cache_read];
                if tokens.iter().any(|t| *t > 0)
                    && let Some(p_old) = load(tx, parent)?.filter(|p| !is_terminal(&p.status))
                {
                    let mut p = p_old.clone();
                    p.tokens_input = add_token("input", p.tokens_input, tokens[0])?;
                    p.tokens_output = add_token("output", p.tokens_output, tokens[1])?;
                    p.tokens_cache_read = add_token("cache_read", p.tokens_cache_read, tokens[2])?;
                    p.updated_at = now;
                    save(tx, Some(&p_old), &p)?;
                }
                post_child_done(
                    tx,
                    parent,
                    child_done(&row, Some(result.unwrap_or(&Value::Null)), "complete", None),
                    now,
                )?;
                resolve_parent(tx, parent, now)?;
            }
            let out = row.to_json();
            if row.remove_on_complete {
                delete_row(tx, &row)?;
            }
            Ok(Some(out))
        })
    }

    /// `failJob`: `delayed` (a retry after `backoff_ms`), `failed` or `dead`; a terminal failure
    /// notifies the parent and applies `on_child_fail`. None when the token is stale.
    pub fn fail_job(
        &self,
        id: i64,
        lock_token: &str,
        error_text: &str,
        new_status: &str,
        backoff_ms: Option<f64>,
        result: Option<&Value>,
    ) -> Result<Option<Value>> {
        if !["delayed", "failed", "dead"].contains(&new_status) {
            return Err(StoreError::invalid(format!("failJob: status {new_status}")));
        }
        let result = result.filter(|r| !r.is_null());
        self.write(|tx| {
            let now = self.env.now_micros();
            let Some(old) = load(tx, id)? else {
                return Ok(None);
            };
            if old.status != "active" || old.lock_token.as_deref() != Some(lock_token) {
                return Ok(None);
            }
            let delayed = new_status == "delayed";
            let terminal = !delayed;
            let mut row = old.clone();
            row.status = new_status.into();
            row.error_text = Some(error_text.into());
            row.attempts_made = old.attempts_made + 1;
            row.append_stack(json!(error_text));
            row.delay_until = delayed.then(|| now + ms_to_us(backoff_ms.unwrap_or(0.0)));
            row.finished_at = terminal.then_some(now);
            if delayed {
                row.started_at = None;
            }
            if let Some(r) = result {
                row.result = Some(r.clone());
            }
            row.lock_token = None;
            row.lock_until = None;
            row.updated_at = now;
            save(tx, Some(&old), &row)?;
            let out = row.to_json();
            if let (true, Some(parent)) = (terminal, row.parent_job_id) {
                let outcome = if new_status == "dead" {
                    "dead"
                } else {
                    "failed"
                };
                post_child_done(
                    tx,
                    parent,
                    child_done(&row, None, outcome, Some(error_text)),
                    now,
                )?;
                if row.on_child_fail == "fail_parent" {
                    if let Some(p_old) =
                        load(tx, parent)?.filter(|p| p.status == "waiting-children")
                    {
                        let mut p = p_old.clone();
                        p.status = "failed".into();
                        p.lock_token = None;
                        p.lock_until = None;
                        p.error_text = Some(format!("child job {} failed: {error_text}", row.id));
                        p.finished_at = Some(now);
                        p.updated_at = now;
                        save(tx, Some(&p_old), &p)?;
                    }
                } else {
                    if row.on_child_fail == "remove_dep" {
                        let before = row.clone();
                        row.parent_job_id = None;
                        row.updated_at = now;
                        save(tx, Some(&before), &row)?;
                    }
                    resolve_parent(tx, parent, now)?;
                }
            }
            if terminal && row.remove_on_fail {
                delete_row(tx, &row)?;
            }
            Ok(Some(out))
        })
    }

    /// `reclaimStalledJobs`: removes drain-lease holder rows whose lease is gone, then requeues or
    /// kills every active job whose lease expired more than `grace_ms` ago. `suspect_mark` is
    /// `WATCHDOG_SUSPECT_MARK`. Both lists come back in id order.
    pub fn reclaim_stalled_jobs(&self, grace_ms: f64, suspect_mark: &str) -> Result<Value> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let cutoff = now - ms_to_us(grace_ms);
            let active = rows_with_status(tx, "active")?;
            let live_tokens: HashSet<String> = all_locks(tx)?
                .into_iter()
                .filter(|(_, l)| l.ttl_expires_at > now)
                .map(|(_, l)| l.acquisition_token)
                .collect();
            for row in active.iter().filter(|r| r.queue == LEASE_BEACON_QUEUE) {
                let expired = row.lock_until.is_some_and(|l| l < now);
                let held = row
                    .lock_token
                    .as_ref()
                    .is_some_and(|t| live_tokens.contains(t));
                if expired && !held {
                    delete_row(tx, row)?;
                }
            }
            let active: Vec<JobRecord> = rows_with_status(tx, "active")?;
            let candidates: Vec<&JobRecord> = active
                .iter()
                .filter(|r| {
                    r.queue != LEASE_BEACON_QUEUE && r.lock_until.is_some_and(|l| l < cutoff)
                })
                .collect();
            if candidates.is_empty() {
                return Ok(json!({ "requeued": [], "dead": [] }));
            }
            // Co-runners: a worker with more than one expired claim (or a recorded co-runner stall).
            let candidate_ids: HashSet<i64> = candidates.iter().map(|c| c.id).collect();
            let mut per_worker: HashMap<String, usize> = HashMap::new();
            for r in active
                .iter()
                .filter(|r| r.lock_until.is_some_and(|l| l < now) || candidate_ids.contains(&r.id))
            {
                if let Some(w) = worker_of(r.lock_token.as_deref()) {
                    *per_worker.entry(w.to_string()).or_default() += 1;
                }
            }
            let mut evidence = HashSet::new();
            for status in ["waiting", "active", "delayed"] {
                for r in rows_with_status(tx, status)? {
                    if let Some(e) = r.error_text.filter(|e| e.starts_with(CO_RUNNER_STALL)) {
                        evidence.insert(e);
                    }
                }
            }
            let mut requeued = Vec::new();
            let mut rest = Vec::new();
            for c in candidates {
                let worker = worker_of(c.lock_token.as_deref());
                let shared = !c.marked(suspect_mark)
                    && worker.is_some_and(|w| {
                        per_worker.get(w).copied().unwrap_or(0) > 1
                            || evidence.contains(&format!("{CO_RUNNER_STALL}{w}"))
                    });
                if shared {
                    let mut new = c.clone();
                    new.status = "waiting".into();
                    new.error_text = Some(format!("{CO_RUNNER_STALL}{}", worker.unwrap_or("")));
                    if !c.marked(suspect_mark) {
                        new.append_stack(json!(suspect_mark));
                    }
                    new.started_at = None;
                    new.lock_token = None;
                    new.lock_until = None;
                    new.updated_at = now;
                    save(tx, Some(c), &new)?;
                    requeued.push(new);
                } else {
                    rest.push(c);
                }
            }
            let mut dead = Vec::new();
            for c in rest {
                let mut new = c.clone();
                new.stalled_counter = c.stalled_counter + 1;
                new.lock_token = None;
                new.lock_until = None;
                new.updated_at = now;
                if c.stalled_counter + 1 < c.max_stalled {
                    new.status = "waiting".into();
                    new.started_at = None;
                    save(tx, Some(c), &new)?;
                    requeued.push(new);
                } else {
                    new.status = "dead".into();
                    new.attempts_made = c.attempts_made + 1;
                    new.error_text = Some(MAX_STALLED_TEXT.into());
                    new.finished_at = Some(now);
                    save(tx, Some(c), &new)?;
                    dead.push(new);
                }
            }
            let mut parents = BTreeSet::new();
            for r in &dead {
                if let Some(parent) = r.parent_job_id {
                    parents.insert(parent);
                    post_child_done(
                        tx,
                        parent,
                        child_done(r, None, "dead", Some(MAX_STALLED_TEXT)),
                        now,
                    )?;
                }
            }
            for parent in parents {
                resolve_parent(tx, parent, now)?;
            }
            requeued.sort_by_key(|r| r.id);
            dead.sort_by_key(|r| r.id);
            Ok(json!({
                "requeued": requeued.iter().map(JobRecord::to_json).collect::<Vec<_>>(),
                "dead": dead.iter().map(JobRecord::to_json).collect::<Vec<_>>(),
            }))
        })
    }

    // ------------------------------------------------------------ cycle locks

    /// `acquireCycleLock`: takes a free lock, or steals an expired one whose holder has not
    /// refreshed within the grace. `fence` is the acquire time as epoch seconds text.
    pub fn acquire_cycle_lock(&self, lock_id: &str, opts: &LockAcquire) -> Result<Option<Value>> {
        uuid_arg("acquireCycleLock", &opts.acquisition_token)?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let key = lock_key(lock_id);
            if let Some(held) = get_json::<LockRecord>(tx, &key)? {
                let grace = (opts.steal_grace_seconds * 1_000_000.0).round() as i64;
                let stealable = held.ttl_expires_at < now
                    && held.last_refreshed_at.is_none_or(|r| r < now - grace);
                if !stealable {
                    return Ok(None);
                }
            }
            let record = LockRecord {
                holder_pid: opts.holder_pid,
                holder_host: opts.holder_host.clone(),
                acquired_at: now,
                ttl_expires_at: now + minutes_us(opts.ttl_minutes),
                last_refreshed_at: Some(now),
                acquisition_token: opts.acquisition_token.to_lowercase(),
            };
            put_json(tx, &key, &record)?;
            let fence = format!(
                "{}.{:06}",
                now.div_euclid(1_000_000),
                now.rem_euclid(1_000_000)
            );
            Ok(Some(json!({ "id": lock_id, "fence": fence })))
        })
    }

    pub fn refresh_cycle_lock(&self, lock_id: &str, opts: &LockHolder) -> Result<bool> {
        let ttl = opts
            .ttl_minutes
            .ok_or_else(|| StoreError::invalid("refreshCycleLock: ttlMinutes is required"))?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let key = lock_key(lock_id);
            let Some(mut held) = held_by(tx, &key, opts)? else {
                return Ok(false);
            };
            held.ttl_expires_at = now + minutes_us(ttl);
            held.last_refreshed_at = Some(now);
            put_json(tx, &key, &held)?;
            Ok(true)
        })
    }

    /// `releaseCycleLock` and `deleteCycleLock`: the row goes only when pid and token match.
    pub fn release_cycle_lock(&self, lock_id: &str, opts: &LockHolder) -> Result<bool> {
        self.write(|tx| {
            let key = lock_key(lock_id);
            if held_by(tx, &key, opts)?.is_none() {
                return Ok(false);
            }
            tx.delete(&key)?;
            Ok(true)
        })
    }

    /// `deleteCycleLockIfStale`: as release, only when `last_refreshed_at` is older than
    /// `maxAgeSeconds`. Returns `{ deleted, lastRefreshedAt }`.
    pub fn delete_cycle_lock_if_stale(&self, lock_id: &str, opts: &LockHolder) -> Result<Value> {
        let max_age = opts.max_age_seconds.ok_or_else(|| {
            StoreError::invalid("deleteCycleLockIfStale: maxAgeSeconds is required")
        })?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let key = lock_key(lock_id);
            let none = json!({ "deleted": false, "lastRefreshedAt": null });
            let Some(held) = held_by(tx, &key, opts)? else {
                return Ok(none);
            };
            let cutoff = now - (max_age * 1_000_000.0).round() as i64;
            match held.last_refreshed_at {
                Some(r) if r < cutoff => {
                    tx.delete(&key)?;
                    Ok(json!({ "deleted": true, "lastRefreshedAt": iso(r) }))
                }
                _ => Ok(none),
            }
        })
    }

    /// `takePageEmbeddingLease`: writes the lease when no row stands or the row expired (no
    /// steal grace, unlike `acquireCycleLock`); false while an unexpired row stands.
    pub fn take_page_embedding_lease(&self, lease_id: &str, opts: &PageLeaseTake) -> Result<bool> {
        uuid_arg("takePageEmbeddingLease", &opts.acquisition_token)?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let key = lock_key(lease_id);
            if let Some(held) = get_json::<LockRecord>(tx, &key)?
                && held.ttl_expires_at >= now
            {
                return Ok(false);
            }
            let record = LockRecord {
                holder_pid: opts.holder_pid,
                holder_host: Some(opts.holder_host.clone()),
                acquired_at: now,
                ttl_expires_at: now + minutes_us(opts.ttl_minutes),
                last_refreshed_at: Some(now),
                acquisition_token: opts.acquisition_token.to_lowercase(),
            };
            put_json(tx, &key, &record)?;
            Ok(true)
        })
    }

    /// `renewPageEmbeddingLease`: pushes the expiry out when the row still carries the token.
    pub fn renew_page_embedding_lease(
        &self,
        lease_id: &str,
        opts: &PageLeaseHolder,
    ) -> Result<bool> {
        uuid_arg("renewPageEmbeddingLease", &opts.acquisition_token)?;
        let ttl = opts.ttl_minutes.ok_or_else(|| {
            StoreError::invalid("renewPageEmbeddingLease: ttlMinutes is required")
        })?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let key = lock_key(lease_id);
            let Some(mut held) = get_json::<LockRecord>(tx, &key)?
                .filter(|l| l.acquisition_token == opts.acquisition_token.to_lowercase())
            else {
                return Ok(false);
            };
            held.ttl_expires_at = now + minutes_us(ttl);
            held.last_refreshed_at = Some(now);
            put_json(tx, &key, &held)?;
            Ok(true)
        })
    }

    /// `releasePageEmbeddingLease`: deletes this holder's row and every expired `embed-page:` row.
    pub fn release_page_embedding_lease(
        &self,
        lease_id: &str,
        opts: &PageLeaseHolder,
    ) -> Result<()> {
        uuid_arg("releasePageEmbeddingLease", &opts.acquisition_token)?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let token = opts.acquisition_token.to_lowercase();
            let mut doomed = Vec::new();
            for (id, lock) in all_locks(tx)? {
                let own = id == lease_id && lock.acquisition_token == token;
                let expired =
                    id.starts_with(PAGE_EMBEDDING_LEASE_PREFIX) && lock.ttl_expires_at < now;
                if own || expired {
                    doomed.push(lock_key(&id));
                }
            }
            for key in doomed {
                tx.delete(&key)?;
            }
            Ok(())
        })
    }

    /// `readCycleLocks`: rows with `db_now`, the store clock the ages compare against. `stale`
    /// and `all` come oldest acquire first.
    pub fn read_cycle_locks(&self, filter: &LockFilter) -> Result<Vec<Value>> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut rows: Vec<(String, LockRecord)> = match filter {
            LockFilter::Id { lock_id } => get_json::<LockRecord>(&*read, &lock_key(lock_id))?
                .map(|l| vec![(lock_id.clone(), l)])
                .unwrap_or_default(),
            LockFilter::Ids { lock_ids } => {
                let mut out = BTreeMap::new();
                for id in lock_ids {
                    if let Some(l) = get_json::<LockRecord>(&*read, &lock_key(id))? {
                        out.insert(id.clone(), l);
                    }
                }
                out.into_iter().collect()
            }
            LockFilter::Stale => all_locks(&*read)?
                .into_iter()
                .filter(|(_, l)| l.ttl_expires_at < now)
                .collect(),
            LockFilter::All => all_locks(&*read)?,
        };
        if matches!(filter, LockFilter::Stale | LockFilter::All) {
            rows.sort_by(|a, b| (a.1.acquired_at, &a.0).cmp(&(b.1.acquired_at, &b.0)));
        }
        Ok(rows
            .into_iter()
            .map(|(id, l)| {
                json!({
                    "id": id,
                    "holder_pid": l.holder_pid,
                    "holder_host": l.holder_host,
                    "acquired_at": iso(l.acquired_at),
                    "ttl_expires_at": iso(l.ttl_expires_at),
                    "last_refreshed_at": l.last_refreshed_at.map(iso),
                    "acquisition_token": l.acquisition_token.clone(),
                    "db_now": iso(now),
                })
            })
            .collect())
    }

    /// `assertCycleLease`: the lease is held under this token and unexpired.
    pub fn assert_cycle_lease(&self, lock_id: &str, acquisition_token: &str) -> Result<bool> {
        uuid_arg("assertCycleLease", acquisition_token)?;
        let now = self.env.now_micros();
        Ok(
            get_json::<LockRecord>(&*self.read()?, &lock_key(lock_id))?.is_some_and(|l| {
                l.acquisition_token == acquisition_token.to_lowercase() && l.ttl_expires_at > now
            }),
        )
    }
}

fn minutes_us(minutes: f64) -> i64 {
    (minutes * 60_000_000.0).round() as i64
}

/// A `::uuid` cast: Postgres refuses any other text.
fn uuid_arg(op: &str, token: &str) -> Result<()> {
    if crate::env::is_uuid(&token.to_lowercase()) {
        Ok(())
    } else {
        Err(StoreError::invalid(format!(
            "{op}: invalid input syntax for type uuid: \"{token}\""
        )))
    }
}

fn held_by(read: &dyn KvRead, key: &[u8], opts: &LockHolder) -> Result<Option<LockRecord>> {
    uuid_arg("cycle lock", &opts.acquisition_token)?;
    Ok(get_json::<LockRecord>(read, key)?.filter(|l| {
        l.holder_pid == opts.holder_pid
            && l.acquisition_token == opts.acquisition_token.to_lowercase()
    }))
}

/// `CLAIM_HEAD_LEASE_HELD`'s lock test: lock `id` is live (`ttl_expires_at>now()`) and held by a
/// process other than `pid` on `host` (`holder_host IS NOT DISTINCT FROM host`).
pub(crate) fn lock_held_by_other(
    read: &dyn KvRead,
    id: &str,
    pid: i64,
    host: &str,
    now: i64,
) -> Result<bool> {
    Ok(
        get_json::<LockRecord>(read, &lock_key(id))?.is_some_and(|l| {
            l.ttl_expires_at > now
                && !(l.holder_pid == pid && l.holder_host.as_deref() == Some(host))
        }),
    )
}

/// The ids of every `gbrain_cycle_locks` row, in key order (shared-skill activation's legacy
/// writer check).
pub(crate) fn cycle_lock_ids(read: &dyn KvRead) -> Result<Vec<String>> {
    Ok(all_locks(read)?.into_iter().map(|(id, _)| id).collect())
}

fn all_locks(read: &dyn KvRead) -> Result<Vec<(String, LockRecord)>> {
    let mut out = Vec::new();
    let mut bad = None;
    let p = prefix(LOCK);
    scan_prefix(read, &p, false, &mut |k, v| {
        let id = String::from_utf8_lossy(&k[p.len()..]).into_owned();
        match serde_json::from_slice(v) {
            Ok(l) => {
                out.push((id, l));
                true
            }
            Err(e) => {
                bad = Some(e);
                false
            }
        }
    })?;
    if let Some(e) = bad {
        return Err(e.into());
    }
    Ok(out)
}

/// The `legacy_locks` part of the writer admin state (`engine-sql/writer-admin.ts`): each cycle
/// lock that is not a page embedding lease as `[id, holder_pid, holder_host, acquisition_token,
/// acquired_at]`, by id in byte order. `acquired_at` has the jsonb `timestamptz` text.
pub(crate) fn legacy_lock_rows(read: &dyn KvRead) -> Result<Vec<Value>> {
    let mut rows: Vec<(String, LockRecord)> = all_locks(read)?
        .into_iter()
        .filter(|(id, _)| !id.starts_with(PAGE_EMBEDDING_LEASE_PREFIX))
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(rows
        .into_iter()
        .map(|(id, l)| {
            json!([
                id,
                l.holder_pid,
                l.holder_host,
                l.acquisition_token,
                crate::facts::jsonb_time(l.acquired_at)
            ])
        })
        .collect())
}

/// The live cycle locks writer activation and deactivation name (`engine-sql/writer-release.ts`
/// `liveLeases`): each unexpired lock that is not a page embedding lease, by id in byte order, as
/// `{ id, holder_host, holder_pid }`.
pub(crate) fn release_lock_rows(read: &dyn KvRead, now_us: i64) -> Result<Vec<Value>> {
    let mut rows: Vec<(String, LockRecord)> = all_locks(read)?
        .into_iter()
        .filter(|(id, l)| !id.starts_with(PAGE_EMBEDDING_LEASE_PREFIX) && l.ttl_expires_at > now_us)
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(rows
        .into_iter()
        .map(
            |(id, l)| json!({ "id": id, "holder_host": l.holder_host, "holder_pid": l.holder_pid }),
        )
        .collect())
}

/// `LEGACY_SPEND_PREDICATE_SQL`: the NULL-record rows of the consent-gated producers
/// (spend-authorization.ts `LEGACY_SPEND_KEY_PREFIXES`).
fn legacy_spend_row(row: &JobRecord) -> bool {
    let key = row.idempotency_key.as_deref().unwrap_or("");
    match row.name.as_str() {
        "subagent" => key.starts_with("book-mirror:"),
        "enrich" => key.starts_with("enrich:") || key.starts_with("cli:enrich:"),
        _ => false,
    }
}

/// The `legacy_default` spend record the claim stamps (engine-sql/jobs.ts `claimNextJob`).
fn legacy_spend_record(row: &JobRecord, spend: &LegacySpend, now: i64) -> Value {
    let enrich = row.name == "enrich";
    let cap = match row.data.get("maxCostUsd") {
        Some(Value::Number(n)) if enrich && n.as_f64().is_some_and(|f| f > 0.0) => {
            Value::Number(n.clone())
        }
        _ => json!(spend.cap_usd),
    };
    let millis = now.div_euclid(1000) * 1000;
    let at = iso(millis);
    // `YYYY-MM-DDTHH24:MI:SS.MSZ`: millisecond precision.
    let at = format!("{}Z", &at[..23]);
    ordered(&json!({
        "version": 1,
        "kind": "legacy_default",
        "group_id": spend.group_id,
        "cap_usd": cap,
        "cap_source": "default",
        "command": if enrich { "enrich" } else { "book-mirror" },
        "authorized_at": at,
    }))
}

/// The message of the `minion_queue_protocol` trigger's insert refusal (src/schema.sql).
const MINION_QUEUE_PROTOCOL_REFUSAL: &str =
    "Minion queue protocol 1 required: upgrade every producer and worker before restart";

fn admit_in(
    tx: &mut dyn KvWrite,
    spec: &AdmitSpec,
    authority: Option<&Value>,
    spend: Option<Value>,
    (delay_until, lease_until): (Option<i64>, Option<i64>),
    now: i64,
) -> Result<Step> {
    let v = &spec.insert;
    let coalesced = |row: &JobRecord, audit: Option<Value>| {
        Step::Done(AdmitOutcome {
            outcome: "coalesced",
            row: row.to_json(),
            audit,
        })
    };
    // Idempotency key.
    if let Some(key) = &v.idempotency_key
        && let Some(id) = get_json::<i64>(tx, &idem_key(key))?
        && let Some(existing) = load(tx, id)?
    {
        match decide(&existing, authority) {
            Decision::Coalesce => return Ok(coalesced(&existing, None)),
            Decision::Conflict => return Ok(Step::Conflict(existing.to_json())),
            Decision::Release => {
                let mut new = existing.clone();
                new.idempotency_key = None;
                new.data = with_released_key(std::mem::take(&mut new.data), key);
                save(tx, Some(&existing), &new)?;
            }
        }
    }
    let mut waiting: Option<Vec<JobRecord>> = None;
    let mut waiting_rows = |tx: &mut dyn KvWrite| -> Result<Vec<JobRecord>> {
        if waiting.is_none() {
            waiting = Some(rows_with_status(tx, "waiting")?);
        }
        Ok(waiting.clone().unwrap_or_default())
    };
    // Parameter coalesce.
    if let Some(pc) = &spec.param_coalesce {
        let min_updated = pc
            .max_age_hours
            .map(|h| now - (h * 3_600_000_000.0).round() as i64);
        let best = waiting_rows(tx)?
            .into_iter()
            .filter(|r| {
                r.name == v.name
                    && r.queue == v.queue
                    && r.parent_job_id.is_none()
                    && r.data
                        .get("__param_hash")
                        .and_then(jsonb_field_text)
                        .as_deref()
                        == Some(pc.param_hash.as_str())
                    && min_updated.is_none_or(|m| r.updated_at > m)
            })
            .max_by_key(|r| (r.created_at, r.id));
        if let Some(m) = best {
            return match decide(&m, authority) {
                Decision::Coalesce => Ok(coalesced(
                    &m,
                    Some(
                        json!({ "queue": v.queue, "name": v.name, "param_hash": pc.param_hash, "returned_job_id": m.id }),
                    ),
                )),
                _ => Ok(Step::Conflict(m.to_json())),
            };
        }
    }
    if spec.capacity_check {
        return Ok(Step::Capacity);
    }
    // Name quota (every queue).
    if let Some(max) = spec.quota_max_waiting {
        let count = waiting_rows(tx)?
            .iter()
            .filter(|r| r.name == v.name)
            .count();
        if count as f64 >= max {
            return Err(StoreError::new(
                crate::error::ADMISSION_REFUSED,
                format!("queue_quota_exceeded:{}:{count}:{max}", v.name),
            ));
        }
    }
    // Backpressure caps.
    if let Some(bp) = &spec.backpressure {
        let same_scope = |r: &JobRecord| r.name == v.name && r.queue == v.queue;
        if let Some(max) = bp.max_pending {
            let max_pending = max.floor().max(1.0) as usize;
            let mut pending: Vec<JobRecord> = waiting_rows(tx)?;
            pending.extend(rows_with_status(tx, "active")?);
            pending.retain(|r| same_scope(r) && r.pending(now) && r.scope_source() == bp.source_id);
            if pending.len() >= max_pending
                && let Some(e) = pending
                    .iter()
                    .max_by_key(|r| (u8::from(r.status == "waiting"), r.created_at, r.id))
            {
                let audit = json!({ "queue": v.queue, "name": v.name, "pending_count": pending.len(), "max_pending": max_pending, "returned_job_id": e.id });
                return match decide(e, authority) {
                    Decision::Coalesce => Ok(coalesced(e, Some(audit))),
                    _ => Ok(Step::Conflict(e.to_json())),
                };
            }
        }
        if let Some(max) = bp.max_waiting {
            let max_waiting = max.floor().max(1.0) as usize;
            let rows: Vec<JobRecord> = waiting_rows(tx)?
                .into_iter()
                .filter(|r| {
                    same_scope(r) && (bp.source_id.is_none() || r.scope_source() == bp.source_id)
                })
                .collect();
            if rows.len() >= max_waiting
                && let Some(e) = rows.iter().max_by_key(|r| (r.created_at, r.id))
            {
                let audit = json!({ "queue": v.queue, "name": v.name, "waiting_count": rows.len(), "max_waiting": max_waiting, "returned_job_id": e.id });
                return match decide(e, authority) {
                    Decision::Coalesce => Ok(coalesced(e, Some(audit))),
                    _ => Ok(Step::Conflict(e.to_json())),
                };
            }
        }
    }
    // Parent checks.
    let mut depth = 0i64;
    if let Some(parent_id) = v.parent_job_id {
        let refuse = |m: String| Err(StoreError::new(crate::error::INVALID_STATE, m));
        let Some(parent) = load(tx, parent_id)? else {
            return refuse(format!("parent_job_id {parent_id} not found"));
        };
        let kind = parent
            .submission_authority
            .as_ref()
            .and_then(|a| a.get("kind"))
            .and_then(Value::as_str);
        if kind.is_some_and(|k| k != "application") {
            return refuse("Remote jobs cannot have descendants".into());
        }
        if !NON_TERMINAL.contains(&parent.status.as_str()) {
            return refuse(format!(
                "parent job {parent_id} is {}; a finished job cannot get new children",
                parent.status
            ));
        }
        depth = i64::from(parent.depth) + 1;
        if depth > spec.max_spawn_depth {
            return refuse(format!(
                "spawn depth {depth} exceeds maxSpawnDepth {}",
                spec.max_spawn_depth
            ));
        }
        if let Some(max) = parent.max_children {
            let live = live_children(tx, parent_id)?;
            if live >= max as usize {
                return refuse(format!(
                    "parent {parent_id} already has {live} live children (max_children={max})"
                ));
            }
        }
    }
    if let Some(owner) = v.private_queue_owner_job_id
        && load(tx, owner)?.is_none()
    {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            format!("minion_jobs foreign key: private_queue_owner_job_id {owner} does not exist"),
        ));
    }
    // The SQL engines' `minion_queue_protocol` trigger refuses an insert without an authority (a
    // legacy NULL row only exists from before the protocol, which a Rust store never held).
    if authority.is_none() {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            MINION_QUEUE_PROTOCOL_REFUSAL,
        ));
    }
    // Insert.
    let id = next_seq(tx, "job")?;
    let row = JobRecord {
        id,
        name: v.name.clone(),
        queue: v.queue.clone(),
        status: v.status.clone(),
        priority: v.priority,
        submission_authority: authority.cloned(),
        claim_generation: 0,
        data: if v.data.is_null() {
            json!({})
        } else {
            v.data.clone()
        },
        max_attempts: v.max_attempts,
        attempts_made: 0,
        attempts_started: 0,
        backoff_type: v.backoff_type.clone(),
        backoff_delay: v.backoff_delay,
        backoff_jitter: v.backoff_jitter,
        stalled_counter: 0,
        max_stalled: v.max_stalled.unwrap_or(5),
        lock_token: None,
        lock_until: None,
        delay_until,
        parent_job_id: v.parent_job_id,
        on_child_fail: v.on_child_fail.clone(),
        tokens_input: 0,
        tokens_output: 0,
        tokens_cache_read: 0,
        result: None,
        progress: None,
        error_text: None,
        stacktrace: Some(json!([])),
        depth: depth as i32,
        max_children: v.max_children,
        timeout_ms: v.timeout_ms,
        lock_duration_ms: v.lock_duration_ms,
        timeout_at: None,
        remove_on_complete: v.remove_on_complete,
        remove_on_fail: v.remove_on_fail,
        idempotency_key: v.idempotency_key.clone(),
        private_queue_owner_job_id: v.private_queue_owner_job_id,
        private_queue_owner_token: v.private_queue_owner_token.clone(),
        private_queue_lease_until: lease_until,
        created_at: now,
        started_at: None,
        finished_at: None,
        updated_at: now,
        quiet_hours: v.quiet_hours.clone().filter(|q| !q.is_null()),
        stagger_key: v.stagger_key.clone(),
        budget_remaining_cents: None,
        budget_owner_job_id: None,
        budget_root_owner_id: None,
        spend_authorization: spend.filter(|s| !s.is_null()),
        spend_claim_token: None,
    };
    save(tx, None, &row)?;
    if let Some(parent_id) = v.parent_job_id
        && let Some(p_old) = load(tx, parent_id)?
            .filter(|p| ["waiting", "active", "delayed"].contains(&p.status.as_str()))
    {
        let mut p = p_old.clone();
        p.status = "waiting-children".into();
        p.updated_at = now;
        save(tx, Some(&p_old), &p)?;
    }
    Ok(Step::Done(AdmitOutcome {
        outcome: "inserted",
        row: row.to_json(),
        audit: None,
    }))
}
