//! The `FORMAT` file: a small JSON record beside the record file that says which store format
//! the directory holds. It is read before the record file is opened, so a directory written by a
//! newer build is refused without being touched.

use crate::error::{FORMAT_UNKNOWN, Result, STORE_IO, StoreError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;

/// The store format this build reads and writes.
///
/// - 1: the chunk stats and the unfinished-request counters are one JSON record each.
/// - 2: each counter is its own record, so concurrent writers add to it without conflict
///   (`chunks::STATS_CHUNKS`, `journal::OUTSTANDING`). A format-1 brain is upgraded in one
///   write transaction when it opens (`Store::open_kv`); a build that reads only format 1
///   refuses a format-2 brain instead of missing its counts.
/// - 3: a page projection job is a compact binary record, not JSON
///   (`persistence::projection_queue::encode_job`), and the record file keeps its commit
///   sequence beside the id counters (`redb_kv::SEQ_KEY`). A format-2 brain is upgraded when it
///   opens; a build that reads only formats 1 and 2 refuses a format-3 brain instead of failing
///   on its jobs.
/// - 4: the store keeps keyword postings (`keyword/index.rs`) and every write keeps them in step.
///   The upgrade clears them and marks the index incomplete in the same transaction; a background
///   build fills them (`keyword/index_build.rs`). A build without the index refuses a format-4
///   brain, as its writes would leave the postings stale.
/// - 5: a take record carries its `trust_tier` and `write_origin` (`trust/row_trust.rs`), stamped
///   by every takes writer (`takes::store_take`). Nothing is rewritten: a take stored before reads
///   `unknown`, the column default. A build without the field refuses a format-5 brain, as a take it
///   rewrote would lose its tier.
/// - 6: the records are this build's shapes. The v0.60.766.0 Rust addon's shadow seed also wrote
///   format 5 but kept page purge tombstones, derived generations and oauth clients in other
///   shapes; the upgrade carries them over (`seed/format_5.rs`) or refuses the brain with
///   `shadow_reseed_required`. A build that writes the old shapes refuses a format-6 brain.
/// - 7: the loop mutes (`loop_suppressions`) are at `F 0x11`, no longer at `F 0x10` beside the take
///   purge tombstones, whose reads scanned them (`facts/key_split.rs`). The upgrade moves each mute
///   in the one transaction, or refuses a record under `F 0x10` it cannot classify with
///   `shadow_reseed_required`. A build that keeps both kinds at `F 0x10` refuses a format-7 brain.
/// - 8: the shared-skill catalog's token secret is at `x 0x0d`, no longer at `x 0x04` beside the
///   access member links, whose scans started on it (`access_key_split.rs`). The upgrade moves the
///   one record in the one transaction, or refuses a record under `x 0x04` it cannot classify with
///   `shadow_reseed_required`. A build that keeps both kinds at `x 0x04` refuses a format-8 brain.
/// - 9: the store keeps keyed lookups (`keyed_index.rs`): entries derived from page, chunk and link
///   records that every write keeps in step, so the chunk-id, exact-title, unserved-page, supersedes,
///   duplicate-page and transition-origin reads look rows up instead of reading every record. The upgrade builds every
///   entry in the one transaction. A build without the lookups refuses a format-9 brain, as its
///   writes would leave them stale.
/// - 12 (the trunk's allotment; formats 10 and 11 belong to other lanes and are not opened by this
///   build): the keyed lookups gain the updated-order entry (`keyed_index::UPDATED`), so `listPages`
///   sorted by `updated_at` reads only the pages it returns. The upgrade rebuilds every keyed entry
///   in its one write transaction. A build that stops at format 9 refuses a format-12 brain.
/// - 13 (the trunk's allotment; formats 10 and 11 belong to other lanes and are not opened by this
///   build): a write keeps one pending record per document it changed instead of rewriting that
///   document's keyword postings, and a later write folds the pending records into the postings
///   (`keyword/pending.rs`); every keyword read applies the pending records. The upgrade writes no
///   record: a format-8, 9 or 12 brain has no pending record (an 8 or 9 brain still gets its keyed
///   lookups built, as above). A build that stops at format 12 would read the postings without the
///   pending records, so it refuses a format-13 brain.
/// - 14 (the trunk's allotment; formats 10 and 11 belong to other lanes and are not opened by this
///   build): the legacy word postings under `T` are gone. Chunk writes no longer keep them, and the
///   upgrade deletes every one in its one write transaction (`legacy_postings.rs`); a format-13
///   brain keeps its pending keyword records, which live under `R`, not `T`. The addon's
///   `searchKeyword` answers as `searchKeywordArm` (`search.rs`). A build that stops at format 13
///   refuses a format-14 brain. The trunk may renumber this at merge by landing order: change this
///   constant only; every test and the upgrade read it.
pub const FORMAT_VERSION: u32 = 14;
/// Every format version this build can open. Addon exports list these as `formatVersions`.
pub const FORMAT_VERSIONS: &[u32] = &[1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, FORMAT_VERSION];

pub const FORMAT_FILE: &str = "FORMAT";
pub const RECORDS_FILE: &str = "records.redb";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormatRecord {
    pub format_version: u32,
    pub engine_abi: u32,
    pub catalog_version: u32,
    /// The TypeScript `config.version` the records match.
    pub schema_version: u32,
    pub brain_id: String,
    pub created_by: String,
}

/// Checks a version number read from `FORMAT` or from the format record in the store.
pub fn check_version(version: u32) -> Result<()> {
    check_version_in(version, FORMAT_VERSIONS)
}

/// `check_version` for a build that opens only the formats in `known` (ascending). The store
/// passes `FORMAT_VERSIONS`; tests pass an older list to show what an older build does.
pub(crate) fn check_version_in(version: u32, known: &[u32]) -> Result<()> {
    if known.contains(&version) {
        return Ok(());
    }
    let newest = known.last().copied().unwrap_or(0);
    let why = if version > newest { "newer" } else { "older" };
    Err(StoreError::new(
        FORMAT_UNKNOWN,
        format!(
            "this brain has store format {version}, {why} than the formats this build opens ({known:?}); nothing was changed"
        ),
    ))
}

/// Reads `FORMAT`; `None` when the file does not exist.
pub fn read(dir: &Path) -> Result<Option<FormatRecord>> {
    read_in(dir, FORMAT_VERSIONS)
}

/// `read` for a build that opens only the formats in `known` (see `check_version_in`).
pub(crate) fn read_in(dir: &Path, known: &[u32]) -> Result<Option<FormatRecord>> {
    let path = dir.join(FORMAT_FILE);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(StoreError::new(STORE_IO, format!("reading FORMAT: {e}"))),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| StoreError::new(FORMAT_UNKNOWN, format!("FORMAT is not valid JSON: {e}")))?;
    // The version is judged before the rest of the record is parsed, so a future record with new
    // required fields still reads as "newer", not "malformed".
    let version = value
        .get("format_version")
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| StoreError::new(FORMAT_UNKNOWN, "FORMAT has no format_version"))?;
    check_version_in(version, known)?;
    serde_json::from_value(value)
        .map(Some)
        .map_err(|e| StoreError::new(FORMAT_UNKNOWN, format!("FORMAT is malformed: {e}")))
}

/// Writes `FORMAT` by temporary file and atomic rename, so a reader sees the old or the new file.
pub fn write(dir: &Path, record: &FormatRecord) -> Result<()> {
    let io = |what: &str, e: std::io::Error| StoreError::new(STORE_IO, format!("{what}: {e}"));
    let temp = dir.join("FORMAT.tmp");
    let mut file = fs::File::create(&temp).map_err(|e| io("creating FORMAT.tmp", e))?;
    let mut body = serde_json::to_vec_pretty(record)?;
    body.push(b'\n');
    file.write_all(&body)
        .map_err(|e| io("writing FORMAT.tmp", e))?;
    file.sync_all().map_err(|e| io("syncing FORMAT.tmp", e))?;
    fs::rename(&temp, dir.join(FORMAT_FILE)).map_err(|e| io("renaming FORMAT", e))?;
    // Make the rename itself durable. A platform that cannot open a directory skips this.
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    Ok(())
}
