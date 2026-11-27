//! The `fact_relink_attempts` table (src/core/engine-sql/fact-relink-attempts.ts): one row per
//! `(source_id, fact_id)` holding a fact's latest relink outcome or memo, and the tried / paid memos
//! the doctor's unlinked-fact reads (`facts/doctor.rs`) take from it.
//!
//! Members: upsertFactRelinkAttempt, listFactRelinkOutcomes, deleteFactRelinkMemos and
//! countFactRelinkOutcomes.
//!
//! Keys (after `keys::FACT`; a text part ends with a NUL byte, and no text column may hold one):
//! - `F 0x0A source_id fact_id -> AttemptRecord`: one row, the `(source_id, fact_id)` primary key.
//!   `fact_id` is 8 big-endian bytes with the sign bit flipped, so ids sort as numbers.
//! - `F 0x0B source_id tier target_slug fact_id -> ()`: the rows of one tier naming one page
//!   (`tier` and `target_slug` not NULL), for the paid memo and `deleteFactRelinkMemos`.
//!
//! The table has no foreign key (facts/relink-schema.ts): a row names a source and a fact that need
//! not exist, and deleting either leaves it in place. So no write checks the source and no delete
//! cascades here.

use super::{DAY_US, FactRecord, bigint, text_key, time_bytes};
use crate::Store;
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::read_page;
use crate::{get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// The byte after `keys::FACT` that marks an attempt row.
const ROW: u8 = 0x0A;
/// The byte after `keys::FACT` that marks the `(source_id, tier, target_slug)` index.
const BY_TARGET: u8 = 0x0B;

/// `CONVERSATION_UNRESOLVED` of facts/conversation-relink.ts: the outcome of a conversation row
/// free relink could not link.
const CONVERSATION_UNRESOLVED: &str = "conversation_unresolved";
/// `PAID_REEXTRACT` of facts/conversation-memo.ts: the tier of a paid re-extraction memo.
const PAID_REEXTRACT: &str = "paid_reextract";
/// The relink outcome that says a fact has no subject (`countUnlinkedFactStats` and
/// `countFactRelinkOutcomes`).
const NO_SUBJECT: &str = "no_subject";
/// The relink outcome of a linked fact (`countFactRelinkOutcomes`).
const LINKED: &str = "linked";

/// One stored attempt row.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct AttemptRecord {
    pub fact_id: i64,
    pub outcome: String,
    pub reason: Option<String>,
    pub tier: Option<String>,
    pub model: Option<String>,
    pub target_slug: Option<String>,
    pub run_id: Option<String>,
    pub attempted_at_us: i64,
}

/// `upsertFactRelinkAttempt(sourceId, attempt, opts)`: the attempt.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptInput {
    pub fact_id: f64,
    pub outcome: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub target_slug: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
}

/// `upsertFactRelinkAttempt(sourceId, attempt, opts)`: the options.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct UpsertOptions {
    pub keep_model_and_run: bool,
}

fn row_prefix(source_id: &str) -> Vec<u8> {
    text_key(ROW, &[source_id])
}

fn row_key(source_id: &str, fact_id: i64) -> Vec<u8> {
    let mut key = row_prefix(source_id);
    key.extend_from_slice(&time_bytes(fact_id));
    key
}

fn target_prefix(source_id: &str, tier: &str, target_slug: &str) -> Vec<u8> {
    text_key(BY_TARGET, &[source_id, tier, target_slug])
}

fn target_key(source_id: &str, r: &AttemptRecord) -> Option<Vec<u8>> {
    let (Some(tier), Some(slug)) = (&r.tier, &r.target_slug) else {
        return None;
    };
    let mut key = target_prefix(source_id, tier, slug);
    key.extend_from_slice(&time_bytes(r.fact_id));
    Some(key)
}

fn read_attempt(read: &dyn KvRead, source_id: &str, fact_id: i64) -> Result<Option<AttemptRecord>> {
    get_json(read, &row_key(source_id, fact_id))
}

/// Stores the row and its index entry, dropping the entry of the row it replaces.
fn write_attempt(tx: &mut dyn KvWrite, source_id: &str, r: &AttemptRecord) -> Result<()> {
    if let Some(old) = read_attempt(&*tx, source_id, r.fact_id)?
        && let Some(key) = target_key(source_id, &old)
    {
        tx.delete(&key)?;
    }
    put_json(tx, &row_key(source_id, r.fact_id), r)?;
    if let Some(key) = target_key(source_id, r) {
        tx.put(&key, &[])?;
    }
    Ok(())
}

