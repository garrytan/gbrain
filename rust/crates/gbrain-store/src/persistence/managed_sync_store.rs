//! The managed sync's named statements (`runSyncStatement`, `src/core/engine-sql/managed-sync-store.ts`;
//! rust/docs/store/managed-mode.md, "Managed sync"): the reads and writes `gbrain sync` of a managed source makes through
//! the source, page, request, effect, config and `op_checkpoints` records.
//!
//! Each statement answers what its Postgres text answers: the same columns, the same filters and the same row choice
//! (`DISTINCT ON`, `LIMIT`, `ORDER BY`), from the records the store keeps. A column the SQL casts to `text` is a string here
//! and a `bigint` a number (the callers read both with `Number()`).
//!
//! Locks. The SQL's row locks (`FOR UPDATE`, `FOR SHARE`) are not reads here. Their guarantee holds another way: an explicit
//! transaction is Serialized (it holds the store's writer, so no other commit interleaves with what it read), and under
//! optimistic transactions every record read below is in the transaction's read set, so a racing change aborts the commit
//! with `write_conflict` instead of being missed. No file lock, no process-wide mutex and no busy error is added.
//!
//! The session settings the SQL carries (`SET TRANSACTION ISOLATION LEVEL`, `set_config`) change nothing here: a read
//! transaction reads one snapshot and the store commits durably.

use std::collections::HashSet;

use super::effects::all_effects;
use super::housekeeping::HousekeepingRow;
use super::op_checkpoint::{delete_op_checkpoint_in, parent_key};
use super::projection_queue::parse_timestamptz;
use super::worktrees::{SOURCE_BINDING, SourceBindingRecord, read_host_record, read_worktree_record, scan_records};
use super::write_claim_terms::worktree_of;
use super::{HOUSEKEEPING, all_requests, json_text, uuid_param};
use crate::env::{Env, iso};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::sources::{read_source, source_key};
use crate::{Store, get_json, keys, put_json};
use serde_json::{Map, Value, json};

/// `state IN ('queued','running','recovering')`.
const OPEN: [&str; 3] = ["queued", "running", "recovering"];

/// The unbound-source predicate's edge whitespace (`edge-whitespace.ts`): ASCII space and controls, and the Unicode
/// spaces the importer trims.
fn edge_space(c: char) -> bool {
    matches!(
        c,
        '\u{20}' | '\u{09}'..='\u{0d}' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn blank(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(|v| v.trim_matches(edge_space).is_empty())
}

// ---------------------------------------------------------------------------------------------
// Parameters, as the statement's `$n` reads them.

pub(super) fn param<'a>(p: &'a [Value], i: usize) -> Result<&'a Value> {
    p.get(i)
        .ok_or_else(|| StoreError::invalid(format!("a sync statement needs parameter ${}", i + 1)))
}

pub(super) fn text(p: &[Value], i: usize) -> Result<String> {
    match param(p, i)? {
        Value::String(s) => Ok(s.clone()),
        Value::Null => Err(StoreError::invalid(format!("parameter ${} is null", i + 1))),
        other => Ok(other.to_string()),
    }
}

pub(super) fn opt_text(p: &[Value], i: usize) -> Result<Option<String>> {
    match param(p, i)? {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        other => Ok(Some(other.to_string())),
    }
}

pub(super) fn texts(p: &[Value], i: usize) -> Result<Vec<String>> {
    match param(p, i)? {
        Value::Array(items) => Ok(items
            .iter()
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect()),
        _ => Err(StoreError::invalid(format!("parameter ${} is not an array", i + 1))),
    }
}

fn opt_texts(p: &[Value], i: usize) -> Result<Option<Vec<String>>> {
    match param(p, i)? {
        Value::Null => Ok(None),
        _ => texts(p, i).map(Some),
    }
}

/// A `bigint` parameter: a JSON number or its text.
pub(super) fn big(value: &Value) -> Result<i64> {
    match value {
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .ok_or_else(|| StoreError::invalid("a bigint parameter is not an integer")),
        Value::String(s) => s
            .trim()
            .parse::<i64>()
            .map_err(|_| StoreError::invalid(format!("invalid input syntax for type bigint: \"{s}\""))),
        _ => Err(StoreError::invalid("a bigint parameter is not a number")),
    }
}

fn opt_big(p: &[Value], i: usize) -> Result<Option<i64>> {
    match param(p, i)? {
        Value::Null => Ok(None),
        v => big(v).map(Some),
    }
}

/// `completed_keys` text parameter (`$n::text::jsonb`).
pub(super) fn jsonb_param(p: &[Value], i: usize) -> Result<Value> {
    let raw = text(p, i)?;
    serde_json::from_str(&raw).map_err(|_| StoreError::invalid("a jsonb parameter is not valid JSON"))
}

// ---------------------------------------------------------------------------------------------
// op_checkpoints rows.

/// Every parent row of `op`, in fingerprint byte order.
pub(super) fn op_rows(read: &dyn KvRead, op: &str) -> Result<Vec<(String, HousekeepingRow)>> {
    let mut prefix = vec![keys::PERSISTENCE, HOUSEKEEPING];
    prefix.extend_from_slice(op.as_bytes());
    prefix.push(0);
    let mut out = Vec::new();
    let mut bad = false;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        match (std::str::from_utf8(&k[prefix.len()..]), serde_json::from_slice::<HousekeepingRow>(v)) {
            (Ok(fingerprint), Ok(row)) => out.push((fingerprint.to_owned(), row)),
            _ => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            "an op checkpoint row is not readable",
        ));
    }
    Ok(out)
}

pub(super) fn op_row(read: &dyn KvRead, op: &str, fingerprint: &str) -> Result<Option<HousekeepingRow>> {
    get_json::<HousekeepingRow>(read, &parent_key(op, fingerprint)?)
}

/// `completed_keys->0`: the first element, or None for an empty or non-array value.
pub(super) fn first(row: &HousekeepingRow) -> Option<&Value> {
    row.completed_keys.as_array().and_then(|a| a.first())
}

/// `completed_keys->0->>key`.
pub(super) fn first_text(row: &HousekeepingRow, key: &str) -> Option<String> {
    first(row).and_then(|v| json_text(v.get(key)))
}

pub(super) fn put_row(tx: &mut dyn KvWrite, env: &dyn Env, op: &str, fingerprint: &str, completed_keys: Value) -> Result<()> {
    put_json(
        tx,
        &parent_key(op, fingerprint)?,
        &HousekeepingRow { completed_keys, updated_at_us: env.now_micros() },
    )
}

/// `to_jsonb(now())` with TimeZone UTC: `2026-01-03T00:00:00.215+00:00`.
fn jsonb_now(env: &dyn Env) -> String {
    jsonb_timestamp(env.now_micros())
}

/// `to_jsonb(timestamptz)` for `micros`.
fn jsonb_timestamp(micros: i64) -> String {
    let iso = iso(micros);
    let trimmed = iso.trim_end_matches('Z');
    let trimmed = if trimmed.contains('.') { trimmed.trim_end_matches('0').trim_end_matches('.') } else { trimmed };
    format!("{trimmed}+00:00")
}

// ---------------------------------------------------------------------------------------------
// Request and page helpers.

pub(super) fn request_is(r: &super::RequestRecord, wanted: &[&str]) -> bool {
    wanted.contains(&r.state.as_str())
}

pub(super) fn kind_of(r: &super::RequestRecord) -> Option<String> {
    json_text(r.intent.get("kind"))
}

/// `(worktree_id = $w OR worktree_id IS NULL AND source_id = $s AND source_incarnation = $i)`.
fn in_scope(r: &super::RequestRecord, worktree: &str, source: &str, incarnation: &str) -> bool {
    match worktree_of(r) {
        Some(w) => w.eq_ignore_ascii_case(worktree),
        None => r.source_id == source && r.source_incarnation.eq_ignore_ascii_case(incarnation),
    }
}

fn page_row_deleted_at(p: &PageRecord) -> Value {
    p.deleted_at_us.map_or(Value::Null, |us| json!(iso(us)))
}

pub(super) fn rows(items: Vec<Value>) -> Value {
    Value::Array(items)
}

fn count_stamp_ids(ids: &HashSet<String>, prefix: &str, value: &str) -> bool {
    ids.contains(&format!("{prefix}{value}"))
}

impl Store {
    /// One read statement of the managed sync (`syncStoreRows`).
    pub fn sync_store_rows(&self, name: &str, params: &[Value]) -> Result<Value> {
        let read = self.read()?;
        // Lane LM slice 2 part B: the status, page-fault, older-cursor and freshness statements (managed_sync_status.rs).
        if let Some(rows) = super::managed_sync_status::read(&*read, &*self.env, name, params)? {
            return Ok(rows);
        }
        run_read(&*read, &*self.env, name, params)
    }

    /// One write statement of the managed sync (`syncStoreWrite`); its `RETURNING` rows.
    pub fn sync_store_write(&self, name: &str, params: &[Value]) -> Result<Value> {
        self.write(|tx| match super::managed_sync_status::write(tx, &*self.env, name, params)? {
            Some(rows) => Ok(rows),
            None => run_write(tx, &*self.env, name, params),
        })
    }
}

