//! The keyword index's health check and its rebuild from the records: what `gbrain doctor` reports
//! as `rust_derived_indexes` and what `gbrain doctor --fix` runs (docs/designs/RUST_ENGINE.md,
//! "Maintenance path"; rust/docs/store/keyword.md, "Doctor").
//!
//! The keyword index (`R` records, `index.rs`) is the only derived index the store keeps on disk.
//! It lives in `records.redb` with the records and is written in the same transaction as each
//! record, so it has no outbox to replay; it goes wrong only when its records are damaged or its
//! build stops. [`check`] reads one snapshot and writes nothing: the state record (absent,
//! unreadable, of another layout, incomplete or complete), whether the postings serve, how the
//! background build of this handle ended, and for a complete state the postings of the first
//! `max_pages` pages compared with the postings rebuilt from their records (`index_build.rs`
//! `verify`).
//!
//! [`rebuild`] resets the index and runs build batches until the state is complete (unless the
//! state is complete and every posting matches the records already), each in its own write
//! transaction, through a handle ([`IndexOnly`]) that refuses any write outside the `R`
//! tag, so a rebuild changes no record but the index's own; the receipt counts its writes.
//!
//! The same check and rebuild cover the core term postings (`keys::POSTING`, `T`) in
//! `term_health.rs`: [`check`] compares them over the same pages, and [`rebuild`] repairs them in
//! place first, through a handle that refuses any write outside the `T` tag.

use serde::Serialize;

use super::index::{INDEX_VERSION, StateRecord, read_state_record, serves};
use super::index_build::{
    BATCH_PAGES, KeywordIndexReport, KeywordIndexState, build_batch, reset, verify,
};
use super::term_health::{self, TermPostingsReport};
use crate::Store;
use crate::error::{INVALID_STATE, Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite};

/// What [`check`] found about the keyword index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeywordIndexHealth {
    /// `"keyword"`: the index this row is about.
    pub index: &'static str,
    /// `ok` (complete, and the checked postings match the records), `mismatch` (complete, but a
    /// checked posting is missing, changed or orphan: keyword results can be wrong), `building`
    /// (incomplete, and this handle's build is running), `stalled` (incomplete, and no build is
    /// running here), `unreadable` (the state record does not parse: every member scans),
    /// `absent` (no state record: the store keeps no postings) or `other_layout` (a state of
    /// another index layout).
    pub status: &'static str,
    pub state: Option<KeywordIndexState>,
    /// The parse error of an unreadable state record.
    pub state_error: Option<String>,
    /// Whether keyword reads use the postings now (false while they scan).
    pub served: bool,
    /// This handle's background build: `none` (never started here), `running`, `finished` or
    /// `failed`.
    pub builder: &'static str,
    /// The error that ended a failed build.
    pub builder_error: Option<String>,
    /// The posting comparison, for a complete state.
    pub verify: Option<KeywordIndexReport>,
    /// The core term postings (`T`) compared with the chunks of the same pages, whatever the
    /// keyword index state.
    pub terms: TermPostingsReport,
}

/// Reads the keyword index's health from one snapshot (see the module docs). `builder` is this
/// handle's build status and its failure; `max_pages` bounds the posting comparison.
pub(crate) fn check(
    read: &dyn KvRead,
    builder: (&'static str, Option<String>),
    max_pages: Option<u64>,
) -> Result<KeywordIndexHealth> {
    let served = serves(read)?;
    let (status, state, state_error, report) = match read_state_record(read)? {
        StateRecord::Unreadable(error) => ("unreadable", None, Some(error), None),
        StateRecord::Absent => ("absent", None, None, None),
        StateRecord::Present(s) if s.version != INDEX_VERSION => {
            ("other_layout", Some(s), None, None)
        }
        StateRecord::Present(s) if !s.complete => {
            let status = if builder.0 == "running" {
                "building"
            } else {
                "stalled"
            };
            (status, Some(s), None, None)
        }
        StateRecord::Present(s) => {
            let report = verify(read, max_pages)?;
            let status = if report.ok { "ok" } else { "mismatch" };
            (status, Some(s), None, Some(report))
        }
    };
    let terms = term_health::verify(read, max_pages)?;
    Ok(KeywordIndexHealth {
        index: "keyword",
        status,
        state: state.map(Into::into),
        state_error,
        served,
        builder: builder.0,
        builder_error: builder.1,
        verify: report,
        terms,
    })
}

/// What [`rebuild`] did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct KeywordIndexRebuild {
    /// `"keyword"`.
    pub index: &'static str,
    /// Write transactions the rebuild committed: each term posting batch, then the reset and each
    /// build batch (none when the keyword index already matched its records).
    pub transactions: u64,
    /// Index records the rebuild put and deleted (the state record included).
    pub index_puts: u64,
    pub index_deletes: u64,
    /// Core term postings (`T`) the repair put and deleted.
    pub term_puts: u64,
    pub term_deletes: u64,
    /// Records outside the two indexes the rebuild wrote: always 0, as its handles refuse them.
    pub record_writes: u64,
    /// The state the rebuild left: complete.
    pub state: KeywordIndexState,
}

