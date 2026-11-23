//! Withdrawal page statements (src/core/engine-sql/withdrawal-pages.ts): the two members
//! `recordFactWithdrawal` (src/core/facts/withdrawal.ts) calls on the pages that carry a withdrawn
//! claim.
//!
//! - `listSegmentedPages`: the id and slug of the segmented pages among the slugs in the source.
//! - `invalidateWithdrawnPages`: every other page among the slugs in the source gets a new
//!   knowledge revision, no text projection revision and no embedding signature, in one store
//!   write; it answers each page's id, slug and new revision. `write_page` queues the page's
//!   projection rebuild, as Postgres's revision trigger does.
//!
//! A page is segmented when its truth and timeline are both NULL, which holds exactly for a
//! segmented page (`PageRecord`). Each slug counts once, in the order given, as `slug=ANY($2)`
//! matches a row once. Neither member skips a soft-deleted page, as neither statement does.

use crate::Store;
use crate::error::Result;
use crate::kv::KvRead;
use crate::links::no_nul;
use crate::pages::{PageRecord, read_page, write_page};
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn segmented(page: &PageRecord) -> bool {
    page.compiled_truth.is_null() && page.timeline.is_null()
}

/// The pages at `slugs` in `source_id`, each slug once, in the order given.
fn pages_at(
    read: &dyn KvRead,
    op: &str,
    source_id: &str,
    slugs: &[String],
) -> Result<Vec<PageRecord>> {
    no_nul(op, &[("sourceId", source_id)])?;
    let mut seen = BTreeSet::new();
    let mut pages = Vec::new();
    for slug in slugs {
        if !seen.insert(slug.as_str()) {
            continue;
        }
        if let Some(page) = read_page(read, source_id, slug)? {
            pages.push(page);
        }
    }
    Ok(pages)
}

impl Store {
    /// `listSegmentedPages(sourceId, slugs)`: `{ id, slug }` of each segmented page among `slugs`.
    pub fn list_segmented_pages(&self, source_id: &str, slugs: &[String]) -> Result<Vec<Value>> {
        let read = self.read()?;
        Ok(pages_at(&*read, "listSegmentedPages", source_id, slugs)?
            .into_iter()
            .filter(segmented)
            .map(|p| json!({ "id": p.id, "slug": p.slug }))
            .collect())
    }

    /// `invalidateWithdrawnPages(sourceId, slugs)`: a new knowledge revision, no text projection
    /// revision and no embedding signature for each inline page among `slugs`; answers
    /// `{ id, slug, knowledge_revision }` of each.
    pub fn invalidate_withdrawn_pages(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        self.write(|tx| {
            let mut out = Vec::new();
            for mut page in pages_at(&*tx, "invalidateWithdrawnPages", source_id, slugs)? {
                if segmented(&page) {
                    continue;
                }
                page.knowledge_revision = self.env.new_uuid();
                page.text_projection_revision = None;
                write_page(tx, &page)?;
                crate::embeddings::clear_signature(tx, page.id)?;
                out.push(json!({ "id": page.id, "slug": page.slug, "knowledge_revision": page.knowledge_revision }));
            }
            Ok(out)
        })
    }
}
