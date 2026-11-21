//! The count and list reads of takes, salience and code edges: `countOffGridTakeWeights`, `countTakes`,
//! `planFactPurgeTakes`, `listTakeRowsForPage`, `countMcpResolvedTakes`, `listTakeSupersessionCandidates`,
//! `countZeroWeightWithTakes` and `hasCodeEdgesSymbol`, matched to the SQL in
//! `src/core/engine-sql/takes-reads.ts`.

mod memory_env;

use gbrain_store::chunks::{ChunkInput, UpsertChunksOptions};
use gbrain_store::code_edges::CodeEdgeInput;
use gbrain_store::facts::InsertFactArgs;
use gbrain_store::facts::purge::PurgeTargetArgs;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::salience::EmotionalWeightRow;
use gbrain_store::sources::SourceInput;
use gbrain_store::takes::{McpResolvedInput, PurgeTakesInput, ResolveTakeInput, TakeInput};
use memory_env::{Brain, brain};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn source(b: &Brain, id: &str) {
    b.upsert_source(&de::<SourceInput>(json!({"id": id, "name": id})))
        .unwrap();
}

fn page(b: &Brain, source: &str, slug: &str) -> u64 {
    let input: PageInput = de(json!({"type": "note", "title": slug, "compiled_truth": "x"}));
    let opts: PutPageOptions = de(json!({"sourceId": source}));
    b.put_page(slug, &input, &opts).unwrap()["id"]
        .as_u64()
        .unwrap()
}

/// One take row. `extra` overrides the defaults (an active `take` held by `garry` at weight 0.5).
fn take(page_id: u64, row: i64, claim: &str, extra: Value) -> TakeInput {
    let mut base = json!({
        "page_id": page_id, "row_num": row, "claim": claim, "kind": "take", "holder": "garry",
        "weight": 0.5, "active": true,
    });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    de(base)
}

fn add(b: &Brain, rows: &[TakeInput]) {
    b.add_takes_batch(rows).unwrap();
}

/// The id of the take on `(page_id, row)`.
fn take_id(b: &Brain, page_id: u64, row: i64) -> u64 {
    let rows = b
        .list_takes(&de(
            json!({"page_id": page_id, "active": null, "limit": 100}),
        ))
        .unwrap();
    rows.iter()
        .find(|t| t["row_num"] == row)
        .unwrap_or_else(|| panic!("no take {page_id}#{row}"))["id"]
        .as_u64()
        .unwrap()
}

fn resolve(b: &Brain, page_id: u64, row: i64, by: Option<&str>) {
    let mut resolution = json!({"quality": "correct", "outcome": true});
    if let Some(by) = by {
        resolution["resolved_by"] = json!(by);
    }
    b.resolve_take(&de::<ResolveTakeInput>(
        json!({"page_id": page_id, "row_num": row, "resolution": resolution}),
    ))
    .unwrap();
}

fn pairs(rows: &[Value], a: &str, b: &str) -> Vec<(u64, u64)> {
    rows.iter()
        .map(|r| (r[a].as_u64().unwrap(), r[b].as_u64().unwrap()))
        .collect()
}

#[test]
fn off_grid_weights_are_counted_by_the_sql_grid_rule() {
    let b = brain("takes-reads-grid");
    let a = page(&b, "default", "a");
    let gone = page(&b, "default", "gone");
    assert_eq!(
        b.count_off_grid_take_weights().unwrap(),
        json!({"off_grid": 0, "total": 0})
    );
    // 0.051 and 0.999 sit exactly 0.001 from the grid (not off); 0.0501 is inside it. 0.052 and
    // 0.9989 are just outside; 0.075 rounds half up to 0.1 and 0.1234567 prints as 0.123457.
    let weights = [
        0.05, 0.051, 0.0501, 0.052, 0.1234567, 1.0, 0.5, 0.075, 0.999, 0.9989, 0.0,
    ];
    let rows: Vec<TakeInput> = weights
        .iter()
        .enumerate()
        .map(|(i, w)| take(a, i as i64 + 1, &format!("c{i}"), json!({"weight": w})))
        .collect();
    add(&b, &rows);
    assert_eq!(
        b.count_off_grid_take_weights().unwrap(),
        json!({"off_grid": 4, "total": 11})
    );
    // A take on a soft-deleted page still counts, as the SQL has no page join.
    add(&b, &[take(gone, 1, "gone", json!({"weight": 0.052}))]);
    b.soft_delete_page("gone", Some("default")).unwrap();
    assert_eq!(
        b.count_off_grid_take_weights().unwrap(),
        json!({"off_grid": 5, "total": 12})
    );
}

