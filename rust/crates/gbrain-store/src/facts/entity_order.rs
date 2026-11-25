//! Per-entity fact order (conformance C10 and C11; design note `docs/designs/rust-engine/multi-user-server.md`,
//! "M3: writers on many machines", row "Fact order per entity").
//!
//! The SQL engines list the facts of one entity by `created_at, id`, which is not the order the writers committed in
//! once several writers run at once. On a store opened in multi-user mode (`Store::multiuser()`) every new fact row
//! that names an entity (`entity_slug` not NULL) also gets the next number of that entity's sequence, taken inside
//! the same write transaction that stores the row. The number is the entity's commit order.
//!
//! How the order is made true: the stamp reads the entity's counter and writes it back (a plain `get` and `put`, not
//! `allocate`, which is built to never conflict). On the concurrent store (`occ_kv`) that read is in the
//! transaction's read set, so two appends to one entity cannot both commit from the same snapshot: the second loses
//! with `write_conflict` and `Store::write` runs it again from a fresh snapshot, where it reads the first one's number
//! and takes the next. So the counter order equals the commit order, with no gap and no duplicate. On the
//! single-writer store the writer is held from the read to the commit, which gives the same result. Appends to
//! different entities touch different keys and never conflict. No lock, no process-wide mutex, no busy error.
//!
//! Keys, all under the lease family `~L` and the sub-tag `leases::ENTITY_FACT_SEQUENCE` (`0x03`); `source` and
//! `entity` are the NUL-free text columns, each followed by a NUL byte; `seq` is 8 big-endian bytes:
//! - `~L 03 01 source 00 entity -> seq`: the last number given to the entity (the counter).
//! - `~L 03 02 source 00 entity 00 seq -> fact id`: the side index, in sequence order.
//!
//! Nothing writes under `~L 03` while the mode is off, so an off store keeps every byte. Existing fact reads do not
//! use these keys and keep their order and output on and off; the new read
//! ([`Store::list_entity_facts_in_commit_order`]) is not wired to any CLI, MCP or JSON output.
//!
//! What stays consistent, and what does not:
//! - A fact row that is rolled back takes its number back with it (the counter and the index are written in the
//!   same transaction as the row).
//! - A row that is deleted later (`delete_fact`, `remove_fact`) or that moves to another entity leaves its index entry
//!   behind. The reader skips an entry whose fact no longer exists or no longer belongs to that source and entity, so
//!   the order of the remaining facts is unchanged; the sequence of an entity may therefore show gaps after a delete.
//!   The numbers are never reused. A delete path does not know the mode, so it stays free of an extra read.
//! - Rows that copy another engine's rows with their own ids (the shadow seed and follow) are not stamped: they were
//!   committed elsewhere and carry no order here. Updates of an existing row never take a number.

use crate::error::{Result, STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, prefix_end};
use crate::leases::ENTITY_FACT_SEQUENCE;
use crate::{Store, keys};

use super::{FactRecord, read_fact};

/// Sub-kinds under `~L 03`. Never reuse, reorder or repurpose one.
const COUNTER: u8 = 0x01;
const INDEX: u8 = 0x02;

/// One fact of an entity in commit order: the number it was given and its row id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EntityFactPosition {
    pub sequence: u64,
    pub fact_id: u64,
}

fn entity_key(kind: u8, source_id: &str, entity_slug: &str) -> Vec<u8> {
    let mut key = keys::LEASES.to_vec();
    key.push(ENTITY_FACT_SEQUENCE);
    key.push(kind);
    key.extend_from_slice(source_id.as_bytes());
    key.push(0);
    key.extend_from_slice(entity_slug.as_bytes());
    key
}

fn counter_key(source_id: &str, entity_slug: &str) -> Vec<u8> {
    entity_key(COUNTER, source_id, entity_slug)
}

fn index_prefix(source_id: &str, entity_slug: &str) -> Vec<u8> {
    let mut key = entity_key(INDEX, source_id, entity_slug);
    key.push(0);
    key
}

fn index_key(source_id: &str, entity_slug: &str, sequence: u64) -> Vec<u8> {
    let mut key = index_prefix(source_id, entity_slug);
    key.extend_from_slice(&sequence.to_be_bytes());
    key
}

fn corrupt(what: &str) -> StoreError {
    StoreError::new(STORE_CORRUPT, format!("bad entity fact order {what}"))
}

