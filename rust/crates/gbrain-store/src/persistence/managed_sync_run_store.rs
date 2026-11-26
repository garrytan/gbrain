//! The managed sync's run statements (`runSyncStatement`, `src/core/engine-sql/managed-sync-store.ts`; rust/docs/store/managed-mode.md,
//! "Managed sync"): the cursor rows a company or dry-run cursor reads and writes, the waiver and hold-gate reads, the cursor-key
//! retirement, the window and lane predecessor reads, the drain's stall probe and the folded stamp's refused-checkpoint read.
//!
//! The statements answer what their Postgres text answers, from the records the store keeps (see managed_sync_store.rs for the
//! parameter and lock conventions). `read` and `write` return `None` for a name that is not one of these, and the caller falls
//! through to managed_sync_store.rs. A cursor row's `completed_keys` is compared as a JSON value, as the `completed_keys=$3::text::jsonb`
//! compare of the SQL does: an object's keys are unordered. The row locks (`FOR UPDATE`, `FOR SHARE`) are not reads here, as in
//! managed_sync_store.rs: a transaction is Serialized, and under optimistic transactions the rows read are in its read set.

use serde_json::{Value, json};

use super::managed_sync_store::{
    first, first_text, jsonb_param, kind_of, op_row, op_rows, opt_big, param, put_row, request_is,
    rows, text, texts,
};
use super::op_checkpoint::delete_op_checkpoint_in;
use super::projection_queue::parse_timestamptz;
use super::worktrees::read_worktree_record;
use super::write_claim_terms::worktree_of;
use super::{RequestRecord, all_requests, json_text, request_by_id, uuid_param};
use crate::chunks::{in_live_body, read_chunks, read_segment_view, segmented};
use crate::env::Env;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite};
use crate::pages::{PageRecord, all_pages};

const OPEN: [&str; 3] = ["queued", "running", "recovering"];
const CURSOR_OP: &str = "managed-sync";
const MANIFEST_OP: &str = "managed-sync-manifest";

fn recovering(r: &RequestRecord) -> bool {
    !r.extra.get("recovery").is_none_or(Value::is_null)
}

