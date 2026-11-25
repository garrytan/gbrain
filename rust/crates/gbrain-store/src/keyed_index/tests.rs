//! The keyed lookups stay equal to what the records derive after every kind of write, and every
//! member that reads them answers exactly as the whole-store scan it replaced (`FULL_SCAN`).

use super::*;
use crate::Store;
use crate::alias_fanout_reads::TitleQuery;
use crate::chunks::{ChunkInput, UpsertChunksOptions};
use crate::link_queries::{
    ApplyTemporalInput, CoverageScope, GraphScope, KeysForOriginInput, TitledInput,
};
use crate::links::{AddLinkOptions, RemoveLinkOptions};
use crate::page_ops::DuplicateQuery;
use crate::pages::{PageInput, PutPageOptions};
use crate::sources::SourceInput;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn de<T: DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// The index equals what the stored records derive.
fn assert_in_step(store: &Store, at: &str) {
    let read = store.read().unwrap();
    let stored = stored_entries(&*read).unwrap();
    let expected = expected_entries(&*read).unwrap();
    assert_eq!(stored, expected, "keyed index out of step after {at}");
}

/// A tiny deterministic generator (no dependency, same sequence on every run).
struct Lcg(u64);
impl Lcg {
    fn next(&mut self, n: usize) -> usize {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.0 >> 33) % n as u64) as usize
    }
}

const SLUGS: &[&str] = &[
    "notes/a", "notes/b", "notes/c", "people/d", "people/e", "notes/f", "notes/g", "notes/h",
];
/// Titles with case variants, a dotted capital I (`to_lowercase` and `pg_lower` differ on it),
/// short titles and one past the raw title limit.
fn titles() -> Vec<String> {
    vec![
        "Acme Launch".into(),
        "acme launch".into(),
        "ACME".into(),
        "İstanbul Trip".into(),
        "ab".into(),
        "Launch".into(),
        "Widget Plan".into(),
        format!("Long {}", "x".repeat(600)),
    ]
}
const HASHES: &[&str] = &["h1", "h2", "h3"];
const FM_IDS: &[Option<&str>] = &[None, Some("doc-1"), Some("doc-2")];

fn basis(i: usize) -> Vec<f64> {
    let mut v = vec![0.0; 1536];
    v[i % 1536] = 1.0;
    v
}

fn put(store: &Store, rng: &mut Lcg, slug: &str, source: &str) -> Option<String> {
    let titles = titles();
    let title = &titles[rng.next(titles.len())];
    let mut frontmatter = json!({});
    if let Some(id) = FM_IDS[rng.next(FM_IDS.len())] {
        frontmatter["id"] = json!(id);
    }
    let input: PageInput = de(json!({
        "type": if rng.next(2) == 0 { "note" } else { "person" },
        "title": title,
        "compiled_truth": format!("{slug} body {}", rng.next(5)),
        "frontmatter": frontmatter,
        "content_hash": HASHES[rng.next(HASHES.len())],
    }));
    let options: PutPageOptions = de(json!({"sourceId": source, "index": false}));
    store
        .put_page(slug, &input, &options)
        .ok()
        .map(|row| row["knowledge_revision"].as_str().unwrap().to_string())
}

