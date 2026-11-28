//! Shared-skill publication on a Rust brain (`shared_skill_publication.rs`): activation, the pack
//! row, the head reads, the in-transaction checks and retention, against the SQL behavior they
//! mirror (skill-activation.ts, publication.ts, retention.ts).

mod memory_env;

use gbrain_store::jobs::LockAcquire;
use gbrain_store::shared_skill_catalog::SharedSkillRevisionWrite;
use gbrain_store::shared_skill_publication::{
    SharedSkillPackHeads, SharedSkillPackWrite, SharedSkillPublicationCheck, SharedSkillSourceKey,
};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const EPOCH: &str = "44444444-4444-4444-8444-444444444444";
const REQUEST: &str = "55555555-5555-4555-8555-555555555555";
const HOUR_US: i64 = 3_600_000_000;

fn incarnation(b: &Brain) -> String {
    b.read_shared_skill_source("default").unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string()
}

fn attach(b: &Brain, id: &str, path: &str) {
    let input: SourceInput =
        serde_json::from_value(json!({ "id": id, "name": id, "local_path": path, "config": {} }))
            .unwrap();
    b.upsert_source(&input).unwrap();
}

fn revision(inc: &str, name: &str, revision: &str) -> SharedSkillRevisionWrite {
    serde_json::from_value(json!({
        "sourceId": "default", "incarnation": inc, "packId": "pack", "name": name, "revision": revision,
        "metadata": {"description": "d"}, "files": [{"path": format!("skills/{name}/SKILL.md")}],
        "deleted": false, "policyEpoch": EPOCH, "requestId": REQUEST,
    }))
    .unwrap()
}

fn rev_id(n: u32) -> String {
    format!("{n:08x}-0000-4000-8000-000000000000")
}

fn check(inc: &str, pack: Option<&str>, heads: Value) -> SharedSkillPublicationCheck {
    serde_json::from_value(json!({
        "sourceId": "default", "incarnation": inc, "packId": "pack", "expectedPackRevision": pack,
        "heads": heads, "revisions": [{"metadata": {"a": 1}, "files": []}],
    }))
    .unwrap()
}

#[test]
fn activation_needs_a_registered_root_and_no_legacy_lock_then_sets_the_flag() {
    let b = brain("ssp-activate");
    assert_eq!(
        b.read_shared_skill_publication().unwrap(),
        json!({"skill_bundles_enabled": false, "writer_protocol_floor": 1})
    );
    assert_eq!(
        b.activate_shared_skill_publication(false).unwrap(),
        json!({"registration_required": true})
    );
    attach(&b, "default", "/srv/brain");
    let lease: LockAcquire = serde_json::from_value(json!({
        "holderPid": 1, "holderHost": "h", "acquisitionToken": REQUEST, "ttlMinutes": 30.0,
        "stealGraceSeconds": 0.0,
    }))
    .unwrap();
    b.acquire_cycle_lock("embed-page:default:notes", &lease)
        .unwrap();
    assert_eq!(
        b.activate_shared_skill_publication(true).unwrap(),
        json!({"activated": false, "protocol_version": 2, "filesystem_sources": 1})
    );
    b.acquire_cycle_lock("cycle", &lease).unwrap();
    assert_eq!(
        b.activate_shared_skill_publication(false).unwrap(),
        json!({"legacy_lock": true})
    );
    assert_eq!(
        b.read_shared_skill_publication().unwrap()["skill_bundles_enabled"],
        json!(false)
    );
    let holder =
        serde_json::from_value(json!({"holderPid": 1, "acquisitionToken": REQUEST})).unwrap();
    b.release_cycle_lock("cycle", &holder).unwrap();
    assert_eq!(
        b.activate_shared_skill_publication(false).unwrap(),
        json!({"activated": true, "protocol_version": 2, "filesystem_sources": 1})
    );
    assert_eq!(
        b.read_shared_skill_publication().unwrap(),
        json!({"skill_bundles_enabled": true, "writer_protocol_floor": 2})
    );
}

#[test]
fn activation_makes_the_reviewed_writer_admin_state_stale() {
    let b = brain("ssp-admin-state");
    attach(&b, "default", "/srv/brain");
    let brain_row = |text: String| serde_json::from_str::<Value>(&text).unwrap()["brain"].clone();
    let before = b.writer_admin_state_text().unwrap();
    assert_eq!(
        brain_row(before.clone())["skill_bundles_enabled"],
        json!(false)
    );
    assert_eq!(brain_row(before.clone())["writer_protocol_floor"], json!(1));
    b.activate_shared_skill_publication(false).unwrap();
    let after = b.writer_admin_state_text().unwrap();
    assert_eq!(
        brain_row(after.clone())["skill_bundles_enabled"],
        json!(true)
    );
    assert_eq!(brain_row(after.clone())["writer_protocol_floor"], json!(2));
    assert_ne!(before, after);
}

