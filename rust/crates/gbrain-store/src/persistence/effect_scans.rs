//! Effect scans: the statements of `src/core/engine-sql/persistence-effect-scans.ts` that the
//! effect worker's pass sends before it claims effects (rust/docs/store/persistence.md, "Effect
//! scans").
//!
//! Each scan joins `persistence_effects` to `persistence_worktrees` on the host that owns the
//! worktree. This engine keeps no worktree and records no effect, so every scan answers no row.
//! The parameters are still checked as their Postgres casts check them, so an argument Postgres
//! refuses is refused here too.

use crate::Store;
use crate::env::is_uuid;
use crate::error::{Result, StoreError};
use serde_json::Value;

/// `$1::uuid`: the message Postgres gives for text that is not a uuid.
fn host_uuid(text: &str) -> Result<()> {
    if is_uuid(text) {
        Ok(())
    } else {
        Err(StoreError::invalid(format!(
            "invalid input syntax for type uuid: \"{text}\""
        )))
    }
}

/// `listGatedMirrorRequests(hostId, gateCode, allowedCodes)`: no request has a parked
/// withdrawal mirror on a worktree here, so no row; a non-uuid host id refuses.
pub(crate) fn list_gated_mirror_requests(host_id: &str) -> Result<Vec<Value>> {
    host_uuid(host_id)?;
    Ok(Vec::new())
}

impl Store {
    /// `listGatedMirrorRequests(hostId, gateCode, allowedCodes)`.
    pub fn list_gated_mirror_requests(&self, host_id: &str) -> Result<Vec<Value>> {
        list_gated_mirror_requests(host_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gated_mirror_requests_are_empty_and_refuse_a_non_uuid_host() {
        let host = "0f000000-0000-4000-8000-0000000000f1";
        assert!(list_gated_mirror_requests(host).unwrap().is_empty());
        assert!(
            list_gated_mirror_requests(&host.to_uppercase())
                .unwrap()
                .is_empty()
        );
        let bad = list_gated_mirror_requests("nope").unwrap_err();
        assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
    }
}