/// Gives the new fact row `row` (id already assigned, row already written) the next number of its entity, in the
/// caller's write transaction, and returns it. A row without an entity gets none (`None`). The caller checks
/// `Store::multiuser()`; this function does not.
pub(crate) fn stamp_new_row(tx: &mut dyn KvWrite, row: &FactRecord) -> Result<Option<u64>> {
    let Some(entity) = row.entity_slug.as_deref() else {
        return Ok(None);
    };
    let counter = counter_key(&row.source_id, entity);
    // A plain read and write of one key: the read is in the transaction's read set.
    let last = match tx.get(&counter)? {
        Some(bytes) => keys::be8(&bytes).ok_or_else(|| corrupt("counter"))?,
        None => 0,
    };
    let next = last
        .checked_add(1)
        .ok_or_else(|| corrupt("counter overflow"))?;
    tx.put(&counter, &next.to_be_bytes())?;
    tx.put(
        &index_key(&row.source_id, entity, next),
        &row.id.to_be_bytes(),
    )?;
    Ok(Some(next))
}

/// The facts of `entity_slug` in `source_id` in commit order, from the number after `after_sequence` on (all of them
/// when `None`), at most `limit` of them. Entries whose fact is gone or moved to another entity are skipped.
fn read_entity_facts(
    read: &dyn KvRead,
    source_id: &str,
    entity_slug: &str,
    after_sequence: Option<u64>,
    limit: usize,
) -> Result<Vec<EntityFactPosition>> {
    let prefix = index_prefix(source_id, entity_slug);
    let Some(end) = prefix_end(&prefix) else {
        return Ok(Vec::new());
    };
    let start = match after_sequence {
        Some(after) => match after.checked_add(1) {
            Some(first) => index_key(source_id, entity_slug, first),
            None => return Ok(Vec::new()),
        },
        None => prefix,
    };
    let mut entries: Vec<(u64, u64)> = Vec::new();
    let mut bad = false;
    let mut page_start = start;
    // Walk in pages so that skipped entries do not end the walk early.
    loop {
        let mut page: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        let want = limit.saturating_sub(entries.len()).max(1) + 16;
        read.scan(&page_start, &end, false, &mut |k, v| {
            page.push((k.to_vec(), v.to_vec()));
            page.len() < want
        })?;
        let full = page.len() >= want;
        for (key, value) in &page {
            let (Some(sequence), Some(id)) = (
                key.get(key.len().saturating_sub(8)..).and_then(keys::be8),
                keys::be8(value),
            ) else {
                bad = true;
                break;
            };
            let live = read_fact(read, id)?.is_some_and(|f| {
                f.source_id == source_id && f.entity_slug.as_deref() == Some(entity_slug)
            });
            if live {
                entries.push((sequence, id));
                if entries.len() >= limit {
                    break;
                }
            }
        }
        if bad {
            return Err(corrupt("index entry"));
        }
        match page.last() {
            Some((last, _)) if full && entries.len() < limit => {
                page_start = last.clone();
                page_start.push(0);
            }
            _ => break,
        }
    }
    Ok(entries
        .into_iter()
        .map(|(sequence, fact_id)| EntityFactPosition { sequence, fact_id })
        .collect())
}

impl Store {
    /// The facts of one entity in commit order (conformance C10, C11): the order the writers committed them in, as
    /// given by the per-entity sequence a multi-user store stamps ([`stamp_new_row`]). Pass the last `sequence` of the
    /// previous page as `after_sequence` to continue. A store that is not in multi-user mode has no sequence and
    /// returns nothing. Not wired to any CLI, MCP or JSON output.
    pub fn list_entity_facts_in_commit_order(
        &self,
        source_id: &str,
        entity_slug: &str,
        after_sequence: Option<u64>,
        limit: usize,
    ) -> Result<Vec<EntityFactPosition>> {
        crate::links::no_nul(
            "listEntityFactsInCommitOrder",
            &[("sourceId", source_id), ("entitySlug", entity_slug)],
        )?;
        if !self.multiuser() || limit == 0 {
            return Ok(Vec::new());
        }
        read_entity_facts(
            &*self.read()?,
            source_id,
            entity_slug,
            after_sequence,
            limit,
        )
    }
}

#[cfg(test)]
#[path = "entity_order_tests.rs"]
mod tests;
