//! Fjall (an LSM tree) as a `Kv`, for the storage bake-off only. Built with the `fjall` cargo
//! feature, which is off by default: the addon does not link it and no brain opens on it.
//!
//! The layout copies `redb_kv`: all records live in one keyspace, `data`, and the commit sequence
//! is kept under key `\0seq`, written in the same atomic batch as the records it counts. Fjall has
//! no write transaction of its own here, so a writer holds a snapshot plus its pending writes
//! (reads see them), and `commit` writes everything as one batch synced to disk. One writer runs
//! at a time, as on redb; `OccKv` over this `Kv` gives many.

use crate::error::{Result, STORE_CORRUPT, STORE_LOCKED, StoreError};
use crate::kv::{Kv, KvRead, KvWrite};
use crate::occ_kv::{OccBase, OccKv};
use fjall::{Database, Keyspace, KeyspaceCreateOptions, PersistMode, Readable, Snapshot};
use std::collections::BTreeMap;
use std::ops::Bound;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};

const SEQ_KEY: &[u8] = b"\0seq";

type Entries = Box<dyn Iterator<Item = Result<(Vec<u8>, Vec<u8>)>>>;
type Pending<'a> = Box<dyn Iterator<Item = (&'a Vec<u8>, &'a Option<Vec<u8>>)> + 'a>;

fn map(error: impl std::fmt::Display) -> StoreError {
    StoreError::io(format!("record store (fjall): {error}"))
}

fn decode_seq(bytes: &[u8]) -> Result<u64> {
    let array: [u8; 8] = bytes
        .try_into()
        .map_err(|_| StoreError::new(STORE_CORRUPT, "the commit sequence record is malformed"))?;
    Ok(u64::from_be_bytes(array))
}

fn reject_reserved(key: &[u8]) -> Result<()> {
    if key.first() == Some(&0) {
        return Err(StoreError::invalid(
            "keys starting with byte 0 are reserved",
        ));
    }
    Ok(())
}

/// The single-writer turn: `begin_write` waits until the previous writer commits or drops.
#[derive(Default)]
struct Turn {
    busy: Mutex<bool>,
    free: Condvar,
}

struct TurnGuard(Arc<Turn>);

impl Turn {
    fn take(self: &Arc<Self>) -> TurnGuard {
        let mut busy = self.busy.lock().unwrap_or_else(|p| p.into_inner());
        while *busy {
            busy = self.free.wait(busy).unwrap_or_else(|p| p.into_inner());
        }
        *busy = true;
        TurnGuard(self.clone())
    }
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        *self.0.busy.lock().unwrap_or_else(|p| p.into_inner()) = false;
        self.0.free.notify_one();
    }
}

pub struct FjallKv {
    db: Database,
    data: Keyspace,
    turn: Arc<Turn>,
}

impl FjallKv {
    /// Opens (creating if absent) a fjall database in directory `dir`.
    pub fn open_dir(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)
            .map_err(|e| StoreError::io(format!("creating {}: {e}", dir.display())))?;
        let db = Database::builder(dir).open().map_err(|e| match e {
            fjall::Error::Locked => StoreError::new(
                STORE_LOCKED,
                "another handle or process already has this brain open",
            ),
            other => map(other),
        })?;
        let data = db
            .keyspace("data", KeyspaceCreateOptions::default)
            .map_err(map)?;
        Ok(Self {
            db,
            data,
            turn: Arc::new(Turn::default()),
        })
    }
}

impl OccKv {
    /// The optimistic layer over a fjall database (bake-off only).
    pub fn new_fjall(base: FjallKv) -> Result<OccKv> {
        Self::over(Arc::new(base))
    }
}

struct Snap {
    snap: Snapshot,
    data: Keyspace,
}

fn snap_get(snap: &Snapshot, data: &Keyspace, key: &[u8]) -> Result<Option<Vec<u8>>> {
    Ok(snap.get(data, key).map_err(map)?.map(|v| v.to_vec()))
}

/// Entries of `[start, end)` in the snapshot, skipping the adapter's 0x00 keys.
fn snap_range(
    snap: &Snapshot,
    data: &Keyspace,
    start: &[u8],
    end: &[u8],
    reverse: bool,
) -> Entries {
    let start = if start.first().is_none_or(|b| *b == 0) {
        vec![1u8]
    } else {
        start.to_vec()
    };
    if start.as_slice() >= end {
        return Box::new(std::iter::empty());
    }
    let iter = snap.range(data, start..end.to_vec()).map(|g| {
        g.into_inner()
            .map(|(k, v)| (k.to_vec(), v.to_vec()))
            .map_err(map)
    });
    if reverse {
        Box::new(iter.rev())
    } else {
        Box::new(iter)
    }
}

