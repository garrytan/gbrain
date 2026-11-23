//! The held fence cells of a world-only fact read, matched to PGLite (`engine-sql/cli-reads-ops.ts`
//! `listHeldFenceCells`, `eligibility/fence-overlay.ts` `heldRowSql`), with no member page, and with a
//! private-facts grant (`grantSources`). test/engine-parity/held-fence-cells.test.ts pins the same cells on every arm.

mod memory_env;

use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::facts::{ExpireFactArgs, HeldFenceCellsInput, InsertFactsArgs};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::trust::proposals::NewProposal;
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const SLUG: &str = "people/held-example";
const OTHER: &str = "people/other-example";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn fact(slug: &str, n: i32, text: &str, visibility: &str) -> Value {
    json!({
        "fact": text, "source": "fence", "source_markdown_slug": slug, "entity_slug": slug,
        "kind": "fact", "visibility": visibility, "row_num": n,
    })
}

fn seed(b: &Brain) {
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(json!({
            "rows": [
                fact(SLUG, 1, "Ana lives in Lima", "world"),
                fact(SLUG, 2, "Ana keeps bees tapirheld", "private"),
                fact(SLUG, 4, "Ana paints", "world"),
                fact(SLUG, 5, "Ana sings opera", "private"),
                fact(SLUG, 6, "Ana paints", "private"),
                fact(SLUG, 7, "Ana walks dogs daily", "private"),
                fact(SLUG, 8, "Ana rode horses", "private"),
                fact(OTHER, 3, "Ana lives in Lima", "private"),
            ],
            "sourceId": "default",
        })))
        .unwrap();
    let expired = out["ids"][6].as_u64().unwrap();
    assert!(
        b.expire_fact(&args::<ExpireFactArgs>(json!({ "id": expired })))
            .unwrap()
    );
}

fn key(slug: &str, n: i64, claim: &str, partial: bool) -> Value {
    json!({ "sourceId": "default", "slug": slug, "rowNum": n, "claim": claim, "partial": partial })
}

