//! The page-set reads of the core commands whose SQL sorts or groups text by byte (the collate-equal lane): the typed
//! members of `src/core/engine-sql/collate-page-reads.ts` that read a source's pages as a set.
//!
//! Members: readPageSizeRows, listChatChannelCensus, listLinkPageMetadataForSlugs, listAttendedOriginSlugs,
//! readCompanyBrainEvidenceRows, listShelfPageRows, listCardRows, findCardRows, listLiveSourceIncarnations,
//! listAttendanceScanWindow.
//!
//! Each reads the page, link and source records the SQL engines keep in tables. Rust text orders by byte, as the
//! `COLLATE "C"` the SQL states. A read the SQL leaves unordered (`listAttendedOriginSlugs`,
//! `listLiveSourceIncarnations`) returns its rows in byte order, which no caller depends on.

use crate::Store;
use crate::aliases::page_alias_rows;
use crate::cli_reads::import::LinkPageMetadataRow;
use crate::cli_reads::pg_text::{btrim, fm_text, pg_lower, timestamptz_text};
use crate::error::{Result, StoreError};
use crate::facts::privacy::{PrivacyPolicy, cheap_page_visible, folder_rules_allow, page_hidden};
use crate::keyword::{
    plainto_tsquery_simple, to_tsvector_simple, trgm_word_similarity, ts_matches,
};
use crate::kv::KvRead;
use crate::links::{no_nul, out_links};
use crate::page_body::{segmented_reference, truth_lead};
use crate::page_embedding_budget::budget_state;
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::sources::read_source;
use serde_json::{Map, Value, json};
use std::cmp::Ordering;
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

/// The card filters: a `storage.status` text, a location `store` text, and `on_source_machine` as the text `true` or `false`.
struct CardFilter<'a> {
    status: Option<&'a str>,
    store: Option<&'a str>,
    machine: Option<String>,
}

/// The live unquarantined pages of type `card_type` in an unarchived `source_id` that pass `filter`, by slug.
fn card_pages(
    read: &dyn KvRead,
    source_id: &str,
    card_type: &str,
    filter: &CardFilter<'_>,
) -> Result<Vec<PageRecord>> {
    if read_source(read, source_id)?.is_none_or(|s| s.archived) {
        return Ok(Vec::new());
    }
    Ok(live_in(read, source_id)?
        .into_iter()
        .filter(|p| p.page_type == card_type && !p.frontmatter.contains_key("quarantine"))
        .filter(|p| {
            let storage = storage_of(p);
            filter
                .status
                .is_none_or(|v| storage_text(storage, "status").as_deref() == Some(v))
                && filter.store.is_none_or(|v| {
                    locations(storage).any(|loc| fm_text(loc, "store").as_deref() == Some(v))
                })
                && filter.machine.as_deref().is_none_or(|v| {
                    storage_text(storage, "on_source_machine").as_deref() == Some(v)
                })
        })
        .collect())
}

/// One card of a page: `{ id, title, status, kind, stores, original_path, on_source_machine, updated_at }`.
fn card_json(p: &PageRecord) -> Value {
    let storage = storage_of(p);
    let mut stores: Vec<Option<String>> = locations(storage)
        .map(|loc| fm_text(loc, "store"))
        .collect();
    stores.sort_by(|a, b| match (a, b) {
        (Some(a), Some(b)) => a.cmp(b),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    });
    stores.dedup();
    let machine = match storage_text(storage, "on_source_machine").as_deref() {
        Some("true") => json!(true),
        Some("false") => json!(false),
        _ => Value::Null,
    };
    json!({
        "id": p.slug, "title": p.title,
        "status": storage_text(storage, "status"), "kind": storage_text(storage, "kind"),
        "stores": stores, "original_path": storage_text(storage, "original_path"),
        "on_source_machine": machine, "updated_at": timestamptz_text(p.updated_at_us),
    })
}

/// `left(coalesce(compiled_truth, truth_lead), BOUNDED_PREFIX_BYTES)` counts code points.
const BOUNDED_PREFIX_CHARS: usize = 64 * 1024;

/// `frontmatter -> 'storage'` as an object: any other value (or none) reads every `->>` on it as NULL.
fn storage_of(page: &PageRecord) -> Option<&Map<String, Value>> {
    page.frontmatter.get("storage").and_then(Value::as_object)
}

/// `frontmatter -> 'storage' ->> key`.
fn storage_text(storage: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    storage.and_then(|s| fm_text(s, key))
}

