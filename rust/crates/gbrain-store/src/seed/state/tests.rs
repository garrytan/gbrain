//! Read-back tests of the identity, link, purge and token relations: each seeds a primary row and reads it back through
//! the family's own public read, as the answer the primary gives. Every test fails without its importer (the relation is
//! unknown to `importRelation`). They also check a retry skips, a missing page or source is named, and that no error or
//! loss carries a token hash.

use crate::Store;
use crate::entity_identities::IdentityFilter;
use crate::env::iso;
use crate::error::{CONSTRAINT_VIOLATION, INVALID_ARGUMENT, PAGE_NOT_FOUND, SOURCE_NOT_FOUND};
use crate::facts::PrivacyPolicy;
use crate::keys;
use crate::link_queries::link_temporal::{
    EvidenceInput, ManualRelationship, ManualRow, ManualWriteInput, RelationshipKey,
};
use crate::seed::decode::timestamp_us;
use crate::seed::{ImportResult, SeedRow};
use crate::test_support::store;
use serde_json::{Value, json};

const SEED: &str = "seed-1";
const REV: &str = "11111111-1111-4111-8111-111111111111";
const HASH: &str = "sha256-of-a-bearer-token-0001";
const OTHER_HASH: &str = "sha256-of-a-bearer-token-0002";

fn row(pairs: &[(&str, &str)]) -> SeedRow {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), Some((*v).to_owned())))
        .collect()
}

fn import(s: &Store, relation: &str, rows: Vec<SeedRow>) -> ImportResult {
    s.import_relation(SEED, relation, rows).unwrap()
}

fn us(text: &str) -> i64 {
    timestamp_us(text).unwrap()
}

fn counter(s: &Store, name: &str) -> u64 {
    let read = s.read().unwrap();
    keys::be8(&read.get(&keys::meta(name)).unwrap().unwrap()).unwrap()
}

fn page_row(id: &str, slug: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("source_id", "default"),
        ("slug", slug),
        ("type", "person"),
        ("title", slug),
        ("compiled_truth", "A page."),
        ("timeline", ""),
        ("frontmatter", "{}"),
        ("created_at", "2026-01-02 03:04:05+00"),
        ("updated_at", "2026-02-03 04:05:06+00"),
        ("knowledge_revision", REV),
        ("text_projection_revision", REV),
    ])
}

/// A store with the default source and three pages (ids 7, 9 and 11).
fn seeded_pages() -> Store {
    let s = store();
    let r = import(
        &s,
        "pages",
        vec![
            page_row("7", "people/alice-example"),
            page_row("9", "companies/acme-example"),
            page_row("11", "people/bob-example"),
        ],
    );
    assert_eq!(r.imported, 3);
    s
}

// ---- entity_identities ---------------------------------------------------------------------

fn identity_row(id: &str, entity: &str, page: &str, canonical: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("entity_id", entity),
        ("source_id", "default"),
        ("page_id", page),
        ("confidence", "0.8"),
        ("established_by", "dedupe"),
        ("established_at", "2026-03-04 05:06:07.123456+00"),
        ("canonical", canonical),
    ])
}

#[test]
fn entity_identities_read_back_as_the_primary_lists_them() {
    let s = seeded_pages();
    let r = import(
        &s,
        "entity_identities",
        vec![
            identity_row("4", "person/alice", "7", "t"),
            identity_row("5", "person/alice", "9", "f"),
            identity_row("6", "person/bob", "11", "f"),
        ],
    );
    assert_eq!((r.imported, r.skipped, r.dropped), (3, 0, 0));
    // The serial id is not kept: the store keys a membership by its page.
    assert_eq!(r.unmapped_columns, ["id"]);
    let listed = s
        .list_entity_identities(&IdentityFilter::default())
        .unwrap();
    let at = iso(us("2026-03-04 05:06:07.123456+00"));
    assert_eq!(
        listed,
        vec![
            json!({ "entity_id": "person/alice", "source_id": "default", "slug": "people/alice-example",
                "title": "people/alice-example", "confidence": 0.8, "established_by": "dedupe",
                "established_at": at, "canonical": true }),
            json!({ "entity_id": "person/alice", "source_id": "default", "slug": "companies/acme-example",
                "title": "companies/acme-example", "confidence": 0.8, "established_by": "dedupe",
                "established_at": at, "canonical": false }),
            json!({ "entity_id": "person/bob", "source_id": "default", "slug": "people/bob-example",
                "title": "people/bob-example", "confidence": 0.8, "established_by": "dedupe",
                "established_at": at, "canonical": false }),
        ]
    );
    let ids = s
        .read_entity_identity_ids_for_pages(
            &["default".to_owned()],
            &["people/alice-example".to_owned()],
        )
        .unwrap();
    assert_eq!(
        ids,
        vec![
            json!({ "entity_id": "person/alice", "source_id": "default", "slug": "people/alice-example" })
        ]
    );
}

