//! Leases with epochs and fencing (frozen interface I-5 of the multi-user build; design note
//! `docs/designs/rust-engine/multi-user-server.md`, "M3: writers on many machines").
//!
//! A lease is one named record: who holds it (`WriteOrigin`), its `epoch`, a token, and when it expires. Taking a
//! lease that nobody holds (never taken, released, or expired) raises the epoch by one and mints a new token, so
//! every takeover moves the epoch. A holder renews with its [`LeaseToken`] before the lease expires; a renewal after
//! the epoch moved, after a release, after expiry or for a token that never held the lease refuses `lease_lost`, and
//! the holder takes the lease again under a new epoch.
//!
//! Fencing: [`assert_held`] reads the lease record inside the writing transaction. On the concurrent store
//! (`occ_kv`) that read is in the transaction's read set, so a takeover that commits after the holder's snapshot
//! makes the holder's commit lose with `write_conflict`; `Store::write` runs it again from a fresh snapshot, where
//! the check refuses `lease_lost` and nothing is written. On the single-writer store, and inside an explicit
//! transaction, the writer is held from the read to the commit, so no takeover can land in between. Either way a
//! paused holder cannot write protected data after a takeover, even when its write began before it. No file lock,
//! no process-wide mutex and no busy error: a second taker of a live lease gets `None`, never an error.
//!
//! Time: expiry is judged by the clock of the process that runs the store (`Env::clock_micros`): one server, one
//! clock. A caller's clock is never read.
//!
//! Protected entry points (job, write-claim, effect, drain-lease and cycle-lock writes) take an optional fence, the
//! caller's [`LeaseToken`] ([`check_fence`]). On a store opened in multi-user mode a missing fence refuses
//! `lease_lost` with reason `fence_missing`; off, a missing fence keeps today's behavior exactly. A claim taken under
//! a fence records the fence's lease name and epoch beside the claim ([`record_claim_epoch`]); a later protected
//! write on that claim must carry a fence with the same name and epoch ([`check_claim_epoch`]).
//!
//! Keys: the two-byte family `~L` (`keys::LEASES`). The byte after the tag names the record:
//! - `0x01 <name>`: a lease record (JSON [`LeaseRecord`]); it stays after a release so the epoch never goes back;
//! - `0x02`: the consumer heartbeat rows (`persistence` consumer members in multi-user mode);
//! - `0x03 <kind> ...`: per-entity fact sequences (`facts/entity_order.rs` lists the kinds: `01 source 00 entity` the
//!   counter, `02 source 00 entity 00 seq` the index of fact ids), written only on a multi-user store;
//! - `0x04`: the clock high-water mark;
//! - `0x05 <family byte> <claim id>`: the lease name and epoch a claim was taken under. Family bytes (`CLAIM_*`):
//!   `01` job, `02` write request (also a grouped publication follower), `03` effect (also a coalesced Git effect),
//!   `04` drain lease, `05` cycle lock, `06` refresh row, `07` sync checkpoint. Append only, never reuse.
//!
//! Nothing writes under `~L` until a caller takes a lease, so a brain that never does keeps every byte.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::Store;
use crate::env::Env;
use crate::error::{LEASE_LOST, Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite};
use crate::write_origin::WriteOrigin;
use crate::{get_json, put_json};

/// Sub-tags under `keys::LEASES`. Never reuse, reorder or repurpose one.
pub const LEASE_RECORD: u8 = 0x01;
pub const CONSUMER_ROW: u8 = 0x02;
pub const ENTITY_FACT_SEQUENCE: u8 = 0x03;
pub const CLOCK_HIGH_WATER: u8 = 0x04;
pub const CLAIM_EPOCH: u8 = 0x05;

