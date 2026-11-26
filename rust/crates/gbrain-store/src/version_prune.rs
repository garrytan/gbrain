//! Version retention: the prunes PGLite's `createPageVersion` (`src/core/page-state/versions.ts`)
//! runs after it saves a snapshot, in the same transaction.
//!
//! - An inline snapshot of a large page (body over `PAGE_INLINE_MAX_BYTES`) keeps the newest
//!   `LARGE_PAGE_VERSIONS_KEPT` large inline versions of the page and deletes the rest.
//! - A segmented snapshot runs segmented retention (`pruneSegmentedVersions`): the newest
//!   `versions.segmented_max_per_page` segmented versions stay while the closed manifest bytes they
//!   pin stay within `max(versions.segmented_max_pinned_bytes, the page's body_bytes)`; when one
//!   goes, the page's segments are swept (`sweepSegments({ pageId })`).
//!
//! Every prune then marks the history it cut (`markPrunedHistory`): the retained version just
//! before each pruned one gets `successor_pruned`, and the page records `version_history_gap_at`.
//! The holding-page prune (`pruneHoldingPageVersions`, `src/core/engine-sql/version-prune.ts`) is
//! a store call of its own: the fence fact append runs it after the version its append saved on a
//! holding page (`memory/unattributed`, `memory/unattributed-private`). It keeps the newest
//! `LARGE_PAGE_VERSIONS_KEPT` versions that are not segmented, deletes at most
//! `HOLDING_PAGE_VERSIONS_PRUNED_PER_WRITE` of the oldest others, and marks the history it cut.
//!
//! No prune touches an `agent_policy` page (#10304): its saved versions are the audit trail of who
//! changed the policy. The inline large-page prune reads the snapshot's type, as PGLite reads the
//! page it saved; the segmented and holding prunes read the live page, as their SQL does
//! (`pages.type IS DISTINCT FROM 'agent_policy'`, which a missing page also fails).

use std::collections::BTreeMap;

use crate::config::read_config;
use crate::env::Env;
use crate::error::Result;
use crate::keys;
use crate::kv::{KvRead, KvWrite};
use crate::pages::{VersionRecord, read_page_by_id, versions_of, write_page};
use crate::put_json;

/// `PAGE_INLINE_MAX_BYTES` (`src/core/page-size-policy.ts`): a page whose inline body is over this
/// many bytes is large.
pub(crate) const PAGE_INLINE_MAX_BYTES: u64 = 1024 * 1024;
/// `LARGE_PAGE_VERSIONS_KEPT` (`src/core/page-body/limits.ts`).
pub(crate) const LARGE_PAGE_VERSIONS_KEPT: usize = 5;
/// `HOLDING_PAGE_VERSIONS_PRUNED_PER_WRITE` (`src/core/engine-sql/version-prune.ts`).
pub(crate) const HOLDING_PAGE_VERSIONS_PRUNED_PER_WRITE: usize = 100;
/// `AGENT_POLICY_TYPE` (`src/core/policy/slugs.ts`): the page type whose versions no prune removes.
const AGENT_POLICY_TYPE: &str = "agent_policy";
/// `DEFAULT_SEGMENTED_VERSIONS_MAX_PER_PAGE`.
const DEFAULT_SEGMENTED_MAX_PER_PAGE: i64 = 50;
/// `DEFAULT_SEGMENTED_VERSIONS_MAX_PINNED_BYTES`.
const DEFAULT_SEGMENTED_MAX_PINNED_BYTES: i64 = 64 * 1024 * 1024;

/// The inline body bytes of a version (`octet_length(compiled_truth) +
/// octet_length(COALESCE(timeline, ''))`), or none for a NULL body (a segmented snapshot).
fn inline_bytes(v: &VersionRecord) -> Option<u64> {
    if v.compiled_truth.is_null() {
        return None;
    }
    Some((v.compiled_truth.len() + v.timeline.len()) as u64)
}

