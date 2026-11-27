//! Page visibility guards: whether the caller sees one page, and which of a list of pages it reads,
//! for the read policy and the member-access policy, live and soft-deleted pages.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::access_rules::AccessRuleRecord;
use gbrain_store::facts::{LabelledOnly, OwnerOnlyForm, PrivacyPolicy};
use gbrain_store::links::AddLinkOptions;
use gbrain_store::page_visibility::{CallerPageAccessRow, PageRef, WriteVisibilityProbe};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, slug: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn put_typed(store: &Store, slug: &str, page_type: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(
        json!({"type": page_type, "title": slug, "compiled_truth": "body", "frontmatter": frontmatter}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    put(&store, "notes/open", json!({}));
    put(&store, "notes/private", json!({"visibility": "private"}));
    put(
        &store,
        "notes/alice",
        json!({"readable_by": ["member:alice"]}),
    );
    put(&store, "notes/gone", json!({}));
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    store
}

fn read_policy() -> PrivacyPolicy {
    PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    }
}

fn access_policy(identity: &[&str]) -> PrivacyPolicy {
    PrivacyPolicy {
        identity: identity.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    }
}

#[test]
fn hidden_judges_the_row_by_the_policy() {
    let dir = TempDir::new("visibility-hidden");
    let store = seeded(&dir);
    let hidden = |slug: &str, policy: &PrivacyPolicy| {
        store
            .read_page_hidden_from_caller("default", slug, policy)
            .unwrap()
    };
    assert!(!hidden("notes/open", &read_policy()));
    assert!(hidden("notes/private", &read_policy()));
    assert!(!hidden("notes/private", &access_policy(&[])));
    assert!(hidden("notes/alice", &access_policy(&[])));
    assert!(!hidden("notes/alice", &access_policy(&["member:alice"])));
    assert!(!hidden("notes/missing", &read_policy()));
    assert!(!hidden("notes/gone", &read_policy()));
    assert!(
        !store
            .read_page_hidden_from_caller("other", "notes/private", &read_policy())
            .unwrap()
    );
}

/// The labelled-only conjunct of a stored write's writer (`labelledOnlyForSql`): the page names one of the identities, or a
/// folder rule stamped on it is one the writer satisfies; the rest of the policy still applies, so it only narrows.
#[test]
fn hidden_judges_the_labelled_only_conjunct() {
    let dir = TempDir::new("visibility-labelled");
    let store = seeded(&dir);
    put(
        &store,
        "notes/carol",
        json!({"readable_by": ["member:carol"]}),
    );
    put(&store, "notes/team", json!({"readable_by": "group:team"}));
    put(&store, "notes/nobody", json!({"readable_by": 5}));
    store.put_access_policy_state("default").unwrap();
    for (id, prefix, readers) in [
        ("carol-rule", "ruled/", "member:carol"),
        ("alice-rule", "alices/", "member:alice"),
    ] {
        let rule: AccessRuleRecord = serde_json::from_value(json!({
            "source_id": "default", "rule_id": id, "prefix": prefix, "readable_by": [readers], "revision": 1,
        }))
        .unwrap();
        store.put_access_rule(rule).unwrap();
    }
    put(&store, "ruled/page", json!({}));
    put(&store, "alices/page", json!({}));
    let policy = |identity: &[&str], satisfied: &[&str], labelled: bool| {
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        PrivacyPolicy {
            identity: ids(identity),
            satisfied_rule_ids: ids(satisfied),
            caller_record: true,
            labelled_only: labelled.then(|| {
                Box::new(LabelledOnly {
                    identity: ids(identity),
                    satisfied_rule_ids: ids(satisfied),
                    ..Default::default()
                })
            }),
            ..Default::default()
        }
    };
    let hidden = |slug: &str, policy: &PrivacyPolicy| {
        store
            .read_page_hidden_from_caller("default", slug, policy)
            .unwrap()
    };
    let carol = ["member:carol", "group:team"];
    let satisfied = ["default:carol-rule"];
    // Without the conjunct the open page is readable; with it, a page that names nobody and has no stamped rule is not.
    assert!(!hidden("notes/open", &policy(&carol, &[], false)));
    assert!(hidden("notes/open", &policy(&carol, &[], true)));
    // Named by the member, or by a group it is in.
    assert!(!hidden("notes/carol", &policy(&carol, &[], true)));
    assert!(!hidden("notes/team", &policy(&carol, &[], true)));
    assert!(hidden("notes/team", &policy(&["member:carol"], &[], true)));
    // Named by another member, or by a readable_by that does not normalize: hidden by the conjunct and by the rest.
    assert!(hidden("notes/alice", &policy(&carol, &[], true)));
    assert!(hidden("notes/nobody", &policy(&carol, &[], true)));
    // A stamped rule the writer satisfies names it; one it does not satisfy hides the page whatever the conjunct says.
    assert!(!hidden("ruled/page", &policy(&carol, &satisfied, true)));
    assert!(hidden("ruled/page", &policy(&carol, &[], true)));
    assert!(hidden("alices/page", &policy(&carol, &satisfied, true)));
    // A rule satisfied but stamped on no page names nothing: an open page stays hidden for a labelled-only writer.
    assert!(hidden("notes/open", &policy(&carol, &satisfied, true)));
    // Empty terms name nothing (an invalid identity or rule id empties them).
    let mut none = policy(&carol, &satisfied, true);
    none.labelled_only = Some(Box::default());
    assert!(hidden("notes/carol", &none));
    assert!(hidden("ruled/page", &none));
}

/// `readPageHiddenFromWriter`: the writer's policy judged on the row of a slug, live or soft-deleted (the statement of
/// `hiddenUnder`'s fallback has no `deleted_at` test), and false for a slug with no row.
#[test]
fn hidden_from_writer_judges_a_soft_deleted_row_like_a_live_one() {
    let dir = TempDir::new("visibility-writer-hidden");
    let store = open(&dir);
    let rows = [
        ("open", json!({})),
        ("names-bob", json!({"readable_by": ["member:bob"]})),
        ("names-alice", json!({"readable_by": ["member:alice"]})),
        ("private", json!({"visibility": "private"})),
    ];
    for (name, frontmatter) in &rows {
        put(&store, &format!("notes/{name}"), frontmatter.clone());
        put(&store, &format!("gone/{name}"), frontmatter.clone());
        store
            .soft_delete_page(&format!("gone/{name}"), Some("default"))
            .unwrap();
    }
    let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let policy = |identity: &[&str], labelled: bool| PrivacyPolicy {
        identity: ids(identity),
        caller_record: true,
        labelled_only: labelled.then(|| LabelledOnly {
            identity: ids(identity),
            satisfied_rule_ids: vec![],
        }),
        ..Default::default()
    };
    let hidden = |slug: &str, policy: &PrivacyPolicy, hide: bool| {
        store
            .read_page_hidden_from_writer("default", slug, policy, hide, true)
            .unwrap()
    };
    let bob = policy(&["member:bob"], false);
    for prefix in ["notes", "gone"] {
        // A row that names another reader hides the slug, whether or not the row is deleted; one that names the writer does not.
        assert!(
            hidden(&format!("{prefix}/names-alice"), &bob, true),
            "{prefix}"
        );
        assert!(
            !hidden(&format!("{prefix}/names-bob"), &bob, true),
            "{prefix}"
        );
        assert!(!hidden(&format!("{prefix}/open"), &bob, true), "{prefix}");
        // The privacy part hides a private page only when asked.
        assert!(hidden(&format!("{prefix}/private"), &bob, true), "{prefix}");
        assert!(
            !hidden(&format!("{prefix}/private"), &bob, false),
            "{prefix}"
        );
        // A labelled-only writer reads only a page that names it, soft-deleted or not.
        let carol = policy(&["member:carol"], true);
        assert!(hidden(&format!("{prefix}/open"), &carol, true), "{prefix}");
        assert!(
            hidden(&format!("{prefix}/names-bob"), &carol, true),
            "{prefix}"
        );
    }
    let names_carol = policy(&["member:bob", "member:carol"], true);
    assert!(!hidden("gone/names-bob", &names_carol, true));
    // No row, in this source or another: nothing is hidden.
    assert!(!hidden("notes/missing", &bob, true));
    assert!(
        !store
            .read_page_hidden_from_writer("other", "notes/names-alice", &bob, true, true)
            .unwrap()
    );
}

#[test]
fn access_names_each_page_row_once() {
    let dir = TempDir::new("visibility-access");
    let store = seeded(&dir);
    let pages: Vec<PageRef> = [
        "notes/open",
        "notes/private",
        "notes/alice",
        "notes/gone",
        "notes/missing",
        "notes/open",
    ]
    .iter()
    .map(|slug| PageRef {
        source_id: "default".into(),
        slug: (*slug).into(),
    })
    .collect();
    let row = |slug: &str, readable: bool| CallerPageAccessRow {
        source_id: "default".into(),
        slug: slug.into(),
        readable,
    };
    assert_eq!(
        store
            .read_caller_page_access(&pages, &read_policy())
            .unwrap(),
        [
            row("notes/alice", false),
            row("notes/gone", false),
            row("notes/open", true),
            row("notes/private", false),
        ]
    );
    assert_eq!(
        store
            .read_caller_page_access(&pages, &access_policy(&["member:alice"]))
            .unwrap(),
        [
            row("notes/alice", true),
            row("notes/gone", false),
            row("notes/open", true),
            row("notes/private", true),
        ]
    );
    assert!(
        store
            .read_caller_page_access(&[], &read_policy())
            .unwrap()
            .is_empty()
    );
}

fn source(store: &Store, id: &str, config: Value) {
    let input: SourceInput =
        serde_json::from_value(json!({ "id": id, "name": id, "config": config })).unwrap();
    store.upsert_source(&input).unwrap();
}

fn probe(
    identity_may_open: Option<bool>,
    owner_only_source: bool,
    owner_only_any: bool,
) -> WriteVisibilityProbe {
    WriteVisibilityProbe {
        any_labelled: false,
        identity_may_open,
        owner_only_source,
        owner_only_any,
    }
}

#[test]
fn write_probe_names_what_an_identity_could_open() {
    let dir = TempDir::new("visibility-probe");
    let store = seeded(&dir);
    let read = |slug: &str| {
        store
            .read_write_visibility_probe("default", slug, &read_policy())
            .unwrap()
    };
    assert_eq!(read("notes/open"), probe(None, false, false));
    assert_eq!(read("notes/missing"), probe(None, false, false));
    assert_eq!(read("notes/private"), probe(Some(false), false, false));
    assert_eq!(read("notes/alice"), probe(Some(true), false, false));
}

#[test]
fn write_probe_reports_a_labelled_only_member() {
    let dir = TempDir::new("visibility-probe-labelled");
    let store = seeded(&dir);
    let any = || {
        let read = store.read_write_visibility_probe("default", "notes/open", &read_policy());
        read.unwrap().any_labelled
    };
    let spec: gbrain_store::access_members::AccessMemberInsert =
        serde_json::from_value(json!({ "id": "carol" })).unwrap();
    store.insert_access_member(&spec).unwrap();
    assert!(!any());
    store
        .set_access_member_labelled_only("carol", true)
        .unwrap();
    assert!(any());
}

#[test]
fn write_probe_reads_owner_only_sources() {
    let dir = TempDir::new("visibility-probe-owner");
    let store = seeded(&dir);
    let read = |source_id: &str| {
        store
            .read_write_visibility_probe(source_id, "notes/open", &read_policy())
            .unwrap()
    };
    source(&store, "plain", json!({ "owner_only": false }));
    assert_eq!(read("plain"), probe(None, false, false));
    source(&store, "chat", json!({ "kind": "imessage" }));
    assert_eq!(read("plain"), probe(None, false, true));
    assert_eq!(read("chat"), probe(None, true, true));
    source(&store, "flagged", json!({ "owner_only": "true" }));
    assert_eq!(read("flagged"), probe(None, true, true));
    assert_eq!(read("absent"), probe(None, false, true));
    // The owner-only test in its closed form (the policy's default): an owner-only source hides every page.
    assert_eq!(read("default"), probe(Some(false), false, true));
    assert!(
        store
            .read_page_hidden_from_caller("default", "notes/open", &read_policy())
            .unwrap()
    );
    let rows = store
        .read_caller_page_access(
            &[PageRef {
                source_id: "default".into(),
                slug: "notes/open".into(),
            }],
            &read_policy(),
        )
        .unwrap();
    assert!(!rows[0].readable);
}

fn put_in(store: &Store, source: &str, slug: &str, page_type: &str) {
    let input: PageInput = serde_json::from_value(
        json!({"type": page_type, "title": slug, "compiled_truth": "body", "frontmatter": {}}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn form_policy(form: OwnerOnlyForm) -> PrivacyPolicy {
    PrivacyPolicy {
        owner_only: form,
        ..read_policy()
    }
}

#[test]
fn owner_only_forms_match_the_sql() {
    let dir = TempDir::new("visibility-owner-forms");
    let store = seeded(&dir);
    source(&store, "chat", json!({ "kind": "imessage" }));
    put_in(&store, "chat", "notes/message", "note");
    put_in(&store, "default", "concepts/lineage", "concept");
    put_in(&store, "default", "concepts/plain", "concept");
    put_in(&store, "default", "notes/linked-note", "note");
    let provenance = AddLinkOptions {
        link_type: Some("synthesized_from".into()),
        link_source: Some("concept-provenance".into()),
        to_source_id: Some("chat".into()),
        ..Default::default()
    };
    store
        .add_link("concepts/lineage", "notes/message", &provenance)
        .unwrap();
    // A note is not a concept or question, so its provenance link is not lineage.
    store
        .add_link("notes/linked-note", "notes/message", &provenance)
        .unwrap();
    let hidden = |source_id: &str, slug: &str, form: OwnerOnlyForm| {
        store
            .read_page_hidden_from_caller(source_id, slug, &form_policy(form))
            .unwrap()
    };
    for slug in ["notes/open", "concepts/plain", "notes/linked-note"] {
        assert!(hidden("default", slug, OwnerOnlyForm::Closed), "{slug}");
        assert!(!hidden("default", slug, OwnerOnlyForm::Fn), "{slug}");
        assert!(!hidden("default", slug, OwnerOnlyForm::Off), "{slug}");
    }
    assert!(hidden("default", "concepts/lineage", OwnerOnlyForm::Fn));
    assert!(!hidden("default", "concepts/lineage", OwnerOnlyForm::Off));
    assert!(hidden("chat", "notes/message", OwnerOnlyForm::Fn));
    assert!(hidden("chat", "notes/message", OwnerOnlyForm::Closed));
    assert!(!hidden("chat", "notes/message", OwnerOnlyForm::Off));
    // The member-access part alone (no privacy part) carries the test too.
    let access = PrivacyPolicy {
        owner_only: OwnerOnlyForm::Fn,
        ..access_policy(&[])
    };
    assert!(
        store
            .read_page_hidden_from_caller("chat", "notes/message", &access)
            .unwrap()
    );
    assert!(
        !store
            .read_page_hidden_from_caller("default", "notes/private", &access)
            .unwrap()
    );
}

#[test]
fn owner_only_form_reads_from_the_policy_json() {
    let policy: PrivacyPolicy = serde_json::from_value(
        json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "fn"}),
    )
    .unwrap();
    assert_eq!(policy.owner_only, OwnerOnlyForm::Fn);
    let policy: PrivacyPolicy =
        serde_json::from_value(json!({"honorAliases": true, "entityPrivacy": true})).unwrap();
    assert_eq!(policy.owner_only, OwnerOnlyForm::Closed);
    // Master's member names the fn form `lineage`.
    let policy: PrivacyPolicy = serde_json::from_value(
        json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "lineage"}),
    )
    .unwrap();
    assert_eq!(policy.owner_only, OwnerOnlyForm::Fn);
    assert!(
        serde_json::from_value::<PrivacyPolicy>(
            json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "mode"})
        )
        .is_err()
    );
}

