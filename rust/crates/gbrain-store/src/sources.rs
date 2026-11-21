//! Sources: the namespaces pages live in. Mirrors `listAllSources` and the source rows of the
//! PGLite engine. A fresh brain has the `default` source.

use crate::env::{Env, iso, parse_iso};
use crate::error::{Result, SOURCE_NOT_FOUND, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const DEFAULT_SOURCE: &str = "default";

/// What is stored for a source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SourceRecord {
    pub id: String,
    pub name: Option<String>,
    pub local_path: Option<String>,
    /// When the sync anchor last advanced (`sources.last_sync_at`).
    #[serde(default)]
    pub last_sync_at_us: Option<i64>,
    pub config: Map<String, Value>,
    /// Changes when a source is deleted and created again; page snapshots carry it.
    pub incarnation: String,
    pub archived: bool,
    pub created_at_us: i64,
    /// The chunker version the source's last full sync stamped (`sources.chunker_version`), or
    /// `None` before the first stamp. Records written before the field existed read as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunker_version: Option<String>,
    /// The sync's last observation of the checkout's Git upstream (`sources.upstream_checked_at`,
    /// `upstream_commit`, `upstream_behind`), or `None` before the first one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_checked_at_us: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_behind: Option<i64>,
    /// The commit the source's last git sync reached (`sources.last_commit`), or `None` before the
    /// first one. Only `advance_source_commit` writes it; older records read as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_commit: Option<String>,
    /// The newest synced content's commit time (`sources.newest_content_at`), or `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_content_at_us: Option<i64>,
    /// The source's purge counter (`sources.purge_epoch`), which every fact purge advances in the
    /// transaction that writes its tombstones (`advance_source_purge_epoch`). Records written
    /// before the field existed, and sources never purged, read as 0.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub purge_epoch: i64,
}

