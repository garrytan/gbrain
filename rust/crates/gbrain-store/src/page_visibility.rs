//! Page visibility guards: the reads a remote page write runs to learn whether the caller may see
//! the page it names and which of a list of pages the caller reads (the TypeScript
//! `engine-sql/page-visibility.ts`).
//!
//! Members: readPageHiddenFromCaller, readCallerPageAccess, readWriteVisibilityProbe. The TypeScript member turns the
//! caller's rendered page policy into a [`PrivacyPolicy`] (or refuses), so both reads judge a page
//! with `page_hidden` (facts/privacy.rs): `entity_privacy` false is the member-access part alone.
//! A soft-deleted page still has its row, so `readPageHiddenFromCaller` judges it too, and
//! `readCallerPageAccess` names it with `readable` false.
//!
//! `readWriteVisibilityProbe` is the one read a remote page write opens its visibility check with:
//! whether any access member is labelled-only (never: no store member is created labelled-only),
//! whether a reader identity could open the page the empty-identity policy hides (none when no row
//! is hidden; else whether the row names readers or a folder rule is stamped on it), and whether
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

use crate::facts::{PrivacyPolicy, page_hidden, stamped_rules};
use crate::owner_only::{any_owner_only, source_owner_only};
use crate::owner_only_marks::any_marked;
use crate::pages::read_page;
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
        // `gbrain_owner_only_lineage()` (v322): an owner-only source, or the one-way held flag a first mark sets.
        let owner_only_any = any_owner_only(&*read)? || any_marked(&*read)?;
        let identity_may_open = match read_page(&*read, source_id, slug)? {
            // `page_readers IS NOT NULL OR folder_rule_ids IS NOT NULL`.
            Some(page) if page_hidden(&*read, &page, policy)? => Some(
                page.frontmatter.contains_key("readable_by")
                    || !stamped_rules(&*read, &page)?.is_empty(),
            ),
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
}
