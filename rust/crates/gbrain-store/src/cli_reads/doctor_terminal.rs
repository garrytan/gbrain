//! Doctor terminal write failure reads: the typed members that replace the two raw statements of
//! `src/core/persistence/terminal-failures.ts` (SQL in `src/core/engine-sql/doctor-terminal.ts`, docs in
//! `rust/docs/store/cli-reads-doctor-terminal.md`).
//!
//! Both read `persistence_requests` (the request journal and its `extra` columns) and answer the rows the SQL
//! answers, with the same column names and types: a `::int` count is a number, a `::text` column a string, a
//! `jsonb` column its value. `now()` is the store clock, read once per call. The classification columns the SQL
//! computes (`knock_on`, `routed_message`, `build`, the schema-aware `reason`) are ported here rule by rule; the
//! strings they test come in the query (`TerminalRules`), taken from the TypeScript constants the SQL splices,
//! so the two sides cannot drift apart without a parity case failing.
//!
//! The recursive connector-retry lineage of `supersessionSql` is walked here too (`connector_retry`): it
//! follows each hop's recorded `retryOf` to a request of the same principal, source, incarnation, operation,
//! slug and intent kind at a lower sequence, up to `connectorLineageMaxDepth` hops.

use crate::Store;
use crate::env::iso;
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::persistence::{all_requests, extra_bool, extra_is_null, json_text, sql_like};
use crate::sources::all_sources;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

const DAY_US: i64 = 86_400 * 1_000_000;
/// `array_agg(..)[1:20]` of the recovery ids.
const RECOVERY_LIST_CAP: usize = 20;

type Request = RequestRecord;

/// The strings and numbers the terminal SQL splices from the TypeScript constants.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRules {
    /// `SYNC_KNOCK_ON_ORIGIN`.
    pub sync_knock_on_origin: String,
    /// `LEGACY_KNOCK_ON_CANCEL_MESSAGES`.
    pub legacy_cancel_messages: Vec<String>,
    /// `LEGACY_KNOCK_ON_CANCEL_PATTERNS` (`LIKE` patterns).
    pub legacy_cancel_patterns: Vec<String>,
    /// `EARLIER_PAGE_REFUSAL_MESSAGE`.
    pub earlier_page_refusal: String,
    /// `SYNC_PASS_SUPERSEDED`.
    pub sync_pass_superseded: String,
    /// `LEGACY_PUBLICATION_PREFIX`.
    pub legacy_publication_prefix: String,
    /// `GRANDFATHER_RETIRED`.
    pub grandfather_retired: String,
    /// `TERMINAL_FIXED_IN.knock_on`.
    pub fixed_knock_on: String,
    /// `TERMINAL_FIXED_IN.fence_unrenderable`.
    pub fixed_fence_unrenderable: String,
    /// The connector write kinds of `connectorRetrySql`.
    pub connector_kinds: Vec<String>,
    /// `PAGE_REMOVAL_OPERATIONS`.
    pub page_removal_operations: Vec<String>,
    /// `CONNECTOR_RETRY_LINEAGE_MAX_DEPTH`.
    pub connector_lineage_max_depth: u32,
}

/// The arguments of `readTerminalFailureGroups`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalGroupsQuery {
    /// The span the base set reads (`max(window, 8)` days).
    pub span_days: i64,
    pub window_days: i64,
    pub source_ids: Option<Vec<String>>,
    pub rules: TerminalRules,
}

/// The arguments of `listTerminalFailureBatch`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBatchQuery {
    pub source_id: String,
    pub window_days: i64,
    pub before: Option<String>,
    pub limit: i64,
    pub rules: TerminalRules,
}

/// The columns the SQL computes once per receipt.
struct Columns {
    intent_kind: Option<String>,
    origin: Option<String>,
    reason: Option<String>,
    cause: Option<String>,
    has_recovery: bool,
    knock_on: bool,
    routed_message: Option<String>,
    build: Option<String>,
    ended_at: i64,
}

fn detail_text(r: &Request, key: &str) -> Option<String> {
    json_text(r.extra.get("error_detail").and_then(|d| d.get(key)))
}

