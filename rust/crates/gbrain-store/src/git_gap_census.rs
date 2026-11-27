//! The Git-gap census reads (`src/core/engine-sql/git-gap-census.ts`, run by
//! `src/commands/sources-git-gap.ts`), answered from the store's page, fact, link, timeline,
//! op-checkpoint and effect records (rust/docs/store/git-gap-census.md).
//!
//! Keys: none of its own. Every list is in byte order of its text keys, as the statements'
//! `COLLATE "C"` (or `ORDER BY` of a `COLLATE "C"` column) orders them.

use crate::Store;
use crate::cli_reads::entities::arrow_text;
use crate::error::{Result, StoreError};
use crate::facts::privacy_allows;
use crate::kv::{KvRead, scan_prefix};
use crate::pages::{PageRecord, all_pages};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

/// `GIT_GAP_BATCH`: the most pages one batch reads.
const BATCH: usize = 256;

/// The live pages of a source, by id.
fn live_pages(read: &dyn KvRead, source_id: &str) -> Result<Vec<PageRecord>> {
    let mut pages: Vec<PageRecord> = all_pages(read)?
        .into_iter()
        .filter(|p| p.source_id == source_id && p.deleted_at_us.is_none())
        .collect();
    pages.sort_by_key(|p| p.id);
    Ok(pages)
}

/// `bigint` input of a page id parameter.
fn page_id(text: &str, what: &str) -> Result<u64> {
    text.trim()
        .parse::<i64>()
        .ok()
        .map(|n| n.max(0) as u64)
        .ok_or_else(|| {
            StoreError::invalid(format!(
                "{what}: invalid input syntax for type bigint: \"{text}\""
            ))
        })
}

impl Store {
    /// `readGitGapSourceRow(sourceId)`: `{ local_path, incarnation }` of the source, or None.
    pub fn read_git_gap_source_row(&self, source_id: &str) -> Result<Option<Value>> {
        let read = self.read()?;
        Ok(crate::sources::read_source(&*read, source_id)?
            .map(|s| json!({ "local_path": s.local_path, "incarnation": s.incarnation })))
    }

    /// `countGitGapLivePages(sourceId)`: the source's live pages.
    pub fn count_git_gap_live_pages(&self, source_id: &str) -> Result<u64> {
        Ok(live_pages(&*self.read()?, source_id)?.len() as u64)
    }

    /// `listGitGapNewestPages(sourceId, limit)`: `{ id, updated_at }` of the `limit` live pages
    /// updated last (ties by the higher id), `updated_at` to the second in UTC
    /// (`YYYY-MM-DDTHH:MM:SSZ`).
    pub fn list_git_gap_newest_pages(&self, source_id: &str, limit: i64) -> Result<Vec<Value>> {
        let mut pages = live_pages(&*self.read()?, source_id)?;
        pages.sort_by(|a, b| b.updated_at_us.cmp(&a.updated_at_us).then(b.id.cmp(&a.id)));
        pages.truncate(usize::try_from(limit.max(0)).unwrap_or(usize::MAX));
        Ok(pages
            .iter()
            .map(|p| {
                let full = crate::env::iso(p.updated_at_us);
                json!({ "id": p.id.to_string(), "updated_at": format!("{}Z", &full[..19]) })
            })
            .collect())
    }

    /// `countGitGapUnreadFacts(sourceId, pageIds)`: the source's fenced facts whose fence page
    /// is live and is not one of `pageIds`.
    pub fn count_git_gap_unread_facts(&self, source_id: &str, page_ids: &[String]) -> Result<u64> {
        let read = self.read()?;
        let skip: HashSet<u64> = page_ids
            .iter()
            .map(|id| page_id(id, "countGitGapUnreadFacts"))
            .collect::<Result<_>>()?;
        let live: BTreeMap<String, u64> = live_pages(&*read, source_id)?
            .into_iter()
            .map(|p| (p.slug, p.id))
            .collect();
        Ok(crate::facts::source_rows(&*read, source_id)?
            .iter()
            .filter(|f| f.row_num.is_some())
            .filter(|f| {
                f.source_markdown_slug
                    .as_ref()
                    .and_then(|s| live.get(s))
                    .is_some_and(|id| !skip.contains(id))
            })
            .count() as u64)
    }

