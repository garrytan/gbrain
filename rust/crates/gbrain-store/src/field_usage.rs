//! Field usage: the page sample read of `gbrain schema detect --fields`
//! (`src/core/schema-pack/field-usage.ts` runFieldUsage).
//!
//! Member: readFieldUsageSamples (`src/core/engine-sql/field-usage.ts`).
//!
//! Keys: none of its own. The read scans the core page rows (`all_pages`).
//!
//! It keeps two behaviours of the PGLite read (TODOS.md): it does not read `sources`, so pages of
//! an archived source count and are sampled; and a segmented page (NULL compiled_truth) samples a
//! null body, which the caller reads as empty.

use crate::Store;
use crate::error::Result;
use crate::pages::{PageRecord, all_pages};
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
}

/// A count bound as the PGLite read binds it: `Math.floor`, at least `min`.
fn limit(value: Option<f64>, min: usize) -> usize {
    match value {
        Some(v) if v.is_finite() && v.floor() > min as f64 => v.floor() as usize,
        _ => min,
    }
}

impl Store {
    /// `readFieldUsageSamples(query)`: the live page types of the scope with their page counts,
    /// most pages first, ties in byte order (`COLLATE "C"`), at most `maxTypes`; per type, the
    /// frontmatter and compiled_truth of at most `samplePerType` (at least 1) live pages in page id
    /// order. The answer carries no page id.
    pub fn read_field_usage_samples(&self, query: &FieldUsageQuery) -> Result<Value> {
        let source = query.source_id.as_deref().filter(|s| !s.is_empty());
        let max_types = limit(query.max_types, 0);
        let sample = limit(query.sample_per_type, 1);
        let read = self.read()?;
        let mut by_type: BTreeMap<String, Vec<PageRecord>> = BTreeMap::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() || page.page_type.is_empty() {
                continue;
            }
            if source.is_some_and(|s| page.source_id != s) {
                continue;
            }
            by_type
                .entry(page.page_type.clone())
                .or_default()
                .push(page);
        }
        // BTreeMap order is byte order; a stable sort by count keeps it for ties.
        let mut types: Vec<(String, Vec<PageRecord>)> = by_type.into_iter().collect();
        types.sort_by_key(|a| std::cmp::Reverse(a.1.len()));
        types.truncate(max_types);
        let out: Vec<Value> = types
            .into_iter()
            .map(|(kind, mut pages)| {
                let count = pages.len();
                pages.sort_by_key(|p| p.id);
                let rows: Vec<Value> = pages
                    .iter()
                    .take(sample)
                    .map(|p| {
                        json!({
                            "frontmatter": p.frontmatter,
                            "compiled_truth": p.compiled_truth.as_deref(),
                        })
                    })
                    .collect();
                json!({ "type": kind, "pages": count, "rows": rows })
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
}
