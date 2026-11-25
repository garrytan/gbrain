//! The claim, scan and probe terms that read a request's or an effect's worktree row
//! (`write_claim_terms.rs`, `worktree_rows.rs`): each case writes the binding's rows as
//! `worktrees.rs` stores them and checks what the Postgres statement answers.

use super::effects::WithdrawalEffectsSpec;
use super::effects::{EffectRecord, all_effects, write_effect};
use super::worktree_admission::{RefreshRecord, put_refresh};
use super::worktree_rows::rows::{put_source_binding, put_worktree};
use crate::journal::{RequestRecord, write_request};
use crate::persistence::{ClaimableSpec, ExpireClaims, PublicationEffectsSpec, WriteRequestInsert};
use crate::test_support::store;
use crate::{Store, get_json, keys};
use serde_json::{Map, Value, json};

const WT: &str = "f0000000-0000-4000-8000-0000000000a1";
const OTHER_WT: &str = "f0000000-0000-4000-8000-0000000000a2";
const HOST: &str = "a0000000-0000-4000-8000-0000000000a1";
const OTHER_HOST: &str = "a0000000-0000-4000-8000-0000000000a2";

fn incarnation(s: &Store) -> Value {
    s.read_source_membership("default").unwrap().unwrap()["incarnation"].clone()
}

fn worktree(s: &Store, id: &str, owner: Option<&str>, state: &str) {
    s.write(|tx| put_worktree(tx, id, owner, state)).unwrap();
}

/// Admits a queued write; `n` picks its request id.
fn admit(s: &Store, n: u8, worktree: Option<&str>, slug: &str, kind: &str) -> String {
    let input: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "p1", "requestId": format!("b0000000-0000-4000-8000-0000000000{n:02x}"),
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation(s), "slug": slug, "digest": "d",
        "intent": { "kind": kind }, "authority": {}, "intentBytes": 1, "terminalReservation": 4096, "targetKind": "page",
        "protocolVersion": 1, "admitterVersion": "v", "counterKeys": [], "state": "queued", "worktreeId": worktree,
    }))
    .unwrap();
    s.insert_write_request(&input).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn edit(s: &Store, id: &str, f: impl Fn(&mut RequestRecord)) {
    s.write(|tx| {
        let mut r: RequestRecord = get_json(&*tx, &keys::request(id))?.unwrap();
        f(&mut r);
        write_request(tx, &r)
    })
    .unwrap();
}

fn effect(s: &Store, request: &str, worktree: Option<&str>, kind: &str, data: Value) {
    let request_id = get_json::<RequestRecord>(&*s.read().unwrap(), &keys::request(request))
        .unwrap()
        .unwrap()
        .id;
    let spec: PublicationEffectsSpec = serde_json::from_value(json!({
        "requestId": request_id, "revision": null, "sourceId": "default", "sourceIncarnation": incarnation(s),
        "worktreeId": worktree, "effects": [{ "kind": kind, "data": data }],
    }))
    .unwrap();
    s.insert_publication_effects(&spec).unwrap();
}

fn edit_effects(s: &Store, f: impl Fn(&mut EffectRecord)) {
    s.write(|tx| {
        for mut e in all_effects(&*tx)? {
            f(&mut e);
            write_effect(tx, &e)?;
        }
        Ok(())
    })
    .unwrap();
}

