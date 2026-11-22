//! The page index hook: lets a family keep its own index of page fields (for example title
//! trigrams, or slugs by content hash) in step with every page write, in the same transaction.
//!
//! `reindex_page` gets the page as stored before the write and as stored after it:
//!
//! - `(None, Some(after))`: a new page.
//! - `(Some(before), Some(after))`: any change to a stored page, including a soft delete, a
//!   restore, a rename (`before.slug` is the old slug) and a tag change. It also fires when no field
//!   a family indexes changed, so a family compares the two and returns early.
//! - `(Some(before), None)`: a hard delete. It fires before the page record is deleted.
//!
//! One store call can fire it more than once: a `putPage` that chunks the page writes the page,
//! then writes it again to seal its text projection (`text_projection_revision`).
//!
//! `pages::write_page` and `pages::remove_page` call it; every page write goes through one of them.
//! A family edits only its own `reindex_page`; this list names each such family once and does not
//! change when one is built. Core keeps its own origin index (`o`) in `pages.rs`.

use crate::Result;
use crate::kv::KvWrite;
use crate::pages::PageRecord;

pub(crate) fn reindex_page(
    tx: &mut dyn KvWrite,
    before: Option<&PageRecord>,
    after: Option<&PageRecord>,
) -> Result<()> {
    #[cfg(test)]
    tests::FIRED.with(|fired| {
        let slug =
            |page: Option<&PageRecord>| page.map(|p| (p.slug.clone(), p.deleted_at_us.is_some()));
        fired.borrow_mut().push((slug(before), slug(after)));
    });
    crate::keyword::reindex_page(tx, before, after)?;
    crate::page_ops::reindex_page(tx, before, after)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::pages::{PageInput, PutPageOptions, read_page, rename_page};
    use std::cell::RefCell;

    /// A page in a hook call: its slug, and whether it is soft deleted.
    type Seen = Option<(String, bool)>;

    thread_local! {
        /// Every `reindex_page` call on this test thread: `(before, after)`.
        pub(crate) static FIRED: RefCell<Vec<(Seen, Seen)>> = const { RefCell::new(Vec::new()) };
    }

    fn fired() -> Vec<(Seen, Seen)> {
        FIRED.with(|fired| fired.borrow_mut().drain(..).collect())
    }

    fn seen(slug: &str, deleted: bool) -> Seen {
        Some((slug.to_owned(), deleted))
    }

    fn put(store: &crate::Store, title: &str) {
        let input = PageInput {
            page_type: "note".into(),
            title: title.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page("a", &input, &PutPageOptions::default())
            .unwrap();
    }

    #[test]
    fn the_index_hook_sees_every_page_write_before_and_after() {
        let store = crate::test_support::store();
        // A put writes the page, then seals it once its chunks are written.
        put(&store, "First");
        assert_eq!(
            fired(),
            vec![
                (None, seen("a", false)),
                (seen("a", false), seen("a", false))
            ]
        );

        put(&store, "Second");
        assert_eq!(
            fired(),
            vec![
                (seen("a", false), seen("a", false)),
                (seen("a", false), seen("a", false))
            ]
        );

        let page = read_page(&*store.read().unwrap(), "default", "a")
            .unwrap()
            .unwrap();
        store
            .write(|tx| rename_page(tx, &*store.env, &page, "b"))
            .unwrap();
        assert_eq!(fired(), vec![(seen("a", false), seen("b", false))]);

        store.soft_delete_page("b", None).unwrap();
        assert_eq!(fired(), vec![(seen("b", false), seen("b", true))]);

        assert!(store.restore_page("b", None).unwrap());
        assert_eq!(fired(), vec![(seen("b", true), seen("b", false))]);

        store.delete_page("b", None).unwrap();
        assert_eq!(fired(), vec![(seen("b", false), None)]);
    }
}
