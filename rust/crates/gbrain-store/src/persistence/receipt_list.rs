//! The receipt list: `listWriteRequestRows` of `src/core/engine-sql/persistence-journal.ts`, the
//! candidate page `list_write_requests` reads (rust/docs/store/persistence.md, "Receipt list").
//!
//! The rows of one principal in one live source (the source exists, has the request's
//! incarnation and is not archived), newest sequence first, after the caller's cursor and through
//! its three fences. The per-row authorization, the scan budget and the paging stay with the
//! caller (`persistence/control.ts`). Text follows PGLite: `lower()` is `pg_text::pg_lower`, and
//! `left()` and `length()` count characters, not bytes.

use super::all_requests;
use crate::Store;
use crate::cli_reads::pg_text::{jsonb_text, pg_lower};
use crate::error::{Result, StoreError};
use crate::journal::{Principal, RequestRecord};
use crate::kv::KvRead;
use crate::sources::read_source;
use serde::Deserialize;
use serde_json::Value;

/// The filters of `listWriteRequestRows`. A `None` list skips its fence; an empty list matches no row.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WriteRequestListFilter {
    /// Only sequences below this one (the previous page's last), as decimal text.
    pub before: Option<String>,
    /// The most rows to return.
    pub limit: u32,
    /// Lower-case slug prefixes: one ending in `/` matches under it, any other matches the slug or under it.
    pub slug_prefixes: Option<Vec<String>>,
    /// The operations the caller may read, matched against `authority.attestedOp`, else `operation`.
    pub operations: Option<Vec<String>>,
    /// Exact slugs, or `<prefix>/*` for every slug under the prefix (case-sensitive).
    pub slug_allow_list: Option<Vec<String>>,
}

/// `left(text, n)`: the first `n` characters (all of them when `text` is shorter).
fn left(text: &str, n: usize) -> &str {
    text.char_indices().nth(n).map_or(text, |(i, _)| &text[..i])
}

/// The `$6` fence: `length(prefix)>0` and the prefix rule over `lower(slug)`.
fn prefix_matches(lower_slug: &str, prefix: &str) -> bool {
    let len = prefix.chars().count();
    if len == 0 {
        return false;
    }
    if prefix.ends_with('/') {
        left(lower_slug, len) == prefix
    } else {
        lower_slug == prefix || left(lower_slug, len + 1) == format!("{prefix}/")
    }
}

/// The `$8` fence: `<prefix>/*` compares the first `length(pattern)-1` characters, any other is exact.
fn allow_matches(slug: &str, pattern: &str) -> bool {
    if pattern.ends_with("/*") {
        let n = pattern.chars().count() - 1;
        left(slug, n) == left(pattern, n)
    } else {
        slug == pattern
    }
}

/// `COALESCE(authority->>'attestedOp', operation)`.
fn effective_operation(request: &RequestRecord) -> String {
    match request.authority.get("attestedOp") {
        None | Some(Value::Null) => request.operation.clone(),
        Some(Value::String(op)) => op.clone(),
        Some(other) => jsonb_text(other),
    }
}

fn listed(request: &RequestRecord, before: Option<u64>, filter: &WriteRequestListFilter) -> bool {
    let lower = pg_lower(&request.slug);
    before.is_none_or(|b| request.sequence < b)
        && filter
            .slug_prefixes
            .as_ref()
            .is_none_or(|prefixes| prefixes.iter().any(|p| prefix_matches(&lower, p)))
        && filter
            .operations
            .as_ref()
            .is_none_or(|ops| ops.contains(&effective_operation(request)))
        && filter
            .slug_allow_list
            .as_ref()
            .is_none_or(|patterns| patterns.iter().any(|p| allow_matches(&request.slug, p)))
}

pub(crate) fn list_write_request_rows_in(
    read: &dyn KvRead,
    principal: &Principal,
    source_id: &str,
    filter: &WriteRequestListFilter,
) -> Result<Vec<Value>> {
    let before =
        match &filter.before {
            None => None,
            Some(text) => Some(text.parse::<u64>().map_err(|_| {
                StoreError::invalid("listWriteRequestRows before is not a sequence")
            })?),
        };
    let Some(source) = read_source(read, source_id)? else {
        return Ok(Vec::new());
    };
    if source.archived {
        return Ok(Vec::new());
    }
    let mut rows: Vec<RequestRecord> = all_requests(read)?
        .into_iter()
        .filter(|r| {
            r.principal_kind == principal.kind
                && r.principal_id == principal.id
                && r.source_id == source_id
                && r.source_incarnation == source.incarnation
                && listed(r, before, filter)
        })
        .collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.sequence));
    rows.truncate(filter.limit as usize);
    Ok(rows.iter().map(RequestRecord::to_row).collect())
}

