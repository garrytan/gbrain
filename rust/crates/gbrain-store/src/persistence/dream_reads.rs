//! The dream cycle's journal reads (`src/core/engine-sql/dream-cycle.ts`): the requests on an
//! output page after a sequence (`listLaterPersistenceRequests`) and the committed `put_page`
//! rows of the retained calls (`listCommittedOutputRequests`). Both read every request record, as
//! the other journal scans of this engine do; requests are never deleted here.

use super::{all_requests, uuid_param};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use serde_json::{Value, json};

/// The states `listLaterPersistenceRequests` reads: the live ones and `committed`.
const LATER_STATES: [&str; 4] = ["queued", "running", "recovering", "committed"];

/// `source_incarnation=$n`: the column is a uuid, so the match ignores case.
fn same_incarnation(record: &RequestRecord, incarnation: &str) -> bool {
    record.source_incarnation.eq_ignore_ascii_case(incarnation)
}

/// A `sequence > $4` bound given as a number or as decimal text; anything else is refused, as
/// Postgres refuses the cast.
fn sequence_bound(after: &str) -> Result<i128> {
    after
        .trim()
        .parse::<i128>()
        .map_err(|_| StoreError::invalid("sequence is not an integer"))
}

fn later(
    record: &RequestRecord,
    source_id: &str,
    incarnation: &str,
    slug: &str,
    after: i128,
) -> bool {
    record.source_id == source_id
        && same_incarnation(record, incarnation)
        && record.slug == slug
        && i128::from(record.sequence) > after
        && LATER_STATES.contains(&record.state.as_str())
}

fn committed_output(
    record: &RequestRecord,
    ids: &[String],
    source_id: &str,
    incarnation: &str,
) -> bool {
    record.source_id == source_id
        && ids.contains(&record.request_id.to_lowercase())
        && same_incarnation(record, incarnation)
        && record.operation == "put_page"
        && record.state == "committed"
}

impl Store {
    /// `listLaterPersistenceRequests(sourceId, incarnation, slug, sequence)`: the queued, running,
    /// recovering and committed requests on the slug after `sequence`, in sequence order.
    pub fn list_later_persistence_requests(
        &self,
        source_id: &str,
        incarnation: &str,
        slug: &str,
        after: &str,
    ) -> Result<Vec<Value>> {
        let after = sequence_bound(after)?;
        let mut rows: Vec<RequestRecord> = all_requests(&*self.read()?)?
            .into_iter()
            .filter(|r| later(r, source_id, incarnation, slug, after))
            .collect();
        rows.sort_by_key(|r| r.sequence);
        Ok(rows.iter().map(RequestRecord::to_row).collect())
    }

    /// `listCommittedOutputRequests(requestIds, sourceId, incarnation)`: `{ request }` for each
    /// committed `put_page` request among `requestIds` in the source and incarnation, newest
    /// sequence first. Each id is a uuid; one that is not is refused, as the `::uuid[]` cast is.
    pub fn list_committed_output_requests(
        &self,
        request_ids: &[String],
        source_id: &str,
        incarnation: &str,
    ) -> Result<Vec<Value>> {
        let ids = request_ids
            .iter()
            .map(|id| uuid_param(id, "requestId"))
            .collect::<Result<Vec<_>>>()?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut rows: Vec<RequestRecord> = all_requests(&*self.read()?)?
            .into_iter()
            .filter(|r| committed_output(r, &ids, source_id, incarnation))
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.sequence));
        Ok(rows
            .iter()
            .map(|r| json!({ "request": r.to_row() }))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(state: &str, operation: &str, sequence: u64) -> RequestRecord {
        serde_json::from_value(json!({
            "id": "a0000000-0000-4000-8000-000000000001",
            "principal_kind": "local_cli",
            "principal_id": "p",
            "request_id": "B0000000-0000-4000-8000-000000000001",
            "operation": operation,
            "source_id": "default",
            "source_incarnation": "C0000000-0000-4000-8000-000000000001",
            "slug": "notes/a",
            "digest": "d",
            "intent": {},
            "authority": {},
            "sequence": sequence,
            "state": state,
            "created_at_us": 0,
            "updated_at_us": 0,
        }))
        .unwrap()
    }

    const INC: &str = "c0000000-0000-4000-8000-000000000001";

    #[test]
    fn later_reads_live_and_committed_requests_after_the_sequence() {
        assert!(later(
            &record("queued", "put_page", 2),
            "default",
            INC,
            "notes/a",
            1
        ));
        assert!(later(
            &record("committed", "delete_page", 2),
            "default",
            INC,
            "notes/a",
            1
        ));
        assert!(!later(
            &record("failed", "put_page", 2),
            "default",
            INC,
            "notes/a",
            1
        ));
        assert!(!later(
            &record("queued", "put_page", 1),
            "default",
            INC,
            "notes/a",
            1
        ));
        assert!(!later(
            &record("queued", "put_page", 2),
            "default",
            INC,
            "notes/b",
            1
        ));
        assert!(!later(
            &record("queued", "put_page", 2),
            "other",
            INC,
            "notes/a",
            1
        ));
    }

    #[test]
    fn committed_output_is_a_committed_put_page_of_a_named_request() {
        let ids = vec!["b0000000-0000-4000-8000-000000000001".to_string()];
        assert!(committed_output(
            &record("committed", "put_page", 1),
            &ids,
            "default",
            INC
        ));
        assert!(!committed_output(
            &record("committed", "delete_page", 1),
            &ids,
            "default",
            INC
        ));
        assert!(!committed_output(
            &record("failed", "put_page", 1),
            &ids,
            "default",
            INC
        ));
        assert!(!committed_output(
            &record("committed", "put_page", 1),
            &[],
            "default",
            INC
        ));
        assert!(!committed_output(
            &record("committed", "put_page", 1),
            &ids,
            "default",
            "c0000000-0000-4000-8000-000000000002"
        ));
    }

    #[test]
    fn the_sequence_bound_takes_a_number_or_decimal_text() {
        assert_eq!(sequence_bound("0").unwrap(), 0);
        assert_eq!(sequence_bound("42").unwrap(), 42);
        assert!(sequence_bound("x").is_err());
    }
}
