//! The access read log: the `access_read_log` table of the PGLite engine (GST-2476 gap 1). The read-log writer
//! (`src/core/access/read-log.ts`) appends one row per read a non-owner member or audience made and keeps the table to
//! a year and a million rows; `gbrain access log` and `gbrain access who-read` read it
//! (`src/commands/access-read-log.ts`).
//!
//! Members: insertAccessReadLogRows, pruneAccessReadLog, readAccessReadLog, listAccessReadPageRefs,
//! readAccessReadsOfPages, tallyAccessReadsOfPages (`src/core/engine-sql/access-read-log.ts`).
//!
//! Keys (under `keys::TELEMETRY`, `a`):
//! - `a 0x11 <id BE8>` -> `ReadLogRecord` (JSON). Key order is id order. The id comes from the
//!   `next_access_read_log_id` counter, as `BIGSERIAL` does.
//!
//! A row names page ids, never page text: a page delete or purge leaves the row, and the reads print a page that is
//! no longer stored as `#<id>`, as the SQL's `LEFT JOIN pages` does.

use crate::env::iso;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::{all_pages, read_page_by_id};
use crate::telemetry::{int4_param, parse_timestamp};
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const OP_INSERT: &str = "insertAccessReadLogRows";
const OP_READ: &str = "readAccessReadLog";
const OP_PAGES: &str = "readAccessReadsOfPages";
const OP_TALLY: &str = "tallyAccessReadsOfPages";
const ID_COUNTER: &str = "next_access_read_log_id";
const DAY_US: i128 = 86_400_000_000;

fn prefix() -> [u8; 2] {
    [keys::TELEMETRY, keys::TELEMETRY_ACCESS_READ_LOG]
}

fn key(id: u64) -> Vec<u8> {
    let mut key = prefix().to_vec();
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// One `access_read_log` row. Times are microseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReadLogRecord {
    id: u64,
    created_us: i64,
    member: Option<String>,
    audience: Option<Vec<String>>,
    operation: String,
    transport: String,
    result_code: String,
    page_ids: Vec<i32>,
}

impl ReadLogRecord {
    /// `COALESCE(member, array_to_string(audience, '+'), '(unbound)')`: an empty audience is the empty text.
    fn who(&self) -> String {
        match (&self.member, &self.audience) {
            (Some(member), _) => member.clone(),
            (None, Some(audience)) => audience.join("+"),
            (None, None) => "(unbound)".to_string(),
        }
    }

    /// The entry the log reads return: each page id as `source:slug` (a soft-deleted page too), else `#id`.
    fn entry(&self, read: &dyn KvRead) -> Result<Value> {
        let mut pages = Vec::with_capacity(self.page_ids.len());
        for &id in &self.page_ids {
            let page = match u64::try_from(id) {
                Ok(id) => read_page_by_id(read, id)?,
                Err(_) => None,
            };
            pages.push(match page {
                Some(p) => format!("{}:{}", p.source_id, p.slug),
                None => format!("#{id}"),
            });
        }
        Ok(json!({
            "created_at": iso(self.created_us), "member": self.member, "audience": self.audience,
            "operation": self.operation, "transport": self.transport, "result_code": self.result_code, "pages": pages,
        }))
    }
}

/// One row of `insertAccessReadLogRows`, as the writer sends it (`created_at` ISO text).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadLogRowInput {
    pub created_at: String,
    #[serde(default)]
    pub member: Option<String>,
    #[serde(default)]
    pub audience: Option<Vec<String>>,
    pub operation: String,
    pub transport: String,
    pub result_code: String,
    #[serde(default)]
    pub page_ids: Vec<f64>,
}

/// `readAccessReadLog` input.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadLogQuery {
    pub since: String,
    #[serde(default)]
    pub member: Option<String>,
    pub limit: u64,
}

/// `readAccessReadsOfPages` and `tallyAccessReadsOfPages` input (`limit` only for the reads).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadLogPagesQuery {
    pub page_ids: Vec<i64>,
    pub since: String,
    #[serde(default)]
    pub limit: Option<u64>,
}

fn read_rows(read: &dyn KvRead) -> Result<Vec<ReadLogRecord>> {
    let mut raw = Vec::new();
    scan_prefix(read, &prefix(), false, &mut |_, v| {
        raw.push(v.to_vec());
        true
    })?;
    raw.iter()
        .map(|v| serde_json::from_slice(v).map_err(StoreError::from))
        .collect()
}

/// Newest first, a tie by the higher id (`ORDER BY created_at DESC, id DESC`).
fn newest_first(rows: &mut [ReadLogRecord]) {
    rows.sort_by_key(|r| std::cmp::Reverse((r.created_us, r.id)));
}

fn take(limit: u64) -> usize {
    usize::try_from(limit).unwrap_or(usize::MAX)
}

