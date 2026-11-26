//! The lane head claim, the reclaim of a released write and the effect recovery claim (`lane_head.rs`,
//! `effect_worker.rs`): each case writes the rows as the store keeps them and checks what the Postgres statement answers
//! (`LANE_HEAD`, `LANE_HEAD_STAMP_SQL`, `RECLAIM_RELEASED_SQL`, `CLAIM_EFFECT_RECOVERY_SQL` in
//! `src/core/engine-sql/persistence-claims.ts` and `persistence-effect-worker.ts`).

use super::effects::{EffectRecord, all_effects, write_effect};
use super::lane_head::LaneHeadSpec;
use super::worktree_admission::{RefreshRecord, put_refresh};
use super::worktree_rows::rows::put_worktree;
use super::{ClaimStamp, EffectClaim, PublicationEffectsSpec, WriteRequestInsert};
use crate::journal::{RequestRecord, write_request};
use crate::test_support::store;
use crate::{Store, get_json, keys};
use serde_json::{Map, Value, json};

const WT: &str = "f0000000-0000-4000-8000-0000000000a1";
const OTHER_WT: &str = "f0000000-0000-4000-8000-0000000000a2";
const HOST: &str = "a0000000-0000-4000-8000-0000000000a1";
const OTHER_HOST: &str = "a0000000-0000-4000-8000-0000000000a2";
const RUN: &str = "run-1";
const TOKEN: &str = "c0000000-0000-4000-8000-0000000000c1";

fn request_id(n: u8) -> String {
    format!("b0000000-0000-4000-8000-0000000000{n:02x}")
}

fn worktree(s: &Store, id: &str, owner: Option<&str>, state: &str) {
    s.write(|tx| put_worktree(tx, id, owner, state)).unwrap();
}

/// Admits a queued request whose intent is `intent`; returns its row id.
fn admit_intent(s: &Store, n: u8, worktree: &str, intent: Value) -> String {
    let incarnation = s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
    let input: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "p1", "requestId": request_id(n),
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation, "slug": format!("notes/n{n}"), "digest": "d",
        "intent": intent, "authority": {}, "intentBytes": 1, "terminalReservation": 4096, "targetKind": "page",
        "protocolVersion": 1, "admitterVersion": "v", "counterKeys": [], "state": "queued", "worktreeId": worktree,
    }))
    .unwrap();
    s.insert_write_request(&input).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// A lane group head of `run`: the intent names the lane and the request itself as its group.
fn lane_head(s: &Store, n: u8, run: &str) -> String {
    admit_intent(
        s,
        n,
        WT,
        json!({ "kind": "managed_sync_import", "lane": run, "group": request_id(n) }),
    )
}

fn foreground(s: &Store, n: u8) -> String {
    admit_intent(s, n, WT, json!({ "kind": "put_page" }))
}

fn edit(s: &Store, id: &str, f: impl Fn(&mut RequestRecord)) {
    s.write(|tx| {
        let mut r: RequestRecord = get_json(&*tx, &keys::request(id))?.unwrap();
        f(&mut r);
        write_request(tx, &r)
    })
    .unwrap();
}

fn spec(extra: Value) -> LaneHeadSpec {
    let mut v = json!({ "hostId": HOST, "worktreeId": WT, "run": RUN, "nonce": "nonce-1", "priority": false });
    if let (Value::Object(m), Value::Object(e)) = (&mut v, extra) {
        m.extend(e);
    }
    serde_json::from_value(v).unwrap()
}

fn picked(s: &Store, spec: &LaneHeadSpec) -> Option<String> {
    s.select_claimable_lane_head(spec)
        .unwrap()
        .map(|r| r["id"].as_str().unwrap().to_owned())
}

fn stamp(id: &str) -> ClaimStamp {
    serde_json::from_value(json!({ "id": id, "token": TOKEN, "leaseMs": 30000.0, "phaseJson": "{\"phase\":\"preparing\"}" })).unwrap()
}

fn setup() -> Store {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    s
}

#[test]
fn the_head_of_a_lane_group_is_claimed_in_order_and_stamped_with_the_newest_sequence() {
    let s = setup();
    let a = lane_head(&s, 1, RUN);
    let b = lane_head(&s, 2, RUN);
    assert_eq!(picked(&s, &spec(json!({}))), Some(a.clone()));
    let claimed = s.stamp_lane_head_claim(&stamp(&a)).unwrap().unwrap();
    assert_eq!(claimed["state"], json!("running"));
    assert_eq!(claimed["execution_token"], json!(TOKEN));
    assert_eq!(claimed["claim_phase"], json!({ "phase": "preparing" }));
    assert!(
        claimed.get("passed_sync").is_none(),
        "RETURNING * carries no passed_sync"
    );
    assert_eq!(claimed["seen_sequence"], json!(claimed_sequence(&s, &b)));
    // A running head of the same run does not block the next head.
    assert_eq!(picked(&s, &spec(json!({}))), Some(b.clone()));
    s.stamp_lane_head_claim(&stamp(&b)).unwrap().unwrap();
    assert_eq!(picked(&s, &spec(json!({}))), None, "nothing is left queued");
    assert_eq!(
        s.stamp_lane_head_claim(&stamp("b1111111-0000-4000-8000-000000000000"))
            .unwrap(),
        None,
        "an unknown id"
    );
}

