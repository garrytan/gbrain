//! Format 5 to 6: the records the v0.60.766.0 Rust addon's shadow seed wrote in shapes this build
//! keeps differently, carried over to this build's shapes when such a brain opens
//! (`upgrade_format` in lib.rs). That addon and this build both wrote format 5, so the number alone
//! cannot tell its records apart; format 6 marks a brain whose records are this build's.
//!
//! Each step gives the records this build's own seed writes for the same source rows, so every
//! read answers as it would on a store this build seeded (`v0_60_766_tests.rs` checks it on a
//! store that addon wrote):
//! - page purge tombstones: `F 0x0C source \0 hash` gets this build's trailing NUL
//!   (`facts/page_purges.rs`); the value is the same JSON.
//! - derived generations: the inline ledger at `F 0x0E id` (the row with its items) moves to the
//!   `h` ledger through the seed's own writers (`generations::seed_generation`, `seed_item`).
//! - oauth clients: a record without `created_at` gets the epoch and the column defaults, as
//!   `jobs::seed_client` writes a client (`jobs/oauth_clients.rs`).
//!
//! A record a step cannot carry is refused: the caller turns the error into
//! `shadow_reseed_required`, and the transaction is dropped, so nothing changes.

use crate::error::{Result, StoreError};
use crate::generations::{SeedGeneration, seed_generation, seed_item};
use crate::keys;
use crate::kv::{KvWrite, collect_prefix};
use serde::Deserialize;
use serde_json::Value;

/// The v0.60.766.0 page purge ledger's sub-tag under `keys::FACT`.
const PAGE_PURGE: u8 = 0x0C;
/// The v0.60.766.0 inline generation ledger's sub-tag under `keys::FACT`.
const GENERATION: u8 = 0x0E;

/// Carries every v0.60.766.0 record over to this build's shape. A brain this build wrote has none,
/// so for it the step changes nothing.
pub(crate) fn carry_over(tx: &mut dyn KvWrite) -> Result<()> {
    page_purges(tx)?;
    generations(tx)?;
    crate::jobs::carry_over_format_5_clients(tx)
}

/// `F 0x0C source \0 hash` (one NUL) becomes `F 0x0C source \0 hash \0`. Neither part may hold a
/// NUL, so a key with one NUL after the prefix is the old shape and one with two is this build's.
fn page_purges(tx: &mut dyn KvWrite) -> Result<()> {
    let prefix = [keys::FACT, PAGE_PURGE];
    for (key, value) in collect_prefix(&*tx, &prefix, false, usize::MAX)? {
        if key[prefix.len()..].iter().filter(|b| **b == 0).count() != 1 {
            continue;
        }
        let mut new_key = key.clone();
        new_key.push(0);
        if tx.get(&new_key)?.is_some() {
            return Err(StoreError::invalid(format!(
                "page purge tombstone {} is stored in both the old and the new shape",
                String::from_utf8_lossy(&key[prefix.len()..]).escape_debug()
            )));
        }
        tx.delete(&key)?;
        tx.put(&new_key, &value)?;
    }
    Ok(())
}

/// One generation of the v0.60.766.0 inline ledger (its `GenerationRecord`).
#[derive(Deserialize)]
struct OldGeneration {
    source_id: String,
    kind: String,
    owner_key: String,
    generation: i32,
    state: String,
    created_at_us: i64,
    items: Vec<OldItem>,
}

#[derive(Deserialize)]
struct OldItem {
    item_key: String,
    action: String,
    #[serde(default)]
    preimage: Option<Value>,
}

/// Every `F 0x0E id` generation is stored again through the seed's writers, then deleted.
fn generations(tx: &mut dyn KvWrite) -> Result<()> {
    let prefix = [keys::FACT, GENERATION];
    for (key, value) in collect_prefix(&*tx, &prefix, false, usize::MAX)? {
        let id = key
            .get(prefix.len()..)
            .and_then(|b| <[u8; 8]>::try_from(b).ok())
            .map(u64::from_be_bytes)
            .ok_or_else(|| StoreError::invalid("a derived generation key is not 8 bytes"))?;
        let old: OldGeneration = serde_json::from_slice(&value)
            .map_err(|e| StoreError::invalid(format!("derived generation {id}: {e}")))?;
        let seed = SeedGeneration {
            source_id: old.source_id,
            kind: old.kind,
            owner_key: old.owner_key,
            generation: old.generation,
            state: old.state,
            created_at_us: old.created_at_us,
        };
        // A disk or storage failure is not about this record: it keeps its own code.
        let refuse = |e: StoreError| {
            if e.is_storage_failure() {
                e
            } else {
                StoreError::invalid(format!("derived generation {id}: {}", e.message))
            }
        };
        if !seed_generation(tx, id, &seed).map_err(refuse)? {
            return Err(StoreError::invalid(format!(
                "derived generation {id} is stored in both the old and the new ledger"
            )));
        }
        for item in old.items {
            seed_item(tx, id, &item.item_key, &item.action, item.preimage).map_err(refuse)?;
        }
        tx.delete(&key)?;
    }
    Ok(())
}