#[test]
fn takes_are_counted_whatever_their_page() {
    let b = brain("takes-reads-count");
    assert_eq!(b.count_takes().unwrap(), 0);
    let a = page(&b, "default", "a");
    let gone = page(&b, "default", "gone");
    add(
        &b,
        &[
            take(a, 1, "x", json!({})),
            take(a, 2, "y", json!({"active": false})),
            take(gone, 1, "z", json!({})),
        ],
    );
    assert_eq!(b.count_takes().unwrap(), 3);
    b.soft_delete_page("gone", Some("default")).unwrap();
    assert_eq!(b.count_takes().unwrap(), 3);
}

/// `gbrain_fact_fingerprint` of `text`, as a fact carrying it is purged.
fn hash_of(b: &Brain, text: &str) -> String {
    let inserted = b
        .insert_fact(&de::<InsertFactArgs>(json!({
            "input": {"fact": text, "entity_slug": null, "visibility": "world", "source": "chat"},
            "sourceId": "default",
        })))
        .unwrap();
    let target: PurgeTargetArgs =
        de(json!({"id": inserted["id"].as_f64().unwrap(), "sourceId": "default"}));
    b.load_purge_target(&target).unwrap()["fact_hash"]
        .as_str()
        .unwrap()
        .to_string()
}

fn fact_id(b: &Brain, text: &str) -> u64 {
    b.insert_fact(&de::<InsertFactArgs>(json!({
        "input": {"fact": text, "entity_slug": null, "visibility": "world", "source": "chat"},
        "sourceId": "default",
    })))
    .unwrap()["id"]
        .as_u64()
        .unwrap()
}

fn plan(b: &Brain, source: &str, fact_ids: &[u64], hash: &str, subject: &str) -> Vec<(u64, u64)> {
    let input: PurgeTakesInput = de(json!({
        "sourceId": source, "factIds": fact_ids, "factHash": hash, "subject": subject,
    }));
    pairs(&b.plan_fact_purge_takes(&input).unwrap(), "id", "page_id")
}

#[test]
fn a_fact_purge_plans_the_takes_it_consolidated_into_or_echoes() {
    let b = brain("takes-reads-purge");
    source(&b, "other");
    let alice = page(&b, "default", "people/alice");
    let bob = page(&b, "default", "people/bob");
    let carol = page(&b, "other", "people/carol");
    let claim = "Alice moved to Berlin";
    add(
        &b,
        &[
            take(alice, 1, claim, json!({})),
            take(alice, 2, "Unrelated claim", json!({})),
            take(bob, 1, "alice  MOVED to berlin.", json!({})),
            take(carol, 1, claim, json!({})),
        ],
    );
    let hash = hash_of(&b, claim);
    let none = hash_of(&b, "A claim no take makes");
    let (a1, a2, b1, c1) = (
        take_id(&b, alice, 1),
        take_id(&b, alice, 2),
        take_id(&b, bob, 1),
        take_id(&b, carol, 1),
    );
    // The echo on the subject's page only, then on every page of the source.
    assert_eq!(
        plan(&b, "default", &[], &hash, "people/alice"),
        vec![(a1, alice)]
    );
    assert_eq!(
        plan(&b, "default", &[], &hash, "*"),
        vec![(a1, alice), (b1, bob)]
    );
    assert_eq!(plan(&b, "other", &[], &hash, "*"), vec![(c1, carol)]);
    assert_eq!(plan(&b, "default", &[], &hash, "people/nobody"), vec![]);
    assert_eq!(plan(&b, "default", &[], &none, "*"), vec![]);
    // A take a purged fact was consolidated into goes with it, whatever its claim; an unconsolidated
    // fact names none, and a take of another source never does.
    let named = fact_id(&b, "Consolidated fact");
    let loose = fact_id(&b, "Loose fact");
    b.consolidate_fact(named as f64, a2 as f64).unwrap();
    assert_eq!(plan(&b, "default", &[named], &none, "*"), vec![(a2, alice)]);
    assert_eq!(plan(&b, "default", &[loose], &none, "*"), vec![]);
    assert_eq!(plan(&b, "other", &[named], &none, "*"), vec![]);
    assert_eq!(
        plan(&b, "default", &[named], &hash, "people/alice"),
        vec![(a1, alice), (a2, alice)]
    );
}

