//! The provenance drift reads (`cli_reads/doctor_drift.rs`): the PGLite semantics of each, and the write attribution
//! of a revision and a version.

mod memory_env;

use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::WriteRequestInsert;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(s: &Brain, slug: &str, body: &str) {
    let input: PageInput = args(json!({ "type": "note", "title": slug, "compiled_truth": body }));
    s.put_page(slug, &input, &PutPageOptions::default())
        .unwrap();
}

fn live(s: &Brain, v: Value) -> Vec<Value> {
    s.list_drift_live_rows(&args(v)).unwrap()
}

fn slugs(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
}

#[test]
fn live_rows_come_by_id_after_a_cursor_or_at_a_slug_and_skip_deleted_pages() {
    let s = brain("drift-live");
    for slug in ["notes/a", "notes/b", "notes/gone"] {
        put(&s, slug, "body");
    }
    s.soft_delete_page("notes/gone", None).unwrap();
    let all = live(&s, json!({ "sourceId": "default" }));
    assert_eq!(slugs(&all), ["notes/a", "notes/b"]);
    let first = all[0]["id"].as_i64().unwrap();
    assert!(first < all[1]["id"].as_i64().unwrap());
    assert_eq!(
        slugs(&live(&s, json!({ "sourceId": "default", "after": first }))),
        ["notes/b"]
    );
    assert_eq!(
        slugs(&live(
            &s,
            json!({ "sourceId": "default", "slug": "notes/b" })
        )),
        ["notes/b"]
    );
    assert!(live(&s, json!({ "sourceId": "default", "slug": "notes/gone" })).is_empty());
    assert!(live(&s, json!({ "sourceId": "other" })).is_empty());
}

const REQ_LOCAL: &str = "d0000000-0000-4000-8000-0000000000d1";
const REQ_REMOTE: &str = "d0000000-0000-4000-8000-0000000000d2";

/// A queued request of the drift writer whose authority says whether it came over a remote transport.
fn request(s: &Brain, request: &str, remote: bool) -> String {
    let incarnation = s.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    let input: WriteRequestInsert = args(json!({
        "principalKind": "local_cli", "principalId": "drift-writer", "requestId": request, "operation": "put_page",
        "sourceId": "default", "sourceIncarnation": incarnation, "pageId": null, "slug": "notes/a", "worktreeId": null,
        "topologyGeneration": null, "digest": "digest", "intent": {}, "authority": { "remote": remote },
        "intentBytes": 10, "terminalReservation": 4096, "targetKind": "page", "protocolVersion": 1,
        "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": ["brain"], "clientRequestId": null,
        "state": "queued", "deferredRefreshId": null,
    }));
    s.insert_write_request(&input).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Runs `f` in a transaction attributed to request `id` (`None`: under no attribution setting).
fn as_request(s: &Brain, id: Option<&str>, f: impl FnOnce(&gbrain_store::Store)) {
    let tx = s.begin_transaction(false).unwrap();
    if let Some(id) = id {
        let names = [
            "gbrain.write_request",
            "gbrain.write_principal_kind",
            "gbrain.write_principal_id",
        ]
        .map(String::from);
        tx.apply_write_trust(
            &names,
            &[id.into(), "local_cli".into(), "drift-writer".into()],
        )
        .unwrap();
    }
    f(&tx);
    tx.commit_transaction().unwrap();
}

fn writer(row: &Value) -> (Value, Value, Value) {
    (
        row["req"].clone(),
        row["kind"].clone(),
        row["remote"].clone(),
    )
}

#[test]
fn a_revision_and_a_version_carry_the_request_kind_and_transport_of_their_writer() {
    let s = brain("drift-writers");
    let local = request(&s, REQ_LOCAL, false);
    let remote = request(&s, REQ_REMOTE, true);
    let page = |tx: &gbrain_store::Store, slug: &str, body: &str| {
        let input: PageInput =
            args(json!({ "type": "note", "title": slug, "compiled_truth": body }));
        tx.put_page(slug, &input, &PutPageOptions::default())
            .unwrap();
    };
    as_request(&s, Some(&local), |tx| page(tx, "notes/a", "one"));
    as_request(&s, Some(&remote), |tx| {
        tx.create_version("notes/a", None).unwrap();
        page(tx, "notes/a", "two");
    });
    as_request(&s, Some(&local), |tx| page(tx, "notes/moved", "one"));
    as_request(&s, None, |tx| page(tx, "notes/moved", "two"));
    as_request(&s, Some(&remote), |tx| page(tx, "notes/same", "one"));
    as_request(&s, None, |tx| {
        tx.create_version("notes/same", None).unwrap();
    });
    let rows = live(&s, json!({ "sourceId": "default" }));
    let by_slug = |slug: &str| rows.iter().find(|r| r["slug"] == slug).unwrap();
    let remote_writer = (json!(remote), json!("local_cli"), json!("true"));
    let nobody = (Value::Null, Value::Null, Value::Null);
    assert_eq!(writer(by_slug("notes/a")), remote_writer);
    // A write with no principal that moves the revision clears its writer.
    assert_eq!(writer(by_slug("notes/moved")), nobody);
    assert_eq!(writer(by_slug("notes/same")), remote_writer);
    let ids: Vec<i64> = rows.iter().map(|r| r["id"].as_i64().unwrap()).collect();
    let versions = s
        .list_drift_version_rows(&args(json!({ "pageIds": ids })))
        .unwrap();
    assert_eq!(versions.len(), 2);
    // The version of notes/a was archived by the remote request; the one of notes/same under no principal.
    assert_eq!(writer(&versions[0]), remote_writer);
    assert_eq!(writer(&versions[1]), nobody);
}

#[test]
fn a_write_request_setting_that_is_not_a_uuid_refuses_the_page_write() {
    let s = brain("drift-bad-request");
    let tx = s.begin_transaction(false).unwrap();
    let names = ["gbrain.write_request", "gbrain.write_principal_kind"].map(String::from);
    tx.apply_write_trust(&names, &["req-1".into(), "local_cli".into()])
        .unwrap();
    let input: PageInput = args(json!({ "type": "note", "title": "a", "compiled_truth": "a" }));
    let err = tx
        .put_page("notes/a", &input, &PutPageOptions::default())
        .unwrap_err();
    assert!(err.message.contains("not a UUID"), "{}", err.message);
    tx.rollback_transaction().unwrap();
}

#[test]
fn an_unattributed_row_carries_no_write_attribution_and_an_unstamped_page_reads_unknown() {
    let s = brain("drift-attribution");
    put(&s, "notes/a", "body");
    let row = &live(&s, json!({ "sourceId": "default" }))[0];
    for key in ["req", "kind", "remote"] {
        assert!(row[key].is_null(), "{key} must be null");
    }
    assert_eq!(row["trust_tier"], "unknown");
    assert!(row["revision"].is_string());
}

#[test]
fn version_rows_come_for_the_given_pages_with_their_frontmatter() {
    let s = brain("drift-versions");
    put(&s, "notes/a", "one");
    put(&s, "notes/b", "two");
    s.create_version("notes/a", None).unwrap();
    let ids: Vec<i64> = live(&s, json!({ "sourceId": "default" }))
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    let rows = s
        .list_drift_version_rows(&args(json!({ "pageIds": ids })))
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["page_id"], ids[0]);
    assert!(rows[0]["req"].is_null() && rows[0]["kind"].is_null() && rows[0]["remote"].is_null());
    assert!(
        s.list_drift_version_rows(&args(json!({ "pageIds": [ids[1]] })))
            .unwrap()
            .is_empty()
    );
}

