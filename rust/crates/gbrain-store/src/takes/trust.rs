//! The trust tier and write origin of a take: the `trust_tier` and `write_origin` columns of
//! `takes` that PGLite's `trust_tier_stamp` trigger stamps (src/core/trust/schema.ts), through
//! [`crate::trust::stamp`] with [`TrustTable::Takes`].
//!
//! - Insert: the write's declared tier (`unknown` when none) and the context's origin. No take
//!   writer supplies a tier, so under backfill the row keeps the column defaults (`unknown`, NULL).
//! - Update: no take writer sets the tier or the origin itself (every `UPDATE takes` and the
//!   `ON CONFLICT DO UPDATE` arm of `addTakesBatch` leave both columns out of their `SET`), so the
//!   update starts from the stored tier and origin. When a content column (`claim`, `kind`,
//!   `holder`) changed, the stamp lowers the tier to the write's and sets the context's origin;
//!   otherwise both stay. Every update runs the stamp, so a writer that declares a tier above
//!   `operator_curated` without owner confirmation is refused on any take write, as the trigger
//!   refuses it.
//!
//! Keys: none; the pair is part of the `A 0x01` record and omitted while the tier is `unknown`
//! with no origin, so a record stored before the store kept the columns reads as their defaults.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::TakeRecord;
use crate::cli_reads::pg_text::jsonb_value;
use crate::error::Result;
use crate::kv::KvRead;
use crate::trust::{
    OriginStamp, StampRow, TrustTable, TrustTier, activation_suppressed, stamp as stamp_trust,
};
use crate::write_trust::stamp_context;

/// `trust_tier` (`None` is `unknown`, the column default) and `write_origin` (`None` is NULL).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct TakeTrust {
    pub trust_tier: Option<String>,
    pub write_origin: Option<Value>,
}

impl TakeTrust {
    pub(crate) fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// The stored tier (`storedTrustTier`).
    pub(crate) fn tier(&self) -> TrustTier {
        TrustTier::stored(self.trust_tier.as_deref())
    }

    /// `write_origin` as jsonb returns it: object keys in jsonb order.
    pub(crate) fn origin_out(&self) -> Option<Value> {
        self.write_origin.as_ref().map(jsonb_value)
    }
}

fn content_changed(old: &TakeRecord, new: &TakeRecord) -> bool {
    (&old.claim, &old.kind, &old.holder) != (&new.claim, &new.kind, &new.holder)
}

/// `new` with the tier and origin the trigger would store under the open write's trust context,
/// as an insert (`old` `None`) or an update of `old`. A refused raise or an undeclared writer
/// above the floor is the trigger's error.
pub(crate) fn stamp(old: Option<&TakeRecord>, new: &TakeRecord) -> Result<TakeRecord> {
    let context = stamp_context::current()?;
    let (row, stored_origin) = match old {
        None => (
            StampRow::Insert {
                supplied: new.trust.tier(),
            },
            new.trust.write_origin.clone(),
        ),
        Some(old) => (
            StampRow::Update {
                old: old.trust.tier(),
                new: old.trust.tier(),
                content_changed: content_changed(old, new),
                origin_set: false,
            },
            old.trust.write_origin.clone(),
        ),
    };
    let stamped = stamp_trust(&context, TrustTable::Takes, row)?;
    let mut out = new.clone();
    out.trust.trust_tier =
        (stamped.tier != TrustTier::Unknown).then(|| stamped.tier.as_str().to_owned());
    out.trust.write_origin = match stamped.origin {
        OriginStamp::Keep => stored_origin,
        OriginStamp::Set(origin) => origin,
    };
    Ok(out)
}

/// The `BEFORE INSERT` trigger on a proposed `addTakesBatch` row: it runs before `ON CONFLICT`
/// decides, so a refused writer fails the statement even when the stored row already holds the
/// values and nothing is written.
pub(crate) fn check_insert() -> Result<()> {
    let context = stamp_context::current()?;
    stamp_trust(
        &context,
        TrustTable::Takes,
        StampRow::Insert {
            supplied: TrustTier::Unknown,
        },
    )
    .map(|_| ())
}

/// `contestedRefSql('takes', alias)`: `tp<id>:challenger|challenged` for the first pending
/// `supersede_fact` / `supersede_take` proposal naming the take, or `None`.
pub(crate) fn contested(read: &dyn KvRead, take_id: u64) -> Result<Option<String>> {
    crate::trust::proposals::contested_ref(read, "takes", take_id)
}