#[test]
fn a_pages_stored_takes_come_back_by_row() {
    let b = brain("takes-reads-rows");
    let a = page(&b, "default", "a");
    let other = page(&b, "default", "other");
    add(
        &b,
        &[
            take(a, 3, "third", json!({})),
            take(a, 1, "first", json!({"active": false})),
            take(a, 2, "second", json!({})),
            take(other, 1, "elsewhere", json!({})),
        ],
    );
    let rows = b.list_take_rows_for_page(a as i64).unwrap();
    assert_eq!(
        rows,
        vec![
            json!({"row_num": 1, "claim": "first"}),
            json!({"row_num": 2, "claim": "second"}),
            json!({"row_num": 3, "claim": "third"}),
        ]
    );
    assert_eq!(b.list_take_rows_for_page(0).unwrap(), Vec::<Value>::new());
    assert_eq!(b.list_take_rows_for_page(-1).unwrap(), Vec::<Value>::new());
    assert_eq!(
        b.list_take_rows_for_page(9999).unwrap(),
        Vec::<Value>::new()
    );
}

fn mcp(b: &Brain, scope: Value) -> u64 {
    b.count_mcp_resolved_takes(&de::<McpResolvedInput>(scope))
        .unwrap()
}

#[test]
fn mcp_resolved_takes_are_counted_in_the_callers_scope() {
    let b = brain("takes-reads-mcp");
    source(&b, "other");
    let a = page(&b, "default", "a");
    let o = page(&b, "other", "o");
    add(
        &b,
        &[
            take(a, 1, "mcp by garry", json!({})),
            take(a, 2, "mcp by alice", json!({"holder": "alice"})),
            take(a, 3, "human", json!({})),
            take(a, 4, "unresolved", json!({})),
            take(a, 5, "stamp mid-string", json!({})),
            take(a, 6, "capital stamp", json!({})),
            take(o, 1, "mcp elsewhere", json!({})),
        ],
    );
    resolve(&b, a, 1, Some("mcp:client-1"));
    resolve(&b, a, 2, Some("mcp:client-2"));
    resolve(&b, a, 3, Some("human:garry"));
    resolve(&b, a, 5, Some("not-mcp:x"));
    resolve(&b, a, 6, Some("MCP:client"));
    resolve(&b, o, 1, Some("mcp:client-3"));
    assert_eq!(mcp(&b, json!({})), 3);
    assert_eq!(mcp(&b, json!({"sourceIds": ["default"]})), 2);
    assert_eq!(mcp(&b, json!({"sourceIds": ["other"]})), 1);
    assert_eq!(mcp(&b, json!({"sourceIds": ["default", "other"]})), 3);
    assert_eq!(mcp(&b, json!({"sourceIds": ["nowhere"]})), 0);
    assert_eq!(mcp(&b, json!({"sourceIds": []})), 0);
    assert_eq!(mcp(&b, json!({"holders": ["garry"]})), 2);
    assert_eq!(mcp(&b, json!({"holders": ["alice", "garry"]})), 3);
    assert_eq!(mcp(&b, json!({"holders": []})), 0);
    assert_eq!(
        mcp(&b, json!({"sourceIds": ["default"], "holders": ["garry"]})),
        1
    );
}

fn page_with(b: &Brain, source: &str, slug: &str, frontmatter: Value) -> u64 {
    let input: PageInput = de(json!({
        "type": "note", "title": slug, "compiled_truth": "x", "frontmatter": frontmatter,
    }));
    let opts: PutPageOptions = de(json!({"sourceId": source}));
    b.put_page(slug, &input, &opts).unwrap()["id"]
        .as_u64()
        .unwrap()
}

