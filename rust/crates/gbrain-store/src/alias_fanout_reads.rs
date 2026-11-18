//! Alias fan-out reads: the exact-title lookup, the case-sensitive alias read, a page's title and
//! the alias rows of a set of pages (`engine-sql/alias-fanout-reads.ts`, callers in
//! `search/alias-fanout.ts`).
//!
//! Members: findPagesByTitles, resolveCaseSensitiveAliases, readPageTitle, readPageAliasRows.
//!
//! The alias reads scan the `page_aliases` rows the aliases family writes (`aliases.rs`):
//!
//! - `k 0x02 source \0 alias_norm \0 slug \0 origin` (by alias), and
//! - `k 0x03 source \0 slug \0 alias_norm \0 origin` (by page),
//!
//! both with an empty value. The layout is private to `aliases.rs`; this module mirrors it, and a
//! test writes through `Store::set_page_aliases` and reads it back here to pin it. The store keeps
//! no `alias_text` and no `case_sensitive` flag (only `setPageAliases` writes rows, every one
//! `frontmatter`, as PGLite's insert leaves `alias_text` NULL and `case_sensitive` false), so every
//! row reads with a null `alias_text` and none is case-sensitive. A row whose value is not empty
//! was written by a writer this reader does not know: the read refuses with `store_corrupt`
//! rather than drop what it holds.
//!
//! Each read sorts in byte order, as the SQL's `COLLATE "C"` does. Text holding a NUL byte is
//! `invalid_argument`, as Postgres refuses a NUL in a text parameter.

use crate::error::{Result, STORE_CORRUPT, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{all_pages, read_page};
use crate::{Store, keys};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

const PAGE_ALIAS: u8 = 0x02;
const PAGE_ALIAS_BY_SLUG: u8 = 0x03;

/// `findPagesByTitles(titleNorms, sourceIds, types, { excludePrivate })`. `exclude_private` is the
/// page policy of `excludePrivate` (`facts/privacy.rs` `page_hidden`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TitleQuery {
    pub title_norms: Vec<String>,
    pub source_ids: Vec<String>,
    pub types: Vec<String>,
    pub exclude_private: Option<PrivacyPolicy>,
}

/// `k sub part0 \0 part1 \0`: the scan prefix of the rows under `parts`.
fn alias_prefix(sub: u8, parts: &[&str]) -> Vec<u8> {
    let mut key = vec![keys::ALIAS, sub];
    for part in parts {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key
}

/// Refuses text holding a NUL byte, as Postgres does for a text parameter.
fn reject_nul<'a>(member: &str, items: impl IntoIterator<Item = &'a str>) -> Result<()> {
    for item in items {
        if item.contains('\0') {
            return Err(StoreError::invalid(format!(
                "{member}: invalid byte sequence for encoding \"UTF8\": 0x00"
            )));
        }
    }
    Ok(())
}

/// The text parts after `prefix_len` bytes of every key under `prefix`; a non-empty value refuses.
fn alias_tails(read: &dyn KvRead, member: &str, prefix: &[u8]) -> Result<Vec<Vec<String>>> {
    let mut out = Vec::new();
    let mut foreign = false;
    scan_prefix(read, prefix, false, &mut |k, v| {
        if !v.is_empty() {
            foreign = true;
            return false;
        }
        out.push(
            k[prefix.len()..]
                .split(|b| *b == 0)
                .map(|p| String::from_utf8_lossy(p).into_owned())
                .collect(),
        );
        true
    })?;
    if foreign {
        return Err(StoreError::new(
            STORE_CORRUPT,
            format!("{member}: a page alias row holds a value this store does not read"),
        ));
    }
    Ok(out)
}

/// The distinct texts of `items` in byte order; a NUL byte is `invalid_argument`.
fn key_texts<'a>(member: &str, items: &'a [String]) -> Result<BTreeSet<&'a str>> {
    reject_nul(member, items.iter().map(String::as_str))?;
    Ok(items.iter().map(String::as_str).collect())
}

