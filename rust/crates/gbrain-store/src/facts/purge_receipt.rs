//! Group 5 facts reads, the plain reads of a purge's scan and receipt (src/core/engine-sql/facts-purge.ts).
//!
//! - `listSegmentedPageBodies(sourceId, limit)`: the source's live pages stored in segments, in id
//!   order, at most `limit`, each `{ page_id, slug, generation: null, version_id: null }`.
//! - `listSegmentedVersionBodies(sourceId, limit)`: the versions stored in segments of the source's
//!   pages (live or not, as the SQL joins pages without a `deleted_at` test), in version id order,
//!   at most `limit`, each `{ page_id, slug, generation, version_id }`.
//! - `listFactContextsForPurgeProbe(sourceId, after)`: the next 1000 unexpired facts of the source
//!   after id `after` whose context is not empty, in id order, each `{ id, context }`.
//! - `listPageSourcePathsForPurge(pageIds)`: the distinct file paths of the pages and of their
//!   versions (any source, as the SQL has no source test), not empty, not absolute, never with
//!   `..`, at most 64, in byte order.
//! - `countLegacyDerivedPages(sourceId)`: the source's live pages of type `atom` or with
//!   frontmatter `dream_generated` of text `true` that no `derivation_inputs` row explains.
//! - `vacuumPurgedTables(withQueryCache)`: a store has nothing to vacuum, so the member only runs
//!   the open check.
//! - `listPageProseHits(store, sourceId, loweredNeedles)`: the distinct slugs, in byte order, at
//!   most 20, of the source's pages whose text in `store` holds a needle after `lower()`. The
//!   `pages` store reads live pages only; the chunk, version and timeline-entry stores join pages
//!   without a `deleted_at` test, as the SQL does. A NULL column (a segmented page or version) holds
//!   no needle; an empty needle is in every other column, as `strpos(x, '') = 1`.
//! - `listNearestFactsForPurge(embedding, sourceId, model, fact)`: the five facts of the source
//!   (expired ones too) with a vector of `model`, nearest the target vector first, each
//!   `{ id, similarity, contains_claim }`.
//! - `countPurgeFingerprintResidue(sourceId, factHash, subject)`: `{ facts, takes }`, the facts of the
//!   source with the fingerprint, about `subject` (`*` for any) and not an outcome marker, and the
//!   takes on the source's pages with the fingerprint, on the page `subject` (`*` for any). Neither
//!   count tests expiry or `active`.
//!
//! `readPurgeSourceLocalPath` and `readPurgeReceiptSourcePath` are the store's
//! `readSourceLocalPath` (memory_mutation_reads.rs).

use super::embedding::{cosine_distance, parse_vector, to_halfvec};
use crate::Store;
use crate::chunks::read_chunks;
use crate::cli_reads::pg_text::pg_lower;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::facts::purge::outcome_marker;
use crate::facts::{fact_fingerprint, fact_normalize, invalid, source_rows};
use crate::generations::hop_limit;
use crate::keys;
use crate::kv::scan_prefix;
use crate::links::no_nul;
use crate::page_body::body_storage_columns;
use crate::pages::{PageRecord, all_pages, read_page_by_id, versions_of};
use crate::takes::all_takes;
use crate::timeline::TimelineRecord;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// `LIMIT 1000` of the context probe.
const CONTEXT_BATCH: usize = 1000;
/// `LIMIT 64` of the file path read.
const PATH_LIMIT: usize = 64;
/// `LIMIT 20` of the prose hits.
const PROSE_LIMIT: usize = 20;

/// `listSegmentedPageBodies` and `listSegmentedVersionBodies`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentedBodiesQuery {
    pub source_id: String,
    pub limit: i64,
}

/// `listFactContextsForPurgeProbe`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct FactContextsQuery {
    pub source_id: String,
    pub after: f64,
}

/// `listPageSourcePathsForPurge`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PageSourcePathsQuery {
    pub page_ids: Vec<i64>,
}

/// `listPageProseHits`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ProseHitsQuery {
    pub store: String,
    pub source_id: String,
    pub needles: Vec<String>,
}

/// `countPurgeFingerprintResidue`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ResidueQuery {
    pub source_id: String,
    pub fact_hash: String,
    pub subject: String,
}

/// `strpos(lower(text), n) > 0` for one of the needles; NULL text holds none.
fn states_needle(text: Option<&str>, needles: &[String]) -> bool {
    text.is_some_and(|t| {
        let lowered = pg_lower(t);
        needles.iter().any(|n| lowered.contains(n.as_str()))
    })
}

