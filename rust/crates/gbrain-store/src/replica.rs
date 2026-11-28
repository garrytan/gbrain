//! Replica acks (multi-user mode with the commit log; rust/docs/store/commit-log.md, "Replica acks").
//!
//! A primary answers a served write only after an attached replica acknowledged the write's
//! position, so an attested promotion of that replica keeps every write a client was told is
//! saved. This module is the store half:
//!
//! - `Store::attach_replica(id)` commits the meta key `replica/<id>` (`ReplicaRecord`) through the
//!   normal write path: a plain commit record, fenced as every write, replicated to followers. An id
//!   that is attached keeps its generation; a new attach after a detach gets the next one.
//! - `Store::detach_replica(id, reason)` deletes that key and writes `replica-detach/<id>`
//!   (`ReplicaDetach`) in one commit. A promotion writes the same detach notes in its own commit
//!   (`follower.rs`, `start_timeline`).
//! - `Store::report_replica_ack(id, generation, cursor, lineage)` raises the id's acked cursor (kept in
//!   memory) to `max(old, cursor)`, only for an attached id of that generation and a cursor at or
//!   below the primary's newest commit (and, with a lineage, one whose history the primary's
//!   continues). Anything else is refused `invalid_state` and changes nothing.
//! - `Store::replica_cover(position)`: `required` while any replica is attached; `covered` once one
//!   of them acked `position` or later.
//! - `Store::wait_replicated(position)`: a blocking wait for Rust callers and tests; it ends
//!   `replication_timeout`. The store never blocks a commit for an ack: the served layer waits at
//!   its answer (src/core/rust-engine/served/replica-gate.ts).
//!
//! The attached set is read from the keys at every call, so a restarted primary keeps waiting and a
//! detach from any handle counts at once. Only the acked cursors live in memory: after a restart the
//! follower's next `repl_follow` cursor reports them again. Everything here is off (nothing
//! required, attach refused) unless multi-user mode and the commit log are on. With the switch off
//! the keys are never written, and no list, dump or parity output shows them (`is_replica_key`).

use crate::commit_log::{self, CommitPosition, Timeline};
use crate::error::{INVALID_ARGUMENT, INVALID_STATE, Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// No attached replica acknowledged a write before the deadline (or its replica was detached while
/// it waited). The commit is durable on the primary; the outcome is unknown to the client.
pub const REPLICATION_TIMEOUT: &str = "replication_timeout";
/// The wait budget is full; the served layer refuses before the write runs (nothing committed).
pub const REPLICATION_BUSY: &str = "replication_busy";

/// Environment overrides of [`ReplicaAckSettings`], read at open in multi-user mode with the log.
pub const TIMEOUT_ENV: &str = "GBRAIN_RUST_REPLICA_ACK_TIMEOUT_MS";
pub const MAX_WAITERS_ENV: &str = "GBRAIN_RUST_REPLICA_ACK_MAX_WAITERS";

const ATTACHED: &str = "replica/";
const DETACHED: &str = "replica-detach/";
/// How often a waiter reads the attached set again when nothing woke it (a detach from another
/// handle on the same records).
const RECHECK: Duration = Duration::from_millis(250);

/// The key of an attached replica.
pub fn replica_key(id: &str) -> Vec<u8> {
    keys::meta(&format!("{ATTACHED}{id}"))
}

/// The key of a replica's last detach note.
pub fn replica_detach_key(id: &str) -> Vec<u8> {
    keys::meta(&format!("{DETACHED}{id}"))
}

/// Whether `key` is replica bookkeeping (`replica/<id>` or `replica-detach/<id>`). Every reader
/// that lists, dumps or compares meta keys for output skips these.
pub fn is_replica_key(key: &[u8]) -> bool {
    match key.split_first() {
        Some((&keys::META, rest)) => {
            rest.starts_with(ATTACHED.as_bytes()) || rest.starts_with(DETACHED.as_bytes())
        }
        _ => false,
    }
}

/// An attached replica (`replica/<id>`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplicaRecord {
    pub id: String,
    /// 1 for the first attach of the id, one more after each detach.
    pub generation: u64,
    pub attached_at_us: i64,
}

/// The last detach of a replica (`replica-detach/<id>`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplicaDetach {
    pub id: String,
    pub generation: u64,
    pub reason: String,
    pub detached_at_us: i64,
}

