//! The request reads of the managed-sync orphan classification (`src/core/engine-sql/managed-sync-orphans.ts`):
//! one source's `persistence_requests` rows with the columns its predicates test
//! (rust/docs/store/repair-bookkeeping.md, "Managed-sync orphans"). The TypeScript store member
//! evaluates the predicates over these rows and the op checkpoint listing.

use super::{all_requests, extra_is_null};
use crate::Store;
use crate::error::Result;
use crate::kv::KvRead;
use serde_json::{Value, json};

/// `listSourceRequestRows(sourceId)`: every request of the source as `{ request_id,
/// source_incarnation, state, recovery, error_code, error_message, intent, sequence,
/// principal_kind, principal_id }`, in sequence order. `recovery` is whether the request's
/// `recovery` column is not null.
pub(crate) fn list_source_request_rows_in(read: &dyn KvRead, source_id: &str) -> Result<Value> {
    let mut rows: Vec<_> = all_requests(read)?
        .into_iter()
        .filter(|r| r.source_id == source_id)
        .collect();
    rows.sort_by_key(|r| r.sequence);
    Ok(Value::Array(
        rows.iter()
            .map(|r| {
                json!({
                    "request_id": r.request_id,
                    "source_incarnation": r.source_incarnation,
                    "state": r.state,
                    "recovery": !extra_is_null(r, "recovery"),
                    "error_code": r.error_code,
                    "error_message": r.error_message,
                    "intent": r.intent,
                    "sequence": r.sequence,
                    "principal_kind": r.principal_kind,
                    "principal_id": r.principal_id,
                })
            })
            .collect(),
    ))
}

impl Store {
    /// `listSourceRequestRows(sourceId)`.
    pub fn list_source_request_rows(&self, source_id: &str) -> Result<Value> {
        list_source_request_rows_in(&*self.read()?, source_id)
    }
}
