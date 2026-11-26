//! Managed-worktree admission (`src/core/engine-sql/persistence-admission.ts`): the reads and the one write that
//! `persistence/journal.ts` admission and `refresh-retry-hint.ts` run against a managed worktree.
//!
//! K1, the refresh keyspace: `d 0x10 <refresh id>` holds one `persistence_worktree_refreshes` row
//! (`RefreshRecord`), JSON. `0x08` is the notifier's on the sync branches, so this family starts at `0x10`.
//! `refresh_store.rs` writes the rows (`gbrain sources refresh`); a brain that never refreshed has an empty keyspace,
//! and every member answers as Postgres answers with no refresh row.
//!
//! `readWorktreeAdmission` reads the worktree row and the source binding through `worktree_rows.rs`.
//!
//! What this engine does not keep, and how each member answers for it:
//! - `persistence_consumers` stays empty (`renewConsumerRow` writes nothing here, `housekeeping.rs`), so
//!   `hasDeferralRoom` stays true until a consumer row exists.
//! - `sources.last_commit` is stored (`sources.rs`): `completeSyncedRefresh` completes a refresh when every
//!   member source that exists is at its target head, and an import hold lands when the source's last commit differs
//!   from the commit the write was held at.

use super::worktree_rows::{read_source_binding, read_worktree_row};
use super::{all_requests, uuid_param};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::sources::read_source;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

/// The byte after `keys::PERSISTENCE` of a refresh row (K1).
const REFRESH: u8 = 0x10;
/// `ACTIVE_REFRESH_STATES` (worktree-refresh-schema.ts), the partial unique index's states.
pub(super) const ACTIVE_REFRESH_STATES: [&str; 5] = [
    "draining",
    "fenced",
    "merged",
    "syncing",
    "recovery_required",
];
/// How many completed refreshes of a worktree the typical duration is taken over (`REFRESH_HISTORY`).
const REFRESH_HISTORY: usize = 10;

/// One `persistence_worktree_refreshes` row. The columns no member here reads (principal, owner epoch,
/// topology generation, old head, upstream ref, preserved paths) are kept in `extra`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RefreshRecord {
    pub(crate) id: String,
    pub(crate) worktree_id: String,
    pub(crate) source_ids: Vec<String>,
    pub(crate) state: String,
    pub(crate) target_head: String,
    #[serde(default)]
    pub(crate) outcome: Map<String, Value>,
    pub(crate) created_at_us: i64,
    pub(crate) updated_at_us: i64,
    #[serde(default)]
    pub(crate) completed_at_us: Option<i64>,
    #[serde(default)]
    pub(crate) released_at_us: Option<i64>,
    #[serde(default, flatten)]
    pub(crate) extra: Map<String, Value>,
}

fn refresh_key(id: &str) -> Vec<u8> {
    let mut key = vec![keys::PERSISTENCE, REFRESH];
    key.extend_from_slice(id.as_bytes());
    key
}

pub(super) fn read_refresh(read: &dyn KvRead, id: &str) -> Result<Option<RefreshRecord>> {
    get_json(read, &refresh_key(id))
}

pub(crate) fn put_refresh(tx: &mut dyn KvWrite, record: &RefreshRecord) -> Result<()> {
    put_json(tx, &refresh_key(&record.id), record)
}

/// Every refresh row, in key order.
pub(super) fn all_refreshes(read: &dyn KvRead) -> Result<Vec<RefreshRecord>> {
    let mut out = Vec::new();
    let mut bad = false;
    scan_prefix(read, &[keys::PERSISTENCE, REFRESH], false, &mut |_, v| {
        match serde_json::from_slice::<RefreshRecord>(v) {
            Ok(r) => out.push(r),
            Err(_) => bad = true,
        }
        !bad
    })?;
    if bad {
        return Err(StoreError::new(
            crate::error::STORE_CORRUPT,
            "a persistence_worktree_refreshes record is not valid JSON",
        ));
    }
    Ok(out)
}

/// `WorktreeAdmissionKey`: the source binding a write was resolved against. The generation is the
/// text of the caller's value, or `None` when it has none.
#[derive(Debug, Clone)]
pub struct WorktreeAdmissionKey {
    pub worktree_id: String,
    pub source_id: String,
    pub source_incarnation: String,
    pub topology_generation: Option<String>,
}

