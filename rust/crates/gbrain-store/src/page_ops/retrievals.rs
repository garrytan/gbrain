//! Page retrieval records: the `page_retrievals` table of the SQL engines (`src/core/last-retrieved.ts`).
//! A user-facing read (search, query, recall, get_page, fetch) records when it last surfaced each
//! page; the domain-bank samplers read it as `last_retrieved_at` and `staleBias` ranks by it.
//!
//! Member: bumpPageRetrievals (`src/core/engine-sql/pages.ts`).
//!
//! Keys (under the family tag `keys::PAGE_OPS`, `p`):
//! - `p 0x01 <page id u64 BE>` -> the time it was last retrieved, in microseconds (JSON integer).
//!
//! The record is keyed by page id, so a rename keeps it and `putPage` never resets it, as the SQL
//! table keys it. A hard page delete drops it (`remove_page_rows`), as the SQL engines'
//! `gbrain_forget_page_retrievals` trigger does.

use crate::error::Result;
use crate::kv::{KvRead, KvWrite};
use crate::pages::{PageRecord, read_page_by_id};
use crate::{Store, get_json, keys, put_json};

/// The sub-tag of the retrieval records inside the `page_ops` family.
const RETRIEVAL: u8 = 0x01;

/// The 5-minute write throttle of `BUMP_LAST_RETRIEVED_SQL`.
const THROTTLE_US: i64 = 5 * 60 * 1_000_000;

fn key(page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::PAGE_OPS, RETRIEVAL];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// When the page was last retrieved, in microseconds; None when it never was.
pub(crate) fn last_retrieved_us(read: &dyn KvRead, page_id: u64) -> Result<Option<i64>> {
    get_json(read, &key(page_id))
}

/// Deletes the retrieval record of a page that is deleted for good (`cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    tx.delete(&key(page.id))
}

impl Store {
    /// `bumpPageRetrievals(pageIds)`: records now as the retrieval time of each page id that names a
    /// page (deleted or not, as `FROM pages p` reads), unless its record is under 5 minutes old.
    /// Returns how many records it wrote. An empty or unknown id list writes nothing.
    pub fn bump_page_retrievals(&self, page_ids: &[i64]) -> Result<u64> {
        if page_ids.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut seen = std::collections::HashSet::new();
            let mut written = 0;
            for &id in page_ids {
                let Ok(id) = u64::try_from(id) else { continue };
                if !seen.insert(id) || read_page_by_id(tx, id)?.is_none() {
                    continue;
                }
                if last_retrieved_us(tx, id)?.is_some_and(|at| at >= now - THROTTLE_US) {
                    continue;
                }
                put_json(tx, &key(id), &now)?;
                written += 1;
            }
            Ok(written)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::{PageInput, PutPageOptions, read_page};
    use crate::test_support::store;
    use serde_json::json;

    fn put(s: &Store, slug: &str) -> u64 {
        let input: PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": format!("{slug} body"),
        }))
        .unwrap();
        s.put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
        let read = s.read().unwrap();
        read_page(&*read, "default", slug).unwrap().unwrap().id
    }

    #[test]
    fn records_known_pages_once_per_window() {
        let s = store();
        let a = put(&s, "notes/a");
        assert_eq!(s.bump_page_retrievals(&[]).unwrap(), 0);
        assert_eq!(
            s.bump_page_retrievals(&[a as i64, a as i64, 99_999, -1])
                .unwrap(),
            1
        );
        let first = last_retrieved_us(&*s.read().unwrap(), a).unwrap();
        assert!(first.is_some());
        assert_eq!(s.bump_page_retrievals(&[a as i64]).unwrap(), 0);
        assert_eq!(last_retrieved_us(&*s.read().unwrap(), a).unwrap(), first);
        assert_eq!(
            last_retrieved_us(&*s.read().unwrap(), 99_999).unwrap(),
            None
        );
    }

    #[test]
    fn a_hard_delete_drops_the_record() {
        let s = store();
        let a = put(&s, "notes/a");
        s.bump_page_retrievals(&[a as i64]).unwrap();
        s.delete_page("notes/a", None).unwrap();
        assert_eq!(last_retrieved_us(&*s.read().unwrap(), a).unwrap(), None);
    }
}