/// The shadow seed (`seed.rs`): stores `r`, an attempt copied from another engine with its own
/// `attempted_at`, with its memo index entry, where `upsert_fact_relink_attempt` stores one.
/// `false` when the `(source_id, fact_id)` row is already stored.
pub(crate) fn seed_attempt(
    tx: &mut dyn KvWrite,
    source_id: &str,
    r: &AttemptRecord,
) -> Result<bool> {
    if read_attempt(&*tx, source_id, r.fact_id)?.is_some() {
        return Ok(false);
    }
    write_attempt(tx, source_id, r)?;
    Ok(true)
}

/// Every attempt row of a source, by fact id.
fn source_attempts(read: &dyn KvRead, source_id: &str) -> Result<Vec<AttemptRecord>> {
    let mut out = Vec::new();
    let mut failure = None;
    scan_prefix(read, &row_prefix(source_id), false, &mut |_, v| {
        match serde_json::from_slice::<AttemptRecord>(v) {
            Ok(r) => out.push(r),
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(out), Err)
}

/// The fact ids of a source's rows of one tier naming one page.
fn target_ids(read: &dyn KvRead, source_id: &str, tier: &str, slug: &str) -> Result<Vec<i64>> {
    let prefix = target_prefix(source_id, tier, slug);
    let mut ids = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, _| {
        if let Some(tail) = k
            .get(prefix.len()..)
            .and_then(|t| <[u8; 8]>::try_from(t).ok())
        {
            ids.push((u64::from_be_bytes(tail) ^ (1 << 63)) as i64);
        }
        true
    })?;
    Ok(ids)
}

/// The tried and paid memos the doctor's unlinked-fact reads take from the attempts, read through
/// one snapshot. `rearmed` is `REARMED` of facts/conversation-memo.ts: the reasons a newer page
/// re-arms.
pub(super) struct Memos<'a> {
    read: &'a dyn KvRead,
    rearmed: BTreeSet<&'a str>,
    newest_page: HashMap<String, Option<i64>>,
    paid_pages: HashMap<(String, String), bool>,
}

impl<'a> Memos<'a> {
    pub(super) fn new(read: &'a dyn KvRead, rearmed: &'a [String]) -> Self {
        Memos {
            read,
            rearmed: rearmed.iter().map(String::as_str).collect(),
            newest_page: HashMap::new(),
            paid_pages: HashMap::new(),
        }
    }

    fn attempt(&self, row: &FactRecord) -> Result<Option<AttemptRecord>> {
        let Ok(id) = i64::try_from(row.id) else {
            return Ok(None);
        };
        read_attempt(self.read, &row.source_id, id)
    }

    /// `created_at` of the source's newest live page: `MAX(created_at)` over the pages with
    /// `deleted_at IS NULL`.
    fn newest_live_page(&mut self, source_id: &str) -> Result<Option<i64>> {
        if let Some(at) = self.newest_page.get(source_id) {
            return Ok(*at);
        }
        let mut newest: Option<i64> = None;
        let mut failure = None;
        let prefix = keys::text(keys::PAGE, &[source_id, ""]);
        scan_prefix(self.read, &prefix, false, &mut |_, v| {
            match serde_json::from_slice::<crate::pages::PageRecord>(v) {
                Ok(p) if p.deleted_at_us.is_none() => {
                    newest = Some(newest.map_or(p.created_at_us, |n| n.max(p.created_at_us)));
                }
                Ok(_) => {}
                Err(e) => failure = Some(StoreError::from(e)),
            }
            failure.is_none()
        })?;
        if let Some(e) = failure {
            return Err(e);
        }
        self.newest_page.insert(source_id.to_string(), newest);
        Ok(newest)
    }

