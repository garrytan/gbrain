//! The page-columns hook: values a family keeps under its own tag that `getPage`,
//! `readPageSnapshot` and `listPages` return as columns of the page (for example
//! `emotional_weight`). The page record never holds them, so building a family never edits
//! `PageRecord`, `pages.rs` or `PAGE_ROW_DEFAULTS` (`src/core/rust-engine/store-codec.ts`).
//!
//! `add_page_columns` asks each family on the list below for its columns, in list order. A family
//! edits only its own `page_columns`; this list names each such family once and does not change
//! when one is built. A column a family does not add reads as its `PAGE_ROW_DEFAULTS` value.
//! `putPage` returns no family columns: PGLite's `RETURNING` list names none of them.

use crate::Result;
use crate::kv::KvRead;
use crate::pages::PageRecord;
use serde_json::{Map, Value};

/// The page being read, as the JSON object the binding returns. A family adds columns through
/// `set` and cannot replace a field core writes or a column another family added.
pub(crate) struct PageColumns<'a> {
    page: &'a mut Map<String, Value>,
}

impl PageColumns<'_> {
    /// Adds the column `name`. Dates go as ISO strings (`env::iso`), as core writes its own; the
    /// TypeScript decoder turns the page dates it knows into `Date`.
    #[allow(dead_code)] // No family adds a column yet; the first one built calls this.
    pub(crate) fn set(&mut self, name: &str, value: Value) {
        // Two writers of one column is a bug in a family: tests fail on it, and a release build
        // keeps the value written first.
        debug_assert!(
            !self.page.contains_key(name),
            "page column {name} is written twice"
        );
        self.page.entry(name).or_insert(value);
    }
}

/// Adds every family's columns to `page`, the JSON object of `record` (`PageRecord::to_page`).
pub(crate) fn add_page_columns(
    read: &dyn KvRead,
    record: &PageRecord,
    page: &mut Value,
) -> Result<()> {
    let Value::Object(page) = page else {
        return Ok(());
    };
    let mut columns = PageColumns { page };
    crate::salience::page_columns(read, record, &mut columns)?;
    crate::aliases::page_columns(read, record, &mut columns)?;
    crate::extraction::page_columns(read, record, &mut columns)?;
    crate::page_body::page_columns(read, record, &mut columns)?;
    crate::trust::page_columns(read, record, &mut columns)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_column_is_added_once_and_never_replaces_a_core_field() {
        let mut page = Map::new();
        page.insert("slug".into(), json!("a"));
        let mut columns = PageColumns { page: &mut page };
        columns.set("emotional_weight", json!(0.5));
        assert_eq!(page.get("emotional_weight"), Some(&json!(0.5)));
        assert_eq!(page.get("slug"), Some(&json!("a")));
    }

    #[test]
    #[should_panic(expected = "page column slug is written twice")]
    fn writing_a_core_field_is_a_bug() {
        let mut page = Map::new();
        page.insert("slug".into(), json!("a"));
        PageColumns { page: &mut page }.set("slug", json!("b"));
    }

    #[test]
    fn page_reads_return_no_family_column_while_every_hook_is_empty() {
        use crate::pages::{PageFilters, PageInput, PutPageOptions, ReadScope};
        let store = crate::test_support::store();
        let input = PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        let put = store
            .put_page("a", &input, &PutPageOptions::default())
            .unwrap();
        let snapshot = store
            .read_page_snapshot("a", &ReadScope::default())
            .unwrap()
            .unwrap();
        let listed = store.list_pages(&PageFilters::default()).unwrap();
        for page in [&put, &snapshot["page"], &listed[0]] {
            for column in [
                "emotional_weight",
                "salience_touched_at",
                "contextual_retrieval_mode",
                "withheld_source_path",
            ] {
                assert!(page.get(column).is_none(), "{column} in {page}");
            }
        }
    }
}
