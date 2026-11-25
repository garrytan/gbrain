//! Where a write comes from (frozen interface I-3 of the multi-user build,
//! `docs/designs/rust-engine/multi-user-server.md`, "Write journal and store format changes").
//!
//! - `host_id`: the machine UUID from `host.json` (`src/core/persistence/identity.ts` `localHostId`), never a hostname;
//! - `incarnation`: a fresh UUID v7 per engine open (or per server connection);
//! - `writer_id`: `<principal_kind>:<principal_id>`, as the write journal keys a principal.
//!
//! The leases (`leases.rs`) record the holder's origin; the commit record and the journal rows (lane L2) carry the same
//! struct. Nothing reads or writes an origin while multi-user mode is off.

use serde::{Deserialize, Serialize};

use crate::error::{Result, StoreError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteOrigin {
    pub host_id: String,
    pub incarnation: String,
    pub writer_id: String,
}

/// The longest text an origin field may hold, in bytes.
const MAX_FIELD_BYTES: usize = 512;

impl WriteOrigin {
    /// Refuses an empty field, a field with NUL (keys use NUL as a separator) or a field longer than 512 bytes.
    pub fn check(&self) -> Result<()> {
        for (name, value) in [
            ("host_id", &self.host_id),
            ("incarnation", &self.incarnation),
            ("writer_id", &self.writer_id),
        ] {
            if value.is_empty() || value.len() > MAX_FIELD_BYTES || value.contains('\0') {
                return Err(StoreError::invalid(format!(
                    "write origin {name} must be 1 to {MAX_FIELD_BYTES} bytes of text without NUL"
                )));
            }
        }
        Ok(())
    }
}