    /// `conversationTriedSql`: the row's attempt has outcome `conversation_unresolved`, and it is
    /// not the case that its reason is a re-armed one and a live page of the source was created
    /// at or after the attempt (`>=`: a page in the attempt's clock tick re-arms it, as on the SQL
    /// engines). A NULL reason makes `reason IN (...)` NULL, so a newer page leaves the
    /// `NOT (...)` NULL (not tried) and no newer page leaves it true (tried).
    pub(super) fn tried(&mut self, row: &FactRecord) -> Result<bool> {
        let Some(a) = self.attempt(row)? else {
            return Ok(false);
        };
        if a.outcome != CONVERSATION_UNRESOLVED {
            return Ok(false);
        }
        let newer = self
            .newest_live_page(&row.source_id)?
            .is_some_and(|at| at >= a.attempted_at_us);
        let rearmed = a.reason.as_deref().map(|r| self.rearmed.contains(r));
        Ok(!(newer && rearmed != Some(false)))
    }

    /// `conversationPaidSql`: some attempt of the source with tier `paid_reextract` names the
    /// row's page (`source_markdown_slug`), the page is live, and the attempt's reason is the
    /// page's `content_hash` (`''` when NULL). A NULL reason matches nothing.
    pub(super) fn paid(&mut self, row: &FactRecord) -> Result<bool> {
        let Some(slug) = row.source_markdown_slug.as_deref() else {
            return Ok(false);
        };
        let cache = (row.source_id.clone(), slug.to_string());
        if let Some(hit) = self.paid_pages.get(&cache) {
            return Ok(*hit);
        }
        let hit = match read_page(self.read, &row.source_id, slug)? {
            Some(page) if page.deleted_at_us.is_none() => {
                let hash = page.content_hash.as_deref().unwrap_or("");
                let mut hit = false;
                for id in target_ids(self.read, &row.source_id, PAID_REEXTRACT, slug)? {
                    if read_attempt(self.read, &row.source_id, id)?
                        .is_some_and(|a| a.reason.as_deref() == Some(hash))
                    {
                        hit = true;
                        break;
                    }
                }
                hit
            }
            _ => false,
        };
        self.paid_pages.insert(cache, hit);
        Ok(hit)
    }

    /// The `judged` test of `countUnlinkedFactStats`: the row's attempt has outcome `no_subject`.
    pub(super) fn no_subject(&self, row: &FactRecord) -> Result<bool> {
        Ok(self.attempt(row)?.is_some_and(|a| a.outcome == NO_SUBJECT))
    }
}

impl Store {
    /// `upsertFactRelinkAttempt(sourceId, attempt, opts)`: `INSERT ... VALUES (..., now()) ON
    /// CONFLICT (source_id, fact_id) DO UPDATE` every column but the key from the new row, or, with
    /// `keepModelAndRun`, every column but `model` and `run_id`, which keep the stored values.
    pub fn upsert_fact_relink_attempt(
        &self,
        source_id: &str,
        attempt: &AttemptInput,
        opts: &UpsertOptions,
    ) -> Result<()> {
        const OP: &str = "upsertFactRelinkAttempt";
        let texts: Vec<(&str, &str)> = [
            ("sourceId", Some(source_id)),
            ("outcome", Some(attempt.outcome.as_str())),
            ("reason", attempt.reason.as_deref()),
            ("tier", attempt.tier.as_deref()),
            ("model", attempt.model.as_deref()),
            ("targetSlug", attempt.target_slug.as_deref()),
            ("runId", attempt.run_id.as_deref()),
        ]
        .into_iter()
        .filter_map(|(n, t)| t.map(|t| (n, t)))
        .collect();
        no_nul(OP, &texts)?;
        let fact_id = bigint(OP, "factId", attempt.fact_id)?;
        let now = self.env.now_micros();
        self.write(|tx| {
            let mut row = AttemptRecord {
                fact_id,
                outcome: attempt.outcome.clone(),
                reason: attempt.reason.clone(),
                tier: attempt.tier.clone(),
                model: attempt.model.clone(),
                target_slug: attempt.target_slug.clone(),
                run_id: attempt.run_id.clone(),
                attempted_at_us: now,
            };
            if opts.keep_model_and_run
                && let Some(old) = read_attempt(&*tx, source_id, fact_id)?
            {
                row.model = old.model;
                row.run_id = old.run_id;
            }
            write_attempt(tx, source_id, &row)
        })
    }

