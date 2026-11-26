//! The page and fact reads of `gbrain access member handover` preview (`src/core/engine-sql/handover-reads.ts`):
//! the live pages whose readers name the leaver, the live pages a folder-rule prefix covers, and the member page and
//! fact counts. The store keeps no handover records and no member-source bindings, so those reads answer in the
//! TypeScript member (rust/docs/store/handover-reads.md).
//!
//! Keys: none of its own. It reads the page and fact records.
use crate::Store;
use crate::error::Result;
use crate::facts::doctor::every_fact;
use crate::facts::privacy::access_readers;
use crate::pages::{PageRecord, all_pages};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};

/// `slug = $2 OR ($2 LIKE '%/' AND left(slug, length($2)) = $2)`.
fn prefix_covers(slug: &str, prefix: &str) -> bool {
    slug == prefix || (prefix.ends_with('/') && slug.starts_with(prefix))
}

fn live(pages: Vec<PageRecord>) -> impl Iterator<Item = PageRecord> {
    pages.into_iter().filter(|p| p.deleted_at_us.is_none())
}

impl Store {
    /// `listHandoverReaderPages(principals, limit)`: `{ id, source_id, slug, frontmatter }` of the live pages whose
    /// normalized readers (`gbrain_access_readers`) share a principal with `principals`, by source id and slug in byte
    /// order, at most `limit`.
    pub fn list_handover_reader_pages(&self, principals: &[String], limit: u32) -> Result<Value> {
        let wanted: HashSet<&str> = principals.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut rows: Vec<PageRecord> = live(all_pages(&*read)?)
            .filter(|p| {
                access_readers(&p.frontmatter)
                    .is_some_and(|r| r.iter().any(|x| wanted.contains(x.as_str())))
            })
            .collect();
        rows.sort_by(|a, b| {
            (a.source_id.as_bytes(), a.slug.as_bytes())
                .cmp(&(b.source_id.as_bytes(), b.slug.as_bytes()))
        });
        rows.truncate(limit as usize);
        Ok(Value::Array(
            rows.into_iter()
                .map(|p| json!({ "id": p.id, "source_id": p.source_id, "slug": p.slug, "frontmatter": p.frontmatter }))
                .collect(),
        ))
    }

    /// `listHandoverPrefixPages(sourceId, prefix)`: `{ source_id, slug, frontmatter }` of the live pages of the source
    /// the prefix covers, at most 5000, by slug in byte order (the SQL sets no order; its callers read a set).
    pub fn list_handover_prefix_pages(&self, source_id: &str, prefix: &str) -> Result<Value> {
        let read = self.read()?;
        let mut rows: Vec<PageRecord> = live(all_pages(&*read)?)
            .filter(|p| p.source_id == source_id && prefix_covers(&p.slug, prefix))
            .collect();
        rows.sort_by(|a, b| a.slug.as_bytes().cmp(b.slug.as_bytes()));
        rows.truncate(5000);
        Ok(Value::Array(
            rows.into_iter()
                .map(|p| json!({ "source_id": p.source_id, "slug": p.slug, "frontmatter": p.frontmatter }))
                .collect(),
        ))
    }

    /// `countMemberPage(slug)`: the live pages, in any source, with this slug.
    pub fn count_member_page(&self, slug: &str) -> Result<u64> {
        let read = self.read()?;
        Ok(live(all_pages(&*read)?).filter(|p| p.slug == slug).count() as u64)
    }

    /// `countMemberPageFacts(slug)`: the facts whose `source_markdown_slug` is this slug and whose source holds a live
    /// page with it (the SQL joins `pages p ON p.source_id = f.source_id AND p.slug = f.source_markdown_slug`).
    pub fn count_member_page_facts(&self, slug: &str) -> Result<u64> {
        let read = self.read()?;
        let sources: BTreeSet<String> = live(all_pages(&*read)?)
            .filter(|p| p.slug == slug)
            .map(|p| p.source_id)
            .collect();
        Ok(every_fact(&*read)?
            .iter()
            .filter(|f| {
                f.source_markdown_slug.as_deref() == Some(slug) && sources.contains(&f.source_id)
            })
            .count() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::prefix_covers;

    #[test]
    fn a_prefix_covers_itself_and_only_its_folder_when_it_ends_in_a_slash() {
        assert!(prefix_covers("notes/a", "notes/a"));
        assert!(prefix_covers("notes/a", "notes/"));
        assert!(!prefix_covers("notes-b/a", "notes"));
        assert!(!prefix_covers("notesa", "notes"));
        assert!(!prefix_covers("other/a", "notes/"));
    }
}
