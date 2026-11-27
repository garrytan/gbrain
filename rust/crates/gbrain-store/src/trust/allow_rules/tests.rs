use super::*;
use crate::sources::SourceInput;
use crate::test_support::store;

fn rule(source: &str, prefix: Option<&str>, family: Option<&str>) -> NewAllowRule {
    NewAllowRule {
        source_id: source.into(),
        uri_prefix: prefix.map(Into::into),
        reason_family: family.map(Into::into),
        created_by: "local_cli:owner".into(),
        reason: Some("parity".into()),
    }
}

fn source(store: &Store, id: &str) {
    store
        .upsert_source(&SourceInput {
            id: id.into(),
            name: Some(id.into()),
            local_path: None,
            last_sync_at: None,
            config: None,
        })
        .unwrap();
}

#[test]
fn an_add_stores_once_per_active_key_and_a_remove_keeps_the_receipt() {
    let store = store();
    source(&store, "work");
    let first = store
        .add_trust_allow_rule(&rule(
            "default",
            Some("https://a.example/"),
            Some("credential"),
        ))
        .unwrap();
    assert_eq!(first["created"], true);
    assert_eq!(first["row"]["id"], 1);
    let again = store
        .add_trust_allow_rule(&rule(
            "default",
            Some("https://a.example/"),
            Some("credential"),
        ))
        .unwrap();
    assert_eq!(
        (again["created"].clone(), again["row"]["id"].clone()),
        (json!(false), json!(1))
    );
    // NULL prefix and family share the COALESCE('') key with each other only.
    // The repeated add used up id 2, as Postgres' sequence does under ON CONFLICT DO NOTHING.
    let open = store
        .add_trust_allow_rule(&rule("work", None, None))
        .unwrap();
    assert_eq!(open["row"]["id"], 3);
    let removed = store.remove_trust_allow_rule(1, "local_cli:owner").unwrap();
    assert_eq!(removed["id"], 1);
    assert!(removed["removed_at"].is_string());
    assert_eq!(removed["removed_by"], "local_cli:owner");
    assert_eq!(store.remove_trust_allow_rule(1, "x").unwrap(), Value::Null);
    assert_eq!(store.remove_trust_allow_rule(99, "x").unwrap(), Value::Null);
    // The key is free again once the rule is removed.
    let fresh = store
        .add_trust_allow_rule(&rule(
            "default",
            Some("https://a.example/"),
            Some("credential"),
        ))
        .unwrap();
    assert_eq!(
        (fresh["created"].clone(), fresh["row"]["id"].clone()),
        (json!(true), json!(4))
    );
    let active: Vec<Value> = store
        .list_trust_allow_rules(None, false)
        .unwrap()
        .iter()
        .map(|r| r["id"].clone())
        .collect();
    assert_eq!(active, vec![json!(3), json!(4)]);
    let all: Vec<Value> = store
        .list_trust_allow_rules(None, true)
        .unwrap()
        .iter()
        .map(|r| r["id"].clone())
        .collect();
    assert_eq!(all, vec![json!(1), json!(3), json!(4)]);
    let work = store
        .list_trust_allow_rules(Some(&["work".to_string()]), true)
        .unwrap();
    assert_eq!(work.len(), 1);
    assert_eq!(
        store.read_trust_allow_rule(1).unwrap()["removed_by"],
        "local_cli:owner"
    );
    assert_eq!(store.read_trust_allow_rule(42).unwrap(), Value::Null);
}

#[test]
fn an_add_to_an_unknown_or_archived_source_writes_nothing_and_checks_refuse() {
    let store = store();
    let missing = store
        .add_trust_allow_rule(&rule("nope", None, None))
        .unwrap();
    assert_eq!(
        missing,
        json!({ "source_active": false, "row": null, "created": false })
    );
    source(&store, "old");
    store.set_source_archived("old", true).unwrap();
    assert_eq!(
        store
            .add_trust_allow_rule(&rule("old", None, None))
            .unwrap()["source_active"],
        false
    );
    assert!(store.list_trust_allow_rules(None, true).unwrap().is_empty());
    let family = store
        .add_trust_allow_rule(&rule("default", None, Some("bogus")))
        .unwrap_err();
    assert_eq!(family.code, CONSTRAINT_VIOLATION);
    let empty = store
        .add_trust_allow_rule(&rule("default", Some(""), None))
        .unwrap_err();
    assert_eq!(empty.code, CONSTRAINT_VIOLATION);
    let long = NewAllowRule {
        reason: Some("x".repeat(501)),
        ..rule("default", None, None)
    };
    assert_eq!(
        store.add_trust_allow_rule(&long).unwrap_err().code,
        CONSTRAINT_VIOLATION
    );
    // A refused add takes no id: the next rule is still id 1.
    assert_eq!(
        store
            .add_trust_allow_rule(&rule("default", None, None))
            .unwrap()["row"]["id"],
        1
    );
}

#[test]
fn a_source_delete_removes_its_rules_and_the_seed_keeps_ids_and_receipts() {
    let store = store();
    source(&store, "team");
    store
        .add_trust_allow_rule(&rule("team", None, None))
        .unwrap();
    store
        .add_trust_allow_rule(&rule("default", None, None))
        .unwrap();
    store
        .write(|tx| crate::cascade::remove_source_rows(tx, "team"))
        .unwrap();
    let left: Vec<Value> = store
        .list_trust_allow_rules(None, true)
        .unwrap()
        .iter()
        .map(|r| r["source_id"].clone())
        .collect();
    assert_eq!(left, vec![json!("default")]);
    let seeded = AllowRuleRecord {
        id: 40,
        source_id: "default".into(),
        uri_prefix: Some("https://b.example/".into()),
        reason_family: None,
        created_by: "local_cli:owner".into(),
        created_at_us: 1_700_000_000_000_000,
        removed_at_us: Some(1_700_000_100_000_000),
        removed_by: Some("local_cli:owner".into()),
        reason: None,
    };
    assert!(store.write(|tx| seed_rule(tx, &seeded)).unwrap());
    assert!(!store.write(|tx| seed_rule(tx, &seeded)).unwrap());
    let row = store.read_trust_allow_rule(40).unwrap();
    assert_eq!(row["removed_at"], iso(1_700_000_100_000_000));
    // A removed seeded rule holds no active key, so the same key can be added.
    let added = store
        .add_trust_allow_rule(&rule("default", Some("https://b.example/"), None))
        .unwrap();
    assert_eq!(added["created"], true);
    assert!(store.write(|tx| remove_rule(tx, 40)).unwrap());
    assert_eq!(store.read_trust_allow_rule(40).unwrap(), Value::Null);
}