#[test]
fn the_source_read_names_aliases_at_the_same_path() {
    let b = brain("ssp-source");
    attach(&b, "default", "/srv/brain");
    attach(&b, "other", "/srv/brain");
    let s = b.read_shared_skill_source("default").unwrap();
    assert_eq!(s["aliases"], json!(["other"]));
    assert_eq!(s["local_path"], json!("/srv/brain"));
    assert!(b.read_shared_skill_source("missing").unwrap().is_null());
}

#[test]
fn checks_and_pack_writes_refuse_while_disabled_and_compare_the_pack_and_heads() {
    let b = brain("ssp-check");
    attach(&b, "default", "/srv/brain");
    let inc = incarnation(&b);
    let refusal = b
        .check_shared_skill_publication(&check(&inc, None, json!([])))
        .unwrap_err();
    assert!(
        refusal
            .to_string()
            .contains("shared publication is disabled")
    );
    b.activate_shared_skill_publication(false).unwrap();
    assert_eq!(
        b.check_shared_skill_publication(&check(
            &inc,
            None,
            json!([{"name": "notes", "revision": null}])
        ))
        .unwrap(),
        json!({"pruned": 0, "incoming_bytes": 10, "capacity": {"retained_revisions": 0, "retained_bytes": 0,
            "brain_retained_revisions": 0, "brain_retained_bytes": 0}})
    );
    b.write_shared_skill_revision(&revision(&inc, "notes", &rev_id(1)))
        .unwrap();
    assert_eq!(
        b.check_shared_skill_publication(&check(
            &inc,
            None,
            json!([{"name": "notes", "revision": null}])
        ))
        .unwrap(),
        json!({"conflict": "head"})
    );
    let pack: SharedSkillPackWrite = serde_json::from_value(json!({
        "sourceId": "default", "incarnation": inc, "packId": "pack", "revision": rev_id(9),
        "manifest": {"name": "pack"}, "manifestHash": "h",
    }))
    .unwrap();
    b.write_shared_skill_pack(&pack).unwrap();
    let key: SharedSkillSourceKey =
        serde_json::from_value(json!({"sourceId": "default", "incarnation": inc})).unwrap();
    assert_eq!(
        b.read_shared_skill_pack(&key).unwrap()["revision"],
        json!(rev_id(9))
    );
    assert_eq!(
        b.check_shared_skill_publication(&check(&inc, None, json!([])))
            .unwrap(),
        json!({"conflict": "pack"})
    );
    let ok = b
        .check_shared_skill_publication(&check(
            &inc,
            Some(&rev_id(9)),
            json!([{"name": "notes", "revision": rev_id(1)}]),
        ))
        .unwrap();
    assert_eq!(ok["capacity"]["retained_revisions"], json!(1));
    let q: SharedSkillPackHeads = serde_json::from_value(json!({
        "sourceId": "default", "incarnation": inc, "packId": "pack", "limit": 10, "names": ["notes"],
    }))
    .unwrap();
    assert_eq!(
        b.list_shared_skill_head_keys(&q).unwrap(),
        json!([{"name": "notes", "revision": rev_id(1), "deleted": false}])
    );
    let rows = b.read_shared_skill_head_revisions(&q).unwrap();
    assert_eq!(rows[0]["request_id"], json!(REQUEST));
    assert_eq!(rows[0]["stored_bytes"], ok["capacity"]["retained_bytes"]);
}

#[test]
fn retention_keeps_the_twenty_newest_and_prunes_older_revisions_past_the_grace_period() {
    let b = brain("ssp-retention");
    attach(&b, "default", "/srv/brain");
    let inc = incarnation(&b);
    b.activate_shared_skill_publication(false).unwrap();
    for n in 1..=23 {
        b.write_shared_skill_revision(&revision(&inc, "notes", &rev_id(n)))
            .unwrap();
        b.clock.advance(HOUR_US);
    }
    let key: SharedSkillSourceKey =
        serde_json::from_value(json!({"sourceId": "default", "incarnation": inc})).unwrap();
    let status = b.read_shared_skill_retention(&key).unwrap();
    assert_eq!(status["retained_revisions"], json!(23));
    assert_eq!(status["protected_heads"], json!(1));
    // Revisions 1-3 are below the 20 newest, but none is older than 24 hours yet.
    assert_eq!(status["eligible_revisions"], json!(0));
    b.clock.advance(4 * HOUR_US);
    assert_eq!(
        b.read_shared_skill_retention(&key).unwrap()["eligible_revisions"],
        json!(3)
    );
    let pruned = b
        .check_shared_skill_publication(&check(
            &inc,
            None,
            json!([{"name": "notes", "revision": rev_id(23)}]),
        ))
        .unwrap();
    assert_eq!(pruned["pruned"], json!(3));
    assert_eq!(pruned["capacity"]["retained_revisions"], json!(20));
}
