//! The fence guard's two reads of a page's fact rows, matched to PGLite (`engine-sql/facts.ts`
//! `listFenceRetireCandidates`, `engine-sql/trust-fence.ts` `listFenceFactRows`).
//!
//! The context cases pin what the default context cannot reach: a declared writer tier, and the
//! fact ids `gbrain repair open-facts` opens. PGLite reads both as transaction settings; the
//! store takes them as a `FenceContext`.

mod memory_env;

use gbrain_store::error::INVALID_ARGUMENT;
use gbrain_store::facts::{
    ExpireFactArgs, FactRestore, FactSourcePrefix, FenceContext, FenceTarget, InsertFactsArgs,
};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const SLUG: &str = "people/fence-example";
const EXTRACTOR: &str = "cli:extract-conversation-facts:session-1";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn row(n: Option<i32>, fact: &str, extra: Value) -> Value {
    let mut r = json!({
        "fact": fact, "source": "fence", "source_markdown_slug": SLUG, "entity_slug": SLUG,
        "kind": "fact", "visibility": "world", "valid_from": "2026-02-01T01:02:03.250Z",
    });
    if let Some(n) = n {
        r["row_num"] = json!(n);
    }
    for (k, v) in extra.as_object().unwrap() {
        r[k] = v.clone();
    }
    r
}

