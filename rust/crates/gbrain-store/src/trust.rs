//! Trust: trust tiers and write provenance of pages, the write gate, trust review, fact withdrawal
//! and the belief ledger.
//!
//! Built: [`stamp`] (the trust-tier trigger rules as one pure function, for the writers of pages,
//! facts, takes and timeline entries to call), [`withdrawals`] (the `fact_withdrawals` ledger),
//! [`write_gate`] (the write gate's `write_gate_receipts` and `write_gate_holds`) and [`proposals`]
//! (the `trust_proposals` decision queue).
//! Everything else still reaches its tables through `executeRaw`, which the Rust engine refuses.
//! See rust/docs/store/trust.md.
//!
//! Keys: every record of this family starts with `keys::TRUST` (`t`); the next byte names the
//! record kind.
//! - `t 0x01 source \0 visibility \0 subject \0 fact_hash` -> `{"withdrawn_at_us"}`: a fact
//!   withdrawal ([`withdrawals`]).
//! - `t 0x02 id` -> a write gate receipt; `t 0x03 target_table \0 target_id \0 content_hash \0
//!   detector_version` -> its id ([`write_gate`]).
//! - `t 0x04 id` -> a write gate hold; `t 0x05 source \0 slug \0 fingerprint \0
//!   detector_version` -> its id ([`write_gate`]).
//! - `t 0x06 id` -> a trust proposal; `t 0x07 action \0 target_table \0 target_id \0
//!   related_table \0 related_id` -> the id of the pending one; `t 0x08 table \0 row_id
//!   proposal_id` -> empty, a proposal that names the row ([`proposals`]).
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md ("trust").

// Crate-only. The facts writer (`facts::write_fact`) calls `stamp`; the pages, takes and timeline
// writers do not yet, so their parts of the module are still unused.
#[allow(dead_code)]
mod stamp;

mod fingerprint;
pub mod proposals;
pub mod withdrawals;
pub mod write_gate;

#[allow(unused_imports)] // the page parts wait for the pages writer
pub(crate) use stamp::{
    OWNER_TIER_FLOOR, OriginStamp, StampRow, Stamped, TRUST_EPHEMERAL_FRONTMATTER_KEYS,
    TRUST_RAISE_REFUSED, TrustTable, TrustTier, WriteTrust, page_frontmatter_content,
    snapshot_version, stamp,
};

/// Removes the family's rows of a deleted source (`cascade::remove_source_rows`).
pub(crate) fn remove_source_rows(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
) -> crate::Result<()> {
    withdrawals::remove_source_rows(tx, source_id)?;
    proposals::remove_source_rows(tx, source_id)
}

/// Adds this family's `getPage` columns to a page (`page_columns::add_page_columns`), such as the
/// page's `trust_tier`. Adds none yet, so a page read is unchanged. Full paths keep this stub clear
/// of the imports this file will add.
pub(crate) fn page_columns(
    _read: &dyn crate::kv::KvRead,
    _page: &crate::pages::PageRecord,
    _columns: &mut crate::page_columns::PageColumns,
) -> crate::Result<()> {
    Ok(())
}