#[test]
fn an_entity_identity_keeps_a_confidence_that_is_not_a_number_and_a_retry_skips() {
    let s = seeded_pages();
    let mut nan = identity_row("4", "person/alice", "7", "f");
    nan.insert("confidence".into(), Some("NaN".into()));
    let mut inf = identity_row("5", "person/alice", "9", "f");
    inf.insert("confidence".into(), Some("-Infinity".into()));
    let r = import(&s, "entity_identities", vec![nan.clone(), inf.clone()]);
    assert_eq!(r.imported, 2);
    let listed = s
        .list_entity_identities(&IdentityFilter::default())
        .unwrap();
    let confidences: Vec<&Value> = listed.iter().map(|m| &m["confidence"]).collect();
    // By entity, then slug: the acme page (-Infinity) before the alice page (NaN).
    assert_eq!(confidences, [&json!("-Infinity"), &json!("NaN")]);
    let again = import(&s, "entity_identities", vec![nan, inf]);
    assert_eq!((again.imported, again.skipped), (0, 2));
}

#[test]
fn an_entity_identity_of_a_page_that_is_not_seeded_is_page_not_found() {
    let s = seeded_pages();
    let e = s
        .import_relation(
            SEED,
            "entity_identities",
            vec![identity_row("4", "person/alice", "99", "f")],
        )
        .unwrap_err();
    assert_eq!(e.code, PAGE_NOT_FOUND);
    assert!(e.message.starts_with("entity_identities row 0:"), "{e:?}");
}

// ---- link_relationships --------------------------------------------------------------------

fn relationship_row(from: &str, to: &str, scope: &str) -> SeedRow {
    row(&[
        ("from_page_id", from),
        ("to_page_id", to),
        ("link_type", "works_at"),
        ("scope", scope),
        ("source_id", "default"),
        ("semantics", "state"),
        ("valid_ranges", "{[2021-04-01,2025-03-01),[2026-01-01,)}"),
        ("status_now", "live"),
        ("first_start", "2021-04-01"),
        ("last_start", "2026-01-01"),
        ("last_end", "2025-03-01"),
        ("undated_present", "1"),
        ("undated_past", "2"),
        ("disputed", "t"),
        ("recorded_at", "2026-03-04 05:06:07.123456+00"),
        ("retired_at", "2026-04-05 06:07:08+00"),
        ("evidence_hash", "ev-1"),
        ("refreshed_at", "2026-05-06 07:08:09.5+00"),
    ])
}

fn relationship_key() -> RelationshipKey {
    serde_json::from_value(json!({ "from_page_id": 7, "to_page_id": 9, "link_type": "works_at" }))
        .unwrap()
}

fn existing_rows(s: &Store) -> Value {
    let evidence = s
        .read_link_relationship_evidence(&EvidenceInput {
            keys: vec![relationship_key()],
            origin_policy: Some(PrivacyPolicy::default()),
        })
        .unwrap();
    serde_json::to_value(evidence).unwrap()
}

