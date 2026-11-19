//! The page reads of hybrid search's ranking stage: the bare-slug suffix lookup, the generated pages
//! among a set of ids and the live page ids at (source, slug) refs. PGLite and Postgres run the SQL in
//! `src/core/engine-sql/search-reads.ts` (`slugsEndingIn`, `generatedPagesIn`, `livePageIdsAt`);
//! these answer the same rows from the store's page records (rust/docs/store/cli-reads-search-pages.md).
//!
//! None of the three SQL statements has a privacy or visibility filter, so these have none either.
//! `generatedPagesIn` has no `deleted_at` or source filter in SQL: it reads soft-deleted pages and
//! pages of any source too.
//!
//! Keys: none of its own. It reads the page records (`P`) and the page id keys (`I`).

use crate::error::{Result, StoreError};
use crate::kv::scan_prefix;
use crate::pages::{read_page, read_page_by_id};
use crate::{Store, keys};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// One row of `generatedPagesIn` (`GeneratedPageRow` of `src/core/engine-sql/search-reads.ts`).
/// `compiled_truth` is `null` for a segmented page, as the SQL column is.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GeneratedPageRow {
    pub id: u64,
    pub frontmatter: Map<String, Value>,
    pub compiled_truth: Option<String>,
}

/// A (source, slug) ref of `livePageIdsAt`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct LivePageRef {
    pub slug: String,
    pub source_id: String,
}

/// The fields of a page record `slugsEndingIn` needs; the rest of the record is not decoded.
#[derive(Deserialize)]
struct PageSlugLiveness {
    id: u64,
    slug: String,
    #[serde(default)]
    deleted_at_us: Option<i64>,
}

/// How many slugs `slugsEndingIn` returns at most (the SQL `LIMIT 2`).
const SLUGS_ENDING_IN_LIMIT: usize = 2;

/// SQL `frontmatter->>'dream_generated' = 'true'`: a JSON `true` or the text `"true"` at the top level.
fn says_dream_generated(frontmatter: &Map<String, Value>) -> bool {
    match frontmatter.get("dream_generated") {
        Some(Value::Bool(true)) => true,
        Some(Value::String(s)) => s == "true",
        _ => false,
    }
}

/// The ids as the SQL `::int[]` cast reads them: an id outside the int4 range is an error there.
fn int4_ids(ids: &[i64]) -> Result<BTreeSet<u64>> {
    let mut out = BTreeSet::new();
    for &id in ids {
        if i32::try_from(id).is_err() {
            return Err(StoreError::invalid(format!(
                "generatedPagesIn id {id} is out of range for type integer"
            )));
        }
        // Page ids start at 1, so a zero or negative id names no page.
        if id > 0 {
            out.insert(id as u64);
        }
    }
    Ok(out)
}

impl Store {
    /// `slugsEndingIn(sourceId, word)`: up to two live slugs of `source_id` that equal `word` or end
    /// in `/word`. The match is exact and case-sensitive (the SQL escapes LIKE's `%`, `_` and `\`).
    /// The SQL has no ORDER BY; the store returns the oldest pages first (page id order).
    pub fn slugs_ending_in(&self, source_id: &str, word: &str) -> Result<Vec<String>> {
        if source_id.contains('\0') {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let prefix = keys::text(keys::PAGE, &[source_id, ""]);
        let suffix = format!("/{word}");
        let mut found: Vec<(u64, String)> = Vec::new();
        let mut failure = None;
        scan_prefix(&*read, &prefix, false, &mut |key, v| {
            let slug = &key[prefix.len()..];
            if slug != word.as_bytes() && !slug.ends_with(suffix.as_bytes()) {
                return true;
            }
            match serde_json::from_slice::<PageSlugLiveness>(v) {
                Ok(page) => {
                    if page.deleted_at_us.is_none() {
                        found.push((page.id, page.slug));
                    }
                    true
                }
                Err(e) => {
                    failure = Some(StoreError::from(e));
                    false
                }
            }
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        found.sort();
        Ok(found
            .into_iter()
            .take(SLUGS_ENDING_IN_LIMIT)
            .map(|(_, slug)| slug)
            .collect())
    }

    /// `generatedPagesIn(ids)`: the pages among `ids` that gbrain generated (frontmatter
    /// `dream_generated` true or type `extract_receipt`), deleted or not, each once, by id.
    pub fn generated_pages_in(&self, ids: &[i64]) -> Result<Vec<GeneratedPageRow>> {
        let ids = int4_ids(ids)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for id in ids {
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            if says_dream_generated(&page.frontmatter) || page.page_type == "extract_receipt" {
                out.push(GeneratedPageRow {
                    id: page.id,
                    compiled_truth: page.compiled_truth.as_deref().map(String::from),
                    frontmatter: page.frontmatter,
                });
            }
        }
        Ok(out)
    }

    /// `livePageIdsAt(refs)`: the id of each live page at a `{ source_id, slug }` ref, each once
    /// however often its ref repeats, by id.
    pub fn live_page_ids_at(&self, refs: &[LivePageRef]) -> Result<Vec<u64>> {
        let read = self.read()?;
        let mut ids = BTreeSet::new();
        for r in refs {
            if let Some(page) = read_page(&*read, &r.source_id, &r.slug)?
                && page.deleted_at_us.is_none()
            {
                ids.insert(page.id);
            }
        }
        Ok(ids.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::{int4_ids, says_dream_generated};
    use serde_json::{Map, Value, json};

    fn fm(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn dream_generated_is_a_json_true_or_the_text_true_at_the_top_level() {
        assert!(says_dream_generated(&fm(
            json!({ "dream_generated": true })
        )));
        assert!(says_dream_generated(&fm(
            json!({ "dream_generated": "true" })
        )));
        assert!(!says_dream_generated(&fm(
            json!({ "dream_generated": false })
        )));
        assert!(!says_dream_generated(&fm(
            json!({ "dream_generated": "TRUE" })
        )));
        assert!(!says_dream_generated(&fm(json!({ "dream_generated": 1 }))));
        assert!(!says_dream_generated(&fm(
            json!({ "nested": { "dream_generated": true } })
        )));
        assert!(!says_dream_generated(&fm(json!({}))));
    }

    #[test]
    fn ids_outside_int4_are_an_error_and_non_positive_ids_name_no_page() {
        assert_eq!(
            int4_ids(&[3, 1, 3, 0, -5])
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>(),
            vec![1, 3]
        );
        assert!(int4_ids(&[i64::from(i32::MAX)]).is_ok());
        assert!(int4_ids(&[i64::from(i32::MAX) + 1]).is_err());
        assert!(int4_ids(&[i64::from(i32::MIN) - 1]).is_err());
    }
}