fn unknown(name: &str) -> StoreError {
    StoreError::invalid(format!("the store has no sync statement named {name}"))
}

fn run_read(read: &dyn KvRead, env: &dyn Env, name: &str, p: &[Value]) -> Result<Value> {
    Ok(match name {
        // ---- the source row
        "source_row" => match read_source(read, &text(p, 0)?)? {
            Some(s) => rows(vec![json!({
                "incarnation": s.incarnation, "archived": s.archived, "local_path": s.local_path,
                "last_commit": s.last_commit, "config": Value::Object(s.config.clone()),
            })]),
            None => rows(vec![]),
        },
        "source_config" | "source_trust_config" => match read_source(read, &text(p, 0)?)? {
            Some(s) => rows(vec![json!({ "config": Value::Object(s.config.clone()) })]),
            None => rows(vec![]),
        },
        "source_local_path" | "source_local_path_shared" => match read_source(read, &text(p, 0)?)? {
            Some(s) => rows(vec![json!({ "local_path": s.local_path })]),
            None => rows(vec![]),
        },
        "source_last_commit" => {
            let incarnation = uuid_param(&text(p, 1)?, "incarnation")?;
            match read_source(read, &text(p, 0)?)?.filter(|s| s.incarnation.eq_ignore_ascii_case(&incarnation)) {
                Some(s) => rows(vec![json!({ "last_commit": s.last_commit })]),
                None => rows(vec![]),
            }
        }
        "config_values" => {
            let mut out = Vec::new();
            let mut seen = HashSet::new();
            for key in texts(p, 0)? {
                if seen.insert(key.clone())
                    && let Some(value) = crate::config::read_config(read, &key)?
                {
                    out.push(json!({ "key": key, "value": value }));
                }
            }
            rows(out)
        }

        // ---- op_checkpoints reads
        "hold_fingerprints" => {
            let (op, source) = (text(p, 0)?, text(p, 1)?);
            rows(op_rows(read, &op)?
                .into_iter()
                .filter(|(_, row)| first_text(row, "source_id").as_deref() == Some(source.as_str()))
                .map(|(fingerprint, _)| json!({ "fingerprint": fingerprint }))
                .collect())
        }
        "held_fingerprints" => {
            let op = text(p, 0)?;
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for fingerprint in texts(p, 1)? {
                if seen.insert(fingerprint.clone()) && op_row(read, &op, &fingerprint)?.is_some() {
                    out.push(json!({ "fingerprint": fingerprint }));
                }
            }
            rows(out)
        }
        "checkpoint_keys" => match op_row(read, &text(p, 0)?, &text(p, 1)?)? {
            Some(row) => rows(vec![json!({ "completed_keys": row.completed_keys })]),
            None => rows(vec![]),
        },
        "checkpoint_first" => match op_row(read, &text(p, 0)?, &text(p, 1)?)? {
            Some(row) => rows(vec![json!({ "value": first(&row).cloned().unwrap_or(Value::Null) })]),
            None => rows(vec![]),
        },
        "checkpoint_prefix" => {
            let prefix = text(p, 1)?;
            rows(op_rows(read, &text(p, 0)?)?
                .into_iter()
                .filter(|(fingerprint, _)| fingerprint.starts_with(&prefix))
                .map(|(fingerprint, row)| json!({ "fingerprint": fingerprint, "value": first(&row).cloned().unwrap_or(Value::Null) }))
                .collect())
        }
        "failure_key_present" => {
            let wanted: HashSet<String> = texts(p, 0)?.into_iter().collect();
            let any = op_rows(read, "managed-sync-failure")?.iter().any(|(fingerprint, _)| wanted.contains(fingerprint));
            rows(if any { vec![json!({ "?column?": 1 })] } else { vec![] })
        }
        "idle_facts" => {
            let source = text(p, 0)?;
            let failures = op_rows(read, "managed-sync-failure")?
                .iter()
                .any(|(_, row)| first_text(row, "source_id").as_deref() == Some(source.as_str()));
            let hold_summary = op_row(read, &text(p, 1)?, &text(p, 2)?)?
                .and_then(|row| first_text(&row, "count"))
                .and_then(|n| n.trim().parse::<i64>().ok())
                .unwrap_or(0);
            rows(vec![json!({ "failures": failures, "hold_summary": hold_summary })])
        }
        "cursor_rows" => {
            let (source, incarnation) = (text(p, 0)?, text(p, 1)?);
            let mut found: Vec<(i64, String, Value)> = op_rows(read, "managed-sync")?
                .into_iter()
                .filter(|(_, row)| {
                    first_text(row, "sourceId").as_deref() == Some(source.as_str())
                        && first_text(row, "incarnation").as_deref() == Some(incarnation.as_str())
                })
                .map(|(fingerprint, row)| {
                    let done = first_text(&row, "done").unwrap_or_else(|| "false".into()) == "true";
                    let value = json!({
                        "key": fingerprint, "done": done,
                        "company_receipt_id": first_text(&row, "companyReceiptId"),
                        "run_id": first_text(&row, "runId"),
                    });
                    (row.updated_at_us, fingerprint, value)
                })
                .collect();
            // ORDER BY updated_at DESC, fingerprint COLLATE "C".
            found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.as_bytes().cmp(b.1.as_bytes())));
            rows(found.into_iter().map(|(_, _, v)| v).collect())
        }
        "reserved_usd" => {
            let prefix = text(p, 1)?;
            let matched: Vec<_> = op_rows(read, &text(p, 0)?)?
                .into_iter()
                .filter(|(fingerprint, _)| fingerprint.starts_with(&prefix))
                .collect();
            let usd: f64 = matched
                .iter()
                .filter_map(|(_, row)| first_text(row, "usd").and_then(|n| n.trim().parse::<f64>().ok()))
                .sum();
            rows(vec![json!({ "usd": usd, "rows": matched.len() })])
        }

        // ---- pages and requests
        "open_requests" => {
            let (worktree, source, incarnation) = (text(p, 0)?, text(p, 1)?, uuid_param(&text(p, 2)?, "incarnation")?);
            rows(all_requests(read)?
                .into_iter()
                .filter(|r| request_is(r, &OPEN) && r.source_id == source && in_scope(r, &worktree, &source, &incarnation))
                .map(|r| json!({
                    "page_id": r.page_id, "source_path": json_text(r.intent.get("sourcePath")), "path": json_text(r.intent.get("path")),
                }))
                .collect())
        }
        "open_git_effects" => {
            let (worktree, source) = (text(p, 0)?, text(p, 1)?);
            let requests: Vec<_> = all_requests(read)?
                .into_iter()
                .filter(|r| r.source_id == source && worktree_of(r).is_some_and(|w| w.eq_ignore_ascii_case(&worktree)))
                .collect();
            let mut out = Vec::new();
            for e in all_effects(read)? {
                if e.kind == "git" && (e.state == "queued" || e.state == "running")
                    && let Some(r) = requests.iter().find(|r| r.id.eq_ignore_ascii_case(&e.request_id))
                {
                    out.push(json!({ "page_id": r.page_id, "path": json_text(e.data.get("relative_path")) }));
                }
            }
            rows(out)
        }
        "foreground_request" => {
            let worktree = uuid_param(&text(p, 0)?, "worktreeId")?;
            let found = all_requests(read)?.into_iter().find(|r| {
                request_is(r, &OPEN)
                    && worktree_of(r).is_some_and(|w| w == worktree)
                    && !super::sql_like(&kind_of(r).unwrap_or_default(), "managed_sync_%")
            });
            rows(found.map(|r| json!({ "id": r.id })).into_iter().collect())
        }
        "pages_for_adoption" => {
            let (source, slugs) = (text(p, 0)?, texts(p, 1)?);
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| pg.source_id == source && (pg.source_path.is_none() || slugs.contains(&pg.slug)))
                .map(|pg| json!({
                    "id": pg.id, "slug": pg.slug, "source_path": pg.source_path, "deleted_at": page_row_deleted_at(&pg),
                    "fm_id": json_text(pg.frontmatter.get("id")),
                }))
                .collect())
        }
        "pages_by_slug" => {
            let (source, slugs) = (text(p, 0)?, texts(p, 1)?);
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| pg.source_id == source && slugs.contains(&pg.slug))
                .map(|pg| json!({
                    "id": pg.id, "slug": pg.slug, "source_path": pg.source_path, "revision": pg.knowledge_revision,
                    "deleted": pg.deleted_at_us.is_some(),
                    "unbound": pg.database_only_reason.as_deref() == Some("unbound_source") && blank(&pg.source_path) && blank(&pg.source_uri),
                    "fm_id": json_text(pg.frontmatter.get("id")),
                }))
                .collect())
        }
        "origin_pages" | "origin_pages_folded" => {
            let (source, paths) = (text(p, 0)?, texts(p, 1)?);
            let folded = name == "origin_pages_folded";
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| {
                    pg.source_id == source
                        && pg.source_path.as_ref().is_some_and(|sp| {
                            let key = if folded { sp.replace('\\', "/").to_lowercase() } else { sp.clone() };
                            paths.contains(&key)
                        })
                })
                .map(|pg| json!({ "id": pg.id, "slug": pg.slug, "source_path": pg.source_path, "deleted_at": page_row_deleted_at(&pg) }))
                .collect())
        }
        "page_writers" => {
            let (source, ids) = (text(p, 0)?, param(p, 1)?.as_array().cloned().unwrap_or_default());
            let wanted: Vec<i64> = ids.iter().filter_map(|v| big(v).ok()).collect();
            let requests = all_requests(read)?;
            let mut out = Vec::new();
            for pg in all_pages(read)? {
                if pg.source_id != source || !wanted.contains(&(pg.id as i64)) {
                    continue;
                }
                if let Some(writer) = pg.revision_receipt.request_id.as_deref()
                    && let Some(r) = requests.iter().find(|r| r.id.eq_ignore_ascii_case(writer))
                {
                    out.push(json!({ "id": pg.id.to_string(), "level": json_text(r.intent.get("level")), "path": json_text(r.intent.get("path")) }));
                }
            }
            rows(out)
        }

        // ---- fence trend
        "max_request_sequence" => {
            let newest = all_requests(read)?.iter().map(|r| r.sequence).max();
            rows(vec![json!({ "through": newest.map(|n| n.to_string()) })])
        }
        "open_import_sequences" => {
            let worktree = uuid_param(&text(p, 0)?, "worktreeId")?;
            let (lo, hi, source) = (big(param(p, 1)?)?, big(param(p, 2)?)?, text(p, 3)?);
            let mut found: Vec<u64> = all_requests(read)?
                .into_iter()
                .filter(|r| {
                    worktree_of(r).is_some_and(|w| w == worktree)
                        && (r.sequence as i64) > lo && (r.sequence as i64) <= hi
                        && request_is(r, &["queued", "deferred", "running", "recovering"])
                        && r.source_id == source && kind_of(r).as_deref() == Some("managed_sync_import")
                })
                .map(|r| r.sequence)
                .collect();
            found.sort_unstable();
            rows(found.into_iter().map(|n| json!({ "sequence": n.to_string() })).collect())
        }
        "fence_trend_range" | "fence_trend_open" | "fence_trend_after" => {
            let worktree = uuid_param(&text(p, 0)?, "worktreeId")?;
            let (source, after) = (text(p, 1)?, big(param(p, 2)?)?);
            let upper = if name == "fence_trend_range" { Some(big(param(p, 3)?)?) } else { None };
            let open: Vec<i64> = if name == "fence_trend_open" {
                text(p, 3)?
                    .trim_matches(|c| c == '{' || c == '}')
                    .split(',')
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.trim().parse::<i64>().map_err(|_| StoreError::invalid("an open sequence is not a bigint")))
                    .collect::<Result<_>>()?
            } else {
                Vec::new()
            };
            let mut found: Vec<_> = all_requests(read)?
                .into_iter()
                .filter(|r| {
                    let seq = r.sequence as i64;
                    let in_range = match (upper, name) {
                        (Some(hi), _) => seq > after && seq <= hi,
                        (None, "fence_trend_open") => seq > after || open.contains(&seq),
                        _ => seq > after,
                    };
                    worktree_of(r).is_some_and(|w| w == worktree)
                        && r.source_id == source && in_range && r.state == "committed"
                        && kind_of(r).as_deref() == Some("managed_sync_import")
                        && json_text(r.intent.get("passId")).is_some()
                        && r.outcome.as_ref().and_then(|o| o.get("fences_normalized")).is_some_and(Value::is_array)
                })
                .collect();
            found.sort_by_key(|r| r.sequence);
            rows(found
                .into_iter()
                .map(|r| {
                    let mut row = json!({
                        "path": json_text(r.intent.get("path")),
                        "fences": r.outcome.as_ref().and_then(|o| o.get("fences_normalized")).cloned().unwrap_or(Value::Null),
                    });
                    if upper.is_some() {
                        row["sequence"] = json!(r.sequence.to_string());
                    }
                    row
                })
                .collect())
        }

        // ---- the drain lease fence and the clock
        "lease_fence" => {
            let token = uuid_param(&text(p, 1)?, "token")?;
            let live = crate::jobs::live_lock_token(read, &text(p, 0)?, env.now_micros())?;
            rows(if live.is_some_and(|t| t.eq_ignore_ascii_case(&token)) { vec![json!({ "?column?": 1 })] } else { vec![] })
        }
        "database_now" => rows(vec![json!({ "at": iso(env.now_micros()) })]),

        // ---- the claim's lease read and the incarnation reads
        "lease_other_holder" => {
            let (pid, host) = (big(param(p, 1)?)?, opt_text(p, 2)?);
            let holder = crate::jobs::live_lock_holder(read, &text(p, 0)?, env.now_micros())?
                .filter(|(holder_pid, holder_host)| !(*holder_pid == pid && *holder_host == host));
            rows(holder.map(|(pid, host)| json!({ "holder_pid": pid, "holder_host": host })).into_iter().collect())
        }
        "source_incarnation_text" | "source_incarnation_plain" => match read_source(read, &text(p, 0)?)? {
            Some(s) => rows(vec![json!({ "incarnation": s.incarnation })]),
            None => rows(vec![]),
        },

        // ---- the round snapshot and the pass reads
        "round_snapshot" => rows(vec![]),
        "cursor_header_slices" => {
            let header = op_row(read, "managed-sync", &text(p, 0)?)?.and_then(|row| first(&row).cloned());
            let prefix = text(p, 2)?;
            let slices = op_rows(read, &text(p, 1)?)?.iter().any(|(fingerprint, _)| fingerprint.starts_with(&prefix));
            rows(vec![json!({ "header": header.unwrap_or(Value::Null), "slices": slices })])
        }
        "pass_idle_probe" => pass_idle_probe(read, p)?,
        "revision_attestations" => revision_attestations(read, p)?,
        "file_removing_deletes" => file_removing_deletes(read, p)?,
        "legacy_deletions" => {
            let (source, incarnation, slugs) = (text(p, 0)?, uuid_param(&text(p, 1)?, "incarnation")?, texts(p, 2)?);
            let mut newest: std::collections::BTreeMap<String, (u64, String)> = Default::default();
            for r in all_requests(read)? {
                if r.source_id == source && r.source_incarnation.eq_ignore_ascii_case(&incarnation) && r.state == "committed"
                    && slugs.contains(&r.slug)
                    && (r.operation == "delete_page" || kind_of(&r).as_deref() == Some("managed_sync_delete"))
                    && newest.get(&r.slug).is_none_or(|(seq, _)| r.sequence > *seq)
                {
                    newest.insert(r.slug.clone(), (r.sequence, r.id.clone()));
                }
            }
            rows(newest.into_iter().map(|(slug, (_, id))| json!({ "slug": slug, "id": id })).collect())
        }
        "tail_slugs" => tail_slugs(read, p)?,

        // ---- markers and the origin checks
        "source_commit_config" => match read_source(read, &text(p, 0)?)? {
            Some(s) => rows(vec![json!({ "last_commit": s.last_commit, "config": Value::Object(s.config.clone()) })]),
            None => rows(vec![]),
        },
        "source_state" => match read_source(read, &text(p, 0)?)? {
            Some(s) => rows(vec![json!({ "incarnation": s.incarnation, "last_commit": s.last_commit, "config": Value::Object(s.config.clone()) })]),
            None => rows(vec![]),
        },
        "page_owning_origin" => {
            let (source, id, paths) = (text(p, 0)?, big(param(p, 1)?)?, texts(p, 2)?);
            let owned = all_pages(read)?.into_iter().any(|pg| {
                pg.source_id == source && pg.id as i64 != id && pg.deleted_at_us.is_none()
                    && pg.source_path.as_ref().is_some_and(|sp| paths.contains(sp))
            });
            rows(if owned { vec![json!({ "?column?": 1 })] } else { vec![] })
        }

        // ---- carried requests, checkout heads and the converged watermark
        "open_pass_requests" => {
            let (source, pass_id) = (text(p, 0)?, text(p, 1)?);
            let carried: Vec<String> = texts(p, 2)?.into_iter().map(|id| id.to_lowercase()).collect();
            let limit = big(param(p, 3)?)?.max(0) as usize;
            let mut found: Vec<_> = all_requests(read)?
                .into_iter()
                .filter(|r| {
                    request_is(r, &OPEN) && r.source_id == source
                        && matches!(kind_of(r).as_deref(), Some("managed_sync_import" | "managed_sync_delete"))
                        && (json_text(r.intent.get("passId")).as_deref() == Some(pass_id.as_str()) || carried.contains(&r.id.to_lowercase()))
                })
                .collect();
            found.sort_by_key(|r| r.sequence);
            rows(found.into_iter().take(limit).map(|r| json!({ "id": r.id })).collect())
        }
        "settle_carried" => {
            let ids: Vec<String> = texts(p, 0)?.into_iter().map(|id| id.to_lowercase()).collect();
            let mut found: Vec<_> = all_requests(read)?.into_iter().filter(|r| ids.contains(&r.id.to_lowercase())).collect();
            found.sort_by_key(|r| r.sequence);
            rows(found
                .into_iter()
                .map(|r| {
                    let outcome = r.outcome.as_ref();
                    let noop = json_text(outcome.and_then(|o| o.get("noop"))).is_some_and(|t| t == "true" || t == "t");
                    let chunks = json_text(outcome.and_then(|o| o.get("chunks"))).and_then(|n| n.trim().parse::<i64>().ok());
                    json!({
                        "id": r.id, "state": r.state, "kind": kind_of(&r), "renamed": r.intent.get("renameFrom").is_some(),
                        "status": json_text(outcome.and_then(|o| o.get("status"))), "noop": noop, "chunks": chunks,
                    })
                })
                .collect())
        }
        "checkout_heads" => {
            let (sources, host) = (texts(p, 0)?, uuid_param(&text(p, 1)?, "hostId")?);
            let mut out = Vec::new();
            for b in scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")? {
                if sources.contains(&b.source_id)
                    && let Some(h) = read_host_record(read, &b.worktree_id, &host)?
                {
                    out.push(json!({ "source_id": b.source_id, "local_path": h.local_path, "relative_path": b.relative_path }));
                }
            }
            rows(out)
        }
        "converged_hwm" => {
            let worktree = uuid_param(&text(p, 0)?, "worktreeId")?;
            let (source, incarnation) = (text(p, 1)?, uuid_param(&text(p, 2)?, "incarnation")?);
            let requests = all_requests(read)?;
            let a = requests.iter().filter(|r| worktree_of(r).is_some_and(|w| w == worktree)).map(|r| r.sequence).max();
            let b = requests
                .iter()
                .filter(|r| worktree_of(r).is_none() && r.source_id == source && r.source_incarnation.eq_ignore_ascii_case(&incarnation))
                .map(|r| r.sequence)
                .max();
            rows(vec![json!({ "hwm": a.max(b).map(|n| n.to_string()) })])
        }
        "converged_open" => {
            let worktree = uuid_param(&text(p, 0)?, "worktreeId")?;
            let own = opt_text(p, 1)?.map(|id| id.to_lowercase());
            let cap = big(param(p, 2)?)?.max(0) as usize;
            let (source, incarnation) = (text(p, 3)?, uuid_param(&text(p, 4)?, "incarnation")?);
            let requests = all_requests(read)?;
            let mut open: Vec<_> = requests
                .iter()
                .filter(|r| {
                    request_is(r, &OPEN) && in_scope(r, &worktree, &source, &incarnation)
                        && own.as_ref().is_none_or(|o| *o != r.request_id.to_lowercase())
                })
                .collect();
            open.sort_by_key(|r| r.sequence);
            let mut out: Vec<Value> = open.into_iter().take(cap).map(|r| json!({ "id": format!("r:{}", r.request_id.to_lowercase()) })).collect();
            let mut effects: Vec<_> = all_effects(read)?
                .into_iter()
                .filter(|e| {
                    e.kind == "git" && (e.state == "queued" || e.state == "running")
                        && requests.iter().any(|r| r.id.eq_ignore_ascii_case(&e.request_id) && worktree_of(r).is_some_and(|w| w == worktree))
                })
                .collect();
            effects.sort_by_key(|e| e.id);
            out.extend(effects.into_iter().take(cap).map(|e| json!({ "id": format!("e:{}", e.id) })));
            rows(out)
        }
        "converged_writeback" => {
            let ids: Vec<String> = texts(p, 0)?.into_iter().map(|id| id.to_lowercase()).collect();
            let found: std::collections::BTreeSet<String> = all_effects(read)?
                .into_iter()
                .filter(|e| e.kind == "git" && e.state != "committed" && e.data.get("settled").is_none() && ids.contains(&e.request_id.to_lowercase()))
                .map(|e| e.request_id.to_lowercase())
                .collect();
            rows(found.into_iter().map(|id| json!({ "id": id })).collect())
        }

        // ---- the pass status reads
        "open_pass_rows" => {
            let (op, sources) = (text(p, 0)?, texts(p, 1)?);
            let mut out = Vec::new();
            let mut seen = HashSet::new();
            for id in sources {
                if !seen.insert(id.clone()) {
                    continue;
                }
                if let Some(s) = read_source(read, &id)?.filter(|s| !s.archived)
                    && let Some(row) = op_row(read, &op, &format!("{}:{}", s.id, s.incarnation))?
                {
                    let outcome = first(&row).and_then(|v| json_text(v.pointer("/telemetry/outcome")));
                    out.push(json!({ "source_id": s.id, "updated_at": iso(row.updated_at_us), "outcome": outcome }));
                }
            }
            rows(out)
        }
        "pass_banked" => {
            let (source, pass_id, hold_op, prefix) = (text(p, 0)?, text(p, 1)?, text(p, 2)?, text(p, 3)?);
            let started = parse_timestamptz(&text(p, 4)?, "startedAt")?;
            let incarnation = text(p, 5)?;
            let binding = scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?
                .into_iter()
                .find(|b| b.source_id == source && b.source_incarnation == incarnation);
            let by_request = binding.as_ref().is_some_and(|b| {
                all_requests(read).map(|requests| requests.into_iter().any(|r| {
                    worktree_of(&r).is_some_and(|w| w.eq_ignore_ascii_case(&b.worktree_id))
                        && r.source_incarnation.eq_ignore_ascii_case(&b.source_incarnation) && r.state == "committed"
                        && super::sql_like(&kind_of(&r).unwrap_or_default(), "managed_sync_%")
                        && r.completed_at_us.is_some_and(|at| at >= started)
                        && json_text(r.intent.get("passId")).as_deref() == Some(pass_id.as_str())
                })).unwrap_or(false)
            });
            let mut by_hold = false;
            for (fingerprint, row) in op_rows(read, &hold_op)? {
                if !fingerprint.starts_with(&prefix) || first_text(&row, "run_id").as_deref() != Some(pass_id.as_str()) {
                    continue;
                }
                let held = first_text(&row, "held_at").map(|t| parse_timestamptz(&t, "held_at")).transpose()?;
                if held.is_some_and(|h| h >= started) && first(&row).and_then(|v| v.pointer("/meta/basis_moved")).is_none() {
                    by_hold = true;
                    break;
                }
            }
            rows(vec![json!({ "banked": by_request || by_hold })])
        }
        "pass_rewritten_holds" => {
            let (source, hold_op, prefix, pass_id) = (text(p, 0)?, text(p, 1)?, text(p, 2)?, text(p, 3)?);
            let started = parse_timestamptz(&text(p, 4)?, "startedAt")?;
            let codes = texts(p, 5)?;
            let (after, limit) = (text(p, 6)?, big(param(p, 7)?)?.max(0) as usize);
            let mut out = Vec::new();
            for (fingerprint, row) in op_rows(read, &hold_op)? {
                if !fingerprint.starts_with(&prefix) || fingerprint.as_str() <= after.as_str() {
                    continue;
                }
                let Some(record) = first(&row) else { continue };
                let meta = |key: &str| record.pointer(&format!("/meta/{key}")).is_some();
                let updated = json_text(record.get("updated_at")).map(|t| parse_timestamptz(&t, "updated_at")).transpose()?;
                let code = json_text(record.get("code"));
                if json_text(record.get("run_id")).as_deref() != Some(pass_id.as_str())
                    || !updated.is_some_and(|u| u >= started)
                    || code.as_ref().is_none_or(|c| codes.contains(c))
                    || meta("basis_moved") || meta("retry_only") || meta("keep_deleted")
                {
                    continue;
                }
                let revision = json_text(record.get("page_id"))
                    .and_then(|n| n.trim().parse::<u64>().ok())
                    .and_then(|id| read_page_by_id(read, id).ok().flatten())
                    .filter(|pg| pg.source_id == source)
                    .map(|pg| pg.knowledge_revision);
                out.push(json!({ "fingerprint": fingerprint, "record": record, "revision": revision }));
                if out.len() >= limit {
                    break;
                }
            }
            rows(out)
        }

        // ---- the apply round and the folded stamp
        "live_slugs" => {
            let (source, slugs) = (text(p, 0)?, texts(p, 1)?);
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| pg.source_id == source && pg.deleted_at_us.is_none() && slugs.contains(&pg.slug))
                .map(|pg| json!({ "slug": pg.slug }))
                .collect())
        }
        "unreadable_hold_paths" => {
            let op = text(p, 0)?;
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for fingerprint in texts(p, 1)? {
                if seen.insert(fingerprint.clone())
                    && let Some(row) = op_row(read, &op, &fingerprint)?
                    && first_text(&row, "code").as_deref() == Some("file_unreadable")
                {
                    out.push(json!({ "path": first_text(&row, "path") }));
                }
            }
            rows(out)
        }
        "pages_revisions_shared" => {
            let (source, ids) = (text(p, 0)?, param(p, 1)?.as_array().cloned().unwrap_or_default());
            let wanted: Vec<i64> = ids.iter().filter_map(|v| big(v).ok()).collect();
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| pg.source_id == source && pg.deleted_at_us.is_none() && wanted.contains(&(pg.id as i64)))
                .map(|pg| json!({ "id": pg.id, "revision": pg.knowledge_revision }))
                .collect())
        }
        "writeback_effects" => {
            let ids: Vec<String> = texts(p, 0)?.into_iter().map(|id| id.to_lowercase()).collect();
            rows(all_effects(read)?
                .into_iter()
                .filter(|e| e.kind == "git" && ids.contains(&e.request_id.to_lowercase()))
                .map(|e| json!({
                    "path": json_text(e.data.get("relative_path")), "hash": json_text(e.data.get("expected_hash")), "state": e.state,
                }))
                .collect())
        }
        "source_mode" => {
            let incarnation = uuid_param(&text(p, 1)?, "incarnation")?;
            match read_source(read, &text(p, 0)?)?.filter(|s| s.incarnation.eq_ignore_ascii_case(&incarnation)) {
                Some(s) => rows(vec![json!({ "last_commit": s.last_commit, "mode": json_text(s.config.get("slug_root_mode")) })]),
                None => rows(vec![]),
            }
        }

        // ---- the source's slug mode and the page reads behind the holds
        "source_slug_mode" | "source_mode_commit" => {
            let incarnation = uuid_param(&text(p, 1)?, "incarnation")?;
            match read_source(read, &text(p, 0)?)?.filter(|s| s.incarnation.eq_ignore_ascii_case(&incarnation)) {
                Some(s) => {
                    let mut row = json!({ "mode": json_text(s.config.get("slug_root_mode")) });
                    if name == "source_mode_commit" {
                        row["last_commit"] = json!(s.last_commit);
                    }
                    rows(vec![row])
                }
                None => rows(vec![]),
            }
        }
        "settled_live_pages" => {
            let (source, ids, slugs) = (text(p, 0)?, param(p, 1)?.as_array().cloned().unwrap_or_default(), texts(p, 2)?);
            let wanted: Vec<i64> = ids.iter().filter_map(|v| big(v).ok()).collect();
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| pg.source_id == source && pg.deleted_at_us.is_none() && (wanted.contains(&(pg.id as i64)) || slugs.contains(&pg.slug)))
                .map(|pg| json!({ "id": pg.id.to_string(), "slug": pg.slug }))
                .collect())
        }
        "pages_basis" | "page_revisions" => {
            let (source, ids) = (text(p, 0)?, param(p, 1)?.as_array().cloned().unwrap_or_default());
            let wanted: Vec<i64> = ids.iter().filter_map(|v| big(v).ok()).collect();
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| pg.source_id == source && wanted.contains(&(pg.id as i64)))
                .map(|pg| {
                    let mut row = json!({ "id": pg.id, "revision": pg.knowledge_revision });
                    if name == "pages_basis" {
                        row["deleted"] = json!(pg.deleted_at_us.is_some());
                    }
                    row
                })
                .collect())
        }
        "file_backed_pages" => {
            let (source, ids, incarnation) = (text(p, 0)?, param(p, 1)?.as_array().cloned().unwrap_or_default(), text(p, 2)?);
            let wanted: Vec<i64> = ids.iter().filter_map(|v| big(v).ok()).collect();
            let requests = all_requests(read)?;
            let effects = all_effects(read)?;
            let mut out = Vec::new();
            for pg in all_pages(read)? {
                if pg.source_id != source || !wanted.contains(&(pg.id as i64)) {
                    continue;
                }
                let Some(r) = pg
                    .revision_receipt
                    .request_id
                    .as_deref()
                    .and_then(|w| requests.iter().find(|r| r.id.eq_ignore_ascii_case(w)))
                    .filter(|r| r.state == "committed" && r.source_id == pg.source_id)
                else {
                    continue;
                };
                let by_import = matches!(kind_of(r).as_deref(), Some("managed_sync_import" | "managed_sync_delete"))
                    && r.source_incarnation.eq_ignore_ascii_case(&incarnation)
                    && (r.page_id.is_none() || r.page_id == Some(pg.id));
                let by_effect = || {
                    effects.iter().any(|e| {
                        e.request_id.eq_ignore_ascii_case(&r.id) && e.kind == "git"
                            && e.revision.as_deref().map(str::to_lowercase) == Some(pg.knowledge_revision.to_lowercase())
                            && json_text(e.data.get("expected_hash")).is_some()
                            && match (json_text(e.data.get("relative_path")), pg.source_path.as_deref()) {
                                (Some(path), Some(sp)) => path == sp || path.ends_with(&format!("/{sp}")),
                                _ => false,
                            }
                    })
                };
                if by_import || by_effect() {
                    out.push(json!({ "id": pg.id }));
                }
            }
            rows(out)
        }
        "page_revision_by_slug" => {
            let (source, slug) = (text(p, 0)?, text(p, 1)?);
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| pg.source_id == source && pg.slug == slug)
                .map(|pg| json!({ "revision": pg.knowledge_revision }))
                .collect())
        }
        "page_revision_by_id" => {
            let (id, source) = (big(param(p, 0)?)?, text(p, 1)?);
            rows(u64::try_from(id)
                .ok()
                .and_then(|id| read_page_by_id(read, id).ok().flatten())
                .filter(|pg| pg.source_id == source)
                .map(|pg| json!({ "revision": pg.knowledge_revision }))
                .into_iter()
                .collect())
        }
        "shared_origin_survivor" => {
            let (source, path) = (text(p, 0)?, text(p, 1)?);
            let requests = all_requests(read)?;
            let any = all_pages(read)?.into_iter().any(|d| {
                d.source_id == source && d.deleted_at_us.is_some() && d.source_path.as_deref() == Some(path.as_str())
                    && requests.iter().any(|r| {
                        r.source_id == d.source_id && r.slug == d.slug && r.operation == "delete_page" && r.state == "committed"
                            && json_text(r.outcome.as_ref().and_then(|o| o.pointer("/write_through/skipped"))).as_deref() == Some("shared_origin")
                    })
            });
            rows(if any { vec![json!({ "?column?": 1 })] } else { vec![] })
        }
        "repeated_write_failures" => {
            let (source, incarnation, slug) = (text(p, 0)?, uuid_param(&text(p, 1)?, "incarnation")?, text(p, 2)?);
            let (code, origin, class, errno) = (text(p, 3)?, text(p, 4)?, text(p, 5)?, text(p, 6)?);
            let n = all_requests(read)?
                .into_iter()
                .filter(|r| {
                    let detail = r.extra.get("error_detail");
                    let field = |k: &str| json_text(detail.and_then(|d| d.get(k)));
                    r.source_id == source && r.source_incarnation.eq_ignore_ascii_case(&incarnation) && r.slug == slug && r.state == "failed"
                        && matches!(kind_of(r).as_deref(), Some("managed_sync_import" | "managed_sync_delete"))
                        && r.error_code.as_deref() == Some(code.as_str())
                        && field("origin").unwrap_or_default() == origin && field("error_class").unwrap_or_default() == class
                        && field("errno").or_else(|| field("sqlstate")).unwrap_or_default() == errno
                })
                .count();
            rows(vec![json!({ "n": n })])
        }

        // ---- session settings, the worktree row lock and the config snapshot
        "sync_commit_on" | "admission_settings" => rows(vec![]),
        "worktree_lock" => {
            let id = uuid_param(&text(p, 0)?, "worktreeId")?;
            rows(read_worktree_record(read, &id)?.map(|_| json!({ "id": id })).into_iter().collect())
        }
        "source_unfinished_request" => {
            let source = text(p, 0)?;
            let found = all_requests(read)?.into_iter().find(|r| {
                r.source_id == source && (request_is(r, &OPEN) || !r.extra.get("recovery").is_none_or(Value::is_null))
            });
            rows(found.map(|r| json!({ "id": r.id })).into_iter().collect())
        }
        "config_all" => rows(crate::config::scan_config(read, "")?
            .into_iter()
            .map(|(key, value)| json!({ "key": key, "value": value }))
            .collect()),

        // ---- the discovery's page reads
        "live_origin_pages" | "live_origin_slugs" => {
            let source = text(p, 0)?;
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| pg.source_id == source && pg.deleted_at_us.is_none() && pg.source_path.is_some())
                .map(|pg| if name == "live_origin_pages" {
                    json!({ "slug": pg.slug, "source_path": pg.source_path, "id": pg.id })
                } else {
                    json!({ "source_path": pg.source_path, "slug": pg.slug })
                })
                .collect())
        }
        "source_identities" => {
            let source = text(p, 0)?;
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| pg.source_id == source)
                .map(|pg| json!({
                    "id": pg.id, "slug": pg.slug, "source_path": pg.source_path, "knowledge_revision": pg.knowledge_revision,
                    "deleted_at": page_row_deleted_at(&pg), "fm_id": json_text(pg.frontmatter.get("id")),
                }))
                .collect())
        }
        "deleted_page_ids" => {
            let source = text(p, 0)?;
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| pg.source_id == source && pg.deleted_at_us.is_some())
                .map(|pg| json!({ "id": pg.id }))
                .collect())
        }
        "database_only_pages" => {
            let ids = param(p, 0)?.as_array().cloned().unwrap_or_default();
            let wanted: Vec<i64> = ids.iter().filter_map(|v| big(v).ok()).collect();
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| {
                    wanted.contains(&(pg.id as i64))
                        && (pg.database_only_reason.as_deref() == Some("origin_twin")
                            || pg.database_only_reason.as_deref() == Some("unbound_source") && blank(&pg.source_path) && blank(&pg.source_uri))
                })
                .map(|pg| json!({ "id": pg.id }))
                .collect())
        }

        // ---- the wait for in-flight requests, the held rename and the blocked request
        "inflight_open_ids" | "inflight_open_work" | "open_inflight_request" => {
            let source = text(p, 0)?;
            let ids: Vec<i64> = param(p, 1)?.as_array().cloned().unwrap_or_default().iter().filter_map(|v| big(v).ok()).collect();
            let origins = texts(p, 2)?;
            let named = |r: &super::RequestRecord, with_path: bool| {
                r.page_id.is_some_and(|id| ids.contains(&(id as i64)))
                    || json_text(r.intent.get("sourcePath")).is_some_and(|sp| origins.contains(&sp))
                    || with_path && json_text(r.intent.get("path")).is_some_and(|path| origins.contains(&path))
            };
            let requests = all_requests(read)?;
            match name {
                "inflight_open_ids" => rows(requests
                    .iter()
                    .filter(|r| r.source_id == source && request_is(r, &OPEN) && named(r, true))
                    .map(|r| json!({ "id": r.id }))
                    .collect()),
                "open_inflight_request" => {
                    let found = requests
                        .iter()
                        .filter(|r| r.source_id == source && request_is(r, &OPEN) && named(r, false))
                        .min_by_key(|r| r.sequence);
                    rows(found.map(|r| json!({ "id": r.id })).into_iter().collect())
                }
                _ => {
                    let effects = all_effects(read)?;
                    let any = requests.iter().any(|r| {
                        r.source_id == source
                            && ((request_is(r, &OPEN) && named(r, true))
                                || effects.iter().any(|e| {
                                    e.request_id.eq_ignore_ascii_case(&r.id) && e.kind == "git"
                                        && (e.state == "queued" || e.state == "running")
                                        && (named(r, true)
                                            || json_text(e.data.get("relative_path")).is_some_and(|path| origins.contains(&path)))
                                }))
                    });
                    rows(if any { vec![json!({ "?column?": 1 })] } else { vec![] })
                }
            }
        }
        "inflight_committed" => {
            let ids: Vec<String> = texts(p, 0)?.into_iter().map(|id| id.to_lowercase()).collect();
            rows(all_requests(read)?
                .into_iter()
                .filter(|r| r.state == "committed" && ids.contains(&r.id.to_lowercase()))
                .map(|r| json!({
                    "id": r.id, "kind": kind_of(&r), "source_path": json_text(r.intent.get("sourcePath")),
                    "renamed": r.intent.get("renameFrom").is_some(),
                }))
                .collect())
        }
        "page_origin_by_id" => {
            let (source, id) = (text(p, 0)?, big(param(p, 1)?)?);
            rows(u64::try_from(id)
                .ok()
                .and_then(|id| read_page_by_id(read, id).ok().flatten())
                .filter(|pg| pg.source_id == source)
                .map(|pg| json!({
                    "source_path": pg.source_path, "revision": pg.knowledge_revision, "deleted": pg.deleted_at_us.is_some(),
                    "fm_id": json_text(pg.frontmatter.get("id")),
                }))
                .into_iter()
                .collect())
        }
        "request_by_request_id" => {
            let (source, request_id) = (text(p, 0)?, uuid_param(&text(p, 1)?, "request_id")?);
            rows(all_requests(read)?
                .into_iter()
                .filter(|r| r.source_id == source && r.request_id.eq_ignore_ascii_case(&request_id))
                .map(|r| json!({ "id": r.id }))
                .collect())
        }

        "sync_cursor_fence" => match op_row(read, "managed-sync", &text(p, 0)?)? {
            None => rows(vec![]),
            Some(row) => {
                let head = first(&row).cloned().unwrap_or(Value::Null);
                let ids = |items: Option<&Value>| -> Vec<Value> {
                    items.and_then(Value::as_array).map(|a| a.iter().map(|m| json!(json_text(m.get("requestId")))).collect()).unwrap_or_default()
                };
                let mut members = ids(head.get("group"));
                for g in head.get("window").and_then(Value::as_array).cloned().unwrap_or_default() {
                    members.extend(ids(Some(&g)));
                }
                rows(vec![json!({
                    "run_id": json_text(head.get("runId")), "request_id": json_text(head.pointer("/pending/requestId")),
                    "index": json_text(head.get("index")), "group": if members.is_empty() { Value::Null } else { Value::Array(members) },
                })])
            }
        },

        "blocking_refresh" => {
            let worktree = uuid_param(&text(p, 0)?, "worktreeId")?;
            let mut found: Vec<_> = super::worktree_admission::all_refreshes(read)?
                .into_iter()
                .filter(|r| r.worktree_id.eq_ignore_ascii_case(&worktree)
                    && matches!(r.state.as_str(), "draining" | "fenced" | "merged" | "recovery_required"))
                .collect();
            found.sort_by_key(|r| r.created_at_us);
            rows(found.into_iter().map(|r| json!({ "id": r.id, "state": r.state })).collect())
        }

        // ---- ghost report
        "ghost_report_read" => match op_row(read, &text(p, 0)?, &text(p, 1)?)? {
            Some(row) => rows(vec![json!({ "report": row.completed_keys, "claimed": false })]),
            None => rows(vec![]),
        },
        "ghost_held_paths" => {
            let op = text(p, 0)?;
            let mut seen = HashSet::new();
            let mut out = Vec::new();
            for fingerprint in texts(p, 1)? {
                if seen.insert(fingerprint.clone())
                    && let Some(row) = op_row(read, &op, &fingerprint)?
                {
                    out.push(json!({ "path": first_text(&row, "path") }));
                }
            }
            rows(out)
        }
        _ => {
            let _ = env;
            return Err(unknown(name));
        }
    })
}