/// Repairs the core term postings in place, then resets the keyword index and builds it again from
/// the records, batch by batch, until the state is complete (see the module docs). A keyword index
/// that is complete and matches every record is left as it is, so repairing only the term
/// postings never sends keyword search to the scan. A running background build may run batches at
/// the same time; both rebuild the same postings from the same records.
pub(crate) fn rebuild(store: &Store) -> Result<KeywordIndexRebuild> {
    let terms = term_health::repair(store)?;
    let sound = {
        let read = store.read()?;
        match read_state_record(&*read)? {
            StateRecord::Present(s) if s.version == INDEX_VERSION && s.complete => {
                verify(&*read, None)?.ok.then_some(s)
            }
            _ => None,
        }
    };
    let mut receipt = KeywordIndexRebuild {
        index: "keyword",
        transactions: terms.transactions,
        index_puts: 0,
        index_deletes: 0,
        term_puts: terms.puts,
        term_deletes: terms.deletes,
        record_writes: 0,
        state: KeywordIndexState {
            version: INDEX_VERSION,
            complete: false,
            cursor: Some(0),
        },
    };
    if let Some(state) = sound {
        receipt.state = state.into();
        return Ok(receipt);
    }
    let (puts, deletes) = store.write(|w| {
        let mut only = IndexOnly::new(w, keys::TRIGRAM);
        reset(&mut only)?;
        Ok((only.puts, only.deletes))
    })?;
    receipt.transactions += 1;
    receipt.index_puts += puts;
    receipt.index_deletes += deletes;
    loop {
        let (state, puts, deletes) = store.write(|w| {
            let mut only = IndexOnly::new(w, keys::TRIGRAM);
            let state = build_batch(&mut only, BATCH_PAGES)?;
            Ok((state, only.puts, only.deletes))
        })?;
        receipt.transactions += 1;
        receipt.index_puts += puts;
        receipt.index_deletes += deletes;
        match state {
            Some(s) if s.version == INDEX_VERSION && s.complete => {
                receipt.state = s.into();
                return Ok(receipt);
            }
            Some(s) if s.version == INDEX_VERSION => {}
            _ => {
                return Err(StoreError::new(
                    INVALID_STATE,
                    "the keyword index state changed under the rebuild; run gbrain doctor --fix again",
                ));
            }
        }
    }
}

/// A write handle that passes only the writes of one index tag (`R`, the keyword index, or `T`,
/// the core term postings) and counts them.
pub(super) struct IndexOnly<'a> {
    inner: &'a mut dyn KvWrite,
    tag: u8,
    pub(super) puts: u64,
    pub(super) deletes: u64,
}

impl<'a> IndexOnly<'a> {
    pub(super) fn new(inner: &'a mut dyn KvWrite, tag: u8) -> Self {
        Self {
            inner,
            tag,
            puts: 0,
            deletes: 0,
        }
    }

    fn guard(&self, key: &[u8]) -> Result<()> {
        if key.first() == Some(&self.tag) {
            return Ok(());
        }
        Err(StoreError::new(
            INVALID_STATE,
            "the keyword index rebuild tried to write a record outside the index; nothing was kept",
        ))
    }
}

impl KvRead for IndexOnly<'_> {
    fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        self.inner.get(key)
    }

    fn scan(
        &self,
        start: &[u8],
        end: &[u8],
        reverse: bool,
        f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
    ) -> Result<()> {
        self.inner.scan(start, end, reverse, f)
    }
}

// The counter primitives keep their defaults, which read and write through `put`, so they meet
// the same guard.
impl KvWrite for IndexOnly<'_> {
    fn put(&mut self, key: &[u8], value: &[u8]) -> Result<()> {
        self.guard(key)?;
        self.puts += 1;
        self.inner.put(key, value)
    }

    fn delete(&mut self, key: &[u8]) -> Result<()> {
        self.guard(key)?;
        self.deletes += 1;
        self.inner.delete(key)
    }

    fn commit(self: Box<Self>) -> Result<u64> {
        Err(StoreError::new(
            INVALID_STATE,
            "a store write handle commits with its write, not on its own",
        ))
    }
}

#[cfg(test)]
mod tests;
