//! The page-store reads and writes of `gbrain repair secret-spans` (`src/core/engine-sql/secret-spans-rows.ts`), served from
//! the page, timeline, fact, take, link, raw data, version and chunk records the other families own.
//!
//! Members: readPageRedactionRow, readPageRedactionRows, listTimelineDedupRows, listVersionBodiesForRedaction,
//! countPageVersionRows, setRetainedVersionBody, listChunkTextsForRedaction, deleteChunksByIds, setRedactedPageFields,
//! readRawDataValue, setRawDataValue, setRedactedRowText.
//!
//! This family adds no key. Every write runs through the helper its family already uses for the same change, so the
//! indexes follow: a page rewrite is `write_page_setting_vector` (the revision bump, the keyword index, the projection
//! queue), a fact rewrite `write_fact` (its indexes, its trust stamp, its receipt), a take rewrite `rewrite_take_column`
//! (the embedding goes, the claim revision counts), a timeline rewrite `put_entry` (the dedup key moves), a link rewrite
//! `put_link`, a chunk delete `delete_chunks_matching` (the postings and the families under a chunk).
//!
//! Differences from the SQL engines, each deliberate:
//! - A raw data row has no serial id here (one record per page and source), so `readPageRedactionRows` numbers a page's
//!   rows from 1 in source order and `readRawDataValue` / `setRawDataValue` take that number with the page id.
//! - The store keeps no `page_view_digests`, so `deletePageViewDigests` has nothing to delete here (it answers like the
//!   SQL engines do for a page with no digests).
//! - A page with a segmented body has no inline text: its page row reads `compiled_truth` and `timeline` as NULL, as
//!   Postgres does, and the body write of a segmented page is not served (`repair secret-spans` stops by name).

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::error::{Result, StoreError};
use crate::facts::{FactRecord, read_fact, source_rows, write_fact};
use crate::kv::KvRead;
use crate::links::{LinkRecord, out_links, put_link};
use crate::pages::{read_page, read_page_by_id, versions_of, write_page_setting_vector};
use crate::takes::{TakeRecord, page_takes};
use crate::timeline::TimelineRecord;
use crate::{Store, get_json, keys, put_json};

/// `RedactedPageFields` of `engine-sql/secret-spans-rows.ts`: the redacted text of every stored page field and the
/// content hash of the redacted page.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedPageFields {
    pub title: String,
    pub frontmatter: Map<String, Value>,
    pub compiled_truth: String,
    pub timeline: String,
    pub content_hash: String,
}

/// Every store of one page a redaction reads besides the page row.
pub(crate) struct PageStores {
    pub timeline: Vec<TimelineRecord>,
    pub facts: Vec<FactRecord>,
    pub takes: Vec<TakeRecord>,
    pub links: Vec<LinkRecord>,
    pub raw_data: Vec<Value>,
}

fn id_of(value: i64) -> Option<u64> {
    u64::try_from(value).ok()
}

/// The timeline rows (page or event page), the facts the page holds or that name it with no holder, its takes, its
/// outgoing links and its raw data, each in id order (raw data in source order).
pub(crate) fn page_stores(
    read: &dyn KvRead,
    page_id: u64,
    source_id: &str,
    slug: &str,
) -> Result<PageStores> {
    let mut facts: Vec<FactRecord> = source_rows(read, source_id)?
        .into_iter()
        .filter(|f| {
            f.source_markdown_slug.as_deref() == Some(slug)
                || (f.source_markdown_slug.is_none() && f.entity_slug.as_deref() == Some(slug))
        })
        .collect();
    facts.sort_by_key(|f| f.id);
    let mut takes = page_takes(read, page_id)?;
    takes.sort_by_key(|t| t.id);
    let mut links = out_links(read, page_id)?;
    links.sort_by_key(|l| l.id);
    Ok(PageStores {
        timeline: crate::timeline_queries::page_and_event_entries(read, page_id)?,
        facts,
        takes,
        links,
        raw_data: crate::raw_files::page_raw_rows(read, page_id)?
            .into_iter()
            .map(|row| row.data)
            .collect(),
    })
}