fn pass_idle_probe(read: &dyn KvRead, p: &[Value]) -> Result<Value> {
    let (pass_op, pass_fp) = (text(p, 0)?, text(p, 1)?);
    let hwm = opt_big(p, 2)?;
    let worktree = uuid_param(&text(p, 3)?, "worktreeId")?;
    let stamp_param = opt_texts(p, 4)?;
    let (source, incarnation) = (text(p, 5)?, uuid_param(&text(p, 6)?, "incarnation")?);
    let pass = op_row(read, &pass_op, &pass_fp)?.and_then(|row| first(&row).cloned());
    let converged = pass.as_ref().and_then(|v| v.pointer("/obligations/converged"));
    let stamp: HashSet<String> = match stamp_param {
        Some(ids) => ids.into_iter().collect(),
        None => converged
            .and_then(|c| c.get("open_at_stamp"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| json_text(Some(v))).collect())
            .unwrap_or_default(),
    };
    let floor = match hwm {
        Some(h) => h,
        None => converged
            .and_then(|c| json_text(c.get("request_hwm")))
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(0),
    };
    let requests = all_requests(read)?;
    let scoped: Vec<_> = requests.iter().filter(|r| in_scope(r, &worktree, &source, &incarnation)).collect();
    let newer = scoped.iter().any(|r| (r.sequence as i64) > floor);
    let open: Vec<_> = scoped.iter().filter(|r| request_is(r, &OPEN)).collect();
    let pending = !open.is_empty();
    let open_stamped = open.iter().filter(|r| count_stamp_ids(&stamp, "r:", &r.request_id.to_lowercase())).count();
    let effects = all_effects(read)?;
    let git_open = effects
        .iter()
        .filter(|e| {
            e.kind == "git" && (e.state == "queued" || e.state == "running")
                && requests.iter().any(|r| r.id.eq_ignore_ascii_case(&e.request_id) && worktree_of(r).is_some_and(|w| w == worktree))
                && count_stamp_ids(&stamp, "e:", &e.id.to_string())
        })
        .count();
    let writeback: Vec<String> = converged
        .and_then(|c| c.get("writeback"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| json_text(Some(v)).map(|s| s.to_lowercase())).collect())
        .unwrap_or_default();
    let writeback_open = effects.iter().any(|e| {
        e.kind == "git" && e.state != "committed" && e.data.get("settled").is_none() && writeback.contains(&e.request_id.to_lowercase())
    });
    Ok(rows(vec![json!({
        "pass_row": pass.unwrap_or(Value::Null), "newer": newer, "pending": pending,
        "still_open": open_stamped + git_open, "writeback_open": writeback_open,
    })]))
}