#[test]
fn link_relationships_read_back_with_the_primary_times_and_state() {
    let s = seeded_pages();
    let r = import(
        &s,
        "link_relationships",
        vec![
            relationship_row("7", "9", "all"),
            relationship_row("7", "9", "world"),
        ],
    );
    assert_eq!((r.imported, r.skipped, r.dropped), (2, 0, 0));
    assert!(r.unmapped_columns.is_empty(), "{:?}", r.unmapped_columns);
    let evidence = existing_rows(&s);
    let existing: Vec<Value> = ["all", "world"]
        .iter()
        .map(|scope| {
            json!({ "from_page_id": 7, "to_page_id": 9, "link_type": "works_at", "scope": scope,
                "recorded_at": "2026-03-04T05:06:07.123Z", "retired_at": "2026-04-05T06:07:08.000Z",
                "evidence_hash": "ev-1" })
        })
        .collect();
    assert_eq!(evidence["existing"], Value::Array(existing));
    // The whole row, including what the evidence read leaves out: the primary's `refreshed_at`, not the seed's clock.
    let read = s.read().unwrap();
    let state =
        crate::link_queries::link_temporal::relationship(&*read, &relationship_key(), "world")
            .unwrap()
            .unwrap();
    assert_eq!(
        state.valid_ranges,
        "{[2021-04-01,2025-03-01),[2026-01-01,)}"
    );
    assert_eq!(state.status_now, "live");
    assert_eq!(state.semantics, "state");
    assert_eq!(state.first_start.as_deref(), Some("2021-04-01"));
    assert_eq!(state.last_start.as_deref(), Some("2026-01-01"));
    assert_eq!(state.last_end.as_deref(), Some("2025-03-01"));
    assert_eq!((state.undated_present, state.undated_past), (1, 2));
    assert!(state.disputed);
    assert_eq!(state.recorded_at_us, us("2026-03-04 05:06:07.123456+00"));
    assert_eq!(state.retired_at_us, Some(us("2026-04-05 06:07:08+00")));
    assert_eq!(state.refreshed_at_us, us("2026-05-06 07:08:09.5+00"));
    drop(read);
    let again = import(
        &s,
        "link_relationships",
        vec![relationship_row("7", "9", "all")],
    );
    assert_eq!((again.imported, again.skipped), (0, 1));
}

#[test]
fn a_link_relationship_needs_both_pages_and_a_scope_the_table_allows() {
    let s = seeded_pages();
    for (from, to) in [("99", "9"), ("7", "99")] {
        let e = s
            .import_relation(
                SEED,
                "link_relationships",
                vec![relationship_row(from, to, "all")],
            )
            .unwrap_err();
        assert_eq!(e.code, PAGE_NOT_FOUND, "{from} {to}");
    }
    let e = s
        .import_relation(
            SEED,
            "link_relationships",
            vec![relationship_row("7", "9", "nobody")],
        )
        .unwrap_err();
    assert_eq!(e.code, CONSTRAINT_VIOLATION);
    assert_eq!(existing_rows(&s)["existing"], json!([]));
}

// ---- link_transitions ----------------------------------------------------------------------

fn transition_row(id: &str, kind: &str, on: &str, producer: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("source_id", "default"),
        ("from_page_id", "7"),
        ("to_page_id", "9"),
        ("link_type", "works_at"),
        ("kind", kind),
        ("occurred_on", on),
        ("date_precision", "month"),
        ("producer", producer),
        ("line_hash", "lh"),
        ("created_at", "2026-03-04 05:06:07.5+00"),
    ])
}

