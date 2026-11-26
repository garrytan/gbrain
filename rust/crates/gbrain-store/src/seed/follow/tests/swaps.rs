//! Tests of natural keys that swap: two rows trade a unique value (a chunk's index, a page's slug,
//! an alias) and the follow calls reach the primary's state however the changes are split.

use super::*;

/// Pages 7 and 9 as `linked_pages` holds them, and a second chunk of page 7 (id 43, index 1,
/// sort 3). Chunks: 41 is page 7 index 0, 42 is page 9 index 0, 43 is page 7 index 1.
fn chunked() -> Store {
    let s = linked_pages();
    s.import_relation_with_digests(
        SEED,
        "content_chunks",
        vec![chunk_row("43", "7", "1", "second chunk of alice")],
        &[dig(3)],
    )
    .unwrap();
    s
}

/// The `(chunk_index, chunk_text)` pairs of the page `slug`, in index order.
fn chunks_of(s: &Store, slug: &str) -> Vec<(i64, String)> {
    let options = crate::chunks::GetChunksOptions {
        include_unsealed: true,
        ..Default::default()
    };
    s.get_chunks_with(slug, &options)
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["chunk_index"].as_i64().unwrap(),
                c["chunk_text"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn chunk_key(n: u8, id: &str) -> KeyInput {
    key(n, &[("id", id)])
}

const ALICE: &str = "people/alice-example";
const ACME: &str = "companies/acme-example";

#[test]
fn two_chunks_swap_their_indexes_in_one_call() {
    let s = chunked();
    let r = s
        .replace_relation_rows(
            SEED,
            "content_chunks",
            1,
            &[chunk_key(1, "41"), chunk_key(3, "43")],
            &[
                chunk_row("41", "7", "1", "first, now second"),
                chunk_row("43", "7", "0", "second, now first"),
            ],
            &[digv(1, 51), digv(3, 53)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (2, 0));
    assert_eq!(
        chunks_of(&s, ALICE),
        [
            (0, "second, now first".to_owned()),
            (1, "first, now second".to_owned())
        ]
    );
    assert_eq!(entries(&s, "content_chunks"), 3);
}

#[test]
fn a_swap_split_over_two_calls_displaces_the_stale_row_and_the_second_call_fixes_it() {
    let s = chunked();
    // The first call carries only chunk 41 to index 1, where chunk 43 still sits.
    let r = s
        .replace_relation_rows(
            SEED,
            "content_chunks",
            1,
            &[chunk_key(1, "41")],
            &[chunk_row("41", "7", "1", "first, now second")],
            &[digv(1, 51)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (1, 1));
    // The stale chunk is gone and so is its entry: the next reconcile sees the difference.
    assert_eq!(chunks_of(&s, ALICE), [(1, "first, now second".to_owned())]);
    assert_eq!(entries(&s, "content_chunks"), 2);
    let listed = s
        .relation_entries(SEED, "content_chunks", None, None, 10)
        .unwrap();
    assert_eq!(entry_sorts(&listed), ["01", "02"]);
    // The second call stores chunk 43 at index 0.
    let r = s
        .replace_relation_rows(
            SEED,
            "content_chunks",
            2,
            &[chunk_key(3, "43")],
            &[chunk_row("43", "7", "0", "second, now first")],
            &[digv(3, 53)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (1, 0));
    assert_eq!(
        chunks_of(&s, ALICE),
        [
            (0, "second, now first".to_owned()),
            (1, "first, now second".to_owned())
        ]
    );
    assert_eq!(entries(&s, "content_chunks"), 3);
}

#[test]
fn a_swap_across_two_reconcile_intervals_ends_with_the_digests_equal() {
    let s = chunked();
    let swapped = [
        (1u8, chunk_row("41", "7", "1", "first, now second"), 51u8),
        (3, chunk_row("43", "7", "0", "second, now first"), 53),
        (2, chunk_row("42", "9", "0", "Acme makes widgets."), 2),
    ];
    // Interval [01, 03) holds chunks 41 and 42; [03, ..) holds chunk 43.
    let pass = |generation, lo: Option<&str>, hi: Option<&str>, picks: &[u8]| {
        let mut rows = Vec::new();
        let mut digests = Vec::new();
        for (n, row, d) in &swapped {
            if picks.contains(n) {
                rows.push(row.clone());
                digests.push(digv(*n, *d));
            }
        }
        s.replace_interval(SEED, "content_chunks", generation, lo, hi, &rows, &digests)
            .unwrap()
    };
    let first = pass(1, None, Some("03"), &[1, 2]);
    assert_eq!(first.displaced, 1, "chunk 43 held index 1 of page 7");
    let second = pass(1, Some("03"), None, &[3]);
    assert_eq!((second.upserted, second.displaced), (1, 0));
    assert_eq!(
        chunks_of(&s, ALICE),
        [
            (0, "second, now first".to_owned()),
            (1, "first, now second".to_owned())
        ]
    );
    // Both intervals now digest as the primary's rows do.
    let mut hasher = Sha256::new();
    for (n, _, d) in [&swapped[0], &swapped[2], &swapped[1]] {
        hasher.update(1u32.to_be_bytes());
        hasher.update([*n]);
        hasher.update([*d; 32]);
    }
    assert_eq!(
        digest_of(&s, "content_chunks"),
        (3, hex(&hasher.finalize()))
    );
    // A third pass over the whole relation finds nothing to change.
    let again = pass(2, None, None, &[1, 2, 3]);
    assert_eq!((again.deleted, again.displaced), (0, 0));
}

#[test]
fn two_pages_swap_their_slugs_in_one_call() {
    let s = linked_pages();
    let r = s
        .replace_relation_rows(
            SEED,
            "pages",
            1,
            &[key(1, &[("id", "7")]), key(2, &[("id", "9")])],
            &[page_row("7", ACME), page_row("9", ALICE)],
            &[digv(1, 31), digv(2, 32)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (2, 0));
    // The chunks stay with their pages: chunk 41 belongs to page 7, now at the slug `acme`.
    assert_eq!(chunks_of(&s, ACME).len(), 1);
    assert_eq!(chunks_of(&s, ALICE).len(), 1);
    assert_eq!(read_page(&s, ACME).unwrap()["page"]["id"], 7);
    assert_eq!(read_page(&s, ALICE).unwrap()["page"]["id"], 9);
}

#[test]
fn a_page_slug_swap_split_over_two_calls_displaces_then_converges() {
    let s = linked_pages();
    let r = s
        .replace_relation_rows(
            SEED,
            "pages",
            1,
            &[key(1, &[("id", "7")])],
            &[page_row("7", ACME)],
            &[digv(1, 31)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (1, 1));
    assert_eq!(read_page(&s, ACME).unwrap()["page"]["id"], 7);
    assert!(read_page(&s, ALICE).is_none());
    assert_eq!(entries(&s, "pages"), 1);
    let r = s
        .replace_relation_rows(
            SEED,
            "pages",
            2,
            &[key(2, &[("id", "9")])],
            &[page_row("9", ALICE)],
            &[digv(2, 32)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (1, 0));
    assert_eq!(read_page(&s, ALICE).unwrap()["page"]["id"], 9);
    assert_eq!(entries(&s, "pages"), 2);
}

fn alias_row(id: &str, alias: &str, canonical: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("source_id", "default"),
        ("alias_slug", alias),
        ("canonical_slug", canonical),
    ])
}

fn canonical_of(s: &Store, alias: &str) -> Option<String> {
    let read = s.read().unwrap();
    crate::aliases::read_slug_alias(&*read, "default", alias)
        .unwrap()
        .map(|record| record.canonical_slug)
}

fn aliased() -> Store {
    let s = store();
    s.import_relation_with_digests(
        SEED,
        "slug_aliases",
        vec![
            alias_row("1", "foo", "people/one"),
            alias_row("2", "bar", "people/two"),
        ],
        &[dig(1), dig(2)],
    )
    .unwrap();
    s
}

#[test]
fn two_aliases_swap_their_names_in_one_call() {
    let s = aliased();
    let r = s
        .replace_relation_rows(
            SEED,
            "slug_aliases",
            1,
            &[key(1, &[("id", "1")]), key(2, &[("id", "2")])],
            &[
                alias_row("1", "bar", "people/one"),
                alias_row("2", "foo", "people/two"),
            ],
            &[digv(1, 41), digv(2, 42)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (2, 0));
    assert_eq!(canonical_of(&s, "bar").as_deref(), Some("people/one"));
    assert_eq!(canonical_of(&s, "foo").as_deref(), Some("people/two"));
}

#[test]
fn an_alias_swap_split_over_two_calls_does_not_end_with_the_row_silently_skipped() {
    let s = aliased();
    // Alias 1 takes the name `bar`, which alias 2 holds: the importer would skip it silently.
    let r = s
        .replace_relation_rows(
            SEED,
            "slug_aliases",
            1,
            &[key(1, &[("id", "1")])],
            &[alias_row("1", "bar", "people/one")],
            &[digv(1, 41)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (1, 1));
    assert_eq!(canonical_of(&s, "bar").as_deref(), Some("people/one"));
    assert_eq!(canonical_of(&s, "foo"), None);
    assert_eq!(entries(&s, "slug_aliases"), 1);
    let r = s
        .replace_relation_rows(
            SEED,
            "slug_aliases",
            2,
            &[key(2, &[("id", "2")])],
            &[alias_row("2", "foo", "people/two")],
            &[digv(2, 42)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (1, 0));
    assert_eq!(canonical_of(&s, "foo").as_deref(), Some("people/two"));
    assert_eq!(entries(&s, "slug_aliases"), 2);
}

#[test]
fn a_row_held_without_an_entry_is_left_alone_not_displaced() {
    let s = store();
    // Imported without digests: the store cannot tell whose row it is.
    s.import_relation(
        SEED,
        "slug_aliases",
        vec![alias_row("2", "bar", "people/two")],
    )
    .unwrap();
    s.import_relation_with_digests(
        SEED,
        "slug_aliases",
        vec![alias_row("1", "foo", "people/one")],
        &[dig(1)],
    )
    .unwrap();
    let r = s
        .replace_relation_rows(
            SEED,
            "slug_aliases",
            1,
            &[key(1, &[("id", "1")])],
            &[alias_row("1", "bar", "people/one")],
            &[digv(1, 41)],
        )
        .unwrap();
    // Nothing to displace, so the importer's silent skip stands and nothing is lost.
    assert_eq!(r.displaced, 0);
    assert_eq!(canonical_of(&s, "bar").as_deref(), Some("people/two"));
}

#[test]
fn a_failed_call_undoes_its_displacements() {
    let s = chunked();
    // Chunk 41 takes index 1 (displacing 43), but the second row names a page that is not there.
    let err = s
        .replace_relation_rows(
            SEED,
            "content_chunks",
            1,
            &[chunk_key(1, "41"), chunk_key(4, "44")],
            &[
                chunk_row("41", "7", "1", "first, now second"),
                chunk_row("44", "99", "0", "orphan"),
            ],
            &[digv(1, 51), digv(4, 54)],
        )
        .unwrap_err();
    assert!(err.message.contains("row 1"), "{}", err.message);
    assert_eq!(
        chunks_of(&s, ALICE),
        [
            (0, "Alice builds widgets at acme.".to_owned()),
            (1, "second chunk of alice".to_owned())
        ]
    );
    assert_eq!(entries(&s, "content_chunks"), 3);
}

/// Links 31 and 32 both run from page 7 to page 9, one `works_at`, one `founded`.
fn two_links() -> Store {
    let s = linked_pages();
    let mut founded = link_row("32", "7", "9");
    founded.insert("link_type".into(), Some("founded".into()));
    s.import_relation_with_digests(SEED, "links", vec![founded], &[dig(2)])
        .unwrap();
    s
}

fn typed(id: &str, link_type: &str) -> SeedRow {
    let mut link = link_row(id, "7", "9");
    link.insert("link_type".into(), Some(link_type.into()));
    link
}

fn link_types(s: &Store) -> Vec<String> {
    let mut types: Vec<String> = s
        .get_links(ALICE, &Default::default())
        .unwrap()
        .iter()
        .map(|l| l["link_type"].as_str().unwrap().to_owned())
        .collect();
    types.sort();
    types
}

#[test]
fn two_links_swap_their_types_in_one_call_and_across_two() {
    let s = two_links();
    let r = s
        .replace_relation_rows(
            SEED,
            "links",
            1,
            &[key(1, &[("id", "31")]), key(2, &[("id", "32")])],
            &[typed("31", "founded"), typed("32", "works_at")],
            &[digv(1, 61), digv(2, 62)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (2, 0));
    assert_eq!(link_types(&s), ["founded", "works_at"]);

    let s = two_links();
    let r = s
        .replace_relation_rows(
            SEED,
            "links",
            1,
            &[key(1, &[("id", "31")])],
            &[typed("31", "founded")],
            &[digv(1, 61)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (1, 1));
    assert_eq!(link_types(&s), ["founded"]);
    let r = s
        .replace_relation_rows(
            SEED,
            "links",
            2,
            &[key(2, &[("id", "32")])],
            &[typed("32", "works_at")],
            &[digv(2, 62)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (1, 0));
    assert_eq!(link_types(&s), ["founded", "works_at"]);
}

#[test]
fn every_unique_natural_key_is_among_the_columns_the_entry_keeps() {
    let mut with_sets = 0;
    for (relation, _) in fixtures() {
        let follow = crate::seed::follow::follow_spec(relation).unwrap();
        for set in follow.unique {
            with_sets += 1;
            for col in *set {
                assert!(
                    follow.identity.contains(col),
                    "{relation}: unique column {col} is not in its identity"
                );
            }
        }
    }
    assert!(with_sets >= 10, "only {with_sets} unique sets");
}

fn timeline_row(id: &str, summary: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("page_id", "7"),
        ("date", "2026-05-06"),
        ("source", "meeting"),
        ("summary", summary),
        ("detail", ""),
        ("created_at", "2026-05-06 10:00:00+00"),
        ("trust_tier", "unknown"),
    ])
}

/// The summaries of the timeline of the page `slug`, sorted.
fn summaries_of(s: &Store, slug: &str) -> Vec<String> {
    let mut all: Vec<String> = s
        .get_timeline(slug, &Default::default())
        .unwrap()
        .iter()
        .map(|e| e["summary"].as_str().unwrap().to_owned())
        .collect();
    all.sort();
    all
}

#[test]
fn a_timeline_key_swap_split_over_two_calls_displaces_then_converges() {
    let s = linked_pages();
    s.import_relation_with_digests(
        SEED,
        "timeline_entries",
        vec![
            timeline_row("12", "Raised a seed round"),
            timeline_row("13", "Hired a CTO"),
        ],
        &[digv(5, 51), digv(6, 52)],
    )
    .unwrap();
    // Entry 12 takes the summary entry 13 holds (the unique key is page, date, summary and source):
    // the stored row is displaced, not refused as a constraint violation.
    let r = s
        .replace_relation_rows(
            SEED,
            "timeline_entries",
            1,
            &[key(5, &[("id", "12")])],
            &[timeline_row("12", "Hired a CTO")],
            &[digv(5, 53)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (1, 1));
    assert_eq!(summaries_of(&s, ALICE), ["Hired a CTO"]);
    assert_eq!(entries(&s, "timeline_entries"), 1);
    let r = s
        .replace_relation_rows(
            SEED,
            "timeline_entries",
            2,
            &[key(6, &[("id", "13")])],
            &[timeline_row("13", "Raised a seed round")],
            &[digv(6, 54)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.displaced), (1, 0));
    assert_eq!(
        summaries_of(&s, ALICE),
        ["Hired a CTO", "Raised a seed round"]
    );
    assert_eq!(entries(&s, "timeline_entries"), 2);
}
