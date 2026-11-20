//! Page visibility guards: the reads a remote page write runs to learn whether the caller may see
//! the page it names and which of a list of pages the caller reads (the TypeScript
//! `engine-sql/page-visibility.ts`).
//!
//! Members: readPageHiddenFromCaller, readCallerPageAccess, readWriteVisibilityProbe, and listVisiblePageSlugs (the
//! admin read of `get_health`'s `most_connected` for a remote caller). The TypeScript member turns the
//! caller's rendered page policy into a [`PrivacyPolicy`] (or refuses), so both reads judge a page
//! with `page_hidden` (facts/privacy.rs): `entity_privacy` false is the member-access part alone.
//! A soft-deleted page still has its row, so `readPageHiddenFromCaller` judges it too, and
//! `readCallerPageAccess` names it with `readable` false.
//!
//! `readWriteVisibilityProbe` is the one read a remote page write opens its visibility check with:
//! whether any access member is labelled-only (never: the store keeps no access members), whether
//! a reader identity could open the page the empty-identity policy hides (none when no row is
//! hidden; else whether the row names readers, since the store keeps no folder rules), and whether
//! the page's source or any source is owner-only (`config ->> 'kind'` is `imessage`, or
//! `config ->> 'owner_only'` is `true`).
//!
//! Every page policy PGLite renders for a caller that is not the owner ends with the owner-only test
//! (`ownerOnlyAllowedSql`); `page_hidden` applies it in the form the policy names (owner_only.rs):
//! `fn` hides a page whose source or concept-provenance input is owner-only, `closed` hides every
//! page while any source is owner-only.
//!
//! Keys: this family adds none. It reads page records through `pages.rs` and source records
//! through `sources.rs`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use crate::facts::{PrivacyPolicy, page_hidden};
use crate::owner_only::{any_owner_only, source_owner_only};
use crate::pages::read_page;
use crate::sources::all_sources;
use crate::{Result, Store};

/// One (source, slug) a caller asks about.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRef {
    pub source_id: String,
    pub slug: String,
}

/// One pair that names a page row, and whether its live row passes the policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CallerPageAccessRow {
    pub source_id: String,
    pub slug: String,
    pub readable: bool,
}

/// `listVisiblePageSlugs({ slugs, sourceIds })`'s arguments; the policy comes beside them.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisibleSlugsQuery {
    pub slugs: Vec<String>,
    /// The source scope; `None` admits every source.
    #[serde(default)]
    pub source_ids: Option<Vec<String>>,
}

/// The answer of `readWriteVisibilityProbe`, in the SQL's column names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WriteVisibilityProbe {
    pub any_labelled: bool,
    pub identity_may_open: Option<bool>,
    pub owner_only_source: bool,
    pub owner_only_any: bool,
}

impl Store {
    /// `readWriteVisibilityProbe(sourceId, slug, { policy })`: the opening read of a remote page
    /// write's visibility check, where `policy` is the empty-identity page policy with privacy.
    pub fn read_write_visibility_probe(
        &self,
        source_id: &str,
        slug: &str,
        policy: &PrivacyPolicy,
    ) -> Result<WriteVisibilityProbe> {
        let read = self.read()?;
        let owner_only_any = any_owner_only(&*read)?;
        let identity_may_open = match read_page(&*read, source_id, slug)? {
            Some(page) if page_hidden(&*read, &page, policy)? => {
                Some(page.frontmatter.contains_key("readable_by"))
            }
            _ => None,
        };
        let owner_only_source = source_owner_only(&*read, source_id)?;
        Ok(WriteVisibilityProbe {
            any_labelled: false,
            identity_may_open,
            owner_only_source,
            owner_only_any,
        })
    }

    /// `readPageHiddenFromCaller(sourceId, slug, { policy })`: whether the page row (live or
    /// soft-deleted) fails `policy`. A missing page is not hidden.
    pub fn read_page_hidden_from_caller(
        &self,
        source_id: &str,
        slug: &str,
        policy: &PrivacyPolicy,
    ) -> Result<bool> {
        let read = self.read()?;
        match read_page(&*read, source_id, slug)? {
            Some(page) => page_hidden(&*read, &page, policy),
            None => Ok(false),
        }
    }

