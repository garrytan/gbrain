//! Emotional weight and salience of pages: the `pages.emotional_weight` and
//! `pages.salience_touched_at` columns of the PGLite engine, and the reads that rank pages by them.
//!
//! Members: batchLoadEmotionalInputs, setEmotionalWeightBatch, getRecentSalience,
//! getSalienceScores.
//!
//! Keys (every record starts with `keys::SALIENCE`, `s`):
//! - `s <page id u64 BE>` -> `SalienceRecord` (JSON): the page's weight and the time it last
//!   changed. A page without a record has weight 0 and no touch time (the column defaults).
//!
//! The record is keyed by page id, so a rename keeps it and `putPage` never resets it, as an
//! `UPDATE` of the content columns leaves `emotional_weight` alone in Postgres. A hard page delete
//! drops it (`remove_page_rows`); a source delete removes its pages first, so no source hook is
//! needed.
//!
//! Numbers: `emotional_weight` is a `real`. It reads back as the shortest text of the f32
//! (`takes::real_out`), while arithmetic on it (`* 5`, `AVG` of take weights) widens the f32 to a
//! double first, as Postgres does.

use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, Result, StoreError};
use crate::facts::{OwnerOnlyCache, PrivacyPolicy};
use crate::kv::{KvRead, KvWrite};
use crate::links::no_nul;
use crate::page_columns::PageColumns;
use crate::pages::{PageRecord, all_pages, read_page};
use crate::sources::read_source;
use crate::takes::{TakeRecord, page_takes, real, real_out};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};

/// What is stored for a page whose weight was ever set.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct SalienceRecord {
    emotional_weight: f32,
    touched_at_us: i64,
}

fn key(page_id: u64) -> Vec<u8> {
    keys::id_key(keys::SALIENCE, &[page_id])
}

fn record(read: &dyn KvRead, page_id: u64) -> Result<Option<SalienceRecord>> {
    get_json(read, &key(page_id))
}

/// Deletes this family's record of a page that is deleted for good (`cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    tx.delete(&key(page.id))
}

/// Adds `emotional_weight` and `salience_touched_at` to a page that has a record. A page without
/// one reads its `PAGE_ROW_DEFAULTS` values (weight 0, no touch time), as the column defaults do.
pub(crate) fn page_columns(
    read: &dyn KvRead,
    page: &PageRecord,
    columns: &mut PageColumns,
) -> Result<()> {
    if let Some(rec) = record(read, page.id)? {
        columns.set("emotional_weight", json!(real_out(rec.emotional_weight)));
        columns.set("salience_touched_at", json!(iso(rec.touched_at_us)));
    }
    Ok(())
}

/// The `emotional_weight` a page reads, as `page_columns` reports it: the stored weight, else the
/// column default 0. The `'salience'` order of `listEnrichCandidates` sorts on it.
pub(crate) fn emotional_weight(read: &dyn KvRead, page_id: u64) -> Result<f64> {
    Ok(real_out(weight_of(record(read, page_id)?)))
}

/// One row of `setEmotionalWeightBatch`. A null weight is a null `real`.
#[derive(Debug, Clone, Deserialize)]
pub struct EmotionalWeightRow {
    pub slug: String,
    pub source_id: String,
    pub weight: Option<f64>,
}

/// One recency branch: pages whose slug starts with `prefix` use `halflife_days` and
/// `coefficient`. The shell sends the branches in `buildRecencyComponentSql` order (longest
/// prefix first); the first match wins.
#[derive(Debug, Clone, Deserialize)]
pub struct RecencyBranch {
    pub prefix: String,
    pub halflife_days: f64,
    pub coefficient: f64,
}

/// The recency term of the salience score (`buildRecencyComponentSql`).
#[derive(Debug, Clone, Deserialize)]
pub struct Recency {
    /// Use `COALESCE(effective_date, updated_at)` as the page date; else `updated_at`.
    #[serde(default)]
    pub effective_date: bool,
    #[serde(default)]
    pub branches: Vec<RecencyBranch>,
    pub fallback_halflife_days: f64,
    pub fallback_coefficient: f64,
}

impl Recency {
    fn term(&self, slug: &str, days_old: f64) -> f64 {
        let (h, c) = self
            .branches
            .iter()
            .find(|b| slug.as_bytes().starts_with(b.prefix.as_bytes()))
            .map_or(
                (self.fallback_halflife_days, self.fallback_coefficient),
                |b| (b.halflife_days, b.coefficient),
            );
        if h == 0.0 || c == 0.0 {
            0.0
        } else {
            c * h / (h + days_old)
        }
    }
}

