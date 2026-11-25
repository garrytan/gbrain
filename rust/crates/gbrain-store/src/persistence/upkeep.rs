//! The write journal's upkeep statements (`persistenceUpkeepStore()`,
//! `src/core/engine-sql/persistence-upkeep.ts`; rust/docs/store/persistence.md, "Upkeep"):
//!
//! - receipt compaction (`compactReceipt`, persistence/journal.ts): the locked receipt with its age
//!   and open-run flags, the unfinished-effect probe, a worktree's newest sync receipt, the effect
//!   bytes, the compaction write and the counter release;
//! - effect claim upkeep (`rearmWithheldTargets`, `effectClaimKeeper`, persistence/effect-journal.ts):
//!   the re-armable effects, the re-arm write and the held claim's renewal.
//!
//! - the preparation-attempt counters, a write receipt's health facts and the segment sweep's
//!   owned sources (`floorPreparationAttempts`, `chargePreparationAttempt`, `writeHealthFacts`,
//!   `sweepSegmentStorage`, persistence/journal.ts);
//! - an effect attempt's next scan page, recovery probe and skipped target (`selectedEffectPage`,
//!   `recordFailure`, `recordSkippedTarget`, persistence/effects.ts).
//!
//! The transaction-local lock and statement waits the compaction sets are Postgres settings with no
//! store counterpart (decision C of `persistence.rs`: the store runs one write at a time), so the
//! TypeScript member answers them without a store call. The row locks (`FOR UPDATE`, `SKIP
//! LOCKED`) are reads here for the same reason. The store keeps no persistence protocol setting, so
//! the protocol predicate always holds.

use super::effect_worker::{CLAIM_LEASE_US, claimed, parked_with, pg_uuid};
use super::effects::{EffectRecord, all_effects, request_effects, write_effect};
use super::receipt_compaction::{first_records, in_open_pass, in_open_run};
use super::worktree_admission::{all_refreshes, released_deferred_in};
use super::worktree_rows::{list_source_bindings, read_worktree_row};
use super::write_claim_terms::worktree_of;
use super::{
    all_requests, distinct_keys, extra_i64, extra_is_null, extra_time, read_counter, request_by_id,
    write_counter,
};
use crate::Store;
use crate::env::parse_iso;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::journal::write_request;
use crate::kv::KvRead;
use crate::pages::all_pages;
use serde_json::{Value, json};

/// `$n::timestamptz` of a compaction cutoff, refused in the cast's words.
fn cutoff(text: &str) -> Result<i64> {
    parse_iso(text).ok_or_else(|| {
        StoreError::invalid(format!(
            "invalid input syntax for type timestamp with time zone: \"{text}\""
        ))
    })
}

/// The re-armable effects of `request_ids` (`REARMABLE_SQL`): a Git or embedding effect, queued or
/// failed, unclaimed, not recovering, not settled, with a target parked under `code`, whose request's
/// withdrawal mirror has committed. In id order.
pub(super) fn rearmable_effects(
    read: &dyn KvRead,
    request_ids: &[String],
    code: &str,
) -> Result<Vec<EffectRecord>> {
    let ids = request_ids
        .iter()
        .map(|id| pg_uuid(id))
        .collect::<Result<Vec<_>>>()?;
    let effects = all_effects(read)?;
    let mut out = Vec::new();
    for e in &effects {
        if !ids.contains(&e.request_id)
            || !matches!(e.kind.as_str(), "git" | "embedding")
            || !matches!(e.state.as_str(), "queued" | "failed")
            || e.execution_token.is_some()
            || e.recovery.is_some()
            || e.data.get("settled").is_some()
            || !parked_with(&e.data, code)?
        {
            continue;
        }
        if effects.iter().any(|m| {
            m.request_id == e.request_id && m.kind == "withdrawal-mirror" && m.state == "committed"
        }) {
            out.push(e.clone());
        }
    }
    out.sort_by_key(|e| e.id);
    Ok(out)
}

