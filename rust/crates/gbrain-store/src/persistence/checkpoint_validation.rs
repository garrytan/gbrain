//! The managed sync checkpoint's validation reads (`readIncompleteSyncReceipt`, `readOpenPassWork` and
//! `readIncompleteSyncReceiptRows`, `src/core/engine-sql/checkpoint-validation.ts`;
//! rust/docs/store/persistence.md, "Checkpoint validation"): the receipt that blocks a run's checkpoint, the
//! open work that blocks a pass stamp, and the blocking receipts `sync status` lists.
//!
//! Each statement is a `UNION ALL` of index probes keyed on the request's worktree. A request here always
//! has a null `worktree_id` (an insert that names one refuses), so no request matches a worktree and each
//! read answers no blocker, as Postgres answers a worktree with no rows. The predicates are still
//! evaluated over the request records (the worktree and recovery the TypeScript journal members store in
//! `extra`), so a record that does carry them is judged as the SQL judges it; the unit tests below write
//! such records directly. The worktree and own-request arguments are checked as their `::uuid` casts check
//! them.
//!
//! Order. Each probe answers in the order the planner walks its index, which no statement fixes; here a
//! probe answers in sequence order and the probes follow the statement's `UNION ALL` order, so the first
//! row is the lowest-sequence recovery row, else the lowest-sequence open page receipt, else the
//! lowest-sequence failed one. `LIMIT` applies to each probe and to the union, as in the statement.

use super::effect_scans::host_uuid;
use super::{all_requests, extra_is_null, json_text};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

/// `IncompleteSyncReceiptSpec`: the worktree and run, the requests the run converted in place
/// (`$3`) and the cursor's settled index ranges (`$4`..`$5`, inclusive).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IncompleteSyncReceiptSpec {
    pub worktree_id: String,
    pub run_id: String,
    pub superseded: Vec<String>,
    pub ranges: Vec<(i64, i64)>,
}

/// `OpenPassWorkSpec`: the worktree, the stamp's own request id and whether its own recovery record
/// is exempt (the statement's `r.request_id<>$2::uuid` on the recovery probe).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenPassWorkSpec {
    pub worktree_id: String,
    pub self_request_id: String,
    pub own_recovery: bool,
}

/// How many blockers the status list shows.
const LIST_LIMIT: usize = 20;

/// `r.worktree_id = $1::uuid`.
fn on_worktree(r: &RequestRecord, worktree: &str) -> bool {
    json_text(r.extra.get("worktree_id")).is_some_and(|w| w.eq_ignore_ascii_case(worktree))
}

fn has_recovery(r: &RequestRecord) -> bool {
    !extra_is_null(r, "recovery")
}

/// `SYNC_PAGE_KINDS`: the two page kinds of a managed sync run.
fn is_page_kind(r: &RequestRecord) -> bool {
    matches!(
        json_text(r.intent.get("kind")).as_deref(),
        Some("managed_sync_import" | "managed_sync_delete")
    )
}

fn is_open(r: &RequestRecord) -> bool {
    matches!(r.state.as_str(), "queued" | "running" | "recovering")
}

fn in_run(r: &RequestRecord, run_id: &str) -> bool {
    json_text(r.intent.get("runId")).as_deref() == Some(run_id)
}

/// `(r.intent->>'index')::int`: an index that is not an integer refuses with the cast's message.
fn index_of(r: &RequestRecord) -> Result<Option<i32>> {
    match json_text(r.intent.get("index")) {
        None => Ok(None),
        Some(text) => text.trim().parse::<i32>().map(Some).map_err(|_| {
            StoreError::invalid(format!("invalid input syntax for type integer: \"{text}\""))
        }),
    }
}

