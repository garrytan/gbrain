//! The reads of the CLI import and extract paths: source lists, guest-source checks, page trust,
//! the database clock, link metadata, stored timeline rows and the revision check of an extract
//! stamp. PGLite and Postgres run the SQL in `src/core/engine-sql/cli-reads-import.ts`; these
//! answer the same questions from the store's records.
//!
//! What the store does not keep, and what each read answers for it (rust/docs/store/cli-reads-import.md):
//! - sources have no `last_commit` and no `newest_content_at`: both read null;
//! - there are no source ingestion receipts: `hasCompanyBrainReceipt` is false;
//! - there is no `guest_sources` table and no row-level security: a guest source is one whose
//!   config says `guest: true`, `readGuestSourceRow` is never hidden and finds no row;
//! - pages have no trust tier, write origin or write-gate receipts: a page reads tier `unknown`,
//!   origin null and not flagged.
//!
//! Keys: none of its own. It reads the source, page and timeline records.

use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::sources::{DEFAULT_SOURCE, SourceRecord, all_sources, read_source};
use crate::timeline::TimelineRecord;
use crate::{Store, keys};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// One source as `listSourceRecords` returns it (`SourceRecordRow` of `src/core/engine.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceRecordRow {
    pub id: String,
    pub name: Option<String>,
    pub local_path: Option<String>,
    pub last_commit: Option<String>,
    pub last_sync_at: Option<String>,
    pub config: Map<String, Value>,
    pub created_at: String,
    pub archived: bool,
    pub newest_content_at: Option<String>,
}

/// A source's config, incarnation and archived flag (`readSourceIncarnation`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceIncarnationRow {
    pub config: Map<String, Value>,
    pub incarnation: String,
    pub archived: bool,
}

/// `readGuestSourceRow`: the source's guest_sources row and whether it is hidden from the reader.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GuestSourceLookupRow {
    pub hidden: bool,
    pub source_id: Option<String>,
    pub writers: Option<Vec<String>>,
    pub trust_ceiling: Option<String>,
}

/// A (source, slug) key of `readPageTrustRows`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PageTrustKey {
    pub source_id: String,
    pub slug: String,
}

/// Input of `readPageTrustRows`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PageTrustLookup {
    pub ids: Vec<u64>,
    pub keys: Vec<PageTrustKey>,
    pub include_deleted: bool,
}

/// One page's trust fields (`PageTrustRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageTrustRow {
    pub id: u64,
    pub source_id: String,
    pub slug: String,
    pub trust_tier: String,
    pub write_origin: Option<String>,
    pub flagged: bool,
    pub guest: bool,
    #[serde(rename = "byId")]
    pub by_id: bool,
}

/// A live page with its aliases and knowledge revision (`listLinkPageMetadata`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LinkPageMetadataRow {
    pub slug: String,
    pub source_id: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub title: String,
    pub aliases: Value,
    pub knowledge_revision: String,
}

/// One stored non-event timeline row (`listStoredTimelineRows`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredTimelineRow {
    pub id: u64,
    pub date: String,
    pub source: String,
    pub summary: String,
    pub detail: String,
}

/// A page and the knowledge revision `filterPagesAtRevision` checks.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct PageAtRevisionRef {
    pub source_id: String,
    pub slug: String,
    pub revision: String,
}

/// A page `filterPagesAtRevision` found at its revision.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageRef {
    pub slug: String,
    pub source_id: String,
}

/// The SQL `COALESCE(config->>'guest' = 'true', false)`: a JSON `true` or the text `"true"`.
pub(crate) fn config_says_guest(config: &Map<String, Value>) -> bool {
    match config.get("guest") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "true",
        _ => false,
    }
}

fn source_is_guest(read: &dyn KvRead, id: &str) -> Result<bool> {
    Ok(read_source(read, id)?.is_some_and(|s| config_says_guest(&s.config)))
}

fn trust_row(read: &dyn KvRead, page: &PageRecord, by_id: bool) -> Result<PageTrustRow> {
    Ok(PageTrustRow {
        id: page.id,
        source_id: page.source_id.clone(),
        slug: page.slug.clone(),
        trust_tier: "unknown".into(),
        write_origin: None,
        flagged: false,
        guest: source_is_guest(read, &page.source_id)?,
        by_id,
    })
}

fn live(page: &PageRecord) -> bool {
    page.deleted_at_us.is_none()
}

fn record_row(r: SourceRecord) -> SourceRecordRow {
    SourceRecordRow {
        id: r.id,
        name: r.name,
        local_path: r.local_path,
        last_commit: None,
        last_sync_at: r.last_sync_at_us.map(iso),
        config: r.config,
        created_at: iso(r.created_at_us),
        archived: r.archived,
        newest_content_at: None,
    }
}

impl Store {
    /// Every source, archived ones included, `default` first, then by id.
    pub fn list_source_records(&self) -> Result<Vec<SourceRecordRow>> {
        let read = self.read()?;
        let mut sources = all_sources(&*read)?;
        sources
            .sort_by(|a, b| (a.id != DEFAULT_SOURCE, &a.id).cmp(&(b.id != DEFAULT_SOURCE, &b.id)));
        Ok(sources.into_iter().map(record_row).collect())
    }

