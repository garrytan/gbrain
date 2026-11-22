//! Entity identity groups (entity_identities). Expected rows follow the PGLite SQL in
//! src/core/engine-sql/entity-identities.ts.

mod common;

use common::TempDir;
use gbrain_store::entity_identities::{IdentityFilter, IdentityLink};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{OpenOptions, Store, SystemEnv};
use serde_json::{Map, Value, json};
use std::sync::Arc;

struct Brain {
    _dir: TempDir,
    store: Store,
}

fn de<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

impl Brain {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(name);
        let kv = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
        let store = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default()).unwrap();
        store
            .insert_source("other", "Other", None, &Map::new())
            .unwrap();
        Brain { _dir: dir, store }
    }

    fn page(&self, source: &str, slug: &str) {
        let input: PageInput = de(json!({
            "type": "person", "title": format!("Title {slug}"), "compiled_truth": format!("{slug} body"),
        }));
        let options: PutPageOptions = de(json!({"sourceId": source, "index": false}));
        self.store.put_page(slug, &input, &options).unwrap();
    }

    fn link(&self, entity: &str, source: &str, slug: &str, canonical: Option<bool>) -> bool {
        self.store
            .link_entity_identity(&IdentityLink {
                entity_id: entity.into(),
                slug: slug.into(),
                source_id: source.into(),
                confidence: 1.0,
                established_by: "manual".into(),
                canonical,
            })
            .unwrap()
    }

    /// `entity:source:slug:canonical` of every live member, in list order.
    fn members(&self) -> Vec<String> {
        self.store
            .list_entity_identities(&IdentityFilter::default())
            .unwrap()
            .iter()
            .map(|r| {
                format!(
                    "{}:{}:{}:{}",
                    r["entity_id"].as_str().unwrap(),
                    r["source_id"].as_str().unwrap(),
                    r["slug"].as_str().unwrap(),
                    r["canonical"]
                )
            })
            .collect()
    }
}

#[test]
fn a_canonical_link_demotes_the_old_canonical_member_in_one_commit() {
    let b = Brain::new("ei-atomic");
    b.page("default", "people/alice-example");
    b.page("other", "people/alice-example");
    assert!(b.link("g-alice", "default", "people/alice-example", Some(true)));
    assert!(b.link("g-alice", "other", "people/alice-example", None));
    let before = b.store.commit_version().unwrap();
    assert!(b.link("g-alice", "other", "people/alice-example", Some(true)));
    // The demotion and the upsert land together: one commit, one canonical member.
    assert_eq!(b.store.commit_version().unwrap(), before + 1);
    assert_eq!(
        b.members(),
        [
            "g-alice:other:people/alice-example:true",
            "g-alice:default:people/alice-example:false"
        ]
    );
}

#[test]
fn no_live_page_links_nothing() {
    let b = Brain::new("ei-missing");
    b.page("default", "people/gone");
    b.store
        .soft_delete_page("people/gone", Some("default"))
        .unwrap();
    assert!(!b.link("g-x", "default", "people/nobody", Some(true)));
    assert!(!b.link("g-x", "default", "people/gone", None));
    b.store
        .restore_page("people/gone", Some("default"))
        .unwrap();
    assert!(b.members().is_empty());
}

#[test]
fn a_move_drops_the_flag_and_leaves_the_old_group_empty() {
    let b = Brain::new("ei-move");
    b.page("default", "people/alice-example");
    assert!(b.link("g-a", "default", "people/alice-example", Some(true)));
    assert!(b.link("g-b", "default", "people/alice-example", None));
    assert_eq!(b.members(), ["g-b:default:people/alice-example:false"]);
    let old = IdentityFilter {
        entity_id: Some("g-a".into()),
        ..IdentityFilter::default()
    };
    assert!(b.store.list_entity_identities(&old).unwrap().is_empty());
    // A canonical link into g-a finds no stale member of g-a to demote.
    b.page("other", "people/alice-example");
    assert!(b.link("g-a", "other", "people/alice-example", Some(true)));
    assert_eq!(
        b.members(),
        [
            "g-a:other:people/alice-example:true",
            "g-b:default:people/alice-example:false"
        ]
    );
}

#[test]
fn a_hard_delete_drops_the_membership_and_its_group_key() {
    let b = Brain::new("ei-cascade");
    b.page("default", "people/alice-example");
    b.page("other", "people/alice-example");
    assert!(b.link("g-alice", "default", "people/alice-example", Some(true)));
    assert!(b.link("g-alice", "other", "people/alice-example", None));
    b.store
        .delete_page("people/alice-example", Some("default"))
        .unwrap();
    // A page written again at the slug is a new page, in no group.
    b.page("default", "people/alice-example");
    assert_eq!(b.members(), ["g-alice:other:people/alice-example:false"]);
    assert!(
        b.store
            .read_canonical_twin("other", "people/alice-example")
            .unwrap()
            .is_empty()
    );
    // The group index lost the deleted page: a canonical link sees only the live member.
    assert!(b.link("g-alice", "default", "people/alice-example", Some(true)));
    assert_eq!(
        b.members(),
        [
            "g-alice:default:people/alice-example:true",
            "g-alice:other:people/alice-example:false"
        ]
    );
}