fn insert(b: &Brain, rows: Value, source_id: &str) -> Vec<u64> {
    let out = b
        .insert_facts(&args::<InsertFactsArgs>(
            json!({ "rows": rows, "sourceId": source_id }),
        ))
        .unwrap();
    out["ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_u64().unwrap())
        .collect()
}

fn target(source: &str, slug: &str, incoming: Value) -> FenceTarget {
    FenceTarget {
        source_id: source.into(),
        slug: slug.into(),
        incoming: incoming.to_string(),
    }
}

fn cell(n: i32, fact: &str, visibility: &str) -> Value {
    json!({ "row_num": n, "fact": fact, "visibility": visibility })
}

fn facts(rows: &[Value]) -> Vec<(i64, &str)> {
    rows.iter()
        .map(|r| (r["row_num"].as_i64().unwrap(), r["fact"].as_str().unwrap()))
        .collect()
}

/// The page of the parity case, inserted out of row order, and the ids by fact.
fn page(b: &Brain) -> Vec<u64> {
    let ids = insert(
        b,
        json!([
            row(
                Some(6),
                "Zeta struck",
                json!({"expired_at": "2026-03-01T04:05:06.500Z", "valid_until": "2026-03-01T04:05:06.500Z"})
            ),
            row(Some(5), "Epsilon extracted", json!({"source": EXTRACTOR})),
            row(Some(4), "Delta extracted", json!({"source": EXTRACTOR})),
            row(
                Some(3),
                "Gamma private",
                json!({"visibility": "private", "kind": "event"})
            ),
            row(Some(2), "Beta", json!({"attributed_to": "user"})),
            row(Some(1), "Alpha", json!({})),
            row(Some(8), "Eta kept", json!({"source": ""})),
            row(None, "Legacy without a row number", json!({})),
            row(
                Some(1),
                "Alpha elsewhere",
                json!({"source_markdown_slug": "people/other-fence"})
            ),
        ]),
        "default",
    );
    assert_eq!(ids.len(), 9);
    // Beta is struck at a fixed time and superseded by Eta Kept: the before-state keeps both.
    assert!(
        b.expire_fact(&args::<ExpireFactArgs>(
            json!({ "id": ids[4], "supersededBy": ids[6], "at": "2026-04-05T06:07:08.125Z" })
        ))
        .unwrap()
    );
    ids
}

fn incoming() -> Value {
    json!([
        cell(1, "Alpha", "world"),
        cell(2, "Beta changed", "world"),
        cell(3, "Gamma private", "world"),
        cell(5, "Epsilon reworded", "world"),
        cell(7, "Theta new", "world"),
    ])
}

#[test]
fn retire_candidates_list_the_rows_the_fence_does_not_hold_with_their_before_state() {
    let b = brain("fence-retire");
    let ids = page(&b);
    let got = b
        .list_fence_retire_candidates(
            &target("default", SLUG, incoming()),
            &FenceContext::default(),
        )
        .unwrap();
    // Row 4 is an extractor row no cell claims, row 7 has no stored row, the legacy row has no number.
    assert_eq!(
        facts(&got),
        vec![
            (2, "Beta"),
            (3, "Gamma private"),
            (5, "Epsilon extracted"),
            (6, "Zeta struck"),
            (8, "Eta kept")
        ]
    );
    assert_eq!(
        got[0],
        json!({
            "id": ids[4], "row_num": 2, "fact": "Beta", "visibility": "world", "kind": "fact",
            "entity_slug": SLUG, "source": "fence",
            "expired_at": "2026-04-05T06:07:08.125+00:00",
            "valid_from": "2026-02-01T01:02:03.25+00:00", "valid_until": null,
            "superseded_by": ids[6], "consolidated_at": null, "consolidated_into": null,
            "attributed_to": "user",
        })
    );
    // The struck row is a candidate, with its times in the jsonb text form.
    assert_eq!(got[3]["expired_at"], "2026-03-01T04:05:06.5+00:00");
    assert_eq!(got[3]["valid_until"], "2026-03-01T04:05:06.5+00:00");
    assert_eq!(got[3]["superseded_by"], Value::Null);
}

#[test]
fn retire_candidates_skip_rows_the_fence_states_as_they_are_and_other_pages() {
    let b = brain("fence-retire-same");
    page(&b);
    let same = json!([
        cell(1, "Alpha", "world"),
        cell(2, "Beta", "world"),
        cell(3, "Gamma private", "private"),
        cell(4, "Delta extracted", "world"),
        cell(5, "Epsilon extracted", "world"),
        cell(6, "Zeta struck", "world"),
        cell(8, "Eta kept", "world"),
    ]);
    let ctx = FenceContext::default();
    let of = |source: &str, slug: &str, incoming: Value| {
        b.list_fence_retire_candidates(&target(source, slug, incoming), &ctx)
            .unwrap()
    };
    assert!(of("default", SLUG, same).is_empty());
    // Row 4 is claimed by number: the extractor row is held to the cell's fact and visibility.
    assert_eq!(
        facts(&of(
            "default",
            SLUG,
            json!([cell(4, "Delta reworded", "world")])
        ))
        .first(),
        Some(&(1, "Alpha"))
    );
    assert_eq!(
        facts(&of("default", SLUG, json!([]))),
        vec![
            (1, "Alpha"),
            (2, "Beta"),
            (3, "Gamma private"),
            (6, "Zeta struck"),
            (8, "Eta kept")
        ]
    );
    assert!(of("elsewhere", SLUG, incoming()).is_empty());
    assert!(of("default", "people/nobody", incoming()).is_empty());
}

#[test]
fn a_cell_with_a_missing_field_equals_nothing() {
    let b = brain("fence-null-cells");
    page(&b);
    let ctx = FenceContext::default();
    let got = b
        .list_fence_retire_candidates(
            &target(
                "default",
                SLUG,
                json!([{ "row_num": 1, "fact": "Alpha" }, { "row_num": 2, "visibility": "world" }]),
            ),
            &ctx,
        )
        .unwrap();
    // Neither cell states a row whole, so Alpha and Beta are both candidates.
    assert_eq!(facts(&got)[..2], [(1, "Alpha"), (2, "Beta")]);
}

#[test]
fn an_incoming_fence_that_is_no_array_of_objects_is_refused() {
    let b = brain("fence-refused");
    page(&b);
    for bad in ["not json", "{}", "[1]", r#"[{"row_num": 1.5}]"#] {
        let t = FenceTarget {
            source_id: "default".into(),
            slug: SLUG.into(),
            incoming: bad.into(),
        };
        let err = b
            .list_fence_retire_candidates(&t, &FenceContext::default())
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT, "{bad}");
        assert_eq!(
            b.list_fence_fact_rows(&t, &FenceContext::default())
                .unwrap_err()
                .code,
            INVALID_ARGUMENT
        );
    }
}