fn refresh(s: &Store, worktree: &str, state: &str) {
    let f = RefreshRecord {
        id: "c0000000-0000-4000-8000-0000000000f1".into(),
        worktree_id: worktree.into(),
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
}

fn spec(host: &str, extra: Value) -> ClaimableSpec {
    let mut v = json!({ "hostId": host, "priority": false });
    if let (Value::Object(m), Value::Object(e)) = (&mut v, extra) {
        m.extend(e);
    }
    serde_json::from_value(v).unwrap()
}

/// The id the claim head picks for `spec`, or `None`. `hasClaimableWrite` is the claimable test
/// alone, without the head's lane, FIFO and sync-wait terms, so it must agree with the head when
/// the spec turns none of them on.
fn head(s: &Store, spec: &ClaimableSpec) -> Option<String> {
    let row = s.select_claimable_write(spec).unwrap();
    let plain = spec.fifo_roots.is_empty()
        && spec.lane_roots.is_empty()
        && spec.sync_seen.is_empty()
        && spec.nonce.is_none()
        && spec.priority != Some(true);
    if plain {
        assert_eq!(
            s.has_claimable_write(spec).unwrap(),
            row.is_some(),
            "the probe agrees with the head"
        );
    }
    row.map(|r| r["id"].as_str().unwrap().to_owned())
}

#[test]
fn an_insert_naming_a_worktree_needs_its_row() {
    let s = store();
    let input: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "p1", "requestId": "b0000000-0000-4000-8000-0000000000e1",
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation(&s), "slug": "notes/a", "digest": "d",
        "intent": {}, "authority": {}, "intentBytes": 1, "terminalReservation": 4096, "targetKind": "page",
        "protocolVersion": 1, "admitterVersion": "v", "counterKeys": [], "state": "queued", "worktreeId": WT,
    }))
    .unwrap();
    let err = s.insert_write_request(&input).unwrap_err();
    assert!(
        err.message.contains("names no persistence_worktrees row"),
        "{}",
        err.message
    );
    worktree(&s, WT, Some(HOST), "active");
    assert_eq!(
        s.insert_write_request(&input).unwrap()["worktree_id"],
        json!(WT)
    );
}

#[test]
fn only_the_owner_claims_a_write_on_an_active_worktree() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    let id = admit(&s, 1, Some(WT), "notes/a", "put");
    assert_eq!(head(&s, &spec(HOST, json!({}))), Some(id.clone()));
    assert_eq!(
        head(&s, &spec(&HOST.to_uppercase(), json!({}))),
        Some(id.clone()),
        "the uuid compares as a uuid"
    );
    assert_eq!(head(&s, &spec(OTHER_HOST, json!({}))), None, "another host");
    worktree(&s, WT, None, "active");
    assert_eq!(head(&s, &spec(HOST, json!({}))), None, "no owner");
    worktree(&s, WT, Some(HOST), "draining");
    assert_eq!(head(&s, &spec(HOST, json!({}))), None, "not active");
}

#[test]
fn a_fence_or_a_recovery_on_the_worktree_holds_its_writes() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    worktree(&s, OTHER_WT, Some(HOST), "active");
    let id = admit(&s, 1, Some(WT), "notes/a", "put");
    for state in ["fenced", "merged", "recovery_required"] {
        refresh(&s, WT, state);
        assert_eq!(head(&s, &spec(HOST, json!({}))), None, "{state}");
    }
    refresh(&s, WT, "draining");
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        Some(id.clone()),
        "a draining refresh does not fence"
    );
    refresh(&s, OTHER_WT, "fenced");
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        Some(id.clone()),
        "a fence on another worktree"
    );

    let other = admit(&s, 2, Some(OTHER_WT), "notes/b", "put");
    effect(&s, &other, Some(WT), "embedding", json!({}));
    edit_effects(&s, |e| e.recovery = Some(json!({ "step": 1 })));
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        None,
        "an effect on the worktree recovers"
    );
    edit_effects(&s, |e| e.recovery = None);
    assert_eq!(head(&s, &spec(HOST, json!({}))), Some(id.clone()));
    let later = admit(&s, 3, Some(WT), "notes/c", "put");
    edit(&s, &later, |r| {
        r.state = "failed".into();
        r.extra.insert("recovery".into(), json!({ "step": 1 }));
    });
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        None,
        "a request on the worktree recovers"
    );
}

#[test]
fn an_unsettled_withdrawal_mirror_holds_the_slugs_it_covers() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    let first = admit(&s, 1, Some(WT), "notes/a", "put");
    edit(&s, &first, |r| r.state = "committed".into());
    let id = admit(&s, 2, Some(WT), "notes/a", "put");
    effect(
        &s,
        &first,
        Some(WT),
        "withdrawal-mirror",
        json!({ "targets": [{ "slug": "notes/b" }] }),
    );
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        Some(id.clone()),
        "the mirror covers another slug"
    );
    edit_effects(&s, |e| {
        e.data = json!({ "targets": [{ "slug": "notes/a" }] })
    });
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        None,
        "the mirror covers this slug"
    );
    edit_effects(&s, |e| e.data = json!({}));
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        None,
        "a mirror with no targets covers every slug"
    );
    edit_effects(&s, |e| e.state = "failed".into());
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        Some(id),
        "a failed mirror holds nothing"
    );
}

