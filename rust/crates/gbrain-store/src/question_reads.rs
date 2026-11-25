//! The pinned-question reads the store serves (`src/core/engine-sql/question-reads.ts`): the candidate pages, the
//! timeline entries, takes and facts of a refresh, the question page's row, the refresh clock, the new-pages and
//! new-facts checks of an answer's watermark, and the rows a publication rereads.
//! The two reads of the pin records (`pinned_questions`, `question_evidence`), which the store does not keep yet, are
//! refused by name (`src/core/rust-engine/question-stops.ts`).
//!
//! Keys: none of its own. It reads the page, fact, timeline and take records, and the page generation index
//! (`page_generation.rs`): `pages.generation` is the per-page counter the store keeps like the SQL engines' trigger.
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::facts::{
    FactRecord, entity_rows, float4_out, hidden_by_deleted_page, highest_source_fact_id, md5_hex,
    ranked_time, read_fact, source_rows,
};
use crate::kv::{KvRead, scan_prefix};
use crate::page_body::read_body_state;
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::takes::{TakeRecord, page_takes, read_take, real_out};
use crate::timeline::TimelineRecord;
use crate::{get_json, keys, page_generation};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The frontmatter key of a pinned question's page (`PINNED_QUESTION_MARKER`).
const PINNED_QUESTION_MARKER: &str = "pinned_question";
/// The frontmatter key a quarantined page carries (`QUARANTINE_KEY`).
const QUARANTINE_KEY: &str = "quarantine";
/// The evidence read's fact limit (`LIMIT 30`).
const MAX_FACTS: usize = 30;
/// The evidence reads' timeline entry and take limit (`LIMIT 20`).
const MAX_ROWS: usize = 20;
/// The page types that are never evidence: the answers themselves.
const ANSWER_TYPES: [&str; 2] = ["question", "synthesis"];

