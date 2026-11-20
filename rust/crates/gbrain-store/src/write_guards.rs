//! Page write guards: the reads and writes a page write runs around the page row to check and
//! record its origin, stamp its ingest provenance, seal an import's closing chunker version, read
//! the body a valid-time advisory compares, and probe segment storage (the TypeScript
//! `engine-sql/write-guards.ts`).
//!
//! Members: readPageOrigin, listOriginClaims, bindPageOrigin, stampPageIngest, sealImportedPage,
//! readLivePageBody, hasSegmentStorage.
//!
//! Locks: PGLite takes an advisory lock per origin spelling before it lists the claims, so two
//! writes of one file queue. The store runs one write transaction at a time, so every lock is
//! already held and `listOriginClaims` takes none.
//!
//! Keys: this family adds none. It reads and writes page records through `pages.rs` (the page
//! key, the id key and the origin key `o`) and the search timeline record, and it reads the
//! prefixes of the segment-text and staging records under `keys::PAGE_BODY`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::env::{iso, parse_iso};
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{
    PageRecord, PageText, assert_origin_unclaimed, claimed_origin, origin_key, read_page,
    read_page_by_id, record_search_timeline, write_page,
};
use crate::{Result, Store, StoreError, keys};

/// Which page: by id within the source when `page_id` is given, else by slug.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOriginTarget {
    pub source_id: String,
    #[serde(default)]
    pub page_id: Option<u64>,
    #[serde(default)]
    pub slug: Option<String>,
}

/// `bindPageOrigin`'s target and the origin it records.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOriginBind {
    #[serde(flatten)]
    pub target: PageOriginTarget,
    pub source_path: String,
    /// Change only a page that records no origin yet.
    #[serde(default)]
    pub only_if_unset: bool,
    /// Change only a live page.
    #[serde(default)]
    pub live_only: bool,
}

/// `listOriginClaims` options. `lock_keys` are the advisory locks PGLite takes; the store takes none.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginClaimOptions {
    #[serde(default)]
    pub lock_keys: Vec<String>,
    #[serde(default)]
    pub exclude_page_id: Option<i64>,
}

/// `stampPageIngest`'s provenance. `ingested_at` is an ISO time (`Date#toISOString`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageIngestStamp {
    pub source_id: String,
    pub source_kind: Option<String>,
    pub ingested_via: Option<String>,
    pub ingested_at: Option<String>,
}

/// `sealImportedPage`'s seal: the page's revision when the caller read it live (null: none), the
/// sanitized timeline the page keyword vector reads, and the chunker version the import deferred.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPageSeal {
    pub source_id: String,
    pub revision: Option<String>,
    #[serde(default)]
    pub timeline_text: String,
    pub chunker_version: i16,
}

/// The page an origin check is about, as PGLite's `SELECT id, slug, source_path, deleted_at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageOriginRow {
    pub id: u64,
    pub slug: String,
    pub source_path: Option<String>,
    pub deleted_at: Option<String>,
}

/// A live page that records one of the asked-for origin spellings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OriginClaimRow {
    pub slug: String,
    pub source_path: String,
}

/// A live page's body columns, as PGLite's `SELECT frontmatter, compiled_truth, timeline,
/// body_storage, content_hash`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LivePageBodyRow {
    pub frontmatter: Map<String, Value>,
    pub compiled_truth: Option<String>,
    pub timeline: Option<String>,
    pub body_storage: &'static str,
    pub content_hash: Option<String>,
}

/// The id and the sealed page of `sealImportedPage`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SealedPage {
    pub id: u64,
}

/// Key kinds of the page-body family (`page_body.rs`) whose records exist only on a brain that
/// stores segmented bodies: a segment text and a body staging. They must stay equal to the kinds
/// `page_body.rs` defines under `keys::PAGE_BODY`.
const SEGMENT_TEXT_KIND: u8 = 0x01;
const BODY_STAGING_KIND: u8 = 0x03;

fn find_page(read: &dyn KvRead, target: &PageOriginTarget) -> Result<Option<PageRecord>> {
    match (target.page_id, target.slug.as_deref()) {
        (Some(id), _) => Ok(read_page_by_id(read, id)?.filter(|p| p.source_id == target.source_id)),
        (None, Some(slug)) => read_page(read, &target.source_id, slug),
        (None, None) => Ok(None),
    }
}