fn is_zero(value: &i64) -> bool {
    *value == 0
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
/// strings. `last_commit` is the one the sync anchor advanced (`advance_source_commit`). The
/// store keeps no `contextual_retrieval_mode` or `trust_frontmatter_overrides`: only source admin
/// SQL writes those columns, and it does not run on a Rust brain, so they read as the column
/// defaults (null, false).
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
        last_commit: None,
        newest_content_at_us: None,
        upstream_checked_at_us: None,
        upstream_commit: None,
        upstream_behind: None,
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
                    last_commit: None,
                    newest_content_at_us: None,
                    upstream_checked_at_us: None,
                    upstream_commit: None,
                    upstream_behind: None,
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

    /// `advanceSourcePurgeEpoch(sourceId)`: adds one to the source's purge epoch and returns the
    /// new value, as `UPDATE sources SET purge_epoch = purge_epoch + 1 ... RETURNING` does; an
    /// unknown id changes nothing and returns `None` (no row).
    pub fn advance_source_purge_epoch(&self, id: &str) -> Result<Option<i64>> {
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, id)? else {
                return Ok(None);
            };
            record.purge_epoch += 1;
            put_json(tx, &source_key(id), &record)?;
            Ok(Some(record.purge_epoch))
        })
    }

    /// `readSourcePurgeEpoch(sourceId)`: the source's purge epoch as stored, or `None` for an
    /// unknown id.
    pub fn read_source_purge_epoch(&self, id: &str) -> Result<Option<i64>> {
        Ok(read_source(&*self.read()?, id)?.map(|record| record.purge_epoch))
    }

    /// Archives or restores a source. Returns whether the source exists.
    pub fn set_source_archived(&self, id: &str, archived: bool) -> Result<bool> {
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, id)? else {
                return Ok(false);
            };
            record.archived = archived;
            put_json(tx, &source_key(id), &record)?;
            Ok(true)
        })
    }

    /// `writeSourceSyncHeartbeat(sourceId)`: stamps `last_sync_at` with the store clock and leaves
    /// the commit anchor alone (the 0-change sync heartbeat). An unknown source changes nothing.
    pub fn write_source_sync_heartbeat(&self, source_id: &str) -> Result<()> {
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, source_id)? else {
                return Ok(());
            };
            record.last_sync_at_us = Some(self.env.now_micros());
            put_json(tx, &source_key(source_id), &record)
        })
    }

    /// `writeSourceUpstreamObservation(sourceId, checkedAt, commit, behind)`: the sync's upstream
    /// observation of the source's checkout. `checked_at` is an ISO time. An unknown source changes
    /// nothing.
    pub fn write_source_upstream_observation(
        &self,
        source_id: &str,
        checked_at: &str,
        commit: &str,
        behind: Option<i64>,
    ) -> Result<()> {
        let checked_us = parse_iso(checked_at).ok_or_else(|| {
            StoreError::invalid("upstream_checked_at must be an ISO timestamp ending in Z")
        })?;
        self.write(|tx| {
            let Some(mut record) = read_source(&*tx, source_id)? else {
                return Ok(());
            };
            record.upstream_checked_at_us = Some(checked_us);
            record.upstream_commit = Some(commit.to_owned());
            record.upstream_behind = behind;
            put_json(tx, &source_key(source_id), &record)
        })
    }

    /// `getSource(id)`: the source row, archived or not, or `None`. Mirrors `getSource`.
    pub fn get_source(&self, id: &str) -> Result<Option<SourceDetailRow>> {
        Ok(read_source(&*self.read()?, id)?.map(SourceDetailRow::from))
    }

    /// `readSourceLastCommit(id)`: the commit the source's last sync advanced to, or `None` before
    /// the first advance and for an unknown source. Archived sources read too, as the SELECT does
    /// not filter them.
    pub fn read_source_last_commit(&self, id: &str) -> Result<Option<String>> {
        Ok(read_source(&*self.read()?, id)?.and_then(|r| r.last_commit))
    }

    /// `countRepoBoundSources()`: how many sources that are not archived have a non-empty
    /// local path. Mirrors `countRepoBoundSources`.
    pub fn count_repo_bound_sources(&self) -> Result<u64> {
        Ok(all_sources(&*self.read()?)?
            .into_iter()
            .filter(|r| !r.archived && r.local_path.as_deref().is_some_and(|p| !p.is_empty()))
            .count() as u64)
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
    use super::SourceRecord;

    #[test]
    fn a_record_written_before_the_sync_anchor_fields_still_reads() {
        let old = r#"{"id":"wiki","name":"wiki","local_path":null,"config":{},"incarnation":"i1","archived":false,"created_at_us":1}"#;
        let record: SourceRecord = serde_json::from_str(old).unwrap();
        assert_eq!(record.last_sync_at_us, None);
        assert_eq!(record.last_commit, None);
        assert_eq!(record.newest_content_at_us, None);
        // Unset anchor fields are not written, so an older reader still reads a new record.
        let back = serde_json::to_value(&record).unwrap();
        assert!(back.get("last_commit").is_none() && back.get("newest_content_at_us").is_none());
        assert!(
            back.get("upstream_commit").is_none() && back.get("upstream_checked_at_us").is_none()
        );
    }

    #[test]
    fn the_upstream_observation_lands_on_one_source_only() {
        let store = crate::test_support::store();
        let wiki = super::SourceInput {
            id: "wiki".into(),
            ..Default::default()
        };
        store.upsert_source(&wiki).unwrap();
        store
            .write_source_upstream_observation("wiki", "2026-01-02T03:04:05.000Z", "u1", Some(2))
            .unwrap();
        store
            .write_source_upstream_observation("wiki", "2026-01-03T03:04:05.000Z", "u2", None)
            .unwrap();
        store
            .write_source_upstream_observation("missing", "2026-01-02T03:04:05.000Z", "u9", Some(0))
            .unwrap();
        assert!(
            store
                .write_source_upstream_observation("wiki", "not a time", "u3", Some(1))
                .is_err()
        );
        let record = super::read_source(&*store.read().unwrap(), "wiki")
            .unwrap()
            .unwrap();
        assert_eq!(record.upstream_commit.as_deref(), Some("u2"));
        assert_eq!(record.upstream_behind, None);
        assert_eq!(
            record
                .upstream_checked_at_us
                .map(crate::env::iso)
                .as_deref(),
            Some("2026-01-03T03:04:05.000000Z")
        );
        assert!(
            super::read_source(&*store.read().unwrap(), "missing")
                .unwrap()
                .is_none()
        );
    }
}
