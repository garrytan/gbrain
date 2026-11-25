//! Orphan connector checkpoints: `listOrphanConnectorCheckpoints`, `countConnectorCheckpointsKeyed`
//! and `deleteOrphanConnectorCheckpoint` (rust/docs/store/repair-bookkeeping.md).

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::persistence::{OrphanBounds, WriteRequestInsert};
use serde_json::{Value, json};

const REQ_1: &str = "b0000000-0000-4000-8000-0000000000b1";
const REQ_2: &str = "b0000000-0000-4000-8000-0000000000b2";
const STATE_OP: &str = "managed-connector-state";

fn incarnation(store: &Store) -> String {
    store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string()
}

fn request(store: &Store, request: &str, intent: Value) {
    let insert: WriteRequestInsert = serde_json::from_value(json!({
        "principalKind": "local_cli", "principalId": "parity-writer", "requestId": request,
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation(store),
        "pageId": null, "slug": "a", "worktreeId": null, "topologyGeneration": null,
        "digest": "digest", "intent": intent, "authority": {}, "intentBytes": 10,
        "terminalReservation": 4096, "targetKind": "page", "protocolVersion": 1,
        "admitterVersion": "v-test", "admitterHostId": null,
        "counterKeys": ["principal:local_cli:parity-writer", "brain"], "clientRequestId": null,
        "state": "queued", "deferredRefreshId": null,
    }))
    .unwrap();
    store.insert_write_request(&insert).unwrap();
}

fn bounds(before: Option<&str>, min_age_days: Option<i64>) -> OrphanBounds<'_> {
    OrphanBounds {
        before,
        min_age_days,
        state_op: STATE_OP,
    }
}

fn later() -> String {
    // An hour ahead of any stamp the test writes.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 3600;
    let days = now / 86_400;
    let (y, m, d) = civil(days as i64);
    let s = now % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        s / 3600,
        s / 60 % 60,
        s % 60
    )
}

fn civil(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn names(rows: &[Value]) -> Vec<String> {
    rows.iter()
        .map(|r| {
            format!(
                "{}/{}",
                r["op"].as_str().unwrap(),
                r["fingerprint"].as_str().unwrap()
            )
        })
        .collect()
}

#[test]
fn an_unloadable_checkpoint_with_nothing_pending_is_an_orphan() {
    let dir = TempDir::new("connector-orphans");
    let store = open(&dir);
    for key in ["kept", "orphan", "named-by-request", "listed-by-state"] {
        store
            .write_op_checkpoint_record("managed-connector", key, Some(&json!([])))
            .unwrap();
    }
    store
        .write_op_checkpoint_record(
            "managed-connector-retry",
            "r1",
            Some(&json!([{ "checkpointKey": "kept" }])),
        )
        .unwrap();
    store
        .write_op_checkpoint_record(
            "managed-connector-retry",
            "r2",
            Some(&json!([{ "checkpointKey": "gone" }])),
        )
        .unwrap();
    // A housekeeping row of another op is never a connector checkpoint.
    store
        .write_op_checkpoint_record("managed-sync", "orphan", Some(&json!([])))
        .unwrap();
    request(
        &store,
        REQ_1,
        json!({ "kind": "connector_v2_sync", "checkpointKey": "named-by-request" }),
    );
    // A request of another kind does not protect a row unless a state row lists it.
    request(
        &store,
        REQ_2,
        json!({ "kind": "page_write", "checkpointKey": "listed-by-state" }),
    );
    store
        .write_op_checkpoint_record(
            STATE_OP,
            "s",
            Some(&json!([{ "pending": [{ "requestId": REQ_2 }] }])),
        )
        .unwrap();

    let loadable = vec!["kept".to_string()];
    let before = later();
    let rows = store
        .list_orphan_connector_checkpoints(&loadable, &bounds(Some(&before), None), 100)
        .unwrap();
    assert_eq!(
        names(&rows),
        ["managed-connector/orphan", "managed-connector-retry/r2"]
    );
    let stamp = rows[0]["updated_at"].as_str().unwrap();
    assert!(
        stamp.ends_with("+00") && stamp.as_bytes()[10] == b' ',
        "{stamp}"
    );

    // The age floor and an earlier `before` both exclude a fresh row; the limit cuts the list.
    assert!(
        store
            .list_orphan_connector_checkpoints(&loadable, &bounds(None, Some(7)), 100)
            .unwrap()
            .is_empty()
    );
    let early = bounds(Some("2000-01-01 00:00:00+00"), None);
    assert!(
        store
            .list_orphan_connector_checkpoints(&loadable, &early, 100)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store
            .list_orphan_connector_checkpoints(&loadable, &bounds(None, None), 1)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.count_connector_checkpoints_keyed(&loadable).unwrap(),
        2
    );

    // The delete needs the listed stamp and a row that is still an orphan.
    let b = bounds(Some(&before), None);
    let stale = store
        .delete_orphan_connector_checkpoint(
            "managed-connector",
            "orphan",
            "2000-01-01T00:00:00.000Z",
            &loadable,
            &b,
        )
        .unwrap();
    assert!(!stale);
    let now_loadable = vec!["orphan".to_string()];
    assert!(
        !store
            .delete_orphan_connector_checkpoint(
                "managed-connector",
                "orphan",
                stamp,
                &now_loadable,
                &b
            )
            .unwrap()
    );
    assert!(
        store
            .delete_orphan_connector_checkpoint("managed-connector", "orphan", stamp, &loadable, &b)
            .unwrap()
    );
    assert!(
        !store
            .delete_orphan_connector_checkpoint("managed-connector", "orphan", stamp, &loadable, &b)
            .unwrap()
    );
    assert!(
        store
            .read_op_checkpoint_record("managed-connector", "orphan", None)
            .unwrap()
            .is_null()
    );
    assert!(
        !store
            .read_op_checkpoint_record("managed-sync", "orphan", None)
            .unwrap()
            .is_null()
    );
    assert!(
        !store
            .delete_orphan_connector_checkpoint("managed-sync", "orphan", stamp, &loadable, &b)
            .unwrap()
    );
    assert!(
        store
            .list_orphan_connector_checkpoints(&loadable, &bounds(Some("not a time"), None), 1)
            .is_err()
    );
}
