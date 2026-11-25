//! The two reads of the pin records: the evidence join of one answer revision (`listQuestionEvidenceJoin`) and the
//! published answers of a source with the pages each cites (`listPublishedQuestionAnswers`). Both are the statements of
//! `src/core/engine-sql/question-reads.ts`, read over main's pin records (`jobs/pinned_questions.rs`) and the evidence.
//!
//! The join reads each cited page's `pages.generation` from the store's per-page counter (`page_generation.rs`).

use super::evidence_of;
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::facts::{FactRecord, float4_out, md5_hex, read_fact};
use crate::jobs::answered_pins;
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::sources::read_source;
use crate::takes::{TakeRecord, read_take};
use crate::timeline::TimelineRecord;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// The frontmatter key a quarantined page carries (`QUARANTINE_KEY`).
const QUARANTINE_KEY: &str = "quarantine";

/// `pages.generation` of `p`: the per-page counter the store keeps like the SQL engines' trigger.
fn page_generation(p: &PageRecord) -> u64 {
    p.generation
}

/// `md5(f.fact || '|' || f.visibility || '|' || COALESCE(f.entity_slug, '') || '|' || f.kind)`.
fn fact_hash(f: &FactRecord) -> String {
    md5_hex(&format!(
        "{}|{}|{}|{}",
        f.fact,
        f.visibility,
        f.entity_slug.as_deref().unwrap_or(""),
        f.kind
    ))
}

/// `md5(t.date::text || '|' || t.summary || '|' || t.detail)`.
fn timeline_hash(t: &TimelineRecord) -> String {
    md5_hex(&format!("{}|{}|{}", t.date, t.summary, t.detail))
}

/// `md5(k.claim || '|' || k.holder || '|' || COALESCE(k.weight::text, '') || '|' || COALESCE(k.resolved_outcome::text, ''))`.
fn take_hash(k: &TakeRecord) -> String {
    let outcome = k
        .resolved_outcome
        .map_or("", |o| if o { "true" } else { "false" });
    md5_hex(&format!(
        "{}|{}|{}|{}",
        k.claim,
        k.holder,
        float4_out(k.weight),
        outcome
    ))
}

/// `CASE WHEN p.body_storage = 'segmented' THEN p.content_hash ELSE md5(p.compiled_truth) END` (a segmented page has no
/// body column: its text is NULL).
fn body_hash(p: &PageRecord) -> Option<String> {
    if p.compiled_truth.is_null() {
        p.content_hash.clone()
    } else {
        Some(md5_hex(&p.compiled_truth))
    }
}

/// Whether the page `(source_id, slug)`, live or soft-deleted, carries the quarantine key.
fn quarantined(read: &dyn KvRead, source_id: &str, slug: Option<&str>) -> Result<bool> {
    Ok(match slug {
        Some(slug) => read_page(read, source_id, slug)?
            .is_some_and(|p| p.frontmatter.contains_key(QUARANTINE_KEY)),
        None => false,
    })
}

/// The timeline entries `ids` name, each looked for on the page the evidence names first (an entry stays on its page
/// unless a page merge moved it) and by one scan of every entry for the ids that are not there.
fn timeline_entries(
    read: &dyn KvRead,
    wanted: &[(Option<u64>, u64)],
) -> Result<Vec<(u64, Option<TimelineRecord>)>> {
    let mut found: Vec<(u64, Option<TimelineRecord>)> = Vec::new();
    for &(page, id) in wanted {
        let mut hit = None;
        if let Some(page) = page {
            scan_prefix(read, &keys::timeline_prefix(page), false, &mut |k, v| {
                if k.len() >= 8 && keys::be8(&k[k.len() - 8..]) == Some(id) {
                    hit = serde_json::from_slice::<TimelineRecord>(v).ok();
                    return false;
                }
                true
            })?;
        }
        found.push((id, hit));
    }
    let missing: BTreeSet<u64> = found
        .iter()
        .filter(|(_, t)| t.is_none())
        .map(|(id, _)| *id)
        .collect();
    if !missing.is_empty() {
        scan_prefix(read, &[keys::TIMELINE], false, &mut |k, v| {
            if k.len() >= 8
                && keys::be8(&k[k.len() - 8..]).is_some_and(|id| missing.contains(&id))
                && let Ok(t) = serde_json::from_slice::<TimelineRecord>(v)
            {
                for (id, slot) in &mut found {
                    if *id == t.id && slot.is_none() {
                        *slot = Some(t.clone());
                    }
                }
            }
            true
        })?;
    }
    Ok(found)
}

