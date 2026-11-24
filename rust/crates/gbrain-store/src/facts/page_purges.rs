//! The `page_purges` ledger (src/core/facts/purge-schema.ts): the text-free tombstones a page purge
//! leaves, one row per `(source_id, content_hash)` naming the purged page's slug, the write request
//! that purged it and when.
//!
//! Members: listRecentPurgeRequests and `upsertPagePurges` ([`Store::upsert_page_purges`], the page
//! purge sweep's `tombstonePage` in src/core/persistence/page-purge.ts). The restore replay
//! (`belief/purge-mirror.ts`) still writes the ledger with raw SQL and stops on the typed `raw_sql`
//! refusal. [`Store::record_page_purge`] is the same writer under the napi `recordPagePurge` name; the
//! store tests seed rows with it. The belief ledger's purge probe ([`has_page_purges`]) and
//! `countPurgedPageFacts` (facts/repair.rs) read the ledger.
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
//! - Deleting a source removes its tombstones (`ON DELETE CASCADE`, [`remove_source_page_purges`]).

use super::purge_ledger::PURGED_CONTENT;
use super::{DAY_US, text_key};
use crate::Store;
use crate::env::is_uuid;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, scan_prefix};
use crate::links::no_nul;
use crate::pages::PageRecord;
use crate::sources::require_source;
use crate::{get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The byte after `keys::FACT` that marks a page purge row.
const ROW: u8 = 0x0C;

/// One stored `page_purges` row.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct PagePurgeRecord {
    pub slug: String,
    pub request_id: Option<String>,
    pub purged_at_us: i64,
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

fn source_prefix(source_id: &str) -> Vec<u8> {
    text_key(ROW, &[source_id])
}

fn row_key(source_id: &str, content_hash: &str) -> Vec<u8> {
    text_key(ROW, &[source_id, content_hash])
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

/// Every `(content_hash, row)` of a source, by content hash (bytewise, as the key orders).
pub(crate) fn source_page_purges(
    read: &dyn KvRead,
    source_id: &str,
) -> Result<Vec<(String, PagePurgeRecord)>> {
    let prefix = source_prefix(source_id);
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        let hash = k[prefix.len()..]
            .strip_suffix(&[0])
            .unwrap_or(&k[prefix.len()..]);
        match serde_json::from_slice::<PagePurgeRecord>(v) {
            Ok(r) => out.push((String::from_utf8_lossy(hash).into_owned(), r)),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// Deletes the rows of a source (`page_purges.source_id ... ON DELETE CASCADE`).
pub(crate) fn remove_source_page_purges(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
) -> Result<()> {
    for (hash, _) in source_page_purges(&*tx, source_id)? {
        tx.delete(&row_key(source_id, &hash))?;
    }
    Ok(())
}

/// The `(slug, purged_at_us)` of every row of a source, in content-hash order (`countPurgedPageFacts`
/// reads the ledger through this).
pub(crate) fn source_purges(
    read: &dyn KvRead,
    source_id: &str,
    op: &str,
) -> Result<Vec<(String, i64)>> {
    let rows = source_page_purges(read, source_id).map_err(|e| {
        StoreError::new(
            e.code,
            format!("{op}: corrupt page purge record: {}", e.message),
        )
    })?;
    Ok(rows
        .into_iter()
        .map(|(_, r)| (r.slug, r.purged_at_us))
        .collect())
}

/// Every tombstone of one source, or of all sources when `source_id` is `None`, with its source and content hash, in
/// key order.
fn purge_rows(
    read: &dyn KvRead,
    source_id: Option<&str>,
    op: &str,
) -> Result<Vec<(String, String, PagePurgeRecord)>> {
    let prefix = match source_id {
        Some(source) => source_prefix(source),
        None => vec![keys::FACT, ROW],
    };
    let mut rows = Vec::new();
    let mut failed = None;
    scan_prefix(read, &prefix, false, &mut |k, v| {
        // The key is `F 0x0C source \0 content_hash \0`.
        let mut parts = k[2..].split(|b| *b == 0);
        let (Some(source), Some(hash)) = (parts.next(), parts.next()) else {
            return true;
        };
        match serde_json::from_slice::<PagePurgeRecord>(v) {
            Ok(record) => rows.push((
                String::from_utf8_lossy(source).into_owned(),
                String::from_utf8_lossy(hash).into_owned(),
                record,
            )),
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

/// The shadow seed (`seed.rs`): stores a tombstone copied from another engine, with its request id and time. `false`
/// when the tombstone is already stored.
pub(crate) fn seed_purge(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
    content_hash: &str,
    record: (&str, Option<&str>, i64),
) -> Result<bool> {
    let (slug, request_id, purged_at_us) = record;
    crate::links::no_nul(
        "seed page_purges",
        &[
            ("source_id", source_id),
            ("content_hash", content_hash),
            ("slug", slug),
        ],
    )?;
    let key = row_key(source_id, content_hash);
    if tx.get(&key)?.is_some() {
        return Ok(false);
    }
    put_json(
        tx,
        &key,
        &PagePurgeRecord {
            slug: slug.to_string(),
            request_id: request_id.map(str::to_string),
            purged_at_us,
        },
    )?;
    Ok(true)
}

/// The shadow follow (`seed/follow.rs`): removes the tombstone of `content_hash` in `source_id`.
/// `false` when there is none.
pub(crate) fn remove_purge(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
    content_hash: &str,
) -> Result<bool> {
    if source_id.contains('\0') || content_hash.contains('\0') {
        return Ok(false);
    }
    let key = row_key(source_id, content_hash);
    if tx.get(&key)?.is_none() {
        return Ok(false);
    }
    tx.delete(&key)?;
    Ok(true)
}

/// Writes one row. Only the unit tests of the readers call it; the store-side writer is
/// [`Store::record_page_purge`].
#[cfg(test)]
pub(crate) fn put_purge(
    tx: &mut dyn crate::kv::KvWrite,
    source_id: &str,
    content_hash: &str,
    slug: &str,
    purged_at_us: i64,
) -> Result<()> {
    put_json(
        tx,
        &row_key(source_id, content_hash),
        &PagePurgeRecord {
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
    if applies && read.get(&row_key(&record.source_id, hash))?.is_some() {
        return Err(StoreError::new(PURGED_CONTENT, PURGED_PAGE_MESSAGE));
    }
    Ok(())
}

impl Store {
    /// `INSERT INTO page_purges(source_id, content_hash, slug, request_id) ... ON CONFLICT
    /// (source_id, content_hash) DO UPDATE SET slug, request_id, purged_at = now()` for each hash:
    /// records the purge of a page's content under every hash it was saved with. It is
    /// [`Store::upsert_page_purges`] with the arguments spread out.
    pub fn record_page_purge(
        &self,
        source_id: &str,
        content_hashes: &[String],
        slug: &str,
        request_id: Option<&str>,
    ) -> Result<()> {
        self.upsert_page_purges(&PagePurgeUpsert {
            source_id: source_id.to_owned(),
            content_hashes: content_hashes.to_vec(),
            slug: slug.to_owned(),
            request_id: request_id.map(str::to_owned),
        })
    }

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

    /// `listPagePurgeTombstones`: `{ content_hash, slug }` of the source's tombstones, newest first (equal times in
    /// content-hash order), up to `limit`.
    pub fn list_page_purge_tombstones(
        &self,
        source_id: &str,
        limit: i64,
    ) -> Result<Vec<serde_json::Value>> {
        let op = "listPagePurgeTombstones";
        no_nul(op, &[("sourceId", source_id)])?;
        let limit = usize::try_from(limit)
            .map_err(|_| StoreError::invalid(format!("{op}: LIMIT must not be negative")))?;
        let mut rows = purge_rows(&*self.read()?, Some(source_id), op)?;
        rows.sort_by_key(|(_, _, r)| std::cmp::Reverse(r.purged_at_us));
        Ok(rows
            .into_iter()
            .take(limit)
            .map(|(_, hash, r)| serde_json::json!({ "content_hash": hash, "slug": r.slug }))
            .collect())
    }

    /// `listPagePurgeRows`: `{ source_id, slug, content_hash, request_id, purged_at }` of the tombstones of the source
    /// (of every source when `source_id` is `None`), newest first (equal times in source and content-hash order), up
    /// to `limit`; `purged_at` as ISO text.
    pub fn list_page_purge_rows(
        &self,
        source_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<serde_json::Value>> {
        let op = "listPagePurgeRows";
        no_nul(op, &[("sourceId", source_id.unwrap_or(""))])?;
        let limit = usize::try_from(limit)
            .map_err(|_| StoreError::invalid(format!("{op}: LIMIT must not be negative")))?;
        let mut rows = purge_rows(&*self.read()?, source_id, op)?;
        rows.sort_by_key(|(_, _, r)| std::cmp::Reverse(r.purged_at_us));
        Ok(rows
            .into_iter()
            .take(limit)
            .map(|(source, hash, r)| {
                serde_json::json!({ "source_id": source, "slug": r.slug, "content_hash": hash,
                    "request_id": r.request_id, "purged_at": crate::env::iso(r.purged_at_us) })
            })
            .collect())
    }

    /// `deletePagePurgeTombstones`: removes the source's tombstones under the slug and returns each one's request id
    /// (null when it has none), in content-hash order. The caller holds the source's write lock: the store admits one
    /// write transaction at a time.
    pub fn delete_page_purge_tombstones(
        &self,
        source_id: &str,
        slug: &str,
    ) -> Result<Vec<Option<String>>> {
        let op = "deletePagePurgeTombstones";
        no_nul(op, &[("sourceId", source_id), ("slug", slug)])?;
        self.write(|tx| {
            let mut requests = Vec::new();
            for (_, hash, record) in purge_rows(&*tx, Some(source_id), op)? {
                if record.slug == slug {
                    tx.delete(&row_key(source_id, &hash))?;
                    requests.push(record.request_id);
                }
            }
            Ok(requests)
        })
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
                let key = row_key(&row.source_id, hash);
                let kept = if keep_time {
                    get_json::<PagePurgeRecord>(tx, &key)?.map(|r| r.purged_at_us)
                } else {
                    None
                };
                put_json(
                    tx,
                    &key,
                    &PagePurgeRecord {
                        slug: row.slug.clone(),
                        request_id: request_id.clone(),
                        purged_at_us: kept.unwrap_or(now_us),
                    },
                )?;
            }
            Ok(())
        })
    }

    /// `listRecentPurgeRequests(days, cap)` over the page ledger: the distinct request ids of the
    /// purges newer than `days` days (`purged_at > now() - make_interval(days => $1)`), up to `cap`.
    /// The statement has no `ORDER BY`; ids come in byte order. The fact purge ledger
    /// (`fact_purges`, `facts::purge_ledger`) and the take purge ledger (`take_purges`,
    /// `facts::take_purges`) add their ids too.
    pub fn list_recent_purge_requests(&self, days: i64, cap: i64) -> Result<Vec<String>> {
        let since = self
            .env
            .now_micros()
            .saturating_sub(days.saturating_mul(DAY_US));
        let read = self.read()?;
        let mut requests: BTreeSet<String> = BTreeSet::new();
        let mut failure = None;
        scan_prefix(&*read, &[keys::FACT, ROW], false, &mut |_, v| {
            match serde_json::from_slice::<PagePurgeRecord>(v) {
                Ok(r) => {
                    if let (Some(request), true) = (r.request_id, r.purged_at_us > since) {
                        requests.insert(request);
                    }
                }
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        super::purge_ledger::recent_request_ids(&*read, since, &mut requests)?;
        super::take_purges::recent_request_ids(&*read, since, &mut requests)?;
        Ok(requests
            .into_iter()
            .take(usize::try_from(cap.max(0)).unwrap_or(usize::MAX))
            .collect())
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
            crate::get_json(&*store.read().unwrap(), &row_key("default", "h1"))
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
            crate::get_json::<PagePurgeRecord>(&*store.read().unwrap(), &row_key("default", hash))
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