fn revision_attestations(read: &dyn KvRead, p: &[Value]) -> Result<Value> {
    let (source, incarnation) = (text(p, 0)?, text(p, 1)?);
    let kinds = texts(p, 2)?;
    let page_ids = param(p, 3)?.as_array().cloned().unwrap_or_default();
    let request_ids = param(p, 4)?.as_array().cloned().unwrap_or_default();
    let revisions = param(p, 5)?.as_array().cloned().unwrap_or_default();
    let source_paths = param(p, 6)?.as_array().cloned().unwrap_or_default();
    let requests = all_requests(read)?;
    let effects = all_effects(read)?;
    let mut out = Vec::new();
    for i in 0..page_ids.len() {
        let (Some(request_id), Some(page_id)) = (request_ids.get(i).and_then(Value::as_str), page_ids.get(i)) else {
            continue;
        };
        let Some(r) = requests.iter().find(|r| r.id.eq_ignore_ascii_case(request_id) && r.state == "committed" && r.source_id == source) else {
            continue;
        };
        let page_id_n = big(page_id).ok();
        let revision = revisions.get(i).and_then(Value::as_str).map(str::to_lowercase);
        let source_path = source_paths.get(i).and_then(Value::as_str);
        let kind = kind_of(r);
        let arm1 = kind.map(|k| kinds.contains(&k) && r.source_incarnation.eq_ignore_ascii_case(&incarnation)
            && (r.page_id.is_none() || r.page_id.map(|v| v as i64) == page_id_n));
        let from_effect = effects.iter().find_map(|e| {
            if !e.request_id.eq_ignore_ascii_case(&r.id) || e.kind != "git" || e.revision.as_deref().map(str::to_lowercase) != revision {
                return None;
            }
            let hash = json_text(e.data.get("expected_hash"))?;
            let path = json_text(e.data.get("relative_path"))?;
            let sp = source_path?;
            (path == sp || path.ends_with(&format!("/{sp}"))).then_some(hash)
        });
        let attested = from_effect.or_else(|| {
            let sp = source_path?;
            (kind_of(r).as_deref() == Some("managed_file_import")
                && json_text(r.intent.get("sourcePath")).as_deref() == Some(sp)
                && json_text(r.intent.get("inputHash")).is_some()
                && json_text(r.intent.get("inputHash")) == json_text(r.intent.get("targetHash")))
            .then(|| json_text(r.intent.get("targetHash")))
            .flatten()
        });
        out.push(json!({ "page_id": page_id, "arm1": arm1, "attested_hash": attested }));
    }
    Ok(rows(out))
}

