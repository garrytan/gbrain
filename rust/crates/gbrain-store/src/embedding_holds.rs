//! A page's embedding hold (`page_embedding_budget`, the TypeScript `src/core/engine-sql/sources.ts`
//! and `src/core/page-embedding-budget.ts`): the state and reason a sync size-state read reports.
//!
//! Members: holdPageEmbedding writes a record; readPageSizeRows (`cli_reads/sources.rs`) reads it.
//! The store keeps only the state and reason. The spend ledger columns (signature, spent, reserved,
//! cap) have no record here: the embedding plan that reads and writes them still runs raw SQL on
//! PGLite and Postgres, and refuses on this engine.
//!
//! Keys (tag `h`, `keys::EMBEDDING_HOLD`): `h page_id` (big-endian), value `{ state, reason }`. A
//! hard page delete removes it (`ON DELETE CASCADE` of `pages.id`, `cascade::remove_page_rows`); a
//! soft delete and a restore keep it, as the row stays while the page row stays.

use crate::error::{PAGE_NOT_FOUND, StoreError};
use crate::kv::{KvRead, KvWrite};
use crate::pages::{PageRecord, read_page_by_id};
use crate::{Result, Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};

/// The stored state and reason of one page (`page_embedding_budget.state`, `.reason`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmbeddingHold {
    pub state: String,
    pub reason: Option<String>,
}

fn key(page_id: u64) -> Vec<u8> {
    keys::id_key(keys::EMBEDDING_HOLD, &[page_id])
}

/// The page's stored hold, if it has one.
pub(crate) fn read_hold(read: &dyn KvRead, page_id: u64) -> Result<Option<EmbeddingHold>> {
    get_json(read, &key(page_id))
}

pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    tx.delete(&key(page.id))
}

impl Store {
    /// `holdPageEmbedding(pageId, reason)`: sets the page's state to `held` with `reason`, adding
    /// the record when the page has none (`INSERT … ON CONFLICT (page_id) DO UPDATE SET state =
    /// 'held', reason = EXCLUDED.reason`). An unknown page id refuses `page_not_found` and stores
    /// nothing, as the foreign key refuses the insert.
    pub fn hold_page_embedding(&self, page_id: u64, reason: &str) -> Result<()> {
        if reason.contains('\0') {
            return Err(StoreError::invalid(
                "holdPageEmbedding: a reason may not hold a NUL byte",
            ));
        }
        self.write(|tx| {
            if read_page_by_id(&*tx, page_id)?.is_none() {
                return Err(StoreError::new(
                    PAGE_NOT_FOUND,
                    format!("holdPageEmbedding: no page with id {page_id}"),
                ));
            }
            put_json(
                tx,
                &key(page_id),
                &EmbeddingHold {
                    state: "held".into(),
                    reason: Some(reason.to_owned()),
                },
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions, read_page};

    fn page_id(store: &Store, slug: &str) -> u64 {
        let input = PageInput {
            page_type: "note".into(),
            title: slug.into(),
            compiled_truth: "body".into(),
            ..PageInput::default()
        };
        store
            .put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        read_page(&*store.read().unwrap(), "default", slug)
            .unwrap()
            .unwrap()
            .id
    }

    #[test]
    fn a_hold_replaces_the_reason_and_a_hard_delete_drops_it() {
        let store = crate::test_support::store();
        let id = page_id(&store, "a");
        store.hold_page_embedding(id, "awaiting_approval").unwrap();
        store.hold_page_embedding(id, "archive_backfill").unwrap();
        assert_eq!(
            read_hold(&*store.read().unwrap(), id).unwrap(),
            Some(EmbeddingHold {
                state: "held".into(),
                reason: Some("archive_backfill".into())
            })
        );
        store.delete_page("a", None).unwrap();
        assert_eq!(read_hold(&*store.read().unwrap(), id).unwrap(), None);
    }

    #[test]
    fn an_unknown_page_refuses() {
        let store = crate::test_support::store();
        let err = store.hold_page_embedding(999, "x").unwrap_err();
        assert_eq!(err.code, PAGE_NOT_FOUND);
    }
}
