//! Commit positions, write origins and the commit log (multi-user mode, `GBRAIN_RUST_MULTIUSER=1`).
//!
//! Every commit that reaches the record file gets its own [`CommitPosition`]: the record file's
//! commit sequence plus the transaction's place in the group commit that carried it (always 0 on
//! the single-writer store). A completion that commits nothing (a transaction with no writes on the
//! optimistic store, a transaction opened read-only) returns [`CommitPosition::end_of`] its snapshot:
//! at or after every commit of that batch and before the next one, so a position never goes back.
//!
//! With the log on, the store also writes one commit record per commit, in the same redb write
//! transaction as the records it changed (`redb_kv.rs` for the single-writer store, the pipeline in
//! `occ_kv.rs` for the optimistic one), so no record exists without its data and no data without its
//! record. Layout (`rust/docs/store/commit-log.md`):
//!
//! - `2` alone: the log's meta record, JSON `{ since, newest, trimmed_through }`, rewritten by every
//!   logged commit. `since` is the activation commit; every commit after it has a record.
//! - `2 sequence_be8 index_be4`: one commit record (I-4.v2). Value: `[version u8 = 2]` `[3 length-prefixed
//!   UTF-8 strings: host id, incarnation, writer id]` `[commit time: i64 big-endian, microseconds since
//!   the Unix epoch, UTC]` `[u32 count of write ids, each length-prefixed]`
//!   `[u32 count of ops, each: op u8, key length-prefixed, operand length-prefixed]`. Lengths and
//!   counts are u32 big-endian. Ops: 1 put (operand: the full value), 2 delete (empty operand), 3
//!   `add_i64` (operand: the delta, 8 bytes little-endian, as the counter is stored), 4
//!   `raise_counter` (operand: the value, 8 bytes big-endian, as an id sequence is stored).
//!
//! The tag is declared here, not in `keys.rs`: a brain opened with the switch off never holds it,
//! and the keyspace catalog (`keyspaces.rs`, `listCatalogRelations`) stays as it is while off. It is
//! claimed in the tag registry of docs/designs/RUST_ENGINE_INTERFACES.md.
//!
//! Retention: the log keeps at most `retention_bytes` of records (keys plus values, 64 MiB by
//! default). A commit that appends trims the oldest records until the rest fit, which can trim every
//! record, the new ones included; `trimmed_through` in the meta record says how far it went, so a
//! reader still knows where the log stands. Log upkeep (the meta record, trims) is not itself logged.

use crate::env::Env;
use crate::error::{INVALID_ARGUMENT, INVALID_STATE, Result, STORE_CORRUPT, StoreError};
use crate::kv::{KvRead, KvWrite, prefix_end};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// The commit log's one-byte key tag.
pub const COMMIT_LOG: u8 = b'2';
/// The version byte every commit record starts with.
pub const RECORD_VERSION: u8 = 2;
/// The default retention cap: 64 MiB of records.
pub const DEFAULT_RETENTION_BYTES: u64 = 64 << 20;

const OP_PUT: u8 = 1;
const OP_DELETE: u8 = 2;
const OP_ADD_I64: u8 = 3;
const OP_RAISE_COUNTER: u8 = 4;

/// Where one commit sits in the brain's commit order: the record file's commit sequence, then
/// the transaction's place in that group commit. Ordered by `(sequence, index)`.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
pub struct CommitPosition {
    pub sequence: u64,
    pub index: u32,
}

impl CommitPosition {
    pub const fn new(sequence: u64, index: u32) -> Self {
        Self { sequence, index }
    }

    /// The position a completion that commits nothing reports when it saw batch `sequence`: after
    /// every commit of that batch and before the first commit of the next.
    pub const fn end_of(sequence: u64) -> Self {
        Self {
            sequence,
            index: u32::MAX,
        }
    }

    /// The read token form (I-2): `cp1:<sequence>.<index>`.
    pub fn token(&self) -> String {
        format!("cp1:{}.{}", self.sequence, self.index)
    }

    /// Parses a read token; `invalid_argument` for anything but `cp1:<u64>.<u32>`.
    pub fn parse_token(text: &str) -> Result<Self> {
        let bad = || {
            StoreError::new(
                INVALID_ARGUMENT,
                format!("not a commit position token: {text:?}"),
            )
        };
        let rest = text.strip_prefix("cp1:").ok_or_else(bad)?;
        let (s, i) = rest.split_once('.').ok_or_else(bad)?;
        let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
        if !digits(s) || !digits(i) {
            return Err(bad());
        }
        Ok(Self {
            sequence: s.parse().map_err(|_| bad())?,
            index: i.parse().map_err(|_| bad())?,
        })
    }

    /// True when `self` is the commit right after `prev` in a gap-free log: the next transaction
    /// of the same batch, or the first of the next batch.
    pub fn follows(&self, prev: CommitPosition) -> bool {
        (prev.index != u32::MAX
            && self.sequence == prev.sequence
            && Some(self.index) == prev.index.checked_add(1))
            || (Some(self.sequence) == prev.sequence.checked_add(1) && self.index == 0)
    }
}

pub use crate::write_origin::WriteOrigin;

