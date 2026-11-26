//! The dream cycle's page, fact, take, version and journal statements
//! (`src/core/engine-sql/dream-cycle.ts`): the provenance stamp and its counts, the synthesize
//! family's page reads, the consolidate phase's fact and take statements, and the three write
//! journal reads. The job queue and cycle lock reads are in `jobs/dream_reads.rs`.
//!
//! Order: a statement with `ORDER BY` returns its order (`slug` in byte order, `sequence`); the
//! others return rows in key order, where the SQL engines give no set order.

use crate::env::{is_uuid, iso};
use crate::error::{Result, StoreError};
use crate::facts::{FactRecord, PrivacyPolicy, page_hidden, read_fact, write_fact};
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages, read_page, versions_of, write_page};
use crate::persistence::parse_timestamptz;
use crate::takes::{page_takes, read_take, store_take};
use crate::timeline_queries::jsonb_field_text;
use crate::{Store, keys};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeSet, HashSet};

/// `stampDreamPageProvenance(stamp)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamProvenanceStamp {
    pub slug: String,
    pub source_id: String,
    pub cycle_date: String,
    /// ISO text, or none to stamp the page whatever its age.
    #[serde(default)]
    pub first_write_at: Option<String>,
    pub clear_seat: bool,
    pub frontmatter: Value,
}

/// `countDreamProvenancePages(sourceId, cycleDate, summarySlug, writtenSlugs)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamProvenanceCountQuery {
    pub source_id: String,
    pub cycle_date: String,
    pub summary_slug: String,
    pub written_slugs: Vec<String>,
}

/// `listLaterPersistenceRequests(sourceId, incarnation, slug, sequence)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaterRequestsQuery {
    pub source_id: String,
    pub incarnation: String,
    pub slug: String,
    /// A number or the decimal text of one (`sequence > $4`, a bigint).
    pub sequence: Value,
}

/// `listCommittedOutputRequests(requestIds, sourceId, incarnation)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedOutputsQuery {
    pub request_ids: Vec<String>,
    pub source_id: String,
    pub incarnation: String,
}

/// `frontmatter ->> key`.
fn fm_text(fm: &Map<String, Value>, key: &str) -> Option<String> {
    fm.get(key).and_then(jsonb_field_text)
}

fn dream_generated(page: &PageRecord) -> bool {
    fm_text(&page.frontmatter, "dream_generated").as_deref() == Some("true")
}

