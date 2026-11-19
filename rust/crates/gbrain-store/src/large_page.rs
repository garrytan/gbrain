//! The large-page write guard's read: the stored body size of a live page, which a remote put_page
//! measures before it is queued (the TypeScript `engine-sql/large-page.ts`).
//!
//! Member: readStoredBodyBytes. A segmented page (both body columns NULL) answers its body state's
//! `body_bytes`; an inline page answers the UTF-8 bytes of `compiled_truth` plus `timeline` (a NULL
//! timeline counts 0), as PGLite's `octet_length(compiled_truth) + COALESCE(octet_length(timeline), 0)`.
//! A missing or soft-deleted page answers `None`.
//!
//! Member: readPageBodySizes, append_page's read after its write (persistence/page-append.ts): by
//! page id, deleted or not, `{ bytes, truth }`. `bytes` is the body state's `body_bytes` when set,
//! else the UTF-8 bytes of both body columns (NULL counts 0); `truth` is a segmented page's
//! `truth_bytes`, else the UTF-8 bytes of `compiled_truth`. A missing page answers `None`.
//!
//! Keys: this family adds none. It reads page records through `pages.rs` and body state through
//! `page_body.rs`.

use crate::page_body::{body_sizes, segmented_reference};
use crate::pages::{read_page, read_page_by_id};
use crate::{Result, Store};
use serde_json::{Value, json};

impl Store {
    /// `readStoredBodyBytes(slug, sourceId)`: the stored body size of the live page, or `None`.
    pub fn read_stored_body_bytes(&self, slug: &str, source_id: &str) -> Result<Option<i64>> {
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(None);
        };
        if page.compiled_truth.is_null() && page.timeline.is_null() {
            return Ok(segmented_reference(&*read, page.id)?.and_then(|(_, bytes)| bytes));
        }
        let timeline = page.timeline.as_deref().map_or(0, str::len);
        Ok(page
            .compiled_truth
            .as_deref()
            .map(|truth| i64::try_from(truth.len() + timeline).unwrap_or(i64::MAX)))
    }

    /// `readPageBodySizes(pageId)`: `{ bytes, truth }` of the page (deleted or not), or `None`.
    pub fn read_page_body_sizes(&self, page_id: i64) -> Result<Option<Value>> {
        let Ok(id) = u64::try_from(page_id) else {
            return Ok(None);
        };
        let read = self.read()?;
        let Some(page) = read_page_by_id(&*read, id)? else {
            return Ok(None);
        };
        let len = |text: Option<&str>| i64::try_from(text.map_or(0, str::len)).unwrap_or(i64::MAX);
        let truth_len = len(page.compiled_truth.as_deref());
        let inline = truth_len.saturating_add(len(page.timeline.as_deref()));
        let (segmented, body_bytes, truth_bytes) =
            body_sizes(&*read, id)?.unwrap_or((false, None, None));
        let truth = if segmented {
            truth_bytes
        } else {
            Some(truth_len)
        };
        Ok(Some(
            json!({ "bytes": body_bytes.unwrap_or(inline), "truth": truth }),
        ))
    }
}