fn recovery_held(r: &Request) -> bool {
    !extra_is_null(r, "recovery")
}

/// `RECOVERY(r)`: a receipt holding a publication recovery record in a state that can hold one.
fn recovery_row(r: &Request) -> bool {
    recovery_held(r)
        && matches!(
            r.state.as_str(),
            "committed" | "recovering" | "failed" | "conflict" | "cancelled"
        )
}

/// `TERMINAL(r)`.
fn terminal_state(r: &Request) -> bool {
    matches!(r.state.as_str(), "failed" | "conflict" | "cancelled")
}

/// `ENDED(r)`: `COALESCE(completed_at, updated_at)`.
fn ended_at(r: &Request) -> i64 {
    r.completed_at_us.unwrap_or(r.updated_at_us)
}

fn intent_kind(r: &Request) -> Option<String> {
    json_text(r.intent.get("kind"))
}

/// `syncKnockOnSql(r)`: never NULL.
fn sync_knock_on(r: &Request, rules: &TerminalRules) -> bool {
    if !(terminal_state(r) && !recovery_held(r) && !extra_bool(r, "publication_started")) {
        return false;
    }
    let code = r.error_code.as_deref();
    let message = r.error_message.as_deref();
    detail_text(r, "origin").as_deref() == Some(rules.sync_knock_on_origin.as_str())
        || (r.state == "cancelled"
            && code == Some("cancelled")
            && message.is_some_and(|m| {
                rules.legacy_cancel_messages.iter().any(|l| l == m)
                    || rules.legacy_cancel_patterns.iter().any(|p| sql_like(m, p))
            }))
        || (matches!(r.state.as_str(), "conflict" | "failed")
            && code == Some("revision_conflict")
            && message == Some(rules.earlier_page_refusal.as_str()))
}

/// `terminalKnockOnSql(r)`.
fn terminal_knock_on(r: &Request, rules: &TerminalRules) -> bool {
    if !sync_knock_on(r, rules) {
        return false;
    }
    let kind = intent_kind(r);
    let sync = kind
        .as_deref()
        .map(|k| matches!(k, "managed_sync_import" | "managed_sync_delete"));
    if detail_text(r, "origin").as_deref() == Some(rules.sync_knock_on_origin.as_str()) {
        kind.is_none() || sync == Some(true)
    } else {
        sync.unwrap_or(false)
    }
}

/// `message ~* 'ECONN|ETIMEDOUT|EPIPE|connection.*closed|CONNECTION_ENDED'`.
fn connection_message(message: &str) -> bool {
    let lower = message.to_lowercase();
    ["econn", "etimedout", "epipe", "connection_ended"]
        .iter()
        .any(|needle| lower.contains(needle))
        || lower
            .find("connection")
            .is_some_and(|at| lower[at + "connection".len()..].contains("closed"))
}

/// `ROUTED_MESSAGE(r)`.
fn routed_message(r: &Request, rules: &TerminalRules) -> Option<String> {
    let code = r.error_code.as_deref();
    let message = r.error_message.as_deref();
    if code == Some("source_changed") && detail_text(r, "reason").is_none() {
        return message.map(|m| m.chars().take(500).collect());
    }
    if matches!(code, Some("storage_error" | "writer_coordinator_required"))
        && extra_is_null(r, "error_detail")
        && message.is_some_and(|m| m.starts_with(rules.legacy_publication_prefix.as_str()))
    {
        return Some(rules.legacy_publication_prefix.clone());
    }
    if code == Some("storage_error") && message.is_some_and(connection_message) {
        return Some("connection closed".to_owned());
    }
    None
}

fn columns(r: &Request, rules: &TerminalRules) -> Columns {
    let origin = detail_text(r, "origin");
    let reason = detail_text(r, "reason").or_else(|| {
        (origin.as_deref() == Some("owner_exception")
            && matches!(detail_text(r, "errno").as_deref(), Some("42P01" | "42703")))
        .then(|| "schema_missing".to_owned())
    });
    let attempt_build = r
        .extra
        .get("error_detail")
        .and_then(|d| d.get("attempt"))
        .and_then(|a| json_text(a.get("consumer_version")));
    Columns {
        intent_kind: intent_kind(r),
        origin,
        reason,
        cause: detail_text(r, "cause"),
        has_recovery: recovery_held(r),
        knock_on: terminal_knock_on(r, rules),
        routed_message: routed_message(r, rules),
        build: attempt_build.or_else(|| json_text(r.extra.get("admitter_version"))),
        ended_at: ended_at(r),
    }
}