/// What a write at `position` needs (`Store::replica_cover`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReplicaCover {
    /// At least one replica is attached.
    pub required: bool,
    /// An attached replica acked `position` or later.
    pub covered: bool,
    /// The newest position an attached replica acked (`None`: none yet).
    pub acked_through: Option<CommitPosition>,
}

/// The wait's deadline and the most waits at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplicaAckSettings {
    pub timeout_ms: u64,
    pub max_waiters: usize,
}

impl Default for ReplicaAckSettings {
    fn default() -> Self {
        Self {
            timeout_ms: 10_000,
            max_waiters: 1_024,
        }
    }
}

impl ReplicaAckSettings {
    /// The settings `get` names ([`TIMEOUT_ENV`] 1 to 600,000; [`MAX_WAITERS_ENV`] 1 to 65,536), the
    /// defaults for an unset name. Any other value is refused `invalid_argument`.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let read = |name: &str, max: u64, default: u64| -> Result<u64> {
            match get(name) {
                None => Ok(default),
                Some(text) => match text.trim().parse::<u64>() {
                    Ok(n) if (1..=max).contains(&n) => Ok(n),
                    _ => Err(StoreError::invalid(format!(
                        "{name} must be an integer from 1 to {max}, not {text:?}"
                    ))),
                },
            }
        };
        let d = Self::default();
        Ok(Self {
            timeout_ms: read(TIMEOUT_ENV, 600_000, d.timeout_ms)?,
            max_waiters: read(MAX_WAITERS_ENV, 65_536, d.max_waiters as u64)? as usize,
        })
    }

    /// The settings of this process's environment.
    pub fn from_env() -> Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }
}

/// The acked cursors and waits of one open brain, shared by every store on it.
#[derive(Default)]
pub(crate) struct ReplicaSet {
    acks: Mutex<Acks>,
    changed: Condvar,
}

#[derive(Default)]
struct Acks {
    settings: ReplicaAckSettings,
    /// id -> (generation, acked cursor).
    cursors: BTreeMap<String, (u64, CommitPosition)>,
    waiters: usize,
    /// Grows at every ack, attach and detach, so a waiter never misses a wake-up.
    epoch: u64,
}

impl ReplicaSet {
    pub(crate) fn new(settings: ReplicaAckSettings) -> ReplicaSet {
        let set = ReplicaSet::default();
        set.lock().settings = settings;
        set
    }

    fn lock(&self) -> MutexGuard<'_, Acks> {
        self.acks.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn bump(&self, f: impl FnOnce(&mut Acks)) {
        let mut acks = self.lock();
        f(&mut acks);
        acks.epoch += 1;
        drop(acks);
        self.changed.notify_all();
    }
}

/// The replicas attached in `read`, in id order.
pub fn attached(read: &dyn KvRead) -> Result<Vec<ReplicaRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &replica_key(""), false, &mut |_, v| {
        match serde_json::from_slice::<ReplicaRecord>(v) {
            Ok(r) => out.push(r),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

fn check_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(StoreError::new(
            INVALID_ARGUMENT,
            "a replica id is 1 to 128 characters of letters, digits, '.', '_', ':' and '-'",
        ))
    }
}

fn check_reason(reason: &str) -> Result<()> {
    if reason.trim().is_empty() || reason.len() > 512 || reason.contains('\0') {
        return Err(StoreError::invalid(
            "a detach reason is 1 to 512 bytes of text without NUL",
        ));
    }
    Ok(())
}

fn refused(why: String) -> StoreError {
    StoreError::new(INVALID_STATE, format!("replica ack refused: {why}"))
}

impl Store {
    /// Replica acks run only on the brain's own store in multi-user mode with the commit log.
    fn replicas_on(&self) -> bool {
        self.multiuser && self.info.commit_log && self.bound.is_none()
    }

    fn require_replicas(&self) -> Result<()> {
        if self.replicas_on() {
            Ok(())
        } else {
            Err(StoreError::new(
                INVALID_STATE,
                "replica acks need multi-user mode and the commit log (GBRAIN_RUST_MULTIUSER=1, GBRAIN_RUST_COMMIT_LOG=1), on the brain's own store",
            ))
        }
    }

    /// The wait settings this brain was opened with.
    pub fn replica_ack_settings(&self) -> ReplicaAckSettings {
        self.replicas.lock().settings
    }

    /// Test seam: replaces the wait settings of every store on this brain (waits running now keep
    /// their deadline).
    #[doc(hidden)]
    pub fn set_replica_ack_settings(&self, settings: ReplicaAckSettings) {
        self.replicas.bump(|acks| acks.settings = settings);
    }