/// A JSON argument of `op`, or a refusal naming it.
fn arg<'a>(args: &'a [Value], at: usize, op: &str) -> Result<&'a Value> {
    args.get(at)
        .ok_or_else(|| StoreError::invalid(format!("{op}: argument {at} is missing")))
}

fn text_arg(args: &[Value], at: usize, op: &str) -> Result<String> {
    arg(args, at, op)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| StoreError::invalid(format!("{op}: argument {at} is not text")))
}

fn opt_text_arg(args: &[Value], at: usize, op: &str) -> Result<Option<String>> {
    match arg(args, at, op)? {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        _ => Err(StoreError::invalid(format!(
            "{op}: argument {at} is not text"
        ))),
    }
}

fn texts_arg(args: &[Value], at: usize, op: &str) -> Result<Vec<String>> {
    serde_json::from_value(arg(args, at, op)?.clone())
        .map_err(|_| StoreError::invalid(format!("{op}: argument {at} is not a text list")))
}

/// A `bigint` parameter (a JSON number, or its text), refused in the cast's words.
fn bigint_arg(args: &[Value], at: usize, op: &str) -> Result<i64> {
    match arg(args, at, op)? {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| {
                n.as_f64()
                    .filter(|f| f.fract() == 0.0 && f.abs() < 9.2e18)
                    .map(|f| f as i64)
            })
            .ok_or_else(|| StoreError::invalid(format!("{op}: bigint out of range"))),
        Value::String(s) => s.trim().parse().map_err(|_| {
            StoreError::invalid(format!("invalid input syntax for type bigint: \"{s}\""))
        }),
        _ => Err(StoreError::invalid(format!(
            "{op}: argument {at} is not a number"
        ))),
    }
}

/// An effect id parameter as text (`id=$1` binds a number or its text).
fn id_arg(args: &[Value], at: usize, op: &str) -> Result<String> {
    match arg(args, at, op)? {
        Value::Number(n) => Ok(n.to_string()),
        Value::String(s) => Ok(s.clone()),
        _ => Err(StoreError::invalid(format!(
            "{op}: argument {at} is not an id"
        ))),
    }
}

/// `STUCK_RECOVERY(r)`: recovering, or holding a recovery record while not running under a live
/// claim. A running claim with no expiry compares NULL, which `COALESCE(..., false)` reads as false.
fn stuck_recovery(r: &RequestRecord, now: i64) -> bool {
    r.state == "recovering"
        || (!extra_is_null(r, "recovery")
            && (r.state != "running" || extra_time(r, "claim_expires_at").is_some_and(|t| t < now)))
}

fn recovery_held(r: &RequestRecord) -> bool {
    !extra_is_null(r, "recovery")
}

/// `r.blocked_reason IN ('unexpected_file_bytes','unexpected_staging_bytes')`.
fn inspect_owner(r: &RequestRecord) -> bool {
    matches!(
        r.blocked_reason.as_deref(),
        Some("unexpected_file_bytes" | "unexpected_staging_bytes")
    )
}

/// The lowest sequence of `rows`, as `sequence::text`.
fn first_sequence<'a>(rows: impl Iterator<Item = &'a RequestRecord>) -> Value {
    rows.map(|r| r.sequence)
        .min()
        .map_or(Value::Null, |s| json!(s.to_string()))
}

