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
//! whether any access member is labelled-only (never: the store keeps no access members), whether
//! a reader identity could open the page the empty-identity policy hides (none when no row is
//! hidden; else whether the row names readers, since the store keeps no folder rules), and whether
//! the page's source or any source is owner-only (`config ->> 'kind'` is `imessage`, or
//! `config ->> 'owner_only'` is `true`).
//!
//! Every page policy PGLite renders for a caller that is not the owner ends with the owner-only test
//! (`ownerOnlyAllowedSql`). The store keeps no derivation lineage, so it applies the `closed` form
//! (`ownerOnlyForm` without a schema version): while any source is owner-only, every page is hidden.
//! A remote read on PGLite carries the schema version and takes the `fn` form, which hides only a
//! page whose source or lineage is owner-only, so there the store hides more pages, never fewer.
//!
//! Keys: this family adds none. It reads page records through `pages.rs` and source records
//! through `sources.rs`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use serde_json::{Map, Value};

use crate::facts::{PrivacyPolicy, page_hidden};
use crate::kv::KvRead;
use crate::pages::{PageRecord, read_page};
use crate::sources::{all_sources, read_source};
use crate::timeline_queries::jsonb_field_text;
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

/// `OWNER_ONLY_KINDS` (access/owner-only.ts): source kinds that are owner-only whatever their flag says.
const OWNER_ONLY_KINDS: &[&str] = &["imessage"];

/// `ownerOnlySourceRowSql`: `config->>'kind' IN OWNER_ONLY_KINDS OR config->>'owner_only' = 'true'`.
fn owner_only_config(config: &Map<String, Value>) -> bool {
    let text = |key: &str| config.get(key).and_then(jsonb_field_text);
    text("kind").is_some_and(|kind| OWNER_ONLY_KINDS.contains(&kind.as_str()))
        || text("owner_only").as_deref() == Some("true")
}

/// `page_hidden` with the owner-only test in its `closed` form: any owner-only source hides the page.
fn hidden_for_writer(
    read: &dyn KvRead,
    page: &PageRecord,
    policy: &PrivacyPolicy,
    owner_only_any: bool,
) -> Result<bool> {
    Ok(owner_only_any || page_hidden(read, page, policy)?)
}

/// Whether the brain holds an owner-only source (`ANY_OWNER_ONLY_SQL`).
fn any_owner_only(read: &dyn KvRead) -> Result<bool> {
    Ok(all_sources(read)?
        .iter()
        .any(|s| owner_only_config(&s.config)))
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
            Some(page) if hidden_for_writer(&*read, &page, policy, owner_only_any)? => {
                Some(page.frontmatter.contains_key("readable_by"))
            }
            _ => None,
        };
        let owner_only_source =
            read_source(&*read, source_id)?.is_some_and(|s| owner_only_config(&s.config));
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
            Some(page) => hidden_for_writer(&*read, &page, policy, any_owner_only(&*read)?),
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
        let owner_only_any = any_owner_only(&*read)?;
        let pairs: BTreeSet<(&str, &str)> = pages
            .iter()
            .map(|p| (p.source_id.as_str(), p.slug.as_str()))
            .collect();
        let mut rows = Vec::new();
        for (source_id, slug) in pairs {
            let Some(page) = read_page(&*read, source_id, slug)? else {
                continue;
            };
            let readable = page.deleted_at_us.is_none()
                && !hidden_for_writer(&*read, &page, policy, owner_only_any)?;
            rows.push(CallerPageAccessRow {
                source_id: source_id.to_owned(),
                slug: slug.to_owned(),
                readable,
            });
        }
        Ok(rows)
    }
}