/// The live pages of `source_id` other than page `except` that record `spelling`.
fn claims_of(
    read: &dyn KvRead,
    source_id: &str,
    spelling: &str,
    except: Option<u64>,
    out: &mut Vec<PageRecord>,
) -> Result<()> {
    let wanted = origin_key(spelling);
    let mut ids = Vec::new();
    scan_prefix(
        read,
        &keys::page_origin_prefix(source_id, &wanted),
        false,
        &mut |k, _| {
            ids.extend(k.len().checked_sub(8).and_then(|at| keys::be8(&k[at..])));
            true
        },
    )?;
    for id in ids.into_iter().filter(|id| Some(*id) != except) {
        if out.iter().any(|p| p.id == id) {
            continue;
        }
        if let Some(page) = read_page_by_id(read, id)?
            && page.source_id == source_id
            && claimed_origin(&page).as_deref() == Some(wanted.as_str())
        {
            out.push(page);
        }
    }
    Ok(())
}

impl Store {
    /// `readPageOrigin(target)`: the page `target` names, live or a tombstone, or `None` when
    /// there is none or the target names neither an id nor a slug.
    pub fn read_page_origin(&self, target: &PageOriginTarget) -> Result<Option<PageOriginRow>> {
        let read = self.read()?;
        Ok(find_page(&*read, target)?.map(|page| PageOriginRow {
            id: page.id,
            slug: page.slug,
            source_path: page.source_path,
            deleted_at: page.deleted_at_us.map(iso),
        }))
    }

    /// `listOriginClaims(sourceId, spellings, opts)`: the live pages of the source that record any
    /// of `spellings`, other than page `exclude_page_id`, in slug order. An empty origin is never a
    /// claim (no page indexes one), and no caller asks for it.
    pub fn list_origin_claims(
        &self,
        source_id: &str,
        spellings: &[String],
        opts: &OriginClaimOptions,
    ) -> Result<Vec<OriginClaimRow>> {
        let read = self.read()?;
        let except = opts.exclude_page_id.and_then(|id| u64::try_from(id).ok());
        let mut pages = Vec::new();
        for spelling in spellings.iter().filter(|s| !s.is_empty()) {
            claims_of(&*read, source_id, spelling, except, &mut pages)?;
        }
        let mut rows: Vec<OriginClaimRow> = pages
            .into_iter()
            .filter_map(|page| {
                page.source_path.map(|source_path| OriginClaimRow {
                    slug: page.slug,
                    source_path,
                })
            })
            .collect();
        rows.sort_by(|a, b| a.slug.cmp(&b.slug));
        Ok(rows)
    }

    /// `bindPageOrigin(bind)`: records `source_path` on the page the bind names when it records a
    /// different origin (`only_if_unset`: none at all) and, with `live_only`, is live. Returns the
    /// number of pages changed, 0 or 1. A live page may not take an origin another live page of
    /// the source records (`origin_claimed`), as PGLite's `pages_live_origin_key` refuses it.
    /// PGLite also clears `database_only_reason = 'origin_twin'`; the store keeps no such column.
    pub fn bind_page_origin(&self, bind: &PageOriginBind) -> Result<u64> {
        self.write(|tx| {
            let Some(mut page) = find_page(&*tx, &bind.target)? else {
                return Ok(0);
            };
            let unchanged = if bind.only_if_unset {
                page.source_path.is_some()
            } else {
                page.source_path.as_deref() == Some(bind.source_path.as_str())
            };
            if unchanged || (bind.live_only && page.deleted_at_us.is_some()) {
                return Ok(0);
            }
            if page.deleted_at_us.is_none() {
                assert_origin_unclaimed(
                    &*tx,
                    &page.source_id,
                    &page.slug,
                    Some(&page),
                    Some(&bind.source_path),
                )?;
            }
            page.source_path = Some(bind.source_path.clone());
            write_page(tx, &page)?;
            Ok(1)
        })
    }

    /// `stampPageIngest(slug, stamp)`: sets the page's source kind, ingest channel and ingest time,
    /// live or a tombstone. A missing page changes nothing.
    pub fn stamp_page_ingest(&self, slug: &str, stamp: &PageIngestStamp) -> Result<()> {
        let ingested_at_us = match stamp.ingested_at.as_deref() {
            None => None,
            Some(text) => Some(parse_iso(text).ok_or_else(|| {
                StoreError::invalid(format!(
                    "stampPageIngest ingestedAt is not an ISO time: {text}"
                ))
            })?),
        };
        self.write(|tx| {
            let Some(mut page) = read_page(&*tx, &stamp.source_id, slug)? else {
                return Ok(());
            };
            page.source_kind = stamp.source_kind.clone();
            page.ingested_via = stamp.ingested_via.clone();
            page.ingested_at_us = ingested_at_us;
            write_page(tx, &page)
        })
    }

