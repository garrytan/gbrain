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
//! The by-alias key is empty. The by-page key of a derived row (`replaceDerivedAliases`, origin
//! `declared` or `subject`) holds its [`DerivedAliasValue`] (`case_sensitive`, `alias_text`); the
//! by-page key of a `frontmatter` row is empty, the column defaults (`false`, NULL). The layout is
//! private to `aliases.rs`; this module mirrors it, and tests write through
//! `Store::set_page_aliases` and `Store::replace_derived_aliases` and read the rows back here to
//! pin it. A by-alias key with a value, a by-page value that is not a `DerivedAliasValue`, or a
//! by-alias key with no by-page key was written by a writer this reader does not know: the read
//! refuses with `store_corrupt` rather than guess what the row holds.
//!
//! Each read sorts in byte order, as the SQL's `COLLATE "C"` does. Text holding a NUL byte is
//! `invalid_argument`, as Postgres refuses a NUL in a text parameter.

use crate::aliases::DerivedAliasValue;
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
pub(crate) fn reject_nul<'a>(member: &str, items: impl IntoIterator<Item = &'a str>) -> Result<()> {
    for item in items {
        if item.contains('\0') {
            return Err(StoreError::invalid(format!(
                "{member}: invalid byte sequence for encoding \"UTF8\": 0x00"
            )));
        }
    }
    Ok(())
}

/// One alias key under a scan prefix: the text parts after the prefix, and the value.
struct AliasKey {
    parts: Vec<String>,
    value: Vec<u8>,
}

/// Every key under `prefix`, in key (byte) order.
fn alias_keys(read: &dyn KvRead, prefix: &[u8]) -> Result<Vec<AliasKey>> {
    let mut out = Vec::new();
    scan_prefix(read, prefix, false, &mut |k, v| {
        out.push(AliasKey {
            parts: k[prefix.len()..]
                .split(|b| *b == 0)
                .map(|p| String::from_utf8_lossy(p).into_owned())
                .collect(),
            value: v.to_vec(),
        });
        true
    })?;
    Ok(out)
}

fn corrupt(member: &str, what: &str) -> StoreError {
    StoreError::new(
        STORE_CORRUPT,
        format!("{member}: a page alias row {what} this store does not read"),
    )
}

