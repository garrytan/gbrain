//! The reads and writes a fence rewrite makes (`src/core/page-body/segment-rewrite.ts` and
//! `deleteRewrittenDerivations` in `segment-derive.ts`), each the store's answer to one statement
//! of `src/core/engine-sql/segmented-writes.ts`: the page a live rewrite reads and the
//! `deleted_at` it puts back, the page row a retained-generation rewrite locks, the manifest split
//! and publish that give a retained generation rows of its own, the version hash it restamps, and
//! the derivation rows a rewrite drops. Each write is one `Store::write`; the store serializes
//! writes, so the lock is a plain read.

use super::{
    ManifestRow, NIL_STAGING, live_published, manifest_key, manifest_rows, page_u64,
    read_body_state, staging_id_arg, uuid_bytes, violation,
};
use crate::env::{iso, parse_iso};
use crate::kv::KvRead;
use crate::pages::{PageRecord, read_page_by_id, versions_of, write_page};
use crate::{Result, Store, StoreError, keys, put_json};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

/// `readSegmentedRewritePage(pageId)`: the page a live fence rewrite reads, deleted or not.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentedRewritePage {
    pub id: i64,
    pub slug: String,
    pub source_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub page_kind: String,
    pub frontmatter: Value,
    pub body_generation: i64,
    pub body_bytes: Option<i64>,
    pub body_flags: Option<Value>,
    pub body_storage: String,
    pub deleted_at: Option<String>,
    pub contextual_retrieval_mode: Option<String>,
    pub corpus_generation: Option<String>,
    pub tags: Vec<String>,
}

/// `lockSegmentedGenerationPage(pageId)`: the body columns of the page a retained-generation
/// rewrite locks.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SegmentedGenerationLock {
    pub slug: String,
    pub source_id: String,
    pub body_flags: Option<Value>,
    pub body_storage: String,
    pub body_generation: i64,
}

fn page_by_id(read: &dyn KvRead, id: i64) -> Result<Option<PageRecord>> {
    Ok(page_u64(id)
        .map(|id| read_page_by_id(read, id))
        .transpose()?
        .flatten())
}

impl Store {
    /// `readSegmentedRewritePage(pageId)`: the page with its body columns, contextual stamp and
    /// tags (sorted), deleted or not; an inline page reads storage `inline` at generation 0. None
    /// for a missing page.
    pub fn read_segmented_rewrite_page(
        &self,
        page_id: i64,
    ) -> Result<Option<SegmentedRewritePage>> {
        let read = self.read()?;
        let Some(page) = page_by_id(&*read, page_id)? else {
            return Ok(None);
        };
        let state = read_body_state(&*read, page.id)?;
        let state = state.as_ref();
        let mut tags = page.tags.clone();
        tags.sort();
        Ok(Some(SegmentedRewritePage {
            id: page_id,
            contextual_retrieval_mode: crate::aliases::contextual_retrieval_mode(&*read, page.id)?,
            corpus_generation: crate::aliases::corpus_generation(&*read, page.id)?,
            deleted_at: page.deleted_at_us.map(iso),
            slug: page.slug,
            source_id: page.source_id,
            title: page.title,
            page_type: page.page_type,
            page_kind: page.page_kind,
            frontmatter: Value::Object(page.frontmatter),
            body_generation: state.map_or(0, |s| s.body_generation),
            body_bytes: state.and_then(|s| s.body_bytes),
            body_flags: state.and_then(|s| s.body_flags.clone()),
            body_storage: state.map_or_else(|| "inline".into(), |s| s.body_storage.clone()),
            tags,
        }))
    }

    /// `restorePageDeletedAt(pageId, deletedAt)`: sets the page's `deleted_at` back. A change
    /// moves the revision and drops the seal, as PGLite's `pages_knowledge_revision` trigger does.
    /// A missing page is a no-op.
    ///
    /// PGLite's `pages_derivation_scope_delete` trigger also notes the page for each derivation
    /// purge request of its source (`page_segment_derivation_purge_pages`) when `deleted_at` goes
    /// from null to a time. The store keeps no purge requests (`recordDerivationPurge` refuses
    /// `raw_sql` on a Rust brain), so that set is always empty here and the note writes nothing,
    /// as it writes nothing on PGLite with no request open. The purge sweep that adds the requests
    /// must add the note here too.
    pub fn restore_page_deleted_at(&self, page_id: i64, deleted_at: &str) -> Result<()> {
        let micros = parse_iso(deleted_at).ok_or_else(|| {
            StoreError::invalid(format!(
                "restorePageDeletedAt deletedAt: invalid input syntax for type timestamp with time zone: {deleted_at:?}"
            ))
        })?;
        self.write(|tx| {
            let Some(mut page) = page_by_id(&*tx, page_id)? else {
                return Ok(());
            };
            if page.deleted_at_us == Some(micros) {
                return Ok(());
            }
            page.deleted_at_us = Some(micros);
            page.knowledge_revision = self.env.new_uuid();
            page.text_projection_revision = None;
            write_page(tx, &page)
        })
    }

