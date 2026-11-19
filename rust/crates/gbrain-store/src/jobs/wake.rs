//! Jobs group A: the Wakeshift report-back tables (`src/core/engine-sql/jobs-wake.ts`):
//! `wake_subscriptions` (the watches), `wake_crons` and `wake_cron_runs`, `wake_terms_acceptances`
//! and `wake_forgets`. See rust/docs/store/jobs-wake.md.
//!
//! Keys, under `keys::JOBS` (`m`), after the sequences (`m 0x00 name`: `wake_sub`, `wake_forget`,
//! `wake_cron_run`):
//! - `m 0x10 id -> WatchRecord`: one watch.
//! - `m 0x11 wake_user \0 ws_subscription_id -> id`: the partial unique index on the open watches;
//!   it is also the list of every open watch (the drainer, the expiry and the disable read it).
//! - `m 0x13 id -> ForgetRecord`: one forget.
//! - `m 0x14 wake_user -> id`: the partial unique index on the pending forgets.
//! - `m 0x15 principal_key version -> TermsRecord`: one acceptance. The version is 16 bytes, so no
//!   separator is needed.
//! - `m 0x16 name -> CronRecord`: one registered cron.
//! - `m 0x17 name \0 finished id -> CronRunRecord`: the runs of a cron in (finished, id) order.
//!
//! Nothing here has a foreign key: a deleted job, request or member changes no row.

use super::*;
use crate::env::parse_iso;
use crate::journal::RequestRecord;

const SUB: u8 = 0x10;
const SUB_OPEN: u8 = 0x11;
const FORGET: u8 = 0x13;
const FORGET_PENDING: u8 = 0x14;
const TERMS: u8 = 0x15;
const CRON: u8 = 0x16;
const CRON_RUN: u8 = 0x17;

const JOB_FINISHED: &str = "gbrain.job.finished";
const WRITE_SETTLED: &str = "gbrain.write.settled";
const CRON_FINISHED: &str = "gbrain.cron.finished";

const DAY_US: i64 = 86_400_000_000;
/// `WAKE_DUE_LIMIT`: the rows one drainer pass reads.
const DUE_LIMIT: usize = 20;
/// The watches one principal's list returns.
const LIST_LIMIT: usize = 50;

// ---------------------------------------------------------------- column rules

fn violation(table: &str, rule: &str) -> StoreError {
    StoreError::new(
        CONSTRAINT_VIOLATION,
        format!("{table}: new row violates check constraint \"{rule}\""),
    )
}

fn no_nul(what: &str, text: &str) -> Result<()> {
    if text.contains('\0') {
        return Err(StoreError::invalid(format!(
            "{what}: text contains a NUL character"
        )));
    }
    Ok(())
}

/// `^[0-9a-f]{n}$`.
fn lower_hex(text: &str, n: usize) -> bool {
    text.len() == n && text.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
fn lower_uuid(text: &str) -> bool {
    let sizes = [8, 4, 4, 4, 12];
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5 && parts.iter().zip(sizes).all(|(p, n)| lower_hex(p, n))
}

/// `^gbrain\.[a-z][a-z0-9._]{0,47}$`.
fn valid_event(event: &str) -> bool {
    let Some(rest) = event.strip_prefix("gbrain.") else {
        return false;
    };
    let b = rest.as_bytes();
    (1..=48).contains(&b.len())
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_'))
}

/// `^[a-z0-9._-]{1,64}$`.
fn valid_cron_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-'))
}

fn char_len_in(text: &str, lo: usize, hi: usize) -> bool {
    (lo..=hi).contains(&text.chars().count())
}

fn parse_at(what: &str, text: &str) -> Result<i64> {
    parse_iso(text).ok_or_else(|| {
        StoreError::invalid(format!(
            "{what}: not an ISO timestamp (UTC, with Z): {text}"
        ))
    })
}

// ---------------------------------------------------------------- records