#[test]
fn the_open_form_hides_every_page_that_names_readers_and_reads_the_store_flag_for_origins() {
    let dir = TempDir::new("visibility-open");
    let store = seeded(&dir);
    let input: PageInput = serde_json::from_value(json!({
        "type": "atom", "title": "atom", "compiled_truth": "body",
        "frontmatter": {"source_slug": "notes/alice"}
    }))
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    store.put_page("atoms/from-alice", &input, &opts).unwrap();
    let open = |identity: &[&str]| PrivacyPolicy {
        open: true,
        ..access_policy(identity)
    };
    let hidden = |slug: &str, policy: &PrivacyPolicy| {
        store
            .read_page_hidden_from_caller("default", slug, policy)
            .unwrap()
    };
    // The short form ignores the identity: a page that names readers is hidden from its own reader.
    assert!(hidden("notes/alice", &open(&["member:alice"])));
    assert!(!hidden("notes/alice", &access_policy(&["member:alice"])));
    assert!(!hidden("notes/open", &open(&[])));
    // The flag is set, so the origin walk still hides the atom derived from a page with readers.
    assert!(hidden("atoms/from-alice", &open(&[])));
    // With the flag unset by hand (the premise the short form trusts), the walk is skipped.
    store
        .set_config("access.restrictions_present", "0")
        .unwrap();
    assert!(!hidden("atoms/from-alice", &open(&[])));
    assert!(hidden("atoms/from-alice", &access_policy(&[])));
}

