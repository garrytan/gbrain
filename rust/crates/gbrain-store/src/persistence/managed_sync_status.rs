//! The managed sync's page-fault, older-cursor, `gbrain sync status` and freshness statements (lane LM slice 2, part B):
//! the named statements of `src/core/engine-sql/managed-sync-store.ts` that `sync-page-fault.ts`, `sync-prepare.ts`,
//! `sync-status.ts`, `sync-dry-run-writer.ts`, `sync-stop-class.ts` and `sync-freshness.ts` send, answered from the same
//! records `managed_sync_store.rs` reads. `managed_sync_store.rs` offers each statement name here first.
//!
//! Each statement answers what its Postgres text answers: the same columns, filters and row choice. A timestamp column
//! comes back as its ISO text (`Date`s are rebuilt from it by the callers) and a `bigint` count as a number.
//!
//! Locks. `cursor_keys_locked` is the SQL's `FOR UPDATE`: not a read lock here. The guarantee holds as in
//! `managed_sync_store.rs` (an explicit transaction is Serialized; under optimistic transactions the row read is in the
//! read set, so a racing change aborts the commit with `write_conflict`). No file lock, process mutex or busy error.

use serde::Deserialize;
use serde_json::{Value, json};

use super::managed_sync_store::{
    big, first, first_text, kind_of, op_row, param, put_row, request_is, rows, text, texts,
};
use super::worktrees::{SOURCE_BINDING, SourceBindingRecord, scan_records};
use super::{all_requests, json_text, sql_like, uuid_param};
use crate::chunks::visible_chunks;
use crate::env::{Env, iso};
use crate::error::{Result, StoreError};
use crate::get_json;
use crate::kv::{KvRead, KvWrite};
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use crate::sources::read_source;

const OPEN: [&str; 3] = ["queued", "running", "recovering"];
/// `LANDING_RECEIPT_LIMIT` (`landing-gaps.ts`), the `LIMIT` written into the `landing_receipts` statement.
const LANDING_RECEIPT_LIMIT: usize = 2000;

/// The strings `syncKnockOnSql` splices from `sync-knock-on.ts`, which its store member adds as the statement's last parameter.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnockOnRules {
    sync_knock_on_origin: String,
    legacy_cancel_messages: Vec<String>,
    legacy_cancel_patterns: Vec<String>,
    earlier_page_refusal: String,
}

fn is_text(v: &Option<&Value>, want: &str) -> bool {
    v.and_then(|v| json_text(Some(v))).as_deref() == Some(want)
}

/// `syncKnockOnSql(r)`: never NULL.
fn knock_on(r: &super::RequestRecord, rules: &KnockOnRules) -> bool {
    let recovery = r.extra.get("recovery").is_some_and(|v| !v.is_null());
    let started = r
        .extra
        .get("publication_started")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !(matches!(r.state.as_str(), "cancelled" | "failed" | "conflict") && !recovery && !started) {
        return false;
    }
    let (code, message) = (r.error_code.as_deref(), r.error_message.as_deref());
    let detail = r.extra.get("error_detail");
    is_text(
        &detail.and_then(|d| d.get("origin")),
        &rules.sync_knock_on_origin,
    ) || (r.state == "cancelled"
        && code == Some("cancelled")
        && message.is_some_and(|m| {
            rules.legacy_cancel_messages.iter().any(|l| l == m)
                || rules.legacy_cancel_patterns.iter().any(|p| sql_like(m, p))
        }))
        || (matches!(r.state.as_str(), "conflict" | "failed")
            && code == Some("revision_conflict")
            && message == Some(rules.earlier_page_refusal.as_str()))
}

/// `percentile_cont(p) WITHIN GROUP (ORDER BY v)` over `values` (sorted here); NULL when there are none.
fn percentile(values: &mut [f64], p: f64) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    let rank = p * (values.len() - 1) as f64;
    let (lo, hi) = (rank.floor() as usize, rank.ceil() as usize);
    json!(values[lo] + (rank - lo as f64) * (values[hi] - values[lo]))
}

/// A page by `(source, slug)`, the first by id (the SQL's `LIMIT 1` takes any).
fn page_by_slug(read: &dyn KvRead, source: &str, slug: &str) -> Result<Option<PageRecord>> {
    Ok(all_pages(read)?
        .into_iter()
        .filter(|p| p.source_id == source && p.slug == slug)
        .min_by_key(|p| p.id))
}