#[test]
fn link_transitions_read_back_and_the_next_id_is_above_the_copied_ones() {
    let s = seeded_pages();
    let mut with_origin = transition_row("12", "end", "2025-03-01", "timeline");
    with_origin.insert("origin_page_id".into(), Some("11".into()));
    with_origin.insert("link_source".into(), Some("frontmatter".into()));
    let r = import(
        &s,
        "link_transitions",
        vec![
            transition_row("5", "start", "2021-04-01", "manual"),
            with_origin,
        ],
    );
    assert_eq!((r.imported, r.skipped, r.dropped), (2, 0, 0));
    let evidence = existing_rows(&s);
    assert_eq!(
        evidence["transitions"],
        json!([
            { "from_page_id": 7, "to_page_id": 9, "link_type": "works_at", "origin_id": null, "kind": "start",
              "occurred_on": "2021-04-01", "producer": "manual", "created_at": "2026-03-04T05:06:07.500Z",
              "source_id": "default", "origin_public": true },
            { "from_page_id": 7, "to_page_id": 9, "link_type": "works_at", "origin_id": 11, "kind": "end",
              "occurred_on": "2025-03-01", "producer": "timeline", "created_at": "2026-03-04T05:06:07.500Z",
              "source_id": "default", "origin_public": true },
        ])
    );
    assert_eq!(
        s.list_manual_link_transitions("default", "people/alice-example")
            .unwrap(),
        json!([{ "to_slug": "companies/acme-example", "to_source_id": "default", "link_type": "works_at",
            "kind": "start", "occurred_on": "2021-04-01" }])
    );
    assert_eq!(counter(&s, "link_transition_id"), 13);
    // The family's own writer takes the next id, above every copied one.
    let wrote = s
        .write_manual_link_transitions(&ManualWriteInput {
            rel: ManualRelationship {
                from: "people/alice-example".into(),
                to: "companies/acme-example".into(),
                link_type: Some("works_at".into()),
                source_id: "default".into(),
                database_only: true,
            },
            rows: vec![ManualRow {
                kind: "end".into(),
                occurred_on: "2026-06-01".into(),
            }],
        })
        .unwrap();
    assert_eq!(wrote.inserted, 1);
    assert_eq!(counter(&s, "link_transition_id"), 14);
    let again = import(
        &s,
        "link_transitions",
        vec![transition_row("5", "start", "2021-04-01", "manual")],
    );
    assert_eq!((again.imported, again.skipped), (0, 1));
}

#[test]
fn a_transition_with_the_identity_of_a_held_one_is_skipped_and_a_bad_producer_is_refused() {
    let s = seeded_pages();
    import(
        &s,
        "link_transitions",
        vec![transition_row("5", "start", "2021-04-01", "manual")],
    );
    // Another id, the same (origin, from, to, type, source, kind, day, producer): `link_transitions_identity_idx`.
    let r = import(
        &s,
        "link_transitions",
        vec![transition_row("6", "start", "2021-04-01", "manual")],
    );
    assert_eq!((r.imported, r.skipped), (0, 1));
    let e = s
        .import_relation(
            SEED,
            "link_transitions",
            vec![transition_row("7", "start", "2021-04-01", "robot")],
        )
        .unwrap_err();
    assert_eq!(e.code, CONSTRAINT_VIOLATION);
    let e = s
        .import_relation(
            SEED,
            "link_transitions",
            vec![{
                let mut r = transition_row("8", "start", "2021-04-02", "manual");
                r.insert("origin_page_id".into(), Some("99".into()));
                r
            }],
        )
        .unwrap_err();
    assert_eq!(e.code, PAGE_NOT_FOUND);
}

// ---- fact_purges ---------------------------------------------------------------------------

fn purge_row(subject: &str, claim: &str) -> SeedRow {
    row(&[
        ("source_id", "default"),
        ("visibility", "world"),
        ("subject", subject),
        ("fact_hash", &crate::facts::fact_fingerprint(claim)),
        ("request_id", "0A1B2C3D-0000-4000-8000-00000000000A"),
        ("actor", "owner"),
        ("reason", "asked to forget"),
        ("purged_at", "2026-03-04 05:06:07.25+00"),
    ])
}

#[test]
fn fact_purges_stop_the_claim_the_way_the_primary_does() {
    let s = store();
    let r = import(
        &s,
        "fact_purges",
        vec![
            purge_row("*", "Alice owes Acme money"),
            purge_row("people/alice-example", "Alice moved to Berlin"),
        ],
    );
    assert_eq!((r.imported, r.skipped, r.dropped), (2, 0, 0));
    assert!(r.unmapped_columns.is_empty());
    assert!(s.has_fact_purges("default").unwrap());
    // Subject `*` covers any entity; a named subject covers only that entity.
    assert!(
        s.is_fact_purged("default", "world", "Alice owes Acme money", None)
            .unwrap()
    );
    assert!(
        s.is_fact_purged(
            "default",
            "world",
            "Alice owes Acme money",
            Some("people/bob-example")
        )
        .unwrap()
    );
    assert!(
        s.is_fact_purged(
            "default",
            "world",
            "Alice moved to Berlin",
            Some("people/alice-example")
        )
        .unwrap()
    );
    assert!(
        !s.is_fact_purged(
            "default",
            "world",
            "Alice moved to Berlin",
            Some("people/bob-example")
        )
        .unwrap()
    );
    assert!(
        !s.is_fact_purged("default", "private", "Alice owes Acme money", None)
            .unwrap()
    );
    let read = s.read().unwrap();
    let held =
        crate::facts::purge_ledger::purges_under_subject(&*read, "default", "world", "*").unwrap();
    assert_eq!(
        held,
        vec![(
            crate::facts::fact_fingerprint("Alice owes Acme money"),
            us("2026-03-04 05:06:07.25+00")
        )]
    );
    drop(read);
    let again = import(
        &s,
        "fact_purges",
        vec![purge_row("*", "Alice owes Acme money")],
    );
    assert_eq!((again.imported, again.skipped), (0, 1));
}

