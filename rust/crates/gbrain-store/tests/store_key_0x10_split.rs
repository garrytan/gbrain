//! Take purges and loop mutes are two record kinds. They once shared the store key prefix
//! `F 0x10`, so a take purge read scanned the mutes as well, and a mute scan scanned the purges.
//! Each kind must read as if the other did not exist.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::take_purges::TakePurgeInsert;
use gbrain_store::sources::SourceInput;
use gbrain_store::trust::belief_events::TombstoneQuery;
use serde_json::json;

const REQUEST: &str = "6f9619ff-8b86-4d01-b42d-00cf4fc964aa";
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn brain(name: &str) -> (Store, TempDir) {
    let dir = TempDir::new(name);
    let store = open(&dir);
    store
        .upsert_source(&SourceInput {
            id: "g1".into(),
            ..SourceInput::default()
        })
        .unwrap();
    (store, dir)
}

fn purge(s: &Store, subject: &str, hash: &str) {
    s.insert_take_purge(&TakePurgeInsert {
        source_id: "g1".into(),
        subject: subject.into(),
        claim_hash: hash.into(),
        request_id: Some(REQUEST.into()),
    })
    .unwrap();
}

fn tombstones(s: &Store, hashes: &[&str]) -> Vec<String> {
    s.read_belief_tombstones(&TombstoneQuery {
        source_id: "g1".into(),
        fact_fps: vec![],
        take_fps: hashes.iter().map(|h| (*h).to_owned()).collect(),
    })
    .unwrap()
    .fps
}

/// Every read of the take purge ledger on source `g1`, as one value.
fn take_purge_reads(s: &Store) -> serde_json::Value {
    json!({
        "flags": s.read_source_purge_flags("g1").unwrap(),
        // A mute whose value is a purged claim's fingerprint must not read as that purge.
        "tombstones": tombstones(s, &[HASH]),
        // An error is part of the answer: it is what a mute's record read as a purge gives.
        "recentRequests": s
            .list_recent_purge_requests(30, 100)
            .unwrap_or_else(|e| vec![format!("error: {}", e.message)]),
    })
}

#[test]
fn a_loop_mute_is_not_a_take_purge() {
    let (s, _dir) = brain("key-0x10-mute-first");
    assert_eq!(
        take_purge_reads(&s),
        json!({ "flags": [false, false], "tombstones": [], "recentRequests": [] })
    );
    // One mute of each kind, the thread mute's value shaped like a claim fingerprint.
    s.add_loop_suppression("g1", "sender", "alerts@bank-example.test")
        .unwrap();
    s.add_loop_suppression("g1", "thread", HASH).unwrap();
    assert_eq!(
        take_purge_reads(&s),
        json!({ "flags": [false, false], "tombstones": [], "recentRequests": [] }),
        "a loop mute showed up as a take purge"
    );
}

#[test]
fn a_take_purge_is_not_a_loop_mute() {
    let (s, _dir) = brain("key-0x10-purge-first");
    purge(&s, "*", HASH);
    purge(&s, "sender", "bbbb");
    assert!(
        s.list_loop_suppressions("g1").unwrap().is_empty(),
        "a take purge showed up as a loop mute"
    );
    assert_eq!(s.read_source_purge_flags("g1").unwrap(), (false, true));
}

#[test]
fn both_kinds_in_one_source_each_read_only_their_own() {
    let (s, _dir) = brain("key-0x10-both");
    s.add_loop_suppression("g1", "sender", "alerts@bank-example.test")
        .unwrap();
    purge(&s, "people/a", HASH);
    s.add_loop_suppression("g1", "thread", "t1").unwrap();
    assert_eq!(
        s.list_loop_suppressions("g1").unwrap(),
        vec![
            json!({ "kind": "sender", "value": "alerts@bank-example.test" }),
            json!({ "kind": "thread", "value": "t1" })
        ]
    );
    assert_eq!(
        take_purge_reads(&s),
        json!({ "flags": [false, true], "tombstones": [HASH], "recentRequests": [REQUEST] })
    );
    // A mute's value that equals a hash nobody purged is not found.
    assert_eq!(tombstones(&s, &["t1"]), Vec::<String>::new());
}
