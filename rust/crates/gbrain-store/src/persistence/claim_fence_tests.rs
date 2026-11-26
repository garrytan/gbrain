//! Claim fencing of the managed claim families on a multi-user store (lane LM slice 3, gate E1; I-5 rules in
//! `fence.rs`, `leases.rs`): grouped publication followers (`group_publish_store.rs`), coalesced Git effects
//! (`effect_worker.rs`), refresh rows (`refresh_store.rs`) and managed sync checkpoints (`managed_sync_store.rs`).
//!
//! Each family runs a create / renew / start / result / release / reclaim / recovery matrix through the store, on a
//! multi-user store with a hand-moved clock: a valid fence succeeds; a stale fence (its lease taken over) and a
//! replacement-epoch fence (same host, new registration epoch) refuse `lease_lost` and change nothing; a call with no fence
//! refuses `fence_missing` before anything is written; a call with no fence on a store that is not multi-user behaves as
//! it always did and writes no `~L` key.

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
    Store::open_kv(
        mem_kv(),
        Clock::new(),
        OpenOptions {
            multiuser,
            ..OpenOptions::default()
        },
    )
    .unwrap()
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
    fn a_call_with_no_fence_on_a_multiuser_store_refuses_before_anything_is_written() {
        let (s, ids) = setup(true, 2);
        let a = register(&s, "a");
        let held = claimed(&s, Some(&a));
        let before = snapshot(&s, &ids);
        let calls = [
            claim(None),
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
        ];
        for call in &calls {
            let e = s.group_write(call).unwrap_err();
            assert_eq!(reason(&e), "fence_missing", "{call:?}");
            assert_eq!(snapshot(&s, &ids), before);
        }
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
        assert_eq!(
            reason(&tx.group_write(&claim(None)).unwrap_err()),
            "fence_missing"
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
