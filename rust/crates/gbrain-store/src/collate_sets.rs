//! The page-set reads of the core commands whose SQL sorts or groups text by byte (the collate-equal lane): the typed
//! members of `src/core/engine-sql/collate-page-reads.ts` that read a source's pages as a set.
//!
//! Members: readPageSizeRows, listChatChannelCensus, listLinkPageMetadataForSlugs, listAttendedOriginSlugs,
//! readCompanyBrainEvidenceRows, listShelfPageRows, listLiveSourceIncarnations, listAttendanceScanWindow.
//!
//! Each reads the page, link and source records the SQL engines keep in tables. Rust text orders by byte, as the
//! `COLLATE "C"` the SQL states. A read the SQL leaves unordered (`listAttendedOriginSlugs`,
//! `listLiveSourceIncarnations`) returns its rows in byte order, which no caller depends on.

use crate::Store;
use crate::cli_reads::import::LinkPageMetadataRow;
use crate::cli_reads::pg_text::fm_text;
use crate::error::{Result, StoreError};
use crate::facts::privacy::{PrivacyPolicy, page_hidden};
use crate::kv::KvRead;
use crate::links::{no_nul, out_links};
use crate::page_body::segmented_reference;
use crate::page_embedding_budget::budget_state;
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::sources::read_source;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The link sources a canonical edge to a page's own origin may carry (`listAttendedOriginSlugs`).
const ATTENDED_SOURCES: [&str; 3] = ["markdown", "wikilink-resolved", "frontmatter"];
/// The link sources of a company-brain ownership or supersession edge.
const EVIDENCE_SOURCES: [&str; 2] = ["frontmatter", "markdown"];

fn live_in(read: &dyn KvRead, source_id: &str) -> Result<Vec<PageRecord>> {
    let mut pages: Vec<PageRecord> = all_pages(read)?
        .into_iter()
        .filter(|p| p.deleted_at_us.is_none() && p.source_id == source_id)
        .collect();
    pages.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(pages)
}

/// `octet_length(compiled_truth) + octet_length(COALESCE(timeline, ''))` for an inline page; `body_bytes` for a
/// segmented one (NULL, here 0, when the page has none).
fn page_bytes(read: &dyn KvRead, page: &PageRecord) -> Result<(i64, bool)> {
    Ok(match segmented_reference(read, page.id)? {
        Some((_, bytes)) => (bytes.unwrap_or(0), true),
        None => (
            (page.compiled_truth.len() + page.timeline.len()) as i64,
            false,
        ),
    })
}

/// Whether the page of `id` may be an edge end of `source_id`'s company brain: live and in the source.
fn live_end(read: &dyn KvRead, id: u64, source_id: &str) -> Result<Option<PageRecord>> {
    Ok(
        read_page_by_id(read, id)?
            .filter(|p| p.deleted_at_us.is_none() && p.source_id == source_id),
    )
}

/// The channel one chat page counts toward: its own DM channel, else the first non-empty of frontmatter `channel`,
/// `chat`, `conversation`, the lower-cased `#name` of its title, `''`.
fn channel_of(page: &PageRecord, dm_types: &[String]) -> String {
    if dm_types.contains(&page.page_type) {
        return format!("dm:{}", page.slug);
    }
    for key in ["channel", "chat", "conversation"] {
        if let Some(text) = fm_text(&page.frontmatter, key).filter(|t| !t.is_empty()) {
            return text;
        }
    }
    title_channel(&page.title).unwrap_or_default()
}

/// `lower(substring(title from '^#([A-Za-z0-9._-]+)'))`.
fn title_channel(title: &str) -> Option<String> {
    let name: String = title
        .strip_prefix('#')?
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .collect();
    (!name.is_empty()).then(|| name.to_ascii_lowercase())
}

