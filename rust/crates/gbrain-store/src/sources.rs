//! Sources: the namespaces pages live in. Mirrors `listAllSources` and the source rows of the
//! PGLite engine. A fresh brain has the `default` source.

use crate::env::{Env, iso, parse_iso};
use crate::error::{Result, SOURCE_NOT_FOUND, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

mod archive;
pub use archive::{
    ArchivedSource, ArchivedSourceListRow, ExpiredArchivedSource, SourceDeleteImpact,
};

pub const DEFAULT_SOURCE: &str = "default";

/// What is stored for a source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SourceRecord {
    pub id: String,
    pub name: Option<String>,
    pub local_path: Option<String>,
    pub last_sync_at_us: Option<i64>,
    #[serde(deserialize_with = "crate::jsonb::de_map")]
    pub config: Map<String, Value>,
    /// Changes when a source is deleted and created again; page snapshots carry it.
    pub incarnation: String,
    pub archived: bool,
    pub created_at_us: i64,
    /// The chunker version the source's last full sync stamped (`sources.chunker_version`), or
    /// `None` before the first stamp. Records written before the field existed read as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunker_version: Option<String>,
    /// When the source was archived (`sources.archived_at`), or `None` when it is active or was
    /// archived without a time. Records written before the field existed read as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at_us: Option<i64>,
    /// When the archive's recovery window ends (`sources.archive_expires_at`), or `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_expires_at_us: Option<i64>,
    /// The commit the source's last git sync reached (`sources.last_commit`), or `None` before the
    /// first one. Only `advance_source_commit` writes it; older records read as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_commit: Option<String>,
    /// The newest synced content's commit time (`sources.newest_content_at`), or `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_content_at_us: Option<i64>,
    /// `sources.purge_epoch`: purge raises it, and the belief ledger refuses a payload prepared
    /// under an older one. Records written before the field existed, and every record still at 0,
    /// read and write as 0 with no bytes of their own.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub purge_epoch: i64,
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// A source as JavaScript sees it: `SourceRow` of `src/core/engine.ts`, with `last_sync_at` as an
/// ISO string, plus `incarnation`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceRow {
    pub id: String,
    pub name: Option<String>,
    pub local_path: Option<String>,
    pub last_sync_at: Option<String>,
    pub config: Map<String, Value>,
    pub incarnation: String,
}

impl From<SourceRecord> for SourceRow {
    fn from(r: SourceRecord) -> Self {
        Self {
            id: r.id,
            name: r.name,
            local_path: r.local_path,
            last_sync_at: r.last_sync_at_us.map(iso),
            config: r.config,
            incarnation: r.incarnation,
        }
    }
}

/// One source as `getSource` returns it: `SourceDetailRow` of `src/core/engine.ts`, dates as ISO
/// strings. The store keeps no `contextual_retrieval_mode` or `trust_frontmatter_overrides`: only
/// source admin SQL writes those columns, and it does not run on a Rust brain, so they read as the
/// column defaults (null, false). `last_commit` is the one `advance_source_commit` stored.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceDetailRow {
    pub id: String,
    pub name: Option<String>,
    pub local_path: Option<String>,
    pub last_commit: Option<String>,
    pub last_sync_at: Option<String>,
    pub config: Map<String, Value>,
    pub created_at: String,
    pub contextual_retrieval_mode: Option<String>,
    pub trust_frontmatter_overrides: bool,
}

impl From<SourceRecord> for SourceDetailRow {
    fn from(r: SourceRecord) -> Self {
        Self {
            id: r.id,
            name: r.name,
            local_path: r.local_path,
            last_commit: r.last_commit,
            last_sync_at: r.last_sync_at_us.map(iso),
            config: r.config,
            created_at: iso(r.created_at_us),
            contextual_retrieval_mode: None,
            trust_frontmatter_overrides: false,
        }
    }
}

/// `markSourceSynced` options: `incarnation` stamps only a source still of that incarnation.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSyncStampOptions {
    pub incarnation: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ListSourcesOptions {
    pub include_archived: bool,
    pub local_path_only: bool,
}