    /// `readGitGapPageBatch(sourceId, batch, honorAliases)`: the next live pages of the source by
    /// id, at most 256: after page id `after`, or exactly `ids`. Each with the census key fields
    /// and `lineage_private`, whether the privacy part hides it.
    pub fn read_git_gap_page_batch(
        &self,
        source_id: &str,
        after: Option<&str>,
        ids: Option<&[String]>,
        honor_aliases: bool,
    ) -> Result<Vec<Value>> {
        let read = self.read()?;
        let wanted: Option<HashSet<u64>> = ids
            .map(|ids| {
                ids.iter()
                    .map(|id| page_id(id, "readGitGapPageBatch"))
                    .collect::<Result<_>>()
            })
            .transpose()?;
        let after = after
            .map(|a| page_id(a, "readGitGapPageBatch"))
            .transpose()?;
        let mut rows = Vec::new();
        for p in live_pages(&*read, source_id)? {
            let keep = match (&wanted, after) {
                (Some(ids), _) => ids.contains(&p.id),
                (None, Some(after)) => p.id > after,
                (None, None) => true,
            };
            if !keep {
                continue;
            }
            if rows.len() >= BATCH {
                break;
            }
            let private = !privacy_allows(&*read, &p, honor_aliases)?;
            rows.push(json!({
                "id": p.id.to_string(), "slug": p.slug, "source_id": p.source_id, "source_path": p.source_path,
                "source_path_bytes": p.source_path.as_ref().map(|s| s.len()), "source_uri": p.source_uri,
                "withheld_source_path": Value::Null, "type": p.page_type,
                "frontmatter": crate::cli_reads::pg_text::jsonb_value(&Value::Object(p.frontmatter.clone())),
                "database_only_reason": p.database_only_reason, "segmented": crate::chunks::segmented(&p),
                "revision": p.knowledge_revision, "lineage_private": private,
            }));
        }
        Ok(rows)
    }

    /// `countGitGapFactsOnPages(sourceId, slugs)`: the source's fenced facts on the pages at
    /// `slugs`, expired ones too.
    pub fn count_git_gap_facts_on_pages(&self, source_id: &str, slugs: &[String]) -> Result<u64> {
        let read = self.read()?;
        let slugs: HashSet<&str> = slugs.iter().map(String::as_str).collect();
        Ok(crate::facts::source_rows(&*read, source_id)?
            .iter()
            .filter(|f| {
                f.row_num.is_some()
                    && f.source_markdown_slug
                        .as_deref()
                        .is_some_and(|s| slugs.contains(s))
            })
            .count() as u64)
    }

    /// `countGitGapTimelineOnPages(pageIds)`: the timeline rows of those pages.
    pub fn count_git_gap_timeline_on_pages(&self, page_ids: &[i64]) -> Result<u64> {
        let read = self.read()?;
        let ids: HashSet<i64> = page_ids.iter().copied().collect();
        let mut n = 0u64;
        for id in ids {
            let Ok(id) = u64::try_from(id) else { continue };
            scan_prefix(
                &*read,
                &crate::keys::timeline_prefix(id),
                false,
                &mut |_, _| {
                    n += 1;
                    true
                },
            )?;
        }
        Ok(n)
    }