/// One root's health facts (the `writeHealthFacts` statement): its head request's sequence, the
/// first started sequences, and the recovery, owner and inspection flags.
fn health_fact(
    read: &dyn KvRead,
    root: &str,
    requests: &[RequestRecord],
    now: i64,
) -> Result<Value> {
    // `w.id::text = roots.root`: a worktree id is stored as lower-case text.
    let worktree = if root == root.to_lowercase() {
        read_worktree_row(read, root)?
    } else {
        None
    };
    let mut sequence = Value::Null;
    let mut started_sequence = Value::Null;
    let mut started_unlaned = Value::Null;
    let mut recovering = false;
    let mut inspect = false;
    if worktree.is_some() {
        let mine: Vec<&RequestRecord> = requests
            .iter()
            .filter(|r| worktree_of(r).as_deref() == Some(root))
            .collect();
        let mut head: Option<&RequestRecord> = None;
        for r in &mine {
            let pending = matches!(r.state.as_str(), "queued" | "running" | "recovering")
                || recovery_held(r)
                || released_deferred_in(read, r)?;
            if pending && head.is_none_or(|h| r.sequence < h.sequence) {
                head = Some(r);
            }
        }
        if let Some(h) = head {
            let started = |r: &&&RequestRecord| {
                matches!(r.state.as_str(), "running" | "recovering") || recovery_held(r)
            };
            sequence = json!(h.sequence.to_string());
            started_sequence = first_sequence(mine.iter().filter(started).copied());
            started_unlaned = first_sequence(
                mine.iter()
                    .filter(started)
                    .filter(|r| {
                        !(r.state == "running" && !recovery_held(r) && r.operation == "submit_job")
                    })
                    .copied(),
            );
            recovering = stuck_recovery(h, now);
            inspect = inspect_owner(h);
        }
    } else if let Some(incarnation) = root.strip_prefix("db:") {
        let incarnation = pg_uuid(incarnation)?;
        let mine: Vec<&RequestRecord> = requests
            .iter()
            .filter(|r| {
                worktree_of(r).is_none() && r.source_incarnation.eq_ignore_ascii_case(&incarnation)
            })
            .collect();
        let head = mine
            .iter()
            .filter(|r| matches!(r.state.as_str(), "queued" | "running" | "recovering"))
            .min_by_key(|r| r.sequence);
        if let Some(h) = head {
            sequence = json!(h.sequence.to_string());
            started_sequence = first_sequence(
                mine.iter()
                    .filter(|r| matches!(r.state.as_str(), "running" | "recovering"))
                    .copied(),
            );
            recovering = stuck_recovery(h, now);
            inspect = inspect_owner(h);
        }
    }
    let (recovery_required, owner_unavailable) = match &worktree {
        None => (recovering, false),
        Some(w) => {
            let effect_recovery = super::effects::all_effects(read)?.iter().any(|e| {
                e.worktree_id
                    .as_deref()
                    .is_some_and(|id| id.eq_ignore_ascii_case(root))
                    && e.recovery.is_some()
            });
            let refresh_recovery = all_refreshes(read)?.iter().any(|f| {
                f.worktree_id.eq_ignore_ascii_case(root) && f.state == "recovery_required"
            });
            (
                recovering || effect_recovery || refresh_recovery,
                w.state != "active" || w.owner_host_id.is_none(),
            )
        }
    };
    Ok(json!({
        "root": root, "sequence": sequence, "started_sequence": started_sequence, "started_unlaned": started_unlaned,
        "inspect_owner": inspect, "recovery_required": recovery_required, "owner_unavailable": owner_unavailable,
    }))
}

