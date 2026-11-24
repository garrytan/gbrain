//! `page_label_guards`: the tier an owner label write set on a page (GST-2521), one record per page.
//!
//! Key: `t 0x0e page_id` (8-byte big-endian) -> `{"tier", "set_at_us"}`. A hard page delete removes it
//! (`ON DELETE CASCADE`, [`remove_page_rows`]). Written by `writePageLabelGuard` (`crate::label_door`); the guard's
//! readers (`labelGuardTier`, the deletion and graduation inventories) still read it through `executeRaw`.

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::keys;
use crate::kv::{KvRead, KvWrite};
use crate::pages::PageRecord;
use crate::trust::TrustTier;
use crate::{get_json, put_json};

// `t 0x0a` holds the belief ledger's page lifetimes (`belief_lifetimes`) and `t 0x0d` is kept for a page tier index.
const LABEL_GUARD: u8 = 0x0e;

/// One `page_label_guards` row.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LabelGuardRecord {
    pub tier: String,
    pub set_at_us: i64,
}

fn key(page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::TRUST, LABEL_GUARD];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// The page's label guard, if any.
pub fn read(read: &dyn KvRead, page_id: u64) -> Result<Option<LabelGuardRecord>> {
    get_json(read, &key(page_id))
}

/// `INSERT ... ON CONFLICT (page_id) DO UPDATE SET tier = EXCLUDED.tier, set_at = now()`.
pub(crate) fn put(tx: &mut dyn KvWrite, page_id: u64, tier: TrustTier, now_us: i64) -> Result<()> {
    put_json(
        tx,
        &key(page_id),
        &LabelGuardRecord {
            tier: tier.as_str().to_string(),
            set_at_us: now_us,
        },
    )
}

/// `DELETE FROM page_label_guards WHERE page_id = $1`.
pub(crate) fn remove(tx: &mut dyn KvWrite, page_id: u64) -> Result<()> {
    tx.delete(&key(page_id))
}

/// `ON DELETE CASCADE` from `pages` (`cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    remove(tx, page.id)
}