/// `OLDER_THAN(build, fixed)`: both `MAJOR.MINOR.PATCH[.MICRO]`; an unknown build is not older.
fn older_than(build: Option<&str>, fixed: &str) -> bool {
    fn parts(text: &str) -> Option<[u64; 4]> {
        let mut out = [0u64; 4];
        let mut n = 0;
        for piece in text.split('.') {
            if n == 4 || piece.is_empty() || !piece.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            out[n] = piece.parse().ok()?;
            n += 1;
        }
        (n >= 3).then_some(out)
    }
    match (build.and_then(parts), parts(fixed)) {
        (Some(have), Some(want)) => have < want,
        _ => false,
    }
}

/// `HISTORICAL_BY_BUILD(b)`: the SQL twin of the verdict's `historical` for the classes a release fixed.
fn historical_by_build(c: &Columns, r: &Request, rules: &TerminalRules) -> bool {
    let code = r.error_code.as_deref();
    let plain = !c.has_recovery && !c.knock_on;
    (c.knock_on && !c.has_recovery && older_than(c.build.as_deref(), &rules.fixed_knock_on))
        || (plain
            && c.routed_message.as_deref() == Some(rules.legacy_publication_prefix.as_str())
            && c.origin.is_none()
            && matches!(code, Some("storage_error" | "writer_coordinator_required")))
        || (plain
            && c.origin.is_none()
            && code == Some("fence_unrenderable")
            && older_than(c.build.as_deref(), &rules.fixed_fence_unrenderable))
        || (plain
            && code == Some("revision_conflict")
            && (c.origin.as_deref() == Some(rules.grandfather_retired.as_str())
                || c.intent_kind.as_deref() == Some("managed_grandfather")))
}

/// The requests by `(source, slug)` and by `(principal, request id)`, for the supersession reads.
struct Journal<'a> {
    by_page: HashMap<(&'a str, &'a str), Vec<&'a Request>>,
    by_request: HashMap<(&'a str, &'a str, String), &'a Request>,
}

impl<'a> Journal<'a> {
    fn new(requests: &'a [Request]) -> Self {
        let mut by_page: HashMap<(&str, &str), Vec<&Request>> = HashMap::new();
        let mut by_request = HashMap::new();
        for r in requests {
            by_page
                .entry((r.source_id.as_str(), r.slug.as_str()))
                .or_default()
                .push(r);
            by_request.insert(
                (
                    r.principal_kind.as_str(),
                    r.principal_id.as_str(),
                    r.request_id.to_lowercase(),
                ),
                r,
            );
        }
        Self {
            by_page,
            by_request,
        }
    }