/// The `LEFT JOIN LATERAL ... sibling`: a committed receipt of the same source and run at the same
/// index text (any worktree). A missing index on either side never matches (`NULL = NULL`).
fn has_committed_sibling(r: &RequestRecord, run_id: &str, all: &[RequestRecord]) -> bool {
    let Some(index) = json_text(r.intent.get("index")) else {
        return false;
    };
    all.iter().any(|c| {
        c.source_id == r.source_id
            && c.state == "committed"
            && in_run(c, run_id)
            && json_text(c.intent.get("index")).as_deref() == Some(index.as_str())
    })
}

/// A terminal, recovery-free receipt the cursor settled another way: converted in place, or at an
/// index inside a settled range.
fn settled_another_way(r: &RequestRecord, spec: &IncompleteSyncReceiptSpec) -> Result<bool> {
    if r.request_id_in(&spec.superseded) {
        return Ok(true);
    }
    if !matches!(r.state.as_str(), "failed" | "cancelled" | "conflict") || has_recovery(r) {
        return Ok(false);
    }
    if spec.ranges.is_empty() {
        return Ok(false);
    }
    let Some(index) = index_of(r)? else {
        return Ok(false);
    };
    Ok(spec
        .ranges
        .iter()
        .any(|(lo, hi)| (*lo..=*hi).contains(&i64::from(index))))
}

impl RequestRecord {
    /// `r.request_id::text = ANY($3::text[])`.
    fn request_id_in(&self, ids: &[String]) -> bool {
        ids.contains(&self.request_id)
    }
}

/// `incompleteSyncReceiptSql(limit)`: the request records of the three probes, in statement order.
fn incomplete_receipts<'a>(
    all: &'a [RequestRecord],
    spec: &IncompleteSyncReceiptSpec,
    limit: usize,
) -> Result<Vec<&'a RequestRecord>> {
    let worktree = &spec.worktree_id;
    let mut sorted: Vec<&RequestRecord> = all.iter().collect();
    sorted.sort_by_key(|r| r.sequence);
    let mut out: Vec<&RequestRecord> = sorted
        .iter()
        .copied()
        .filter(|r| on_worktree(r, worktree) && has_recovery(r))
        .take(limit)
        .collect();
    out.extend(
        sorted
            .iter()
            .copied()
            .filter(|r| {
                on_worktree(r, worktree)
                    && in_run(r, &spec.run_id)
                    && r.state != "committed"
                    && is_page_kind(r)
                    && is_open(r)
            })
            .take(limit),
    );
    let mut failed = Vec::new();
    for r in sorted.iter().copied() {
        if failed.len() >= limit {
            break;
        }
        if on_worktree(r, worktree)
            && in_run(r, &spec.run_id)
            && r.state != "committed"
            && is_page_kind(r)
            && !has_committed_sibling(r, &spec.run_id, all)
            && !settled_another_way(r, spec)?
        {
            failed.push(r);
        }
    }
    out.extend(failed);
    out.truncate(limit);
    Ok(out)
}

fn check_receipt_spec(spec: &IncompleteSyncReceiptSpec) -> Result<()> {
    host_uuid(&spec.worktree_id)
}

pub(crate) fn read_incomplete_sync_receipt_in(
    all: &[RequestRecord],
    spec: &IncompleteSyncReceiptSpec,
) -> Result<Option<String>> {
    check_receipt_spec(spec)?;
    Ok(incomplete_receipts(all, spec, 1)?
        .first()
        .map(|r| r.request_id.clone()))
}

pub(crate) fn read_open_pass_work_in(
    all: &[RequestRecord],
    spec: &OpenPassWorkSpec,
) -> Result<Option<String>> {
    host_uuid(&spec.worktree_id)?;
    host_uuid(&spec.self_request_id)?;
    let own = spec.self_request_id.to_lowercase();
    let worktree = &spec.worktree_id;
    let mut sorted: Vec<&RequestRecord> = all.iter().collect();
    sorted.sort_by_key(|r| r.sequence);
    let recovery = sorted.iter().copied().find(|r| {
        on_worktree(r, worktree)
            && has_recovery(r)
            && !(spec.own_recovery && r.request_id.to_lowercase() == own)
    });
    let open = || {
        sorted.iter().copied().find(|r| {
            on_worktree(r, worktree)
                && is_open(r)
                && r.request_id.to_lowercase() != own
                && matches!(
                    json_text(r.intent.get("kind")).as_deref(),
                    Some("managed_sync_import" | "managed_sync_delete" | "managed_sync_checkpoint")
                )
        })
    };
    Ok(recovery.or_else(open).map(|r| r.request_id.clone()))
}