/// An evidence link end pair: the first `(from, to)` by `from.slug`, `to.slug` that `accept` takes.
fn first_edge(
    read: &dyn KvRead,
    source_id: &str,
    link_type: &str,
    accept: &dyn Fn(&PageRecord, &PageRecord) -> bool,
    customer_first: bool,
) -> Result<Option<Value>> {
    let mut best: Option<(u8, String, String, Value)> = None;
    for from in live_in(read, source_id)? {
        for link in out_links(read, from.id)? {
            let source = link.link_source.as_deref();
            let owned = link.origin_page_id == Some(from.id)
                || (link.origin_page_id.is_none() && source == Some("markdown"));
            if link.link_type != link_type
                || !source.is_some_and(|s| EVIDENCE_SOURCES.contains(&s))
                || !owned
            {
                continue;
            }
            let Some(to) = live_end(read, link.to_page_id, source_id)? else {
                continue;
            };
            if !accept(&from, &to) {
                continue;
            }
            let rank = u8::from(!(customer_first && from.page_type == "customer"));
            let key = (rank, from.slug.clone(), to.slug.clone());
            if best
                .as_ref()
                .is_none_or(|b| key < (b.0, b.1.clone(), b.2.clone()))
            {
                let row = json!({
                    "from_slug": from.slug, "from_title": from.title,
                    "to_slug": to.slug, "to_title": to.title,
                });
                best = Some((key.0, key.1, key.2, row));
            }
        }
    }
    Ok(best.map(|b| b.3))
}

impl Store {
    /// `readPageSizeRows(sourceId, maxBytes, slugs)`: `{ slug, bytes, segmented, frontmatter, state, reason }` of the
    /// source's live pages (only `slugs` when given) that carry `embed_skip`, hold more than `max_bytes`, are segmented
    /// or have an embedding ledger row, by slug.
    pub fn read_page_size_rows(
        &self,
        source_id: &str,
        max_bytes: i64,
        slugs: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        const OP: &str = "readPageSizeRows";
        no_nul(OP, &[("source_id", source_id)])?;
        let read = self.read()?;
        let mut out = Vec::new();
        for page in live_in(&*read, source_id)? {
            if slugs.is_some_and(|s| !s.contains(&page.slug)) {
                continue;
            }
            let (bytes, segmented) = page_bytes(&*read, &page)?;
            let budget = budget_state(&*read, page.id)?;
            if !(page.frontmatter.contains_key("embed_skip")
                || bytes > max_bytes
                || segmented
                || budget.is_some())
            {
                continue;
            }
            let (state, reason) = budget.unzip();
            out.push(json!({
                "slug": page.slug, "bytes": bytes, "segmented": segmented,
                "frontmatter": Value::Object(page.frontmatter),
                "state": state, "reason": reason.flatten(),
            }));
        }
        Ok(out)
    }