/// Input of `upsertSource`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SourceInput {
    pub id: String,
    pub name: Option<String>,
    pub local_path: Option<String>,
    pub last_sync_at: Option<String>,
    pub config: Option<Map<String, Value>>,
}

/// The key of a source record. Other families that change a source record write it here.
pub(crate) fn source_key(id: &str) -> Vec<u8> {
    keys::text(keys::SOURCE, &[id])
}

pub(crate) fn valid_source_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub(crate) fn read_source(read: &dyn KvRead, id: &str) -> Result<Option<SourceRecord>> {
    if id.contains('\0') {
        return Ok(None);
    }
    get_json(read, &source_key(id))
}

pub(crate) fn require_source(read: &dyn KvRead, id: &str) -> Result<SourceRecord> {
    read_source(read, id)?
        .ok_or_else(|| StoreError::new(SOURCE_NOT_FOUND, format!("source \"{id}\" does not exist")))
}

/// The `default` source a fresh brain starts with: `config` is `{"federated": true}`.
pub(crate) fn seed_default_source(tx: &mut dyn KvWrite, env: &dyn Env) -> Result<()> {
    let mut config = Map::new();
    config.insert("federated".into(), Value::Bool(true));
    let record = SourceRecord {
        id: DEFAULT_SOURCE.into(),
        name: Some(DEFAULT_SOURCE.into()),
        local_path: None,
        last_sync_at_us: None,
        config,
        incarnation: env.new_uuid(),
        archived: false,
        created_at_us: env.now_micros(),
        chunker_version: None,
        archived_at_us: None,
        archive_expires_at_us: None,
        last_commit: None,
        newest_content_at_us: None,
        purge_epoch: 0,
    };
    put_json(tx, &source_key(DEFAULT_SOURCE), &record)
}