impl KvRead for Snap {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        snap_get(&self.snap, &self.data, key)
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        for item in snap_range(&self.snap, &self.data, start, end, reverse) {
            let (k, v) = item?;
            if !f(&k, &v) {
                break;
            }
        }
        Ok(())
    }
}

struct Writer {
    db: Database,
    snap: Snapshot,
    data: Keyspace,
    pending: BTreeMap<Vec<u8>, Option<Vec<u8>>>,
    _turn: TurnGuard,
}

impl KvRead for Writer {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        match self.pending.get(key) {
            Some(value) => Ok(value.clone()),
            None => snap_get(&self.snap, &self.data, key),
        }
    }

    /// Merges the snapshot's entries with the pending writes (a pending write wins; a pending
    /// delete hides the entry).
    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        let lo = if start.first().is_none_or(|b| *b == 0) {
            &[1u8][..]
        } else {
            start
        };
        if lo >= end {
            return Ok(());
        }
        let range = self
            .pending
            .range::<[u8], _>((Bound::Included(lo), Bound::Excluded(end)));
        let mut overlay: Pending<'_> = if reverse {
            Box::new(range.rev())
        } else {
            Box::new(range)
        };
        let mut base = snap_range(&self.snap, &self.data, lo, end, reverse);
        let mut next_base = base.next().transpose()?;
        let mut next_over = overlay.next();
        loop {
            // Which side comes first in scan order; equal keys take the pending write.
            let take_base = match (&next_base, &next_over) {
                (None, None) => return Ok(()),
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (Some((bk, _)), Some((ok, _))) => {
                    if reverse {
                        bk.as_slice() > ok.as_slice()
                    } else {
                        bk.as_slice() < ok.as_slice()
                    }
                }
            };
            if take_base {
                let (k, v) = next_base.take().expect("checked above");
                next_base = base.next().transpose()?;
                if !f(&k, &v) {
                    return Ok(());
                }
            } else {
                let (k, v) = next_over.take().expect("checked above");
                if next_base.as_ref().is_some_and(|(bk, _)| bk == k) {
                    next_base = base.next().transpose()?;
                }
                next_over = overlay.next();
                if let Some(v) = v
                    && !f(k, v)
                {
                    return Ok(());
                }
            }
        }
    }
}

impl KvWrite for Writer {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        reject_reserved(key)?;
        self.pending.insert(key.to_vec(), Some(value.to_vec()));
        Ok(())
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        reject_reserved(key)?;
        self.pending.insert(key.to_vec(), None);
        Ok(())
    }

    fn commit(self: Box<Self>) -> Result<u64> {
        // The writer holds the turn since before its snapshot, so the snapshot is the latest.
        let current = match snap_get(&self.snap, &self.data, SEQ_KEY)? {
            Some(bytes) => decode_seq(&bytes)?,
            None => 0,
        };
        let next = current + 1;
        let mut batch = self.db.batch().durability(Some(PersistMode::SyncAll));
        for (key, value) in &self.pending {
            match value {
                Some(v) => batch.insert(&self.data, key.as_slice(), v.as_slice()),
                None => batch.remove(&self.data, key.as_slice()),
            }
        }
        batch.insert(&self.data, SEQ_KEY, next.to_be_bytes().as_slice());
        batch.commit().map_err(map)?;
        Ok(next)
    }
}

impl Kv for FjallKv {
    fn snapshot(&self) -> Result<Box<dyn KvRead>> {
        Ok(Box::new(Snap {
            snap: self.db.snapshot(),
            data: self.data.clone(),
        }))
    }

    fn versioned_snapshot(&self) -> Result<(Box<dyn KvRead + Send>, u64)> {
        let snap = self.db.snapshot();
        let version = match snap_get(&snap, &self.data, SEQ_KEY)? {
            Some(bytes) => decode_seq(&bytes)?,
            None => 0,
        };
        Ok((
            Box::new(Snap {
                snap,
                data: self.data.clone(),
            }),
            version,
        ))
    }

    fn begin_write(&self) -> Result<Box<dyn KvWrite>> {
        let turn = self.turn.take();
        Ok(Box::new(Writer {
            db: self.db.clone(),
            snap: self.db.snapshot(),
            data: self.data.clone(),
            pending: BTreeMap::new(),
            _turn: turn,
        }))
    }

    fn version(&self) -> Result<u64> {
        Ok(self.versioned_snapshot()?.1)
    }
}

impl OccBase for FjallKv {}
