//! The derivation edges (`derivation_inputs`, `src/core/facts/derivation-inputs.ts`): for each derived row, every input
//! row a deriver placed in the model's context. A deriver records them in the transaction that writes the derived row
//! (`recordDerivationEdges`); the purge walk (`listDerivedRows`), the quote read (`listFactsFromQuotedPages`), the
//! legacy-page count (`countLegacyDerivedPages`) and the owner-only lineage (`owner_only.rs`, `owner_only_marks.rs`)
//! read them (rust/docs/store/derivation-inputs.md).
//!
//! Keys (family `keys::DERIVATION_INPUT`, `3`):
//! - `3 0x01 derived_table \0 derived_id \0 input_table \0 input_id -> EdgeRecord`: one row, its primary key
//!   `(derived_table, derived_id, input_table, input_id)` in byte order.
//! - `3 0x02 input_table \0 input_id \0 derived_table \0 derived_id -> ""`: the reverse index
//!   (`idx_derivation_inputs_input`), for the walk from an input to what was derived from it.
//!
//! A source delete removes the source's edges (`source_id REFERENCES sources ON DELETE CASCADE`); an edge with no
//! source stays.

use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::sources::read_source;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet, VecDeque};

const FORWARD: u8 = 0x01;
const REVERSE: u8 = 0x02;

/// One row reference: the owning table's name and its primary key as text.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
pub struct EdgeRef {
    pub table: String,
    pub id: String,
}

/// `recordDerivationEdges(derived, sourceId, edges)`'s arguments.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivationEdges {
    pub derived: EdgeRef,
    #[serde(default)]
    pub source_id: Option<String>,
    pub edges: Vec<EdgeRef>,
}

/// One `derivation_inputs` row's columns beyond its key.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EdgeRecord {
    #[serde(default)]
    source_id: Option<String>,
    created_at_us: i64,
}

fn push_parts(key: &mut Vec<u8>, parts: &[&str]) {
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            key.push(0);
        }
        key.extend_from_slice(part.as_bytes());
    }
}

fn forward_key(derived: &EdgeRef, input: &EdgeRef) -> Vec<u8> {
    let mut key = vec![keys::DERIVATION_INPUT, FORWARD];
    push_parts(
        &mut key,
        &[&derived.table, &derived.id, &input.table, &input.id],
    );
    key
}

fn reverse_key(input: &EdgeRef, derived: &EdgeRef) -> Vec<u8> {
    let mut key = vec![keys::DERIVATION_INPUT, REVERSE];
    push_parts(
        &mut key,
        &[&input.table, &input.id, &derived.table, &derived.id],
    );
    key
}

/// `tag table \0 id \0`: every edge whose first pair is `(table, id)`.
fn pair_prefix(tag: u8, row: &EdgeRef) -> Vec<u8> {
    let mut key = vec![keys::DERIVATION_INPUT, tag];
    push_parts(&mut key, &[&row.table, &row.id]);
    key.push(0);
    key
}

/// The second pair of a key under `pair_prefix`.
fn second_pair(key: &[u8], prefix_len: usize) -> Option<EdgeRef> {
    let rest = key.get(prefix_len..)?;
    let nul = rest.iter().position(|b| *b == 0)?;
    Some(EdgeRef {
        table: String::from_utf8(rest[..nul].to_vec()).ok()?,
        id: String::from_utf8(rest[nul + 1..].to_vec()).ok()?,
    })
}

fn pairs_under(read: &dyn KvRead, tag: u8, row: &EdgeRef) -> Result<Vec<EdgeRef>> {
    if row.table.contains('\0') || row.id.contains('\0') {
        return Ok(Vec::new());
    }
    let prefix = pair_prefix(tag, row);
    let mut out = Vec::new();
    let mut bad = false;
    scan_prefix(
        read,
        &prefix,
        false,
        &mut |k, _| match second_pair(k, prefix.len()) {
            Some(pair) => {
                out.push(pair);
                true
            }
            None => {
                bad = true;
                false
            }
        },
    )?;
    if bad {
        return Err(StoreError::invalid("unreadable derivation_inputs key"));
    }
    Ok(out)
}

/// The inputs recorded for `derived` (`WHERE derived_table=$1 AND derived_id=$2`), in key order.
pub(crate) fn inputs_of(read: &dyn KvRead, derived: &EdgeRef) -> Result<Vec<EdgeRef>> {
    pairs_under(read, FORWARD, derived)
}

/// The rows derived from `input` (`WHERE input_table=$1 AND input_id=$2`), in key order.
pub(crate) fn derived_from(read: &dyn KvRead, input: &EdgeRef) -> Result<Vec<EdgeRef>> {
    pairs_under(read, REVERSE, input)
}