impl Store {
    /// `insertAccessReadLogRows(rows)`: appends each row with the next id, in order. A `created_at` that is not ISO
    /// text, a page id that is not a whole `int4` or a NUL in text refuses the batch with `invalid_argument` and
    /// writes nothing.
    pub fn insert_access_read_log_rows(&self, rows: &[ReadLogRowInput]) -> Result<()> {
        let mut records = Vec::with_capacity(rows.len());
        for row in rows {
            let mut texts: Vec<(&str, &str)> = vec![
                ("operation", &row.operation),
                ("transport", &row.transport),
                ("result_code", &row.result_code),
            ];
            if let Some(member) = row.member.as_deref() {
                texts.push(("member", member));
            }
            for a in row.audience.iter().flatten() {
                texts.push(("audience", a));
            }
            no_nul(OP_INSERT, &texts)?;
            let page_ids = row
                .page_ids
                .iter()
                .map(|&id| int4_param(OP_INSERT, "page_ids", id))
                .collect::<Result<Vec<i32>>>()?;
            records.push(ReadLogRecord {
                id: 0,
                created_us: parse_timestamp(OP_INSERT, &row.created_at)?,
                member: row.member.clone(),
                audience: row.audience.clone(),
                operation: row.operation.clone(),
                transport: row.transport.clone(),
                result_code: row.result_code.clone(),
                page_ids,
            });
        }
        self.write(|tx| {
            for record in &records {
                let id = crate::pages::next_id(tx, ID_COUNTER)?;
                put_json(
                    tx,
                    &key(id),
                    &ReadLogRecord {
                        id,
                        ..record.clone()
                    },
                )?;
            }
            Ok(())
        })
    }

    /// `pruneAccessReadLog(days, maxRows)`: deletes the rows logged before `now - days`, then every row whose id is at
    /// most the highest id less `maxRows` (nothing on an empty table).
    pub fn prune_access_read_log(&self, days: i64, max_rows: i64) -> Result<()> {
        let cutoff = i128::from(self.env.now_micros()) - i128::from(days) * DAY_US;
        self.write(|tx| {
            let rows = read_rows(&*tx)?;
            let mut kept = Vec::new();
            for row in rows {
                if i128::from(row.created_us) < cutoff {
                    tx.delete(&key(row.id))?;
                } else {
                    kept.push(row);
                }
            }
            if let Some(max) = kept.iter().map(|r| i128::from(r.id)).max() {
                let floor = max - i128::from(max_rows);
                for row in kept.iter().filter(|r| i128::from(r.id) <= floor) {
                    tx.delete(&key(row.id))?;
                }
            }
            Ok(())
        })
    }

    /// `readAccessReadLog({ since, member, limit })`: the rows logged at or after `since`, newest first, at most
    /// `limit`; with `member`, the rows it made and the rows whose audience names `member:<member>`.
    pub fn read_access_read_log(&self, q: &ReadLogQuery) -> Result<Value> {
        let since = parse_timestamp(OP_READ, &q.since)?;
        let read = self.read()?;
        let principal = q.member.as_ref().map(|m| format!("member:{m}"));
        let mut rows: Vec<ReadLogRecord> = read_rows(&*read)?
            .into_iter()
            .filter(|r| r.created_us >= since)
            .filter(|r| match (&q.member, &principal) {
                (Some(member), Some(principal)) => {
                    r.member.as_ref() == Some(member)
                        || r.audience.as_ref().is_some_and(|a| a.contains(principal))
                }
                _ => true,
            })
            .collect();
        newest_first(&mut rows);
        let out = rows
            .iter()
            .take(take(q.limit))
            .map(|r| r.entry(&*read))
            .collect::<Result<Vec<Value>>>()?;
        Ok(Value::Array(out))
    }

