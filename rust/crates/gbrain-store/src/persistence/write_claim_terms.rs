//! The write claim's worktree terms: the parts of `claimableWriteFragment` and `CLAIM_HEAD`
//! (`src/core/engine-sql/persistence-claims.ts`) that read a request's worktree
//! (rust/docs/store/persistence.md, "Worktree rows").
//!
//! A request with a null `worktree_id` is claimed by its source incarnation's order
//! (`persistence.rs`, `claimable`). A request on a worktree is claimed only by the host that owns
//! the worktree while it is `active` and no refresh fences it, only when no effect or request on
//! the worktree carries a recovery and no unsettled withdrawal mirror there covers its slug, and
//! in the worktree's order: an earlier pending request blocks it unless the foreground switch
//! lets it pass a queued sync row, an earlier released deferred request blocks it, and a sync
//! row waits behind a running foreground write. The claim head adds the `waiting` term: a sync
//! row that would go first waits while a foreground write it has not seen is still ahead.

use super::effects::{EffectRecord, all_effects};
use super::worktree_admission::{RefreshRecord, all_refreshes, released_deferred_in};
use super::worktree_rows::read_worktree_row;
use super::{
    ClaimableSpec, extra_bool, extra_is_null, json_text, names_page, passes_queued_sync, sync_kind,
};
use crate::error::{Result, StoreError};
use crate::journal::RequestRecord;
use crate::kv::KvRead;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;

/// `fence.state IN ('fenced','merged','recovery_required')`: the refresh states that hold a
/// worktree's claims.
const FENCE_STATES: [&str; 3] = ["fenced", "merged", "recovery_required"];

/// `r.worktree_id`, as the lower-case text `::text` gives a uuid.
pub(super) fn worktree_of(r: &RequestRecord) -> Option<String> {
    r.extra
        .get("worktree_id")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
}

fn same(a: Option<&str>, w: &str) -> bool {
    a.is_some_and(|a| a.eq_ignore_ascii_case(w))
}

/// `refreshFenceClear` negated: a refresh on worktree `w` holds its claims.
pub(super) fn fenced(refreshes: &[RefreshRecord], w: &str) -> bool {
    refreshes
        .iter()
        .any(|f| same(Some(&f.worktree_id), w) && FENCE_STATES.contains(&f.state.as_str()))
}

/// `NOT EXISTS (... blocked.worktree_id=w AND blocked.recovery IS NOT NULL)` over both tables,
/// negated: an effect or a request on worktree `w` carries a recovery.
pub(super) fn recovery_on(effects: &[EffectRecord], requests: &[RequestRecord], w: &str) -> bool {
    effects
        .iter()
        .any(|e| same(e.worktree_id.as_deref(), w) && e.recovery.is_some())
        || requests.iter().any(|r| {
            same(r.extra.get("worktree_id").and_then(Value::as_str), w)
                && !extra_is_null(r, "recovery")
        })
}

/// `NOT (mirror.data ? 'targets') OR mirror.data->'targets' @> [{"slug": slug}]`.
fn mirror_covers(data: &Value, slug: &str) -> bool {
    let has_targets = match data {
        Value::Object(m) => m.contains_key("targets"),
        Value::Array(a) => a.iter().any(|v| v.as_str() == Some("targets")),
        Value::String(s) => s == "targets",
        _ => false,
    };
    if !has_targets {
        return true;
    }
    data.get("targets")
        .and_then(Value::as_array)
        .is_some_and(|targets| {
            targets
                .iter()
                .any(|t| t.get("slug").and_then(Value::as_str) == Some(slug))
        })
}

fn pending_state(r: &RequestRecord) -> bool {
    matches!(r.state.as_str(), "queued" | "running" | "recovering")
}

/// `($6::text::jsonb->>w)::bigint`: the text of a sync-seen value as a bigint. Postgres trims
/// surrounding whitespace and accepts a leading sign; anything else refuses as the cast does.
fn seen_bigint(v: &Value) -> Result<Option<i64>> {
    let Some(text) = json_text(Some(v)) else {
        return Ok(None);
    };
    let digits = text.trim();
    let body = digits.strip_prefix(['+', '-']).unwrap_or(digits);
    if body.is_empty() || !body.bytes().all(|c| c.is_ascii_digit()) {
        return Err(StoreError::invalid(format!(
            "invalid input syntax for type bigint: \"{text}\""
        )));
    }
    digits.parse::<i64>().map(Some).map_err(|_| {
        StoreError::invalid(format!("value \"{text}\" is out of range for type bigint"))
    })
}

