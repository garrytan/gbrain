//! The `FORMAT` file: a small JSON record beside the record file that says which store format
//! the directory holds. It is read before the record file is opened, so a directory written by a
//! newer build is refused without being touched.

use crate::error::{FORMAT_UNKNOWN, Result, STORE_IO, StoreError};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::Path;

/// The store format this build reads and writes.
pub const FORMAT_VERSION: u32 = 1;
/// Every format version this build can open. Addon exports list these as `formatVersions`.
pub const FORMAT_VERSIONS: &[u32] = &[FORMAT_VERSION];

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
    if FORMAT_VERSIONS.contains(&version) {
        return Ok(());
    }
    let why = if version > FORMAT_VERSION {
        "newer"
    } else {
        "older"
    };
    Err(StoreError::new(
        FORMAT_UNKNOWN,
        format!(
            "this brain has store format {version}, {why} than the formats this build opens ({FORMAT_VERSIONS:?}); nothing was changed"
        ),
    ))
}

/// Reads `FORMAT`; `None` when the file does not exist.
pub fn read(dir: &Path) -> Result<Option<FormatRecord>> {
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
    check_version(version)?;
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
