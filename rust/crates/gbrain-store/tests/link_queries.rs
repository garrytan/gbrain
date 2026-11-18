//! Link reads and derived-link writes beyond the core links family (link_queries). Expected rows
//! follow the PGLite SQL in src/core/engine-sql/links.ts and the graph reads of
//! src/core/engine-sql/graph.ts.

mod common;

use common::TempDir;
use gbrain_store::link_queries::{
    ChainHopOptions, DerivedItem, FanoutOptions, GraphScope, LinkSourcesOptions, OrphanOptions,
    PageRef, RemoveBySourceOptions,
};
use gbrain_store::links::{AddLinkOptions, LinkScope};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::sources::SourceInput;
use gbrain_store::{OpenOptions, Store, SystemEnv};
use serde_json::{Value, json};
use std::sync::Arc;

struct Brain {
    _dir: TempDir,
    store: Store,
}

impl Brain {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(name);
        let kv = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
        let store = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default()).unwrap();
        Brain { _dir: dir, store }
    }

    fn source(&self, id: &str) {
        let input: SourceInput = serde_json::from_value(json!({"id": id, "name": id})).unwrap();
        self.store.upsert_source(&input).unwrap();
    }

    /// Writes one page and returns `(id, knowledge_revision)`.
    fn page(&self, slug: &str, source: &str, page_type: &str) -> (u64, String) {
        let input: PageInput = serde_json::from_value(json!({
            "type": page_type, "title": slug, "compiled_truth": format!("{slug} body"),
        }))
        .unwrap();
        let options: PutPageOptions =
            serde_json::from_value(json!({"sourceId": source, "index": false})).unwrap();
        let page = self.store.put_page(slug, &input, &options).unwrap();
        (
            page["id"].as_u64().unwrap(),
            page["knowledge_revision"].as_str().unwrap().to_string(),
        )
    }

    fn link(&self, from: &str, to: &str, link_type: &str, link_source: &str) {
        self.link_in(from, "default", to, "default", link_type, link_source);
    }

    fn link_in(&self, from: &str, fs: &str, to: &str, ts: &str, link_type: &str, source: &str) {
        let options = AddLinkOptions {
            link_type: Some(link_type.into()),
            link_source: Some(source.into()),
            from_source_id: Some(fs.into()),
            to_source_id: Some(ts.into()),
            ..AddLinkOptions::default()
        };
        self.store.add_link(from, to, &options).unwrap();
    }

    fn incarnation(&self, source: &str) -> String {
        self.store
            .get_source_by_id(source)
            .unwrap()
            .unwrap()
            .incarnation
    }

    /// `from>to:type:source` for each outgoing link of `slug`, sorted.
    fn out(&self, slug: &str) -> Vec<String> {
        let mut rows: Vec<String> = self
            .store
            .get_links(slug, &LinkScope::default())
            .unwrap()
            .iter()
            .map(|l| {
                format!(
                    "{}>{}:{}:{}",
                    l["from_slug"].as_str().unwrap(),
                    l["to_slug"].as_str().unwrap(),
                    l["link_type"].as_str().unwrap(),
                    l["link_source"].as_str().unwrap_or("null"),
                )
            })
            .collect();
        rows.sort();
        rows
    }
}

fn derived(origin: &str, revision: &str, incarnation: &str, rows: &[(&str, &str)]) -> DerivedItem {
    let rows: Vec<Value> = rows
        .iter()
        .map(|(to, link_type)| {
            json!({
                "from_slug": origin, "to_slug": to, "link_type": link_type,
                "link_source": "markdown", "origin_slug": origin,
                "from_source_id": "default", "to_source_id": "default",
                "origin_source_id": "default",
            })
        })
        .collect();
    serde_json::from_value(json!({
        "origin": {
            "slug": origin, "sourceId": "default", "expectedRevision": revision,
            "sourceIncarnation": incarnation,
        },
        "producers": ["markdown"],
        "rows": rows,
    }))
    .unwrap()
}

