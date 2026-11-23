//! Code call edges between chunks and symbols: the `code_edges_chunk` and `code_edges_symbol`
//! tables of the PGLite engine.
//!
//! Members: addCodeEdges, deleteCodeEdgesForChunks, getCallersOf, getCalleesOf, getEdgesByChunk,
//! hasCodeEdgesSymbol. The `code_traversal_cache` table, which memoises what these edges answer,
//! is kept by the `traversal_cache` submodule under its own key tag (getCodeTraversalCache,
//! putCodeTraversalCache, clearCodeTraversalCache).
//!
//! An edge is resolved (a `code_edges_chunk` row, `Table::Chunk`) when the caller knows the chunk
//! it points at, and unresolved (a `code_edges_symbol` row, `Table::Symbol`) when it knows only the
//! target symbol's name. The two tables keep separate id sequences, as the two `SERIAL` columns do.
//!
//! Keys (every record starts with `keys::CODE_EDGE`, `H`; `table` is one byte, 0 for the chunk
//! table and 1 for the symbol table; numbers are 8 big-endian bytes; text parts hold no NUL):
//! - `H 0x01 table id` -> `EdgeRecord` (JSON): the row.
//! - `H 0x02 from_chunk to_chunk edge_type` -> id: the chunk table's unique key
//!   `(from_chunk_id, to_chunk_id, edge_type)`.
//! - `H 0x03 from_chunk to_symbol NUL edge_type` -> id: the symbol table's unique key
//!   `(from_chunk_id, to_symbol_qualified, edge_type)`.
//! - `H 0x04 chunk_id table id` -> empty: every row with `chunk_id` as an end (`from_chunk_id`
//!   of both tables, `to_chunk_id` of the chunk table). Chunk deletes and chunk reads use it.
//! - `H 0x05 to_symbol NUL table id` and `H 0x06 from_symbol NUL table id` -> empty: the rows by
//!   target and by caller name, for getCallersOf and getCalleesOf.
//!
//! Cascades: the foreign keys `from_chunk_id` / `to_chunk_id` -> `content_chunks ON DELETE
//! CASCADE` are `remove_chunk_rows`, which every chunk delete (a page delete included) calls;
//! `source_id -> sources ON DELETE CASCADE` is `remove_source_rows`.
//!
//! The chunk store has no index by chunk id, so a call that needs a chunk's page (the foreign key
//! check of addCodeEdges, the live-endpoint filter of the caller and callee reads, the bare-name
//! fallback) reads every chunk record once.

use crate::dream::{jsonb, jsonb_check};
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::{PageRecord, next_id, read_page_by_id};
use crate::sources::read_source;
use crate::takes::{fk_failed, int4, not_null};
use crate::timeline_queries::jsonb_field_text;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};

mod traversal_cache;
pub use traversal_cache::{CacheClearInput, CacheKeyInput, CachePutInput};

const ROW: u8 = 0x01;
const CHUNK_UNIQUE: u8 = 0x02;
const SYMBOL_UNIQUE: u8 = 0x03;
const BY_CHUNK: u8 = 0x04;
const BY_TO_SYMBOL: u8 = 0x05;
const BY_FROM_SYMBOL: u8 = 0x06;

const CHUNK_TABLE: &str = "code_edges_chunk";
const SYMBOL_TABLE: &str = "code_edges_symbol";

/// `text_projection_revision` of a page whose pre-activation index is still served
/// (`ACTIVATION_SERVED_REVISION`, src/core/search/safe-chunks.ts).
const ACTIVATION_SERVED_REVISION: &str = "00000000-0000-0000-0000-000000000153";

/// Which table a row belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Table {
    Chunk,
    Symbol,
}

impl Table {
    fn byte(self) -> u8 {
        match self {
            Table::Chunk => 0,
            Table::Symbol => 1,
        }
    }

    fn from_byte(b: u8) -> Option<Self> {
        match b {
            0 => Some(Table::Chunk),
            1 => Some(Table::Symbol),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Table::Chunk => CHUNK_TABLE,
            Table::Symbol => SYMBOL_TABLE,
        }
    }

    pub(crate) fn sequence(self) -> &'static str {
        match self {
            Table::Chunk => "next_code_edge_chunk",
            Table::Symbol => "next_code_edge_symbol",
        }
    }
}

/// One row of either table. `to_chunk_id` is set only on the chunk table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct EdgeRecord {
    pub table: Table,
    pub id: u64,
    pub from_chunk_id: u64,
    pub to_chunk_id: Option<u64>,
    pub from_symbol_qualified: String,
    pub to_symbol_qualified: String,
    pub edge_type: String,
    pub edge_metadata: Value,
    pub source_id: Option<String>,
    pub created_at_us: i64,
}

