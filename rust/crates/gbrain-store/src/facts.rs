//! Facts and their supersession chains. Nothing is built yet: every member below still refuses with
//! `engine_capability_missing` in the TypeScript engine.
//!
//! Members: insertFact, insertFacts, deleteFactsForPage, expireFact, listFactsByEntity,
//! listFactsSince, listFactsKeyset, listFactsBySession, listSupersessions,
//! countUnconsolidatedFacts, findCandidateDuplicates, consolidateFact, findTrajectory,
//! getFactsHealth, migrateFactsToCanonical, and the `pageCollapseFacts` search read
//! (`facts/collapse.rs`).
//!
//! Keys (every one starts with `keys::FACT`, `F`):
//! - `F 0x01 id -> FactRecord`: one fact row, the `id` primary key (8 big-endian bytes).
//!
//! Time: every `*_us` field is a UTC microsecond time from the store's clock.

mod collapse;
#[allow(dead_code)]
mod embedding;
#[allow(dead_code)]
mod privacy;

pub use privacy::PrivacyPolicy;
pub(crate) use privacy::page_hidden;

use crate::error::Result;
use crate::kv::KvRead;
use crate::{get_json, keys};
use serde::{Deserialize, Serialize};

const ROW: u8 = 0x01;

/// One `facts` row. The ontology family reads and writes the same rows.
#[allow(dead_code)]
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct FactRecord {
    pub id: u64,
    pub source_id: String,
    pub entity_slug: Option<String>,
    pub fact: String,
    pub kind: String,
    pub visibility: String,
    pub notability: String,
    pub context: Option<String>,
    pub valid_from_us: i64,
    pub valid_until_us: Option<i64>,
    pub expired_at_us: Option<i64>,
    pub superseded_by: Option<u64>,
    pub consolidated_at_us: Option<i64>,
    pub consolidated_into: Option<i64>,
    pub source: String,
    pub source_session: Option<String>,
    /// A `REAL` column: stored as the `f32` Postgres keeps.
    pub confidence: f32,
    /// The `halfvec(N)` column: every element an `f16` value, held as its 16-bit pattern.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "embedding::half_hex"
    )]
    pub embedding: Option<Vec<f32>>,
    pub embedding_model: Option<String>,
    pub embedded_text_hash: Option<String>,
    pub embedded_at_us: Option<i64>,
    pub created_at_us: i64,
    pub row_num: Option<i32>,
    pub source_markdown_slug: Option<String>,
    pub claim_metric: Option<String>,
    pub claim_value: Option<f64>,
    pub claim_unit: Option<String>,
    pub claim_period: Option<String>,
    pub event_type: Option<String>,
    pub dimension: Option<String>,
    pub value: Option<String>,
    pub value_hash: Option<String>,
    pub dim_status: Option<String>,
    pub attributed_to: Option<String>,
}

/// Deletes this family's records keyed by a source that is deleted (`cascade::remove_source_rows`).
/// `F 0x01 id`: the key of fact row `id`.
pub(crate) fn fact_key(id: u64) -> Vec<u8> {
    let mut key = vec![keys::FACT, ROW];
    key.extend_from_slice(&id.to_be_bytes());
    key
}

/// Fact row `id`, when it exists.
pub(crate) fn read_fact(read: &dyn KvRead, id: u64) -> Result<Option<FactRecord>> {
    get_json(read, &fact_key(id))
}

/// Whether fact row `id` exists in one of `source_ids` (any source when `source_ids` is empty).
///
/// This is PGLite's rule for a `facts/<id>` slug on a captured eval candidate
/// (`insertEvalCandidate`, src/core/feedback/store.ts): the slug stays while the fact row does.
/// The row counts whatever its state: an expired, superseded or consolidated row, and a row
/// whose page was soft-deleted, still exist. Only a deleted row (a page re-extract, a source
/// delete) is gone. The caller matches the slug against `^facts/[0-9]{1,18}$` first.
// Called by eval_capture (lane 5) once it drops its `facts/<id>` refusal.
#[allow(dead_code)]
pub(crate) fn fact_exists(read: &dyn KvRead, id: u64, source_ids: &[String]) -> Result<bool> {
    Ok(read_fact(read, id)?
        .is_some_and(|row| source_ids.is_empty() || source_ids.contains(&row.source_id)))
}

/// Nothing to delete yet. Full paths keep this stub clear of the imports this file will add.
pub(crate) fn remove_source_rows(
    _tx: &mut dyn crate::kv::KvWrite,
    _source_id: &str,
) -> crate::Result<()> {
    Ok(())
}

