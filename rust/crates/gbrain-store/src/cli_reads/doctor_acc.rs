//! Doctor reads, second set: the request-log statements of `gbrain doctor` checks
//! (SQL in `src/core/engine-sql/doctor-acc.ts`, docs in `rust/docs/store/cli-reads-doctor-acc.md`).
//! The other members of that set answer in TypeScript for state this store does not keep.
//! Each read takes one snapshot and has no keys of its own.

use crate::Store;
use crate::error::Result;
use crate::kv::scan_prefix;
use crate::telemetry::{LogRecord, days_before, log_prefix};

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
}
