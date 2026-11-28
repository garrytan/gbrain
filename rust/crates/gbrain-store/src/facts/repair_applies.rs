//! The rechecks and writes of `gbrain repair` applies that ran through `executeRaw`
//! (src/core/engine-sql/repair-applies.ts):
//!
//! - `restoreConsolidationTie(tie)`: consolidate-ties reopens the previewed fact (`valid_until` back to null).
//! - `listLiveDuplicateRows`, `supersedeDuplicateFacts`, `linkStruckDuplicateFacts`: duplicate-facts' recheck and its
//!   two writes.
//! - `listCommittedRestorePages`, `listActivePositionedFactIds`, `readFactRestorePage`, `restoreExtractorFact`:
//!   extractor-facts' resume check, its page read and its restore.
//! - `moveFactClaimDates(sourceId, rows)`: fact-claim-dates' database-only move.
//! - `readSourceCloneRow(sourceId)`: the url-clone check's source row.
//!
//! Each write reads the rows the statement's `WHERE` names and saves the changed ones through [`write_fact`], so the
//! trust stamp, the withdrawal guard, the purge guard and the unique indexes run as they do for the `UPDATE`. `now()` is
//! the store's clock, read once per call. Texts compare by bytes.

use super::captured::{id_set, named_rows};
use super::{bigint, entity_rows, fact_fingerprint, read_fact, source_rows, write_fact};
use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::links::no_nul;
use crate::pages::read_page;
use crate::persistence::all_requests;
use crate::persistence::projection_queue::parse_timestamptz;
use crate::sources::read_source;
use crate::timeline_queries::jsonb_field_text;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// `restoreConsolidationTie(tie)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TieArgs {
    pub source_id: String,
    pub id: f64,
    pub entity_slug: String,
    pub take_id: f64,
    pub valid_from: String,
}

/// `listLiveDuplicateRows` and `supersedeDuplicateFacts`: the group's facts and claim; `keptId` for the write.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DuplicateArgs {
    pub source_id: String,
    pub ids: Vec<f64>,
    #[serde(default)]
    pub kept_id: Option<f64>,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub fingerprint: Option<String>,
}

/// `listCommittedRestorePages(sourceIds, slugs, hash, requestIds)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommittedRestoreArgs {
    pub source_ids: Vec<String>,
    pub slugs: Vec<String>,
    pub hash: String,
    pub request_ids: Vec<String>,
}

/// `restoreExtractorFact(sourceId, id, rowNum, expiredAt)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractorRestoreArgs {
    pub source_id: String,
    pub id: f64,
    pub row_num: f64,
    pub expired_at: String,
}

/// `detachFenceRowFacts(sourceId, slug, rowNum)` and `hasDatabaseOnlyClaim(sourceId, entitySlug, fact)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FenceRowArgs {
    pub source_id: String,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default)]
    pub row_num: Option<f64>,
    #[serde(default)]
    pub entity_slug: Option<String>,
    #[serde(default)]
    pub fact: Option<String>,
}

/// `listPageAccessKeys({ ids, honorAliases })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccessKeyArgs {
    pub ids: Vec<f64>,
    pub honor_aliases: bool,
}

/// One row of `moveFactClaimDates`: the fact, the `valid_from` the preview read and the claim's day.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimDateRow {
    pub id: f64,
    pub valid_from: String,
    pub date: String,
}

/// `moveFactClaimDates(sourceId, rows)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimDateArgs {
    pub source_id: String,
    pub rows: Vec<ClaimDateRow>,
}

fn required<'a, T>(op: &str, what: &str, value: &'a Option<T>) -> Result<&'a T> {
    value
        .as_ref()
        .ok_or_else(|| StoreError::invalid(format!("{op}: {what} is required")))
}

/// A `bigint` id that names a row (at least 1), or none: a smaller id matches nothing.
fn row_id(op: &str, what: &str, value: f64) -> Result<Option<u64>> {
    Ok(u64::try_from(bigint(op, what, value)?)
        .ok()
        .filter(|id| *id >= 1))
}

