//! A source's own contextual-retrieval mode (`sources.contextual_retrieval_mode`), written by
//! `setSourceContextualMode` of `src/core/engine-sql/source-cr-mode.ts` (`gbrain sources
//! set-cr-mode`) and read by `getSource` and the synopsis tier (rust/docs/store/source-cr-mode.md).
//!
//! Keys: `M source_cr_mode/<source id>` -> `{ mode, incarnation }`. The record sits beside the
//! source record, not in it, and names the incarnation of the source it was written for: a mode
//! counts only while that source is the live one, so a source deleted and created again under
//! the same id reads as having no mode, as the SQL column of a new row does.

use crate::Store;
use crate::error::Result;
use crate::kv::{KvRead, scan_prefix};
use crate::sources::{SourceRecord, all_sources, read_source};
use crate::{get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const PREFIX: &str = "source_cr_mode/";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModeRecord {
    mode: String,
    incarnation: String,
}

fn mode_key(source_id: &str) -> Vec<u8> {
    keys::meta(&format!("{PREFIX}{source_id}"))
}

/// The mode of `source`, when one was set for its current incarnation.
pub(crate) fn source_mode(read: &dyn KvRead, source: &SourceRecord) -> Result<Option<String>> {
    let record: Option<ModeRecord> = get_json(read, &mode_key(&source.id))?;
    Ok(record
        .filter(|r| r.incarnation == source.incarnation)
        .map(|r| r.mode))
}

/// Every live source's mode, keyed by source id (byte order), archived sources included.
pub(crate) fn source_modes(read: &dyn KvRead) -> Result<BTreeMap<String, (String, bool)>> {
    let mut records: BTreeMap<String, ModeRecord> = BTreeMap::new();
    let prefix = keys::meta(PREFIX);
    let mut bad = None;
    scan_prefix(read, &prefix, false, &mut |key, value| {
        let id = String::from_utf8_lossy(&key[prefix.len()..]).into_owned();
        match serde_json::from_slice::<ModeRecord>(value) {
            Ok(record) => {
                records.insert(id, record);
                true
            }
            Err(e) => {
                bad = Some(e);
                false
            }
        }
    })?;
    if let Some(e) = bad {
        return Err(e.into());
    }
    if records.is_empty() {
        return Ok(BTreeMap::new());
    }
    Ok(all_sources(read)?
        .into_iter()
        .filter_map(|s| {
            let record = records.remove(&s.id)?;
            (record.incarnation == s.incarnation).then_some((s.id, (record.mode, s.archived)))
        })
        .collect())
}

impl Store {
    /// `setSourceContextualMode(id, mode)`: sets the source's own mode, or clears it when `mode`
    /// is `None`. Returns whether the source exists; nothing is written when it does not.
    pub fn set_source_contextual_mode(&self, id: &str, mode: Option<&str>) -> Result<bool> {
        self.write(|tx| {
            let Some(source) = read_source(&*tx, id)? else {
                return Ok(false);
            };
            match mode {
                Some(mode) => put_json(
                    tx,
                    &mode_key(id),
                    &ModeRecord {
                        mode: mode.to_string(),
                        incarnation: source.incarnation,
                    },
                )?,
                None => tx.delete(&mode_key(id))?,
            }
            Ok(true)
        })
    }

    /// The source's own mode as `getSource` reads its `contextual_retrieval_mode`: `None` when
    /// none is set, or when the source does not exist.
    pub fn source_contextual_mode(&self, id: &str) -> Result<Option<String>> {
        let read = self.read()?;
        match read_source(&*read, id)? {
            Some(source) => source_mode(&*read, &source),
            None => Ok(None),
        }
    }
}
