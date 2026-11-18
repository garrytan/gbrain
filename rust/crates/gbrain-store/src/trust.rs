//! Trust: trust tiers and write provenance of pages, the write gate, trust review, fact withdrawal
//! and the belief ledger.
//!
//! Built: [`stamp`] (the trust-tier trigger rules as one pure function, for the writers of pages,
//! facts, takes and timeline entries to call). Everything else still reaches its tables through
//! `executeRaw`, which the Rust engine refuses. See rust/docs/store/trust.md.
//!
//! Keys: every record of this family starts with `keys::TRUST` (`t`). The bytes after the tag are
//! this file's to define; document them here.
//!
//! Open to build now; see docs/designs/RUST_ENGINE_INTERFACES.md ("trust").

// Crate-only until the writers of pages and facts call `stamp`; the interfaces session wires
// those calls. The allows go when the first caller lands.
#[allow(dead_code)]
mod stamp;

#[allow(unused_imports)]
pub(crate) use stamp::{
    OWNER_TIER_FLOOR, OriginStamp, StampRow, Stamped, TRUST_EPHEMERAL_FRONTMATTER_KEYS,
    TRUST_RAISE_REFUSED, TrustTable, TrustTier, WriteTrust, page_frontmatter_content,
    snapshot_version, stamp,
};

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