fn file_removing_deletes(read: &dyn KvRead, p: &[Value]) -> Result<Value> {
    let source = text(p, 0)?;
    let paths = texts(p, 1)?;
    let slugs = texts(p, 2)?;
    let page_ids = param(p, 3)?.as_array().cloned().unwrap_or_default();
    let requests = all_requests(read)?;
    let not_true = |v: Option<&Value>, key: &str, wanted: &str| json_text(v.and_then(|o| o.get(key))).as_deref() != Some(wanted);
    let mut out = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        let (Some(slug), Some(page_id)) = (slugs.get(i), page_ids.get(i).and_then(|v| big(v).ok())) else { continue };
        let same_page = |r: &super::RequestRecord| r.page_id.is_none() || r.page_id.map(|v| v as i64) == Some(page_id);
        let newest = requests
            .iter()
            .filter(|r| {
                r.source_id == source && &r.slug == slug && r.state == "committed" && r.operation == "delete_page" && same_page(r)
                    && not_true(r.outcome.as_ref(), "noop", "true") && not_true(r.outcome.as_ref(), "retention", "true")
                    && not_true(Some(&r.intent), "retention", "true")
            })
            .max_by_key(|r| r.sequence);
        let Some(d) = newest else { continue };
        let written = json_text(d.outcome.as_ref().and_then(|o| o.pointer("/write_through/written"))).as_deref() == Some("true");
        if !written || json_text(d.outcome.as_ref().and_then(|o| o.get("status"))).as_deref() == Some("purged") {
            continue;
        }
        let brought_back = requests.iter().any(|l| {
            l.source_id == source && &l.slug == slug && l.sequence > d.sequence && l.state == "committed"
                && (l.operation == "restore_page" || l.operation == "put_page") && same_page(l)
                && not_true(l.outcome.as_ref(), "noop", "true") && not_true(l.outcome.as_ref(), "status", "duplicate")
        });
        if !brought_back {
            out.push(json!({ "path": path }));
        }
    }
    Ok(rows(out))
}