    /// `listAccessReadPageRefs(slug, sourceId)`: `{ id, source_id, slug }` of every stored page with this slug (in the
    /// source when one is given), soft-deleted ones too, by source id in byte order.
    pub fn list_access_read_page_refs(&self, slug: &str, source_id: Option<&str>) -> Result<Value> {
        let read = self.read()?;
        let mut pages: Vec<_> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.slug == slug && source_id.is_none_or(|s| s == p.source_id))
            .collect();
        pages.sort_by(|a, b| a.source_id.as_bytes().cmp(b.source_id.as_bytes()));
        Ok(Value::Array(
            pages
                .into_iter()
                .map(|p| json!({ "id": p.id, "source_id": p.source_id, "slug": p.slug }))
                .collect(),
        ))
    }

    /// The rows logged at or after `since` that name one of `page_ids` (`page_ids && $1::int[]`).
    fn rows_of_pages(
        &self,
        read: &dyn KvRead,
        q: &ReadLogPagesQuery,
        op: &str,
    ) -> Result<Vec<ReadLogRecord>> {
        let since = parse_timestamp(op, &q.since)?;
        let wanted: BTreeSet<i64> = q.page_ids.iter().copied().collect();
        Ok(read_rows(read)?
            .into_iter()
            .filter(|r| {
                r.created_us >= since
                    && r.page_ids.iter().any(|id| wanted.contains(&i64::from(*id)))
            })
            .collect())
    }

    /// `readAccessReadsOfPages({ pageIds, since, limit })`: those rows, newest first, at most `limit`.
    pub fn read_access_reads_of_pages(&self, q: &ReadLogPagesQuery) -> Result<Value> {
        let read = self.read()?;
        let mut rows = self.rows_of_pages(&*read, q, OP_PAGES)?;
        newest_first(&mut rows);
        let limit = q.limit.ok_or_else(|| {
            StoreError::new(INVALID_ARGUMENT, format!("{OP_PAGES}: limit is required"))
        })?;
        let out = rows
            .iter()
            .take(take(limit))
            .map(|r| r.entry(&*read))
            .collect::<Result<Vec<Value>>>()?;
        Ok(Value::Array(out))
    }

    /// `tallyAccessReadsOfPages({ pageIds, since })`: `{ who, reads, last_at }` per reader of those rows, the latest
    /// last read first, a tie by who in byte order.
    pub fn tally_access_reads_of_pages(&self, q: &ReadLogPagesQuery) -> Result<Value> {
        let read = self.read()?;
        let mut groups: BTreeMap<String, (u64, i64)> = BTreeMap::new();
        for row in self.rows_of_pages(&*read, q, OP_TALLY)? {
            let group = groups.entry(row.who()).or_insert((0, i64::MIN));
            group.0 += 1;
            group.1 = group.1.max(row.created_us);
        }
        let mut tally: Vec<(String, u64, i64)> =
            groups.into_iter().map(|(w, (n, at))| (w, n, at)).collect();
        tally.sort_by(|a, b| {
            b.2.cmp(&a.2)
                .then_with(|| a.0.as_bytes().cmp(b.0.as_bytes()))
        });
        Ok(Value::Array(
            tally
                .into_iter()
                .map(|(who, reads, at)| json!({ "who": who, "reads": reads, "last_at": iso(at) }))
                .collect(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    fn row(
        at: &str,
        member: Option<&str>,
        audience: Option<&[&str]>,
        pages: &[f64],
    ) -> ReadLogRowInput {
        ReadLogRowInput {
            created_at: at.into(),
            member: member.map(Into::into),
            audience: audience.map(|a| a.iter().map(|s| s.to_string()).collect()),
            operation: "search".into(),
            transport: "http".into(),
            result_code: "ok".into(),
            page_ids: pages.to_vec(),
        }
    }

    #[test]
    fn the_log_reads_newest_first_and_names_a_member_by_its_reads_and_its_audiences() {
        let s = store();
        s.insert_access_read_log_rows(&[
            row("2026-01-01T00:00:00Z", Some("alice-example"), None, &[1.0]),
            row(
                "2026-01-02T00:00:00Z",
                None,
                Some(&["member:alice-example", "member:bob-example"]),
                &[],
            ),
            row("2026-01-02T00:00:00Z", Some("bob-example"), None, &[9.0]),
        ])
        .unwrap();
        let q = |member: Option<&str>| ReadLogQuery {
            since: "2026-01-01T00:00:00Z".into(),
            member: member.map(Into::into),
            limit: 10,
        };
        let all = s.read_access_read_log(&q(None)).unwrap();
        let who: Vec<_> = all
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["member"].clone())
            .collect();
        assert_eq!(
            who,
            vec![json!("bob-example"), Value::Null, json!("alice-example")]
        );
        assert_eq!(all[0]["pages"], json!(["#9"]));
        assert_eq!(
            s.read_access_read_log(&q(Some("alice-example")))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn the_tally_counts_each_reader_and_the_prune_keeps_the_newest_rows() {
        let s = store();
        s.insert_access_read_log_rows(&[
            row("2026-01-01T00:00:00Z", None, None, &[4.0]),
            row("2026-01-03T00:00:00Z", None, Some(&[]), &[4.0]),
            row(
                "2026-01-03T00:00:00Z",
                Some("carol-example"),
                None,
                &[4.0, 5.0],
            ),
            row("2026-01-02T00:00:00Z", Some("carol-example"), None, &[6.0]),
        ])
        .unwrap();
        let q = ReadLogPagesQuery {
            page_ids: vec![4],
            since: "2026-01-01T00:00:00Z".into(),
            limit: None,
        };
        let tally = s.tally_access_reads_of_pages(&q).unwrap();
        let rows: Vec<(String, u64)> = tally
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                (
                    t["who"].as_str().unwrap().to_string(),
                    t["reads"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                ("".into(), 1),
                ("carol-example".into(), 1),
                ("(unbound)".into(), 1)
            ]
        );
        s.prune_access_read_log(100_000, 2).unwrap();
        let left = s
            .read_access_read_log(&ReadLogQuery {
                since: "2000-01-01T00:00:00Z".into(),
                member: None,
                limit: 10,
            })
            .unwrap();
        assert_eq!(left.as_array().unwrap().len(), 2);
    }
}
