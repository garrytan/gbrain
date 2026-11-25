//! The write journal's upkeep statements (`persistenceUpkeepStore()`,
//! `src/core/engine-sql/persistence-upkeep.ts`; rust/docs/store/persistence.md, "Upkeep"):
//!
//! - receipt compaction (`compactReceipt`, persistence/journal.ts): the locked receipt with its age
//!   and open-run flags, the unfinished-effect probe, a worktree's newest sync receipt, the effect
//!   bytes, the compaction write and the counter release;
//! - effect claim upkeep (`rearmWithheldTargets`, `effectClaimKeeper`, persistence/effect-journal.ts):
//!   the re-armable effects, the re-arm write and the held claim's renewal.
//!
//! The transaction-local lock and statement waits the compaction sets are Postgres settings with no
//! store counterpart (decision C of `persistence.rs`: the store runs one write at a time), so the
//! TypeScript member answers them without a store call. The row locks (`FOR UPDATE`, `SKIP
//! LOCKED`) are reads here for the same reason. The store keeps no persistence protocol setting, so
//! the protocol predicate always holds.

use super::effect_worker::{CLAIM_LEASE_US, claimed, parked_with, pg_uuid};
use super::effects::{EffectRecord, all_effects, request_effects, write_effect};
use super::receipt_compaction::{first_records, in_open_pass, in_open_run};
use super::{distinct_keys, read_counter, request_by_id, write_counter};
use crate::Store;
use crate::env::parse_iso;
use crate::error::{Result, StoreError};
use crate::journal::write_request;
use crate::kv::KvRead;
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
