//! The `code_traversal_cache` table: the memoised answers of `code_blast` and `code_flow`
//! (`src/core/code-intel/traversal-cache.ts`).
//!
//! Members: getCodeTraversalCache, putCodeTraversalCache, clearCodeTraversalCache.
//!
//! A row is the answer of one traversal, keyed by `(symbol_qualified, depth, source_id)` and
//! stamped with the `cluster_generation` it was computed at. A read asks for one generation, so a
//! row from another generation is a miss; a write on an existing key replaces the row in place
//! (the generation moves with it) and restarts `computed_at`.
//!
//! Keys (every record starts with `keys::CODE_TRAVERSAL_CACHE`, `g`; text parts hold no NUL;
//! `depth` is the `int4` as 4 big-endian bytes with the sign bit flipped):
//! - `g 0x01 id` -> `CacheRecord` (JSON): the row. `id` is the 8-byte big-endian `SERIAL`.
//! - `g 0x02 symbol NUL source NUL depth` -> id: the unique index
//!   `(symbol_qualified, depth, source_id)`.
//! - `g 0x03 source NUL id` -> empty: the rows of one source, for `clearCodeTraversalCache`.
//!
//! Ids come from the sequence `next_code_traversal_cache`. Every write takes one id, also the one
//! that lands on an existing key, as the `SERIAL` default of an `INSERT .. ON CONFLICT` does (the
//! id is never read back, so only the counter shows it).
//!
//! The table has no foreign key to `sources` and no page or chunk key, so no cascade hook touches
//! it: removing a source leaves its rows, as Postgres does.
//!
//! The TypeScript member (`store-members/code-traversal-cache.ts`) refuses what the store cannot
//! hold the way Postgres does (a generation or `xmin_max` beyond 2^53, a `max_chunk_updated_at`
//! that is not an ISO timestamp) and throws for what Postgres rejects as a bind. The store
//! checks the same again for a caller that skips the shell.

use crate::dream::{jsonb, jsonb_check};
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::next_id;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const ROW: u8 = 0x01;
const UNIQUE: u8 = 0x02;
const BY_SOURCE: u8 = 0x03;

const SEQUENCE: &str = "next_code_traversal_cache";

/// One row of `code_traversal_cache`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct CacheRecord {
    pub id: u64,
    pub symbol_qualified: String,
    pub depth: i32,
    pub source_id: String,
    pub response_json: Value,
    pub max_chunk_updated_at_us: i64,
    pub xmin_max: i64,
    pub cluster_generation: i64,
    pub computed_at_us: i64,
}

impl CacheRecord {
    fn unique_key(&self) -> Vec<u8> {
        unique_key(&self.symbol_qualified, self.depth, &self.source_id)
    }
}

/// The key of a read or write: the unique tuple, and the generation a read must match.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CacheKeyInput {
    pub symbol_qualified: String,
    pub depth: i64,
    pub source_id: String,
    pub cluster_generation: i64,
}

/// `putCachedTraversal` after the shell checked the binds and stringified the response.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CachePutInput {
    pub symbol_qualified: String,
    pub depth: i64,
    pub source_id: String,
    pub cluster_generation: i64,
    pub response_json: Value,
    /// An ISO timestamp (`Date#toISOString`), the only form the shell lets through.
    pub max_chunk_updated_at: String,
    pub xmin_max: i64,
}

/// `clearTraversalCache` after the shell resolved the scope: a source id, or null for every source.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CacheClearInput {
    pub source_id: Option<String>,
}

fn row_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::CODE_TRAVERSAL_CACHE, ROW];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn unique_key(symbol: &str, depth: i32, source: &str) -> Vec<u8> {
    let mut key = vec![keys::CODE_TRAVERSAL_CACHE, UNIQUE];
    key.extend_from_slice(symbol.as_bytes());
    key.push(0);
    key.extend_from_slice(source.as_bytes());
    key.push(0);
    key.extend_from_slice(&((depth as u32) ^ 0x8000_0000).to_be_bytes());
    key
}

