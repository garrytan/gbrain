//! Claim fencing of the managed claim families on a multi-user store (lane LM slice 3, gate E1; I-5 rules in
//! `fence.rs`, `leases.rs`): grouped publication followers (`group_publish_store.rs`), coalesced Git effects
//! (`effect_worker.rs`), refresh rows (`refresh_store.rs`) and managed sync checkpoints (`managed_sync_store.rs`).
//!
//! Each family runs a create / renew / start / result / release / reclaim / recovery matrix through the store, on a
//! multi-user store with a hand-moved clock: a valid fence succeeds; a stale fence (its lease taken over) and a
//! replacement-epoch fence (same host, new registration epoch) refuse `lease_lost` and change nothing; a call with no fence
//! is not refused for lacking one (multi-user: an unregistered caller takes an implicit lease for a new claim and
//! refuses `held_by_another` only on a claim a live registered holder owns); a call with no fence on a store that is not
//! multi-user behaves as it always did and writes no `~L` key.

use super::WriteRequestInsert;
use crate::env::Env;
use crate::error::{LEASE_LOST, StoreError};
use crate::kv::scan_prefix;
use crate::leases::{CLAIM_EPOCH, LeaseToken, lost_reason};
use crate::test_support::mem_kv;
use crate::write_origin::WriteOrigin;
use crate::{OpenOptions, Store, keys};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

pub(super) struct Clock {
    now: AtomicI64,
    ids: AtomicU64,
}

impl Clock {
    pub(super) fn new() -> Arc<Clock> {
        Arc::new(Clock {
            now: AtomicI64::new(1_800_000_000_000_000),
            ids: AtomicU64::new(1),
        })
    }
}

impl Clock {
    pub(super) fn advance_ms(&self, ms: i64) {
        self.now.fetch_add(ms * 1000, Ordering::SeqCst);
    }
}

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn new_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, Ordering::SeqCst);
        format!("00000000-0000-4000-8000-{n:012x}")
    }
}

pub(super) fn origin(host: &str) -> WriteOrigin {
    WriteOrigin {
        host_id: format!("{host}-host"),
        incarnation: format!("{host}-incarnation"),
        writer_id: "local_cli:test".into(),
    }
}

/// A store on an in-memory file; `multiuser` as the brain was opened.
pub(super) fn open(multiuser: bool) -> Store {
    open_with_clock(multiuser).0
}

/// `open`, with the clock the test moves by hand.
pub(super) fn open_with_clock(multiuser: bool) -> (Store, Arc<Clock>) {
    let clock = Clock::new();
    let store = Store::open_kv(
        mem_kv(),
        clock.clone(),
        OpenOptions {
            multiuser,
            ..OpenOptions::default()
        },
    )
    .unwrap();
    (store, clock)
}

/// The consumer registration of host `host`: its lease token.
pub(super) fn register(s: &Store, host: &str) -> LeaseToken {
    s.acquire_lease(&format!("consumer:{host}-host"), &origin(host), 600_000)
        .unwrap()
        .unwrap()
}

/// Host `host` registers again after its lease was released: the same lease, the next epoch.
pub(super) fn register_again(s: &Store, old: &LeaseToken) -> LeaseToken {
    s.release_lease(old).unwrap();
    let host = old
        .name
        .trim_start_matches("consumer:")
        .trim_end_matches("-host");
    let fresh = s
        .acquire_lease(&old.name, &origin(host), 600_000)
        .unwrap()
        .unwrap();
    assert_eq!(fresh.epoch, old.epoch + 1);
    fresh
}

/// Another host takes the lease over: the old token is stale.
pub(super) fn take_over(s: &Store, old: &LeaseToken) -> LeaseToken {
    s.release_lease(old).unwrap();
    s.acquire_lease(&old.name, &origin("b"), 600_000)
        .unwrap()
        .unwrap()
}

pub(super) fn reason(e: &StoreError) -> String {
    assert_eq!(e.code, LEASE_LOST, "{e}");
    lost_reason(e).unwrap()
}

/// How many claim epoch records the store holds (`~L 0x05 ...`).
pub(super) fn epoch_records(s: &Store) -> usize {
    let mut prefix = keys::LEASES.to_vec();
    prefix.push(CLAIM_EPOCH);
    let read = s.read().unwrap();
    let mut n = 0;
    scan_prefix(&*read, &prefix, false, &mut |_, _| {
        n += 1;
        true
    })
    .unwrap();
    n
}

/// Every `~L` key in the store: a plain store with no fence never writes one.
pub(super) fn lease_keys(s: &Store) -> usize {
    let read = s.read().unwrap();
    let mut n = 0;
    scan_prefix(&*read, &keys::LEASES, false, &mut |_, _| {
        n += 1;
        true
    })
    .unwrap();
    n
}

pub(super) fn request_id(n: u8) -> String {
    format!("b0000000-0000-4000-8000-0000000000{n:02x}")
}

// ---------------------------------------------------------------------------------------------
// Grouped publication followers.

mod group {
    use super::*;
    use crate::persistence::GroupWrite;
    use crate::persistence::worktree_rows::rows::put_worktree;
    use crate::persistence::{CounterRecord, write_counter};

    const WT: &str = "f0000000-0000-4000-8000-0000000000a1";
    const HOST: &str = "a0000000-0000-4000-8000-0000000000a1";
    const GROUP: &str = "sync:G";

