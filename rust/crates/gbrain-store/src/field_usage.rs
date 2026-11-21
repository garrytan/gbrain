//! Field usage: the page sample read of `gbrain schema detect --fields`
//! (`src/core/schema-pack/field-usage.ts` runFieldUsage).
//!
//! Member: readFieldUsageSamples (`src/core/engine-sql/field-usage.ts`).
//!
//! Keys: none of its own. The read scans the core page rows once. It decodes only a page's id,
//! source, type and deletion stamp to count it, and decodes the whole record only for a page that
//! enters a type's sample, so memory holds at most `samplePerType` sampled pages per type, and no
//! page body when `countsOnly` is set.
//!
//! It keeps two behaviours of the PGLite read (TODOS.md): it does not read `sources`, so pages of
//! an archived source count and are sampled; and a segmented page (NULL compiled_truth) samples a
//! null body, which the caller reads as empty.

use crate::Store;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::scan_prefix;
use crate::pages::PageRecord;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// `FieldUsageQuery`. `sourceId` absent or empty reads the whole brain.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FieldUsageQuery {
    pub source_id: Option<String>,
    pub max_types: Option<f64>,
    pub sample_per_type: Option<f64>,
    /// One page type; absent reads every type.
    #[serde(rename = "type")]
    pub page_type: Option<String>,
    /// True answers the types and counts with no sampled pages.
    pub counts_only: Option<bool>,
}

/// A count bound as the PGLite read binds it: `Math.floor`, at least `min`.
fn limit(value: Option<f64>, min: usize) -> usize {
    match value {
        Some(v) if v.is_finite() && v.floor() > min as f64 => v.floor() as usize,
        _ => min,
    }
}

/// The fields of a page row the read filters on. Decoding only these skips the page body.
#[derive(Deserialize)]
struct PageHead {
    id: u64,
    source_id: String,
    #[serde(rename = "type")]
    page_type: String,
    #[serde(default)]
    deleted_at_us: Option<i64>,
}

/// One type's page count and its sampled rows, lowest page id first, at most the sample size.
#[derive(Default)]
struct TypeTally {
    count: usize,
    sampled: Vec<(u64, Value)>,
}