    /// `sealImportedPage(slug, seal)`: stamps the chunker version and, when `seal.revision` is the
    /// page's revision, seals its text projection at that revision with the timeline the keyword
    /// vector reads. Returns the page id, or `None` when there is no such page.
    pub fn seal_imported_page(
        &self,
        slug: &str,
        seal: &ImportedPageSeal,
    ) -> Result<Option<SealedPage>> {
        self.write(|tx| {
            let Some(mut page) = read_page(&*tx, &seal.source_id, slug)? else {
                return Ok(None);
            };
            page.chunker_version = Some(seal.chunker_version);
            let current = seal.revision.as_deref() == Some(page.knowledge_revision.as_str());
            if current {
                page.text_projection_revision = Some(page.knowledge_revision.clone());
            }
            write_page(tx, &page)?;
            if current {
                record_search_timeline(
                    tx,
                    page.id,
                    &page.knowledge_revision,
                    &page.title,
                    &seal.timeline_text,
                )?;
            }
            Ok(Some(SealedPage { id: page.id }))
        })
    }

    /// `readLivePageBody(slug, { sourceId })`: the live page's frontmatter, body columns, body
    /// storage and content hash, or `None` when the page is absent or a tombstone. NULL body
    /// columns mean a segmented shell (`PageText`), so the storage reads `segmented` then.
    pub fn read_live_page_body(
        &self,
        slug: &str,
        source_id: &str,
    ) -> Result<Option<LivePageBodyRow>> {
        let read = self.read()?;
        Ok(read_page(&*read, source_id, slug)?
            .filter(|page| page.deleted_at_us.is_none())
            .map(|page| {
                let segmented = page.compiled_truth.is_null() && page.timeline.is_null();
                LivePageBodyRow {
                    frontmatter: page.frontmatter,
                    compiled_truth: text_of(&page.compiled_truth),
                    timeline: text_of(&page.timeline),
                    body_storage: if segmented { "segmented" } else { "inline" },
                    content_hash: page.content_hash,
                }
            }))
    }

    /// `hasSegmentStorage()`: whether any segment text or body staging is stored.
    pub fn has_segment_storage(&self) -> Result<bool> {
        let read = self.read()?;
        let mut present = false;
        for kind in [SEGMENT_TEXT_KIND, BODY_STAGING_KIND] {
            scan_prefix(&*read, &[keys::PAGE_BODY, kind], false, &mut |_, _| {
                present = true;
                false
            })?;
            if present {
                break;
            }
        }
        Ok(present)
    }
}

fn text_of(text: &PageText) -> Option<String> {
    text.as_deref().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::pages::{PageInput, PutPageOptions, search_timeline};

    #[test]
    fn a_seal_at_the_current_revision_records_the_search_timeline_and_a_stale_one_does_not() {
        let store = crate::test_support::store();
        let input: PageInput = serde_json::from_value(
            json!({"type": "note", "title": "Sealed", "compiled_truth": "Body.", "timeline": "- 2026: x"}),
        )
        .unwrap();
        store
            .put_page("notes/sealed", &input, &PutPageOptions::default())
            .unwrap();
        let page = read_page(&*store.read().unwrap(), "default", "notes/sealed")
            .unwrap()
            .unwrap();
        let seal = |revision: &str| ImportedPageSeal {
            source_id: "default".into(),
            revision: Some(revision.into()),
            timeline_text: "- 2026: x".into(),
            chunker_version: 4,
        };
        let stale = store
            .seal_imported_page(
                "notes/sealed",
                &seal("f0000000-0000-4000-8000-0000000000f1"),
            )
            .unwrap();
        assert_eq!(stale, Some(SealedPage { id: page.id }));
        assert_eq!(
            search_timeline(&*store.read().unwrap(), page.id).unwrap(),
            None
        );
        store
            .seal_imported_page("notes/sealed", &seal(&page.knowledge_revision))
            .unwrap();
        let read = store.read().unwrap();
        let sealed = read_page(&*read, "default", "notes/sealed")
            .unwrap()
            .unwrap();
        assert_eq!(sealed.chunker_version, Some(4));
        assert_eq!(
            sealed.text_projection_revision.as_deref(),
            Some(page.knowledge_revision.as_str())
        );
        let timeline = search_timeline(&*read, page.id).unwrap().unwrap();
        assert_eq!(
            (timeline.revision.as_str(), timeline.timeline.as_str()),
            (page.knowledge_revision.as_str(), "- 2026: x")
        );
    }

    #[test]
    fn segment_storage_is_any_segment_text_or_body_staging_record() {
        let store = crate::test_support::store();
        assert!(!store.has_segment_storage().unwrap());
        store
            .write(|tx| tx.put(&[keys::PAGE_BODY, 0x02, 1], b"manifest"))
            .unwrap();
        assert!(
            !store.has_segment_storage().unwrap(),
            "a manifest alone is not segment storage"
        );
        store
            .write(|tx| tx.put(&[keys::PAGE_BODY, BODY_STAGING_KIND, 1], b"staging"))
            .unwrap();
        assert!(store.has_segment_storage().unwrap());
    }
}
