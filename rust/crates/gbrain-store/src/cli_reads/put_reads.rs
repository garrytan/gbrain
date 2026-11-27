//! Two reads of the `gbrain put` path that this store answers from what it keeps:
//!
//! - `hasExtractedEvents(sourceId, pageId)`: PGLite and Postgres ask whether an extracted
//!   life-chronicle row of the page lists at least one event hash. This store keeps no
//!   life-chronicle ledger (every chronicle ledger write refuses on this engine), so no page has
//!   such a row and the answer is false.
//! - `pageAwaitsRederive(pageId)`: whether a page with this id exists and a purge marked it in
//!   `needs_rederive`. Only a raw-SQL purge writes that queue and this store has no such rows
//!   (`takes.rs`, `facts.rs`), so the answer is false for every page, missing or not.
//!
//! Both still read the store, so a closed store refuses as every other read does.
//!
//! Keys: none of its own.

use crate::Store;
use crate::error::Result;

impl Store {
    /// `hasExtractedEvents(sourceId, pageId)`: an extracted chronicle row of the page lists at
    /// least one event hash. The store keeps no chronicle rows, so this is false.
    pub fn has_extracted_events(&self, _source_id: &str, _page_id: i64) -> Result<bool> {
        let _read = self.read()?;
        Ok(false)
    }

    /// `pageAwaitsRederive(pageId)`: a page with this id exists and a purge marked it in
    /// `needs_rederive`. The store keeps no `needs_rederive` rows, so this is false.
    pub fn page_awaits_rederive(&self, _page_id: i64) -> Result<bool> {
        let _read = self.read()?;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use crate::pages::{PageInput, PutPageOptions, read_page};

    #[test]
    fn a_written_page_has_no_extracted_events_and_awaits_no_rederive() {
        let store = crate::test_support::store();
        let input = PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page("notes/a", &input, &PutPageOptions::default())
            .unwrap();
        let id = store
            .write(|tx| Ok(read_page(&*tx, "default", "notes/a")?.unwrap().id))
            .unwrap() as i64;
        assert!(!store.has_extracted_events("default", id).unwrap());
        assert!(!store.page_awaits_rederive(id).unwrap());
        // A missing page and a negative id read false too, as the SQL engines answer them.
        assert!(!store.has_extracted_events("default", id + 1).unwrap());
        assert!(!store.page_awaits_rederive(id + 1).unwrap());
        assert!(!store.page_awaits_rederive(-1).unwrap());
    }
}