impl Store {
    /// One upkeep statement by name (`op`), with the TypeScript member's arguments (`args`).
    pub fn persistence_upkeep(&self, op: &str, args: &[Value]) -> Result<Value> {
        match op {
            "lockCompactionReceipt" => {
                let id = text_arg(args, 0, op)?;
                let before = opt_text_arg(args, 1, op)?.map(|t| cutoff(&t)).transpose()?;
                let read = self.read()?;
                let Some(r) = request_by_id(&*read, &id)? else {
                    return Ok(Value::Null);
                };
                let runs = first_records(&*read, "managed-sync")?;
                let passes = first_records(&*read, "managed-sync-pass")?;
                // `$2 IS NULL OR completed_at < $2`: NULL (not false) for a receipt with no completion time.
                let eligible = match (before, r.completed_at_us) {
                    (None, _) => json!(true),
                    (Some(_), None) => Value::Null,
                    (Some(b), Some(t)) => json!(t < b),
                };
                let mut row = r.to_row();
                row["eligible_age"] = eligible;
                row["open_cursor"] = json!(in_open_run(&r, &runs));
                row["open_pass"] = json!(in_open_pass(&r, &passes));
                Ok(row)
            }
            "hasUnfinishedEffect" => {
                let id = pg_uuid(&text_arg(args, 0, op)?)?;
                let read = self.read()?;
                Ok(json!(
                    request_effects(&*read, &id)?
                        .iter()
                        .any(|e| e.state != "committed")
                ))
            }
            "newestSyncReceiptId" => {
                let worktree = pg_uuid(&text_arg(args, 0, op)?)?;
                let read = self.read()?;
                let newest = super::all_requests(&*read)?
                    .into_iter()
                    .filter(|r| {
                        r.state == "committed"
                            && r.extra
                                .get("worktree_id")
                                .and_then(Value::as_str)
                                .map(str::to_lowercase)
                                .as_deref()
                                == Some(worktree.as_str())
                            && r.intent
                                .get("kind")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .starts_with("managed_sync_")
                    })
                    // ORDER BY completed_at DESC, sequence DESC: a NULL completion sorts first, as DESC puts NULLs first.
                    .max_by(|a, b| {
                        let at = |r: &crate::journal::RequestRecord| {
                            r.completed_at_us.unwrap_or(i64::MAX)
                        };
                        at(a).cmp(&at(b)).then(a.sequence.cmp(&b.sequence))
                    });
                Ok(newest.map_or(Value::Null, |r| json!(r.id)))
            }
            "requestEffectBytes" => {
                let id = pg_uuid(&text_arg(args, 0, op)?)?;
                let read = self.read()?;
                let bytes: i64 = request_effects(&*read, &id)?
                    .iter()
                    .map(EffectRecord::bytes)
                    .sum();
                Ok(json!(bytes.to_string()))
            }
            "markReceiptCompacted" => {
                let id = text_arg(args, 0, op)?;
                let retained = bigint_arg(args, 1, op)?;
                self.write(|tx| {
                    let Some(mut r) = request_by_id(&*tx, &id)? else {
                        return Ok(Value::Null);
                    };
                    r.intent = Value::Null;
                    r.error_message = None;
                    r.extra.insert("compacted".into(), json!(true));
                    r.extra
                        .insert("terminal_reservation".into(), json!(retained));
                    write_request(tx, &r)?;
                    Ok(Value::Null)
                })
            }
            "releaseTerminalBytes" => {
                let keys = texts_arg(args, 0, op)?;
                let freed = bigint_arg(args, 1, op)?;
                self.write(|tx| {
                    for key in distinct_keys(&keys) {
                        let Some(mut counter) = read_counter(&*tx, &key)? else {
                            continue;
                        };
                        // terminal_bytes - LEAST($2, terminal_bytes); a negative release adds and must stay a bigint.
                        let release = freed.min(counter.terminal_bytes);
                        counter.terminal_bytes = counter
                            .terminal_bytes
                            .checked_sub(release)
                            .ok_or_else(|| StoreError::invalid("bigint out of range"))?;
                        write_counter(tx, &key, &counter)?;
                    }
                    Ok(Value::Null)
                })
            }
            "lockRearmableEffects" => {
                let ids = texts_arg(args, 0, op)?;
                let code = text_arg(args, 1, op)?;
                let read = self.read()?;
                Ok(Value::Array(
                    rearmable_effects(&*read, &ids, &code)?
                        .iter()
                        .map(EffectRecord::to_row)
                        .collect(),
                ))
            }
            "rearmEffect" => {
                let id = super::effect_worker::effect_id(&id_arg(args, 0, op)?)?;
                let data_text = text_arg(args, 1, op)?;
                let data: Value = serde_json::from_str(&data_text)
                    .map_err(|_| StoreError::invalid("invalid input syntax for type json"))?;
                let now = self.env.now_micros();
                self.write(|tx| {
                    let Some(mut e) = super::effects::effect_by_id(&*tx, id)? else {
                        return Ok(Value::Null);
                    };
                    if e.execution_token.is_some() || e.recovery.is_some() {
                        return Ok(Value::Null);
                    }
                    e.state = "queued".into();
                    e.data = data.clone();
                    e.error_code = None;
                    e.claim_expires_at_us = None;
                    e.claim_owner = None;
                    e.next_attempt_at_us = now;
                    e.updated_at_us = now;
                    write_effect(tx, &e)?;
                    Ok(Value::Null)
                })
            }
            "renewHeldEffectClaim" => {
                let id = id_arg(args, 0, op)?;
                let token = opt_text_arg(args, 1, op)?;
                let now = self.env.now_micros();
                self.write(|tx| {
                    // A recovery record does not stop this renewal (the withdrawal mirror renews while it holds one).
                    let Some(mut e) = claimed(&*tx, &id, token.as_deref(), false)? else {
                        return Ok(json!(false));
                    };
                    if e.state != "running" {
                        return Ok(json!(false));
                    }
                    e.claim_expires_at_us = Some(now + CLAIM_LEASE_US);
                    e.updated_at_us = now;
                    write_effect(tx, &e)?;
                    Ok(json!(true))
                })
            }
            "floorPreparationAttempts" => {
                let id = text_arg(args, 0, op)?;
                let limit = bigint_arg(args, 1, op)?;
                let now = self.env.now_micros();
                self.write(|tx| {
                    let Some(mut r) = request_by_id(&*tx, &id)? else {
                        return Ok(Value::Null);
                    };
                    if !matches!(r.state.as_str(), "queued" | "running") {
                        return Ok(Value::Null);
                    }
                    let current = extra_i64(&r, "preparation_attempts");
                    r.extra
                        .insert("preparation_attempts".into(), json!(current.max(limit)));
                    r.updated_at_us = now;
                    write_request(tx, &r)?;
                    Ok(Value::Null)
                })
            }
            "chargePreparationAttempt" => {
                let id = text_arg(args, 0, op)?;
                let token = opt_text_arg(args, 1, op)?
                    .map(|t| pg_uuid(&t))
                    .transpose()?;
                let now = self.env.now_micros();
                self.write(|tx| {
                    let Some(token) = &token else {
                        return Ok(Value::Null);
                    };
                    let Some(mut r) = request_by_id(&*tx, &id)? else {
                        return Ok(Value::Null);
                    };
                    let holds = r.state == "running"
                        && r.extra
                            .get("execution_token")
                            .and_then(Value::as_str)
                            .is_some_and(|t| t.eq_ignore_ascii_case(token));
                    if !holds {
                        return Ok(Value::Null);
                    }
                    let attempts = extra_i64(&r, "preparation_attempts") + 1;
                    r.extra
                        .insert("preparation_attempts".into(), json!(attempts));
                    r.updated_at_us = now;
                    write_request(tx, &r)?;
                    Ok(json!(attempts))
                })
            }
            "readHealthFacts" => {
                let roots = texts_arg(args, 0, op)?;
                let read = self.read()?;
                let now = self.env.now_micros();
                let requests = all_requests(&*read)?;
                let rows = roots
                    .iter()
                    .map(|root| health_fact(&*read, root, &requests, now))
                    .collect::<Result<Vec<_>>>()?;
                Ok(Value::Array(rows))
            }
            "nextScanSlug" => {
                let source = text_arg(args, 0, op)?;
                let after = opt_text_arg(args, 1, op)?;
                let read = self.read()?;
                let next = all_pages(&*read)?
                    .into_iter()
                    .filter(|p| {
                        p.source_id == source
                            && after.as_deref().is_none_or(|a| p.slug.as_str() > a)
                    })
                    .map(|p| p.slug)
                    .min();
                Ok(next.map_or(Value::Null, Value::String))
            }
            "effectRecovering" => {
                let id = super::effect_worker::effect_id(&id_arg(args, 0, op)?)?;
                let read = self.read()?;
                Ok(super::effects::effect_by_id(&*read, id)?
                    .map_or(Value::Null, |e| json!(e.recovery.is_some())))
            }
            "recordSkippedTarget" => {
                let id = id_arg(args, 0, op)?;
                let token = opt_text_arg(args, 1, op)?;
                let targets: Value = serde_json::from_str(&text_arg(args, 2, op)?)
                    .map_err(|_| StoreError::invalid("invalid input syntax for type json"))?;
                let limit = bigint_arg(args, 3, op)?;
                self.write(|tx| {
                    let Some(mut e) = claimed(&*tx, &id, token.as_deref(), false)? else {
                        return Ok(Value::Null);
                    };
                    let mut skipped = match e.data.get("skipped") {
                        Some(Value::Array(items)) => items.clone(),
                        _ => Vec::new(),
                    };
                    if skipped.len() as i64 >= limit {
                        return Ok(Value::Null);
                    }
                    if let Value::Array(items) = &targets {
                        skipped.extend(items.iter().cloned());
                    }
                    if let Value::Object(map) = &mut e.data {
                        map.insert("skipped".into(), Value::Array(skipped));
                    }
                    write_effect(tx, &e)?;
                    Ok(Value::Null)
                })
            }
            "listOwnedBoundSources" => {
                let host = pg_uuid(&text_arg(args, 0, op)?)?;
                let read = self.read()?;
                let mut owned = Vec::new();
                for (source, binding) in list_source_bindings(&*read)? {
                    if let Some(w) = read_worktree_row(&*read, &binding.worktree_id)?
                        && w.owned_by(Some(&host))
                        && w.state == "active"
                    {
                        owned.push(Value::String(source));
                    }
                }
                Ok(Value::Array(owned))
            }
            _ => Err(StoreError::invalid(format!(
                "persistenceUpkeepStore: unknown statement {op}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn upkeep_statements_refuse_bad_arguments_and_answer_unknown_rows_as_their_sql_does() {
        let store = crate::test_support::store();
        let unknown = "a0000000-0000-4000-8000-0000000000a9";
        assert_eq!(
            store
                .persistence_upkeep("lockCompactionReceipt", &[json!(unknown), json!(null)])
                .unwrap(),
            json!(null)
        );
        assert_eq!(
            store
                .persistence_upkeep("hasUnfinishedEffect", &[json!(unknown)])
                .unwrap(),
            json!(false)
        );
        assert_eq!(
            store
                .persistence_upkeep("requestEffectBytes", &[json!(unknown)])
                .unwrap(),
            json!("0")
        );
        assert_eq!(
            store
                .persistence_upkeep("newestSyncReceiptId", &[json!(unknown)])
                .unwrap(),
            json!(null)
        );
        assert_eq!(
            store
                .persistence_upkeep(
                    "lockRearmableEffects",
                    &[json!([unknown]), json!("withdrawal_mirror_failed")]
                )
                .unwrap(),
            json!([])
        );
        assert_eq!(
            store
                .persistence_upkeep("renewHeldEffectClaim", &[json!(1), json!(unknown)])
                .unwrap(),
            json!(false)
        );
        assert_eq!(
            store
                .persistence_upkeep("renewHeldEffectClaim", &[json!(1), json!(null)])
                .unwrap(),
            json!(false)
        );
        let refused = |op: &str, args: &[serde_json::Value]| {
            store.persistence_upkeep(op, args).unwrap_err().to_string()
        };
        assert!(
            refused("hasUnfinishedEffect", &[json!("not-a-uuid")])
                .contains("invalid input syntax for type uuid")
        );
        assert!(
            refused(
                "lockCompactionReceipt",
                &[json!(unknown), json!("not a time")]
            )
            .contains("timestamp with time zone")
        );
        assert!(
            refused("releaseTerminalBytes", &[json!(["brain"]), json!("x")])
                .contains("type bigint")
        );
        assert!(refused("noSuchStatement", &[]).contains("unknown statement"));
    }
}
