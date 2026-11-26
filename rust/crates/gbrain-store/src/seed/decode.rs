//! Decoders for the rows the shadow seed receives: each column is the Postgres text output of the
//! value (`col::text`), or `null` for NULL. A column a row leaves out reads as NULL.

use crate::env::parse_iso;
use crate::error::{Result, StoreError};
use crate::trust::RowTrust;
use crate::write_receipt::{ActorColumns, WriteReceipt};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// One row as the caller sends it: column name to the Postgres text of its value.
pub type SeedRow = BTreeMap<String, Option<String>>;

/// A row of `relation`, with typed reads of its columns. Every error names the column.
pub(super) struct Row<'a> {
    pub relation: &'a str,
    pub row: &'a SeedRow,
}

impl<'a> Row<'a> {
    /// The column's text; `None` for NULL or a column the row leaves out.
    pub fn value(&self, col: &str) -> Option<&'a str> {
        self.row.get(col).and_then(|v| v.as_deref())
    }

    fn bad(&self, col: &str, what: impl std::fmt::Display) -> StoreError {
        StoreError::invalid(format!("seed {}.{col}: {what}", self.relation))
    }

    fn need<T>(&self, col: &str, value: Option<T>) -> Result<T> {
        value.ok_or_else(|| self.bad(col, "is NULL"))
    }

    fn parse<T>(&self, col: &str, f: impl FnOnce(&str) -> Option<T>) -> Result<Option<T>> {
        match self.value(col) {
            None => Ok(None),
            Some(text) => f(text)
                .map(Some)
                .ok_or_else(|| self.bad(col, format!("cannot read {text:?}"))),
        }
    }

    pub fn text(&self, col: &str) -> Option<String> {
        self.value(col).map(str::to_owned)
    }

    pub fn req(&self, col: &str) -> Result<String> {
        self.need(col, self.text(col))
    }

    /// A text column whose NULL reads as `default` (a `NOT NULL DEFAULT` column the caller may leave out).
    pub fn text_or(&self, col: &str, default: &str) -> String {
        self.value(col).unwrap_or(default).to_owned()
    }

    pub fn i64(&self, col: &str) -> Result<Option<i64>> {
        self.parse(col, |t| t.parse().ok())
    }

    pub fn i32(&self, col: &str) -> Result<Option<i32>> {
        self.parse(col, |t| t.parse().ok())
    }

    /// A positive id (`serial`, `bigserial`).
    pub fn id(&self, col: &str) -> Result<Option<u64>> {
        self.parse(col, |t| t.parse::<u64>().ok().filter(|v| *v > 0))
    }

    pub fn req_id(&self, col: &str) -> Result<u64> {
        self.need(col, self.id(col)?)
    }

    pub fn f32(&self, col: &str) -> Result<Option<f32>> {
        self.parse(col, |t| t.parse().ok())
    }

    pub fn f64(&self, col: &str) -> Result<Option<f64>> {
        self.parse(col, |t| t.parse().ok())
    }

    pub fn bool(&self, col: &str) -> Result<Option<bool>> {
        self.parse(col, |t| match t {
            "t" | "true" => Some(true),
            "f" | "false" => Some(false),
            _ => None,
        })
    }

    /// A `timestamptz` as microseconds since the epoch.
    pub fn ts(&self, col: &str) -> Result<Option<i64>> {
        self.parse(col, timestamp_us)
    }

    pub fn req_ts(&self, col: &str) -> Result<i64> {
        self.need(col, self.ts(col)?)
    }

    /// A `date` (`YYYY-MM-DD`), checked and kept as text.
    pub fn date(&self, col: &str) -> Result<Option<String>> {
        self.parse(col, |t| {
            (t.len() == 10 && parse_iso(&format!("{t}T00:00:00Z")).is_some()).then(|| t.to_owned())
        })
    }

    pub fn json(&self, col: &str) -> Result<Option<Value>> {
        self.parse(col, |t| serde_json::from_str(t).ok())
    }

    /// A `jsonb` that must be an object. NULL reads as `{}`.
    pub fn object(&self, col: &str) -> Result<Map<String, Value>> {
        match self.json(col)? {
            None => Ok(Map::new()),
            Some(Value::Object(map)) => Ok(map),
            Some(_) => Err(self.bad(col, "is not a JSON object")),
        }
    }

    /// A `vector` or `halfvec`: `[0.1,0.2]`.
    pub fn vector(&self, col: &str) -> Result<Option<Vec<f32>>> {
        self.parse(col, vector)
    }

    /// The seven write receipt columns of `facts`, `takes` and `timeline_entries`.
    pub fn write_receipt(&self) -> Result<WriteReceipt> {
        Ok(WriteReceipt {
            write_request_id: self.text("write_request_id"),
            write_principal_kind: self.text("write_principal_kind"),
            write_principal_id: self.text("write_principal_id"),
            last_write_request_id: self.text("last_write_request_id"),
            last_write_principal_kind: self.text("last_write_principal_kind"),
            last_write_principal_id: self.text("last_write_principal_id"),
            last_written_at_us: self.ts("last_written_at")?,
        })
    }

    /// An actor stored as three columns (`pages.revision_*`, half of a version receipt).
    pub fn actor(&self, request: &str, kind: &str, id: &str) -> ActorColumns {
        ActorColumns {
            request_id: self.text(request),
            principal_kind: self.text(kind),
            principal_id: self.text(id),
        }
    }

    /// The `trust_tier` and `write_origin` columns of `takes` and `timeline_entries`.
    pub fn row_trust(&self) -> Result<RowTrust> {
        Ok(RowTrust {
            trust_tier: self.text("trust_tier").filter(|tier| tier != "unknown"),
            write_origin: self.json("write_origin")?,
        })
    }

    /// A one-dimensional `text[]`: `{a,"b c"}`.
    pub fn text_array(&self, col: &str) -> Result<Option<Vec<String>>> {
        self.parse(col, |t| {
            text_array(t).and_then(|items| items.into_iter().collect())
        })
    }

    /// A `text[]` that may hold NULL elements (`{read,NULL}`): the elements that are text, and how many NULL elements the
    /// array held. The caller names the dropped elements as a loss. A SQL NULL column stays `None`, an empty array stays
    /// empty.
    pub fn text_array_without_nulls(&self, col: &str) -> Result<Option<(Vec<String>, u64)>> {
        self.parse(col, |t| {
            let items = text_array(t)?;
            let nulls = items.iter().filter(|i| i.is_none()).count() as u64;
            Some((items.into_iter().flatten().collect(), nulls))
        })
    }
}