/// One `wake_subscriptions` row; timestamps are µs.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WatchRecord {
    id: i64,
    event: String,
    target: String,
    target_ref: Option<String>,
    principal_kind: String,
    principal_id: String,
    member_id: Option<String>,
    wake_user: String,
    ws_subscription_id: String,
    state: String,
    delivered_marker: Option<String>,
    attempts: i32,
    next_attempt_at: i64,
    lease_until: Option<i64>,
    last_error: Option<String>,
    expires_at: i64,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ForgetRecord {
    id: i64,
    wake_user: String,
    state: String,
    attempts: i32,
    next_attempt_at: i64,
    lease_until: Option<i64>,
    last_error: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CronRecord {
    created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CronRunRecord {
    id: i64,
    status: String,
    finished_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TermsRecord {
    accepted_at: i64,
}

// ---------------------------------------------------------------- keys

fn sub_key(id: i64) -> Vec<u8> {
    let mut k = prefix(SUB);
    k.extend_from_slice(&signed_key(id));
    k
}

fn open_key(wake_user: &str, ws_subscription_id: &str) -> Vec<u8> {
    let mut k = prefix(SUB_OPEN);
    k.extend_from_slice(wake_user.as_bytes());
    k.push(0);
    k.extend_from_slice(ws_subscription_id.as_bytes());
    k
}

fn forget_key(id: i64) -> Vec<u8> {
    let mut k = prefix(FORGET);
    k.extend_from_slice(&signed_key(id));
    k
}

fn pending_key(wake_user: &str) -> Vec<u8> {
    let mut k = prefix(FORGET_PENDING);
    k.extend_from_slice(wake_user.as_bytes());
    k
}

fn terms_key(principal_key: &str, version: &str) -> Vec<u8> {
    let mut k = prefix(TERMS);
    k.extend_from_slice(principal_key.as_bytes());
    k.extend_from_slice(version.as_bytes());
    k
}

fn cron_key(name: &str) -> Vec<u8> {
    let mut k = prefix(CRON);
    k.extend_from_slice(name.as_bytes());
    k
}

fn run_prefix(name: &str) -> Vec<u8> {
    let mut k = prefix(CRON_RUN);
    k.extend_from_slice(name.as_bytes());
    k.push(0);
    k
}

fn run_key(name: &str, finished_at: i64, id: i64) -> Vec<u8> {
    let mut k = run_prefix(name);
    k.extend_from_slice(&signed_key(finished_at));
    k.extend_from_slice(&signed_key(id));
    k
}

// ---------------------------------------------------------------- row access

fn scan_records<T: serde::de::DeserializeOwned>(
    read: &dyn KvRead,
    under: &[u8],
    reverse: bool,
) -> Result<Vec<T>> {
    let mut rows = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        under,
        reverse,
        &mut |_, v| match serde_json::from_slice::<T>(v) {
            Ok(row) => {
                rows.push(row);
                true
            }
            Err(e) => {
                bad = Some(e);
                false
            }
        },
    )?;
    match bad {
        Some(e) => Err(e.into()),
        None => Ok(rows),
    }
}

fn load_watch(read: &dyn KvRead, id: i64) -> Result<Option<WatchRecord>> {
    get_json(read, &sub_key(id))
}

fn load_forget(read: &dyn KvRead, id: i64) -> Result<Option<ForgetRecord>> {
    get_json(read, &forget_key(id))
}

/// Every open watch, in id order of the index's `wake_user`/subscription key (not id order).
fn open_watches(read: &dyn KvRead) -> Result<Vec<WatchRecord>> {
    let mut ids = Vec::new();
    let mut bad = None;
    scan_prefix(
        read,
        &prefix(SUB_OPEN),
        false,
        &mut |_, v| match serde_json::from_slice::<i64>(v) {
            Ok(id) => {
                ids.push(id);
                true
            }
            Err(e) => {
                bad = Some(e);
                false
            }
        },
    )?;
    if let Some(e) = bad {
        return Err(e.into());
    }
    ids.sort_unstable();
    let mut rows = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(row) = load_watch(read, id)? {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// Write a watch and keep the open index in step with its state.
fn save_watch(tx: &mut dyn KvWrite, old: Option<&WatchRecord>, new: &WatchRecord) -> Result<()> {
    if let Some(old) = old.filter(|o| o.state == "open") {
        tx.delete(&open_key(&old.wake_user, &old.ws_subscription_id))?;
    }
    if new.state == "open" {
        put_json(
            tx,
            &open_key(&new.wake_user, &new.ws_subscription_id),
            &new.id,
        )?;
    }
    put_json(tx, &sub_key(new.id), new)
}

fn save_forget(tx: &mut dyn KvWrite, old: Option<&ForgetRecord>, new: &ForgetRecord) -> Result<()> {
    if old.is_some_and(|o| o.state == "pending") && new.state != "pending" {
        tx.delete(&pending_key(&new.wake_user))?;
    }
    if new.state == "pending" {
        put_json(tx, &pending_key(&new.wake_user), &new.id)?;
    }
    put_json(tx, &forget_key(new.id), new)
}

fn all_watches(read: &dyn KvRead) -> Result<Vec<WatchRecord>> {
    scan_records(read, &prefix(SUB), false)
}

fn all_forgets(read: &dyn KvRead) -> Result<Vec<ForgetRecord>> {
    scan_records(read, &prefix(FORGET), false)
}

fn cron_runs(read: &dyn KvRead, name: &str) -> Result<Vec<CronRunRecord>> {
    scan_records(read, &run_prefix(name), false)
}

fn lease_text(lease_until: i64) -> String {
    lease_until.to_string()
}

// ---------------------------------------------------------------- specs and results

/// `WakeWatchInsert`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchInsert {
    event: String,
    target: String,
    target_ref: Option<String>,
    principal_kind: String,
    principal_id: String,
    member_id: Option<String>,
    wake_user: String,
    ws_subscription_id: String,
    expires_at: String,
}

/// `WakeWatchFilter`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchFilter {
    principal_kind: String,
    principal_id: String,
    member_id: Option<String>,
    scope: String,
    event: Option<String>,
    target: Option<String>,
    id: Option<i64>,
}

/// `EndWakeWatches`: `{ reason: 'disabled' | 'expired' | 'unwatched', id? }`.
#[derive(Debug, Clone, Deserialize)]
pub struct EndSpec {
    reason: String,
    id: Option<i64>,
}

/// `WakeWatchSettle`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSettle {
    id: i64,
    lease: String,
    state: String,
    marker: Option<String>,
    attempts: Option<i32>,
    delay_s: Option<i64>,
    error: Option<String>,
}

/// `WakeForgetSettle`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetSettle {
    id: i64,
    lease: String,
    state: String,
    attempts: i32,
    error: Option<String>,
    delay_s: Option<i64>,
}

