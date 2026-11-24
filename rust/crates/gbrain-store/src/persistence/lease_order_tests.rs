//! The claim order's `CLAIM_HEAD_LEASE_HELD` term (`select_claimable_write_in`): a non-resident
//! consumer ranks a managed-sync row whose source's drain lease another live process holds after
//! every other row.

use crate::Store;
use crate::jobs::{LockAcquire, LockHolder};
use crate::persistence::{ClaimableSpec, WriteRequestInsert};
use crate::sources::SourceInput;
use crate::test_support::store;
use serde_json::{Value, json};

fn admit(s: &Store, source: &str, request: &str, slug: &str, kind: &str) -> String {
    let inc = s.read_source_membership(source).unwrap().unwrap()["incarnation"].clone();
    let input: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "p1", "requestId": request,
        "operation": "put_page", "sourceId": source, "sourceIncarnation": inc, "slug": slug, "digest": "d",
        "intent": { "kind": kind }, "authority": {}, "intentBytes": 1, "terminalReservation": 4096, "targetKind": "page",
        "protocolVersion": 1, "admitterVersion": "v", "counterKeys": [], "state": "queued",
    }))
    .unwrap();
    s.insert_write_request(&input).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn head(s: &Store, holder: Value) -> String {
    let spec: ClaimableSpec = serde_json::from_value(json!({
        "hostId": "a0000000-0000-4000-8000-0000000000a1", "priority": false, "leaseHolder": holder,
    }))
    .unwrap();
    s.select_claimable_write(&spec).unwrap().unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn a_sync_row_whose_lease_another_process_holds_ranks_last() {
    let s = store();
    s.upsert_source(&SourceInput {
        id: "other".into(),
        ..SourceInput::default()
    })
    .unwrap();
    let sync = admit(
        &s,
        "default",
        "b0000000-0000-4000-8000-0000000000e1",
        "notes/a",
        "managed_sync_put",
    );
    let write = admit(
        &s,
        "other",
        "b0000000-0000-4000-8000-0000000000e2",
        "notes/b",
        "put",
    );
    let me = json!({ "lockPrefix": "gbrain-sync:", "pid": 42, "host": "here" });
    assert_eq!(
        head(&s, Value::Null),
        sync,
        "plain FIFO takes the older row"
    );
    assert_eq!(head(&s, me.clone()), sync, "no lease is held");
    let take = |pid: i64, host: &str| {
        let lock = LockAcquire {
            holder_pid: pid,
            holder_host: Some(host.into()),
            acquisition_token: "c0000000-0000-4000-8000-0000000000c1".into(),
            ttl_minutes: 5.0,
            steal_grace_seconds: 0.0,
        };
        s.acquire_cycle_lock("gbrain-sync:default", &lock)
            .unwrap()
            .unwrap();
    };
    take(42, "here");
    assert_eq!(head(&s, me.clone()), sync, "this process holds the lease");
    assert_eq!(
        head(&s, Value::Null),
        sync,
        "a resident consumer ignores the lease"
    );
    let mine = LockHolder {
        holder_pid: 42,
        acquisition_token: "c0000000-0000-4000-8000-0000000000c1".into(),
        ttl_minutes: None,
        max_age_seconds: None,
    };
    assert!(s.release_cycle_lock("gbrain-sync:default", &mine).unwrap());
    take(7, "there");
    assert_eq!(
        head(&s, me),
        write,
        "another process holds the lease: the sync row goes last"
    );
}

#[test]
fn a_bad_host_or_pid_refuses_as_the_casts_do() {
    let s = store();
    let spec = |v: Value| serde_json::from_value::<ClaimableSpec>(v).unwrap();
    let host = s
        .select_claimable_write(&spec(json!({ "hostId": "nope" })))
        .unwrap_err();
    assert_eq!(host.message, "invalid input syntax for type uuid: \"nope\"");
    let pid = s
        .has_claimable_write(&spec(
            json!({ "leaseHolder": { "lockPrefix": "x", "pid": 1.5, "host": "h" } }),
        ))
        .unwrap_err();
    assert_eq!(
        pid.message,
        "invalid input syntax for type integer: \"1.5\""
    );
}