/// `$4::bigint` of the lane head read: refuses a text that is not a bigint, as the cast does.
pub(super) fn check_seen(v: &Value) -> Result<()> {
    seen_bigint(v).map(|_| ())
}

/// The rows the worktree terms read, loaded once per claim.
pub(super) struct WorktreeClaims<'a> {
    read: &'a dyn KvRead,
    all: &'a [RequestRecord],
    effects: Vec<EffectRecord>,
    refreshes: Vec<RefreshRecord>,
    /// The `waiting` CTE per worktree, computed when a sync row first asks.
    waiting: RefCell<HashMap<String, Option<u64>>>,
}

impl<'a> WorktreeClaims<'a> {
    pub(super) fn new(read: &'a dyn KvRead, all: &'a [RequestRecord]) -> Result<Self> {
        Ok(Self {
            read,
            all,
            effects: all_effects(read)?,
            refreshes: all_refreshes(read)?,
            waiting: RefCell::new(HashMap::new()),
        })
    }

    /// `claimableWriteFragment` for candidate `r` on worktree `w`, after its root and next
    /// attempt passed. `p` is the claim-first condition (the switch, or `first` in the claim head).
    pub(super) fn claimable(
        &self,
        r: &RequestRecord,
        w: &str,
        spec: &ClaimableSpec,
        p: bool,
        lane_roots: &[String],
    ) -> Result<bool> {
        let Some(row) = read_worktree_row(self.read, w)? else {
            return Ok(false);
        };
        if !(row.owned_by(spec.host_id.as_deref()) && row.state == "active") {
            return Ok(false);
        }
        if fenced(&self.refreshes, w) || recovery_on(&self.effects, self.all, w) {
            return Ok(false);
        }
        if self.effects.iter().any(|m| {
            same(m.worktree_id.as_deref(), w)
                && m.kind == "withdrawal-mirror"
                && matches!(m.state.as_str(), "queued" | "running")
                && mirror_covers(&m.data, &r.slug)
        }) {
            return Ok(false);
        }
        let on = self.on(w);
        if on.iter().any(|e| {
            e.sequence < r.sequence
                && pending_state(e)
                && passes_queued_sync(e, r, p, lane_roots) == Some(false)
        }) {
            return Ok(false);
        }
        for e in on.iter().filter(|e| e.sequence < r.sequence) {
            if released_deferred_in(self.read, e)? {
                return Ok(false);
            }
        }
        let behind_running = on.iter().any(|a| {
            a.sequence > r.sequence
                && matches!(a.state.as_str(), "running" | "recovering")
                && !sync_kind(&a.intent)
        });
        Ok(!(p && sync_kind(&r.intent) && behind_running))
    }

    /// The lane head read's terms for candidate `r` on worktree `w` (`claimNextLaneHead`), after its state, backoff, lane
    /// and group matched: the worktree is active under `host_id` and no refresh fences it, no effect or request there
    /// carries a recovery, no withdrawal mirror is unsettled there (of any page), no earlier request is queued, recovering,
    /// a released deferred write or a running one of another run, and, with the switch on, no foreground write waits.
    pub(super) fn lane_head_open(
        &self,
        r: &RequestRecord,
        w: &str,
        host_id: &str,
        run: &str,
        spec: &ClaimableSpec,
        priority: bool,
    ) -> Result<bool> {
        let Some(row) = read_worktree_row(self.read, w)? else {
            return Ok(false);
        };
        if !(row.owned_by(Some(host_id)) && row.state == "active") {
            return Ok(false);
        }
        if fenced(&self.refreshes, w) || recovery_on(&self.effects, self.all, w) {
            return Ok(false);
        }
        if self.effects.iter().any(|m| {
            same(m.worktree_id.as_deref(), w)
                && m.kind == "withdrawal-mirror"
                && matches!(m.state.as_str(), "queued" | "running")
        }) {
            return Ok(false);
        }
        for e in self.on(w).iter().filter(|e| e.sequence < r.sequence) {
            let other_run =
                e.state == "running" && json_text(e.intent.get("lane")).unwrap_or_default() != run;
            if matches!(e.state.as_str(), "queued" | "recovering")
                || other_run
                || released_deferred_in(self.read, e)?
            {
                return Ok(false);
            }
        }
        Ok(!(priority && self.waiting_last(w, spec)?.is_some()))
    }