#[test]
fn privacy_hidden_judges_the_live_page_by_the_privacy_part_alone() {
    let dir = TempDir::new("visibility-privacy-hidden");
    let store = seeded(&dir);
    put(&store, "notes/aliased", json!({"access": "private"}));
    put(
        &store,
        "notes/shown",
        json!({"access": "private", "visibility": "world"}),
    );
    let hidden = |slug: &str, honor_aliases: bool| {
        store
            .read_page_privacy_hidden("default", slug, honor_aliases)
            .unwrap()
    };
    assert_eq!(hidden("notes/private", false), Some(true));
    assert_eq!(hidden("notes/open", true), Some(false));
    // The readers list is the member-access part, not the privacy part.
    assert_eq!(hidden("notes/alice", true), Some(false));
    // A soft-deleted page and a missing one have no live row.
    assert_eq!(hidden("notes/gone", true), None);
    assert_eq!(hidden("notes/missing", true), None);
    assert_eq!(
        store
            .read_page_privacy_hidden("other", "notes/open", true)
            .unwrap(),
        None
    );
    // `access: private` hides only while the aliases are honoured, and never against a stated visibility.
    assert_eq!(hidden("notes/aliased", true), Some(true));
    assert_eq!(hidden("notes/aliased", false), Some(false));
    assert_eq!(hidden("notes/shown", true), Some(false));
}

