//! The atom generation adapter's reads, matched to PGLite (`engine-sql/generation-atom-reads.ts`):
//! the origin input of a live page, the stored versions the `extract_atoms` producer wrote, and
//! the committed managed atom write receipts whose activation activated.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::generations::{
    ActivationInput, ActivationRecordInput, GenerationKey, LedgerItemInput,
};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::persistence::{ClaimStamp, WriteCompletion, WriteRequestInsert};
use serde_json::{Value, json};

const TOKEN: &str = "c0000000-0000-4000-8000-0000000000c1";
const PRINCIPAL_KEY: &str = "principal:local_cli:parity-writer";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(store: &Store, slug: &str, page: Value) {
    store
        .put_page(
            slug,
            &args::<PageInput>(page),
            &args::<PutPageOptions>(json!({})),
        )
        .unwrap();
}

fn counter_keys() -> Vec<String> {
    vec![PRINCIPAL_KEY.into(), "brain".into()]
}

fn committed(store: &Store, request: &str, slug: &str, intent: Value, state: &str) {
    let incarnation = store.read_source_membership("default").unwrap().unwrap()["incarnation"]
        .as_str()
        .unwrap()
        .to_string();
    store.lock_persistence_counters(&counter_keys()).unwrap();
    let insert: WriteRequestInsert = args(json!({
        "principalKind": "local_cli", "principalId": "parity-writer", "requestId": request,
        "operation": "put_page", "sourceId": "default", "sourceIncarnation": incarnation,
        "pageId": null, "slug": slug, "worktreeId": null, "topologyGeneration": null,
        "digest": "digest", "intent": intent, "authority": {}, "intentBytes": 10,
        "terminalReservation": 4096, "targetKind": "page", "protocolVersion": 1,
        "admitterVersion": "v-test", "admitterHostId": null, "counterKeys": counter_keys(),
        "clientRequestId": null, "state": "queued", "deferredRefreshId": null,
    }));
    let row = store.insert_write_request(&insert).unwrap();
    let id = row["id"].as_str().unwrap().to_string();
    store
        .stamp_write_claim(&ClaimStamp {
            fence: None,
            id: id.clone(),
            token: TOKEN.into(),
            lease_ms: 1000.0,
            phase_json: None,
        })
        .unwrap();
    let completion: WriteCompletion = args(json!({
        "id": id, "state": state, "outcome": { "slug": slug }, "errorCode": null,
        "errorMessage": null, "consumerVersion": "v-consumer",
        "consumerHostId": "d0000000-0000-4000-8000-0000000000d1", "errorDetail": null,
        "resultBytes": 100, "counterKeys": counter_keys(), "intentBytes": 10,
        "retainedBytes": 512, "terminalReservation": 4096, "probePurges": true,
    }));
    store.complete_write_row(&completion).unwrap().unwrap();
}

fn activation(store: &Store, id: &str, activate: bool) {
    let key = GenerationKey {
        source_id: "default".into(),
        kind: "managed_walk".into(),
        owner_key: format!("input:{id}"),
    };
    store
        .record_generation_activation(
            &key,
            &ActivationRecordInput {
                activation_id: id.into(),
                expected_generation: 0.0,
                input_pin: Some("pin".into()),
                set_hash: "h".into(),
                members: "[]".into(),
            },
        )
        .unwrap();
    if !activate {
        return;
    }
    let generation = store
        .activate_generation_rows(
            &key,
            None,
            &ActivationInput {
                generation: 1.0,
                run_id: None,
                operation_id: format!("op-{id}"),
                input_pin: Some("pin".into()),
                input_size: None,
                completeness: "{}".into(),
                set_hash: "h".into(),
                restore_of: None,
                activation_id: Some(id.into()),
                locator: None,
            },
            &[LedgerItemInput {
                item_key: "atoms/x".into(),
                identity_hash: "x".into(),
                action: "published".into(),
                preimage: None,
                preimage_bytes: None,
                pending: false,
            }],
        )
        .unwrap();
    store
        .mark_generation_activated(id, generation as f64)
        .unwrap();
}

fn slugs(rows: &[Value]) -> Vec<&str> {
    rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
}

#[test]
fn atom_origin_input_answers_the_live_page_and_its_body_bytes() {
    let dir = TempDir::new("atom-origin");
    let store = open(&dir);
    put(
        &store,
        "notes/origin",
        json!({ "type": "note", "title": "O", "compiled_truth": "héllo", "timeline": "ab" }),
    );
    let row = store
        .read_atom_origin_input("default", "notes/origin")
        .unwrap();
    assert!(row["id"].as_u64().unwrap() > 0);
    assert!(row["content_hash"].is_string());
    assert!(row["revision"].is_string());
    assert_eq!(row["body_bytes"], json!(8));
    assert_eq!(
        store
            .read_atom_origin_input("other", "notes/origin")
            .unwrap(),
        Value::Null
    );
    store.soft_delete_page("notes/origin", None).unwrap();
    assert_eq!(
        store
            .read_atom_origin_input("default", "notes/origin")
            .unwrap(),
        Value::Null
    );
    assert_eq!(
        store
            .read_atom_origin_input("default", "a\u{0}b")
            .unwrap_err()
            .code,
        INVALID_ARGUMENT
    );
}

