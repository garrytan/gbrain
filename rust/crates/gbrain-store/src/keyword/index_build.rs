//! Building, checking and rebuilding the keyword index (docs/plans/rust-keyword-index.md, D6a).
//!
//! Format 4 means "this store keeps keyword postings". A fresh store starts with a complete,
//! empty index ([`seed_complete`]). The upgrade to format 4 and [`reset`] clear every `R` record
//! and write an incomplete state with cursor 0 in the same transaction, so a crash leaves the old
//! store or the new one.
//!
//! While the state is incomplete, a background thread owned by the `Store` ([`Builder`]) runs
//! [`build_batch`] until the index is complete: each batch rebuilds the postings of the next
//! [`BATCH_PAGES`] pages in page-id order (`I page_id`), with their chunks, and moves the cursor
//! in the same transaction, through `Store::write` and its OCC retry. Only the batch that finds no
//! page past the cursor marks the state complete. Every write keeps the postings of the documents
//! it touches in step while the state exists (`index_writer.rs`), so a page behind the cursor is
//! always current and a page ahead is rebuilt by its batch. The thread stops when the `Store` is
//! dropped, after its current batch, and the next open resumes from the cursor. Reads use the
//! postings only once their own snapshot holds a complete state (`index.rs` `serves`).
//!
//! [`verify`] compares the stored records with the records rebuilt from the pages and chunks.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use super::index::{
    INDEX_VERSION, IndexState, StateRecord, expected_records, read_state, read_state_record,
    reindex_page_and_chunks,
};
use crate::error::{FORMAT_UNKNOWN, Result, StoreError};
use crate::keys;
use crate::kv::{Kv, KvRead, KvWrite, scan_prefix};
use crate::{Store, put_json};

/// Pages one build batch reindexes.
pub(crate) const BATCH_PAGES: usize = 256;

/// How long dropping a `Store` waits for its builder's current batch.
const STOP_WAIT: Duration = Duration::from_secs(30);

fn write_state(w: &mut dyn KvWrite, state: &IndexState) -> Result<()> {
    put_json(w, &keys::keyword_index_state(), state)
}

/// The state a fresh store starts with: complete, as it has no documents.
pub(crate) fn seed_complete(w: &mut dyn KvWrite) -> Result<()> {
    write_state(
        w,
        &IndexState {
            version: INDEX_VERSION,
            complete: true,
            cursor: None,
        },
    )
}

/// Deletes every `R` record and writes an incomplete state with cursor 0.
pub(crate) fn reset(w: &mut dyn KvWrite) -> Result<()> {
    let mut stale = Vec::new();
    scan_prefix(&*w, &[keys::TRIGRAM], false, &mut |k, _| {
        stale.push(k.to_vec());
        true
    })?;
    for key in stale {
        w.delete(&key)?;
    }
    write_state(
        w,
        &IndexState {
            version: INDEX_VERSION,
            complete: false,
            cursor: Some(0),
        },
    )
}

/// What [`open_index`] found.
pub(crate) struct IndexOpen {
    /// The index is incomplete: the build should run.
    pub needs_build: bool,
}

/// Run by every open, after the format upgrade: refuses an index of a newer layout, writes an
/// incomplete state when a format-4 brain has none (a self-heal; the build fills it) and resets an
/// index of an older layout. A state record that does not parse is left as it is, with no build:
/// the members scan, and `gbrain doctor` reports it until `--fix` rebuilds the index
/// (`index_health.rs`).
pub(crate) fn open_index(kv: &dyn Kv) -> Result<IndexOpen> {
    match check_state(&*kv.snapshot()?)? {
        StateRecord::Unreadable(_) => return Ok(IndexOpen { needs_build: false }),
        StateRecord::Present(s) if s.version == INDEX_VERSION => {
            return Ok(IndexOpen {
                needs_build: !s.complete,
            });
        }
        _ => {}
    }
    let mut tx = kv.begin_write_exclusive()?;
    // Another handle may have repaired it first; judge the state again inside the transaction.
    let needs_build = match check_state(&*tx)? {
        StateRecord::Present(s) if s.version == INDEX_VERSION => !s.complete,
        StateRecord::Unreadable(_) => false,
        _ => {
            reset(&mut *tx)?;
            true
        }
    };
    tx.commit()?;
    Ok(IndexOpen { needs_build })
}

/// Refuses a state written by a build with a newer index layout, before anything is written.
pub(crate) fn check_state(read: &dyn KvRead) -> Result<StateRecord> {
    let state = read_state_record(read)?;
    if let StateRecord::Present(s) = &state
        && s.version > INDEX_VERSION
    {
        return Err(StoreError::new(
            FORMAT_UNKNOWN,
            format!(
                "this brain's keyword index has version {}, newer than the version this build keeps ({INDEX_VERSION}); nothing was changed",
                s.version
            ),
        ));
    }
    Ok(state)
}

/// The page ids from `start` on, ascending, at most `limit`.
pub(super) fn page_ids_from(read: &dyn KvRead, start: u64, limit: usize) -> Result<Vec<u64>> {
    let mut ids = Vec::new();
    if limit == 0 {
        return Ok(ids);
    }
    read.scan(
        &keys::page_id(start),
        &[keys::PAGE_ID + 1],
        false,
        &mut |k, _| {
            if let Some(id) = keys::be8(&k[1..]) {
                ids.push(id);
            }
            ids.len() < limit
        },
    )?;
    Ok(ids)
}