#[test]
fn a_fact_purge_of_an_unknown_source_or_a_bad_visibility_is_refused() {
    let s = store();
    let mut other = purge_row("*", "x");
    other.insert("source_id".into(), Some("wiki".into()));
    let e = s
        .import_relation(SEED, "fact_purges", vec![other])
        .unwrap_err();
    assert_eq!(e.code, SOURCE_NOT_FOUND);
    let mut bad = purge_row("*", "x");
    bad.insert("visibility".into(), Some("secret".into()));
    let e = s
        .import_relation(SEED, "fact_purges", vec![bad])
        .unwrap_err();
    assert_eq!(e.code, INVALID_ARGUMENT);
    assert!(!s.has_fact_purges("default").unwrap());
}

// ---- access_tokens -------------------------------------------------------------------------

const TOKEN_A: &str = "0a1b2c3d-0000-4000-8000-0000000000a1";
const TOKEN_B: &str = "0a1b2c3d-0000-4000-8000-0000000000b2";

fn token_row(id: &str, name: &str, hash: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("name", name),
        ("token_hash", hash),
        ("scopes", "{read,write}"),
        ("created_at", "2026-03-04 05:06:07.5+00"),
        ("last_used_at", "2026-03-05 00:00:00+00"),
        (
            "permissions",
            r#"{"takes_holders": ["world"], "setup_reads": ["wiki"]}"#,
        ),
        ("source_grant", "federated"),
        ("source_id", "default"),
        ("federated_read", "{default,wiki}"),
        ("allowed_operations", "{query,get_page}"),
        ("takes_holders", "{world}"),
        ("grant_revision", "3"),
        ("min_trust", "tool_observed"),
        ("private_pages", "granted_sources"),
        ("private_facts", "none"),
        ("member_id", "alice"),
        ("may_act_for", "{bob}"),
        ("attest_actor", "agent"),
        ("attest_ops", "{put_page}"),
        ("attest_sources", "{default}"),
        ("attest_read", "all"),
        ("reads_unscoped", "2026-03-06 00:00:00+00"),
        ("read_shared_revision", "2"),
    ])
}

