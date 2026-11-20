//! Alias rows whose target page is not live: the reads and the delete of `gbrain repair aliases`
//! and doctor's `dangling_aliases` check (`engine-sql/alias-orphans.ts`).
//!
//! Members: listAliasTargets (the TypeScript members listOrphanedAliasTargets,
//! countSoftDeletedAliasTargets, countOrphanedAliasesBySource and countSoftDeletedAliases read it),
//! deleteOrphanedAliases.
//!
//! A target is the slug an alias row resolves to: a `page_aliases` row's `slug` (the by-page key
//! `0x03 source \0 slug \0 alias_norm \0 origin`) and a `slug_aliases` row's `canonical_slug` (the
//! value of `0x01 source \0 alias_slug`). Neither table has a foreign key to `pages`, so the rows
//! outlive a hard delete of their page (see the module comment of `aliases.rs`). A target with no
//! page row at all is `missing`; one whose page is soft-deleted is `soft_deleted`; a live page's
//! target is not listed. Targets come in byte order, source then slug, as the SQL's
//! `COLLATE "C"` orders them.

use super::{
    PAGE_ALIAS_BY_SLUG, SLUG_ALIAS, SLUG_ALIAS_BY_CANONICAL, SlugAliasRecord, delete_page_alias,
    delete_slug_alias, page_alias_rows, prefix, refuse_nul, scan_tails, tail,
};
use crate::error::Result;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::read_page;
use crate::{Store, keys};
use serde::Serialize;
use std::collections::BTreeMap;

/// One target slug and how many rows of each alias table resolve to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AliasTarget {
    pub source_id: String,
    pub slug: String,
    /// `missing` (no page row) or `soft_deleted`.
    pub page: &'static str,
    pub page_aliases: u64,
    pub slug_redirects: u64,
}

/// `(page_aliases, slug_redirects)` per `(source, target slug)`, every source.
fn target_counts(read: &dyn KvRead) -> Result<BTreeMap<(String, String), (u64, u64)>> {
    let mut counts: BTreeMap<(String, String), (u64, u64)> = BTreeMap::new();
    for (_, parts) in scan_tails(read, &[keys::ALIAS, PAGE_ALIAS_BY_SLUG])? {
        if let [source, slug, _alias, _origin] = parts.as_slice() {
            counts.entry((source.clone(), slug.clone())).or_default().0 += 1;
        }
    }
    let head = [keys::ALIAS, SLUG_ALIAS];
    let mut failure = None;
    scan_prefix(read, &head, false, &mut |k, v| {
        let parts = tail(k, head.len());
        let [source, _alias] = parts.as_slice() else {
            return true;
        };
        match serde_json::from_slice::<SlugAliasRecord>(v) {
            Ok(record) => {
                counts
                    .entry((source.clone(), record.canonical_slug))
                    .or_default()
                    .1 += 1;
                true
            }
            Err(e) => {
                failure = Some(e.into());
                false
            }
        }
    })?;
    match failure {
        Some(e) => Err(e),
        None => Ok(counts),
    }
}

impl Store {
    /// `listAliasTargets(sourceIds)`: every target slug whose page is missing or soft-deleted, in
    /// the named sources (every source when `None`), by source then slug in byte order.
    pub fn list_alias_targets(&self, source_ids: Option<&[String]>) -> Result<Vec<AliasTarget>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for ((source, slug), (page_aliases, slug_redirects)) in target_counts(&*read)? {
            if source_ids.is_some_and(|ids| !ids.contains(&source)) {
                continue;
            }
            let page = match read_page(&*read, &source, &slug)? {
                None => "missing",
                Some(record) if record.deleted_at_us.is_some() => "soft_deleted",
                Some(_) => continue,
            };
            out.push(AliasTarget {
                source_id: source,
                slug,
                page,
                page_aliases,
                slug_redirects,
            });
        }
        Ok(out)
    }

    /// `deleteOrphanedAliases(sourceId, slug)`: when `(source, slug)` has no page row, deletes
    /// every `page_aliases` row of the slug and every `slug_aliases` row that resolves to it, in one
    /// write, and answers how many rows went. A page row, soft-deleted or live, keeps every row
    /// (`gbrain restore` still needs them). A rename redirect whose alias is the slug is never
    /// touched. NUL in either text is `invalid_argument`.
    pub fn delete_orphaned_aliases(&self, source_id: &str, slug: &str) -> Result<u64> {
        refuse_nul("deleteOrphanedAliases", &[source_id, slug])?;
        self.write(|tx| {
            if read_page(&*tx, source_id, slug)?.is_some() {
                return Ok(0);
            }
            let mut removed = 0;
            for (alias, origin) in page_alias_rows(&*tx, source_id, slug)? {
                delete_page_alias(tx, source_id, &alias, slug, &origin)?;
                removed += 1;
            }
            for (_, parts) in
                scan_tails(&*tx, &prefix(SLUG_ALIAS_BY_CANONICAL, &[source_id, slug]))?
            {
                if let [alias] = parts.as_slice() {
                    delete_slug_alias(tx, source_id, alias)?;
                    removed += 1;
                }
            }
            Ok(removed)
        })
    }
}