/// Runs the prune PGLite runs after it saves `snapshot`, the newest version of its page.
pub(crate) fn prune_after_snapshot(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    snapshot: &VersionRecord,
) -> Result<()> {
    let page_id = snapshot.page_id;
    if snapshot.body_storage.is_some() {
        let pruned = if prunable_page(&*tx, page_id)? {
            prune_segmented(tx, page_id)?
        } else {
            Vec::new()
        };
        mark_pruned_history(tx, env, page_id, &pruned)?;
        if !pruned.is_empty() {
            let now = now(env);
            crate::page_body::sweep_segments_in(
                tx,
                now,
                crate::page_body::SEGMENT_TEXT_GC_GRACE_MS.saturating_mul(1000),
                None,
                i64::try_from(page_id).ok(),
                false,
            )?;
        }
        return Ok(());
    }
    if snapshot.page_type == AGENT_POLICY_TYPE
        || inline_bytes(snapshot).is_none_or(|bytes| bytes <= PAGE_INLINE_MAX_BYTES)
    {
        return Ok(());
    }
    let mut large: Vec<u64> = versions_of(&*tx, page_id)?
        .iter()
        .filter(|v| inline_bytes(v).is_some_and(|b| b > PAGE_INLINE_MAX_BYTES))
        .map(|v| v.id)
        .collect();
    large.sort_unstable_by(|a, b| b.cmp(a));
    let pruned: Vec<u64> = large.into_iter().skip(LARGE_PAGE_VERSIONS_KEPT).collect();
    for id in &pruned {
        tx.delete(&keys::version(page_id, *id))?;
    }
    mark_pruned_history(tx, env, page_id, &pruned)
}

/// `pruneHoldingPageVersions`: past the newest `LARGE_PAGE_VERSIONS_KEPT` versions of the page
/// that are not segmented (`body_storage IS DISTINCT FROM 'segmented'`), deletes the oldest, at most
/// `HOLDING_PAGE_VERSIONS_PRUNED_PER_WRITE` of them, marks the history it cut and answers how many
/// it deleted.
pub(crate) fn prune_holding(tx: &mut dyn KvWrite, env: &dyn Env, page_id: u64) -> Result<u64> {
    if !prunable_page(&*tx, page_id)? {
        return Ok(0);
    }
    let mut inline: Vec<u64> = versions_of(&*tx, page_id)?
        .iter()
        .filter(|v| v.body_storage.as_deref() != Some("segmented"))
        .map(|v| v.id)
        .collect();
    inline.sort_unstable_by(|a, b| b.cmp(a));
    let mut excess: Vec<u64> = inline.into_iter().skip(LARGE_PAGE_VERSIONS_KEPT).collect();
    excess.sort_unstable();
    excess.truncate(HOLDING_PAGE_VERSIONS_PRUNED_PER_WRITE);
    for id in &excess {
        tx.delete(&keys::version(page_id, *id))?;
    }
    mark_pruned_history(tx, env, page_id, &excess)?;
    Ok(excess.len() as u64)
}

/// `EXISTS (SELECT 1 FROM pages WHERE id = $1 AND type IS DISTINCT FROM 'agent_policy')`: the live
/// page exists and is not an agent policy page.
fn prunable_page(read: &dyn KvRead, page_id: u64) -> Result<bool> {
    Ok(read_page_by_id(read, page_id)?.is_some_and(|page| page.page_type != AGENT_POLICY_TYPE))
}