/// `topology_generation=$4` with the parameter typed integer: the text Postgres accepts, or the
/// refusal of its integer input.
fn generation_param(text: &str) -> Result<i64> {
    let digits = text.trim();
    let body = digits.strip_prefix(['+', '-']).unwrap_or(digits);
    if body.is_empty() || !body.bytes().all(|c| c.is_ascii_digit()) {
        return Err(StoreError::invalid(format!(
            "invalid input syntax for type integer: \"{text}\""
        )));
    }
    digits.parse::<i32>().map(i64::from).map_err(|_| {
        StoreError::invalid(format!("value \"{text}\" is out of range for type integer"))
    })
}

/// `readWorktreeAdmission`: `{ worktree, refresh, bound }` (`WORKTREE_SHARE_SQL`,
/// `WORKTREE_FENCE_SQL`). `worktree` is the row's state and owner epoch (text), null when no row
/// has the id; `refresh` is the worktree's active refresh, the one row of the partial unique index;
/// `bound` is whether the source's binding names this incarnation, worktree and generation. The row
/// locks are no-ops here (persistence.rs, decision C).
pub(crate) fn read_worktree_admission_in(
    read: &dyn KvRead,
    key: &WorktreeAdmissionKey,
) -> Result<Value> {
    let worktree_id = uuid_param(&key.worktree_id, "worktreeId")?;
    let incarnation = uuid_param(&key.source_incarnation, "sourceIncarnation")?;
    let generation = key
        .topology_generation
        .as_deref()
        .map(generation_param)
        .transpose()?;
    let worktree = read_worktree_row(read, &worktree_id)?;
    let refresh = all_refreshes(read)?.into_iter().find(|r| {
        r.worktree_id.eq_ignore_ascii_case(&worktree_id)
            && ACTIVE_REFRESH_STATES.contains(&r.state.as_str())
    });
    let bound = match (read_source_binding(read, &key.source_id)?, generation) {
        (Some(b), Some(generation)) => {
            b.source_incarnation.eq_ignore_ascii_case(&incarnation)
                && b.worktree_id.eq_ignore_ascii_case(&worktree_id)
                && b.topology_generation == generation
        }
        _ => false,
    };
    Ok(json!({
        "worktree": worktree.map(|w| json!({ "state": w.state, "owner_epoch": w.owner_epoch.to_string() })),
        "refresh": refresh.map(|r| json!({ "id": r.id, "state": r.state, "source_ids": r.source_ids })),
        "bound": bound,
    }))
}

/// `completeSyncedRefresh`: a `syncing` refresh none of whose sources has a `last_commit` other than its target
/// head becomes `completed`; a member source that does not exist passes.
pub(crate) fn complete_synced_refresh_in(
    tx: &mut dyn KvWrite,
    now_us: i64,
    refresh_id: &str,
) -> Result<bool> {
    let id = uuid_param(refresh_id, "refreshId")?;
    let Some(mut refresh) = read_refresh(&*tx, &id)? else {
        return Ok(false);
    };
    if refresh.state != "syncing" {
        return Ok(false);
    }
    // `NOT EXISTS (SELECT 1 FROM sources s WHERE s.id=ANY(f.source_ids) AND s.last_commit IS DISTINCT FROM f.target_head)`.
    for source_id in &refresh.source_ids {
        if read_source(&*tx, source_id)?
            .is_some_and(|s| s.last_commit.as_deref() != Some(refresh.target_head.as_str()))
        {
            return Ok(false);
        }
    }
    refresh.state = "completed".into();
    refresh.completed_at_us = Some(now_us);
    // `gbrain_release_refresh_barrier`: the first move into a terminal state releases the barrier.
    refresh.released_at_us.get_or_insert(now_us);
    refresh.updated_at_us = now_us;
    put_json(tx, &refresh_key(&id), &refresh)?;
    Ok(true)
}

/// `hasDeferralRoom`: no `persistence_consumers` row exists here, so no live consumer lacks the capability.
pub(crate) fn has_deferral_room_in(worktree_id: &str, live_ms: i64) -> Result<bool> {
    uuid_param(worktree_id, "worktreeId")?;
    if live_ms < i64::from(i32::MIN) || live_ms > i64::from(i32::MAX) {
        return Err(StoreError::invalid(
            "liveMs is out of range for type integer",
        ));
    }
    Ok(true)
}

