//! The page purge ledger: the `page_purges` table (src/core/facts/purge-schema.ts).
//!
//! A tombstone says "a page with this content hash was purged from this source under this slug".
//! It lives at `F 0x0C source \0 content_hash` with the JSON value
//! `{"slug": <text>, "request_id": <uuid text or null>, "purged_at_us": <i64>}`; the key is the
//! table's primary key `(source_id, content_hash)`.
//!
//! - `upsertPagePurges` ([`Store::upsert_page_purges`]) writes it, for the page purge sweep
//!   (`persistence/page-purge.ts` `tombstonePage`): a hash already tombstoned takes the new slug,
//!   request id and time (`ON CONFLICT ... DO UPDATE`).
//! - `replayPagePurges` ([`Store::replay_page_purges`]) writes it for the restore replay
//!   (`belief/purge-mirror.ts`): the same upsert, except a hash already tombstoned keeps its time
//!   (the replay's statement sets no `purged_at`).
//! - `countPurgedPageFacts` (facts/repair.rs), the belief ledger's purge probe
//!   (trust/belief_history.rs) and the purge receipt's `countPagePurgeTombstones`
//!   ([`Store::count_page_purge_tombstones`]) read it.
//! - The page guard ([`refuse_purged_page`]) refuses a page write that stores a tombstoned hash in
//!   its source, as the `pages_refuse_purged` trigger does: `putPage` (an upsert, so the `BEFORE
//!   INSERT` trigger fires) on every write, other page writes on insert or a hash or source change.
//! - Deleting a source removes its tombstones (`ON DELETE CASCADE`, [`remove_source_rows`]).

use super::purge_ledger::PURGED_CONTENT;
use crate::Store;
use crate::env::is_uuid;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::PageRecord;
use crate::sources::require_source;
use crate::{get_json, put_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The byte after `keys::FACT` that marks a page purge tombstone.
const PURGE: u8 = 0x0C;

/// What is stored for a tombstone.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PurgeRecord {
    slug: String,
    request_id: Option<String>,
    purged_at_us: i64,
}

const PURGED_PAGE_MESSAGE: &str =
    "purged_content: this page content was purged from this source and cannot be saved again";

/// `upsertPagePurges`'s argument (`PagePurgeUpsert`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PagePurgeUpsert {
    pub source_id: String,
    pub content_hashes: Vec<String>,
    pub slug: String,
    pub request_id: Option<String>,
}

/// `F 0x0C source \0 content_hash \0`: one tombstone.
fn purge_key(source_id: &str, content_hash: &str) -> Vec<u8> {
    let mut key = keys::text(keys::FACT, &[source_id, content_hash]);
    key.insert(1, PURGE);
    key
}

/// `F 0x0C source \0`: every tombstone of a source.
fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut prefix = keys::text(keys::FACT, &[source_id, ""]);
    prefix.insert(1, PURGE);
    prefix
}

/// Whether the source has any page purge tombstone (`EXISTS (SELECT 1 FROM page_purges WHERE
/// source_id = $1)`), for the belief ledger's purge probe.
pub(crate) fn has_page_purges(read: &dyn KvRead, source_id: &str) -> Result<bool> {
    let mut found = false;
    scan_prefix(read, &source_prefix(source_id), false, &mut |_, _| {
        found = true;
        false
    })?;
    Ok(found)
}

/// The `(slug, purged_at_us)` of every tombstone of a source, in content-hash order.
pub(crate) fn source_purges(
    read: &dyn KvRead,
    source_id: &str,
    op: &str,
) -> Result<Vec<(String, i64)>> {
    let mut rows = Vec::new();
    let mut failed = None;
    scan_prefix(read, &source_prefix(source_id), false, &mut |_, v| {
        match serde_json::from_slice::<PurgeRecord>(v) {
            Ok(r) => rows.push((r.slug, r.purged_at_us)),
            Err(e) => {
                failed = Some(e);
                return false;
            }
        }
        true
    })?;
    match failed {
        Some(e) => Err(StoreError::invalid(format!(
            "{op}: corrupt page purge record: {e}"
        ))),
        None => Ok(rows),
    }
}

/// Writes one tombstone with a chosen time, for the unit tests.
#[cfg(test)]
pub(crate) fn put_purge(
    tx: &mut dyn KvWrite,
    source_id: &str,
    content_hash: &str,
    slug: &str,
    purged_at_us: i64,
) -> Result<()> {
    put_json(
        tx,
        &purge_key(source_id, content_hash),
        &PurgeRecord {
            slug: slug.to_string(),
            request_id: None,
            purged_at_us,
        },
    )
}

