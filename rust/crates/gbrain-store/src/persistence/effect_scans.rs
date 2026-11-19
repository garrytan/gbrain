//! Effect scans: the statements of `src/core/engine-sql/persistence-effect-scans.ts` that the
//! effect worker's pass sends before and when it claims effects, and the read of the effects a
//! write receipt lists (rust/docs/store/persistence.md, "Effect scans").
//!
//! Each scan joins `persistence_effects` to `persistence_worktrees` on the host that owns the
//! worktree. This engine keeps no worktree, so every scan answers no row (the claim itself is
//! `effect_worker.rs`).
//! The parameters are still checked as their Postgres casts check them, so an argument Postgres
//! refuses is refused here too.

use crate::Store;
use crate::env::is_uuid;
use crate::error::{Result, StoreError};
use serde_json::Value;

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

/// `listGatedMirrorRequests(hostId, gateCode, allowedCodes)`: no request has a parked
/// withdrawal mirror on a worktree here, so no row; a non-uuid host id refuses.
pub(crate) fn list_gated_mirror_requests(host_id: &str) -> Result<Vec<Value>> {
    host_uuid(host_id)?;
    Ok(Vec::new())
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
fn limit_count(limit: f64) -> Result<()> {
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
    pub fn list_gated_mirror_requests(&self, host_id: &str) -> Result<Vec<Value>> {
        list_gated_mirror_requests(host_id)
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
        let host = "0f000000-0000-4000-8000-0000000000f1";
        assert!(list_gated_mirror_requests(host).unwrap().is_empty());
        assert!(
            list_gated_mirror_requests(&host.to_uppercase())
                .unwrap()
                .is_empty()
        );
        let bad = list_gated_mirror_requests("nope").unwrap_err();
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
