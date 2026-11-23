//! The write receipt of a timeline entry: the seven attribution columns of `timeline_entries`
//! that `gbrain_stamp_write_attribution` (persistence/attribution-schema.ts) stamps.
//!
//! - Insert: under a principal (`gbrain.write_principal_kind` set), `write_*` and `last_*` take
//!   the request, the principal kind and the principal id, and `last_written_at` the transaction
//!   time. With no principal the row keeps what it was given (every column null).
//! - Update: `write_*` keep the stored values when any is set. When the content tuple (id, page,
//!   date, source, summary, detail, event page, `created_at`) changed, `last_*` take the actor of
//!   this write (null when there is none) and `last_written_at` the transaction time; otherwise
//!   they keep the stored values.
//!
//! The actor comes from the open write's context (`write_trust::stamp_context`, its
//! [`WriteAttribution`]), the time from `env::transaction_clock`: one time per transaction, as
//! `now()` is. Keys: none; the receipt is part of the `E` record. The stamp itself is
//! [`WriteReceipt::stamp`], which facts and takes share.

use super::TimelineRecord;
use crate::error::Result;
use crate::write_receipt::WriteReceipt;

/// The content tuple the trigger compares (`WRITE_ATTRIBUTION_CONTENT_COLUMNS.timeline_entries`).
fn content_changed(old: &TimelineRecord, new: &TimelineRecord) -> bool {
    (
        old.id,
        old.page_id,
        &old.date,
        &old.source,
        &old.summary,
        &old.detail,
        old.event_page_id,
        old.created_at_us,
    ) != (
        new.id,
        new.page_id,
        &new.date,
        &new.source,
        &new.summary,
        &new.detail,
        new.event_page_id,
        new.created_at_us,
    )
}

