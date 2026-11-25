//! The publication journal: the request-row reads and writes a bound (worktree) publication makes
//! around its files, served for `publicationJournalStore()` (`src/core/engine-sql/publication-journal.ts`).
//!
//! A bound write records its recovery record and reserves its recovery bytes before it renames a
//! file (`prepareRecovery`), stamps `publication_started` on its row, moves to `recovering` when the
//! publication refuses (`markRecovering`), and its recovery then blocks, requeues or finishes the
//! request and releases the bytes (`recoverPublication`, `clearResolvedRecovery`). The reads are the
//! import hold of an earlier write to the same page, the recovery blocker of a worktree, the owner's
//! checkout root and one row's recovery record.
//!
//! Each member answers the statement it replaces: the conditions of a conditional `UPDATE` decide
//! whether anything changes, and a counter `UPDATE` changes only the rows that exist (the CHECK
//! (`>= 0`) refuses a release below zero). Row locks are no-ops (Decision C, `persistence.rs`).
//! What each member answers and why: rust/docs/store/persistence.md ("Publication journal").

use super::effects::{all_effects, effect_by_id, write_effect};
use super::worktrees::{host_binding_in, worktree_owner_in};
use super::{
    all_requests, distinct_keys, extra_is_null, read_counter, request_by_id, uuid_param,
    write_counter,
};
use crate::Store;
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::fence;
use crate::journal::{RequestRecord, write_request};
use crate::kv::{KvRead, KvWrite};
use crate::leases::LeaseToken;
use crate::sources::read_source;
use serde::Deserialize;
use serde_json::{Value, json};

/// The states a request ends in (`isTerminal`).
const TERMINAL: &[&str] = &["committed", "conflict", "failed", "cancelled"];

/// The table one recovery-staging read or write names.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
pub enum RecoveryTable {
    #[serde(rename = "persistence_requests")]
    Requests,
    #[serde(rename = "persistence_effects")]
    Effects,
}

/// One read of `publicationJournalStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PublicationRead {
    /// The import an earlier deferred write to the same page waits on, when that import has not
    /// landed (`sources.last_commit` is still the commit it deferred from): its commit, or null.
    HeldBehindImport {
        #[serde(rename = "sourceId")]
        source_id: String,
        slug: String,
        sequence: Value,
    },
    /// Whether another request on the worktree, or an effect on it, holds a recovery record.
    RecoveryBlocker {
        #[serde(rename = "worktreeId")]
        worktree_id: String,
        #[serde(rename = "excludeId")]
        exclude_id: String,
    },
    /// The checkout root of the worktree's owner host, or null when it has none.
    OwnerPath {
        #[serde(rename = "worktreeId")]
        worktree_id: String,
    },
    /// One row's `{ recovery, recovery_bytes, source_id }`, or null when the row is missing.
    RecoveryStaging { table: RecoveryTable, id: Value },
}

/// One write of `publicationJournalStore()`, named by `kind`.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PublicationWrite {
    /// Records the recovery and adds `bytes` to the named counters. `checked`: only a request still
    /// running under the token with no recovery record (the fast path); otherwise by id and token.
    RecordRecovery {
        id: String,
        execution_token: Option<String>,
        recovery: Value,
        bytes: i64,
        keys: Vec<String>,
        checked: bool,
    },
    /// Clears a terminal request's recovery when it is still exactly `recovery`, releasing its bytes.
    ClearKnownRecovery {
        id: String,
        keys: Vec<String>,
        recovery: Value,
    },
    /// Clears the request's recovery and releases `bytes` from the named counters.
    ClearRecovery {
        id: String,
        keys: Vec<String>,
        bytes: i64,
    },
    /// A request still running or recovering under the token moves to `recovering`; the first
    /// failure is kept.
    MarkRecovering {
        id: String,
        execution_token: Option<String>,
        reason: String,
        #[serde(default)]
        error_code: Option<String>,
        #[serde(default)]
        error_message: Option<String>,
        #[serde(default)]
        error_detail: Option<Value>,
    },
    PublicationStarted {
        id: String,
    },
    /// A running or recovering request with a recovery record waits for a publication slot.
    BlockCapacity {
        id: String,
    },
    /// A live request moves to `recovering` (a terminal one keeps its state) with `reason`.
    BlockRecovery {
        id: String,
        reason: String,
    },
    /// The recovered request goes back to `queued` without its claim and recovery record.
    RequeueRecovered {
        id: String,
        #[serde(default)]
        kept: Option<Value>,
        clear_error: bool,
    },
    /// Replaces the row's recovery record and adds `extra` to its recovery bytes.
    GrowRecoveryStaging {
        table: RecoveryTable,
        id: Value,
        recovery: Value,
        extra: i64,
    },
}