    /// `readCallerPageAccess(pages, { policy })`: one row per distinct pair that names a page
    /// row, `readable` when the row is live and passes `policy`. Rows come in pair order
    /// (source, then slug, bytewise); PGLite sets no order.
    pub fn read_caller_page_access(
        &self,
        pages: &[PageRef],
        policy: &PrivacyPolicy,
    ) -> Result<Vec<CallerPageAccessRow>> {
        let read = self.read()?;
        let pairs: BTreeSet<(&str, &str)> = pages
            .iter()
            .map(|p| (p.source_id.as_str(), p.slug.as_str()))
            .collect();
        let mut rows = Vec::new();
        for (source_id, slug) in pairs {
            let Some(page) = read_page(&*read, source_id, slug)? else {
                continue;
            };
            let readable = page.deleted_at_us.is_none() && !page_hidden(&*read, &page, policy)?;
            rows.push(CallerPageAccessRow {
                source_id: source_id.to_owned(),
                slug: slug.to_owned(),
                readable,
            });
        }
        Ok(rows)
    }

    /// `listVisiblePageSlugs(slugs, sourceIds, policy)`: the distinct slugs among `slugs` that name a live page of a
    /// source in the scope (every source when `source_ids` is `None`) that passes `policy`, in byte order; the SQL sets
    /// no order. A slug or source id with a NUL byte names no page.
    pub fn list_visible_page_slugs(
        &self,
        q: &VisibleSlugsQuery,
        policy: &PrivacyPolicy,
    ) -> Result<Vec<String>> {
        let read = self.read()?;
        let sources: BTreeSet<String> = match &q.source_ids {
            Some(ids) => ids.iter().cloned().collect(),
            None => all_sources(&*read)?.into_iter().map(|s| s.id).collect(),
        };
        let wanted: BTreeSet<&str> = q.slugs.iter().map(String::as_str).collect();
        let mut out = Vec::new();
        for slug in wanted {
            for source_id in &sources {
                let Some(page) = read_page(&*read, source_id, slug)? else {
                    continue;
                };
                if page.deleted_at_us.is_none() && !page_hidden(&*read, &page, policy)? {
                    out.push(slug.to_owned());
                    break;
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn put(store: &Store, source: &str, slug: &str, frontmatter: serde_json::Value) {
        let input: crate::pages::PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter,
        }))
        .unwrap();
        let options: crate::pages::PutPageOptions =
            serde_json::from_value(json!({ "sourceId": source })).unwrap();
        store.put_page(slug, &input, &options).unwrap();
    }

    fn query(slugs: &[&str], sources: Option<&[&str]>) -> VisibleSlugsQuery {
        VisibleSlugsQuery {
            slugs: slugs.iter().map(|s| s.to_string()).collect(),
            source_ids: sources.map(|s| s.iter().map(|x| x.to_string()).collect()),
        }
    }

    /// A slug is kept once when a live page of a scoped source passes the policy; a private page, a page of another
    /// source and a missing slug are not.
    #[test]
    fn visible_slugs_keep_live_pages_the_policy_admits_within_the_scope() {
        let store = crate::test_support::store();
        let other: crate::sources::SourceInput =
            serde_json::from_value(json!({ "id": "other", "name": "other" })).unwrap();
        store.upsert_source(&other).unwrap();
        put(&store, "default", "notes/open", json!({}));
        put(&store, "other", "notes/open", json!({}));
        put(
            &store,
            "default",
            "notes/private",
            json!({ "visibility": "private" }),
        );
        put(&store, "other", "notes/elsewhere", json!({}));
        let policy: PrivacyPolicy = serde_json::from_value(json!({
            "honorAliases": false, "entityPrivacy": true, "ownerOnly": "off",
        }))
        .unwrap();
        let slugs = [
            "notes/private",
            "notes/open",
            "notes/elsewhere",
            "notes/never",
        ];
        let every = store
            .list_visible_page_slugs(&query(&slugs, None), &policy)
            .unwrap();
        assert_eq!(every, vec!["notes/elsewhere", "notes/open"]);
        let scoped = store
            .list_visible_page_slugs(&query(&slugs, Some(&["default"])), &policy)
            .unwrap();
        assert_eq!(scoped, vec!["notes/open"]);
        let none = store
            .list_visible_page_slugs(&query(&[], None), &policy)
            .unwrap();
        assert!(none.is_empty());
    }
}