#[test]
fn a_soft_delete_hides_the_membership_until_a_restore() {
    let b = Brain::new("ei-soft");
    b.page("default", "people/alice-example");
    b.page("other", "people/alice-example");
    assert!(b.link("g-alice", "other", "people/alice-example", Some(true)));
    assert!(b.link("g-alice", "default", "people/alice-example", None));
    let twin = json!([{"slug": "people/alice-example", "source_id": "other"}]);
    assert_eq!(
        Value::Array(
            b.store
                .read_canonical_twin("default", "people/alice-example")
                .unwrap()
        ),
        twin
    );
    b.store
        .soft_delete_page("people/alice-example", Some("other"))
        .unwrap();
    assert_eq!(b.members(), ["g-alice:default:people/alice-example:false"]);
    assert!(
        b.store
            .read_canonical_twin("default", "people/alice-example")
            .unwrap()
            .is_empty()
    );
    // An unlink reaches a soft-deleted member.
    assert!(
        !b.store
            .unlink_entity_identity("g-other", "people/alice-example", "other")
            .unwrap()
    );
    b.store
        .restore_page("people/alice-example", Some("other"))
        .unwrap();
    assert_eq!(
        b.members(),
        [
            "g-alice:other:people/alice-example:true",
            "g-alice:default:people/alice-example:false"
        ]
    );
    b.store
        .soft_delete_page("people/alice-example", Some("other"))
        .unwrap();
    assert!(
        b.store
            .unlink_entity_identity("g-alice", "people/alice-example", "other")
            .unwrap()
    );
    b.store
        .restore_page("people/alice-example", Some("other"))
        .unwrap();
    assert_eq!(b.members(), ["g-alice:default:people/alice-example:false"]);
}

#[test]
fn a_nul_byte_is_refused_before_any_write() {
    let b = Brain::new("ei-nul");
    b.page("default", "people/alice-example");
    let err = b
        .store
        .link_entity_identity(&IdentityLink {
            entity_id: "g\0x".into(),
            slug: "people/alice-example".into(),
            source_id: "default".into(),
            confidence: 1.0,
            established_by: "manual".into(),
            canonical: None,
        })
        .unwrap_err();
    assert!(err.to_string().contains("linkEntityIdentityRow"), "{err}");
    assert!(b.members().is_empty());
}

