//! Store errors. Every error carries a stable `code` string; the binding passes it to JavaScript
//! unchanged. The codes are listed in `rust/README.md`.

use std::fmt;

pub type Result<T> = std::result::Result<T, StoreError>;

/// Another process (or another handle in this process) owns the brain.
pub const STORE_LOCKED: &str = "store_locked";
/// `FORMAT` or the format record is not a version this build reads and writes.
pub const FORMAT_UNKNOWN: &str = "format_unknown";
/// The file system or the storage engine failed. The write that hit it did not commit.
pub const STORE_IO: &str = "store_io";
/// The records on disk do not pass the storage engine's own checks.
pub const STORE_CORRUPT: &str = "store_corrupt";
/// The handle was closed.
pub const STORE_CLOSED: &str = "store_closed";
/// A caller's argument is malformed (bad slug, bad revision text, wrong JSON shape).
pub const INVALID_ARGUMENT: &str = "invalid_argument";
/// The slug failed `validateSlug`.
pub const INVALID_SLUG: &str = "invalid_slug";
/// The named source does not exist.
pub const SOURCE_NOT_FOUND: &str = "source_not_found";
/// `expectedRevision` does not match the stored page.
pub const REVISION_CONFLICT: &str = "revision_conflict";
/// The caller gave no `expectedRevision` and the page already exists (`revision_required`).
pub const REVISION_REQUIRED: &str = "revision_required";
/// The named page does not exist (only where PGLite throws instead of returning null).
pub const PAGE_NOT_FOUND: &str = "page_not_found";
/// `readPageSnapshot` under `requireUnambiguous` found more than one readable page for the
/// identifier (PGLite's `PageSnapshotAmbiguousError`).
pub const PAGE_AMBIGUOUS: &str = "page_ambiguous";
/// The write breaks a table constraint that PGLite enforces (a CHECK list or a unique key). The
/// whole write rolls back.
pub const CONSTRAINT_VIOLATION: &str = "constraint_violation";
/// The write would make a page a second live page of its source recording one `source_path`.
/// The message is a JSON object: `source_id`, `source_path`, `holders` (the live pages that
/// record it, by slug) and `slug` (the page written). Nothing was written.
pub const ORIGIN_CLAIMED: &str = "origin_claimed";
/// The write replaces a non-empty page with an empty one and did not ask for it.
pub const EMPTY_OVERWRITE: &str = "empty_overwrite";
/// A request id was used for a different write.
pub const IDEMPOTENCY_CONFLICT: &str = "idempotency_conflict";
/// The journal refused to admit another write (too many outstanding).
pub const ADMISSION_REFUSED: &str = "admission_refused";
/// The brain has no persistence metadata row.
pub const WRITER_NOT_INITIALIZED: &str = "writer_not_initialized";
/// A local writer registration was revoked, or its lane or credential does not match.
pub const WRITER_REJECTED: &str = "writer_rejected";
/// The source was replaced (its incarnation changed) after the caller read it.
pub const SOURCE_CHANGED: &str = "source_changed";
/// A journal request is not in a state that allows the call.
pub const INVALID_STATE: &str = "invalid_state";
/// Internal: an optimistic write transaction read something another transaction changed before
/// it committed. `Store::write` runs the transaction again; callers do not see this code unless
/// a write keeps losing until its retry budget is spent.
pub const WRITE_CONFLICT: &str = "write_conflict";
/// The brain is a shadow store the v0.60.766.0 Rust addon wrote (store format 5) and holds a record this
/// build cannot carry over to its own shape (`seed/format_5.rs`); nothing was changed. The message names the
/// record and the re-seed steps.
pub const SHADOW_RESEED_REQUIRED: &str = "shadow_reseed_required";
/// A write inside a read-only transaction (Postgres SQLSTATE 25006, `read_only_sql_transaction`).
pub const READ_ONLY_TRANSACTION: &str = "read_only_transaction";
/// An input written in a form the store does not read the way Postgres does (a resolved date with
/// a zone it does not know). Nothing was written; the engine refuses the call by name.
pub const UNMODELED_INPUT: &str = "unmodeled_input";

/// A wait or a transaction passed its caller's deadline and nothing was committed. The message starts with the
/// reason and a colon (`transaction_deadline: ...`, `key_wait: ...`); the TypeScript mapper reads the reason from it
/// (`src/core/rust-engine/store-errors.ts`). Only multi-user mode sets a deadline, so no other path returns it.
pub const TIMEOUT: &str = "timeout";

/// A lease fence failed (`leases.rs`): the lease's epoch or token moved, it was released or expired, a protected
/// entry point on a multi-user store had no fence, or the claim was taken under another epoch. Nothing was written.
/// The message is JSON: `{ reason, name, epoch, current_epoch }`.
pub const LEASE_LOST: &str = "lease_lost";

/// A store snapshot was cancelled (`snapshot.rs`). It removed what it had written and released
/// its read before this error returned.
pub const SNAPSHOT_CANCELLED: &str = "snapshot_cancelled";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    pub code: &'static str,
    pub message: String,
}

impl StoreError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(INVALID_ARGUMENT, message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(STORE_IO, message)
    }

    /// A `timeout` whose message starts with `reason` (see [`TIMEOUT`]).
    pub fn timeout(reason: &str, message: impl Into<String>) -> Self {
        Self::new(TIMEOUT, format!("{reason}: {}", message.into()))
    }

    /// Whether the file system or the storage engine failed (`store_io`, `store_corrupt`), as
    /// against a record the caller's data does not fit. A failure like this says nothing about
    /// any one record, so a step that turns a bad record into a refusal must pass it on as it is.
    pub fn is_storage_failure(&self) -> bool {
        matches!(self.code, STORE_IO | STORE_CORRUPT)
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for StoreError {}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(
            STORE_CORRUPT,
            format!("a stored record is not valid JSON: {error}"),
        )
    }
}
