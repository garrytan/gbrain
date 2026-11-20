//! Page, mention and fact-pool reads whose SQL sorts text by byte (the collate-equal lane): the typed members of
//! `src/core/engine-sql/collate-page-reads.ts`.
//!
//! Members: listPageTypePairs, countPagesWithMentionLinks, listGazetteerSourceIds, listGazetteerPages,
//! listGazetteerAliasRows, listStaleMentionPages, listStaleMentionLinks, listPoolEntityPairs, listPoolUnbackedKeys.
//!
//! Each reads the page, link, alias and fact records the SQL engines keep in tables. Rust text orders by byte, as the
//! `COLLATE "C"` the SQL states; a read that names no order returns rows by (source, slug), the key order.

use crate::cli_reads::pg_text::fm_text;
use crate::error::Result;
use crate::facts::trust::{EntityRef, PoolArgs, RelevanceQuery};
use crate::kv::{KvRead, scan_prefix};
use crate::links::{no_nul, out_links};
use crate::page_body::segmented_reference;
use crate::pages::{PageRecord, all_pages, read_page, read_page_by_id};
use crate::{Store, keys};
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `keys::ALIAS` sub-key of the by-page `page_aliases` rows (`aliases.rs`).
const PAGE_ALIAS_BY_SLUG: u8 = 0x03;
/// The link source of the mention pass.
const MENTIONS: &str = "mentions";

fn live_pages(read: &dyn KvRead) -> Result<Vec<PageRecord>> {
    Ok(all_pages(read)?
        .into_iter()
        .filter(|p| p.deleted_at_us.is_none())
        .collect())
}

/// A live page with at least one outgoing `mentions` link.
fn has_mentions(read: &dyn KvRead, page: &PageRecord) -> Result<bool> {
    Ok(out_links(read, page.id)?
        .iter()
        .any(|l| l.link_source.as_deref() == Some(MENTIONS)))
}

/// The pages `scanStaleMentions` scans: live pages with a `mentions` link, `ORDER BY slug COLLATE "C", id LIMIT`.
fn scanned_pages(read: &dyn KvRead, limit: usize) -> Result<Vec<PageRecord>> {
    let mut pages = Vec::new();
    for page in live_pages(read)? {
        if has_mentions(read, &page)? {
            pages.push(page);
        }
    }
    pages.sort_by(|a, b| a.slug.cmp(&b.slug).then(a.id.cmp(&b.id)));
    pages.truncate(limit);
    Ok(pages)
}

/// The `(source_id, entity_slug)` pairs of the sources' facts that a pool read could name, by byte.
fn fact_pairs(read: &dyn KvRead, sources: &[String]) -> Result<BTreeSet<(String, String)>> {
    let mut pairs = BTreeSet::new();
    for source in sources {
        for row in crate::facts::source_rows(read, source)? {
            if let Some(slug) = row.entity_slug {
                pairs.insert((row.source_id, slug));
            }
        }
    }
    Ok(pairs)
}

impl Store {
    /// `listPageTypePairs()`: the distinct `(source_id, type)` pairs of the live pages, by byte.
    pub fn list_page_type_pairs(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let pairs: BTreeSet<(String, String)> = live_pages(&*read)?
            .into_iter()
            .map(|p| (p.source_id, p.page_type))
            .collect();
        Ok(pairs
            .into_iter()
            .map(|(source_id, kind)| json!({"source_id": source_id, "type": kind}))
            .collect())
    }

    /// `countPagesWithMentionLinks()`: the live pages that have at least one outgoing `mentions` link.
    pub fn count_pages_with_mention_links(&self) -> Result<u64> {
        let read = self.read()?;
        let mut count = 0;
        for page in live_pages(&*read)? {
            if has_mentions(&*read, &page)? {
                count += 1;
            }
        }
        Ok(count)
    }

    /// `listGazetteerSourceIds()`: `{ id }` of every source that holds a live page, by byte.
    pub fn list_gazetteer_source_ids(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let ids: BTreeSet<String> = live_pages(&*read)?
            .into_iter()
            .map(|p| p.source_id)
            .collect();
        Ok(ids.into_iter().map(|id| json!({ "id": id })).collect())
    }