impl EdgeRecord {
    /// The row as both engines' reads select it (`rowToCodeEdge` in the shell finishes it).
    fn to_row(&self) -> Value {
        json!({
            "id": self.id,
            "from_chunk_id": self.from_chunk_id,
            "to_chunk_id": self.to_chunk_id,
            "from_symbol_qualified": self.from_symbol_qualified,
            "to_symbol_qualified": self.to_symbol_qualified,
            "edge_type": self.edge_type,
            "edge_metadata": self.edge_metadata,
            "source_id": self.source_id,
            "resolved": self.table == Table::Chunk,
        })
    }

    /// Every key of the row: the record, its unique key and its index entries.
    fn keys(&self) -> Vec<Vec<u8>> {
        let t = self.table;
        let mut out = vec![
            row_key(t, self.id),
            unique_key(
                t,
                self.from_chunk_id,
                self.to_chunk_id,
                &self.to_symbol_qualified,
                &self.edge_type,
            ),
            by_chunk_key(self.from_chunk_id, t, self.id),
            by_symbol_key(BY_TO_SYMBOL, &self.to_symbol_qualified, t, self.id),
            by_symbol_key(BY_FROM_SYMBOL, &self.from_symbol_qualified, t, self.id),
        ];
        if let Some(to) = self.to_chunk_id
            && to != self.from_chunk_id
        {
            out.push(by_chunk_key(to, t, self.id));
        }
        out
    }
}

