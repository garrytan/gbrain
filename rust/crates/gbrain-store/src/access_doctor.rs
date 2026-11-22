//! The doctor access reads (rust/docs/store/access-doctor.md): the live pages no enabled member reads remotely
//! (`listPagesReadByNobody`, doctor `access_pages_read_by_nobody`) and whether the owner-only guard is on
//! (`ownerOnlyMarkTriggers().held`, doctor `owner_only_marks_triggers`). PGLite and Postgres run the SQL in
//! `src/core/engine-sql/doctor-access.ts` and `src/core/engine-sql/owner-only-marks.ts`; this answers the same
//! questions from the store's records.
//!
//! Keys: none of its own. It reads the page records, their normalized readers (`page_readers`, `access_readers`), the
//! source configs and the owner-only marks.

use crate::Store;
use crate::error::Result;
use crate::facts::privacy::access_readers;
use crate::owner_only::OwnerOnlySources;
use crate::pages::all_pages;
use serde::{Deserialize, Serialize};

/// `MEMBER_PAGE_PREFIX` (src/core/access/principals.ts): member pages are never counted.
pub const MEMBER_PAGE_PREFIX: &str = "memory/members/";
/// `NOBODY`: the marker of a page closed on purpose (and of an invalid `readable_by`).
pub const NOBODY: &str = "!nobody";

/// Which pages to read (`PagesReadByNobodySpec` of `src/core/engine-sql/doctor-access.ts`).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "by", rename_all = "camelCase")]
pub enum PagesReadByNobodySpec {
    /// Every live labelled page whose readers name none of `live` and not the nobody marker.
    Labelled { live: Vec<String> },
    /// The live pages of `source_id` the folder rule at `prefix` covers, not closed on purpose, that no identity in
    /// `admitted` reads: every covered page when `admitted` is empty, else the labelled ones naming none of it.
    #[serde(rename_all = "camelCase")]
    Rule {
        source_id: String,
        prefix: String,
        admitted: Vec<String>,
    },
}

/// A live page and its normalized readers (`PageReadByNobodyRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageReadByNobodyRow {
    pub source_id: String,
    pub slug: String,
    pub readers: Option<Vec<String>>,
}

/// `ruleCoversSql(slug, prefix)` (src/core/access/folder-rules.ts): the slug starts with the prefix, and the prefix is
/// empty, a folder (ends in `/`) or the slug itself.
fn rule_covers(slug: &str, prefix: &str) -> bool {
    slug.starts_with(prefix) && (prefix.is_empty() || prefix.ends_with('/') || slug == prefix)
}

fn overlaps(readers: &[String], set: &[String]) -> bool {
    readers.iter().any(|r| set.contains(r))
}

impl Store {
    /// The pages `spec` names, by (source, slug) in byte order. The SQL has no ORDER BY (the check sorts the rows), so
    /// any order is an answer; this one is stable.
    pub fn list_pages_read_by_nobody(
        &self,
        spec: &PagesReadByNobodySpec,
    ) -> Result<Vec<PageReadByNobodyRow>> {
        let read = self.read()?;
        let mut rows: Vec<PageReadByNobodyRow> = all_pages(&*read)?
            .into_iter()
            .filter(|p| p.deleted_at_us.is_none() && !p.slug.starts_with(MEMBER_PAGE_PREFIX))
            .filter_map(|p| {
                let readers = access_readers(&p.frontmatter);
                let keep = match spec {
                    PagesReadByNobodySpec::Labelled { live } => readers
                        .as_deref()
                        .is_some_and(|r| !overlaps(r, live) && !r.iter().any(|x| x == NOBODY)),
                    PagesReadByNobodySpec::Rule {
                        source_id,
                        prefix,
                        admitted,
                    } => {
                        p.source_id == *source_id
                            && rule_covers(&p.slug, prefix)
                            && !readers
                                .as_deref()
                                .is_some_and(|r| r.iter().any(|x| x == NOBODY))
                            && (admitted.is_empty()
                                || readers.as_deref().is_some_and(|r| !overlaps(r, admitted)))
                    }
                };
                keep.then_some(PageReadByNobodyRow {
                    source_id: p.source_id,
                    slug: p.slug,
                    readers,
                })
            })
            .collect();
        rows.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
        Ok(rows)
    }

    /// Whether the owner-only guard is on: the brain holds an owner-only source or a mark (`gbrain_owner_only_lineage()`,
    /// the read `ownerOnlyMarkTriggers().held` answers here). SQL keeps a held flag that stays set once the brain held
    /// owner-only data; the store reads the sources and the marks on every delete instead (`owner_only_marks.rs`), so
    /// this is the guard a delete would test now.
    pub fn owner_only_guarded(&self) -> Result<bool> {
        let read = self.read()?;
        Ok(OwnerOnlySources::read(&*read)?.guarded())
    }
}

#[cfg(test)]
mod tests {
    use super::rule_covers;

    #[test]
    fn rule_covers_matches_rule_covers_sql() {
        assert!(rule_covers("notes/a", ""));
        assert!(rule_covers("notes/a", "notes/"));
        assert!(rule_covers("notes/a", "notes/a"));
        assert!(!rule_covers("notes/ab", "notes/a"));
        assert!(!rule_covers("other/a", "notes/"));
    }
}
