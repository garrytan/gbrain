//! The commit notifier's host lease and host source list: the `claimNotifierLease` and
//! `listNotifierHostSourceRows` members of `src/core/engine-sql/notifier.ts`
//! (rust/docs/store/persistence.md, "Commit notifier").
//!
//! The lease is one `sync_notifier_leases` row per host. Key `d 0x08 0x01 <host_id>` (the host id
//! text, which cannot hold NUL, as Postgres text cannot), JSON `NotifierLeaseRecord`. A claim
//! wins when the host has no row, when the row is the caller's, or when it expired
//! (`expires_at <= now`); a takeover adds 1 to the fencing token, a renewal keeps it. A lost
//! claim reads the holder. Rows are never deleted on this engine (the notifier's release, which
//! still refuses here, would expire the row, not delete it).
//!
//! The host source list reads the source records. This engine keeps no managed worktree bindings
//! and no classic syncer rows (`sync_notifier_sources`), and a source keeps no `last_commit`, so
//! every row reads `bound` false and `last_commit`, `owner`, `root` and `syncer` null, as Postgres
//! reads a source with none of those rows.

use crate::env::{Env, iso};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite};
use crate::sources::all_sources;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The byte after `d 0x08` of a lease row.
const LEASE: u8 = 0x01;

/// One stored `sync_notifier_leases` row.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct NotifierLeaseRecord {
    owner_id: String,
    fence: i64,
    resident_kind: String,
    pid: Option<i64>,
    renewed_at_us: i64,
    expires_at_us: i64,
}

/// `claimNotifierLease(l)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifierLeaseClaim {
    pub host_id: String,
    pub owner_id: String,
    pub kind: String,
    pub pid: i64,
    pub lease_ms: f64,
}

fn lease_key(host_id: &str) -> Result<Vec<u8>> {
    if host_id.contains('\0') {
        return Err(StoreError::invalid("hostId must not contain NUL"));
    }
    let mut key = vec![keys::PERSISTENCE, super::NOTIFIER, LEASE];
    key.extend_from_slice(host_id.as_bytes());
    Ok(key)
}

/// The holder as `readNotifierLease` returns it.
fn holder(r: &NotifierLeaseRecord, now: i64) -> Value {
    json!({
        "owner_id": r.owner_id,
        "fence": r.fence,
        "resident_kind": r.resident_kind,
        "pid": r.pid,
        "expires_at": iso(r.expires_at_us),
        "live": r.expires_at_us > now,
    })
}

/// The INSERT ... ON CONFLICT ... WHERE ... RETURNING fence of the claim, then the holder read
/// when no row came back: `{ owner: true, fence }` or `{ owner: false, holder }`.
pub(crate) fn claim_notifier_lease_in(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    claim: &NotifierLeaseClaim,
) -> Result<Value> {
    let key = lease_key(&claim.host_id)?;
    // Math.max(1, Math.round(leaseMs)) milliseconds; JavaScript rounds half up.
    let lease_ms = (claim.lease_ms + 0.5).floor().max(1.0) as i64;
    let now = env.now_micros();
    let expires = now.saturating_add(lease_ms.saturating_mul(1000));
    let fence = match get_json::<NotifierLeaseRecord>(&*tx, &key)? {
        None => 1,
        Some(old) if old.owner_id == claim.owner_id => old.fence,
        Some(old) if old.expires_at_us <= now => old.fence + 1,
        Some(old) => return Ok(json!({ "owner": false, "holder": holder(&old, now) })),
    };
    let record = NotifierLeaseRecord {
        owner_id: claim.owner_id.clone(),
        fence,
        resident_kind: claim.kind.clone(),
        pid: Some(claim.pid),
        renewed_at_us: now,
        expires_at_us: expires,
    };
    put_json(tx, &key, &record)?;
    Ok(json!({ "owner": true, "fence": fence }))
}

/// The notifier's host source list: every source that is not archived, in id order.
pub(crate) fn list_notifier_host_source_rows_in(read: &dyn KvRead) -> Result<Vec<Value>> {
    let mut records = all_sources(read)?;
    records.retain(|r| !r.archived);
    records.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(records
        .into_iter()
        .map(|r| {
            json!({
                "id": r.id,
                "local_path": r.local_path,
                "last_commit": Value::Null,
                "bound": false,
                "owner": Value::Null,
                "root": Value::Null,
                "syncer": Value::Null,
                "config": r.config,
            })
        })
        .collect())
}

impl Store {
    /// `claimNotifierLease(l)`.
    pub fn claim_notifier_lease(&self, claim: &NotifierLeaseClaim) -> Result<Value> {
        self.write(|tx| claim_notifier_lease_in(tx, &*self.env, claim))
    }

    /// `listNotifierHostSourceRows()`.
    pub fn list_notifier_host_source_rows(&self) -> Result<Vec<Value>> {
        list_notifier_host_source_rows_in(&*self.read()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every key under `prefix`: from the prefix itself up to (not including) the prefix with
    /// its last byte plus one.
    fn range(prefix: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut end = prefix.to_vec();
        *end.last_mut().unwrap() += 1;
        (prefix.to_vec(), end)
    }

    #[test]
    fn the_notifier_key_range_does_not_overlap_the_effect_and_checkpoint_path_range() {
        // `d 0x05` (effect rows), `d 0x06` (effect order) and `d 0x07` (operation checkpoint
        // paths) are taken by another change; the notifier owns `d 0x08` alone.
        let (taken_start, _) = range(&[keys::PERSISTENCE, 0x05]);
        let (_, taken_end) = range(&[keys::PERSISTENCE, 0x07]);
        let (start, end) = range(&[keys::PERSISTENCE, super::super::NOTIFIER]);
        assert!(
            start >= taken_end || end <= taken_start,
            "notifier range overlaps d 0x05-0x07"
        );
        for host in [
            "",
            "00000000-0000-4000-8000-00000000a001",
            "\u{ff}\u{ff}",
            "host\u{1}",
        ] {
            let key = lease_key(host).unwrap();
            assert!(
                key.as_slice() >= start.as_slice() && key.as_slice() < end.as_slice(),
                "{host:?}"
            );
            assert!(!(taken_start.as_slice()..taken_end.as_slice()).contains(&key.as_slice()));
        }
        // Nor does it share a byte with this family's other rows.
        for other in [
            super::super::COUNTER,
            super::super::HOUSEKEEPING,
            super::super::TOPOLOGY,
            super::super::QUEUE,
        ] {
            assert_ne!(other, super::super::NOTIFIER);
        }
    }

    #[test]
    fn a_host_id_with_nul_is_refused() {
        assert!(lease_key("a\0b").is_err());
    }
}