/// The `RowTrustRow` flag of a take: `activationSuppressedSql('takes')`.
pub(crate) fn flagged(read: &dyn KvRead, take: &TakeRecord) -> Result<bool> {
    activation_suppressed(read, "takes", take.id, take.trust.tier())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trust::WriteTrust;
    use serde_json::json;

    fn take(claim: &str, trust: TakeTrust) -> TakeRecord {
        TakeRecord {
            id: 3,
            page_id: 1,
            source_id: "default".into(),
            row_num: 1,
            claim: claim.into(),
            kind: "take".into(),
            holder: "world".into(),
            weight: 0.5,
            since_date: None,
            until_date: None,
            source: None,
            superseded_by: None,
            active: true,
            resolved_at_us: None,
            resolved_outcome: None,
            resolved_quality: None,
            resolved_value: None,
            resolved_unit: None,
            resolved_source: None,
            resolved_by: None,
            created_at_us: 1,
            updated_at_us: 1,
            claim_rev: 0,
            trust,
        }
    }

    fn under<T>(writer: Option<TrustTier>, origin: Option<Value>, f: impl FnOnce() -> T) -> T {
        let _trust = stamp_context::open(WriteTrust {
            writer,
            origin,
            ..WriteTrust::default()
        });
        f()
    }

    fn agent() -> TakeTrust {
        TakeTrust {
            trust_tier: Some("agent_written".into()),
            write_origin: Some(json!({ "channel": "agent" })),
        }
    }

    #[test]
    fn an_insert_takes_the_declared_tier_and_origin() {
        let out = under(
            Some(TrustTier::AgentWritten),
            Some(json!({ "channel": "agent" })),
            || stamp(None, &take("a", TakeTrust::default())),
        )
        .unwrap();
        assert_eq!(out.trust, agent());
        let unknown = under(None, None, || stamp(None, &take("a", TakeTrust::default()))).unwrap();
        assert!(unknown.trust.is_empty());
    }

    #[test]
    fn an_update_keeps_the_stored_pair_unless_a_content_column_changed() {
        let old = take("a", agent());
        let tool = Some(json!({ "channel": "tool" }));
        let mut weight = old.clone();
        weight.weight = 0.9;
        let kept = under(Some(TrustTier::ToolObserved), tool.clone(), || {
            stamp(Some(&old), &weight)
        })
        .unwrap();
        assert_eq!(kept.trust, agent());
        let lowered = under(Some(TrustTier::ToolObserved), tool.clone(), || {
            stamp(Some(&old), &take("b", TakeTrust::default()))
        })
        .unwrap();
        // A writer below the floor only lowers: agent_written stays, the origin is the rewrite's.
        assert_eq!(lowered.trust.tier(), TrustTier::AgentWritten);
        assert_eq!(lowered.trust.write_origin, tool);
    }

    #[test]
    fn a_writer_above_the_floor_without_confirmation_is_refused_on_every_write() {
        let refused = under(Some(TrustTier::UserConfirmed), None, check_insert).unwrap_err();
        assert!(
            refused.message.contains("owner confirmation"),
            "{refused:?}"
        );
        let old = take("a", agent());
        assert!(
            under(Some(TrustTier::UserConfirmed), None, || stamp(
                Some(&old),
                &old
            ))
            .is_err()
        );
    }

    #[test]
    fn a_record_stored_before_the_columns_reads_as_their_defaults() {
        let mut stored = serde_json::to_value(take("a", TakeTrust::default())).unwrap();
        assert!(stored.get("trust").is_none());
        stored.as_object_mut().unwrap().remove("trust");
        let read: TakeRecord = serde_json::from_value(stored).unwrap();
        assert_eq!(read.trust.tier(), TrustTier::Unknown);
        assert_eq!(read.trust.write_origin, None);
    }

    #[test]
    fn the_origin_reads_in_jsonb_key_order() {
        let trust = TakeTrust {
            trust_tier: None,
            write_origin: Some(json!({ "zz": 1, "a": { "y": 1, "x": 2 }, "mm": 3 })),
        };
        let out = serde_json::to_string(&trust.origin_out()).unwrap();
        assert_eq!(out, r#"{"a":{"x":2,"y":1},"mm":3,"zz":1}"#);
    }
}
