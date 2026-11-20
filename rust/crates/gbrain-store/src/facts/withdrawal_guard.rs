//! The facts update guard `gbrain_preserve_fact_withdrawal` (src/core/facts/withdrawal-schema.ts) for the
//! repair writes that set a column it watches (`entity_slug`, `expired_at`): a row saved active that a
//! withdrawal of its claim reaches comes back expired at the earliest such withdrawal.
//!
//! The trigger runs `BEFORE INSERT OR UPDATE OF fact, source_id, visibility, entity_slug, expired_at`
//! and, only when the new row has no `expired_at`, takes the earliest `withdrawn_at` of the withdrawals
//! of the row's source and visibility whose fingerprint is the claim's (current or v1) and whose subject
//! reaches the row: a row on a member page (`memory/members/...`) is reached only by that page's own
//! withdrawals, any other row by subject `*`, its entity, or, on an unbacked name key, any subject but an
//! owned memory page. It then sets `expired_at` to that time and clamps `valid_until` to it.
//!
//! Only the members that run the guarded `UPDATE`s call this ([`super::captured`], `ontology_repair`); the
//! other fact writers still skip it (rust/docs/store/facts.md, "Not modeled").

use super::purge::{owned_memory_subject, unbacked};
use super::{FactRecord, MEMBER_PAGE_PREFIX};
use crate::error::Result;
use crate::kv::KvRead;
use crate::trust::fingerprint::{fact_fingerprint, fact_fingerprint_v1};
use crate::trust::withdrawals::withdrawals_at;

/// The earliest withdrawal that reaches `row`, as the guard's `SELECT min(withdrawn_at)` finds it.
fn reaching_withdrawal(read: &dyn KvRead, row: &FactRecord) -> Result<Option<i64>> {
    let member_page = row
        .source_markdown_slug
        .as_deref()
        .filter(|slug| slug.starts_with(MEMBER_PAGE_PREFIX));
    let unbacked = member_page.is_none() && unbacked(read, row)?;
    let hashes = [fact_fingerprint(&row.fact), fact_fingerprint_v1(&row.fact)];
    let mut earliest: Option<i64> = None;
    for (subject, hash, at) in withdrawals_at(read, &row.source_id, &row.visibility)? {
        if !hashes.contains(&hash) {
            continue;
        }
        let reaches = match member_page {
            Some(page) => subject == page,
            None => {
                subject == "*"
                    || row.entity_slug.as_deref() == Some(subject.as_str())
                    || (unbacked && !owned_memory_subject(&subject))
            }
        };
        if reaches {
            earliest = Some(earliest.map_or(at, |e| e.min(at)));
        }
    }
    Ok(earliest)
}

/// Applies the guard to `row`, the row about to be saved: a no-op for an expired row.
pub(crate) fn preserve_withdrawal(read: &dyn KvRead, row: &mut FactRecord) -> Result<()> {
    if row.expired_at_us.is_some() {
        return Ok(());
    }
    if let Some(withdrawn) = reaching_withdrawal(read, row)? {
        row.expired_at_us = Some(withdrawn);
        row.valid_until_us = Some(row.valid_until_us.map_or(withdrawn, |u| u.min(withdrawn)));
    }
    Ok(())
}
