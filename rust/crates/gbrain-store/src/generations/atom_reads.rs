//! The reads of the atom generation adapter (`src/core/generations/adapters/atoms.ts`) and of
//! page.ts `pageVersionEvidence`: the statements of `engine-sql/generation-atom-reads.ts`.
//!
//! Members: readAtomOriginInput (a live page origin's id, content hash, knowledge revision and
//! stored body size), listProducerVersionRows (the stored versions with a body that a producer
//! wrote of the listed pages) and listAtomWriteReceipts (the committed `managed_atom_page` write
//! receipts with content of the listed pages whose activation, if they name one, activated).
//! These are internal reads of derived pages and the write journal, not caller page reads, so they
//! take no page read policy. They add no keys: they read the page records (`pages.rs`), the version
//! records, the body state (`page_body.rs`), the journal's request records (`journal.rs`) and the
//! activation rows (`activations.rs`).
//!
//! The statements have no ORDER BY. The version rows come by slug in byte order, then version id;
//! the receipts come in request key order. The callers key both by slug.

use super::activations::activation_activated;
use super::fence_evidence::page_versions;
use super::page_rows::text_of;
use super::{GenerationRecord, RECORD};
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::journal::RequestRecord;
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::page_body::segmented_reference;
use crate::pages::read_page;
use crate::{Store, keys};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// The `extract_atoms` producer: `v.frontmatter->>'extracted_by' LIKE 'extract\_atoms%'`.
const EXTRACT_ATOMS: &str = "extract_atoms";

fn slug_set<'a>(op: &str, slugs: &'a [String]) -> Result<BTreeSet<&'a str>> {
    for slug in slugs {
        no_nul(op, &[("slugs", slug.as_str())])?;
    }
    Ok(slugs.iter().map(String::as_str).collect())
}

/// The held atom inputs a backlog leaves out (#10270, `heldAtomInputExclusionSql` in
/// src/core/cycle/extract-atoms-generation.ts): per held `atom` generation whose hold id is one of `hold_ids`, that is not a
/// partial hold (`held_context.partial` is not `true`) and records an input pin, the triple (source id, owner key, input pin).
/// A page is held for its current input when its source, `source_slug:<slug>` and either its content hash or
/// `<content hash>:<id>:<knowledge revision>` is in the set.
pub(crate) fn held_atom_inputs(
    read: &dyn KvRead,
    hold_ids: &BTreeSet<&str>,
) -> Result<BTreeSet<(String, String, String)>> {
    let mut held = BTreeSet::new();
    if hold_ids.is_empty() {
        return Ok(held);
    }
    let mut failure = None;
    scan_prefix(
        read,
        &[keys::DERIVED_GENERATION, RECORD],
        false,
        &mut |_, v| {
            let record = match serde_json::from_slice::<GenerationRecord>(v) {
                Ok(record) => record,
                Err(e) => {
                    failure = Some(StoreError::from(e));
                    return false;
                }
            };
            let partial = record
                .held_context
                .as_ref()
                .and_then(|context| context.get("partial"))
                .is_some_and(|partial| {
                    partial.as_str() == Some("true") || partial == &Value::Bool(true)
                });
            if let (Some(hold_id), Some(pin)) = (record.hold_id.as_deref(), record.input_pin.as_ref())
                && record.kind == "atom"
                && record.state == "held"
                && !partial
                && hold_ids.contains(hold_id)
            {
                held.insert((record.source_id.clone(), record.owner_key.clone(), pin.clone()));
            }
            true
        },
    )?;
    match failure {
        Some(e) => Err(e),
        None => Ok(held),
    }
}