/// The page `(source_id, slug)`, live or soft-deleted, when there is one.
fn page_at(
    read: &dyn KvRead,
    source_id: &str,
    slug: &Option<String>,
) -> Result<Option<PageRecord>> {
    match slug {
        Some(slug) => read_page(read, source_id, slug),
        None => Ok(None),
    }
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

/// Whether the evidence read keeps `f`: live (not expired, not superseded, `valid_until` unset or after `now`), its
/// provenance page (live or soft-deleted) not quarantined, neither its provenance nor its entity page soft-deleted
/// (`projectionEligibleSql('facts')`; the store keeps no `needs_rederive` rows), and its provenance page not a question,
/// synthesis or pinned-question page.
fn evidence_fact(read: &dyn KvRead, f: &FactRecord, now: i64) -> Result<bool> {
    if f.expired_at_us.is_some()
        || f.superseded_by.is_some()
        || f.valid_until_us.is_some_and(|u| u <= now)
    {
        return Ok(false);
    }
    if hidden_by_deleted_page(read, f)? {
        return Ok(false);
    }
    Ok(
        match page_at(read, &f.source_id, &f.source_markdown_slug)? {
            Some(p) => {
                !p.frontmatter.contains_key(QUARANTINE_KEY)
                    && p.page_type != "question"
                    && p.page_type != "synthesis"
                    && !p.frontmatter.contains_key(PINNED_QUESTION_MARKER)
            }
            None => true,
        },
    )
}

/// The page's `body_storage`: a page with no body columns is inline.
fn body_storage(read: &dyn KvRead, page_id: u64) -> Result<String> {
    Ok(read_body_state(read, page_id)?.map_or_else(|| "inline".to_string(), |s| s.body_storage))
}

/// `COALESCE(frontmatter, '{}') ? 'quarantine'`.
fn quarantined(p: &PageRecord) -> bool {
    p.frontmatter.contains_key(QUARANTINE_KEY)
}

/// The evidence page of `id` that `projectionEligibleSql` keeps: not soft-deleted, not quarantined (the store keeps no
/// `needs_rederive` rows). `None` for a page that is gone or ineligible: the join to `pages` drops its rows.
fn eligible_page(read: &dyn KvRead, id: i64) -> Result<Option<PageRecord>> {
    let Ok(id) = u64::try_from(id) else {
        return Ok(None);
    };
    Ok(read_page_by_id(read, id)?.filter(|p| p.deleted_at_us.is_none() && !quarantined(p)))
}

/// The distinct non-negative ids, ascending.
fn distinct_ids(ids: &[i64]) -> Vec<i64> {
    ids.iter()
        .copied()
        .filter(|id| *id >= 0)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// `md5(t.date::text || '|' || t.summary || '|' || t.detail)`.
fn timeline_hash(t: &TimelineRecord) -> String {
    md5_hex(&format!("{}|{}|{}", t.date, t.summary, t.detail))
}

/// `md5(k.claim || '|' || k.holder || '|' || COALESCE(k.weight::text, '') || '|' || COALESCE(k.resolved_outcome::text, ''))`.
fn take_hash(k: &TakeRecord) -> String {
    md5_hex(&format!(
        "{}|{}|{}|{}",
        k.claim,
        k.holder,
        float4_out(k.weight),
        k.resolved_outcome
            .map(|o| o.to_string())
            .unwrap_or_default()
    ))
}

/// Whether a take is evidence: `k.active AND k.superseded_by IS NULL`.
fn live_take(k: &TakeRecord) -> bool {
    k.active && k.superseded_by.is_none()
}

/// `f.expired_at IS NULL AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())`.
fn live_fact(f: &FactRecord, now: i64) -> bool {
    f.expired_at_us.is_none()
        && f.superseded_by.is_none()
        && f.valid_until_us.is_none_or(|u| u > now)
}

impl Store {
    /// `listQuestionEvidenceFacts(sourceId, entitySlugs)`: `{ id, fact, entity_slug, valid_from, hash }` of the
    /// evidence facts about these entities (see [`evidence_fact`]), newest first by `valid_from` (`created_at` for a
    /// fact dated after now), then id, at most 30. `valid_from` is ISO 8601 UTC.
    pub fn list_question_evidence_facts(
        &self,
        source_id: &str,
        entity_slugs: &[String],
    ) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let entities: BTreeSet<&str> = entity_slugs.iter().map(String::as_str).collect();
        let mut rows = Vec::new();
        for entity in entities {
            for f in entity_rows(&*read, source_id, entity)? {
                if evidence_fact(&*read, &f, now)? {
                    rows.push(f);
                }
            }
        }
        rows.sort_by_key(|a| std::cmp::Reverse((ranked_time(a, now), a.id)));
        rows.truncate(MAX_FACTS);
        Ok(Value::Array(
            rows.iter()
                .map(|f| {
                    json!({
                        "id": f.id,
                        "fact": f.fact,
                        "entity_slug": f.entity_slug,
                        "valid_from": iso(f.valid_from_us),
                        "hash": fact_hash(f),
                    })
                })
                .collect(),
        ))
    }

    /// `hasNewQuestionFacts(sourceId, factId, entitySlug)`: whether the source holds an unexpired fact with an id above
    /// `fact_id`, about `entity_slug` when it is given.
    pub fn has_new_question_facts(
        &self,
        source_id: &str,
        fact_id: i64,
        entity_slug: Option<String>,
    ) -> Result<bool> {
        let read = self.read()?;
        let rows = match &entity_slug {
            Some(entity) => entity_rows(&*read, source_id, entity)?,
            None => source_rows(&*read, source_id)?,
        };
        Ok(rows
            .iter()
            .any(|f| i128::from(f.id) > i128::from(fact_id) && f.expired_at_us.is_none()))
    }
    /// `listQuestionCandidatePages(sourceId, slugs)`: `{ id, slug, source_id, generation, revision, type,
    /// compiled_truth, updated_at, marker }` of the live inline pages of the source with these slugs that no
    /// quarantine marks, by page id (the SQL has no order). `marker` says the page carries the pinned-question marker;
    /// `updated_at` is ISO 8601 UTC and the TypeScript member reads it as a `Date`.
    pub fn list_question_candidate_pages(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Value> {
        let read = self.read()?;
        let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        let mut pages = Vec::new();
        for slug in wanted {
            if let Some(p) = read_page(&*read, source_id, slug)?
                && p.deleted_at_us.is_none()
                && !quarantined(&p)
                && body_storage(&*read, p.id)? == "inline"
            {
                pages.push(p);
            }
        }
        pages.sort_by_key(|p| p.id);
        Ok(Value::Array(
            pages
                .iter()
                .map(|p| {
                    json!({
                        "id": p.id,
                        "slug": p.slug,
                        "source_id": p.source_id,
                        "generation": p.generation,
                        "revision": p.knowledge_revision,
                        "type": p.page_type,
                        "compiled_truth": p.compiled_truth,
                        "updated_at": iso(p.updated_at_us),
                        "marker": p.frontmatter.contains_key(PINNED_QUESTION_MARKER),
                    })
                })
                .collect(),
        ))
    }

    /// `listQuestionEvidenceTimeline(pageIds)`: `{ id, date, summary, detail, page_id, slug, generation, revision,
    /// hash }` of the timeline entries of these pages (live and not quarantined), newest date first, then id, at most
    /// 20. `date` is `YYYY-MM-DD` and the TypeScript member reads it as a `Date`; `hash` is
    /// `md5(date || '|' || summary || '|' || detail)`.
    pub fn list_question_evidence_timeline(&self, page_ids: &[i64]) -> Result<Value> {
        let read = self.read()?;
        let mut rows: Vec<(TimelineRecord, PageRecord)> = Vec::new();
        for id in distinct_ids(page_ids) {
            let Some(page) = eligible_page(&*read, id)? else {
                continue;
            };
            // The entry key sorts by date then id, so the newest 20 of the page are the last 20 keys.
            let mut keys_seen = Vec::new();
            scan_prefix(
                &*read,
                &keys::timeline_prefix(page.id),
                true,
                &mut |k, _| {
                    keys_seen.push(k.to_vec());
                    keys_seen.len() < MAX_ROWS
                },
            )?;
            for key in keys_seen {
                if let Some(entry) = get_json::<TimelineRecord>(&*read, &key)? {
                    rows.push((entry, page.clone()));
                }
            }
        }
        rows.sort_by(|a, b| (&b.0.date, b.0.id).cmp(&(&a.0.date, a.0.id)));
        rows.truncate(MAX_ROWS);
        Ok(Value::Array(
            rows.iter()
                .map(|(t, p)| {
                    json!({
                        "id": t.id,
                        "date": t.date,
                        "summary": t.summary,
                        "detail": t.detail,
                        "page_id": p.id,
                        "slug": p.slug,
                        "generation": p.generation,
                        "revision": p.knowledge_revision,
                        "hash": timeline_hash(t),
                    })
                })
                .collect(),
        ))
    }

    /// `listQuestionEvidenceTakes(pageIds)`: `{ id, claim, holder, weight, page_id, slug, generation, revision, hash }`
    /// of the active, unsuperseded takes of these pages (live and not quarantined), newest id first, at most 20.
    /// `weight` is the `real` column as Postgres prints it, read as a number; `hash` is
    /// `md5(claim || '|' || holder || '|' || weight::text || '|' || resolved_outcome::text)`.
    pub fn list_question_evidence_takes(&self, page_ids: &[i64]) -> Result<Value> {
        let read = self.read()?;
        let mut rows: Vec<(TakeRecord, PageRecord)> = Vec::new();
        for id in distinct_ids(page_ids) {
            let Some(page) = eligible_page(&*read, id)? else {
                continue;
            };
            for take in page_takes(&*read, page.id)? {
                if live_take(&take) {
                    rows.push((take, page.clone()));
                }
            }
        }
        rows.sort_by_key(|(k, _)| std::cmp::Reverse(k.id));
        rows.truncate(MAX_ROWS);
        Ok(Value::Array(
            rows.iter()
                .map(|(k, p)| {
                    json!({
                        "id": k.id,
                        "claim": k.claim,
                        "holder": k.holder,
                        "weight": real_out(k.weight),
                        "page_id": p.id,
                        "slug": p.slug,
                        "generation": p.generation,
                        "revision": p.knowledge_revision,
                        "hash": take_hash(k),
                    })
                })
                .collect(),
        ))
    }

    /// `readQuestionPageRow(sourceId, slug)`: `{ id, generation, revision, compiled_truth, body_storage, archived }`
    /// of the live page, or null. `compiled_truth` is null for a segmented page; `archived` says its frontmatter
    /// `status` is `archived`.
    pub fn read_question_page_row(&self, source_id: &str, slug: &str) -> Result<Value> {
        let read = self.read()?;
        let Some(p) = read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(Value::Null);
        };
        Ok(json!({
            "id": p.id,
            "generation": p.generation,
            "revision": p.knowledge_revision,
            "compiled_truth": p.compiled_truth,
            "body_storage": body_storage(&*read, p.id)?,
            "archived": p.frontmatter.get("status").and_then(Value::as_str) == Some("archived"),
        }))
    }

    /// `readQuestionEvidenceClock(sourceId)`: `{ generation, fact_id }`: the highest page generation of the brain (live
    /// and soft-deleted pages, every source) and the highest fact id of the source, 0 for none.
    pub fn read_question_evidence_clock(&self, source_id: &str) -> Result<Value> {
        let read = self.read()?;
        Ok(json!({
            "generation": page_generation::highest(&*read)?,
            "fact_id": highest_source_fact_id(&*read, source_id)?,
        }))
    }

    /// `hasNewQuestionPages(sourceId, generation, prefix)`: whether a live page of the source that is not a question,
    /// synthesis or pinned-question page, and whose slug starts with `prefix` when it is given, has a generation above
    /// `generation`. Reads the generation index from the watermark up and stops at the first such page.
    pub fn has_new_question_pages(
        &self,
        source_id: &str,
        generation: i64,
        prefix: Option<String>,
    ) -> Result<bool> {
        let read = self.read()?;
        // `generation > $2`: from the next number up, or from 0 for a watermark below it.
        let first = u64::try_from(generation).map_or(Some(0), |g| g.checked_add(1));
        let Some(first) = first else {
            return Ok(false);
        };
        let mut hit = false;
        page_generation::for_each_from(&*read, first, &mut |_, id| {
            let Some(p) = read_page_by_id(&*read, id)? else {
                return Ok(true);
            };
            hit = p.source_id == source_id
                && p.deleted_at_us.is_none()
                && !ANSWER_TYPES.contains(&p.page_type.as_str())
                && !p.frontmatter.contains_key(PINNED_QUESTION_MARKER)
                && prefix.as_deref().is_none_or(|x| p.slug.starts_with(x));
            Ok(!hit)
        })?;
        Ok(hit)
    }

    /// `lockQuestionEvidenceRows(kind, ids)`: the rows a publication rereads, one kind at a time. The SQL reads them
    /// `FOR SHARE`; the store has one writer at a time and each call is one transaction, so there is nothing to lock
    /// and the rows are read. `page`: `{ id, generation, revision, deleted, body }` (`body` is the content hash of a
    /// segmented page and `md5(compiled_truth)` of an inline one); `fact`, `timeline` and `take`: `{ id, ok, hash }`.
    /// Rows are by id; an id with no row has none.
    pub fn lock_question_evidence_rows(&self, kind: &str, ids: &[i64]) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let wanted = distinct_ids(ids);
        // Timeline entries have no index by id: one scan of their keys (the id ends each key) reads the wanted ones.
        let mut entries: BTreeMap<u64, TimelineRecord> = BTreeMap::new();
        if kind == "timeline" {
            let want: BTreeSet<u64> = wanted.iter().map(|id| *id as u64).collect();
            let mut found = Vec::new();
            scan_prefix(&*read, &[keys::TIMELINE], false, &mut |k, _| {
                let id = k.get(k.len().saturating_sub(8)..).and_then(keys::be8);
                if id.is_some_and(|id| want.contains(&id)) {
                    found.push(k.to_vec());
                }
                true
            })?;
            for key in found {
                if let Some(t) = get_json::<TimelineRecord>(&*read, &key)? {
                    entries.insert(t.id, t);
                }
            }
        }
        let mut rows = Vec::new();
        for id in wanted {
            let id = id as u64;
            let row = match kind {
                "page" => match read_page_by_id(&*read, id)? {
                    Some(p) => {
                        let segmented = body_storage(&*read, p.id)? == "segmented";
                        let body = if segmented {
                            p.content_hash.clone().map(Value::String)
                        } else {
                            p.compiled_truth
                                .as_deref()
                                .map(|t| Value::String(md5_hex(t)))
                        };
                        Some(json!({
                            "id": p.id,
                            "generation": p.generation,
                            "revision": p.knowledge_revision,
                            "deleted": p.deleted_at_us.is_some(),
                            "body": body,
                        }))
                    }
                    None => None,
                },
                "fact" => read_fact(&*read, id)?.map(
                    |f| json!({ "id": f.id, "ok": live_fact(&f, now), "hash": fact_hash(&f) }),
                ),
                "timeline" => entries
                    .get(&id)
                    .map(|t| json!({ "id": t.id, "ok": true, "hash": timeline_hash(t) })),
                "take" => read_take(&*read, id)?
                    .map(|k| json!({ "id": k.id, "ok": live_take(&k), "hash": take_hash(&k) })),
                other => {
                    return Err(crate::error::StoreError::invalid(format!(
                        "lockQuestionEvidenceRows: unknown kind {other:?}"
                    )));
                }
            };
            rows.extend(row);
        }
        Ok(Value::Array(rows))
    }
}