/// One random write; `Some(label)` when it ran.
fn step(store: &Store, rng: &mut Lcg) -> Option<String> {
    let slug = SLUGS[rng.next(SLUGS.len())];
    let other = SLUGS[rng.next(SLUGS.len())];
    let source = if rng.next(4) == 0 { "work" } else { "default" };
    match rng.next(11) {
        0..=2 => put(store, rng, slug, source).map(|_| format!("put {source}:{slug}")),
        3 => {
            let rev = put(store, rng, slug, "default")?;
            let n = 1 + rng.next(3);
            let chunks: Vec<Value> = (0..n)
                .map(|i| {
                    let mut c =
                        json!({"chunk_index": i, "chunk_text": format!("c{i}"), "model": "m1"});
                    if rng.next(3) > 0 {
                        c["embedding"] = json!(basis(rng.next(4)));
                    }
                    c
                })
                .collect();
            store
                .upsert_chunks(
                    slug,
                    &de::<Vec<ChunkInput>>(json!(chunks)),
                    &UpsertChunksOptions {
                        expected_revision: Some(rev),
                        seal: rng.next(3) > 0,
                        ..Default::default()
                    },
                )
                .ok()
                .map(|_| format!("chunks {slug}"))
        }
        4 => {
            let link_type = if rng.next(2) == 0 {
                "supersedes"
            } else {
                "cites"
            };
            let options = AddLinkOptions {
                link_type: Some(link_type.into()),
                link_source: Some("manual".into()),
                ..AddLinkOptions::default()
            };
            store
                .add_link(slug, other, &options)
                .ok()
                .map(|_| format!("link {slug}>{other} {link_type}"))
        }
        5 => store
            .remove_link(slug, other, &RemoveLinkOptions::default())
            .ok()
            .map(|_| format!("unlink {slug}>{other}")),
        6 => store
            .soft_delete_page(slug, None)
            .ok()
            .map(|_| format!("soft delete {slug}")),
        7 => store
            .restore_page(slug, None)
            .ok()
            .map(|_| format!("restore {slug}")),
        10 => {
            // Dated evidence the page owns (`applyLinkTemporalRows`): it replaces the page's own
            // transitions of the producer, so rows come and go.
            let page_id = crate::pages::read_page(&*store.read().ok()?, "default", slug)
                .ok()??
                .id;
            let n = rng.next(3);
            let transitions: Vec<Value> = (0..n)
                .map(|i| {
                    json!({
                        "from_slug": slug, "to_slug": other, "link_type": "works_at",
                        "kind": if i % 2 == 0 { "start" } else { "end" },
                        "occurred_on": format!("20{:02}-01-01", 10 + rng.next(10)),
                        "date_precision": "day", "producer": "timeline", "line_hash": format!("h{i}"),
                    })
                })
                .collect();
            let input: ApplyTemporalInput = de(json!({
                "pageId": page_id, "sourceId": "default", "transitions": transitions,
                "producers": ["timeline"], "linkTypes": ["works_at"],
            }));
            store
                .apply_link_temporal_rows(&input)
                .ok()
                .map(|applied| format!("temporal {slug}>{other} x{n}: {applied:?}"))
        }
        8 => store
            .delete_page(slug, Some(source))
            .ok()
            .map(|_| format!("delete {source}:{slug}")),
        _ => store
            .update_slug(slug, other, None)
            .ok()
            .map(|_| format!("rename {slug}>{other}")),
    }
}

/// Runs `read` with the keyed lookups and again as the whole-store scan; both must agree.
fn same<T: PartialEq + std::fmt::Debug>(what: &str, read: impl Fn() -> T) {
    let keyed = read();
    FULL_SCAN.with(|f| f.set(true));
    let scanned = read();
    FULL_SCAN.with(|f| f.set(false));
    assert_eq!(keyed, scanned, "{what}: keyed answer differs from the scan");
}

fn check_readers(store: &Store) {
    let titles = titles();
    let mut norms: Vec<String> = titles.iter().map(|t| t.to_lowercase()).collect();
    norms.push("missing".into());
    same("findPagesByTitles", || {
        store
            .find_pages_by_titles(&TitleQuery {
                title_norms: norms.clone(),
                source_ids: vec!["default".into(), "work".into()],
                types: vec!["note".into(), "person".into()],
                exclude_private: None,
            })
            .unwrap()
    });
    let mut queries: Vec<String> = [
        "the acme launch and widget plan",
        "ab",
        "",
        "acme\u{0}launch",
    ]
    .map(String::from)
    .to_vec();
    // Each lower-casing of each title on its own, inside other text, so neither form hides the other.
    for title in &titles {
        queries.push(format!("about {} today", crate::keyword::pg_lower(title)));
        queries.push(format!("about {} today", title.to_lowercase()));
    }
    for query in &queries {
        same(&format!("listPagesTitledIn {query:?}"), || {
            store
                .list_pages_titled_in(&TitledInput {
                    query_lower: query.clone(),
                    scope: GraphScope::default(),
                })
                .unwrap()
        });
    }
    for hash in HASHES.iter().chain(&["none"]) {
        for fm in FM_IDS {
            for exclude in [None, Some("notes/a")] {
                let q: DuplicateQuery =
                    de(json!({"hash": hash, "frontmatterId": fm, "excludeSlug": exclude}));
                for source in ["default", "work"] {
                    same("findDuplicatePage", || {
                        store.find_duplicate_page(source, &q).unwrap()
                    });
                    same("findDuplicatePages", || {
                        store
                            .find_duplicate_pages(source, std::slice::from_ref(&q))
                            .unwrap()
                    });
                }
            }
        }
    }
    same("hasSupersedeEdges", || store.has_supersede_edges().unwrap());
    for page_id in 1..30 {
        same("linkRelationshipKeysForOrigin", || {
            store
                .link_relationship_keys_for_origin(&KeysForOriginInput {
                    page_id,
                    link_types: vec!["works_at".into()],
                })
                .unwrap()
        });
    }
    for scope in [
        json!({}),
        json!({"sourceId": "work"}),
        json!({"pageKind": "image"}),
    ] {
        let scope: CoverageScope = de(scope);
        same("readProjectionReadiness", || {
            store.read_projection_readiness(&scope).unwrap()
        });
    }
    let ids: Vec<u64> = (1..40).collect();
    same("cosinesByChunkIds", || {
        store.cosines_by_chunk_ids(&ids, &basis(1)).unwrap()
    });
    same("getEmbeddingsByChunkIds", || {
        store.get_embeddings_by_chunk_ids(&ids).unwrap()
    });
}

