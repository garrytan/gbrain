//! The trust tier and write origin of a timeline entry: the `trust_tier` and `write_origin`
//! columns of `timeline_entries` that PGLite's `trust_tier_stamp` trigger stamps
//! (trust/schema.ts), through [`crate::trust::stamp`] with [`TrustTable::TimelineEntries`].
//!
//! - Insert: the tier the record carries is what the caller supplied (kept only under backfill);
//!   otherwise the write's declared tier (`unknown` when none) and the context's origin.
//! - Update: no timeline writer sets the tier or the origin itself (PGLite's timeline writes leave
//!   both columns out of their `SET`), so the update starts from the stored tier and origin. When a
//!   content column (`summary`, `detail`, `date`) changed, the stamp lowers the tier to the write's
//!   and sets the context's origin; otherwise both stay.
//!
//! Keys: none; the tier is part of the `E` record and omitted while it is `unknown` with no origin.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::TimelineRecord;
use crate::error::Result;
use crate::trust::{OriginStamp, StampRow, TrustTable, TrustTier, stamp as stamp_trust};
use crate::write_trust::stamp_context;

/// `trust_tier` (`None` is `unknown`, the column default) and `write_origin` (`None` is NULL).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct TimelineTrust {
    pub trust_tier: Option<String>,
    pub write_origin: Option<Value>,
}

impl TimelineTrust {
    pub(crate) fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    /// The stored tier.
    pub(crate) fn tier(&self) -> TrustTier {
        TrustTier::stored(self.trust_tier.as_deref())
    }

    /// The two columns of a `TimelineEntry` row.
    pub(crate) fn extend_json(&self, row: &mut Map<String, Value>) {
        row.insert("trust_tier".into(), json!(self.tier().as_str()));
        row.insert("write_origin".into(), json!(self.write_origin));
    }
}

fn content_changed(old: &TimelineRecord, new: &TimelineRecord) -> bool {
    (&old.summary, &old.detail, &old.date) != (&new.summary, &new.detail, &new.date)
}

/// `new` with the tier and origin the trigger would store, under the open write's trust context.
pub(crate) fn stamp(old: Option<&TimelineRecord>, new: &TimelineRecord) -> Result<TimelineRecord> {
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
    let stamped = stamp_trust(&context, TrustTable::TimelineEntries, row)?;
    let mut out = new.clone();
    out.trust.trust_tier =
        (stamped.tier != TrustTier::Unknown).then(|| stamped.tier.as_str().to_owned());
    out.trust.write_origin = match stamped.origin {
        OriginStamp::Keep => stored_origin,
        OriginStamp::Set(origin) => origin,
    };
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::TimelineReceipt;
    use crate::trust::WriteTrust;

    fn stamped(
        writer: Option<TrustTier>,
        origin: Option<Value>,
        old: Option<&TimelineRecord>,
        new: &TimelineRecord,
    ) -> TimelineRecord {
        let _trust = stamp_context::open(WriteTrust {
            writer,
            origin,
            ..WriteTrust::default()
        });
        stamp(old, new).unwrap()
    }

    fn record(summary: &str, trust: TimelineTrust) -> TimelineRecord {
        TimelineRecord {
            id: 7,
            page_id: 1,
            date: "2026-08-01".into(),
            source: "cal".into(),
            summary: summary.into(),
            detail: "d".into(),
            event_page_id: None,
            created_at_us: 5,
            receipt: TimelineReceipt::default(),
            trust,
        }
    }

    fn trust(tier: &str, origin: Value) -> TimelineTrust {
        TimelineTrust {
            trust_tier: Some(tier.into()),
            write_origin: Some(origin),
        }
    }

    #[test]
    fn an_insert_takes_the_declared_tier_and_origin_and_ignores_a_supplied_one() {
        let origin = json!({"kind": "cli"});
        let row = stamped(
            Some(TrustTier::AgentWritten),
            Some(origin.clone()),
            None,
            &record("s", trust("user_confirmed", json!({"kind": "forged"}))),
        );
        assert_eq!(row.trust, trust("agent_written", origin));
        // No declared tier: unknown, which is stored as no field at all.
        let bare = stamped(None, None, None, &record("s", TimelineTrust::default()));
        assert!(bare.trust.is_empty());
        let mut json = Map::new();
        bare.trust.extend_json(&mut json);
        assert_eq!(
            Value::Object(json),
            json!({"trust_tier": "unknown", "write_origin": null})
        );
    }

    #[test]
    fn an_update_lowers_the_tier_only_when_a_content_column_changed() {
        let stored = record("s", trust("operator_curated", json!({"kind": "owner"})));
        let origin = json!({"kind": "agent"});
        // The record a writer built carries no tier: the stored one stays when nothing changed.
        let same = stamped(
            Some(TrustTier::AgentWritten),
            Some(origin.clone()),
            Some(&stored),
            &record("s", TimelineTrust::default()),
        );
        assert_eq!(same.trust, stored.trust);
        let edited = stamped(
            Some(TrustTier::AgentWritten),
            Some(origin.clone()),
            Some(&stored),
            &record("t", TimelineTrust::default()),
        );
        assert_eq!(edited.trust, trust("agent_written", origin));
    }
}
