//! Orphan connector checkpoints: the statements `listOrphanConnectorCheckpoints`,
//! `countConnectorCheckpointsKeyed` and `deleteOrphanConnectorCheckpoint` of
//! `src/core/engine-sql/repair-bookkeeping.ts` (rust/docs/store/repair-bookkeeping.md).
//!
//! A connector checkpoint is an `op_checkpoints` parent (`op_checkpoint.rs`) of op
//! `managed-connector` (keyed by its fingerprint) or `managed-connector-retry` (keyed by
//! `completed_keys[0].checkpointKey`). It is an orphan when:
//!
//! - its key is not one the caller can load (`loadable`);
//! - no pending connector request names it: a request that is outstanding or in recovery, whose
//!   `intent.kind` is `connector_v2_*` or `managed_connector_*`, and whose
//!   `intent.checkpointKey` is the fingerprint or the row's `checkpointKey`, or whose request id is
//!   the row's `completed_keys[0].requestId`;
//! - no request of any state that a `stateOp` row lists in `completed_keys[0].pending[]` (by
//!   `requestId`) names it the same way;
//! - it is not newer than `before`, and older than `min_age_days` days when that is given.
//!
//! Each comparison is SQL text equality, so a JSON null never matches. Postgres orders by its
//! database collation; the store orders by bytes. Postgres raises an error when a `stateOp` row's
//! `pending` is present and not an array (`jsonb_array_elements` of a scalar); the store reads such
//! a value as no pending requests.

use super::housekeeping::HousekeepingRow;
use super::op_checkpoint::delete_op_checkpoint_in;
use super::projection_queue::parse_timestamptz;
use super::{OUTSTANDING_STATES, all_requests, extra_is_null, json_text};
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::telemetry::pg_timestamptz_text;
use crate::{Store, keys};
use serde_json::{Value, json};
use std::collections::HashSet;

const CHECKPOINT_OP: &str = "managed-connector";
const RETRY_OP: &str = "managed-connector-retry";

/// The bounds of a scan or delete, as `OrphanCheckpointBounds` names them.
pub struct OrphanBounds<'a> {
    pub before: Option<&'a str>,
    pub min_age_days: Option<i64>,
    pub state_op: &'a str,
}

struct Checkpoint {
    op: &'static str,
    fingerprint: String,
    row: HousekeepingRow,
}

impl Checkpoint {
    /// `c.completed_keys->0->>'<field>'`.
    fn first(&self, field: &str) -> Option<String> {
        json_text(self.row.completed_keys.get(0).and_then(|v| v.get(field)))
    }

    /// The key `loadable` must hold: the fingerprint, or the retry row's `checkpointKey` ('' when
    /// absent, as `COALESCE` reads it).
    fn key(&self) -> String {
        if self.op == CHECKPOINT_OP {
            self.fingerprint.clone()
        } else {
            self.first("checkpointKey").unwrap_or_default()
        }
    }

    /// Whether a request names this row: its `checkpointKey` is the fingerprint or the row's
    /// `checkpointKey`, or its id is the row's `requestId`.
    fn named_by(&self, r: &RequestRecord) -> bool {
        let wanted = json_text(r.intent.get("checkpointKey"));
        let row_key = self.first("checkpointKey");
        wanted
            .as_deref()
            .is_some_and(|k| k == self.fingerprint || row_key.as_deref() == Some(k))
            || self.first("requestId").as_deref() == Some(r.request_id.as_str())
    }
}

fn scan_op(read: &dyn KvRead, op: &'static str) -> Result<Vec<Checkpoint>> {
    let mut prefix = vec![keys::PERSISTENCE, super::HOUSEKEEPING];
    prefix.extend_from_slice(op.as_bytes());
    prefix.push(0);
    let mut out = Vec::new();
    let mut bad = false;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        let fingerprint = std::str::from_utf8(&k[prefix.len()..]).map(str::to_owned);
        match (fingerprint, serde_json::from_slice::<HousekeepingRow>(v)) {
            (Ok(fingerprint), Ok(row)) => out.push(Checkpoint {
                op,
                fingerprint,
                row,
            }),
            _ => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            "an op checkpoint row is not readable",
        ));
    }
    Ok(out)
}

/// What the orphan test reads once per statement: the requests and the `stateOp` pending ids.
struct Context {
    pending: Vec<RequestRecord>,
    listed: Vec<RequestRecord>,
    before_us: Option<i64>,
    age_floor_us: Option<i64>,
    loadable: HashSet<String>,
}

fn context(
    read: &dyn KvRead,
    env: &dyn Env,
    loadable: &[String],
    bounds: &OrphanBounds,
) -> Result<Context> {
    let before_us = bounds
        .before
        .map(|b| parse_timestamptz(b, "before"))
        .transpose()?;
    let age_floor_us = bounds.min_age_days.map(|d| {
        env.now_micros()
            .saturating_sub(d.saturating_mul(86_400_000_000))
    });
    let mut listed_ids = HashSet::new();
    for state in scan_state_op(read, bounds.state_op)? {
        if let Some(Value::Array(items)) =
            state.completed_keys.get(0).and_then(|v| v.get("pending"))
        {
            listed_ids.extend(items.iter().filter_map(|p| json_text(p.get("requestId"))));
        }
    }
    let mut pending = Vec::new();
    let mut listed = Vec::new();
    for r in all_requests(read)? {
        // `LIKE 'connector\_v2\_%'`: the underscores are escaped, so each is itself.
        let kind = json_text(r.intent.get("kind"));
        let connector = kind
            .as_deref()
            .is_some_and(|k| k.starts_with("connector_v2_") || k.starts_with("managed_connector_"));
        if listed_ids.contains(&r.request_id) {
            // Listed requests count in any state, so a pending one needs no second check.
            listed.push(r);
        } else if connector
            && (OUTSTANDING_STATES.contains(&r.state.as_str()) || !extra_is_null(&r, "recovery"))
        {
            pending.push(r);
        }
    }
    Ok(Context {
        pending,
        listed,
        before_us,
        age_floor_us,
        loadable: loadable.iter().cloned().collect(),
    })
}