#[test]
fn identity_decisions_link_confirmed_members_and_refuse_a_stale_revision() {
    use gbrain_store::identity_reviews::ApplyDecisions;
    let b = Brain::new("identity-decisions");
    b.page("default", "people/alice-example");
    b.page("other", "people/alice-example");
    let decision = json!({
        "decision_id": "00000000000000aa", "verdict": "same",
        "members": [{"source_id": "default", "slug": "people/alice-example"}, {"source_id": "other", "slug": "people/alice-example"}],
        "group_id": null, "entity_id": "dedupe/aa", "canonical": {"source_id": "other", "slug": "people/alice-example"},
        "decided_by": "owner", "decided_at": "2026-11-18T00:00:00Z", "origin": "git", "home_source_id": "default", "git_blob": "b1",
    });
    let applied = b
        .store
        .apply_identity_decisions(&de::<ApplyDecisions>(json!({ "upsert": [decision] })))
        .unwrap();
    assert_eq!(
        applied,
        json!({ "upserted": 1, "removed": 0, "linked": 2, "unlinked": 0 })
    );
    let read = b.store.list_identity_decisions().unwrap();
    assert_eq!(
        read["revision"],
        json!("00000000000000aa:same:dedupe/aa:git:b1")
    );
    assert_eq!(read["pending"], json!([]));
    assert_eq!(
        read["decisions"][0]["decided_at"],
        json!("2026-11-18 00:00:00+00")
    );
    let rows = b
        .store
        .list_entity_identities(&de::<IdentityFilter>(json!({ "entity_id": "dedupe/aa" })))
        .unwrap();
    let canonical: Vec<(Value, Value)> = rows
        .iter()
        .map(|r| (r["source_id"].clone(), r["canonical"].clone()))
        .collect();
    assert_eq!(
        canonical,
        [
            (json!("other"), json!(true)),
            (json!("default"), json!(false))
        ]
    );
    // An apply pinned to an older revision writes nothing.
    let stale = b
        .store
        .apply_identity_decisions(&de::<ApplyDecisions>(
            json!({ "remove": ["00000000000000aa"], "expect_revision": "" }),
        ))
        .unwrap();
    assert_eq!(
        stale,
        json!({ "upserted": 0, "removed": 0, "linked": 0, "unlinked": 0, "stale": true })
    );
    assert_eq!(
        b.store.list_identity_decisions().unwrap()["decisions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // A hand link is never touched; removing the decision unlinks only its confirmed rows.
    b.page("default", "people/bob-example");
    let hand = json!({ "entity_id": "dedupe/aa", "slug": "people/bob-example", "source_id": "default",
        "confidence": 0.5, "established_by": "manual", "canonical": false });
    assert!(
        b.store
            .link_entity_identity(&de::<IdentityLink>(hand))
            .unwrap()
    );
    let removed = b.store.apply_identity_decisions(&de::<ApplyDecisions>(json!({
        "remove": ["00000000000000aa"], "expect_revision": "00000000000000aa:same:dedupe/aa:git:b1",
    }))).unwrap();
    assert_eq!(
        removed,
        json!({ "upserted": 0, "removed": 1, "linked": 0, "unlinked": 2 })
    );
    let left = b
        .store
        .list_entity_identities(&de::<IdentityFilter>(json!({ "entity_id": "dedupe/aa" })))
        .unwrap();
    assert_eq!(
        left.iter().map(|r| r["slug"].clone()).collect::<Vec<_>>(),
        [json!("people/bob-example")]
    );
}

#[test]
fn a_non_finite_confidence_is_kept_exactly_and_never_breaks_a_listing() {
    let b = Brain::new("ei-non-finite");
    let values = [
        ("people/a-nan", f64::NAN),
        ("people/b-inf", f64::INFINITY),
        ("people/c-neg-inf", f64::NEG_INFINITY),
        ("people/d-finite", 0.1 + 0.2),
    ];
    for (slug, confidence) in values {
        b.page("default", slug);
        assert!(
            b.store
                .link_entity_identity(&IdentityLink {
                    entity_id: "g".into(),
                    slug: slug.into(),
                    source_id: "default".into(),
                    confidence,
                    established_by: "manual".into(),
                    canonical: None,
                })
                .unwrap()
        );
    }
    // Postgres keeps every float8 and lists it back; JSON has no number for NaN or ±Infinity, so the row carries the
    // text Postgres prints for them, and a finite value round-trips bit for bit.
    let rows = b
        .store
        .list_entity_identities(&IdentityFilter::default())
        .unwrap();
    let got: Vec<(String, Value)> = rows
        .iter()
        .map(|r| {
            (
                r["slug"].as_str().unwrap().to_string(),
                r["confidence"].clone(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("people/a-nan".to_string(), json!("NaN")),
            ("people/b-inf".to_string(), json!("Infinity")),
            ("people/c-neg-inf".to_string(), json!("-Infinity")),
            ("people/d-finite".to_string(), json!(0.1 + 0.2)),
        ]
    );
    assert_eq!(
        rows[3]["confidence"].as_f64().unwrap().to_bits(),
        (0.1f64 + 0.2).to_bits()
    );
}

#[test]
fn identity_decisions_keep_non_empty_evidence_and_sweep_a_broken_sync_link() {
    use gbrain_store::identity_reviews::ApplyDecisions;
    let b = Brain::new("identity-decisions-evidence");
    b.page("default", "companies/acme-example");
    let decision = |id: &str, evidence: Value| {
        json!({
            "decision_id": id, "verdict": "different",
            "members": [{"source_id": "default", "slug": "companies/acme-example"}],
            "group_id": null, "entity_id": null, "canonical": null, "decided_by": "owner",
            "decided_at": null, "origin": "database", "home_source_id": null, "git_blob": null,
            "evidence": evidence,
        })
    };
    b.store
        .apply_identity_decisions(&de::<ApplyDecisions>(json!({ "upsert": [
            decision("01", json!(["linkedin:acme-example"])), decision("02", json!([])), decision("03", Value::Null),
        ] })))
        .unwrap();
    let read = b.store.list_identity_decisions().unwrap();
    let evidence: Vec<Value> = read["decisions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["evidence"].clone())
        .collect();
    assert_eq!(
        evidence,
        [json!(["linkedin:acme-example"]), Value::Null, Value::Null]
    );
    // A company link the sync made ('dedupe:auto') is swept by the apply, as the SQL apply does: a
    // group left with one member is broken, so the apply removes it along with the decision.
    let auto = json!({ "entity_id": "company/acme", "slug": "companies/acme-example", "source_id": "default",
        "confidence": 1.0, "established_by": "dedupe:auto", "canonical": true });
    assert!(
        b.store
            .link_entity_identity(&de::<IdentityLink>(auto))
            .unwrap()
    );
    assert_eq!(
        b.members(),
        ["company/acme:default:companies/acme-example:true"]
    );
    let applied = b
        .store
        .apply_identity_decisions(&de::<ApplyDecisions>(json!({ "remove": ["01"] })))
        .unwrap();
    assert_eq!(applied["removed"], json!(1));
    assert_eq!(
        b.store.list_identity_decisions().unwrap()["decisions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(b.members().is_empty());
}

#[test]
fn a_link_sent_with_a_non_finite_confidence_as_text_decodes_and_bad_text_is_refused() {
    let link: IdentityLink = de(
        json!({ "entity_id": "g", "slug": "s", "source_id": "default",
        "confidence": "-Infinity", "established_by": "manual", "canonical": null }),
    );
    assert_eq!(link.confidence, f64::NEG_INFINITY);
    let bad = serde_json::from_value::<IdentityLink>(
        json!({ "entity_id": "g", "slug": "s", "source_id": "default",
        "confidence": "high", "established_by": "manual", "canonical": null }),
    );
    assert!(bad.is_err());
}