    /// `listGazetteerPages(types, handleKeys)`: the live pages of the listed types as the gazetteer reads them (slug,
    /// source_id, title, type, connector_stub, and the frontmatter text of the four handle keys as h1..h4), by
    /// (source, slug).
    pub fn list_gazetteer_pages(
        &self,
        types: &[String],
        handle_keys: &[String],
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for page in live_pages(&*read)? {
            if !types.contains(&page.page_type) {
                continue;
            }
            let handle = |i: usize| {
                handle_keys
                    .get(i)
                    .and_then(|key| fm_text(&page.frontmatter, key))
            };
            out.push(json!({
                "slug": page.slug, "source_id": page.source_id, "title": page.title, "type": page.page_type,
                "connector_stub": fm_text(&page.frontmatter, "google_contact_id").is_some(),
                "h1": handle(0), "h2": handle(1), "h3": handle(2), "h4": handle(3),
            }));
        }
        Ok(out)
    }

    /// `listGazetteerAliasRows(types)`: every `page_aliases` row of a live page of the listed types, with the page's
    /// title, type and frontmatter `identity` text, by (source, slug, alias, origin).
    pub fn list_gazetteer_alias_rows(&self, types: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for page in live_pages(&*read)? {
            if !types.contains(&page.page_type) {
                continue;
            }
            let mut prefix = vec![keys::ALIAS, PAGE_ALIAS_BY_SLUG];
            for part in [page.source_id.as_str(), page.slug.as_str()] {
                prefix.extend_from_slice(part.as_bytes());
                prefix.push(0);
            }
            let mut rows = Vec::new();
            scan_prefix(&*read, &prefix, false, &mut |k, v| {
                let mut parts = k[prefix.len()..].split(|b| *b == 0);
                if let (Some(alias), Some(origin)) = (parts.next(), parts.next()) {
                    rows.push((
                        String::from_utf8_lossy(alias).into_owned(),
                        String::from_utf8_lossy(origin).into_owned(),
                        v.to_vec(),
                    ));
                }
                true
            })?;
            for (alias, origin, value) in rows {
                let value: Value = if value.is_empty() {
                    json!({})
                } else {
                    serde_json::from_slice(&value)?
                };
                out.push(json!({
                    "alias_norm": alias, "slug": page.slug, "source_id": page.source_id,
                    "title": page.title, "type": page.page_type, "origin": origin,
                    "case_sensitive": value.get("c").and_then(Value::as_bool).unwrap_or(false),
                    "alias_text": value.get("t").and_then(Value::as_str),
                    "identity": fm_text(&page.frontmatter, "identity"),
                }));
            }
        }
        Ok(out)
    }