    /// `readGitGapSourceRows(sourceId, derivedLinkSources, holdOp)`: `{ unfenced, fencePageMissing,
    /// links, holds, parked }` (see the engine-sql statements).
    pub fn read_git_gap_source_rows(
        &self,
        source_id: &str,
        derived: &[String],
        hold_op: &str,
    ) -> Result<Value> {
        let read = self.read()?;
        let facts = crate::facts::source_rows(&*read, source_id)?;
        let pages = live_pages(&*read, source_id)?;
        let live_slugs: HashSet<&str> = pages.iter().map(|p| p.slug.as_str()).collect();
        let unfenced = facts
            .iter()
            .filter(|f| f.row_num.is_none() && f.expired_at_us.is_none())
            .count();
        let fence_page_missing = facts
            .iter()
            .filter(|f| f.row_num.is_some())
            .filter(|f| {
                !f.source_markdown_slug
                    .as_deref()
                    .is_some_and(|s| live_slugs.contains(s))
            })
            .count();
        // Links out of the source's live pages whose provenance is not a derived one.
        let mut links: BTreeMap<String, i64> = BTreeMap::new();
        for p in &pages {
            for l in crate::links::out_links(&*read, p.id)? {
                if l.link_source.as_ref().is_some_and(|s| derived.contains(s)) {
                    continue;
                }
                *links
                    .entry(l.link_source.unwrap_or_else(|| "(none)".into()))
                    .or_insert(0) += 1;
            }
        }
        // The hold records of the source's current incarnation, by code (NULL codes last).
        let incarnation = crate::sources::read_source(&*read, source_id)?.map(|s| s.incarnation);
        let mut holds: BTreeMap<Option<String>, i64> = BTreeMap::new();
        if let Some(incarnation) = &incarnation {
            let rows = crate::persistence::list_op_checkpoint_records_in(&*read, hold_op)?;
            for row in rows.as_array().into_iter().flatten() {
                let record = row
                    .get("completed_keys")
                    .and_then(|k| k.get(0))
                    .cloned()
                    .unwrap_or(Value::Null);
                let field = |key: &str| record.get(key).and_then(arrow_text);
                if field("source_id").as_deref() == Some(source_id)
                    && field("incarnation").as_deref() == Some(incarnation.as_str())
                {
                    *holds.entry(field("code")).or_insert(0) += 1;
                }
            }
        }
        // Each effect's parked targets, by kind and error code (NULL codes last).
        let mut parked: BTreeMap<(String, Option<String>), i64> = BTreeMap::new();
        for e in crate::persistence::all_effects(&*read)? {
            if e.source_id.as_deref() != Some(source_id) {
                continue;
            }
            if let Some(Value::Array(targets)) = e.data.get("parked") {
                for t in targets {
                    let code = t.get("error_code").and_then(arrow_text);
                    *parked.entry((e.kind.clone(), code)).or_insert(0) += 1;
                }
            }
        }
        let nulls_last = |a: &Option<String>, b: &Option<String>| match (a, b) {
            (Some(a), Some(b)) => a.as_bytes().cmp(b.as_bytes()),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        };
        let mut holds: Vec<(Option<String>, i64)> = holds.into_iter().collect();
        holds.sort_by(|a, b| nulls_last(&a.0, &b.0));
        let mut parked: Vec<((String, Option<String>), i64)> = parked.into_iter().collect();
        parked.sort_by(|a, b| {
            a.0.0
                .as_bytes()
                .cmp(b.0.0.as_bytes())
                .then_with(|| nulls_last(&a.0.1, &b.0.1))
        });
        Ok(json!({
            "unfenced": unfenced,
            "fencePageMissing": fence_page_missing,
            "links": links.into_iter().map(|(link_source, n)| json!({ "link_source": link_source, "n": n })).collect::<Vec<_>>(),
            "holds": holds.into_iter().map(|(code, n)| json!({ "code": code, "n": n })).collect::<Vec<_>>(),
            "parked": parked.into_iter().map(|((kind, code), targets)| json!({ "kind": kind, "code": code, "targets": targets })).collect::<Vec<_>>(),
        }))
    }
}