/// An origin with every field empty: what a record carries when the store knows no origin.
pub fn no_origin() -> WriteOrigin {
    WriteOrigin {
        host_id: String::new(),
        incarnation: String::new(),
        writer_id: String::new(),
    }
}

/// What a commit says about itself beyond its changes: set on the record file's write before it
/// commits (`KvWrite::set_commit_meta`). `None` origin: the store's own (host, incarnation, no writer).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommitMeta {
    pub origin: Option<WriteOrigin>,
    /// The persistence request ids the commit carries, in the order they were noted.
    pub write_ids: Vec<String>,
}

impl CommitMeta {
    /// Adds the ids and, when `self` has none yet, the writer of `other`.
    pub(crate) fn absorb(&mut self, other: CommitMeta) {
        for id in other.write_ids {
            if !self.write_ids.contains(&id) {
                self.write_ids.push(id);
            }
        }
        if self.origin.is_none() {
            self.origin = other.origin;
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.origin.is_none() && self.write_ids.is_empty()
    }
}

/// One logical change of a commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogOp {
    Put(Vec<u8>),
    Delete,
    AddI64(i64),
    RaiseCounter(u64),
}

/// One commit record, as `read_commit_log` returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitRecord {
    pub position: CommitPosition,
    pub origin: WriteOrigin,
    /// The commit's time (`CommitClock`): strictly increasing in position order across the log.
    pub commit_time: i64,
    pub write_ids: Vec<String>,
    /// In key order; at most one op per key.
    pub ops: Vec<(Vec<u8>, LogOp)>,
}

/// One timeline of a log's history (`LogMeta::lineage`): a promotion starts a new one at the
/// position the promoted follower had reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Timeline {
    /// A UUID v7 minted at the promotion.
    pub id: String,
    /// The last commit the new timeline shares with the one before it.
    pub from: CommitPosition,
}

/// True when a follower whose applied history is `mine`, at `cursor`, may continue from a log
/// whose history is `theirs`: `mine` is a prefix of `theirs`, and every newer timeline starts at
/// or after `cursor`, so the history up to the cursor is common. Otherwise the follower holds
/// commits the log does not, and must install a snapshot.
pub fn lineage_continues(mine: &[Timeline], cursor: CommitPosition, theirs: &[Timeline]) -> bool {
    theirs.len() >= mine.len()
        && theirs[..mine.len()] == *mine
        && theirs[mine.len()..].iter().all(|t| t.from >= cursor)
}

/// The log's meta record (key `2`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogMeta {
    /// The activation commit. Every commit after it has a record (until retention trims it).
    pub since: CommitPosition,
    /// The newest commit with a record (or `since` before the first).
    pub newest: CommitPosition,
    /// The newest commit whose record retention removed, if any.
    pub trimmed_through: Option<CommitPosition>,
    /// The timelines this log went through after its first one, oldest first (`Timeline`). Empty,
    /// and then not written, on a log no promotion ever continued.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lineage: Vec<Timeline>,
}

/// Commit records as the store holds them: each position with its record's bytes, unchanged.
pub type RawRecords = Vec<(CommitPosition, Vec<u8>)>;

/// One page of the log, read from one snapshot (I-4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogPage {
    pub records: Vec<CommitRecord>,
    /// The oldest record the log still holds.
    pub oldest_retained: Option<CommitPosition>,
    /// The newest commit with a record (`since` before the first).
    pub newest: Option<CommitPosition>,
    /// True when the cursor cannot be continued from the log: it is older than `since` or than what
    /// retention trimmed, or past the newest commit. The reader must install a snapshot first.
    pub snapshot_required: bool,
    /// The log's history (`LogMeta::lineage`): a follower checks it with `lineage_continues`.
    pub lineage: Vec<Timeline>,
    /// The brain the log belongs to (its format record's `brain_id`): a follower applies only its
    /// own brain's records.
    pub brain_id: String,
}

/// The key of the meta record.
pub fn meta_key() -> Vec<u8> {
    vec![COMMIT_LOG]
}

/// The key of the commit record at `position`.
pub fn record_key(position: CommitPosition) -> Vec<u8> {
    let mut key = Vec::with_capacity(13);
    key.push(COMMIT_LOG);
    key.extend_from_slice(&position.sequence.to_be_bytes());
    key.extend_from_slice(&position.index.to_be_bytes());
    key
}

/// The position a record key names; `store_corrupt` for any other key under the tag.
pub fn position_of(key: &[u8]) -> Result<CommitPosition> {
    if key.len() != 13 || key[0] != COMMIT_LOG {
        return Err(corrupt(
            "a key under the commit log tag is not a commit record key",
        ));
    }
    Ok(CommitPosition {
        sequence: u64::from_be_bytes(key[1..9].try_into().expect("8 bytes")),
        index: u32::from_be_bytes(key[9..13].try_into().expect("4 bytes")),
    })
}

/// True for every key the commit log owns (the meta record and the records).
pub fn is_log_key(key: &[u8]) -> bool {
    key.first() == Some(&COMMIT_LOG)
}