/// The filters of `listIncarnationRequests`: the request rows of one source incarnation that the
/// dream cycle's journal reads name (`listLaterPersistenceRequests`, `listCommittedOutputRequests`,
/// engine-sql/dream-cycle.ts). A `None` filter skips its fence.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IncarnationRequestFilter {
    pub source_id: String,
    pub incarnation: String,
    /// The exact slug (`slug=$3`).
    pub slug: Option<String>,
    /// Only sequences above this one, as decimal text (`sequence > $4`).
    pub after_sequence: Option<String>,
    /// The states to keep (`state IN (...)`).
    pub states: Option<Vec<String>>,
    /// The operation to keep (`operation='put_page'`).
    pub operation: Option<String>,
    /// Request ids, each a UUID compared as Postgres compares a `uuid` (`request_id=ANY($1::uuid[])`).
    pub request_ids: Option<Vec<String>>,
    /// Newest sequence first (`ORDER BY sequence DESC`); oldest first otherwise.
    pub newest_first: bool,
}

pub(crate) fn list_incarnation_requests_in(
    read: &dyn KvRead,
    filter: &IncarnationRequestFilter,
) -> Result<Vec<Value>> {
    let after = match &filter.after_sequence {
        None => None,
        Some(text) => Some(text.parse::<u64>().map_err(|_| {
            StoreError::invalid("listIncarnationRequests afterSequence is not a sequence")
        })?),
    };
    let ids = match &filter.request_ids {
        None => None,
        Some(ids) => Some(
            ids.iter()
                .map(|id| super::uuid_param(id, "listIncarnationRequests requestId"))
                .collect::<Result<Vec<_>>>()?,
        ),
    };
    let mut rows: Vec<RequestRecord> = all_requests(read)?
        .into_iter()
        .filter(|r| {
            r.source_id == filter.source_id
                && r.source_incarnation == filter.incarnation
                && filter.slug.as_ref().is_none_or(|slug| &r.slug == slug)
                && after.is_none_or(|a| r.sequence > a)
                && filter
                    .states
                    .as_ref()
                    .is_none_or(|states| states.contains(&r.state))
                && filter
                    .operation
                    .as_ref()
                    .is_none_or(|op| &r.operation == op)
                && ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&r.request_id.to_lowercase()))
        })
        .collect();
    if filter.newest_first {
        rows.sort_by_key(|r| std::cmp::Reverse(r.sequence));
    } else {
        rows.sort_by_key(|r| r.sequence);
    }
    Ok(rows.iter().map(RequestRecord::to_row).collect())
}

impl Store {
    /// `listWriteRequestRows(principalKind, principalId, sourceId, filter)`: full request rows,
    /// newest sequence first, at most `filter.limit`.
    pub fn list_write_request_rows(
        &self,
        principal: &Principal,
        source_id: &str,
        filter: &WriteRequestListFilter,
    ) -> Result<Vec<Value>> {
        list_write_request_rows_in(&*self.read()?, principal, source_id, filter)
    }

    /// `listIncarnationRequests(filter)`: the request rows of one source incarnation through the
    /// filter's fences, by sequence (the dream cycle's two journal reads).
    pub fn list_incarnation_requests(
        &self,
        filter: &IncarnationRequestFilter,
    ) -> Result<Vec<Value>> {
        list_incarnation_requests_in(&*self.read()?, filter)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn left_counts_characters() {
        assert_eq!(left("ééa", 2), "éé");
        assert_eq!(left("ab", 5), "ab");
        assert_eq!(left("ab", 0), "");
    }

    #[test]
    fn prefix_rules_follow_the_sql() {
        assert!(prefix_matches("wiki/a", "wiki/"));
        assert!(!prefix_matches("wikis/a", "wiki/"));
        assert!(prefix_matches("wiki", "wiki"));
        assert!(prefix_matches("wiki/a", "wiki"));
        assert!(!prefix_matches("wikis", "wiki"));
        assert!(!prefix_matches("wiki", ""));
    }

    #[test]
    fn allow_list_rules_follow_the_sql() {
        assert!(allow_matches("wiki/agents/7/a", "wiki/agents/7/*"));
        assert!(!allow_matches("wiki/agents/70/a", "wiki/agents/7/*"));
        assert!(allow_matches("wiki/agents/7/", "wiki/agents/7/*"));
        assert!(allow_matches("notes/x", "notes/x"));
        assert!(!allow_matches("Notes/x", "notes/x"));
    }
}
