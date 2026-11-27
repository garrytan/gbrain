//! The four reads the enforced member CLI makes around a write (`readStoredPageLabels`, `readSlugFolderRules`,
//! `readMemberPageReadable`, `readHiddenPageSlugs`) through the public store API, on a store that was closed and
//! opened again, so they read the persisted page and rule records and nothing held in memory.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::access_rules::AccessRuleRecord;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, source: &str, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": format!("body of {slug}"), "frontmatter": frontmatter}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn member(identity: &str, satisfied: &[&str]) -> PrivacyPolicy {
    serde_json::from_value(json!({
        "honorAliases": false, "entityPrivacy": true, "ownerOnly": "fn", "identity": [identity],
        "privateReadableSources": [], "callerRecord": true, "satisfiedRuleIds": satisfied,
    }))
    .unwrap()
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    let vault: SourceInput =
        serde_json::from_value(json!({"id": "vault", "name": "vault"})).unwrap();
    store.upsert_source(&vault).unwrap();
    store.put_access_policy_state("default").unwrap();
    store
        .put_access_rule(AccessRuleRecord {
            source_id: "default".into(),
            rule_id: "team-a".into(),
            prefix: "team-a/".into(),
            readable_by: vec!["group:team-a".into()],
            revision: 1,
            covers_derived: true,
            created_by: None,
        })
        .unwrap();
    put(&store, "default", "notes/open", json!({}));
    put(
        &store,
        "default",
        "notes/listed",
        json!({"readable_by": ["member:tess-example"]}),
    );
    put(
        &store,
        "default",
        "notes/private",
        json!({"visibility": "private"}),
    );
    put(
        &store,
        "default",
        "notes/gone",
        json!({"readable_by": ["member:tess-example"]}),
    );
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    put(&store, "default", "team-a/plan", json!({}));
    put(
        &store,
        "default",
        "notes/twin",
        json!({"readable_by": ["member:bob-example"]}),
    );
    put(&store, "vault", "notes/twin", json!({}));
    store
}

#[test]
fn the_reads_answer_from_the_persisted_records() {
    let dir = TempDir::new("enforced-member-reads");
    drop(seeded(&dir));
    let store = open(&dir);

    let labels = store
        .read_stored_page_labels("default", "notes/gone")
        .unwrap()
        .unwrap();
    assert_eq!(labels["compiled_truth"], json!("body of notes/gone"));
    assert_eq!(labels["body_storage"], json!("inline"));
    assert!(
        store
            .read_stored_page_labels("vault", "notes/gone")
            .unwrap()
            .is_none()
    );

    assert_eq!(
        store
            .read_slug_folder_rules("default", "team-a/new")
            .unwrap(),
        Some(vec!["default:team-a".to_string()])
    );
    assert_eq!(
        store
            .read_slug_folder_rules("default", "notes/new")
            .unwrap(),
        None
    );

    let tess = member("member:tess-example", &[]);
    let readable = |slug: &str, policy: &PrivacyPolicy| {
        store
            .read_member_page_readable("default", slug, policy)
            .unwrap()
    };
    assert_eq!(readable("notes/listed", &tess), Some(true));
    assert_eq!(readable("notes/gone", &tess), Some(true));
    assert_eq!(readable("notes/private", &tess), Some(false));
    assert_eq!(readable("team-a/plan", &tess), Some(false));
    assert_eq!(
        readable(
            "team-a/plan",
            &member("member:tess-example", &["default:team-a"])
        ),
        Some(true)
    );
    assert_eq!(readable("notes/none", &tess), None);

    let slugs: Vec<String> = ["notes/open", "notes/private", "team-a/plan", "notes/twin"]
        .map(String::from)
        .to_vec();
    assert_eq!(
        store.read_hidden_page_slugs(&slugs, &[], &tess).unwrap(),
        ["notes/private", "team-a/plan"].map(String::from)
    );
    assert_eq!(
        store
            .read_hidden_page_slugs(&slugs, &["vault".to_string()], &tess)
            .unwrap(),
        ["notes/private", "notes/twin", "team-a/plan"].map(String::from)
    );
}