#[test]
fn an_opened_private_row_is_no_retire_candidate() {
    let b = brain("fence-retire-opened");
    let ids = page(&b);
    let gamma = ids[3];
    let ctx = FenceContext {
        writer: None,
        opened: vec![gamma, 999],
    };
    let got = b
        .list_fence_retire_candidates(&target("default", SLUG, incoming()), &ctx)
        .unwrap();
    // Gamma is private, named, and the fence widens it to world: it moves in place and does not retire.
    assert_eq!(
        facts(&got),
        vec![
            (2, "Beta"),
            (5, "Epsilon extracted"),
            (6, "Zeta struck"),
            (8, "Eta kept")
        ]
    );
}

#[test]
fn fence_fact_rows_are_empty_in_the_default_context() {
    let b = brain("fence-rows-default");
    page(&b);
    let ctx = FenceContext::default();
    for incoming in [incoming(), json!([])] {
        assert!(
            b.list_fence_fact_rows(&target("default", SLUG, incoming), &ctx)
                .unwrap()
                .is_empty()
        );
    }
    assert!(
        b.list_fence_fact_rows(&target("elsewhere", SLUG, incoming()), &ctx)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn fence_fact_rows_list_rows_above_the_writer_live_and_by_row_number() {
    let b = brain("fence-rows-above");
    let ids = page(&b);
    // An external writer (rank 1) is below every stored row (`unknown`, rank 2).
    let ctx = FenceContext {
        writer: Some("external_untrusted".into()),
        opened: vec![],
    };
    let got = b
        .list_fence_fact_rows(&target("default", SLUG, incoming()), &ctx)
        .unwrap();
    // Beta (2) and Zeta (6) are struck, so not live; the extractor row 4 is nobody's claim, row 1 is
    // stated as it is, and the legacy row has no number.
    assert_eq!(
        facts(&got),
        vec![
            (3, "Gamma private"),
            (5, "Epsilon extracted"),
            (8, "Eta kept")
        ]
    );
    assert_eq!(
        got[2],
        json!({ "id": ids[6], "row_num": 8, "fact": "Eta kept", "visibility": "world",
                "trust_tier": "unknown", "above": true, "opened": false })
    );
    // A writer at the stored tier or above lists none; a name that is no tier ranks 0 and is below every row.
    for writer in ["", "unknown", "agent_written", "user_confirmed"] {
        let ctx = FenceContext {
            writer: Some(writer.into()),
            opened: vec![],
        };
        assert!(
            b.list_fence_fact_rows(&target("default", SLUG, incoming()), &ctx)
                .unwrap()
                .is_empty(),
            "{writer}"
        );
    }
    let ctx = FenceContext {
        writer: Some("nobody".into()),
        opened: vec![],
    };
    assert_eq!(
        b.list_fence_fact_rows(&target("default", SLUG, incoming()), &ctx)
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn fence_fact_rows_list_an_opened_row_even_for_a_trusted_writer() {
    let b = brain("fence-rows-opened");
    let ids = page(&b);
    let gamma = ids[3];
    let ctx = FenceContext {
        writer: Some("operator_curated".into()),
        opened: vec![gamma],
    };
    let got = b
        .list_fence_fact_rows(&target("default", SLUG, incoming()), &ctx)
        .unwrap();
    assert_eq!(
        got,
        vec![
            json!({ "id": gamma, "row_num": 3, "fact": "Gamma private", "visibility": "private",
                     "trust_tier": "unknown", "above": false, "opened": true })
        ]
    );
    // An opened row the fence does not widen (the cell keeps it private, or is for another fact) is not opened.
    let kept = json!([cell(3, "Gamma private", "private")]);
    assert!(
        b.list_fence_fact_rows(&target("default", SLUG, kept), &ctx)
            .unwrap()
            .is_empty()
    );
    let other = json!([cell(3, "Gamma other", "world")]);
    assert!(
        b.list_fence_fact_rows(&target("default", SLUG, other), &ctx)
            .unwrap()
            .is_empty()
    );
    // A world row is never opened.
    let ctx = FenceContext {
        writer: None,
        opened: vec![ids[6]],
    };
    assert!(
        b.list_fence_fact_rows(&target("default", SLUG, incoming()), &ctx)
            .unwrap()
            .is_empty()
    );
}

/// The fence reads with the context taken from the store's write trust settings (`write_trust.rs`),
/// set as the engine's transaction would set `gbrain.write_trust_tier` and `gbrain.write_open_facts`.
#[test]
fn the_write_trust_settings_reach_both_fence_reads_and_clear_with_the_context() {
    let b = brain("fence-write-trust");
    let ids = page(&b);
    let gamma = ids[3];
    let names = |items: &[&str]| items.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
    // The opened list holds a foreign id, a non-canonical piece and Gamma, as `withOpenFacts` may write it.
    b.apply_write_trust(
        &names(&["gbrain.write_trust_tier", "gbrain.write_open_facts"]),
        &names(&["agent_written", &format!("999,0{gamma},{gamma}")]),
    )
    .unwrap();
    let rows = b
        .list_fence_fact_rows(&target("default", SLUG, incoming()), &b.fence_context())
        .unwrap();
    assert_eq!(
        rows,
        vec![
            json!({ "id": gamma, "row_num": 3, "fact": "Gamma private", "visibility": "private",
                     "trust_tier": "unknown", "above": false, "opened": true })
        ]
    );
    let retired = b
        .list_fence_retire_candidates(&target("default", SLUG, incoming()), &b.fence_context())
        .unwrap();
    assert_eq!(
        facts(&retired),
        vec![
            (2, "Beta"),
            (5, "Epsilon extracted"),
            (6, "Zeta struck"),
            (8, "Eta kept")
        ]
    );
    // A writer below `unknown` lists every live unknown row the fence does not hold as above it
    // (Beta is struck, so it is not live).
    b.apply_write_trust(
        &names(&["gbrain.write_trust_tier"]),
        &names(&["external_untrusted"]),
    )
    .unwrap();
    let rows = b
        .list_fence_fact_rows(&target("default", SLUG, incoming()), &b.fence_context())
        .unwrap();
    assert_eq!(
        facts(&rows),
        vec![
            (3, "Gamma private"),
            (5, "Epsilon extracted"),
            (8, "Eta kept")
        ]
    );
    // The end of the transaction ends the context: the default context again.
    b.clear_write_trust();
    assert!(
        b.list_fence_fact_rows(&target("default", SLUG, incoming()), &b.fence_context())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        b.list_fence_retire_candidates(&target("default", SLUG, incoming()), &b.fence_context())
            .unwrap()
            .len(),
        5
    );
}

#[test]
fn fact_preimages_read_the_source_rows_by_id_once_in_id_order() {
    let b = brain("fact-preimages");
    let ids = page(&b);
    let id = |n: usize| i64::try_from(ids[n]).unwrap();
    let asked = [id(4), id(0), id(4), -1, i64::MAX];
    let rows = b.read_fact_preimages("default", &asked).unwrap();
    let got: Vec<(u64, &str)> = rows
        .iter()
        .map(|r| (r["id"].as_u64().unwrap(), r["fact"].as_str().unwrap()))
        .collect();
    assert_eq!(got, vec![(ids[0], "Zeta struck"), (ids[4], "Beta")]);
    // Beta's before-state keeps its strike and its successor, as `FACT_PREIMAGE_SQL` does.
    assert_eq!(
        rows[1]["expired_at"],
        json!("2026-04-05T06:07:08.125+00:00")
    );
    assert_eq!(rows[1]["superseded_by"], json!(ids[6]));
    assert_eq!(rows[1]["attributed_to"], json!("user"));
    assert!(b.read_fact_preimages("default", &[]).unwrap().is_empty());
    assert!(b.read_fact_preimages("missing", &asked).unwrap().is_empty());
}

#[test]
fn fact_restore_puts_a_before_state_back_on_the_same_claim_only() {
    let b = brain("fact-restore");
    let ids = page(&b);
    let restore = |source: &str, v: Value| b.restore_fact_preimage(source, &args::<FactRestore>(v));
    let beta = |extra: Value| {
        let mut v = json!({"id": ids[4], "fact": "Beta", "visibility": "world", "row_num": 2});
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    };
    // Another claim, visibility or source, or a missing id, changes nothing.
    assert!(!restore("default", beta(json!({"fact": "Beta changed"}))).unwrap());
    assert!(!restore("default", beta(json!({"visibility": "private"}))).unwrap());
    assert!(!restore("other", beta(json!({}))).unwrap());
    assert!(!restore("default", beta(json!({"id": 1u64 << 40}))).unwrap());
    // A successor that does not exist is the foreign key refusal Postgres gives.
    let err = restore("default", beta(json!({"superseded_by": 1u64 << 40}))).unwrap_err();
    assert!(
        err.to_string().contains("facts_superseded_by_fkey"),
        "{err}"
    );
    // The restore clears the strike and the successor, and keeps its fence number.
    assert!(restore("default", beta(json!({}))).unwrap());
    let back = b
        .read_fact_preimages("default", &[i64::try_from(ids[4]).unwrap()])
        .unwrap();
    assert_eq!(back[0]["expired_at"], Value::Null);
    assert_eq!(back[0]["superseded_by"], Value::Null);
    assert_eq!(back[0]["row_num"], json!(2));
    // Alpha moves to a free fence number only: 2 is Beta's, 9 is free.
    let alpha = |n: i32| {
        json!({"id": ids[5], "fact": "Alpha", "visibility": "world", "row_num": n,
        "valid_until": "2026-05-01T10:00:00.5+02:00"})
    };
    assert!(restore("default", alpha(2)).unwrap());
    let a = b
        .read_fact_preimages("default", &[i64::try_from(ids[5]).unwrap()])
        .unwrap();
    assert_eq!(a[0]["row_num"], json!(1));
    assert_eq!(a[0]["valid_until"], json!("2026-05-01T08:00:00.5+00:00"));
    assert!(restore("default", alpha(9)).unwrap());
    let a = b
        .read_fact_preimages("default", &[i64::try_from(ids[5]).unwrap()])
        .unwrap();
    assert_eq!(a[0]["row_num"], json!(9));
}

fn by_prefix(source: &str, slug: &str, prefix: &str) -> FactSourcePrefix {
    FactSourcePrefix {
        source_id: source.into(),
        slug: slug.into(),
        source_prefix: prefix.into(),
    }
}

#[test]
fn fact_ids_by_source_prefix_list_the_page_rows_whose_source_starts_so_by_id() {
    let b = brain("fence-source-prefix");
    let ids = page(&b);
    let list = |source: &str, slug: &str, prefix: &str| {
        b.list_fact_ids_by_source_prefix(&by_prefix(source, slug, prefix))
            .unwrap()
    };
    // Live and struck rows alike; the other page's row is not listed.
    assert_eq!(
        list("default", SLUG, "cli:extract-conversation-facts"),
        vec![ids[1], ids[2]]
    );
    assert_eq!(
        list("default", SLUG, "fence"),
        vec![ids[0], ids[3], ids[4], ids[5], ids[7]]
    );
    // An empty prefix is every row of the page, the empty source included.
    assert_eq!(list("default", SLUG, ""), ids[..8].to_vec());
    assert!(list("other", SLUG, "").is_empty());
    assert!(list("default", "people/missing", "").is_empty());
    let err = b
        .list_fact_ids_by_source_prefix(&by_prefix("default", SLUG, "a\0b"))
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT, "{err}");
}

#[test]
fn expire_fact_rows_ends_only_the_live_rows_of_the_source() {
    let b = brain("fence-expire-rows");
    let ids = page(&b);
    let id = |i: usize| i64::try_from(ids[i]).unwrap();
    let expired =
        |i: usize| b.read_fact_preimages("default", &[id(i)]).unwrap()[0]["expired_at"].clone();
    assert_eq!(b.expire_fact_rows("other", &[id(1)]).unwrap(), 0);
    assert_eq!(expired(1), Value::Null);
    assert_eq!(b.expire_fact_rows("default", &[]).unwrap(), 0);
    // A repeated id, a struck row, a negative id and a missing id end nothing more.
    let before = expired(0);
    assert_eq!(
        b.expire_fact_rows("default", &[id(1), id(1), id(0), -1, 1 << 40])
            .unwrap(),
        1
    );
    assert_ne!(expired(1), Value::Null);
    assert_eq!(expired(0), before);
    assert_eq!(expired(2), Value::Null);
}
