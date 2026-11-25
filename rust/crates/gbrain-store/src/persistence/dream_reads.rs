//! The dream cycle's journal reads: the statements of `src/core/engine-sql/dream-cycle.ts` that
//! read `persistence_requests` after a synthesis child's put_page (rust/docs/store/dream.md).
//!
//! - `listLaterPersistenceRequests`: the requests on the output page after the child's put_page
//!   that are queued, running, recovering or committed, oldest first.
//! - `listCommittedOutputRequests`: the committed put_page rows of the retained calls' request ids
//!   in the cycle's source and incarnation, newest first, each as `{ request }`.
//!
//! Both read the whole request scan, as the other journal listings of this engine do.

use super::{all_requests, uuid_param};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use serde_json::{Value, json};

/// The states `listLaterPersistenceRequests` keeps (`state IN (...)`).
const LATER_STATES: &[&str] = &["queued", "running", "recovering", "committed"];

/// `sequence > $4`: the parameter as a bigint; anything else is refused, as the cast is.
fn sequence_param(text: &str) -> Result<i128> {
    text.trim().parse::<i128>().map_err(|_| {
        StoreError::invalid(format!(
            "listLaterPersistenceRequests: sequence is not an integer: {text}"
        ))
    })
}

pub(crate) fn list_later_persistence_requests_in(
    read: &dyn KvRead,
    source_id: &str,
    incarnation: &str,
    slug: &str,
    sequence: &str,
) -> Result<Vec<Value>> {
    let after = sequence_param(sequence)?;
    let mut rows: Vec<RequestRecord> = all_requests(read)?
        .into_iter()
        .filter(|r| {
            r.source_id == source_id
                && r.source_incarnation == incarnation
                && r.slug == slug
                && i128::from(r.sequence) > after
                && LATER_STATES.contains(&r.state.as_str())
        })
        .collect();
    rows.sort_by_key(|r| r.sequence);
    Ok(rows.iter().map(RequestRecord::to_row).collect())
}

pub(crate) fn list_committed_output_requests_in(
    read: &dyn KvRead,
    request_ids: &[String],
    source_id: &str,
    incarnation: &str,
) -> Result<Vec<Value>> {
    let mut wanted = Vec::with_capacity(request_ids.len());
    for id in request_ids {
        wanted.push(uuid_param(id, "listCommittedOutputRequests request id")?);
    }
    let mut rows: Vec<RequestRecord> = all_requests(read)?
        .into_iter()
        .filter(|r| {
            r.source_id == source_id
                && r.source_incarnation == incarnation
                && r.operation == "put_page"
                && r.state == "committed"
                && wanted.contains(&r.request_id.to_lowercase())
        })
        .collect();
    rows.sort_by_key(|a| std::cmp::Reverse(a.sequence));
    Ok(rows
        .iter()
        .map(|r| json!({ "request": r.to_row() }))
        .collect())
}

impl Store {
    /// `listLaterPersistenceRequests(sourceId, incarnation, slug, sequence)`.
    pub fn list_later_persistence_requests(
        &self,
        source_id: &str,
        incarnation: &str,
        slug: &str,
        sequence: &str,
    ) -> Result<Vec<Value>> {
        list_later_persistence_requests_in(&*self.read()?, source_id, incarnation, slug, sequence)
    }

    /// `listCommittedOutputRequests(requestIds, sourceId, incarnation)`.
    pub fn list_committed_output_requests(
        &self,
        request_ids: &[String],
        source_id: &str,
        incarnation: &str,
    ) -> Result<Vec<Value>> {
        list_committed_output_requests_in(&*self.read()?, request_ids, source_id, incarnation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sequence_that_is_not_an_integer_is_refused() {
        assert_eq!(sequence_param(" 42 ").unwrap(), 42);
        assert_eq!(sequence_param("-1").unwrap(), -1);
        assert!(sequence_param("4.5").is_err());
        assert!(sequence_param("").is_err());
    }
}