    /// `lockSegmentedGenerationPage(pageId)`: the page's body columns, or None. Store writes are
    /// serialized, so no other write can move the page under the caller's transaction.
    pub fn lock_segmented_generation_page(
        &self,
        page_id: i64,
    ) -> Result<Option<SegmentedGenerationLock>> {
        let read = self.read()?;
        let Some(page) = page_by_id(&*read, page_id)? else {
            return Ok(None);
        };
        let state = read_body_state(&*read, page.id)?;
        let state = state.as_ref();
        Ok(Some(SegmentedGenerationLock {
            slug: page.slug,
            source_id: page.source_id,
            body_flags: state.and_then(|s| s.body_flags.clone()),
            body_storage: state.map_or_else(|| "inline".into(), |s| s.body_storage.clone()),
            body_generation: state.map_or(0, |s| s.body_generation),
        }))
    }

    /// `splitManifestGeneration(pageId, generation, stagingId)`: gives retained generation `g`
    /// rows of its own. Each published row of `g` that also covers `g + 1` gets a copy from
    /// `g + 1` on, staged under `stagingId`; published rows that began before `g` end at `g`;
    /// published rows that began at `g` go.
    pub fn split_manifest_generation(
        &self,
        page_id: i64,
        generation: i64,
        staging_id: &str,
    ) -> Result<()> {
        let staging = staging_id_arg(staging_id)?;
        let Some(page) = page_u64(page_id) else {
            return Ok(());
        };
        let next = generation + 1;
        let staging_bytes = uuid_bytes(&staging);
        self.write(|tx| {
            let rows = manifest_rows(&*tx, page)?;
            for (_, row) in &rows {
                if row.staging_id.is_none()
                    && row.gen_from <= generation
                    && row.gen_to.is_none_or(|to| to > next)
                {
                    let key = manifest_key(page, row.occurrence_id, next, &staging_bytes);
                    if tx.get(&key)?.is_some() {
                        return Err(violation(format!(
                            "duplicate key value violates unique constraint \"page_body_manifest_pkey\" (page {page_id}, occurrence {}, gen_from {next})",
                            row.occurrence_id
                        )));
                    }
                    let copy = ManifestRow {
                        gen_from: next,
                        staging_id: Some(staging.clone()),
                        ..row.clone()
                    };
                    put_json(tx, &key, &copy)?;
                }
            }
            for (key, mut row) in rows {
                if row.staging_id.is_some() {
                    continue;
                }
                if row.gen_from == generation {
                    tx.delete(&key)?;
                } else if row.gen_from < generation && row.gen_to.is_none_or(|to| to > generation)
                {
                    row.gen_to = Some(generation);
                    put_json(tx, &key, &row)?;
                }
            }
            Ok(())
        })
    }

    /// `publishRebuiltGeneration(pageId, generation, stagingId)`: publishes the rows staged under
    /// `stagingId`; those that begin at `generation` end at `generation + 1`, the others keep their
    /// end. Refuses a row whose published key is taken or that would be a second live row at one
    /// seq, as Postgres's `page_body_manifest_pkey` and `page_body_manifest_live_seq` do.
    pub fn publish_rebuilt_generation(
        &self,
        page_id: i64,
        generation: i64,
        staging_id: &str,
    ) -> Result<()> {
        let staging = staging_id_arg(staging_id)?;
        let Some(page) = page_u64(page_id) else {
            return Ok(());
        };
        self.write(|tx| {
            let mut live_seqs: HashSet<i64> = HashSet::new();
            let mut moved = Vec::new();
            for (key, row) in manifest_rows(&*tx, page)? {
                if row.staging_id.as_deref() == Some(staging.as_str()) {
                    moved.push((key, row));
                } else if live_published(&row) {
                    live_seqs.insert(row.seq);
                }
            }
            for (key, _) in &moved {
                tx.delete(key)?;
            }
            for (_, mut row) in moved {
                row.staging_id = None;
                if row.gen_from == generation {
                    row.gen_to = Some(generation + 1);
                }
                let published = manifest_key(page, row.occurrence_id, row.gen_from, &NIL_STAGING);
                if tx.get(&published)?.is_some() {
                    return Err(violation(format!(
                        "duplicate key value violates unique constraint \"page_body_manifest_pkey\" (page {page_id}, occurrence {}, gen_from {})",
                        row.occurrence_id, row.gen_from
                    )));
                }
                if row.gen_to.is_none() && !live_seqs.insert(row.seq) {
                    return Err(violation(format!(
                        "duplicate key value violates unique constraint \"page_body_manifest_live_seq\" (page {page_id}, seq {})",
                        row.seq
                    )));
                }
                put_json(tx, &published, &row)?;
            }
            Ok(())
        })
    }

