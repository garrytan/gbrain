//! The reads `remember` and `forget` make before admission (`memory_mutation_reads.rs`): the source write row and
//! checkout, a fact's entity, a live file-backed page among slugs, whether a caller reads a fact, and the tier of the
//! world fact a remote forget targets, and the fact a forget names; and what a forget's withdrawal reaches: an unbacked
//! entity, the linked copies, a copy the floor hides, and the owner's reach.

mod memory_env;

use gbrain_store::facts::{InsertFactsArgs, OwnerOnlyForm};
use gbrain_store::memory_mutation_reads::{
    FactReadableQuery, ForgetTargetQuery, HiddenCopyQuery, LinkedCopiesQuery, OwnPage,
    OwnerReachQuery, RemoteFloor, RemoteForgetTierQuery, WithdrawalClaimQuery,
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
                owner_only: OwnerOnlyForm::Fn,
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
                owner_only: OwnerOnlyForm::Fn,
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
                owner_only: OwnerOnlyForm::Fn,
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

fn claim(
    b: &Brain,
    text: &str,
    entity: Option<&str>,
    page: &str,
    visibility: &str,
    row: u32,
) -> u64 {
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(json!({
            "rows": [{ "fact": text, "entity_slug": entity, "source_markdown_slug": page,
                "row_num": row, "kind": "fact", "visibility": visibility, "source": "fence" }],
            "sourceId": "default",
        })))
        .unwrap();
    out["ids"][0].as_u64().unwrap()
}

