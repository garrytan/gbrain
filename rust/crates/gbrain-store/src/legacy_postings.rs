//! The legacy word postings (`keys::POSTING`, `T term \0 page_id chunk_index`), deleted by the store
//! format 13 upgrade.
//!
//! Through store format 8 every chunk write kept one record per distinct word of the chunk, for a
//! BM25 `searchKeyword` that production search never called (the live keyword index, `keyword/`,
//! serves every keyword member). Format 13 writes none and [`delete_all`] removes them in the
//! upgrade's one write transaction, so a failed upgrade leaves every one in place.

use crate::error::Result;
use crate::keys;
use crate::kv::{KvWrite, scan_prefix};

/// Deletes every legacy word posting.
pub(crate) fn delete_all(tx: &mut dyn KvWrite) -> Result<()> {
    let mut doomed = Vec::new();
    scan_prefix(&*tx, &[keys::POSTING], false, &mut |key, _| {
        doomed.push(key.to_vec());
        true
    })?;
    for key in doomed {
        tx.delete(&key)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