#[test]
fn mcp_resolved_takes_under_exclude_private_skip_the_pages_the_page_policy_hides() {
    let b = brain("takes-reads-mcp-private");
    source(&b, "other");
    let pages = [
        page_with(&b, "default", "open", json!({})),
        page_with(&b, "default", "private", json!({"visibility": "private"})),
        page_with(&b, "default", "readers", json!({"readable_by": ["alice"]})),
        page_with(&b, "default", "alias", json!({"access": "restricted"})),
        page_with(
            &b,
            "default",
            "alias-world",
            json!({"access": "restricted", "visibility": "world"}),
        ),
        page_with(&b, "other", "other-open", json!({})),
        page_with(
            &b,
            "other",
            "other-private",
            json!({"visibility": "private"}),
        ),
    ];
    for (i, p) in pages.iter().enumerate() {
        let holder = if i % 2 == 0 { "garry" } else { "alice" };
        add(&b, &[take(*p, 1, "resolved", json!({"holder": holder}))]);
        resolve(&b, *p, 1, Some("mcp:client"));
    }
    let policy = |honor_aliases: bool, entity_privacy: bool| json!({"honorAliases": honor_aliases, "entityPrivacy": entity_privacy, "ownerOnly": "fn"});
    // No policy counts every page.
    assert_eq!(mcp(&b, json!({})), 7);
    assert_eq!(mcp(&b, json!({"excludePrivate": null})), 7);
    // With aliases honoured: private, readers, alias and other-private are hidden.
    let strict = policy(true, true);
    assert_eq!(mcp(&b, json!({"excludePrivate": strict})), 3);
    assert_eq!(
        mcp(
            &b,
            json!({"excludePrivate": strict, "sourceIds": ["default"]})
        ),
        2
    );
    assert_eq!(
        mcp(
            &b,
            json!({"excludePrivate": strict, "sourceIds": ["other"]})
        ),
        1
    );
    assert_eq!(
        mcp(&b, json!({"excludePrivate": strict, "holders": ["alice"]})),
        1
    );
    assert_eq!(mcp(&b, json!({"excludePrivate": strict, "holders": []})), 0);
    // Without aliases, the `access` key alone no longer hides a page.
    assert_eq!(mcp(&b, json!({"excludePrivate": policy(false, true)})), 4);
    // Without the privacy part (an operator relaxed it) only the readers rule hides a page.
    assert_eq!(mcp(&b, json!({"excludePrivate": policy(true, false)})), 6);
    // A soft-deleted page still counts when the policy lets it through (its row stays in `pages`).
    b.soft_delete_page("open", Some("default")).unwrap();
    assert_eq!(mcp(&b, json!({"excludePrivate": strict})), 3);
}

#[test]
fn take_supersession_candidates_are_live_pages_with_an_inactive_or_superseded_take() {
    let b = brain("takes-reads-supersession");
    source(&b, "other");
    let inactive = page(&b, "default", "inactive");
    let named = page(&b, "default", "named");
    let shouted = page(&b, "default", "shouted");
    let plain = page(&b, "default", "plain");
    let gone = page(&b, "default", "gone");
    let elsewhere = page(&b, "other", "elsewhere");
    let blank = page(&b, "default", "blank");
    add(
        &b,
        &[
            take(inactive, 1, "a", json!({"active": false})),
            take(
                named,
                1,
                "b",
                json!({"source": "meeting; superseded by #2"}),
            ),
            take(shouted, 1, "c", json!({"source": "SUPERSEDED BY #7"})),
            take(plain, 1, "d", json!({"source": "superseded by 2"})),
            take(plain, 2, "e", json!({})),
            take(gone, 1, "f", json!({"active": false})),
            take(elsewhere, 1, "g", json!({"active": false})),
            take(blank, 1, "h", json!({"source": ""})),
        ],
    );
    b.soft_delete_page("gone", Some("default")).unwrap();
    let rows = b
        .list_take_supersession_candidates(&["default".to_string()])
        .unwrap();
    assert_eq!(
        rows,
        vec![
            json!({"id": inactive, "source_id": "default", "slug": "inactive"}),
            json!({"id": named, "source_id": "default", "slug": "named"}),
            json!({"id": shouted, "source_id": "default", "slug": "shouted"}),
        ]
    );
    let both = b
        .list_take_supersession_candidates(&["other".to_string(), "default".to_string()])
        .unwrap();
    assert_eq!(both.len(), 4);
    assert_eq!(both[3]["slug"], "elsewhere");
    assert!(b.list_take_supersession_candidates(&[]).unwrap().is_empty());
    assert!(
        b.list_take_supersession_candidates(&["nowhere".to_string()])
            .unwrap()
            .is_empty()
    );
}