fn cells(b: &Brain, keys: Vec<Value>) -> Vec<(String, i64, String)> {
    b.list_held_fence_cells(&args::<HeldFenceCellsInput>(json!({ "keys": keys })))
        .unwrap()
        .iter()
        .map(|r| {
            assert_eq!(r["source_id"], "default");
            (
                r["slug"].as_str().unwrap().to_string(),
                r["row_num"].as_i64().unwrap(),
                r["claim"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn c(slug: &str, n: i64, claim: &str) -> (String, i64, String) {
    (slug.to_string(), n, claim.to_string())
}

#[test]
fn a_cell_is_held_by_its_row_number_or_an_unstated_narrower_restatement() {
    let b = brain("held-row");
    seed(&b);
    let found = cells(
        &b,
        vec![
            key(SLUG, 1, "Ana lives in Lima", false),
            key(SLUG, 2, "Ana keeps bees tapirheld", false),
            key(SLUG, 3, "Ana sings opera", false),
            key(SLUG, 4, "Ana paints", false),
            key(SLUG, 8, "Ana rode horses", false),
            key(OTHER, 2, "Ana keeps bees tapirheld", false),
            key(OTHER, 3, "Ana lives in Lima", false),
        ],
    );
    // Row 1 and row 4 are world (row 4's private restatement is also stated at world), row 8
    // expired, and the other page's row 2 is no row of this page's.
    assert_eq!(
        found,
        vec![
            c(SLUG, 2, "Ana keeps bees tapirheld"),
            c(SLUG, 3, "Ana sings opera"),
            c(OTHER, 3, "Ana lives in Lima"),
        ]
    );
}

#[test]
fn a_cut_claim_is_held_where_a_narrower_fact_contains_it() {
    let b = brain("held-cut");
    seed(&b);
    let found = cells(
        &b,
        vec![
            key(SLUG, 10, "Ana walks", false),
            key(SLUG, 9, "Ana walks", true),
            key(SLUG, -1, "sings", true),
            key(SLUG, -1, "Lima", true),
        ],
    );
    assert_eq!(found, vec![c(SLUG, 9, "Ana walks"), c(SLUG, -1, "sings")]);
}

#[test]
fn each_held_cell_is_named_once_and_no_keys_name_none() {
    let b = brain("held-once");
    seed(&b);
    let found = cells(
        &b,
        vec![
            key(SLUG, 2, "Ana keeps bees tapirheld", false),
            key(SLUG, 2, "Ana keeps bees tapirheld", true),
            key(SLUG, 2, "Ana keeps bees tapirheld", false),
        ],
    );
    assert_eq!(found, vec![c(SLUG, 2, "Ana keeps bees tapirheld")]);
    assert!(cells(&b, vec![]).is_empty());
    let other_source = json!({ "sourceId": "source-b", "slug": SLUG, "rowNum": 2,
        "claim": "Ana keeps bees tapirheld", "partial": false });
    assert!(cells(&b, vec![other_source]).is_empty());
}

#[test]
fn a_nul_or_an_out_of_range_row_number_is_refused() {
    let b = brain("held-refused");
    for bad in [
        key(SLUG, 1, "Ana\u{0}", false),
        key(SLUG, i64::from(i32::MAX) + 1, "Ana", false),
    ] {
        let err = b
            .list_held_fence_cells(&args::<HeldFenceCellsInput>(json!({ "keys": [bad] })))
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT);
    }
}

fn put(b: &Brain, slug: &str, frontmatter: Value) {
    let input: PageInput = args(json!({
        "type": "note", "title": slug, "compiled_truth": "body", "frontmatter": frontmatter
    }));
    let opts: PutPageOptions = args(json!({"sourceId": "default"}));
    b.put_page(slug, &input, &opts).unwrap();
}

fn granted_cells(b: &Brain, keys: Vec<Value>, sources: &[&str]) -> Vec<(String, i64, String)> {
    b.list_held_fence_cells(&args::<HeldFenceCellsInput>(
        json!({ "keys": keys, "grantSources": sources }),
    ))
    .unwrap()
    .iter()
    .map(|r| {
        (
            r["slug"].as_str().unwrap().to_string(),
            r["row_num"].as_i64().unwrap(),
            r["claim"].as_str().unwrap().to_string(),
        )
    })
    .collect()
}

/// `grantedPrivateFactSql` with `heldRowSql`'s visibility-proposal clause: a private fact of a granted source on a
/// live, open page is admitted, unless a visibility proposal names it and targets a fact the grant does not admit.
#[test]
fn a_private_facts_grant_admits_open_page_facts_unless_a_proposal_names_an_unread_copy() {
    let b = brain("held-cells-grant");
    put(&b, "notes/open-example", json!({}));
    put(
        &b,
        "notes/closed-example",
        json!({ "visibility": "private" }),
    );
    put(
        &b,
        "notes/quarantined-example",
        json!({ "quarantine": true }),
    );
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(json!({
            "rows": [
                fact("notes/open-example", 1, "Ana grows figs", "private"),
                fact("notes/open-example", 2, "Ana naps daily", "private"),
                fact("notes/closed-example", 1, "Ana hides gold", "private"),
                fact("notes/quarantined-example", 1, "Ana sails", "private"),
                fact("notes/open-example", 3, "Ana knits", "private"),
            ],
            "sourceId": "default",
        })))
        .unwrap();
    let id = |i: usize| out["ids"][i].as_i64().unwrap();
    let keys = || {
        vec![
            key("notes/open-example", 1, "Ana grows figs", false),
            key("notes/open-example", 3, "Ana knits", false),
            key("notes/closed-example", 1, "Ana hides gold", false),
            key("notes/quarantined-example", 1, "Ana sails", false),
        ]
    };
    let every = vec![
        c("notes/open-example", 1, "Ana grows figs"),
        c("notes/open-example", 3, "Ana knits"),
        c("notes/closed-example", 1, "Ana hides gold"),
        c("notes/quarantined-example", 1, "Ana sails"),
    ];
    assert_eq!(granted_cells(&b, keys(), &[]), every);
    assert_eq!(granted_cells(&b, keys(), &["other-source"]), every);
    assert_eq!(
        granted_cells(&b, keys(), &["default"]),
        vec![
            c("notes/closed-example", 1, "Ana hides gold"),
            c("notes/quarantined-example", 1, "Ana sails"),
        ]
    );
    // A visibility proposal that names "Ana grows figs" and targets a copy on the private page keeps it held; one that
    // names "Ana knits" and targets a copy the grant reads does not.
    for (target, related) in [(id(2), id(0)), (id(1), id(4))] {
        b.insert_trust_proposal(&args::<NewProposal>(json!({
            "action": "supersede_fact", "sourceId": "default",
            "target": { "table": "facts", "id": target },
            "related": { "table": "facts", "id": related },
            "before": { "visibility": "private" }, "proposer": "test",
        })))
        .unwrap();
    }
    assert_eq!(
        granted_cells(&b, keys(), &["default"]),
        vec![
            c("notes/open-example", 1, "Ana grows figs"),
            c("notes/closed-example", 1, "Ana hides gold"),
            c("notes/quarantined-example", 1, "Ana sails"),
        ]
    ); // The hold chain: once the copy "Ana knits" names ("Ana naps daily") is itself held by a copy the grant does not
    // read, "Ana knits" is held too.
    b.insert_trust_proposal(&args::<NewProposal>(json!({
        "action": "confirm", "sourceId": "default",
        "target": { "table": "facts", "id": id(2) },
        "related": { "table": "facts", "id": id(1) },
        "before": { "visibility": "private" }, "proposer": "test",
    })))
    .unwrap();
    assert_eq!(
        granted_cells(&b, keys(), &["default"]),
        vec![
            c("notes/open-example", 1, "Ana grows figs"),
            c("notes/open-example", 3, "Ana knits"),
            c("notes/closed-example", 1, "Ana hides gold"),
            c("notes/quarantined-example", 1, "Ana sails"),
        ]
    );
}
