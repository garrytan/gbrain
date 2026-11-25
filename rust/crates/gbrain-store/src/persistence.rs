//! Persistence: the tables the TypeScript persistence coordinator reads and writes (write requests,
//! effects, capacity counters, operation checkpoints, worktree bindings, consumers and the page
//! projection queue). The coordinator stays TypeScript; this family stores its rows and answers
//! the typed journal members of `src/core/engine-sql/persistence-journal.ts` and
//! `persistence-claims.ts` (rust/docs/store/persistence.md).
//!
//! Keys: write requests stay under `keys::REQUEST` and `keys::REQUEST_ID` and local writers under
//! `keys::WRITER` (`journal.rs`). Every other record of this family starts with
//! `keys::PERSISTENCE` (`d`). The bytes after the tag are this file's to define:
//!
//! | Key | Record |
//! |---|---|
//! | `d 0x01 <counter key>` | one `persistence_counters` row (`CounterRecord`), JSON |
//! | `d 0x02 <op> 0x00 <fingerprint>` | one housekeeping `op_checkpoints` row (`housekeeping.rs`), JSON |
//! | `d 0x03 <principal_id> 0x00 <request_id>` | one `persistence_topology_changes` row (`topology.rs`), JSON |
//! | `d 0x04 <source incarnation> 0x00 <slug>` | one `page_projection_jobs` row (`projection_queue.rs`), JSON |
//! | `d 0x05 <request id> 0x00 <kind>` | one `persistence_effects` row (`effects.rs`), JSON |
//! | `d 0x06 <id, 8 bytes big-endian>` | the effect claim-order index (`effects.rs`), JSON |
//! | `d 0x07 <op> 0x00 <fingerprint> 0x00 <path>` | one `op_checkpoint_paths` row (`op_checkpoint.rs`), empty |
//! | `d 0x08 0x01 <host_id>` | one `sync_notifier_leases` row (`notifier.rs`), JSON |
//! | `d 0x08 0x02 <source_id>` | one `sync_notifier_sources` row (`notifier.rs`), JSON |
//! | `d 0x08 0x03 <source_id> 0x00 <intent>` | one `sync_wanted_markers` row (`notifier.rs`), JSON |
//! | `d 0x09 0x01 <worktree_id>` | one `persistence_worktrees` row (`worktrees.rs`), JSON |
//! | `d 0x09 0x02 <worktree_id> 0x00 <host_id>` | one `persistence_host_bindings` row (`worktrees.rs`), JSON |
//! | `d 0x09 0x03 <source_id>` | one `persistence_source_bindings` row (`worktrees.rs`), JSON |
//! | `d 0x10 <refresh id>` | one `persistence_worktree_refreshes` row (`worktree_admission.rs`), JSON |
//!
//! `d 0x05` and `d 0x06` are the `persistence_effects` rows and their claim-order index (`effects.rs`); no other
//! family here uses them.

//!
//! A resumable op's checkpoint parent (`op_checkpoint.rs`) is an `op_checkpoints` row, so it is
//! stored under `d 0x02` with the housekeeping turns, as Postgres keeps both in one table.
//!
//! A counter key is the text of `persistence_counters.key` (`brain`, `principal:<kind>:<id>`); it
//! cannot hold NUL, as Postgres text cannot.
//!
//! A request admitted by `insert_write_request` is a `journal::RequestRecord`: the columns the
//! native journal keeps are its own fields, every other `persistence_requests` column it was given
//! is in `RequestRecord::extra` (`fill_request_columns` names them and their defaults).
//! Timestamps in `extra` are ISO strings (`env::iso`).
//!
//! Decision C of the lane: the row locks (`FOR SHARE`, `FOR UPDATE`, `SKIP LOCKED`), the advisory
//! locks and the page write guards these statements take on Postgres are no-ops here. The store
//! runs one write transaction at a time, so a read never overlaps a write. Each member's body is a
//! `*_in` function over one `KvWrite`, so a store write transaction can run several of them.
//!
//! A request or effect that names a worktree reads its `persistence_worktrees` row (written by
//! `worktrees.rs`) through `worktree_rows.rs`: an insert refuses a worktree id with no row, as the
//! foreign key does, and the claim terms on a worktree (owner, state, fence, recovery, lane,
//! waiting) live in `write_claim_terms.rs`. A row admitted `deferred` names its refresh
//! (`deferred_refresh_id`, checked against the refresh rows of `worktree_admission.rs`); the claim
//! takes it once `RELEASED_DEFERRED`, and the state writes refuse what `gbrain_guard_deferred_request`
//! refuses.

use crate::config::read_config;
use crate::env::{Env, is_uuid, iso, parse_iso};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::journal::{
    PRINCIPAL_KINDS, Principal, RequestRecord, max_sequence, next_sequence, read_request,
    write_request,
};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

mod binding_reads;
mod checkpoint_rows;
mod checkpoint_validation;
mod connector_attempts;
mod connector_orphans;
mod diagnostic_checkpoints;
mod dream_reads;
mod effect_retry_reads;
mod effect_scans;
mod effect_worker;
pub(crate) mod effects;
mod embedding_candidates;
mod freshness;
mod git_holds;
mod head_blocker;
mod housekeeping;
mod identity_downgrade;
mod idle_probe;
mod image_seal;
mod journal_redaction;
#[cfg(test)]
mod lease_order_tests;
mod noop_settle;
mod notifier;
mod op_checkpoint;
mod origin_holds;
mod owner_scans;
pub(crate) mod projection_queue;
mod projection_rebuild;
mod publication;
mod purge_effects;
mod receipt_compaction;
mod receipt_list;
mod retained_sources;
mod sync_conversions;
mod sync_orphan_reads;
mod sync_pass_pages;
mod sync_run_reads;
pub(crate) mod topology;
pub(crate) use topology::purge_probe_rows as purge_probe_topology_rows;
mod worktree_admission;
#[cfg(test)]
mod worktree_claim_tests;
mod worktree_rows;
mod worktrees;
mod write_claim_terms;
mod writer_status;
mod writer_status_queue;
mod writer_versions;
pub use checkpoint_validation::{IncompleteSyncReceiptSpec, OpenPassWorkSpec};
pub use connector_orphans::OrphanBounds;
pub use diagnostic_checkpoints::HeldHitQuery;
pub use effect_worker::{EffectClaim, EffectSettle, LinksRearm, Settle};
pub use effects::{PublicationEffectsSpec, QueuedEffect, WithdrawalEffectsSpec};
pub(crate) use effects::{all_effects, request_effects};
pub use head_blocker::HeadBlockerSpec;
pub use housekeeping::{HousekeepingClaim, HousekeepingTurn, TrueUpReservation};
pub(crate) use housekeeping::{HousekeepingRow, turn_key};
pub use identity_downgrade::IdentityDowngradeSpec;
pub use idle_probe::IdleProbeSpec;
pub use image_seal::{ImageSealChunkRef, ImageSealPageRef, ImageSealRow};
pub use journal_redaction::{RedactRequestArgs, SweepChunkArgs};
pub use noop_settle::NoopSettleCandidateSpec;
pub(crate) use notifier::remove_source_rows as remove_notifier_source_rows;
pub use notifier::{
    NotifierCoverage, NotifierLeaseClaim, NotifierStateError, NotifierStatePatch, WantedMarkerInput,
};
pub use op_checkpoint::AtomGenerationBump;
mod trust_scan_cursor;

pub(crate) use op_checkpoint::{
    delete_op_checkpoint_in, list_op_checkpoint_records_in, op_checkpoint_completed_keys,
};
pub use origin_holds::PurgeOrigin;
#[cfg(test)]
pub(crate) use projection_queue::{JobRecord, read_page_job};
pub use projection_queue::{
    ProjectionJobRef, ProjectionWindowCursor, ProjectionWindowKey, SegmentedProjectionFilter,
};
pub(crate) use projection_queue::{
    SeedJob, activation_started_us, parse_timestamptz, queue_page_projection, queued_jobs, seed_job,
};
pub use projection_rebuild::{
    ProjectionJobKey, ProjectionWindowCandidate, QueuedProjectionFilter, QueuedProjectionKey,
    QueuedProjectionPages,
};
pub use publication::{PublicationRead, PublicationWrite, RecoveryTable};
pub use purge_effects::{
    GitEffectsCarryingArgs, PageGitEffectsArgs, PurgeEffectDataArgs, PurgeGitEffectRow,
};
pub use receipt_list::{IncarnationRequestFilter, WriteRequestListFilter};
pub use sync_pass_pages::{SyncImportPageQuery, SyncImportPageWindow};
pub use sync_run_reads::SyncAdmissionEffectsQuery;
pub use topology::TopologyChangeInsert;
pub use worktree_admission::WorktreeAdmissionKey;
pub(crate) use worktrees::remove_source_binding_in;
pub use worktrees::{
    CounterDelta, HostBindingInsert, ReleaseRead, SourceBindingInsert, WorktreeInsert,
};

