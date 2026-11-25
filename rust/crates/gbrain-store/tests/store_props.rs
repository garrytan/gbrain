//! Property tests for the store's durable round trips on the redb record file.
//!
//! Three promises, each checked against many generated inputs instead of hand-picked ones:
//!
//! 1. A page written with `put_page` reads back, field for field, exactly as it was given, both
//!    from the open store and after the store is closed and opened again from disk.
//! 2. A page (or a fact) that is deleted leaves nothing a live read can find. A hard delete
//!    leaves no row at all; a soft delete only hides the page from live reads.
//! 3. A withdrawn claim stays withdrawn after the store is reopened: the fact that was withdrawn
//!    is still expired, and the same claim written again later (even with different capital
//!    letters, spacing or a closing full stop) is saved already expired. A different claim is not.
//!
//! Every case opens a real store directory, so each one costs real disk syncs. The case counts
//! are small on purpose to keep the whole file well under a minute on a CI runner. Failure
//! persistence is off and the generator seed is proptest's default, so a failing case prints its
//! minimal input and leaves no file behind.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::facts::purge::WithdrawalExpiry;
use gbrain_store::facts::{
    ExpireFactArgs, FactQuery, InsertFactArgs, InsertFactsArgs, NewFactInput, PageDeleteArgs,
};
use gbrain_store::pages::{PageFilters, PageInput, PutPageOptions, ReadScope, VersionsOptions};
use proptest::prelude::*;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// Case counts: page round trips and deletes open one store per case; the withdrawal property
/// opens two (before and after the reopen) and writes a few facts.
const PAGE_CASES: u32 = 64;
const DELETE_CASES: u32 = 64;
const WITHDRAWAL_CASES: u32 = 64;

fn config(cases: u32) -> ProptestConfig {
    ProptestConfig {
        cases,
        failure_persistence: None,
        ..ProptestConfig::default()
    }
}

// ---------------------------------------------------------------------------------------------
// Generators.

/// One building block of generated text. It mixes plain letters with the shapes that tend to
/// break text storage: accented letters written both as one character and as a letter plus a
/// combining mark, emoji (including joined families and flags), right-to-left script, byte-order
/// marks, zero-width joiners, runs of unusual whitespace, and any other Unicode character. A NUL
/// byte is left out because the store strips it by design.
fn text_piece() -> BoxedStrategy<String> {
    let fixed: Vec<&'static str> = vec![
        "\u{e9}",
        "e\u{301}",
        "n\u{303}\u{323}",
        "\u{65e5}\u{672c}\u{8a9e}",
        "\u{41f}\u{440}\u{438}\u{432}\u{435}\u{442}",
        "\u{645}\u{631}\u{62d}\u{628}\u{627}",
        "\u{1f600}",
        "\u{1f469}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466}",
        "\u{1f1fa}\u{1f1f8}",
        "\u{200d}",
        "\u{feff}",
        "\u{130}",
        "\u{df}",
        "line one\r\nline two\n",
        "  trailing spaces  ",
        "# heading\n\n- item\n",
        "\"quoted\" and \\backslash\\",
    ];
    prop_oneof![
        4 => prop::collection::vec(prop::char::range('a', 'z'), 1..8)
            .prop_map(|chars| chars.into_iter().collect::<String>()),
        3 => prop::sample::select(fixed).prop_map(str::to_string),
        2 => prop::collection::vec(
            prop::sample::select(vec![
                ' ', '\t', '\n', '\r', '\u{a0}', '\u{2003}', '\u{2028}', '\u{3000}',
            ]),
            1..6,
        )
        .prop_map(|chars| chars.into_iter().collect::<String>()),
        1 => any::<char>().prop_filter("no NUL", |c| *c != '\0').prop_map(|c| c.to_string()),
    ]
    .boxed()
}

/// Text of up to `max_pieces` building blocks, possibly empty.
fn text(max_pieces: usize) -> BoxedStrategy<String> {
    prop::collection::vec(text_piece(), 0..=max_pieces)
        .prop_map(|pieces| pieces.concat())
        .boxed()
}

