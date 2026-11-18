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
    pub last_sync_at_us: Option<i64>,
    pub config: Map<String, Value>,
    /// Changes when a source is deleted and created again; page snapshots carry it.
    pub incarnation: String,
    pub archived: bool,
    pub created_at_us: i64,
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
/// strings. The store keeps no `last_commit`, `contextual_retrieval_mode` or
/// `trust_frontmatter_overrides`: only the sync anchor and source admin SQL write those columns,
/// and neither runs on a Rust brain, so they read as the column defaults (null, null, false).
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
            last_commit: None,
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

fn source_key(id: &str) -> Vec<u8> {
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

    /// `getSource(id)`: the source row, archived or not, or `None`. Mirrors `getSource`.
    pub fn get_source(&self, id: &str) -> Result<Option<SourceDetailRow>> {
        Ok(read_source(&*self.read()?, id)?.map(SourceDetailRow::from))
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