/// The byte after `keys::PERSISTENCE` of a counter row.
const COUNTER: u8 = 0x01;
/// The byte after `keys::PERSISTENCE` of a housekeeping checkpoint row.
pub(crate) const HOUSEKEEPING: u8 = 0x02;
/// The byte after `keys::PERSISTENCE` of a topology change row (persistence/topology.rs).
const TOPOLOGY: u8 = 0x03;
/// The byte after `keys::PERSISTENCE` of a page projection job (persistence/projection_queue.rs).
const QUEUE: u8 = 0x04;
/// The byte after `keys::PERSISTENCE` of a resumable op's checkpoint path (persistence/op_checkpoint.rs).
/// Not 0x05 or 0x06: those are the `persistence_effects` rows and their claim-order index.
const CHECKPOINT_PATH: u8 = 0x07;
/// The byte after `keys::PERSISTENCE` of a commit notifier row (persistence/notifier.rs). 0x05 to
/// 0x07 are reserved for effect rows and operation checkpoint paths.
const NOTIFIER: u8 = 0x08;
/// The byte after `keys::PERSISTENCE` of a worktree binding row (persistence/worktrees.rs).
const WORKTREES: u8 = 0x09;

/// `persistence_requests.state` CHECK (with `deferred`, added by a later migration).
const REQUEST_STATES: &[&str] = &[
    "queued",
    "running",
    "recovering",
    "committed",
    "conflict",
    "failed",
    "cancelled",
    "deferred",
];

/// The config row `sync.foreground_priority` (`WRITE_SWITCHES.foreground_priority.key`).
const FOREGROUND_PRIORITY_KEY: &str = "sync.foreground_priority";

/// The config row the completion counts clamped true-ups in (`TRUE_UP_CLAMP_SQL`).
pub(crate) const TRUE_UP_CLAMPED_KEY: &str = "persistence.true_up.clamped";

/// The `persistence_requests` columns `RequestRecord` keeps in `extra`, each with its column
/// default. `to_row` fills every one, so a row read here has the column set Postgres returns.
pub(crate) fn fill_request_columns(row: &mut Map<String, Value>, extra: &Map<String, Value>) {
    const NULLS: &[&str] = &[
        "worktree_id",
        "topology_generation",
        "execution_token",
        "claim_expires_at",
        "recovery",
        "admitter_version",
        "admitter_host_id",
        "consumer_version",
        "consumer_host_id",
        "published_at",
        "error_detail",
        "claim_phase",
        "admitter_segment_reader",
        "consumer_segment_reader",
        "next_attempt_at",
        "deferred_refresh_id",
        "deferred_import_from",
    ];
    const ZEROS: &[&str] = &[
        "recovery_bytes",
        "intent_bytes",
        "terminal_reservation",
        "preparation_attempts",
        "transient_interruptions",
    ];
    let mut put = |column: &str, default: Value| {
        // The jsonb columns (recovery, error_detail, claim_phase) read in jsonb key order; ordering
        // a scalar changes nothing.
        let value = extra.get(column).cloned().map(crate::jsonb::order);
        row.insert(column.into(), value.unwrap_or(default));
    };
    for column in NULLS {
        put(column, Value::Null);
    }
    for column in ZEROS {
        put(column, json!(0));
    }
    put("compacted", json!(false));
    put("publication_started", json!(false));
    put("target_kind", json!("page"));
    put("protocol_version", json!(1));
}

// ---------------------------------------------------------------------------------------------
// Values as SQL reads them.

/// `->>`: a JSON value as text. A JSON null (or a missing key) is SQL NULL; a string is its text
/// unquoted; anything else is its JSON text.
pub(crate) fn json_text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// SQL `LIKE` with `%` and `_` and no escape character.
pub(crate) fn sql_like(text: &str, pattern: &str) -> bool {
    fn go(t: &[char], p: &[char]) -> bool {
        match p.split_first() {
            None => t.is_empty(),
            Some(('%', rest)) => (0..=t.len()).any(|i| go(&t[i..], rest)),
            Some(('_', rest)) => !t.is_empty() && go(&t[1..], rest),
            Some((c, rest)) => t.first() == Some(c) && go(&t[1..], rest),
        }
    }
    let t: Vec<char> = text.chars().collect();
    let p: Vec<char> = pattern.chars().collect();
    go(&t, &p)
}

/// `SYNC_KIND`: `COALESCE(intent->>'kind','') LIKE 'managed_sync_%'`.
fn sync_kind(intent: &Value) -> bool {
    sql_like(
        &json_text(intent.get("kind")).unwrap_or_default(),
        "managed_sync_%",
    )
}

/// Three-valued AND / OR / NOT (`None` is SQL NULL).
pub(crate) fn and3(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    match (a, b) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), Some(true)) => Some(true),
        _ => None,
    }
}

fn or3(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    match (a, b) {
        (Some(true), _) | (_, Some(true)) => Some(true),
        (Some(false), Some(false)) => Some(false),
        _ => None,
    }
}

fn not3(a: Option<bool>) -> Option<bool> {
    a.map(|v| !v)
}

/// A timestamp stored in `extra`, in microseconds.
pub(crate) fn extra_time(record: &RequestRecord, column: &str) -> Option<i64> {
    record
        .extra
        .get(column)
        .and_then(Value::as_str)
        .and_then(parse_iso)
}