/// A valid page slug: one to three `/`-separated segments of lower-case letters, digits, `-`,
/// `_` and a few non-ASCII lower-case letters. A segment never starts with a dot, so `..` and
/// hidden-path shapes cannot appear.
fn slug() -> BoxedStrategy<String> {
    let segment = prop::collection::vec(
        prop::sample::select(vec![
            "a", "b", "c", "x", "y", "z", "0", "7", "-", "_", "\u{e9}", "\u{fc}", "\u{65e5}",
        ]),
        1..6,
    )
    .prop_map(|parts| parts.concat());
    prop::collection::vec(segment, 1..=3)
        .prop_map(|segments| segments.join("/"))
        .boxed()
}

/// A small arbitrary JSON value: scalars, and arrays or objects nested a couple of levels deep.
/// Numbers are whole numbers, because the page's JSON column normalises fractions on purpose.
fn json_value() -> BoxedStrategy<Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        (-100_000i64..100_000).prop_map(|n| json!(n)),
        text(3).prop_map(Value::String),
    ];
    leaf.prop_recursive(2, 12, 3, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..3).prop_map(Value::Array),
            prop::collection::btree_map(text(2), inner, 0..3)
                .prop_map(|m| Value::Object(m.into_iter().collect())),
        ]
    })
    .boxed()
}

/// What a caller hands to `put_page` for one page.
#[derive(Debug, Clone)]
struct PageSpec {
    slug: String,
    page_type: String,
    title: String,
    body: String,
    timeline: String,
    frontmatter: Map<String, Value>,
}

impl PageSpec {
    fn input(&self) -> PageInput {
        PageInput {
            page_type: self.page_type.clone(),
            title: self.title.clone(),
            compiled_truth: self.body.clone(),
            timeline: Some(self.timeline.clone()),
            frontmatter: Some(self.frontmatter.clone()),
            ..PageInput::default()
        }
    }
}

fn page_spec() -> BoxedStrategy<PageSpec> {
    (
        slug(),
        prop::sample::select(vec!["note", "person", "company", "concept"]),
        text(6),
        // A non-blank body: the store refuses to overwrite a page with an empty one, and a
        // first write of an empty page is not the interesting case here.
        text(10).prop_map(|body| format!("body {body}")),
        text(4),
        prop::collection::btree_map(
            // Keys that name no special frontmatter field (such as `tags` or `type`).
            text(2).prop_map(|k| format!("k {k}")),
            json_value(),
            0..4,
        ),
    )
        .prop_map(
            |(slug, page_type, title, body, timeline, frontmatter)| PageSpec {
                slug,
                page_type: page_type.to_string(),
                title,
                body,
                timeline,
                frontmatter: frontmatter.into_iter().collect(),
            },
        )
        .boxed()
}

/// Up to four pages with different slugs (a later page with the same slug would overwrite an
/// earlier one, which is a different property).
fn page_set() -> BoxedStrategy<Vec<PageSpec>> {
    prop::collection::vec(page_spec(), 1..=4)
        .prop_map(|specs| {
            let mut by_slug = BTreeMap::new();
            for spec in specs {
                by_slug.entry(spec.slug.clone()).or_insert(spec);
            }
            by_slug.into_values().collect()
        })
        .boxed()
}

// ---------------------------------------------------------------------------------------------
// Helpers.

fn put(store: &Store, spec: &PageSpec) -> Value {
    store
        .put_page(&spec.slug, &spec.input(), &PutPageOptions::default())
        .unwrap()
}

fn read(store: &Store, slug: &str, include_deleted: bool) -> Option<Value> {
    let scope = ReadScope {
        include_deleted,
        ..ReadScope::default()
    };
    store.read_page_snapshot(slug, &scope).unwrap()
}

fn list_slugs(store: &Store, include_deleted: bool) -> Vec<String> {
    let filters = PageFilters {
        include_deleted,
        limit: Some(1000),
        sort: Some("slug".into()),
        ..PageFilters::default()
    };
    store
        .list_pages(&filters)
        .unwrap()
        .iter()
        .map(|p| p["slug"].as_str().unwrap().to_string())
        .collect()
}

