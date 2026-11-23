//! Effect scans: the statements of `src/core/engine-sql/persistence-effect-scans.ts` that the
//! effect worker's pass sends before and when it claims effects (rust/docs/store/persistence.md,
//! "Effect scans").
//!
//! Each scan joins `persistence_effects` to `persistence_worktrees` on the host that owns the
//! worktree (the claim itself is `effect_worker.rs`), read through `worktree_rows.rs`. The
//! effect-recovery scan belongs to the worktree binding and answers no row.
//! The parameters are still checked as their Postgres casts check them, so an argument Postgres
//! refuses is refused here too.

use super::all_requests;
use super::effects::all_effects;
use super::worktree_rows::read_worktree_row;
use crate::Store;
use crate::env::is_uuid;
use crate::error::{Result, StoreError};
use crate::kv::KvRead;
use serde_json::{Value, json};

/// `$1::uuid`: the message Postgres gives for text that is not a uuid.
pub(super) fn host_uuid(text: &str) -> Result<()> {
    if is_uuid(text) {
        Ok(())
    } else {
        Err(StoreError::invalid(format!(
            "invalid input syntax for type uuid: \"{text}\""
        )))
    }
}

/// `jsonb_array_elements(COALESCE(o.data->'parked','[]'))`: the parked targets of an effect;
/// anything but an array refuses as the function does.
fn parked_targets(data: &Value) -> Result<&[Value]> {
    match data.get("parked") {
        None => Ok(&[]),
        Some(Value::Array(a)) => Ok(a),
        Some(Value::Object(_)) => Err(StoreError::invalid(
            "cannot extract elements from an object",
        )),
        Some(_) => Err(StoreError::invalid("cannot extract elements from a scalar")),
    }
}