/// `chunkVisibleFilter('p', 'cc', currentTextProjectionFilter)` over the page's chunks: `(count, count without embedded_at, newest embedded_at)`.
fn embedded_chunks(read: &dyn KvRead, page_id: Option<u64>) -> Result<(i64, i64, Option<i64>)> {
    let Some(page) = page_id
        .and_then(|id| read_page_by_id(read, id).transpose())
        .transpose()?
    else {
        return Ok((0, 0, None));
    };
    if page.text_projection_revision.as_deref() != Some(page.knowledge_revision.as_str()) {
        return Ok((0, 0, None));
    }
    let chunks = visible_chunks(read, page.id)?;
    let missing = chunks
        .iter()
        .filter(|c| c.embed.embedded_at_us.is_none())
        .count() as i64;
    let last = chunks.iter().filter_map(|c| c.embed.embedded_at_us).max();
    Ok((chunks.len() as i64, missing, last))
}

/// `freshness_aggregate`: the commit-to-searchable and commit-to-embedded latencies of the window's samples.
fn freshness_aggregate(read: &dyn KvRead, env: &dyn Env, p: &[Value]) -> Result<Value> {
    let worktree = uuid_param(&text(p, 0)?, "worktreeId")?;
    let incarnation = uuid_param(&text(p, 1)?, "incarnation")?;
    let hours = big(param(p, 2)?)?;
    let times: Value = serde_json::from_str(&text(p, 3)?)
        .map_err(|_| StoreError::invalid("a jsonb parameter is not valid JSON"))?;
    // `to_timestamp(value::double precision)`: seconds to microseconds.
    let committed: std::collections::BTreeMap<String, i64> = times
        .as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| {
                    json_text(Some(v))
                        .and_then(|t| t.trim().parse::<f64>().ok())
                        .map(|s| (k.clone(), (s * 1e6).round() as i64))
                })
                .collect()
        })
        .unwrap_or_default();
    let since = env
        .now_micros()
        .saturating_sub(hours.saturating_mul(3_600_000_000));
    let requests = all_requests(read)?;
    let samples: Vec<(&super::RequestRecord, i64, i64)> = requests
        .iter()
        .filter(|r| {
            r.extra
                .get("worktree_id")
                .and_then(Value::as_str)
                .is_some_and(|w| w.eq_ignore_ascii_case(&worktree))
                && r.source_incarnation.eq_ignore_ascii_case(&incarnation)
                && r.state == "committed"
                && kind_of(r).as_deref() == Some("managed_sync_import")
                && r.completed_at_us.is_some_and(|at| at > since)
                && json_text(r.intent.get("from")).is_some()
                && json_text(r.intent.get("working"))
                    .as_deref()
                    .unwrap_or("false")
                    != "true"
        })
        .filter_map(|r| {
            let at = committed.get(&json_text(r.intent.get("target"))?)?;
            Some((r, *at, r.completed_at_us.unwrap_or_default()))
        })
        .collect();
    let (mut searchable, mut embedded, mut pending) = (Vec::new(), Vec::new(), 0i64);
    if let Some(floor) = samples.iter().map(|(r, _, _)| r.sequence).min() {
        let sources: std::collections::HashSet<&str> = samples
            .iter()
            .map(|(r, _, _)| r.source_id.as_str())
            .collect();
        let mut later: std::collections::HashMap<(&str, &str), u64> =
            std::collections::HashMap::new();
        for l in requests.iter().filter(|l| {
            l.state == "committed" && sources.contains(l.source_id.as_str()) && l.sequence > floor
        }) {
            let entry = later
                .entry((l.source_id.as_str(), l.slug.as_str()))
                .or_insert(l.sequence);
            *entry = (*entry).max(l.sequence);
        }
        for (r, committed_at, completed_at) in &samples {
            let page_id = match r.page_id {
                Some(id) => Some(id),
                None => page_by_slug(read, &r.source_id, &r.slug)?.map(|p| p.id),
            };
            let superseded = later
                .get(&(r.source_id.as_str(), r.slug.as_str()))
                .is_some_and(|n| *n > r.sequence);
            let (n, missing, last_at) = embedded_chunks(read, page_id)?;
            searchable.push(((completed_at - committed_at) as f64 / 1e6).max(0.0));
            if !superseded && n > 0 && missing == 0 && last_at.is_some_and(|at| at >= *completed_at)
            {
                embedded.push(((last_at.unwrap_or_default() - committed_at) as f64 / 1e6).max(0.0));
            }
            if !superseded && n > 0 && missing > 0 {
                pending += 1;
            }
        }
    }
    Ok(rows(vec![json!({
        "samples": samples.len(), "s50": percentile(&mut searchable.clone(), 0.5), "s95": percentile(&mut searchable, 0.95),
        "embedded": embedded.len(), "e50": percentile(&mut embedded.clone(), 0.5), "e95": percentile(&mut embedded, 0.95), "pending": pending,
    })]))
}