fn by_source_key(source: &str, id: u64) -> Vec<u8> {
    let mut key = vec![keys::CODE_TRAVERSAL_CACHE, BY_SOURCE];
    key.extend_from_slice(source.as_bytes());
    key.push(0);
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn by_source_prefix(source: &str) -> Vec<u8> {
    let mut key = vec![keys::CODE_TRAVERSAL_CACHE, BY_SOURCE];
    key.extend_from_slice(source.as_bytes());
    key.push(0);
    key
}

/// A whole number in the `int4` range, as the column holds it.
fn depth_int4(op: &str, depth: i64) -> Result<i32> {
    i32::try_from(depth).map_err(|_| {
        StoreError::invalid(format!(
            "{op}: value \"{depth}\" is out of range for type integer (depth)"
        ))
    })
}

fn remove(tx: &mut dyn KvWrite, row: &CacheRecord) -> Result<()> {
    tx.delete(&row_key(row.id))?;
    tx.delete(&row.unique_key())?;
    tx.delete(&by_source_key(&row.source_id, row.id))
}

fn find(read: &dyn KvRead, symbol: &str, depth: i32, source: &str) -> Result<Option<CacheRecord>> {
    let Some(id) = read.get(&unique_key(symbol, depth, source))? else {
        return Ok(None);
    };
    let id = keys::be8(&id)
        .ok_or_else(|| StoreError::new(crate::error::STORE_CORRUPT, "bad traversal cache id"))?;
    get_json(read, &row_key(id))
}

fn id_bytes(id: u64) -> [u8; 8] {
    id.to_be_bytes()
}

impl Store {
    /// `getCachedTraversal`: the row at the key whose generation is the one asked for, as
    /// `{response_json, computed_at, cluster_generation}`, or null.
    pub fn get_code_traversal_cache(&self, key: &CacheKeyInput) -> Result<Option<Value>> {
        const OP: &str = "getCodeTraversalCache";
        let depth = depth_int4(OP, key.depth)?;
        no_nul(
            OP,
            &[
                ("symbol_qualified", &key.symbol_qualified),
                ("source_id", &key.source_id),
            ],
        )?;
        let read = self.read()?;
        Ok(find(&*read, &key.symbol_qualified, depth, &key.source_id)?
            .filter(|row| row.cluster_generation == key.cluster_generation)
            .map(|row| {
                json!({
                    "response_json": row.response_json,
                    "computed_at": iso(row.computed_at_us),
                    "cluster_generation": row.cluster_generation,
                })
            }))
    }

    /// `putCachedTraversal`: inserts the row, or on its key replaces the response, the
    /// timestamps, `xmin_max` and the generation and restarts `computed_at`.
    pub fn put_code_traversal_cache(&self, input: &CachePutInput) -> Result<()> {
        const OP: &str = "putCodeTraversalCache";
        let depth = depth_int4(OP, input.depth)?;
        no_nul(
            OP,
            &[
                ("symbol_qualified", &input.symbol_qualified),
                ("source_id", &input.source_id),
            ],
        )?;
        jsonb_check(OP, "response_json", &input.response_json)?;
        let max_chunk_updated_at_us = parse_iso(&input.max_chunk_updated_at).ok_or_else(|| {
            StoreError::invalid(format!(
                "{OP}: invalid input syntax for type timestamp with time zone: \"{}\"",
                input.max_chunk_updated_at
            ))
        })?;
        let response_json = jsonb(&input.response_json);
        let now = self.env.now_micros();
        self.write(|tx| {
            // The SERIAL default runs before the conflict check, so the id is taken either way.
            let fresh = next_id(tx, SEQUENCE)?;
            let existing = find(&*tx, &input.symbol_qualified, depth, &input.source_id)?;
            let id = existing.as_ref().map_or(fresh, |row| row.id);
            let row = CacheRecord {
                id,
                symbol_qualified: input.symbol_qualified.clone(),
                depth,
                source_id: input.source_id.clone(),
                response_json: response_json.clone(),
                max_chunk_updated_at_us,
                xmin_max: input.xmin_max,
                cluster_generation: input.cluster_generation,
                computed_at_us: now,
            };
            put_json(tx, &row_key(id), &row)?;
            tx.put(&row.unique_key(), &id_bytes(id))?;
            tx.put(&by_source_key(&row.source_id, id), &[])
        })
    }

    /// `clearTraversalCache`: deletes the rows of one source, or every row for a null source,
    /// and returns how many it deleted.
    pub fn clear_code_traversal_cache(&self, input: &CacheClearInput) -> Result<u64> {
        if let Some(source) = &input.source_id {
            no_nul("clearCodeTraversalCache", &[("source_id", source)])?;
        }
        self.write(|tx| {
            let mut ids: Vec<u64> = Vec::new();
            match &input.source_id {
                Some(source) => {
                    let prefix = by_source_prefix(source);
                    scan_prefix(&*tx, &prefix, false, &mut |key, _| {
                        if let Some(id) = keys::be8(&key[prefix.len()..]) {
                            ids.push(id);
                        }
                        true
                    })?;
                }
                None => {
                    scan_prefix(
                        &*tx,
                        &[keys::CODE_TRAVERSAL_CACHE, ROW],
                        false,
                        &mut |key, _| {
                            if let Some(id) = keys::be8(&key[2..]) {
                                ids.push(id);
                            }
                            true
                        },
                    )?;
                }
            }
            let mut deleted = 0u64;
            for id in ids {
                if let Some(row) = get_json::<CacheRecord>(&*tx, &row_key(id))? {
                    remove(tx, &row)?;
                    deleted += 1;
                }
            }
            Ok(deleted)
        })
    }
}