    /// The later requests of the page `r` wrote, `supersessionSql(r, c)` first and `r_kind` as the SQL passes it.
    fn superseding(&self, r: &Request, rules: &TerminalRules) -> Vec<&'a Request> {
        let r_kind = intent_kind(r);
        self.by_page
            .get(&(r.source_id.as_str(), r.slug.as_str()))
            .into_iter()
            .flatten()
            .copied()
            .filter(|c| c.sequence > r.sequence && self.supersedes(r, c, r_kind.as_deref(), rules))
            .collect()
    }

    fn supersedes(
        &self,
        r: &Request,
        c: &Request,
        r_kind: Option<&str>,
        rules: &TerminalRules,
    ) -> bool {
        let pending = matches!(c.state.as_str(), "queued" | "running" | "recovering");
        let committed = c.state == "committed";
        let same_digest = c.digest == r.digest;
        (same_digest && (committed || c.state == "failed" || pending))
            || ((committed || pending)
                && (rules.page_removal_operations.contains(&c.operation)
                    || r.operation == "put_page"))
            || (r.slug == "__managed_sync_checkpoint__"
                && r.operation == "submit_job"
                && committed
                && c.operation == "submit_job"
                && intent_kind(r)
                    .as_deref()
                    .unwrap_or("managed_sync_checkpoint")
                    == "managed_sync_checkpoint"
                && intent_kind(c)
                    .as_deref()
                    .unwrap_or("managed_sync_checkpoint")
                    == "managed_sync_checkpoint")
            || (r.operation == "put_page"
                && c.state == "failed"
                && c.operation == "put_page"
                && c.intent
                    .as_object()
                    .is_some_and(|o| !o.contains_key("kind")))
            || self.connector_retry(r, c, r_kind, rules)
    }

    /// `connectorRetrySql(r, c, rKind)`.
    fn connector_retry(
        &self,
        r: &Request,
        c: &Request,
        r_kind: Option<&str>,
        rules: &TerminalRules,
    ) -> bool {
        let is_connector = |kind: Option<&str>| {
            kind.is_some_and(|k| rules.connector_kinds.iter().any(|known| known == k))
        };
        if !(r.operation == "submit_job"
            && c.operation == "submit_job"
            && c.state == "committed"
            && is_connector(r_kind)
            && c.intent
                .as_object()
                .is_some_and(|o| o.contains_key("retryOf")))
        {
            return false;
        }
        let kind = intent_kind(r);
        if !(is_connector(kind.as_deref())
            && intent_kind(c) == kind
            && c.principal_kind == r.principal_kind
            && c.principal_id == r.principal_id
            && c.source_incarnation == r.source_incarnation)
        {
            return false;
        }
        let wanted = r.request_id.to_lowercase();
        let (mut request_id, mut sequence) = (c.request_id.to_lowercase(), c.sequence);
        let mut intent = &c.intent;
        for depth in 0..=rules.connector_lineage_max_depth {
            if request_id == wanted {
                return true;
            }
            if depth == rules.connector_lineage_max_depth {
                return false;
            }
            let Some(next) = json_text(intent.get("retryOf"))
                .filter(|text| is_uuid_text(text))
                .map(|text| text.to_lowercase())
                .and_then(|id| {
                    self.by_request
                        .get(&(r.principal_kind.as_str(), r.principal_id.as_str(), id))
                })
                .filter(|p| {
                    p.sequence < sequence
                        && p.source_id == r.source_id
                        && p.source_incarnation == r.source_incarnation
                        && p.operation == r.operation
                        && p.slug == r.slug
                        && intent_kind(p) == kind
                })
            else {
                return false;
            };
            request_id = next.request_id.to_lowercase();
            sequence = next.sequence;
            intent = &next.intent;
        }
        false
    }
}

/// `~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`.
fn is_uuid_text(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.
fn second_text(micros: i64) -> String {
    format!("{}Z", &iso(micros)[..19])
}

/// One group of the aggregate: every column of `GROUP BY GROUPING SETS` but the key.
#[derive(Default)]
struct Totals {
    rows: i64,
    n_24h: i64,
    days: [i64; 7],
    oldest: Option<i64>,
    slugs: BTreeSet<String>,
    digests: BTreeSet<String>,
    recovery: Vec<(u64, String, String)>,
}

/// The grouping columns, in the SQL's order.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
    state: String,
    error_code: Option<String>,
    origin: Option<String>,
    reason: Option<String>,
    cause: Option<String>,
    operation: String,
    intent_kind: Option<String>,
    has_recovery: bool,
    blocked_reason: Option<String>,
    compacted: bool,
    knock_on: bool,
    routed_message: Option<String>,
    build: Option<String>,
    resolved: bool,
}

struct Receipt<'a> {
    r: &'a Request,
    in_window: bool,
    resolved: bool,
    historical_build: bool,
}

