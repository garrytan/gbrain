//! The legacy word postings (`keys::POSTING`, `T term \0 page_id chunk_index`), deleted by the store
//! format 14 upgrade.
//!
//! Through store format 8 every chunk write kept one record per distinct word of the chunk, for a
//! BM25 `searchKeyword` that production search never called (the live keyword index, `keyword/`,
//! serves every keyword member). Format 14 writes none and [`delete_all`] removes them in the
//! upgrade's one write transaction, so a failed upgrade leaves every one in place.

use crate::error::Result;
use crate::keys;
use crate::kv::KvWrite;

/// The store format that dropped the legacy word postings: the upgrade deletes them only for a
/// brain older than this, so a later format's upgrade never runs the delete again. It equals
/// `FORMAT_VERSION` on this branch; a renumber at merge changes both.
pub(crate) const DROPPED_AT_FORMAT: u32 = 14;

/// Keys read per step of [`delete_all`].
const BATCH: usize = if cfg!(test) { 7 } else { 10_000 };

/// Deletes every legacy word posting, reading the keys a batch at a time so this step holds at
/// most one batch of keys; the transaction's own write set still holds every delete until it
/// commits (the upgrade is one transaction, so a failure leaves every posting).
pub(crate) fn delete_all(tx: &mut dyn KvWrite) -> Result<()> {
    let Some(end) = crate::kv::prefix_end(&[keys::POSTING]) else {
        return Ok(());
    };
    let mut from = vec![keys::POSTING];
    loop {
        let mut batch: Vec<Vec<u8>> = Vec::with_capacity(BATCH);
        tx.scan(&from, &end, false, &mut |key, _| {
            batch.push(key.to_vec());
            batch.len() < BATCH
        })?;
        for key in &batch {
            tx.delete(key)?;
        }
        let full = batch.len() == BATCH;
        match batch.pop() {
            Some(mut last) if full => {
                last.push(0);
                from = last;
            }
            _ => return Ok(()),
        }
    }
}

#[cfg(test)]
mod tests;
