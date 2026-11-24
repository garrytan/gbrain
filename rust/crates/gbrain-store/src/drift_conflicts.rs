//! The drift-conflict audit reads (`readDriftConflictBounds`, `listDriftConflictGroups`,
//! `readDriftConflictDetails`; `src/core/engine-sql/repair-plan-scans.ts`,
//! `persistence/drift-conflicts.ts` `auditDriftConflicts`; rust/docs/store/repair-bookkeeping.md,
//! "Drift conflicts").
//!
//! The window is the requests of the source's current incarnation whose sequence is above
//! `floor` through `through`. A conflict receipt is a request of the source in that window in
//! state `conflict` with `source_changed`. The groups sort their slugs, and each group's
//! producers, in byte order; the SQL sorts them in the database's default collation, which is
//! the same order for the lower-case ASCII slugs a source holds.

use crate::Store;
use crate::cli_reads::pg_text::fm_text;
use crate::env::iso;
use crate::error::{INVALID_ARGUMENT, Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::journal::RequestRecord;
use crate::pages::read_page;
use crate::persistence::{all_requests, extra_bool};
use crate::sources::read_source;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// `listDriftConflictGroups(sourceId, query)`. `slug_prefixes` holds normalized prefixes, at
/// least one; `exclude_private` is the caller's remote read floor as a page policy.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DriftConflictQuery {
    pub incarnation: String,
    pub floor: String,
    pub through: String,
    #[serde(default)]
    pub slug_prefixes: Option<Vec<String>>,
    pub require_live_page: bool,
    #[serde(default)]
    pub exclude_private: Option<PrivacyPolicy>,
    pub after: String,
    pub limit: u64,
    pub drift_message: String,
}

/// `to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`: whole seconds.
fn utc_seconds(us: i64) -> String {
    format!("{}Z", &iso(us)[..19])
}

fn sequence_bound(text: &str, what: &str) -> Result<i128> {
    text.parse::<i128>().map_err(|_| {
        StoreError::new(
            INVALID_ARGUMENT,
            format!("listDriftConflictGroups {what} is not an integer: {text}"),
        )
    })
}

