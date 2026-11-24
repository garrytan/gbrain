//! The plan reads of `gbrain repair attribution-backfill` (`listProvenAttributionTargets`,
//! `countUnfilledAttribution`, `src/core/engine-sql/repair-plan-scans.ts`;
//! rust/docs/store/repair-bookkeeping.md, "Attribution backfill").
//!
//! A row is unfilled while its request id and principal kind are both null: `pages.revision_*`,
//! `page_versions.write_*` (joined to a page of the scope), `facts.write_*`. A committed request
//! proves a page or version row when its `outcome->>'revision'` is the row's knowledge revision,
//! its source is the page's, and it changed the page (a page mutation that reports a change, or
//! a fenced `remember` whose fact is still fenced on the request's page). It proves a fact when it
//! is a committed `remember` that inserted or superseded that fact id in the fact's source. A row
//! is a target only when exactly one request proves it, as the SQL's `HAVING count(*) = 1`.

use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::error::{Result, StoreError};
use crate::facts::{read_fact, source_rows};
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use crate::pages::all_pages;
use crate::persistence::all_requests;
use crate::trust::tier_reads::all_versions;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const PAGE_OPERATIONS: [&str; 7] = [
    "put_page",
    "capture",
    "edit_page",
    "append_page",
    "delete_page",
    "restore_page",
    "revert_version",
];
const PAGE_STATUSES: [&str; 4] = ["created_or_updated", "restored", "reverted", "soft_deleted"];
const FACT_STATUSES: [&str; 2] = ["inserted", "superseded"];

/// `r.outcome->>key`.
fn outcome_text(r: &RequestRecord, key: &str) -> Option<String> {
    r.outcome
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|o| fm_text(o, key))
}

fn status_in(r: &RequestRecord, statuses: &[&str]) -> bool {
    outcome_text(r, "status").is_some_and(|s| statuses.contains(&s.as_str()))
}

/// `FACT_ID`: `outcome->>'id'` when it is 1 to 18 digits, as a fact id.
fn fact_id(r: &RequestRecord) -> Option<u64> {
    outcome_text(r, "id")
        .filter(|t| (1..=18).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|t| t.parse().ok())
}

/// `MUTATED_PAGE`: the request changed its page to the revision it reports.
fn mutated_page(read: &dyn KvRead, r: &RequestRecord) -> Result<bool> {
    if PAGE_OPERATIONS.contains(&r.operation.as_str())
        && status_in(r, &PAGE_STATUSES)
        && outcome_text(r, "noop").as_deref().unwrap_or("false") != "true"
    {
        return Ok(true);
    }
    if r.operation != "remember" || !status_in(r, &FACT_STATUSES) {
        return Ok(false);
    }
    let Some(id) = fact_id(r) else {
        return Ok(false);
    };
    Ok(read_fact(read, id)?.is_some_and(|f| {
        f.source_id == r.source_id
            && f.row_num.is_some()
            && f.source_markdown_slug.as_deref() == Some(r.slug.as_str())
    }))
}

/// The attribution-backfill tables, checked as the TypeScript phase lookup checks them.
fn checked_table(table: &str) -> Result<&str> {
    match table {
        "pages" | "page_versions" | "facts" => Ok(table),
        other => Err(StoreError::invalid(format!(
            "attribution-backfill: unknown table {other}"
        ))),
    }
}

/// Each `table` row of the scope with no attribution, with how many committed requests prove it.
fn unfilled_rows(
    read: &dyn KvRead,
    table: &str,
    source_ids: &[String],
) -> Result<Vec<(u64, usize)>> {
    let scope: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
    let committed: Vec<RequestRecord> = all_requests(read)?
        .into_iter()
        .filter(|r| r.state == "committed")
        .collect();
    let mut out = Vec::new();
    if table == "facts" {
        let mut proofs: BTreeMap<(String, u64), usize> = BTreeMap::new();
        for r in &committed {
            if r.operation == "remember"
                && status_in(r, &FACT_STATUSES)
                && let Some(id) = fact_id(r)
            {
                *proofs.entry((r.source_id.clone(), id)).or_default() += 1;
            }
        }
        for source in &scope {
            for f in source_rows(read, source)? {
                if f.receipt.write_request_id.is_none() && f.receipt.write_principal_kind.is_none()
                {
                    let n = proofs
                        .get(&(f.source_id.clone(), f.id))
                        .copied()
                        .unwrap_or(0);
                    out.push((f.id, n));
                }
            }
        }
        return Ok(out);
    }
    let mut proofs: BTreeMap<(String, String), usize> = BTreeMap::new();
    for r in &committed {
        if let Some(revision) = outcome_text(r, "revision")
            && mutated_page(read, r)?
        {
            *proofs.entry((r.source_id.clone(), revision)).or_default() += 1;
        }
    }
    let proven = |source: &str, revision: &str| {
        proofs
            .get(&(source.to_string(), revision.to_string()))
            .copied()
            .unwrap_or(0)
    };
    let pages = all_pages(read)?;
    if table == "pages" {
        for p in pages
            .iter()
            .filter(|p| scope.contains(p.source_id.as_str()))
        {
            let receipt = &p.revision_receipt;
            if receipt.request_id.is_none() && receipt.principal_kind.is_none() {
                out.push((p.id, proven(&p.source_id, &p.knowledge_revision)));
            }
        }
        return Ok(out);
    }
    let page_source: BTreeMap<u64, &str> = pages
        .iter()
        .filter(|p| scope.contains(p.source_id.as_str()))
        .map(|p| (p.id, p.source_id.as_str()))
        .collect();
    for v in all_versions(read)? {
        let Some(source) = page_source.get(&v.page_id) else {
            continue;
        };
        let written = &v.receipt.written;
        if written.request_id.is_none() && written.principal_kind.is_none() {
            out.push((v.id, proven(source, &v.knowledge_revision)));
        }
    }
    Ok(out)
}

impl Store {
    /// `listProvenAttributionTargets(table, sourceIds)`: the ids of the unfilled `table` rows of
    /// the sources that exactly one committed request proves, ascending.
    pub fn list_proven_attribution_targets(
        &self,
        table: &str,
        source_ids: &[String],
    ) -> Result<Value> {
        let table = checked_table(table)?;
        let read = self.read()?;
        let mut ids: Vec<u64> = unfilled_rows(&*read, table, source_ids)?
            .into_iter()
            .filter(|(_, n)| *n == 1)
            .map(|(id, _)| id)
            .collect();
        ids.sort_unstable();
        Ok(json!(ids))
    }

    /// `countUnfilledAttribution(table, sourceIds)`: how many `table` rows of the sources have no
    /// attribution.
    pub fn count_unfilled_attribution(&self, table: &str, source_ids: &[String]) -> Result<Value> {
        let table = checked_table(table)?;
        let read = self.read()?;
        Ok(json!(unfilled_rows(&*read, table, source_ids)?.len()))
    }
}