    fn admit(s: &Store, n: u8, intent: Value) -> String {
        let incarnation =
            s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
        let input: WriteRequestInsert = serde_json::from_value(json!({
            "principalKind": "local_cli", "principalId": "p1", "requestId": request_id(n),
            "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation, "slug": format!("notes/n{n}"),
            "digest": "d", "intent": intent, "authority": {}, "intentBytes": 10, "terminalReservation": 4096,
            "targetKind": "page", "protocolVersion": 1, "admitterVersion": "v", "counterKeys": ["brain"], "state": "queued",
            "worktreeId": WT,
        }))
        .unwrap();
        s.insert_write_request(&input).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// A store with a worktree, a counter and a head plus `n` followers of group `G`.
    fn setup(multiuser: bool, followers: u8) -> (Store, Vec<String>) {
        let s = open(multiuser);
        s.write(|tx| put_worktree(tx, WT, Some(HOST), "active"))
            .unwrap();
        s.write(|tx| write_counter(tx, "brain", &CounterRecord::default()))
            .unwrap();
        // The head is a different group (a lone foreground write), then the followers of `G`.
        admit(&s, 0, json!({ "kind": "put_page" }));
        let ids = (1..=followers)
            .map(|n| admit(&s, n, json!({ "group": "G" })))
            .collect();
        (s, ids)
    }

    fn claim(fence: Option<&LeaseToken>) -> GroupWrite {
        serde_json::from_value(json!({
            "kind": "claim_followers", "worktreeId": WT, "headSequence": "1", "group": GROUP, "max": 10, "leaseMs": 30000.0,
            "owner": { "pid": 1 }, "fence": fence,
        }))
        .unwrap()
    }

    fn claimed(s: &Store, fence: Option<&LeaseToken>) -> Vec<(String, String)> {
        s.group_write(&claim(fence))
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["id"].as_str().unwrap().to_owned(),
                    r["execution_token"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    fn members(held: &[(String, String)]) -> Value {
        json!(
            held.iter()
                .map(|(id, token)| json!({ "id": id, "token": token, "stamp": null }))
                .collect::<Vec<_>>()
        )
    }

    fn completions(held: &[(String, String)]) -> Value {
        json!(
            held.iter()
                .map(|(id, token)| json!({ "id": id, "token": token, "outcome": "{\"ok\":true}", "need": 100,
                    "principalKey": "brain", "retained": 0 }))
                .collect::<Vec<_>>()
        )
    }

    fn write(kind: &str, mut body: Value, fence: Option<&LeaseToken>) -> GroupWrite {
        body["kind"] = json!(kind);
        body["fence"] = json!(fence);
        serde_json::from_value(body).unwrap()
    }

    fn complete(held: &[(String, String)], fence: Option<&LeaseToken>) -> GroupWrite {
        write(
            "complete_group",
            json!({ "members": completions(held), "version": "v", "hostId": HOST }),
            fence,
        )
    }

    /// Every request row and the counter: what a refusal must leave alone.
    fn snapshot(s: &Store, ids: &[String]) -> Value {
        json!({
            "rows": ids.iter().map(|id| s.read_write_request_by_id(id).unwrap()).collect::<Vec<_>>(),
            "counters": s.read_counter_rows(&["brain".to_owned()]).unwrap(),
            "epochs": epoch_records(s),
        })
    }

    #[test]
    fn a_valid_fenced_group_completes_every_member_and_ends_their_claims() {
        let (s, ids) = setup(true, 3);
        let a = register(&s, "a");
        let held = claimed(&s, Some(&a));
        assert_eq!(held.len(), 3);
        assert_eq!(epoch_records(&s), 3, "one CLAIM_WRITE record per follower");
        let before = s.read_counter_rows(&["brain".to_owned()]).unwrap();
        let done = s.group_write(&complete(&held, Some(&a))).unwrap();
        assert_eq!(done.as_array().unwrap().len(), 3);
        for id in &ids {
            assert_eq!(
                s.read_write_request_by_id(id).unwrap().unwrap()["state"],
                "committed"
            );
        }
        assert_eq!(epoch_records(&s), 0, "a finished claim clears its record");
        let after = s.read_counter_rows(&["brain".to_owned()]).unwrap();
        assert_ne!(before, after, "the counters were released");
    }

    #[test]
    fn a_stale_fence_refuses_every_claim_entry_and_changes_nothing() {
        let (s, ids) = setup(true, 3);
        let a = register(&s, "a");
        let held = claimed(&s, Some(&a));
        let stale = a.clone();
        let _b = take_over(&s, &a);
        let before = snapshot(&s, &ids);
        let calls = [
            claim(Some(&stale)),
            write(
                "renew_claims",
                json!({ "members": members(&held), "leaseMs": 1000.0 }),
                Some(&stale),
            ),
            write(
                "mark_dispatched",
                json!({ "members": members(&held) }),
                Some(&stale),
            ),
            write(
                "start_publication",
                json!({ "members": members(&held) }),
                Some(&stale),
            ),
            complete(&held, Some(&stale)),
            write(
                "record_recoveries",
                json!({ "members": held.iter().map(|(id, token)| json!({ "id": id, "token": token, "record": {"k": 1}, "bytes": 5 })).collect::<Vec<_>>(),
                    "total": 15, "counterKeys": ["brain"] }),
                Some(&stale),
            ),
            write(
                "clear_recoveries",
                json!({ "resolved": [], "counterKeys": ["brain"], "worktreeId": WT }),
                Some(&stale),
            ),
        ];
        for call in &calls {
            let e = s.group_write(call).unwrap_err();
            assert_eq!(reason(&e), "epoch_moved", "{call:?}");
            assert_eq!(snapshot(&s, &ids), before, "{call:?} changed something");
        }
    }

    #[test]
    fn a_replacement_epoch_of_the_same_host_cannot_finish_or_renew_the_old_claim() {
        let (s, ids) = setup(true, 3);
        let a1 = register(&s, "a");
        let held = claimed(&s, Some(&a1));
        let a2 = register_again(&s, &a1);
        let before = snapshot(&s, &ids);
        let calls = [
            complete(&held, Some(&a2)),
            write(
                "renew_claims",
                json!({ "members": members(&held), "leaseMs": 1000.0 }),
                Some(&a2),
            ),
            write(
                "mark_dispatched",
                json!({ "members": members(&held) }),
                Some(&a2),
            ),
            write(
                "start_publication",
                json!({ "members": members(&held) }),
                Some(&a2),
            ),
            write(
                "record_recoveries",
                json!({ "members": held.iter().map(|(id, token)| json!({ "id": id, "token": token, "record": {"k": 1}, "bytes": 5 })).collect::<Vec<_>>(),
                    "total": 15, "counterKeys": ["brain"] }),
                Some(&a2),
            ),
        ];
        for call in &calls {
            let e = s.group_write(call).unwrap_err();
            assert_eq!(reason(&e), "claim_epoch_mismatch", "{call:?}");
            assert_eq!(snapshot(&s, &ids), before, "{call:?} changed something");
        }
        // The old registration is no longer held either: it refuses before it reaches the claims.
        let e = s.group_write(&complete(&held, Some(&a1))).unwrap_err();
        assert_eq!(reason(&e), "epoch_moved");
        assert_eq!(snapshot(&s, &ids), before);
    }

    #[test]
    fn the_whole_lifecycle_renews_starts_records_and_clears_under_the_claim_epoch() {
        let (s, ids) = setup(true, 2);
        let a = register(&s, "a");
        let held = claimed(&s, Some(&a));
        let r = s
            .group_write(&write(
                "renew_claims",
                json!({ "members": members(&held), "leaseMs": 1000.0 }),
                Some(&a),
            ))
            .unwrap();
        assert_eq!(r.as_array().unwrap().len(), 2);
        let m = s
            .group_write(&write(
                "mark_dispatched",
                json!({ "members": members(&held) }),
                Some(&a),
            ))
            .unwrap();
        assert_eq!(m.as_array().unwrap().len(), 2);
        let st = s
            .group_write(&write(
                "start_publication",
                json!({ "members": members(&held) }),
                Some(&a),
            ))
            .unwrap();
        assert_eq!(st.as_array().unwrap().len(), 2);
        let rec = s
            .group_write(&write(
                "record_recoveries",
                json!({ "members": held.iter().map(|(id, token)| json!({ "id": id, "token": token, "record": {"k": 1}, "bytes": 5 })).collect::<Vec<_>>(),
                    "total": 10, "counterKeys": ["brain"] }),
                Some(&a),
            ))
            .unwrap();
        assert_eq!(rec.as_array().unwrap().len(), 2);
        // Terminal rows (complete them) and clear the recoveries.
        s.group_write(&complete(&held, Some(&a))).unwrap();
        let cleared = s
            .group_write(&write(
                "clear_recoveries",
                json!({ "resolved": ids.iter().map(|id| json!({ "id": id, "record": {"k": 1} })).collect::<Vec<_>>(),
                    "counterKeys": ["brain"], "worktreeId": WT }),
                Some(&a),
            ))
            .unwrap();
        assert_eq!(cleared.as_array().unwrap().len(), 2);
        assert_eq!(epoch_records(&s), 0);
    }

    #[test]
    fn a_follower_released_and_claimed_again_takes_a_new_claim_and_the_old_holder_cannot_finish_it()
    {
        let (s, ids) = setup(true, 2);
        let a = register(&s, "a");
        let old = claimed(&s, Some(&a));
        for (id, token) in &old {
            assert!(
                s.release_unpublished_claim(
                    &serde_json::from_value(
                        json!({ "id": id, "token": token, "reason": "r", "fence": a })
                    )
                    .unwrap()
                )
                .unwrap()
            );
        }
        assert_eq!(epoch_records(&s), 0, "a released claim clears its record");
        let c = register(&s, "c");
        let fresh = claimed(&s, Some(&c));
        assert_eq!(fresh.len(), 2);
        let before = snapshot(&s, &ids);
        // The old holder's execution token no longer holds: nothing completes and nothing changes.
        let done = s.group_write(&complete(&old, Some(&a))).unwrap();
        assert!(done.as_array().unwrap().is_empty());
        assert_eq!(snapshot(&s, &ids), before);
        // The new claimer's epoch record is its own: the old fence with the new token refuses.
        let mixed: Vec<(String, String)> = fresh.clone();
        let e = s.group_write(&complete(&mixed, Some(&a))).unwrap_err();
        assert_eq!(reason(&e), "claim_epoch_mismatch");
        assert_eq!(snapshot(&s, &ids), before);
        assert_eq!(
            s.group_write(&complete(&fresh, Some(&c)))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn a_call_with_no_fence_on_a_multiuser_store_is_not_refused_for_lacking_one_but_cannot_touch_a_live_holders_claim()
     {
        let (s, ids) = setup(true, 2);
        let a = register(&s, "a");
        let held = claimed(&s, Some(&a));
        let before = snapshot(&s, &ids);
        // Nothing is queued, so a claim with no fence takes nothing (no host registered is not a refusal).
        assert!(
            s.group_write(&claim(None))
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(snapshot(&s, &ids), before);
        let calls = [
            complete(&held, None),
            write(
                "renew_claims",
                json!({ "members": members(&held), "leaseMs": 1000.0 }),
                None,
            ),
            write(
                "mark_dispatched",
                json!({ "members": members(&held) }),
                None,
            ),
            write(
                "start_publication",
                json!({ "members": members(&held) }),
                None,
            ),
        ];
        for call in &calls {
            let e = s.group_write(call).unwrap_err();
            assert_eq!(reason(&e), "held_by_another", "{call:?}");
            assert_eq!(snapshot(&s, &ids), before);
        }
        // A call that names no claim has nothing to refuse.
        for call in [
            write(
                "record_recoveries",
                json!({ "members": [], "total": 0, "counterKeys": [] }),
                None,
            ),
            write(
                "clear_recoveries",
                json!({ "resolved": [], "counterKeys": [], "worktreeId": null }),
                None,
            ),
        ] {
            s.group_write(&call).unwrap();
        }
        assert_eq!(snapshot(&s, &ids), before);
    }

    #[test]
    fn a_later_member_that_refuses_rolls_back_every_earlier_member_and_the_counters() {
        let (s, ids) = setup(true, 3);
        let a = register(&s, "a");
        let held = claimed(&s, Some(&a));
        // The last member's claim was taken under another registration (its record names it).
        let other = register(&s, "other");
        s.write(|tx| {
            crate::leases::record_claim_epoch(
                tx,
                crate::leases::CLAIM_WRITE,
                &held[2].0.to_lowercase(),
                &other,
            )
        })
        .unwrap();
        let before = snapshot(&s, &ids);
        let e = s.group_write(&complete(&held, Some(&a))).unwrap_err();
        assert_eq!(reason(&e), "claim_epoch_mismatch");
        assert_eq!(
            snapshot(&s, &ids),
            before,
            "no earlier member and no counter changed"
        );
        // The same group inside an explicit transaction: the refusal leaves the transaction's own view unchanged too.
        let tx = s.begin_transaction(false).unwrap();
        let e = tx.group_write(&complete(&held, Some(&a))).unwrap_err();
        assert_eq!(reason(&e), "claim_epoch_mismatch");
        assert_eq!(snapshot(&tx, &ids), before);
        tx.rollback_transaction().unwrap();
        assert_eq!(snapshot(&s, &ids), before);
    }

    #[test]
    fn the_bound_transaction_route_runs_the_guards_and_commits_a_valid_group() {
        let (s, ids) = setup(true, 2);
        let a = register(&s, "a");
        // A valid fence inside an explicit transaction: claim, complete, commit.
        let tx = s.begin_transaction(false).unwrap();
        let held = claimed(&tx, Some(&a));
        assert_eq!(held.len(), 2);
        assert_eq!(epoch_records(&tx), 2);
        assert_eq!(
            tx.group_write(&complete(&held, Some(&a)))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        tx.commit_transaction().unwrap();
        assert_eq!(
            s.read_write_request_by_id(&ids[0]).unwrap().unwrap()["state"],
            "committed"
        );
        assert_eq!(epoch_records(&s), 0);
        // A stale fence and a missing fence refuse inside the transaction, which then rolls back unchanged.
        let (s, ids) = setup(true, 2);
        let a = register(&s, "a");
        let stale = a.clone();
        take_over(&s, &a);
        let before = snapshot(&s, &ids);
        let tx = s.begin_transaction(false).unwrap();
        assert_eq!(
            reason(&tx.group_write(&claim(Some(&stale))).unwrap_err()),
            "epoch_moved"
        );
        // A claim with no fence is not refused for lacking one: it takes the queued members under an implicit lease,
        // and the rollback leaves the store as it was.
        assert_eq!(
            tx.group_write(&claim(None))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        tx.rollback_transaction().unwrap();
        assert_eq!(snapshot(&s, &ids), before);
    }

    #[test]
    fn with_multiuser_off_and_no_fence_the_calls_are_what_they_were_and_write_no_lease_key() {
        let (s, ids) = setup(false, 3);
        let held = claimed(&s, None);
        assert_eq!(held.len(), 3);
        for call in [
            write(
                "renew_claims",
                json!({ "members": members(&held), "leaseMs": 1000.0 }),
                None,
            ),
            write(
                "mark_dispatched",
                json!({ "members": members(&held) }),
                None,
            ),
            write(
                "start_publication",
                json!({ "members": members(&held) }),
                None,
            ),
        ] {
            assert_eq!(s.group_write(&call).unwrap().as_array().unwrap().len(), 3);
        }
        assert_eq!(
            s.group_write(&complete(&held, None))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            3
        );
        for id in &ids {
            assert_eq!(
                s.read_write_request_by_id(id).unwrap().unwrap()["state"],
                "committed"
            );
        }
        assert_eq!(lease_keys(&s), 0, "no ~L key without a fence");
    }
}

// ---------------------------------------------------------------------------------------------
// Coalesced Git effects.

mod effect {
    use super::*;
    use crate::persistence::effects::all_effects;
    use crate::persistence::worktree_rows::rows::put_worktree;
    use crate::persistence::{
        CoalescedGitClaim, EffectSettle, GitEffectWrite, PublicationEffectsSpec, Settle,
    };

    const WT: &str = "f0000000-0000-4000-8000-0000000000a1";
    const HOST: &str = "a0000000-0000-4000-8000-0000000000a1";

    /// A store with a worktree owned by HOST and `n` queued single-file Git effects (one request each).
    fn setup(multiuser: bool, n: u8) -> (Store, Arc<Clock>) {
        let (s, clock) = open_with_clock(multiuser);
        s.write(|tx| put_worktree(tx, WT, Some(HOST), "active"))
            .unwrap();
        let incarnation =
            s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
        for i in 1..=n {
            let input: WriteRequestInsert = serde_json::from_value(json!({
                "principalKind": "local_cli", "principalId": "p1", "requestId": request_id(i),
                "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation, "slug": format!("notes/n{i}"),
                "digest": "d", "intent": { "kind": "put_page" }, "authority": {}, "intentBytes": 1, "terminalReservation": 4096,
                "targetKind": "page", "protocolVersion": 1, "admitterVersion": "v", "counterKeys": [], "state": "committed",
                "worktreeId": WT,
            }))
            .unwrap();
            let row_id = s.insert_write_request(&input).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let spec: PublicationEffectsSpec =
                serde_json::from_value(json!({ "requestId": row_id, "revision": null,
                "sourceId": "default", "sourceIncarnation": incarnation, "worktreeId": WT,
                "effects": [{ "kind": "git", "data": { "relative_path": format!("n{i}.md") } }] }))
                .unwrap();
            s.insert_publication_effects(&spec).unwrap();
        }
        (s, clock)
    }

    fn input(fence: Option<&LeaseToken>) -> CoalescedGitClaim {
        serde_json::from_value(json!({ "hostId": HOST, "worktreeId": WT, "limit": 10,
            "ownerJson": json!({ "pid": 1 }).to_string(), "fence": fence }))
        .unwrap()
    }

    /// The claimed effects: id and execution token.
    fn claim(s: &Store, fence: Option<&LeaseToken>) -> Vec<(String, String)> {
        s.claim_coalesced_git_effects(&input(fence))
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["id"].as_str().unwrap().to_owned(),
                    r["execution_token"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    fn refs(held: &[(String, String)]) -> Vec<Value> {
        held.iter()
            .map(|(id, token)| json!({ "id": id, "token": token }))
            .collect()
    }

    fn write(kind: &str, held: &[(String, String)], fence: Option<&LeaseToken>) -> GitEffectWrite {
        let mut body = json!({ "kind": kind, "claims": refs(held), "fence": fence });
        if kind == "yield_to_publications" {
            body["delayMs"] = json!(1000.0);
        } else {
            body["outcomeJson"] = json!("{\"ok\":true}");
        }
        serde_json::from_value(body).unwrap()
    }

    fn settle(id: &str, token: &str, fence: Option<&LeaseToken>) -> EffectSettle {
        serde_json::from_value(
            json!({ "id": id, "token": token, "outcomeJson": "{}", "fence": fence }),
        )
        .unwrap()
    }

    fn snapshot(s: &Store) -> (Value, usize) {
        (
            json!(
                all_effects(&*s.read().unwrap())
                    .unwrap()
                    .iter()
                    .map(|e| e.to_row())
                    .collect::<Vec<_>>()
            ),
            epoch_records(s),
        )
    }

    #[test]
    fn a_coalesced_claim_records_its_epoch_and_settles_only_under_it() {
        let (s, _) = setup(true, 3);
        let a = register(&s, "a");
        let held = claim(&s, Some(&a));
        assert_eq!(held.len(), 3);
        assert_eq!(
            epoch_records(&s),
            3,
            "one CLAIM_EFFECT record per claimed effect"
        );
        for (id, token) in &held {
            assert!(
                s.settle_effect(Settle::Renew, &settle(id, token, Some(&a)))
                    .unwrap()
            );
        }
        for (id, token) in &held {
            assert!(
                s.settle_effect(Settle::Complete, &settle(id, token, Some(&a)))
                    .unwrap()
            );
        }
        assert_eq!(epoch_records(&s), 0, "a settled claim clears its record");
    }

    #[test]
    fn the_git_group_yield_and_plain_outcome_run_under_the_claim_epoch_and_end_it() {
        let (s, _) = setup(true, 4);
        let a = register(&s, "a");
        let held = claim(&s, Some(&a));
        assert_eq!(held.len(), 4);
        s.git_effect_write(&write("yield_to_publications", &held[..2], Some(&a)))
            .unwrap();
        assert_eq!(epoch_records(&s), 2, "the yielded claims ended");
        s.git_effect_write(&write("record_plain_outcome", &held[2..], Some(&a)))
            .unwrap();
        assert_eq!(epoch_records(&s), 0);
        let states: Vec<String> = all_effects(&*s.read().unwrap())
            .unwrap()
            .iter()
            .map(|e| e.state.clone())
            .collect();
        assert_eq!(states, ["queued", "queued", "committed", "committed"]);
    }

    #[test]
    fn a_stale_fence_refuses_the_claim_the_settle_and_the_git_writes_and_changes_nothing() {
        let (s, _) = setup(true, 3);
        let a = register(&s, "a");
        let held = claim(&s, Some(&a));
        let stale = a.clone();
        take_over(&s, &a);
        let before = snapshot(&s);
        let e = s
            .claim_coalesced_git_effects(&input(Some(&stale)))
            .unwrap_err();
        assert_eq!(reason(&e), "epoch_moved");
        for action in [Settle::Renew, Settle::Complete, Settle::Retry, Settle::Fail] {
            let e = s
                .settle_effect(action, &settle(&held[0].0, &held[0].1, Some(&stale)))
                .unwrap_err();
            assert_eq!(reason(&e), "epoch_moved", "{action:?}");
        }
        for kind in ["yield_to_publications", "record_plain_outcome"] {
            let e = s
                .git_effect_write(&write(kind, &held, Some(&stale)))
                .unwrap_err();
            assert_eq!(reason(&e), "epoch_moved", "{kind}");
        }
        assert_eq!(snapshot(&s), before);
    }

    #[test]
    fn a_replacement_epoch_of_the_same_host_cannot_settle_or_release_the_old_claim() {
        let (s, _) = setup(true, 3);
        let a1 = register(&s, "a");
        let held = claim(&s, Some(&a1));
        let a2 = register_again(&s, &a1);
        let before = snapshot(&s);
        let e = s
            .settle_effect(Settle::Complete, &settle(&held[0].0, &held[0].1, Some(&a2)))
            .unwrap_err();
        assert_eq!(reason(&e), "claim_epoch_mismatch");
        for kind in ["yield_to_publications", "record_plain_outcome"] {
            let e = s
                .git_effect_write(&write(kind, &held, Some(&a2)))
                .unwrap_err();
            assert_eq!(reason(&e), "claim_epoch_mismatch", "{kind}");
        }
        assert_eq!(snapshot(&s), before);
    }

    #[test]
    fn a_later_claim_that_refuses_rolls_back_every_earlier_effect() {
        let (s, _) = setup(true, 3);
        let a = register(&s, "a");
        let held = claim(&s, Some(&a));
        let other = register(&s, "other");
        s.write(|tx| {
            crate::leases::record_claim_epoch(tx, crate::leases::CLAIM_EFFECT, &held[2].0, &other)
        })
        .unwrap();
        let before = snapshot(&s);
        for kind in ["yield_to_publications", "record_plain_outcome"] {
            let e = s
                .git_effect_write(&write(kind, &held, Some(&a)))
                .unwrap_err();
            assert_eq!(reason(&e), "claim_epoch_mismatch", "{kind}");
            assert_eq!(snapshot(&s), before, "{kind}: the earlier effects stayed");
        }
    }

    #[test]
    fn a_reclaim_after_expiry_takes_a_new_claim_and_the_old_holder_cannot_settle_it() {
        let (s, clock) = setup(true, 2);
        let a = register(&s, "a");
        let old = claim(&s, Some(&a));
        assert_eq!(old.len(), 2);
        clock.advance_ms(3 * 60 * 1000);
        let c = register(&s, "c");
        let fresh = claim(&s, Some(&c));
        assert_eq!(fresh.len(), 2, "the expired claims were reclaimed");
        let before = snapshot(&s);
        // The old execution token no longer holds: nothing settles.
        assert!(
            !s.settle_effect(Settle::Complete, &settle(&old[0].0, &old[0].1, Some(&c)))
                .unwrap()
        );
        assert_eq!(snapshot(&s), before);
        // The new claim carries the new epoch; the old fence with the new token refuses.
        let e = s
            .settle_effect(
                Settle::Complete,
                &settle(&fresh[0].0, &fresh[0].1, Some(&a)),
            )
            .unwrap_err();
        assert!(matches!(
            reason(&e).as_str(),
            "claim_epoch_mismatch" | "epoch_moved" | "expired"
        ));
        assert!(
            s.settle_effect(
                Settle::Complete,
                &settle(&fresh[0].0, &fresh[0].1, Some(&c))
            )
            .unwrap()
        );
    }

    #[test]
    fn a_call_with_no_fence_on_a_multiuser_store_is_not_refused_for_lacking_one_but_cannot_touch_a_live_holders_claim()
     {
        let (s, _) = setup(true, 2);
        let a = register(&s, "a");
        let held = claim(&s, Some(&a));
        let before = snapshot(&s);
        // Every effect is held, so a claim with no fence takes nothing (and is not refused).
        assert!(
            s.claim_coalesced_git_effects(&input(None))
                .unwrap()
                .is_empty()
        );
        for kind in ["yield_to_publications", "record_plain_outcome"] {
            let e = s.git_effect_write(&write(kind, &held, None)).unwrap_err();
            assert_eq!(reason(&e), "held_by_another", "{kind}");
        }
        assert_eq!(snapshot(&s), before);
    }

    #[test]
    fn with_multiuser_off_and_no_fence_the_calls_are_what_they_were_and_write_no_lease_key() {
        let (s, _) = setup(false, 3);
        let held = claim(&s, None);
        assert_eq!(held.len(), 3);
        s.git_effect_write(&write("yield_to_publications", &held[..1], None))
            .unwrap();
        s.git_effect_write(&write("record_plain_outcome", &held[1..2], None))
            .unwrap();
        assert!(
            s.settle_effect(Settle::Complete, &settle(&held[2].0, &held[2].1, None))
                .unwrap()
        );
        assert_eq!(lease_keys(&s), 0, "no ~L key without a fence");
    }

    #[test]
    fn the_bound_transaction_route_runs_the_guards() {
        let (s, _) = setup(true, 2);
        let a = register(&s, "a");
        let tx = s.begin_transaction(false).unwrap();
        let held = claim(&tx, Some(&a));
        assert_eq!(held.len(), 2);
        assert_eq!(epoch_records(&tx), 2);
        tx.git_effect_write(&write("record_plain_outcome", &held, Some(&a)))
            .unwrap();
        tx.commit_transaction().unwrap();
        assert_eq!(epoch_records(&s), 0);
        // A stale fence refuses inside a transaction, which rolls back unchanged; a missing one is not refused.
        let (s, _) = setup(true, 2);
        let a = register(&s, "a");
        let stale = a.clone();
        take_over(&s, &a);
        let before = snapshot(&s);
        let tx = s.begin_transaction(false).unwrap();
        assert_eq!(
            reason(
                &tx.claim_coalesced_git_effects(&input(Some(&stale)))
                    .unwrap_err()
            ),
            "epoch_moved"
        );
        // A call with no fence is not refused for lacking one: it takes the queued effects under an implicit lease,
        // and the rollback leaves the store as it was.
        assert_eq!(
            tx.claim_coalesced_git_effects(&input(None)).unwrap().len(),
            2
        );
        tx.rollback_transaction().unwrap();
        assert_eq!(snapshot(&s), before);
    }
}

// ---------------------------------------------------------------------------------------------
// Refresh rows.

mod refresh {
    use super::*;
    use crate::persistence::worktree_rows::rows::put_worktree;
    use crate::persistence::{ClaimStamp, RefreshRead, RefreshWrite};

    const WT: &str = "d0000000-0000-4000-8000-0000000000d1";
    const HOST: &str = "a0000000-0000-4000-8000-0000000000a1";
    const PRINCIPAL: &str = "b0000000-0000-4000-8000-0000000000b1";

    fn setup(multiuser: bool) -> Store {
        let s = open(multiuser);
        s.write(|tx| put_worktree(tx, WT, Some(HOST), "active"))
            .unwrap();
        s
    }

    fn write(kind: &str, mut body: Value, fence: Option<&LeaseToken>) -> RefreshWrite {
        body["kind"] = json!(kind);
        body["fence"] = json!(fence);
        serde_json::from_value(body).unwrap()
    }

    fn insert(fence: Option<&LeaseToken>) -> RefreshWrite {
        write(
            "insert_draining",
            json!({ "worktreeId": WT, "sourceIds": ["default"], "principalId": PRINCIPAL, "ownerEpoch": "1",
                "topologyGeneration": "1", "oldHead": "aaa", "targetHead": "bbb", "upstreamRef": "origin/main",
                "preserved": [], "outcome": { "holder": { "pid": 1 } } }),
            fence,
        )
    }

    fn start(s: &Store, fence: Option<&LeaseToken>) -> String {
        s.refresh_write(&insert(fence)).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    fn transition(id: &str, from: &[&str], to: &str, fence: Option<&LeaseToken>) -> RefreshWrite {
        let terminal = matches!(to, "completed" | "aborted");
        write(
            "transition",
            json!({ "id": id, "from": from, "to": to, "outcome": {}, "terminal": terminal }),
            fence,
        )
    }

    fn row(s: &Store, id: &str) -> Value {
        s.refresh_rows(&RefreshRead::Row { id: id.into() }).unwrap()
    }

    fn snapshot(s: &Store, id: &str) -> (Value, usize) {
        (row(s, id), epoch_records(s))
    }

    fn state(s: &Store, id: &str) -> String {
        row(s, id)["state"].as_str().unwrap().to_owned()
    }

    /// The mutations a fenced holder makes on a `fenced` row, as calls.
    fn mutations(id: &str, fence: Option<&LeaseToken>) -> Vec<RefreshWrite> {
        vec![
            transition(id, &["fenced"], "merged", fence),
            write(
                "replan",
                json!({ "id": id, "oldHead": "ccc", "targetHead": "ddd" }),
                fence,
            ),
            write(
                "mark_merge_started",
                json!({ "id": id, "atMs": 5.0 }),
                fence,
            ),
        ]
    }

    #[test]
    fn a_refresh_is_claimed_at_insert_checked_on_every_move_and_ended_at_the_terminal_state() {
        let s = setup(true);
        let a = register(&s, "a");
        let id = start(&s, Some(&a));
        assert_eq!(epoch_records(&s), 1, "one CLAIM_REFRESH record: the row id");
        assert_eq!(
            s.refresh_write(&transition(&id, &["draining"], "fenced", Some(&a)))
                .unwrap(),
            json!(true)
        );
        assert_eq!(
            s.refresh_write(&write(
                "replan",
                json!({ "id": id, "oldHead": "ccc", "targetHead": "ddd" }),
                Some(&a)
            ))
            .unwrap()["target_head"],
            "ddd"
        );
        assert_eq!(
            s.refresh_write(&write(
                "mark_merge_started",
                json!({ "id": id, "atMs": 5.0 }),
                Some(&a)
            ))
            .unwrap(),
            json!(true)
        );
        for (from, to) in [("fenced", "merged"), ("merged", "syncing")] {
            assert_eq!(
                s.refresh_write(&transition(&id, &[from], to, Some(&a)))
                    .unwrap(),
                json!(true)
            );
            assert_eq!(
                epoch_records(&s),
                1,
                "the claim stays while the row is active"
            );
        }
        s.refresh_write(&write(
            "set_holder",
            json!({ "id": id, "holder": { "pid": 2 } }),
            Some(&a),
        ))
        .unwrap();
        assert_eq!(
            s.refresh_write(&transition(&id, &["syncing"], "completed", Some(&a)))
                .unwrap(),
            json!(true)
        );
        assert_eq!(state(&s, &id), "completed");
        assert_eq!(epoch_records(&s), 0, "a terminal state ends the claim");
    }

    #[test]
    fn a_stale_fence_refuses_every_refresh_write_and_changes_nothing() {
        let s = setup(true);
        let a = register(&s, "a");
        let id = start(&s, Some(&a));
        s.refresh_write(&transition(&id, &["draining"], "fenced", Some(&a)))
            .unwrap();
        let stale = a.clone();
        take_over(&s, &a);
        let before = snapshot(&s, &id);
        let mut calls = mutations(&id, Some(&stale));
        calls.push(write(
            "set_holder",
            json!({ "id": id, "holder": { "pid": 2 } }),
            Some(&stale),
        ));
        calls.push(write("adopt_claim", json!({ "id": id }), Some(&stale)));
        calls.push(insert(Some(&stale)));
        for call in &calls {
            let e = s.refresh_write(call).unwrap_err();
            assert_eq!(reason(&e), "epoch_moved", "{call:?}");
            assert_eq!(snapshot(&s, &id), before, "{call:?} changed something");
        }
    }

    #[test]
    fn a_replacement_epoch_cannot_move_the_old_row_until_it_adopts_it() {
        let s = setup(true);
        let a1 = register(&s, "a");
        let id = start(&s, Some(&a1));
        s.refresh_write(&transition(&id, &["draining"], "fenced", Some(&a1)))
            .unwrap();
        let a2 = register_again(&s, &a1);
        let before = snapshot(&s, &id);
        for call in mutations(&id, Some(&a2)) {
            let e = s.refresh_write(&call).unwrap_err();
            assert_eq!(reason(&e), "claim_epoch_mismatch", "{call:?}");
            assert_eq!(snapshot(&s, &id), before, "{call:?} changed something");
        }
        // Explicit adoption takes a new claim; the move then goes through.
        assert_eq!(
            s.refresh_write(&write("adopt_claim", json!({ "id": id }), Some(&a2)))
                .unwrap(),
            json!(true)
        );
        assert_eq!(
            s.refresh_write(&transition(&id, &["fenced"], "merged", Some(&a2)))
                .unwrap(),
            json!(true)
        );
    }

    #[test]
    fn a_new_holder_adopts_the_row_and_the_old_live_holder_is_then_refused() {
        let s = setup(true);
        let a = register(&s, "a");
        let c = register(&s, "c");
        let id = start(&s, Some(&a));
        // Adoption by set_holder (the caller becomes the holder).
        s.refresh_write(&write(
            "set_holder",
            json!({ "id": id, "holder": { "pid": 9 } }),
            Some(&c),
        ))
        .unwrap();
        assert_eq!(
            epoch_records(&s),
            1,
            "the record was overwritten, not added"
        );
        let before = snapshot(&s, &id);
        let e = s
            .refresh_write(&transition(&id, &["draining"], "fenced", Some(&a)))
            .unwrap_err();
        assert_eq!(reason(&e), "claim_epoch_mismatch");
        assert_eq!(snapshot(&s, &id), before);
        assert_eq!(
            s.refresh_write(&transition(&id, &["draining"], "fenced", Some(&c)))
                .unwrap(),
            json!(true)
        );
        // Adoption by adopt_claim, then abandonment ends the claim.
        let d = register(&s, "d");
        assert_eq!(
            s.refresh_write(&write("adopt_claim", json!({ "id": id }), Some(&d)))
                .unwrap(),
            json!(true)
        );
        s.refresh_write(&transition(&id, &["fenced"], "aborted", Some(&d)))
            .unwrap();
        assert_eq!(epoch_records(&s), 0);
        // A finished row is adopted by nobody.
        assert_eq!(
            s.refresh_write(&write("adopt_claim", json!({ "id": id }), Some(&d)))
                .unwrap(),
            json!(false)
        );
        assert_eq!(epoch_records(&s), 0);
    }

    #[test]
    fn a_call_with_no_fence_on_a_multiuser_store_is_not_refused_for_lacking_one_but_cannot_touch_a_live_holders_claim()
     {
        let s = setup(true);
        let a = register(&s, "a");
        let id = start(&s, Some(&a));
        s.refresh_write(&transition(&id, &["draining"], "fenced", Some(&a)))
            .unwrap();
        let before = snapshot(&s, &id);
        // A write on a row a live registered holder claimed refuses, and nothing changes.
        for call in &mutations(&id, None) {
            let e = s.refresh_write(call).unwrap_err();
            assert_eq!(reason(&e), "held_by_another", "{call:?}");
            assert_eq!(snapshot(&s, &id), before);
        }
        // A call that names no claim a live holder owns is not refused for lacking a fence.
        s.refresh_write(&write(
            "hold_for_import",
            json!({ "id": request_id(1), "token": "t", "importFrom": "x" }),
            None,
        ))
        .unwrap();
        assert_eq!(snapshot(&s, &id), before);
        s.refresh_write(&insert(None)).unwrap();
    }

    /// A running request claimed under `fence`; returns its row id and token.
    fn running_request(s: &Store, fence: Option<&LeaseToken>) -> (String, String) {
        let incarnation =
            s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
        let input: crate::persistence::WriteRequestInsert = serde_json::from_value(json!({
            "principalKind": "local_cli", "principalId": "p1", "requestId": request_id(1),
            "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation, "slug": "notes/n1",
            "digest": "d", "intent": { "kind": "put_page" }, "authority": {}, "intentBytes": 1, "terminalReservation": 4096,
            "targetKind": "page", "protocolVersion": 1, "admitterVersion": "v", "counterKeys": [], "state": "queued",
            "worktreeId": WT,
        }))
        .unwrap();
        let id = s.insert_write_request(&input).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let token = "c0000000-0000-4000-8000-0000000000c1".to_owned();
        let stamp: ClaimStamp =
            serde_json::from_value(json!({ "id": id, "token": token, "leaseMs": 30000.0,
            "phaseJson": "{\"phase\":\"preparing\"}", "fence": fence }))
            .unwrap();
        s.stamp_write_claim(&stamp).unwrap().unwrap();
        (id, token)
    }

    #[test]
    fn holding_a_claimed_write_for_an_import_releases_its_claim_under_the_epoch_it_was_taken_with()
    {
        let s = setup(true);
        let a1 = register(&s, "a");
        let (id, token) = running_request(&s, Some(&a1));
        assert_eq!(epoch_records(&s), 1);
        let hold = |fence: Option<&LeaseToken>| {
            write(
                "hold_for_import",
                json!({ "id": id, "token": token, "importFrom": "abc" }),
                fence,
            )
        };
        let a2 = register_again(&s, &a1);
        let before = (s.read_write_request_by_id(&id).unwrap(), epoch_records(&s));
        let e = s.refresh_write(&hold(Some(&a2))).unwrap_err();
        assert_eq!(reason(&e), "claim_epoch_mismatch");
        let e = s.refresh_write(&hold(Some(&a1))).unwrap_err();
        assert_eq!(reason(&e), "epoch_moved");
        assert_eq!(
            (s.read_write_request_by_id(&id).unwrap(), epoch_records(&s)),
            before
        );
        // The holder of the claim holds the write: the claim is released with the move to `deferred`.
        let (s, a) = {
            let s = setup(true);
            let a = register(&s, "a");
            (s, a)
        };
        let (id, token) = running_request(&s, Some(&a));
        let row = s
            .refresh_write(&write(
                "hold_for_import",
                json!({ "id": id, "token": token, "importFrom": "abc" }),
                Some(&a),
            ))
            .unwrap();
        assert_eq!(row["state"], "deferred");
        assert_eq!(
            epoch_records(&s),
            0,
            "the released claim cleared its record"
        );
    }

    #[test]
    fn the_bound_transaction_route_runs_the_guards() {
        let s = setup(true);
        let a = register(&s, "a");
        let tx = s.begin_transaction(false).unwrap();
        let id = start(&tx, Some(&a));
        assert_eq!(epoch_records(&tx), 1);
        tx.refresh_write(&transition(&id, &["draining"], "aborted", Some(&a)))
            .unwrap();
        tx.commit_transaction().unwrap();
        assert_eq!(state(&s, &id), "aborted");
        assert_eq!(epoch_records(&s), 0);
        // A stale and a missing fence refuse inside a transaction; it rolls back unchanged.
        let s = setup(true);
        let a = register(&s, "a");
        let id = start(&s, Some(&a));
        let stale = a.clone();
        take_over(&s, &a);
        let before = snapshot(&s, &id);
        let tx = s.begin_transaction(false).unwrap();
        let e = tx
            .refresh_write(&transition(&id, &["draining"], "aborted", Some(&stale)))
            .unwrap_err();
        assert_eq!(reason(&e), "epoch_moved");
        let e = tx
            .refresh_write(&transition(&id, &["draining"], "aborted", None))
            .unwrap_err();
        assert_eq!(reason(&e), "held_by_another");
        tx.rollback_transaction().unwrap();
        assert_eq!(snapshot(&s, &id), before);
    }

    #[test]
    fn with_multiuser_off_and_no_fence_the_calls_are_what_they_were_and_write_no_lease_key() {
        let s = setup(false);
        let id = start(&s, None);
        for (from, to) in [
            ("draining", "fenced"),
            ("fenced", "merged"),
            ("merged", "completed"),
        ] {
            assert_eq!(
                s.refresh_write(&transition(&id, &[from], to, None))
                    .unwrap(),
                json!(true)
            );
        }
        s.refresh_write(&write(
            "set_holder",
            json!({ "id": id, "holder": { "pid": 2 } }),
            None,
        ))
        .unwrap();
        assert_eq!(
            s.refresh_write(&write("adopt_claim", json!({ "id": id }), None))
                .unwrap(),
            json!(false)
        );
        let (rid, token) = running_request(&s, None);
        s.refresh_write(&write(
            "hold_for_import",
            json!({ "id": rid, "token": token, "importFrom": "abc" }),
            None,
        ))
        .unwrap();
        assert_eq!(lease_keys(&s), 0, "no ~L key without a fence");
    }
}

// ---------------------------------------------------------------------------------------------
// Managed sync checkpoints.

mod sync {
    use super::*;

    const OP: &str = "managed-sync";
    const MANIFEST: &str = "managed-sync-manifest";
    const KEY: &str = "cursor-1";

    fn header(index: u64, done: bool) -> String {
        json!([{ "runId": "run-1", "index": index, "total": 3, "done": done }]).to_string()
    }

    fn call(
        s: &Store,
        name: &str,
        params: Vec<Value>,
        fence: Option<&LeaseToken>,
    ) -> crate::error::Result<Value> {
        s.sync_store_write_fenced(name, &params, fence)
    }

    fn insert(s: &Store, fence: Option<&LeaseToken>) -> crate::error::Result<Value> {
        call(
            s,
            "cursor_insert",
            vec![json!(OP), json!(KEY), json!(header(0, false))],
            fence,
        )
    }

    fn swap(
        s: &Store,
        from: u64,
        to: u64,
        fence: Option<&LeaseToken>,
    ) -> crate::error::Result<Value> {
        call(
            s,
            "cursor_swap",
            vec![
                json!(OP),
                json!(KEY),
                json!(header(from, false)),
                json!(header(to, false)),
            ],
            fence,
        )
    }

    fn adopt(s: &Store, fence: Option<&LeaseToken>) -> crate::error::Result<Value> {
        call(s, "checkpoint_touch", vec![json!(OP), json!(KEY)], fence)
    }

    fn mark_done(s: &Store, fence: Option<&LeaseToken>) -> crate::error::Result<Value> {
        call(s, "cursor_mark_done", vec![json!(KEY)], fence)
    }

    fn finish_delete(s: &Store, fence: Option<&LeaseToken>) -> crate::error::Result<Value> {
        call(s, "finished_cursor_delete", vec![json!(KEY)], fence)
    }

    fn cursor(s: &Store) -> Value {
        s.sync_store_rows("checkpoint_keys", &[json!(OP), json!(KEY)])
            .unwrap()
    }

    fn snapshot(s: &Store) -> (Value, usize) {
        (cursor(s), epoch_records(s))
    }

    /// Every fenced statement as a call, for the refusal tests.
    fn every(s: &Store, fence: Option<&LeaseToken>) -> Vec<crate::error::Result<Value>> {
        vec![
            insert(s, fence),
            swap(s, 0, 1, fence),
            adopt(s, fence),
            mark_done(s, fence),
            finish_delete(s, fence),
        ]
    }

    #[test]
    fn a_cursor_is_claimed_at_insert_checked_on_every_swap_and_ended_when_it_is_done_and_deleted() {
        let s = open(true);
        let a = register(&s, "a");
        assert_eq!(insert(&s, Some(&a)).unwrap().as_array().unwrap().len(), 1);
        assert_eq!(epoch_records(&s), 1, "one CLAIM_SYNC_CHECKPOINT record");
        // A second insert of the same key loses and takes nothing.
        let c = register(&s, "c");
        assert!(insert(&s, Some(&c)).unwrap().as_array().unwrap().is_empty());
        assert_eq!(epoch_records(&s), 1);
        assert_eq!(
            swap(&s, 0, 1, Some(&a)).unwrap().as_array().unwrap().len(),
            1
        );
        assert_eq!(
            swap(&s, 1, 2, Some(&a)).unwrap().as_array().unwrap().len(),
            1
        );
        // A manifest touch has no claim: it runs with no fence and writes no record.
        call(
            &s,
            "checkpoint_touch",
            vec![json!(MANIFEST), json!("run-1")],
            None,
        )
        .unwrap();
        assert_eq!(epoch_records(&s), 1);
        mark_done(&s, Some(&a)).unwrap();
        assert_eq!(epoch_records(&s), 0, "a finished cursor ends its claim");
        assert_eq!(
            finish_delete(&s, Some(&a))
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(cursor(&s), json!([]));
    }

    #[test]
    fn a_stale_fence_refuses_every_checkpoint_statement_and_changes_nothing() {
        let s = open(true);
        let a = register(&s, "a");
        insert(&s, Some(&a)).unwrap();
        let stale = a.clone();
        take_over(&s, &a);
        let before = snapshot(&s);
        for result in every(&s, Some(&stale)) {
            assert_eq!(reason(&result.unwrap_err()), "epoch_moved");
            assert_eq!(snapshot(&s), before);
        }
    }

    #[test]
    fn a_replacement_epoch_cannot_swap_the_old_cursor_until_it_adopts_it() {
        let s = open(true);
        let a1 = register(&s, "a");
        insert(&s, Some(&a1)).unwrap();
        let a2 = register_again(&s, &a1);
        let before = snapshot(&s);
        assert_eq!(
            reason(&swap(&s, 0, 1, Some(&a2)).unwrap_err()),
            "claim_epoch_mismatch"
        );
        assert_eq!(snapshot(&s), before);
        // A swap that would lose (another value) writes nothing and has no claim to check.
        assert!(
            swap(&s, 7, 8, Some(&a2))
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        // The explicit adoption takes a new claim, overwriting the record; the swap then goes through.
        adopt(&s, Some(&a2)).unwrap();
        assert_eq!(epoch_records(&s), 1);
        assert_eq!(
            swap(&s, 0, 1, Some(&a2)).unwrap().as_array().unwrap().len(),
            1
        );
        // A second live holder adopts it again: the first is then refused.
        let c = register(&s, "c");
        adopt(&s, Some(&c)).unwrap();
        assert_eq!(
            reason(&swap(&s, 1, 2, Some(&a2)).unwrap_err()),
            "claim_epoch_mismatch"
        );
        assert_eq!(
            swap(&s, 1, 2, Some(&c)).unwrap().as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn a_call_with_no_fence_on_a_multiuser_store_is_not_refused_for_lacking_one_but_cannot_touch_a_live_holders_claim()
     {
        let s = open(true);
        let a = register(&s, "a");
        insert(&s, Some(&a)).unwrap();
        let before = snapshot(&s);
        // A swap of a cursor a live registered holder owns refuses, and nothing changes; a losing insert takes nothing.
        assert_eq!(
            reason(&swap(&s, 0, 1, None).unwrap_err()),
            "held_by_another"
        );
        assert!(insert(&s, None).unwrap().as_array().unwrap().is_empty());
        assert_eq!(snapshot(&s), before);
        // The explicit adoption, the done mark and the delete name no claim to check: none is refused for lacking a fence.
        for result in [
            adopt(&s, None),
            mark_done(&s, None),
            finish_delete(&s, None),
        ] {
            result.unwrap();
        }
    }

    #[test]
    fn deleting_or_purging_a_cursor_ends_its_claim() {
        let s = open(true);
        let a = register(&s, "a");
        insert(&s, Some(&a)).unwrap();
        assert_eq!(epoch_records(&s), 1);
        s.delete_op_checkpoint(OP, KEY).unwrap();
        assert_eq!(epoch_records(&s), 0);
        // A row that is not a sync cursor never had a claim.
        insert(&s, Some(&a)).unwrap();
        s.delete_op_checkpoint("embed", "f1").unwrap();
        assert_eq!(epoch_records(&s), 1);
    }

    #[test]
    fn the_bound_transaction_route_runs_the_guards() {
        let s = open(true);
        let a = register(&s, "a");
        let tx = s.begin_transaction(false).unwrap();
        insert(&tx, Some(&a)).unwrap();
        swap(&tx, 0, 1, Some(&a)).unwrap();
        assert_eq!(epoch_records(&tx), 1);
        tx.commit_transaction().unwrap();
        assert_eq!(epoch_records(&s), 1);
        let stale = a.clone();
        take_over(&s, &a);
        let before = snapshot(&s);
        let tx = s.begin_transaction(false).unwrap();
        assert_eq!(
            reason(&swap(&tx, 1, 2, Some(&stale)).unwrap_err()),
            "epoch_moved"
        );
        assert_eq!(
            reason(&swap(&tx, 1, 2, None).unwrap_err()),
            "held_by_another"
        );
        tx.rollback_transaction().unwrap();
        assert_eq!(snapshot(&s), before);
    }

    #[test]
    fn with_multiuser_off_and_no_fence_the_calls_are_what_they_were_and_write_no_lease_key() {
        let s = open(false);
        assert_eq!(insert(&s, None).unwrap().as_array().unwrap().len(), 1);
        assert_eq!(swap(&s, 0, 1, None).unwrap().as_array().unwrap().len(), 1);
        adopt(&s, None).unwrap();
        mark_done(&s, None).unwrap();
        assert_eq!(
            finish_delete(&s, None).unwrap().as_array().unwrap().len(),
            1
        );
        s.delete_op_checkpoint(OP, KEY).unwrap();
        assert_eq!(lease_keys(&s), 0, "no ~L key without a fence");
    }
}
