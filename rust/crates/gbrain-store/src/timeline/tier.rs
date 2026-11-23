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

use super::TimelineRecord;
use crate::error::Result;
pub(crate) use crate::trust::RowTrust as TimelineTrust;
use crate::trust::TrustTable;
use crate::trust::stamp_row;

fn content_changed(old: &TimelineRecord, new: &TimelineRecord) -> bool {
    (&old.summary, &old.detail, &old.date) != (&new.summary, &new.detail, &new.date)
}

/// `new` with the tier and origin the trigger would store, under the open write's trust context.
pub(crate) fn stamp(old: Option<&TimelineRecord>, new: &TimelineRecord) -> Result<TimelineRecord> {
    let mut out = new.clone();
    out.trust = stamp_row(
        TrustTable::TimelineEntries,
        old.map(|o| &o.trust),
        &new.trust,
        old.is_some_and(|o| content_changed(o, new)),
    )?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::TimelineReceipt;
    use crate::trust::{TrustTier, WriteTrust};
    use crate::write_trust::stamp_context;
    use serde_json::{Map, Value, json};

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