pub(crate) fn all_sources(read: &dyn KvRead) -> Result<Vec<SourceRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &[keys::SOURCE], false, &mut |_, v| {
        match serde_json::from_slice::<SourceRecord>(v) {
            Ok(record) => out.push(record),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    match failure {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

impl Store {
    /// Every source, `default` first, then by id. Archived sources are left out unless
    /// `include_archived`; `local_path_only` keeps sources that have a local path and are not the
    /// storage shelf. Mirrors `listAllSources`.
    pub fn list_all_sources(&self, options: &ListSourcesOptions) -> Result<Vec<SourceRow>> {
        let mut records = all_sources(&*self.read()?)?;
        records.retain(|r| {
            (options.include_archived || !r.archived)
                && (!options.local_path_only
                    || (r.local_path.is_some()
                        && r.config.get("role").and_then(Value::as_str)
                            != Some("storage_manifest")))
        });
        records.sort_by(|a, b| {
            (b.id == DEFAULT_SOURCE)
                .cmp(&(a.id == DEFAULT_SOURCE))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(records.into_iter().map(SourceRow::from).collect())
    }

    /// One source by id, archived or not, or `None`.
    pub fn get_source_by_id(&self, id: &str) -> Result<Option<SourceRow>> {
        Ok(read_source(&*self.read()?, id)?.map(SourceRow::from))
    }

    /// Creates a source, or updates the fields given on an existing one (its incarnation stays).
    /// Source ids are 1 to 32 characters of `a-z`, `0-9` and `-`.
    pub fn upsert_source(&self, input: &SourceInput) -> Result<SourceRow> {
        if !valid_source_id(&input.id) {
            return Err(StoreError::invalid(
                "a source id is 1 to 32 characters of a-z, 0-9 and -",
            ));
        }
        let last_sync = match &input.last_sync_at {
            Some(text) => Some(parse_iso(text).ok_or_else(|| {
                StoreError::invalid("last_sync_at must be an ISO timestamp ending in Z")
            })?),
            None => None,
        };
        self.write(|tx| {
            let mut record = match read_source(&*tx, &input.id)? {
                Some(existing) => existing,
                None => SourceRecord {
                    id: input.id.clone(),
                    name: None,
                    local_path: None,
                    last_sync_at_us: None,
                    config: Map::new(),
                    incarnation: self.env.new_uuid(),
                    archived: false,
                    created_at_us: self.env.now_micros(),
                    chunker_version: None,
                    archived_at_us: None,
                    archive_expires_at_us: None,
                    last_commit: None,
                    newest_content_at_us: None,
                    purge_epoch: 0,
                },
            };
            if input.name.is_some() {
                record.name = input.name.clone();
            }
            if input.local_path.is_some() {
                record.local_path = input.local_path.clone();
            }
            if last_sync.is_some() {
                record.last_sync_at_us = last_sync;
            }
            if let Some(config) = &input.config {
                record.config = config.clone();
            }
            put_json(tx, &source_key(&record.id), &record)?;
            Ok(SourceRow::from(record))
        })
    }

    /// Merges `patch` into the source's config, one level deep (PGLite's `config || patch`): a key
    /// set to `null` is kept as JSON `null`, not removed. Returns whether the source exists.
    /// Mirrors `updateSourceConfig`.
    pub fn update_source_config(&self, id: &str, patch: &Map<String, Value>) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, id)? else {
                return Ok(false);
            };
            for (key, value) in patch {
                record.config.insert(key.clone(), value.clone());
            }
            put_json(tx, &source_key(id), &record)?;
            Ok(true)
        })
    }

    /// `replaceSourceConfig(id, config)`: replaces the source's whole config. Returns whether the
    /// source exists; an unknown id changes nothing.
    pub fn replace_source_config(&self, id: &str, config: &Map<String, Value>) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, id)? else {
                return Ok(false);
            };
            record.config = config.clone();
            put_json(tx, &source_key(id), &record)?;
            Ok(true)
        })
    }

    /// `renameSource(id, name)`: sets the source's display name. Returns whether the source exists;
    /// an unknown id changes nothing.
    pub fn rename_source(&self, id: &str, name: &str) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, id)? else {
                return Ok(false);
            };
            record.name = Some(name.to_string());
            put_json(tx, &source_key(id), &record)?;
            Ok(true)
        })
    }

    /// `advanceSourceCommit`: records that the source's git sync reached `commit` and stamps
    /// `last_sync_at` with the store clock. `newest_content_at` is left alone when `None`, cleared
    /// when `Some(None)` and set when `Some(Some(iso))`. An unknown id changes nothing, as the
    /// `UPDATE ... WHERE id` of the SQL engines does.
    pub fn advance_source_commit(
        &self,
        id: &str,
        commit: &str,
        newest_content_at: Option<Option<&str>>,
    ) -> Result<()> {
        let newest = match newest_content_at {
            Some(Some(text)) => Some(Some(parse_iso(text).ok_or_else(|| {
                StoreError::invalid("newest_content_at must be an ISO timestamp ending in Z")
            })?)),
            Some(None) => Some(None),
            None => None,
        };
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, id)? else {
                return Ok(());
            };
            record.last_commit = Some(commit.to_string());
            record.last_sync_at_us = Some(self.env.now_micros());
            if let Some(newest) = newest {
                record.newest_content_at_us = newest;
            }
            put_json(tx, &source_key(id), &record)
        })
    }

    /// Archives or restores a source. Archiving sets no archive time (an unverified archive);
    /// restoring clears both times. Returns whether the source exists.
    pub fn set_source_archived(&self, id: &str, archived: bool) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, id)? else {
                return Ok(false);
            };
            record.archived = archived;
            if !archived {
                record.archived_at_us = None;
                record.archive_expires_at_us = None;
            }
            put_json(tx, &source_key(id), &record)?;
            Ok(true)
        })
    }

    /// `markSourceSynced(id)`: sets the source's last sync time to the store clock, the stamp a
    /// clean `gbrain import` of a folder source makes. Returns whether the source exists; an
    /// unknown id changes nothing. Mirrors `markSourceSynced` (`last_sync_at = now()`).
    pub fn mark_source_synced(&self, id: &str, options: &SourceSyncStampOptions) -> Result<bool> {
        // `incarnation = $2::uuid`: a malformed id is refused as the cast refuses it; case does not matter.
        let incarnation = match options.incarnation.as_deref() {
            None => None,
            Some(text) if crate::env::is_uuid(text) => Some(text.to_lowercase()),
            Some(text) => {
                return Err(StoreError::invalid(format!(
                    "invalid input syntax for type uuid: \"{text}\""
                )));
            }
        };
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, id)? else {
                return Ok(false);
            };
            if incarnation
                .as_deref()
                .is_some_and(|want| record.incarnation.to_lowercase() != want)
            {
                return Ok(false);
            }
            record.last_sync_at_us = Some(self.env.now_micros());
            put_json(tx, &source_key(id), &record)?;
            Ok(true)
        })
    }

    /// `getSource(id)`: the source row, archived or not, or `None`. Mirrors `getSource`.
    pub fn get_source(&self, id: &str) -> Result<Option<SourceDetailRow>> {
        Ok(read_source(&*self.read()?, id)?.map(SourceDetailRow::from))
    }

    /// `countRepoBoundSources()`: how many sources that are not archived have a non-empty
    /// local path. Mirrors `countRepoBoundSources`.
    pub fn count_repo_bound_sources(&self) -> Result<u64> {
        Ok(all_sources(&*self.read()?)?
            .into_iter()
            .filter(|r| !r.archived && r.local_path.as_deref().is_some_and(|p| !p.is_empty()))
            .count() as u64)
    }

    /// `readSourcePurgeEpoch(id)`: the source's stored purge epoch (0 until a purge raises it), or
    /// `None` for an unknown source. Archived sources answer too, as the SQL reads the row as is.
    pub fn read_source_purge_epoch(&self, id: &str) -> Result<Option<i64>> {
        Ok(read_source(&*self.read()?, id)?.map(|r| r.purge_epoch))
    }

    /// `listSourceLocalPaths()`: the local path of every source that has a non-empty one,
    /// archived sources included, in id order. Mirrors `listSourceLocalPaths`.
    pub fn list_source_local_paths(&self) -> Result<Vec<String>> {
        Ok(all_sources(&*self.read()?)?
            .into_iter()
            .filter_map(|r| r.local_path.filter(|p| !p.is_empty()))
            .collect())
    }

    /// `getSourceStrictness(id)`: true when the source's `config.canonical` is the string `git`;
    /// false otherwise, an unknown id included. Mirrors `getSourceStrictness`.
    pub fn get_source_strictness(&self, id: &str) -> Result<bool> {
        Ok(read_source(&*self.read()?, id)?
            .is_some_and(|r| r.config.get("canonical").and_then(Value::as_str) == Some("git")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OpenOptions;
    use std::path::PathBuf;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// `readSourcePurgeEpoch` reads the stored field, not a constant: a fresh source reads 0, a
    /// raised epoch reads as stored, another source keeps its own, and an unknown source has none.
    #[test]
    fn read_source_purge_epoch_reads_the_stored_epoch_of_the_named_source() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/unit-tmp")
            .join(format!("source-purge-epoch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let _guard = Dir(dir.clone());
        let store = Store::open_dir(&dir.join("brain"), OpenOptions::default()).unwrap();
        let team: SourceInput =
            serde_json::from_value(serde_json::json!({ "id": "team" })).unwrap();
        store.upsert_source(&team).unwrap();
        assert_eq!(store.read_source_purge_epoch("team").unwrap(), Some(0));
        store
            .write(|tx| {
                let mut record = require_source(&*tx, "team")?;
                record.purge_epoch = 3;
                put_json(tx, &source_key("team"), &record)
            })
            .unwrap();
        assert_eq!(store.read_source_purge_epoch("team").unwrap(), Some(3));
        assert_eq!(
            store.read_source_purge_epoch(DEFAULT_SOURCE).unwrap(),
            Some(0)
        );
        assert_eq!(
            store.read_source_purge_epoch("no-such-source").unwrap(),
            None
        );
    }
}