#[test]
fn a_worktree_write_waits_for_the_earlier_writes_there() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    worktree(&s, OTHER_WT, Some(HOST), "active");
    let first = admit(&s, 1, Some(WT), "notes/a", "put");
    let second = admit(&s, 2, Some(WT), "notes/b", "put");
    let elsewhere = admit(&s, 3, Some(OTHER_WT), "notes/c", "put");
    edit(&s, &first, |r| r.state = "running".into());
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        Some(elsewhere.clone()),
        "the running write blocks the next write on its worktree only"
    );
    edit(&s, &first, |r| r.state = "committed".into());
    assert_eq!(head(&s, &spec(HOST, json!({}))), Some(second.clone()));
    let roots = json!({ "excludeRoots": [WT] });
    assert_eq!(
        head(&s, &spec(HOST, roots)),
        Some(elsewhere),
        "an excluded root is the worktree id"
    );
}

#[test]
fn a_foreground_write_passes_a_queued_sync_row_only_under_the_switch() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    let sync = admit(&s, 1, Some(WT), "notes/a", "managed_sync_put");
    let write = admit(&s, 2, Some(WT), "notes/b", "put");
    let on = json!({ "priority": true });
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        Some(sync.clone()),
        "without the switch the claim is FIFO"
    );
    assert_eq!(
        head(&s, &spec(HOST, on.clone())),
        Some(write.clone()),
        "the switch claims the foreground write first"
    );
    let fifo = json!({ "priority": true, "fifoRoots": [WT] });
    assert_eq!(
        head(&s, &spec(HOST, fifo)),
        Some(sync.clone()),
        "a FIFO root ignores the switch"
    );
    edit(&s, &sync, |r| r.state = "running".into());
    assert_eq!(
        head(&s, &spec(HOST, on.clone())),
        None,
        "a running sync row outside a lane blocks"
    );
    edit(&s, &sync, |r| {
        r.intent["lane"] = json!(1);
    });
    assert_eq!(
        head(&s, &spec(HOST, on)),
        None,
        "a laned sync row on a root not laned here blocks"
    );
    let lane = json!({ "laneRoots": [WT], "priority": true });
    assert_eq!(
        head(&s, &spec(HOST, lane)),
        Some(write),
        "a sync row laned here lets a foreground write pass"
    );
}

#[test]
fn a_released_deferred_write_blocks_the_writes_behind_it() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    let held = admit(&s, 1, Some(WT), "notes/a", "put");
    let next = admit(&s, 2, Some(WT), "notes/b", "put");
    refresh(&s, WT, "completed");
    edit(&s, &held, |r| {
        r.state = "deferred".into();
        r.extra.insert(
            "deferred_refresh_id".into(),
            json!("c0000000-0000-4000-8000-0000000000f1"),
        );
        r.extra
            .insert("next_attempt_at".into(), json!("2999-01-01T00:00:00.000Z"));
    });
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        Some(next.clone()),
        "a write still held by its refresh blocks nothing"
    );
    s.write(|tx| {
        let mut f: RefreshRecord = super::worktree_admission::all_refreshes(&*tx)?.remove(0);
        f.released_at_us = Some(1);
        put_refresh(tx, &f)
    })
    .unwrap();
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        None,
        "a released write not yet due blocks the write behind it"
    );
    edit(&s, &held, |r| {
        r.extra.remove("next_attempt_at");
    });
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        Some(held),
        "the released write goes first"
    );
}

