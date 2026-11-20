//! The two page reads of an extract receipt write served from the store (SQL in
//! `src/core/engine-sql/extract-bookkeeping.ts`, docs in `rust/docs/store/sweep-reads.md`): the prior-row check and the
//! seal check. Each reads the page record at (source, slug), deleted or not, as the SQL does.

use crate::Store;
use crate::error::Result;
use crate::pages::read_page;
use serde::Deserialize;
use serde_json::{Value, json};

/// `readExtractReceiptPrior({ sourceId, slug })` and `readExtractReceiptSealed({ sourceId, slug, safeVersion })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractReceiptPageSpec {
    pub source_id: String,
    pub slug: String,
    /// `SAFE_FENCE_CHUNKER_VERSION`; only the seal check reads it.
    #[serde(default)]
    pub safe_version: i64,
}

/// SQL `a AND b` over booleans that may be NULL.
fn sql_and(a: Option<bool>, b: Option<bool>) -> Option<bool> {
    match (a, b) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), Some(true)) => Some(true),
        _ => None,
    }
}

impl Store {
    /// `readExtractReceiptPrior`: `{ type, source_path, source_uri, withheld_source_path }` of the page at (source,
    /// slug), or null when there is none. The store keeps no withheld source path, so that field is always null.
    pub fn read_extract_receipt_prior(&self, spec: &ExtractReceiptPageSpec) -> Result<Value> {
        let read = self.read()?;
        Ok(match read_page(&*read, &spec.source_id, &spec.slug)? {
            None => Value::Null,
            Some(p) => json!({
                "type": p.page_type,
                "source_path": p.source_path,
                "source_uri": p.source_uri,
                "withheld_source_path": Value::Null,
            }),
        })
    }

    /// `readExtractReceiptSealed`: `{ sealed }` of the page at (source, slug), or null when there is none. `sealed` is
    /// `chunker_version >= safeVersion AND text_projection_revision = knowledge_revision` with SQL's NULL rules.
    pub fn read_extract_receipt_sealed(&self, spec: &ExtractReceiptPageSpec) -> Result<Value> {
        let read = self.read()?;
        Ok(match read_page(&*read, &spec.source_id, &spec.slug)? {
            None => Value::Null,
            Some(p) => {
                let at_fence = p.chunker_version.map(|v| i64::from(v) >= spec.safe_version);
                let projected = p
                    .text_projection_revision
                    .as_ref()
                    .map(|r| *r == p.knowledge_revision);
                json!({ "sealed": sql_and(at_fence, projected) })
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_and_follows_three_valued_logic() {
        assert_eq!(sql_and(Some(true), Some(true)), Some(true));
        assert_eq!(sql_and(Some(true), None), None);
        assert_eq!(sql_and(None, Some(false)), Some(false));
        assert_eq!(sql_and(Some(false), None), Some(false));
        assert_eq!(sql_and(None, None), None);
    }

    #[test]
    fn a_missing_page_reads_as_null_and_a_new_page_has_no_withheld_path() {
        let store = crate::test_support::store();
        let spec = |slug: &str| ExtractReceiptPageSpec {
            source_id: "default".into(),
            slug: slug.into(),
            safe_version: 4,
        };
        assert_eq!(
            store
                .read_extract_receipt_prior(&spec("extracts/a"))
                .unwrap(),
            Value::Null
        );
        assert_eq!(
            store
                .read_extract_receipt_sealed(&spec("extracts/a"))
                .unwrap(),
            Value::Null
        );
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "extract_receipt", "title": "r", "compiled_truth": "body", "frontmatter": {},
        }))
        .unwrap();
        let options: crate::pages::PutPageOptions =
            serde_json::from_value(json!({ "sourceId": "default" })).unwrap();
        store.put_page("extracts/a", &input, &options).unwrap();
        let prior = store
            .read_extract_receipt_prior(&spec("extracts/a"))
            .unwrap();
        assert_eq!(prior["type"], json!("extract_receipt"));
        assert_eq!(prior["withheld_source_path"], Value::Null);
        // `sealed` is the record's own fence test, read from the stored chunker version and revisions.
        let record = {
            let read = store.read().unwrap();
            read_page(&*read, "default", "extracts/a").unwrap().unwrap()
        };
        let expected = sql_and(
            record.chunker_version.map(|v| i64::from(v) >= 4),
            record
                .text_projection_revision
                .as_ref()
                .map(|r| *r == record.knowledge_revision),
        );
        let sealed = store
            .read_extract_receipt_sealed(&spec("extracts/a"))
            .unwrap();
        assert_eq!(sealed, json!({ "sealed": expected }));
        let above = ExtractReceiptPageSpec {
            safe_version: i64::from(i16::MAX) + 1,
            ..spec("extracts/a")
        };
        let below = store.read_extract_receipt_sealed(&above).unwrap();
        assert_ne!(below["sealed"], json!(true));
    }
}