pub(crate) fn extra_i64(record: &RequestRecord, column: &str) -> i64 {
    record
        .extra
        .get(column)
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

pub(crate) fn extra_is_null(record: &RequestRecord, column: &str) -> bool {
    record.extra.get(column).is_none_or(Value::is_null)
}

pub(crate) fn extra_bool(record: &RequestRecord, column: &str) -> bool {
    record
        .extra
        .get(column)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// A `::uuid` parameter: lower-cased; anything else is refused, as Postgres refuses the cast.
pub(crate) fn uuid_param(text: &str, what: &str) -> Result<String> {
    if is_uuid(text) {
        Ok(text.to_lowercase())
    } else {
        Err(StoreError::invalid(format!("{what} is not a UUID")))
    }
}

fn optional_uuid(text: &Option<String>, what: &str) -> Result<Value> {
    match text {
        None => Ok(Value::Null),
        Some(t) => Ok(json!(uuid_param(t, what)?)),
    }
}

/// A `::text::jsonb` parameter: null stays SQL NULL; text that is not JSON is refused.
fn jsonb_param(text: &Option<String>, what: &str) -> Result<Option<Value>> {
    match text {
        None => Ok(None),
        Some(t) => serde_json::from_str(t)
            .map(Some)
            .map_err(|_| StoreError::invalid(format!("{what} is not JSON"))),
    }
}

fn violation(message: impl Into<String>) -> StoreError {
    StoreError::new(CONSTRAINT_VIOLATION, message)
}

/// Every request record, in key order. Requests are never deleted on this engine.
pub(crate) fn all_requests(read: &dyn KvRead) -> Result<Vec<RequestRecord>> {
    let mut out = Vec::new();
    let mut bad = false;
    scan_prefix(read, &[keys::REQUEST], false, &mut |_, v| {
        match serde_json::from_slice::<RequestRecord>(v) {
            Ok(r) => out.push(r),
            Err(_) => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            "a write request record is not readable",
        ));
    }
    Ok(out)
}

/// The states that hold an outstanding slot (`persistence/journal.ts` `outstandingRefusal`).
pub(crate) const OUTSTANDING_STATES: [&str; 4] = ["queued", "deferred", "running", "recovering"];

pub(crate) fn count_outstanding_by_source_in(
    read: &dyn KvRead,
    principal_kind: &str,
    principal_id: &str,
) -> Result<Vec<Value>> {
    let mut by_source: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
    for r in all_requests(read)? {
        if r.principal_kind == principal_kind
            && r.principal_id == principal_id
            && OUTSTANDING_STATES.contains(&r.state.as_str())
        {
            *by_source.entry(r.source_id).or_default() += 1;
        }
    }
    let mut rows: Vec<(String, u64)> = by_source.into_iter().collect();
    // The map is in byte order of the source id; a stable sort by count keeps it within a tie.
    rows.sort_by_key(|r| std::cmp::Reverse(r.1));
    Ok(rows
        .into_iter()
        .map(|(source_id, n)| json!({ "source_id": source_id, "n": n }))
        .collect())
}

/// The journal half of `readWriteWatermarkRow` (`engine-sql/applied-watermark-reads.ts`): the
/// outstanding requests of one source incarnation (lowest sequence, how many, oldest admission) and,
/// when none is outstanding, the newest sequence in the brain. `incarnation` is `None` for an absent
/// source, which has no outstanding request.
pub(crate) fn read_request_watermark_in(
    read: &dyn KvRead,
    source_id: &str,
    incarnation: Option<&str>,
) -> Result<Value> {
    let all = all_requests(read)?;
    let pending: Vec<_> = all
        .iter()
        .filter(|r| {
            r.source_id == source_id
                && incarnation == Some(r.source_incarnation.as_str())
                && OUTSTANDING_STATES.contains(&r.state.as_str())
        })
        .collect();
    let pending_min = pending.iter().map(|r| r.sequence).min();
    let pending_since = pending.iter().map(|r| r.created_at_us).min().map(iso);
    let newest = match pending_min {
        None => all.iter().map(|r| r.sequence).max(),
        Some(_) => None,
    };
    Ok(json!({
        "pending_min": pending_min,
        "pending_count": pending.len(),
        "pending_since": pending_since,
        "newest_sequence": newest,
    }))
}

/// `persistence/receipt-bytes.ts` `COMPACTED_HEADROOM_BYTES`.
const COMPACTED_HEADROOM_BYTES: i64 = 1024;
/// The admissions `readAdmissionRate` samples.
const ADMISSION_SAMPLE: usize = 1000;

fn text_bytes(value: Option<&Value>) -> i64 {
    match value {
        None | Some(Value::Null) => 0,
        Some(v) => crate::cli_reads::pg_text::jsonb_text(v).len() as i64,
    }
}

/// A request's compacted receipt size (`COMPACTED_RECEIPT_BYTES_SQL`): its reservation, or less
/// when the authority, outcome, error detail and client request id with the compaction headroom
/// are smaller, with the bytes of the request's effect rows (`effect_bytes`).
fn compacted_receipt_bytes(r: &RequestRecord, effect_bytes: i64) -> i64 {
    let kept = text_bytes(Some(&r.authority))
        + effect_bytes
        + text_bytes(r.outcome.as_ref())
        + text_bytes(r.extra.get("error_detail"))
        + r.client_request_id.as_ref().map_or(0, |c| c.len() as i64)
        + COMPACTED_HEADROOM_BYTES;
    extra_i64(r, "terminal_reservation").min(kept)
}

pub(crate) fn read_admission_rate_in(
    read: &dyn KvRead,
    now_us: i64,
    principal: Option<(&str, &str)>,
) -> Result<Value> {
    let mut requests = all_requests(read)?;
    let first = requests
        .iter()
        .min_by_key(|r| r.sequence)
        .map(|r| r.id.clone());
    if let Some((kind, id)) = principal {
        requests.retain(|r| r.principal_kind == kind && r.principal_id == id);
    }
    requests.sort_by_key(|r| std::cmp::Reverse(r.sequence));
    requests.truncate(ADMISSION_SAMPLE);
    let n = requests.len();
    let mean = |f: &dyn Fn(&RequestRecord) -> i64| -> Value {
        if n == 0 {
            Value::Null
        } else {
            json!(requests.iter().map(|r| f(r) as f64).sum::<f64>() / n as f64)
        }
    };
    let mut effect_bytes = Vec::with_capacity(n);
    for r in &requests {
        effect_bytes.push(effects::effect_totals(read, &r.id)?.0);
    }
    let net = if n == 0 {
        Value::Null
    } else {
        json!(
            requests
                .iter()
                .zip(&effect_bytes)
                .map(|(r, b)| compacted_receipt_bytes(r, *b) as f64)
                .sum::<f64>()
                / n as f64
        )
    };
    let oldest = requests.iter().map(|r| r.created_at_us).min();
    Ok(json!({
        "first_request_id": first,
        "admissions": n,
        "age_seconds": oldest.map(|t| (now_us - t) as f64 / 1_000_000.0),
        "gross": mean(&|r| extra_i64(r, "terminal_reservation")),
        "net": net,
    }))
}

/// `readCounterRows(keys)`: the existing counter rows of `keys`, in byte order, unlocked.
pub(crate) fn read_counter_rows_in(read: &dyn KvRead, names: &[String]) -> Result<Vec<Value>> {
    let mut rows = Vec::new();
    for key in distinct_keys(names) {
        if let Some(counter) = read_counter(read, &key)? {
            rows.push(counter.row(&key));
        }
    }
    Ok(rows)
}

/// `state IN ('queued','deferred','running','recovering') OR recovery IS NOT NULL`: a request that
/// keeps a brain from quiescing.
fn blocks_quiescence(r: &RequestRecord) -> bool {
    matches!(
        r.state.as_str(),
        "queued" | "deferred" | "running" | "recovering"
    ) || !extra_is_null(r, "recovery")
}

/// What keeps shared-skill activation from passing, in the order the SQL engines check it
/// (activation.ts, then skill-activation.ts): the first blocking request by sequence, then the
/// first effect holding a recovery record (both `managed`), then the first queued or running
/// effect (`skill`). Effects come in id order; `source_id` is the effect's, else its request's.
pub(crate) fn activation_blocker(read: &dyn KvRead) -> Result<Option<Value>> {
    let mut requests: Vec<RequestRecord> = all_requests(read)?
        .into_iter()
        .filter(blocks_quiescence)
        .collect();
    requests.sort_by_key(|r| r.sequence);
    if let Some(r) = requests.first() {
        return Ok(Some(json!({
            "phase": "managed",
            "kind": "request",
            "request_id": r.request_id,
            "source_id": r.source_id,
            "slug": r.slug,
            "operation": r.operation,
            "state": r.state,
        })));
    }
    let effects = effects::all_effects(read)?;
    let blocking = |recovering_only: bool| -> Result<Option<Value>> {
        for e in &effects {
            let recovering = e.recovery.is_some();
            if !(recovering || !recovering_only && matches!(e.state.as_str(), "queued" | "running"))
            {
                continue;
            }
            let Some(r) = request_by_id(read, &e.request_id)? else {
                continue;
            };
            return Ok(Some(json!({
                "kind": "effect",
                "effect_id": e.id.to_string(),
                "effect_kind": e.kind,
                "state": e.state,
                "recovering": recovering,
                "source_id": e.source_id.clone().unwrap_or(r.source_id),
                "slug": r.slug,
                "request_id": r.request_id,
                "attempts": e.attempts,
                "next_attempt_at": iso(e.next_attempt_at_us),
            })));
        }
        Ok(None)
    };
    if let Some(mut v) = blocking(true)? {
        v["phase"] = json!("managed");
        return Ok(Some(v));
    }
    Ok(blocking(false)?.map(|mut v| {
        v["phase"] = json!("skill");
        v
    }))
}

/// The revisions a pending shared-skill publication of the source incarnation names
/// (retention.ts `publication_revisions`): each skill_bundle request that is queued, running or
/// recovering, or holds a recovery record, gives its `intent.expected_revision` and every
/// `intent.affected[].revision`.
pub(crate) fn pending_skill_revisions(
    read: &dyn KvRead,
    source_id: &str,
    incarnation: &str,
) -> Result<std::collections::BTreeSet<String>> {
    let mut out = std::collections::BTreeSet::new();
    for r in all_requests(read)? {
        let target = r.extra.get("target_kind").and_then(Value::as_str);
        if r.source_id != source_id
            || r.source_incarnation != incarnation
            || target != Some("skill_bundle")
            || !(matches!(r.state.as_str(), "queued" | "running" | "recovering")
                || !extra_is_null(&r, "recovery"))
        {
            continue;
        }
        let text = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
        if let Some(rev) = text(r.intent.get("expected_revision")) {
            out.insert(rev);
        }
        if let Some(Value::Array(affected)) = r.intent.get("affected") {
            out.extend(affected.iter().filter_map(|a| text(a.get("revision"))));
        }
    }
    Ok(out)
}

pub(crate) fn request_by_id(read: &dyn KvRead, id: &str) -> Result<Option<RequestRecord>> {
    get_json(read, &keys::request(&uuid_param(id, "id")?))
}

// ---------------------------------------------------------------------------------------------
// Counters.

/// One `persistence_counters` row. Every column is `bigint DEFAULT 0 CHECK (>= 0)`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct CounterRecord {
    pub(crate) outstanding_count: i64,
    pub(crate) intent_bytes: i64,
    pub(crate) lifetime_ids: i64,
    pub(crate) terminal_bytes: i64,
    pub(crate) recovery_bytes: i64,
}

impl CounterRecord {
    fn row(&self, key: &str) -> Value {
        json!({
            "key": key,
            "outstanding_count": self.outstanding_count,
            "intent_bytes": self.intent_bytes,
            "lifetime_ids": self.lifetime_ids,
            "terminal_bytes": self.terminal_bytes,
            "recovery_bytes": self.recovery_bytes,
        })
    }

    /// The table's CHECK constraints.
    fn check(&self, key: &str) -> Result<()> {
        let fields = [
            self.outstanding_count,
            self.intent_bytes,
            self.lifetime_ids,
            self.terminal_bytes,
            self.recovery_bytes,
        ];
        if fields.iter().any(|v| *v < 0) {
            return Err(violation(format!(
                "persistence counter \"{key}\" would go below zero"
            )));
        }
        Ok(())
    }
}

fn counter_key(key: &str) -> Result<Vec<u8>> {
    if key.contains('\0') {
        return Err(StoreError::invalid(
            "a persistence counter key cannot contain NUL",
        ));
    }
    let mut out = vec![keys::PERSISTENCE, COUNTER];
    out.extend_from_slice(key.as_bytes());
    Ok(out)
}

pub(crate) fn read_counter(read: &dyn KvRead, key: &str) -> Result<Option<CounterRecord>> {
    get_json(read, &counter_key(key)?)
}

fn write_counter(tx: &mut dyn KvWrite, key: &str, counter: &CounterRecord) -> Result<()> {
    counter.check(key)?;
    put_json(tx, &counter_key(key)?, counter)
}

/// The distinct keys of a `key=ANY($n::text[])` match, in byte order (`COLLATE "C"`).
fn distinct_keys(keys: &[String]) -> Vec<String> {
    let mut out = keys.to_vec();
    out.sort();
    out.dedup();
    out
}

/// Every counter row, in key order.
pub(crate) fn all_counters(read: &dyn KvRead) -> Result<Vec<(String, CounterRecord)>> {
    let mut out = Vec::new();
    let mut bad = false;
    scan_prefix(read, &[keys::PERSISTENCE, COUNTER], false, &mut |k, v| {
        match (
            std::str::from_utf8(&k[2..]),
            serde_json::from_slice::<CounterRecord>(v),
        ) {
            (Ok(key), Ok(c)) => out.push((key.to_string(), c)),
            _ => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            "a persistence counter record is not readable",
        ));
    }
    Ok(out)
}

/// `lockPersistenceCounters`: creates the missing rows at zero and returns every named row in key
/// order (the lock itself is a no-op, Decision C).
pub(crate) fn lock_persistence_counters_in(
    tx: &mut dyn KvWrite,
    names: &[String],
) -> Result<Vec<Value>> {
    let mut rows = Vec::new();
    for key in distinct_keys(names) {
        let counter = match read_counter(&*tx, &key)? {
            Some(c) => c,
            None => {
                let fresh = CounterRecord::default();
                write_counter(tx, &key, &fresh)?;
                fresh
            }
        };
        rows.push(counter.row(&key));
    }
    Ok(rows)
}

// ---------------------------------------------------------------------------------------------
// Admission, claim and completion.

/// `WriteRequestInsert` of `src/core/engine-sql/persistence-journal.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRequestInsert {
    pub principal_kind: String,
    pub principal_id: String,
    pub request_id: String,
    pub operation: String,
    pub source_id: String,
    pub source_incarnation: String,
    #[serde(default)]
    pub page_id: Option<u64>,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub worktree_id: Option<String>,
    #[serde(default)]
    pub topology_generation: Option<Value>,
    pub digest: String,
    #[serde(default)]
    pub intent: Value,
    #[serde(default)]
    pub authority: Value,
    pub intent_bytes: i64,
    pub terminal_reservation: i64,
    pub target_kind: String,
    pub protocol_version: i64,
    pub admitter_version: String,
    #[serde(default)]
    pub admitter_host_id: Option<String>,
    pub counter_keys: Vec<String>,
    #[serde(default)]
    pub client_request_id: Option<String>,
    pub state: String,
    #[serde(default)]
    pub deferred_refresh_id: Option<String>,
}