fn same_uuid(v: Option<&Value>, id: &str) -> bool {
    v.and_then(Value::as_str)
        .is_some_and(|w| w.eq_ignore_ascii_case(id))
}

fn has_recovery(v: &Option<Value>) -> bool {
    v.as_ref().is_some_and(|v| !v.is_null())
}

/// A `bigint` parameter given as a number or its text.
fn bigint(v: &Value, what: &str) -> Result<i64> {
    match v {
        Value::Number(n) if n.is_i64() => Ok(n.as_i64().unwrap_or_default()),
        Value::String(s) => s
            .trim()
            .parse::<i64>()
            .map_err(|_| StoreError::invalid(format!("{what} is not an integer"))),
        _ => Err(StoreError::invalid(format!("{what} is not an integer"))),
    }
}

/// `UPDATE persistence_counters SET recovery_bytes=recovery_bytes+delta WHERE key=ANY(keys)`.
fn add_recovery_bytes(tx: &mut dyn KvWrite, keys: &[String], delta: i64) -> Result<()> {
    for key in distinct_keys(keys) {
        if let Some(mut counter) = read_counter(&*tx, &key)? {
            counter.recovery_bytes += delta;
            write_counter(tx, &key, &counter)?;
        }
    }
    Ok(())
}

/// The request under `id` when its token is `token` (`execution_token=$n::uuid`; a null token
/// matches nothing).
fn claimed(tx: &dyn KvRead, id: &str, token: &Option<String>) -> Result<Option<RequestRecord>> {
    let Some(token) = token.as_deref() else {
        return Ok(None);
    };
    let token = uuid_param(token, "executionToken")?;
    Ok(request_by_id(tx, id)?.filter(|r| same_uuid(r.extra.get("execution_token"), &token)))
}

fn set_recovery(record: &mut RequestRecord, recovery: Value, bytes: i64) {
    record.extra.insert("recovery".into(), recovery);
    record.extra.insert("recovery_bytes".into(), json!(bytes));
}

fn row_or_null(record: Option<RequestRecord>) -> Value {
    record.map_or(Value::Null, |r| r.to_row())
}

pub(crate) fn publication_journal_rows_in(
    read: &dyn KvRead,
    what: &PublicationRead,
) -> Result<Value> {
    Ok(match what {
        PublicationRead::HeldBehindImport {
            source_id,
            slug,
            sequence,
        } => {
            let before = bigint(sequence, "sequence")?;
            let Some(source) = read_source(read, source_id)? else {
                return Ok(Value::Null);
            };
            let landed = source.last_commit.unwrap_or_default();
            all_requests(read)?
                .into_iter()
                .filter(|r| {
                    r.source_id == *source_id
                        && r.slug == *slug
                        && (r.sequence as i64) < before
                        && r.state == "deferred"
                        && r.extra.get("deferred_import_from").and_then(Value::as_str)
                            == Some(landed.as_str())
                })
                .min_by_key(|r| r.sequence)
                .map_or(Value::Null, |r| r.extra["deferred_import_from"].clone())
        }
        PublicationRead::RecoveryBlocker {
            worktree_id,
            exclude_id,
        } => {
            let worktree = uuid_param(worktree_id, "worktreeId")?;
            let exclude = uuid_param(exclude_id, "excludeId")?;
            let request = all_requests(read)?.iter().any(|r| {
                same_uuid(r.extra.get("worktree_id"), &worktree)
                    && !r.id.eq_ignore_ascii_case(&exclude)
                    && !extra_is_null(r, "recovery")
            });
            let blocked = request
                || all_effects(read)?.iter().any(|e| {
                    e.worktree_id
                        .as_deref()
                        .is_some_and(|w| w.eq_ignore_ascii_case(&worktree))
                        && has_recovery(&e.recovery)
                });
            json!(blocked)
        }
        PublicationRead::OwnerPath { worktree_id } => {
            let owner = worktree_owner_in(read, worktree_id)?
                .and_then(|w| w["owner_host_id"].as_str().map(String::from));
            match owner {
                Some(host) => host_binding_in(read, worktree_id, &host)?
                    .map_or(Value::Null, |h| h["local_path"].clone()),
                None => Value::Null,
            }
        }
        PublicationRead::RecoveryStaging { table, id } => match table {
            RecoveryTable::Requests => {
                let id = id
                    .as_str()
                    .ok_or_else(|| StoreError::invalid("id is not a UUID"))?;
                request_by_id(read, id)?.map_or(Value::Null, |r| {
                    json!({
                        "recovery": r.extra.get("recovery").cloned().unwrap_or(Value::Null),
                        "recovery_bytes": r.extra.get("recovery_bytes").cloned().unwrap_or(json!(0)),
                        "source_id": r.source_id,
                    })
                })
            }
            RecoveryTable::Effects => {
                effect_by_id(read, bigint(id, "id")?)?.map_or(Value::Null, |e| {
                    json!({
                        "recovery": e.recovery,
                        "recovery_bytes": e.recovery_bytes,
                        "source_id": e.source_id,
                    })
                })
            }
        },
    })
}