/// The `case_sensitive` and `alias_text` columns a by-page value holds: an empty value is a
/// `frontmatter` row, the column defaults (`false`, NULL).
fn row_value(member: &str, value: &[u8]) -> Result<DerivedAliasValue> {
    if value.is_empty() {
        return Ok(DerivedAliasValue {
            case_sensitive: false,
            alias_text: None,
        });
    }
    serde_json::from_slice(value).map_err(|_| corrupt(member, "holds a value"))
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
    /// sources, as `{ slug, alias_norm, alias_text }` by slug, alias, alias text. The SQL leaves the
    /// order of two origins of one row open; this read puts them in origin byte order.
    pub fn resolve_case_sensitive_aliases(
        &self,
        alias_norms: &[String],
        source_ids: &[String],
    ) -> Result<Vec<Value>> {
        const MEMBER: &str = "resolveCaseSensitiveAliases";
        let sources = key_texts(MEMBER, source_ids)?;
        let aliases = key_texts(MEMBER, alias_norms)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for &source in &sources {
            for &alias in &aliases {
                for key in alias_keys(&*read, &alias_prefix(PAGE_ALIAS, &[source, alias]))? {
                    if !key.value.is_empty() {
                        return Err(corrupt(MEMBER, "holds a value"));
                    }
                    let [slug, origin] = key.parts.as_slice() else {
                        continue;
                    };
                    let mut by_page = alias_prefix(PAGE_ALIAS_BY_SLUG, &[source, slug, alias]);
                    by_page.extend_from_slice(origin.as_bytes());
                    let Some(value) = read.get(&by_page)? else {
                        return Err(corrupt(MEMBER, "has no page key"));
                    };
                    let value = row_value(MEMBER, &value)?;
                    if value.case_sensitive {
                        rows.push((slug.clone(), alias, value.alias_text, origin.clone()));
                    }
                }
            }
        }
        // The rows carry no source, so they sort by slug, alias and text across every listed source.
        rows.sort();
        let out = rows
            .into_iter()
            .map(|(slug, alias, text, _)| json!({"slug": slug, "alias_norm": alias, "alias_text": text}))
            .collect();
        Ok(out)
    }

    /// `readPageTitle`: the title of the page at `(source_id, slug)`, soft-deleted pages included;
    /// `None` with no page.
    pub fn read_page_title(&self, source_id: &str, slug: &str) -> Result<Option<String>> {
        reject_nul("readPageTitle", [source_id, slug])?;
        let read = self.read()?;
        Ok(read_page(&*read, source_id, slug)?.map(|p| p.title))
    }

    /// `readPageAliasRows`: every alias row of a listed slug in a listed source, as `{ slug,
    /// source_id, alias_norm, alias_text, origin }` by source, slug, alias, then origin.
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
                for key in alias_keys(&*read, &prefix)? {
                    let [alias, origin] = key.parts.as_slice() else {
                        continue;
                    };
                    let value = row_value(MEMBER, &key.value)?;
                    out.push(json!({
                        "slug": slug,
                        "source_id": source,
                        "alias_norm": alias,
                        "alias_text": value.alias_text,
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
    fn derived_rows_read_back_their_case_flag_and_text() {
        use crate::aliases::DerivedAliasRow;
        let store = temp_store();
        let row = |alias: &str, origin: &str, case_sensitive: bool, text: &str| DerivedAliasRow {
            alias_norm: alias.into(),
            origin: origin.into(),
            case_sensitive,
            alias_text: Some(text.into()),
        };
        store
            .set_page_aliases("people/alice-example", "default", &strings(&["ae"]))
            .unwrap();
        store
            .replace_derived_aliases(
                "people/alice-example",
                "default",
                &[
                    row("ae", "subject", true, "AE"),
                    row("ae", "declared", true, "AE"),
                    row("alice", "declared", false, "Alice"),
                ],
            )
            .unwrap();
        store
            .replace_derived_aliases(
                "people/a-founder",
                "default",
                &[row("ae", "declared", true, "aE")],
            )
            .unwrap();
        let rows = store
            .read_page_alias_rows(&strings(&["default"]), &strings(&["people/alice-example"]))
            .unwrap();
        let row_json = |alias: &str, text: Value, origin: &str| json!({"slug": "people/alice-example", "source_id": "default", "alias_norm": alias, "alias_text": text, "origin": origin});
        assert_eq!(
            rows,
            vec![
                row_json("ae", json!("AE"), "declared"),
                row_json("ae", Value::Null, "frontmatter"),
                row_json("ae", json!("AE"), "subject"),
                row_json("alice", json!("Alice"), "declared"),
            ]
        );
        let hits = store
            .resolve_case_sensitive_aliases(&strings(&["alice", "ae"]), &strings(&["default"]))
            .unwrap();
        assert_eq!(
            hits,
            vec![
                json!({"slug": "people/a-founder", "alias_norm": "ae", "alias_text": "aE"}),
                json!({"slug": "people/alice-example", "alias_norm": "ae", "alias_text": "AE"}),
                json!({"slug": "people/alice-example", "alias_norm": "ae", "alias_text": "AE"}),
            ]
        );
    }

    #[test]
    fn a_row_with_no_page_key_refuses() {
        let store = temp_store();
        store
            .write(|tx: &mut dyn KvWrite| {
                let mut key = alias_prefix(PAGE_ALIAS, &["default", "al", "p"]);
                key.extend_from_slice(b"declared");
                tx.put(&key, b"")
            })
            .unwrap();
        let err = store
            .resolve_case_sensitive_aliases(&strings(&["al"]), &strings(&["default"]))
            .unwrap_err();
        assert_eq!(err.code, STORE_CORRUPT);
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