/// `getRecentSalience` after the shell resolved its defaults.
#[derive(Debug, Clone, Deserialize)]
pub struct RecentSalienceOptions {
    /// Pages touched before this time (epoch ms) are left out. It is a float because
    /// N-API hands every JS number above 2^31 to serde as a double.
    pub boundary_ms: f64,
    pub limit: usize,
    /// A literal slug prefix (the SQL's escaped `LIKE 'prefix%'`).
    #[serde(default)]
    pub slug_prefix: Option<String>,
    /// Leave out `briefings/` pages.
    #[serde(default)]
    pub exclude_briefings: bool,
    /// The source scope; null reads every source.
    #[serde(default)]
    pub source_ids: Option<Vec<Option<String>>>,
    /// `takesHoldersAllowList`; null is unrestricted. A restricted read counts only these
    /// holders' takes and ignores the emotional weight and its touch time.
    #[serde(default)]
    pub holders: Option<Vec<Option<String>>>,
    pub recency: Recency,
}

/// A page reference of `getSalienceScores`.
#[derive(Debug, Clone, Deserialize)]
pub struct PageRef {
    pub slug: String,
    pub source_id: String,
}

/// `getSalienceScores` after the shell resolved its read policy.
#[derive(Debug, Clone, Deserialize)]
pub struct SalienceScoresInput {
    pub refs: Vec<PageRef>,
    /// The source scope; null reads every source.
    #[serde(default)]
    pub source_ids: Option<Vec<Option<String>>>,
    /// `takesHoldersAllowList`; null is unrestricted.
    #[serde(default)]
    pub holders: Option<Vec<Option<String>>>,
    /// Apply the live clauses (not soft-deleted, not quarantined, source not archived): PGLite
    /// applies them whenever a read policy is passed.
    #[serde(default)]
    pub live: bool,
    /// `excludePrivate`: the page policy `pageReadFilter` adds, as `facts/privacy.rs`
    /// `page_hidden` reads it; null hides nothing.
    #[serde(default)]
    pub exclude_private: Option<PrivacyPolicy>,
}

fn listed(list: &Option<Vec<Option<String>>>, value: &str) -> bool {
    list.as_ref()
        .is_none_or(|l| l.iter().any(|v| v.as_deref() == Some(value)))
}

/// The weight a page reads: its record's, else the column default 0.
fn weight_of(rec: Option<SalienceRecord>) -> f32 {
    rec.map_or(0.0, |r| r.emotional_weight)
}

/// `IS DISTINCT FROM` on two non-null `real`s: NaN equals NaN, and -0 equals 0.
fn same_real(a: f32, b: f32) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

/// `pageReadFilter(..., live = true)`'s live clauses.
struct Live<'a> {
    read: &'a dyn KvRead,
    archived: HashMap<String, bool>,
}

impl Live<'_> {
    fn passes(&mut self, page: &PageRecord) -> Result<bool> {
        if page.deleted_at_us.is_some() || page.frontmatter.contains_key("quarantine") {
            return Ok(false);
        }
        let open = match self.archived.get(&page.source_id) {
            Some(open) => *open,
            None => {
                let open = read_source(self.read, &page.source_id)?.is_some_and(|s| !s.archived);
                self.archived.insert(page.source_id.clone(), open);
                open
            }
        };
        Ok(open)
    }
}

/// The page's active takes the read counts.
fn counted_takes(
    read: &dyn KvRead,
    page_id: u64,
    holders: &Option<Vec<Option<String>>>,
) -> Result<Vec<TakeRecord>> {
    Ok(page_takes(read, page_id)?
        .into_iter()
        .filter(|t| t.active && listed(holders, &t.holder))
        .collect())
}

impl Store {
    /// `batchLoadEmotionalInputs(slugs?)`: every page (or every page whose slug is listed, in any
    /// source, soft-deleted ones too) with its distinct tags in byte order and its active takes.
    pub fn batch_load_emotional_inputs(&self, slugs: Option<&[String]>) -> Result<Vec<Value>> {
        let wanted: Option<HashSet<&str>> = slugs.map(|s| s.iter().map(String::as_str).collect());
        let read = self.read()?;
        let mut out = Vec::new();
        for page in all_pages(&*read)? {
            if wanted
                .as_ref()
                .is_some_and(|w| !w.contains(page.slug.as_str()))
            {
                continue;
            }
            let tags: BTreeSet<&str> = page.tags.iter().map(String::as_str).collect();
            let takes: Vec<Value> = page_takes(&*read, page.id)?
                .into_iter()
                .filter(|t| t.active)
                .map(|t| {
                    json!({
                        "holder": t.holder, "weight": real_out(t.weight), "kind": t.kind,
                        "active": t.active,
                    })
                })
                .collect();
            out.push(json!({
                "slug": page.slug, "source_id": page.source_id, "tags": tags, "takes": takes,
            }));
        }
        Ok(out)
    }