/// Claim families whose claims record an epoch (`CLAIM_EPOCH` keys). Never reuse, reorder or repurpose one.
pub const CLAIM_JOB: u8 = 0x01;
pub const CLAIM_WRITE: u8 = 0x02;
pub const CLAIM_EFFECT: u8 = 0x03;
pub const CLAIM_DRAIN_LEASE: u8 = 0x04;
pub const CLAIM_CYCLE_LOCK: u8 = 0x05;
/// A worktree refresh row (lane LM slice 3): the claim id is the refresh row id, lowercase. Taken when the row is
/// created (`insert_draining`) or adopted by a new holder (`adopt_claim`, `set_holder`), checked on every state
/// mutation, ended at the terminal states (`completed`, `aborted`).
pub const CLAIM_REFRESH: u8 = 0x06;
/// A managed sync checkpoint (lane LM slice 3): the claim id is `<op> 0x00 <fingerprint>` of the `op_checkpoints`
/// row (the sync cursor of op `managed-sync` and the ghost report claim). Taken when the row is created or claimed
/// (`cursor_insert`, `ghost_report_claim`) or adopted by a resuming run (`checkpoint_touch` of a cursor row), checked on
/// every compare-and-swap and write, ended when the cursor is marked done or deleted.
pub const CLAIM_SYNC_CHECKPOINT: u8 = 0x07;

/// The longest lease name, in bytes.
pub const MAX_NAME_BYTES: usize = 512;
/// The longest time to live, in milliseconds: seven days.
pub const MAX_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// What a holder keeps and shows on every protected write: the lease name, the epoch it took and its token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeaseToken {
    pub name: String,
    pub epoch: u64,
    /// A UUID v7 minted when the lease was taken.
    pub token: String,
}

/// The stored lease record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseRecord {
    pub name: String,
    pub epoch: u64,
    pub token: String,
    pub holder: WriteOrigin,
    pub acquired_at_us: i64,
    pub renewed_at_us: i64,
    pub expires_at_us: i64,
    pub released: bool,
}

/// What `read_lease` shows: the record without its token, and whether it is live now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LeaseState {
    pub name: String,
    pub epoch: u64,
    pub holder: WriteOrigin,
    pub acquired_at_us: i64,
    pub renewed_at_us: i64,
    pub expires_at_us: i64,
    pub released: bool,
    pub live: bool,
}

/// Why a fence was refused (`lease_lost` reason).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LostReason {
    /// No lease record carries the name.
    NotFound,
    /// The epoch or token moved: someone took the lease over.
    EpochMoved,
    /// The holder released it.
    Released,
    /// It expired and was not renewed.
    Expired,
    /// A protected entry point on a multi-user store was called without a fence.
    FenceMissing,
    /// The claim was taken under another lease name or epoch than the fence shows.
    ClaimEpochMismatch,
}

impl LostReason {
    pub fn as_str(self) -> &'static str {
        match self {
            LostReason::NotFound => "not_found",
            LostReason::EpochMoved => "epoch_moved",
            LostReason::Released => "released",
            LostReason::Expired => "expired",
            LostReason::FenceMissing => "fence_missing",
            LostReason::ClaimEpochMismatch => "claim_epoch_mismatch",
        }
    }
}

/// `lease_lost`. The message is JSON: `{ reason, name, epoch, current_epoch }` (`current_epoch` null when unknown).
pub fn lease_lost(reason: LostReason, name: &str, epoch: u64, current: Option<u64>) -> StoreError {
    StoreError::new(
        LEASE_LOST,
        json!({ "reason": reason.as_str(), "name": name, "epoch": epoch, "current_epoch": current }).to_string(),
    )
}

/// The `lease_lost` reason of an error, when it is one.
pub fn lost_reason(error: &StoreError) -> Option<String> {
    if error.code != LEASE_LOST {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(&error.message)
        .ok()
        .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_owned))
}

fn lease_key(name: &str) -> Vec<u8> {
    let mut key = keys::LEASES.to_vec();
    key.push(LEASE_RECORD);
    key.extend_from_slice(name.as_bytes());
    key
}

