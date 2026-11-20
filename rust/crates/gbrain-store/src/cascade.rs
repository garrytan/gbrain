//! What a delete removes beyond core's own records. Each list below names, once, every family that
//! keeps records under the deleted thing, and does not change when one is built. A family edits
//! only its own hook.
//!
//! - `remove_page_rows`: a hard page delete. `pages::remove_page` deletes the page's versions,
//!   chunks, links and timeline entries itself, then calls it.
//! - `remove_chunk_rows`: chunks that are gone (`ON DELETE CASCADE` of a `content_chunks` id).
//!   `chunks::clear_chunks` calls it with every chunk of the page; `chunks::replace_chunks` with
//!   the chunks whose index the new set does not keep (a kept index keeps its id). A hard page
//!   delete calls it before `remove_page_rows`.
//! - `remove_source_rows`: a source delete (`ON DELETE CASCADE` of `sources.id`), for records keyed
//!   by source rather than by page. The Rust engine does not serve source delete yet, so nothing
//!   calls it; when core serves it, core removes each page of the source with
//!   `pages::remove_page` first (the page and chunk hooks fire for those), then calls this list,
//!   then deletes the source record, all in one write transaction.
//! - `rename_slug_rows`: a page rename (`updateSlug`), for records keyed by `(source, slug)` rather
//!   than by page id (PGLite `moveSlugBindings`, `page-state/rename-alias.ts`). The rename caller
//!   calls it in the rename transaction after `pages::rename_page`, only when the slug changed;
//!   core does not call it itself.

use crate::Result;
use crate::kv::KvWrite;
use crate::pages::PageRecord;
use crate::trust::WriteTrust;

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
    crate::wanted_links::remove_page_rows(tx, page)?;
    crate::link_queries::link_temporal::remove_page_rows(tx, page)?;
    crate::facts::reconcile::remove_page_rows(tx, page)?;
    crate::page_ops::remove_page_rows(tx, page)?;
    crate::entity_identities::remove_page_rows(tx, page)?;
    Ok(())
}

/// `chunk_ids` are sorted and belong to `page_id`; their chunk records are already gone.
pub(crate) fn remove_chunk_rows(
    tx: &mut dyn KvWrite,
    page_id: u64,
    chunk_ids: &[u64],
) -> Result<()> {
    #[cfg(test)]
    tests::FIRED.with(|fired| fired.borrow_mut().push((page_id, chunk_ids.to_vec())));
    crate::code_edges::remove_chunk_rows(tx, page_id, chunk_ids)?;
    crate::vectors::remove_chunk_rows(tx, page_id, chunk_ids)?;
    crate::embeddings::remove_chunk_rows(tx, page_id, chunk_ids)?;
    Ok(())
}

// Core's source delete is the first caller.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    crate::facts::remove_source_rows(tx, source_id)?;
    crate::aliases::remove_source_rows(tx, source_id)?;
    crate::code_edges::remove_source_rows(tx, source_id)?;
    crate::link_queries::remove_source_rows(tx, source_id)?;
    crate::raw_files::remove_source_rows(tx, source_id)?;
    crate::page_body::remove_source_rows(tx, source_id)?;
    crate::takes::remove_source_rows(tx, source_id)?;
    crate::extraction::remove_source_rows(tx, source_id)?;
    crate::trust::remove_source_rows(tx, source_id)?;
    crate::facts::loops::remove_source_rows(tx, source_id)?;
    crate::eval_capture::calibration_profiles::remove_source_rows(tx, source_id)?;
    Ok(())
}