fn tail_slugs(read: &dyn KvRead, p: &[Value]) -> Result<Value> {
    let run_ids = texts(p, 0)?;
    let passes = jsonb_param(p, 1)?;
    let source = text(p, 2)?;
    let mut slugs: std::collections::BTreeSet<String> = Default::default();
    for run_id in &run_ids {
        if let Some(row) = op_row(read, "managed-sync-manifest", run_id)?
            && let Some(items) = row.completed_keys.as_array()
        {
            for e in items {
                if json_text(e.get("action")).as_deref() == Some("import")
                    && let Some(slug) = json_text(e.get("slug"))
                {
                    slugs.insert(slug);
                }
            }
        }
    }
    let mut windows = Vec::new();
    for pass in passes.as_array().cloned().unwrap_or_default() {
        let (Some(run_id), Some(since), Some(at)) = (json_text(pass.get("run_id")), json_text(pass.get("since")), json_text(pass.get("at"))) else {
            continue;
        };
        windows.push((run_id, parse_timestamptz(&since, "since")?, parse_timestamptz(&at, "at")?));
    }
    for r in all_requests(read)? {
        let compacted = r.extra.get("compacted").and_then(Value::as_bool).unwrap_or(false);
        let recovery_null = r.extra.get("recovery").is_none_or(Value::is_null);
        if !recovery_null || compacted || r.state != "committed" || r.source_id != source
            || kind_of(&r).as_deref() != Some("managed_sync_import")
        {
            continue;
        }
        let (Some(done), Some(pass_id)) = (r.completed_at_us, json_text(r.intent.get("passId"))) else { continue };
        if windows.iter().any(|(run_id, since, at)| *run_id == pass_id && done >= *since && done <= *at) {
            slugs.insert(r.slug.clone());
        }
    }
    Ok(rows(slugs.into_iter().take(1001).map(|slug| json!({ "slug": slug })).collect()))
}

