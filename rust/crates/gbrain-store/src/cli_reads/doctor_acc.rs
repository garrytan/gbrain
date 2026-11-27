//! Doctor reads, second set: the request-log statements of `gbrain doctor` checks and the pages that
//! name readers (`listReaderPages`, behind the member-access checks) (SQL in
//! `src/core/engine-sql/doctor-acc.ts`, docs in `rust/docs/store/cli-reads-doctor-acc.md`).
//! The other members of that set answer in TypeScript from members the store serves.
//! Each read takes one snapshot and has no keys of its own.

use crate::Store;
use crate::cli_reads::pg_text::timestamptz_text;
use crate::error::Result;
use crate::facts::privacy::access_readers;
use crate::kv::scan_prefix;
use crate::pages::{all_pages, versions_of};
use crate::telemetry::{LogRecord, days_before, log_prefix};
use serde_json::{Value, json};

const OP_PAST_WINDOW: &str = "hasMcpLogRowsPastWindow";

impl Store {
    /// `readMcpRequestLogBytes()`: what the request log occupies, the bytes of its keys and
    /// records. Postgres measures the table's pages instead, so the two differ in size, not in
    /// meaning: an empty log is 0 here.
    pub fn read_mcp_request_log_bytes(&self) -> Result<u64> {
        let read = self.read()?;
        let mut bytes: u64 = 0;
        scan_prefix(&*read, &log_prefix(), false, &mut |k, v| {
            bytes += (k.len() + v.len()) as u64;
            true
        })?;
        Ok(bytes)
    }

    /// `countMcpRequestLogRows(limit)`: the rows of the request log, counted up to `limit`
    /// (`SELECT count(*) FROM (SELECT 1 FROM mcp_request_log LIMIT $1)`); a limit of 0 or less
    /// counts none.
    pub fn count_mcp_request_log_rows(&self, limit: f64) -> Result<u64> {
        let cap = if limit.is_finite() && limit > 0.0 {
            limit as u64
        } else {
            0
        };
        if cap == 0 {
            return Ok(0);
        }
        let read = self.read()?;
        let mut rows: u64 = 0;
        scan_prefix(&*read, &log_prefix(), false, &mut |_, _| {
            rows += 1;
            rows < cap
        })?;
        Ok(rows)
    }

    /// `hasMcpLogRowsPastWindow(days, keepOperations)`: whether a request created before
    /// `now - days` days whose operation is not in `keep` exists, the rows
    /// `prune_mcp_request_log_batch` would delete. Keys are in `created_at` order, so the scan
    /// stops at the first row inside the window.
    pub fn has_mcp_log_rows_past_window(&self, days: f64, keep: &[String]) -> Result<bool> {
        let Some(cutoff) = days_before(OP_PAST_WINDOW, self.env.now_micros(), Some(days))? else {
            return Ok(false);
        };
        let read = self.read()?;
        let mut waiting = false;
        let mut failure = None;
        scan_prefix(
            &*read,
            &log_prefix(),
            false,
            &mut |_, v| match serde_json::from_slice::<LogRecord>(v) {
                Ok(row) if row.created_us >= cutoff => false,
                Ok(row) if keep.contains(&row.operation) => true,
                Ok(_) => {
                    waiting = true;
                    false
                }
                Err(e) => {
                    failure = Some(e);
                    false
                }
            },
        )?;
        match failure {
            Some(e) => Err(e.into()),
            None => Ok(waiting),
        }
    }

    /// `listReaderPages(updatedWithinDays)`: every live page whose frontmatter has a `readable_by` key (a
    /// JSON null counts, as `frontmatter->'readable_by' IS NOT NULL` does), in byte order of source then
    /// slug; `updated_within_days` keeps only the pages written after `now() - days` (`None` keeps all):
    /// `{ id, source_id, slug, readers, updated_at, updated_us, writer, prior_names_readers }`.
    /// `readers` is `gbrain_access_readers(frontmatter)` (`["!nobody"]` for a value that names no valid
    /// reader), `updated_at` is `timestamptz::text`, `writer` is the revision receipt's
    /// `principal_kind:principal_id` (null without one), and `prior_names_readers` is whether the
    /// newest stored version (by snapshot time, then id) names `readable_by` (null for a page with no
    /// version): the three member-access checks of `gbrain doctor` are read from these.
    pub fn list_reader_pages(&self, updated_within_days: Option<f64>) -> Result<Vec<Value>> {
        let read = self.read()?;
        let cutoff = updated_within_days
            .map(|days| self.env.now_micros() - (days * 86_400_000_000.0).round() as i64);
        let mut pages: Vec<_> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && cutoff.is_none_or(|c| p.updated_at_us > c))
            .filter_map(|p| access_readers(&p.frontmatter).map(|readers| (p, readers)))
            .collect();
        pages.sort_by(|a, b| (&a.0.source_id, &a.0.slug).cmp(&(&b.0.source_id, &b.0.slug)));
        let mut rows = Vec::with_capacity(pages.len());
        for (page, readers) in pages {
            let newest = versions_of(&*read, page.id)?
                .into_iter()
                .max_by_key(|v| (v.snapshot_at_us, v.id));
            let writer = match (
                &page.revision_receipt.principal_kind,
                &page.revision_receipt.principal_id,
            ) {
                (Some(kind), Some(id)) => Some(format!("{kind}:{id}")),
                _ => None,
            };
            rows.push(json!({
                "id": page.id,
                "source_id": page.source_id,
                "slug": page.slug,
                "readers": readers,
                "updated_at": timestamptz_text(page.updated_at_us),
                "updated_us": page.updated_at_us,
                "writer": writer,
                "prior_names_readers": newest.map(|v| v.frontmatter.contains_key("readable_by")),
            }));
        }
        Ok(rows)
    }
}