/// Checks every field the caller gave against the page the store returned.
fn check_page(page: &Value, spec: &PageSpec) -> Result<(), TestCaseError> {
    prop_assert_eq!(page["slug"].as_str(), Some(spec.slug.as_str()));
    prop_assert_eq!(page["type"].as_str(), Some(spec.page_type.as_str()));
    prop_assert_eq!(page["title"].as_str(), Some(spec.title.as_str()));
    prop_assert_eq!(page["compiled_truth"].as_str(), Some(spec.body.as_str()));
    prop_assert_eq!(page["timeline"].as_str(), Some(spec.timeline.as_str()));
    prop_assert_eq!(
        &page["frontmatter"],
        &Value::Object(spec.frontmatter.clone())
    );
    Ok(())
}

fn fact_row(claim: &str, entity: &str, visibility: &str, page: Option<&str>) -> NewFactInput {
    NewFactInput {
        fact: Some(claim.to_string()),
        entity_slug: Some(entity.to_string()),
        visibility: Some(visibility.to_string()),
        source: Some("props".to_string()),
        source_markdown_slug: page.map(str::to_string),
        ..NewFactInput::default()
    }
}

/// Saves one fact with `insert_fact` and returns its id.
fn insert_fact(store: &Store, claim: &str, entity: &str, visibility: &str) -> u64 {
    let args = InsertFactArgs {
        input: fact_row(claim, entity, visibility, None),
        source_id: "default".to_string(),
        supersede_id: None,
    };
    store.insert_fact(&args).unwrap()["id"].as_u64().unwrap()
}

/// Saves one fact tied to the page `slug` (only the batch write records the page) and returns
/// its id.
fn insert_page_fact(store: &Store, claim: &str, slug: &str) -> u64 {
    let args = InsertFactsArgs {
        rows: vec![fact_row(claim, slug, "world", Some(slug))],
        source_id: "default".to_string(),
        delete_for_page_first: None,
    };
    let out = store.insert_facts(&args).unwrap();
    out["ids"][0].as_u64().unwrap()
}

/// Every fact row about `entity`, expired ones included unless `active_only`.
fn facts_of(store: &Store, entity: &str, active_only: bool) -> Vec<Value> {
    let query = FactQuery {
        source_id: "default".to_string(),
        entity_slug: Some(entity.to_string()),
        active_only,
        limit: 100.0,
        ..FactQuery::default()
    };
    store.list_facts_by_entity(&query).unwrap()
}

fn row_with(rows: &[Value], id: u64) -> Option<&Value> {
    rows.iter().find(|r| r["id"].as_u64() == Some(id))
}

// ---------------------------------------------------------------------------------------------
// Property 1: put then get gives back what was put.

proptest! {
    #![proptest_config(config(PAGE_CASES))]

    #[test]
    fn a_written_page_reads_back_exactly_as_given(specs in page_set()) {
        let dir = TempDir::new("props-roundtrip");
        let store = open(&dir);
        for spec in &specs {
            let stored = put(&store, spec);
            // What `put_page` echoes is what the caller gave.
            check_page(&stored, spec)?;
        }
        let reads = |store: &Store| -> Result<(), TestCaseError> {
            for spec in &specs {
                let snapshot = read(store, &spec.slug, false);
                prop_assert!(snapshot.is_some(), "page {:?} is missing", spec.slug);
                check_page(&snapshot.unwrap()["page"], spec)?;
            }
            // The list read sees the same pages, one row per slug.
            let mut expected: Vec<String> = specs.iter().map(|s| s.slug.clone()).collect();
            expected.sort();
            prop_assert_eq!(list_slugs(store, false), expected);
            for page in store
                .list_pages(&PageFilters { limit: Some(1000), ..PageFilters::default() })
                .unwrap()
            {
                let spec = specs.iter().find(|s| page["slug"] == s.slug.as_str()).unwrap();
                check_page(&page, spec)?;
            }
            Ok(())
        };
        reads(&store)?;
        // The same reads from disk, through a fresh open.
        drop(store);
        let store = open(&dir);
        reads(&store)?;
    }
}