/// One read statement of part B; `None` when `name` is not one of them.
pub(super) fn read(
    read: &dyn KvRead,
    env: &dyn Env,
    name: &str,
    p: &[Value],
) -> Result<Option<Value>> {
    Ok(Some(match name {
        "page_revision_writer" => {
            let (id, source) = (big(param(p, 0)?)?, text(p, 1)?);
            rows(u64::try_from(id)
                .ok()
                .and_then(|id| read_page_by_id(read, id).ok().flatten())
                .filter(|pg| pg.source_id == source)
                .map(|pg| json!({ "revision": pg.knowledge_revision, "writer": pg.revision_receipt.request_id }))
                .into_iter()
                .collect())
        }
        "request_writer" => {
            let id = uuid_param(&text(p, 0)?, "id")?;
            rows(get_json::<super::RequestRecord>(read, &crate::keys::request(&id))?
                .map(|r| json!({
                    "request_id": r.request_id.to_lowercase(), "operation": r.operation, "kind": json_text(r.intent.get("kind")),
                    "state": r.state, "incarnation": r.source_incarnation.to_lowercase(), "page_id": r.page_id,
                }))
                .into_iter()
                .collect())
        }
        "page_deleted_revision_writer" => {
            let (id, source) = (big(param(p, 0)?)?, text(p, 1)?);
            rows(u64::try_from(id)
                .ok()
                .and_then(|id| read_page_by_id(read, id).ok().flatten())
                .filter(|pg| pg.source_id == source)
                .map(|pg| json!({ "revision": pg.knowledge_revision, "writer": pg.revision_receipt.request_id, "deleted": pg.deleted_at_us.is_some() }))
                .into_iter()
                .collect())
        }
        "live_page_at_origin" => {
            let (source, id, path) = (text(p, 0)?, big(param(p, 1)?)?, text(p, 2)?);
            let any = all_pages(read)?.into_iter().any(|pg| {
                pg.source_id == source
                    && pg.deleted_at_us.is_none()
                    && pg.id as i64 != id
                    && pg.source_path.as_deref() == Some(path.as_str())
            });
            rows(if any {
                vec![json!({ "?column?": 1 })]
            } else {
                vec![]
            })
        }
        "manifest_entry" => match op_row(read, "managed-sync-manifest", &text(p, 0)?)? {
            None => rows(vec![]),
            Some(row) => {
                let index = big(param(p, 1)?)?;
                let items = row
                    .completed_keys
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                // `jsonb -> integer`: a negative index counts from the end.
                let at = if index < 0 {
                    items.len() as i64 + index
                } else {
                    index
                };
                let entry = usize::try_from(at)
                    .ok()
                    .and_then(|i| items.get(i))
                    .cloned()
                    .unwrap_or(Value::Null);
                rows(vec![json!({ "entry": entry })])
            }
        },
        "cursor_keys_locked" => match op_row(read, "managed-sync", &text(p, 0)?)? {
            Some(row) => rows(vec![json!({ "completed_keys": row.completed_keys })]),
            None => rows(vec![]),
        },
        "manifest_length" => match op_row(read, "managed-sync-manifest", &text(p, 0)?)? {
            None => rows(vec![]),
            Some(row) => match row.completed_keys.as_array() {
                Some(items) => rows(vec![json!({ "count": items.len() })]),
                None => {
                    return Err(StoreError::invalid(
                        "cannot get array length of a non-array",
                    ));
                }
            },
        },
        "failure_supersession" => {
            let (source, key) = (text(p, 0)?, text(p, 1)?);
            let failure_at =
                op_row(read, "managed-sync-failure", &key)?.map(|row| iso(row.updated_at_us));
            let bindings: Vec<SourceBindingRecord> =
                scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?
                    .into_iter()
                    .filter(|b| b.source_id == source)
                    .collect();
            let bound = |r: &super::RequestRecord| {
                r.extra
                    .get("worktree_id")
                    .and_then(Value::as_str)
                    .is_some_and(|w| {
                        bindings.iter().any(|b| {
                            b.worktree_id.eq_ignore_ascii_case(w)
                                && b.source_incarnation
                                    .eq_ignore_ascii_case(&r.source_incarnation)
                        })
                    })
            };
            let requests = all_requests(read)?;
            let committed_at = requests
                .iter()
                .filter(|r| {
                    bound(r)
                        && r.state == "committed"
                        && sql_like(&kind_of(r).unwrap_or_default(), "managed_sync_%")
                })
                .filter_map(|r| r.completed_at_us)
                .max();
            let admitted_at = requests
                .iter()
                .filter(|r| {
                    bound(r)
                        && r.state != "committed"
                        && matches!(
                            kind_of(r).as_deref(),
                            Some("managed_sync_import" | "managed_sync_delete")
                        )
                })
                .map(|r| r.created_at_us)
                .max();
            rows(vec![json!({
                "now_at": iso(env.now_micros()), "failure_at": failure_at,
                "committed_at": committed_at.map(iso), "admitted_at": admitted_at.map(iso),
            })])
        }
        "source_company_brain" => match read_source(read, &text(p, 0)?)? {
            Some(s) if s.config.contains_key("company_brain") => rows(vec![json!({ "id": s.id })]),
            _ => rows(vec![]),
        },
        "source_live_incarnation" => match read_source(read, &text(p, 0)?)?.filter(|s| !s.archived)
        {
            Some(s) => rows(vec![json!({ "incarnation": s.incarnation })]),
            None => rows(vec![]),
        },
        "knock_on_requests" => {
            let ids: Vec<String> = texts(p, 0)?
                .into_iter()
                .map(|id| id.to_lowercase())
                .collect();
            let rules: KnockOnRules = serde_json::from_value(param(p, 1)?.clone())
                .map_err(|_| StoreError::invalid("the knock-on rules are not readable"))?;
            rows(
                all_requests(read)?
                    .into_iter()
                    .filter(|r| ids.contains(&r.request_id.to_lowercase()) && knock_on(r, &rules))
                    .map(|r| json!({ "request_id": r.request_id.to_lowercase() }))
                    .collect(),
            )
        }
        "live_cursor_rows" => {
            let (source, incarnation) = (text(p, 0)?, text(p, 1)?);
            let requests = all_requests(read)?;
            let mut found: Vec<(i64, String, Value)> = Vec::new();
            for (fingerprint, row) in super::managed_sync_store::op_rows(read, "managed-sync")? {
                if first_text(&row, "sourceId").as_deref() != Some(source.as_str())
                    || first_text(&row, "incarnation").as_deref() != Some(incarnation.as_str())
                {
                    continue;
                }
                let header = first(&row).cloned().unwrap_or(Value::Null);
                let at = iso(row.updated_at_us);
                // `to_char(.., 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`: milliseconds.
                let stamp = format!("{}Z", &at[..23]);
                let pending = json_text(header.pointer("/pending/requestId"));
                // LEFT JOIN: one row per request of this source whose request_id is the pending one, else one row with no state.
                let states: Vec<Option<String>> = match pending {
                    Some(id) => {
                        let matched: Vec<_> = requests
                            .iter()
                            .filter(|r| {
                                r.source_id == source && r.request_id.eq_ignore_ascii_case(&id)
                            })
                            .map(|r| Some(r.state.clone()))
                            .collect();
                        if matched.is_empty() {
                            vec![None]
                        } else {
                            matched
                        }
                    }
                    None => vec![None],
                };
                for state in states {
                    found.push((row.updated_at_us, fingerprint.clone(), json!({ "fingerprint": fingerprint, "header": header, "updated_at": stamp, "state": state })));
                }
            }
            // ORDER BY c.updated_at DESC (ties by fingerprint here), LIMIT 20.
            found.sort_by(|a, b| {
                b.0.cmp(&a.0)
                    .then_with(|| a.1.as_bytes().cmp(b.1.as_bytes()))
            });
            rows(found.into_iter().take(20).map(|(_, _, v)| v).collect())
        }
        "open_writer_requests" => {
            let source = text(p, 0)?;
            let open: Vec<_> = all_requests(read)?
                .into_iter()
                .filter(|r| r.source_id == source && request_is(r, &OPEN))
                .collect();
            let age = open
                .iter()
                .map(|r| r.created_at_us)
                .min()
                .map(|at| (env.now_micros() - at) as f64 / 1e6);
            rows(vec![json!({ "n": open.len(), "age": age })])
        }
        "recorded_stop" => {
            let (key, run_id) = (text(p, 0)?, text(p, 1)?);
            match op_row(read, "managed-sync-failure", &key)?
                .filter(|row| first_text(row, "run_id").as_deref() == Some(run_id.as_str()))
            {
                Some(row) => rows(vec![
                    json!({ "gbrain_version": first_text(&row, "gbrain_version") }),
                ]),
                None => rows(vec![]),
            }
        }
        "landing_binding" => {
            let source = text(p, 0)?;
            let Some(live) = read_source(read, &source)? else {
                return Ok(Some(rows(vec![])));
            };
            rows(scan_records::<SourceBindingRecord>(read, SOURCE_BINDING, "source binding")?
                .into_iter()
                .filter(|b| b.source_id == source && b.source_incarnation.eq_ignore_ascii_case(&live.incarnation))
                .map(|b| json!({ "worktree_id": b.worktree_id.to_lowercase(), "incarnation": b.source_incarnation.to_lowercase() }))
                .collect())
        }
        "landing_receipts" => {
            let worktree = uuid_param(&text(p, 0)?, "worktreeId")?;
            let incarnation = uuid_param(&text(p, 1)?, "incarnation")?;
            let since = env
                .now_micros()
                .saturating_sub(big(param(p, 2)?)?.saturating_mul(3_600_000_000));
            let mut newest: Vec<_> = all_requests(read)?
                .into_iter()
                .filter(|r| {
                    r.extra
                        .get("worktree_id")
                        .and_then(Value::as_str)
                        .is_some_and(|w| w.eq_ignore_ascii_case(&worktree))
                        && r.source_incarnation.eq_ignore_ascii_case(&incarnation)
                        && r.state == "committed"
                        && sql_like(&kind_of(r).unwrap_or_default(), "managed_sync_%")
                        && r.completed_at_us.is_some_and(|at| at > since)
                        && !r.slug.is_empty()
                })
                .collect();
            // ORDER BY completed_at DESC, sequence DESC LIMIT 2000, then one row per slug (the highest sequence), slugs in byte order.
            newest.sort_by(|a, b| {
                b.completed_at_us
                    .cmp(&a.completed_at_us)
                    .then_with(|| b.sequence.cmp(&a.sequence))
            });
            newest.truncate(LANDING_RECEIPT_LIMIT);
            let mut per_slug: std::collections::BTreeMap<Vec<u8>, &super::RequestRecord> =
                std::collections::BTreeMap::new();
            for r in &newest {
                let slot = per_slug.entry(r.slug.as_bytes().to_vec()).or_insert(r);
                if r.sequence > slot.sequence {
                    *slot = r;
                }
            }
            let now = env.now_micros();
            rows(per_slug
                .into_values()
                .map(|r| json!({
                    "slug": r.slug, "kind": kind_of(r), "completed_at": r.completed_at_us.map(iso),
                    "age": (now - r.completed_at_us.unwrap_or(now)) as f64 / 1e6,
                }))
                .collect())
        }
        "freshness_aggregate" => freshness_aggregate(read, env, p)?,
        _ => return Ok(None),
    }))
}