    /// `listStaleMentionPages(limit)`: the first `limit` live pages with a `mentions` link by slug byte, then page id,
    /// with their `title || body` text (id, slug, source_id, title, body_storage, body).
    pub fn list_stale_mention_pages(&self, limit: u64) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for page in scanned_pages(&*read, limit as usize)? {
            let segmented = segmented_reference(&*read, page.id)?.is_some();
            let text = |t: &crate::pages::PageText| t.as_deref().unwrap_or("").to_string();
            let body = format!(
                "{}\n\n{}\n\n{}",
                page.title,
                text(&page.compiled_truth),
                text(&page.timeline)
            );
            out.push(json!({
                "id": page.id, "slug": page.slug, "source_id": page.source_id, "title": page.title,
                "body_storage": if segmented { "segmented" } else { "inline" }, "body": body,
            }));
        }
        Ok(out)
    }

    /// `listStaleMentionLinks(limit)`: the `mentions` links of those pages by from-slug then to-slug byte (from_id,
    /// from_slug, to_slug, to_source_id, link_kind, link_type).
    pub fn list_stale_mention_links(&self, limit: u64) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for page in scanned_pages(&*read, limit as usize)? {
            for link in out_links(&*read, page.id)? {
                if link.link_source.as_deref() != Some(MENTIONS) {
                    continue;
                }
                let Some(target) = read_page_by_id(&*read, link.to_page_id)? else {
                    continue;
                };
                rows.push((
                    page.slug.clone(),
                    target.slug.clone(),
                    page.id,
                    target.source_id.clone(),
                    link,
                ));
            }
        }
        rows.sort_by(|a, b| {
            a.0.cmp(&b.0)
                .then(a.1.cmp(&b.1))
                .then(a.2.cmp(&b.2))
                .then(a.3.cmp(&b.3))
        });
        Ok(rows
            .into_iter()
            .map(|(from_slug, to_slug, from_id, to_source_id, link)| {
                json!({
                    "from_id": from_id, "from_slug": from_slug, "to_slug": to_slug, "to_source_id": to_source_id,
                    "link_kind": link.link_kind, "link_type": link.link_type,
                })
            })
            .collect())
    }

    /// Whether the pool `pool` holds a fact about `(source, slug)`: the entity arm of `listFactsForRelevance` reads
    /// the pool's rows of one entity under the pool's whole read policy.
    fn pool_names(&self, pool: &PoolArgs, source_id: &str, slug: &str) -> Result<bool> {
        let query = RelevanceQuery {
            arm: "entity".into(),
            pool: pool.clone(),
            entity: Some(EntityRef {
                source_id: source_id.into(),
                slug: slug.into(),
            }),
            limit: 1.0,
            ..RelevanceQuery::default()
        };
        Ok(!self.list_facts_for_relevance(&query)?.is_empty())
    }

    /// The `(source, entity slug)` pairs of the pool's facts that `keep` admits, by byte.
    fn pool_pairs(
        &self,
        op: &str,
        pool: &PoolArgs,
        keep: &dyn Fn(&dyn KvRead, &str, &str) -> Result<bool>,
    ) -> Result<Vec<(String, String)>> {
        let mut texts: Vec<(&str, &str)> = pool
            .source_ids
            .iter()
            .map(|s| ("sourceIds", s.as_str()))
            .collect();
        for entity in pool.entities.iter().flatten() {
            texts.push(("entities", entity.source_id.as_str()));
            texts.push(("entities", entity.slug.as_str()));
        }
        no_nul(op, &texts)?;
        let candidates = {
            let read = self.read()?;
            let mut kept = Vec::new();
            for (source, slug) in fact_pairs(&*read, &pool.source_ids)? {
                if keep(&*read, &source, &slug)? {
                    kept.push((source, slug));
                }
            }
            kept
        };
        let mut out = Vec::new();
        for (source, slug) in candidates {
            if self.pool_names(pool, &source, &slug)? {
                out.push((source, slug));
            }
        }
        Ok(out)
    }

    /// `listPoolEntityPairs(pool)`: the distinct `(source_id, entity_slug)` pairs with a fact in the pool, by byte.
    pub fn list_pool_entity_pairs(&self, pool: &PoolArgs) -> Result<Vec<Value>> {
        let pairs = self.pool_pairs("listPoolEntityPairs", pool, &|_, _, _| Ok(true))?;
        Ok(pairs
            .into_iter()
            .map(|(source_id, entity_slug)| json!({"source_id": source_id, "entity_slug": entity_slug}))
            .collect())
    }

    /// `listPoolUnbackedKeys(pool, keys, limit)`: the pool pairs whose entity slug is one of `keys` and that have no
    /// live page at that slug, the byte-first `limit`.
    pub fn list_pool_unbacked_keys(
        &self,
        pool: &PoolArgs,
        wanted: &[String],
        limit: u64,
    ) -> Result<Vec<Value>> {
        no_nul(
            "listPoolUnbackedKeys",
            &wanted
                .iter()
                .map(|k| ("keys", k.as_str()))
                .collect::<Vec<_>>(),
        )?;
        let wanted: BTreeSet<&str> = wanted.iter().map(String::as_str).collect();
        let pairs = self.pool_pairs("listPoolUnbackedKeys", pool, &|read, source, slug| {
            Ok(wanted.contains(slug)
                && !read_page(read, source, slug)?.is_some_and(|p| p.deleted_at_us.is_none()))
        })?;
        Ok(pairs
            .into_iter()
            .take(limit as usize)
            .map(|(source_id, entity_slug)| json!({"source_id": source_id, "entity_slug": entity_slug}))
            .collect())
    }
}