/// Moves this family's records keyed by `(source, slug)` from `old_slug` to `new_slug` when a page
/// is renamed (`cascade::rename_slug_rows`, PGLite `moveSlugBindings`): fact withdrawals by
/// `subject`, facts by `entity_slug` and by `source_markdown_slug`, dropping the rows the new slug
/// already holds as PGLite does. Nothing to move yet.
pub(crate) fn rename_slug_rows(
    _tx: &mut dyn crate::kv::KvWrite,
    _source_id: &str,
    _old_slug: &str,
    _new_slug: &str,
) -> crate::Result<()> {
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Postgres text functions the members use.

/// Code points Postgres `lower()` leaves alone that Rust's `char::to_lowercase` maps (the two
/// Unicode tables differ). Probed on PGLite.
const LOWER_KEEP: [(u32, u32); 41] = [
    (0x1C89, 0x1C89),
    (0x24B6, 0x24CF),
    (0x2C2F, 0x2C2F),
    (0xA7C0, 0xA7C0),
    (0xA7C7, 0xA7C7),
    (0xA7C9, 0xA7C9),
    (0xA7CB, 0xA7CC),
    (0xA7CE, 0xA7CE),
    (0xA7D0, 0xA7D0),
    (0xA7D2, 0xA7D2),
    (0xA7D4, 0xA7D4),
    (0xA7D6, 0xA7D6),
    (0xA7D8, 0xA7D8),
    (0xA7DA, 0xA7DA),
    (0xA7DC, 0xA7DD),
    (0xA7E2, 0xA7E2),
    (0xA7F5, 0xA7F5),
    (0xAB6C, 0xAB6D),
    (0x10570, 0x1057A),
    (0x1057C, 0x1058A),
    (0x1058C, 0x10592),
    (0x10594, 0x10595),
    (0x10D50, 0x10D65),
    (0x16EA0, 0x16EB8),
    (0x1DF40, 0x1DF40),
    (0x1DF48, 0x1DF48),
    (0x1DF4A, 0x1DF4A),
    (0x1DF4D, 0x1DF4D),
    (0x1DF51, 0x1DF51),
    (0x1DF68, 0x1DF68),
    (0x1DF6A, 0x1DF6A),
    (0x1DF6C, 0x1DF6C),
    (0x1DF6E, 0x1DF6E),
    (0x1DF72, 0x1DF72),
    (0x1DF74, 0x1DF74),
    (0x1DF76, 0x1DF76),
    (0x1DF78, 0x1DF78),
    (0x1DF7A, 0x1DF7A),
    (0x1DF7C, 0x1DF7C),
    (0x1DF7E, 0x1DF7E),
    (0xFEFF, 0xFEFF),
];

/// Postgres `lower()` of one code point: one code point out, the first of the full mapping
/// ('İ' gives 'i').
pub(crate) fn pg_lower_char(c: char) -> char {
    let cp = c as u32;
    if LOWER_KEEP.iter().any(|&(lo, hi)| (lo..=hi).contains(&cp)) {
        return c;
    }
    c.to_lowercase().next().unwrap_or(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kv::KvRead;
    use std::collections::BTreeMap;

    struct MapRead(BTreeMap<Vec<u8>, Vec<u8>>);

    impl KvRead for MapRead {
        fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
            Ok(self.0.get(key).cloned())
        }
        fn scan(
            &self,
            start: &[u8],
            end: &[u8],
            reverse: bool,
            f: &mut dyn FnMut(&[u8], &[u8]) -> bool,
        ) -> Result<()> {
            let range = self.0.range(start.to_vec()..end.to_vec());
            let entries: Vec<_> = if reverse {
                range.rev().collect()
            } else {
                range.collect()
            };
            for (k, v) in entries {
                if !f(k, v) {
                    break;
                }
            }
            Ok(())
        }
    }

    fn row(id: u64, source_id: &str, expired: bool) -> FactRecord {
        FactRecord {
            id,
            source_id: source_id.into(),
            fact: format!("fact {id}"),
            kind: "fact".into(),
            visibility: "private".into(),
            notability: "medium".into(),
            source: "test".into(),
            confidence: 1.0,
            expired_at_us: expired.then_some(5),
            ..FactRecord::default()
        }
    }

    fn brain(rows: &[FactRecord]) -> MapRead {
        let mut map = BTreeMap::new();
        for r in rows {
            map.insert(fact_key(r.id), serde_json::to_vec(r).unwrap());
        }
        MapRead(map)
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn fact_exists_follows_the_eval_capture_rule() {
        let read = brain(&[row(1, "default", false), row(2, "wiki", true)]);
        // Any source when the candidate names none.
        assert!(fact_exists(&read, 1, &[]).unwrap());
        assert!(fact_exists(&read, 2, &[]).unwrap());
        // Only the named sources otherwise.
        assert!(fact_exists(&read, 1, &ids(&["default"])).unwrap());
        assert!(fact_exists(&read, 1, &ids(&["wiki", "default"])).unwrap());
        assert!(!fact_exists(&read, 1, &ids(&["wiki"])).unwrap());
        // An expired row still exists, as in PGLite.
        assert!(fact_exists(&read, 2, &ids(&["wiki"])).unwrap());
        // A row that is not there, and id 0 (Postgres never assigns it).
        assert!(!fact_exists(&read, 3, &[]).unwrap());
        assert!(!fact_exists(&read, 0, &[]).unwrap());
        assert!(!fact_exists(&read, u64::MAX, &ids(&["default"])).unwrap());
    }

    #[test]
    fn fact_keys_sort_by_id() {
        assert!(fact_key(2) < fact_key(256));
        assert_eq!(fact_key(1)[..2], [keys::FACT, ROW]);
        let read = brain(&[row(7, "default", false)]);
        assert_eq!(read_fact(&read, 7).unwrap().unwrap().id, 7);
    }
}