pub(crate) fn read_incomplete_sync_receipt_rows_in(
    all: &[RequestRecord],
    spec: &IncompleteSyncReceiptSpec,
) -> Result<Vec<Value>> {
    check_receipt_spec(spec)?;
    let ids: HashSet<&str> = incomplete_receipts(all, spec, LIST_LIMIT)?
        .into_iter()
        .map(|r| r.request_id.as_str())
        .collect();
    let mut rows: Vec<&RequestRecord> = all
        .iter()
        .filter(|r| ids.contains(r.request_id.as_str()))
        .collect();
    rows.sort_by_key(|r| r.sequence);
    rows.truncate(LIST_LIMIT);
    rows.into_iter()
        .map(|r| {
            Ok(json!({
                "request_id": r.request_id,
                "slug": r.slug,
                "state": r.state,
                "code": r.error_code,
                "index": index_of(r)?,
                "recovery": has_recovery(r),
            }))
        })
        .collect()
}

impl Store {
    /// `readIncompleteSyncReceipt(spec)`: the request id of a receipt that blocks the run's
    /// checkpoint, or none.
    pub fn read_incomplete_sync_receipt(
        &self,
        spec: &IncompleteSyncReceiptSpec,
    ) -> Result<Option<String>> {
        read_incomplete_sync_receipt_in(&all_requests(&*self.read()?)?, spec)
    }

    /// `readOpenPassWork(spec)`: the request id of the work that blocks a pass stamp, or none.
    pub fn read_open_pass_work(&self, spec: &OpenPassWorkSpec) -> Result<Option<String>> {
        read_open_pass_work_in(&all_requests(&*self.read()?)?, spec)
    }