#[test]
fn access_tokens_authorize_by_hash_as_the_primary_row_says() {
    let s = store();
    let r = import(
        &s,
        "access_tokens",
        vec![token_row(TOKEN_A, "agent-key", HASH), {
            let mut revoked = token_row(TOKEN_B, "old-key", OTHER_HASH);
            revoked.insert("revoked_at".into(), Some("2026-03-07 00:00:00+00".into()));
            revoked
        }],
    );
    assert_eq!((r.imported, r.skipped, r.dropped), (2, 0, 0));
    assert!(r.unmapped_columns.is_empty(), "{:?}", r.unmapped_columns);
    assert!(r.losses.is_empty());
    let whole = s.read_active_access_token_by_hash(HASH).unwrap().unwrap();
    assert_eq!(
        whole,
        json!({
            "id": TOKEN_A, "name": "agent-key", "scopes": ["read", "write"],
            "created_at": iso(us("2026-03-04 05:06:07.5+00")), "last_used_at": iso(us("2026-03-05 00:00:00+00")),
            "revoked_at": null, "permissions": { "takes_holders": ["world"], "setup_reads": ["wiki"] },
            "source_grant": "federated", "source_id": "default", "federated_read": ["default", "wiki"],
            "allowed_operations": ["query", "get_page"], "takes_holders": ["world"], "grant_revision": 3,
            "min_trust": "tool_observed", "private_pages": "granted_sources", "member_id": "alice",
            "may_act_for": ["bob"], "attest_actor": "agent", "attest_ops": ["put_page"],
            "attest_sources": ["default"], "attest_read": "all",
            "reads_unscoped": iso(us("2026-03-06 00:00:00+00")), "private_facts": "none",
            "read_shared_revision": 2,
        })
    );
    // A revoked token no longer authorizes, but the list and the id read still show it.
    assert!(
        s.read_active_access_token_by_hash(OTHER_HASH)
            .unwrap()
            .is_none()
    );
    assert!(
        s.read_active_access_token_by_hash("no-such-hash")
            .unwrap()
            .is_none()
    );
    assert_eq!(s.list_access_tokens().unwrap().as_array().unwrap().len(), 2);
    assert_eq!(
        s.find_active_access_tokens("agent-key").unwrap(),
        json!([{ "id": TOKEN_A, "name": "agent-key", "min_trust": "tool_observed" }])
    );
    assert!(
        s.find_active_access_tokens("old-key")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(s.read_access_token(TOKEN_B).unwrap().is_some());
    // What the family does not stamp on a read stays as the primary had it.
    assert!(s.access_token_live(TOKEN_A).unwrap());
    assert!(!s.access_token_live(TOKEN_B).unwrap());
    let again = import(
        &s,
        "access_tokens",
        vec![token_row(TOKEN_A, "agent-key", HASH)],
    );
    assert_eq!((again.imported, again.skipped), (0, 1));
}

#[test]
fn a_token_with_the_hash_of_another_is_refused_without_naming_the_hash() {
    let s = store();
    import(
        &s,
        "access_tokens",
        vec![token_row(TOKEN_A, "agent-key", HASH)],
    );
    let e = s
        .import_relation(
            SEED,
            "access_tokens",
            vec![token_row(TOKEN_B, "twin", HASH)],
        )
        .unwrap_err();
    assert_eq!(e.code, CONSTRAINT_VIOLATION);
    assert!(e.message.contains("access_tokens_token_hash_key"), "{e:?}");
    assert!(!format!("{e:?}").contains(HASH));
    // A value the table forbids is refused by the table's own check, and no value is in the message.
    let mut bad = token_row(TOKEN_B, "bad", OTHER_HASH);
    bad.insert("source_grant".into(), Some("everyone".into()));
    let e = s
        .import_relation(SEED, "access_tokens", vec![bad])
        .unwrap_err();
    assert_eq!(e.code, CONSTRAINT_VIOLATION);
    assert!(!format!("{e:?}").contains(OTHER_HASH));
    assert_eq!(s.list_access_tokens().unwrap().as_array().unwrap().len(), 1);
}

#[test]
fn a_token_with_no_created_at_is_stored_at_time_zero_and_counted() {
    let s = store();
    let mut row = token_row(TOKEN_A, "agent-key", HASH);
    row.insert("created_at".into(), None);
    let r = import(&s, "access_tokens", vec![row]);
    assert_eq!(r.imported, 1);
    assert_eq!(r.losses.get("token_without_created_at"), Some(&1));
    let row = s.read_access_token(TOKEN_A).unwrap().unwrap();
    assert_eq!(row["created_at"], iso(0));
}

// ---- the plan ------------------------------------------------------------------------------

#[test]
fn the_plan_copies_the_five_relations_and_keeps_their_keys() {
    let plan = crate::seed::plan();
    for (relation, key) in [
        ("entity_identities", vec!["id"]),
        (
            "link_relationships",
            vec!["from_page_id", "to_page_id", "link_type", "scope"],
        ),
        ("link_transitions", vec!["id"]),
        (
            "fact_purges",
            vec!["source_id", "visibility", "subject", "fact_hash"],
        ),
        ("access_tokens", vec!["id"]),
    ] {
        let p = plan
            .relations
            .iter()
            .find(|p| p.relation == relation)
            .unwrap_or_else(|| panic!("{relation}"));
        assert_eq!(p.key, key.as_slice(), "{relation}");
        assert!(p.removable, "{relation}");
    }
}