/// Postgres's `timestamptz` text (`2026-11-20 07:22:05.123456+00`, any offset) or ISO-8601 with
/// `Z`, as microseconds since the epoch.
pub(super) fn timestamp_us(text: &str) -> Option<i64> {
    if text.len() < 19 || !matches!(text.as_bytes()[10], b' ' | b'T') {
        return None;
    }
    let iso = |base: &str| parse_iso(&format!("{}T{}Z", &base[..10], &base[11..]));
    if let Some(base) = text.strip_suffix('Z') {
        return iso(base);
    }
    let at = text[19..].find(['+', '-'])? + 19;
    let (base, offset) = text.split_at(at);
    let sign = if offset.starts_with('-') { -1 } else { 1 };
    let mut seconds = 0i64;
    for (i, part) in offset[1..].split(':').enumerate() {
        if i > 2 || part.len() != 2 || !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        seconds += part.parse::<i64>().ok()? * [3600, 60, 1][i];
    }
    Some(iso(base)? - sign * seconds * 1_000_000)
}

fn vector(text: &str) -> Option<Vec<f32>> {
    let inner = text.strip_prefix('[')?.strip_suffix(']')?;
    if inner.trim().is_empty() {
        return Some(Vec::new());
    }
    inner.split(',').map(|v| v.trim().parse().ok()).collect()
}

/// The elements of a one-dimensional `text[]`; a NULL element is `None` (Postgres prints it as an unquoted `NULL`).
fn text_array(text: &str) -> Option<Vec<Option<String>>> {
    let inner = text.strip_prefix('{')?.strip_suffix('}')?;
    let mut out = Vec::new();
    if inner.is_empty() {
        return Some(out);
    }
    let mut chars = inner.chars().peekable();
    loop {
        let mut item = String::new();
        let quoted = chars.peek() == Some(&'"');
        if quoted {
            chars.next();
            loop {
                match chars.next()? {
                    '\\' => item.push(chars.next()?),
                    '"' => break,
                    c => item.push(c),
                }
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c == ',' {
                    break;
                }
                if matches!(c, '{' | '}' | '"' | '\\') {
                    return None;
                }
                item.push(c);
                chars.next();
            }
            if item.is_empty() {
                return None;
            }
        }
        out.push(if !quoted && item.eq_ignore_ascii_case("NULL") {
            None
        } else {
            Some(item)
        });
        match chars.next() {
            None => return Some(out),
            Some(',') => {}
            Some(_) => return None,
        }
    }
}
