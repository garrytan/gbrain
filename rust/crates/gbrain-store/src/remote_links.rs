//! The remote links effect's edge reads and writes (the TypeScript `engine-sql/remote-links.ts`):
//! the edges one producer owns from a page, their removal, and which of a list of pages the writer
//! reads and the privacy part shows. The effect itself (which targets get an edge) stays in
//! `src/core/persistence/effect-links.ts`.
//!
//! Members: readOwnedLinks, deleteOwnedLinks, readLinkTargetPages. The TypeScript member turns the
//! writer's rendered read policy into a [`PrivacyPolicy`] (or refuses), so the target read judges a
//! page with `page_hidden` (facts/privacy.rs), as `readCallerPageAccess` does; `visible` is the
//! privacy part alone (`privacyPartSql`), judged by `privacy_allows`.
//!
//! Keys: this family adds none. It reads links through the origin index of `links.rs`
//! (`keys::link_origin_prefix`) and pages through `pages.rs`.

use serde::Serialize;
use std::collections::{BTreeSet, HashSet};

use crate::facts::{PrivacyPolicy, page_hidden, privacy_allows};
use crate::keys;
use crate::links::{LinkRecord, delete_link, indexed_links};
use crate::pages::{read_page, read_page_by_id};
use crate::{Result, Store, StoreError};

/// One edge a producer owns: its id and its target's slug.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OwnedLink {
    pub id: u64,
    pub slug: String,
}

/// One live page among the asked slugs: whether the writer reads it and whether the privacy part shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkTargetPage {
    pub slug: String,
    pub readable: bool,
    pub visible: bool,
}

/// `$N` as Postgres casts a page or link id to bigint: surrounding whitespace is accepted.
fn bigint(text: &str) -> Result<u64> {
    text.trim().parse::<u64>().map_err(|_| {
        StoreError::invalid(format!("invalid input syntax for type bigint: \"{text}\""))
    })
}

fn owned(read: &dyn crate::kv::KvRead, link_source: &str, origin: u64) -> Result<Vec<LinkRecord>> {
    Ok(indexed_links(read, &keys::link_origin_prefix(origin))?
        .into_iter()
        .filter(|l| {
            l.origin_page_id == Some(origin) && l.link_source.as_deref() == Some(link_source)
        })
        .collect())
}

impl Store {
    /// `readOwnedLinks(linkSource, originPageId)`: the edges `link_source` owns from the page, with
    /// each target's slug, in link id order (PGLite sets no order).
    pub fn read_owned_links(
        &self,
        link_source: &str,
        origin_page_id: &str,
    ) -> Result<Vec<OwnedLink>> {
        let origin = bigint(origin_page_id)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for link in owned(&*read, link_source, origin)? {
            if let Some(target) = read_page_by_id(&*read, link.to_page_id)? {
                rows.push(OwnedLink {
                    id: link.id,
                    slug: target.slug,
                });
            }
        }
        Ok(rows)
    }

    /// `deleteOwnedLinks(originPageId, linkSource, ids)`: removes the edges among `ids` that
    /// `link_source` owns from the page; returns how many.
    pub fn delete_owned_links(
        &self,
        origin_page_id: &str,
        link_source: &str,
        ids: &[String],
    ) -> Result<u64> {
        let origin = bigint(origin_page_id)?;
        let wanted: HashSet<u64> = ids.iter().map(|id| bigint(id)).collect::<Result<_>>()?;
        if wanted.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            let mut removed = 0u64;
            for link in owned(&*tx, link_source, origin)? {
                if wanted.contains(&link.id) {
                    delete_link(tx, &link)?;
                    removed += 1;
                }
            }
            Ok(removed)
        })
    }

    /// `readLinkTargetPages(sourceId, slugs, policy)`: one row per distinct slug that names a live
    /// page of the source. `readable` is the writer's policy (`None`: every page), `visible` the
    /// privacy part, with the privacy aliases when `honor_aliases`. Rows come in slug order
    /// (bytewise); PGLite sets no order.
    pub fn read_link_target_pages(
        &self,
        source_id: &str,
        slugs: &[String],
        readable: Option<&PrivacyPolicy>,
        honor_aliases: bool,
    ) -> Result<Vec<LinkTargetPage>> {
        let read = self.read()?;
        let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        let mut rows = Vec::new();
        for slug in wanted {
            let Some(page) = read_page(&*read, source_id, slug)? else {
                continue;
            };
            if page.deleted_at_us.is_some() {
                continue;
            }
            let readable = match readable {
                None => true,
                Some(policy) => !page_hidden(&*read, &page, policy)?,
            };
            let visible = privacy_allows(&*read, &page, honor_aliases)?;
            rows.push(LinkTargetPage {
                slug: slug.to_owned(),
                readable,
                visible,
            });
        }
        Ok(rows)
    }
}