fn strings(rows: &[Value], key: &str) -> Vec<String> {
    rows.iter()
        .map(|r| r[key].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn replace_derived_links_swaps_the_origin_edges_and_keeps_manual_ones() {
    let b = Brain::new("lq-replace");
    let (_, rev) = b.page("d/origin", "default", "note");
    for slug in ["d/one", "d/two", "d/three"] {
        b.page(slug, "default", "note");
    }
    b.link("d/origin", "d/three", "cites", "manual");
    let inc = b.incarnation("default");

    let first = b
        .store
        .replace_derived_links(&[derived(
            "d/origin",
            &rev,
            &inc,
            &[("d/one", "cites"), ("d/two", "cites")],
        )])
        .unwrap();
    assert_eq!(first, vec![json!({"created": 2, "removed": 0})]);

    let cleared = b
        .store
        .replace_derived_links(&[derived("d/origin", &rev, &inc, &[])])
        .unwrap();
    assert_eq!(cleared, vec![json!({"created": 0, "removed": 2})]);
    assert_eq!(b.out("d/origin"), vec!["d/origin>d/three:cites:manual"]);

    // An empty batch is a no-op, not an error.
    assert!(b.store.replace_derived_links(&[]).unwrap().is_empty());
}

#[test]
fn replace_derived_links_refuses_a_stale_revision_and_a_bad_uuid() {
    let b = Brain::new("lq-conflict");
    let (_, rev) = b.page("d/origin", "default", "note");
    b.page("d/one", "default", "note");
    let inc = b.incarnation("default");
    let stale = "00000000-0000-4000-8000-000000000000";

    let err = b
        .store
        .replace_derived_links(&[derived("d/origin", stale, &inc, &[("d/one", "cites")])])
        .unwrap_err();
    assert_eq!(err.code, "revision_conflict");
    assert!(
        err.message.contains(&format!("item=0 current={rev}")),
        "{}",
        err.message
    );

    let err = b
        .store
        .replace_derived_links(&[derived("d/origin", "nope", &inc, &[("d/one", "cites")])])
        .unwrap_err();
    assert!(err.message.starts_with("bad_revision:"), "{}", err.message);

    // A wrong incarnation means the source was recreated: origin_changed.
    let err = b
        .store
        .replace_derived_links(&[derived("d/origin", &rev, "other", &[("d/one", "cites")])])
        .unwrap_err();
    assert!(
        err.message.starts_with("origin_changed:"),
        "{}",
        err.message
    );

    // A failed item rolls the whole batch back.
    let (_, rev2) = b.page("d/second", "default", "note");
    let err = b
        .store
        .replace_derived_links(&[
            derived("d/second", &rev2, &inc, &[("d/one", "cites")]),
            derived("d/origin", &rev, &inc, &[("d/missing", "cites")]),
        ])
        .unwrap_err();
    assert!(
        err.message.starts_with("endpoint_missing:"),
        "{}",
        err.message
    );
    assert!(b.out("d/second").is_empty());
}

#[test]
fn replace_derived_links_preserve_existing_keeps_unchanged_rows() {
    let b = Brain::new("lq-preserve");
    let (_, rev) = b.page("d/origin", "default", "note");
    b.page("d/one", "default", "note");
    b.page("d/two", "default", "note");
    let inc = b.incarnation("default");
    b.store
        .replace_derived_links(&[derived("d/origin", &rev, &inc, &[("d/one", "cites")])])
        .unwrap();

    let mut item = derived(
        "d/origin",
        &rev,
        &inc,
        &[("d/one", "cites"), ("d/two", "cites")],
    );
    item.preserve_existing = true;
    let result = b.store.replace_derived_links(&[item]).unwrap();
    assert_eq!(result, vec![json!({"created": 1, "removed": 0})]);

    let mut item = derived("d/origin", &rev, &inc, &[("d/two", "cites")]);
    item.preserve_existing = true;
    let result = b.store.replace_derived_links(&[item]).unwrap();
    assert_eq!(result, vec![json!({"created": 0, "removed": 1})]);
    assert_eq!(b.out("d/origin"), vec!["d/origin>d/two:cites:markdown"]);
}

#[test]
fn remove_by_pages_and_source_and_list_link_sources() {
    let b = Brain::new("lq-sources");
    b.source("other");
    for slug in ["a", "b", "c"] {
        b.page(slug, "default", "note");
    }
    b.page("x", "other", "note");
    b.link("a", "b", "cites", "markdown");
    b.link("a", "c", "cites", "markdown");
    b.link("a", "c", "cites", "manual");
    b.link("b", "c", "cites", "citation-graph");
    b.page("y", "other", "note");
    b.link_in("x", "other", "a", "default", "cites", "markdown");
    b.link_in("x", "other", "y", "other", "cites", "manual");

    let all = b
        .store
        .list_link_sources(&LinkSourcesOptions::default())
        .unwrap();
    assert_eq!(
        all,
        vec![
            json!({"link_source": "markdown", "count": 3}),
            json!({"link_source": "manual", "count": 2}),
            json!({"link_source": "citation-graph", "count": 1}),
        ]
    );
    let scoped = b
        .store
        .list_link_sources(&LinkSourcesOptions {
            source_id: Some("other".into()),
            ..LinkSourcesOptions::default()
        })
        .unwrap();
    // A scoped read counts an edge only when both endpoints are in scope: x>a crosses sources.
    assert_eq!(scoped, vec![json!({"link_source": "manual", "count": 1})]);

    let removed = b
        .store
        .remove_links_by_pages_and_source(
            &[PageRef {
                slug: "a".into(),
                source_id: "default".into(),
            }],
            &RemoveBySourceOptions {
                link_source: Some("markdown".into()),
                ..RemoveBySourceOptions::default()
            },
        )
        .unwrap();
    assert_eq!(removed, 2);
    assert_eq!(b.out("a"), vec!["a>c:cites:manual"]);
    // The incoming markdown link from the other source stays.
    assert_eq!(b.out("x"), vec!["x>a:cites:markdown", "x>y:cites:manual"]);
}

#[test]
fn orphans_backlinks_and_adjacency() {
    let b = Brain::new("lq-signals");
    let (hub, _) = b.page("hub", "default", "note");
    let (a, _) = b.page("a", "default", "note");
    let (c, _) = b.page("c", "default", "note");
    b.page("island", "default", "note");
    b.page("linker", "default", "note");
    b.link("a", "hub", "cites", "markdown");
    b.link("c", "hub", "cites", "markdown");
    b.link("a", "hub", "mentions", "markdown");
    b.link("linker", "a", "cites", "markdown");
    b.link("hub", "c", "cites", "markdown");

    let counts = b
        .store
        .get_backlink_counts(&[hub, a, 999], &GraphScope::default())
        .unwrap();
    assert_eq!(
        counts,
        vec![
            json!({"page_id": hub, "cnt": 2}),
            json!({"page_id": a, "cnt": 1}),
        ]
    );

    let boosts = b
        .store
        .get_adjacency_boosts(&[hub, a, c], &GraphScope::default())
        .unwrap();
    let hub_hits = boosts
        .iter()
        .find(|r| r["to_page_id"] == json!(hub))
        .unwrap();
    assert_eq!(hub_hits["hits"], json!(2));
    // linker is outside the set, so `a` gets no in-set linker.
    assert!(boosts.iter().all(|r| r["to_page_id"] != json!(a)));

    let islanded = b
        .store
        .find_orphan_pages(&OrphanOptions::default())
        .unwrap();
    assert_eq!(strings(&islanded, "slug"), vec!["island"]);
    let inbound = b
        .store
        .find_orphan_pages(&OrphanOptions {
            mode: Some("inbound".into()),
            ..OrphanOptions::default()
        })
        .unwrap();
    assert_eq!(strings(&inbound, "slug"), vec!["island", "linker"]);
}

#[test]
fn relational_fanout_walks_typed_edges() {
    let b = Brain::new("lq-fanout");
    for slug in ["seed", "inv-a", "inv-b", "far", "noise"] {
        b.page(slug, "default", "note");
    }
    b.link("seed", "inv-a", "invested_in", "markdown");
    b.link("seed", "inv-b", "invested_in", "markdown");
    b.link("inv-a", "far", "invested_in", "markdown");
    b.link("seed", "noise", "mentions", "markdown");

    let options = |depth: u32| FanoutOptions {
        link_types: Some(vec!["invested_in".into()]),
        direction: Some("out".into()),
        depth,
        limit: 50,
        ..FanoutOptions::default()
    };
    let one = b
        .store
        .relational_fanout(&["seed".into()], &options(1))
        .unwrap();
    assert_eq!(strings(&one, "slug"), vec!["inv-a", "inv-b"]);
    assert_eq!(one[0]["hop"], json!(1));
    assert_eq!(one[0]["path"], json!(["seed", "inv-a"]));

    let two = b
        .store
        .relational_fanout(&["seed".into()], &options(2))
        .unwrap();
    assert_eq!(strings(&two, "slug"), vec!["inv-a", "inv-b", "far"]);

    let scoped = b
        .store
        .relational_fanout(
            &["seed".into()],
            &FanoutOptions {
                source_id: Some("no-such-source".into()),
                scoped: true,
                ..options(2)
            },
        )
        .unwrap();
    assert!(scoped.is_empty());
}

#[test]
fn relational_chain_hop_orients_edges() {
    let b = Brain::new("lq-chain");
    let (emp, _) = b.page("people/emp", "default", "person");
    let (widget, _) = b.page("companies/widget", "default", "company");
    b.page("companies/other", "default", "company");
    b.link("people/emp", "companies/widget", "works_at", "markdown");
    b.link("people/emp", "companies/other", "works_at", "markdown");

    let options = |toward: &str, subject: &str, object: &str| ChainHopOptions {
        link_types: vec!["works_at".into()],
        toward: toward.into(),
        subject_types: vec![subject.into()],
        object_types: vec![object.into()],
        neighbor_cap: 100,
        ..ChainHopOptions::default()
    };
    let objects = b
        .store
        .relational_chain_hop(&[emp], &options("object", "person", "company"))
        .unwrap();
    assert_eq!(
        strings(&objects, "to_slug"),
        vec!["companies/widget", "companies/other"]
    );
    assert_eq!(objects[0]["orientation"], json!("stored"));

    let subjects = b
        .store
        .relational_chain_hop(&[widget], &options("subject", "person", "company"))
        .unwrap();
    assert_eq!(strings(&subjects, "to_slug"), vec!["people/emp"]);
}

#[test]
fn search_reads_supersede_probe_and_slugs() {
    let b = Brain::new("lq-supersede");
    b.source("other");
    let (stale, _) = b.page("stale", "default", "note");
    b.page("canon-z", "default", "note");
    b.page("canon-a", "default", "note");
    let (gone_to, _) = b.page("gone-to", "default", "note");
    b.page("gone-from", "default", "note");
    let (lonely, _) = b.page("lonely", "default", "note");
    b.page("canon-x", "other", "note");
    b.link("canon-z", "stale", "cites", "manual");
    assert!(!b.store.has_supersede_edges().unwrap());

    b.link("canon-z", "stale", "supersedes", "manual");
    b.link("canon-a", "stale", "supersedes", "manual");
    b.link("canon-z", "gone-to", "supersedes", "manual");
    b.link("gone-from", "lonely", "supersedes", "manual");
    b.link_in(
        "canon-x",
        "other",
        "lonely",
        "default",
        "supersedes",
        "manual",
    );
    b.store.soft_delete_page("gone-to", None).unwrap();
    b.store.soft_delete_page("gone-from", None).unwrap();
    assert!(b.store.has_supersede_edges().unwrap());

    let open = b
        .store
        .superseding_page_slugs(
            &[gone_to, stale, stale, lonely, 999],
            &GraphScope::default(),
        )
        .unwrap();
    // Ordered by page id, then slug bytes: `canon-a` is the first row for `stale`. A soft-deleted
    // target still counts without a policy; a soft-deleted or other-source superseder never does.
    assert_eq!(
        open,
        vec![
            json!({"to_page_id": stale, "by_slug": "canon-a"}),
            json!({"to_page_id": stale, "by_slug": "canon-z"}),
            json!({"to_page_id": gone_to, "by_slug": "canon-z"}),
        ]
    );
    let live = b
        .store
        .superseding_page_slugs(
            &[gone_to, stale],
            &GraphScope {
                scoped: true,
                ..GraphScope::default()
            },
        )
        .unwrap();
    assert_eq!(strings(&live, "by_slug"), vec!["canon-a", "canon-z"]);
    let elsewhere = b
        .store
        .superseding_page_slugs(
            &[stale],
            &GraphScope {
                source_id: Some("other".into()),
                scoped: true,
                ..GraphScope::default()
            },
        )
        .unwrap();
    assert!(elsewhere.is_empty());
}

/// A private page hidden by the page policy removes itself and every edge it takes part in from
/// the three ranking reads that serve `excludePrivate`: as the target, as the linking page and as
/// the page that authored the edge (the origin).
#[test]
fn ranking_reads_under_exclude_private_hide_private_targets_linkers_and_origins() {
    let b = Brain::new("lq-private");
    let marked = |slug: &str, frontmatter: Value| -> u64 {
        let input: PageInput = serde_json::from_value(json!({
            "type": "note", "title": slug, "compiled_truth": format!("{slug} body"),
            "frontmatter": frontmatter,
        }))
        .unwrap();
        let options: PutPageOptions =
            serde_json::from_value(json!({"sourceId": "default", "index": false})).unwrap();
        b.store.put_page(slug, &input, &options).unwrap()["id"]
            .as_u64()
            .unwrap()
    };
    let open_to = marked("open-to", json!({}));
    let open_from = marked("open-from", json!({}));
    let private_from = marked("private-from", json!({"visibility": "private"}));
    let by_alias = marked("alias-from", json!({"access": "private"}));
    let private_to = marked("private-to", json!({"visibility": "private"}));
    let private_origin = marked("private-origin", json!({"visibility": "private"}));
    let by_origin = marked("by-origin", json!({}));
    b.link("open-from", "open-to", "cites", "markdown");
    b.link("private-from", "open-to", "cites", "markdown");
    b.link("alias-from", "open-to", "cites", "markdown");
    b.link("open-from", "private-to", "cites", "markdown");
    b.link("open-from", "open-to", "supersedes", "markdown");
    b.link("private-from", "open-to", "supersedes", "manual");
    b.link("alias-from", "by-origin", "supersedes", "manual");
    let origin = AddLinkOptions {
        link_type: Some("cites".into()),
        link_source: Some("markdown".into()),
        origin_slug: Some("private-origin".into()),
        from_source_id: Some("default".into()),
        to_source_id: Some("default".into()),
        origin_source_id: Some("default".into()),
        ..AddLinkOptions::default()
    };
    b.store.add_link("open-from", "by-origin", &origin).unwrap();
    let _ = private_origin;
    let scope = |policy: Value| -> GraphScope {
        serde_json::from_value(json!({"scoped": true, "excludePrivate": policy})).unwrap()
    };
    let all = scope(json!({"honorAliases": true, "entityPrivacy": true, "ownerOnly": "lineage"}));
    let visibility_only =
        scope(json!({"honorAliases": false, "entityPrivacy": true, "ownerOnly": "lineage"}));
    let unpoliced = scope(Value::Null);

    // getBacklinkCounts: a private target is dropped, a private linker or a private origin does
    // not count. `open-to` keeps `open-from` only. `by-origin` has a link from `open-from` that a
    // private origin authored, and `alias-from`'s supersedes: both count without a policy; under
    // `visibility` alone only the second does.
    let ids = [open_to, private_to, by_origin];
    let counts = |scope: &GraphScope| b.store.get_backlink_counts(&ids, scope).unwrap();
    assert_eq!(
        counts(&unpoliced),
        vec![
            json!({"page_id": open_to, "cnt": 3}),
            json!({"page_id": private_to, "cnt": 1}),
            json!({"page_id": by_origin, "cnt": 2}),
        ],
        "a scope without a policy hides nothing private"
    );
    assert_eq!(
        counts(&all),
        vec![
            json!({"page_id": open_to, "cnt": 1}),
            json!({"page_id": by_origin, "cnt": 0}),
        ],
        "private target, private linker (`visibility`, `access` alias) and private origin all drop"
    );
    assert_eq!(
        counts(&visibility_only),
        vec![
            json!({"page_id": open_to, "cnt": 2}),
            json!({"page_id": by_origin, "cnt": 1}),
        ],
        "without the alias keys only `visibility` hides a page"
    );

    // getAdjacencyBoosts: both ends and the origin must pass.
    let set = [
        open_from,
        private_from,
        by_alias,
        open_to,
        private_to,
        by_origin,
    ];
    let hits = |scope: &GraphScope| -> Vec<(u64, u64)> {
        b.store
            .get_adjacency_boosts(&set, scope)
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["to_page_id"].as_u64().unwrap(),
                    r["hits"].as_u64().unwrap(),
                )
            })
            .collect()
    };
    let mut open_rows = vec![(open_to, 3), (private_to, 1), (by_origin, 2)];
    open_rows.sort();
    assert_eq!(hits(&unpoliced), open_rows);
    assert_eq!(hits(&all), vec![(open_to, 1)]);
    assert_eq!(hits(&visibility_only), vec![(open_to, 2), (by_origin, 1)]);

    // supersedingPageSlugs: the superseding page, the target and the origin must pass.
    let slugs = |scope: &GraphScope| -> Vec<String> {
        strings(
            &b.store
                .superseding_page_slugs(&[open_to, by_origin], scope)
                .unwrap(),
            "by_slug",
        )
    };
    // Ordered by target id, then slug: `open-to`'s superseders, then `by-origin`'s.
    assert_eq!(
        slugs(&unpoliced),
        vec!["open-from", "private-from", "alias-from"]
    );
    assert_eq!(slugs(&all), vec!["open-from"]);
    assert_eq!(slugs(&visibility_only), vec!["open-from", "alias-from"]);
    let private_target: GraphScope = serde_json::from_value(
        json!({"scoped": true, "excludePrivate": {"honorAliases": true, "entityPrivacy": true, "ownerOnly": "lineage"}}),
    )
    .unwrap();
    assert!(
        b.store
            .superseding_page_slugs(&[private_to], &private_target)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn search_reads_pages_linking_to() {
    let b = Brain::new("lq-linking");
    let (target, _) = b.page("target", "default", "person");
    let (linker, _) = b.page("linker", "default", "note");
    let (gone, _) = b.page("gone", "default", "note");
    let (amender, _) = b.page("amender", "default", "note");
    let (other, _) = b.page("other", "default", "note");
    b.link("linker", "target", "mentions", "manual");
    b.link("gone", "target", "works_at", "manual");
    b.link("amender", "target", "amends", "manual");
    b.link("other", "linker", "mentions", "manual");
    b.store.soft_delete_page("gone", None).unwrap();

    let ids = [other, amender, gone, linker, linker, 999];
    let mut expected = vec![linker, gone];
    expected.sort();
    assert_eq!(b.store.pages_linking_to(&ids, &[target]).unwrap(), expected);
    assert_eq!(
        b.store.pages_linking_to(&ids, &[]).unwrap(),
        Vec::<u64>::new()
    );
    assert_eq!(
        b.store.pages_linking_to(&[], &[target]).unwrap(),
        Vec::<u64>::new()
    );
}
