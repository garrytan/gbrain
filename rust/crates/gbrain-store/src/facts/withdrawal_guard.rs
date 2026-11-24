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
//! `write_fact` runs the same guard on every insert and on an update that changes a watched column (`facts.rs`
//! `preserve_withdrawal`). Every update member whose `UPDATE` sets a watched column on a row it can leave active calls it
//! before `write_fact`: `rehomeEntityFacts` ([`super::captured`]), `restoreOntologyFact`, `placeRelinkedFact`,
//! `linkConversationFact`, `restoreSupersededFact`, `restoreFactPreimage`, `migrateFactsToCanonical` and
//! `adoptFactIntoFence` ([`super::write_path`]). The
//! other update members the store serves set no watched column, or set `expired_at` to a time, so the guard has
//! nothing to do.

use super::FactRecord;
use super::purge::earliest_withdrawal;
use crate::error::Result;
use crate::kv::KvRead;

/// Applies the guard to `row`, the row about to be saved: a no-op for an expired row. The reach of a withdrawal is
/// [`earliest_withdrawal`], the one the `write_fact` guard uses.
pub(crate) fn preserve_withdrawal(read: &dyn KvRead, row: &mut FactRecord) -> Result<()> {
    if row.expired_at_us.is_some() {
        return Ok(());
    }
    if let Some(withdrawn) = earliest_withdrawal(read, row)? {
        row.expired_at_us = Some(withdrawn);
        row.valid_until_us = Some(row.valid_until_us.map_or(withdrawn, |u| u.min(withdrawn)));
    }
    Ok(())
}