#[test]
fn producer_versions_are_the_extract_atoms_versions_with_the_live_visibility() {
    let dir = TempDir::new("atom-versions");
    let store = open(&dir);
    let atom = |by: &str, body: &str, extra: Value| {
        let mut fm = json!({ "extracted_by": by, "source_slug": "notes/origin" });
        if let (Some(fm), Some(extra)) = (fm.as_object_mut(), extra.as_object()) {
            fm.extend(extra.clone());
        }
        json!({ "type": "atom", "title": "A", "compiled_truth": body, "frontmatter": fm })
    };
    put(
        &store,
        "atoms/a",
        atom("extract_atoms:v2", "first", json!({})),
    );
    store.create_version("atoms/a", None).unwrap();
    put(&store, "atoms/a", atom("manual", "second", json!({})));
    store.create_version("atoms/a", None).unwrap();
    put(
        &store,
        "atoms/a",
        atom("manual", "third", json!({ "visibility": "private" })),
    );
    put(&store, "atoms/b", atom("extract_atomsx", "b", json!({})));
    store.create_version("atoms/b", None).unwrap();
    put(&store, "atoms/c", atom("xextract_atoms", "c", json!({})));
    store.create_version("atoms/c", None).unwrap();
    store.soft_delete_page("atoms/b", None).unwrap();

    let listed: Vec<String> = ["atoms/c", "atoms/b", "atoms/a", "atoms/a", "atoms/none"]
        .map(String::from)
        .to_vec();
    let rows = store
        .list_producer_version_rows("default", &listed, "extract_atoms")
        .unwrap();
    assert_eq!(slugs(&rows), ["atoms/a", "atoms/b"]);
    let a = &rows[0];
    assert_eq!(a["type"], json!("atom"));
    assert_eq!(a["title"], json!("A"));
    assert_eq!(a["compiled_truth"], json!("first"));
    assert_eq!(a["frontmatter"]["extracted_by"], json!("extract_atoms:v2"));
    assert_eq!(a["tags"], json!([]));
    assert_eq!(a["live_visibility"], json!("private"));
    assert_eq!(rows[1]["live_visibility"], Value::Null);
    assert!(
        store
            .list_producer_version_rows("other", &listed, "extract_atoms")
            .unwrap()
            .is_empty()
    );
    for (slugs, producer) in [
        (vec!["atoms/a".to_string()], "synthetic"),
        (vec!["a\u{0}b".to_string()], "extract_atoms"),
    ] {
        let err = store
            .list_producer_version_rows("default", &slugs, producer)
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
    }
}

#[test]
fn atom_write_receipts_are_committed_managed_atom_writes_whose_activation_activated() {
    let dir = TempDir::new("atom-receipts");
    let store = open(&dir);
    activation(&store, "act-on", true);
    activation(&store, "act-pending", false);
    let intent = |content: Option<&str>, activation: Option<&str>| {
        let mut intent = json!({ "kind": "managed_atom_page" });
        if let Some(content) = content {
            intent["content"] = json!(content);
        }
        if let Some(activation) = activation {
            intent["activationId"] = json!(activation);
        }
        intent
    };
    let req = |n: u8| format!("b0000000-0000-4000-8000-0000000000{n:02x}");
    committed(
        &store,
        &req(1),
        "atoms/a",
        intent(Some("plain"), None),
        "committed",
    );
    committed(
        &store,
        &req(2),
        "atoms/b",
        intent(Some("activated"), Some("act-on")),
        "committed",
    );
    committed(
        &store,
        &req(3),
        "atoms/c",
        intent(Some("pending"), Some("act-pending")),
        "committed",
    );
    committed(
        &store,
        &req(4),
        "atoms/d",
        intent(Some("missing"), Some("act-gone")),
        "committed",
    );
    committed(&store, &req(5), "atoms/e", intent(None, None), "committed");
    committed(
        &store,
        &req(6),
        "atoms/f",
        intent(Some("failed"), None),
        "failed",
    );
    committed(
        &store,
        &req(7),
        "atoms/g",
        json!({ "kind": "put_page", "content": "other" }),
        "committed",
    );
    committed(
        &store,
        &req(8),
        "atoms/h",
        intent(Some("unlisted"), None),
        "committed",
    );
    let listed: Vec<String> = ["a", "b", "c", "d", "e", "f", "g"]
        .map(|s| format!("atoms/{s}"))
        .to_vec();
    let mut rows = store.list_atom_write_receipts("default", &listed).unwrap();
    rows.sort_by(|x, y| x["slug"].as_str().cmp(&y["slug"].as_str()));
    assert_eq!(
        rows,
        [
            json!({ "slug": "atoms/a", "content": "plain" }),
            json!({ "slug": "atoms/b", "content": "activated" }),
        ]
    );
    assert!(
        store
            .list_atom_write_receipts("other", &listed)
            .unwrap()
            .is_empty()
    );
}