/// A `bigint` parameter given as a number or its text.
fn bigint_param(v: &Option<Value>, what: &str) -> Result<Value> {
    match v {
        None | Some(Value::Null) => Ok(Value::Null),
        Some(Value::Number(n)) if n.is_i64() => Ok(Value::Number(n.clone())),
        Some(Value::String(s)) => s
            .trim()
            .parse::<i64>()
            .map(|n| json!(n))
            .map_err(|_| StoreError::invalid(format!("{what} is not an integer"))),
        Some(_) => Err(StoreError::invalid(format!("{what} is not an integer"))),
    }
}

/// `insertWriteRequest`: the request row and its counter charge (`ADMIT_WRITE_SQL`). The table's
/// constraints are checked as Postgres checks them: the principal kind, state, target kind and
/// protocol version CHECKs, the `(principal_kind, principal_id, request_id)` unique key, the NOT
/// NULL slug, and the worktree and refresh foreign keys: a worktree id must name a worktree row
/// (`worktree_rows.rs`) and a refresh id a refresh row (`worktree_admission.rs`).
pub(crate) fn insert_write_request_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    input: &WriteRequestInsert,
) -> Result<Value> {
    let request_id = uuid_param(&input.request_id, "requestId")?;
    let source_incarnation = uuid_param(&input.source_incarnation, "sourceIncarnation")?;
    let admitter_host_id = optional_uuid(&input.admitter_host_id, "admitterHostId")?;
    if !PRINCIPAL_KINDS.contains(&input.principal_kind.as_str()) {
        return Err(violation(format!(
            "principal_kind \"{}\" is not one of {}",
            input.principal_kind,
            PRINCIPAL_KINDS.join(", ")
        )));
    }
    if !REQUEST_STATES.contains(&input.state.as_str()) {
        return Err(violation(format!(
            "\"{}\" is not a request state",
            input.state
        )));
    }
    if input.target_kind != "page" && input.target_kind != "skill_bundle" {
        return Err(violation(format!(
            "target_kind \"{}\" is not page or skill_bundle",
            input.target_kind
        )));
    }
    if input.protocol_version != 1 && input.protocol_version != 2 {
        return Err(violation("protocol_version is 1 or 2"));
    }
    let Some(slug) = input.slug.clone() else {
        return Err(violation("a write request needs a slug"));
    };
    let worktree_id = optional_uuid(&input.worktree_id, "worktreeId")?;
    if let Some(id) = worktree_id.as_str()
        && worktree_rows::read_worktree_row(&*tx, id)?.is_none()
    {
        return Err(violation(format!(
            "worktree_id {id} names no persistence_worktrees row"
        )));
    }
    let deferred_refresh_id = optional_uuid(&input.deferred_refresh_id, "deferredRefreshId")?;
    if let Some(id) = deferred_refresh_id.as_str()
        && !worktree_admission::refresh_exists(&*tx, id)?
    {
        return Err(violation(format!(
            "deferred_refresh_id {id} names no persistence_worktree_refreshes row"
        )));
    }
    if input.principal_id.contains('\0') {
        // Postgres text refuses a NUL byte, and the duplicate lookup below cannot find a key
        // that holds one, so a repeat would add a second row instead of being refused.
        return Err(StoreError::invalid(
            "insertWriteRequest: principal_id contains a NUL byte",
        ));
    }
    let principal = Principal {
        kind: input.principal_kind.clone(),
        id: input.principal_id.clone(),
    };
    if read_request(&*tx, &principal, &request_id)?.is_some() {
        return Err(violation(format!(
            "request_id {request_id} is already admitted for this principal"
        )));
    }
    let topology_generation = bigint_param(&input.topology_generation, "topologyGeneration")?;
    for key in distinct_keys(&input.counter_keys) {
        if let Some(mut c) = read_counter(&*tx, &key)? {
            let add = |a: i64, b: i64| {
                a.checked_add(b)
                    .ok_or_else(|| violation("persistence counter overflow"))
            };
            c.outstanding_count = add(c.outstanding_count, 1)?;
            c.intent_bytes = add(c.intent_bytes, input.intent_bytes)?;
            c.lifetime_ids = add(c.lifetime_ids, 1)?;
            c.terminal_bytes = add(c.terminal_bytes, input.terminal_reservation)?;
            write_counter(tx, &key, &c)?;
        }
    }
    let now = env.now_micros();
    let mut extra = Map::new();
    extra.insert("topology_generation".into(), topology_generation);
    extra.insert("intent_bytes".into(), json!(input.intent_bytes));
    extra.insert(
        "terminal_reservation".into(),
        json!(input.terminal_reservation),
    );
    extra.insert("target_kind".into(), json!(input.target_kind));
    extra.insert("protocol_version".into(), json!(input.protocol_version));
    extra.insert("admitter_version".into(), json!(input.admitter_version));
    extra.insert("admitter_host_id".into(), admitter_host_id);
    extra.insert("admitter_segment_reader".into(), json!(true));
    extra.insert("deferred_refresh_id".into(), deferred_refresh_id);
    extra.insert("worktree_id".into(), worktree_id);
    let record = RequestRecord {
        id: env.new_uuid(),
        principal_kind: input.principal_kind.clone(),
        principal_id: input.principal_id.clone(),
        request_id: request_id.clone(),
        client_request_id: input.client_request_id.clone(),
        operation: input.operation.clone(),
        source_id: input.source_id.clone(),
        source_incarnation,
        page_id: input.page_id,
        slug,
        digest: input.digest.clone(),
        intent: input.intent.clone(),
        authority: input.authority.clone(),
        sequence: next_sequence(tx)?,
        state: input.state.clone(),
        outcome: None,
        error_code: None,
        error_message: None,
        blocked_reason: None,
        created_at_us: now,
        updated_at_us: now,
        completed_at_us: None,
        extra,
    };
    let mut record = record;
    crate::journal::stamp_origin(
        &mut record.extra,
        &record.principal_kind,
        &record.principal_id,
        None,
    );
    crate::commit_log::scope::note(
        &record.request_id,
        &record.principal_kind,
        &record.principal_id,
    );
    write_request(tx, &record)?;
    tx.put(
        &keys::request_by_principal(&record.principal_kind, &record.principal_id, &request_id),
        record.id.as_bytes(),
    )?;
    Ok(record.to_row())
}