// ---------------------------------------------------------------------------------------------
// Property 2: a write followed by a delete leaves no row.

/// What happens to one page after it is written.
#[derive(Debug, Clone, Copy)]
enum Fate {
    Keep,
    SoftDelete,
    HardDelete,
    SoftThenHardDelete,
}

fn fate() -> BoxedStrategy<Fate> {
    prop::sample::select(vec![
        Fate::Keep,
        Fate::SoftDelete,
        Fate::HardDelete,
        Fate::SoftThenHardDelete,
    ])
    .boxed()
}

/// What happens to the fact attached to a page.
#[derive(Debug, Clone, Copy)]
enum FactFate {
    Keep,
    Expire,
    DeleteWithPage,
}

fn fact_fate() -> BoxedStrategy<FactFate> {
    prop::sample::select(vec![
        FactFate::Keep,
        FactFate::Expire,
        FactFate::DeleteWithPage,
    ])
    .boxed()
}

/// Checks the fact attached to a page after its fate. A kept fact must still be live when
/// `kept_is_live` (its page is live too); an expired fact must be out of live reads; a deleted
/// fact must have no row at all.
fn check_fact(
    store: &Store,
    entity: &str,
    id: u64,
    fate: FactFate,
    kept_is_live: bool,
) -> Result<(), TestCaseError> {
    let rows = facts_of(store, entity, false);
    let active = facts_of(store, entity, true);
    match fate {
        FactFate::Keep => {
            if kept_is_live {
                prop_assert!(row_with(&active, id).is_some(), "kept fact is gone");
            }
        }
        FactFate::Expire => {
            // The row stays as history, marked expired, and no live read returns it.
            prop_assert!(row_with(&active, id).is_none(), "expired fact is live");
            if let Some(row) = row_with(&rows, id) {
                prop_assert!(row["expired_at"].is_string());
            }
        }
        FactFate::DeleteWithPage => {
            prop_assert!(
                row_with(&rows, id).is_none(),
                "deleted fact still has a row"
            );
            prop_assert!(row_with(&active, id).is_none());
        }
    }
    Ok(())
}