    /// `setEmotionalWeightBatch(rows)`: sets each listed page's weight where it differs from the
    /// stored one and stamps its touch time; returns the number of pages changed. A row naming no
    /// page changes nothing. A page listed twice is updated once, by its first row (Postgres
    /// updates a target row once per statement). `updated_at` does not move.
    pub fn set_emotional_weight_batch(&self, rows: &[EmotionalWeightRow]) -> Result<u64> {
        const OP: &str = "setEmotionalWeightBatch";
        for row in rows {
            no_nul(OP, &[("slug", &row.slug), ("source_id", &row.source_id)])?;
        }
        let weights = rows
            .iter()
            .map(|r| r.weight.map(|w| real(w, OP)).transpose())
            .collect::<Result<Vec<_>>>()?;
        if rows.is_empty() {
            return Ok(0);
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut seen = HashSet::new();
            let mut changed = 0;
            for (row, weight) in rows.iter().zip(weights) {
                let Some(page) = read_page(tx, &row.source_id, &row.slug)? else {
                    continue;
                };
                if !seen.insert(page.id) {
                    continue;
                }
                let Some(weight) = weight else {
                    return Err(StoreError::new(
                        CONSTRAINT_VIOLATION,
                        "null value in column \"emotional_weight\" of relation \"pages\" violates not-null constraint",
                    ));
                };
                if same_real(weight_of(record(tx, page.id)?), weight) {
                    continue;
                }
                let rec = SalienceRecord {
                    emotional_weight: weight,
                    touched_at_us: now,
                };
                put_json(tx, &key(page.id), &rec)?;
                changed += 1;
            }
            Ok(changed)
        })
    }

    /// `getRecentSalience(opts)`: live pages touched since the boundary, by
    /// `emotional_weight * 5 + ln(1 + active takes) + recency`, best first. Equal scores fall
    /// back to `(source_id, slug)` in byte order (the SQL leaves ties unordered).
    pub fn get_recent_salience(&self, opts: &RecentSalienceOptions) -> Result<Vec<Value>> {
        let restricted = opts.holders.is_some();
        // The boundary is whole milliseconds, so the product is exact.
        let boundary_us = (opts.boundary_ms * 1000.0) as i64;
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut live = Live {
            read: &*read,
            archived: HashMap::new(),
        };
        let mut rows: Vec<(f64, PageRecord, Value)> = Vec::new();
        for page in all_pages(&*read)? {
            if opts
                .slug_prefix
                .as_ref()
                .is_some_and(|p| !page.slug.as_bytes().starts_with(p.as_bytes()))
                || (opts.exclude_briefings && page.slug.starts_with("briefings/"))
                || !listed(&opts.source_ids, &page.source_id)
                || !live.passes(&page)?
            {
                continue;
            }
            let rec = if restricted {
                None
            } else {
                record(&*read, page.id)?
            };
            let touched = rec.map_or(page.updated_at_us, |r| {
                page.updated_at_us.max(r.touched_at_us)
            });
            if touched < boundary_us {
                continue;
            }
            let takes = counted_takes(&*read, page.id, &opts.holders)?;
            let count = takes.len();
            let avg = if count == 0 {
                0.0
            } else {
                takes.iter().map(|t| f64::from(t.weight)).sum::<f64>() / count as f64
            };
            let weight = weight_of(rec);
            let date = if opts.recency.effective_date {
                page.effective_date_us.unwrap_or(page.updated_at_us)
            } else {
                page.updated_at_us
            };
            let days_old = (now - date) as f64 / 1_000_000.0 / 86_400.0;
            let score = f64::from(weight) * 5.0
                + (1.0 + count as f64).ln()
                + opts.recency.term(&page.slug, days_old);
            let value = json!({
                "slug": page.slug, "source_id": page.source_id, "title": page.title,
                "type": page.page_type, "updated_at": iso(page.updated_at_us),
                "emotional_weight": real_out(weight), "take_count": count,
                "take_avg_weight": avg, "score": score,
            });
            rows.push((score, page, value));
        }
        rows.sort_by(|a, b| {
            b.0.total_cmp(&a.0)
                .then_with(|| a.1.source_id.as_bytes().cmp(b.1.source_id.as_bytes()))
                .then_with(|| a.1.slug.as_bytes().cmp(b.1.slug.as_bytes()))
        });
        rows.truncate(opts.limit);
        Ok(rows.into_iter().map(|(_, _, v)| v).collect())
    }

    /// `getSalienceScores(refs, opts)`: `{slug, source_id, score}` for each listed page the read
    /// can see, `score = emotional_weight * 5 + ln(1 + active takes)`. A restricted read counts
    /// only the allowed holders' takes and drops the weight term. Pages come in ref order, once
    /// each.
    pub fn get_salience_scores(&self, input: &SalienceScoresInput) -> Result<Vec<Value>> {
        let restricted = input.holders.is_some();
        let read = self.read()?;
        let mut live = Live {
            read: &*read,
            archived: HashMap::new(),
        };
        let mut owner_only = OwnerOnlyCache::default();
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for r in &input.refs {
            let Some(page) = read_page(&*read, &r.source_id, &r.slug)? else {
                continue;
            };
            if !seen.insert(page.id)
                || !listed(&input.source_ids, &page.source_id)
                || (input.live && !live.passes(&page)?)
            {
                continue;
            }
            if let Some(policy) = &input.exclude_private
                && owner_only.page_hidden(&*read, &page, policy)?
            {
                continue;
            }
            let count = counted_takes(&*read, page.id, &input.holders)?.len();
            let emotional = if restricted {
                0.0
            } else {
                f64::from(weight_of(record(&*read, page.id)?)) * 5.0
            };
            let score = emotional + (1.0 + count as f64).ln();
            out.push(json!({"slug": page.slug, "source_id": page.source_id, "score": score}));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    //! The crate-private hooks are tested here; the members through the public API in
    //! `tests/salience.rs`.
    use super::*;
    use crate::pages::{PageInput, PutPageOptions};
    use crate::test_support::store;

    fn put(store: &Store, slug: &str) -> u64 {
        let input: PageInput =
            serde_json::from_value(json!({"type": "note", "title": slug, "compiled_truth": "x"}))
                .unwrap();
        let opts: PutPageOptions = serde_json::from_value(json!({})).unwrap();
        store.put_page(slug, &input, &opts).unwrap()["id"]
            .as_u64()
            .unwrap()
    }

    fn set(store: &Store, slug: &str, weight: f64) -> u64 {
        let row: EmotionalWeightRow =
            serde_json::from_value(json!({"slug": slug, "source_id": "default", "weight": weight}))
                .unwrap();
        store.set_emotional_weight_batch(&[row]).unwrap()
    }

    fn page_json(store: &Store, slug: &str) -> Value {
        let read = store.read().unwrap();
        let rec = read_page(&*read, "default", slug).unwrap().unwrap();
        rec.to_page_with_columns(&*read).unwrap()
    }

    #[test]
    fn page_columns_add_the_weight_and_touch_time_only_once_set() {
        let store = store();
        put(&store, "notes/a");
        let before = page_json(&store, "notes/a");
        assert!(before.get("emotional_weight").is_none());
        assert!(before.get("salience_touched_at").is_none());
        assert_eq!(set(&store, "notes/a", 0.7), 1);
        let after = page_json(&store, "notes/a");
        assert_eq!(after["emotional_weight"], json!(0.7));
        assert!(after["salience_touched_at"].is_string());
        assert_eq!(after["updated_at"], before["updated_at"]);
    }

    #[test]
    fn remove_page_rows_drops_the_record() {
        let store = store();
        let id = put(&store, "notes/a");
        set(&store, "notes/a", 0.3);
        let page = {
            let read = store.read().unwrap();
            read_page(&*read, "default", "notes/a").unwrap().unwrap()
        };
        store.write(|tx| remove_page_rows(tx, &page)).unwrap();
        let read = store.read().unwrap();
        assert!(record(&*read, id).unwrap().is_none());
    }

    #[test]
    fn recency_takes_the_first_matching_branch_and_zero_disables_it() {
        let recency: Recency = serde_json::from_value(json!({
            "branches": [
                {"prefix": "daily/x/", "halflife_days": 0, "coefficient": 1},
                {"prefix": "daily/", "halflife_days": 2, "coefficient": 0.5},
            ],
            "fallback_halflife_days": 1, "fallback_coefficient": 1,
        }))
        .unwrap();
        assert_eq!(recency.term("daily/x/1", 3.0), 0.0);
        assert!((recency.term("daily/1", 2.0) - 0.25).abs() < 1e-12);
        assert!((recency.term("notes/1", 1.0) - 0.5).abs() < 1e-12);
    }
}