impl Store {
    /// `restoreConsolidationTie(tie)`: `UPDATE facts SET valid_until = NULL WHERE source_id AND id AND entity_slug
    /// AND consolidated_into = take_id AND expired_at IS NULL AND valid_until = valid_from AND valid_from = $5`.
    /// True when it changed the row.
    pub fn restore_consolidation_tie(&self, a: &TieArgs) -> Result<bool> {
        const OP: &str = "restoreConsolidationTie";
        no_nul(
            OP,
            &[
                ("source_id", a.source_id.as_str()),
                ("entity_slug", a.entity_slug.as_str()),
            ],
        )?;
        let valid_from = parse_timestamptz(&a.valid_from, "restoreConsolidationTie valid_from")?;
        let take = bigint(OP, "take_id", a.take_id)?;
        let Some(id) = row_id(OP, "id", a.id)? else {
            return Ok(false);
        };
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = read_fact(&*tx, id)? else {
                return Ok(false);
            };
            if old.source_id != a.source_id
                || old.entity_slug.as_deref() != Some(a.entity_slug.as_str())
                || old.consolidated_into != Some(take)
                || old.expired_at_us.is_some()
                || old.valid_until_us != Some(old.valid_from_us)
                || old.valid_from_us != valid_from
            {
                return Ok(false);
            }
            let mut new = old.clone();
            new.valid_until_us = None;
            write_fact(tx, trust, Some(&old), &new)?;
            Ok(true)
        })
    }

    /// `listLiveDuplicateRows(sourceId, ids, visibility, fingerprint)`: the named facts of the source with that
    /// visibility and claim fingerprint that are unexpired, still valid and unsuperseded, as `{ id, entity_slug,
    /// row_num, source_markdown_slug }`, by id.
    pub fn list_live_duplicate_rows(&self, a: &DuplicateArgs) -> Result<Vec<Value>> {
        const OP: &str = "listLiveDuplicateRows";
        let visibility = required(OP, "visibility", &a.visibility)?;
        let fingerprint = required(OP, "fingerprint", &a.fingerprint)?;
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let ids = id_set(OP, &a.ids)?;
        let read = self.read()?;
        let now = self.env.now_micros();
        Ok(named_rows(&*read, &a.source_id, &ids)?
            .into_iter()
            .filter(|r| {
                &r.visibility == visibility
                    && r.expired_at_us.is_none()
                    && r.valid_until_us.is_none_or(|u| u > now)
                    && r.superseded_by.is_none()
                    && &fact_fingerprint(&r.fact) == fingerprint
            })
            .map(|r| {
                json!({ "id": r.id, "entity_slug": r.entity_slug, "row_num": r.row_num,
                    "source_markdown_slug": r.source_markdown_slug })
            })
            .collect())
    }

    /// `supersedeDuplicateFacts(sourceId, ids, keptId, visibility, fingerprint)`: while the kept fact of the source
    /// is unexpired, expires each named unexpired, unsuperseded fact with that visibility and fingerprint and sets its
    /// `superseded_by` to the kept fact. The ids it changed, by id.
    pub fn supersede_duplicate_facts(&self, a: &DuplicateArgs) -> Result<Vec<u64>> {
        const OP: &str = "supersedeDuplicateFacts";
        let visibility = required(OP, "visibility", &a.visibility)?;
        let fingerprint = required(OP, "fingerprint", &a.fingerprint)?;
        let kept = bigint(OP, "keptId", *required(OP, "keptId", &a.kept_id)?)?;
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let ids = id_set(OP, &a.ids)?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let kept_live = u64::try_from(kept)
                .ok()
                .map_or(Ok(None), |k| read_fact(&*tx, k))?
                .is_some_and(|k| k.source_id == a.source_id && k.expired_at_us.is_none());
            if !kept_live {
                return Ok(Vec::new());
            }
            let mut changed = Vec::new();
            for old in named_rows(&*tx, &a.source_id, &ids)? {
                if old.expired_at_us.is_some()
                    || old.superseded_by.is_some()
                    || &old.visibility != visibility
                    || &fact_fingerprint(&old.fact) != fingerprint
                {
                    continue;
                }
                let mut new = old.clone();
                new.expired_at_us = Some(now);
                new.superseded_by = Some(kept as u64);
                write_fact(tx, trust, Some(&old), &new)?;
                changed.push(old.id);
            }
            Ok(changed)
        })
    }

    /// `linkStruckDuplicateFacts(sourceId, ids, keptId)`: sets `superseded_by` to the kept fact on each named
    /// expired, unsuperseded fact of the source. The ids it changed, by id.
    pub fn link_struck_duplicate_facts(&self, a: &DuplicateArgs) -> Result<Vec<u64>> {
        const OP: &str = "linkStruckDuplicateFacts";
        let kept = bigint(OP, "keptId", *required(OP, "keptId", &a.kept_id)?)?;
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let ids = id_set(OP, &a.ids)?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut changed = Vec::new();
            for old in named_rows(&*tx, &a.source_id, &ids)? {
                if old.expired_at_us.is_none() || old.superseded_by.is_some() {
                    continue;
                }
                let mut new = old.clone();
                new.superseded_by = u64::try_from(kept).ok();
                write_fact(tx, trust, Some(&old), &new)?;
                changed.push(old.id);
            }
            Ok(changed)
        })
    }

    /// `listCommittedRestorePages(sourceIds, slugs, hash, requestIds)`: the distinct `{ source_id, slug }` of the
    /// committed `submit_job` requests in those sources and slugs whose intent's `preview_hash` is `hash` or whose
    /// request id is one of `requestIds`, by (source, slug).
    pub fn list_committed_restore_pages(&self, a: &CommittedRestoreArgs) -> Result<Vec<Value>> {
        let sources: BTreeSet<&str> = a.source_ids.iter().map(String::as_str).collect();
        let slugs: BTreeSet<&str> = a.slugs.iter().map(String::as_str).collect();
        let requests: BTreeSet<String> = a
            .request_ids
            .iter()
            .map(|r| r.to_ascii_lowercase())
            .collect();
        let read = self.read()?;
        let mut pages: BTreeSet<(String, String)> = BTreeSet::new();
        for r in all_requests(&*read)? {
            if r.state != "committed"
                || r.operation != "submit_job"
                || !sources.contains(r.source_id.as_str())
                || !slugs.contains(r.slug.as_str())
            {
                continue;
            }
            let hash = r.intent.get("preview_hash").and_then(jsonb_field_text);
            if hash.as_deref() == Some(a.hash.as_str())
                || requests.contains(&r.request_id.to_ascii_lowercase())
            {
                pages.insert((r.source_id, r.slug));
            }
        }
        Ok(pages
            .into_iter()
            .map(|(source_id, slug)| json!({ "source_id": source_id, "slug": slug }))
            .collect())
    }

    /// `listActivePositionedFactIds(ids)`: the named facts (any source) that are unexpired and hold a `row_num`, by id.
    pub fn list_active_positioned_fact_ids(&self, ids: &[f64]) -> Result<Vec<u64>> {
        let ids = id_set("listActivePositionedFactIds", ids)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(r) = read_fact(&*read, id)?
                && r.expired_at_us.is_none()
                && r.row_num.is_some()
            {
                out.push(r.id);
            }
        }
        Ok(out)
    }

    /// `readFactRestorePage(sourceId, slug)`: the live page's `{ id, compiled_truth, max_row }` (the body null for a
    /// segmented page; `max_row` the largest `row_num` of any fact the page holds), or null.
    pub fn read_fact_restore_page(&self, source_id: &str, slug: &str) -> Result<Value> {
        no_nul(
            "readFactRestorePage",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(Value::Null);
        };
        let max_row = source_rows(&*read, source_id)?
            .into_iter()
            .filter(|f| f.source_markdown_slug.as_deref() == Some(slug))
            .filter_map(|f| f.row_num)
            .max();
        Ok(
            json!({ "id": page.id, "compiled_truth": page.compiled_truth.as_deref(), "max_row": max_row }),
        )
    }

    /// `restoreExtractorFact(sourceId, id, rowNum, expiredAt)`: clears `expired_at` and sets `row_num` on the named
    /// fact of the source when it has no `row_num`, is unsuperseded and its expiry reads `expiredAt` (UTC, to the
    /// microsecond). True when it changed the row.
    pub fn restore_extractor_fact(&self, a: &ExtractorRestoreArgs) -> Result<bool> {
        const OP: &str = "restoreExtractorFact";
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let row_num = i32::try_from(bigint(OP, "rowNum", a.row_num)?).map_err(|_| {
            StoreError::invalid(format!("{OP}: rowNum is out of the integer range"))
        })?;
        let Some(id) = row_id(OP, "id", a.id)? else {
            return Ok(false);
        };
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = read_fact(&*tx, id)? else {
                return Ok(false);
            };
            if old.source_id != a.source_id
                || old.row_num.is_some()
                || old.superseded_by.is_some()
                || old.expired_at_us.map(iso).as_deref() != Some(a.expired_at.as_str())
            {
                return Ok(false);
            }
            let mut new = old.clone();
            new.expired_at_us = None;
            new.row_num = Some(row_num);
            write_fact(tx, trust, Some(&old), &new)?;
            Ok(true)
        })
    }

    /// `moveFactClaimDates(sourceId, rows)`: sets `valid_from` to UTC midnight of each row's `date` on the named
    /// unexpired, unpositioned fact of the source whose `valid_from` is still the row's. The ids it moved, by id.
    pub fn move_fact_claim_dates(&self, a: &ClaimDateArgs) -> Result<Vec<u64>> {
        const OP: &str = "moveFactClaimDates";
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let mut moves: BTreeMap<u64, Vec<(i64, i64)>> = BTreeMap::new();
        for r in &a.rows {
            let from = parse_timestamptz(&r.valid_from, "moveFactClaimDates valid_from")?;
            let to =
                parse_timestamptz(&format!("{}T00:00:00Z", r.date), "moveFactClaimDates date")?;
            if let Some(id) = row_id(OP, "id", r.id)? {
                moves.entry(id).or_default().push((from, to));
            }
        }
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut moved = Vec::new();
            for (id, pairs) in &moves {
                let Some(old) = read_fact(&*tx, *id)? else {
                    continue;
                };
                if old.source_id != a.source_id
                    || old.expired_at_us.is_some()
                    || old.row_num.is_some()
                {
                    continue;
                }
                // `UPDATE ... FROM` changes a row once, with the first joined row that matches it.
                let Some((_, to)) = pairs.iter().find(|(from, _)| *from == old.valid_from_us)
                else {
                    continue;
                };
                let mut new = old.clone();
                new.valid_from_us = *to;
                write_fact(tx, trust, Some(&old), &new)?;
                moved.push(old.id);
            }
            Ok(moved)
        })
    }

    /// `expireApprovedFacts(sourceId, ids)`: expires each named unexpired fact of the source and clears its `row_num`.
    /// The ids it expired, by id.
    pub fn expire_approved_facts(&self, a: &DuplicateArgs) -> Result<Vec<u64>> {
        const OP: &str = "expireApprovedFacts";
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let ids = id_set(OP, &a.ids)?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut changed = Vec::new();
            for old in named_rows(&*tx, &a.source_id, &ids)? {
                if old.expired_at_us.is_some() {
                    continue;
                }
                let mut new = old.clone();
                new.expired_at_us = Some(now);
                new.row_num = None;
                write_fact(tx, trust, Some(&old), &new)?;
                changed.push(old.id);
            }
            Ok(changed)
        })
    }

    /// `tightenDatabaseFactVisibility(sourceId, ids)`: sets `visibility` to `private` on each named world fact of the
    /// source that has no `row_num` and is unexpired. The ids it changed, by id.
    pub fn tighten_database_fact_visibility(&self, a: &DuplicateArgs) -> Result<Vec<u64>> {
        const OP: &str = "tightenDatabaseFactVisibility";
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let ids = id_set(OP, &a.ids)?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut changed = Vec::new();
            for old in named_rows(&*tx, &a.source_id, &ids)? {
                if old.visibility != "world" || old.row_num.is_some() || old.expired_at_us.is_some()
                {
                    continue;
                }
                let mut new = old.clone();
                new.visibility = "private".to_string();
                write_fact(tx, trust, Some(&old), &new)?;
                changed.push(old.id);
            }
            Ok(changed)
        })
    }

    /// `readFactLiveVisibility(factId)`: the fact's `visibility` and whether it is unexpired (`live`), in any source;
    /// `None` for no such fact.
    pub fn read_fact_live_visibility(&self, fact_id: f64) -> Result<Option<Value>> {
        let Some(id) = super::forget::fact_number("readFactLiveVisibility", fact_id)? else {
            return Ok(None);
        };
        Ok(read_fact(&*self.read()?, id)?
            .map(|f| json!({ "visibility": f.visibility, "live": f.expired_at_us.is_none() })))
    }

    /// `tightenFencedFactVisibility(sourceId, factId, rowNum)` (`a.ids` holds the one fact id): sets `visibility` to
    /// `private` on the named world fact of the source at that fence row when it is unexpired. The ids it changed.
    pub fn tighten_fenced_fact_visibility(
        &self,
        a: &DuplicateArgs,
        row_num: f64,
    ) -> Result<Vec<u64>> {
        const OP: &str = "tightenFencedFactVisibility";
        no_nul(OP, &[("sourceId", a.source_id.as_str())])?;
        let ids = id_set(OP, &a.ids)?;
        let row_num = bigint(OP, "rowNum", row_num)?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut changed = Vec::new();
            for old in named_rows(&*tx, &a.source_id, &ids)? {
                if old.visibility != "world"
                    || old.row_num.map(i64::from) != Some(row_num)
                    || old.expired_at_us.is_some()
                {
                    continue;
                }
                let mut new = old.clone();
                new.visibility = "private".to_string();
                write_fact(tx, trust, Some(&old), &new)?;
                changed.push(old.id);
            }
            Ok(changed)
        })
    }

    /// `detachFenceRowFacts(sourceId, slug, rowNum)`: clears `row_num` and `source_markdown_slug` on the facts of the
    /// source at that fence row of that page. The ids it changed, by id.
    pub fn detach_fence_row_facts(&self, a: &FenceRowArgs) -> Result<Vec<u64>> {
        const OP: &str = "detachFenceRowFacts";
        let slug = required(OP, "slug", &a.slug)?;
        let row_num = bigint(OP, "rowNum", *required(OP, "rowNum", &a.row_num)?)?;
        no_nul(
            OP,
            &[("sourceId", a.source_id.as_str()), ("slug", slug.as_str())],
        )?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let mut changed = Vec::new();
            for old in source_rows(&*tx, &a.source_id)? {
                if old.source_markdown_slug.as_deref() != Some(slug.as_str())
                    || old.row_num.map(i64::from) != Some(row_num)
                {
                    continue;
                }
                let mut new = old.clone();
                new.row_num = None;
                new.source_markdown_slug = None;
                write_fact(tx, trust, Some(&old), &new)?;
                changed.push(old.id);
            }
            changed.sort_unstable();
            Ok(changed)
        })
    }

    /// `hasDatabaseOnlyClaim(sourceId, entitySlug, fact)`: whether a fact of the source on that entity with no
    /// `row_num` states exactly `fact` (expired or not).
    pub fn has_database_only_claim(&self, a: &FenceRowArgs) -> Result<bool> {
        const OP: &str = "hasDatabaseOnlyClaim";
        let entity = required(OP, "entitySlug", &a.entity_slug)?;
        let fact = required(OP, "fact", &a.fact)?;
        no_nul(
            OP,
            &[
                ("sourceId", a.source_id.as_str()),
                ("entitySlug", entity.as_str()),
            ],
        )?;
        let read = self.read()?;
        Ok(entity_rows(&*read, &a.source_id, entity)?
            .iter()
            .any(|r| r.row_num.is_none() && &r.fact == fact))
    }

    /// `listPageAccessKeys({ ids, honorAliases })`: per named page, `{ id, readers, folder, readable_by, world }`: the
    /// `page_readers` column (`gbrain_access_readers`), the folder rule ids the last stamp kept (`folder_rule_ids`),
    /// `frontmatter->'readable_by'` and the snapshot filter (`privateSnapshotFilterFragment`), by id.
    pub fn list_page_access_keys(&self, a: &AccessKeyArgs) -> Result<Vec<Value>> {
        let ids = id_set("listPageAccessKeys", &a.ids)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for id in ids {
            let Some(page) = crate::pages::read_page_by_id(&*read, id)? else {
                continue;
            };
            out.push(json!({
                "id": page.id,
                "readers": super::privacy::access_readers(&page.frontmatter),
                "folder": crate::access_policy::kept_rule_ids(&*read, &page.source_id, page.id)?,
                "readable_by": page.frontmatter.get("readable_by"),
                "world": super::privacy::snapshot_fields_allow(&page.page_type, &page.frontmatter, a.honor_aliases),
            }));
        }
        Ok(out)
    }

    /// `readSourceCloneRow(sourceId)`: the source's `{ local_path, config }`, archived or not, or null.
    pub fn read_source_clone_row(&self, source_id: &str) -> Result<Value> {
        let read = self.read()?;
        Ok(match read_source(&*read, source_id)? {
            Some(s) => json!({ "local_path": s.local_path, "config": s.config }),
            None => Value::Null,
        })
    }
}