/// Admits a journal request whose authority carries `remote`, and returns its row id.
fn admit(s: &Brain, n: u32, remote: Value) -> String {
    let membership = s.read_source_membership("default").unwrap().unwrap();
    let input: gbrain_store::persistence::WriteRequestInsert = args(json!({
        "principalKind": "local_cli", "principalId": "w", "requestId": format!("c0000000-0000-4000-8000-00000000000{n}"),
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": membership["incarnation"],
        "pageId": null, "slug": "notes/a", "worktreeId": null, "topologyGeneration": null, "digest": format!("d{n}"),
        "intent": {}, "authority": { "remote": remote }, "intentBytes": 10, "terminalReservation": 4096,
        "targetKind": "page", "protocolVersion": 1, "admitterVersion": "t", "admitterHostId": null,
        "counterKeys": [], "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }));
    s.insert_write_request(&input).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

/// Runs `f` in a transaction whose writes are attributed to request `id` under `kind`.
fn attributed(s: &Brain, id: &str, kind: &str, f: impl FnOnce(&gbrain_store::Store)) {
    let tx = s.begin_transaction(false).unwrap();
    let names = [
        "gbrain.write_request",
        "gbrain.write_principal_kind",
        "gbrain.write_principal_id",
    ]
    .map(String::from);
    tx.apply_write_trust(&names, &[id.to_string(), kind.to_string(), "w".to_string()])
        .unwrap();
    f(&tx);
    tx.commit_transaction().unwrap();
}

#[test]
fn an_attributed_page_and_version_carry_their_request_kind_and_remote_flag() {
    let s = brain("drift-attributed");
    let wrote = admit(&s, 1, json!(true));
    let archived = admit(&s, 2, json!(false));
    attributed(&s, &wrote, "mcp_token", |tx| {
        let input: PageInput =
            args(json!({ "type": "note", "title": "a", "compiled_truth": "one" }));
        tx.put_page("notes/a", &input, &PutPageOptions::default())
            .unwrap();
    });
    attributed(&s, &archived, "local_cli", |tx| {
        tx.create_version("notes/a", None).unwrap();
    });
    let row = &live(&s, json!({ "sourceId": "default" }))[0];
    assert_eq!(
        [&row["req"], &row["kind"], &row["remote"]],
        [&json!(wrote), &json!("mcp_token"), &json!("true")]
    );
    let versions = s
        .list_drift_version_rows(&args(json!({ "pageIds": [row["id"]] })))
        .unwrap();
    assert_eq!(
        [
            &versions[0]["req"],
            &versions[0]["kind"],
            &versions[0]["remote"]
        ],
        [&json!(archived), &json!("local_cli"), &json!("false")]
    );
}