    /// `setSegmentedVersionHash(pageId, generation, contentHash, bodyBytes)`: sets `content_hash`
    /// and `body_bytes` on each segmented version of the page at `generation`.
    pub fn set_segmented_version_hash(
        &self,
        page_id: i64,
        generation: i64,
        content_hash: &str,
        body_bytes: i64,
    ) -> Result<()> {
        let Some(page) = page_u64(page_id) else {
            return Ok(());
        };
        self.write(|tx| {
            for mut row in versions_of(&*tx, page)? {
                if row.body_storage.as_deref() == Some("segmented")
                    && row.body_generation == Some(generation)
                {
                    row.content_hash = Some(content_hash.to_string());
                    row.body_bytes = Some(body_bytes);
                    put_json(tx, &keys::version(page, row.id), &row)?;
                }
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::segment_chunk_tests::{STAGING_2, published, row, staging, text};
    use super::super::{ReadManifestOptions, StageTextsOptions};
    use super::*;

    #[test]
    fn a_rewrite_page_reads_body_columns_tags_in_order_and_none_for_a_missing_page() {
        let store = crate::test_support::store();
        let id = published(&store);
        let page = store.read_segmented_rewrite_page(id).unwrap().unwrap();
        assert_eq!(page.body_storage, "segmented");
        assert_eq!(page.body_generation, 1);
        assert_eq!(page.body_bytes, Some(8));
        assert_eq!(page.deleted_at, None);
        assert!(
            store
                .read_segmented_rewrite_page(id + 99)
                .unwrap()
                .is_none()
        );
        let lock = store.lock_segmented_generation_page(id).unwrap().unwrap();
        assert_eq!(
            (lock.body_storage.as_str(), lock.body_generation),
            ("segmented", 1)
        );
    }

    #[test]
    fn restoring_deleted_at_keeps_the_page_deleted_and_moves_its_revision() {
        let store = crate::test_support::store();
        let id = published(&store);
        let before = store.read_segmented_rewrite_page(id).unwrap().unwrap();
        assert!(before.deleted_at.is_none());
        store
            .restore_page_deleted_at(id, "2026-01-02T03:04:05.000Z")
            .unwrap();
        let after = store.read_segmented_rewrite_page(id).unwrap().unwrap();
        assert_eq!(
            after.deleted_at.as_deref(),
            Some(iso(parse_iso("2026-01-02T03:04:05.000Z").unwrap()).as_str())
        );
        assert!(store.restore_page_deleted_at(id, "not a time").is_err());
        store
            .restore_page_deleted_at(id + 99, "2026-01-02T03:04:05Z")
            .unwrap();
    }

    #[test]
    fn a_split_then_publish_gives_a_retained_generation_rows_of_its_own() {
        let store = crate::test_support::store();
        let id = published(&store);
        // Generation 1 is live: rows 1 and 2 cover [1, ∞). Rebuild generation 1 as if it were
        // retained: the shared rows move to a copy from 2 on, and the rebuilt row takes [1, 2).
        store
            .open_body_staging(&staging(
                STAGING_2,
                id,
                "55555555-5555-4555-8555-555555555555",
            ))
            .unwrap();
        store
            .stage_segment_texts(
                "default",
                &[text("ONE\n")],
                &StageTextsOptions {
                    staging_id: Some(STAGING_2.into()),
                },
            )
            .unwrap();
        store.split_manifest_generation(id, 1, STAGING_2).unwrap();
        assert!(
            store
                .read_manifest(
                    id,
                    &ReadManifestOptions {
                        generation: Some(1),
                        ..Default::default()
                    }
                )
                .unwrap()
                .is_empty()
        );
        store
            .stage_manifest_rows(&[row(id, 3, 1, 0, 0, "ONE\n", STAGING_2)])
            .unwrap();
        store.publish_rebuilt_generation(id, 1, STAGING_2).unwrap();
        let gen1: Vec<i64> = store
            .read_manifest(
                id,
                &ReadManifestOptions {
                    generation: Some(1),
                    ..Default::default()
                },
            )
            .unwrap()
            .iter()
            .map(|r| r.occurrence_id)
            .collect();
        assert_eq!(gen1, vec![3]);
        let gen2: Vec<(i64, i64, Option<i64>)> = store
            .read_manifest(
                id,
                &ReadManifestOptions {
                    generation: Some(2),
                    ..Default::default()
                },
            )
            .unwrap()
            .iter()
            .map(|r| (r.occurrence_id, r.gen_from, r.gen_to))
            .collect();
        assert_eq!(gen2, vec![(1, 2, None), (2, 2, None)]);
        // Nothing is left staged, so a second publish changes nothing.
        store.publish_rebuilt_generation(id, 1, STAGING_2).unwrap();
        assert!(
            store
                .split_manifest_generation(id, 1, "not a uuid")
                .is_err()
        );
    }

    #[test]
    fn a_version_hash_is_restamped_only_on_segmented_versions_of_the_generation() {
        let store = crate::test_support::store();
        let id = published(&store);
        store.create_version("notes/a", Some("default")).unwrap();
        store
            .set_segmented_version_hash(id, 1, "rebuilt", 7)
            .unwrap();
        store.set_segmented_version_hash(id, 5, "other", 9).unwrap();
        let versions = versions_of(&*store.read().unwrap(), id as u64).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].content_hash.as_deref(), Some("rebuilt"));
        assert_eq!(versions[0].body_bytes, Some(7));
    }
}