#[test]
fn private_only_slugs_names_a_slug_every_scoped_row_of_which_is_hidden() {
    let dir = TempDir::new("visibility-private-only");
    let store = seeded(&dir);
    store
        .upsert_source(&SourceInput {
            id: "second".into(),
            ..Default::default()
        })
        .unwrap();
    let input: PageInput = serde_json::from_value(
        json!({"type": "note", "title": "t", "compiled_truth": "body", "frontmatter": {}}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "second"})).unwrap();
    store.put_page("notes/private", &input, &opts).unwrap();
    let slugs: Vec<String> = [
        "notes/private",
        "notes/open",
        "notes/gone",
        "notes/never",
        "notes/private",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let read = |source_id: Option<&str>, source_ids: Option<&[&str]>, deleted: bool| {
        store
            .read_private_only_slugs(
                &slugs,
                source_id.map(str::to_owned),
                source_ids.map(|ids| ids.iter().map(|s| s.to_string()).collect()),
                deleted,
                &read_policy(),
            )
            .unwrap()
    };
    // One source: its only row of notes/private is hidden; notes/gone has no live row.
    assert_eq!(read(Some("default"), None, false), ["notes/private"]);
    // Both sources, or every source: notes/private is open in `second`.
    assert!(read(None, Some(&["default", "second"]), false).is_empty());
    assert!(read(None, None, false).is_empty());
    // A non-empty array wins over the scalar; an empty one does not.
    assert_eq!(
        read(Some("second"), Some(&["default"]), false),
        ["notes/private"]
    );
    assert!(read(Some("second"), Some(&[]), false).is_empty());
    // Soft-deleted rows count with include_deleted: notes/gone is open, so it is not named.
    assert_eq!(read(Some("default"), None, true), ["notes/private"]);
}

