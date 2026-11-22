//! The config table: string keys to string values. Mirrors `getConfig`, `setConfig`,
//! `unsetConfig`, `listConfigKeys` and `getAllConfig` of the PGLite engine.

use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::{Store, keys};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// One row of `getConfigValues`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConfigValueRow {
    pub key: String,
    pub value: String,
}

fn config_key(key: &str) -> Result<Vec<u8>> {
    if key.contains('\0') {
        return Err(StoreError::invalid("a config key cannot contain NUL"));
    }
    Ok(keys::text(keys::CONFIG, &[key]))
}

pub(crate) fn read_config(read: &dyn KvRead, key: &str) -> Result<Option<String>> {
    match read.get(&config_key(key)?)? {
        Some(bytes) => Ok(Some(String::from_utf8(bytes).map_err(|_| {
            StoreError::new(crate::error::STORE_CORRUPT, "a config value is not UTF-8")
        })?)),
        None => Ok(None),
    }
}

fn scan_config(read: &dyn KvRead, prefix: &str) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    let mut bad = false;
    scan_prefix(
        read,
        &keys::text(keys::CONFIG, &[prefix]),
        false,
        &mut |k, v| {
            match (std::str::from_utf8(&k[1..]), std::str::from_utf8(v)) {
                (Ok(key), Ok(value)) => out.push((key.to_string(), value.to_string())),
                _ => bad = true,
            }
            true
        },
    )?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            "a config record is not UTF-8",
        ));
    }
    Ok(out)
}

impl Store {
    /// The value of `key`, or `None`. Mirrors `getConfig`.
    pub fn get_config(&self, key: &str) -> Result<Option<String>> {
        read_config(&*self.read()?, key)
    }

    /// Sets `key`, replacing any value. Mirrors `setConfig`.
    pub fn set_config(&self, key: &str, value: &str) -> Result<()> {
        let key = config_key(key)?;
        self.write(|tx| tx.put(&key, value.as_bytes()))
    }

    /// Removes `key`; returns how many rows were removed (0 or 1). Mirrors `unsetConfig`.
    pub fn unset_config(&self, key: &str) -> Result<u32> {
        let key = config_key(key)?;
        self.write(|tx| {
            if tx.get(&key)?.is_none() {
                return Ok(0);
            }
            tx.delete(&key)?;
            Ok(1)
        })
    }

    /// Keys that start with `prefix` (literally: `%` and `_` are ordinary characters), sorted.
    /// Mirrors `listConfigKeys`.
    pub fn list_config_keys(&self, prefix: &str) -> Result<Vec<String>> {
        config_key(prefix)?;
        Ok(scan_config(&*self.read()?, prefix)?
            .into_iter()
            .map(|(key, _)| key)
            .collect())
    }

    /// Every config entry. Mirrors `getAllConfig`.
    pub fn get_all_config(&self) -> Result<BTreeMap<String, String>> {
        Ok(scan_config(&*self.read()?, "")?.into_iter().collect())
    }

    /// `getConfigValues(keys)`: the stored `{key, value}` rows of the named keys, ordered by key,
    /// each key once; a key with no row (or one that cannot be a key) is left out. Mirrors
    /// `getConfigValues`.
    pub fn get_config_values(&self, keys: &[String]) -> Result<Vec<ConfigValueRow>> {
        let read = self.read()?;
        let wanted: BTreeSet<&str> = keys
            .iter()
            .map(String::as_str)
            .filter(|k| !k.contains('\0'))
            .collect();
        let mut out = Vec::new();
        for key in wanted {
            if let Some(value) = read_config(&*read, key)? {
                out.push(ConfigValueRow {
                    key: key.to_string(),
                    value,
                });
            }
        }
        Ok(out)
    }
}
