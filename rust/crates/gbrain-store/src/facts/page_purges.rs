//! The page purge ledger: the `page_purges` table (src/core/facts/purge-schema.ts).
//!
//! A tombstone says "a page with this content hash was purged from this source under this slug".
//! It lives at `F 0x0C source \0 content_hash` with the JSON value
//! `{"slug": <text>, "request_id": <uuid text or null>, "purged_at_us": <i64>}`; the key is the
//! table's primary key `(source_id, content_hash)`.
//!
//! The store reads the ledger (`countPurgedPageFacts`, facts/repair.rs). No member writes it: the
//! page purge sweep (`persistence/page-purge.ts`) and the restore replay (`belief/purge-mirror.ts`)
//! write it with raw SQL inside the write journal's transaction, so on Rust they stop on the typed
//! `raw_sql` refusal and the ledger stays empty. A writer that binds here must also add `F 0x0C` to
//! the source cascade (`ON DELETE CASCADE` from `sources`) and give `putPage` the `purged_content`
//! guard the pages trigger raises on Postgres.

use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, scan_prefix};
use serde::{Deserialize, Serialize};

/// The byte after `keys::FACT` that marks a page purge tombstone.
const PURGE: u8 = 0x0C;

/// What is stored for a tombstone.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PurgeRecord {
    slug: String,
    request_id: Option<String>,
    purged_at_us: i64,
}

/// `F 0x0C source \0`: every tombstone of a source.
fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut prefix = keys::text(keys::FACT, &[source_id, ""]);
    prefix.insert(1, PURGE);
    prefix
}

/// The `(slug, purged_at_us)` of every tombstone of a source, in content-hash order.
pub(crate) fn source_purges(
    read: &dyn KvRead,
    source_id: &str,
    op: &str,
) -> Result<Vec<(String, i64)>> {
    let mut rows = Vec::new();
    let mut failed = None;
    scan_prefix(read, &source_prefix(source_id), false, &mut |_, v| {
        match serde_json::from_slice::<PurgeRecord>(v) {
            Ok(r) => rows.push((r.slug, r.purged_at_us)),
            Err(e) => {
                failed = Some(e);
                return false;
            }
        }
        true
    })?;
    match failed {
        Some(e) => Err(StoreError::invalid(format!(
            "{op}: corrupt page purge record: {e}"
        ))),
        None => Ok(rows),
    }
}

/// The shadow seed (`seed.rs`): stores a tombstone copied from another engine, with its request id and time. `false`
/// when the tombstone is already stored.
pub(crate) fn seed_purge(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
    content_hash: &str,
    record: (&str, Option<&str>, i64),
) -> Result<bool> {
    let (slug, request_id, purged_at_us) = record;
    crate::links::no_nul(
        "seed page_purges",
        &[
            ("source_id", source_id),
            ("content_hash", content_hash),
            ("slug", slug),
        ],
    )?;
    let mut key = keys::text(keys::FACT, &[source_id, content_hash]);
    key.insert(1, PURGE);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    crate::put_json(
        tx,
        &key,
        &PurgeRecord {
            slug: slug.to_string(),
            request_id: request_id.map(str::to_string),
            purged_at_us,
        },
    )?;
    Ok(true)
}

/// Writes one tombstone. Only the unit tests call it: no member binds a writer yet (module doc).
#[cfg(test)]
pub(crate) fn put_purge(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
    content_hash: &str,
    slug: &str,
    purged_at_us: i64,
) -> Result<()> {
    let mut key = keys::text(keys::FACT, &[source_id, content_hash]);
    key.insert(1, PURGE);
    crate::put_json(
        tx,
        &key,
        &PurgeRecord {
            slug: slug.to_string(),
            request_id: None,
            purged_at_us,
        },
    )
}

/// The shadow follow (`seed/follow.rs`): removes the tombstone of `content_hash` in `source_id`.
/// `false` when there is none.
pub(crate) fn remove_purge(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
    content_hash: &str,
) -> Result<bool> {
    if source_id.contains('\0') || content_hash.contains('\0') {
        return Ok(false);
    }
    let mut key = keys::text(keys::FACT, &[source_id, content_hash]);
    key.insert(1, PURGE);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}