proptest! {
    #![proptest_config(config(DELETE_CASES))]

    #[test]
    fn a_deleted_page_or_fact_leaves_nothing_a_live_read_finds(
        specs in page_set(),
        fates in prop::collection::vec((fate(), fact_fate()), 4),
        claim in text(4).prop_map(|c| format!("claim {c}")),
    ) {
        let dir = TempDir::new("props-delete");
        let store = open(&dir);
        let mut fact_ids = Vec::new();
        for spec in &specs {
            put(&store, spec);
            // One fact per page, tied to the page by its slug.
            fact_ids.push(insert_page_fact(&store, &claim, &spec.slug));
        }
        let plan: Vec<(Fate, FactFate)> = fates.into_iter().take(specs.len()).collect();

        for (i, (spec, (fate, fact_fate))) in specs.iter().zip(&plan).enumerate() {
            // The fact goes first, while its page is still live, so a hidden page cannot mask it.
            let id = fact_ids[i];
            match fact_fate {
                FactFate::Keep => {}
                FactFate::Expire => {
                    let expired = store
                        .expire_fact(&ExpireFactArgs { id: id as f64, ..ExpireFactArgs::default() })
                        .unwrap();
                    prop_assert!(expired);
                }
                FactFate::DeleteWithPage => {
                    let deleted = store
                        .delete_facts_for_page(&PageDeleteArgs {
                            slug: spec.slug.clone(),
                            source_id: "default".to_string(),
                            ..PageDeleteArgs::default()
                        })
                        .unwrap();
                    prop_assert_eq!(deleted, 1);
                }
            }
            check_fact(&store, &spec.slug, id, *fact_fate, true)?;
            match fate {
                Fate::Keep => {}
                Fate::SoftDelete => {
                    let hidden = store.soft_delete_page(&spec.slug, None).unwrap();
                    prop_assert_eq!(hidden.as_deref(), Some(spec.slug.as_str()));
                }
                Fate::HardDelete => store.delete_page(&spec.slug, None).unwrap(),
                Fate::SoftThenHardDelete => {
                    store.soft_delete_page(&spec.slug, None).unwrap();
                    store.delete_page(&spec.slug, None).unwrap();
                }
            }
        }

        // Check the same things on the open store and again after a reopen.
        let checks = |store: &Store| -> Result<(), TestCaseError> {
            let mut live = Vec::new();
            for (i, (spec, (fate, fact_fate))) in specs.iter().zip(&plan).enumerate() {
                let slug = spec.slug.as_str();
                match fate {
                    Fate::Keep => {
                        live.push(slug.to_string());
                        let snapshot = read(store, slug, false);
                        prop_assert!(snapshot.is_some(), "kept page {slug:?} vanished");
                        check_page(&snapshot.unwrap()["page"], spec)?;
                    }
                    Fate::SoftDelete => {
                        // Hidden from live reads, still there for a read that asks for it.
                        prop_assert!(read(store, slug, false).is_none());
                        let kept = read(store, slug, true);
                        prop_assert!(kept.is_some(), "soft-deleted page {slug:?} lost its row");
                        let kept = kept.unwrap();
                        prop_assert!(kept["page"]["deleted_at"].is_string());
                        check_page(&kept["page"], spec)?;
                        prop_assert!(!list_slugs(store, false).contains(&spec.slug));
                        prop_assert!(list_slugs(store, true).contains(&spec.slug));
                    }
                    Fate::HardDelete | Fate::SoftThenHardDelete => {
                        // No row at all, even for a read that asks for deleted pages.
                        prop_assert!(read(store, slug, false).is_none());
                        prop_assert!(read(store, slug, true).is_none());
                        prop_assert!(!list_slugs(store, true).contains(&spec.slug));
                        prop_assert!(store
                            .get_versions(slug, &VersionsOptions::default())
                            .unwrap()
                            .is_empty());
                    }
                }
                // A fact that was expired or deleted stays out of live reads whatever became of
                // its page. A kept fact is only asserted while its page is live.
                check_fact(store, slug, fact_ids[i], *fact_fate, matches!(fate, Fate::Keep))?;
            }
            let mut expected: Vec<String> = live;
            expected.extend(
                specs
                    .iter()
                    .zip(&plan)
                    .filter(|(_, (fate, _))| matches!(fate, Fate::SoftDelete))
                    .map(|(s, _)| s.slug.clone()),
            );
            expected.sort();
            // Everything that still has a row, soft-deleted pages included, and nothing else.
            prop_assert_eq!(list_slugs(store, true), expected);
            Ok(())
        };
        checks(&store)?;
        drop(store);
        let store = open(&dir);
        checks(&store)?;
    }
}

// ---------------------------------------------------------------------------------------------
// Property 3: a withdrawn claim stays withdrawn after a reopen.

/// A claim made of lower-case words (plain and non-ASCII letters). Upper-casing it with ASCII
/// rules never changes what the store treats as the same claim, so the variants below are always
/// the same claim to the fingerprint.
fn claim_words() -> BoxedStrategy<Vec<String>> {
    let word = prop::collection::vec(
        prop::sample::select(vec![
            "a", "b", "c", "d", "e", "i", "l", "k", "s", "t", "\u{e9}", "\u{fc}", "\u{f1}",
            "\u{65e5}", "\u{436}",
        ]),
        1..6,
    )
    .prop_map(|parts| parts.concat());
    prop::collection::vec(word, 1..5).boxed()
}

/// The claim written the way a person might: capitals, uneven gaps made of spaces, tabs and
/// newlines, space around it, and optionally a closing full stop.
fn variant(words: &[String], capitals: bool, gaps: &[usize], pad: usize, stop: bool) -> String {
    const GAPS: [&str; 5] = [" ", "  ", "\t", " \n ", "   "];
    let mut out = " ".repeat(pad);
    for (i, word) in words.iter().enumerate() {
        if i > 0 {
            out.push_str(GAPS[gaps[i % gaps.len()] % GAPS.len()]);
        }
        out.push_str(&if capitals {
            word.to_ascii_uppercase()
        } else {
            word.clone()
        });
    }
    if stop {
        out.push('.');
    }
    out.push_str(&" ".repeat(pad));
    out
}