fn same_uuid(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn worktree_is(r: &RequestRecord, worktree: &str) -> bool {
    worktree_of(r).is_some_and(|w| same_uuid(&w, worktree))
}

/// `PAGE_MATCH` of `UNFINISHED_PAGE_REQUEST_SQL`: `$3` source, `$4` slug, `$5` page id, `$6` its text, `$7` path, `$8` origin.
struct PageMatch {
    source: String,
    slug: String,
    page_id: Option<i64>,
    page_id_text: Option<String>,
    path: Option<String>,
    origin: Option<String>,
}

impl PageMatch {
    fn of(p: &[Value]) -> Result<Self> {
        let nullable = |i: usize| -> Result<Option<String>> {
            Ok(match param(p, i)? {
                Value::Null => None,
                _ => Some(text(p, i)?),
            })
        };
        Ok(Self {
            source: text(p, 2)?,
            slug: text(p, 3)?,
            page_id: opt_big(p, 4)?,
            page_id_text: nullable(5)?,
            path: nullable(6)?,
            origin: nullable(7)?,
        })
    }

    fn matches(&self, r: &RequestRecord) -> bool {
        if r.source_id != self.source {
            return false;
        }
        let rename = r.intent.get("renameFrom");
        let rename_text = |key: &str| json_text(rename.and_then(|v| v.get(key)));
        let eq = |left: Option<String>, right: &Option<String>| left.is_some() && left == *right;
        r.slug == self.slug
            || self.page_id.is_some() && r.page_id.map(|n| n as i64) == self.page_id
            || rename_text("slug").as_deref() == Some(self.slug.as_str())
            || eq(rename_text("pageId"), &self.page_id_text)
            || self.path.is_some()
                && (eq(json_text(r.intent.get("path")), &self.path)
                    || eq(json_text(r.intent.get("sourcePath")), &self.origin)
                    || eq(rename_text("sourcePath"), &self.origin))
    }
}

/// `UNFINISHED_PAGE_REQUEST_SQL`: an unfinished request for the page by worktree pending, worktree recovery, or (no worktree)
/// source incarnation pending.
fn unfinished_page_request(read: &dyn KvRead, p: &[Value]) -> Result<Value> {
    let (worktree, incarnation) = (
        uuid_param(&text(p, 0)?, "worktreeId")?,
        uuid_param(&text(p, 1)?, "incarnation")?,
    );
    let page = PageMatch::of(p)?;
    let found = all_requests(read)?.into_iter().any(|r| {
        page.matches(&r)
            && (worktree_is(&r, &worktree) && (request_is(&r, &OPEN) || recovering(&r))
                || worktree_of(&r).is_none()
                    && same_uuid(&r.source_incarnation, &incarnation)
                    && request_is(&r, &OPEN))
    });
    Ok(rows(if found {
        vec![json!({ "?column?": 1 })]
    } else {
        vec![]
    }))
}

fn kernel_row(page: &PageRecord, read: &dyn KvRead) -> Result<Value> {
    let chunks = read_chunks(read, page.id)?;
    let view = read_segment_view(read, page.id)?;
    let segmented_page = segmented(page);
    let live = |c: &&crate::chunks::ChunkRecord| in_live_body(c, segmented_page, &view);
    let has_embedded = chunks.iter().filter(live).any(|c| c.embed.has_vector());
    let unembedded = chunks.iter().filter(live).any(|c| !c.embed.has_vector());
    let mode = crate::aliases::contextual_retrieval_mode(read, page.id)?;
    Ok(json!({
        "id": page.id, "slug": page.slug, "chunker_version": page.chunker_version,
        "text_projection_revision": page.text_projection_revision, "knowledge_revision": page.knowledge_revision,
        "source_path": page.source_path, "mode_pending": mode.is_none() && has_embedded, "unembedded": unembedded,
    }))
}

/// `kernelPageSql(...) WHERE <filter> AND p.deleted_at IS NULL`: the kernel's page read.
fn kernel_pages(read: &dyn KvRead, wanted: &dyn Fn(&PageRecord) -> bool) -> Result<Value> {
    let mut out = Vec::new();
    for page in all_pages(read)? {
        if page.deleted_at_us.is_none() && wanted(&page) {
            out.push(kernel_row(&page, read)?);
        }
    }
    Ok(rows(out))
}

/// `completed_keys->0->>key` of the cursor row `fingerprint`.
fn cursor_first(
    read: &dyn KvRead,
    fingerprint: &str,
) -> Result<Option<super::housekeeping::HousekeepingRow>> {
    op_row(read, CURSOR_OP, fingerprint)
}

/// The read statements of this block, or `None` for a name that is not one.
pub(super) fn read(
    read: &dyn KvRead,
    env: &dyn Env,
    name: &str,
    p: &[Value],
) -> Result<Option<Value>> {
    Ok(Some(match name {
        "cursor_head_locked" => match cursor_first(read, &text(p, 0)?)? {
            None => rows(vec![]),
            Some(row) => {
                let head = first(&row);
                rows(vec![json!({
                    "run_id": first_text(&row, "runId"),
                    "index": head.and_then(|v| v.get("index")).cloned().unwrap_or(Value::Null),
                    "request_id": head.and_then(|v| json_text(v.pointer("/pending/requestId"))),
                })])
            }
        },
        "pending_intent_held" => match op_row(read, &text(p, 0)?, &text(p, 1)?)? {
            None => rows(vec![]),
            Some(row) => {
                let pending = first(&row).and_then(|v| v.get("pending"));
                let incoming = jsonb_param(p, 2)?;
                let same = pending
                    .and_then(|v| v.get("intent"))
                    .map(|intent| *intent == incoming);
                rows(vec![
                    json!({ "request_id": pending.and_then(|v| json_text(v.get("requestId"))), "same": same }),
                ])
            }
        },
        "unfinished_page_request" => unfinished_page_request(read, p)?,
        "stale_page_requests" => {
            let (worktree, run, index) = (
                uuid_param(&text(p, 0)?, "worktreeId")?,
                text(p, 1)?,
                text(p, 2)?,
            );
            let mut found: Vec<RequestRecord> = all_requests(read)?
                .into_iter()
                .filter(|r| {
                    worktree_is(r, &worktree)
                        && json_text(r.intent.get("runId")).as_deref() == Some(run.as_str())
                        && matches!(
                            kind_of(r).as_deref(),
                            Some("managed_sync_import" | "managed_sync_delete")
                        )
                        && json_text(r.intent.get("index")).as_deref() == Some(index.as_str())
                        && matches!(r.state.as_str(), "failed" | "cancelled" | "conflict")
                })
                .collect();
            found.sort_by_key(|r| r.sequence);
            rows(
                found
                    .into_iter()
                    .map(|r| json!({ "request_id": r.request_id }))
                    .collect(),
            )
        }
        "waiver_settings" => rows(vec![]),
        "waiver_pages" => {
            let (source, slugs) = (text(p, 0)?, texts(p, 1)?);
            rows(all_pages(read)?
                .into_iter()
                .filter(|pg| pg.source_id == source && slugs.contains(&pg.slug))
                .map(|pg| json!({
                    "id": pg.id, "slug": pg.slug, "deleted": pg.deleted_at_us.is_some(), "knowledge_revision": pg.knowledge_revision,
                }))
                .collect())
        }
        "kernel_pages_by_slug" | "kernel_pages_by_slug_unmanifested" => {
            let (source, slugs) = (text(p, 0)?, texts(p, 1)?);
            kernel_pages(read, &|pg| {
                pg.source_id == source && slugs.contains(&pg.slug)
            })?
        }
        "kernel_page_by_id" | "kernel_page_by_id_unmanifested" => {
            let id = super::managed_sync_store::big(param(p, 0)?)?;
            kernel_pages(read, &|pg| pg.id as i64 == id)?
        }
        "cursor_open_requests" => {
            let (source, key) = (text(p, 0)?, text(p, 1)?);
            let mut found: Vec<RequestRecord> = all_requests(read)?
                .into_iter()
                .filter(|r| {
                    r.source_id == source
                        && json_text(r.intent.get("cursorKey")).as_deref() == Some(key.as_str())
                        && (request_is(r, &OPEN) || recovering(r))
                })
                .collect();
            found.sort_by_key(|r| r.sequence);
            rows(found.iter().map(RequestRecord::to_row).collect())
        }
        "request_for_update" => rows(
            request_by_id(read, &text(p, 0)?)?
                .iter()
                .map(RequestRecord::to_row)
                .collect(),
        ),
        "group_predecessor" => {
            let (kind, id, sequence, group) = (
                text(p, 0)?,
                text(p, 1)?,
                super::managed_sync_store::big(param(p, 2)?)?,
                text(p, 3)?,
            );
            let previous = all_requests(read)?
                .into_iter()
                .filter(|r| {
                    r.principal_kind == kind
                        && r.principal_id == id
                        && (r.sequence as i64) < sequence
                        && json_text(r.intent.get("group")).as_deref() == Some(group.as_str())
                })
                .max_by_key(|r| r.sequence);
            rows(
                previous
                    .map(|r| json!({ "state": r.state, "request_id": r.request_id }))
                    .into_iter()
                    .collect(),
            )
        }
        "request_state_by_principal" => {
            let (kind, id, request) = (
                text(p, 0)?,
                text(p, 1)?,
                uuid_param(&text(p, 2)?, "requestId")?,
            );
            rows(
                all_requests(read)?
                    .into_iter()
                    .filter(|r| {
                        r.principal_kind == kind
                            && r.principal_id == id
                            && same_uuid(&r.request_id, &request)
                    })
                    .map(|r| json!({ "state": r.state }))
                    .collect(),
            )
        }
        "stall_probe" => stall_probe(read, env, &uuid_param(&text(p, 0)?, "id")?)?,
        "refused_checkpoint" => refused_checkpoint(read, p)?,
        _ => return Ok(None),
    }))
}

/// The oldest unfinished request of `r`'s worktree (`ORDER BY e.sequence LIMIT 1`), the head `r` waits behind.
fn stall_probe(read: &dyn KvRead, env: &dyn Env, id: &str) -> Result<Value> {
    let Some(r) = request_by_id(read, id)? else {
        return Ok(rows(vec![]));
    };
    let worktree = worktree_of(&r);
    let head = match &worktree {
        Some(w) => all_requests(read)?
            .into_iter()
            .filter(|e| worktree_is(e, w) && (request_is(e, &OPEN) || recovering(e)))
            .min_by_key(|e| e.sequence),
        None => None,
    };
    let owner = match &worktree {
        Some(w) => read_worktree_record(read, &w.to_lowercase())?.and_then(|w| w.owner_host_id),
        None => None,
    };
    let lapsed = match head
        .as_ref()
        .and_then(|h| json_text(h.extra.get("claim_expires_at")))
    {
        Some(at) => parse_timestamptz(&at, "claim_expires_at")? < env.now_micros(),
        None => false,
    };
    Ok(rows(vec![json!({
        "state": r.state, "blocked_reason": r.blocked_reason, "recovering": recovering(&r), "worktree_id": worktree,
        "head_id": head.as_ref().map(|h| h.id.clone()), "head_state": head.as_ref().map(|h| h.state.clone()),
        "head_claim_phase": head.as_ref().and_then(|h| h.extra.get("claim_phase")).cloned().unwrap_or(Value::Null),
        "head_token": head.as_ref().and_then(|h| json_text(h.extra.get("execution_token"))),
        "head_lapsed": lapsed, "head_kind": head.as_ref().and_then(kind_of), "owner_host_id": owner,
    })]))
}

/// The folded stamp's read: a failed, conflicted or cancelled sync checkpoint of the source that no later request supersedes
/// (`supersessionSql`). `p[1]` carries the page-removal operations the SQL text inlines.
fn refused_checkpoint(read: &dyn KvRead, p: &[Value]) -> Result<Value> {
    let source = text(p, 0)?;
    let removals = texts(p, 1)
        .map_err(|_| StoreError::invalid("refused_checkpoint needs the page-removal operations"))?;
    let all = all_requests(read)?;
    let checkpoint = |r: &RequestRecord| {
        kind_of(r).unwrap_or_else(|| "managed_sync_checkpoint".into()) == "managed_sync_checkpoint"
    };
    let found = all.iter().any(|r| {
        r.source_id == source
            && r.slug == "__managed_sync_checkpoint__"
            && !r
                .extra
                .get("compacted")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            && r.operation == "submit_job"
            && kind_of(r).as_deref() == Some("managed_sync_checkpoint")
            && matches!(r.state.as_str(), "failed" | "conflict" | "cancelled")
            && !all.iter().any(|c| {
                let pending = request_is(c, &OPEN);
                let committed = c.state == "committed";
                c.source_id == r.source_id
                    && c.slug == r.slug
                    && c.sequence > r.sequence
                    && (c.digest == r.digest && (committed || c.state == "failed" || pending)
                        || (committed || pending) && removals.contains(&c.operation)
                        || committed
                            && c.operation == "submit_job"
                            && checkpoint(r)
                            && checkpoint(c))
            })
    });
    Ok(rows(if found {
        vec![json!({ "?column?": 1 })]
    } else {
        vec![]
    }))
}

/// The write statements of this block, or `None` for a name that is not one.
pub(super) fn write(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    name: &str,
    p: &[Value],
) -> Result<Option<Value>> {
    Ok(Some(match name {
        "cursor_manifest_insert" | "cursor_insert" => {
            let (op, fingerprint) = (text(p, 0)?, text(p, 1)?);
            if op_row(&*tx, &op, &fingerprint)?.is_some() {
                rows(vec![])
            } else {
                put_row(tx, env, &op, &fingerprint, jsonb_param(p, 2)?)?;
                rows(if name == "cursor_insert" {
                    vec![json!({ "fingerprint": fingerprint })]
                } else {
                    vec![]
                })
            }
        }
        "cursor_swap" => {
            let (op, fingerprint) = (text(p, 0)?, text(p, 1)?);
            let (before, next) = (jsonb_param(p, 2)?, jsonb_param(p, 3)?);
            if op_row(&*tx, &op, &fingerprint)?.is_some_and(|row| row.completed_keys == before) {
                put_row(tx, env, &op, &fingerprint, next)?;
                rows(vec![json!({ "fingerprint": fingerprint })])
            } else {
                rows(vec![])
            }
        }
        "checkpoint_touch" => {
            let (op, fingerprint) = (text(p, 0)?, text(p, 1)?);
            if let Some(row) = op_row(&*tx, &op, &fingerprint)? {
                put_row(tx, env, &op, &fingerprint, row.completed_keys)?;
            }
            rows(vec![])
        }
        "finished_cursor_delete" => {
            let fingerprint = text(p, 0)?;
            match op_row(&*tx, CURSOR_OP, &fingerprint)? {
                Some(row) if first_text(&row, "done").as_deref() == Some("true") => {
                    delete_op_checkpoint_in(tx, CURSOR_OP, &fingerprint)?;
                    rows(vec![json!({ "run_id": first_text(&row, "runId") })])
                }
                _ => rows(vec![]),
            }
        }
        "manifest_delete_unshared" => {
            let run = text(p, 0)?;
            let shared = op_rows(&*tx, CURSOR_OP)?
                .iter()
                .any(|(_, row)| first_text(row, "runId").as_deref() == Some(run.as_str()));
            if !shared && op_row(&*tx, MANIFEST_OP, &run)?.is_some() {
                delete_op_checkpoint_in(tx, MANIFEST_OP, &run)?;
            }
            rows(vec![])
        }
        "prefix_delete" => {
            let (op, prefix) = (text(p, 0)?, text(p, 1)?);
            for (fingerprint, _) in op_rows(&*tx, &op)? {
                if fingerprint.starts_with(&prefix) {
                    delete_op_checkpoint_in(tx, &op, &fingerprint)?;
                }
            }
            rows(vec![])
        }
        _ => return Ok(None),
    }))
}
