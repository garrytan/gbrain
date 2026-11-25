//! Lock skips that stay safe when explicit transactions run optimistically (multi-user mode,
//! interface I-1; docs/designs/rust-engine/multi-user-server.md, "Appendix: skip guarantees under
//! multi-user mode").
//!
//! A store fn that skips a lock a SQL engine takes calls [`crate::Store::assert_serialized_transactions`].
//! With multi-user mode off the store's explicit transactions hold the writer, so every skip passes.
//! With it on, a skip passes only when its site is listed here with the guarantee that replaces
//! the lock and the test that proves it under `GBRAIN_RUST_MULTIUSER=1`; every other site refuses
//! `engine_capability_missing`. `test/serialized-transactions-guard.test.ts` checks each row names a
//! marked site and an existing test.

/// What replaces the skipped lock once explicit transactions run optimistically.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Guarantee {
    /// Every key the transaction read through its handle is validated at commit (`occ_kv.rs`): a
    /// read that changed refuses the commit with `write_conflict` and the callback runs again.
    ReadSet,
    /// A revision compare inside the transaction (a read of the row, so validated at commit).
    Cas,
    /// The keys are held in the brain's single-flight table until commit or rollback.
    SingleFlight,
    /// Commutative counter operations with their admission check re-evaluated at commit.
    Counter,
}

/// One proven site: its id (the `assert_serialized_transactions` argument), the guarantee and the
/// test that proves it with multi-user mode on.
#[derive(Debug, Clone, Copy)]
pub struct Proven {
    pub site: &'static str,
    pub guarantee: Guarantee,
    pub test: &'static str,
}

/// The Rust-side sites proven under multi-user mode.
pub const MULTIUSER_PROVEN: &[Proven] = &[];

/// The proven row of `site`, if any.
pub fn proven(site: &str) -> Option<&'static Proven> {
    MULTIUSER_PROVEN.iter().find(|p| p.site == site)
}