fn row_key(table: Table, id: u64) -> Vec<u8> {
    let mut key = vec![keys::CODE_EDGE, ROW, table.byte()];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn row_prefix(table: Table) -> Vec<u8> {
    vec![keys::CODE_EDGE, ROW, table.byte()]
}

fn unique_key(
    table: Table,
    from: u64,
    to_chunk: Option<u64>,
    to_symbol: &str,
    edge_type: &str,
) -> Vec<u8> {
    let tag = match (table, to_chunk) {
        (Table::Chunk, Some(_)) => CHUNK_UNIQUE,
        _ => SYMBOL_UNIQUE,
    };
    let mut key = vec![keys::CODE_EDGE, tag];
    key.extend_from_slice(&from.to_be_bytes());
    match (table, to_chunk) {
        (Table::Chunk, Some(to)) => key.extend_from_slice(&to.to_be_bytes()),
        _ => {
            key.extend_from_slice(to_symbol.as_bytes());
            key.push(0);
        }
    }
    key.extend_from_slice(edge_type.as_bytes());
    key
}

fn by_chunk_prefix(chunk_id: u64) -> Vec<u8> {
    let mut key = vec![keys::CODE_EDGE, BY_CHUNK];
    key.extend_from_slice(&chunk_id.to_be_bytes());
    key
}

fn by_chunk_key(chunk_id: u64, table: Table, id: u64) -> Vec<u8> {
    let mut key = by_chunk_prefix(chunk_id);
    key.push(table.byte());
    key.extend_from_slice(&id.to_be_bytes());
    key
}

fn by_symbol_prefix(tag: u8, symbol: &str) -> Vec<u8> {
    let mut key = vec![keys::CODE_EDGE, tag];
    key.extend_from_slice(symbol.as_bytes());
    key.push(0);
    key
}

fn by_symbol_key(tag: u8, symbol: &str, table: Table, id: u64) -> Vec<u8> {
    let mut key = by_symbol_prefix(tag, symbol);
    key.push(table.byte());
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// The `(table, id)` at the end of an index key.
fn tail_ref(key: &[u8]) -> Option<(Table, u64)> {
    let n = key.len();
    if n < 9 {
        return None;
    }
    let table = Table::from_byte(key[n - 9])?;
    Some((table, keys::be8(&key[n - 8..])?))
}

fn read_edge(read: &dyn KvRead, table: Table, id: u64) -> Result<Option<EdgeRecord>> {
    get_json(read, &row_key(table, id))
}

/// The rows an index prefix names, chunk table first, each table in id order.
fn edges_under(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<EdgeRecord>> {
    let mut refs = BTreeSet::new();
    scan_prefix(read, prefix, false, &mut |k, _| {
        if let Some(r) = tail_ref(k) {
            refs.insert(r);
        }
        true
    })?;
    let mut out = Vec::with_capacity(refs.len());
    for (table, id) in refs {
        if let Some(edge) = read_edge(read, table, id)? {
            out.push(edge);
        }
    }
    Ok(out)
}

fn table_rows(read: &dyn KvRead, table: Table) -> Result<Vec<EdgeRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &row_prefix(table), false, &mut |_, v| {
        match serde_json::from_slice::<EdgeRecord>(v) {
            Ok(edge) => out.push(edge),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

fn delete_edge(tx: &mut dyn KvWrite, edge: &EdgeRecord) -> Result<()> {
    for key in edge.keys() {
        tx.delete(&key)?;
    }
    Ok(())
}

/// Deletes every row with one of `chunk_ids` as an end.
fn delete_for_chunks(tx: &mut dyn KvWrite, chunk_ids: &[u64]) -> Result<()> {
    let mut doomed: BTreeSet<(Table, u64)> = BTreeSet::new();
    for chunk_id in chunk_ids {
        scan_prefix(&*tx, &by_chunk_prefix(*chunk_id), false, &mut |k, _| {
            if let Some(r) = tail_ref(k) {
                doomed.insert(r);
            }
            true
        })?;
    }
    for (table, id) in doomed {
        if let Some(edge) = read_edge(&*tx, table, id)? {
            delete_edge(tx, &edge)?;
        }
    }
    Ok(())
}

/// Deletes this family's records of a page that is deleted for good (`cascade::remove_page_rows`).
/// The page's chunks are removed first (`pages::remove_page` clears them, which runs
/// `remove_chunk_rows`), so every edge with an end on the page is already gone. Nothing is keyed by
/// page.
pub(crate) fn remove_page_rows(_tx: &mut dyn KvWrite, _page: &PageRecord) -> Result<()> {
    Ok(())
}

/// The shadow seed (`seed.rs`): stores `edge`, a row copied from another engine with its own id and
/// `created_at`, with its unique key and every index key `add_code_edges` writes. `false` when the
/// id already holds a row of the table; the unique key held by another id is the unique violation.
/// The caller checked the chunks and the source.
pub(crate) fn seed_edge(tx: &mut dyn KvWrite, edge: &EdgeRecord) -> Result<bool> {
    if tx.get(&row_key(edge.table, edge.id))?.is_some() {
        return Ok(false);
    }
    let all = edge.keys();
    if tx.get(&all[1])?.is_some() {
        return Err(StoreError::new(
            CONSTRAINT_VIOLATION,
            format!(
                "duplicate key value violates unique constraint \"{}_unique\"",
                edge.table.name()
            ),
        ));
    }
    tx.put(&all[1], &edge.id.to_be_bytes())?;
    for key in &all[2..] {
        tx.put(key, &[])?;
    }
    put_json(tx, &all[0], edge)?;
    Ok(true)
}

/// Deletes the rows of chunks that are gone (`cascade::remove_chunk_rows`): every row of either
/// table whose `from_chunk_id` is one of them, and every chunk-table row whose `to_chunk_id` is,
/// as the two `ON DELETE CASCADE` foreign keys do. Rows of other chunks of the page stay.
pub(crate) fn remove_chunk_rows(
    tx: &mut dyn KvWrite,
    _page_id: u64,
    chunk_ids: &[u64],
) -> Result<()> {
    delete_for_chunks(tx, chunk_ids)
}

/// Deletes the rows whose `source_id` is a source that is deleted (`cascade::remove_source_rows`,
/// the `source_id -> sources ON DELETE CASCADE` foreign key), whatever chunks they join.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    for table in [Table::Chunk, Table::Symbol] {
        for edge in table_rows(&*tx, table)? {
            if edge.source_id.as_deref() == Some(source_id) {
                delete_edge(tx, &edge)?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Chunks.

#[derive(Deserialize)]
struct ChunkLite {
    id: u64,
    page_id: u64,
    #[serde(default)]
    meta: Map<String, Value>,
}

/// Every chunk by id: its page and its `symbol_name`.
struct Chunks(HashMap<u64, (u64, Option<String>)>);

impl Chunks {
    fn load(read: &dyn KvRead) -> Result<Self> {
        let mut map = HashMap::new();
        let mut failure = None;
        scan_prefix(read, &[keys::CHUNK], false, &mut |_, v| {
            match serde_json::from_slice::<ChunkLite>(v) {
                Ok(c) => {
                    let symbol = c
                        .meta
                        .get("symbol_name")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    map.insert(c.id, (c.page_id, symbol));
                }
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        failure.map_or(Ok(Chunks(map)), Err)
    }

    fn page_of(&self, chunk_id: u64) -> Option<u64> {
        self.0.get(&chunk_id).map(|(page, _)| *page)
    }

    /// `SELECT id FROM content_chunks WHERE symbol_name = name` (any page, any state).
    fn named(&self, name: &str) -> HashSet<u64> {
        self.0
            .iter()
            .filter(|(_, (_, symbol))| symbol.as_deref() == Some(name))
            .map(|(id, _)| *id)
            .collect()
    }
}

/// `currentCodeEdgeFilter`: an end chunk counts when its page is live (not soft-deleted, no
/// `quarantine` frontmatter key, in a source that exists and is not archived) and serves its
/// text projection (sealed at the current revision, or the pre-activation index).
struct Endpoints<'a> {
    read: &'a dyn KvRead,
    chunks: Chunks,
    pages: HashMap<u64, bool>,
    sources: HashMap<String, bool>,
}

impl<'a> Endpoints<'a> {
    fn new(read: &'a dyn KvRead) -> Result<Self> {
        Ok(Endpoints {
            read,
            chunks: Chunks::load(read)?,
            pages: HashMap::new(),
            sources: HashMap::new(),
        })
    }

    fn page_passes(&mut self, page: &PageRecord) -> Result<bool> {
        if page.deleted_at_us.is_some() || page.frontmatter.contains_key("quarantine") {
            return Ok(false);
        }
        let served = match page.text_projection_revision.as_deref() {
            Some(rev) => rev == page.knowledge_revision || rev == ACTIVATION_SERVED_REVISION,
            None => false,
        };
        if !served {
            return Ok(false);
        }
        let open = match self.sources.get(&page.source_id) {
            Some(open) => *open,
            None => {
                let open = read_source(self.read, &page.source_id)?.is_some_and(|s| !s.archived);
                self.sources.insert(page.source_id.clone(), open);
                open
            }
        };
        Ok(open)
    }

    fn chunk_passes(&mut self, chunk_id: u64) -> Result<bool> {
        let Some(page_id) = self.chunks.page_of(chunk_id) else {
            return Ok(false);
        };
        if let Some(ok) = self.pages.get(&page_id) {
            return Ok(*ok);
        }
        let ok = match read_page_by_id(self.read, page_id)? {
            Some(page) => self.page_passes(&page)?,
            None => false,
        };
        self.pages.insert(page_id, ok);
        Ok(ok)
    }

    fn edge_passes(&mut self, edge: &EdgeRecord) -> Result<bool> {
        if !self.chunk_passes(edge.from_chunk_id)? {
            return Ok(false);
        }
        match (edge.table, edge.to_chunk_id) {
            (Table::Chunk, Some(to)) => self.chunk_passes(to),
            _ => Ok(true),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Inputs.

/// `CodeEdgeInput` after the shell resolved its defaults (`source_id ?? 'default'`,
/// `edge_metadata ?? {}` through a JSON round trip).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct CodeEdgeInput {
    pub from_chunk_id: Value,
    pub to_chunk_id: Value,
    pub from_symbol_qualified: Option<String>,
    pub to_symbol_qualified: Option<String>,
    pub edge_type: Option<String>,
    pub edge_metadata: Value,
    pub source_id: Option<String>,
}

/// `getCallersOf` / `getCalleesOf` after the shell resolved its defaults.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct EdgeLookup {
    /// The qualified name the read keys on (ignored when `chunk_id` is set).
    pub name: String,
    /// `opts.chunkId`: read by chunk identity instead of by name.
    pub chunk_id: Value,
    /// The edge source the read keeps; null reads every source (`allSources`, or no `sourceId`).
    pub source_id: Option<String>,
    /// `min(limit ?? 100, 500)`, shared by both tables.
    pub limit: i64,
    /// getCalleesOf: re-key on the bare chunk `symbol_name` when the exact name finds nothing (the
    /// shell already checked the opt-in and that the name has no `.`, `#` or `:`).
    pub bare_fallback: bool,
}

/// `getEdgesByChunk` after the shell resolved its defaults.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ChunkEdgesOptions {
    pub chunk_id: Value,
    /// `in`, `out` or `both`.
    pub direction: String,
    /// Only rows of this `edge_type`; null keeps every type.
    pub edge_type: Option<String>,
    /// `min(limit ?? 50, 200)`, applied to each table on its own.
    pub limit: i64,
}

/// A chunk id: a whole `int4`, never null.
fn chunk_id(value: &Value, op: &str, column: &str) -> Result<Option<u64>> {
    Ok(int4(value, op, column)?.map(|v| u64::try_from(v).unwrap_or(u64::MAX)))
}

/// `LIMIT n`: Postgres refuses a negative count.
fn limit(n: i64) -> Result<usize> {
    usize::try_from(n).map_err(|_| StoreError::invalid("LIMIT must not be negative"))
}

/// `int4in` of `->>` text: optional blanks, an optional sign and decimal digits (an `_` may join
/// two digits); anything else is refused as Postgres refuses the whole read.
fn int4_text(text: &str) -> Result<i32> {
    let syntax =
        || StoreError::invalid(format!("invalid input syntax for type integer: \"{text}\""));
    let trimmed = text.trim_matches(|c: char| c.is_ascii_whitespace());
    let (negative, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (true, &trimmed[1..]),
        Some(b'+') => (false, &trimmed[1..]),
        _ => (false, trimmed),
    };
    let bytes = digits.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_digit() || !bytes[bytes.len() - 1].is_ascii_digit() {
        return Err(syntax());
    }
    let mut value: i64 = 0;
    let mut prev_underscore = false;
    for b in bytes {
        match b {
            b'0'..=b'9' => {
                value = value.saturating_mul(10).saturating_add(i64::from(b - b'0'));
                prev_underscore = false;
            }
            b'_' if !prev_underscore => prev_underscore = true,
            _ => return Err(syntax()),
        }
    }
    let value = if negative { -value } else { value };
    i32::try_from(value).map_err(|_| {
        StoreError::invalid(format!("value \"{text}\" is out of range for type integer"))
    })
}

/// `(edge_metadata->>'resolved_chunk_id')::int`.
fn resolved_chunk_id(metadata: &Value) -> Result<Option<i32>> {
    match metadata
        .as_object()
        .and_then(|m| m.get("resolved_chunk_id"))
        .and_then(jsonb_field_text)
    {
        Some(text) => int4_text(&text).map(Some),
        None => Ok(None),
    }
}

fn in_scope(edge: &EdgeRecord, source_id: &Option<String>) -> bool {
    source_id
        .as_ref()
        .is_none_or(|s| edge.source_id.as_deref() == Some(s.as_str()))
}

impl Store {
    /// `addCodeEdges(edges)`: inserts the resolved edges (a `to_chunk_id`) into the chunk table and
    /// the others into the symbol table, skipping a row whose unique key is already there (a row
    /// repeated in the batch too). Returns the number of rows inserted. Like the two Postgres
    /// statements, each table checks its not-null columns row by row, then its foreign keys for
    /// the rows it inserted (`from_chunk_id`, `source_id`, `to_chunk_id`, in constraint-name order);
    /// unlike them, a failure leaves neither table changed.
    pub fn add_code_edges(&self, edges: &[CodeEdgeInput]) -> Result<u64> {
        const OP: &str = "addCodeEdges";
        if edges.is_empty() {
            return Ok(0);
        }
        // The binds are typed before any row is written.
        let mut parsed = Vec::with_capacity(edges.len());
        for e in edges {
            let from = chunk_id(&e.from_chunk_id, OP, "from_chunk_id")?;
            let to = chunk_id(&e.to_chunk_id, OP, "to_chunk_id")?;
            let texts = [
                ("from_symbol_qualified", &e.from_symbol_qualified),
                ("to_symbol_qualified", &e.to_symbol_qualified),
                ("edge_type", &e.edge_type),
                ("source_id", &e.source_id),
            ];
            let present: Vec<(&str, &str)> = texts
                .iter()
                .filter_map(|(n, v)| v.as_deref().map(|v| (*n, v)))
                .collect();
            no_nul(OP, &present)?;
            jsonb_check(OP, "edge_metadata", &e.edge_metadata)?;
            parsed.push((e, from, to));
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            let chunks = Chunks::load(&*tx)?;
            let mut inserted = 0u64;
            for table in [Table::Chunk, Table::Symbol] {
                let mut added: Vec<EdgeRecord> = Vec::new();
                for (e, from, to) in parsed
                    .iter()
                    .filter(|(e, _, _)| (table == Table::Chunk) == !e.to_chunk_id.is_null())
                {
                    let name = table.name();
                    let from = from.ok_or_else(|| not_null(name, "from_chunk_id"))?;
                    let to_chunk = match table {
                        Table::Chunk => Some(to.ok_or_else(|| not_null(name, "to_chunk_id"))?),
                        Table::Symbol => None,
                    };
                    let need = |v: &Option<String>, column: &str| {
                        v.clone().ok_or_else(|| not_null(name, column))
                    };
                    let from_symbol = need(&e.from_symbol_qualified, "from_symbol_qualified")?;
                    let to_symbol = need(&e.to_symbol_qualified, "to_symbol_qualified")?;
                    let edge_type = need(&e.edge_type, "edge_type")?;
                    let metadata = if e.edge_metadata.is_null() {
                        // `JSON.stringify(null)::jsonb` is the JSON null, which `NOT NULL` allows;
                        // the shell sends `{}` for a missing value.
                        Value::Null
                    } else {
                        jsonb(&e.edge_metadata)
                    };
                    let unique = unique_key(table, from, to_chunk, &to_symbol, &edge_type);
                    if tx.get(&unique)?.is_some() {
                        continue;
                    }
                    let id = next_id(tx, table.sequence())?;
                    let edge = EdgeRecord {
                        table,
                        id,
                        from_chunk_id: from,
                        to_chunk_id: to_chunk,
                        from_symbol_qualified: from_symbol,
                        to_symbol_qualified: to_symbol,
                        edge_type,
                        edge_metadata: metadata,
                        source_id: e.source_id.clone(),
                        created_at_us: now,
                    };
                    tx.put(&unique, &id.to_be_bytes())?;
                    for key in edge.keys().into_iter().skip(2) {
                        tx.put(&key, &[])?;
                    }
                    put_json(tx, &row_key(table, id), &edge)?;
                    added.push(edge);
                }
                for edge in &added {
                    let name = table.name();
                    if chunks.page_of(edge.from_chunk_id).is_none() {
                        return Err(fk_failed(name, &format!("{name}_from_chunk_id_fkey")));
                    }
                    if let Some(source) = &edge.source_id
                        && read_source(&*tx, source)?.is_none()
                    {
                        return Err(fk_failed(name, &format!("{name}_source_id_fkey")));
                    }
                    if let Some(to) = edge.to_chunk_id
                        && chunks.page_of(to).is_none()
                    {
                        return Err(fk_failed(name, &format!("{name}_to_chunk_id_fkey")));
                    }
                }
                inserted += added.len() as u64;
            }
            Ok(inserted)
        })
    }

    /// `hasCodeEdgesSymbol(sourceId)`: whether the source owns an unresolved (symbol) edge.
    pub fn has_code_edges_symbol(&self, source_id: &str) -> Result<bool> {
        Ok(table_rows(&*self.read()?, Table::Symbol)?
            .iter()
            .any(|e| e.source_id.as_deref() == Some(source_id)))
    }

    /// `deleteCodeEdgesForChunks(ids)`: deletes the chunk-table rows with an end in `ids` and the
    /// symbol-table rows leaving one of them.
    pub fn delete_code_edges_for_chunks(&self, ids: &[Value]) -> Result<()> {
        const OP: &str = "deleteCodeEdgesForChunks";
        let mut chunk_ids = Vec::new();
        for v in ids {
            // A null element matches nothing (`= ANY` with a NULL is never true).
            if let Some(id) = chunk_id(v, OP, "chunkIds")? {
                chunk_ids.push(id);
            }
        }
        if ids.is_empty() {
            return Ok(());
        }
        self.write(|tx| delete_for_chunks(tx, &chunk_ids))
    }

    /// `getCallersOf(name, opts)`: rows pointing at `name` (or, with a chunk id, chunk-table rows
    /// pointing at the chunk and symbol-table rows the resolver stamped with it), chunk table first.
    pub fn get_callers_of(&self, lookup: &EdgeLookup) -> Result<Vec<Value>> {
        const OP: &str = "getCallersOf";
        no_nul(OP, &[("qualifiedName", lookup.name.as_str())])?;
        let by_chunk = chunk_id(&lookup.chunk_id, OP, "chunkId")?;
        let limit = limit(lookup.limit)?;
        let read = self.read()?;
        let candidates = match by_chunk {
            Some(chunk) => {
                let mut rows: Vec<EdgeRecord> = edges_under(&*read, &by_chunk_prefix(chunk))?
                    .into_iter()
                    .filter(|e| e.table == Table::Chunk && e.to_chunk_id == Some(chunk))
                    .collect();
                // The cast runs on every symbol row, so one bad stamp fails the read.
                for edge in table_rows(&*read, Table::Symbol)? {
                    if resolved_chunk_id(&edge.edge_metadata)?
                        .is_some_and(|id| i64::from(id) == chunk as i64)
                    {
                        rows.push(edge);
                    }
                }
                rows
            }
            None => edges_under(&*read, &by_symbol_prefix(BY_TO_SYMBOL, &lookup.name))?,
        };
        let mut endpoints = Endpoints::new(&*read)?;
        finish(candidates, lookup, limit, &mut endpoints)
    }

    /// `getCalleesOf(name, opts)`: rows leaving `name` (or the chunk), chunk table first. With
    /// `bare_fallback`, an empty read re-keys on the chunks whose `symbol_name` is `name`.
    pub fn get_callees_of(&self, lookup: &EdgeLookup) -> Result<Vec<Value>> {
        const OP: &str = "getCalleesOf";
        no_nul(OP, &[("qualifiedName", lookup.name.as_str())])?;
        let by_chunk = chunk_id(&lookup.chunk_id, OP, "chunkId")?;
        let limit = limit(lookup.limit)?;
        let read = self.read()?;
        let mut endpoints = Endpoints::new(&*read)?;
        let leaving = |chunks: &HashSet<u64>| -> Result<Vec<EdgeRecord>> {
            let mut rows = Vec::new();
            let mut ordered: Vec<u64> = chunks.iter().copied().collect();
            ordered.sort_unstable();
            for chunk in ordered {
                rows.extend(
                    edges_under(&*read, &by_chunk_prefix(chunk))?
                        .into_iter()
                        .filter(|e| e.from_chunk_id == chunk),
                );
            }
            rows.sort_by_key(|e| (e.table, e.id));
            Ok(rows)
        };
        if let Some(chunk) = by_chunk {
            let rows = leaving(&HashSet::from([chunk]))?;
            return finish(rows, lookup, limit, &mut endpoints);
        }
        let rows = edges_under(&*read, &by_symbol_prefix(BY_FROM_SYMBOL, &lookup.name))?;
        let found = finish(rows, lookup, limit, &mut endpoints)?;
        if !found.is_empty() || !lookup.bare_fallback {
            return Ok(found);
        }
        let named = endpoints.chunks.named(&lookup.name);
        let rows = leaving(&named)?;
        finish(rows, lookup, limit, &mut endpoints)
    }

    /// `getEdgesByChunk(chunkId, opts)`: the chunk-table rows by direction, then (unless the
    /// direction is `in`) the symbol-table rows leaving the chunk, each table limited on its own.
    /// No live filter, as in PGLite.
    pub fn get_edges_by_chunk(&self, options: &ChunkEdgesOptions) -> Result<Vec<Value>> {
        const OP: &str = "getEdgesByChunk";
        if let Some(t) = &options.edge_type {
            no_nul(OP, &[("edgeType", t.as_str())])?;
        }
        let limit = limit(options.limit)?;
        let Some(chunk) = chunk_id(&options.chunk_id, OP, "chunkId")? else {
            return Ok(Vec::new());
        };
        let read = self.read()?;
        let typed = |e: &EdgeRecord| options.edge_type.as_ref().is_none_or(|t| e.edge_type == *t);
        let all = edges_under(&*read, &by_chunk_prefix(chunk))?;
        let mut out: Vec<Value> = all
            .iter()
            .filter(|e| e.table == Table::Chunk && typed(e))
            .filter(|e| match options.direction.as_str() {
                "in" => e.to_chunk_id == Some(chunk),
                "out" => e.from_chunk_id == chunk,
                _ => true,
            })
            .take(limit)
            .map(EdgeRecord::to_row)
            .collect();
        if options.direction != "in" {
            out.extend(
                all.iter()
                    .filter(|e| e.table == Table::Symbol && e.from_chunk_id == chunk && typed(e))
                    .take(limit)
                    .map(EdgeRecord::to_row),
            );
        }
        Ok(out)
    }
}

/// The read filters both tables share (live ends, then the edge source), and the shared limit.
fn finish(
    rows: Vec<EdgeRecord>,
    lookup: &EdgeLookup,
    limit: usize,
    endpoints: &mut Endpoints<'_>,
) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for edge in rows {
        if out.len() >= limit {
            break;
        }
        if in_scope(&edge, &lookup.source_id) && endpoints.edge_passes(&edge)? {
            out.push(edge.to_row());
        }
    }
    Ok(out)
}

/// The shadow follow (`seed/follow.rs`): removes the row `id` of `table` with its unique and index
/// keys. `false` when there is none.
pub(crate) fn remove_edge(tx: &mut dyn KvWrite, table: Table, id: u64) -> Result<bool> {
    let Some(edge) = read_edge(&*tx, table, id)? else {
        return Ok(false);
    };
    delete_edge(tx, &edge)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunks::{ChunkInput, UpsertChunksOptions};
    use crate::pages::{PageInput, PutPageOptions, ReadScope};

    fn seed(store: &Store, slug: &str, symbols: &[&str]) -> Vec<u64> {
        let input = PageInput {
            page_type: "code".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        let chunks: Vec<ChunkInput> = symbols
            .iter()
            .enumerate()
            .map(|(i, s)| {
                let mut rest = Map::new();
                rest.insert("symbol_name".into(), json!(s));
                ChunkInput {
                    chunk_index: i as u32,
                    chunk_text: format!("fn {s}() {{}}"),
                    rest,
                    ..ChunkInput::default()
                }
            })
            .collect();
        store
            .upsert_chunks(
                slug,
                &chunks,
                &UpsertChunksOptions {
                    seal: true,
                    ..UpsertChunksOptions::default()
                },
            )
            .unwrap();
        store
            .get_chunks(slug, &ReadScope::default())
            .unwrap()
            .iter()
            .map(|c| c["id"].as_u64().unwrap())
            .collect()
    }

    fn edge(from: u64, to: Option<u64>, from_symbol: &str, to_symbol: &str) -> CodeEdgeInput {
        CodeEdgeInput {
            from_chunk_id: json!(from),
            to_chunk_id: to.map_or(Value::Null, |t| json!(t)),
            from_symbol_qualified: Some(from_symbol.into()),
            to_symbol_qualified: Some(to_symbol.into()),
            edge_type: Some("calls".into()),
            edge_metadata: json!({}),
            source_id: Some("default".into()),
        }
    }

    fn by_chunk(store: &Store, chunk: u64) -> usize {
        store
            .get_edges_by_chunk(&ChunkEdgesOptions {
                chunk_id: json!(chunk),
                direction: "both".into(),
                edge_type: None,
                limit: 50,
            })
            .unwrap()
            .len()
    }

    fn key_count(store: &Store) -> usize {
        let read = store.read().unwrap();
        let mut n = 0;
        scan_prefix(&*read, &[keys::CODE_EDGE], false, &mut |_, _| {
            n += 1;
            true
        })
        .unwrap();
        n
    }

    #[test]
    fn remove_chunk_rows_drops_only_the_rows_of_the_chunks_given() {
        let store = crate::test_support::store();
        let a = seed(&store, "a", &["run", "main"]);
        let b = seed(&store, "b", &["helper"]);
        store
            .add_code_edges(&[
                edge(a[0], Some(b[0]), "run", "helper"),
                edge(a[1], None, "main", "ext"),
                edge(b[0], Some(a[1]), "helper", "main"),
            ])
            .unwrap();
        store.write(|tx| remove_chunk_rows(tx, 0, &[a[0]])).unwrap();
        assert_eq!(by_chunk(&store, a[0]), 0);
        assert_eq!(by_chunk(&store, b[0]), 1);
        assert_eq!(by_chunk(&store, a[1]), 2);
        store.write(|tx| remove_chunk_rows(tx, 0, &[a[1]])).unwrap();
        assert_eq!(by_chunk(&store, b[0]), 0);
        // Every index entry went with its row.
        assert_eq!(key_count(&store), 0);
    }

    #[test]
    fn remove_page_rows_leaves_the_edges_to_the_chunk_hook() {
        let store = crate::test_support::store();
        let a = seed(&store, "a", &["run"]);
        let b = seed(&store, "b", &["helper"]);
        let c = seed(&store, "c", &["other"]);
        store
            .add_code_edges(&[
                edge(a[0], Some(b[0]), "run", "helper"),
                edge(c[0], None, "other", "ext"),
            ])
            .unwrap();
        let page = store
            .write(|tx| Ok(crate::pages::read_page(&*tx, "default", "a")?.unwrap()))
            .unwrap();
        // The page hook itself removes nothing.
        store.write(|tx| remove_page_rows(tx, &page)).unwrap();
        assert_eq!(by_chunk(&store, b[0]), 1);
        // A hard delete clears the page's chunks first, which removes the edge into `b`.
        store.delete_page("a", None).unwrap();
        assert_eq!(by_chunk(&store, b[0]), 0);
        assert_eq!(by_chunk(&store, c[0]), 1);
    }

    #[test]
    fn remove_source_rows_drops_the_rows_of_that_source_only() {
        let store = crate::test_support::store();
        let a = seed(&store, "a", &["run"]);
        store
            .upsert_source(&crate::sources::SourceInput {
                id: "gone".into(),
                name: None,
                local_path: None,
                last_sync_at: None,
                config: None,
            })
            .unwrap();
        let mut other = edge(a[0], None, "run", "ext.two");
        other.source_id = Some("gone".into());
        store
            .add_code_edges(&[edge(a[0], None, "run", "ext.one"), other])
            .unwrap();
        assert_eq!(by_chunk(&store, a[0]), 2);
        store.write(|tx| remove_source_rows(tx, "gone")).unwrap();
        assert_eq!(by_chunk(&store, a[0]), 1);
    }

    #[test]
    fn int4_text_reads_what_int4in_reads() {
        assert_eq!(int4_text(" 42 ").unwrap(), 42);
        assert_eq!(int4_text("-7").unwrap(), -7);
        assert_eq!(int4_text("+1_000").unwrap(), 1000);
        assert!(int4_text("4.5").is_err());
        assert!(int4_text("1__0").is_err());
        assert!(int4_text("_1").is_err());
        assert!(int4_text("").is_err());
        assert!(int4_text("true").is_err());
        assert!(int4_text("2147483648").is_err());
        assert_eq!(int4_text("-2147483648").unwrap(), i32::MIN);
    }
}