/// One write statement of part B; `None` when `name` is not one of them.
pub(super) fn write(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    name: &str,
    p: &[Value],
) -> Result<Option<Value>> {
    Ok(Some(match name {
        // `jsonb_set(completed_keys, '{0,done}', 'true')`: the cursor header's `done`; a row with no object first element is unchanged.
        // `jsonb_set(completed_keys, '{0,meta,needs_human_at}', stamp)` on a hold of this code whose meta has no stamp yet.
        "hold_needs_human_stamp" => {
            let (op, fingerprint, stamp, code) =
                (text(p, 0)?, text(p, 1)?, text(p, 2)?, text(p, 3)?);
            let mut stamped = false;
            if let Some(row) = op_row(&*tx, &op, &fingerprint)?
                .filter(|row| first_text(row, "code").as_deref() == Some(code.as_str()))
            {
                let mut keys = row.completed_keys.clone();
                if let Some(meta) = keys
                    .as_array_mut()
                    .and_then(|a| a.first_mut())
                    .and_then(|h| h.get_mut("meta"))
                    .and_then(Value::as_object_mut)
                    && !meta.contains_key("needs_human_at")
                {
                    meta.insert("needs_human_at".into(), json!(stamp));
                    stamped = true;
                }
                if stamped {
                    put_row(tx, env, &op, &fingerprint, keys)?;
                }
            }
            rows(if stamped {
                vec![json!({ "?column?": 1 })]
            } else {
                vec![]
            })
        }
        "cursor_mark_done" => {
            let key = text(p, 0)?;
            if let Some(row) = op_row(&*tx, "managed-sync", &key)? {
                let mut keys = row.completed_keys.clone();
                if let Some(header) = keys
                    .as_array_mut()
                    .and_then(|a| a.first_mut())
                    .and_then(Value::as_object_mut)
                {
                    header.insert("done".into(), Value::Bool(true));
                }
                put_row(tx, env, "managed-sync", &key, keys)?;
            }
            rows(vec![])
        }
        _ => return Ok(None),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> KnockOnRules {
        serde_json::from_value(json!({
            "syncKnockOnOrigin": "sync_knock_on",
            "legacyCancelMessages": ["An earlier page of the same sync did not commit."],
            "legacyCancelPatterns": ["Its predecessor request % was never admitted."],
            "earlierPageRefusal": "An earlier page of this sync did not commit.",
        }))
        .unwrap()
    }

    fn request(
        state: &str,
        code: Option<&str>,
        message: Option<&str>,
        extra: Value,
    ) -> super::super::RequestRecord {
        let mut record = json!({
            "id": "00000000-0000-4000-8000-000000000001", "principal_kind": "local_cli", "principal_id": "writer", "request_id": "00000000-0000-4000-8000-000000000002",
            "operation": "submit_job", "source_id": "work", "source_incarnation": "00000000-0000-4000-8000-000000000003", "slug": "notes/a", "digest": "d",
            "intent": { "kind": "managed_sync_import" }, "authority": {}, "sequence": 1, "state": state, "error_code": code, "error_message": message,
            "created_at_us": 0, "updated_at_us": 0,
        });
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            record[k] = v;
        }
        serde_json::from_value(record).unwrap()
    }

    #[test]
    fn knock_on_matches_the_sql_predicate() {
        let rules = rules();
        // The typed marker, a legacy cancel message and pattern, and the earlier-page refusal are knock-ons ...
        assert!(knock_on(
            &request(
                "failed",
                None,
                None,
                json!({ "error_detail": { "origin": "sync_knock_on" } })
            ),
            &rules
        ));
        assert!(knock_on(
            &request(
                "cancelled",
                Some("cancelled"),
                Some("An earlier page of the same sync did not commit."),
                json!({})
            ),
            &rules
        ));
        assert!(knock_on(
            &request(
                "cancelled",
                Some("cancelled"),
                Some("Its predecessor request 7 was never admitted."),
                json!({})
            ),
            &rules
        ));
        assert!(knock_on(
            &request(
                "conflict",
                Some("revision_conflict"),
                Some("An earlier page of this sync did not commit."),
                json!({})
            ),
            &rules
        ));
        // ... a committed receipt, an operator's cancel, a receipt holding a recovery and one whose publication started are not.
        assert!(!knock_on(
            &request(
                "committed",
                None,
                None,
                json!({ "error_detail": { "origin": "sync_knock_on" } })
            ),
            &rules
        ));
        assert!(!knock_on(
            &request(
                "cancelled",
                Some("cancelled"),
                Some("Cancelled before publication."),
                json!({})
            ),
            &rules
        ));
        assert!(!knock_on(
            &request(
                "failed",
                None,
                None,
                json!({ "error_detail": { "origin": "sync_knock_on" }, "recovery": { "state": "x" } })
            ),
            &rules
        ));
        assert!(!knock_on(
            &request(
                "failed",
                None,
                None,
                json!({ "error_detail": { "origin": "sync_knock_on" }, "publication_started": true })
            ),
            &rules
        ));
    }

    #[test]
    fn percentile_interpolates_like_percentile_cont() {
        assert_eq!(percentile(&mut [], 0.5), Value::Null);
        assert_eq!(percentile(&mut [4.0], 0.95), json!(4.0));
        assert_eq!(percentile(&mut [3.0, 1.0, 2.0], 0.5), json!(2.0));
        assert_eq!(percentile(&mut [10.0, 20.0], 0.5), json!(15.0));
        assert!(
            (percentile(&mut [0.0, 10.0, 20.0, 30.0], 0.95)
                .as_f64()
                .unwrap()
                - 28.5)
                .abs()
                < 1e-9
        );
    }
}
