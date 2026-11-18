//! The read-side trust policy of `src/core/eligibility/sql.ts`: a trust floor (`trustFloorSql`)
//! and flag suppression (`activationSuppressedSql`), applied to one stored row at a time.
//!
//! A read member that takes `minTrust` / `suppressFlagged` builds one [`TrustPolicy`] and asks
//! [`TrustPolicy::admits`] per row, so the floor and the suppression rule stay in one place.

use crate::error::{Result, StoreError};
use crate::kv::KvRead;

use super::{TrustTier, activation_suppressed};

/// A parsed `{ minTrust, suppressFlagged }` pair.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct TrustPolicy {
    floor: Option<TrustTier>,
    suppress_flagged: bool,
}

impl TrustPolicy {
    /// The policy of a read scope. An unset or empty `minTrust` sets no floor; a name that is no
    /// tier is refused (`invalid_argument`), as `tiersAtOrAbove` throws on it.
    pub(crate) fn parse(min_trust: Option<&str>, suppress_flagged: bool) -> Result<Self> {
        let floor = match min_trust {
            None | Some("") => None,
            Some(name) => Some(TrustTier::parse(name).ok_or_else(|| {
                StoreError::invalid(format!("minTrust: \"{name}\" names no trust tier"))
            })?),
        };
        Ok(Self {
            floor,
            suppress_flagged,
        })
    }

    /// `trustFloorSql(alias, floor) AND NOT activationSuppressedSql(table, alias)`: the row's
    /// stored `tier` is at or above the floor, and, with suppression on, the row is not a
    /// flagged activation (`target_table = table`, `target_id = id`).
    pub(crate) fn admits(
        &self,
        read: &dyn KvRead,
        table: &str,
        id: u64,
        tier: TrustTier,
    ) -> Result<bool> {
        if self.floor.is_some_and(|floor| tier.rank() < floor.rank()) {
            return Ok(false);
        }
        Ok(!(self.suppress_flagged && activation_suppressed(read, table, id, tier)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::INVALID_ARGUMENT;
    use crate::test_support::store;
    use crate::trust::write_gate::ReceiptInput;

    fn flag(table: &str, id: u64, family: &str) -> ReceiptInput {
        ReceiptInput {
            target_table: table.into(),
            target_id: id.to_string(),
            source_id: Some("default".into()),
            content_hash: "h".into(),
            tier: "agent_written".into(),
            detector_version: 1,
            verdict: "flag".into(),
            reason_families: vec![family.into()],
            reasons: vec!["a reason".into()],
            detector_error: false,
            request_id: None,
        }
    }

    #[test]
    fn an_unset_or_empty_floor_admits_every_tier_and_a_bad_name_is_refused() {
        let s = store();
        let read = s.read().unwrap();
        for policy in [
            TrustPolicy::parse(None, false).unwrap(),
            TrustPolicy::parse(Some(""), false).unwrap(),
        ] {
            assert!(
                policy
                    .admits(&*read, "pages", 1, TrustTier::ExternalUntrusted)
                    .unwrap()
            );
        }
        let err = TrustPolicy::parse(Some("trusted"), false).unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
        assert!(err.to_string().contains("\"trusted\" names no trust tier"));
    }

    #[test]
    fn the_floor_admits_its_tier_and_above_only() {
        let s = store();
        let read = s.read().unwrap();
        let policy = TrustPolicy::parse(Some("tool_observed"), false).unwrap();
        let admitted = |tier| policy.admits(&*read, "facts", 1, tier).unwrap();
        assert!(admitted(TrustTier::UserConfirmed));
        assert!(admitted(TrustTier::ToolObserved));
        assert!(!admitted(TrustTier::AgentWritten));
        assert!(!admitted(TrustTier::Unknown));
    }

    #[test]
    fn suppression_drops_a_flagged_low_tier_row_of_its_own_table_only() {
        let s = store();
        s.upsert_write_gate_receipt(flag("facts", 7, "standing_instruction"))
            .unwrap();
        s.upsert_write_gate_receipt(flag("facts", 8, "a_family_that_does_not_suppress"))
            .unwrap();
        let read = s.read().unwrap();
        let on = TrustPolicy::parse(None, true).unwrap();
        let off = TrustPolicy::parse(None, false).unwrap();
        assert!(
            !on.admits(&*read, "facts", 7, TrustTier::AgentWritten)
                .unwrap()
        );
        assert!(
            off.admits(&*read, "facts", 7, TrustTier::AgentWritten)
                .unwrap()
        );
        // Another table's row with the same id, a higher tier and a non-activation family all pass.
        assert!(
            on.admits(&*read, "pages", 7, TrustTier::AgentWritten)
                .unwrap()
        );
        assert!(
            on.admits(&*read, "facts", 7, TrustTier::ToolObserved)
                .unwrap()
        );
        assert!(
            on.admits(&*read, "facts", 8, TrustTier::AgentWritten)
                .unwrap()
        );
    }
}
