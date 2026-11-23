//! The two reads `scanStaleMentions` (src/core/by-mention.ts) made through raw SQL
//! (`src/core/engine-sql/mention-scan-reads.ts`): the pages it scans and their `mentions` links.
//! PGLite and Postgres run the SQL; this answers the same questions from the store's page and
//! link records. What each member answers: rust/docs/store/mention-scan-reads.md.
//!
//! Keys: none of its own. It reads page, body-state and link records.

use crate::Store;
use crate::error::Result;
use crate::kv::KvRead;
use crate::links::out_links;
use crate::page_body::segmented_reference;
use crate::pages::{PageRecord, all_pages, read_page_by_id};
use serde_json::{Value, json};

/// The link source of the mention pass.
const MENTIONS: &str = "mentions";

/// The pages `scanStaleMentions` scans: live pages with a `mentions` link, by slug bytes, then page
/// id (`ORDER BY p.slug COLLATE "C", p.id LIMIT`).
fn scanned_pages(read: &dyn KvRead, limit: usize) -> Result<Vec<PageRecord>> {
    let mut pages = Vec::new();
    for page in all_pages(read)? {
        if page.deleted_at_us.is_none()
            && out_links(read, page.id)?
                .iter()
                .any(|l| l.link_source.as_deref() == Some(MENTIONS))
        {
            pages.push(page);
        }
    }
    pages.sort_by(|a, b| {
        a.slug
            .as_bytes()
            .cmp(b.slug.as_bytes())
            .then(a.id.cmp(&b.id))
    });
    pages.truncate(limit);
    Ok(pages)
}

impl Store {
    /// `listStaleMentionPages(limit)`: the first `limit` live pages with a `mentions` link by slug
    /// bytes then page id, each with its `title`, `compiled_truth` and `timeline` joined by blank
    /// lines (a segmented page's empty body columns read as empty text), as
    /// `{ id, slug, source_id, title, body_storage, body }`.
    pub fn list_stale_mention_pages(&self, limit: u64) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for page in scanned_pages(&*read, usize::try_from(limit).unwrap_or(usize::MAX))? {
            let segmented = segmented_reference(&*read, page.id)?.is_some();
            let text = |t: &crate::pages::PageText| t.as_deref().unwrap_or("").to_string();
            let body = format!(
                "{}\n\n{}\n\n{}",
                page.title,
                text(&page.compiled_truth),
                text(&page.timeline)
            );
            out.push(json!({
                "id": page.id, "slug": page.slug, "source_id": page.source_id, "title": page.title,
                "body_storage": if segmented { "segmented" } else { "inline" }, "body": body,
            }));
        }
        Ok(out)
    }

    /// `listStaleMentionLinks(limit)`: the `mentions` links of those same pages by from-slug then
    /// to-slug bytes, as `{ from_id, from_slug, to_slug, to_source_id, link_kind, link_type }`.
    /// A link whose target page is gone is not listed, as the SQL join drops it.
    pub fn list_stale_mention_links(&self, limit: u64) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut rows = Vec::new();
        for page in scanned_pages(&*read, usize::try_from(limit).unwrap_or(usize::MAX))? {
            for link in out_links(&*read, page.id)? {
                if link.link_source.as_deref() != Some(MENTIONS) {
                    continue;
                }
                let Some(target) = read_page_by_id(&*read, link.to_page_id)? else {
                    continue;
                };
                rows.push((
                    page.slug.clone(),
                    target.slug.clone(),
                    page.id,
                    link,
                    target,
                ));
            }
        }
        rows.sort_by(|a, b| {
            a.0.as_bytes()
                .cmp(b.0.as_bytes())
                .then(a.1.as_bytes().cmp(b.1.as_bytes()))
                .then(a.2.cmp(&b.2))
                .then(a.4.source_id.cmp(&b.4.source_id))
        });
        Ok(rows
            .into_iter()
            .map(|(from_slug, to_slug, from_id, link, target)| {
                json!({
                    "from_id": from_id, "from_slug": from_slug, "to_slug": to_slug,
                    "to_source_id": target.source_id, "link_kind": link.link_kind,
                    "link_type": link.link_type,
                })
            })
            .collect())
    }
}