    /// `listChatChannelCensus(sourceIds, chatTypes, dmTypes, policy)`: `{ source_id, chat_pages, channels }` per source
    /// that holds a live chat page the caller can read (`policy` none hides nothing), by source.
    pub fn list_chat_channel_census(
        &self,
        source_ids: &[String],
        chat_types: &[String],
        dm_types: &[String],
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut census: BTreeMap<String, (u64, BTreeSet<String>)> = BTreeMap::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || !chat_types.contains(&page.page_type)
                || !source_ids.contains(&page.source_id)
            {
                continue;
            }
            if let Some(policy) = policy
                && page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            let entry = census.entry(page.source_id.clone()).or_default();
            entry.0 += 1;
            entry.1.insert(channel_of(&page, dm_types));
        }
        Ok(census
            .into_iter()
            .map(|(source_id, (pages, channels))| {
                json!({ "source_id": source_id, "chat_pages": pages, "channels": channels.len() })
            })
            .collect())
    }

    /// `listLinkPageMetadataForSlugs(sourceId, slugs)`: the live pages of `slugs` as the link resolver reads them, by slug.
    pub fn list_link_page_metadata_for_slugs(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<LinkPageMetadataRow>> {
        let read = self.read()?;
        let wanted: BTreeSet<&String> = slugs.iter().collect();
        let mut out = Vec::new();
        for slug in wanted {
            let Some(page) = read_page(&*read, source_id, slug)? else {
                continue;
            };
            if page.deleted_at_us.is_some() {
                continue;
            }
            out.push(LinkPageMetadataRow {
                aliases: page
                    .frontmatter
                    .get("aliases")
                    .cloned()
                    .unwrap_or(Value::Null),
                slug: page.slug,
                source_id: page.source_id,
                page_type: page.page_type,
                title: page.title,
                knowledge_revision: page.knowledge_revision,
            });
        }
        Ok(out)
    }

    /// `listAttendedOriginSlugs(sourceId, slugs)`: `{ slug }` of the source's pages (only `slugs` when given) that are
    /// the origin of a canonical `attended` edge to themselves, by slug. A deleted origin counts, as the SQL's join does.
    pub fn list_attended_origin_slugs(
        &self,
        source_id: &str,
        slugs: Option<&[String]>,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        // The edge may start at any page; only its origin, which is also its target, is reported.
        let mut ids = BTreeSet::new();
        for page in all_pages(&*read)? {
            for l in out_links(&*read, page.id)? {
                if l.link_type == "attended"
                    && l.origin_page_id == Some(l.to_page_id)
                    && l.link_source
                        .as_deref()
                        .is_some_and(|s| ATTENDED_SOURCES.contains(&s))
                {
                    ids.insert(l.to_page_id);
                }
            }
        }
        let mut origins = BTreeSet::new();
        for id in ids {
            if let Some(page) = read_page_by_id(&*read, id)?
                && page.source_id == source_id
                && slugs.is_none_or(|s| s.contains(&page.slug))
            {
                origins.insert(page.slug);
            }
        }
        Ok(origins
            .into_iter()
            .map(|slug| json!({ "slug": slug }))
            .collect())
    }

    /// `readCompanyBrainEvidenceRows(sourceId)`: `{ owner, decision, page }`, each the first row of its statement or null.
    pub fn read_company_brain_evidence_rows(&self, source_id: &str) -> Result<Value> {
        let read = self.read()?;
        let owner = first_edge(&*read, source_id, "owned_by", &|_, _| true, true)?;
        let decision = first_edge(
            &*read,
            source_id,
            "supersedes",
            &|from, to| from.page_type == "decision" && to.page_type == "decision",
            false,
        )?;
        let page = live_in(&*read, source_id)?
            .into_iter()
            .next()
            .map(|p| json!({ "slug": p.slug, "title": p.title }));
        Ok(json!({ "owner": owner, "decision": decision, "page": page }))
    }

    /// `listShelfPageRows(sourceId)`: `{ slug, title, type, frontmatter }` of every live page of the source, by slug.
    pub fn list_shelf_page_rows(&self, source_id: &str) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(live_in(&*read, source_id)?
            .into_iter()
            .map(|p| {
                json!({
                    "slug": p.slug, "title": p.title, "type": p.page_type,
                    "frontmatter": Value::Object(p.frontmatter),
                })
            })
            .collect())
    }

    /// `listLiveSourceIncarnations(sourceIds)`: `{ id, incarnation }` of each listed source that exists and is not
    /// archived, by id.
    pub fn list_live_source_incarnations(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = BTreeMap::new();
        for id in source_ids {
            if id.contains('\0') {
                continue;
            }
            if let Some(source) = read_source(&*read, id)?.filter(|s| !s.archived) {
                out.insert(source.id, source.incarnation);
            }
        }
        Ok(out
            .into_iter()
            .map(|(id, incarnation)| json!({ "id": id, "incarnation": incarnation }))
            .collect())
    }

    /// `listAttendanceScanWindow(sourceId, afterSlug, limit)`: `{ id, slug, source_id, type, revision, deleted }` of the
    /// first `limit` pages of the source (deleted ones included) whose slug is after `after_slug` by byte, by slug.
    pub fn list_attendance_scan_window(
        &self,
        source_id: &str,
        after_slug: &str,
        limit: i64,
    ) -> Result<Vec<Value>> {
        if limit < 0 {
            return Err(StoreError::invalid(
                "listAttendanceScanWindow limit must not be negative",
            ));
        }
        let read = self.read()?;
        let mut pages: Vec<PageRecord> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.slug.as_str() > after_slug)
            .collect();
        pages.sort_by(|a, b| a.slug.cmp(&b.slug));
        pages.truncate(limit as usize);
        Ok(pages
            .into_iter()
            .map(|p| {
                json!({
                    "id": p.id.to_string(), "slug": p.slug, "source_id": p.source_id,
                    "type": p.page_type, "revision": p.knowledge_revision,
                    "deleted": p.deleted_at_us.is_some(),
                })
            })
            .collect())
    }
}