fn corrupt(why: &str) -> StoreError {
    StoreError::new(STORE_CORRUPT, format!("commit log: {why}"))
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// Encodes a commit record value (the position is in its key).
pub fn encode_record<'a>(
    origin: &WriteOrigin,
    commit_time: i64,
    write_ids: &[String],
    ops: impl IntoIterator<Item = (&'a [u8], LogOpRef<'a>)>,
) -> Vec<u8> {
    let mut out = vec![RECORD_VERSION];
    put_bytes(&mut out, origin.host_id.as_bytes());
    put_bytes(&mut out, origin.incarnation.as_bytes());
    put_bytes(&mut out, origin.writer_id.as_bytes());
    out.extend_from_slice(&commit_time.to_be_bytes());
    out.extend_from_slice(&(write_ids.len() as u32).to_be_bytes());
    for id in write_ids {
        put_bytes(&mut out, id.as_bytes());
    }
    let count_at = out.len();
    out.extend_from_slice(&0u32.to_be_bytes());
    let mut count = 0u32;
    for (key, op) in ops {
        count += 1;
        let (tag, operand): (u8, std::borrow::Cow<'_, [u8]>) = match op {
            LogOpRef::Put(v) => (OP_PUT, v.into()),
            LogOpRef::Delete => (OP_DELETE, (&[][..]).into()),
            LogOpRef::AddI64(d) => (OP_ADD_I64, d.to_le_bytes().to_vec().into()),
            LogOpRef::RaiseCounter(m) => (OP_RAISE_COUNTER, m.to_be_bytes().to_vec().into()),
        };
        out.push(tag);
        put_bytes(&mut out, key);
        put_bytes(&mut out, &operand);
    }
    out[count_at..count_at + 4].copy_from_slice(&count.to_be_bytes());
    out
}

/// Encodes a decoded record back to its value: the encoding is canonical (keys in order, one op
/// each), so this gives the bytes the primary stored.
pub fn encode_commit_record(record: &CommitRecord) -> Vec<u8> {
    encode_record(
        &record.origin,
        record.commit_time,
        &record.write_ids,
        record.ops.iter().map(|(k, op)| {
            (
                k.as_slice(),
                match op {
                    LogOp::Put(v) => LogOpRef::Put(v),
                    LogOp::Delete => LogOpRef::Delete,
                    LogOp::AddI64(d) => LogOpRef::AddI64(*d),
                    LogOp::RaiseCounter(m) => LogOpRef::RaiseCounter(*m),
                },
            )
        }),
    )
}

/// A borrowed op for the encoder.
#[derive(Debug, Clone, Copy)]
pub enum LogOpRef<'a> {
    Put(&'a [u8]),
    Delete,
    AddI64(i64),
    RaiseCounter(u64),
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or_else(|| corrupt("a record is shorter than its lengths say"))?;
        let out = &self.bytes[self.at..end];
        self.at = end;
        Ok(out)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().expect("4 bytes"),
        ))
    }
    fn bytes(&mut self) -> Result<&'a [u8]> {
        let n = self.u32()? as usize;
        self.take(n)
    }
    fn text(&mut self) -> Result<String> {
        String::from_utf8(self.bytes()?.to_vec())
            .map_err(|_| corrupt("a record string is not UTF-8"))
    }
    fn remaining(&self) -> usize {
        self.bytes.len() - self.at
    }
}

/// Decodes the commit record stored under `key`. A version other than `RECORD_VERSION` (v1 was
/// retired before any store outside tests held it) refuses with `format_unknown`: an unknown version
/// is not corruption, and no offset is guessed. Otherwise strict: a length or count
/// past the bytes left, a wrong operand length, an unknown op, a key written twice, invalid UTF-8
/// or trailing bytes refuse with `store_corrupt`.
pub fn decode_record(key: &[u8], value: &[u8]) -> Result<CommitRecord> {
    let position = position_of(key)?;
    let mut c = Cursor {
        bytes: value,
        at: 0,
    };
    let version = c.take(1)?[0];
    if version != RECORD_VERSION {
        return Err(StoreError::new(
            crate::error::FORMAT_UNKNOWN,
            format!(
                "commit log: record version {version} is not one this build reads ({RECORD_VERSION}); nothing was changed"
            ),
        ));
    }
    let origin = WriteOrigin {
        host_id: c.text()?,
        incarnation: c.text()?,
        writer_id: c.text()?,
    };
    let commit_time = i64::from_be_bytes(c.take(8)?.try_into().expect("8 bytes"));
    let ids = c.u32()? as usize;
    // Every id takes at least its 4-byte length: a count past that is a lie, refused before any
    // allocation it would size.
    if ids > c.remaining() / 4 {
        return Err(corrupt("a record names more write ids than its bytes hold"));
    }
    let mut write_ids = Vec::with_capacity(ids);
    for _ in 0..ids {
        write_ids.push(c.text()?);
    }
    let n = c.u32()? as usize;
    if n > c.remaining() / 9 {
        return Err(corrupt("a record names more ops than its bytes hold"));
    }
    let mut ops: Vec<(Vec<u8>, LogOp)> = Vec::with_capacity(n);
    for _ in 0..n {
        let tag = c.take(1)?[0];
        let key = c.bytes()?.to_vec();
        let operand = c.bytes()?;
        let eight = |what: &str| -> Result<[u8; 8]> {
            operand
                .try_into()
                .map_err(|_| corrupt(&format!("a {what} operand is not 8 bytes")))
        };
        let op = match tag {
            OP_PUT => LogOp::Put(operand.to_vec()),
            OP_DELETE if operand.is_empty() => LogOp::Delete,
            OP_DELETE => return Err(corrupt("a delete carries an operand")),
            OP_ADD_I64 => LogOp::AddI64(i64::from_le_bytes(eight("add_i64")?)),
            OP_RAISE_COUNTER => LogOp::RaiseCounter(u64::from_be_bytes(eight("raise_counter")?)),
            other => return Err(corrupt(&format!("op {other} is not known"))),
        };
        if ops.last().is_some_and(|(last, _)| *last >= key) {
            return Err(corrupt(
                "a record's keys are not in strictly increasing order",
            ));
        }
        ops.push((key, op));
    }
    if c.remaining() != 0 {
        return Err(corrupt("a record has bytes after its last op"));
    }
    Ok(CommitRecord {
        position,
        origin,
        commit_time,
        write_ids,
        ops,
    })
}