/// The object elements of `storage -> 'locations'` when it is an array (`jsonb_typeof(...) = 'array'`); any other element
/// reads `->> 'store'` as NULL, so it is an empty object here.
fn locations(storage: Option<&Map<String, Value>>) -> impl Iterator<Item = &Map<String, Value>> {
    static NONE: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);
    storage
        .and_then(|s| s.get("locations"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|loc| loc.as_object().unwrap_or(&NONE))
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

/// Whether the census leaves `page` out: the page policy, or with `fast` the folder rules first and the rest of the
/// policy only for a page that fails the cheap test.
fn census_hidden(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &PrivacyPolicy,
    fast: bool,
) -> Result<bool> {
    if !fast {
        return page_hidden(read, page, policy);
    }
    if !folder_rules_allow(read, page, policy)? {
        return Ok(true);
    }
    if cheap_page_visible(page, policy.honor_aliases) {
        return Ok(false);
    }
    page_hidden(read, page, policy)
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
    /// `fast` reads the policy as `privatePagesFilterFragmentFast` does: a page under no folder rule
    /// with no `visibility`, `derived_from`, `readable_by`, `pinned_question` (or alias) key and a
    /// plain type passes without the rest of the policy, so a page in an owner-only source that
    /// passes that cheap test is counted, as the statement counts it.
    pub fn list_chat_channel_census(
        &self,
        source_ids: &[String],
        chat_types: &[String],
        dm_types: &[String],
        policy: Option<&PrivacyPolicy>,
        fast: bool,
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
                && census_hidden(&*read, &page, policy, fast)?
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

    /// `listCardRows(sourceId, cardType, status, store, onSourceMachine, limit, offset)`: `{ cards, total }`, the live
    /// unquarantined pages of type `card_type` in `source_id` (an unarchived source) that pass the card filters, by slug,
    /// `limit` from `offset`; `total` counts all of them. A card is `{ id, title, status, kind, stores, original_path,
    /// on_source_machine, updated_at }` read from the page's `storage` frontmatter object; `stores` is the distinct
    /// location stores by byte, a missing store (`null`) last.
    #[allow(clippy::too_many_arguments)]
    pub fn list_card_rows(
        &self,
        source_id: &str,
        card_type: &str,
        status: Option<&str>,
        store: Option<&str>,
        on_source_machine: Option<bool>,
        limit: i64,
        offset: i64,
    ) -> Result<Value> {
        let read = self.read()?;
        let filter = CardFilter {
            status,
            store,
            machine: on_source_machine.map(|b| b.to_string()),
        };
        let cards = card_pages(&*read, source_id, card_type, &filter)?;
        let total = cards.len();
        let page = cards
            .iter()
            .skip(usize::try_from(offset).unwrap_or(usize::MAX))
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .map(card_json)
            .collect::<Vec<_>>();
        Ok(json!({ "cards": page, "total": total }))
    }

    /// `findCardRows(sourceId, cardType, query, aliasNorm, terms, status, store, onSourceMachine)`: the cards of
    /// `list_card_rows` that pass the filters, each with its ranking columns, best first, at most 500. `query` is the
    /// lowercased trimmed phrase and `alias_norm` its alias form. `exact_id` is `slug = query`; `exact_alias` is an alias
    /// row equal to `alias_norm`; `exact_title` is `lower(btrim(title)) = query`; `matched` counts the terms the
    /// `simple` text search finds in the document `title aliases slug body` (the body is the first 65536 characters of
    /// the compiled truth, or of the truth lead of a segmented page; a page with no body matches no term);
    /// `similarity` is the best `word_similarity(query, ...)` over the lowercased title and the aliases. The order is
    /// `exact_id`, `exact_alias`, `exact_title`, `matched`, `similarity` (each greatest first), then slug by byte.
    #[allow(clippy::too_many_arguments)]
    pub fn find_card_rows(
        &self,
        source_id: &str,
        card_type: &str,
        query: &str,
        alias_norm: &str,
        terms: &[String],
        status: Option<&str>,
        store: Option<&str>,
        on_source_machine: Option<bool>,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let filter = CardFilter {
            status,
            store,
            machine: on_source_machine.map(|b| b.to_string()),
        };
        let mut rows = Vec::new();
        for page in card_pages(&*read, source_id, card_type, &filter)? {
            let aliases: Vec<String> = page_alias_rows(&*read, source_id, &page.slug)?
                .into_iter()
                .map(|(alias, _)| alias)
                .collect();
            let body = match page.compiled_truth.as_deref() {
                Some(text) => Some(text.to_string()),
                None => truth_lead(&*read, page.id)?,
            };
            let mut matched = 0usize;
            if let Some(body) = body.filter(|_| !terms.is_empty()) {
                let prefix = body
                    .char_indices()
                    .nth(BOUNDED_PREFIX_CHARS)
                    .map_or(body.as_str(), |(at, _)| &body[..at]);
                let doc = to_tsvector_simple(&format!(
                    "{} {} {} {}",
                    page.title,
                    aliases.join(" "),
                    page.slug,
                    prefix
                ))?;
                for term in terms {
                    if ts_matches(&doc, &plainto_tsquery_simple(term)?) {
                        matched += 1;
                    }
                }
            }
            let similarity = aliases
                .iter()
                .map(|alias| trgm_word_similarity(query, alias))
                .fold(
                    trgm_word_similarity(query, &pg_lower(&page.title)),
                    f32::max,
                );
            let mut card = card_json(&page);
            card["exact_id"] = json!(page.slug == query);
            card["exact_alias"] = json!(aliases.iter().any(|a| a == alias_norm));
            card["exact_title"] = json!(pg_lower(btrim(&page.title)) == query);
            card["matched"] = json!(matched);
            card["similarity"] = json!(f64::from(similarity));
            rows.push(card);
        }
        let flag = |row: &Value, key: &str| row[key].as_bool().unwrap_or(false);
        // Stable: `card_pages` is by slug byte, the last sort key.
        rows.sort_by(|a, b| {
            flag(b, "exact_id")
                .cmp(&flag(a, "exact_id"))
                .then(flag(b, "exact_alias").cmp(&flag(a, "exact_alias")))
                .then(flag(b, "exact_title").cmp(&flag(a, "exact_title")))
                .then(b["matched"].as_u64().cmp(&a["matched"].as_u64()))
                .then(
                    b["similarity"]
                        .as_f64()
                        .partial_cmp(&a["similarity"].as_f64())
                        .unwrap_or(Ordering::Equal),
                )
        });
        rows.truncate(500);
        Ok(rows)
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
