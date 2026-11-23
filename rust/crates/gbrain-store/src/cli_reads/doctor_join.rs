//! Doctor reads of the checks the rust-engine/main join brought in: the two page scans of
//! `access_pages_read_by_nobody` (SQL in `src/core/engine-sql/doctor-join.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-join.md`). The other members of that file answer in TypeScript from the store's
//! access members, groups, member links and sources. Each read takes one snapshot and has no keys of its own.

use serde::Serialize;

use crate::Store;
use crate::error::Result;
use crate::facts::privacy::access_readers;
use crate::pages::{PageRecord, all_pages};

/// `NOBODY` (src/core/access/principals.ts): the reader a page names to stay closed on purpose.
const NOBODY: &str = "!nobody";
/// `MEMBER_PAGE_PREFIX` (src/core/access/principals.ts): a member's own pages.
const MEMBER_PAGE_PREFIX: &str = "memory/members/";

/// A live page and its normalized readers (`PageReadersRow`): `page_readers`, none when the page names no reader.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageReadersRow {
    pub source_id: String,
    pub slug: String,
    pub readers: Option<Vec<String>>,
}

fn row(page: PageRecord, readers: Option<Vec<String>>) -> PageReadersRow {
    PageReadersRow {
        source_id: page.source_id,
        slug: page.slug,
        readers,
    }
}

/// `readers && principals`: some reader is one of `principals`.
fn names_any(readers: &[String], principals: &[String]) -> bool {
    readers.iter().any(|r| principals.contains(r))
}

/// `ruleCoversSql('slug', prefix)` (src/core/access/folder-rules.ts): the slug starts with the prefix, and the prefix
/// is empty, ends in `/`, or is the whole slug.
fn rule_covers(slug: &str, prefix: &str) -> bool {
    slug.starts_with(prefix) && (prefix.is_empty() || prefix.ends_with('/') || slug == prefix)
}

/// Sorted by (source, slug): the SQL leaves the order undefined and the check sorts what it keeps.
fn sorted(mut rows: Vec<PageReadersRow>) -> Vec<PageReadersRow> {
    rows.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
    rows
}

impl Store {
    /// `listPagesReadByNobody(live)`: the live pages whose readers name none of `live` and not the nobody marker,
    /// member pages left out. A page with no `readable_by` has no readers and is not listed.
    pub fn list_pages_read_by_nobody(&self, live: &[String]) -> Result<Vec<PageReadersRow>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() || page.slug.starts_with(MEMBER_PAGE_PREFIX) {
                continue;
            }
            let Some(readers) = access_readers(&page.frontmatter) else {
                continue;
            };
            if names_any(&readers, live) || readers.iter().any(|r| r == NOBODY) {
                continue;
            }
            rows.push(row(page, Some(readers)));
        }
        Ok(sorted(rows))
    }

    /// `listRulePagesReadByNobody(sourceId, prefix, admittedCount, admitted)`: the live pages of `source_id` the folder
    /// rule at `prefix` covers that are not closed on purpose, member pages left out; with `admitted_count` above 0
    /// only those whose own readers name none of `admitted` (a page with no readers is read through the rule).
    pub fn list_rule_pages_read_by_nobody(
        &self,
        source_id: &str,
        prefix: &str,
        admitted_count: i64,
        admitted: &[String],
    ) -> Result<Vec<PageReadersRow>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || page.source_id != source_id
                || !rule_covers(&page.slug, prefix)
                || page.slug.starts_with(MEMBER_PAGE_PREFIX)
            {
                continue;
            }
            let readers = access_readers(&page.frontmatter);
            if readers
                .as_ref()
                .is_some_and(|r| r.iter().any(|x| x == NOBODY))
            {
                continue;
            }
            if admitted_count != 0 && !readers.as_ref().is_some_and(|r| !names_any(r, admitted)) {
                continue;
            }
            rows.push(row(page, readers));
        }
        Ok(sorted(rows))
    }
}