fn run_write(tx: &mut dyn KvWrite, env: &dyn Env, name: &str, p: &[Value]) -> Result<Value> {
    Ok(match name {
        "failure_clear" => {
            let key = text(p, 0)?;
            let unfinished = op_row(&*tx, "managed-sync", &key)?
                .is_some_and(|row| first_text(&row, "done").unwrap_or_else(|| "false".into()) != "true");
            if unfinished || op_row(&*tx, "managed-sync-failure", &key)?.is_none() {
                rows(vec![])
            } else {
                delete_op_checkpoint_in(tx, "managed-sync-failure", &key)?;
                rows(vec![json!({ "fingerprint": key })])
            }
        }
        "tail_record_run" => {
            let (op, fingerprint, run_id, cursor_key) = (text(p, 0)?, text(p, 1)?, text(p, 2)?, text(p, 3)?);
            if let Some(cursor) = op_row(&*tx, "managed-sync", &cursor_key)? {
                let count = |key: &str| {
                    first(&cursor)
                        .and_then(|v| json_text(v.pointer(&format!("/counts/{key}"))))
                        .and_then(|n| n.trim().parse::<i64>().ok())
                        .unwrap_or(0)
                };
                let extract = first(&cursor).and_then(|v| json_text(v.pointer("/processingOptions/noExtract"))).as_deref() != Some("true");
                let extract = extract && first_text(&cursor, "companyReceiptId").is_none();
                let item = json!({
                    "run_id": run_id, "at": jsonb_now(env),
                    "changed": count("added") + count("modified") + count("deleted"), "extract": extract,
                });
                append_tail(tx, env, &op, &fingerprint, item)?;
            }
            rows(vec![])
        }
        "tail_record_pass" => {
            let (op, fingerprint, pass_id) = (text(p, 0)?, text(p, 1)?, text(p, 2)?);
            let changed = big(param(p, 3)?)?;
            let extract = param(p, 4)?.as_bool().ok_or_else(|| StoreError::invalid("extract is not a boolean"))?;
            let mut item = Map::new();
            item.insert("run_id".into(), json!(pass_id));
            item.insert("at".into(), json!(jsonb_now(env)));
            item.insert("changed".into(), json!(changed));
            item.insert("extract".into(), json!(extract));
            if let Some(since) = opt_text(p, 5)? {
                item.insert("since".into(), json!(since));
            }
            append_tail(tx, env, &op, &fingerprint, Value::Object(item))?;
            rows(vec![])
        }
        "tail_clear" => {
            let (op, fingerprint) = (text(p, 0)?, text(p, 1)?);
            let expected = jsonb_param(p, 2)?;
            if op_row(&*tx, &op, &fingerprint)?.is_some_and(|row| row.completed_keys == expected) {
                delete_op_checkpoint_in(tx, &op, &fingerprint)?;
            }
            rows(vec![])
        }
        "pass_cost_insert" => {
            let (op, fingerprint) = (text(p, 0)?, text(p, 1)?);
            if op_row(&*tx, &op, &fingerprint)?.is_none() {
                put_row(tx, env, &op, &fingerprint, json!([jsonb_param(p, 2)?]))?;
            }
            rows(vec![])
        }
        "checkpoint_put_first" => {
            put_row(tx, env, &text(p, 0)?, &text(p, 1)?, json!([jsonb_param(p, 2)?]))?;
            rows(vec![])
        }
        "checkpoint_delete_if_first" => {
            let (op, fingerprint, expected) = (text(p, 0)?, text(p, 1)?, jsonb_param(p, 2)?);
            if op_row(&*tx, &op, &fingerprint)?.is_some_and(|row| first(&row) == Some(&expected)) {
                delete_op_checkpoint_in(tx, &op, &fingerprint)?;
                rows(vec![json!({ "?column?": 1 })])
            } else {
                rows(vec![])
            }
        }
        "checkpoint_delete" => {
            let (op, fingerprint) = (text(p, 0)?, text(p, 1)?);
            if op_row(&*tx, &op, &fingerprint)?.is_some() {
                delete_op_checkpoint_in(tx, &op, &fingerprint)?;
                rows(vec![json!({ "?column?": 1 })])
            } else {
                rows(vec![])
            }
        }
        "failure_record" => failure_record(tx, env, p)?,
        "source_chunker_stamp" => {
            let id = text(p, 0)?;
            if let Some(mut source) = read_source(&*tx, &id)? {
                source.chunker_version = Some(text(p, 1)?);
                put_json(tx, &source_key(&id), &source)?;
            }
            rows(vec![])
        }
        "legacy_markers_insert" => {
            let op = text(p, 0)?;
            for item in jsonb_param(p, 1)?.as_array().cloned().unwrap_or_default() {
                let Some(fingerprint) = json_text(item.get("fingerprint")) else { continue };
                if op_row(&*tx, &op, &fingerprint)?.is_none() {
                    put_row(tx, env, &op, &fingerprint, json!([item.get("value").cloned().unwrap_or(Value::Null)]))?;
                }
            }
            rows(vec![])
        }
        "page_set_type" => {
            let (source, slug, page_type) = (text(p, 0)?, text(p, 1)?, text(p, 2)?);
            if let Some(mut page) = crate::pages::read_page(&*tx, &source, &slug)?
                && page.page_type != page_type
            {
                // A changed type takes a new knowledge revision, as the revision trigger reads the type.
                page.page_type = page_type;
                page.knowledge_revision = env.new_uuid();
                page.text_projection_revision = None;
                crate::pages::write_page(tx, &page)?;
            }
            rows(vec![])
        }
        "page_clear_unbound" => {
            let (source, slug) = (text(p, 0)?, text(p, 1)?);
            if let Some(mut page) = crate::pages::read_page(&*tx, &source, &slug)?
                && page.database_only_reason.as_deref() == Some("unbound_source")
            {
                page.database_only_reason = None;
                put_json(tx, &keys::page(&source, &slug), &page)?;
            }
            rows(vec![])
        }
        "delete_tombstone_record" => {
            let (op, incarnation, pass_id, run_id, request_id) = (text(p, 0)?, text(p, 1)?, opt_text(p, 2)?, opt_text(p, 3)?, text(p, 4)?);
            let (source, slug) = (text(p, 5)?, text(p, 6)?);
            if let Some(page) = crate::pages::read_page(&*tx, &source, &slug)?
                && page.deleted_at_us == Some(env.now_micros())
            {
                let record = json!({
                    "source_id": page.source_id, "incarnation": incarnation, "page_id": page.id, "slug": page.slug,
                    "source_path": page.source_path, "pass_id": pass_id, "run_id": run_id, "request_id": request_id,
                    "deleted_at": jsonb_timestamp(env.now_micros()),
                });
                put_row(tx, env, &op, &page.id.to_string(), json!([record]))?;
            }
            rows(vec![])
        }
        "slice_put" => {
            put_row(tx, env, &text(p, 0)?, &text(p, 1)?, jsonb_param(p, 2)?)?;
            rows(vec![])
        }
        "slice_clear" => {
            let (op, fingerprint, target) = (text(p, 0)?, text(p, 1)?, opt_text(p, 2)?);
            if let Some(row) = op_row(&*tx, &op, &fingerprint)?
                && target.as_ref().is_none_or(|t| first_text(&row, "target").as_deref() == Some(t.as_str()))
            {
                delete_op_checkpoint_in(tx, &op, &fingerprint)?;
            }
            rows(vec![])
        }
        "retry_paths_remove" => {
            let (op, fingerprint, taken) = (text(p, 0)?, text(p, 1)?, texts(p, 2)?);
            if let Some(row) = op_row(&*tx, &op, &fingerprint)? {
                let mut keys_now = row.completed_keys.clone();
                if let Some(Value::Object(head)) = keys_now.as_array_mut().and_then(|a| a.first_mut()) {
                    let kept: Vec<Value> = head
                        .get("paths")
                        .and_then(Value::as_array)
                        .map(|a| a.iter().filter(|v| v.as_str().is_none_or(|s| !taken.iter().any(|t| t == s))).cloned().collect())
                        .unwrap_or_default();
                    head.insert("paths".into(), Value::Array(kept));
                }
                put_row(tx, env, &op, &fingerprint, keys_now)?;
            }
            rows(vec![])
        }
        "retry_paths_prune" => {
            let (op, fingerprint) = (text(p, 0)?, text(p, 1)?);
            let empty = op_row(&*tx, &op, &fingerprint)?
                .and_then(|row| first(&row).and_then(|v| v.get("paths")).and_then(Value::as_array).map(Vec::is_empty))
                .unwrap_or(false);
            if empty {
                delete_op_checkpoint_in(tx, &op, &fingerprint)?;
            }
            rows(vec![])
        }
        "ghost_report_claim" => {
            let (op, fingerprint) = (text(p, 0)?, text(p, 1)?);
            let interval_us = big(param(p, 2)?)?.saturating_mul(1000);
            let prior = op_row(&*tx, &op, &fingerprint)?;
            let synced = read_source(&*tx, &fingerprint)?.and_then(|s| s.last_sync_at_us);
            let now = env.now_micros();
            let claimed = match (&prior, synced) {
                (None, Some(_)) => {
                    put_row(tx, env, &op, &fingerprint, json!([]))?;
                    true
                }
                (Some(row), Some(at)) if row.updated_at_us <= now.saturating_sub(interval_us) && at > row.updated_at_us => {
                    put_row(tx, env, &op, &fingerprint, row.completed_keys.clone())?;
                    true
                }
                _ => false,
            };
            rows(vec![json!({ "report": prior.map_or(Value::Null, |row| row.completed_keys), "claimed": claimed })])
        }
        "ghost_report_write" => {
            let (op, fingerprint) = (text(p, 0)?, text(p, 1)?);
            if op_row(&*tx, &op, &fingerprint)?.is_some() {
                put_row(tx, env, &op, &fingerprint, jsonb_param(p, 2)?)?;
            }
            rows(vec![])
        }
        _ => return Err(unknown(name)),
    })
}