    /// `listFactRelinkOutcomes(sourceId, factIds, outcomes)`: `SELECT fact_id, outcome WHERE
    /// source_id = $1 AND fact_id = ANY($2) AND outcome = ANY($3) ORDER BY fact_id`. Both arrays
    /// are sets.
    pub fn list_fact_relink_outcomes(
        &self,
        source_id: &str,
        fact_ids: &[f64],
        outcomes: &[String],
    ) -> Result<Vec<Value>> {
        const OP: &str = "listFactRelinkOutcomes";
        let texts: Vec<(&str, &str)> = std::iter::once(("sourceId", source_id))
            .chain(outcomes.iter().map(|o| ("outcomes", o.as_str())))
            .collect();
        no_nul(OP, &texts)?;
        let ids: BTreeSet<i64> = fact_ids
            .iter()
            .map(|id| bigint(OP, "factIds", *id))
            .collect::<Result<_>>()?;
        let wanted: BTreeSet<&str> = outcomes.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut rows = Vec::new();
        for id in ids {
            if let Some(a) = read_attempt(&*read, source_id, id)?
                && wanted.contains(a.outcome.as_str())
            {
                rows.push(json!({ "fact_id": id, "outcome": a.outcome }));
            }
        }
        Ok(rows)
    }

    /// `deleteFactRelinkMemos(sourceId, tier, targetSlug)`: `DELETE WHERE source_id = $1 AND tier
    /// = $2 AND target_slug = $3`.
    pub fn delete_fact_relink_memos(
        &self,
        source_id: &str,
        tier: &str,
        target_slug: &str,
    ) -> Result<()> {
        const OP: &str = "deleteFactRelinkMemos";
        no_nul(
            OP,
            &[
                ("sourceId", source_id),
                ("tier", tier),
                ("targetSlug", target_slug),
            ],
        )?;
        self.write(|tx| {
            for id in target_ids(&*tx, source_id, tier, target_slug)? {
                tx.delete(&row_key(source_id, id))?;
                let mut key = target_prefix(source_id, tier, target_slug);
                key.extend_from_slice(&time_bytes(id));
                tx.delete(&key)?;
            }
            Ok(())
        })
    }

    /// `countFactRelinkOutcomes(sourceIds)`: over the rows of `sourceIds` (a set) with outcome
    /// `no_subject`, or `linked` with `attempted_at >= now() - 7 days`, `COUNT(*)` by outcome and
    /// tier. The statement has no `ORDER BY`; rows come by outcome, then tier with NULL last.
    pub fn count_fact_relink_outcomes(&self, source_ids: &[String]) -> Result<Vec<Value>> {
        const OP: &str = "countFactRelinkOutcomes";
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let texts: Vec<(&str, &str)> = sources.iter().map(|s| ("sourceIds", *s)).collect();
        no_nul(OP, &texts)?;
        let since = self.env.now_micros() - 7 * DAY_US;
        let read = self.read()?;
        // `None` sorts first in a BTreeMap; the key flips it to NULL last.
        let mut groups: BTreeMap<(String, bool, Option<String>), u64> = BTreeMap::new();
        for source in sources {
            for a in source_attempts(&*read, source)? {
                let counted =
                    a.outcome == NO_SUBJECT || (a.outcome == LINKED && a.attempted_at_us >= since);
                if counted {
                    *groups
                        .entry((a.outcome, a.tier.is_none(), a.tier))
                        .or_default() += 1;
                }
            }
        }
        Ok(groups
            .into_iter()
            .map(|((outcome, _, tier), n)| json!({ "outcome": outcome, "tier": tier, "n": n }))
            .collect())
    }
}

/// The attempt rows of `source_id` a fact purge's inventory probe searches (crate::facts::purge_probe).
pub(crate) fn purge_probe_rows(
    read: &dyn KvRead,
    source_id: &str,
) -> Result<Vec<crate::facts::purge_probe::ProbeRow>> {
    use crate::facts::purge_probe::{ProbeCell, ProbeRow};
    Ok(source_attempts(read, source_id)?
        .into_iter()
        .map(|r| ProbeRow {
            source_id: Some(source_id.to_string()),
            cells: vec![("reason", ProbeCell::opt_text(r.reason.as_deref()))],
        })
        .collect())
}