    /// `readIncompleteSyncReceiptRows(spec)`: up to 20 blocking receipts, in sequence order.
    pub fn read_incomplete_sync_receipt_rows(
        &self,
        spec: &IncompleteSyncReceiptSpec,
    ) -> Result<Vec<Value>> {
        read_incomplete_sync_receipt_rows_in(&all_requests(&*self.read()?)?, spec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: &str = "a1000000-0000-4000-8000-000000000001";
    const OTHER_W: &str = "a1000000-0000-4000-8000-000000000002";
    const SELF: &str = "f0000000-0000-4000-8000-0000000000f1";

    fn id(n: u64) -> String {
        format!("b1000000-0000-4000-8000-{n:012}")
    }

    /// A request record as the TypeScript journal members store it, with the worktree and recovery in `extra`.
    fn record(
        n: u64,
        worktree: Option<&str>,
        state: &str,
        kind: &str,
        run: &str,
        index: u64,
    ) -> Value {
        json!({
            "id": format!("c1000000-0000-4000-8000-{n:012}"),
            "principal_kind": "local_cli", "principal_id": "p", "request_id": id(n),
            "operation": "submit_job", "source_id": "default", "source_incarnation": "i",
            "slug": format!("notes/{n}"), "digest": "d",
            "intent": { "kind": kind, "runId": run, "index": index },
            "authority": {}, "sequence": n, "state": state,
            "created_at_us": 0, "updated_at_us": 0,
            "worktree_id": worktree,
        })
    }

    fn records(rows: Vec<Value>) -> Vec<RequestRecord> {
        rows.into_iter()
            .map(|v| serde_json::from_value(v).expect("a request record"))
            .collect()
    }

    fn with(mut row: Value, key: &str, value: Value) -> Value {
        row[key] = value;
        row
    }

    fn spec(superseded: &[u64], ranges: &[(i64, i64)]) -> IncompleteSyncReceiptSpec {
        IncompleteSyncReceiptSpec {
            worktree_id: W.into(),
            run_id: "run".into(),
            superseded: superseded.iter().map(|n| id(*n)).collect(),
            ranges: ranges.to_vec(),
        }
    }

    fn pass(own: &str, own_recovery: bool) -> OpenPassWorkSpec {
        OpenPassWorkSpec {
            worktree_id: W.into(),
            self_request_id: own.into(),
            own_recovery,
        }
    }

    fn page(n: u64, state: &str, index: u64) -> Value {
        record(n, Some(W), state, "managed_sync_import", "run", index)
    }

    #[test]
    fn a_request_without_a_worktree_blocks_nothing() {
        let all = records(vec![record(
            1,
            None,
            "queued",
            "managed_sync_import",
            "run",
            0,
        )]);
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[], &[])).unwrap(),
            None
        );
        assert_eq!(
            read_open_pass_work_in(&all, &pass(SELF, false)).unwrap(),
            None
        );
        assert!(
            read_incomplete_sync_receipt_rows_in(&all, &spec(&[], &[]))
                .unwrap()
                .is_empty()
        );
        let none = records(vec![record(
            1,
            Some(OTHER_W),
            "queued",
            "managed_sync_import",
            "run",
            0,
        )]);
        assert_eq!(
            read_incomplete_sync_receipt_in(&none, &spec(&[], &[])).unwrap(),
            None
        );
    }

    #[test]
    fn an_open_receipt_blocks_and_a_committed_one_does_not() {
        let all = records(vec![
            page(1, "committed", 0),
            page(2, "queued", 1),
            page(3, "running", 2),
        ]);
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[], &[])).unwrap(),
            Some(id(2))
        );
        // Another run's open receipt is not this run's.
        let mut other = spec(&[], &[]);
        other.run_id = "other".into();
        assert_eq!(read_incomplete_sync_receipt_in(&all, &other).unwrap(), None);
        // Superseding does not release an open receipt.
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[2], &[])).unwrap(),
            Some(id(2))
        );
    }

    #[test]
    fn a_failed_receipt_blocks_until_superseded_or_settled() {
        let all = records(vec![page(1, "failed", 5)]);
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[], &[])).unwrap(),
            Some(id(1))
        );
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[1], &[])).unwrap(),
            None
        );
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[], &[(3, 7)])).unwrap(),
            None
        );
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[], &[(5, 5)])).unwrap(),
            None
        );
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[], &[(6, 9), (0, 4)])).unwrap(),
            Some(id(1))
        );
        // A settled range does not skip a receipt that records a recovery.
        let with_recovery = records(vec![with(
            page(1, "failed", 5),
            "recovery",
            json!({ "version": 1 }),
        )]);
        assert_eq!(
            read_incomplete_sync_receipt_in(&with_recovery, &spec(&[], &[(3, 7)])).unwrap(),
            Some(id(1))
        );
    }

    #[test]
    fn a_committed_sibling_at_the_index_releases_a_failed_receipt() {
        let all = records(vec![
            page(1, "failed", 2),
            page(2, "cancelled", 3),
            page(3, "committed", 2),
            page(4, "committed", 3),
        ]);
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[], &[])).unwrap(),
            None
        );
        let lone = records(vec![page(1, "failed", 2), page(3, "committed", 9)]);
        assert_eq!(
            read_incomplete_sync_receipt_in(&lone, &spec(&[], &[])).unwrap(),
            Some(id(1))
        );
        // A sibling of another source or another run does not count.
        let mut elsewhere = page(3, "committed", 2);
        elsewhere["source_id"] = json!("other");
        let all = records(vec![page(1, "failed", 2), elsewhere]);
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[], &[])).unwrap(),
            Some(id(1))
        );
    }

    #[test]
    fn a_recovery_row_blocks_every_run_and_comes_first() {
        let recovering = with(
            record(9, Some(W), "committed", "put_page", "x", 0),
            "recovery",
            json!({ "version": 1 }),
        );
        let all = records(vec![page(1, "queued", 0), recovering]);
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[], &[])).unwrap(),
            Some(id(9))
        );
        assert_eq!(
            read_open_pass_work_in(&all, &pass(SELF, false)).unwrap(),
            Some(id(9))
        );
        assert_eq!(
            read_open_pass_work_in(&all, &pass(&id(9), false)).unwrap(),
            Some(id(9))
        );
        // The folded stamp's own recovery is exempt; the open page receipt then blocks.
        assert_eq!(
            read_open_pass_work_in(&all, &pass(&id(9), true)).unwrap(),
            Some(id(1))
        );
        assert_eq!(
            read_open_pass_work_in(&all, &pass(SELF, true)).unwrap(),
            Some(id(9))
        );
    }

    #[test]
    fn open_pass_work_is_another_open_managed_sync_request() {
        let all = records(vec![
            record(1, Some(W), "committed", "managed_sync_checkpoint", "r", 0),
            record(2, Some(W), "queued", "put_page", "r", 0),
            record(3, Some(OTHER_W), "queued", "managed_sync_import", "r", 0),
            record(4, Some(W), "recovering", "managed_sync_delete", "r", 0),
            record(5, Some(W), "running", "managed_sync_checkpoint", "r", 0),
        ]);
        assert_eq!(
            read_open_pass_work_in(&all, &pass(SELF, false)).unwrap(),
            Some(id(4))
        );
        assert_eq!(
            read_open_pass_work_in(&all, &pass(&id(4), false)).unwrap(),
            Some(id(5))
        );
        let only_self = records(vec![record(
            5,
            Some(W),
            "running",
            "managed_sync_checkpoint",
            "r",
            0,
        )]);
        assert_eq!(
            read_open_pass_work_in(&only_self, &pass(&id(5), false)).unwrap(),
            None
        );
        // A request id compares as the uuid cast does: without regard to case.
        assert_eq!(
            read_open_pass_work_in(&only_self, &pass(&id(5).to_uppercase(), false)).unwrap(),
            None
        );
    }

    #[test]
    fn the_list_is_capped_in_sequence_order_with_what_status_shows() {
        let mut rows: Vec<Value> = (1..=25).map(|n| page(n, "queued", n - 1)).collect();
        rows[0] = with(
            with(page(1, "failed", 0), "error_code", json!("write_failed")),
            "recovery",
            json!({ "version": 1 }),
        );
        // Insert out of order: the list follows `sequence`, not the stored order.
        rows.reverse();
        let all = records(rows);
        let list = read_incomplete_sync_receipt_rows_in(&all, &spec(&[], &[])).unwrap();
        assert_eq!(list.len(), 20);
        assert_eq!(
            list[0],
            json!({ "request_id": id(1), "slug": "notes/1", "state": "failed", "code": "write_failed", "index": 0, "recovery": true })
        );
        assert_eq!(list[19]["request_id"], json!(id(20)));
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &spec(&[], &[])).unwrap(),
            Some(id(1))
        );
    }

    #[test]
    fn an_argument_the_uuid_cast_refuses_refuses_here_too() {
        let all = records(Vec::new());
        let bad = IncompleteSyncReceiptSpec {
            worktree_id: "nope".into(),
            ..spec(&[], &[])
        };
        assert_eq!(
            read_incomplete_sync_receipt_in(&all, &bad)
                .unwrap_err()
                .message,
            "invalid input syntax for type uuid: \"nope\""
        );
        assert!(read_incomplete_sync_receipt_rows_in(&all, &bad).is_err());
        let bad_pass = OpenPassWorkSpec {
            worktree_id: "nope".into(),
            ..pass(SELF, false)
        };
        assert!(read_open_pass_work_in(&all, &bad_pass).is_err());
        let bad_self = pass("nope", false);
        assert_eq!(
            read_open_pass_work_in(&all, &bad_self).unwrap_err().message,
            "invalid input syntax for type uuid: \"nope\""
        );
    }
}