/// `readRefreshTiming`: `{ elapsed_ms, typical_ms }` or `None` when the refresh does not exist. `typical_ms` is the
/// median (`percentile_cont(0.5)`, rounded as `::bigint` rounds) of the worktree's last completed refreshes that kept
/// no refusal, null with none.
pub(crate) fn read_refresh_timing_in(
    read: &dyn KvRead,
    now_us: i64,
    refresh_id: &str,
) -> Result<Option<Value>> {
    let id = uuid_param(refresh_id, "refreshId")?;
    let Some(refresh) = read_refresh(read, &id)? else {
        return Ok(None);
    };
    let elapsed_ms = round_half_away((now_us - refresh.created_at_us) as f64 / 1000.0);
    let mut done: Vec<(i64, f64)> = all_refreshes(read)?
        .into_iter()
        .filter(|p| {
            p.worktree_id == refresh.worktree_id
                && p.state == "completed"
                && !p.outcome.contains_key("refusal")
        })
        .filter_map(|p| {
            p.completed_at_us
                .map(|c| (c, (c - p.created_at_us) as f64 / 1000.0))
        })
        .collect();
    done.sort_by_key(|a| std::cmp::Reverse(a.0));
    done.truncate(REFRESH_HISTORY);
    let mut ms: Vec<f64> = done.into_iter().map(|(_, ms)| ms).collect();
    ms.sort_by(|a, b| a.total_cmp(b));
    let typical_ms = median(&ms).map(round_half_away);
    Ok(Some(
        json!({ "elapsed_ms": elapsed_ms, "typical_ms": typical_ms }),
    ))
}

/// `percentile_cont(0.5)`: the middle value, or the mean of the two middle values.
fn median(sorted: &[f64]) -> Option<f64> {
    let n = sorted.len();
    if n == 0 {
        return None;
    }
    Some(if n % 2 == 1 {
        sorted[n / 2]
    } else {
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    })
}

/// Postgres rounds a numeric or double to bigint half away from zero.
fn round_half_away(v: f64) -> i64 {
    v.round() as i64
}