fn weigh(b: &Brain, slug: &str, weight: f64) {
    let rows: Vec<EmotionalWeightRow> =
        de(json!([{"slug": slug, "source_id": "default", "weight": weight}]));
    b.set_emotional_weight_batch(&rows).unwrap();
}

#[test]
fn pages_with_active_takes_and_no_weight_are_counted_beside_the_weighed_ones() {
    let b = brain("takes-reads-salience");
    assert_eq!(
        b.count_zero_weight_with_takes().unwrap(),
        json!({"zero_weight_with_takes": 0, "nonzero_weight": 0})
    );
    let lagging = page(&b, "default", "lagging");
    let twice = page(&b, "default", "twice");
    let weighed = page(&b, "default", "weighed");
    let zeroed = page(&b, "default", "zeroed");
    let retired = page(&b, "default", "retired");
    let _bare = page(&b, "default", "bare");
    add(
        &b,
        &[
            take(lagging, 1, "a", json!({})),
            take(twice, 1, "b", json!({})),
            take(twice, 2, "c", json!({})),
            take(weighed, 1, "d", json!({})),
            take(zeroed, 1, "e", json!({})),
            take(retired, 1, "f", json!({"active": false})),
        ],
    );
    weigh(&b, "weighed", 0.4);
    // Weighed and then set back to zero, so the page keeps a stored weight of 0.
    weigh(&b, "zeroed", 0.3);
    weigh(&b, "zeroed", 0.0);
    // A page counts once however many active takes it has, an inactive take counts for nothing, and
    // a weight written as zero is still no weight.
    assert_eq!(
        b.count_zero_weight_with_takes().unwrap(),
        json!({"zero_weight_with_takes": 3, "nonzero_weight": 1})
    );
    weigh(&b, "lagging", 0.2);
    weigh(&b, "bare", 0.9);
    assert_eq!(
        b.count_zero_weight_with_takes().unwrap(),
        json!({"zero_weight_with_takes": 2, "nonzero_weight": 3})
    );
}

fn code_page(b: &Brain, source: &str, slug: &str, symbol: &str) -> u64 {
    let input: PageInput = de(json!({"type": "code", "title": slug, "compiled_truth": "body"}));
    b.put_page(
        slug,
        &input,
        &de::<PutPageOptions>(json!({"sourceId": source})),
    )
    .unwrap();
    let mut rest = Map::new();
    rest.insert("symbol_name".into(), json!(symbol));
    let chunk = ChunkInput {
        chunk_index: 0,
        chunk_text: format!("fn {symbol}() {{}}"),
        rest,
        ..ChunkInput::default()
    };
    b.upsert_chunks(
        slug,
        &[chunk],
        &UpsertChunksOptions {
            source_id: Some(source.into()),
            seal: true,
            ..UpsertChunksOptions::default()
        },
    )
    .unwrap();
    let rows = b
        .get_chunks(slug, &de(json!({"sourceId": source})))
        .unwrap();
    rows[0]["id"].as_u64().unwrap()
}

fn edge(from: u64, to: Option<u64>, source: &str) -> CodeEdgeInput {
    de(json!({
        "from_chunk_id": from, "to_chunk_id": to, "from_symbol_qualified": "a.run",
        "to_symbol_qualified": "ext.log", "edge_type": "calls", "edge_metadata": {},
        "source_id": source,
    }))
}

#[test]
fn a_source_owns_symbol_edges_only_when_one_of_its_edges_is_unresolved() {
    let b = brain("takes-reads-edges");
    source(&b, "other");
    source(&b, "empty");
    let run = code_page(&b, "default", "a", "run");
    let helper = code_page(&b, "default", "b", "helper");
    let far = code_page(&b, "other", "c", "far");
    let near = code_page(&b, "other", "d", "near");
    assert!(!b.has_code_edges_symbol("default").unwrap());
    // A resolved edge lives in the chunk table, not the symbol table.
    b.add_code_edges(&[edge(far, Some(near), "other")]).unwrap();
    assert!(!b.has_code_edges_symbol("other").unwrap());
    b.add_code_edges(&[
        edge(run, Some(helper), "default"),
        edge(run, None, "default"),
    ])
    .unwrap();
    assert!(b.has_code_edges_symbol("default").unwrap());
    assert!(!b.has_code_edges_symbol("other").unwrap());
    assert!(!b.has_code_edges_symbol("empty").unwrap());
    assert!(!b.has_code_edges_symbol("nowhere").unwrap());
}