fn claimed_sequence(s: &Store, id: &str) -> String {
    s.read_write_request_by_id(id).unwrap().unwrap()["sequence"]
        .to_string()
        .trim_matches('"')
        .to_owned()
}

#[test]
fn only_a_row_of_this_run_that_heads_its_own_group_on_this_hosts_active_worktree_is_a_head() {
    let s = setup();
    admit_intent(
        &s,
        1,
        WT,
        json!({ "kind": "managed_sync_import", "lane": RUN, "group": request_id(9) }),
    );
    assert_eq!(
        picked(&s, &spec(json!({}))),
        None,
        "a follower names another request as its group"
    );
    let head = lane_head(&s, 2, RUN);
    // The follower queued before it blocks it (an earlier queued row), so a head is claimable only once the follower is gone.
    assert_eq!(
        picked(&s, &spec(json!({}))),
        None,
        "an earlier queued follower"
    );
    edit(
        &s,
        s.read_write_request_by_id(&head).unwrap().unwrap()["id"]
            .as_str()
            .unwrap(),
        |_| {},
    );
    let other_run = spec(json!({ "run": "run-2" }));
    assert_eq!(picked(&s, &other_run), None, "another run's heads");
    assert_eq!(
        picked(&s, &spec(json!({ "hostId": OTHER_HOST }))),
        None,
        "another host"
    );
    assert_eq!(
        picked(&s, &spec(json!({ "worktreeId": OTHER_WT }))),
        None,
        "another worktree"
    );
    worktree(&s, WT, Some(HOST), "draining");
    assert_eq!(picked(&s, &spec(json!({}))), None, "not active");
    assert!(
        s.select_claimable_lane_head(
            &serde_json::from_value(
                json!({ "hostId": "nope", "worktreeId": WT, "run": RUN, "nonce": "n" })
            )
            .unwrap()
        )
        .is_err(),
        "$1::uuid"
    );
}

#[test]
fn an_earlier_queued_recovering_released_or_other_run_request_blocks_the_head() {
    let s = setup();
    let early = foreground(&s, 1);
    let head = lane_head(&s, 2, RUN);
    assert_eq!(
        picked(&s, &spec(json!({}))),
        None,
        "an earlier queued write"
    );
    edit(&s, &early, |r| r.state = "running".into());
    edit(&s, &early, |r| {
        r.intent["lane"] = json!("run-2");
    });
    assert_eq!(
        picked(&s, &spec(json!({}))),
        None,
        "an earlier running request of another run"
    );
    edit(&s, &early, |r| {
        r.intent["lane"] = json!(RUN);
    });
    assert_eq!(
        picked(&s, &spec(json!({}))),
        Some(head.clone()),
        "an earlier running request of the same run"
    );
    edit(&s, &early, |r| r.state = "recovering".into());
    assert_eq!(
        picked(&s, &spec(json!({}))),
        None,
        "an earlier recovering request"
    );
    edit(&s, &early, |r| r.state = "committed".into());
    assert_eq!(picked(&s, &spec(json!({}))), Some(head.clone()));
    edit(&s, &early, |r| {
        r.state = "failed".into();
        r.extra.insert("recovery".into(), json!({ "step": 1 }));
    });
    assert_eq!(
        picked(&s, &spec(json!({}))),
        None,
        "a recovery record on the worktree"
    );
}

