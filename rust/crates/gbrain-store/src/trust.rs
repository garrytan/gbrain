//! Trust: trust tiers and write provenance of pages, the write gate, trust review, fact withdrawal
//! and the belief ledger.
//!
//! Built: [`stamp`] (the trust-tier trigger rules as one pure function, for the writers of pages,
//! facts, takes and timeline entries to call), [`withdrawals`] (the `fact_withdrawals` ledger),
//! [`write_gate`] (the write gate's `write_gate_receipts` and `write_gate_holds`), [`proposals`]
//! (the `trust_proposals` decision queue) and [`tier_reads`] (the typed reads of stamped tiers that
//! core memory, the trust scan and page history made through `executeRaw`; no key of their own).
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
//! A page's trust tier and write origin have no key of their own: they are fields of the page
//! record (`pages::PageRecord`, stamped by `pages::write_page`) and of each version record (copied
//! by `pages::snapshot_in`). No read looks a page up by its tier, so no tier index exists; a later
//! one takes `t 0x09`. The design sketch's `t 0x04` and `t 0x05` page keys were not built, and
//! those bytes hold the write gate.
//!
//! See docs/designs/RUST_ENGINE_INTERFACES.md ("trust").

// Crate-only. The facts writer (`facts::write_fact`), the pages writer (`pages::write_page`,
// `pages::snapshot_in`) and the takes and timeline writers (through `row_trust::stamp_row`) call it.
// The rest of the TS contract it mirrors (`content_columns`, the exported constants) is read only
// by its tests.
#[allow(dead_code)]
mod stamp;

mod eligibility;
pub(crate) mod fingerprint;
pub(crate) use fingerprint::fact_fingerprint_v1;
pub mod held_rows;
pub mod proposals;
mod row_trust;
pub mod tier_reads;
pub mod valid_time;
pub mod withdrawal_commit;
pub mod withdrawals;
pub mod write_gate;

pub(crate) use eligibility::TrustPolicy;
pub(crate) use row_trust::{RowTrust, stamp_row};
pub(crate) use write_gate::activation_suppressed;

pub(crate) use stamp::{
    OriginStamp, StampRow, TrustTable, TrustTier, WriteTrust, page_frontmatter_content,
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

/// Adds this family's `getPage` columns to a page (`page_columns::add_page_columns`). Adds none:
/// PGLite's `getPage` (`rowToPage`) maps no trust column, and the page's stamped tier and origin
/// are read through `readPageTrustRows` (`cli_reads::import`). Full paths keep this stub clear of
/// imports.
pub(crate) fn page_columns(
    _read: &dyn crate::kv::KvRead,
    _page: &crate::pages::PageRecord,
    _columns: &mut crate::page_columns::PageColumns,
) -> crate::Result<()> {
    Ok(())
}