#[test]
fn a_sync_head_waits_behind_a_foreground_write_it_has_not_seen() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    let sync = admit(&s, 1, Some(WT), "notes/a", "managed_sync_put");
    let write = admit(&s, 2, Some(WT), "notes/b", "put");
    let seq = |id: &str| {
        get_json::<RequestRecord>(&*s.read().unwrap(), &keys::request(id))
            .unwrap()
            .unwrap()
            .sequence
    };
    // The foreground write behind the sync row is queued but not yet due, so it is not a candidate.
    edit(&s, &write, |r| {
        r.extra
            .insert("next_attempt_at".into(), json!("2999-01-01T00:00:00.000Z"));
    });
    assert_eq!(
        head(&s, &spec(HOST, json!({}))),
        Some(sync.clone()),
        "without the switch the sync head goes"
    );
    let on = json!({ "priority": true });
    assert_eq!(
        head(&s, &spec(HOST, on)),
        None,
        "under the switch the sync head waits for the write"
    );
    let committed = admit(&s, 3, Some(WT), "notes/c", "put");
    edit(&s, &committed, |r| r.state = "committed".into());
    let since = |seen: Value| spec(HOST, json!({ "priority": true, "syncSeen": { WT: seen } }));
    assert_eq!(
        head(&s, &since(json!(null))),
        Some(sync.clone()),
        "a write committed since the sync last claimed frees the head"
    );
    assert_eq!(
        head(&s, &since(json!((seq(&committed) - 1).to_string()))),
        Some(sync.clone())
    );
    assert_eq!(
        head(&s, &since(json!(seq(&committed).to_string()))),
        None,
        "nothing committed since the sync saw it"
    );
    let bad = since(json!("x"));
    assert_eq!(
        s.select_claimable_write(&bad).unwrap_err().message,
        "invalid input syntax for type bigint: \"x\""
    );
}

#[test]
fn only_the_owner_claims_an_effect_on_a_clear_worktree() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    let id = admit(&s, 1, Some(WT), "notes/a", "put");
    edit(&s, &id, |r| r.state = "committed".into());
    effect(&s, &id, Some(WT), "embedding", json!({}));
    assert!(!s.select_claimable_effect(HOST, &[]).unwrap().is_null());
    assert!(
        s.select_claimable_effect(OTHER_HOST, &[])
            .unwrap()
            .is_null(),
        "another host"
    );
    refresh(&s, WT, "fenced");
    assert!(
        s.select_claimable_effect(HOST, &[]).unwrap().is_null(),
        "fenced"
    );
    refresh(&s, WT, "completed");
    assert!(!s.select_claimable_effect(HOST, &[]).unwrap().is_null());
    edit(&s, &id, |r| {
        r.extra.insert("recovery".into(), json!({ "step": 1 }));
    });
    assert!(
        s.select_claimable_effect(HOST, &[]).unwrap().is_null(),
        "a request recovers there"
    );
    let bad = s.select_claimable_effect("nope", &[]).unwrap_err();
    assert_eq!(bad.message, "invalid input syntax for type uuid: \"nope\"");
}

#[test]
fn the_gated_scan_lists_parked_mirrors_on_owned_worktrees() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    let id = admit(&s, 1, Some(WT), "notes/a", "put");
    edit(&s, &id, |r| r.state = "committed".into());
    effect(&s, &id, Some(WT), "withdrawal-mirror", json!({}));
    let park = |parked: Value| {
        edit_effects(&s, |e| {
            e.state = "failed".into();
            e.error_code = Some("targets_parked".into());
            e.data = json!({ "parked": parked.clone() });
        })
    };
    park(json!([{ "slug": "notes/a", "error_code": "writer_gate" }]));
    let allowed = ["writer_gate".to_owned()];
    let listed = s
        .list_gated_mirror_requests(HOST, "writer_gate", &allowed)
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["id"], json!(id));
    assert!(
        s.list_gated_mirror_requests(OTHER_HOST, "writer_gate", &allowed)
            .unwrap()
            .is_empty(),
        "another host"
    );
    assert!(
        s.list_gated_mirror_requests(HOST, "other_gate", &allowed)
            .unwrap()
            .is_empty(),
        "another gate"
    );
    assert!(
        s.list_gated_mirror_requests(HOST, "writer_gate", &[])
            .unwrap()
            .is_empty(),
        "a code not allowed"
    );
    park(json!([{ "error_code": "writer_gate" }, { "error_code": "other" }]));
    assert!(
        s.list_gated_mirror_requests(HOST, "writer_gate", &allowed)
            .unwrap()
            .is_empty(),
        "another parked code"
    );
    edit_effects(&s, |e| {
        e.data = json!({ "parked": { "error_code": "writer_gate" } })
    });
    assert!(
        s.list_gated_mirror_requests(HOST, "writer_gate", &allowed)
            .unwrap()
            .is_empty(),
        "an object of parked targets contains no array"
    );
}

