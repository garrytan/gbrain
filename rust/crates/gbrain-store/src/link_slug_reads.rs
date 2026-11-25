//! Link preparation's slug reads (`src/core/engine-sql/link-slug-reads.ts`, persistence/links-preparation.ts): the
//! live alias targets a page's links name, and the slug fingerprint behind the per-source basename index.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::Store;
use crate::aliases::read_slug_alias;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, read_page};

/// One live `slug_aliases` row (`LiveSlugAliasRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LiveSlugAliasRow {
    pub alias_slug: String,
    pub canonical_slug: String,
}

/// `readSourceSlugProbe` (`SourceSlugProbe`): the hashes are decimal text.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSlugProbe {
    pub count: u64,
    pub hash: String,
    pub max_id: u64,
    pub added: Vec<String>,
    pub added_hash: String,
}

/// The store's per-slug hash (64-bit FNV-1a as a signed integer). Postgres sums `hashtextextended`; the caller compares a
/// hash only with one the same engine gave and relies only on the sum, so any stable hash serves.
fn slug_hash(slug: &str) -> i128 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in slug.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    i128::from(h as i64)
}

fn live(read: &dyn KvRead, source: &str, slug: &str) -> Result<bool> {
    Ok(read_page(read, source, slug)?.is_some_and(|p| p.deleted_at_us.is_none()))
}

/// Every page record of `source_id`, deleted pages included, in page id order.
pub(crate) fn source_pages(read: &dyn KvRead, source_id: &str) -> Result<Vec<PageRecord>> {
    let mut prefix = keys::text(keys::PAGE, &[source_id]);
    prefix.push(0);
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &prefix, false, &mut |_, v| {
        match serde_json::from_slice::<PageRecord>(v) {
            Ok(page) if page.source_id == source_id => out.push(page),
            Ok(_) => {}
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    out.sort_by_key(|p| p.id);
    Ok(out)
}

impl Store {
    /// `readLiveSlugAliases(sourceId, targets)`: the `slug_aliases` rows of the source whose alias is one of `targets`,
    /// has no live page and points at a live canonical page, in alias byte order (the SQL states no order).
    pub fn read_live_slug_aliases(
        &self,
        source_id: &str,
        targets: &[String],
    ) -> Result<Vec<LiveSlugAliasRow>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for alias in targets.iter().collect::<BTreeSet<_>>() {
            let Some(record) = read_slug_alias(&*read, source_id, alias)? else {
                continue;
            };
            if live(&*read, source_id, alias)? || !live(&*read, source_id, &record.canonical_slug)?
            {
                continue;
            }
            out.push(LiveSlugAliasRow {
                alias_slug: alias.clone(),
                canonical_slug: record.canonical_slug,
            });
        }
        Ok(out)
    }

    /// `readSourceSlugProbe(sourceId, afterId)`: the count, hash sum and largest id of the source's pages (deleted
    /// pages included), and the slugs (in id order) and hash sum of the pages whose id is above `after_id`.
    pub fn read_source_slug_probe(
        &self,
        source_id: &str,
        after_id: u64,
    ) -> Result<SourceSlugProbe> {
        let read = self.read()?;
        let pages = source_pages(&*read, source_id)?;
        let mut hash: i128 = 0;
        let mut added_hash: i128 = 0;
        let mut added = Vec::new();
        for page in &pages {
            let h = slug_hash(&page.slug);
            hash += h;
            if page.id > after_id {
                added_hash += h;
                added.push(page.slug.clone());
            }
        }
        Ok(SourceSlugProbe {
            count: pages.len() as u64,
            hash: hash.to_string(),
            max_id: pages.iter().map(|p| p.id).max().unwrap_or(0),
            added,
            added_hash: added_hash.to_string(),
        })
    }
}