pub(crate) fn publication_journal_write_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    what: &PublicationWrite,
) -> Result<Value> {
    let now = env.now_micros();
    Ok(match what {
        PublicationWrite::RecordRecovery {
            id,
            execution_token,
            recovery,
            bytes,
            keys,
            checked,
        } => {
            let Some(mut record) = claimed(&*tx, id, execution_token)? else {
                // The slow path's counter reservation runs whether or not the row matched.
                if !checked {
                    add_recovery_bytes(tx, keys, *bytes)?;
                }
                return Ok(json!(false));
            };
            if *checked && (record.state != "running" || !extra_is_null(&record, "recovery")) {
                return Ok(json!(false));
            }
            set_recovery(&mut record, recovery.clone(), *bytes);
            record.updated_at_us = now;
            write_request(tx, &record)?;
            add_recovery_bytes(tx, keys, *bytes)?;
            json!(true)
        }
        PublicationWrite::ClearKnownRecovery { id, keys, recovery } => {
            let Some(mut record) = request_by_id(&*tx, id)? else {
                return Ok(json!(false));
            };
            if record.extra.get("recovery") != Some(recovery)
                || !TERMINAL.contains(&record.state.as_str())
            {
                return Ok(json!(false));
            }
            let bytes = record
                .extra
                .get("recovery_bytes")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            add_recovery_bytes(tx, keys, -bytes)?;
            set_recovery(&mut record, Value::Null, 0);
            record.blocked_reason = None;
            write_request(tx, &record)?;
            json!(true)
        }
        PublicationWrite::ClearRecovery { id, keys, bytes } => {
            add_recovery_bytes(tx, keys, -*bytes)?;
            if let Some(mut record) = request_by_id(&*tx, id)? {
                set_recovery(&mut record, Value::Null, 0);
                record.blocked_reason = None;
                write_request(tx, &record)?;
            }
            Value::Null
        }
        PublicationWrite::MarkRecovering {
            id,
            execution_token,
            reason,
            error_code,
            error_message,
            error_detail,
        } => {
            let Some(mut record) = claimed(&*tx, id, execution_token)? else {
                return Ok(Value::Null);
            };
            if record.state != "running" && record.state != "recovering" {
                return Ok(Value::Null);
            }
            if record.error_code.is_none() {
                record.extra.insert(
                    "error_detail".into(),
                    error_detail.clone().unwrap_or(Value::Null),
                );
            }
            record.error_code = record.error_code.take().or_else(|| error_code.clone());
            record.error_message = record
                .error_message
                .take()
                .or_else(|| error_message.clone());
            record.state = "recovering".into();
            record.blocked_reason = Some(reason.clone());
            record.updated_at_us = now;
            write_request(tx, &record)?;
            Value::Null
        }
        PublicationWrite::PublicationStarted { id } => {
            let record = request_by_id(&*tx, id)?.map(|mut r| {
                r.extra.insert("publication_started".into(), json!(true));
                r
            });
            if let Some(r) = &record {
                write_request(tx, r)?;
            }
            row_or_null(record)
        }
        PublicationWrite::BlockCapacity { id } => {
            let record = request_by_id(&*tx, id)?.filter(|r| {
                !extra_is_null(r, "recovery") && (r.state == "running" || r.state == "recovering")
            });
            let record = record.map(|mut r| {
                r.blocked_reason = Some("writer_pool_capacity".into());
                r.updated_at_us = now;
                r
            });
            if let Some(r) = &record {
                write_request(tx, r)?;
            }
            row_or_null(record)
        }
        PublicationWrite::BlockRecovery { id, reason } => {
            let record = request_by_id(&*tx, id)?.map(|mut r| {
                if !TERMINAL.contains(&r.state.as_str()) {
                    r.state = "recovering".into();
                }
                r.blocked_reason = Some(reason.clone());
                r.updated_at_us = now;
                r
            });
            if let Some(r) = &record {
                write_request(tx, r)?;
            }
            row_or_null(record)
        }
        PublicationWrite::RequeueRecovered {
            id,
            kept,
            clear_error,
        } => {
            let record = request_by_id(&*tx, id)?.map(|mut r| {
                r.state = "queued".into();
                for column in ["execution_token", "claim_expires_at"] {
                    r.extra.insert(column.into(), Value::Null);
                }
                set_recovery(&mut r, Value::Null, 0);
                r.extra.insert("publication_started".into(), json!(false));
                r.blocked_reason = None;
                if let Some(kept) = kept.as_ref().filter(|k| !k.is_null()) {
                    r.outcome = Some(kept.clone());
                }
                if *clear_error {
                    r.error_code = None;
                    r.error_message = None;
                    r.extra.insert("error_detail".into(), Value::Null);
                }
                r.updated_at_us = now;
                r
            });
            if let Some(r) = &record {
                write_request(tx, r)?;
            }
            row_or_null(record)
        }
        PublicationWrite::GrowRecoveryStaging {
            table,
            id,
            recovery,
            extra,
        } => {
            match table {
                RecoveryTable::Requests => {
                    let id = id
                        .as_str()
                        .ok_or_else(|| StoreError::invalid("id is not a UUID"))?;
                    if let Some(mut r) = request_by_id(&*tx, id)? {
                        let bytes = r
                            .extra
                            .get("recovery_bytes")
                            .and_then(Value::as_i64)
                            .unwrap_or(0);
                        set_recovery(&mut r, recovery.clone(), bytes + extra);
                        write_request(tx, &r)?;
                    }
                }
                RecoveryTable::Effects => {
                    if let Some(mut e) = effect_by_id(&*tx, bigint(id, "id")?)? {
                        e.recovery = Some(recovery.clone());
                        e.recovery_bytes += extra;
                        write_effect(tx, &e)?;
                    }
                }
            }
            Value::Null
        }
    })
}