/// A remote read of a labelled-only caller, as the TypeScript member sends it: its identity and the rules it satisfies, a
/// caller record, the lineage member-access part (`ownerRead`) and, with `lineage`, the labelled-only origin walk.
fn labelled_read(lineage: bool) -> PrivacyPolicy {
    let identity = vec!["member:carol".to_string(), "group:team".to_string()];
    let satisfied = vec!["default:carol-rule".to_string()];
    PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        identity: identity.clone(),
        satisfied_rule_ids: satisfied.clone(),
        caller_record: true,
        owner_read: lineage,
        labelled_only: Some(Box::new(LabelledOnly {
            identity,
            satisfied_rule_ids: satisfied,
            lineage,
            member: None,
        })),
        ..Default::default()
    }
}

fn link_input(store: &Store, from: &str, to: &str) {
    let options: AddLinkOptions = serde_json::from_value(json!({
        "linkType": "synthesized_from", "linkSource": "concept-provenance", "context": ""
    }))
    .unwrap();
    store.add_link(from, to, &options).unwrap();
}

/// `gbrain_access_origin_labelled_for` (v308), branch by branch: a derived page with no label of its own is read by a
/// labelled-only caller with lineage on only when it has an origin and every origin names the caller. The rows are the
/// parity case's (test/engine-parity/labelled-only-reads.test.ts), judged here by the store alone.
#[test]
fn hidden_walks_the_labelled_origin_of_a_derived_page() {
    let dir = TempDir::new("visibility-labelled-walk");
    let store = open(&dir);
    put(&store, "open/plain", json!({}));
    put(
        &store,
        "open/origin-carol",
        json!({"readable_by": ["member:carol"]}),
    );
    put(
        &store,
        "open/origin-bob",
        json!({"readable_by": ["member:bob"]}),
    );
    put(
        &store,
        "open/readers-group",
        json!({"readable_by": ["group:team"]}),
    );
    put(
        &store,
        "open/was-carol",
        json!({"readable_by": ["member:carol"]}),
    );
    store
        .update_slug("open/was-carol", "open/now-carol", Some("default"))
        .unwrap();
    store.put_access_policy_state("default").unwrap();
    let rule: AccessRuleRecord = serde_json::from_value(json!({
        "source_id": "default", "rule_id": "carol-rule", "prefix": "ruled/",
        "readable_by": ["member:carol"], "revision": 1,
    }))
    .unwrap();
    store.put_access_rule(rule).unwrap();
    put(&store, "ruled/open", json!({}));
    let world = |fm: Value| {
        let mut fm = fm;
        fm["visibility"] = json!("world");
        fm
    };
    let chronicle =
        |depth: &str| json!({"captured_via": "life-chronicle:x", "event": {"depth": depth}});
    // (slug, type, frontmatter, inputs, read with lineage on)
    let rows: Vec<(&str, &str, Value, Vec<&str>, bool)> = vec![
        (
            "w01",
            "atom",
            json!({"source_slug": "open/origin-carol"}),
            vec![],
            true,
        ),
        (
            "w02",
            "atom",
            json!({"source_slug": "open/origin-bob"}),
            vec![],
            false,
        ),
        ("w03", "atom", json!({}), vec![], false),
        (
            "w04",
            "atom",
            json!({"source_slug": "open/plain"}),
            vec![],
            false,
        ),
        (
            "w05",
            "atom",
            json!({"source_slug": "open/was-carol"}),
            vec![],
            true,
        ),
        (
            "w06",
            "concept",
            json!({"synthesized_by": "x"}),
            vec!["open/origin-carol", "open/readers-group"],
            true,
        ),
        (
            "w07",
            "concept",
            json!({"synthesized_by": "x"}),
            vec!["open/origin-carol", "open/plain"],
            false,
        ),
        (
            "w08",
            "concept",
            json!({"synthesized_by": "x"}),
            vec!["walk/w01"],
            true,
        ),
        (
            "w09",
            "concept",
            json!({"synthesized_by": "x"}),
            vec![],
            false,
        ),
        (
            "w10",
            "question",
            json!({}),
            vec!["open/origin-carol"],
            true,
        ),
        ("w11", "concept", json!({}), vec![], false),
        ("w12", "event", chronicle("open/origin-carol"), vec![], true),
        ("w13", "event", chronicle("open/nowhere"), vec![], false),
        ("w14", "event", json!({}), vec![], false),
        (
            "w15",
            "note",
            json!({"derived_from": ["open/origin-carol.md", "open/origin-bob"]}),
            vec![],
            false,
        ),
        (
            "w16",
            "note",
            json!({"derived_from": ["open/origin-carol.md", null]}),
            vec![],
            false,
        ),
        (
            "w16b",
            "note",
            json!({"derived_from": [null]}),
            vec![],
            false,
        ),
        ("w17", "note", json!({"derived_from": []}), vec![], false),
        (
            "w18",
            "note",
            json!({"derived_from": "open/nowhere"}),
            vec![],
            false,
        ),
        ("w19", "note", json!({"derived_from": 5}), vec![], false),
        (
            "w20",
            "note",
            json!({"derived_from": "ruled/open"}),
            vec![],
            true,
        ),
        (
            "w21",
            "note",
            json!({"derived_from": "open/readers-group"}),
            vec![],
            true,
        ),
        (
            "w22",
            "atom",
            json!({"source_slug": "open/origin-carol", "derived_from": "open/plain"}),
            vec![],
            false,
        ),
        ("w23", "note", json!({"derived_from": null}), vec![], false),
        (
            "w24",
            "note",
            json!({"readable_by": ["member:carol"], "derived_from": "open/plain"}),
            vec![],
            true,
        ),
    ];
    for (id, kind, fm, inputs, _) in &rows {
        let slug = format!("walk/{id}");
        put_typed(&store, &slug, kind, world(fm.clone()));
        for input in inputs {
            link_input(&store, &slug, input);
        }
    }
    let hidden = |id: &str, policy: &PrivacyPolicy| {
        store
            .read_page_hidden_from_caller("default", &format!("walk/{id}"), policy)
            .unwrap()
    };
    for (id, _, _, _, on) in &rows {
        assert_eq!(
            !hidden(id, &labelled_read(true)),
            *on,
            "{id} with lineage on"
        );
        // Without lineage a derived page that names nobody is hidden, whatever its origins say; only w24 names the member.
        assert_eq!(
            !hidden(id, &labelled_read(false)),
            *id == "w24",
            "{id} with lineage off"
        );
    }
}