/// `stampWriteClaim({ id, token, leaseMs, phaseJson })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimStamp {
    pub id: String,
    pub token: String,
    pub lease_ms: f64,
    #[serde(default)]
    pub phase_json: Option<String>,
}

fn lease_end(now: i64, lease_ms: f64) -> i64 {
    now + (lease_ms * 1000.0).round() as i64
}

/// `gbrain_guard_deferred_request`'s refusal of a claim of a deferred row whose holds are not released.
const DEFERRED_CLAIM_REFUSED: &str = "writer_upgrade_required: a deferred request is claimed only by a refresh-barrier consumer after its refresh and import are released";

/// `gbrain_guard_deferred_request` (v292, v294) for an update that is not a claim: a row becomes
/// `deferred` only at admission (no update here sets `deferred_import_from`), and a deferred row
/// leaves only to `conflict`, `failed` or `cancelled`.
pub(crate) fn guard_deferred_transition(old: &str, new: &str) -> Result<()> {
    if old != "deferred" && new != "deferred" {
        return Ok(());
    }
    if new == "deferred" {
        if old == "deferred" {
            return Ok(());
        }
        return Err(violation(
            "unsupported_mutation_protocol: only admission, or a refresh-barrier consumer holding its claim for an import, defers a request",
        ));
    }
    if matches!(new, "conflict" | "failed" | "cancelled") {
        return Ok(());
    }
    Err(violation(DEFERRED_CLAIM_REFUSED))
}

/// `CLAIM_STAMP_SQL`: running, the token, the lease and the first phase. `passed_sync` is false:
/// it asks for an earlier queued sync row on the same worktree, and every worktree here is null.
/// `seen_sequence` is the newest sequence for a sync row: requests are never deleted on this
/// engine, so `max(sequence)` is the last sequence handed out.
pub(crate) fn stamp_write_claim_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    stamp: &ClaimStamp,
) -> Result<Option<Value>> {
    let token = uuid_param(&stamp.token, "token")?;
    let phase = jsonb_param(&stamp.phase_json, "phaseJson")?;
    let Some(mut record) = request_by_id(&*tx, &stamp.id)? else {
        return Ok(None);
    };
    // gbrain_guard_deferred_request: the claim runs as a refresh-barrier consumer
    // (REFRESH_BARRIER_CLAIM_PREDICATE), so a deferred row moves to running only once released.
    if record.state == "deferred" && !worktree_admission::released_deferred_in(&*tx, &record)? {
        return Err(violation(DEFERRED_CLAIM_REFUSED));
    }
    let now = env.now_micros();
    record.state = "running".into();
    record.updated_at_us = now;
    record.blocked_reason = None;
    record.extra.insert("execution_token".into(), json!(token));
    record.extra.insert(
        "claim_expires_at".into(),
        json!(iso(lease_end(now, stamp.lease_ms))),
    );
    record
        .extra
        .insert("claim_phase".into(), phase.unwrap_or(Value::Null));
    write_request(tx, &record)?;
    let mut row = record.to_row();
    row["passed_sync"] = json!(false);
    row["seen_sequence"] = if sync_kind(&record.intent) {
        json!(max_sequence(&*tx)?.to_string())
    } else {
        Value::Null
    };
    Ok(Some(row))
}

/// `WriteCompletion` of `src/core/engine-sql/persistence-journal.ts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteCompletion {
    pub id: String,
    pub state: String,
    #[serde(default)]
    pub outcome: Value,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    pub consumer_version: String,
    #[serde(default)]
    pub consumer_host_id: Option<String>,
    #[serde(default)]
    pub error_detail: Value,
    pub result_bytes: i64,
    pub counter_keys: Vec<String>,
    pub intent_bytes: i64,
    pub retained_bytes: i64,
    pub terminal_reservation: i64,
    #[serde(default)]
    pub probe_purges: bool,
}

/// `TerminalIntentCompaction` of `src/core/engine-sql/persistence-journal.ts`: the compaction of a
/// terminal request whose stored intent carried purged content (`journal.ts` finishTerminal).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIntentCompaction {
    pub id: String,
    /// What the receipt keeps without its intent.
    pub left: i64,
    /// The terminal reservation the completion left.
    pub reservation: i64,
    pub counter_keys: Vec<String>,
}

/// `TRUE_UP_CLAMP_SQL`: adds `clamped` counters to `persistence.true_up.clamped` (a value that is
/// not digits counts as 0); nothing is written when none clamped.
fn add_true_up_clamped(tx: &mut dyn KvWrite, clamped: u64) -> Result<()> {
    if clamped == 0 {
        return Ok(());
    }
    let config = keys::text(keys::CONFIG, &[TRUE_UP_CLAMPED_KEY]);
    let old = read_config(&*tx, TRUE_UP_CLAMPED_KEY)?
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    tx.put(&config, (old + clamped).to_string().as_bytes())
}

/// `COMPLETE_WRITE_SQL`: the terminal state, the counter release and the true-up clamp count.
/// The request's effect rows (`effects.rs`) add their bytes to the result; while one is not
/// committed the reservation is kept whole. `None`, with nothing changed, when the result does not fit the
/// terminal reservation. A source has no fact or page purge rows here, so the purge probe answers
/// false.
/// `compactTerminalIntent(compaction)`, as the SQL member's one statement: drops the request's
/// intent and marks it compacted; its terminal reservation shrinks to `left` plus its effect bytes
/// unless an effect is unfinished; each named counter (once) releases `reservation` minus what is
/// kept, never below zero. The compacted row, or `None` for an unknown id (nothing changes). The
/// row's `updated_at` stays as it was.
pub(crate) fn compact_terminal_intent_in(
    tx: &mut dyn KvWrite,
    c: &TerminalIntentCompaction,
) -> Result<Option<Value>> {
    let Some(mut record) = request_by_id(&*tx, &c.id)? else {
        return Ok(None);
    };
    let (effect_bytes, unfinished) = effects::effect_totals(&*tx, &c.id)?;
    let current = extra_i64(&record, "terminal_reservation");
    let out_of_range = || {
        StoreError::invalid("compactTerminalIntent: a byte count is out of range for type bigint")
    };
    let kept = if unfinished {
        current
    } else {
        let left = c.left.checked_add(effect_bytes).ok_or_else(out_of_range)?;
        current.min(left)
    };
    record.intent = Value::Null;
    record.extra.insert("compacted".into(), json!(true));
    record
        .extra
        .insert("terminal_reservation".into(), json!(kept));
    write_request(tx, &record)?;
    let released = c.reservation.checked_sub(kept).ok_or_else(out_of_range)?;
    for key in distinct_keys(&c.counter_keys) {
        let Some(mut counter) = read_counter(&*tx, &key)? else {
            continue;
        };
        counter.terminal_bytes = counter
            .terminal_bytes
            .checked_sub(released.min(counter.terminal_bytes))
            .ok_or_else(out_of_range)?;
        write_counter(tx, &key, &counter)?;
    }
    Ok(Some(record.to_row()))
}