/// The pages of `source_id`, by id.
fn source_pages(pages: Vec<PageRecord>, source_id: &str) -> BTreeMap<u64, PageRecord> {
    pages
        .into_iter()
        .filter(|p| p.source_id == source_id)
        .map(|p| (p.id, p))
        .collect()
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct NearestPurgeQuery {
    /// The purge target's vector literal (`loadPurgeTarget`), cast to `halfvec`.
    pub embedding: String,
    pub source_id: String,
    pub model: String,
    pub fact: String,
}

impl Store {
    /// `listSegmentedPageBodies(sourceId, limit)`. A negative limit is refused, as `LIMIT` refuses it.
    pub fn list_segmented_page_bodies(&self, q: &SegmentedBodiesQuery) -> Result<Vec<Value>> {
        no_nul("listSegmentedPageBodies", &[("sourceId", &q.source_id)])?;
        let limit = hop_limit(q.limit)?;
        let read = self.read()?;
        let mut out = Vec::new();
        // all_pages walks the id index, so the pages come in id order.
        for page in all_pages(&*read)? {
            if out.len() >= limit {
                break;
            }
            if page.source_id != q.source_id || page.deleted_at_us.is_some() {
                continue;
            }
            if body_storage_columns(&*read, page.id)?.0 == "segmented" {
                out.push(json!({ "page_id": page.id, "slug": page.slug, "generation": null, "version_id": null }));
            }
        }
        Ok(out)
    }

    /// `listSegmentedVersionBodies(sourceId, limit)`. A negative limit is refused, as `LIMIT` refuses it.
    pub fn list_segmented_version_bodies(&self, q: &SegmentedBodiesQuery) -> Result<Vec<Value>> {
        no_nul("listSegmentedVersionBodies", &[("sourceId", &q.source_id)])?;
        let limit = hop_limit(q.limit)?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for page in all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == q.source_id)
        {
            for v in versions_of(&*read, page.id)? {
                if v.body_storage.as_deref() == Some("segmented") {
                    rows.push((v.id, json!({ "page_id": page.id, "slug": page.slug, "generation": v.body_generation, "version_id": v.id })));
                }
            }
        }
        rows.sort_by_key(|(id, _)| *id);
        Ok(rows.into_iter().take(limit).map(|(_, row)| row).collect())
    }

    /// `listFactContextsForPurgeProbe(sourceId, after)`.
    pub fn list_fact_contexts_for_purge_probe(&self, q: &FactContextsQuery) -> Result<Vec<Value>> {
        no_nul(
            "listFactContextsForPurgeProbe",
            &[("sourceId", &q.source_id)],
        )?;
        let read = self.read()?;
        let mut rows: Vec<_> = source_rows(&*read, &q.source_id)?
            .into_iter()
            .filter(|f| {
                f.id as f64 > q.after
                    && f.expired_at_us.is_none()
                    && f.context.as_deref().is_some_and(|c| !c.is_empty())
            })
            .collect();
        rows.sort_by_key(|f| f.id);
        Ok(rows
            .into_iter()
            .take(CONTEXT_BATCH)
            .map(|f| json!({ "id": f.id, "context": f.context }))
            .collect())
    }

    /// `listPageSourcePathsForPurge(pageIds)`.
    pub fn list_page_source_paths_for_purge(&self, q: &PageSourcePathsQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut paths = BTreeSet::new();
        let ids: BTreeSet<u64> = q
            .page_ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        for id in ids {
            if let Some(page) = read_page_by_id(&*read, id)? {
                paths.extend(page.source_path);
            }
            paths.extend(
                versions_of(&*read, id)?
                    .into_iter()
                    .filter_map(|v| v.source_path),
            );
        }
        Ok(paths
            .into_iter()
            .filter(|p| !p.is_empty() && !p.starts_with('/') && !p.contains(".."))
            .take(PATH_LIMIT)
            .map(|p| json!({ "source_path": p }))
            .collect())
    }

    /// `vacuumPurgedTables(withQueryCache)`: the open check; the store has nothing to vacuum.
    pub fn vacuum_purged_tables(&self) -> Result<()> {
        drop(self.read()?);
        Ok(())
    }

    /// `listPageProseHits(store, sourceId, loweredNeedles)`.
    pub fn list_page_prose_hits(&self, q: &ProseHitsQuery) -> Result<Vec<Value>> {
        const OP: &str = "listPageProseHits";
        no_nul(OP, &[("sourceId", &q.source_id)])?;
        for n in &q.needles {
            no_nul(OP, &[("needle", n)])?;
        }
        let read = self.read()?;
        let pages = source_pages(all_pages(&*read)?, &q.source_id);
        let needles = &q.needles;
        let mut slugs = BTreeSet::new();
        for page in pages.values() {
            let hit = match q.store.as_str() {
                "pages" => {
                    page.deleted_at_us.is_none()
                        && (states_needle(page.compiled_truth.as_deref(), needles)
                            || states_needle(Some(page.timeline.as_deref().unwrap_or("")), needles))
                }
                "content_chunks" => read_chunks(&*read, page.id)?
                    .iter()
                    .any(|c| states_needle(Some(&c.chunk_text), needles)),
                "page_versions" => versions_of(&*read, page.id)?.iter().any(|v| {
                    states_needle(v.compiled_truth.as_deref(), needles)
                        || states_needle(Some(v.timeline.as_deref().unwrap_or("")), needles)
                }),
                "timeline_entries" => page_entries(&*read, page.id)?.iter().any(|t| {
                    states_needle(Some(&t.summary), needles)
                        || states_needle(Some(&t.detail), needles)
                }),
                other => {
                    return Err(StoreError::new(
                        INVALID_ARGUMENT,
                        format!("{OP}: unknown page text store \"{other}\""),
                    ));
                }
            };
            if hit {
                slugs.insert(page.slug.clone());
            }
        }
        Ok(slugs
            .into_iter()
            .take(PROSE_LIMIT)
            .map(|slug| json!({ "slug": slug }))
            .collect())
    }

    /// `countPurgeFingerprintResidue(sourceId, factHash, subject)`.
    pub fn count_purge_fingerprint_residue(&self, q: &ResidueQuery) -> Result<Value> {
        no_nul(
            "countPurgeFingerprintResidue",
            &[
                ("sourceId", &q.source_id),
                ("factHash", &q.fact_hash),
                ("subject", &q.subject),
            ],
        )?;
        let all = q.subject == "*";
        let read = self.read()?;
        let facts = source_rows(&*read, &q.source_id)?
            .iter()
            .filter(|f| {
                fact_fingerprint(&f.fact) == q.fact_hash
                    && (all || f.entity_slug.as_deref() == Some(q.subject.as_str()))
                    && !outcome_marker(f)
            })
            .count();
        let pages = source_pages(all_pages(&*read)?, &q.source_id);
        let takes = all_takes(&*read)?
            .iter()
            .filter(|t| {
                pages
                    .get(&t.page_id)
                    .is_some_and(|p| all || p.slug == q.subject)
                    && fact_fingerprint(&t.claim) == q.fact_hash
            })
            .count();
        Ok(json!({ "facts": facts, "takes": takes }))
    }

    /// `listNearestFactsForPurge(embedding, sourceId, model, fact)`: the five facts of the source,
    /// expired ones too, with a vector of `model`, nearest the target first (NaN after every
    /// number, equal distances by id). `contains_claim` is
    /// `strpos(gbrain_fact_normalize(fact), gbrain_fact_normalize($4)) > 0`; an empty claim is in
    /// every fact, as `strpos` finds it at 1. A vector of another width fails, as `<=>` does, and
    /// the caller reports the probe skipped.
    pub fn list_nearest_facts_for_purge(&self, q: &NearestPurgeQuery) -> Result<Vec<Value>> {
        const OP: &str = "listNearestFactsForPurge";
        no_nul(
            OP,
            &[
                ("sourceId", q.source_id.as_str()),
                ("model", q.model.as_str()),
                ("fact", q.fact.as_str()),
            ],
        )?;
        let target = to_halfvec(&parse_vector(&q.embedding)?, None)?;
        let claim = fact_normalize(&q.fact);
        let read = self.read()?;
        let mut ranked: Vec<(f64, u64, bool)> = Vec::new();
        for row in source_rows(&*read, &q.source_id)? {
            let Some(vector) = row.embedding.as_deref() else {
                continue;
            };
            if row.embedding_model.as_deref() != Some(q.model.as_str()) {
                continue;
            }
            if vector.len() != target.len() {
                return Err(invalid(format!(
                    "{OP}: different halfvec dimensions {} and {}",
                    vector.len(),
                    target.len()
                )));
            }
            let contains = fact_normalize(&row.fact).contains(&claim);
            ranked.push((cosine_distance(vector, &target), row.id, contains));
        }
        ranked.sort_by(|(da, a, _), (db, b, _)| {
            da.is_nan()
                .cmp(&db.is_nan())
                .then(da.total_cmp(db))
                .then(a.cmp(b))
        });
        Ok(ranked
            .iter()
            .take(5)
            .map(|&(distance, id, contains)| {
                let similarity = 1.0 - distance;
                let similarity = if similarity.is_nan() {
                    json!("NaN")
                } else {
                    json!(similarity)
                };
                json!({ "id": id, "similarity": similarity, "contains_claim": contains })
            })
            .collect())
    }
}

/// The timeline entries of one page (`timeline_entries WHERE page_id = id`).
fn page_entries(read: &dyn crate::kv::KvRead, page_id: u64) -> Result<Vec<TimelineRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &keys::timeline_prefix(page_id), false, &mut |_, v| {
        match serde_json::from_slice::<TimelineRecord>(v) {
            Ok(entry) => out.push(entry),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

#[cfg(test)]
mod tests {
    use super::states_needle;

    #[test]
    fn a_needle_is_found_after_lower_and_null_holds_none() {
        let needles = vec!["needle".to_string()];
        assert!(states_needle(Some("The NEEDLE"), &needles));
        assert!(!states_needle(None, &needles));
        assert!(states_needle(Some(""), &[String::new()]));
        assert!(!states_needle(Some("hay"), &needles));
    }
}
