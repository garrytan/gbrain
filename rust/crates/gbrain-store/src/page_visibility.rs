//! Page visibility guards: the reads a remote page write runs to learn whether the caller may see
//! the page it names and which of a list of pages the caller reads (the TypeScript
//! `engine-sql/page-visibility.ts`).
//!
//! Members: readPageHiddenFromCaller, readCallerPageAccess. The TypeScript member turns the
//! caller's rendered page policy into a [`PrivacyPolicy`] (or refuses), so both reads judge a page
//! with `page_hidden` (facts/privacy.rs): `entity_privacy` false is the member-access part alone.
//! A soft-deleted page still has its row, so `readPageHiddenFromCaller` judges it too, and
//! `readCallerPageAccess` names it with `readable` false.
//!
//! Keys: this family adds none. It reads page records through `pages.rs`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use crate::facts::{PrivacyPolicy, page_hidden};
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

impl Store {
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
