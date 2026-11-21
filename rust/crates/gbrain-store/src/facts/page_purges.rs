//! The `page_purges` ledger (src/core/facts/purge-schema.ts): the text-free tombstones a page purge
//! leaves, one row per `(source_id, content_hash)` naming the purged page's slug, the write request
//! that purged it and when.
//!
//! Members: listRecentPurgeRequests. `record_page_purge` is the writer a purge will call
//! (`recordPagePurge` of src/core/persistence/page-purge.ts); no TypeScript path reaches it yet,
//! because a purge runs through `executeRaw`, which a Rust brain refuses, so the parity cases and the
//! store tests seed rows with it.
//!
//! Keys (after `keys::FACT`; a text part ends with a NUL byte, and no text column may hold one):
//! - `F 0x0C source_id content_hash -> PagePurgeRecord`: one row, the `(source_id, content_hash)`
//!   primary key. The table's foreign key to `sources` (`ON DELETE CASCADE`) is honoured by
//!   `facts::remove_source_rows` and by `record_page_purge` refusing an unknown source.

use super::{DAY_US, text_key};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::sources::require_source;
use crate::{keys, put_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The byte after `keys::FACT` that marks a page purge row.
const ROW: u8 = 0x0C;

/// One stored `page_purges` row.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct PagePurgeRecord {
    pub slug: String,
    pub request_id: Option<String>,
    pub purged_at_us: i64,
}

fn source_prefix(source_id: &str) -> Vec<u8> {
    text_key(ROW, &[source_id])
}

fn row_key(source_id: &str, content_hash: &str) -> Vec<u8> {
    text_key(ROW, &[source_id, content_hash])
}

/// Every `(content_hash, row)` of a source, by content hash (bytewise, as the key orders).
pub(crate) fn source_page_purges(
    read: &dyn KvRead,
    source_id: &str,
) -> Result<Vec<(String, PagePurgeRecord)>> {
    let prefix = source_prefix(source_id);
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        let hash = k[prefix.len()..]
            .strip_suffix(&[0])
            .unwrap_or(&k[prefix.len()..]);
        match serde_json::from_slice::<PagePurgeRecord>(v) {
            Ok(r) => out.push((String::from_utf8_lossy(hash).into_owned(), r)),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// Deletes the rows of a source (`page_purges.source_id ... ON DELETE CASCADE`).
pub(crate) fn remove_source_page_purges(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
) -> Result<()> {
    for (hash, _) in source_page_purges(&*tx, source_id)? {
        tx.delete(&row_key(source_id, &hash))?;
    }
    Ok(())
}

/// The `(slug, purged_at_us)` of every row of a source, in content-hash order (`countPurgedPageFacts`
/// reads the ledger through this).
pub(crate) fn source_purges(
    read: &dyn KvRead,
    source_id: &str,
    op: &str,
) -> Result<Vec<(String, i64)>> {
    let rows = source_page_purges(read, source_id).map_err(|e| {
        StoreError::new(
            e.code,
            format!("{op}: corrupt page purge record: {}", e.message),
        )
    })?;
    Ok(rows
        .into_iter()
        .map(|(_, r)| (r.slug, r.purged_at_us))
        .collect())
}

/// Writes one row. Only the unit tests of the readers call it; the store-side writer is
/// [`Store::record_page_purge`].
#[cfg(test)]
pub(crate) fn put_purge(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
    content_hash: &str,
    slug: &str,
    purged_at_us: i64,
) -> Result<()> {
    put_json(
        tx,
        &row_key(source_id, content_hash),
        &PagePurgeRecord {
            slug: slug.to_string(),
            request_id: None,
            purged_at_us,
        },
    )
}

impl Store {
    /// `INSERT INTO page_purges(source_id, content_hash, slug, request_id) ... ON CONFLICT
    /// (source_id, content_hash) DO UPDATE SET slug, request_id, purged_at = now()` for each hash:
    /// records the purge of a page's content under every hash it was saved with. A source the store
    /// does not hold is refused, as the foreign key refuses it.
    pub fn record_page_purge(
        &self,
        source_id: &str,
        content_hashes: &[String],
        slug: &str,
        request_id: Option<&str>,
    ) -> Result<()> {
        const OP: &str = "recordPagePurge";
        let mut texts: Vec<(&str, &str)> = vec![("sourceId", source_id), ("slug", slug)];
        texts.extend(content_hashes.iter().map(|h| ("contentHashes", h.as_str())));
        if let Some(request) = request_id {
            texts.push(("requestId", request));
        }
        no_nul(OP, &texts)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            require_source(&*tx, source_id)?;
            for hash in content_hashes {
                let row = PagePurgeRecord {
                    slug: slug.to_owned(),
                    request_id: request_id.map(str::to_owned),
                    purged_at_us: now,
                };
                put_json(tx, &row_key(source_id, hash), &row)?;
            }
            Ok(())
        })
    }

    /// `listRecentPurgeRequests(days, cap)` over the page ledger: the distinct request ids of the
    /// purges newer than `days` days (`purged_at > now() - make_interval(days => $1)`), up to `cap`.
    /// The statement has no `ORDER BY`; ids come in byte order. The fact purge ledger
    /// (`fact_purges`, `facts::purge_ledger`) adds its ids too; the take purge ledger (`take_purges`)
    /// has no store rows, so it adds nothing.
    pub fn list_recent_purge_requests(&self, days: i64, cap: i64) -> Result<Vec<String>> {
        let since = self
            .env
            .now_micros()
            .saturating_sub(days.saturating_mul(DAY_US));
        let read = self.read()?;
        let mut requests: BTreeSet<String> = BTreeSet::new();
        let mut failure = None;
        scan_prefix(&*read, &[keys::FACT, ROW], false, &mut |_, v| {
            match serde_json::from_slice::<PagePurgeRecord>(v) {
                Ok(r) => {
                    if let (Some(request), true) = (r.request_id, r.purged_at_us > since) {
                        requests.insert(request);
                    }
                }
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        super::purge_ledger::recent_request_ids(&*read, since, &mut requests)?;
        Ok(requests
            .into_iter()
            .take(usize::try_from(cap.max(0)).unwrap_or(usize::MAX))
            .collect())
    }
}