fn copies(b: &Brain, id: u64, world_only: bool, floor: bool) -> Vec<String> {
    let q: LinkedCopiesQuery = args(
        json!({ "id": id, "sourceId": "default", "worldOnly": world_only,
        "remoteFloor": floor.then(|| json!({ "honorAliases": true, "restricted": true })) }),
    );
    b.read_linked_fact_copies(&q)
        .unwrap()
        .iter()
        .map(|r| r["entity_slug"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn a_forget_reaches_the_copies_of_its_claim_on_other_entities() {
    let b = brain("memory-mutation-reads-forget-reach");
    page(&b, "people/e-example", json!({}), None);
    page(&b, "notes/open", json!({}), None);
    page(
        &b,
        "notes/private",
        json!({ "visibility": "private" }),
        None,
    );
    let unlinked = claim(&b, "Alice keeps bees", None, "notes/open", "world", 1);
    claim(
        &b,
        "  ALICE keeps   bees ",
        Some("people/e-example"),
        "notes/open",
        "world",
        2,
    );
    claim(
        &b,
        "Alice keeps bees",
        Some("people/f-example"),
        "notes/private",
        "world",
        3,
    );
    claim(
        &b,
        "Alice keeps bees",
        Some("people/g-example"),
        "notes/open",
        "private",
        4,
    );
    let name_key = claim(&b, "Bob bakes", Some("bobname"), "notes/open", "world", 5);
    let backed = claim(
        &b,
        "Bob bakes",
        Some("people/e-example"),
        "notes/open",
        "world",
        6,
    );
    for i in 0..7 {
        claim(
            &b,
            "Dana runs",
            Some(&format!("people/d{i}-example")),
            "notes/open",
            "world",
            10 + i,
        );
    }
    let dana = claim(&b, "Dana runs", None, "notes/open", "world", 20);

    assert!(
        b.is_fact_entity_unbacked(name_key as i64, "default")
            .unwrap()
    );
    assert!(!b.is_fact_entity_unbacked(backed as i64, "default").unwrap());
    assert!(
        !b.is_fact_entity_unbacked(unlinked as i64, "default")
            .unwrap()
    );
    assert!(!b.is_fact_entity_unbacked(name_key as i64, "other").unwrap());
    page(&b, "bobname", json!({}), None);
    assert!(
        !b.is_fact_entity_unbacked(name_key as i64, "default")
            .unwrap()
    );

    assert_eq!(
        copies(&b, unlinked, false, false),
        ["people/e-example", "people/f-example"]
    );
    assert_eq!(copies(&b, unlinked, true, true), ["people/e-example"]);
    assert_eq!(copies(&b, dana, false, false).len(), 5);
    assert_eq!(copies(&b, dana, false, false)[0], "people/d0-example");

    let hidden = |id: u64| {
        b.has_hidden_fact_copy(&args::<HiddenCopyQuery>(
            json!({ "id": id, "sourceId": "default",
            "remoteFloor": { "honorAliases": true, "restricted": true } }),
        ))
        .unwrap()
    };
    assert!(hidden(unlinked));
    assert!(!hidden(backed));
    assert!(!hidden(dana));
}

#[test]
fn an_owner_with_no_member_identity_reaches_only_a_fact_on_no_page() {
    let b = brain("memory-mutation-reads-owner-reach");
    page(&b, "notes/open", json!({}), None);
    page(&b, "notes/deleted", json!({}), None);
    let free = claim(&b, "free", None, "notes/never-written", "world", 1);
    let open = claim(&b, "open", None, "notes/open", "world", 2);
    let deleted = claim(&b, "deleted", None, "notes/deleted", "world", 3);
    let member = claim(
        &b,
        "member",
        None,
        "memory/members/alice-example",
        "world",
        4,
    );
    b.soft_delete_page("notes/deleted", None).unwrap();
    let reach = |id: u64, source: &str| {
        b.owner_reaches_fact(&args::<OwnerReachQuery>(
            json!({ "id": id, "sourceId": source }),
        ))
        .unwrap()
    };
    assert!(reach(free, "default"));
    assert!(!reach(free, "other"));
    assert!(!reach(open, "default"));
    assert!(!reach(deleted, "default"));
    assert!(!reach(member, "default"));
    assert!(!reach(free + 1000, "default"));
}

#[test]
fn an_owner_bound_to_a_member_reaches_the_facts_whose_pages_it_reads() {
    let b = brain("memory-mutation-reads-owner-reach-member");
    page(&b, "people/e-example", json!({}), None);
    page(&b, "notes/open", json!({}), None);
    page(
        &b,
        "notes/private",
        json!({ "visibility": "private" }),
        None,
    );
    page(
        &b,
        "notes/alice",
        json!({ "readable_by": ["member:alice-example"] }),
        None,
    );
    page(
        &b,
        "notes/bob",
        json!({ "readable_by": ["member:bob-example"] }),
        None,
    );
    page(&b, "notes/deleted", json!({}), None);
    page(
        &b,
        "people/hidden-example",
        json!({ "visibility": "private" }),
        None,
    );
    let entity = Some("people/e-example");
    let free = claim(&b, "free", None, "notes/never-written", "world", 1);
    let open = claim(&b, "open", None, "notes/open", "world", 2);
    let private = claim(&b, "private", None, "notes/private", "world", 3);
    let alice = claim(&b, "alice", None, "notes/alice", "world", 4);
    let bob = claim(&b, "bob", None, "notes/bob", "world", 5);
    let deleted = claim(&b, "deleted", None, "notes/deleted", "world", 6);
    let about_open = claim(&b, "about open", entity, "notes/never-written", "world", 7);
    let about_hidden = claim(
        &b,
        "about hidden",
        Some("people/hidden-example"),
        "notes/open",
        "world",
        8,
    );
    let open_page_hidden_entity = claim(
        &b,
        "hidden entity",
        Some("people/hidden-example"),
        "notes/never-written",
        "world",
        9,
    );
    let member = claim(
        &b,
        "member",
        None,
        "memory/members/alice-example",
        "world",
        10,
    );
    b.soft_delete_page("notes/deleted", None).unwrap();
    let reach = |id: u64, policy: Value| {
        let spec = match policy {
            Value::Null => json!({ "id": id, "sourceId": "default" }),
            policy => json!({ "id": id, "sourceId": "default", "policy": policy }),
        };
        b.owner_reaches_fact(&args::<OwnerReachQuery>(spec))
            .unwrap()
    };
    let alice_policy = |extra: Value| {
        let mut policy = json!({ "honorAliases": true, "entityPrivacy": true, "ownerOnly": "off",
            "identity": ["member:alice-example"] });
        for (key, value) in extra.as_object().unwrap() {
            policy[key] = value.clone();
        }
        policy
    };
    let policy = alice_policy(json!({}));
    assert!(reach(free, policy.clone()));
    assert!(reach(open, policy.clone()));
    assert!(reach(about_open, policy.clone()));
    // The page's readers name the owner's member, or another one.
    assert!(reach(alice, policy.clone()));
    assert!(!reach(bob, policy.clone()));
    assert!(!reach(private, policy.clone()));
    // A deleted page record still judges the fact, by its own fields as any page: open here.
    assert!(reach(deleted, policy.clone()));
    // The entity page is judged as the provenance page is.
    assert!(!reach(about_hidden, policy.clone()));
    assert!(!reach(open_page_hidden_entity, policy.clone()));
    // An owned memory page is never reached, and a fact of another source or no fact is not.
    assert!(!reach(member, policy.clone()));
    assert!(!reach(free + 1000, policy.clone()));
    let other = b
        .owner_reaches_fact(&args::<OwnerReachQuery>(
            json!({ "id": free, "sourceId": "other", "policy": policy.clone() }),
        ))
        .unwrap();
    assert!(!other);
    // The short member-access form hides a page that names readers whoever the identity is.
    let short = alice_policy(json!({ "open": true }));
    assert!(reach(open, short.clone()) && reach(free, short.clone()));
    assert!(!reach(alice, short.clone()));
    // A privacy alias counts unless the process setting is off.
    page(&b, "notes/aliased", json!({ "access": "private" }), None);
    let aliased = claim(&b, "aliased", None, "notes/aliased", "world", 11);
    assert!(!reach(aliased, policy.clone()));
    assert!(reach(
        aliased,
        alice_policy(json!({ "honorAliases": false }))
    ));
    // An owner with no valid member principal first reads no page, whatever the policy says: the rule is FALSE.
    for identity in [json!([]), json!(["group:ops"]), json!(["member:Alice"])] {
        let unbound = alice_policy(json!({ "identity": identity }));
        assert!(reach(free, unbound.clone()), "no page: reached");
        assert!(!reach(open, unbound.clone()));
        assert!(!reach(deleted, unbound.clone()));
    }
    assert!(reach(free, Value::Null) && !reach(open, Value::Null));
}

#[test]
fn the_remote_floor_hides_owner_only_facts_in_its_form() {
    let b = brain("memory-mutation-reads-floor-owner-only");
    page(&b, "notes/open", json!({}), None);
    let open = fact(&b, "default", "open fact", "notes/open", "world", 1);
    let bare = fact(
        &b,
        "default",
        "no page fact",
        "notes/never-written",
        "world",
        2,
    );
    let tier = |id: u64, source: &str, form: OwnerOnlyForm| {
        b.read_remote_forget_tier(&RemoteForgetTierQuery {
            fact_id: id as i64,
            source_id: source.into(),
            remote_floor: Some(RemoteFloor {
                honor_aliases: true,
                restricted: true,
                owner_only: form,
            }),
        })
        .unwrap()
        .is_some()
    };
    let forms = [OwnerOnlyForm::Closed, OwnerOnlyForm::Fn, OwnerOnlyForm::Off];
    for form in forms {
        assert!(
            tier(open, "default", form) && tier(bare, "default", form),
            "{form:?} with no owner-only source"
        );
    }
    source(&b, "vault", None, json!({ "owner_only": true }));
    page(&b, "notes/vault-note", json!({}), None);
    let vault = fact(&b, "vault", "vault fact", "notes/never-written", "world", 3);
    // Closed: any owner-only source hides every fact, a fact on no page included.
    assert!(!tier(open, "default", OwnerOnlyForm::Closed));
    assert!(!tier(bare, "default", OwnerOnlyForm::Closed));
    // Fn (schema 320): only the owner-only source's fact.
    assert!(tier(open, "default", OwnerOnlyForm::Fn) && tier(bare, "default", OwnerOnlyForm::Fn));
    assert!(!tier(vault, "vault", OwnerOnlyForm::Fn));
    // Off (the owner): nothing.
    assert!(tier(vault, "vault", OwnerOnlyForm::Off) && tier(open, "default", OwnerOnlyForm::Off));
}

#[test]
fn the_withdrawal_claim_reads_the_subject_under_the_admission_rule() {
    let b = brain("memory-mutation-reads-withdrawal-claim");
    page(&b, "people/e-example", json!({}), None);
    page(&b, "notes/open", json!({}), None);
    page(
        &b,
        "notes/private",
        json!({ "visibility": "private" }),
        None,
    );
    let member = "memory/members/alice-example";
    let entity = claim(
        &b,
        "  Erin ROWS  boats",
        Some("people/e-example"),
        "notes/open",
        "world",
        1,
    );
    let unlinked = claim(&b, "Erin rows boats", None, "notes/open", "world", 2);
    let unbacked = claim(
        &b,
        "Erin rows boats",
        Some("erinname"),
        "notes/open",
        "world",
        3,
    );
    let hidden = claim(
        &b,
        "Erin rows boats",
        Some("people/f-example"),
        "notes/private",
        "world",
        4,
    );
    let own = claim(
        &b,
        "Erin rows boats",
        Some("people/e-example"),
        member,
        "private",
        5,
    );
    let private = claim(
        &b,
        "Erin rows boats",
        Some("people/e-example"),
        "notes/open",
        "private",
        6,
    );
    let marker = b
        .insert_facts(&args::<InsertFactsArgs>(json!({
            "rows": [{ "fact": "EXTRACTION_COMPLETE", "source_markdown_slug": "notes/open", "row_num": 7,
                "kind": "fact", "visibility": "world", "source": "cli:extract-conversation-facts:terminal" }],
            "sourceId": "default",
        })))
        .unwrap()["ids"][0]
        .as_u64()
        .unwrap();
    let read = |id: u64, world_only: bool, member_page: Option<&str>, floor: bool| {
        let q: WithdrawalClaimQuery = args(
            json!({ "id": id, "sourceId": "default", "worldOnly": world_only,
            "memberPage": member_page,
            "remoteFloor": floor.then(|| json!({ "honorAliases": true, "restricted": true })) }),
        );
        b.read_fact_withdrawal_claim(&q).unwrap()
    };
    let subject = |id: u64, world_only: bool, member_page: Option<&str>, floor: bool| {
        read(id, world_only, member_page, floor).map(|r| r["subject"].as_str().unwrap().to_owned())
    };
    let first = read(entity, false, None, false).unwrap();
    assert_eq!(first["visibility"], "world");
    assert_eq!(first["fact"], "  Erin ROWS  boats");
    assert_eq!(first["expired"], false);
    assert_eq!(
        first["fact_hash"],
        read(unlinked, false, None, false).unwrap()["fact_hash"]
    );
    assert_eq!(
        subject(entity, false, None, false).as_deref(),
        Some("people/e-example")
    );
    assert_eq!(subject(unlinked, false, None, false).as_deref(), Some("*"));
    assert_eq!(subject(unbacked, false, None, false).as_deref(), Some("*"));
    assert_eq!(subject(own, false, None, false).as_deref(), Some(member));
    assert_eq!(subject(marker, false, None, false), None);
    // worldOnly admits a world fact and a private fact on the member page only.
    assert_eq!(subject(own, true, None, false), None);
    assert_eq!(
        subject(own, true, Some(member), false).as_deref(),
        Some(member)
    );
    assert_eq!(subject(private, true, Some(member), false), None);
    // The floor hides a fact whose provenance page is private.
    assert_eq!(
        subject(hidden, true, None, false).as_deref(),
        Some("people/f-example")
    );
    assert_eq!(subject(hidden, true, None, true), None);
    assert_eq!(
        subject(entity, true, None, true).as_deref(),
        Some("people/e-example")
    );
    // Another source, an unknown id.
    let q: WithdrawalClaimQuery = args(
        json!({ "id": entity, "sourceId": "other", "worldOnly": false, "memberPage": null, "remoteFloor": null }),
    );
    assert!(b.read_fact_withdrawal_claim(&q).unwrap().is_none());
    assert!(read(entity + 1000, false, None, false).is_none());
}