/// `recordManagedSyncFailure`'s upsert of the failure row `fingerprint = $1` with `$2` (a one-element array).
fn failure_record(tx: &mut dyn KvWrite, env: &dyn Env, p: &[Value]) -> Result<Value> {
    let key = text(p, 0)?;
    let incoming_all = jsonb_param(p, 1)?;
    let incoming = incoming_all.get(0).cloned().unwrap_or(Value::Null);
    let stored = match op_row(&*tx, "managed-sync-failure", &key)? {
        None => incoming_all.clone(),
        Some(row) => {
            let was = first(&row).cloned().unwrap_or(Value::Null);
            let t = |v: &Value, k: &str| json_text(v.get(k));
            let same = ["path", "code", "message"].iter().all(|k| matches!((t(&was, k), t(&incoming, k)), (Some(a), Some(b)) if a == b));
            let repeats = t(&was, "repeats").and_then(|n| n.trim().parse::<i64>().ok()).unwrap_or(1) + 1;
            let merge = |base: &Value, extra: Value| -> Value {
                let mut object = base.as_object().cloned().unwrap_or_default();
                if let Value::Object(more) = extra {
                    object.extend(more);
                }
                Value::Object(object)
            };
            let same_observation = matches!((t(&was, "observation_id"), t(&incoming, "observation_id")), (Some(a), Some(b)) if a == b);
            if same_observation {
                let invocation = t(&incoming, "invocation");
                if same && invocation.is_some() && t(&was, "invocation") != invocation {
                    json!([merge(&was, json!({ "repeats": repeats, "invocation": invocation }))])
                } else {
                    row.completed_keys.clone()
                }
            } else if t(&was, "target") != t(&incoming, "target") {
                incoming_all.clone()
            } else {
                let attempts = t(&was, "attempts").and_then(|n| n.trim().parse::<i64>().ok()).unwrap_or(0) + 1;
                json!([merge(&incoming, json!({
                    "first_seen": t(&was, "first_seen"), "attempts": attempts, "repeats": if same { repeats } else { 1 },
                }))])
            }
        }
    };
    put_row(tx, env, "managed-sync-failure", &key, stored.clone())?;
    Ok(rows(vec![json!({ "completed_keys": stored })]))
}

/// `ON CONFLICT (op,fingerprint) DO UPDATE ... completed_keys = CASE WHEN jsonb_array_length(..) >= 16 THEN (keys - 0) || new
/// ELSE keys || new END`: the obligations of one source, the oldest dropped at 16.
fn append_tail(tx: &mut dyn KvWrite, env: &dyn Env, op: &str, fingerprint: &str, item: Value) -> Result<()> {
    let mut keys_now: Vec<Value> = op_row(&*tx, op, fingerprint)?
        .and_then(|row| row.completed_keys.as_array().cloned())
        .unwrap_or_default();
    if keys_now.len() >= 16 {
        keys_now.remove(0);
    }
    keys_now.push(item);
    put_row(tx, env, op, fingerprint, Value::Array(keys_now))
}