impl Store {
    /// `readAtomOriginInput(sourceId, slug)`: the live page as `{ id, content_hash, revision,
    /// body_bytes }`, or null. A segmented page answers its body state's
    /// `body_bytes`; an inline page answers the UTF-8 bytes of its body and timeline, a NULL column
    /// counting 0.
    pub fn read_atom_origin_input(&self, source_id: &str, slug: &str) -> Result<Value> {
        no_nul(
            "readAtomOriginInput",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(Value::Null);
        };
        let body_bytes = match segmented_reference(&*read, page.id)? {
            Some((_, bytes)) => bytes,
            None => {
                let truth = page.compiled_truth.as_deref().map_or(0, str::len);
                let timeline = page.timeline.as_deref().map_or(0, str::len);
                Some(i64::try_from(truth + timeline).unwrap_or(i64::MAX))
            }
        };
        Ok(json!({
            "id": page.id,
            "content_hash": page.content_hash,
            "revision": page.knowledge_revision,
            "body_bytes": body_bytes,
        }))
    }

    /// `listProducerVersionRows(sourceId, slugs, producer)`: the stored versions with a body (a
    /// version title is never NULL here) of
    /// the pages `slugs` (deleted or not) whose frontmatter `extracted_by` starts with the
    /// producer, as `{ slug, type, title, compiled_truth, timeline, frontmatter, tags,
    /// live_visibility }`; `live_visibility` is the page's own `visibility` value.
    pub fn list_producer_version_rows(
        &self,
        source_id: &str,
        slugs: &[String],
        producer: &str,
    ) -> Result<Vec<Value>> {
        const OP: &str = "listProducerVersionRows";
        no_nul(OP, &[("sourceId", source_id)])?;
        if producer != EXTRACT_ATOMS {
            return Err(StoreError::new(
                INVALID_ARGUMENT,
                format!(
                    "{OP}: not a version producer: {}",
                    serde_json::to_string(producer)?
                ),
            ));
        }
        let slugs = slug_set(OP, slugs)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for slug in slugs {
            let Some(page) = read_page(&*read, source_id, slug)? else {
                continue;
            };
            let live_visibility = page.frontmatter.get("visibility").cloned();
            for version in page_versions(&*read, source_id, slug)? {
                let Some(body) = version.compiled_truth.as_deref() else {
                    continue;
                };
                if !text_of(&version.frontmatter, "extracted_by")
                    .is_some_and(|by| by.starts_with(EXTRACT_ATOMS))
                {
                    continue;
                }
                rows.push(json!({
                    "slug": page.slug,
                    "type": version.page_type,
                    "title": version.title,
                    "compiled_truth": body,
                    "timeline": version.timeline.as_deref(),
                    "frontmatter": version.frontmatter,
                    "tags": version.tags,
                    "live_visibility": live_visibility,
                }));
            }
        }
        Ok(rows)
    }

    /// `listAtomWriteReceipts(sourceId, slugs)`: the committed requests of the pages `slugs`
    /// whose intent is a `managed_atom_page` write with a `content` key and names no activation
    /// or one in state `activated`, as `{ slug, content }`.
    pub fn list_atom_write_receipts(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        const OP: &str = "listAtomWriteReceipts";
        no_nul(OP, &[("sourceId", source_id)])?;
        let slugs = slug_set(OP, slugs)?;
        let read = self.read()?;
        let mut receipts = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &[keys::REQUEST], false, &mut |_, v| {
            match serde_json::from_slice::<RequestRecord>(v) {
                Ok(request) => {
                    if request.source_id == source_id
                        && slugs.contains(request.slug.as_str())
                        && request.state == "committed"
                    {
                        receipts.push(request);
                    }
                }
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        let mut rows = Vec::new();
        for request in receipts {
            let Some(intent) = request.intent.as_object() else {
                continue;
            };
            if text_of(intent, "kind").as_deref() != Some("managed_atom_page")
                || !intent.contains_key("content")
            {
                continue;
            }
            if let Some(activation) = text_of(intent, "activationId")
                && !activation_activated(&*read, &activation)?
            {
                continue;
            }
            rows.push(json!({ "slug": request.slug, "content": text_of(intent, "content") }));
        }
        Ok(rows)
    }
}
