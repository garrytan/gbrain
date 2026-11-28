//! The pinned-question reads the store serves (`src/core/engine-sql/question-reads.ts`): the evidence facts of a
//! refresh and whether new facts arrived since an answer's watermark.
//! The other question reads return or compare `pages.generation` or read the pin records, which the store does not
//! keep yet; the engine refuses them by name (`src/core/rust-engine/question-stops.ts`).
//!
//! Keys: none of its own. It reads the page and fact records.
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::facts::{
    FactRecord, entity_rows, hidden_by_deleted_page, md5_hex, ranked_time, source_rows,
};
use crate::kv::KvRead;
use crate::pages::{PageRecord, read_page};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// The frontmatter key of a pinned question's page (`PINNED_QUESTION_MARKER`).
const PINNED_QUESTION_MARKER: &str = "pinned_question";
/// The frontmatter key a quarantined page carries (`QUARANTINE_KEY`).
const QUARANTINE_KEY: &str = "quarantine";
/// The evidence read's fact limit (`LIMIT 30`).
const MAX_FACTS: usize = 30;

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

impl Store {
    /// `listQuestionEvidenceFacts(sourceId, entitySlugs)`: `{ id, fact, entity_slug, valid_from, hash }` of the
    /// evidence facts about these entities (see [`evidence_fact`]), newest first by `valid_from` (`created_at` for a
    /// fact dated after now or undated), then id, at most 30. `valid_from` is ISO 8601 UTC, or null for an undated fact.
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
                        "valid_from": f.valid_from().map(iso),
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
}