#[test]
fn the_gated_scan_refuses_parked_targets_that_are_not_an_array() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    let id = admit(&s, 1, Some(WT), "notes/a", "put");
    edit(&s, &id, |r| r.state = "committed".into());
    effect(&s, &id, Some(WT), "withdrawal-mirror", json!({}));
    effect(&s, &id, Some(WT), "embedding", json!({}));
    edit_effects(&s, |e| {
        if e.kind == "withdrawal-mirror" {
            e.state = "failed".into();
            e.error_code = Some("targets_parked".into());
            e.data = json!({ "parked": [{ "error_code": "writer_gate" }] });
        } else {
            e.data = json!({ "parked": { "error_code": "writer_gate" } });
        }
    });
    let allowed = ["writer_gate".to_owned()];
    let err = s
        .list_gated_mirror_requests(HOST, "writer_gate", &allowed)
        .unwrap_err();
    assert_eq!(err.message, "cannot extract elements from an object");
}

#[test]
fn expiry_releases_only_the_claims_of_worktrees_the_host_owns() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    worktree(&s, OTHER_WT, Some(OTHER_HOST), "active");
    let mine = admit(&s, 1, Some(WT), "notes/a", "put");
    let theirs = admit(&s, 2, Some(OTHER_WT), "notes/b", "put");
    let plain = admit(&s, 3, None, "notes/c", "put");
    for id in [&mine, &theirs, &plain] {
        edit(&s, id, |r| {
            r.state = "running".into();
            r.extra
                .insert("claim_expires_at".into(), json!("2000-01-01T00:00:00.000Z"));
        });
    }
    let spec = ExpireClaims {
        fence: None,
        host_id: HOST.into(),
        charge: false,
        dead_owners: vec![],
    };
    assert_eq!(s.expire_stale_write_claims(&spec).unwrap(), 2);
    let state = |id: &str| {
        get_json::<RequestRecord>(&*s.read().unwrap(), &keys::request(id))
            .unwrap()
            .unwrap()
            .state
    };
    assert_eq!(state(&mine), "queued");
    assert_eq!(state(&plain), "queued");
    assert_eq!(state(&theirs), "running", "another host's worktree");
}

#[test]
fn the_owner_scans_read_worktree_rows() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    worktree(&s, OTHER_WT, Some(HOST), "active");
    let a = admit(&s, 1, Some(WT), "notes/a", "put");
    let b = admit(&s, 2, Some(WT), "notes/b", "put");
    let c = admit(&s, 3, Some(OTHER_WT), "notes/c", "put");
    for id in [&a, &b, &c] {
        edit(&s, id, |r| {
            r.state = "failed".into();
            r.extra.insert("recovery".into(), json!({ "step": 1 }));
        });
    }
    let heads = |host: &str, excluded: &[String]| -> Vec<String> {
        s.list_owner_recovery_heads(host, excluded)
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        heads(HOST, &[]),
        vec![a.clone(), c.clone()],
        "the oldest recovering write per worktree"
    );
    assert_eq!(heads(HOST, &[WT.to_owned()]), vec![c.clone()]);
    assert!(heads(OTHER_HOST, &[]).is_empty());

    let held = admit(&s, 4, Some(WT), "notes/d", "put");
    edit(&s, &held, |r| {
        r.state = "deferred".into();
        r.extra.insert("deferred_import_from".into(), json!(""));
        r.updated_at_us = 0;
    });
    let overdue = s.list_overdue_held_writes(HOST, 1000.0, "import").unwrap();
    assert_eq!(
        overdue.iter().map(|r| r["id"].clone()).collect::<Vec<_>>(),
        vec![json!(held)]
    );
    assert!(
        s.list_overdue_held_writes(OTHER_HOST, 1000.0, "import")
            .unwrap()
            .is_empty()
    );
    assert!(
        s.list_overdue_held_writes(HOST, 1000.0, "refresh")
            .unwrap()
            .is_empty()
    );
    assert!(
        s.lock_overdue_hold("import", Some(&held), Some(""), 1000.0)
            .unwrap()
    );
    assert!(
        !s.lock_overdue_hold("import", Some(&held), Some("c1"), 1000.0)
            .unwrap(),
        "another import"
    );
    assert!(
        !s.lock_overdue_hold("import", Some(&held), None, 1000.0)
            .unwrap()
    );
}