/// The page guard (`gbrain_refuse_purged_page`, `BEFORE INSERT OR UPDATE ON pages`): a write that
/// stores a content hash tombstoned in its source is refused, on insert (`before` is `None`) and
/// on an update that changes the hash or the source. A page with no hash (a segmented shell) passes.
pub(crate) fn refuse_purged_page(
    read: &dyn KvRead,
    before: Option<&PageRecord>,
    record: &PageRecord,
) -> Result<()> {
    let Some(hash) = record.content_hash.as_deref() else {
        return Ok(());
    };
    let applies = before
        .is_none_or(|b| b.content_hash.as_deref() != Some(hash) || b.source_id != record.source_id);
    if applies && read.get(&purge_key(&record.source_id, hash))?.is_some() {
        return Err(StoreError::new(PURGED_CONTENT, PURGED_PAGE_MESSAGE));
    }
    Ok(())
}

/// Removes every tombstone of a source, for the source delete.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut doomed = Vec::new();
    scan_prefix(tx, &source_prefix(source_id), false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    for k in doomed {
        tx.delete(&k)?;
    }
    Ok(())
}

impl Store {
    /// `upsertPagePurges`: stores one tombstone per content hash under the slug. A hash already
    /// tombstoned in the source takes the new slug, request id and time; an empty list writes
    /// nothing. As Postgres refuses a statement that upserts one key twice, a repeated hash is
    /// refused and nothing is written. `purged_at` is the open transaction's clock, else the store's.
    pub fn upsert_page_purges(&self, row: &PagePurgeUpsert) -> Result<()> {
        self.write_page_purges("upsertPagePurges", row, false)
    }

    /// `replayPagePurges`: the restore replay's tombstones, as [`Store::upsert_page_purges`]
    /// writes them, except a hash already tombstoned in the source keeps its `purged_at`.
    pub fn replay_page_purges(&self, row: &PagePurgeUpsert) -> Result<()> {
        self.write_page_purges("replayPagePurges", row, true)
    }

    /// `countPagePurgeTombstones`: how many of the source's tombstones name the slug (the purge
    /// receipt's count).
    pub fn count_page_purge_tombstones(&self, source_id: &str, slug: &str) -> Result<u64> {
        let rows = source_purges(&*self.read()?, source_id, "countPagePurgeTombstones")?;
        Ok(rows.iter().filter(|(s, _)| s == slug).count() as u64)
    }