    /// `EXISTS (SELECT 1 FROM waiting g WHERE g.worktree_id=w AND g.last>sequence)`.
    pub(super) fn waits(&self, w: &str, sequence: u64, spec: &ClaimableSpec) -> Result<bool> {
        if let Some(last) = self.waiting.borrow().get(w) {
            return Ok(last.is_some_and(|l| l > sequence));
        }
        let last = self.waiting_last(w, spec)?;
        self.waiting.borrow_mut().insert(w.to_owned(), last);
        Ok(last.is_some_and(|l| l > sequence))
    }

    /// Whether `x` is pending, a sync row, and names row `f`'s page (`named` in the CTE).
    fn names(x: &RequestRecord, f: &RequestRecord) -> bool {
        x.sequence < f.sequence
            && pending_state(x)
            && sync_kind(&x.intent)
            && names_page(x, f) == Some(true)
    }

    /// The `waiting` CTE for worktree `w`: the newest foreground write there that a sync head
    /// waits for, or `None`.
    fn waiting_last(&self, w: &str, spec: &ClaimableSpec) -> Result<Option<u64>> {
        let on = self.on(w);
        let mut released = HashMap::new();
        for r in &on {
            released.insert(r.id.clone(), released_deferred_in(self.read, r)?);
        }
        let released = |r: &RequestRecord| released.get(&r.id).copied().unwrap_or(false);
        let mut seen: Option<i64> = None;
        let mut last: Option<u64> = None;
        for f in &on {
            let live = pending_state(f) || released(f);
            let unclaimed_here = f.state != "running"
                || (!extra_bool(f, "publication_started")
                    && json_text(
                        f.extra
                            .get("claim_phase")
                            .and_then(|p| p.get("owner"))
                            .and_then(|o| o.get("nonce")),
                    ) != spec.nonce);
            if !(live && unclaimed_here && extra_is_null(f, "recovery") && !sync_kind(&f.intent)) {
                continue;
            }
            if on.iter().any(|n| Self::names(n, f)) {
                continue;
            }
            if on.iter().any(|a| {
                a.sequence < f.sequence
                    && (a.state == "queued" || released(a))
                    && !sync_kind(&a.intent)
                    && on.iter().any(|n| Self::names(n, a))
            }) {
                continue;
            }
            let seen = match seen {
                Some(s) => s,
                None => {
                    let s = spec
                        .sync_seen
                        .get(w)
                        .map(seen_bigint)
                        .transpose()?
                        .flatten()
                        .unwrap_or(0);
                    seen = Some(s);
                    s
                }
            };
            if on.iter().any(|c| {
                i128::from(c.sequence) > i128::from(seen)
                    && c.state == "committed"
                    && !sync_kind(&c.intent)
            }) {
                continue;
            }
            last = last.max(Some(f.sequence));
        }
        Ok(last)
    }

    /// The requests on worktree `w`.
    fn on(&self, w: &str) -> Vec<&'a RequestRecord> {
        self.all
            .iter()
            .filter(|r| same(r.extra.get("worktree_id").and_then(Value::as_str), w))
            .collect()
    }
}

/// The effect claim's worktree terms (`CLAIMABLE_EFFECT_SQL`, and the idle probe's effect term):
/// an effect on worktree `w` is claimable only by the worktree's owner host, while no refresh
/// fences the worktree and no effect or request there carries a recovery. A missing worktree row
/// has no owner, so no host claims its effects.
pub(super) fn effect_claimable_on_worktree(
    read: &dyn KvRead,
    w: &str,
    host_id: &str,
    effects: &[EffectRecord],
    requests: &[RequestRecord],
    refreshes: &[RefreshRecord],
) -> Result<bool> {
    let owned = read_worktree_row(read, w)?.is_some_and(|row| row.owned_by(Some(host_id)));
    Ok(owned && !fenced(refreshes, w) && !recovery_on(effects, requests, w))
}