/// Applies one record's ops to `tx` (a follower's or a check's replay). Ops of one record touch
/// distinct keys, so their order within the record does not matter.
pub fn apply_record(tx: &mut dyn KvWrite, record: &CommitRecord) -> Result<()> {
    for (key, op) in &record.ops {
        match op {
            LogOp::Put(v) => tx.put(key, v)?,
            LogOp::Delete => tx.delete(key)?,
            LogOp::AddI64(d) => tx.add_i64(key, *d)?,
            LogOp::RaiseCounter(m) => tx.raise_counter(key, *m)?,
        }
    }
    Ok(())
}

/// The meta record `read` holds, if the brain keeps a log.
pub fn read_meta(read: &dyn KvRead) -> Result<Option<LogMeta>> {
    match read.get(&meta_key())? {
        None => Ok(None),
        Some(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| corrupt(&format!("the meta record is malformed: {e}"))),
    }
}

fn records_end() -> Vec<u8> {
    prefix_end(&[COMMIT_LOG]).expect("the tag is not 0xFF")
}

/// Reads up to `max` records after `after` (`None`: from `since`), all from `read` (one snapshot).
/// `invalid_state` when the brain keeps no log; `store_corrupt` when the records the meta record
/// promises are not there.
pub fn read_commit_log(
    read: &dyn KvRead,
    after: Option<CommitPosition>,
    max: usize,
) -> Result<LogPage> {
    let meta = read_meta(read)?
        .ok_or_else(|| StoreError::new(INVALID_STATE, "this brain keeps no commit log"))?;
    let mut oldest_retained = None;
    read.scan(
        &record_key(CommitPosition::default()),
        &records_end(),
        false,
        &mut |k, _| {
            oldest_retained = Some(k.to_vec());
            false
        },
    )?;
    let oldest_retained = oldest_retained.map(|k| position_of(&k)).transpose()?;
    let after = after.unwrap_or(meta.since);
    let stale = after < meta.since
        || meta.trimmed_through.is_some_and(|t| after < t)
        || after > meta.newest;
    let mut page = LogPage {
        records: Vec::new(),
        oldest_retained,
        newest: Some(meta.newest),
        snapshot_required: stale,
        lineage: meta.lineage.clone(),
        brain_id: crate::get_json::<serde_json::Value>(read, &crate::keys::meta("format"))?
            .and_then(|f| {
                f.get("brain_id")
                    .and_then(|b| b.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default(),
    };
    if stale || max == 0 || after >= meta.newest {
        return Ok(page);
    }
    // The first record after the cursor must be its successor: the log has no gaps after `since`
    // except what retention trimmed, and the cursor is past that.
    let start = if after.index == u32::MAX {
        record_key(CommitPosition::new(after.sequence.saturating_add(1), 0))
    } else {
        let mut k = record_key(after);
        k.push(0);
        k
    };
    let mut failure = None;
    let mut prev = after;
    read.scan(&start, &records_end(), false, &mut |k, v| {
        match decode_record(k, v) {
            Ok(record) if record.position.follows(prev) => {
                prev = record.position;
                page.records.push(record);
            }
            Ok(record) => {
                failure = Some(corrupt(&format!(
                    "the log jumps from {} to {}",
                    prev.token(),
                    record.position.token()
                )));
            }
            Err(e) => failure = Some(e),
        }
        failure.is_none() && page.records.len() < max
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    if page.records.is_empty() {
        return Err(corrupt(&format!(
            "the meta record says the log reaches {} but no record follows {}",
            meta.newest.token(),
            after.token()
        )));
    }
    Ok(page)
}

/// Writes the meta record of a log that starts at `since` into `tx`: the activation commit, whose
/// own position must be `since` (the caller checks the commit's result).
pub fn write_activation(tx: &mut dyn KvWrite, since: CommitPosition) -> Result<()> {
    let meta = LogMeta {
        since,
        newest: since,
        trimmed_through: None,
        lineage: Vec::new(),
    };
    tx.put(&meta_key(), &serde_json::to_vec(&meta)?)
}

/// One transaction the record file's writer accepted: its position and its commit time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Accepted {
    pub position: CommitPosition,
    pub commit_time: i64,
}

/// The accept hook (`Kv::set_commit_clock`): called once per accepted transaction, in accept order
/// (which is commit order), by the record file's one writer, at the accept step: before the commit
/// is durable, so a commit that then fails was still seen, and while no later transaction can be
/// accepted. For observation only: it holds no policy of the store's, must be quick and must not
/// write to the store.
pub type AcceptHook = std::sync::Arc<dyn Fn(Accepted) + Send + Sync>;

/// Commit times (multi-user mode, lane L5's clock rule): every accepted transaction gets
/// `max(store clock, previous accepted commit time + 1 µs)`, so commit times strictly increase in
/// commit order even when the clock goes back. The record file keeps the newest durable one
/// (`redb_kv::COMMIT_TIME_KEY`) in the same write transaction as the data, so a failed commit
/// leaves no time behind and a restart, or another process opening the same store, continues
/// above it. Owned by the record file's one writer.
pub(crate) struct CommitClock {
    clock: std::sync::Arc<dyn Env>,
    /// The newest durable commit time (0 before the first).
    last: std::sync::Mutex<i64>,
    hook: std::sync::Mutex<Option<AcceptHook>>,
}

impl CommitClock {
    pub(crate) fn new(clock: std::sync::Arc<dyn Env>, last: i64) -> Self {
        Self {
            clock,
            last: std::sync::Mutex::new(last),
            hook: std::sync::Mutex::new(None),
        }
    }

    pub(crate) fn set_hook(&self, hook: Option<AcceptHook>) {
        *self.hook.lock().unwrap_or_else(|p| p.into_inner()) = hook;
    }

    /// The commit time of the transaction accepted at `position`, after `prev` (the time given to
    /// the transaction accepted just before it in the same record-file commit) or, for the first,
    /// after the newest durable time; reported to the hook.
    pub(crate) fn accept(&self, position: CommitPosition, prev: Option<i64>) -> i64 {
        let floor = prev.unwrap_or_else(|| *self.last.lock().unwrap_or_else(|p| p.into_inner()));
        let time = self.clock.clock_micros().max(floor.saturating_add(1));
        let hook = self.hook.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if let Some(hook) = hook {
            hook(Accepted {
                position,
                commit_time: time,
            });
        }
        time
    }

    /// Takes in the newest time of a record-file commit that succeeded.
    pub(crate) fn committed(&self, time: i64) {
        let mut last = self.last.lock().unwrap_or_else(|p| p.into_inner());
        *last = (*last).max(time);
    }
}

/// The floor every later commit time is above, from `read`: the larger of the durable commit time
/// (`redb_kv::COMMIT_TIME_KEY`) and the newest commit record's time (a store rebuilt from the log,
/// or a copy that did not carry the adapter key).
pub fn floor_time(read: &dyn KvRead) -> Result<i64> {
    let mut floor = crate::redb_kv::read_commit_time(read)?.unwrap_or(0);
    let mut newest = None;
    read.scan(
        &record_key(CommitPosition::default()),
        &records_end(),
        true,
        &mut |k, v| {
            newest = Some((k.to_vec(), v.to_vec()));
            false
        },
    )?;
    if let Some((k, v)) = newest {
        floor = floor.max(decode_record(&k, &v)?.commit_time);
    }
    Ok(floor)
}

/// How a store keeps its log (`Kv::enable_commit_log`).
#[derive(Debug, Clone)]
pub struct LogSettings {
    pub retention_bytes: u64,
    /// The origin of a commit that sets no meta of its own (open-time upkeep, rollbacks).
    pub default_origin: WriteOrigin,
}

impl Default for LogSettings {
    fn default() -> Self {
        Self {
            retention_bytes: DEFAULT_RETENTION_BYTES,
            default_origin: no_origin(),
        }
    }
}

/// The retention bookkeeping of an open log: the meta record and the size of every record, oldest
/// first. Owned by the one writer of the record file (the single-writer store's writer, or the
/// optimistic pipeline).
#[derive(Debug, Clone)]
pub(crate) struct LogState {
    pub(crate) settings: LogSettings,
    meta: LogMeta,
    sizes: VecDeque<(CommitPosition, u64)>,
    total: u64,
}

/// What one commit appends, planned before the record file commits and applied after it did.
pub(crate) struct Append {
    trim_old: usize,
    trim_new: usize,
    new: Vec<(CommitPosition, u64)>,
    meta: LogMeta,
}

impl LogState {
    /// Loads the state from `read` (the meta record must exist: the log was activated).
    pub(crate) fn load(read: &dyn KvRead, settings: LogSettings) -> Result<Self> {
        let meta = read_meta(read)?.ok_or_else(|| {
            StoreError::new(
                INVALID_STATE,
                "the commit log was not activated on this brain (no meta record)",
            )
        })?;
        let mut sizes = VecDeque::new();
        let mut total = 0u64;
        let mut failure = None;
        read.scan(
            &record_key(CommitPosition::default()),
            &records_end(),
            false,
            &mut |k, v| match position_of(k) {
                Ok(p) => {
                    let size = (k.len() + v.len()) as u64;
                    total += size;
                    sizes.push_back((p, size));
                    true
                }
                Err(e) => {
                    failure = Some(e);
                    false
                }
            },
        )?;
        if let Some(e) = failure {
            return Err(e);
        }
        Ok(Self {
            settings,
            meta,
            sizes,
            total,
        })
    }

    /// Plans the append of `records` (position and encoded value, in position order) and writes
    /// them, the trims and the new meta record into `tx`. Nothing in `self` changes until
    /// [`LogState::applied`].
    pub(crate) fn write(
        &self,
        tx: &mut dyn KvWrite,
        records: &[(CommitPosition, Vec<u8>)],
    ) -> Result<Append> {
        let mut new = Vec::with_capacity(records.len());
        let mut newest = self.meta.newest;
        for (position, value) in records {
            if !position.follows(newest) {
                return Err(StoreError::new(
                    STORE_CORRUPT,
                    format!(
                        "commit log: the next record would be {} after {}",
                        position.token(),
                        newest.token()
                    ),
                ));
            }
            newest = *position;
            let key = record_key(*position);
            new.push((*position, (key.len() + value.len()) as u64));
            tx.put(&key, value)?;
        }
        let cap = self.settings.retention_bytes;
        let mut total = self.total + new.iter().map(|(_, s)| s).sum::<u64>();
        let mut trimmed_through = self.meta.trimmed_through;
        let mut trim_old = 0;
        while total > cap && trim_old < self.sizes.len() {
            let (p, s) = self.sizes[trim_old];
            tx.delete(&record_key(p))?;
            total -= s;
            trimmed_through = Some(p);
            trim_old += 1;
        }
        let mut trim_new = 0;
        while total > cap && trim_new < new.len() {
            let (p, s) = new[trim_new];
            tx.delete(&record_key(p))?;
            total -= s;
            trimmed_through = Some(p);
            trim_new += 1;
        }
        let meta = LogMeta {
            since: self.meta.since,
            newest,
            trimmed_through,
            lineage: self.meta.lineage.clone(),
        };
        tx.put(&meta_key(), &serde_json::to_vec(&meta)?)?;
        Ok(Append {
            trim_old,
            trim_new,
            new,
            meta,
        })
    }

    /// Takes in an append whose commit succeeded.
    pub(crate) fn applied(&mut self, append: Append) {
        for _ in 0..append.trim_old {
            if let Some((_, s)) = self.sizes.pop_front() {
                self.total -= s;
            }
        }
        for (i, (p, s)) in append.new.into_iter().enumerate() {
            if i >= append.trim_new {
                self.sizes.push_back((p, s));
                self.total += s;
            }
        }
        self.meta = append.meta;
    }

    /// The meta record as this state holds it.
    pub(crate) fn meta(&self) -> &LogMeta {
        &self.meta
    }

    /// Sets the lineage the next `write` records (a follower adopting its primary's history).
    pub(crate) fn set_lineage(&mut self, lineage: Vec<Timeline>) {
        self.meta.lineage = lineage;
    }

    /// The origin a record carries for `meta`.
    pub(crate) fn origin_for(&self, meta: &CommitMeta) -> WriteOrigin {
        meta.origin
            .clone()
            .unwrap_or_else(|| self.settings.default_origin.clone())
    }
}

/// A UUID version 7 (RFC 9562): 48 bits of Unix milliseconds from `env`, then random bits from
/// `env`'s generator, so the seeded environments of tests and the simulation replay it.
pub fn uuid_v7(env: &dyn Env) -> String {
    let millis = (env.now_micros().max(0) / 1000) as u64;
    let random = env.new_uuid().replace('-', "");
    let mut b = [0u8; 16];
    for (i, byte) in b.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&random[i * 2..i * 2 + 2], 16).unwrap_or(0);
    }
    b[..6].copy_from_slice(&millis.to_be_bytes()[2..]);
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The write context of the `Store::write` running on this thread: the open origin (when write
/// origin is on, journal rows are stamped with it) and the request ids and principal the journal
/// notes while the write runs. `Store::write` opens one per run and hands what was noted to the
/// commit's meta.
pub(crate) mod scope {
    use super::CommitMeta;
    use std::cell::RefCell;

    /// The store's open origin as journal rows are stamped with it.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct RowOrigin {
        pub(crate) host_id: String,
        pub(crate) incarnation: String,
    }

    #[derive(Default)]
    struct Frame {
        stamp: Option<RowOrigin>,
        ids: Vec<String>,
        writer: Option<String>,
    }

    thread_local! {
        static FRAMES: RefCell<Vec<Frame>> = const { RefCell::new(Vec::new()) };
    }

    /// Ends the frame when the write run ends (its notes are taken with [`Guard::take`]).
    pub(crate) struct Guard(());

    impl Drop for Guard {
        fn drop(&mut self) {
            FRAMES.with(|f| f.borrow_mut().pop());
        }
    }

    impl Guard {
        /// What the run noted: its request ids and the first principal (`kind:id`).
        pub(crate) fn take(&self) -> (Vec<String>, Option<String>) {
            FRAMES.with(|f| {
                let mut frames = f.borrow_mut();
                let frame = frames.last_mut().expect("the frame of this guard");
                (std::mem::take(&mut frame.ids), frame.writer.take())
            })
        }
    }

    /// Opens a frame. `stamp`: the origin journal rows get, `None` when write origin is off.
    pub(crate) fn open(stamp: Option<RowOrigin>) -> Guard {
        FRAMES.with(|f| {
            f.borrow_mut().push(Frame {
                stamp,
                ..Frame::default()
            })
        });
        Guard(())
    }

    /// The origin to stamp journal rows with, when write origin is on for the running write.
    pub(crate) fn row_origin() -> Option<RowOrigin> {
        FRAMES.with(|f| f.borrow().last().and_then(|frame| frame.stamp.clone()))
    }

    /// Notes a journal request the running write admitted, and its principal.
    pub(crate) fn note(request_id: &str, principal_kind: &str, principal_id: &str) {
        FRAMES.with(|f| {
            if let Some(frame) = f.borrow_mut().last_mut() {
                if !frame.ids.iter().any(|id| id == request_id) {
                    frame.ids.push(request_id.to_string());
                }
                if frame.writer.is_none() {
                    frame.writer = Some(format!("{principal_kind}:{principal_id}"));
                }
            }
        })
    }

    /// The meta of a run: `writer` from the write trust context wins over a noted principal.
    pub(crate) fn meta_of(
        origin: Option<&RowOrigin>,
        noted: (Vec<String>, Option<String>),
        request_id: Option<String>,
        writer: Option<String>,
    ) -> CommitMeta {
        let (mut ids, noted_writer) = noted;
        if let Some(request) = request_id
            && !ids.contains(&request)
        {
            ids.insert(0, request);
        }
        let writer_id = writer.or(noted_writer);
        CommitMeta {
            origin: origin.map(|o| super::WriteOrigin {
                host_id: o.host_id.clone(),
                incarnation: o.incarnation.clone(),
                writer_id: writer_id.unwrap_or_default(),
            }),
            write_ids: ids,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin() -> WriteOrigin {
        WriteOrigin {
            host_id: "h".into(),
            incarnation: "i".into(),
            writer_id: "local_cli:me".into(),
        }
    }

    fn sample() -> (Vec<u8>, Vec<u8>) {
        let ops: Vec<(&[u8], LogOpRef)> = vec![
            (b"a", LogOpRef::Put(b"value")),
            (b"b", LogOpRef::Delete),
            (b"c", LogOpRef::AddI64(-3)),
            (b"d", LogOpRef::RaiseCounter(9)),
        ];
        (
            record_key(CommitPosition::new(7, 2)),
            encode_record(
                &origin(),
                1_700_000_000_000_042,
                &["r1".into(), "r2".into()],
                ops,
            ),
        )
    }

    #[test]
    fn a_record_round_trips() {
        let (k, v) = sample();
        let r = decode_record(&k, &v).unwrap();
        assert_eq!(r.position, CommitPosition::new(7, 2));
        assert_eq!(r.origin, origin());
        assert_eq!(r.commit_time, 1_700_000_000_000_042);
        assert_eq!(r.write_ids, vec!["r1", "r2"]);
        assert_eq!(
            r.ops,
            vec![
                (b"a".to_vec(), LogOp::Put(b"value".to_vec())),
                (b"b".to_vec(), LogOp::Delete),
                (b"c".to_vec(), LogOp::AddI64(-3)),
                (b"d".to_vec(), LogOp::RaiseCounter(9)),
            ]
        );
    }

    #[test]
    fn a_decoded_record_encodes_back_to_its_bytes() {
        let (k, v) = sample();
        assert_eq!(encode_commit_record(&decode_record(&k, &v).unwrap()), v);
    }

    #[test]
    fn a_follower_continues_only_on_a_common_history() {
        let t = |id: &str, s: u64| Timeline {
            id: id.into(),
            from: CommitPosition::new(s, 0),
        };
        let at = |s: u64| CommitPosition::new(s, 0);
        assert!(lineage_continues(&[], at(5), &[]));
        assert!(
            lineage_continues(&[], at(5), &[t("a", 5)]),
            "forked at the cursor"
        );
        assert!(
            lineage_continues(&[], at(5), &[t("a", 7)]),
            "forked after the cursor"
        );
        assert!(
            !lineage_continues(&[], at(9), &[t("a", 7)]),
            "the follower holds old-timeline commits"
        );
        assert!(lineage_continues(
            &[t("a", 7)],
            at(9),
            &[t("a", 7), t("b", 9)]
        ));
        assert!(
            !lineage_continues(&[t("a", 7)], at(9), &[t("x", 7)]),
            "another history"
        );
        assert!(
            !lineage_continues(&[t("a", 7)], at(9), &[]),
            "the follower is on a newer timeline"
        );
    }

    #[test]
    fn every_malformed_record_is_refused_as_corrupt() {
        let (k, v) = sample();
        let mut cases: Vec<(String, Vec<u8>)> = Vec::new();
        cases.push(("empty".into(), vec![]));
        // Any other version, the retired v1 included, is not one this build reads.
        for version in [0u8, 1, 3, 255] {
            let mut other = v.clone();
            other[0] = version;
            let err = decode_record(&k, &other).unwrap_err();
            assert_eq!(err.code, crate::error::FORMAT_UNKNOWN, "version {version}");
        }
        let mut trailing = v.clone();
        trailing.push(0);
        cases.push(("trailing".into(), trailing));
        for cut in 1..v.len() {
            cases.push((format!("cut at {cut}"), v[..cut].to_vec()));
        }
        // A write id count far past the bytes: refused before it sizes an allocation.
        let mut huge = vec![RECORD_VERSION];
        for _ in 0..3 {
            put_bytes(&mut huge, b"");
        }
        huge.extend_from_slice(&0i64.to_be_bytes());
        huge.extend_from_slice(&u32::MAX.to_be_bytes());
        cases.push(("id count".into(), huge.clone()));
        let mut huge_ops = huge[..huge.len() - 4].to_vec();
        huge_ops.extend_from_slice(&0u32.to_be_bytes());
        huge_ops.extend_from_slice(&u32::MAX.to_be_bytes());
        cases.push(("op count".into(), huge_ops));
        let op = |tag: u8, key: &[u8], operand: &[u8]| {
            let mut out = vec![RECORD_VERSION];
            for _ in 0..3 {
                put_bytes(&mut out, b"");
            }
            out.extend_from_slice(&0i64.to_be_bytes());
            out.extend_from_slice(&0u32.to_be_bytes());
            out.extend_from_slice(&1u32.to_be_bytes());
            out.push(tag);
            put_bytes(&mut out, key);
            put_bytes(&mut out, operand);
            out
        };
        cases.push(("short add".into(), op(OP_ADD_I64, b"k", &[1, 2, 3])));
        cases.push(("long raise".into(), op(OP_RAISE_COUNTER, b"k", &[0; 9])));
        cases.push(("delete operand".into(), op(OP_DELETE, b"k", &[1])));
        cases.push(("unknown op".into(), op(9, b"k", b"")));
        let mut bad_utf8 = vec![RECORD_VERSION];
        put_bytes(&mut bad_utf8, &[0xff, 0xfe]);
        cases.push(("utf8".into(), bad_utf8));
        for (name, value) in cases {
            let err = decode_record(&k, &value).expect_err(&name);
            assert_eq!(err.code, STORE_CORRUPT, "{name}: {err:?}");
        }
        // Keys out of order or repeated.
        let twice: Vec<(&[u8], LogOpRef)> =
            vec![(b"a", LogOpRef::Delete), (b"a", LogOpRef::Delete)];
        let v = encode_record(&origin(), 0, &[], twice);
        assert_eq!(decode_record(&k, &v).unwrap_err().code, STORE_CORRUPT);
        // A key under the tag that is no record key.
        assert_eq!(
            decode_record(&[COMMIT_LOG, 1], &sample().1)
                .unwrap_err()
                .code,
            STORE_CORRUPT
        );
    }

    #[test]
    fn positions_order_and_tokens_round_trip() {
        let a = CommitPosition::new(3, 1);
        assert!(a < CommitPosition::new(3, 2));
        assert!(CommitPosition::new(3, 9) < CommitPosition::end_of(3));
        assert!(CommitPosition::end_of(3) < CommitPosition::new(4, 0));
        assert_eq!(CommitPosition::parse_token(&a.token()).unwrap(), a);
        assert_eq!(a.token(), "cp1:3.1");
        for bad in [
            "",
            "cp1:",
            "cp1:3",
            "cp1:3.",
            "cp2:3.1",
            "cp1:-3.1",
            "cp1:3.1.2",
            "cp1:3.4294967296",
        ] {
            assert_eq!(
                CommitPosition::parse_token(bad).unwrap_err().code,
                INVALID_ARGUMENT,
                "{bad}"
            );
        }
        assert!(CommitPosition::new(3, 2).follows(a));
        assert!(CommitPosition::new(4, 0).follows(a));
        assert!(!CommitPosition::new(4, 1).follows(a));
        assert!(!CommitPosition::new(3, 1).follows(a));
        assert!(CommitPosition::new(4, 0).follows(CommitPosition::end_of(3)));
        assert!(!CommitPosition::new(3, 0).follows(CommitPosition::end_of(3)));
        let json = serde_json::to_string(&a).unwrap();
        assert_eq!(json, r#"{"sequence":3,"index":1}"#);
    }

    #[test]
    fn a_write_inside_another_brains_write_sees_none_of_its_origin_or_requests() {
        let on = scope::RowOrigin {
            host_id: "h".into(),
            incarnation: "i".into(),
        };
        let outer = scope::open(Some(on.clone()));
        scope::note("outer-req", "local_cli", "a");
        {
            // An off brain's write opens its own empty frame.
            let inner = scope::open(None);
            assert_eq!(scope::row_origin(), None);
            scope::note("inner-req", "local_cli", "b");
            assert_eq!(
                inner.take(),
                (vec!["inner-req".to_string()], Some("local_cli:b".into()))
            );
        }
        assert_eq!(scope::row_origin(), Some(on));
        assert_eq!(
            outer.take(),
            (vec!["outer-req".to_string()], Some("local_cli:a".into()))
        );
    }

    #[test]
    fn a_uuid_v7_carries_the_time_and_the_version() {
        struct Fixed;
        impl Env for Fixed {
            fn now_micros(&self) -> i64 {
                1_700_000_000_123_456
            }
            fn new_uuid(&self) -> String {
                "ffffffff-ffff-4fff-bfff-ffffffffffff".into()
            }
        }
        let id = uuid_v7(&Fixed);
        assert!(crate::env::is_uuid(&id), "{id}");
        assert_eq!(&id[14..15], "7");
        assert_eq!(&id[0..13], "018bcfe5-687b");
    }
}