    /// A source's config, incarnation and archived flag, or `None` for an unknown id. The
    /// TypeScript `lock: 'share'` option has no counterpart: the store runs one write transaction
    /// at a time, so no archive can land between this read and the caller's write.
    pub fn read_source_incarnation(&self, source_id: &str) -> Result<Option<SourceIncarnationRow>> {
        let read = self.read()?;
        Ok(
            read_source(&*read, source_id)?.map(|s| SourceIncarnationRow {
                config: s.config,
                incarnation: s.incarnation,
                archived: s.archived,
            }),
        )
    }

    /// Always false: the store keeps no source ingestion receipts.
    pub fn has_company_brain_receipt(&self, _source_id: &str) -> Result<bool> {
        self.read()?;
        Ok(false)
    }

    /// Never hidden (the store has no row-level security) and never a row (it has no guest_sources).
    pub fn read_guest_source_row(&self, _source_id: &str) -> Result<GuestSourceLookupRow> {
        self.read()?;
        Ok(GuestSourceLookupRow {
            hidden: false,
            source_id: None,
            writers: None,
            trust_ceiling: None,
        })
    }

    /// The ids among `source_ids` (each once) of sources whose config says guest, in id order.
    pub fn list_guest_source_ids(&self, source_ids: &[String]) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for id in source_ids.iter().collect::<BTreeSet<_>>() {
            if source_is_guest(&*read, id)? {
                out.push(id.clone());
            }
        }
        Ok(out)
    }

    /// Whether any source's config says guest.
    pub fn has_guest_source(&self) -> Result<bool> {
        let read = self.read()?;
        Ok(all_sources(&*read)?
            .iter()
            .any(|s| config_says_guest(&s.config)))
    }

    /// The trust rows of the pages named by id (deleted ones too) and by key (live ones unless
    /// `include_deleted`). Each id and each key is read once.
    pub fn read_page_trust_rows(&self, lookup: &PageTrustLookup) -> Result<Vec<PageTrustRow>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for id in lookup.ids.iter().collect::<BTreeSet<_>>() {
            if let Some(page) = read_page_by_id(&*read, *id)? {
                out.push(trust_row(&*read, &page, true)?);
            }
        }
        let keys: BTreeSet<(&str, &str)> = lookup
            .keys
            .iter()
            .map(|k| (k.source_id.as_str(), k.slug.as_str()))
            .collect();
        for (source_id, slug) in keys {
            if let Some(page) = read_page(&*read, source_id, slug)?
                && (lookup.include_deleted || live(&page))
            {
                out.push(trust_row(&*read, &page, false)?);
            }
        }
        Ok(out)
    }

    /// The store clock, `YYYY-MM-DDTHH:MM:SS.ffffffZ` in UTC.
    pub fn read_database_clock(&self) -> Result<String> {
        Ok(iso(self.env.now_micros()))
    }

    /// Every live page (of `source_id` when given) by source, then slug.
    pub fn list_link_page_metadata(
        &self,
        source_id: Option<&str>,
    ) -> Result<Vec<LinkPageMetadataRow>> {
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| live(p) && source_id.is_none_or(|s| p.source_id == s))
            .collect();
        pages.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
        Ok(pages
            .into_iter()
            .map(|p| LinkPageMetadataRow {
                aliases: p.frontmatter.get("aliases").cloned().unwrap_or(Value::Null),
                slug: p.slug,
                source_id: p.source_id,
                page_type: p.page_type,
                title: p.title,
                knowledge_revision: p.knowledge_revision,
            })
            .collect())
    }

    /// The stored timeline rows of one page (deleted or not) that no event page projects, by id.
    pub fn list_stored_timeline_rows(
        &self,
        source_id: &str,
        slug: &str,
    ) -> Result<Vec<StoredTimelineRow>> {
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)? else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        let mut failure = None;
        scan_prefix(
            &*read,
            &keys::timeline_prefix(page.id),
            false,
            &mut |_, v| {
                match serde_json::from_slice::<TimelineRecord>(v) {
                    Ok(r) if r.event_page_id.is_none() => out.push(StoredTimelineRow {
                        id: r.id,
                        date: r.date,
                        source: r.source,
                        summary: r.summary,
                        detail: r.detail,
                    }),
                    Ok(_) => {}
                    Err(e) => failure = Some(StoreError::from(e)),
                }
                failure.is_none()
            },
        )?;
        if let Some(e) = failure {
            return Err(e);
        }
        out.sort_by_key(|r| r.id);
        Ok(out)
    }

    /// The live pages among `refs` whose knowledge revision is the one named, once per ref.
    pub fn filter_pages_at_revision(&self, refs: &[PageAtRevisionRef]) -> Result<Vec<PageRef>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for r in refs {
            if let Some(page) = read_page(&*read, &r.source_id, &r.slug)?
                && live(&page)
                && page.knowledge_revision == r.revision
            {
                out.push(PageRef {
                    slug: page.slug,
                    source_id: page.source_id,
                });
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::config_says_guest;
    use serde_json::{Map, Value, json};

    fn config(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn guest_is_a_json_true_or_the_text_true() {
        assert!(config_says_guest(&config(json!({ "guest": true }))));
        assert!(config_says_guest(&config(json!({ "guest": "true" }))));
        assert!(!config_says_guest(&config(json!({ "guest": false }))));
        assert!(!config_says_guest(&config(json!({ "guest": "yes" }))));
        assert!(!config_says_guest(&config(json!({ "guest": 1 }))));
        assert!(!config_says_guest(&config(json!({}))));
    }
}