/// Whether any edge names `derived` as its derived row.
pub(crate) fn has_inputs(read: &dyn KvRead, derived: &EdgeRef) -> Result<bool> {
    if derived.table.contains('\0') || derived.id.contains('\0') {
        return Ok(false);
    }
    let mut found = false;
    scan_prefix(read, &pair_prefix(FORWARD, derived), false, &mut |_, _| {
        found = true;
        false
    })?;
    Ok(found)
}

/// Every row reached upward from `start` by its recorded inputs, transitively (the `WITH RECURSIVE up` of
/// `gbrain_owner_only_lineage_strict`), each once, `start` itself not included unless a cycle returns to it.
pub(crate) fn lineage_inputs(read: &dyn KvRead, start: &EdgeRef) -> Result<Vec<EdgeRef>> {
    let mut seen: HashSet<EdgeRef> = HashSet::new();
    let mut out = Vec::new();
    let mut queue: VecDeque<EdgeRef> = VecDeque::from([start.clone()]);
    while let Some(row) = queue.pop_front() {
        for input in inputs_of(read, &row)? {
            if seen.insert(input.clone()) {
                out.push(input.clone());
                queue.push_back(input);
            }
        }
    }
    Ok(out)
}

/// Every row reached downward from `seeds` by the edges, transitively (the `WITH RECURSIVE down` of
/// `gbrain_owner_only_mark_derived`), each once.
pub(crate) fn derived_closure(read: &dyn KvRead, seeds: &[EdgeRef]) -> Result<Vec<EdgeRef>> {
    let mut seen: HashSet<EdgeRef> = HashSet::new();
    let mut out = Vec::new();
    let mut queue: VecDeque<EdgeRef> = seeds.iter().cloned().collect();
    while let Some(row) = queue.pop_front() {
        for derived in derived_from(read, &row)? {
            if seen.insert(derived.clone()) {
                out.push(derived.clone());
                queue.push_back(derived);
            }
        }
    }
    Ok(out)
}

/// Removes the edges recorded under `source_id` (the source delete's `ON DELETE CASCADE`).
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let prefix = [keys::DERIVATION_INPUT, FORWARD];
    let mut doomed: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    let mut bad = None;
    scan_prefix(&*tx, &prefix, false, &mut |k, v| {
        match serde_json::from_slice::<EdgeRecord>(v) {
            Ok(r) if r.source_id.as_deref() == Some(source_id) => {
                let rest = &k[prefix.len()..];
                let parts: Vec<&[u8]> = rest.split(|b| *b == 0).collect();
                if parts.len() == 4 {
                    let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
                    let derived = EdgeRef {
                        table: text(parts[0]),
                        id: text(parts[1]),
                    };
                    let input = EdgeRef {
                        table: text(parts[2]),
                        id: text(parts[3]),
                    };
                    doomed.push((k.to_vec(), reverse_key(&input, &derived)));
                }
            }
            Ok(_) => {}
            Err(e) => bad = Some(StoreError::from(e)),
        }
        bad.is_none()
    })?;
    if let Some(e) = bad {
        return Err(e);
    }
    for (forward, reverse) in doomed {
        tx.delete(&forward)?;
        tx.delete(&reverse)?;
    }
    Ok(())
}