impl Totals {
    fn add(&mut self, now: i64, row: &Receipt, ended: i64) {
        let r = row.r;
        let terminal = terminal_state(r);
        if row.in_window {
            self.rows += 1;
            self.oldest = Some(self.oldest.map_or(ended, |o| o.min(ended)));
            if !row.resolved && !recovery_held(r) && !row.historical_build {
                self.slugs.insert(r.slug.clone());
                self.digests.insert(r.digest.clone());
            }
            if recovery_held(r) {
                self.recovery
                    .push((r.sequence, r.request_id.clone(), r.slug.clone()));
            }
        }
        if terminal && ended > now - DAY_US {
            self.n_24h += 1;
        }
        for (i, day) in self.days.iter_mut().enumerate() {
            let i = i as i64;
            if terminal && ended <= now - (i + 1) * DAY_US && ended > now - (i + 2) * DAY_US {
                *day += 1;
            }
        }
    }

    fn json(&self, now: i64, set: i64, source_id: &str, key: Option<&Key>) -> Value {
        let mut recovery = self.recovery.clone();
        recovery.sort();
        recovery.truncate(RECOVERY_LIST_CAP);
        let mut row = json!({
            "set": set,
            "source_id": source_id,
            "state": key.map(|k| k.state.clone()),
            "error_code": key.and_then(|k| k.error_code.clone()),
            "origin": key.and_then(|k| k.origin.clone()),
            "reason": key.and_then(|k| k.reason.clone()),
            "cause": key.and_then(|k| k.cause.clone()),
            "operation": key.map(|k| k.operation.clone()),
            "intent_kind": key.and_then(|k| k.intent_kind.clone()),
            "has_recovery": key.map(|k| k.has_recovery),
            "blocked_reason": key.and_then(|k| k.blocked_reason.clone()),
            "compacted": key.map(|k| k.compacted),
            "knock_on": key.map(|k| k.knock_on),
            "routed_message": key.and_then(|k| k.routed_message.clone()),
            "build": key.and_then(|k| k.build.clone()),
            "resolved": key.map(|k| k.resolved),
            "rows": self.rows,
            "in_window": self.rows,
            "n_24h": self.n_24h,
            "oldest": self.oldest.map(second_text),
            "oldest_age": self.oldest.map(|o| (now - o).div_euclid(1_000_000)),
            "distinct_slugs": self.slugs.len(),
            "distinct_intents": self.digests.len(),
            "recovery_ids": (!recovery.is_empty()).then(|| recovery.iter().map(|r| r.1.clone()).collect::<Vec<_>>()),
            "recovery_slugs": (!recovery.is_empty()).then(|| recovery.iter().map(|r| r.2.clone()).collect::<Vec<_>>()),
        });
        let object = row.as_object_mut().expect("a JSON object");
        for (i, count) in self.days.iter().enumerate() {
            object.insert(format!("d{}", i + 2), json!(count));
        }
        row
    }
}

impl Store {
    /// `readTerminalFailureGroups(query)`: the aggregate of `readTerminalFailureSummary`. The receipts of the
    /// non-archived sources that hold a recovery record or ended terminal inside `spanDays`, grouped on the
    /// classification columns, plus one total row per source (`set` is 1 there, and the key columns are null).
    /// Rows come in source order, each source's groups before its total, groups in key order.
    pub fn read_terminal_failure_groups(&self, q: &TerminalGroupsQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let live: HashSet<String> = all_sources(&*read)?
            .into_iter()
            .filter(|s| !s.archived)
            .map(|s| s.id)
            .collect();
        let requests = all_requests(&*read)?;
        let journal = Journal::new(&requests);
        let mut groups: BTreeMap<String, BTreeMap<Key, Totals>> = BTreeMap::new();
        let mut sources: BTreeMap<String, Totals> = BTreeMap::new();
        for r in &requests {
            let ended = ended_at(r);
            let included = recovery_row(r)
                || (terminal_state(r) && ended > now - q.span_days.saturating_mul(DAY_US));
            if !included
                || !live.contains(&r.source_id)
                || q.source_ids
                    .as_ref()
                    .is_some_and(|ids| !ids.contains(&r.source_id))
            {
                continue;
            }
            let c = columns(r, &q.rules);
            let resolved = !c.has_recovery
                && (!journal.superseding(r, &q.rules).is_empty()
                    || r.error_code.as_deref() == Some(q.rules.sync_pass_superseded.as_str()));
            let receipt = Receipt {
                r,
                in_window: c.has_recovery || ended > now - q.window_days.saturating_mul(DAY_US),
                resolved,
                historical_build: historical_by_build(&c, r, &q.rules),
            };
            let key = Key {
                state: r.state.clone(),
                error_code: r.error_code.clone(),
                origin: c.origin,
                reason: c.reason,
                cause: c.cause,
                operation: r.operation.clone(),
                intent_kind: c.intent_kind,
                has_recovery: c.has_recovery,
                blocked_reason: r.blocked_reason.clone(),
                compacted: extra_bool(r, "compacted"),
                knock_on: c.knock_on,
                routed_message: c.routed_message,
                build: c.build,
                resolved,
            };
            groups
                .entry(r.source_id.clone())
                .or_default()
                .entry(key)
                .or_default()
                .add(now, &receipt, c.ended_at);
            sources
                .entry(r.source_id.clone())
                .or_default()
                .add(now, &receipt, c.ended_at);
        }
        let mut rows = Vec::new();
        for (source_id, total) in &sources {
            for (key, totals) in &groups[source_id] {
                rows.push(totals.json(now, 0, source_id, Some(key)));
            }
            rows.push(total.json(now, 1, source_id, None));
        }
        Ok(rows)
    }

