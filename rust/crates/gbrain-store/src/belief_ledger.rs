//! The belief ledger's page lifetimes and the orphan read over them (`orphanLifetimes`,
//! `src/core/engine-sql/collate-belief-reads.ts`). PGLite and Postgres run the SQL over
//! `belief_page_lifetimes`; this answers the same question from the store's lifetime records.
//! What it answers: rust/docs/store/collate-belief-reads.md.
//!
//! Only the read is served. Nothing in a shipped brain writes a lifetime yet (the ledger's writes
//! are `executeRaw` on the SQL engines), so the family is empty unless the parity suite's
//! test-only seed fills it (`test_seeds.rs`).
//!
//! A removed source keeps its lifetimes, as the SQL table (no foreign key) does; the read joins the
//! source's current incarnation, so they answer nothing once the source is gone or recreated.
//!
//! Keys (under `keys::FACT`, `F`, with a sub-tag the facts records do not use; a text part ends
//! with a NUL byte, and no text column may hold one):
//! - `F 0x20 <source> 0x00 <slug> 0x00 <page lifetime uuid>` -> `LifetimeRecord` (JSON). A scan of
//!   one source meets its lifetimes in slug byte order, and one slug's in uuid text order.

use crate::error::Result;
use crate::kv::scan_prefix;
use crate::links::no_nul;
use crate::pages::read_page;
use crate::sources::read_source;
use crate::{Store, keys};
use serde::{Deserialize, Serialize};

/// The byte after `keys::FACT` that marks a belief page lifetime.
const LIFETIME: u8 = 0x20;

/// One `belief_page_lifetimes` row. `page_id` is the hint the SQL column keeps.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LifetimeRecord {
    pub page_lifetime: String,
    pub source_id: String,
    pub source_incarnation: String,
    pub slug: String,
    pub page_id: Option<u64>,
    pub started_at_us: i64,
    pub ended_at_us: Option<i64>,
}

/// One orphan finding (`reason` is `no_page`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrphanLifetime {
    pub slug: String,
    pub page_lifetime: String,
    pub reason: String,
}

/// The orphan lifetimes of a source: the total and the first `limit` by byte order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrphanLifetimes {
    pub total: usize,
    pub rows: Vec<OrphanLifetime>,
}

fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut key = vec![keys::FACT, LIFETIME];
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key
}

#[cfg_attr(not(feature = "test-seeds"), allow(dead_code))]
pub(crate) fn lifetime_key(source_id: &str, slug: &str, page_lifetime: &str) -> Vec<u8> {
    let mut key = source_prefix(source_id);
    key.extend_from_slice(slug.as_bytes());
    key.push(0);
    key.extend_from_slice(page_lifetime.as_bytes());
    key
}

impl Store {
    /// `listOrphanLifetimes(sourceId, limit)`: the open lifetimes of the source's current
    /// incarnation whose slug has no page row (a soft-deleted page is a row), ordered by slug and
    /// lifetime bytes, at most `max(1, limit)` of them, with the count of all of them.
    pub fn list_orphan_lifetimes(&self, source_id: &str, limit: usize) -> Result<OrphanLifetimes> {
        no_nul("listOrphanLifetimes", &[("sourceId", source_id)])?;
        let read = self.read()?;
        let Some(source) = read_source(&*read, source_id)? else {
            return Ok(OrphanLifetimes {
                total: 0,
                rows: Vec::new(),
            });
        };
        let mut found = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &source_prefix(source_id), false, &mut |_, v| {
            match serde_json::from_slice::<LifetimeRecord>(v) {
                Ok(l) if l.ended_at_us.is_none() && l.source_incarnation == source.incarnation => {
                    found.push(l);
                }
                Ok(_) => {}
                Err(e) => {
                    failure = Some(e);
                    return false;
                }
            }
            true
        })?;
        if let Some(e) = failure {
            return Err(e.into());
        }
        let mut orphans = Vec::new();
        for l in found {
            if read_page(&*read, source_id, &l.slug)?.is_none() {
                orphans.push(OrphanLifetime {
                    slug: l.slug,
                    page_lifetime: l.page_lifetime,
                    reason: "no_page".into(),
                });
            }
        }
        orphans.sort_by(|a, b| {
            (a.slug.as_bytes(), a.page_lifetime.as_bytes())
                .cmp(&(b.slug.as_bytes(), b.page_lifetime.as_bytes()))
        });
        let total = orphans.len();
        orphans.truncate(limit.max(1));
        Ok(OrphanLifetimes {
            total,
            rows: orphans,
        })
    }
}