fn source(store: &Store, id: &str) {
    let input: SourceInput = de(json!({"id": id, "name": id}));
    store.upsert_source(&input).unwrap();
}

#[test]
fn the_index_stays_in_step_and_the_members_answer_as_the_scans() {
    for seed in [1u64, 7, 42] {
        let store = crate::test_support::store();
        source(&store, "work");
        let mut rng = Lcg(seed);
        let mut ran = 0;
        let mut kinds: BTreeSet<u8> = BTreeSet::new();
        for i in 0..400 {
            if let Some(label) = step(&store, &mut rng) {
                ran += 1;
                assert_in_step(&store, &format!("seed {seed} step {i}: {label}"));
                kinds.extend(
                    stored_entries(&*store.read().unwrap())
                        .unwrap()
                        .iter()
                        .map(|k| k[keys::KEYED_INDEX.len()]),
                );
            }
            if i % 25 == 24 {
                check_readers(&store);
            }
        }
        assert!(ran > 200, "seed {seed}: only {ran} writes ran");
        // The workload reached every lookup kind, so the comparison above was not vacuous.
        assert_eq!(
            kinds,
            [
                CHUNK_ID,
                TITLE,
                UNSERVED,
                SUPERSEDES,
                CONTENT_HASH,
                FRONTMATTER_ID,
                LONG_TITLE,
                TRANSITION_ORIGIN
            ]
            .into_iter()
            .collect(),
            "seed {seed}"
        );
    }
}

#[test]
fn a_rolled_back_savepoint_and_transaction_leave_the_index_in_step() {
    let store = crate::test_support::store();
    source(&store, "work");
    let mut rng = Lcg(3);
    for _ in 0..40 {
        step(&store, &mut rng);
    }
    let before = stored_entries(&*store.read().unwrap()).unwrap();
    let tx = store.begin_transaction(false).unwrap();
    for _ in 0..10 {
        step(&tx, &mut rng);
    }
    let depth = tx.savepoint().unwrap();
    for _ in 0..20 {
        step(&tx, &mut rng);
    }
    tx.rollback_savepoint(depth).unwrap();
    assert_in_step(&tx, "a savepoint rollback");
    tx.rollback_transaction().unwrap();
    drop(tx);
    assert_eq!(stored_entries(&*store.read().unwrap()).unwrap(), before);
    assert_in_step(&store, "a transaction rollback");
}

#[test]
fn concurrent_writers_keep_the_index_in_step() {
    let store = crate::test_support::occ_store();
    source(&store, "work");
    std::thread::scope(|scope| {
        for seed in 0..4u64 {
            let store = &store;
            scope.spawn(move || {
                let mut rng = Lcg(100 + seed);
                for _ in 0..60 {
                    step(store, &mut rng);
                }
            });
        }
    });
    assert_in_step(&store, "four concurrent writers");
    check_readers(&store);
}

#[test]
fn rebuild_writes_exactly_the_derived_entries() {
    let store = crate::test_support::store();
    source(&store, "work");
    let mut rng = Lcg(9);
    for _ in 0..120 {
        step(&store, &mut rng);
    }
    let want = stored_entries(&*store.read().unwrap()).unwrap();
    // Drop half the entries and add a stray one, as an index written by another build might be.
    store
        .write(|tx| {
            for key in want.iter().step_by(2) {
                tx.delete(key)?;
            }
            tx.put(&id_entry(UNSERVED, &[999_999]), &[])
        })
        .unwrap();
    store.write(rebuild).unwrap();
    assert_eq!(stored_entries(&*store.read().unwrap()).unwrap(), want);
}