/// The live page `slug` of `source_id`.
fn live_page(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<Option<PageRecord>> {
    Ok(read_page(read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none()))
}

/// A `uuid` bind: the lower-case text, or Postgres' refusal of the input.
fn uuid_bind(op: &str, text: &str) -> Result<String> {
    if is_uuid(text) {
        Ok(text.to_lowercase())
    } else {
        Err(StoreError::invalid(format!(
            "{op}: invalid input syntax for type uuid: \"{text}\""
        )))
    }
}

/// The facts of `ids` (a `bigint[]`), in id order.
fn facts_of(read: &dyn KvRead, ids: &[i64]) -> Result<Vec<FactRecord>> {
    let wanted: BTreeSet<u64> = ids
        .iter()
        .filter_map(|id| u64::try_from(*id).ok())
        .collect();
    let mut out = Vec::new();
    for id in wanted {
        if let Some(fact) = read_fact(read, id)? {
            out.push(fact);
        }
    }
    Ok(out)
}

/// An `int4` bind of a take row number.
fn row_num_bind(op: &str, row_num: i64) -> Result<i32> {
    i32::try_from(row_num).map_err(|_| {
        StoreError::invalid(format!(
            "{op}: value \"{row_num}\" is out of range for type integer"
        ))
    })
}

impl Store {
    /// `stampDreamPageProvenance(stamp)`: merges `frontmatter` over the page's frontmatter (after
    /// dropping `seat` when `clearSeat`) and keeps the first cycle date in `dream_cycle_date` and
    /// `dream_created_cycle_date`. A page created before `firstWriteAt` that is not dream output
    /// is left alone. The page takes a new knowledge revision when its frontmatter changes, as the
    /// PGLite revision trigger does; `updated_at` does not change.
    pub fn stamp_dream_page_provenance(&self, stamp: &DreamProvenanceStamp) -> Result<()> {
        const OP: &str = "stampDreamPageProvenance";
        let Value::Object(merge) = &stamp.frontmatter else {
            return Err(StoreError::invalid(format!(
                "{OP}: the frontmatter to merge must be an object"
            )));
        };
        let first_write = stamp
            .first_write_at
            .as_deref()
            .map(|at| parse_timestamptz(at, "firstWriteAt"))
            .transpose()?;
        self.write(|tx| {
            let Some(mut page) = read_page(&*tx, &stamp.source_id, &stamp.slug)? else {
                return Ok(());
            };
            if let Some(at) = first_write
                && !dream_generated(&page)
                && page.created_at_us < at
            {
                return Ok(());
            }
            let old = page.frontmatter.clone();
            let first = fm_text(&old, "dream_created_cycle_date")
                .filter(|d| !d.is_empty())
                .or_else(|| fm_text(&old, "dream_cycle_date").filter(|d| !d.is_empty()))
                .unwrap_or_else(|| stamp.cycle_date.clone());
            // `frontmatter - CASE WHEN $5 THEN 'seat' ELSE '' END`: the empty key goes either way.
            page.frontmatter
                .remove(if stamp.clear_seat { "seat" } else { "" });
            for (k, v) in merge {
                page.frontmatter.insert(k.clone(), v.clone());
            }
            page.frontmatter
                .insert("dream_cycle_date".into(), json!(first));
            page.frontmatter
                .insert("dream_created_cycle_date".into(), json!(first));
            if page.frontmatter != old {
                page.knowledge_revision = self.env.new_uuid();
                page.text_projection_revision = None;
            }
            write_page(tx, &page)
        })
    }

    /// `listDreamPageIds(slug, sourceId)` and `findConsolidationPageIds(sourceId, slug)`: `[{ id }]`
    /// of the live page, or none.
    pub fn list_dream_page_ids(&self, source_id: &str, slug: &str) -> Result<Vec<Value>> {
        Ok(live_page(&*self.read()?, source_id, slug)?
            .map(|p| json!({ "id": p.id }))
            .into_iter()
            .collect())
    }

    /// `countDreamProvenancePages(...)`: `{ found, earlier }` over the live dream pages of the
    /// source: the pages of the cycle date other than the summary, and the written slugs that keep
    /// an earlier cycle's date. Always one row.
    pub fn count_dream_provenance_pages(&self, q: &DreamProvenanceCountQuery) -> Result<Value> {
        let written: HashSet<&str> = q.written_slugs.iter().map(String::as_str).collect();
        let (mut found, mut earlier) = (0i64, 0i64);
        for page in all_pages(&*self.read()?)? {
            if page.source_id != q.source_id
                || page.deleted_at_us.is_some()
                || !dream_generated(&page)
            {
                continue;
            }
            let date = fm_text(&page.frontmatter, "dream_cycle_date");
            if date.as_deref() == Some(q.cycle_date.as_str()) && page.slug != q.summary_slug {
                found += 1;
            }
            let date = date.unwrap_or_default();
            if written.contains(page.slug.as_str()) && !date.is_empty() && date != q.cycle_date {
                earlier += 1;
            }
        }
        Ok(json!({ "found": found, "earlier": earlier }))
    }

    /// `listRetainedDreamOutputSources(sourceId)`: the distinct non-empty `raw_source` of the live
    /// dream pages of the source, `[{ raw_source }]` in byte order.
    pub fn list_retained_dream_output_sources(&self, source_id: &str) -> Result<Vec<Value>> {
        let mut out = BTreeSet::new();
        for page in all_pages(&*self.read()?)? {
            if page.source_id == source_id
                && page.deleted_at_us.is_none()
                && dream_generated(&page)
                && let Some(raw) =
                    fm_text(&page.frontmatter, "raw_source").filter(|r| !r.is_empty())
            {
                out.insert(raw);
            }
        }
        Ok(out
            .into_iter()
            .map(|raw| json!({ "raw_source": raw }))
            .collect())
    }

    /// `listDreamAtomPages(sourceId)`: the live `atom` pages of the source with no
    /// `imported_from`: `{ slug, title, compiled_truth, frontmatter, private }`, where `private` is
    /// whether `policy` (the no-caller page policy) hides the page.
    pub fn list_dream_atom_pages(
        &self,
        source_id: &str,
        policy: &PrivacyPolicy,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for page in all_pages(&*read)? {
            if page.page_type != "atom"
                || page.source_id != source_id
                || page.deleted_at_us.is_some()
                || fm_text(&page.frontmatter, "imported_from").is_some()
            {
                continue;
            }
            let private = page_hidden(&*read, &page, policy)?;
            out.push(json!({
                "slug": page.slug,
                "title": page.title,
                "compiled_truth": page.compiled_truth,
                "frontmatter": page.frontmatter,
                "private": private,
            }));
        }
        Ok(out)
    }

    /// `listSynthesisPageBodies(sourceId, slugs)`: `{ slug, title, body }` of each live inline page
    /// of `slugs`, the body being the compiled truth, a newline and the timeline, by slug.
    pub fn list_synthesis_page_bodies(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        let mut out = Vec::new();
        for slug in wanted {
            let Some(page) = live_page(&*read, source_id, slug)? else {
                continue;
            };
            if page.compiled_truth.is_null() {
                continue;
            }
            let body = format!("{}\n{}", &*page.compiled_truth, &*page.timeline);
            out.push(json!({ "slug": page.slug, "title": page.title, "body": body }));
        }
        Ok(out)
    }

    /// `readDreamPreRunRevision(slug, sourceId, sinceIso)`: `{ compiled_truth, timeline,
    /// frontmatter }` of the page's first version snapshot at or after `since` (by snapshot time,
    /// then id), live or deleted page alike, or none.
    pub fn read_dream_pre_run_revision(
        &self,
        source_id: &str,
        slug: &str,
        since: &str,
    ) -> Result<Option<Value>> {
        let since = parse_timestamptz(since, "readDreamPreRunRevision: sinceIso")?;
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)? else {
            return Ok(None);
        };
        Ok(versions_of(&*read, page.id)?
            .into_iter()
            .filter(|v| v.snapshot_at_us >= since)
            .min_by_key(|v| (v.snapshot_at_us, v.id))
            .map(|v| {
                json!({
                    "compiled_truth": v.compiled_truth,
                    "timeline": v.timeline,
                    "frontmatter": v.frontmatter,
                })
            }))
    }

    /// `readDreamVerifyEpoch()`: the store clock now, as ISO text.
    pub fn read_dream_verify_epoch(&self) -> Result<String> {
        Ok(iso(self.env.now_micros()))
    }

    /// `listConsolidationClaimValues(ids)`: `{ id, claim_value }` of each fact in `ids`.
    pub fn list_consolidation_claim_values(&self, ids: &[i64]) -> Result<Vec<Value>> {
        Ok(facts_of(&*self.read()?, ids)?
            .into_iter()
            .map(|f| json!({ "id": f.id, "claim_value": f.claim_value }))
            .collect())
    }

    /// `listConsolidationClaimShapes(ids)`: `{ id, claim_metric, claim_unit, claim_period }` of each
    /// fact in `ids`.
    pub fn list_consolidation_claim_shapes(&self, ids: &[i64]) -> Result<Vec<Value>> {
        Ok(facts_of(&*self.read()?, ids)?
            .into_iter()
            .map(|f| {
                json!({
                    "id": f.id,
                    "claim_metric": f.claim_metric,
                    "claim_unit": f.claim_unit,
                    "claim_period": f.claim_period,
                })
            })
            .collect())
    }

    /// `setConsolidatedFactValidUntil(validUntil, id)`: writes the fact's `valid_until` only when
    /// it differs.
    pub fn set_consolidated_fact_valid_until(&self, valid_until: &str, id: i64) -> Result<()> {
        let until = parse_timestamptz(valid_until, "setConsolidatedFactValidUntil: validUntil")?;
        let Ok(id) = u64::try_from(id) else {
            return Ok(());
        };
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = read_fact(&*tx, id)? else {
                return Ok(());
            };
            if old.valid_until_us == Some(until) {
                return Ok(());
            }
            let mut new = old.clone();
            new.valid_until_us = Some(until);
            write_fact(tx, trust, Some(&old), &new)
        })
    }

    /// `listReadersSourcedFactIds(ids)`: `[{ id }]` of the facts in `ids` whose own page (deleted
    /// or not) names readers (`readersSourcedFactSql`).
    pub fn list_readers_sourced_fact_ids(&self, ids: &[i64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for fact in facts_of(&*read, ids)? {
            let readers = match &fact.source_markdown_slug {
                Some(slug) => read_page(&*read, &fact.source_id, slug)?
                    .is_some_and(|p| p.frontmatter.contains_key("readable_by")),
                None => false,
            };
            if readers {
                out.push(json!({ "id": fact.id }));
            }
        }
        Ok(out)
    }

    /// `readConsolidationTakesMaxRowNum(pageId)`: the highest take row number of the page, 0 when
    /// it has none.
    pub fn read_consolidation_takes_max_row_num(&self, page_id: i64) -> Result<i64> {
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(0);
        };
        Ok(page_takes(&*self.read()?, page_id)?
            .iter()
            .map(|t| i64::from(t.row_num))
            .max()
            .unwrap_or(0))
    }

    /// `findConsolidatedTakes(pageId, claim)`: `[{ id, resolved_at }]` of the earliest self-held
    /// `fact` take of `claim` on the page, or none.
    pub fn find_consolidated_takes(&self, page_id: i64, claim: &str) -> Result<Vec<Value>> {
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(Vec::new());
        };
        Ok(page_takes(&*self.read()?, page_id)?
            .into_iter()
            .filter(|t| t.claim == claim && t.kind == "fact" && t.holder == "self")
            .min_by_key(|t| t.id)
            .map(|t| json!({ "id": t.id, "resolved_at": t.resolved_at_us.map(iso) }))
            .into_iter()
            .collect())
    }

    /// `refreshConsolidatedTakeSource(source, id)`: sets the take's `source` and `updated_at`.
    pub fn refresh_consolidated_take_source(&self, source: &str, id: i64) -> Result<()> {
        let Ok(id) = u64::try_from(id) else {
            return Ok(());
        };
        let now = self.env.now_micros();
        self.write(|tx| {
            let Some(mut take) = read_take(&*tx, id)? else {
                return Ok(());
            };
            take.source = Some(source.to_string());
            take.updated_at_us = now;
            store_take(tx, &take)
        })
    }

    /// `findConsolidatedTakeIds(pageId, rowNum)`: `[{ id }]` of the take at `rowNum` on the page.
    pub fn find_consolidated_take_ids(&self, page_id: i64, row_num: i64) -> Result<Vec<Value>> {
        let row_num = row_num_bind("findConsolidatedTakeIds", row_num)?;
        let Ok(page_id) = u64::try_from(page_id) else {
            return Ok(Vec::new());
        };
        Ok(crate::takes::take_at(&*self.read()?, page_id, row_num)?
            .map(|t| json!({ "id": t.id }))
            .into_iter()
            .collect())
    }

    /// `readDreamDeferralReceipt(receiptId)`: `{ state, error_code, error_message }` of the journal
    /// request with that row id, or none.
    pub fn read_dream_deferral_receipt(&self, id: &str) -> Result<Option<Value>> {
        let id = uuid_bind("readDreamDeferralReceipt", id)?;
        Ok(crate::get_json::<RequestRecord>(&*self.read()?, &keys::request(&id))?.map(|r| {
            json!({ "state": r.state, "error_code": r.error_code, "error_message": r.error_message })
        }))
    }
}