fn claim_epoch_key(family: u8, id: &str) -> Vec<u8> {
    let mut key = keys::LEASES.to_vec();
    key.push(CLAIM_EPOCH);
    key.push(family);
    key.extend_from_slice(id.as_bytes());
    key
}

fn check_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > MAX_NAME_BYTES || name.contains('\0') {
        return Err(StoreError::invalid(format!(
            "a lease name must be 1 to {MAX_NAME_BYTES} bytes of text without NUL"
        )));
    }
    Ok(())
}

fn check_ttl(ttl_ms: u64) -> Result<i64> {
    if ttl_ms == 0 || ttl_ms > MAX_TTL_MS {
        return Err(StoreError::invalid(format!(
            "a lease time to live must be 1 to {MAX_TTL_MS} milliseconds"
        )));
    }
    Ok((ttl_ms as i64) * 1000)
}

/// A UUID v7: 48 bits of Unix milliseconds from the store's clock, then the version, then random bits from the
/// store's random source (`Env::new_uuid`). Separate from `Env::new_uuid` (v4), which every older identifier keeps.
pub fn uuid_v7(env: &dyn Env) -> String {
    let ms = (env.clock_micros().max(0) / 1000) as u64;
    let random: Vec<u8> = env
        .new_uuid()
        .bytes()
        .filter(u8::is_ascii_hexdigit)
        .collect::<Vec<u8>>()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap_or("00"), 16).unwrap_or(0))
        .collect();
    let mut b = [0u8; 16];
    for (i, byte) in random.iter().take(16).enumerate() {
        b[i] = *byte;
    }
    b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    b[6] = 0x70 | (b[6] & 0x0f);
    b[8] = 0x80 | (b[8] & 0x3f);
    let hex: Vec<String> = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].concat(),
        hex[4..6].concat(),
        hex[6..8].concat(),
        hex[8..10].concat(),
        hex[10..16].concat()
    )
}

fn load(read: &dyn KvRead, name: &str) -> Result<Option<LeaseRecord>> {
    get_json(read, &lease_key(name))
}

/// Fails `lease_lost` unless `token` holds its lease now (`now` on the store clock): same epoch and token, not
/// released, not expired. Called inside the writing transaction, the read is in its read set (see the module
/// header), so the check holds at commit.
pub fn assert_held(read: &dyn KvRead, token: &LeaseToken, now: i64) -> Result<()> {
    let Some(rec) = load(read, &token.name)? else {
        return Err(lease_lost(
            LostReason::NotFound,
            &token.name,
            token.epoch,
            None,
        ));
    };
    if rec.epoch != token.epoch || rec.token != token.token {
        return Err(lease_lost(
            LostReason::EpochMoved,
            &token.name,
            token.epoch,
            Some(rec.epoch),
        ));
    }
    if rec.released {
        return Err(lease_lost(
            LostReason::Released,
            &token.name,
            token.epoch,
            Some(rec.epoch),
        ));
    }
    if rec.expires_at_us <= now {
        return Err(lease_lost(
            LostReason::Expired,
            &token.name,
            token.epoch,
            Some(rec.epoch),
        ));
    }
    Ok(())
}