#[test]
fn a_fence_a_withdrawal_mirror_a_recovering_effect_and_a_backoff_hold_the_head() {
    let s = setup();
    let head = lane_head(&s, 1, RUN);
    let fence = |state: &str| {
        let f = RefreshRecord {
            id: "c0000000-0000-4000-8000-0000000000f1".into(),
            worktree_id: WT.into(),
            source_ids: vec!["default".into()],
            state: state.into(),
            target_head: "abc".into(),
            outcome: Map::new(),
            created_at_us: 0,
            updated_at_us: 0,
            completed_at_us: None,
            released_at_us: None,
            extra: Map::new(),
        };
        s.write(|tx| put_refresh(tx, &f)).unwrap();
    };
    for state in ["fenced", "merged", "recovery_required"] {
        fence(state);
        assert_eq!(picked(&s, &spec(json!({}))), None, "{state}");
    }
    fence("draining");
    assert_eq!(picked(&s, &spec(json!({}))), Some(head.clone()));

    let incarnation = s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
    let effect = |kind: &str, data: Value| {
        let row_id = get_json::<RequestRecord>(&*s.read().unwrap(), &keys::request(&head))
            .unwrap()
            .unwrap()
            .id;
        let spec: PublicationEffectsSpec = serde_json::from_value(json!({ "requestId": row_id, "revision": null, "sourceId": "default",
            "sourceIncarnation": incarnation, "worktreeId": WT, "effects": [{ "kind": kind, "data": data }] })).unwrap();
        s.insert_publication_effects(&spec).unwrap();
    };
    effect(
        "withdrawal-mirror",
        json!({ "targets": [{ "slug": "notes/other" }] }),
    );
    assert_eq!(
        picked(&s, &spec(json!({}))),
        None,
        "an unsettled mirror holds the lane head whatever page it covers"
    );
    let edit_effects = |f: &dyn Fn(&mut EffectRecord)| {
        s.write(|tx| {
            for mut e in all_effects(&*tx)? {
                f(&mut e);
                write_effect(tx, &e)?;
            }
            Ok(())
        })
        .unwrap()
    };
    edit_effects(&|e| e.state = "committed".into());
    assert_eq!(
        picked(&s, &spec(json!({}))),
        Some(head.clone()),
        "a committed mirror holds nothing"
    );
    edit_effects(&|e| e.recovery = Some(json!({ "step": 1 })));
    assert_eq!(
        picked(&s, &spec(json!({}))),
        None,
        "an effect on the worktree recovers"
    );
    edit_effects(&|e| e.recovery = None);
    edit(&s, &head, |r| {
        r.extra.insert(
            "next_attempt_at".into(),
            json!(crate::env::iso(32_503_680_000_000_000)),
        );
    });
    assert_eq!(
        picked(&s, &spec(json!({}))),
        None,
        "its backoff has not elapsed"
    );
}

#[test]
fn a_waiting_foreground_write_holds_the_head_until_a_foreground_commit_newer_than_the_seen_sequence()
 {
    let s = setup();
    let head = lane_head(&s, 1, RUN);
    let fg = foreground(&s, 2);
    assert_eq!(
        picked(&s, &spec(json!({ "priority": true }))),
        None,
        "a foreground write that may go first waits"
    );
    assert_eq!(
        picked(&s, &spec(json!({ "priority": false }))),
        Some(head.clone()),
        "the switch off"
    );
    // The foreground write was claimed by this process (same nonce) and has begun nothing: the head still waits for another process's.
    edit(&s, &fg, |r| {
        r.state = "running".into();
        r.extra.insert(
            "claim_phase".into(),
            json!({ "owner": { "nonce": "nonce-1" } }),
        );
    });
    assert_eq!(
        picked(&s, &spec(json!({ "priority": true }))),
        Some(head.clone()),
        "this process's own claim does not hold its lane"
    );
    edit(&s, &fg, |r| {
        r.extra.insert(
            "claim_phase".into(),
            json!({ "owner": { "nonce": "nonce-2" } }),
        );
    });
    assert_eq!(
        picked(&s, &spec(json!({ "priority": true }))),
        None,
        "another process's unstarted claim waits"
    );
    edit(&s, &fg, |r| r.state = "committed".into());
    assert_eq!(
        picked(&s, &spec(json!({ "priority": true, "seenSequence": "0" }))),
        Some(head.clone()),
        "a commit after the seen sequence earns the lane a head"
    );
    assert!(
        s.select_claimable_lane_head(&spec(json!({ "seenSequence": "abc" })))
            .is_err(),
        "$4::bigint"
    );
}

#[test]
fn a_released_write_is_reclaimed_only_while_queued_without_a_recovery_and_past_its_backoff() {
    let s = setup();
    let id = foreground(&s, 1);
    edit(&s, &id, |r| {
        r.extra.insert(
            "next_attempt_at".into(),
            json!(crate::env::iso(32_503_680_000_000_000)),
        );
    });
    assert_eq!(
        s.reclaim_released_write(&stamp(&id)).unwrap(),
        None,
        "before its backoff"
    );
    edit(&s, &id, |r| {
        r.extra.remove("next_attempt_at");
        r.extra.insert("recovery".into(), json!({ "step": 1 }));
    });
    assert_eq!(
        s.reclaim_released_write(&stamp(&id)).unwrap(),
        None,
        "a recovery record"
    );
    edit(&s, &id, |r| {
        r.extra.remove("recovery");
    });
    let claimed = s.reclaim_released_write(&stamp(&id)).unwrap().unwrap();
    assert_eq!(claimed["state"], json!("running"));
    assert_eq!(claimed["execution_token"], json!(TOKEN));
    assert_eq!(claimed["blocked_reason"], Value::Null);
    assert!(claimed.get("passed_sync").is_none() && claimed.get("seen_sequence").is_none());
    assert_eq!(
        s.reclaim_released_write(&stamp(&id)).unwrap(),
        None,
        "already running"
    );
    assert_eq!(
        s.reclaim_released_write(&stamp("b1111111-0000-4000-8000-000000000000"))
            .unwrap(),
        None
    );
    assert!(
        s.reclaim_released_write(
            &serde_json::from_value(json!({ "id": "nope", "token": TOKEN, "leaseMs": 1.0 }))
                .unwrap()
        )
        .is_err(),
        "$1::uuid"
    );
}