    /// The replicas attached now.
    pub fn attached_replicas(&self) -> Result<Vec<ReplicaRecord>> {
        if !self.replicas_on() {
            return Ok(Vec::new());
        }
        attached(&*self.kv.snapshot()?)
    }

    /// Attaches replica `id` (module docs): one commit, or none when it is attached already.
    pub fn attach_replica(&self, id: &str) -> Result<ReplicaRecord> {
        self.require_replicas()?;
        check_id(id)?;
        let key = replica_key(id);
        if let Some(rec) = get_json::<ReplicaRecord>(&*self.kv.snapshot()?, &key)? {
            return Ok(rec);
        }
        let now = self.env.now_micros();
        let rec = self.write(|w| {
            if let Some(rec) = get_json::<ReplicaRecord>(&*w, &key)? {
                return Ok(rec);
            }
            let generation = get_json::<ReplicaDetach>(&*w, &replica_detach_key(id))?
                .map_or(0, |d| d.generation)
                + 1;
            let rec = ReplicaRecord {
                id: id.to_owned(),
                generation,
                attached_at_us: now,
            };
            put_json(w, &key, &rec)?;
            Ok(rec)
        })?;
        self.replicas.bump(|acks| {
            if acks
                .cursors
                .get(id)
                .is_some_and(|(g, _)| *g != rec.generation)
            {
                acks.cursors.remove(id);
            }
        });
        Ok(rec)
    }

    /// Detaches replica `id` with `reason` (module docs). Returns false, committing nothing, when it
    /// is not attached. Every wait on it ends.
    pub fn detach_replica(&self, id: &str, reason: &str) -> Result<bool> {
        self.require_replicas()?;
        check_id(id)?;
        check_reason(reason)?;
        let key = replica_key(id);
        if get_json::<ReplicaRecord>(&*self.kv.snapshot()?, &key)?.is_none() {
            return Ok(false);
        }
        let now = self.env.now_micros();
        let done = self.write(|w| {
            let Some(rec) = get_json::<ReplicaRecord>(&*w, &key)? else {
                return Ok(false);
            };
            w.delete(&key)?;
            put_json(
                w,
                &replica_detach_key(id),
                &ReplicaDetach {
                    id: id.to_owned(),
                    generation: rec.generation,
                    reason: reason.to_owned(),
                    detached_at_us: now,
                },
            )?;
            Ok(true)
        })?;
        self.replicas.bump(|acks| {
            acks.cursors.remove(id);
        });
        Ok(done)
    }

    /// Reports that replica `id` (attach `generation`) holds every commit through `cursor`. With
    /// `lineage` (the replica's history, from a reconnect), the primary's history must continue it at
    /// `cursor`. Returns the id's acked cursor after the call.
    pub fn report_replica_ack(
        &self,
        id: &str,
        generation: u64,
        cursor: CommitPosition,
        lineage: Option<&[Timeline]>,
    ) -> Result<CommitPosition> {
        self.require_replicas()?;
        let read = self.kv.snapshot()?;
        let Some(rec) = get_json::<ReplicaRecord>(&*read, &replica_key(id))? else {
            return Err(refused(format!("replica {id:?} is not attached")));
        };
        if rec.generation != generation {
            return Err(refused(format!(
                "replica {id:?} is attached as generation {}, not {generation}",
                rec.generation
            )));
        }
        let meta = commit_log::read_meta(&*read)?
            .ok_or_else(|| refused("the brain keeps no commit log".into()))?;
        if cursor > meta.newest {
            return Err(refused(format!(
                "cursor {} is past the primary's newest commit {}",
                cursor.token(),
                meta.newest.token()
            )));
        }
        if let Some(theirs) = lineage
            && !commit_log::lineage_continues(theirs, cursor, &meta.lineage)
        {
            return Err(refused(format!(
                "the replica's history is not the primary's at {}",
                cursor.token()
            )));
        }
        drop(read);
        let mut acked = cursor;
        self.replicas.bump(|acks| {
            let entry = acks
                .cursors
                .entry(id.to_owned())
                .or_insert((generation, cursor));
            if entry.0 != generation {
                *entry = (generation, cursor);
            } else if cursor > entry.1 {
                entry.1 = cursor;
            }
            acked = entry.1;
        });
        Ok(acked)
    }

