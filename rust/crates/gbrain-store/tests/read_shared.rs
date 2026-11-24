//! The read-shared switch (GST-2898): `readSharedSourceRows` (PGLite's
//! `READ_SHARED_SOURCE_ROWS_SQL`) and the two stamp writes, `setOauthClientReadSharedRevision` and
//! `setAccessTokenReadSharedRevision`.

mod common;

use common::{TempDir, open};
use gbrain_store::sources::SourceInput;
use serde_json::{Map, Value, json};

fn config(v: Value) -> Option<Map<String, Value>> {
    v.as_object().cloned()
}

#[test]
fn shared_source_rows_are_live_sources_in_byte_order_with_guest_flags_and_the_owner() {
    let dir = TempDir::new("read-shared-rows");
    let store = open(&dir);
    for (id, cfg) in [
        ("team", json!({"federated": true})),
        ("guest-flag", json!({"guest": true})),
        ("guest-text", json!({"guest": "true"})),
        ("aaa", json!({})),
        ("gone", json!({"federated": true})),
    ] {
        store
            .upsert_source(&SourceInput {
                id: id.into(),
                config: config(cfg),
                ..Default::default()
            })
            .unwrap();
    }
    store.set_source_archived("gone", true).unwrap();
    let before = store.read_shared_source_rows().unwrap();
    assert!(before.iter().all(|r| r["owner_member"].is_null()));
    store
        .set_config("access.owner_member", "  owner-1 ")
        .unwrap();
    let rows = store.read_shared_source_rows().unwrap();
    let view: Vec<(String, bool)> = rows
        .iter()
        .map(|r| {
            (
                r["id"].as_str().unwrap().to_string(),
                r["guest"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        view,
        vec![
            ("aaa".to_string(), false),
            ("default".to_string(), false),
            ("guest-flag".to_string(), true),
            ("guest-text".to_string(), true),
            ("team".to_string(), false),
        ]
    );
    assert!(
        rows.iter()
            .all(|r| r["owner_member"] == json!("owner-1") && r["owners"] == json!([]))
    );
}