fn opt(text: &Option<String>) -> Value {
    text.as_ref().map_or(Value::Null, |t| json!(t))
}

impl Store {
    /// `readPageRedactionRow(sourceId, slug)`: the live page as a redaction reads it, or `None`.
    pub fn read_page_redaction_row(&self, source_id: &str, slug: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(None);
        };
        let state = crate::page_body::read_body_state(&*read, page.id)?;
        let segmented = state
            .as_ref()
            .is_some_and(|s| s.body_storage == "segmented");
        let mut tags = page.tags.clone();
        tags.sort();
        Ok(Some(json!({
            "id": page.id,
            "source_id": page.source_id,
            "slug": page.slug,
            "title": page.title,
            "type": page.page_type,
            "page_kind": page.page_kind,
            "frontmatter": Value::Object(page.frontmatter.clone()),
            "compiled_truth": page.compiled_truth.as_deref(),
            "timeline": page.timeline.as_deref(),
            "body_storage": if segmented { "segmented" } else { "inline" },
            "body_bytes": state.as_ref().filter(|_| segmented).and_then(|s| s.body_bytes),
            "generation": state.as_ref().map_or(0, |s| s.body_generation).to_string(),
            "body_flags": state.as_ref().and_then(|s| s.body_flags.clone()),
            "revision": page.knowledge_revision,
            "contextual_retrieval_mode": crate::aliases::contextual_retrieval_mode(&*read, page.id)?,
            "corpus_generation": crate::aliases::corpus_generation(&*read, page.id)?,
            "tags": tags,
        })))
    }

    /// `readPageRedactionRows(pageId, sourceId, slug)`.
    pub fn read_page_redaction_rows(
        &self,
        page_id: i64,
        source_id: &str,
        slug: &str,
    ) -> Result<Value> {
        let Some(page_id) = id_of(page_id) else {
            return Ok(
                json!({ "timeline": [], "facts": [], "takes": [], "links": [], "rawData": [] }),
            );
        };
        let read = self.read()?;
        let stores = page_stores(&*read, page_id, source_id, slug)?;
        Ok(json!({
            "timeline": stores.timeline.iter().map(|e| json!({
                "id": e.id, "summary": e.summary, "detail": e.detail, "source": e.source,
            })).collect::<Vec<_>>(),
            "facts": stores.facts.iter().map(|f| json!({
                "id": f.id, "fact": f.fact, "context": opt(&f.context), "value": opt(&f.value),
            })).collect::<Vec<_>>(),
            "takes": stores.takes.iter().map(|t| json!({
                "id": t.id, "claim": t.claim, "source": opt(&t.source), "resolved_source": opt(&t.resolved_source),
            })).collect::<Vec<_>>(),
            "links": stores.links.iter().map(|l| json!({ "id": l.id, "context": l.context })).collect::<Vec<_>>(),
            "rawData": stores.raw_data.iter().enumerate().map(|(i, data)| json!({
                "id": i + 1, "data": crate::jsonb::ordered(data),
            })).collect::<Vec<_>>(),
        }))
    }

    /// `listTimelineDedupRows(pageId)`.
    pub fn list_timeline_dedup_rows(&self, page_id: i64) -> Result<Vec<Value>> {
        let Some(page_id) = id_of(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        Ok(crate::timeline_queries::redaction_dedup_rows(&*read, page_id)?
            .iter()
            .map(|e| {
                json!({ "id": e.id, "page_id": e.page_id, "date": e.date, "summary": e.summary, "source": e.source })
            })
            .collect())
    }

    /// `listVersionBodiesForRedaction(pageId)`: the page's versions in id order; a segmented snapshot keeps no body text
    /// (its `compiled_truth` is NULL) and says `segmented`; an inline snapshot says `inline`, as the column does.
    pub fn list_version_bodies_for_redaction(&self, page_id: i64) -> Result<Vec<Value>> {
        let Some(page_id) = id_of(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let mut rows = versions_of(&*read, page_id)?;
        rows.sort_by_key(|v| v.id);
        Ok(rows
            .iter()
            .map(|v| {
                json!({
                    "id": v.id,
                    "compiled_truth": v.compiled_truth.as_deref(),
                    "frontmatter": Value::Object(v.frontmatter.clone()),
                    "body_storage": v.body_storage.as_deref().unwrap_or("inline"),
                })
            })
            .collect())
    }

    /// `countPageVersionRows(pageId)`.
    pub fn count_page_version_rows(&self, page_id: i64) -> Result<u64> {
        let Some(page_id) = id_of(page_id) else {
            return Ok(0);
        };
        let read = self.read()?;
        Ok(versions_of(&*read, page_id)?.len() as u64)
    }

    /// `setRetainedVersionBody(pageId, id, compiledTruth, frontmatter)`: rewrites one retained version's text and
    /// frontmatter; an unknown version changes nothing.
    pub fn set_retained_version_body(
        &self,
        page_id: i64,
        id: i64,
        compiled_truth: Option<String>,
        frontmatter: Map<String, Value>,
    ) -> Result<()> {
        let (Some(page_id), Some(id)) = (id_of(page_id), id_of(id)) else {
            return Ok(());
        };
        if compiled_truth.as_deref().is_some_and(|t| t.contains('\0')) {
            return Err(StoreError::invalid(
                "setRetainedVersionBody: text cannot contain a NUL byte",
            ));
        }
        self.write(|tx| {
            let key = keys::version(page_id, id);
            let Some(mut row) = get_json::<crate::pages::VersionRecord>(&*tx, &key)? else {
                return Ok(());
            };
            row.compiled_truth = match &compiled_truth {
                Some(text) => text.as_str().into(),
                None => crate::pages::PageText::null(),
            };
            row.frontmatter = frontmatter.clone();
            put_json(tx, &key, &row)
        })
    }

    /// `listChunkTextsForRedaction(pageId, purpose)`: every stored chunk row of the page with its id, text and doc
    /// comment (a chunk without one reads NULL).
    pub fn list_chunk_texts_for_redaction(&self, page_id: i64) -> Result<Vec<Value>> {
        let Some(page_id) = id_of(page_id) else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let mut rows = crate::chunks::read_chunks(&*read, page_id)?;
        rows.sort_by_key(|c| c.id);
        Ok(rows
            .iter()
            .map(|c| {
                json!({
                    "id": c.id,
                    "chunk_text": c.chunk_text,
                    "doc_comment": c.meta.get("doc_comment").and_then(Value::as_str),
                })
            })
            .collect())
    }

    /// `deleteChunksByIds(pageId, ids)`: removes the page's chunks with these ids, with their postings and the records
    /// the other families keep under a chunk; an id the page does not hold is ignored.
    pub fn delete_chunks_by_ids(&self, page_id: i64, ids: &[i64]) -> Result<()> {
        let Some(page_id) = id_of(page_id) else {
            return Ok(());
        };
        let wanted: BTreeSet<u64> = ids.iter().filter_map(|id| id_of(*id)).collect();
        if wanted.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            crate::chunks::delete_chunks_matching(tx, page_id, &|c| wanted.contains(&c.id))
                .map(|_| ())
        })
    }

    /// `setRedactedPageFields(pageId, fields)`: the page's title, frontmatter, body, timeline and content hash, stamped
    /// updated now. A changed field takes a new knowledge revision and clears the text projection seal, as the
    /// revision trigger does; a write that changes none keeps the revision. A missing page changes nothing.
    pub fn set_redacted_page_fields(
        &self,
        page_id: i64,
        fields: &RedactedPageFields,
    ) -> Result<()> {
        let Some(page_id) = id_of(page_id) else {
            return Ok(());
        };
        for text in [
            &fields.title,
            &fields.compiled_truth,
            &fields.timeline,
            &fields.content_hash,
        ] {
            if text.contains('\0') {
                return Err(StoreError::invalid(
                    "setRedactedPageFields: text cannot contain a NUL byte",
                ));
            }
        }
        self.write(|tx| {
            let Some(mut page) = read_page_by_id(&*tx, page_id)? else {
                return Ok(());
            };
            let changed = page.title != fields.title
                || page.compiled_truth != fields.compiled_truth.as_str()
                || page.timeline != fields.timeline.as_str()
                || page.frontmatter != fields.frontmatter;
            page.title = fields.title.clone();
            page.compiled_truth = fields.compiled_truth.as_str().into();
            page.timeline = fields.timeline.as_str().into();
            page.frontmatter = fields.frontmatter.clone();
            page.content_hash = Some(fields.content_hash.clone());
            page.updated_at_us = self.env.now_micros();
            if changed {
                page.knowledge_revision = self.env.new_uuid();
                page.text_projection_revision = None;
            }
            write_page_setting_vector(tx, &page)
        })
    }

    /// `readRawDataValue(pageId, id)`: the data of the page's `id`th raw data row (from 1), or `None`.
    pub fn read_raw_data_value(&self, page_id: i64, id: i64) -> Result<Option<Value>> {
        let (Some(page_id), Some(id)) = (id_of(page_id), id_of(id)) else {
            return Ok(None);
        };
        let read = self.read()?;
        Ok(crate::raw_files::raw_row_data(&*read, page_id, id)?
            .map(|data| crate::jsonb::ordered(&data)))
    }

    /// `setRawDataValue(pageId, id, data)`: replaces the data of the page's `id`th raw data row.
    pub fn set_raw_data_value(&self, page_id: i64, id: i64, data: Value) -> Result<()> {
        let (Some(page_id), Some(id)) = (id_of(page_id), id_of(id)) else {
            return Ok(());
        };
        self.write(|tx| crate::raw_files::set_raw_row_data(tx, page_id, id, data.clone()))
    }

    /// `setRedactedRowText(pageId, store, id, column, text)`: rewrites one text column of a timeline, fact, take or link
    /// row page `pageId`'s redaction read. A fact or take loses its embedding with the rewrite. An unknown row changes
    /// nothing; a store or column a redaction does not rewrite refuses `invalid_argument`.
    pub fn set_redacted_row_text(
        &self,
        page_id: i64,
        store: &str,
        id: i64,
        column: &str,
        text: &str,
    ) -> Result<()> {
        let allowed: &[&str] = match store {
            "timeline_entries" => &["summary", "detail", "source"],
            "facts" => &["fact", "context", "value"],
            "takes" => &["claim", "source", "resolved_source"],
            "links" => &["context"],
            other => {
                return Err(StoreError::invalid(format!(
                    "setRedactedRowText: {other} is not a store a redaction rewrites"
                )));
            }
        };
        if !allowed.contains(&column) {
            return Err(StoreError::invalid(format!(
                "setRedactedRowText: {store}.{column} is not a column a redaction rewrites"
            )));
        }
        if text.contains('\0') {
            return Err(StoreError::invalid(
                "setRedactedRowText: text cannot contain a NUL byte",
            ));
        }
        let (Some(page_id), Some(id)) = (id_of(page_id), id_of(id)) else {
            return Ok(());
        };
        let trust = if store == "facts" {
            Some(self.write_trust()?)
        } else {
            None
        };
        self.write(|tx| match store {
            "timeline_entries" => {
                crate::timeline_queries::rewrite_timeline_column(tx, page_id, id, column, text)
            }
            "facts" => {
                let Some(old) = read_fact(&*tx, id)? else {
                    return Ok(());
                };
                let mut new = old.clone();
                match column {
                    "fact" => new.fact = text.to_owned(),
                    "context" => new.context = Some(text.to_owned()),
                    _ => new.value = Some(text.to_owned()),
                }
                new.embedding = None;
                new.embedding_model = None;
                new.embedded_text_hash = None;
                new.embedded_at_us = None;
                let trust = trust.as_ref().expect("facts take the write trust");
                write_fact(tx, trust, Some(&old), &new)
            }
            "takes" => {
                crate::takes::rewrite_take_column(tx, id, column, text, self.env.now_micros())
            }
            _ => {
                let Some(mut link) = get_json::<LinkRecord>(&*tx, &keys::link(page_id, id))? else {
                    return Ok(());
                };
                link.context = text.to_owned();
                put_link(tx, &link)
            }
        })
    }
}