/// `new` as the attribution trigger leaves it: an insert when `old` is `None`, else an update of
/// `old` (the module rules). A `gbrain.write_request` that is not a UUID is `invalid_argument`
/// for every write, as the trigger casts it with `::uuid` before it reads anything else.
pub(crate) fn stamp(old: Option<&TimelineRecord>, new: &TimelineRecord) -> Result<TimelineRecord> {
    let changed = old.is_some_and(|old| content_changed(old, new));
    let mut out = new.clone();
    out.receipt = WriteReceipt::stamp(old.map(|o| &o.receipt), &new.receipt, changed)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::Env;
    use crate::env::transaction_clock;
    use crate::error::INVALID_ARGUMENT;
    use crate::timeline::TimelineReceipt;
    use crate::timeline::{AddTimelineOptions, TimelineInput, TimelineOptions};
    use crate::timeline_queries::TimelineDetailRefresh;
    use crate::trust::WriteTrust;
    use crate::write_trust::{WRITE_PRINCIPAL_ID, WRITE_PRINCIPAL_KIND, WRITE_REQUEST};
    use crate::write_trust::{WriteAttribution, stamp_context};
    use serde_json::{Value, json};
    use std::sync::Arc;

    struct At(i64);
    impl Env for At {
        fn now_micros(&self) -> i64 {
            self.0
        }
        fn new_uuid(&self) -> String {
            String::new()
        }
    }

    const R1: &str = "0b9c4f0e-1a2b-4c3d-8e4f-5a6b7c8d9e01";
    const R2: &str = "0b9c4f0e-1a2b-4c3d-8e4f-5a6b7c8d9e02";

    fn actor(request: Option<&str>, kind: &str, id: &str) -> WriteAttribution {
        WriteAttribution {
            request_id: request.map(str::to_string),
            principal_kind: Some(kind.into()),
            principal_id: Some(id.into()),
        }
    }

    /// `stamp` inside a write whose actor is `who` and whose transaction time is `at`.
    fn stamped(
        who: WriteAttribution,
        at: i64,
        old: Option<&TimelineRecord>,
        new: &TimelineRecord,
    ) -> TimelineRecord {
        let _trust = stamp_context::open(WriteTrust {
            attribution: who,
            ..WriteTrust::default()
        });
        let _clock = transaction_clock::open(Arc::new(At(at)));
        stamp(old, new).unwrap()
    }

    fn record(detail: &str) -> TimelineRecord {
        TimelineRecord {
            id: 7,
            page_id: 1,
            date: "2026-08-01".into(),
            source: "cal".into(),
            summary: "s".into(),
            detail: detail.into(),
            event_page_id: None,
            created_at_us: 5,
            receipt: TimelineReceipt::default(),
            trust: crate::timeline::TimelineTrust::default(),
        }
    }

    fn receipt(
        w: (Option<&str>, &str, &str),
        l: (Option<&str>, &str, &str),
        at: i64,
    ) -> TimelineReceipt {
        TimelineReceipt {
            write_request_id: w.0.map(str::to_string),
            write_principal_kind: Some(w.1.into()),
            write_principal_id: Some(w.2.into()),
            last_write_request_id: l.0.map(str::to_string),
            last_write_principal_kind: Some(l.1.into()),
            last_write_principal_id: Some(l.2.into()),
            last_written_at_us: Some(at),
        }
    }

    #[test]
    fn an_insert_under_a_principal_stamps_write_and_last_and_one_with_none_stamps_nothing() {
        let a = (Some(R1), "application", "host:a");
        let row = stamped(actor(a.0, a.1, a.2), 100, None, &record("d"));
        assert_eq!(row.receipt, receipt(a, a, 100));
        // A principal id or a request with no principal kind is no principal.
        let orphan = WriteAttribution {
            request_id: Some(R1.into()),
            principal_kind: None,
            principal_id: Some("host:a".into()),
        };
        assert!(stamped(orphan, 100, None, &record("d")).receipt.is_empty());
        assert!(
            stamped(WriteAttribution::default(), 100, None, &record("d"))
                .receipt
                .is_empty()
        );
    }

    #[test]
    fn an_update_keeps_write_and_moves_last_only_when_the_content_changed() {
        let (a, b) = (
            (Some(R1), "application", "host:a"),
            (Some(R2), "oauth_client", "client:b"),
        );
        let stored = TimelineRecord {
            receipt: receipt(a, a, 100),
            ..record("before")
        };
        let edited = stamped(actor(b.0, b.1, b.2), 200, Some(&stored), &record("after"));
        assert_eq!(edited.receipt, receipt(a, b, 200));
        // The same content: last_* and the time stay.
        let same = stamped(actor(b.0, b.1, b.2), 300, Some(&stored), &stored);
        assert_eq!(same.receipt, receipt(a, a, 100));
        // A change with no principal clears last_* and still moves the time.
        let cleared = stamped(
            WriteAttribution::default(),
            400,
            Some(&stored),
            &record("after"),
        );
        let mut want = receipt(a, a, 400);
        want.last_write_request_id = None;
        want.last_write_principal_kind = None;
        want.last_write_principal_id = None;
        assert_eq!(cleared.receipt, want);
        // Every content column counts, created_at included.
        let moved = TimelineRecord {
            created_at_us: 6,
            ..stored.clone()
        };
        assert_eq!(
            stamped(actor(b.0, b.1, b.2), 500, Some(&stored), &moved).receipt,
            receipt(a, b, 500)
        );
    }

    #[test]
    fn an_update_of_an_unattributed_row_does_not_stamp_write() {
        let b = (Some(R2), "oauth_client", "client:b");
        let edited = stamped(
            actor(b.0, b.1, b.2),
            200,
            Some(&record("before")),
            &record("after"),
        );
        assert_eq!(edited.receipt.write_principal_kind, None);
        assert_eq!(
            edited.receipt.last_write_principal_id.as_deref(),
            Some("client:b")
        );
    }

    #[test]
    fn a_request_that_is_not_a_uuid_refuses_every_write() {
        let old = stamped(
            actor(Some(R1), "application", "host:a"),
            1,
            None,
            &record("d"),
        );
        for (who, old) in [
            (actor(Some("req-1"), "application", "host:a"), None),
            (actor(Some("r1"), "application", "host:a"), Some(&old)),
            (
                WriteAttribution {
                    request_id: Some("0b9c4f0e-1a2b-4c3d-8e4f-5a6b7c8d9e0".into()),
                    ..WriteAttribution::default()
                },
                None,
            ),
        ] {
            let _trust = stamp_context::open(WriteTrust {
                attribution: who,
                ..WriteTrust::default()
            });
            let _clock = transaction_clock::open(Arc::new(At(2)));
            let err = stamp(old, &record("e")).unwrap_err();
            assert_eq!(err.code, INVALID_ARGUMENT);
        }
    }

    #[test]
    fn a_stamp_outside_a_write_refuses() {
        let err = stamp(None, &record("d")).unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
    }

    #[test]
    fn the_store_paths_stamp_and_get_timeline_returns_the_receipt() {
        let store = crate::test_support::store();
        let input = crate::pages::PageInput {
            page_type: "note".into(),
            title: "a".into(),
            compiled_truth: "body".into(),
            ..crate::pages::PageInput::default()
        };
        store
            .put_page("a", &input, &crate::pages::PutPageOptions::default())
            .unwrap();
        let names = |v: [&str; 3]| v.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        store
            .apply_write_trust(
                &names([WRITE_REQUEST, WRITE_PRINCIPAL_KIND, WRITE_PRINCIPAL_ID]),
                &names([R1, "application", "host:a"]),
            )
            .unwrap();
        let add = TimelineInput {
            date: Some("2026-08-01".into()),
            source: None,
            summary: Some("s".into()),
            detail: Some("before".into()),
        };
        store
            .add_timeline_entry("a", &add, &AddTimelineOptions::default())
            .unwrap();
        store.clear_write_trust();
        let rows = store
            .get_timeline("a", &TimelineOptions::default())
            .unwrap();
        let row = &rows[0];
        assert_eq!(row["write_request_id"], R1);
        assert_eq!(row["last_write_principal_id"], "host:a");
        assert!(row["last_written_at"].is_string());
        let page_id = row["page_id"].as_i64().unwrap();
        store
            .update_timeline_details(
                page_id,
                &[TimelineDetailRefresh {
                    id: row["id"].clone(),
                    detail: Some("before".into()),
                    next: Some("after".into()),
                }],
            )
            .unwrap();
        let rows = store
            .get_timeline("a", &TimelineOptions::default())
            .unwrap();
        let row = &rows[0];
        assert_eq!(
            (
                row["write_principal_id"].clone(),
                row["last_write_principal_id"].clone()
            ),
            (json!("host:a"), Value::Null)
        );
        assert!(row["last_written_at"].is_string());
    }
}