/// The fence of a protected entry point, checked inside its writing transaction. `Some` asserts it
/// ([`assert_held`]); `None` refuses `lease_lost` / `fence_missing` on a multi-user store and passes otherwise
/// (today's behavior).
pub fn check_fence(
    store: &Store,
    read: &dyn KvRead,
    fence: Option<&LeaseToken>,
    what: &str,
) -> Result<()> {
    match fence {
        Some(token) => assert_held(read, token, store.env.clock_micros()),
        None if store.multiuser() => Err(lease_lost(LostReason::FenceMissing, what, 0, None)),
        None => Ok(()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ClaimEpoch {
    lease: String,
    epoch: u64,
}

/// Records that claim `id` of `family` was taken under `fence` (in the claim's own write).
pub fn record_claim_epoch(
    tx: &mut dyn KvWrite,
    family: u8,
    id: &str,
    fence: &LeaseToken,
) -> Result<()> {
    put_json(
        tx,
        &claim_epoch_key(family, id),
        &ClaimEpoch {
            lease: fence.name.clone(),
            epoch: fence.epoch,
        },
    )
}

/// Fails `lease_lost` / `claim_epoch_mismatch` unless claim `id` of `family` was taken under `fence`'s lease name and
/// epoch. A claim with no record (taken without a fence) refuses too: a fenced write never finishes an unfenced claim.
pub fn check_claim_epoch(
    read: &dyn KvRead,
    family: u8,
    id: &str,
    fence: &LeaseToken,
) -> Result<()> {
    let recorded: Option<ClaimEpoch> = get_json(read, &claim_epoch_key(family, id))?;
    match recorded {
        Some(c) if c.lease == fence.name && c.epoch == fence.epoch => Ok(()),
        other => Err(lease_lost(
            LostReason::ClaimEpochMismatch,
            &fence.name,
            fence.epoch,
            other.map(|c| c.epoch),
        )),
    }
}

/// Deletes claim `id`'s epoch record (when the claim ends: completion, failure, release or reclaim).
pub fn clear_claim_epoch(tx: &mut dyn KvWrite, family: u8, id: &str) -> Result<()> {
    let key = claim_epoch_key(family, id);
    if tx.get(&key)?.is_some() {
        tx.delete(&key)?;
    }
    Ok(())
}

impl Store {
    /// `acquire_lease(name, holder, ttl_ms)`: takes the lease when nobody holds it (never taken, released, or expired
    /// on the store clock), with the epoch raised by one and a new token, and returns the token; `None` while another
    /// holder's lease is live (never an error). A live lease is not re-taken by its own holder: it renews.
    pub fn acquire_lease(
        &self,
        name: &str,
        holder: &WriteOrigin,
        ttl_ms: u64,
    ) -> Result<Option<LeaseToken>> {
        check_name(name)?;
        holder.check()?;
        let ttl_us = check_ttl(ttl_ms)?;
        self.write(|tx| {
            let now = self.env.clock_micros();
            let old = load(tx, name)?;
            if old
                .as_ref()
                .is_some_and(|r| !r.released && r.expires_at_us > now)
            {
                return Ok(None);
            }
            let epoch = old
                .as_ref()
                .map_or(0, |r| r.epoch)
                .checked_add(1)
                .ok_or_else(|| {
                    StoreError::new(
                        crate::error::INVALID_STATE,
                        "the lease epoch cannot grow further",
                    )
                })?;
            let rec = LeaseRecord {
                name: name.to_owned(),
                epoch,
                token: uuid_v7(&*self.env),
                holder: holder.clone(),
                acquired_at_us: now,
                renewed_at_us: now,
                expires_at_us: now.saturating_add(ttl_us),
                released: false,
            };
            put_json(tx, &lease_key(name), &rec)?;
            Ok(Some(LeaseToken {
                name: rec.name,
                epoch: rec.epoch,
                token: rec.token,
            }))
        })
    }

    /// `renew_lease(token, ttl_ms)`: moves the expiry `ttl_ms` past now. `lease_lost` when the epoch or token moved,
    /// the lease was released, or it expired on the store clock: an expired holder (a machine back from a partition)
    /// takes the lease again with `acquire_lease`, under a new epoch, so every write it started under the old epoch is
    /// refused.
    pub fn renew_lease(&self, token: &LeaseToken, ttl_ms: u64) -> Result<()> {
        check_name(&token.name)?;
        let ttl_us = check_ttl(ttl_ms)?;
        self.write(|tx| {
            let now = self.env.clock_micros();
            let Some(mut rec) = load(tx, &token.name)? else {
                return Err(lease_lost(
                    LostReason::NotFound,
                    &token.name,
                    token.epoch,
                    None,
                ));
            };
            if rec.epoch != token.epoch || rec.token != token.token {
                return Err(lease_lost(
                    LostReason::EpochMoved,
                    &token.name,
                    token.epoch,
                    Some(rec.epoch),
                ));
            }
            if rec.released {
                return Err(lease_lost(
                    LostReason::Released,
                    &token.name,
                    token.epoch,
                    Some(rec.epoch),
                ));
            }
            if rec.expires_at_us <= now {
                return Err(lease_lost(
                    LostReason::Expired,
                    &token.name,
                    token.epoch,
                    Some(rec.epoch),
                ));
            }
            rec.renewed_at_us = now;
            rec.expires_at_us = now.saturating_add(ttl_us);
            put_json(tx, &lease_key(&token.name), &rec)
        })
    }

    /// `release_lease(token)`: gives the lease up when `token` still holds it; a stale or unknown token changes
    /// nothing (release is token-scoped and repeatable). The record stays, so the next taker's epoch is higher.
    pub fn release_lease(&self, token: &LeaseToken) -> Result<()> {
        check_name(&token.name)?;
        self.write(|tx| {
            let now = self.env.clock_micros();
            let Some(mut rec) = load(tx, &token.name)? else {
                return Ok(());
            };
            if rec.epoch != token.epoch || rec.token != token.token || rec.released {
                return Ok(());
            }
            rec.released = true;
            rec.expires_at_us = rec.expires_at_us.min(now);
            put_json(tx, &lease_key(&token.name), &rec)
        })
    }

    /// The lease named `name` as stored (without its token), and whether it is live on the store clock.
    pub fn read_lease(&self, name: &str) -> Result<Option<LeaseState>> {
        check_name(name)?;
        let now = self.env.clock_micros();
        Ok(load(&*self.read()?, name)?.map(|r| LeaseState {
            live: !r.released && r.expires_at_us > now,
            name: r.name,
            epoch: r.epoch,
            holder: r.holder,
            acquired_at_us: r.acquired_at_us,
            renewed_at_us: r.renewed_at_us,
            expires_at_us: r.expires_at_us,
            released: r.released,
        }))
    }

    /// `assert_lease(token)` (I-1 / I-5): on a store bound to a transaction, a statement that reads the lease record
    /// into the transaction, so the check holds at its commit; on the brain's own store, a check against the latest
    /// snapshot. `lease_lost` when `token` does not hold its lease now.
    pub fn assert_lease(&self, token: &LeaseToken) -> Result<()> {
        check_name(&token.name)?;
        let now = self.env.clock_micros();
        match &self.bound {
            Some(tx) => tx.statement(|w| assert_held(w, token, now)),
            None => assert_held(&*self.read()?, token, now),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixedEnv(i64);
    impl Env for FixedEnv {
        fn now_micros(&self) -> i64 {
            self.0
        }
        fn new_uuid(&self) -> String {
            "0123abcd-4567-4890-a123-456789abcdef".into()
        }
    }

    #[test]
    fn uuid_v7_carries_the_millisecond_time_and_version_7() {
        let id = uuid_v7(&FixedEnv(1_795_619_334_140_229));
        assert_eq!(id.len(), 36);
        let hex: String = id.chars().filter(|c| *c != '-').collect();
        assert_eq!(
            u64::from_str_radix(&hex[..12], 16).unwrap(),
            1_795_619_334_140
        );
        assert_eq!(&hex[12..13], "7");
        assert!(matches!(&hex[16..17], "8" | "9" | "a" | "b"));
        assert!(crate::env::is_uuid(&id));
    }

    #[test]
    fn lost_reasons_round_trip_through_the_message() {
        let e = lease_lost(LostReason::EpochMoved, "consumer:h", 3, Some(4));
        assert_eq!(e.code, LEASE_LOST);
        assert_eq!(lost_reason(&e).as_deref(), Some("epoch_moved"));
    }
}

#[cfg(test)]
#[path = "leases_tests.rs"]
mod store_tests;