pub(crate) fn complete_write_row_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    c: &WriteCompletion,
) -> Result<Option<Value>> {
    let consumer_host_id = optional_uuid(&c.consumer_host_id, "consumerHostId")?;
    let Some(mut record) = request_by_id(&*tx, &c.id)? else {
        return Ok(None);
    };
    if !REQUEST_STATES.contains(&c.state.as_str()) {
        return Err(violation(format!("\"{}\" is not a request state", c.state)));
    }
    guard_deferred_transition(&record.state, &c.state)?;
    let reservation = extra_i64(&record, "terminal_reservation");
    let (effect_bytes, unfinished) = effects::effect_totals(&*tx, &c.id)?;
    // SQL sums these as exact numerics, so a sum past i64 is simply too big, never a wrapped small one.
    if i128::from(c.result_bytes) + i128::from(effect_bytes) > i128::from(reservation) {
        return Ok(None);
    }
    let kept = if unfinished {
        reservation
    } else {
        let retained = i128::from(c.retained_bytes) + i128::from(effect_bytes);
        i64::try_from(i128::from(reservation).min(retained)).unwrap_or(reservation)
    };
    let out_of_range =
        || StoreError::invalid("completeWriteRow: a byte count is out of range for type bigint");
    let released = c
        .terminal_reservation
        .checked_sub(kept)
        .ok_or_else(out_of_range)?;
    let mut clamped = 0u64;
    for key in distinct_keys(&c.counter_keys) {
        let Some(mut counter) = read_counter(&*tx, &key)? else {
            continue;
        };
        if released > counter.terminal_bytes {
            clamped += 1;
        }
        counter.outstanding_count = counter
            .outstanding_count
            .checked_sub(1)
            .ok_or_else(out_of_range)?;
        counter.intent_bytes = counter
            .intent_bytes
            .checked_sub(c.intent_bytes)
            .ok_or_else(out_of_range)?;
        counter.terminal_bytes = counter
            .terminal_bytes
            .checked_sub(released.min(counter.terminal_bytes))
            .ok_or_else(out_of_range)?;
        write_counter(tx, &key, &counter)?;
    }
    add_true_up_clamped(tx, clamped)?;
    let now = env.now_micros();
    let committed = c.state == "committed";
    record.state = c.state.clone();
    // Stored as `jsonb` stores it: keys shorter first, then by bytes, at every depth.
    record.outcome = (!c.outcome.is_null()).then(|| crate::jsonb::ordered(&c.outcome));
    record.error_code = c.error_code.clone();
    record.error_message = c.error_message.clone();
    record.blocked_reason = None;
    record.completed_at_us = Some(now);
    record.updated_at_us = now;
    let extra = &mut record.extra;
    if !c.error_detail.is_null() {
        extra.insert(
            "error_detail".into(),
            crate::jsonb::ordered(&c.error_detail),
        );
    }
    extra.insert("claim_expires_at".into(), Value::Null);
    if committed {
        extra.insert("consumer_version".into(), json!(c.consumer_version));
        extra.insert("consumer_host_id".into(), consumer_host_id);
        extra.insert("consumer_segment_reader".into(), json!(true));
        extra.insert("published_at".into(), json!(iso(now)));
        extra.insert("preparation_attempts".into(), json!(0));
    }
    extra.insert("terminal_reservation".into(), json!(kept));
    write_request(tx, &record)?;
    let mut row = record.to_row();
    if c.probe_purges {
        let has_facts = crate::facts::purge_ledger::has_fact_purges(&*tx, &record.source_id)?;
        row["purge_has_facts"] = json!(has_facts);
        // Page purges are not modeled: the store keeps no `page_purges` rows.
        row["purge_has_pages"] = json!(false);
    }
    Ok(Some(row))
}

/// `WriteCancellation` of `src/core/engine-sql/persistence-journal.ts`: a completion plus the state
/// and execution token the caller read.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteCancellation {
    #[serde(flatten)]
    pub completion: WriteCompletion,
    pub expect_state: String,
    #[serde(default)]
    pub expect_execution_token: Option<String>,
}

/// `cancelWriteRow`: the lock, the check and the completion in one write. `None` when the row does
/// not exist. `kept` with the row unchanged when it is terminal, publishing, in recovery, or no
/// longer in the state and claim the caller read; `too_large` when the result does not fit.
pub(crate) fn cancel_write_row_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    c: &WriteCancellation,
) -> Result<Option<Value>> {
    if c.completion.state != "cancelled" {
        return Err(violation(format!(
            "cancelWriteRow completes a request as cancelled, not \"{}\"",
            c.completion.state
        )));
    }
    let Some(record) = request_by_id(&*tx, &c.completion.id)? else {
        return Ok(None);
    };
    let token = json_text(record.extra.get("execution_token"));
    let cancellable = !["committed", "conflict", "failed", "cancelled"]
        .contains(&record.state.as_str())
        && record.state == c.expect_state
        && token == c.expect_execution_token
        && !extra_bool(&record, "publication_started")
        && extra_is_null(&record, "recovery");
    if !cancellable {
        return Ok(Some(json!({ "status": "kept", "row": record.to_row() })));
    }
    Ok(Some(match complete_write_row_in(tx, env, &c.completion)? {
        Some(row) => json!({ "status": "cancelled", "row": row }),
        None => json!({ "status": "too_large", "row": record.to_row() }),
    }))
}

/// `renewWriteClaim({ id, token, leaseMs, phaseJson })`: true when the request is still running
/// under `token`.
pub(crate) fn renew_write_claim_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    stamp: &ClaimStamp,
) -> Result<bool> {
    let token = uuid_param(&stamp.token, "token")?;
    let phase = jsonb_param(&stamp.phase_json, "phaseJson")?;
    let Some(mut record) = request_by_id(&*tx, &stamp.id)? else {
        return Ok(false);
    };
    let holds = record.state == "running"
        && record.extra.get("execution_token").and_then(Value::as_str) == Some(token.as_str());
    if !holds {
        return Ok(false);
    }
    let now = env.now_micros();
    record.updated_at_us = now;
    record.extra.insert(
        "claim_expires_at".into(),
        json!(iso(lease_end(now, stamp.lease_ms))),
    );
    if let Some(phase) = phase {
        record.extra.insert("claim_phase".into(), phase);
    }
    write_request(tx, &record)?;
    Ok(true)
}

/// `releaseUnpublishedClaim({ id, token, reason, charge })` (journal.ts).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRelease {
    pub id: String,
    #[serde(default)]
    pub token: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub charge: bool,
}

/// `RELEASE_CLAIM_SQL`: a request still `running` under `token`, with no recovery record, that
/// never began to publish goes back to `queued` with `reason` as its blocked reason. `charge`
/// counts one preparation attempt and keeps the claim phase; otherwise the phase is cleared.
/// Returns whether a request was released.
pub(crate) fn release_unpublished_claim_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    release: &ClaimRelease,
) -> Result<bool> {
    let Some(token) = release.token.as_deref() else {
        return Ok(false);
    };
    let token = uuid_param(token, "token")?;
    uuid_param(&release.id, "id")?;
    let Some(mut record) = request_by_id(&*tx, &release.id)? else {
        return Ok(false);
    };
    let holds = record.state == "running"
        && record.extra.get("execution_token").and_then(Value::as_str) == Some(token.as_str())
        && extra_is_null(&record, "recovery")
        && !extra_bool(&record, "publication_started");
    if !holds {
        return Ok(false);
    }
    record.state = "queued".into();
    record.extra.insert("execution_token".into(), Value::Null);
    record.extra.insert("claim_expires_at".into(), Value::Null);
    record.blocked_reason = Some(release.reason.clone());
    record.updated_at_us = env.now_micros();
    if release.charge {
        let attempts = extra_i64(&record, "preparation_attempts") + 1;
        record
            .extra
            .insert("preparation_attempts".into(), json!(attempts));
    } else {
        record.extra.insert("claim_phase".into(), Value::Null);
    }
    write_request(tx, &record)?;
    Ok(true)
}

/// `expireStaleWriteClaims({ hostId, charge, deadOwners })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpireClaims {
    pub host_id: String,
    #[serde(default)]
    pub charge: bool,
    #[serde(default)]
    pub dead_owners: Vec<String>,
}

/// How many claims `expire_stale_write_claims_in` releases at most (the statement's `LIMIT 100`).
const EXPIRE_BATCH: usize = 100;

/// The consumer's `expired_claims` statement: running claims with no recovery record that never
/// began to publish, whose lease ran out or whose stamped owner is in `deadOwners`, go back to
/// queued (at most 100, in sequence order). A claim that expired while preparing counts one
/// preparation attempt when `charge` is set. Returns how many claims were released.
pub(crate) fn expire_stale_write_claims_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    spec: &ExpireClaims,
) -> Result<u64> {
    let host = uuid_param(&spec.host_id, "hostId")?;
    let now = env.now_micros();
    let mut owned = Vec::new();
    for r in all_requests(&*tx)? {
        // `r.worktree_id IS NULL OR EXISTS (... w.owner_host_id=$1::uuid)`.
        let mine = match write_claim_terms::worktree_of(&r) {
            None => true,
            Some(w) => worktree_rows::read_worktree_row(&*tx, &w)?
                .is_some_and(|row| row.owned_by(Some(&host))),
        };
        if mine {
            owned.push(r);
        }
    }
    let mut candidates: Vec<RequestRecord> = owned
        .into_iter()
        .filter(|r| {
            if r.state != "running"
                || !extra_is_null(r, "recovery")
                || extra_bool(r, "publication_started")
            {
                return false;
            }
            let expired = extra_time(r, "claim_expires_at").map(|t| t < now);
            let phase = r.extra.get("claim_phase");
            let token = json_text(r.extra.get("execution_token"));
            let phase_token = json_text(phase.and_then(|p| p.get("token")));
            let same_token = match (&phase_token, &token) {
                (Some(a), Some(b)) => Some(a == b),
                _ => None,
            };
            let owner = phase.and_then(|p| p.get("owner"));
            let parts: Vec<String> = ["pid", "nonce", "start"]
                .iter()
                .filter_map(|k| json_text(owner.and_then(|o| o.get(*k))))
                .collect();
            let dead = Some(spec.dead_owners.contains(&parts.join(":")));
            or3(expired, and3(same_token, dead)) == Some(true)
        })
        .collect();
    candidates.sort_by_key(|r| r.sequence);
    candidates.truncate(EXPIRE_BATCH);
    let released = candidates.len() as u64;
    for mut r in candidates {
        let phase = r.extra.get("claim_phase");
        let preparing = json_text(phase.and_then(|p| p.get("phase"))).as_deref()
            == Some("preparing")
            && json_text(phase.and_then(|p| p.get("token")))
                == json_text(r.extra.get("execution_token"));
        if spec.charge && preparing {
            let attempts = extra_i64(&r, "preparation_attempts") + 1;
            r.extra
                .insert("preparation_attempts".into(), json!(attempts));
        }
        r.state = "queued".into();
        r.extra.insert("execution_token".into(), Value::Null);
        r.extra.insert("claim_expires_at".into(), Value::Null);
        write_request(tx, &r)?;
    }
    Ok(released)
}