/// `TABLE_NAME` of derivation-inputs.ts: the member checks it first; the store refuses the same.
fn valid_table(table: &str) -> bool {
    let b = table.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && (b[0].is_ascii_lowercase() || b[0] == b'_')
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

fn check(op: &str, r: &EdgeRef) -> Result<()> {
    if r.table.contains('\0') || r.id.contains('\0') {
        return Err(StoreError::invalid(format!(
            "{op}: a table or id contains a NUL character"
        )));
    }
    if !valid_table(&r.table) {
        return Err(StoreError::invalid(format!(
            "{op}: invalid derivation table name: {}",
            r.table
        )));
    }
    Ok(())
}

impl Store {
    /// `recordDerivationEdges(derived, sourceId, edges)`: records each edge of `derived` that is not recorded yet
    /// (`ON CONFLICT DO NOTHING`), with `sourceId`, in one write. A source that does not exist refuses the whole call
    /// (`derivation_inputs_source_id_fkey`) and records nothing.
    pub fn record_derivation_edges(&self, spec: &DerivationEdges) -> Result<()> {
        const OP: &str = "recordDerivationEdges";
        check(OP, &spec.derived)?;
        for e in &spec.edges {
            check(OP, e)?;
        }
        if spec.edges.is_empty() {
            return Ok(());
        }
        let now = self.env.now_micros();
        self.write(|tx| {
            if let Some(source) = spec.source_id.as_deref()
                && (source.contains('\0') || read_source(&*tx, source)?.is_none())
            {
                return Err(StoreError::new(
                    CONSTRAINT_VIOLATION,
                    format!(
                        "insert or update on table \"derivation_inputs\" violates foreign key constraint \"derivation_inputs_source_id_fkey\": source {source:?} is not present"
                    ),
                ));
            }
            let edges: BTreeSet<&EdgeRef> = spec.edges.iter().collect();
            for input in edges {
                let key = forward_key(&spec.derived, input);
                if get_json::<EdgeRecord>(&*tx, &key)?.is_some() {
                    continue;
                }
                put_json(tx, &key, &EdgeRecord { source_id: spec.source_id.clone(), created_at_us: now })?;
                tx.put(&reverse_key(input, &spec.derived), b"")?;
            }
            Ok(())
        })
    }
}

impl Store {
    /// `countLegacyDerivedPages(sourceId)`: the live atom and dream pages of the source (`type = 'atom'` or
    /// `frontmatter->>'dream_generated' = 'true'`) that no recorded edge explains (no `derivation_inputs` row derives
    /// them).
    pub fn count_legacy_derived_pages(&self, source_id: &str) -> Result<i64> {
        let read = self.read()?;
        let mut n = 0;
        for page in crate::pages::all_pages(&*read)? {
            if page.source_id != source_id || page.deleted_at_us.is_some() {
                continue;
            }
            let dream = page
                .frontmatter
                .get("dream_generated")
                .and_then(crate::cli_reads::entities::arrow_text)
                .as_deref()
                == Some("true");
            if (page.page_type == "atom" || dream)
                && !has_inputs(
                    &*read,
                    &EdgeRef {
                        table: "pages".into(),
                        id: page.id.to_string(),
                    },
                )?
            {
                n += 1;
            }
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    fn r(table: &str, id: &str) -> EdgeRef {
        EdgeRef {
            table: table.into(),
            id: id.into(),
        }
    }

    #[test]
    fn edges_are_recorded_once_and_walk_both_ways() {
        let s = store();
        let spec = |inputs: Vec<EdgeRef>| DerivationEdges {
            derived: r("pages", "7"),
            source_id: Some("default".into()),
            edges: inputs,
        };
        s.record_derivation_edges(&spec(vec![
            r("facts", "1"),
            r("pages", "3"),
            r("facts", "1"),
        ]))
        .unwrap();
        s.record_derivation_edges(&spec(vec![r("pages", "3")]))
            .unwrap();
        let read = s.read().unwrap();
        assert_eq!(
            inputs_of(&*read, &r("pages", "7")).unwrap(),
            vec![r("facts", "1"), r("pages", "3")]
        );
        assert_eq!(
            derived_from(&*read, &r("pages", "3")).unwrap(),
            vec![r("pages", "7")]
        );
        assert!(has_inputs(&*read, &r("pages", "7")).unwrap());
        assert!(!has_inputs(&*read, &r("pages", "70")).unwrap());
    }

    #[test]
    fn a_missing_source_or_a_bad_table_refuses_and_records_nothing() {
        let s = store();
        let bad_source = DerivationEdges {
            derived: r("pages", "7"),
            source_id: Some("nope".into()),
            edges: vec![r("facts", "1")],
        };
        assert!(s.record_derivation_edges(&bad_source).is_err());
        let bad_table = DerivationEdges {
            derived: r("Pages", "7"),
            source_id: None,
            edges: vec![r("facts", "1")],
        };
        assert!(s.record_derivation_edges(&bad_table).is_err());
        assert!(
            inputs_of(&*s.read().unwrap(), &r("pages", "7"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn the_lineage_walk_is_transitive_and_survives_a_cycle() {
        let s = store();
        let edge = |d: EdgeRef, i: EdgeRef| {
            s.record_derivation_edges(&DerivationEdges {
                derived: d,
                source_id: None,
                edges: vec![i],
            })
            .unwrap()
        };
        edge(r("pages", "3"), r("pages", "2"));
        edge(r("pages", "2"), r("facts", "1"));
        edge(r("facts", "1"), r("pages", "3"));
        let read = s.read().unwrap();
        let up: BTreeSet<EdgeRef> = lineage_inputs(&*read, &r("pages", "3"))
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(
            up,
            [r("facts", "1"), r("pages", "2"), r("pages", "3")]
                .into_iter()
                .collect()
        );
        let down: BTreeSet<EdgeRef> = derived_closure(&*read, &[r("facts", "1")])
            .unwrap()
            .into_iter()
            .collect();
        assert_eq!(
            down,
            [r("facts", "1"), r("pages", "2"), r("pages", "3")]
                .into_iter()
                .collect()
        );
    }
}