/// The slug fence: a prefix ending `/` matches the slugs under it; any other matches the slug
/// itself and the slugs under it. Slugs compare lower-cased, as the SQL's `lower(r.slug)`.
fn fenced(slug: &str, prefixes: &[String]) -> bool {
    let lower = slug.to_lowercase();
    prefixes.iter().any(|base| {
        if base.ends_with('/') {
            lower.starts_with(base.as_str())
        } else {
            lower == *base
                || lower
                    .strip_prefix(base.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
        }
    })
}

/// `operation || COALESCE(':' || (intent->>'kind'), '')`.
fn producer(r: &RequestRecord) -> String {
    match r.intent.as_object().and_then(|o| fm_text(o, "kind")) {
        Some(kind) => format!("{}:{kind}", r.operation),
        None => r.operation.clone(),
    }
}

impl Store {
    /// `readDriftConflictBounds(sourceId)`: `{ incarnation, top, bottom }`, the newest and oldest
    /// request sequence of the source's current incarnation (null with none), or null for an
    /// unknown source.
    pub fn read_drift_conflict_bounds(&self, source_id: &str) -> Result<Value> {
        let read = self.read()?;
        let Some(source) = read_source(&*read, source_id)? else {
            return Ok(Value::Null);
        };
        let sequences: Vec<u64> = all_requests(&*read)?
            .iter()
            .filter(|r| r.source_incarnation == source.incarnation)
            .map(|r| r.sequence)
            .collect();
        Ok(json!({
            "incarnation": source.incarnation,
            "top": sequences.iter().max().map(u64::to_string),
            "bottom": sequences.iter().min().map(u64::to_string),
        }))
    }

    /// `listDriftConflictGroups(sourceId, query)`: `{ slugs, receipts, rows }`, the window's
    /// distinct slugs and receipts, and the groups of the slugs after `after`, at most `limit`.
    pub fn list_drift_conflict_groups(
        &self,
        source_id: &str,
        q: &DriftConflictQuery,
    ) -> Result<Value> {
        let floor = sequence_bound(&q.floor, "floor")?;
        let through = sequence_bound(&q.through, "through")?;
        let read = self.read()?;
        let mut requests = all_requests(&*read)?;
        requests.sort_by_key(|r| r.sequence);
        let mut live: BTreeMap<String, bool> = BTreeMap::new();
        let mut groups: BTreeMap<String, Vec<&RequestRecord>> = BTreeMap::new();
        let mut receipts = 0u64;
        for r in &requests {
            let sequence = i128::from(r.sequence);
            if r.source_id != source_id
                || r.source_incarnation != q.incarnation
                || sequence <= floor
                || sequence > through
                || r.state != "conflict"
                || r.error_code.as_deref() != Some("source_changed")
                || q.slug_prefixes
                    .as_deref()
                    .is_some_and(|p| !fenced(&r.slug, p))
            {
                continue;
            }
            if q.require_live_page || q.exclude_private.is_some() {
                let shown = match live.get(&r.slug) {
                    Some(shown) => *shown,
                    None => {
                        let shown = match read_page(&*read, source_id, &r.slug)? {
                            Some(page) if page.deleted_at_us.is_none() => {
                                match &q.exclude_private {
                                    Some(policy) => !page_hidden(&*read, &page, policy)?,
                                    None => true,
                                }
                            }
                            _ => false,
                        };
                        live.insert(r.slug.clone(), shown);
                        shown
                    }
                };
                if !shown {
                    continue;
                }
            }
            receipts += 1;
            groups.entry(r.slug.clone()).or_default().push(r);
        }
        let slugs = groups.len();
        let rows: Vec<Value> = groups
            .iter()
            .filter(|(slug, _)| slug.as_str() > q.after.as_str())
            .take(usize::try_from(q.limit).unwrap_or(usize::MAX))
            .map(|(slug, group)| {
                let producers: BTreeSet<String> = group.iter().map(|r| producer(r)).collect();
                let created = group.iter().map(|r| r.created_at_us);
                json!({
                    "slug": slug,
                    "receipts": group.len(),
                    "drift_receipts": group
                        .iter()
                        .filter(|r| r.error_message.as_deref() == Some(q.drift_message.as_str()))
                        .count(),
                    "first_seen": created.clone().min().map(utc_seconds),
                    "last_seen": created.max().map(utc_seconds),
                    "producers": producers,
                    "last_request_id": group.last().map(|r| r.request_id.clone()),
                })
            })
            .collect();
        Ok(json!({ "slugs": slugs, "receipts": receipts, "rows": rows }))
    }

    /// `readDriftConflictDetails(sourceId, slugs, paths)`: `{ committed, recorded }`, the newest
    /// committed receipt of each slug that keeps its intent and is not compacted, and with
    /// `paths` each live page's `source_path` and `source_uri`. Both are in slug order.
    pub fn read_drift_conflict_details(
        &self,
        source_id: &str,
        slugs: &[String],
        paths: bool,
    ) -> Result<Value> {
        let asked: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut newest: BTreeMap<&str, RequestRecord> = BTreeMap::new();
        for r in all_requests(&*read)? {
            if r.source_id != source_id
                || r.state != "committed"
                || r.intent.is_null()
                || extra_bool(&r, "compacted")
            {
                continue;
            }
            let Some(slug) = asked.get(r.slug.as_str()).copied() else {
                continue;
            };
            if newest.get(slug).is_none_or(|n| n.sequence < r.sequence) {
                newest.insert(slug, r);
            }
        }
        let committed: Vec<Value> = newest
            .into_iter()
            .map(|(slug, r)| {
                json!({
                    "slug": slug,
                    "request_id": r.request_id,
                    "completed_at": r.completed_at_us.map(utc_seconds),
                })
            })
            .collect();
        let mut recorded = Vec::new();
        if paths {
            for slug in &asked {
                if let Some(page) = read_page(&*read, source_id, slug)?
                    && page.deleted_at_us.is_none()
                {
                    recorded.push(json!({
                        "slug": page.slug,
                        "source_path": page.source_path,
                        "source_uri": page.source_uri,
                    }));
                }
            }
        }
        Ok(json!({ "committed": committed, "recorded": recorded }))
    }
}
