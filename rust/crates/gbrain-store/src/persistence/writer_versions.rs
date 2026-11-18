//! The writer-version reads (`src/core/engine-sql/writer-versions.ts`): when the brain started
//! stamping the writer versions of its write requests.
//!
//! The cutoff (`persistence_brain.writer_version_cutoff`, the moment migration 178 started stamping
//! requests on Postgres) is the brain's creation time here: a Rust brain stamps every request it
//! admits from birth.

use crate::env::iso;
use crate::error::Result;
use crate::kv::KvRead;
use crate::{Store, StoredFormat, get_json, keys};

/// When the brain started stamping writer versions: its creation time.
pub(crate) fn read_writer_version_cutoff_in(read: &dyn KvRead) -> Result<Option<String>> {
    let format: Option<StoredFormat> = get_json(read, &keys::meta("format"))?;
    Ok(format.map(|f| iso(f.created_at_us)))
}

impl Store {
    /// `readWriterVersionCutoff()`.
    pub fn read_writer_version_cutoff(&self) -> Result<Option<String>> {
        read_writer_version_cutoff_in(&*self.read()?)
    }
}