/// A version names its own readers: the live page's readers do not label it, a rule the caller satisfies on the live
/// page does, and with lineage so does a derived live page whose origins all name the caller. A reason is withheld when
/// the successor snapshot fails the same test.
#[test]
fn get_versions_judges_the_labelled_conjunct_of_a_snapshot() {
    let dir = TempDir::new("visibility-labelled-versions");
    let store = open(&dir);
    put(
        &store,
        "open/origin-carol",
        json!({"readable_by": ["member:carol"]}),
    );
    store.put_access_policy_state("default").unwrap();
    let rule: AccessRuleRecord = serde_json::from_value(json!({
        "source_id": "default", "rule_id": "carol-rule", "prefix": "ruled/",
        "readable_by": ["member:carol"], "revision": 1,
    }))
    .unwrap();
    store.put_access_rule(rule).unwrap();
    let rewrite = |slug: &str, old: Value, live: Value| {
        put(&store, slug, old);
        store
            .create_version_with(slug, Some("default"), Some("why"))
            .unwrap();
        put(&store, slug, live);
    };
    rewrite(
        "open/v-old-carol",
        json!({"readable_by": ["member:carol"]}),
        json!({"readable_by": ["member:carol", "member:bob"]}),
    );
    rewrite(
        "open/v-old-bob",
        json!({"readable_by": ["member:bob"]}),
        json!({"readable_by": ["member:carol", "member:bob"]}),
    );
    rewrite(
        "open/v-live-readers",
        json!({}),
        json!({"readable_by": ["member:carol"]}),
    );
    rewrite("ruled/v-open", json!({}), json!({}));
    rewrite(
        "open/v-derived",
        json!({"derived_from": "open/origin-carol"}),
        json!({"derived_from": "open/origin-carol"}),
    );
    let listed = |slug: &str, policy: &PrivacyPolicy| {
        let options = gbrain_store::pages::VersionsOptions {
            exclude_private: Some(policy.clone()),
            ..Default::default()
        };
        store.get_versions(slug, &options).unwrap().len()
    };
    for (slug, off, on) in [
        ("open/v-old-carol", 1, 1),
        ("open/v-old-bob", 0, 0),
        ("open/v-live-readers", 0, 0),
        ("ruled/v-open", 1, 1),
        ("open/v-derived", 0, 1),
    ] {
        assert_eq!(
            listed(slug, &labelled_read(false)),
            off,
            "{slug} with lineage off"
        );
        assert_eq!(
            listed(slug, &labelled_read(true)),
            on,
            "{slug} with lineage on"
        );
    }
    // The first snapshot's reason: its successor is the live page (not judged here), so it shows; the reason of a snapshot
    // whose successor snapshot fails the labelled test is withheld.
    put(
        &store,
        "open/v-reason",
        json!({"readable_by": ["member:carol"]}),
    );
    store
        .create_version_with("open/v-reason", Some("default"), Some("one"))
        .unwrap();
    put(&store, "open/v-reason", json!({}));
    store
        .create_version_with("open/v-reason", Some("default"), Some("two"))
        .unwrap();
    put(
        &store,
        "open/v-reason",
        json!({"readable_by": ["member:carol"]}),
    );
    let options = gbrain_store::pages::VersionsOptions {
        exclude_private: Some(labelled_read(false)),
        ..Default::default()
    };
    let rows = store.get_versions("open/v-reason", &options).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(
        rows[0]["replaced_because"].is_null(),
        "the successor names nobody: the reason is withheld"
    );
}