proptest! {
    #![proptest_config(config(WITHDRAWAL_CASES))]

    #[test]
    fn a_withdrawn_claim_stays_withdrawn_after_reopen(
        words in claim_words(),
        visibility in prop::sample::select(vec!["private", "world"]),
        subject_is_everyone in any::<bool>(),
        gaps in prop::collection::vec(0usize..5, 1..4),
        pad in 0usize..3,
        capitals in any::<bool>(),
        stop in any::<bool>(),
        other_word in prop::sample::select(vec!["zzz", "qqq", "\u{4e16}\u{754c}"]),
    ) {
        const ENTITY: &str = "people/alice";
        let subject = if subject_is_everyone { "*" } else { ENTITY };
        let claim = words.join(" ");
        let other = format!("{claim} {other_word}");
        let again = variant(&words, capitals, &gaps, pad, stop);

        let dir = TempDir::new("props-withdrawal");
        let store = open(&dir);
        let withdrawn_id = insert_fact(&store, &claim, ENTITY, visibility);
        let other_id = insert_fact(&store, &other, ENTITY, visibility);

        // Withdraw the first claim: record the withdrawal, then expire the rows it covers.
        prop_assert!(store
            .insert_fact_withdrawal("default", visibility, &claim, subject, None)
            .unwrap());
        let expired = store
            .expire_facts_by_withdrawal(&WithdrawalExpiry {
                source_id: "default".to_string(),
                visibility: visibility.to_string(),
                fact: claim.clone(),
                subject: subject.to_string(),
            })
            .unwrap();
        prop_assert_eq!(expired, vec![json!({ "id": withdrawn_id })]);
        let before = facts_of(&store, ENTITY, false);
        let withdrawn_row = row_with(&before, withdrawn_id).cloned().unwrap();
        prop_assert!(withdrawn_row["expired_at"].is_string());

        // Close the store and open the directory again.
        drop(store);
        let store = open(&dir);

        // The withdrawn fact is the same row, still expired, and still out of live reads. The
        // other claim is untouched.
        let after = facts_of(&store, ENTITY, false);
        prop_assert_eq!(row_with(&after, withdrawn_id), Some(&withdrawn_row));
        let live = facts_of(&store, ENTITY, true);
        prop_assert!(row_with(&live, withdrawn_id).is_none());
        prop_assert!(row_with(&live, other_id).is_some());
        let other_row = row_with(&after, other_id).unwrap();
        prop_assert!(other_row["expired_at"].is_null());

        // The ledger still answers for the claim, in every spelling that shares its fingerprint.
        for text in [&claim, &again] {
            prop_assert!(
                store
                    .is_fact_withdrawn("default", Some(visibility), text, Some(ENTITY), None)
                    .unwrap(),
                "claim {text:?} is no longer withdrawn"
            );
        }
        prop_assert!(!store
            .is_fact_withdrawn("default", Some(visibility), &other, Some(ENTITY), None)
            .unwrap());

        // Writing the same claim again, in any spelling, is saved already expired.
        let reborn_exact = insert_fact(&store, &claim, ENTITY, visibility);
        let reborn_variant = insert_fact(&store, &again, ENTITY, visibility);
        // A different claim is not fenced: it is saved live.
        let fresh = format!("{claim} and also {other_word}");
        let fresh_id = insert_fact(&store, &fresh, ENTITY, visibility);
        let rows = facts_of(&store, ENTITY, false);
        let live = facts_of(&store, ENTITY, true);
        for id in [reborn_exact, reborn_variant] {
            let row = row_with(&rows, id).unwrap();
            prop_assert!(row["expired_at"].is_string(), "re-written claim {row:?} is live");
            prop_assert!(row_with(&live, id).is_none());
        }
        prop_assert!(row_with(&live, fresh_id).is_some(), "a new claim was fenced");
        prop_assert!(row_with(&live, other_id).is_some());
    }
}