#[test]
fn a_format_8_brain_gets_its_index_when_it_opens() {
    let kv = crate::test_support::mem_kv();
    let env: std::sync::Arc<dyn crate::env::Env> = std::sync::Arc::new(crate::SystemEnv);
    let want = {
        let store = Store::open_kv(kv.clone(), env.clone(), crate::OpenOptions::default()).unwrap();
        source(&store, "work");
        let mut rng = Lcg(11);
        for _ in 0..120 {
            step(&store, &mut rng);
        }
        let want = stored_entries(&*store.read().unwrap()).unwrap();
        assert!(!want.is_empty());
        // What a format-8 build leaves: no keyed entries, format record at 8.
        let mut tx = kv.begin_write().unwrap();
        for key in &want {
            tx.delete(key).unwrap();
        }
        let mut stored: crate::StoredFormat = crate::get_json(&*tx, &keys::meta("format"))
            .unwrap()
            .unwrap();
        stored.format_version = 8;
        crate::put_json(&mut *tx, &keys::meta("format"), &stored).unwrap();
        tx.commit().unwrap();
        want
    };
    let store = Store::open_kv(kv, env, crate::OpenOptions::default()).unwrap();
    assert_eq!(store.info().format_version, crate::FORMAT_VERSION);
    assert_eq!(stored_entries(&*store.read().unwrap()).unwrap(), want);
    check_readers(&store);
}

#[test]
fn a_raw_title_entry_reads_back_its_title_and_page() {
    let key = title_entry("a\u{0}b", 7);
    assert_eq!(raw_title_of(&key), Some((&b"a\0b"[..], 7)));
    let long = "x".repeat(RAW_TITLE_MAX + 1);
    assert_eq!(title_entry(&long, 7)[keys::KEYED_INDEX.len()], LONG_TITLE);
    assert_eq!(
        title_entry(&"x".repeat(RAW_TITLE_MAX), 7)[keys::KEYED_INDEX.len()],
        TITLE
    );
}

/// A write that reads the lookups inside its own statement (`applyLinkTemporalRows` reads the
/// origin's keys after inserting transitions) answers as the scan does: the same seeded workload
/// run with the lookups and with the scans returns the same answer from every write.
#[test]
fn every_write_answers_as_the_scans_inside_its_own_statement() {
    let run = |full_scan: bool| {
        FULL_SCAN.with(|f| f.set(full_scan));
        let store = crate::test_support::store();
        source(&store, "work");
        let mut rng = Lcg(5);
        let labels: Vec<Option<String>> = (0..400).map(|_| step(&store, &mut rng)).collect();
        FULL_SCAN.with(|f| f.set(false));
        labels
    };
    let keyed = run(false);
    let scanned = run(true);
    let temporal = keyed
        .iter()
        .flatten()
        .filter(|l| l.starts_with("temporal") && !l.contains("keys_after: []"))
        .count();
    assert!(
        temporal > 5,
        "only {temporal} temporal writes returned keys"
    );
    assert_eq!(keyed, scanned);
}

/// Transition-only evidence: a new dated relationship with no link between the pages reports its
/// key in `keys_after`, so the caller materializes its relationship state.
#[test]
fn new_transitions_with_no_link_are_in_keys_after() {
    let store = crate::test_support::store();
    let mut rng = Lcg(1);
    put(&store, &mut rng, "people/a", "default");
    put(&store, &mut rng, "companies/b", "default");
    let page_id = crate::pages::read_page(&*store.read().unwrap(), "default", "people/a")
        .unwrap()
        .unwrap()
        .id;
    let to_id = crate::pages::read_page(&*store.read().unwrap(), "default", "companies/b")
        .unwrap()
        .unwrap()
        .id;
    let input: ApplyTemporalInput = de(json!({
        "pageId": page_id, "sourceId": "default", "producers": ["timeline"], "linkTypes": ["works_at"],
        "transitions": [{ "from_slug": "people/a", "to_slug": "companies/b", "link_type": "works_at",
            "kind": "start", "occurred_on": "2020-01-01", "date_precision": "day", "producer": "timeline",
            "line_hash": "h" }],
    }));
    let applied = store.apply_link_temporal_rows(&input).unwrap();
    let want = vec![crate::link_queries::RelationshipKey {
        from_page_id: page_id,
        to_page_id: to_id,
        link_type: "works_at".into(),
    }];
    assert_eq!(applied.inserted, want);
    assert_eq!(applied.keys_after, want);
    // Applying the same evidence again replaces the row: still one key, still reported.
    let again = store.apply_link_temporal_rows(&input).unwrap();
    assert_eq!(again.keys_after, want);
}