/// The shadow follow (`seed/follow.rs`): removes the attempt row `(source_id, fact_id)` with its
/// memo index entry. `false` when there is none.
pub(crate) fn remove_attempt(tx: &mut dyn KvWrite, source_id: &str, fact_id: i64) -> Result<bool> {
    let Some(old) = read_attempt(&*tx, source_id, fact_id)? else {
        return Ok(false);
    };
    if let Some(key) = target_key(source_id, &old) {
        tx.delete(&key)?;
    }
    tx.delete(&row_key(source_id, fact_id))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::store;

    fn input(fact_id: f64, outcome: &str, tier: Option<&str>, slug: Option<&str>) -> AttemptInput {
        AttemptInput {
            fact_id,
            outcome: outcome.into(),
            reason: Some("r".into()),
            tier: tier.map(Into::into),
            model: Some("m".into()),
            target_slug: slug.map(Into::into),
            run_id: Some("run".into()),
        }
    }

    #[test]
    fn ids_sort_as_numbers_and_the_index_follows_the_row() {
        let s = store();
        let keep = UpsertOptions::default();
        for id in [300.0, -1.0, 2.0] {
            s.upsert_fact_relink_attempt(
                "default",
                &input(id, "linked", Some("t"), Some("p")),
                &keep,
            )
            .unwrap();
        }
        let read = s.read().unwrap();
        let ids: Vec<i64> = source_attempts(&*read, "default")
            .unwrap()
            .iter()
            .map(|a| a.fact_id)
            .collect();
        assert_eq!(ids, [-1, 2, 300]);
        assert_eq!(
            target_ids(&*read, "default", "t", "p").unwrap(),
            [-1, 2, 300]
        );
        drop(read);
        // Moving a row to another page moves its index entry.
        s.upsert_fact_relink_attempt(
            "default",
            &input(2.0, "linked", Some("t"), Some("q")),
            &keep,
        )
        .unwrap();
        s.upsert_fact_relink_attempt("default", &input(300.0, "linked", None, Some("p")), &keep)
            .unwrap();
        let read = s.read().unwrap();
        assert_eq!(target_ids(&*read, "default", "t", "p").unwrap(), [-1]);
        assert_eq!(target_ids(&*read, "default", "t", "q").unwrap(), [2]);
    }

    #[test]
    fn keep_model_and_run_keeps_the_stored_values_only_on_a_conflict() {
        let s = store();
        let keep = UpsertOptions {
            keep_model_and_run: true,
        };
        let mut a = input(1.0, "paid_reextract", Some("paid_reextract"), Some("p"));
        a.model = Some("new".into());
        s.upsert_fact_relink_attempt("default", &a, &keep).unwrap();
        let read = s.read().unwrap();
        assert_eq!(
            read_attempt(&*read, "default", 1)
                .unwrap()
                .unwrap()
                .model
                .as_deref(),
            Some("new")
        );
        drop(read);
        a.model = None;
        a.run_id = None;
        s.upsert_fact_relink_attempt("default", &a, &keep).unwrap();
        let read = s.read().unwrap();
        let row = read_attempt(&*read, "default", 1).unwrap().unwrap();
        assert_eq!(
            (row.model.as_deref(), row.run_id.as_deref()),
            (Some("new"), Some("run"))
        );
    }

    #[test]
    fn delete_memos_drops_only_the_named_tier_and_page() {
        let s = store();
        let o = UpsertOptions::default();
        s.upsert_fact_relink_attempt("default", &input(1.0, "x", Some("t"), Some("p")), &o)
            .unwrap();
        s.upsert_fact_relink_attempt("default", &input(2.0, "x", Some("t"), Some("q")), &o)
            .unwrap();
        s.upsert_fact_relink_attempt("other", &input(1.0, "x", Some("t"), Some("p")), &o)
            .unwrap();
        s.delete_fact_relink_memos("default", "t", "p").unwrap();
        let read = s.read().unwrap();
        assert!(read_attempt(&*read, "default", 1).unwrap().is_none());
        assert!(read_attempt(&*read, "default", 2).unwrap().is_some());
        assert!(read_attempt(&*read, "other", 1).unwrap().is_some());
    }

    #[test]
    fn nul_text_and_fractional_ids_refuse() {
        let s = store();
        let o = UpsertOptions::default();
        assert!(
            s.upsert_fact_relink_attempt("de\0f", &input(1.0, "x", None, None), &o)
                .is_err()
        );
        assert!(
            s.upsert_fact_relink_attempt("default", &input(1.5, "x", None, None), &o)
                .is_err()
        );
        assert!(
            s.list_fact_relink_outcomes("default", &[1.0], &["a\0".into()])
                .is_err()
        );
        assert!(s.delete_fact_relink_memos("default", "t\0", "p").is_err());
        assert!(s.count_fact_relink_outcomes(&["a\0".into()]).is_err());
    }
}
