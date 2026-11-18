//! The page projection hook: keeps the page projection queue (Postgres `page_projection_jobs`) in
//! step with every page write, in the same transaction, as PGLite's `gbrain_queue_page_projection`
//! trigger does on every `pages` insert, update and delete.
//!
//! `queue_page_projection` gets the page as stored before the write and as stored after it, in the
//! same three forms as the page index hook (`page_index.rs`): `(None, Some(after))` for a new page,
//! `(Some(before), Some(after))` for any change to a stored page (a soft delete, a restore and a
//! rename included), and `(Some(before), None)` for a hard delete, before the record is deleted.
//! One store call can fire it more than once: a `putPage` that chunks the page writes it, then
//! writes it again to seal its text projection (`text_projection_revision`).
//!
//! `pages::write_page` and `pages::remove_page` call it; every page write goes through one of
//! them. The persistence family fills in `persistence::queue_page_projection`; this file does not
//! change when it does.

use crate::Result;
use crate::kv::KvWrite;
use crate::pages::PageRecord;

pub(crate) fn queue_page_projection(
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
    crate::persistence::queue_page_projection(tx, before, after)
}

#[cfg(test)]
mod tests {
    use crate::pages::{PageInput, PutPageOptions};
    use std::cell::RefCell;

    /// A page in a hook call: its slug, and whether it is soft deleted.
    type Seen = Option<(String, bool)>;

    thread_local! {
        /// Every `queue_page_projection` call on this test thread: `(before, after)`.
        pub(crate) static FIRED: RefCell<Vec<(Seen, Seen)>> = const { RefCell::new(Vec::new()) };
    }

    fn fired() -> Vec<(Seen, Seen)> {
        FIRED.with(|fired| fired.borrow_mut().drain(..).collect())
    }

    fn seen(slug: &str, deleted: bool) -> Seen {
        Some((slug.to_owned(), deleted))
    }

    #[test]
    fn the_projection_hook_sees_every_page_write_and_delete() {
        let store = crate::test_support::store();
        let input = PageInput {
            page_type: "note".into(),
            title: "First".into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page("a", &input, &PutPageOptions::default())
            .unwrap();
        // A put writes the page, then seals it once its chunks are written.
        assert_eq!(
            fired(),
            vec![
                (None, seen("a", false)),
                (seen("a", false), seen("a", false))
            ]
        );

        store.soft_delete_page("a", None).unwrap();
        assert_eq!(fired(), vec![(seen("a", false), seen("a", true))]);

        store.delete_page("a", None).unwrap();
        assert_eq!(fired(), vec![(seen("a", true), None)]);
    }
}
