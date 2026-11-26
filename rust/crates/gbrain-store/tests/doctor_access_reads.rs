//! The doctor reads of the access and generation checks (`listLiveGenerationRetirements`,
//! `listHeldGenerations`, `listReaderPages`, `countAccessFolderDrift`),
//! matched to the statements of `src/core/engine-sql/doctor-derived.ts`, `doctor-acc.ts` and
//! `access-policy.ts`.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::access_rules::AccessRuleRecord;
use gbrain_store::generations::{ActivationInput, GenerationKey, HeldInput, LedgerItemInput};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, source: &str, slug: &str, page_type: &str, title: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(json!({
        "type": page_type, "title": title, "compiled_truth": "body", "frontmatter": frontmatter,
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({ "sourceId": source })).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            ..Default::default()
        })
        .unwrap();
}

fn generation(store: &Store, source_id: &str, kind: &str, n: u32, retired: bool) {
    let key = GenerationKey {
        source_id: source_id.into(),
        kind: kind.into(),
        owner_key: "owner".into(),
    };
    let row = ActivationInput {
        generation: 1.0,
        run_id: None,
        operation_id: format!("op-live-{n}"),
        input_pin: None,
        input_size: None,
        completeness: "{}".into(),
        set_hash: "hash".into(),
        restore_of: None,
        activation_id: None,
        locator: None,
    };
    let item = LedgerItemInput {
        item_key: "item".into(),
        identity_hash: "identity".into(),
        action: if retired { "retired" } else { "published" }.into(),
        preimage: None,
        preimage_bytes: None,
        pending: false,
    };
    store
        .activate_generation_rows(&key, None, &row, &[item])
        .unwrap();
    store
        .record_held_generation_row(
            &key,
            &HeldInput {
                hold_id: format!("hold-{n}"),
                run_id: None,
                input_pin: None,
                input_size: None,
                set_hash: "hash".into(),
                reason: "shrunk".into(),
                context: "{}".into(),
                proposal: None,
                proposal_bytes: 0.0,
            },
        )
        .unwrap();
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| s.to_string()).collect()
}

#[test]
fn generation_retirements_and_held_rows_group_by_source_and_kind_in_byte_order() {
    let dir = TempDir::new("doctor-generations");
    let store = open(&dir);
    for id in ["ab", "a-z"] {
        source(&store, id);
    }
    let mut n = 0;
    for id in ["ab", "a-z"] {
        for kind in ["kb", "k-z"] {
            n += 1;
            generation(&store, id, kind, n, true);
        }
    }
    // A live generation that retired nothing is not listed as a retirement; its held row still counts.
    n += 1;
    generation(&store, "a-z", "k-a", n, false);

    let sources = strings(&["ab", "a-z", "missing"]);
    let retired = store
        .list_live_generation_retirements(&sources, 30.0)
        .unwrap();
    let keys: Vec<String> = retired
        .iter()
        .map(|r| {
            format!(
                "{}/{}",
                r["source_id"].as_str().unwrap(),
                r["kind"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(keys, ["a-z/k-z", "a-z/kb", "ab/k-z", "ab/kb"]);
    assert!(
        retired
            .iter()
            .all(|r| r["keys"] == json!(1) && r["items"] == json!(1))
    );
    assert!(retired[0]["oldest"].as_str().unwrap().ends_with("+00"));
    // A window too short for a row made just now still holds it; a negative one holds none.
    assert_eq!(
        store
            .list_live_generation_retirements(&sources, 0.5)
            .unwrap()
            .len(),
        4
    );
    assert!(
        store
            .list_live_generation_retirements(&sources, -1.0)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .list_live_generation_retirements(&strings(&["missing"]), 30.0)
            .unwrap()
            .is_empty()
    );

    let held = store.list_held_generations(&sources).unwrap();
    let keys: Vec<String> = held
        .iter()
        .map(|r| {
            format!(
                "{}/{} {}",
                r["source_id"].as_str().unwrap(),
                r["kind"].as_str().unwrap(),
                r["held_reason"].as_str().unwrap()
            )
        })
        .collect();
    assert_eq!(
        keys,
        [
            "a-z/k-a shrunk",
            "a-z/k-z shrunk",
            "a-z/kb shrunk",
            "ab/k-z shrunk",
            "ab/kb shrunk"
        ]
    );
    assert!(held.iter().all(|r| r["count"] == json!(1)));
}

#[test]
fn reader_pages_list_live_pages_naming_readers_with_the_newest_earlier_version() {
    let dir = TempDir::new("doctor-reader-pages");
    let store = open(&dir);
    put(
        &store,
        "default",
        "notes/valid",
        "note",
        "valid",
        json!({"readable_by": ["member:b", "Group:Team", "member:b"]}),
    );
    put(
        &store,
        "default",
        "notes/bad",
        "note",
        "bad",
        json!({"readable_by": ["!! no !!"]}),
    );
    put(&store, "default", "notes/none", "note", "none", json!({}));
    put(
        &store,
        "default",
        "notes/gone",
        "note",
        "gone",
        json!({"readable_by": ["member:x"]}),
    );
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();

    let rows = store.list_reader_pages(None).unwrap();
    let slugs: Vec<&str> = rows.iter().map(|r| r["slug"].as_str().unwrap()).collect();
    assert_eq!(slugs, ["notes/bad", "notes/valid"]);
    assert_eq!(rows[0]["readers"], json!(["!nobody"]));
    assert_eq!(rows[1]["readers"], json!(["group:team", "member:b"]));
    assert_eq!(rows[1]["prior_names_readers"], Value::Null);
    assert_eq!(rows[1]["writer"], Value::Null);
    assert!(rows[1]["updated_at"].as_str().unwrap().ends_with("+00"));
    assert_eq!(store.list_reader_pages(Some(7.0)).unwrap().len(), 2);
    assert!(store.list_reader_pages(Some(-1.0)).unwrap().is_empty());
}

#[test]
fn folder_drift_counts_pages_whose_kept_rule_ids_differ_from_the_rules_now() {
    let dir = TempDir::new("doctor-folder-drift");
    let store = open(&dir);
    put(&store, "default", "hr/review", "note", "x", json!({}));
    put(&store, "default", "notes/open", "note", "x", json!({}));
    assert_eq!(store.count_access_folder_drift("default").unwrap(), 0);
    store.put_access_policy_state("default").unwrap();
    store
        .put_access_rule(AccessRuleRecord {
            source_id: "default".into(),
            rule_id: "hr".into(),
            prefix: "hr/".into(),
            readable_by: strings(&["member:parity"]),
            revision: 1,
            covers_derived: true,
            created_by: None,
        })
        .unwrap();
    // The rule arrived after the page: its kept ids are older than the rules, until a restamp.
    assert_eq!(store.count_access_folder_drift("default").unwrap(), 1);
    store.finish_access_restamp("default").unwrap();
    assert_eq!(store.count_access_folder_drift("default").unwrap(), 0);
    assert_eq!(store.count_access_folder_drift("other").unwrap(), 0);
}