    fn write_page_purges(&self, op: &str, row: &PagePurgeUpsert, keep_time: bool) -> Result<()> {
        no_nul(op, &[("sourceId", &row.source_id), ("slug", &row.slug)])?;
        for hash in &row.content_hashes {
            no_nul(op, &[("contentHashes", hash)])?;
        }
        let distinct: BTreeSet<&str> = row.content_hashes.iter().map(String::as_str).collect();
        if distinct.len() != row.content_hashes.len() {
            return Err(StoreError::invalid(format!(
                "{op}: ON CONFLICT DO UPDATE command cannot affect row a second time"
            )));
        }
        let request_id = match &row.request_id {
            None => None,
            Some(text) if is_uuid(text) => Some(text.to_lowercase()),
            Some(_) => {
                return Err(StoreError::invalid(format!(
                    "{op}: requestId is not a UUID"
                )));
            }
        };
        if row.content_hashes.is_empty() {
            return Ok(());
        }
        self.write(|tx| {
            require_source(tx, &row.source_id)?;
            let now_us = crate::env::transaction_clock::transaction_now()
                .unwrap_or_else(|| self.env.now_micros());
            for hash in &row.content_hashes {
                let key = purge_key(&row.source_id, hash);
                let kept = if keep_time {
                    get_json::<PurgeRecord>(tx, &key)?.map(|r| r.purged_at_us)
                } else {
                    None
                };
                put_json(
                    tx,
                    &key,
                    &PurgeRecord {
                        slug: row.slug.clone(),
                        request_id: request_id.clone(),
                        purged_at_us: kept.unwrap_or(now_us),
                    },
                )?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::OpenOptions;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::sources::SourceInput;
    use serde_json::json;
    use std::path::PathBuf;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open(name: &str) -> (Store, Dir) {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/unit-tmp")
            .join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open_dir(&dir.join("brain"), OpenOptions::default()).unwrap();
        let team: SourceInput = serde_json::from_value(json!({ "id": "team" })).unwrap();
        store.upsert_source(&team).unwrap();
        (store, Dir(dir))
    }

    fn upsert(source: &str, hashes: &[&str], slug: &str, request: Option<&str>) -> PagePurgeUpsert {
        serde_json::from_value(json!({ "sourceId": source, "contentHashes": hashes,
            "slug": slug, "requestId": request }))
        .unwrap()
    }

    fn slugs(store: &Store, source: &str) -> Vec<String> {
        source_purges(&*store.read().unwrap(), source, "test")
            .unwrap()
            .into_iter()
            .map(|(slug, _)| slug)
            .collect()
    }

    #[test]
    fn a_repeated_hash_takes_the_new_slug_and_a_bad_row_writes_nothing() {
        let (store, _dir) = open("page-purges-upsert");
        let request = "C0000000-0000-4000-8000-000000000001";
        store
            .upsert_page_purges(&upsert("default", &["h1", "h2"], "notes/a", Some(request)))
            .unwrap();
        store
            .upsert_page_purges(&upsert("default", &["h2"], "notes/b", None))
            .unwrap();
        assert_eq!(slugs(&store, "default"), ["notes/a", "notes/b"]);
        let stored: serde_json::Value =
            crate::get_json(&*store.read().unwrap(), &purge_key("default", "h1"))
                .unwrap()
                .unwrap();
        assert_eq!(stored["request_id"], request.to_lowercase());
        for bad in [
            upsert("default", &["h3", "h3"], "notes/c", None),
            upsert("default", &["h3"], "notes/c", Some("nope")),
            upsert("missing", &["h3"], "notes/c", None),
        ] {
            assert!(store.upsert_page_purges(&bad).is_err());
        }
        store
            .upsert_page_purges(&upsert("missing", &[], "notes/c", None))
            .unwrap();
        assert_eq!(slugs(&store, "default").len(), 2);
    }

    #[test]
    fn the_replay_moves_a_tombstoned_hash_to_the_new_slug_and_keeps_its_time() {
        let (store, _dir) = open("page-purges-replay");
        let time = |store: &Store, hash: &str| {
            crate::get_json::<PurgeRecord>(&*store.read().unwrap(), &purge_key("default", hash))
                .unwrap()
                .unwrap()
                .purged_at_us
        };
        store
            .upsert_page_purges(&upsert("default", &["h1"], "notes/a", None))
            .unwrap();
        let first = time(&store, "h1");
        std::thread::sleep(std::time::Duration::from_millis(2));
        store
            .replay_page_purges(&upsert("default", &["h1", "h2"], "notes/b", None))
            .unwrap();
        assert_eq!(slugs(&store, "default"), ["notes/b", "notes/b"]);
        assert_eq!(time(&store, "h1"), first);
        assert_eq!(
            store
                .count_page_purge_tombstones("default", "notes/b")
                .unwrap(),
            2
        );
        assert_eq!(
            store
                .count_page_purge_tombstones("default", "notes/a")
                .unwrap(),
            0
        );
        assert!(time(&store, "h2") > first);
        assert!(
            store
                .replay_page_purges(&upsert("default", &["h3", "h3"], "notes/c", None))
                .is_err()
        );
    }

    #[test]
    fn put_page_refuses_a_tombstoned_body_in_its_source_and_the_source_delete_clears_it() {
        let (store, _dir) = open("page-purges-guard");
        let input: PageInput = serde_json::from_value(
            json!({ "type": "note", "title": "Gone", "compiled_truth": "a purged body" }),
        )
        .unwrap();
        let team: PutPageOptions = serde_json::from_value(json!({ "sourceId": "team" })).unwrap();
        let page = store
            .put_page("notes/gone", &input, &PutPageOptions::default())
            .unwrap();
        let hash = page["content_hash"].as_str().unwrap().to_string();
        for source in ["default", "team"] {
            store
                .upsert_page_purges(&upsert(source, &[&hash], "notes/gone", None))
                .unwrap();
        }
        for (slug, options) in [
            ("notes/gone", &PutPageOptions::default()),
            ("notes/copy", &PutPageOptions::default()),
            ("notes/copy", &team),
        ] {
            let e = store.put_page(slug, &input, options).unwrap_err();
            assert!(e.message.starts_with("purged_content:"), "{}", e.message);
        }
        store
            .write(|tx| crate::cascade::remove_source_rows(tx, "team"))
            .unwrap();
        assert!(slugs(&store, "team").is_empty());
        assert_eq!(slugs(&store, "default"), ["notes/gone"]);
        store.put_page("notes/copy", &input, &team).unwrap();
    }
}
