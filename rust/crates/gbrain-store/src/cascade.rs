//! What a hard page delete removes beyond the page's own records. `pages::remove_page` deletes the
//! page's versions, chunks, links and timeline entries itself, then calls `remove_page_rows`, which
//! asks each family that keeps records under a page to delete them. A family edits only its own
//! `remove_page_rows`; this list names each such family once and does not change when one is built.

use crate::Result;
use crate::kv::KvWrite;
use crate::pages::PageRecord;

pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    crate::extraction::remove_page_rows(tx, page)?;
    crate::aliases::remove_page_rows(tx, page)?;
    crate::page_body::remove_page_rows(tx, page)?;
    crate::takes::remove_page_rows(tx, page)?;
    crate::code_edges::remove_page_rows(tx, page)?;
    crate::salience::remove_page_rows(tx, page)?;
    crate::raw_files::remove_page_rows(tx, page)?;
    crate::vectors::remove_page_rows(tx, page)?;
    crate::embeddings::remove_page_rows(tx, page)?;
    Ok(())
}