impl Store {
    /// `listQuestionEvidenceJoin(questionId, answerRevision)`: one row per evidence row of that answer revision (by
    /// evidence id), with the `p_`, `f_`, `t_` and `k_` columns of what it cites: the page (live or soft-deleted, with
    /// its source's `archived`), the fact (same source), the timeline entry and the take. Columns of a cited row that
    /// is absent are null, except the two booleans of a fact, which are false.
    pub fn list_question_evidence_join(
        &self,
        question_id: i64,
        answer_revision: i32,
    ) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let Ok(question_id) = u64::try_from(question_id) else {
            return Ok(json!([]));
        };
        let evidence: Vec<_> = evidence_of(&*read, question_id)?
            .into_iter()
            .filter(|e| e.answer_revision == answer_revision)
            .collect();
        let wanted: Vec<(Option<u64>, u64)> = evidence
            .iter()
            .filter(|e| e.kind == "timeline")
            .filter_map(|e| {
                let id = u64::try_from(e.item_id?).ok()?;
                Some((e.page_id.and_then(|p| u64::try_from(p).ok()), id))
            })
            .collect();
        let entries = timeline_entries(&*read, &wanted)?;
        let mut rows = Vec::new();
        for e in &evidence {
            let page = match e.page_id.and_then(|p| u64::try_from(p).ok()) {
                Some(id) => read_page_by_id(&*read, id)?,
                None => None,
            };
            let archived = match &page {
                Some(p) => read_source(&*read, &p.source_id)?.map(|s| s.archived),
                None => None,
            };
            let item = e.item_id.and_then(|i| u64::try_from(i).ok());
            let fact = match item {
                Some(id) if e.kind == "fact" => {
                    read_fact(&*read, id)?.filter(|f| f.source_id == e.source_id)
                }
                _ => None,
            };
            let entry = match item {
                Some(id) if e.kind == "timeline" => entries
                    .iter()
                    .find(|(i, _)| *i == id)
                    .and_then(|(_, t)| t.clone()),
                _ => None,
            };
            let take = match item {
                Some(id) if e.kind == "take" => read_take(&*read, id)?,
                _ => None,
            };
            let f_quarantined = match &fact {
                Some(f) => quarantined(&*read, &f.source_id, f.source_markdown_slug.as_deref())?,
                None => false,
            };
            let mut row = Map::new();
            let mut put = |k: &str, v: Value| {
                row.insert(k.to_string(), v);
            };
            put("sentence_id", json!(e.sentence_id));
            put("kind", json!(e.kind));
            put("source_id", json!(e.source_id));
            put("page_id", json!(e.page_id));
            put("page_generation", json!(e.page_generation));
            put("page_revision", json!(e.page_revision));
            put("content_hash", json!(e.content_hash));
            put("p_id", json!(page.as_ref().map(|p| p.id)));
            put("p_generation", json!(page.as_ref().map(page_generation)));
            put(
                "p_revision",
                json!(page.as_ref().map(|p| p.knowledge_revision.clone())),
            );
            put(
                "p_deleted",
                json!(page.as_ref().and_then(|p| p.deleted_at_us).map(iso)),
            );
            put("p_source_archived", json!(archived));
            put("p_body_hash", json!(page.as_ref().and_then(body_hash)));
            put("f_id", json!(fact.as_ref().map(|f| f.id)));
            put(
                "f_expired",
                json!(fact.as_ref().and_then(|f| f.expired_at_us).map(iso)),
            );
            put(
                "f_valid_until_passed",
                json!(
                    fact.as_ref()
                        .is_some_and(|f| f.valid_until_us.is_some_and(|u| u <= now))
                ),
            );
            put(
                "f_superseded",
                json!(fact.as_ref().and_then(|f| f.superseded_by)),
            );
            put("f_hash", json!(fact.as_ref().map(fact_hash)));
            put("f_source_quarantined", json!(f_quarantined));
            put("t_id", json!(entry.as_ref().map(|t| t.id)));
            put("t_hash", json!(entry.as_ref().map(timeline_hash)));
            put("k_id", json!(take.as_ref().map(|k| k.id)));
            put("k_active", json!(take.as_ref().map(|k| k.active)));
            put(
                "k_superseded",
                json!(take.as_ref().and_then(|k| k.superseded_by)),
            );
            put("k_hash", json!(take.as_ref().map(take_hash)));
            rows.push(Value::Object(row));
        }
        Ok(Value::Array(rows))
    }

    /// `listPublishedQuestionAnswers(sourceId)`: `{ answer, published_at, cited }` of every pin of the source that holds an
    /// answer (by pin id): the answer text, when it was last refreshed, and the page ids the evidence of its current
    /// answer revision cites.
    pub fn list_published_question_answers(&self, source_id: &str) -> Result<Value> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for pin in answered_pins(&*read, source_id)? {
            let cited: Vec<i64> = evidence_of(&*read, pin.id as u64)?
                .into_iter()
                .filter(|e| e.answer_revision == pin.answer_revision)
                .filter_map(|e| e.page_id)
                .collect();
            rows.push(json!({
                "answer": pin.answer,
                "published_at": pin.last_refresh_at.map(iso),
                "cited": cited,
            }));
        }
        Ok(Value::Array(rows))
    }
}