/// The request a claimant's own publication step names (see `publication_journal_write_fenced`).
fn claimant_step(what: &PublicationWrite) -> Option<&str> {
    match what {
        PublicationWrite::RecordRecovery { id, .. }
        | PublicationWrite::MarkRecovering { id, .. }
        | PublicationWrite::PublicationStarted { id } => Some(id.as_str()),
        _ => None,
    }
}

impl Store {
    /// One `publicationJournalStore()` read (`PublicationRead`) as JSON.
    pub fn publication_journal_rows(&self, what: &PublicationRead) -> Result<Value> {
        publication_journal_rows_in(&*self.read()?, what)
    }

    /// One `publicationJournalStore()` write (`PublicationWrite`); its result as JSON.
    pub fn publication_journal_write(&self, what: &PublicationWrite) -> Result<Value> {
        self.publication_journal_write_fenced(what, None)
    }

    /// `publication_journal_write` under the caller's host fence. The claimant's own steps (`RecordRecovery`,
    /// `MarkRecovering`, `PublicationStarted`) run only while the host's lease is held and only on a claim taken
    /// under the fence's epoch (`lease_lost` otherwise, nothing written). The other steps (recovery bookkeeping that
    /// any consumer may run on a request it does not hold) are not gated.
    pub fn publication_journal_write_fenced(
        &self,
        what: &PublicationWrite,
        fence: Option<&LeaseToken>,
    ) -> Result<Value> {
        self.write(|tx| {
            if let Some(id) = claimant_step(what) {
                fence::begin(self, tx, fence, "publication_journal_write")?;
                if fence.is_some() {
                    super::held_claim_of(tx, id, fence)?;
                }
            }
            publication_journal_write_in(tx, &*self.env, what)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    const WORKTREE: &str = "e0000000-0000-4000-8000-0000000000e1";
    const REQ: &str = "b0000000-0000-4000-8000-0000000000b1";
    const OTHER: &str = "b0000000-0000-4000-8000-0000000000b2";
    const TOKEN: &str = "f0000000-0000-4000-8000-000000000001";

    fn record(id: &str, state: &str, extra: Value) -> RequestRecord {
        let mut row = json!({
            "id": id, "principal_kind": "local_cli", "principal_id": "w", "request_id": id,
            "operation": "put_page", "source_id": "work", "source_incarnation": "1",
            "slug": "notes/a", "digest": "d", "intent": {}, "authority": {}, "sequence": 5,
            "state": state, "created_at_us": 0, "updated_at_us": 0,
        });
        if let (Value::Object(row), Value::Object(extra)) = (&mut row, extra) {
            row.extend(extra);
        }
        serde_json::from_value(row).unwrap()
    }

    fn put(s: &Store, r: &RequestRecord) {
        s.write(|tx| write_request(tx, r)).unwrap();
    }

    fn counters(s: &Store, keys: &[&str]) {
        let keys: Vec<String> = keys.iter().map(|k| k.to_string()).collect();
        s.lock_persistence_counters(&keys).unwrap();
    }

    fn recovery_bytes(s: &Store, key: &str) -> i64 {
        read_counter(&*s.read().unwrap(), key)
            .unwrap()
            .unwrap()
            .recovery_bytes
    }

    fn get(s: &Store, id: &str) -> Value {
        s.read_write_request_by_id(id).unwrap().unwrap()
    }

    fn write(s: &Store, what: Value) -> Value {
        s.publication_journal_write(&serde_json::from_value(what).unwrap())
            .unwrap()
    }

    fn rows(s: &Store, what: Value) -> Value {
        s.publication_journal_rows(&serde_json::from_value(what).unwrap())
            .unwrap()
    }

    #[test]
    fn a_running_request_records_its_recovery_once_and_reserves_its_bytes() {
        let s = store();
        counters(&s, &["brain", "worktree:w"]);
        put(
            &s,
            &record(
                REQ,
                "running",
                json!({ "execution_token": TOKEN, "worktree_id": WORKTREE }),
            ),
        );
        let rec = json!({ "version": 1, "path": "/x" });
        let first = json!({ "kind": "record_recovery", "id": REQ, "executionToken": TOKEN,
            "recovery": rec, "bytes": 100, "keys": ["brain", "worktree:w", "absent"], "checked": true });
        assert_eq!(write(&s, first.clone()), json!(true));
        assert_eq!(get(&s, REQ)["recovery"], rec);
        assert_eq!(get(&s, REQ)["recovery_bytes"], 100);
        assert_eq!(recovery_bytes(&s, "brain"), 100);
        // A second checked record finds a recovery record and changes nothing.
        assert_eq!(write(&s, first), json!(false));
        assert_eq!(recovery_bytes(&s, "worktree:w"), 100);
        // A request blocked behind it on the same worktree; the request itself is excluded.
        let blocker = |exclude: &str| {
            rows(
                &s,
                json!({ "kind": "recovery_blocker", "worktreeId": WORKTREE, "excludeId": exclude }),
            )
        };
        assert_eq!(blocker(OTHER), json!(true));
        assert_eq!(blocker(REQ), json!(false));
    }

    #[test]
    fn a_refused_publication_moves_to_recovering_keeps_its_first_failure_and_requeues() {
        let s = store();
        counters(&s, &["brain"]);
        put(
            &s,
            &record(REQ, "running", json!({ "execution_token": TOKEN })),
        );
        write(
            &s,
            json!({ "kind": "record_recovery", "id": REQ, "executionToken": TOKEN,
            "recovery": { "v": 1 }, "bytes": 10, "keys": ["brain"], "checked": true }),
        );
        let started = write(&s, json!({ "kind": "publication_started", "id": REQ }));
        assert_eq!(started["publication_started"], true);
        let mark = |code: &str| {
            write(
                &s,
                json!({ "kind": "mark_recovering", "id": REQ, "executionToken": TOKEN,
            "reason": "publication_failed", "errorCode": code, "errorMessage": "m", "errorDetail": { "c": code } }),
            )
        };
        mark("storage_error");
        mark("later_error");
        let row = get(&s, REQ);
        assert_eq!(row["state"], "recovering");
        assert_eq!(row["error_code"], "storage_error");
        assert_eq!(row["error_detail"], json!({ "c": "storage_error" }));
        // Another token changes nothing.
        write(
            &s,
            json!({ "kind": "mark_recovering", "id": REQ, "executionToken": OTHER, "reason": "x" }),
        );
        assert_eq!(get(&s, REQ)["blocked_reason"], "publication_failed");
        let blocked = write(&s, json!({ "kind": "block_capacity", "id": REQ }));
        assert_eq!(blocked["blocked_reason"], "writer_pool_capacity");
        let requeued = write(
            &s,
            json!({ "kind": "requeue_recovered", "id": REQ, "kept": null, "clearError": true }),
        );
        assert_eq!(requeued["state"], "queued");
        assert_eq!(requeued["recovery"], Value::Null);
        assert_eq!(requeued["execution_token"], Value::Null);
        assert_eq!(requeued["error_code"], Value::Null);
        assert_eq!(requeued["publication_started"], false);
        // Capacity is no longer blocked: the request holds no recovery record.
        assert_eq!(
            write(&s, json!({ "kind": "block_capacity", "id": REQ })),
            Value::Null
        );
    }

    #[test]
    fn a_terminal_request_clears_only_its_exact_recovery_and_releases_its_bytes() {
        let s = store();
        counters(&s, &["brain"]);
        write(
            &s,
            json!({ "kind": "grow_recovery_staging", "table": "persistence_requests", "id": REQ, "recovery": {}, "extra": 0 }),
        );
        put(
            &s,
            &record(
                REQ,
                "failed",
                json!({ "recovery": { "v": 1 }, "recovery_bytes": 40 }),
            ),
        );
        s.add_persistence_counters(
            "brain",
            &serde_json::from_value(json!({ "recovery_bytes": 40 })).unwrap(),
        )
        .unwrap();
        let clear = |rec: Value| {
            write(
                &s,
                json!({ "kind": "clear_known_recovery", "id": REQ, "keys": ["brain"], "recovery": rec }),
            )
        };
        assert_eq!(clear(json!({ "v": 2 })), json!(false));
        assert_eq!(clear(json!({ "v": 1 })), json!(true));
        assert_eq!(recovery_bytes(&s, "brain"), 0);
        assert_eq!(get(&s, REQ)["recovery"], Value::Null);
        // A release below zero refuses, as the CHECK does.
        let err = s
            .publication_journal_write(
                &serde_json::from_value(
                    json!({ "kind": "clear_recovery", "id": REQ, "keys": ["brain"], "bytes": 1 }),
                )
                .unwrap(),
            )
            .unwrap_err();
        assert!(err.message.contains("below zero"), "{}", err.message);
    }

    #[test]
    fn a_recovery_error_blocks_a_live_request_and_staging_grows_its_record() {
        let s = store();
        put(
            &s,
            &record(
                REQ,
                "recovering",
                json!({ "recovery": { "v": 1 }, "recovery_bytes": 7 }),
            ),
        );
        put(&s, &record(OTHER, "committed", json!({})));
        assert_eq!(
            write(
                &s,
                json!({ "kind": "block_recovery", "id": REQ, "reason": "unexpected_file_bytes" })
            )["state"],
            "recovering"
        );
        assert_eq!(
            write(
                &s,
                json!({ "kind": "block_recovery", "id": OTHER, "reason": "unexpected_file_bytes" })
            )["state"],
            "committed"
        );
        write(
            &s,
            json!({ "kind": "grow_recovery_staging", "table": "persistence_requests", "id": REQ, "recovery": { "v": 2 }, "extra": 3 }),
        );
        assert_eq!(
            rows(
                &s,
                json!({ "kind": "recovery_staging", "table": "persistence_requests", "id": REQ })
            ),
            json!({ "recovery": { "v": 2 }, "recovery_bytes": 10, "source_id": "work" })
        );
        assert_eq!(
            rows(
                &s,
                json!({ "kind": "recovery_staging", "table": "persistence_effects", "id": "9" })
            ),
            Value::Null
        );
    }

    #[test]
    fn a_held_write_waits_on_the_import_its_source_has_not_landed() {
        let s = store();
        let input =
            serde_json::from_value(json!({ "id": "work", "name": "work", "config": {} })).unwrap();
        s.upsert_source(&input).unwrap();
        put(
            &s,
            &record(REQ, "deferred", json!({ "deferred_import_from": "" })),
        );
        let held = |seq: Value| {
            rows(
                &s,
                json!({ "kind": "held_behind_import", "sourceId": "work", "slug": "notes/a", "sequence": seq }),
            )
        };
        // The source has no last commit, so a hold from '' has not landed.
        assert_eq!(held(json!("6")), json!(""));
        assert_eq!(held(json!(5)), Value::Null);
        assert_eq!(
            rows(
                &s,
                json!({ "kind": "held_behind_import", "sourceId": "none", "slug": "notes/a", "sequence": 9 })
            ),
            Value::Null
        );
        assert_eq!(
            rows(&s, json!({ "kind": "owner_path", "worktreeId": WORKTREE })),
            Value::Null
        );
    }
}