    /// Whether a write at `position` needs a replica ack, and whether it has one.
    pub fn replica_cover(&self, position: CommitPosition) -> Result<ReplicaCover> {
        if !self.replicas_on() {
            return Ok(ReplicaCover {
                required: false,
                covered: false,
                acked_through: None,
            });
        }
        let attached = attached(&*self.kv.snapshot()?)?;
        let acks = self.replicas.lock();
        let acked_through = attached
            .iter()
            .filter_map(|r| match acks.cursors.get(&r.id) {
                Some((g, c)) if *g == r.generation => Some(*c),
                _ => None,
            })
            .max();
        Ok(ReplicaCover {
            required: !attached.is_empty(),
            covered: acked_through.is_some_and(|a| a >= position),
            acked_through,
        })
    }

    /// The waits running now (`wait_replicated`).
    pub fn replica_waiters(&self) -> usize {
        self.replicas.lock().waiters
    }

    /// Waits until a write at `position` is covered (module docs), at most the settings' timeout.
    /// Returns at once when no replica is attached. Ends `replication_timeout` at the deadline, when
    /// every replica it waited for is detached, or when the wait budget is full.
    pub fn wait_replicated(&self, position: CommitPosition) -> Result<ReplicaCover> {
        let first = self.replica_cover(position)?;
        if !first.required || first.covered {
            return Ok(first);
        }
        let settings = self.replica_ack_settings();
        let timeout = |why: &str, cover: &ReplicaCover| {
            StoreError::new(
                REPLICATION_TIMEOUT,
                format!(
                    "the primary committed {} but {why}; acked through {}",
                    position.token(),
                    cover
                        .acked_through
                        .map_or_else(|| "nothing".to_owned(), |a| a.token())
                ),
            )
        };
        {
            let mut acks = self.replicas.lock();
            if acks.waiters >= settings.max_waiters {
                return Err(timeout(
                    &format!("the replica wait budget ({}) is full", settings.max_waiters),
                    &first,
                ));
            }
            acks.waiters += 1;
        }
        struct Leave<'a>(&'a ReplicaSet);
        impl Drop for Leave<'_> {
            fn drop(&mut self) {
                self.0.lock().waiters -= 1;
            }
        }
        let _leave = Leave(&self.replicas);
        let deadline = Instant::now() + Duration::from_millis(settings.timeout_ms);
        loop {
            let seen = self.replicas.lock().epoch;
            let cover = self.replica_cover(position)?;
            if !cover.required {
                return Err(timeout(
                    "its replica was detached before it acknowledged",
                    &cover,
                ));
            }
            if cover.covered {
                return Ok(cover);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(timeout(
                    &format!(
                        "no attached replica acknowledged it within {} ms",
                        settings.timeout_ms
                    ),
                    &cover,
                ));
            }
            let acks = self.replicas.lock();
            if acks.epoch == seen {
                let wait = (deadline - now).min(RECHECK);
                let _ = self
                    .replicas
                    .changed
                    .wait_timeout(acks, wait)
                    .unwrap_or_else(|p| p.into_inner());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_parse_their_ranges_and_refuse_the_rest() {
        let none = ReplicaAckSettings::from_lookup(|_| None).unwrap();
        assert_eq!(none, ReplicaAckSettings::default());
        let set = |t: &'static str, w: &'static str| {
            ReplicaAckSettings::from_lookup(move |n| {
                Some(if n == TIMEOUT_ENV { t } else { w }.to_owned())
            })
        };
        assert_eq!(
            set("1", "65536").unwrap(),
            ReplicaAckSettings {
                timeout_ms: 1,
                max_waiters: 65_536
            }
        );
        for (t, w) in [
            ("0", "1"),
            ("600001", "1"),
            ("x", "1"),
            ("1", "0"),
            ("1", "65537"),
            ("-1", "1"),
        ] {
            assert_eq!(set(t, w).unwrap_err().code, INVALID_ARGUMENT, "{t} {w}");
        }
    }

    #[test]
    fn replica_keys_are_recognised_and_nothing_else() {
        assert!(is_replica_key(&replica_key("r1")));
        assert!(is_replica_key(&replica_detach_key("r1")));
        assert!(!is_replica_key(&keys::meta("format")));
        assert!(!is_replica_key(&keys::meta("promotion/x")));
        assert!(!is_replica_key(b"Xreplica/r1"));
    }

    #[test]
    fn replica_ids_are_checked() {
        assert!(check_id("follower-1:a.b_c").is_ok());
        for bad in ["", "a/b", "a b", &"x".repeat(129)] {
            assert!(check_id(bad).is_err(), "{bad}");
        }
    }
}