    /// `listTerminalFailureBatch(query)`: up to `limit` receipts of one source, newest sequence first, from
    /// before the `before` sequence, each with the first later request that made it moot.
    pub fn list_terminal_failure_batch(&self, q: &TerminalBatchQuery) -> Result<Vec<Value>> {
        let read = self.read()?;
        let now = self.env.now_micros();
        let before: Option<u64> = q
            .before
            .as_deref()
            .map(|text| {
                text.trim()
                    .parse::<i64>()
                    .map(|n| n.max(0) as u64)
                    .map_err(|_| StoreError::invalid(format!("'{text}' is not a bigint")))
            })
            .transpose()?;
        let requests = all_requests(&*read)?;
        let journal = Journal::new(&requests);
        let mut chosen: Vec<&Request> = requests
            .iter()
            .filter(|r| {
                r.source_id == q.source_id
                    && (recovery_row(r)
                        || (terminal_state(r)
                            && ended_at(r) > now - q.window_days.saturating_mul(DAY_US)))
                    && before.is_none_or(|b| r.sequence < b)
            })
            .collect();
        chosen.sort_by_key(|r| std::cmp::Reverse(r.sequence));
        chosen.truncate(q.limit.max(0) as usize);
        Ok(chosen
            .into_iter()
            .map(|r| {
                let c = columns(r, &q.rules);
                let later = (!c.has_recovery)
                    .then(|| {
                        journal
                            .superseding(r, &q.rules)
                            .into_iter()
                            .min_by_key(|l| {
                                let same = l.digest == r.digest;
                                (!(same && l.state == "committed"), !same, l.sequence)
                            })
                    })
                    .flatten();
                json!({
                    "request_id": r.request_id,
                    "sequence": r.sequence.to_string(),
                    "source_id": r.source_id,
                    "slug": r.slug,
                    "operation": r.operation,
                    "intent_kind": c.intent_kind,
                    "state": r.state,
                    "error_code": r.error_code,
                    "error_detail": r.extra.get("error_detail").cloned().filter(|d| !d.is_null()),
                    "origin": c.origin,
                    // The batch reads the detail's own `reason`; only the aggregate maps a missing relation.
                    "reason": detail_text(r, "reason"),
                    "cause": c.cause,
                    "has_recovery": c.has_recovery,
                    "blocked_reason": r.blocked_reason,
                    "compacted": extra_bool(r, "compacted"),
                    "knock_on": c.knock_on,
                    "routed_message": c.routed_message,
                    "build": c.build,
                    "ended_at": second_text(c.ended_at),
                    "admitted_at": second_text(r.created_at_us),
                    "later_state": later.map(|l| l.state.clone()),
                    "same_intent": later.map(|l| l.digest == r.digest),
                })
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_loss_text_matches_the_posix_pattern_case_insensitively() {
        assert!(connection_message("read ECONNRESET"));
        assert!(connection_message("Connection was Closed by the peer"));
        assert!(connection_message("CONNECTION_ENDED"));
        assert!(!connection_message("closed before the connection"));
        assert!(!connection_message("fine"));
    }

    #[test]
    fn a_build_is_older_only_when_both_versions_are_dotted_numbers() {
        assert!(older_than(Some("0.60.215.9"), "0.60.216.0"));
        assert!(older_than(Some("0.60.215"), "0.60.216.0"));
        assert!(!older_than(Some("0.60.216"), "0.60.216.0"));
        assert!(!older_than(Some("v0.60.1"), "0.60.216.0"));
        assert!(!older_than(None, "0.60.216.0"));
    }

    fn request(extra: Value) -> Request {
        let mut base = json!({
            "id": "1", "principal_kind": "local_cli", "principal_id": "w", "request_id": "b0000000-0000-4000-8000-000000000001",
            "operation": "submit_job", "source_id": "default", "source_incarnation": "i", "slug": "s", "digest": "d",
            "intent": {}, "authority": {}, "sequence": 1, "state": "failed", "created_at_us": 0, "updated_at_us": 5,
        });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn a_recovery_record_counts_only_in_a_state_that_can_hold_one() {
        let held = json!({ "recovery": { "step": 1 } });
        assert!(recovery_row(&request(
            json!({ "recovery": { "step": 1 }, "state": "committed" })
        )));
        assert!(!recovery_row(&request(
            json!({ "recovery": { "step": 1 }, "state": "running" })
        )));
        assert!(!recovery_row(&request(json!({ "recovery": null }))));
        assert!(recovery_held(&request(held)));
    }

    fn connector(sequence: u64, request_id: &str, state: &str, intent: Value) -> Request {
        request(
            json!({ "sequence": sequence, "request_id": request_id, "state": state, "intent": intent, "id": request_id }),
        )
    }

    #[test]
    fn a_committed_connector_retry_supersedes_through_its_recorded_lineage() {
        let rules: TerminalRules = serde_json::from_value(json!({
            "syncKnockOnOrigin": "k", "legacyCancelMessages": [], "legacyCancelPatterns": [], "earlierPageRefusal": "e",
            "syncPassSuperseded": "p", "legacyPublicationPrefix": "l", "grandfatherRetired": "g", "fixedKnockOn": "1.0.0",
            "fixedFenceUnrenderable": "1.0.0", "connectorKinds": ["connector_v2_import"], "pageRemovalOperations": [],
            "connectorLineageMaxDepth": 2,
        }))
        .unwrap();
        let (a, b, c) = (
            "b0000000-0000-4000-8000-0000000000a1",
            "b0000000-0000-4000-8000-0000000000a2",
            "b0000000-0000-4000-8000-0000000000a3",
        );
        let kind = json!({ "kind": "connector_v2_import" });
        let refused = connector(1, a, "failed", kind.clone());
        let retry = connector(
            2,
            b,
            "committed",
            json!({ "kind": "connector_v2_import", "retryOf": a }),
        );
        let far = connector(
            3,
            c,
            "committed",
            json!({ "kind": "connector_v2_import", "retryOf": b }),
        );
        let unrelated = connector(
            4,
            "b0000000-0000-4000-8000-0000000000a4",
            "committed",
            json!({ "kind": "connector_v2_import", "retryOf": "b0000000-0000-4000-8000-0000000000ff" }),
        );
        let all = vec![
            refused.clone(),
            retry.clone(),
            far.clone(),
            unrelated.clone(),
        ];
        let journal = Journal::new(&all);
        let kind = Some("connector_v2_import");
        assert!(
            journal.connector_retry(&refused, &retry, kind, &rules),
            "one hop"
        );
        assert!(
            journal.connector_retry(&refused, &far, kind, &rules),
            "two hops"
        );
        assert!(
            !journal.connector_retry(&refused, &unrelated, kind, &rules),
            "no recorded link is not proof"
        );
        let short = TerminalRules {
            connector_lineage_max_depth: 1,
            ..rules
        };
        assert!(
            !journal.connector_retry(&refused, &far, kind, &short),
            "a longer chain fails closed"
        );
    }
}