/// `{ leaseSeconds, limit }` of `claimWakeForgets`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetClaimSpec {
    lease_seconds: i64,
    limit: i64,
}

/// `{ name, status, finishedAt }` of `recordWakeCronRun`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunInput {
    name: String,
    status: String,
    finished_at: Option<String>,
}

fn ended_json(r: &WatchRecord) -> Value {
    json!({ "id": r.id, "wake_user": r.wake_user, "ws_subscription_id": r.ws_subscription_id })
}

fn watch_json(r: &WatchRecord) -> Value {
    json!({
        "id": r.id, "event": r.event, "target": r.target, "state": r.state, "attempts": r.attempts,
        "last_error": r.last_error, "created_at": iso(r.created_at), "expires_at": iso(r.expires_at),
        "wake_user": r.wake_user, "ws_subscription_id": r.ws_subscription_id,
    })
}

/// What the request a write watch joined says (`req_*`), or all null when it is gone.
fn request_columns(request: Option<&RequestRecord>) -> [(&'static str, Value); 7] {
    let settled = request.map(|r| r.completed_at_us.unwrap_or(r.updated_at_us));
    [
        ("req_id", json!(request.map(|r| r.id.clone()))),
        ("req_state", json!(request.map(|r| r.state.clone()))),
        ("req_operation", json!(request.map(|r| r.operation.clone()))),
        ("req_source_id", json!(request.map(|r| r.source_id.clone()))),
        (
            "req_created_at",
            json!(request.map(|r| iso(r.created_at_us))),
        ),
        ("req_settled_at", json!(settled.map(iso))),
        ("req_settled_us", json!(settled.map(|us| us.to_string()))),
    ]
}

/// A write request is settled for a watch when it ended unsuccessfully, or committed with no recovery
/// still to run (`recovery IS NULL`).
fn write_settled(r: &RequestRecord) -> bool {
    match r.state.as_str() {
        "failed" | "conflict" | "cancelled" => true,
        "committed" => r.extra.get("recovery").is_none_or(Value::is_null),
        _ => false,
    }
}

impl Store {
    /// `openWakeWatch`: record a watch and return its id. A second open watch of one
    /// (`wakeUser`, `wsSubscriptionId`) keeps its row and takes the new expiry. The id sequence
    /// moves in both cases, as the table's `BIGSERIAL` does before its conflict check. A row that
    /// breaks a column rule is a `constraint_violation` (it also rolls the sequence back here,
    /// which Postgres does not).
    pub fn open_wake_watch(&self, w: &WatchInsert) -> Result<i64> {
        for (what, text) in [
            ("event", &w.event),
            ("target", &w.target),
            ("principal_id", &w.principal_id),
            ("wake_user", &w.wake_user),
            ("ws_subscription_id", &w.ws_subscription_id),
        ] {
            no_nul(&format!("wake_subscriptions.{what}"), text)?;
        }
        let nul_optional = [("target_ref", &w.target_ref), ("member_id", &w.member_id)];
        for (what, text) in nul_optional {
            if let Some(text) = text {
                no_nul(&format!("wake_subscriptions.{what}"), text)?;
            }
        }
        let expires_at = parse_at("openWakeWatch expiresAt", &w.expires_at)?;
        if !valid_event(&w.event) {
            return Err(violation("wake_subscriptions", "event"));
        }
        if !char_len_in(&w.target, 1, 128) {
            return Err(violation("wake_subscriptions", "target"));
        }
        if !matches!(
            w.principal_kind.as_str(),
            "oauth_client" | "legacy_token" | "local_stdio"
        ) {
            return Err(violation("wake_subscriptions", "principal_kind"));
        }
        if !lower_hex(&w.wake_user, 32) {
            return Err(violation("wake_subscriptions", "wake_user"));
        }
        if !char_len_in(&w.ws_subscription_id, 1, 200) {
            return Err(violation("wake_subscriptions", "ws_subscription_id"));
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let fresh = next_seq(tx, "wake_sub")?;
            let key = open_key(&w.wake_user, &w.ws_subscription_id);
            if let Some(existing) = get_json::<i64>(tx, &key)?
                && let Some(mut row) = load_watch(tx, existing)?
            {
                let old = row.clone();
                row.expires_at = expires_at;
                row.updated_at = now;
                save_watch(tx, Some(&old), &row)?;
                return Ok(row.id);
            }
            let row = WatchRecord {
                id: fresh,
                event: w.event.clone(),
                target: w.target.clone(),
                target_ref: w.target_ref.clone(),
                principal_kind: w.principal_kind.clone(),
                principal_id: w.principal_id.clone(),
                member_id: w.member_id.clone(),
                wake_user: w.wake_user.clone(),
                ws_subscription_id: w.ws_subscription_id.clone(),
                state: "open".into(),
                delivered_marker: None,
                attempts: 0,
                next_attempt_at: now,
                lease_until: None,
                last_error: None,
                expires_at,
                created_at: now,
                updated_at: now,
            };
            save_watch(tx, None, &row)?;
            Ok(fresh)
        })
    }

    /// `listWakeWatches`: one principal's watches (a NULL member matches only a NULL member), newest
    /// first, at most 50. `scope` `open` is the open ones; `open_or_recent` adds those updated in the last
    /// day. `id`, or `event` with `target`, narrows it.
    pub fn list_wake_watches(&self, f: &WatchFilter) -> Result<Vec<Value>> {
        let open_only = match f.scope.as_str() {
            "open" => true,
            "open_or_recent" => false,
            other => {
                return Err(StoreError::invalid(format!(
                    "listWakeWatches: unknown scope {other}"
                )));
            }
        };
        let read = self.read()?;
        let recent_after = self.env.now_micros() - DAY_US;
        let mut rows: Vec<WatchRecord> = match (f.id, &f.event, &f.target) {
            (Some(id), _, _) => load_watch(&*read, id)?.into_iter().collect(),
            _ => all_watches(&*read)?,
        };
        rows.retain(|r| {
            r.principal_kind == f.principal_kind
                && r.principal_id == f.principal_id
                && r.member_id == f.member_id
                && (r.state == "open" || (!open_only && r.updated_at > recent_after))
                && (f.id.is_some()
                    || match (&f.event, &f.target) {
                        (Some(event), Some(target)) => &r.event == event && &r.target == target,
                        _ => true,
                    })
        });
        rows.sort_by_key(|r| std::cmp::Reverse((r.created_at, r.id)));
        rows.truncate(LIST_LIMIT);
        Ok(rows.iter().map(watch_json).collect())
    }

    /// `endWakeWatches`: end open watches and return the rows that ended. `disabled` ends every open
    /// one; `expired` those past `expires_at` (their lease stays); `unwatched` the open one `id`.
    pub fn end_wake_watches(&self, spec: &EndSpec) -> Result<Vec<Value>> {
        let reason = match spec.reason.as_str() {
            "disabled" | "expired" => spec.reason.as_str(),
            "unwatched" if spec.id.is_some() => "unwatched",
            other => {
                return Err(StoreError::invalid(format!(
                    "endWakeWatches: unknown reason {other}, or no id"
                )));
            }
        };
        self.write(|tx| {
            let now = self.env.now_micros();
            let candidates = match (reason, spec.id) {
                ("unwatched", Some(id)) => load_watch(tx, id)?
                    .filter(|r| r.state == "open")
                    .into_iter()
                    .collect(),
                _ => open_watches(tx)?,
            };
            let mut ended = Vec::new();
            for old in candidates {
                if reason == "expired" && old.expires_at >= now {
                    continue;
                }
                let mut row = old.clone();
                row.state = "ended".into();
                row.last_error = Some(reason.into());
                row.updated_at = now;
                if reason != "expired" {
                    row.lease_until = None;
                }
                save_watch(tx, Some(&old), &row)?;
                ended.push(ended_json(&row));
            }
            Ok(ended)
        })
    }

    /// `countWakeWatches`: every watch by (state, last_error), bytewise, a NULL error last.
    pub fn count_wake_watches(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut counts: BTreeMap<(String, bool, String), (Option<String>, i64)> = BTreeMap::new();
        for r in all_watches(&*read)? {
            let key = (
                r.state.clone(),
                r.last_error.is_none(),
                r.last_error.clone().unwrap_or_default(),
            );
            counts.entry(key).or_insert((r.last_error, 0)).1 += 1;
        }
        Ok(counts
            .into_iter()
            .map(|((state, ..), (last_error, n))| json!({ "state": state, "last_error": last_error, "n": n }))
            .collect())
    }

    /// `readWakeDoctor`: the watches that are open or were updated in the last 7 days by (state,
    /// whether the error was `id_reused`), the cron names that ran in the last 7 days without being
    /// registered, the pending forgets older than a day and the forgets that died in the last 30 days.
    pub fn read_wake_doctor(&self) -> Result<Value> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut watches: BTreeMap<(String, u8), (Option<bool>, i64)> = BTreeMap::new();
        for r in all_watches(&*read)? {
            if r.state != "open" && r.updated_at <= now - 7 * DAY_US {
                continue;
            }
            let reused = r.last_error.as_deref().map(|e| e == "id_reused");
            let order = match reused {
                Some(false) => 0,
                Some(true) => 1,
                None => 2,
            };
            watches.entry((r.state, order)).or_insert((reused, 0)).1 += 1;
        }
        let mut unregistered = BTreeSet::new();
        let mut bad = None;
        scan_prefix(&*read, &prefix(CRON_RUN), false, &mut |k, v| {
            let run: CronRunRecord = match serde_json::from_slice(v) {
                Ok(run) => run,
                Err(e) => {
                    bad = Some(e);
                    return false;
                }
            };
            let tail = &k[prefix(CRON_RUN).len()..];
            if let Some(end) = tail.iter().position(|b| *b == 0)
                && run.finished_at > now - 7 * DAY_US
            {
                unregistered.insert(String::from_utf8_lossy(&tail[..end]).into_owned());
            }
            true
        })?;
        if let Some(e) = bad {
            return Err(e.into());
        }
        let mut names = Vec::new();
        for name in unregistered {
            if read.get(&cron_key(&name))?.is_none() {
                names.push(name);
            }
        }
        let forgets = all_forgets(&*read)?;
        let stale = forgets
            .iter()
            .filter(|f| f.state == "pending" && f.created_at < now - DAY_US)
            .count();
        let dead = forgets
            .iter()
            .filter(|f| f.state == "dead" && f.updated_at > now - 30 * DAY_US)
            .count();
        Ok(json!({
            "watches": watches.into_iter().map(|((state, _), (id_reused, n))| json!({ "state": state, "id_reused": id_reused, "n": n })).collect::<Vec<_>>(),
            "unregistered": names,
            "stale_forgets": stale,
            "dead_forgets": dead,
        }))
    }

    /// `countPendingWakeForgets`.
    pub fn count_pending_wake_forgets(&self) -> Result<i64> {
        let read = self.read()?;
        let mut n = 0;
        scan_prefix(&*read, &prefix(FORGET_PENDING), false, &mut |_, _| {
            n += 1;
            true
        })?;
        Ok(n)
    }

    /// `listWakeCrons`: the registered crons by name (bytewise), each with the status and time of
    /// its last run (latest `finished_at`, then highest id).
    pub fn list_wake_crons(&self) -> Result<Vec<Value>> {
        let read = self.read()?;
        let mut out = Vec::new();
        let mut crons = Vec::new();
        let mut bad = None;
        let skip = prefix(CRON).len();
        scan_prefix(
            &*read,
            &prefix(CRON),
            false,
            &mut |k, v| match serde_json::from_slice::<CronRecord>(v) {
                Ok(c) => {
                    crons.push((String::from_utf8_lossy(&k[skip..]).into_owned(), c));
                    true
                }
                Err(e) => {
                    bad = Some(e);
                    false
                }
            },
        )?;
        if let Some(e) = bad {
            return Err(e.into());
        }
        for (name, cron) in crons {
            let last = cron_runs(&*read, &name)?.pop();
            out.push(json!({
                "name": name,
                "created_at": iso(cron.created_at),
                "last_status": last.as_ref().map(|r| r.status.clone()),
                "last_finished_at": last.map(|r| iso(r.finished_at)),
            }));
        }
        Ok(out)
    }

    /// `addWakeCron`: register a name; one already registered stays as it is.
    pub fn add_wake_cron(&self, name: &str) -> Result<()> {
        no_nul("wake_crons.name", name)?;
        if !valid_cron_name(name) {
            return Err(violation("wake_crons", "name"));
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            if tx.get(&cron_key(name))?.is_none() {
                put_json(tx, &cron_key(name), &CronRecord { created_at: now })?;
            }
            Ok(())
        })
    }

    /// `removeWakeCron`: unregister a name, then end the open watches on it (`cron_removed`).
    pub fn remove_wake_cron(&self, name: &str) -> Result<Vec<Value>> {
        no_nul("wake_crons.name", name)?;
        self.write(|tx| {
            let now = self.env.now_micros();
            tx.delete(&cron_key(name))?;
            let mut ended = Vec::new();
            for old in open_watches(tx)? {
                if old.event != CRON_FINISHED || old.target != name {
                    continue;
                }
                let mut row = old.clone();
                row.state = "ended".into();
                row.last_error = Some("cron_removed".into());
                row.lease_until = None;
                row.updated_at = now;
                save_watch(tx, Some(&old), &row)?;
                ended.push(ended_json(&row));
            }
            Ok(ended)
        })
    }

    /// `hasWakeCron`.
    pub fn has_wake_cron(&self, name: &str) -> Result<bool> {
        if name.contains('\0') {
            return Ok(false);
        }
        Ok(self.read()?.get(&cron_key(name))?.is_some())
    }

    /// `recordWakeCronRun`: record one run (a spooled one, with its time, is skipped when the same
    /// name, status and time are recorded), drop that cron's runs older than 30 days, and say whether
    /// the name is registered.
    pub fn record_wake_cron_run(&self, run: &CronRunInput) -> Result<Value> {
        no_nul("wake_cron_runs.name", &run.name)?;
        if !valid_cron_name(&run.name) {
            return Err(violation("wake_cron_runs", "name"));
        }
        if !matches!(run.status.as_str(), "ok" | "failed") {
            return Err(violation("wake_cron_runs", "status"));
        }
        let given = run
            .finished_at
            .as_deref()
            .map(|t| parse_at("recordWakeCronRun finishedAt", t))
            .transpose()?;
        self.write(|tx| {
            let now = self.env.now_micros();
            let finished_at = given.unwrap_or(now);
            let known = given.is_some()
                && cron_runs(tx, &run.name)?
                    .iter()
                    .any(|r| r.status == run.status && r.finished_at == finished_at);
            if !known {
                let id = next_seq(tx, "wake_cron_run")?;
                let record = CronRunRecord {
                    id,
                    status: run.status.clone(),
                    finished_at,
                };
                put_json(tx, &run_key(&run.name, finished_at, id), &record)?;
            }
            for old in cron_runs(tx, &run.name)? {
                if old.finished_at < now - 30 * DAY_US {
                    tx.delete(&run_key(&run.name, old.finished_at, old.id))?;
                }
            }
            Ok(json!({ "registered": tx.get(&cron_key(&run.name))?.is_some() }))
        })
    }

    /// `hasWakeTermsAcceptance`.
    pub fn has_wake_terms_acceptance(&self, principal_key: &str, version: &str) -> Result<bool> {
        if principal_key.contains('\0') || version.contains('\0') {
            return Ok(false);
        }
        Ok(self
            .read()?
            .get(&terms_key(principal_key, version))?
            .is_some())
    }

    /// `recordWakeTermsAcceptance`: one already recorded stays as it is.
    pub fn record_wake_terms_acceptance(&self, principal_key: &str, version: &str) -> Result<()> {
        no_nul("wake_terms_acceptances.principal_key", principal_key)?;
        if !char_len_in(principal_key, 1, 300) {
            return Err(violation("wake_terms_acceptances", "principal_key"));
        }
        if !lower_hex(version, 16) {
            return Err(violation("wake_terms_acceptances", "terms_version"));
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let key = terms_key(principal_key, version);
            if tx.get(&key)?.is_none() {
                put_json(tx, &key, &TermsRecord { accepted_at: now })?;
            }
            Ok(())
        })
    }

    /// `listDueWakeWatches`: the open, due, unleased watches whose target settled, at most 20, by due
    /// time then id, each joined to its job, write request or cron run. With `ids`, only those watches.
    /// A job watch is due when its job ended or is gone; a write watch when its request settled
    /// (failed, conflict, cancelled, or committed with no recovery) or is gone; a cron watch when the
    /// cron has a run at or after the watch began.
    pub fn list_due_wake_watches(&self, ids: Option<&[i64]>) -> Result<Vec<Value>> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let mut candidates: Vec<WatchRecord> = open_watches(&*read)?
            .into_iter()
            .filter(|w| {
                w.next_attempt_at <= now
                    && w.lease_until.is_none_or(|l| l < now)
                    && ids.is_none_or(|ids| ids.contains(&w.id))
            })
            .collect();
        candidates.sort_by_key(|w| (w.next_attempt_at, w.id));
        let mut out = Vec::new();
        for w in candidates {
            if out.len() == DUE_LIMIT {
                break;
            }
            let mut row = Map::new();
            for (k, v) in [
                ("id", json!(w.id)),
                ("event", json!(w.event)),
                ("target", json!(w.target)),
                ("target_ref", json!(w.target_ref)),
                ("principal_kind", json!(w.principal_kind)),
                ("principal_id", json!(w.principal_id)),
                ("member_id", json!(w.member_id)),
                ("wake_user", json!(w.wake_user)),
                ("ws_subscription_id", json!(w.ws_subscription_id)),
                ("attempts", json!(w.attempts)),
                ("created_us", json!(w.created_at.to_string())),
            ] {
                row.insert(k.into(), v);
            }
            let (mut job, mut request, mut run): (
                Option<JobRecord>,
                Option<RequestRecord>,
                Option<CronRunRecord>,
            ) = (None, None, None);
            let due = match w.event.as_str() {
                JOB_FINISHED => {
                    let numeric = (1..=18).contains(&w.target.len())
                        && w.target.bytes().all(|c| c.is_ascii_digit());
                    if let (true, Ok(id)) = (numeric, w.target.parse::<i64>()) {
                        job = load(&*read, id)?;
                    }
                    job.as_ref().is_none_or(|j| is_terminal(&j.status))
                }
                WRITE_SETTLED => {
                    if let Some(id) = w.target_ref.as_deref().filter(|r| lower_uuid(r)) {
                        request = get_json(&*read, &keys::request(id))?;
                    }
                    request.as_ref().is_none_or(write_settled)
                }
                CRON_FINISHED => {
                    run = cron_runs(&*read, &w.target)?
                        .into_iter()
                        .find(|r| r.finished_at >= w.created_at);
                    run.is_some()
                }
                _ => false,
            };
            if !due {
                continue;
            }
            let at = |v: Option<i64>| v.map(iso);
            for (k, v) in [
                ("job_id", json!(job.as_ref().map(|j| j.id))),
                ("job_name", json!(job.as_ref().map(|j| j.name.clone()))),
                ("job_status", json!(job.as_ref().map(|j| j.status.clone()))),
                (
                    "started_at",
                    json!(at(job.as_ref().and_then(|j| j.started_at))),
                ),
                (
                    "finished_at",
                    json!(at(job.as_ref().and_then(|j| j.finished_at))),
                ),
                (
                    "finished_us",
                    json!(
                        job.as_ref()
                            .and_then(|j| j.finished_at)
                            .map(|us| us.to_string())
                    ),
                ),
            ] {
                row.insert(k.into(), v);
            }
            for (k, v) in request_columns(request.as_ref()) {
                row.insert(k.into(), v);
            }
            for (k, v) in [
                ("run_id", json!(run.as_ref().map(|r| r.id))),
                ("run_status", json!(run.as_ref().map(|r| r.status.clone()))),
                (
                    "run_finished_at",
                    json!(at(run.as_ref().map(|r| r.finished_at))),
                ),
            ] {
                row.insert(k.into(), v);
            }
            out.push(Value::Object(row));
        }
        Ok(out)
    }

    /// `claimWakeWatch`: lease an open, due, unleased watch for `lease_seconds`. The lease's instant
    /// in epoch microseconds as text is the token `settleWakeWatch` must give back.
    pub fn claim_wake_watch(&self, id: i64, lease_seconds: i64) -> Result<Option<Value>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let Some(old) = load_watch(tx, id)? else {
                return Ok(None);
            };
            if old.state != "open"
                || old.next_attempt_at > now
                || old.lease_until.is_some_and(|l| l >= now)
            {
                return Ok(None);
            }
            let mut row = old.clone();
            let lease = now + lease_seconds * 1_000_000;
            row.lease_until = Some(lease);
            row.updated_at = now;
            save_watch(tx, Some(&old), &row)?;
            Ok(Some(
                json!({ "lease": lease_text(lease), "attempts": row.attempts }),
            ))
        })
    }

    /// `settleWakeWatch`: settle a watch still open and still leased under `lease`; false when it was
    /// ended or re-leased meanwhile. A null `attempts` or `marker` keeps the column, a null `error`
    /// clears it, and a `delayS` moves the next attempt.
    pub fn settle_wake_watch(&self, s: &WatchSettle) -> Result<bool> {
        if !matches!(s.state.as_str(), "open" | "delivered" | "dead" | "ended") {
            return Err(violation("wake_subscriptions", "state"));
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let Some(old) = load_watch(tx, s.id)? else {
                return Ok(false);
            };
            if old.state != "open"
                || old.lease_until.map(lease_text).as_deref() != Some(s.lease.as_str())
            {
                return Ok(false);
            }
            let mut row = old.clone();
            row.state = s.state.clone();
            row.lease_until = None;
            row.updated_at = now;
            if s.marker.is_some() {
                row.delivered_marker = s.marker.clone();
            }
            if let Some(attempts) = s.attempts {
                row.attempts = attempts;
            }
            if let Some(delay) = s.delay_s {
                row.next_attempt_at = now + delay * 1_000_000;
            }
            row.last_error = s.error.clone();
            save_watch(tx, Some(&old), &row)?;
            Ok(true)
        })
    }

    /// `queueWakeForget`: queue a forget of `wake_user` unless one is already pending. The
    /// `access_members` check of the SQL (`memberId` queues only when that member is not live) is
    /// true here: this store keeps no access members, so a given member id is never live.
    pub fn queue_wake_forget(&self, wake_user: &str, _member_id: Option<&str>) -> Result<()> {
        no_nul("wake_forgets.wake_user", wake_user)?;
        if !lower_hex(wake_user, 32) {
            return Err(violation("wake_forgets", "wake_user"));
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let id = next_seq(tx, "wake_forget")?;
            if tx.get(&pending_key(wake_user))?.is_some() {
                return Ok(());
            }
            let row = ForgetRecord {
                id,
                wake_user: wake_user.into(),
                state: "pending".into(),
                attempts: 0,
                next_attempt_at: now,
                lease_until: None,
                last_error: None,
                created_at: now,
                updated_at: now,
            };
            save_forget(tx, None, &row)
        })
    }

    /// `claimWakeForgets`: lease up to `limit` due pending forgets (by due time, then id) for
    /// `leaseSeconds`; the rows come back in id order, each with its lease token.
    pub fn claim_wake_forgets(&self, spec: &ForgetClaimSpec) -> Result<Vec<Value>> {
        self.write(|tx| {
            let now = self.env.now_micros();
            let mut pending = Vec::new();
            let mut ids = Vec::new();
            scan_prefix(tx, &prefix(FORGET_PENDING), false, &mut |_, v| {
                if let Ok(id) = serde_json::from_slice::<i64>(v) {
                    ids.push(id);
                }
                true
            })?;
            for id in ids {
                if let Some(f) = load_forget(tx, id)?
                    && f.state == "pending"
                    && f.next_attempt_at <= now
                    && f.lease_until.is_none_or(|l| l < now)
                {
                    pending.push(f);
                }
            }
            pending.sort_by_key(|f| (f.next_attempt_at, f.id));
            pending.truncate(spec.limit.max(0) as usize);
            pending.sort_by_key(|f| f.id);
            let mut out = Vec::new();
            for old in pending {
                let mut row = old.clone();
                let lease = now + spec.lease_seconds * 1_000_000;
                row.lease_until = Some(lease);
                row.updated_at = now;
                save_forget(tx, Some(&old), &row)?;
                out.push(json!({
                    "id": row.id, "wake_user": row.wake_user, "attempts": row.attempts, "lease": lease_text(lease),
                }));
            }
            Ok(out)
        })
    }

    /// `settleWakeForget`: settle a forget still pending and leased under `lease`; false otherwise.
    pub fn settle_wake_forget(&self, s: &ForgetSettle) -> Result<bool> {
        if !matches!(s.state.as_str(), "pending" | "done" | "dead") {
            return Err(violation("wake_forgets", "state"));
        }
        self.write(|tx| {
            let now = self.env.now_micros();
            let Some(old) = load_forget(tx, s.id)? else {
                return Ok(false);
            };
            if old.state != "pending"
                || old.lease_until.map(lease_text).as_deref() != Some(s.lease.as_str())
            {
                return Ok(false);
            }
            let mut row = old.clone();
            row.state = s.state.clone();
            row.attempts = s.attempts;
            row.last_error = s.error.clone();
            row.lease_until = None;
            row.updated_at = now;
            if let Some(delay) = s.delay_s {
                row.next_attempt_at = now + delay * 1_000_000;
            }
            save_forget(tx, Some(&old), &row)?;
            Ok(true)
        })
    }
}
