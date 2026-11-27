//! Takes: the two writes of the takes publication's prepare step
//! (`src/core/persistence/takes-prepare.ts`) and the holder read of a remote takes write's
//! authority check (`src/core/persistence/authority.ts`). Each is one `BrainEngine` member
//! (`src/core/engine-sql/takes-reads.ts`); the result matches its SQL row for row. Carried from
//! 098c048ad683be0220c0cea6bfa96b6310523f8e (rust-engine/takes-prepare-rust).
//!
//! Members: listTakeHoldersAtRows, stampTakeResolvedAt, recordTakeHoldersUsed.
//!
//! `stampTakeResolvedAt` moves only `resolved_at`, as its SQL sets only that column.
//! `recordTakeHoldersUsed` sets `authority.takeHoldersUsed` of a stored request and leaves its
//! `updated_at`; a request that is not stored is left alone, as an `UPDATE` that matches no row.

use super::{store_take, take_at};
use crate::error::{Result, StoreError};
use crate::journal::{RequestRecord, write_request};
use crate::persistence::uuid_param;
use crate::{Store, get_json, keys};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `<text>::timestamptz` with TimeZone UTC for the forms the prepare step passes: a date
/// (`2026-11-20`, midnight) and an ISO or `now()::text` time.
fn resolved_at_micros(text: &str) -> Result<i64> {
    let t = text.trim();
    if t.len() == 10 {
        return crate::env::parse_iso(&format!("{t}T00:00:00Z")).ok_or_else(|| {
            StoreError::invalid(format!("resolvedAt is not a timestamp: {text:?}"))
        });
    }
    crate::persistence::projection_queue::parse_timestamptz(t, "resolvedAt")
}

impl Store {
    /// `listTakeHoldersAtRows(pageId, rowNums)`: the distinct holders of the page's takes at those
    /// row numbers, sorted (the SQL's `DISTINCT` sets no order; the caller reads a set).
    pub fn list_take_holders_at_rows(&self, page_id: i64, row_nums: &[i64]) -> Result<Vec<String>> {
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let mut holders = BTreeSet::new();
        for &n in row_nums {
            let Ok(n) = i32::try_from(n) else { continue };
            if let Some(take) = take_at(&*read, page_id, n)? {
                holders.insert(take.holder);
            }
        }
        Ok(holders.into_iter().collect())
    }

    /// `stampTakeResolvedAt(pageId, rowNum, resolvedAt)`: sets the take's `resolved_at`; no take
    /// at the row number writes nothing. Text that is not a time is refused before any write.
    pub fn stamp_take_resolved_at(
        &self,
        page_id: i64,
        row_num: i64,
        resolved_at: &str,
    ) -> Result<()> {
        let at = resolved_at_micros(resolved_at)?;
        let (Ok(page_id), Ok(row_num)) = (u64::try_from(page_id), i32::try_from(row_num)) else {
            return Ok(());
        };
        self.write(|tx| {
            if let Some(mut take) = take_at(&*tx, page_id, row_num)? {
                take.resolved_at_us = Some(at);
                store_take(tx, &take)?;
            }
            Ok(())
        })
    }

    /// `recordTakeHoldersUsed(requestId, holders)`: stores `holders` as the request's
    /// `authority.takeHoldersUsed`, in the order given.
    pub fn record_take_holders_used(&self, request_id: &str, holders: &[String]) -> Result<()> {
        let id = uuid_param(request_id, "id")?;
        self.write(|tx| {
            let Some(mut request) = get_json::<RequestRecord>(&*tx, &keys::request(&id))? else {
                return Ok(());
            };
            // jsonb_set on an authority that is not an object leaves it as it is.
            if let Value::Object(authority) = &mut request.authority {
                authority.insert("takeHoldersUsed".into(), json!(holders));
                write_request(tx, &request)?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::parse_iso;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::takes::TakeInput;
    use crate::test_support::store;

    fn page_with_take(store: &Store) -> u64 {
        let input: PageInput =
            serde_json::from_value(json!({"type": "note", "title": "p", "compiled_truth": "x"}))
                .unwrap();
        let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
        store.put_page("notes/p", &input, &opts).unwrap();
        let id = crate::pages::read_page(&*store.read().unwrap(), "default", "notes/p")
            .unwrap()
            .unwrap()
            .id;
        let take: TakeInput = serde_json::from_value(json!({
            "page_id": id, "row_num": 1, "claim": "Ships weekly", "kind": "take", "holder": "world",
            "weight": 0.5, "active": true,
        }))
        .unwrap();
        store.add_takes_batch(&[take]).unwrap();
        id
    }

    #[test]
    fn resolved_at_reads_a_date_and_a_time() {
        assert_eq!(
            resolved_at_micros("2026-11-20").unwrap(),
            parse_iso("2026-11-20T00:00:00Z").unwrap()
        );
        assert_eq!(
            resolved_at_micros("2026-11-20T08:30:00.5Z").unwrap(),
            parse_iso("2026-11-20T08:30:00.5Z").unwrap()
        );
        assert!(resolved_at_micros("next week").is_err());
    }

    #[test]
    fn stamps_only_the_take_at_the_row_number() {
        let store = store();
        let page = page_with_take(&store);
        let before = take_at(&*store.read().unwrap(), page, 1).unwrap().unwrap();
        store
            .stamp_take_resolved_at(page as i64, 1, "2026-11-20")
            .unwrap();
        let after = take_at(&*store.read().unwrap(), page, 1).unwrap().unwrap();
        assert_eq!(after.resolved_at_us, parse_iso("2026-11-20T00:00:00Z"));
        assert_eq!(after.updated_at_us, before.updated_at_us);
        store
            .stamp_take_resolved_at(page as i64, 9, "2026-11-20")
            .unwrap();
        store.stamp_take_resolved_at(-1, 1, "2026-11-20").unwrap();
        assert!(
            store
                .stamp_take_resolved_at(page as i64, 1, "soon")
                .is_err()
        );
    }

    #[test]
    fn lists_the_distinct_holders_at_the_row_numbers() {
        let store = store();
        let page = page_with_take(&store);
        let take: TakeInput = serde_json::from_value(json!({
            "page_id": page, "row_num": 2, "claim": "Hires slowly", "kind": "take", "holder": "alice-example",
            "weight": 0.5, "active": true,
        }))
        .unwrap();
        store.add_takes_batch(&[take]).unwrap();
        let p = page as i64;
        assert_eq!(
            store.list_take_holders_at_rows(p, &[1, 2, 2, 9]).unwrap(),
            vec!["alice-example".to_string(), "world".to_string()]
        );
        assert_eq!(
            store.list_take_holders_at_rows(p, &[1]).unwrap(),
            vec!["world".to_string()]
        );
        assert!(store.list_take_holders_at_rows(p, &[9]).unwrap().is_empty());
        assert!(
            store
                .list_take_holders_at_rows(-1, &[1])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_request_that_is_not_stored_is_left_alone() {
        let store = store();
        store
            .record_take_holders_used("00000000-0000-4000-8000-000000000001", &["world".into()])
            .unwrap();
        assert!(store.record_take_holders_used("not-a-uuid", &[]).is_err());
    }
}
