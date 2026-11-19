//! The reads `remember` and `forget` make before admission (`memory_mutation_reads.rs`): the source write row and
//! checkout, a fact's entity, a live file-backed page among slugs, whether a caller reads a fact, and the tier of the
//! world fact a remote forget targets, and the fact a forget names.

mod memory_env;

use gbrain_store::facts::InsertFactsArgs;
use gbrain_store::memory_mutation_reads::{
    FactReadableQuery, ForgetTargetQuery, OwnPage, RemoteFloor, RemoteForgetTierQuery,
};
use gbrain_store::sources::SourceInput;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn page(b: &Brain, slug: &str, frontmatter: Value, source_path: Option<&str>) {
    let input: gbrain_store::pages::PageInput = args(json!({
        "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter, "source_path": source_path }));
    b.put_page(slug, &input, &args(json!({}))).unwrap();
}

fn fact(b: &Brain, source: &str, name: &str, page: &str, visibility: &str, row: u32) -> u64 {
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(json!({
            "rows": [{ "fact": name, "entity_slug": "people/e-example", "source_markdown_slug": page,
                "row_num": row, "kind": "fact", "visibility": visibility, "source": "fence" }],
            "sourceId": source,
        })))
        .unwrap();
    out["ids"][0].as_u64().unwrap()
}

fn source(b: &Brain, id: &str, local_path: Option<&str>, config: Value) {
    b.upsert_source(&SourceInput {
        id: id.into(),
        name: Some(id.into()),
        local_path: local_path.map(String::from),
        config: Some(args(config)),
        ..SourceInput::default()
    })
    .unwrap();
}

#[test]
fn the_source_write_row_reads_kind_and_role_as_jsonb_text() {
    let b = brain("memory-mutation-reads-source");
    source(
        &b,
        "kinded",
        Some("/var/brain/kinded"),
        json!({ "kind": "memory", "role": "scope" }),
    );
    source(&b, "odd", None, json!({ "kind": 3, "role": null }));
    let kinded = b.read_source_write_row("kinded").unwrap().unwrap();
    assert_eq!(kinded["archived"], json!(false));
    assert_eq!(kinded["local_path"], json!("/var/brain/kinded"));
    assert_eq!(
        (&kinded["kind"], &kinded["role"]),
        (&json!("memory"), &json!("scope"))
    );
    assert!(!kinded["incarnation"].as_str().unwrap().is_empty());
    let odd = b.read_source_write_row("odd").unwrap().unwrap();
    assert_eq!(
        (&odd["kind"], &odd["role"], &odd["local_path"]),
        (&json!("3"), &Value::Null, &Value::Null)
    );
    assert_eq!(b.read_source_write_row("no-such").unwrap(), None);
    assert_eq!(
        b.read_source_local_path("kinded").unwrap().as_deref(),
        Some("/var/brain/kinded")
    );
    assert_eq!(b.read_source_local_path("odd").unwrap(), None);
    assert_eq!(b.read_source_local_path("no-such").unwrap(), None);
    assert!(b.read_source_write_row("bad\0id").is_err());
}

#[test]
fn a_fact_entity_reads_only_in_the_fact_source() {
    let b = brain("memory-mutation-reads-entity");
    source(&b, "other", None, json!({}));
    let id = fact(&b, "default", "Pat likes tea", "notes/open", "world", 1);
    assert_eq!(
        b.read_fact_entity_slug(id as i64, "default")
            .unwrap()
            .as_deref(),
        Some("people/e-example")
    );
    assert_eq!(b.read_fact_entity_slug(id as i64, "other").unwrap(), None);
    assert_eq!(b.read_fact_entity_slug(-1, "default").unwrap(), None);
    assert_eq!(
        b.read_fact_entity_slug(id as i64 + 100, "default").unwrap(),
        None
    );
}

#[test]
fn a_live_file_backed_page_is_found_among_the_slugs() {
    let b = brain("memory-mutation-reads-file");
    page(&b, "notes/filed", json!({}), Some("notes/filed.md"));
    page(&b, "notes/unfiled", json!({}), None);
    page(&b, "notes/gone", json!({}), Some("notes/gone.md"));
    b.soft_delete_page("notes/gone", None).unwrap();
    let has = |slugs: &[&str]| {
        let slugs: Vec<String> = slugs.iter().map(|s| s.to_string()).collect();
        b.has_live_file_backed_page("default", &slugs).unwrap()
    };
    assert!(has(&["notes/unfiled", "notes/filed"]));
    assert!(!has(&["notes/unfiled"]));
    assert!(!has(&["notes/gone"]));
    assert!(!has(&[]));
}

#[test]
fn a_fact_is_readable_under_the_visibility_rule_eligibility_and_provenance_policy() {
    let b = brain("memory-mutation-reads-readable");
    page(&b, "notes/open", json!({}), None);
    page(
        &b,
        "notes/quarantined",
        json!({ "quarantine": { "reason": "junk_pattern" } }),
        None,
    );
    page(&b, "notes/deleted", json!({}), None);
    let world = fact(&b, "default", "open world", "notes/open", "world", 1);
    let private = fact(&b, "default", "open private", "notes/open", "private", 2);
    let quarantined = fact(
        &b,
        "default",
        "quarantined",
        "notes/quarantined",
        "world",
        3,
    );
    let deleted = fact(&b, "default", "deleted", "notes/deleted", "world", 4);
    b.soft_delete_page("notes/deleted", None).unwrap();
    let readable = |id: u64, source: &str, any: bool| {
        b.fact_readable_under(&FactReadableQuery {
            id: id as i64,
            source_id: source.into(),
            any_visibility: any,
            min_trust: None,
            suppress_flagged: false,
            exclude_private: None,
        })
        .unwrap()
    };
    assert!(readable(world, "default", false));
    assert!(readable(private, "default", true));
    assert!(!readable(private, "default", false));
    assert!(!readable(quarantined, "default", true));
    assert!(!readable(deleted, "default", true));
    assert!(!readable(world, "other", true));
    assert!(!readable(world + 100, "default", true));
}

#[test]
fn a_remote_forget_reads_the_tier_of_a_world_fact_under_the_remote_floor() {
    let b = brain("memory-mutation-reads-remote-forget");
    page(&b, "notes/open", json!({}), None);
    page(
        &b,
        "notes/private",
        json!({ "visibility": "private" }),
        None,
    );
    page(&b, "notes/aliased", json!({ "access": "restricted" }), None);
    let world = fact(&b, "default", "open world", "notes/open", "world", 1);
    let private = fact(&b, "default", "open private", "notes/open", "private", 2);
    let hidden = fact(
        &b,
        "default",
        "on private page",
        "notes/private",
        "world",
        3,
    );
    let aliased = fact(
        &b,
        "default",
        "on aliased page",
        "notes/aliased",
        "world",
        4,
    );
    let missing = fact(
        &b,
        "default",
        "missing page",
        "notes/never-written",
        "world",
        5,
    );
    page(
        &b,
        "notes/readers",
        json!({ "readable_by": ["member:alice-example"] }),
        None,
    );
    let readers = fact(
        &b,
        "default",
        "on readers page",
        "notes/readers",
        "world",
        6,
    );
    let tier = |id: u64, source: &str, floor: Option<bool>| {
        b.read_remote_forget_tier(&RemoteForgetTierQuery {
            fact_id: id as i64,
            source_id: source.into(),
            remote_floor: floor.map(|honor_aliases| RemoteFloor {
                honor_aliases,
                restricted: true,
            }),
        })
        .unwrap()
    };
    let stored = tier(world, "default", None).expect("a world fact has a tier");
    assert!(!stored.is_empty());
    assert_eq!(tier(world, "default", Some(false)), Some(stored.clone()));
    assert_eq!(tier(private, "default", None), None);
    assert_eq!(tier(hidden, "default", None), Some(stored.clone()));
    assert_eq!(tier(hidden, "default", Some(false)), None);
    assert_eq!(tier(aliased, "default", Some(false)), Some(stored.clone()));
    assert_eq!(tier(aliased, "default", Some(true)), None);
    assert_eq!(tier(missing, "default", Some(true)), Some(stored.clone()));
    assert_eq!(tier(world, "other", None), None);
    assert_eq!(tier(world + 100, "default", None), None);
    let named = |restricted: bool| {
        b.read_remote_forget_tier(&RemoteForgetTierQuery {
            fact_id: readers as i64,
            source_id: "default".into(),
            remote_floor: Some(RemoteFloor {
                honor_aliases: true,
                restricted,
            }),
        })
        .unwrap()
    };
    assert_eq!(named(true), None);
    assert_eq!(named(false), None);
}

#[test]
fn the_forget_target_reads_under_visibility_the_floor_and_a_member_page() {
    let b = brain("memory-mutation-reads-forget-target");
    source(&b, "other", None, json!({}));
    page(&b, "notes/open", json!({}), None);
    page(
        &b,
        "notes/private",
        json!({ "visibility": "private" }),
        None,
    );
    page(
        &b,
        "memory/members/alice-example",
        json!({ "readable_by": ["member:alice-example"] }),
        None,
    );
    let world = fact(&b, "default", "open world", "notes/open", "world", 1);
    let private = fact(&b, "default", "open private", "notes/open", "private", 2);
    let hidden = fact(
        &b,
        "default",
        "on private page",
        "notes/private",
        "world",
        3,
    );
    let mine = fact(
        &b,
        "default",
        "alice private",
        "memory/members/alice-example",
        "private",
        4,
    );
    let read = |id: u64, world_only: bool, floor: bool, own: Option<&str>| {
        b.read_forget_target(&ForgetTargetQuery {
            id: id as i64,
            source_id: "default".into(),
            world_only,
            remote_floor: floor.then_some(RemoteFloor {
                honor_aliases: true,
                restricted: true,
            }),
            own_page: own.map(|slug| OwnPage {
                slug: slug.into(),
                reader: "member:alice-example".into(),
            }),
        })
        .unwrap()
    };
    let row = read(world, false, false, None).expect("the owner reads a world fact");
    assert_eq!(row["id"], json!(world));
    assert_eq!(row["entity_slug"], json!("people/e-example"));
    assert_eq!(row["source_markdown_slug"], json!("notes/open"));
    assert_eq!(row["row_num"], json!(1));
    assert_eq!(row["expired_at"], Value::Null);
    assert!(read(private, false, false, None).is_some());
    assert!(read(private, true, false, None).is_none());
    assert!(read(hidden, true, false, None).is_some());
    assert!(read(hidden, true, true, None).is_none());
    assert!(read(world, true, true, None).is_some());
    let own = Some("memory/members/alice-example");
    assert!(read(mine, true, false, own).is_some());
    assert!(read(world, true, false, own).is_none());
    assert!(read(mine, true, false, Some("notes/open")).is_none());
    assert!(read(world + 100, false, false, None).is_none());
}