#[test]
fn an_effect_is_claimed_for_recovery_only_while_it_holds_a_recovery_record() {
    let s = setup();
    let request = foreground(&s, 1);
    let incarnation = s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone();
    let row_id = get_json::<RequestRecord>(&*s.read().unwrap(), &keys::request(&request))
        .unwrap()
        .unwrap()
        .id;
    let queued: PublicationEffectsSpec = serde_json::from_value(json!({ "requestId": row_id, "revision": null, "sourceId": "default",
        "sourceIncarnation": incarnation, "worktreeId": WT, "effects": [{ "kind": "withdrawal-mirror", "data": {} }] })).unwrap();
    s.insert_publication_effects(&queued).unwrap();
    let effect_id = all_effects(&*s.read().unwrap()).unwrap()[0].id.to_string();
    let claim = || EffectClaim {
        id: effect_id.clone(),
        token: TOKEN.into(),
        owner_json: json!({ "token": TOKEN, "owner": { "pid": 1 } }).to_string(),
        fence: None,
    };
    assert_eq!(
        s.claim_effect_recovery(&claim()).unwrap(),
        None,
        "no recovery record"
    );
    let edit_effects = |f: &dyn Fn(&mut EffectRecord)| {
        s.write(|tx| {
            for mut e in all_effects(&*tx)? {
                f(&mut e);
                write_effect(tx, &e)?;
            }
            Ok(())
        })
        .unwrap()
    };
    edit_effects(&|e| e.recovery = Some(json!({ "step": 1 })));
    let claimed = s.claim_effect_recovery(&claim()).unwrap().unwrap();
    assert_eq!(claimed["state"], json!("running"));
    assert_eq!(claimed["execution_token"], json!(TOKEN));
    assert_eq!(claimed["attempts"], json!(1));
    assert_eq!(
        claimed["claim_owner"],
        json!({ "token": TOKEN, "owner": { "pid": 1 } })
    );
    assert_eq!(
        s.claim_effect_recovery(&EffectClaim {
            id: "999999".into(),
            ..claim()
        })
        .unwrap(),
        None,
        "no such effect"
    );
    assert!(
        s.claim_effect_recovery(&EffectClaim {
            token: "nope".into(),
            ..claim()
        })
        .is_err(),
        "$2::uuid"
    );
}

#[test]
fn a_transient_interruption_is_charged_to_the_claim_that_holds_it_and_schedules_the_backoff() {
    use super::TransientCharge;
    let s = setup();
    let id = foreground(&s, 1);
    let charge = |token: Option<&str>| -> TransientCharge {
        serde_json::from_value(
            json!({ "id": id, "token": token, "baseMs": 1000.0, "maxMs": 15000.0 }),
        )
        .unwrap()
    };
    assert_eq!(
        s.charge_transient_interruption(&charge(Some(TOKEN)))
            .unwrap(),
        None,
        "a queued request holds no claim"
    );
    s.stamp_lane_head_claim(&stamp(&id)).unwrap().unwrap();
    assert_eq!(
        s.charge_transient_interruption(&charge(None)).unwrap(),
        None,
        "a null token matches nothing"
    );
    assert_eq!(
        s.charge_transient_interruption(&charge(Some("c0000000-0000-4000-8000-0000000000c2")))
            .unwrap(),
        None,
        "another token"
    );
    assert_eq!(
        s.charge_transient_interruption(&charge(Some(TOKEN)))
            .unwrap(),
        Some(json!({ "transient_interruptions": 1 }))
    );
    let row = s.read_write_request_by_id(&id).unwrap().unwrap();
    assert!(
        row["next_attempt_at"].is_string(),
        "the next claim is scheduled"
    );
    assert_eq!(
        s.charge_transient_interruption(&charge(Some(&TOKEN.to_uppercase())))
            .unwrap(),
        Some(json!({ "transient_interruptions": 2 }))
    );
    assert!(
        s.charge_transient_interruption(&charge(Some("nope")))
            .is_err(),
        "$2::uuid"
    );
}