/// The `stateOp` rows (any fingerprint), whose `completed_keys[0].pending` lists request ids.
fn scan_state_op(read: &dyn KvRead, op: &str) -> Result<Vec<HousekeepingRow>> {
    if op.contains('\0') {
        return Err(StoreError::invalid(
            "an op checkpoint op cannot contain NUL",
        ));
    }
    let mut prefix = vec![keys::PERSISTENCE, super::HOUSEKEEPING];
    prefix.extend_from_slice(op.as_bytes());
    prefix.push(0);
    let mut out = Vec::new();
    let mut bad = false;
    scan_prefix(read, &prefix, false, &mut |_, v| {
        match serde_json::from_slice::<HousekeepingRow>(v) {
            Ok(row) => out.push(row),
            Err(_) => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            "an op checkpoint row is not readable",
        ));
    }
    Ok(out)
}

fn is_orphan(c: &Checkpoint, ctx: &Context) -> bool {
    !ctx.loadable.contains(&c.key())
        && !ctx.pending.iter().any(|r| c.named_by(r))
        && !ctx.listed.iter().any(|r| c.named_by(r))
        && ctx.before_us.is_none_or(|b| c.row.updated_at_us <= b)
        && ctx.age_floor_us.is_none_or(|f| c.row.updated_at_us < f)
}

pub(crate) fn list_orphan_connector_checkpoints_in(
    read: &dyn KvRead,
    env: &dyn Env,
    loadable: &[String],
    bounds: &OrphanBounds,
    limit: i64,
) -> Result<Vec<Value>> {
    let ctx = context(read, env, loadable, bounds)?;
    let mut rows = scan_op(read, CHECKPOINT_OP)?;
    rows.extend(scan_op(read, RETRY_OP)?);
    let limit = usize::try_from(limit.max(0)).unwrap_or(usize::MAX);
    Ok(rows
        .iter()
        .filter(|c| is_orphan(c, &ctx))
        .take(limit)
        .map(|c| {
            json!({
                "op": c.op,
                "fingerprint": c.fingerprint,
                "updated_at": pg_timestamptz_text(c.row.updated_at_us),
            })
        })
        .collect())
}

/// `countConnectorCheckpointsKeyed(keys)`: the checkpoint rows whose fingerprint, and the retry rows
/// whose `checkpointKey`, is one of the keys.
pub(crate) fn count_connector_checkpoints_keyed_in(
    read: &dyn KvRead,
    keys: &[String],
) -> Result<i64> {
    let keys: HashSet<&str> = keys.iter().map(String::as_str).collect();
    let mut n = 0;
    for c in scan_op(read, CHECKPOINT_OP)? {
        n += i64::from(keys.contains(c.fingerprint.as_str()));
    }
    for c in scan_op(read, RETRY_OP)? {
        n += i64::from(
            c.first("checkpointKey")
                .is_some_and(|k| keys.contains(k.as_str())),
        );
    }
    Ok(n)
}

/// `deleteOrphanConnectorCheckpoint(row, loadable, bounds)`: deletes the row (and its paths) when
/// its stamp is still `updated_at` and it is still an orphan; true when deleted.
pub(crate) fn delete_orphan_connector_checkpoint_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    op: &str,
    fingerprint: &str,
    updated_at: &str,
    loadable: &[String],
    bounds: &OrphanBounds,
) -> Result<bool> {
    let op: &'static str = match op {
        CHECKPOINT_OP => CHECKPOINT_OP,
        RETRY_OP => RETRY_OP,
        // `WHERE c.op=$1 AND c.op IN (..)`: another op matches no row.
        _ => return Ok(false),
    };
    let stamp = parse_timestamptz(updated_at, "updated_at")?;
    let ctx = context(&*tx, env, loadable, bounds)?;
    let Some(c) = scan_op(&*tx, op)?
        .into_iter()
        .find(|c| c.fingerprint == fingerprint)
    else {
        return Ok(false);
    };
    if c.row.updated_at_us != stamp || !is_orphan(&c, &ctx) {
        return Ok(false);
    }
    delete_op_checkpoint_in(tx, op, fingerprint)?;
    Ok(true)
}

impl Store {
    /// `listOrphanConnectorCheckpoints(loadable, bounds, limit)`.
    pub fn list_orphan_connector_checkpoints(
        &self,
        loadable: &[String],
        bounds: &OrphanBounds,
        limit: i64,
    ) -> Result<Vec<Value>> {
        list_orphan_connector_checkpoints_in(&*self.read()?, &*self.env, loadable, bounds, limit)
    }

    /// `countConnectorCheckpointsKeyed(keys)`.
    pub fn count_connector_checkpoints_keyed(&self, keys: &[String]) -> Result<i64> {
        count_connector_checkpoints_keyed_in(&*self.read()?, keys)
    }

    /// `deleteOrphanConnectorCheckpoint(row, loadable, bounds)`.
    pub fn delete_orphan_connector_checkpoint(
        &self,
        op: &str,
        fingerprint: &str,
        updated_at: &str,
        loadable: &[String],
        bounds: &OrphanBounds,
    ) -> Result<bool> {
        self.write(|tx| {
            delete_orphan_connector_checkpoint_in(
                tx,
                &*self.env,
                op,
                fingerprint,
                updated_at,
                loadable,
                bounds,
            )
        })
    }
}