#[test]
fn withdrawal_effects_take_the_worktree_of_a_binding_at_the_source_incarnation() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    let id = admit(&s, 1, Some(WT), "notes/a", "put");
    let spec = |request: &str| WithdrawalEffectsSpec {
        request_id: request.into(),
        source_id: "default".into(),
        data: json!({}),
    };
    let worktrees = |s: &Store| {
        let mut effects = all_effects(&*s.read().unwrap()).unwrap();
        effects.sort_by_key(|e| e.id);
        effects
            .into_iter()
            .map(|e| e.worktree_id)
            .collect::<Vec<_>>()
    };
    // A binding from an earlier incarnation of the source binds nothing.
    s.write(|tx| put_source_binding(tx, "default", "00000000-0000-4000-8000-000000000000", WT, 1))
        .unwrap();
    s.insert_withdrawal_effects(&spec(&id)).unwrap();
    assert_eq!(worktrees(&s), vec![None, None, None]);
    let inc = incarnation(&s).as_str().unwrap().to_uppercase();
    let next = admit(&s, 2, Some(WT), "notes/b", "put");
    s.write(|tx| put_source_binding(tx, "default", &inc, WT, 1))
        .unwrap();
    s.insert_withdrawal_effects(&spec(&next)).unwrap();
    let wt = Some(WT.to_owned());
    assert_eq!(
        worktrees(&s),
        vec![None, None, None, wt.clone(), wt.clone(), wt]
    );
}

/// Whether the idle probe of `host` finds work.
fn probe(s: &Store, host: &str, extra: Value) -> bool {
    let mut v = json!({
        "hostId": host, "cursor": { "after": { "source_incarnation": incarnation(s), "slug": "" }, "highWater": null },
    });
    if let (Value::Object(m), Value::Object(e)) = (&mut v, extra) {
        m.extend(e);
    }
    let spec: super::idle_probe::IdleProbeSpec = serde_json::from_value(v).unwrap();
    s.probe_idle_work(&spec).unwrap()["work"].as_bool().unwrap()
}

#[test]
fn the_idle_probe_counts_worktree_work_only_for_the_owner() {
    let s = store();
    worktree(&s, WT, Some(HOST), "active");
    let id = admit(&s, 1, Some(WT), "notes/a", "put");
    assert!(probe(&s, HOST, json!({})), "the owner's claimable write");
    assert!(!probe(&s, OTHER_HOST, json!({})), "another host's");
    assert!(
        !probe(&s, HOST, json!({ "excludedRoots": [WT] })),
        "an excluded worktree"
    );
    edit(&s, &id, |r| {
        r.state = "recovering".into();
        r.extra.insert("recovery".into(), json!({ "step": "x" }));
    });
    assert!(
        probe(&s, HOST, json!({})),
        "a recovery on an owned worktree"
    );
    assert!(!probe(&s, OTHER_HOST, json!({})));
    assert!(!probe(&s, HOST, json!({ "excludedRoots": [WT] })));
    edit(&s, &id, |r| {
        r.state = "committed".into();
        r.extra.remove("recovery");
    });
    effect(&s, &id, Some(WT), "embedding", json!({}));
    assert!(
        probe(&s, HOST, json!({})),
        "a due effect on an owned worktree"
    );
    assert!(!probe(&s, OTHER_HOST, json!({})));
    refresh(&s, WT, "fenced");
    assert!(!probe(&s, HOST, json!({})), "a fence holds the effect");
}