impl Store {
    /// `readFieldUsageSamples(query)`: the live page types of the scope with their page counts,
    /// most pages first, ties in byte order (`COLLATE "C"`), at most `maxTypes`; per type, the
    /// frontmatter and compiled_truth of at most `samplePerType` (at least 1) live pages in page id
    /// order. The answer carries no page id. `type` narrows the read to one type; `countsOnly`
    /// answers no sampled pages.
    pub fn read_field_usage_samples(&self, query: &FieldUsageQuery) -> Result<Value> {
        let source = query.source_id.as_deref().filter(|s| !s.is_empty());
        let max_types = limit(query.max_types, 0);
        let sample = if query.counts_only == Some(true) {
            0
        } else {
            limit(query.sample_per_type, 1)
        };
        let read = self.read()?;
        let mut by_type: BTreeMap<String, TypeTally> = BTreeMap::new();
        let mut failure: Option<StoreError> = None;
        scan_prefix(&*read, &[keys::PAGE], false, &mut |_, v| {
            let head = match serde_json::from_slice::<PageHead>(v) {
                Ok(head) => head,
                Err(e) => {
                    failure = Some(StoreError::from(e));
                    return false;
                }
            };
            if head.deleted_at_us.is_some() || head.page_type.is_empty() {
                return true;
            }
            if source.is_some_and(|s| head.source_id != s) {
                return true;
            }
            if query
                .page_type
                .as_deref()
                .is_some_and(|t| head.page_type != t)
            {
                return true;
            }
            let tally = by_type.entry(head.page_type).or_default();
            tally.count += 1;
            let enters = sample > 0
                && (tally.sampled.len() < sample
                    || tally.sampled.last().is_some_and(|(id, _)| head.id < *id));
            if !enters {
                return true;
            }
            let page = match serde_json::from_slice::<PageRecord>(v) {
                Ok(page) => page,
                Err(e) => {
                    failure = Some(StoreError::from(e));
                    return false;
                }
            };
            let row = json!({
                "frontmatter": page.frontmatter,
                "compiled_truth": page.compiled_truth.as_deref(),
            });
            let at = tally.sampled.partition_point(|(id, _)| *id < page.id);
            tally.sampled.insert(at, (page.id, row));
            tally.sampled.truncate(sample);
            true
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        // BTreeMap order is byte order; a stable sort by count keeps it for ties.
        let mut types: Vec<(String, TypeTally)> = by_type.into_iter().collect();
        types.sort_by_key(|a| std::cmp::Reverse(a.1.count));
        types.truncate(max_types);
        let out: Vec<Value> = types
            .into_iter()
            .map(|(kind, tally)| {
                let rows: Vec<Value> = tally.sampled.into_iter().map(|(_, row)| row).collect();
                json!({ "type": kind, "pages": tally.count, "rows": rows })
            })
            .collect();
        Ok(Value::Array(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;

    fn put(s: &Store, slug: &str, kind: &str, frontmatter: Value) {
        let input: PageInput = serde_json::from_value(json!({
            "type": kind, "title": slug, "compiled_truth": format!("{slug} body"),
            "frontmatter": frontmatter,
        }))
        .unwrap();
        s.put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
    }

    fn query(max_types: f64, sample: f64) -> FieldUsageQuery {
        FieldUsageQuery {
            source_id: None,
            max_types: Some(max_types),
            sample_per_type: Some(sample),
            ..FieldUsageQuery::default()
        }
    }

    #[test]
    fn counts_live_pages_per_type_and_samples_the_oldest() {
        let s = store();
        assert_eq!(
            s.read_field_usage_samples(&query(50.0, 10.0)).unwrap(),
            json!([])
        );
        put(&s, "notes/z", "Zeta", json!({ "k": 1 }));
        put(&s, "notes/a", "alpha", json!({ "k": 2 }));
        put(&s, "people/p1", "person", json!({ "n": 1 }));
        put(&s, "people/p2", "person", json!({ "n": 2 }));
        put(&s, "people/gone", "person", json!({ "n": 3 }));
        s.soft_delete_page("people/gone", None).unwrap();
        let all = s.read_field_usage_samples(&query(50.0, 10.0)).unwrap();
        let kinds: Vec<String> = all
            .as_array()
            .unwrap()
            .iter()
            .map(|t| format!("{}:{}", t["type"].as_str().unwrap(), t["pages"]))
            .collect();
        assert_eq!(kinds, ["person:2", "Zeta:1", "alpha:1"]);
        let capped = s.read_field_usage_samples(&query(1.0, 1.0)).unwrap();
        assert_eq!(
            capped,
            json!([{ "type": "person", "pages": 2,
                "rows": [{ "frontmatter": { "n": 1 }, "compiled_truth": "people/p1 body" }] }])
        );
        let zero = s.read_field_usage_samples(&query(0.0, 0.0)).unwrap();
        assert_eq!(zero, json!([]));
    }

    #[test]
    fn one_type_or_counts_only() {
        let s = store();
        put(&s, "notes/a", "alpha", json!({ "k": 2 }));
        put(&s, "people/p1", "person", json!({ "n": 1 }));
        put(&s, "people/p2", "person", json!({ "n": 2 }));
        let counts = s
            .read_field_usage_samples(&FieldUsageQuery {
                counts_only: Some(true),
                ..query(50.0, 10.0)
            })
            .unwrap();
        assert_eq!(
            counts,
            json!([{ "type": "person", "pages": 2, "rows": [] }, { "type": "alpha", "pages": 1, "rows": [] }])
        );
        let one = s
            .read_field_usage_samples(&FieldUsageQuery {
                page_type: Some("alpha".into()),
                ..query(1.0, 10.0)
            })
            .unwrap();
        assert_eq!(
            one,
            json!([{ "type": "alpha", "pages": 1,
                "rows": [{ "frontmatter": { "k": 2 }, "compiled_truth": "notes/a body" }] }])
        );
    }

    #[test]
    fn samples_the_lowest_page_ids_whatever_the_slug_order() {
        let s = store();
        // Ids follow write order; the scan reads in slug order, so the sample must not keep
        // the first pages it meets.
        for (n, slug) in ["notes/z", "notes/y", "notes/c", "notes/b", "notes/a"]
            .iter()
            .enumerate()
        {
            put(&s, slug, "note", json!({ "n": n }));
        }
        assert_eq!(
            s.read_field_usage_samples(&query(50.0, 2.0)).unwrap(),
            json!([{ "type": "note", "pages": 5, "rows": [
                { "frontmatter": { "n": 0 }, "compiled_truth": "notes/z body" },
                { "frontmatter": { "n": 1 }, "compiled_truth": "notes/y body" },
            ] }])
        );
    }
}