/// Reindexes the next `max_pages` pages past the cursor and moves it; marks the state complete
/// when no page is left past them. Returns the state as the batch leaves it (`None`: no state).
pub(crate) fn build_batch(w: &mut dyn KvWrite, max_pages: usize) -> Result<Option<IndexState>> {
    let Some(mut state) = read_state(&*w)? else {
        return Ok(None);
    };
    if state.complete || state.version != INDEX_VERSION {
        return Ok(Some(state));
    }
    let max_pages = max_pages.max(1);
    let ids = page_ids_from(&*w, state.cursor.unwrap_or(0), max_pages + 1)?;
    for &id in ids.iter().take(max_pages) {
        reindex_page_and_chunks(w, id)?;
    }
    match ids.get(max_pages) {
        Some(&next) => state.cursor = Some(next),
        None => {
            state.complete = true;
            state.cursor = None;
        }
    }
    write_state(w, &state)?;
    Ok(Some(state))
}

/// What [`verify`] found. `orphan` counts records no document should hold; it is `None` when
/// `max_pages` stopped the walk before the last page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeywordIndexReport {
    pub state: Option<KeywordIndexState>,
    pub pages: u64,
    pub expected: u64,
    pub missing: u64,
    pub changed: u64,
    pub orphan: Option<u64>,
    pub ok: bool,
}

/// The index state as the store API reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeywordIndexState {
    pub version: u32,
    pub complete: bool,
    pub cursor: Option<u64>,
}

impl From<IndexState> for KeywordIndexState {
    fn from(s: IndexState) -> Self {
        Self {
            version: s.version,
            complete: s.complete,
            cursor: s.cursor,
        }
    }
}

/// The first `max_pages` page ids (all of them when `None`), ascending, and whether that is every
/// page (the walk reached the last one).
pub(super) fn checked_page_ids(
    read: &dyn KvRead,
    max_pages: Option<u64>,
) -> Result<(Vec<u64>, bool)> {
    let mut complete_walk = true;
    let mut ids = Vec::new();
    scan_prefix(read, &[keys::PAGE_ID], false, &mut |k, _| {
        if max_pages.is_some_and(|m| ids.len() as u64 >= m) {
            complete_walk = false;
            return false;
        }
        if let Some(id) = keys::be8(&k[1..]) {
            ids.push(id);
        }
        true
    })?;
    Ok((ids, complete_walk))
}

/// Compares the stored `R` records with the records rebuilt from the first `max_pages` pages (all
/// of them when `None`) and their chunks. A record is missing when the store lacks it, changed
/// when its value differs, and orphan when no page's rebuild has it (counted only when the walk
/// covered every page: stored records minus the expected ones found).
pub(crate) fn verify(read: &dyn KvRead, max_pages: Option<u64>) -> Result<KeywordIndexReport> {
    // An unreadable state reports as none; the postings are compared all the same.
    let state = match read_state_record(read)? {
        StateRecord::Present(s) => Some(s),
        StateRecord::Absent | StateRecord::Unreadable(_) => None,
    };
    let (mut pages, mut expected, mut missing, mut changed) = (0u64, 0u64, 0u64, 0u64);
    let (ids, complete_walk) = checked_page_ids(read, max_pages)?;
    for id in ids {
        pages += 1;
        for (key, value) in expected_records(read, id)? {
            expected += 1;
            match read.get(&key)? {
                None => missing += 1,
                Some(stored) if stored != value => changed += 1,
                Some(_) => {}
            }
        }
    }
    let orphan = if complete_walk {
        let state_key = keys::keyword_index_state();
        let mut stored = 0u64;
        scan_prefix(read, &[keys::TRIGRAM], false, &mut |k, _| {
            stored += u64::from(k != state_key.as_slice());
            true
        })?;
        Some(stored - (expected - missing))
    } else {
        None
    };
    let ok = missing == 0 && changed == 0 && orphan.unwrap_or(0) == 0;
    Ok(KeywordIndexReport {
        state: state.map(Into::into),
        pages,
        expected,
        missing,
        changed,
        orphan,
        ok,
    })
}

/// The background build of one `Store` (see the module docs). Dropping it stops the thread after
/// its current batch.
pub(crate) struct Builder {
    stop: Arc<AtomicBool>,
    done: Receiver<()>,
    /// The error that ended the build, when a batch failed (`index_health.rs` reports it).
    failure: Arc<Mutex<Option<String>>>,
}

impl Builder {
    /// Runs batches on `store` (a handle on the same records) until the index is complete, a batch
    /// fails (the error is kept for `gbrain doctor`; the next open resumes) or the builder is
    /// dropped.
    pub(crate) fn start(store: Store) -> Builder {
        let stop = Arc::new(AtomicBool::new(false));
        let failure = Arc::new(Mutex::new(None));
        let (tx, done) = channel();
        let flag = stop.clone();
        let failed = failure.clone();
        std::thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                match store.write(|w| build_batch(w, BATCH_PAGES)) {
                    Ok(Some(state)) if !state.complete => std::thread::yield_now(),
                    Ok(_) => break,
                    Err(e) => {
                        *failed.lock().unwrap_or_else(|p| p.into_inner()) =
                            Some(format!("{}: {}", e.code, e.message));
                        break;
                    }
                }
            }
            drop(store);
            let _ = tx.send(());
        });
        Builder {
            stop,
            done,
            failure,
        }
    }

    /// True once the thread has ended.
    pub(crate) fn finished(&self) -> bool {
        !matches!(
            self.done.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        )
    }

    /// The error that ended the build, if a batch failed.
    pub(crate) fn failure(&self) -> Option<String> {
        self.failure
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

impl Drop for Builder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = self.done.recv_timeout(STOP_WAIT);
    }
}

#[cfg(test)]
mod tests;