/// A text column of a request row kept in `extra`, or `None` when it is null.
fn request_text(r: &crate::journal::RequestRecord, column: &str) -> Option<String> {
    r.extra
        .get(column)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Whether refresh `id` has a row: the `persistence_requests.deferred_refresh_id` foreign key.
pub(crate) fn refresh_exists(read: &dyn KvRead, id: &str) -> Result<bool> {
    Ok(read_refresh(read, id)?.is_some())
}

/// Whether refresh `id` has a row with no `released_at` (`LOCK_OVERDUE_HOLD_SQL.refresh`).
pub(crate) fn refresh_unreleased(read: &dyn KvRead, id: &str) -> Result<bool> {
    Ok(read_refresh(read, id)?.is_some_and(|f| f.released_at_us.is_none()))
}

/// `RELEASED_DEFERRED(r)` (worktree-refresh-schema.ts): `r` is `deferred`, holds a refresh or an import, and
/// every hold it has is released. `refresh` is the row `r.deferred_refresh_id` names, when it has one. The
/// import hold reads `COALESCE(last_commit,'')<>deferred_import_from` of the stored source.
pub(crate) fn released_deferred(
    read: &dyn KvRead,
    r: &crate::journal::RequestRecord,
    refresh: Option<&RefreshRecord>,
) -> Result<bool> {
    if r.state != "deferred" {
        return Ok(false);
    }
    let has_refresh_id = r
        .extra
        .get("deferred_refresh_id")
        .is_some_and(|v| !v.is_null());
    let import_from = request_text(r, "deferred_import_from");
    if !has_refresh_id && import_from.is_none() {
        return Ok(false);
    }
    if has_refresh_id && !refresh.is_some_and(|f| f.released_at_us.is_some()) {
        return Ok(false);
    }
    Ok(match &import_from {
        None => true,
        Some(from) => read_source(read, &r.source_id)?
            .is_some_and(|s| s.last_commit.as_deref().unwrap_or("") != from.as_str()),
    })
}

/// `RELEASED_DEFERRED(r)` with the refresh row read by id.
pub(crate) fn released_deferred_in(
    read: &dyn KvRead,
    r: &crate::journal::RequestRecord,
) -> Result<bool> {
    let refresh = match request_text(r, "deferred_refresh_id") {
        Some(id) => read_refresh(read, &id)?,
        None => None,
    };
    released_deferred(read, r, refresh.as_ref())
}

/// `countHeldBehindImport`: the `deferred` requests on `source_id` (of one principal, or all) that are not released
/// and wait on its managed sync: held for its import, or behind an unreleased refresh it is a member of.
pub(crate) fn count_held_behind_import_in(
    read: &dyn KvRead,
    source_id: &str,
    principal: Option<(&str, &str)>,
) -> Result<Value> {
    let refreshes: std::collections::HashMap<String, RefreshRecord> = all_refreshes(read)?
        .into_iter()
        .map(|r| (r.id.clone(), r))
        .collect();
    let (mut count, mut bytes) = (0u64, 0i64);
    for r in all_requests(read)? {
        if r.state != "deferred" {
            continue;
        }
        if let Some((kind, id)) = principal
            && (r.principal_kind != kind || r.principal_id != id)
        {
            continue;
        }
        let refresh = request_text(&r, "deferred_refresh_id").and_then(|id| refreshes.get(&id));
        if released_deferred(read, &r, refresh)? {
            continue;
        }
        let import_from = request_text(&r, "deferred_import_from");
        let held_for_import = import_from.is_some() && r.source_id == source_id;
        let behind_refresh = refresh.is_some_and(|f| {
            f.released_at_us.is_none() && f.source_ids.iter().any(|s| s == source_id)
        });
        if held_for_import || behind_refresh {
            count += 1;
            bytes += r
                .extra
                .get("intent_bytes")
                .and_then(Value::as_i64)
                .unwrap_or(0);
        }
    }
    Ok(json!({ "count": count, "bytes": bytes }))
}

impl Store {
    /// `readWorktreeAdmission(key, { lockRefresh })`: `{ worktree, refresh, bound }`.
    pub fn read_worktree_admission(&self, key: &WorktreeAdmissionKey) -> Result<Value> {
        read_worktree_admission_in(&*self.read()?, key)
    }

    /// `completeSyncedRefresh(refreshId)`: true when a `syncing` refresh was completed.
    pub fn complete_synced_refresh(&self, refresh_id: &str) -> Result<bool> {
        let now = self.env.now_micros();
        self.write(|tx| complete_synced_refresh_in(tx, now, refresh_id))
    }

    /// `hasDeferralRoom(worktreeId, capability, liveMs)`: true, since no consumer row exists here.
    pub fn has_deferral_room(&self, worktree_id: &str, live_ms: i64) -> Result<bool> {
        has_deferral_room_in(worktree_id, live_ms)
    }

    /// `readRefreshTiming(refreshId)`: `{ elapsed_ms, typical_ms }` or `None`.
    pub fn read_refresh_timing(&self, refresh_id: &str) -> Result<Option<Value>> {
        read_refresh_timing_in(&*self.read()?, self.env.now_micros(), refresh_id)
    }

    /// `countHeldBehindImport(sourceId, principal)`: `{ count, bytes }`.
    pub fn count_held_behind_import(
        &self,
        source_id: &str,
        principal: Option<(&str, &str)>,
    ) -> Result<Value> {
        count_held_behind_import_in(&*self.read()?, source_id, principal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::RequestRecord;
    use crate::sources::SourceInput;
    use crate::test_support::store;

    const WT: &str = "d0000000-0000-4000-8000-0000000000d1";
    const OTHER_WT: &str = "d0000000-0000-4000-8000-0000000000d2";
    const INC: &str = "e0000000-0000-4000-8000-0000000000e1";
    const F1: &str = "f0000000-0000-4000-8000-0000000000f1";
    const F2: &str = "f0000000-0000-4000-8000-0000000000f2";

    fn key(worktree: &str, generation: Option<&str>) -> WorktreeAdmissionKey {
        WorktreeAdmissionKey {
            worktree_id: worktree.into(),
            source_id: "default".into(),
            source_incarnation: INC.into(),
            topology_generation: generation.map(str::to_owned),
        }
    }

    fn refresh(
        id: &str,
        worktree: &str,
        state: &str,
        sources: &[&str],
        created_us: i64,
    ) -> RefreshRecord {
        RefreshRecord {
            id: id.into(),
            worktree_id: worktree.into(),
            source_ids: sources.iter().map(|s| s.to_string()).collect(),
            state: state.into(),
            target_head: "abc".into(),
            outcome: Map::new(),
            created_at_us: created_us,
            updated_at_us: created_us,
            completed_at_us: None,
            released_at_us: None,
            extra: Map::new(),
        }
    }

    fn put(s: &Store, r: &RefreshRecord) {
        s.write(|tx| put_refresh(tx, r)).unwrap();
    }

    fn source(s: &Store, id: &str) {
        s.upsert_source(&SourceInput {
            id: id.into(),
            name: None,
            local_path: None,
            last_sync_at: None,
            config: None,
        })
        .unwrap();
    }

    fn deferred(s: &Store, n: u8, source: &str, extra: Value) {
        let mut row: RequestRecord = serde_json::from_value(json!({
            "id": format!("a0000000-0000-4000-8000-0000000000{n:02x}"),
            "principal_kind": "local_cli", "principal_id": "p1", "request_id": format!("b0000000-0000-4000-8000-0000000000{n:02x}"),
            "operation": "put_page", "source_id": source, "source_incarnation": INC, "slug": "a", "digest": "d",
            "intent": {}, "authority": {}, "sequence": n, "state": "deferred", "created_at_us": 0, "updated_at_us": 0,
        }))
        .unwrap();
        if let Value::Object(m) = extra {
            row.extra.extend(m);
        }
        s.write(|tx| crate::journal::write_request(tx, &row))
            .unwrap();
    }

    #[test]
    fn an_empty_keyspace_reads_no_worktree_no_refresh_and_no_binding() {
        let s = store();
        assert_eq!(
            s.read_worktree_admission(&key(WT, Some("1"))).unwrap(),
            json!({ "worktree": null, "refresh": null, "bound": false })
        );
        assert!(s.read_worktree_admission(&key("nope", Some("1"))).is_err());
        assert!(!s.complete_synced_refresh(F1).unwrap());
        assert!(s.has_deferral_room(WT, 30_000).unwrap());
        assert_eq!(s.read_refresh_timing(F1).unwrap(), None);
        assert_eq!(
            s.count_held_behind_import("default", None).unwrap(),
            json!({ "count": 0, "bytes": 0 })
        );
    }

    #[test]
    fn admission_reads_the_worktree_row_and_whether_the_source_is_bound_to_it() {
        use crate::persistence::worktree_rows::rows::{put_source_binding, put_worktree};
        let s = store();
        s.write(|tx| {
            put_worktree(tx, WT, None, "draining")?;
            put_source_binding(tx, "default", INC, WT, 2)
        })
        .unwrap();
        let read = |generation: Option<&str>| s.read_worktree_admission(&key(WT, generation));
        assert_eq!(
            read(Some("2")).unwrap(),
            json!({ "worktree": { "state": "draining", "owner_epoch": "3" }, "refresh": null, "bound": true })
        );
        assert_eq!(
            read(Some(" +2 ")).unwrap()["bound"],
            json!(true),
            "the integer cast trims and takes a sign"
        );
        assert_eq!(
            read(Some("1")).unwrap()["bound"],
            json!(false),
            "another generation"
        );
        assert_eq!(
            read(None).unwrap()["bound"],
            json!(false),
            "no generation matches no row"
        );
        let other = s
            .read_worktree_admission(&key(OTHER_WT, Some("2")))
            .unwrap();
        assert_eq!(
            other,
            json!({ "worktree": null, "refresh": null, "bound": false })
        );
        let mut other_inc = key(WT, Some("2"));
        other_inc.source_incarnation = "e0000000-0000-4000-8000-0000000000e2".into();
        assert_eq!(
            s.read_worktree_admission(&other_inc).unwrap()["bound"],
            json!(false)
        );
        assert_eq!(
            read(Some("x")).unwrap_err().message,
            "invalid input syntax for type integer: \"x\""
        );
        assert_eq!(
            read(Some("2147483648")).unwrap_err().message,
            "value \"2147483648\" is out of range for type integer"
        );
    }

    #[test]
    fn admission_reads_only_the_worktrees_active_refresh() {
        let s = store();
        put(&s, &refresh(F1, WT, "completed", &["default"], 0));
        put(&s, &refresh(F2, OTHER_WT, "fenced", &["other"], 0));
        assert_eq!(
            s.read_worktree_admission(&key(WT, Some("1"))).unwrap()["refresh"],
            Value::Null
        );
        let active = "f0000000-0000-4000-8000-0000000000f3";
        put(&s, &refresh(active, WT, "syncing", &["default"], 0));
        assert_eq!(
            s.read_worktree_admission(&key(WT, Some("1"))).unwrap()["refresh"],
            json!({ "id": active, "state": "syncing", "source_ids": ["default"] })
        );
    }

    #[test]
    fn a_syncing_refresh_completes_only_when_no_member_source_exists() {
        let s = store();
        source(&s, "kept");
        put(&s, &refresh(F1, WT, "syncing", &["kept"], 0));
        put(&s, &refresh(F2, WT, "syncing", &["gone"], 0));
        assert!(
            !s.complete_synced_refresh(F1).unwrap(),
            "a stored source reads last_commit null, not the target"
        );
        assert!(s.complete_synced_refresh(F2).unwrap());
        assert!(
            !s.complete_synced_refresh(F2).unwrap(),
            "only a syncing refresh completes"
        );
        let done = read_refresh(&*s.read().unwrap(), F2).unwrap().unwrap();
        assert_eq!(done.state, "completed");
        assert!(done.completed_at_us.is_some());
    }

    #[test]
    fn timing_is_the_running_time_and_the_median_of_the_last_clean_completions() {
        let s = store();
        let now = s.env.now_micros();
        put(
            &s,
            &refresh(F1, WT, "fenced", &["default"], now - 4_000_000),
        );
        let t = s.read_refresh_timing(F1).unwrap().unwrap();
        assert!(t["elapsed_ms"].as_i64().unwrap() >= 4_000);
        assert_eq!(t["typical_ms"], Value::Null);
        for (i, secs) in [10i64, 20, 30, 40].iter().enumerate() {
            let mut done = refresh(
                &format!("f0000000-0000-4000-8000-0000000001{i:02x}"),
                WT,
                "completed",
                &["default"],
                0,
            );
            done.completed_at_us = Some(secs * 1_000_000);
            put(&s, &done);
        }
        let mut refused = refresh(
            "f0000000-0000-4000-8000-0000000002ff",
            WT,
            "completed",
            &["default"],
            0,
        );
        refused.completed_at_us = Some(900_000_000);
        refused.outcome.insert("refusal".into(), json!({}));
        put(&s, &refused);
        assert_eq!(
            s.read_refresh_timing(F1).unwrap().unwrap()["typical_ms"],
            json!(25_000)
        );
    }

    #[test]
    fn held_writes_are_the_unreleased_deferred_rows_on_the_source() {
        let s = store();
        put(&s, &refresh(F1, WT, "syncing", &["fresh", "b"], 0));
        let mut released = refresh(F2, WT, "completed", &["fresh"], 0);
        released.released_at_us = Some(1);
        put(&s, &released);
        deferred(
            &s,
            1,
            "fresh",
            json!({ "deferred_import_from": "c1", "intent_bytes": 5 }),
        );
        deferred(
            &s,
            2,
            "b",
            json!({ "deferred_refresh_id": F1, "intent_bytes": 7 }),
        );
        deferred(
            &s,
            3,
            "fresh",
            json!({ "deferred_refresh_id": F2, "intent_bytes": 11 }),
        );
        deferred(
            &s,
            4,
            "other",
            json!({ "deferred_import_from": "c1", "intent_bytes": 13 }),
        );
        // A fresh brain stores only `default`. Held for its import (no stored source, so not released) and behind the unreleased refresh F1.
        assert_eq!(
            s.count_held_behind_import("fresh", None).unwrap(),
            json!({ "count": 2, "bytes": 12 })
        );
        assert_eq!(
            s.count_held_behind_import("fresh", Some(("local_cli", "p2")))
                .unwrap(),
            json!({ "count": 0, "bytes": 0 })
        );
        // Once the source exists its import reads as landed (last_commit null differs from the held commit).
        source(&s, "fresh");
        assert_eq!(
            s.count_held_behind_import("fresh", Some(("local_cli", "p1")))
                .unwrap(),
            json!({ "count": 1, "bytes": 7 })
        );
    }

    fn deferred_insert(s: &Store, request: &str, refresh: Option<&str>) -> Result<Value> {
        let inc = s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
        let input: crate::persistence::WriteRequestInsert = serde_json::from_value(json!({
            "principalKind": "local_cli", "principalId": "p1", "requestId": request, "operation": "put_page",
            "sourceId": "default", "sourceIncarnation": inc, "slug": "notes/a", "digest": "d", "intent": {},
            "authority": {}, "intentBytes": 1, "terminalReservation": 4096, "targetKind": "page",
            "protocolVersion": 1, "admitterVersion": "v", "counterKeys": [], "state": "deferred",
            "deferredRefreshId": refresh,
        }))
        .unwrap();
        s.insert_write_request(&input)
    }

    fn no_roots() -> crate::persistence::ClaimableSpec {
        crate::persistence::ClaimableSpec {
            priority: Some(false),
            ..Default::default()
        }
    }

    fn claim(s: &Store, id: &str) -> Result<Option<Value>> {
        s.stamp_write_claim(&crate::persistence::ClaimStamp {
            fence: None,
            id: id.into(),
            token: "c0000000-0000-4000-8000-0000000000c1".into(),
            lease_ms: 30_000.0,
            phase_json: None,
        })
    }

    #[test]
    fn a_deferred_request_names_an_existing_refresh() {
        let s = store();
        let missing =
            deferred_insert(&s, "b0000000-0000-4000-8000-000000000001", Some(F1)).unwrap_err();
        assert!(
            missing
                .message
                .contains("names no persistence_worktree_refreshes row"),
            "{missing:?}"
        );
        put(&s, &refresh(F1, WT, "syncing", &["default"], 0));
        let row = deferred_insert(&s, "b0000000-0000-4000-8000-000000000001", Some(F1)).unwrap();
        assert_eq!(row["state"], json!("deferred"));
        assert_eq!(row["deferred_refresh_id"], json!(F1));
        assert!(deferred_insert(&s, "b0000000-0000-4000-8000-000000000002", Some("nope")).is_err());
    }

    #[test]
    fn a_deferred_request_is_claimed_only_after_its_refresh_is_released() {
        let s = store();
        let mut f = refresh(F1, WT, "syncing", &["default"], 0);
        put(&s, &f);
        let row = deferred_insert(&s, "b0000000-0000-4000-8000-000000000001", Some(F1)).unwrap();
        let id = row["id"].as_str().unwrap().to_owned();
        assert_eq!(s.select_claimable_write(&no_roots()).unwrap(), None);
        let refused = claim(&s, &id).unwrap_err();
        assert!(
            refused.message.starts_with("writer_upgrade_required"),
            "{refused:?}"
        );
        assert_eq!(
            s.count_held_behind_import("default", None).unwrap(),
            json!({ "count": 1, "bytes": 1 })
        );
        assert!(s.lock_overdue_hold("refresh", Some(F1), None, 0.0).unwrap());
        assert!(!s.lock_overdue_hold("import", Some(&id), None, 0.0).unwrap());
        f.released_at_us = Some(1);
        put(&s, &f);
        assert!(!s.lock_overdue_hold("refresh", Some(F1), None, 0.0).unwrap());
        assert_eq!(
            s.select_claimable_write(&no_roots()).unwrap().unwrap()["id"],
            json!(id)
        );
        assert_eq!(
            s.count_held_behind_import("default", None).unwrap(),
            json!({ "count": 0, "bytes": 0 })
        );
        assert_eq!(claim(&s, &id).unwrap().unwrap()["state"], json!("running"));
    }

    #[test]
    fn a_deferred_request_leaves_only_as_the_trigger_allows() {
        use crate::persistence::guard_deferred_transition as guard;
        assert!(guard("queued", "running").is_ok());
        assert!(guard("deferred", "deferred").is_ok());
        for end in ["conflict", "failed", "cancelled"] {
            assert!(guard("deferred", end).is_ok(), "{end}");
        }
        for next in ["queued", "running", "recovering", "committed"] {
            assert!(guard("deferred", next).is_err(), "{next}");
        }
        for from in ["queued", "running", "recovering"] {
            assert!(guard(from, "deferred").is_err(), "{from}");
        }
    }
}
