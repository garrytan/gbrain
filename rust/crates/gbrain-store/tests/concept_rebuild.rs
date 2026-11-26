//! The held-concept rebuild's reads: the held predicate (re-derive mark at the delete, no owed purge), the stated kinds,
//! the access read and the held-concept report.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::concept_rebuild::StatedKindLists;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::generations::needs_rederive::MarkRederiveArgs;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use serde_json::{Value, json};

const OWED: &str = "owed-page-purge";

fn put(store: &Store, slug: &str, page: Value) {
    let input: PageInput = serde_json::from_value(page).unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn concept(title: &str, frontmatter: Value) -> Value {
    let mut fm = json!({"synthesized_by": "synthesize_concepts:v1"});
    fm.as_object_mut()
        .unwrap()
        .extend(frontmatter.as_object().unwrap().clone());
    json!({"type": "concept", "title": title, "compiled_truth": "narrative", "frontmatter": fm})
}

/// Puts a concept, soft-deletes it and marks it at its delete; its page id is `id`.
fn hold(store: &Store, slug: &str, id: u64, frontmatter: Value) {
    put(
        store,
        slug,
        concept(slug.rsplit('/').next().unwrap(), frontmatter),
    );
    store.soft_delete_page(slug, Some("default")).unwrap();
    store
        .mark_needs_rederive(&MarkRederiveArgs {
            table: "pages".into(),
            ids: vec![id.to_string()],
            source_id: Some("default".into()),
            request_id: None,
            reason: "input_purged".into(),
            hidden_now: vec![id.to_string()],
        })
        .unwrap();
}

fn lists() -> StatedKindLists {
    StatedKindLists {
        derived_link_sources: vec!["markdown".into(), "mentions".into()],
        stated_label_keys: vec!["readable_by".into()],
        synthesis_keys: vec![
            "type".into(),
            "title".into(),
            "synthesized_by".into(),
            "visibility".into(),
        ],
    }
}

#[test]
fn a_concept_is_held_while_its_mark_is_at_its_delete_and_no_purge_is_owed() {
    let dir = TempDir::new("concept-held");
    let store = open(&dir);
    hold(&store, "concepts/held", 1, json!({}));
    let held = store.read_held_concept(1, OWED).unwrap().unwrap();
    assert!(held.deleted_us.chars().all(|c| c.is_ascii_digit()));
    assert!(
        store
            .is_concept_still_held(1, &held.deleted_us, OWED)
            .unwrap()
    );
    assert!(!store.is_concept_still_held(1, "1", OWED).unwrap());
    assert!(
        store
            .lock_held_concept(1, "default", "concepts/held", &held.deleted_us, OWED)
            .unwrap()
    );
    assert!(
        !store
            .lock_held_concept(1, "default", "concepts/other", &held.deleted_us, OWED)
            .unwrap()
    );
    assert!(store.read_held_concept(0, OWED).unwrap().is_none());
    assert!(
        store
            .read_held_concept(i64::from(i32::MAX) + 1, OWED)
            .is_err()
    );
    store
        .insert_op_checkpoint_if_absent(OWED, "1", &json!([]))
        .unwrap();
    assert!(store.read_held_concept(1, OWED).unwrap().is_none());
    let window = store.read_tombstone_window(1, 72.0).unwrap().unwrap();
    assert!(window.until.ends_with('Z') && window.until.len() == 20 && !window.past);
    assert!(store.read_tombstone_window(1, 0.0).unwrap().unwrap().past);
    assert!(store.read_tombstone_window(1, f64::NAN).is_err());
}

#[test]
fn the_stated_kinds_name_what_synthesis_did_not_write() {
    let dir = TempDir::new("concept-stated");
    let store = open(&dir);
    put(
        &store,
        "notes/from",
        json!({"type": "note", "title": "from", "compiled_truth": "body", "frontmatter": {}}),
    );
    hold(&store, "concepts/plain", 2, json!({"visibility": "world"}));
    hold(
        &store,
        "concepts/extra",
        3,
        json!({"owner_note": "x", "tags": []}),
    );
    hold(
        &store,
        "concepts/labelled",
        4,
        json!({"readable_by": ["member:alice-example"]}),
    );
    let link = |link_source: &str| {
        let options: AddLinkOptions =
            serde_json::from_value(json!({"linkType": "mentions", "linkSource": link_source}))
                .unwrap();
        store
            .add_link("notes/from", "concepts/plain", &options)
            .unwrap();
    };
    link("markdown");
    let kinds = |id: i64, slug: &str| {
        store
            .read_concept_stated_kinds(id, "default", slug, &lists())
            .unwrap()
            .kinds
    };
    assert!(kinds(2, "concepts/plain").is_empty());
    link("manual");
    assert_eq!(kinds(2, "concepts/plain"), ["links"]);
    assert_eq!(kinds(3, "concepts/extra"), ["frontmatter"]);
    assert_eq!(kinds(4, "concepts/labelled"), ["labels"]);
    let missing = store
        .read_concept_stated_kinds(99, "default", "concepts/none", &lists())
        .unwrap();
    assert!(missing.kinds.is_empty() && missing.lead.is_none() && missing.segmented.is_none());
    let lead = store
        .read_concept_stated_kinds(2, "default", "concepts/plain", &lists())
        .unwrap();
    assert_eq!(
        (lead.lead.as_deref(), lead.segmented),
        (Some("narrative"), Some(false))
    );
}

#[test]
fn the_access_read_and_the_held_report_judge_the_page_by_the_no_caller_policy() {
    let dir = TempDir::new("concept-access");
    let store = open(&dir);
    hold(&store, "concepts/world", 1, json!({"visibility": "world"}));
    hold(&store, "concepts/private", 2, json!({}));
    hold(
        &store,
        "concepts/labelled",
        3,
        json!({"visibility": "world", "readable_by": "member:alice-example"}),
    );
    let policy = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    let world = store.read_rebuild_access(1, &policy).unwrap().unwrap();
    assert!(world.open && world.public_part && world.readers.is_none());
    let private = store.read_rebuild_access(2, &policy).unwrap().unwrap();
    assert!(!private.open && !private.public_part);
    let labelled = store.read_rebuild_access(3, &policy).unwrap().unwrap();
    assert_eq!(
        labelled.readers.as_deref(),
        Some(&["member:alice-example".to_string()][..])
    );
    assert!(!labelled.open && labelled.public_part);
    assert!(store.read_rebuild_access(99, &policy).unwrap().is_none());
    let rows = store.read_held_concept_rows(OWED, true, &policy).unwrap();
    let report: Vec<(&str, bool)> = rows.iter().map(|r| (r.slug.as_str(), r.private)).collect();
    assert_eq!(
        report,
        [
            ("concepts/labelled", false),
            ("concepts/private", true),
            ("concepts/world", false)
        ]
    );
}