impl Store {
    /// `findPagesByTitles`: pages of the listed sources, not soft-deleted, whose type is listed and
    /// whose lower-cased title is a listed title, as `{ slug, source_id, t }` by source then slug.
    /// Quarantined pages and archived sources still answer, as the SQL does not filter them.
    pub fn find_pages_by_titles(&self, q: &TitleQuery) -> Result<Vec<Value>> {
        if q.title_norms.is_empty() || q.source_ids.is_empty() || q.types.is_empty() {
            return Ok(Vec::new());
        }
        const MEMBER: &str = "findPagesByTitles";
        let titles = key_texts(MEMBER, &q.title_norms)?;
        let sources = key_texts(MEMBER, &q.source_ids)?;
        let types = key_texts(MEMBER, &q.types)?;
        let read = self.read()?;
        let mut hits = Vec::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || !sources.contains(page.source_id.as_str())
                || !types.contains(page.page_type.as_str())
            {
                continue;
            }
            let lower = page.title.to_lowercase();
            if !titles.contains(lower.as_str()) {
                continue;
            }
            if let Some(policy) = &q.exclude_private
                && page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            hits.push((page.source_id, page.slug, lower));
        }
        hits.sort();
        Ok(hits
            .into_iter()
            .map(|(source_id, slug, t)| json!({"slug": slug, "source_id": source_id, "t": t}))
            .collect())
    }

    /// `resolveCaseSensitiveAliases`: the case-sensitive rows of the listed aliases in the listed
    /// sources. The store keeps none, so the answer is empty once the rows read clean.
    pub fn resolve_case_sensitive_aliases(
        &self,
        alias_norms: &[String],
        source_ids: &[String],
    ) -> Result<Vec<Value>> {
        const MEMBER: &str = "resolveCaseSensitiveAliases";
        let sources = key_texts(MEMBER, source_ids)?;
        let aliases = key_texts(MEMBER, alias_norms)?;
        let read = self.read()?;
        for &source in &sources {
            for &alias in &aliases {
                alias_tails(&*read, MEMBER, &alias_prefix(PAGE_ALIAS, &[source, alias]))?;
            }
        }
        Ok(Vec::new())
    }

    /// `readPageTitle`: the title of the page at `(source_id, slug)`, soft-deleted pages included;
    /// `None` with no page.
    pub fn read_page_title(&self, source_id: &str, slug: &str) -> Result<Option<String>> {
        reject_nul("readPageTitle", [source_id, slug])?;
        let read = self.read()?;
        Ok(read_page(&*read, source_id, slug)?.map(|p| p.title))
    }

    /// `readPageAliasRows`: every alias row of a listed slug in a listed source, as `{ slug,
    /// source_id, alias_norm, alias_text: null, origin }` by source, slug, alias, then origin.
    pub fn read_page_alias_rows(
        &self,
        source_ids: &[String],
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        const MEMBER: &str = "readPageAliasRows";
        let sources = key_texts(MEMBER, source_ids)?;
        let slugs = key_texts(MEMBER, slugs)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for &source in &sources {
            for &slug in &slugs {
                let prefix = alias_prefix(PAGE_ALIAS_BY_SLUG, &[source, slug]);
                for parts in alias_tails(&*read, MEMBER, &prefix)? {
                    let [alias, origin] = parts.as_slice() else {
                        continue;
                    };
                    out.push(json!({
                        "slug": slug,
                        "source_id": source,
                        "alias_norm": alias,
                        "alias_text": null,
                        "origin": origin,
                    }));
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kv::KvWrite;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store as temp_store;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn put_page(store: &Store, slug: &str, page_type: &str, title: &str) {
        let input = PageInput {
            page_type: page_type.into(),
            title: title.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
    }

    #[test]
    fn alias_rows_read_back_what_set_page_aliases_wrote() {
        let store = temp_store();
        put_page(&store, "people/alice-example", "person", "Alice Example");
        store
            .set_page_aliases(
                "people/alice-example",
                "default",
                &strings(&["ally", "a.e.", "ally"]),
            )
            .unwrap();
        let rows = store
            .read_page_alias_rows(
                &strings(&["default"]),
                &strings(&["people/alice-example", "people/none"]),
            )
            .unwrap();
        assert_eq!(
            rows,
            vec![
                json!({"slug": "people/alice-example", "source_id": "default", "alias_norm": "a.e.", "alias_text": null, "origin": "frontmatter"}),
                json!({"slug": "people/alice-example", "source_id": "default", "alias_norm": "ally", "alias_text": null, "origin": "frontmatter"}),
            ]
        );
        assert!(
            store
                .resolve_case_sensitive_aliases(&strings(&["ally"]), &strings(&["default"]))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_row_with_a_value_refuses() {
        let store = temp_store();
        store
            .write(|tx: &mut dyn KvWrite| {
                let mut key = alias_prefix(PAGE_ALIAS_BY_SLUG, &["default", "p", "al"]);
                key.extend_from_slice(b"declared");
                tx.put(&key, b"x")?;
                let mut key = alias_prefix(PAGE_ALIAS, &["default", "al", "p"]);
                key.extend_from_slice(b"declared");
                tx.put(&key, b"x")
            })
            .unwrap();
        let by_page = store
            .read_page_alias_rows(&strings(&["default"]), &strings(&["p"]))
            .unwrap_err();
        assert_eq!(by_page.code, STORE_CORRUPT);
        let by_alias = store
            .resolve_case_sensitive_aliases(&strings(&["al"]), &strings(&["default"]))
            .unwrap_err();
        assert_eq!(by_alias.code, STORE_CORRUPT);
    }

    #[test]
    fn titles_match_lower_cased_in_byte_order() {
        let store = temp_store();
        put_page(&store, "people/b", "person", "Acme Example");
        put_page(&store, "people/a", "person", "ACME example");
        put_page(&store, "notes/c", "note", "Acme Example");
        let q = TitleQuery {
            title_norms: strings(&["acme example"]),
            source_ids: strings(&["default"]),
            types: strings(&["person"]),
            exclude_private: None,
        };
        let hits = store.find_pages_by_titles(&q).unwrap();
        assert_eq!(
            hits,
            vec![
                json!({"slug": "people/a", "source_id": "default", "t": "acme example"}),
                json!({"slug": "people/b", "source_id": "default", "t": "acme example"}),
            ]
        );
        assert_eq!(
            store.read_page_title("default", "people/a").unwrap(),
            Some("ACME example".to_string())
        );
        assert_eq!(
            store.read_page_title("default", "people/none").unwrap(),
            None
        );
        let nul = store.read_page_title("default", "a\0b").unwrap_err();
        assert_eq!(nul.code, crate::error::INVALID_ARGUMENT);
        let nul = store
            .find_pages_by_titles(&TitleQuery {
                title_norms: strings(&["a\0"]),
                ..q
            })
            .unwrap_err();
        assert_eq!(nul.code, crate::error::INVALID_ARGUMENT);
    }
}