/// `pruneSegmentedVersions`: deletes the segmented versions past the count cap or the pinned
/// bytes cap and answers their ids. A closed manifest row counts once, at the newest version whose
/// generation it covers, so the kept versions are a prefix by id, newest first.
fn prune_segmented(tx: &mut dyn KvWrite, page_id: u64) -> Result<Vec<u64>> {
    let max_per_page = config_positive_int(
        &*tx,
        "versions.segmented_max_per_page",
        DEFAULT_SEGMENTED_MAX_PER_PAGE,
    )?;
    let max_pinned = config_positive_int(
        &*tx,
        "versions.segmented_max_pinned_bytes",
        DEFAULT_SEGMENTED_MAX_PINNED_BYTES,
    )?;
    let mut ranked: Vec<(u64, i64)> = versions_of(&*tx, page_id)?
        .iter()
        .filter(|v| v.body_storage.as_deref() == Some("segmented"))
        .map(|v| (v.id, v.body_generation.unwrap_or(0)))
        .collect();
    ranked.sort_unstable_by_key(|a| std::cmp::Reverse(a.0));
    // The bytes each rank (1-based) newly pins: every closed row, grouped by
    // (occurrence_id, gen_from, byte_len), counts at the lowest rank whose generation it covers.
    let mut first_rank: BTreeMap<(i64, i64, i64), usize> = BTreeMap::new();
    for row in crate::page_body::closed_manifest_rows(&*tx, page_id)? {
        let Some(gen_to) = row.gen_to else { continue };
        let rank = ranked
            .iter()
            .position(|(_, g)| row.gen_from <= *g && *g < gen_to)
            .map(|i| i + 1);
        if let Some(rank) = rank {
            let entry = first_rank
                .entry((row.occurrence_id, row.gen_from, row.byte_len))
                .or_insert(rank);
            *entry = (*entry).min(rank);
        }
    }
    let mut per_rank: BTreeMap<usize, i64> = BTreeMap::new();
    for ((_, _, byte_len), rank) in first_rank {
        *per_rank.entry(rank).or_insert(0) += byte_len;
    }
    let body_bytes = crate::page_body::segmented_reference(&*tx, page_id)?
        .and_then(|(_, bytes)| bytes)
        .unwrap_or(0);
    let cap = max_pinned.max(body_bytes);
    let mut pruned = Vec::new();
    let mut bytes: i64 = 0;
    for (i, (id, _)) in ranked.iter().enumerate() {
        let rank = i + 1;
        bytes = bytes.saturating_add(per_rank.get(&rank).copied().unwrap_or(0));
        if i64::try_from(rank).unwrap_or(i64::MAX) > max_per_page || bytes > cap {
            pruned.push(*id);
        }
    }
    for id in &pruned {
        tx.delete(&keys::version(page_id, *id))?;
    }
    Ok(pruned)
}

/// `markPrunedHistory`: for each pruned id, the retained version with the greatest id below it
/// gets `successor_pruned`, and the page records `version_history_gap_at`. Nothing when nothing
/// was pruned.
fn mark_pruned_history(
    tx: &mut dyn KvWrite,
    env: &dyn Env,
    page_id: u64,
    pruned: &[u64],
) -> Result<()> {
    if pruned.is_empty() {
        return Ok(());
    }
    let retained = versions_of(&*tx, page_id)?;
    let mut marked: Vec<u64> = pruned
        .iter()
        .filter_map(|d| retained.iter().filter(|k| k.id < *d).map(|k| k.id).max())
        .collect();
    marked.sort_unstable();
    marked.dedup();
    for mut row in retained.into_iter().filter(|r| marked.contains(&r.id)) {
        row.successor_pruned = true;
        put_json(tx, &keys::version(page_id, row.id), &row)?;
    }
    record_history_gap(tx, env, page_id)
}

/// `UPDATE pages SET version_history_gap_at = now() WHERE id = $1`, with the transaction's clock.
pub(crate) fn record_history_gap(tx: &mut dyn KvWrite, env: &dyn Env, page_id: u64) -> Result<()> {
    let Some(mut page) = read_page_by_id(&*tx, page_id)? else {
        return Ok(());
    };
    page.version_history_gap_at_us = Some(now(env));
    write_page(tx, &page)
}

/// PGLite's `now()`: the open write transaction's clock, else the store clock.
fn now(env: &dyn Env) -> i64 {
    crate::env::transaction_clock::transaction_now().unwrap_or_else(|| env.now_micros())
}

/// `positiveInt` (`src/core/page-body/limits.ts`): a configured safe integer over zero, else the
/// fallback. A blank, missing or malformed value takes the fallback.
fn config_positive_int(read: &dyn KvRead, key: &str, fallback: i64) -> Result<i64> {
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let Some(raw) = read_config(read, key)? else {
        return Ok(fallback);
    };
    let text = raw.trim();
    if text.is_empty() {
        return Ok(fallback);
    }
    Ok(match text.parse::<f64>() {
        Ok(n) if n.is_finite() && n.fract() == 0.0 && n > 0.0 && n <= MAX_SAFE => n as i64,
        _ => fallback,
    })
}