/// `selectClaimableWrite` / `hasClaimableWrite`: what the claim statement reads. `priority` is the
/// `foreground_priority` switch as the environment set it, or `None` to read the config row.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClaimableSpec {
    /// `$1`: the consumer's host id (a uuid), which selects the worktree rows it may claim.
    pub host_id: Option<String>,
    pub exclude_roots: Vec<String>,
    pub fifo_roots: Vec<String>,
    pub lane_roots: Vec<String>,
    /// `$5` and `$6`: the consumer nonce and per-worktree sync-seen sequences of the `waiting`
    /// term, which matches worktree rows only (`g.worktree_id=r.worktree_id`).
    pub nonce: Option<String>,
    pub sync_seen: Map<String, Value>,
    pub priority: Option<bool>,
    /// `CLAIM_HEAD_LEASE_HELD` ($7-$9): a non-resident consumer ranks a managed-sync row whose
    /// source's drain lease another live process holds after every other row. `None` for a
    /// resident consumer.
    pub lease_holder: Option<LeaseHolder>,
}

/// The lock a non-resident consumer checks before it takes a managed-sync row.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseHolder {
    pub lock_prefix: String,
    pub pid: f64,
    pub host: String,
}

impl ClaimableSpec {
    /// The parameters Postgres casts before it reads a row: `$1::uuid` and `$8::integer`.
    fn check(&self) -> Result<()> {
        if let Some(host) = &self.host_id {
            effect_scans::host_uuid(host)?;
        }
        if let Some(h) = &self.lease_holder
            && (h.pid.fract() != 0.0 || h.pid < f64::from(i32::MIN) || h.pid > f64::from(i32::MAX))
        {
            return Err(StoreError::invalid(format!(
                "invalid input syntax for type integer: \"{}\"",
                h.pid
            )));
        }
        Ok(())
    }

    /// Whether sync row `r`'s drain lease is held by a process other than this consumer.
    fn lease_held(&self, read: &dyn KvRead, r: &RequestRecord, now: i64) -> Result<bool> {
        let Some(h) = self.lease_holder.as_ref().filter(|_| sync_kind(&r.intent)) else {
            return Ok(false);
        };
        let id = format!("{}{}", h.lock_prefix, r.source_id);
        crate::jobs::lock_held_by_other(read, &id, h.pid as i64, &h.host, now)
    }
}

fn foreground_priority(read: &dyn KvRead, given: Option<bool>) -> Result<bool> {
    if let Some(on) = given {
        return Ok(on);
    }
    let value = read_config(read, FOREGROUND_PRIORITY_KEY)?;
    Ok(!matches!(
        value.map(|v| v.trim_matches(' ').to_lowercase()).as_deref(),
        Some("0") | Some("false")
    ))
}

/// `NAMES_PAGE(sync, write)`.
fn names_page(sync: &RequestRecord, write: &RequestRecord) -> Option<bool> {
    let same_source = Some(sync.source_id == write.source_id);
    let slug = Some(sync.slug == write.slug);
    let page = match (sync.page_id, write.page_id) {
        (Some(a), Some(b)) => Some(a == b),
        _ => None,
    };
    let renamed = json_text(sync.intent.get("renameFrom").and_then(|r| r.get("slug")))
        .map(|s| s == write.slug);
    and3(same_source, or3(or3(slug, page), renamed))
}

/// `PASSES_QUEUED_SYNC(earlier, r, priority, laneRoots)`.
fn passes_queued_sync(
    earlier: &RequestRecord,
    r: &RequestRecord,
    priority: bool,
    lane_roots: &[String],
) -> Option<bool> {
    let lane_running = if earlier.state == "running" && earlier.intent.get("lane").is_some() {
        match write_claim_terms::worktree_of(earlier) {
            Some(w) => Some(lane_roots.contains(&w)),
            // `NULL::text = ANY(laneRoots)`: false over an empty array, otherwise NULL.
            None if lane_roots.is_empty() => Some(false),
            None => None,
        }
    } else {
        Some(false)
    };
    let state_ok = or3(Some(earlier.state == "queued"), lane_running);
    let mut out = and3(Some(priority), Some(!sync_kind(&r.intent)));
    out = and3(out, state_ok);
    out = and3(out, Some(extra_is_null(earlier, "recovery")));
    out = and3(out, Some(sync_kind(&earlier.intent)));
    and3(out, not3(names_page(earlier, r)))
}

/// `COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)`: the root a claim skips by.
fn root_key(r: &RequestRecord) -> String {
    write_claim_terms::worktree_of(r).unwrap_or_else(|| format!("db:{}", r.source_incarnation))
}

/// `claimableWriteSql(priority, laneRoots)`. `r` is a candidate (`candidates`): queued, or a
/// released deferred row. A row with a null worktree is ordered by its source incarnation's
/// pending rows; a row on a worktree by that worktree's terms (`write_claim_terms.rs`).
fn claimable(
    r: &RequestRecord,
    pending: &[&RequestRecord],
    worktrees: &write_claim_terms::WorktreeClaims<'_>,
    priority: bool,
    spec: &ClaimableSpec,
    lane_roots: &[String],
    now: i64,
) -> Result<bool> {
    if spec.exclude_roots.contains(&root_key(r)) {
        return Ok(false);
    }
    if extra_time(r, "next_attempt_at").is_some_and(|t| t > now) {
        return Ok(false);
    }
    if let Some(w) = write_claim_terms::worktree_of(r) {
        return worktrees.claimable(r, &w, spec, priority, lane_roots);
    }
    Ok(!pending.iter().any(|e| {
        e.sequence < r.sequence
            && e.source_incarnation == r.source_incarnation
            && extra_is_null(e, "worktree_id")
            && passes_queued_sync(e, r, priority, lane_roots) == Some(false)
    }))
}

/// The pending rows a null-worktree candidate is ordered behind.
fn pending(all: &[RequestRecord]) -> Vec<&RequestRecord> {
    all.iter()
        .filter(|r| {
            matches!(r.state.as_str(), "queued" | "running" | "recovering")
                && extra_is_null(r, "worktree_id")
        })
        .collect()
}

/// The rows the claim may take: `r.state='queued' OR RELEASED_DEFERRED('r')`.
fn candidates<'a>(read: &dyn KvRead, all: &'a [RequestRecord]) -> Result<Vec<&'a RequestRecord>> {
    let mut out = Vec::new();
    for r in all {
        if r.state == "queued" || worktree_admission::released_deferred_in(read, r)? {
            out.push(r);
        }
    }
    Ok(out)
}