/// `p.target->>'error_code'`: the code of one parked target, as text.
fn target_code(target: &Value) -> Option<String> {
    match target.as_object()?.get("error_code")? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// `listGatedMirrorRequests(hostId, gateCode, allowedCodes)`: the distinct requests (`id`,
/// `source_id`, `request_id`; at most 100) of each parked withdrawal mirror
/// (`kind='withdrawal-mirror'`, `state='failed'`, `error_code='targets_parked'`) on a worktree host
/// `host_id` owns whose parked targets include one parked by `gate_code`, when every unsettled
/// effect of the request is parked only with codes in `allowed_codes`. A non-uuid host id refuses.
pub(crate) fn list_gated_mirror_requests(
    read: &dyn KvRead,
    host_id: &str,
    gate_code: &str,
    allowed_codes: &[String],
) -> Result<Vec<Value>> {
    host_uuid(host_id)?;
    let effects = all_effects(read)?;
    let requests: std::collections::HashMap<String, crate::journal::RequestRecord> =
        all_requests(read)?
            .into_iter()
            .map(|r| (r.id.clone(), r))
            .collect();
    let mut out: Vec<Value> = Vec::new();
    for e in &effects {
        let parked = e.kind == "withdrawal-mirror"
            && e.state == "failed"
            && e.error_code.as_deref() == Some("targets_parked");
        let Some(w) = e.worktree_id.as_deref().filter(|_| parked) else {
            continue;
        };
        let Some(r) = requests.get(&e.request_id) else {
            continue;
        };
        if !read_worktree_row(read, w)?.is_some_and(|row| row.owned_by(Some(host_id))) {
            continue;
        }
        let gated = e
            .data
            .get("parked")
            .and_then(Value::as_array)
            .is_some_and(|targets| {
                targets.iter().any(|t| {
                    t.get("error_code").and_then(Value::as_str) == Some(gate_code) && t.is_object()
                })
            });
        if !gated {
            continue;
        }
        let mut other_code = false;
        for o in effects
            .iter()
            .filter(|o| o.request_id == e.request_id && o.state != "committed")
        {
            if parked_targets(&o.data)?
                .iter()
                .any(|t| !allowed_codes.contains(&target_code(t).unwrap_or_default()))
            {
                other_code = true;
                break;
            }
        }
        if other_code {
            continue;
        }
        let row = json!({ "id": r.id, "source_id": r.source_id, "request_id": r.request_id });
        if !out.contains(&row) {
            out.push(row);
            if out.len() == 100 {
                break;
            }
        }
    }
    Ok(out)
}

/// `$2::bigint`: the effect id to scan after. Postgres trims surrounding whitespace and accepts a
/// leading sign; text that is no integer, or one past the bigint range, refuses.
fn after_bigint(text: &str) -> Result<()> {
    let digits = text.trim();
    let body = digits.strip_prefix(['+', '-']).unwrap_or(digits);
    if body.is_empty() || !body.bytes().all(|c| c.is_ascii_digit()) {
        return Err(StoreError::invalid(format!(
            "invalid input syntax for type bigint: \"{text}\""
        )));
    }
    digits.parse::<i64>().map(|_| ()).map_err(|_| {
        StoreError::invalid(format!("value \"{text}\" is out of range for type bigint"))
    })
}

/// `LIMIT $3`, which Postgres types as bigint: a fraction refuses as bigint syntax, a negative
/// count as a negative LIMIT.
pub(super) fn limit_count(limit: f64) -> Result<()> {
    if !limit.is_finite() || limit.fract() != 0.0 {
        return Err(StoreError::invalid(format!(
            "invalid input syntax for type bigint: \"{limit}\""
        )));
    }
    if limit < 0.0 {
        return Err(StoreError::invalid("LIMIT must not be negative"));
    }
    Ok(())
}

/// `listEffectRecoveries(hostId, after, limit)`: no effect carries a recovery on a worktree here,
/// so no row; a non-uuid host id, a non-bigint `after` and a fractional or negative limit refuse.
pub(crate) fn list_effect_recoveries(
    host_id: &str,
    after: Option<&str>,
    limit: f64,
) -> Result<Vec<Value>> {
    host_uuid(host_id)?;
    if let Some(after) = after {
        after_bigint(after)?;
    }
    limit_count(limit)?;
    Ok(Vec::new())
}

impl Store {
    /// `listGatedMirrorRequests(hostId, gateCode, allowedCodes)`.
    pub fn list_gated_mirror_requests(
        &self,
        host_id: &str,
        gate_code: &str,
        allowed_codes: &[String],
    ) -> Result<Vec<Value>> {
        list_gated_mirror_requests(&*self.read()?, host_id, gate_code, allowed_codes)
    }

    /// `listEffectRecoveries(hostId, after, limit)`.
    pub fn list_effect_recoveries(
        &self,
        host_id: &str,
        after: Option<&str>,
        limit: f64,
    ) -> Result<Vec<Value>> {
        list_effect_recoveries(host_id, after, limit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gated_mirror_requests_are_empty_and_refuse_a_non_uuid_host() {
        let s = crate::test_support::store();
        let host = "0f000000-0000-4000-8000-0000000000f1";
        assert!(
            s.list_gated_mirror_requests(host, "gate", &[])
                .unwrap()
                .is_empty()
        );
        assert!(
            s.list_gated_mirror_requests(&host.to_uppercase(), "gate", &[])
                .unwrap()
                .is_empty()
        );
        let bad = s
            .list_gated_mirror_requests("nope", "gate", &[])
            .unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
    }

    #[test]
    fn effect_recoveries_are_empty_and_refuse_what_the_casts_refuse() {
        let host = "0f000000-0000-4000-8000-0000000000f1";
        assert!(list_effect_recoveries(host, None, 10.0).unwrap().is_empty());
        assert!(
            list_effect_recoveries(host, Some(" +12 "), 0.0)
                .unwrap()
                .is_empty()
        );
        let message = |after: Option<&str>, limit: f64| {
            list_effect_recoveries(host, after, limit)
                .unwrap_err()
                .message
        };
        assert_eq!(
            list_effect_recoveries("nope", None, 1.0)
                .unwrap_err()
                .message,
            "invalid input syntax for type uuid: \"nope\""
        );
        assert_eq!(
            message(Some("x1"), 1.0),
            "invalid input syntax for type bigint: \"x1\""
        );
        assert_eq!(
            message(Some("99999999999999999999"), 1.0),
            "value \"99999999999999999999\" is out of range for type bigint"
        );
        assert_eq!(message(None, -1.0), "LIMIT must not be negative");
        assert_eq!(
            message(None, 1.5),
            "invalid input syntax for type bigint: \"1.5\""
        );
    }
}