// The aliases family's `updateSlug` is the first caller.
pub(crate) fn rename_slug_rows(
    tx: &mut dyn KvWrite,
    trust: &WriteTrust,
    source_id: &str,
    old_slug: &str,
    new_slug: &str,
) -> Result<()> {
    crate::facts::rename_slug_rows(tx, trust, source_id, old_slug, new_slug)?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::chunks::ChunkInput;
    use crate::pages::{PageInput, PutPageOptions};
    use std::cell::RefCell;

    thread_local! {
        /// Every `remove_chunk_rows` call on this test thread: `(page_id, chunk_ids)`.
        pub(crate) static FIRED: RefCell<Vec<(u64, Vec<u64>)>> = const { RefCell::new(Vec::new()) };
    }

    fn fired() -> Vec<(u64, Vec<u64>)> {
        FIRED.with(|fired| fired.borrow_mut().drain(..).collect())
    }

    fn chunk(index: u32, text: &str) -> ChunkInput {
        ChunkInput {
            chunk_index: index,
            chunk_text: text.into(),
            chunk_source: None,
            modality: None,
            rest: Default::default(),
        }
    }

    fn ids(store: &crate::Store, page_id: u64) -> Vec<u64> {
        crate::chunks::read_chunks(&*store.read().unwrap(), page_id)
            .unwrap()
            .iter()
            .map(|c| c.id)
            .collect()
    }

    #[test]
    fn the_chunk_hook_gets_exactly_the_chunks_that_are_gone() {
        use crate::chunks::UpsertChunksOptions;
        let store = crate::test_support::store();
        let input = PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page("a", &input, &PutPageOptions::default())
            .unwrap();
        let page = crate::pages::read_page(&*store.read().unwrap(), "default", "a")
            .unwrap()
            .unwrap();
        let options = UpsertChunksOptions::default();
        store
            .upsert_chunks(
                "a",
                &[chunk(0, "x"), chunk(1, "y"), chunk(2, "z")],
                &options,
            )
            .unwrap();
        fired();
        let three = ids(&store, page.id);
        assert_eq!(three.len(), 3);

        // Index 1 goes; 0 and 2 keep their ids, so only index 1's id is reported.
        store
            .upsert_chunks("a", &[chunk(0, "new"), chunk(2, "z")], &options)
            .unwrap();
        assert_eq!(fired(), vec![(page.id, vec![three[1]])]);
        assert_eq!(ids(&store, page.id), vec![three[0], three[2]]);

        // The same indexes again: nothing is gone, so the hook is not called.
        store
            .upsert_chunks("a", &[chunk(0, "x"), chunk(2, "z")], &options)
            .unwrap();
        assert_eq!(fired(), vec![]);

        // deleteChunks reports every chunk.
        store.delete_chunks("a", None).unwrap();
        assert_eq!(fired(), vec![(page.id, vec![three[0], three[2]])]);

        // A hard page delete reports its chunks too.
        store
            .upsert_chunks("a", &[chunk(0, "x")], &options)
            .unwrap();
        let last = ids(&store, page.id);
        fired();
        store.delete_page("a", None).unwrap();
        assert_eq!(fired(), vec![(page.id, last)]);
    }

    #[test]
    fn the_source_list_runs_and_removes_nothing_while_every_hook_is_empty() {
        let store = crate::test_support::store();
        let input = PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page("a", &input, &PutPageOptions::default())
            .unwrap();
        store
            .write(|tx| super::remove_source_rows(tx, "default"))
            .unwrap();
        assert_eq!(store.count_pages(None).unwrap(), 1);
    }

    #[test]
    fn the_rename_list_runs_and_moves_nothing_while_every_hook_is_empty() {
        let store = crate::test_support::store();
        let input = PageInput {
            page_type: "note".into(),
            title: "A".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page("a", &input, &PutPageOptions::default())
            .unwrap();
        store
            .write(|tx| {
                super::rename_slug_rows(
                    tx,
                    &crate::trust::WriteTrust::default(),
                    "default",
                    "a",
                    "b",
                )
            })
            .unwrap();
        let read = store.read().unwrap();
        assert!(
            crate::pages::read_page(&*read, "default", "a")
                .unwrap()
                .is_some()
        );
        assert!(
            crate::pages::read_page(&*read, "default", "b")
                .unwrap()
                .is_none()
        );
    }
}