/// `hasClaimableWrite`: whether `selectClaimableWrite` would find a row, with the plain switch
/// and no lane roots.
pub(crate) fn has_claimable_write_in(
    read: &dyn KvRead,
    env: &dyn Env,
    spec: &ClaimableSpec,
) -> Result<bool> {
    spec.check()?;
    let priority = foreground_priority(read, spec.priority)?;
    let all = all_requests(read)?;
    let pending = pending(&all);
    let worktrees = write_claim_terms::WorktreeClaims::new(read, &all)?;
    let now = env.now_micros();
    for r in candidates(read, &all)? {
        if claimable(r, &pending, &worktrees, priority, spec, &[], now)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `selectClaimableWrite`: the row `claimNextWrite` claims next, or `None`. `first` is the switch
/// unless the row's root is in `fifoRoots`. On a root in `laneRoots` only a foreground write is
/// claimed; a null worktree compares as NULL there, so with any lane root a sync row or a row that
/// does not go first is skipped. A sync row that would go first waits while its worktree's
/// `waiting` foreground write is newer (`write_claim_terms.rs`). The order: a sync row whose
/// drain lease another process holds last, then a claimable foreground row before the sync rows
/// it passes, then sequence order.
pub(crate) fn select_claimable_write_in(
    read: &dyn KvRead,
    env: &dyn Env,
    spec: &ClaimableSpec,
) -> Result<Option<Value>> {
    spec.check()?;
    let priority = foreground_priority(read, spec.priority)?;
    let all = all_requests(read)?;
    let pending = pending(&all);
    let worktrees = write_claim_terms::WorktreeClaims::new(read, &all)?;
    let now = env.now_micros();
    // `free` and `ahead` rank higher when true.
    let mut best: Option<((bool, bool), &RequestRecord)> = None;
    for r in candidates(read, &all)? {
        let first = priority && !spec.fifo_roots.contains(&root_key(r));
        let sync = sync_kind(&r.intent);
        let worktree = write_claim_terms::worktree_of(r);
        let on_lane = match &worktree {
            Some(w) => spec.lane_roots.contains(w),
            None => !spec.lane_roots.is_empty(),
        };
        if on_lane && (sync || !first) {
            continue;
        }
        if !claimable(r, &pending, &worktrees, first, spec, &spec.lane_roots, now)? {
            continue;
        }
        if let Some(w) = &worktree
            && sync
            && first
            && worktrees.waits(w, r.sequence, spec)?
        {
            continue;
        }
        let rank = (!spec.lease_held(read, r, now)?, first && !sync);
        let better = match best {
            None => true,
            Some((b_rank, b)) => {
                (rank, std::cmp::Reverse(r.sequence)) > (b_rank, std::cmp::Reverse(b.sequence))
            }
        };
        if better {
            best = Some((rank, r));
        }
    }
    Ok(best.map(|(_, r)| r.to_row()))
}

impl Store {
    /// `lockPersistenceCounters(keys)`: the counter rows, created at zero when missing.
    pub fn lock_persistence_counters(&self, names: &[String]) -> Result<Vec<Value>> {
        self.write(|tx| lock_persistence_counters_in(tx, names))
    }

    /// `readWriteRequest(principalKind, principalId, requestId)`: the request row or `None`.
    pub fn read_write_request(
        &self,
        principal: &Principal,
        request_id: &str,
    ) -> Result<Option<Value>> {
        let request_id = uuid_param(request_id, "requestId")?;
        let read = self.read()?;
        Ok(read_request(&*read, principal, &request_id)?.map(|r| r.to_row()))
    }

    /// `readWriteRequestsByRequestId(requestId)`: at most two request rows with this request id,
    /// from any principal, in key order. The trusted local CLI answers a receipt by request id
    /// alone only when exactly one row has it, so two rows is enough to know it is ambiguous.
    pub fn read_write_requests_by_request_id(&self, request_id: &str) -> Result<Vec<Value>> {
        let request_id = uuid_param(request_id, "requestId")?;
        Ok(all_requests(&*self.read()?)?
            .into_iter()
            .filter(|r| r.request_id == request_id)
            .take(2)
            .map(|r| r.to_row())
            .collect())
    }

    /// `listWriteRequestsByRequestId(requestId)`: every request admitted under `requestId`, whichever
    /// principal admitted it, in key order (the SQL names no order).
    pub fn list_write_requests_by_request_id(&self, request_id: &str) -> Result<Vec<Value>> {
        let request_id = uuid_param(request_id, "requestId")?;
        Ok(all_requests(&*self.read()?)?
            .into_iter()
            .filter(|r| r.request_id == request_id)
            .map(|r| r.to_row())
            .collect())
    }

    /// `readWriteRequestById(id)` and `lockWriteRequest(id)`: the request row or `None`.
    pub fn read_write_request_by_id(&self, id: &str) -> Result<Option<Value>> {
        Ok(request_by_id(&*self.read()?, id)?.map(|r| r.to_row()))
    }

    /// `listWriteRequestsByRequestIds(requestIds)`: the request rows whose client request id is
    /// one of `request_ids`, by sequence. A malformed id refuses, as the SQL's `::uuid[]` cast does.
    pub fn list_write_requests_by_request_ids(&self, request_ids: &[String]) -> Result<Vec<Value>> {
        let mut wanted = std::collections::BTreeSet::new();
        for id in request_ids {
            wanted.insert(uuid_param(id, "requestIds")?);
        }
        let mut rows: Vec<RequestRecord> = all_requests(&*self.read()?)?
            .into_iter()
            .filter(|r| wanted.contains(&r.request_id.to_lowercase()))
            .collect();
        rows.sort_by_key(|r| r.sequence);
        Ok(rows.iter().map(RequestRecord::to_row).collect())
    }

    /// `insertWriteRequest(row)`: the stored request row.
    pub fn insert_write_request(&self, input: &WriteRequestInsert) -> Result<Value> {
        self.write(|tx| insert_write_request_in(tx, &*self.env, input))
    }

    /// `insertWriteRequestGroup(rows)`: the stored rows in item order, all inserted in one store
    /// write. A refusal at any row drops the whole write, so no row and no counter charge is kept.
    pub fn insert_write_request_group(&self, inputs: &[WriteRequestInsert]) -> Result<Value> {
        self.write(|tx| {
            inputs
                .iter()
                .map(|input| insert_write_request_in(tx, &*self.env, input))
                .collect::<Result<Vec<_>>>()
                .map(Value::Array)
        })
    }

    /// `stampWriteClaim(id, token, leaseMs, phaseJson)`: the claimed row or `None`.
    pub fn stamp_write_claim(&self, stamp: &ClaimStamp) -> Result<Option<Value>> {
        self.write(|tx| stamp_write_claim_in(tx, &*self.env, stamp))
    }

    /// `completeWriteRow(completion)`: the completed row, or `None` when it does not fit.
    pub fn complete_write_row(&self, completion: &WriteCompletion) -> Result<Option<Value>> {
        self.write(|tx| complete_write_row_in(tx, &*self.env, completion))
    }

    /// `compactTerminalIntent(compaction)`: the compacted row, or `None` for an unknown id.
    pub fn compact_terminal_intent(
        &self,
        compaction: &TerminalIntentCompaction,
    ) -> Result<Option<Value>> {
        self.write(|tx| compact_terminal_intent_in(tx, compaction))
    }

    /// `cancelWriteRow(cancellation)`: `{ status, row }`, or `None` when the row does not exist.
    pub fn cancel_write_row(&self, cancellation: &WriteCancellation) -> Result<Option<Value>> {
        self.write(|tx| cancel_write_row_in(tx, &*self.env, cancellation))
    }

    /// `renewWriteClaim(id, token, leaseMs, phaseJson)`.
    pub fn renew_write_claim(&self, stamp: &ClaimStamp) -> Result<bool> {
        self.write(|tx| renew_write_claim_in(tx, &*self.env, stamp))
    }

    /// `releaseUnpublishedClaim({ id, token, reason, charge })`: whether the claim was released.
    pub fn release_unpublished_claim(&self, release: &ClaimRelease) -> Result<bool> {
        self.write(|tx| release_unpublished_claim_in(tx, &*self.env, release))
    }

    /// `expireStaleWriteClaims({ hostId, charge, deadOwners })`: how many claims were released.
    pub fn expire_stale_write_claims(&self, spec: &ExpireClaims) -> Result<u64> {
        self.write(|tx| expire_stale_write_claims_in(tx, &*self.env, spec))
    }

    /// `hasClaimableWrite(spec)`.
    pub fn has_claimable_write(&self, spec: &ClaimableSpec) -> Result<bool> {
        has_claimable_write_in(&*self.read()?, &*self.env, spec)
    }

    /// `selectClaimableWrite(spec)`: the row `claimNextWrite` claims next, or `None`; the claim's
    /// stamp is `stamp_write_claim`.
    pub fn select_claimable_write(&self, spec: &ClaimableSpec) -> Result<Option<Value>> {
        select_claimable_write_in(&*self.read()?, &*self.env, spec)
    }

    /// `countOutstandingBySource(principalKind, principalId)`: `[{ source_id, n }]`, one row per source
    /// holding requests of the principal that are queued, deferred, running or recovering. The most
    /// requests come first; a tie is in byte order of the source id (Postgres `COLLATE "C"`).
    pub fn count_outstanding_by_source(
        &self,
        principal_kind: &str,
        principal_id: &str,
    ) -> Result<Vec<Value>> {
        count_outstanding_by_source_in(&*self.read()?, principal_kind, principal_id)
    }

    /// `readWriteWatermarkRow`'s journal half: `{ pending_min, pending_count, pending_since,
    /// newest_sequence }` of one source incarnation (`None` for an absent source).
    pub fn read_request_watermark(
        &self,
        source_id: &str,
        incarnation: Option<&str>,
    ) -> Result<Value> {
        read_request_watermark_in(&*self.read()?, source_id, incarnation)
    }

    /// `readCounterRows(keys)`: the counter rows that exist, in byte order (`COLLATE "C"`), unlocked.
    pub fn read_counter_rows(&self, names: &[String]) -> Result<Vec<Value>> {
        read_counter_rows_in(&*self.read()?, names)
    }

    /// `readAdmissionRate(principal)`: `{ first_request_id, admissions, age_seconds, gross, net }`
    /// over the latest 1,000 requests of the principal (or of the brain when `None`).
    pub fn read_admission_rate(&self, principal: Option<(&str, &str)>) -> Result<Value> {
        read_admission_rate_in(&*self.read()?, self.env.now_micros(), principal)
    }

    /// `readSourceMembership(sourceId)`: `{ incarnation, archived }` or `None`.
    pub fn read_source_membership(&self, source_id: &str) -> Result<Option<Value>> {
        Ok(self
            .read_source_state(source_id)?
            .map(|s| json!({ "incarnation": s.incarnation, "archived": s.archived })))
    }
}
