//! Tests of the follow calls: the digest vectors the TypeScript side shares, the generation rule,
//! delete versus replace, atomicity, the seed guards, and one round trip per relation (import a
//! row, delete it through `replaceRelationRows`, and the store holds what it held before).

use crate::Store;
use crate::error::{INVALID_ARGUMENT, INVALID_STATE};
use crate::pages::ReadScope;
use crate::seed::{DigestInput, KeyInput, SeedRow, UNSUPPORTED, plan};
use crate::test_support::store;
use serde_json::Value;
use sha2::{Digest as _, Sha256};

mod displace;
mod fences;
mod stream;
mod swaps;

const SEED: &str = "seed-1";
const REV: &str = "11111111-1111-4111-8111-111111111111";
const INCARNATION: &str = "22222222-2222-4222-8222-222222222222";

fn row(pairs: &[(&str, &str)]) -> SeedRow {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), Some((*v).to_owned())))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(text: &str) -> String {
    hex(&Sha256::digest(text.as_bytes()))
}

/// A digest input: the sort key is `n` as one byte, the digest is that byte thirty-two times.
fn dig(n: u8) -> DigestInput {
    DigestInput {
        sort: hex(&[n]),
        digest: hex(&[n; 32]),
    }
}

/// A digest input with its own sort key byte and digest byte.
fn digv(sort: u8, digest: u8) -> DigestInput {
    DigestInput {
        sort: hex(&[sort]),
        digest: hex(&[digest; 32]),
    }
}

fn key(n: u8, pairs: &[(&str, &str)]) -> KeyInput {
    KeyInput {
        sort: hex(&[n]),
        key: pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
    }
}

fn digest_of(s: &Store, relation: &str) -> (u64, String) {
    let d = s.relation_digest(SEED, relation, None, None).unwrap();
    (d.rows, d.digest)
}

fn config_row(key: &str, value: &str) -> SeedRow {
    row(&[("key", key), ("value", value)])
}

/// A store the seed owns, holding the config keys `a` and `b` (sorts 01 and 02, generation 0).
fn seeded_config() -> Store {
    let s = store();
    let r = s
        .import_relation_with_digests(
            SEED,
            "config",
            vec![config_row("a", "1"), config_row("b", "2")],
            &[dig(1), dig(2)],
        )
        .unwrap();
    assert_eq!(r.imported, 2);
    s
}

// ---- digests and fingerprints ----------------------------------------------------------------

#[test]
fn an_empty_interval_digests_to_sha256_of_nothing() {
    let s = store();
    s.import_relation(SEED, "config", vec![]).unwrap();
    let d = s.relation_digest(SEED, "config", None, None).unwrap();
    assert_eq!(d.rows, 0);
    assert_eq!(d.digest, sha256_hex(""));
    assert_eq!(
        d.digest,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn the_interval_digest_matches_the_vector_the_typescript_side_pins() {
    let s = store();
    let r = s
        .import_relation_with_digests(
            SEED,
            "config",
            vec![config_row("a", "1"), config_row("b", "2")],
            &[
                DigestInput {
                    sort: "8000000000000001".into(),
                    digest: "98fced634434a6ed2734cf443eb7d45b90195c6b1421217660f0d6badb6d0404"
                        .into(),
                },
                DigestInput {
                    sort: "8000000000000005".into(),
                    digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                        .into(),
                },
            ],
        )
        .unwrap();
    assert_eq!(r.imported, 2);
    let d = s.relation_digest(SEED, "config", None, None).unwrap();
    assert_eq!(d.rows, 2);
    assert_eq!(
        d.digest,
        "7e548c509c244d04315a47aa5e8979c2825f2bf268b40a17c7795edebc234efe"
    );
}

#[test]
fn the_digest_covers_the_half_open_interval_and_reads_only() {
    let s = seeded_config();
    let one =
        |lo: Option<&str>, hi: Option<&str>| s.relation_digest(SEED, "config", lo, hi).unwrap();
    assert_eq!(one(Some("01"), Some("02")).rows, 1);
    assert_eq!(one(Some("01"), Some("03")).rows, 2);
    assert_eq!(one(Some("02"), None).rows, 1);
    assert_eq!(one(None, Some("02")).rows, 1);
    assert_eq!(one(Some("02"), Some("02")).rows, 0);
    assert_eq!(one(Some("03"), None).digest, sha256_hex(""));
    // One entry digests as sha256(u32be(len sort) || sort || digest).
    let mut bytes = vec![0, 0, 0, 1, 1];
    bytes.extend_from_slice(&[1; 32]);
    assert_eq!(
        one(Some("01"), Some("02")).digest,
        hex(&Sha256::digest(&bytes))
    );
    // A bound that is not lowercase hex of whole bytes is refused.
    for bad in ["0", "zz", "0A"] {
        let err = s
            .relation_digest(SEED, "config", Some(bad), None)
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT, "{bad}");
    }
}

#[test]
fn relation_digest_refuses_a_foreign_seed_an_unseeded_store_and_an_unknown_relation() {
    let s = seeded_config();
    let err = s
        .relation_digest("seed-2", "config", None, None)
        .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    let err = s.relation_digest(SEED, "nope", None, None).unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    let err = store()
        .relation_digest(SEED, "config", None, None)
        .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
}

#[test]
fn fact_fingerprints_give_the_normalized_and_the_raw_text_hash() {
    let both = super::fact_fingerprints(&[
        "Hello,  World.".to_owned(),
        "Alice Founded  Acme".to_owned(),
    ]);
    assert_eq!(both.len(), 2);
    // v1 only lowercases and collapses white space: punctuation stays.
    assert_eq!(both[0].fingerprint_v1, sha256_hex("hello, world."));
    assert_eq!(both[0].fingerprint, sha256_hex("hello world"));
    assert_ne!(both[0].fingerprint, both[0].fingerprint_v1);
    assert_eq!(both[1].fingerprint, sha256_hex("alice founded acme"));
    assert_eq!(both[1].fingerprint, both[1].fingerprint_v1);
    assert!(super::fact_fingerprints(&[]).is_empty());
}

// ---- importing with digests ------------------------------------------------------------------

#[test]
fn import_with_digests_stores_an_entry_per_row_stored_skipped_and_dropped() {
    let s = store();
    // owner_only_marks drops the rows of any table but pages.
    let rows = || {
        vec![
            row(&[("row_table", "pages"), ("row_id", "7")]),
            row(&[("row_table", "facts"), ("row_id", "3")]),
        ]
    };
    s.import_relation("seed-1", "pages", vec![]).unwrap();
    let r = s
        .import_relation_with_digests(SEED, "owner_only_marks", rows(), &[dig(1), dig(2)])
        .unwrap();
    assert_eq!((r.imported, r.dropped), (1, 1));
    assert_eq!(digest_of(&s, "owner_only_marks").0, 2);
    // A retried batch skips the stored row and keeps both entries.
    let again = s
        .import_relation_with_digests(SEED, "owner_only_marks", rows(), &[dig(1), dig(2)])
        .unwrap();
    assert_eq!((again.imported, again.skipped, again.dropped), (0, 1, 1));
    assert_eq!(digest_of(&s, "owner_only_marks").0, 2);
}

#[test]
fn import_without_digests_stores_no_entry() {
    let s = store();
    s.import_relation(SEED, "config", vec![config_row("a", "1")])
        .unwrap();
    assert_eq!(digest_of(&s, "config"), (0, sha256_hex("")));
}

#[test]
fn a_digest_list_that_does_not_align_with_the_rows_stores_nothing() {
    let s = store();
    let err = s
        .import_relation_with_digests(
            SEED,
            "config",
            vec![config_row("a", "1")],
            &[dig(1), dig(2)],
        )
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert_eq!(s.get_config("a").unwrap(), None);
    let err = s
        .import_relation_with_digests(SEED, "config", vec![config_row("a", "1")], &[])
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    let bad = DigestInput {
        sort: "01".into(),
        digest: "ab".into(),
    };
    let err = s
        .import_relation_with_digests(SEED, "config", vec![config_row("a", "1")], &[bad])
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
}

// ---- replaceRelationRows ---------------------------------------------------------------------

#[test]
fn replace_stores_new_and_changed_rows_and_deletes_the_rest() {
    let s = seeded_config();
    let r = s
        .replace_relation_rows(
            SEED,
            "config",
            1,
            &[
                key(1, &[("key", "a")]),
                key(2, &[("key", "b")]),
                key(3, &[("key", "c")]),
            ],
            &[config_row("a", "changed"), config_row("c", "3")],
            &[digv(1, 11), digv(3, 13)],
        )
        .unwrap();
    assert_eq!(
        (r.upserted, r.deleted, r.skipped_older, r.dropped),
        (2, 1, 0, 0)
    );
    assert_eq!(s.get_config("a").unwrap().as_deref(), Some("changed"));
    assert_eq!(s.get_config("b").unwrap(), None);
    assert_eq!(s.get_config("c").unwrap().as_deref(), Some("3"));
    let d = s.relation_digest(SEED, "config", None, None).unwrap();
    assert_eq!(d.rows, 2);
    // The entry for sort 01 now carries the new digest.
    let mut bytes = vec![0, 0, 0, 1, 1];
    bytes.extend_from_slice(&[11; 32]);
    bytes.extend_from_slice(&[0, 0, 0, 1, 3]);
    bytes.extend_from_slice(&[13; 32]);
    assert_eq!(d.digest, hex(&Sha256::digest(&bytes)));
}

#[test]
fn an_entry_of_a_later_generation_is_left_alone() {
    let s = seeded_config();
    let newer = |s: &Store, generation| {
        s.replace_relation_rows(
            SEED,
            "config",
            generation,
            &[key(1, &[("key", "a")])],
            &[config_row("a", &format!("g{generation}"))],
            &[digv(1, 20 + generation as u8)],
        )
        .unwrap()
    };
    assert_eq!(newer(&s, 5).upserted, 1);
    // Generation 4 is older than the entry's 5: skipped, the row and the entry stay.
    let r = newer(&s, 4);
    assert_eq!((r.upserted, r.skipped_older), (0, 1));
    assert_eq!(s.get_config("a").unwrap().as_deref(), Some("g5"));
    // The delete is skipped the same way.
    let r = s
        .replace_relation_rows(SEED, "config", 4, &[key(1, &[("key", "a")])], &[], &[])
        .unwrap();
    assert_eq!((r.deleted, r.skipped_older), (0, 1));
    assert_eq!(s.get_config("a").unwrap().as_deref(), Some("g5"));
    // An equal or newer generation applies.
    assert_eq!(newer(&s, 5).upserted, 1);
    assert_eq!(newer(&s, 6).upserted, 1);
    assert_eq!(s.get_config("a").unwrap().as_deref(), Some("g6"));
    // Importing again never replaces the entry of a follow call (generation 0 is the oldest).
    s.import_relation_with_digests(SEED, "config", vec![config_row("a", "g6")], &[digv(1, 99)])
        .unwrap();
    let mut bytes = vec![0, 0, 0, 1, 1];
    bytes.extend_from_slice(&[26; 32]);
    bytes.extend_from_slice(&[0, 0, 0, 1, 2]);
    bytes.extend_from_slice(&[2; 32]);
    assert_eq!(
        s.relation_digest(SEED, "config", None, None)
            .unwrap()
            .digest,
        hex(&Sha256::digest(&bytes))
    );
}

#[test]
fn replace_refuses_a_foreign_seed_and_a_store_no_seed_owns() {
    let s = seeded_config();
    let err = s
        .replace_relation_rows("seed-2", "config", 1, &[], &[], &[])
        .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    let err = s
        .replace_interval("seed-2", "config", 1, None, None, &[], &[])
        .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    let fresh = store();
    let err = fresh
        .replace_relation_rows(SEED, "config", 1, &[], &[], &[])
        .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    let err = fresh
        .replace_interval(SEED, "config", 1, None, None, &[], &[])
        .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    // Nothing was claimed by the refused calls.
    assert_eq!(fresh.get_config("a").unwrap(), None);
}

#[test]
fn replace_checks_its_arguments_before_it_writes() {
    let s = seeded_config();
    let call = |keys: &[KeyInput], rows: &[SeedRow], digests: &[DigestInput]| {
        s.replace_relation_rows(SEED, "config", 1, keys, rows, digests)
            .unwrap_err()
    };
    // A row whose sort is not among the keys.
    let err = call(
        &[key(1, &[("key", "a")])],
        &[config_row("z", "9")],
        &[dig(9)],
    );
    assert_eq!(err.code, INVALID_ARGUMENT);
    // Rows and digests that do not align.
    let err = call(&[key(1, &[("key", "a")])], &[config_row("a", "9")], &[]);
    assert_eq!(err.code, INVALID_ARGUMENT);
    // Two rows with one sort key.
    let err = call(
        &[key(1, &[("key", "a")])],
        &[config_row("a", "8"), config_row("a", "9")],
        &[dig(1), dig(1)],
    );
    assert_eq!(err.code, INVALID_ARGUMENT);
    let err = s
        .replace_relation_rows(SEED, "nope", 1, &[], &[], &[])
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert_eq!(s.get_config("a").unwrap().as_deref(), Some("1"));
}

#[test]
fn deleting_a_row_of_a_relation_the_store_cannot_remove_is_unsupported() {
    let s = store();
    let default = row(&[
        ("id", "wiki"),
        ("name", "Wiki"),
        ("config", "{}"),
        ("archived", "f"),
        ("incarnation", INCARNATION),
        ("created_at", "2025-12-31 23:59:59+00"),
    ]);
    s.import_relation_with_digests(SEED, "sources", vec![default.clone()], &[dig(1)])
        .unwrap();
    let err = s
        .replace_relation_rows(SEED, "sources", 1, &[key(1, &[("id", "wiki")])], &[], &[])
        .unwrap_err();
    assert_eq!(err.code, UNSUPPORTED);
    // A changed row of it is stored in place.
    let mut renamed = default;
    renamed.insert("name".into(), Some("Wiki two".into()));
    let r = s
        .replace_relation_rows(
            SEED,
            "sources",
            1,
            &[key(1, &[("id", "wiki")])],
            &[renamed],
            &[digv(1, 2)],
        )
        .unwrap();
    assert_eq!(r.upserted, 1);
    assert_eq!(
        s.relation_digest(SEED, "sources", None, None).unwrap().rows,
        1
    );
}

#[test]
fn the_plan_marks_exactly_the_relations_the_store_cannot_remove() {
    let relations = plan().relations;
    let not_removable: Vec<&str> = relations
        .iter()
        .filter(|r| !r.removable)
        .map(|r| r.relation)
        .collect();
    assert_eq!(not_removable, ["sources"]);
    for r in &relations {
        assert!(
            super::follow_spec(r.relation).is_some(),
            "{} has no follow spec",
            r.relation
        );
    }
}

// ---- pages and what hangs off them -----------------------------------------------------------

fn page_row(id: &str, slug: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("source_id", "default"),
        ("slug", slug),
        ("type", "person"),
        ("page_kind", "markdown"),
        ("title", "Alice Example"),
        ("compiled_truth", "Alice builds widgets at acme."),
        ("timeline", ""),
        ("frontmatter", r#"{"role": "founder"}"#),
        ("content_hash", "abc123"),
        ("created_at", "2026-01-02 03:04:05.123456+00"),
        ("updated_at", "2026-02-03 04:05:06.5+00"),
        ("knowledge_revision", REV),
        ("text_projection_revision", REV),
        ("chunker_version", "3"),
        ("trust_tier", "user_confirmed"),
        ("write_origin", r#"{"kind": "cli"}"#),
        ("emotional_weight", "0.75"),
        ("salience_touched_at", "2026-03-01 00:00:00+00"),
        ("contextual_retrieval_mode", "on"),
        ("corpus_generation", "g7"),
        ("embedding_signature", "openai:text-embedding-3-large:1536"),
        ("links_extracted_at", "2026-03-02 00:00:00+00"),
        ("generation", "1"),
        ("search_vector", "'alice':1"),
    ])
}

fn chunk_row(id: &str, page_id: &str, index: &str, text: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("page_id", page_id),
        ("chunk_index", index),
        ("chunk_text", text),
        ("chunk_source", "compiled_truth"),
        ("model", "openai:text-embedding-3-large"),
        ("modality", "text"),
        ("token_count", "6"),
        ("created_at", "2026-01-02 03:04:05+00"),
    ])
}

fn link_row(id: &str, from: &str, to: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("from_page_id", from),
        ("to_page_id", to),
        ("link_type", "works_at"),
        ("context", "works at"),
        ("link_source", "markdown"),
        ("created_at", "2026-01-04 00:00:00+00"),
    ])
}

/// Two pages (7 and 9) with a chunk, a tag and a link each way round, every row with a digest.
fn linked_pages() -> Store {
    let s = store();
    let import = |relation: &str, rows: Vec<SeedRow>, base: u8| {
        let digests: Vec<DigestInput> = (0..rows.len() as u8).map(|n| dig(base + n)).collect();
        s.import_relation_with_digests(SEED, relation, rows, &digests)
            .unwrap();
    };
    import(
        "pages",
        vec![
            page_row("7", "people/alice-example"),
            page_row("9", "companies/acme-example"),
        ],
        1,
    );
    import("tags", vec![row(&[("page_id", "7"), ("tag", "yc")])], 1);
    import(
        "content_chunks",
        vec![
            chunk_row("41", "7", "0", "Alice builds widgets at acme."),
            chunk_row("42", "9", "0", "Acme makes widgets."),
        ],
        1,
    );
    import("links", vec![link_row("31", "7", "9")], 1);
    s
}

fn read_page(s: &Store, slug: &str) -> Option<Value> {
    s.read_page_snapshot(slug, &ReadScope::default()).unwrap()
}

fn entries(s: &Store, relation: &str) -> u64 {
    digest_of(s, relation).0
}

#[test]
fn a_changed_page_keeps_its_chunks_links_and_tags() {
    let s = linked_pages();
    let mut changed = page_row("7", "people/alice-example");
    changed.insert("title".into(), Some("Alice Changed".into()));
    changed.insert(
        "compiled_truth".into(),
        Some("Alice now builds gadgets.".into()),
    );
    let r = s
        .replace_relation_rows(
            SEED,
            "pages",
            1,
            &[key(1, &[("id", "7")])],
            &[changed],
            &[digv(1, 31)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.deleted), (1, 0));
    let page = read_page(&s, "people/alice-example").unwrap();
    assert_eq!(page["page"]["title"], "Alice Changed");
    assert_eq!(page["tags"], serde_json::json!(["yc"]));
    assert_eq!(
        s.get_tags("people/alice-example", &ReadScope::default())
            .unwrap(),
        ["yc"]
    );
    assert_eq!(entries(&s, "content_chunks"), 2);
    assert_eq!(entries(&s, "links"), 1);
    assert_eq!(entries(&s, "tags"), 1);
    assert_eq!(
        s.get_links("people/alice-example", &Default::default())
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn a_deleted_page_takes_its_chunks_links_tags_and_their_entries() {
    let s = linked_pages();
    let r = s
        .replace_relation_rows(SEED, "pages", 1, &[key(1, &[("id", "7")])], &[], &[])
        .unwrap();
    assert_eq!((r.upserted, r.deleted), (0, 1));
    assert!(read_page(&s, "people/alice-example").is_none());
    assert!(read_page(&s, "companies/acme-example").is_some());
    // Page 7's tag, chunk and link (it is the link's source) are gone, with their entries.
    assert_eq!(entries(&s, "pages"), 1);
    assert_eq!(entries(&s, "tags"), 0);
    assert_eq!(entries(&s, "links"), 0);
    // Page 9's chunk stays.
    assert_eq!(entries(&s, "content_chunks"), 1);
    assert!(
        s.get_links("companies/acme-example", &Default::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_deleted_page_takes_its_chronicle_ledger_rows_and_their_entries() {
    let s = linked_pages();
    let ledger = |page: &str, hash: &str| {
        row(&[
            ("source_id", "default"),
            ("page_id", page),
            ("content_hash", hash),
            ("extractor_version", "2"),
            ("slug", "people/alice-example"),
            ("state", "pending"),
            ("trigger", "backfill"),
            ("decided_at", "2026-03-01 00:00:00+00"),
            ("updated_at", "2026-03-01 00:00:00+00"),
        ])
    };
    s.import_relation_with_digests(
        SEED,
        "chronicle_page_state",
        vec![ledger("7", "abc123"), ledger("9", "def456")],
        &[dig(1), dig(2)],
    )
    .unwrap();
    assert_eq!(entries(&s, "chronicle_page_state"), 2);
    s.replace_relation_rows(SEED, "pages", 1, &[key(1, &[("id", "7")])], &[], &[])
        .unwrap();
    // Page 7's ledger row goes with it, as ON DELETE CASCADE removes it; page 9's stays.
    assert_eq!(entries(&s, "chronicle_page_state"), 1);
    let read = |page: i64, hash: &str| {
        s.read_chronicle_row(&crate::chronicle_state::ChronicleRowKey {
            source_id: "default".into(),
            page_id: page,
            content_hash: hash.into(),
            extractor_version: 2,
        })
        .unwrap()
    };
    assert!(read(7, "abc123").is_none());
    assert!(read(9, "def456").is_some());
}

#[test]
fn deleting_the_page_a_link_points_to_removes_the_link_too() {
    let s = linked_pages();
    s.replace_relation_rows(SEED, "pages", 1, &[key(2, &[("id", "9")])], &[], &[])
        .unwrap();
    assert_eq!(entries(&s, "links"), 0);
    assert_eq!(entries(&s, "content_chunks"), 1);
    assert!(
        s.get_links("people/alice-example", &Default::default())
            .unwrap()
            .is_empty()
    );
}

// ---- replaceInterval -------------------------------------------------------------------------

#[test]
fn an_interval_replace_removes_the_entries_the_primary_no_longer_holds() {
    let s = seeded_config();
    s.import_relation_with_digests(SEED, "config", vec![config_row("c", "3")], &[dig(3)])
        .unwrap();
    // The primary now holds, in [01, 03): a changed `a` and nothing else. `c` (03) is outside.
    let r = s
        .replace_interval(
            SEED,
            "config",
            1,
            Some("01"),
            Some("03"),
            &[config_row("a", "changed")],
            &[digv(1, 11)],
        )
        .unwrap();
    assert_eq!((r.upserted, r.deleted), (1, 1));
    assert_eq!(s.get_config("a").unwrap().as_deref(), Some("changed"));
    assert_eq!(s.get_config("b").unwrap(), None);
    assert_eq!(s.get_config("c").unwrap().as_deref(), Some("3"));
    assert_eq!(entries(&s, "config"), 2);
    // Unbounded on both sides replaces the whole relation.
    let r = s
        .replace_interval(SEED, "config", 2, None, None, &[], &[])
        .unwrap();
    assert_eq!(r.deleted, 2);
    assert_eq!(entries(&s, "config"), 0);
}

#[test]
fn an_interval_replace_skips_entries_of_a_later_generation() {
    let s = seeded_config();
    s.replace_relation_rows(
        SEED,
        "config",
        7,
        &[key(2, &[("key", "b")])],
        &[config_row("b", "newer")],
        &[digv(2, 12)],
    )
    .unwrap();
    let r = s
        .replace_interval(SEED, "config", 3, None, None, &[], &[])
        .unwrap();
    assert_eq!((r.deleted, r.skipped_older), (1, 1));
    assert_eq!(s.get_config("b").unwrap().as_deref(), Some("newer"));
}

#[test]
fn an_interval_replace_refuses_a_row_outside_the_interval() {
    let s = seeded_config();
    let err = s
        .replace_interval(
            SEED,
            "config",
            1,
            Some("01"),
            Some("02"),
            &[config_row("b", "x")],
            &[dig(2)],
        )
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert_eq!(s.get_config("b").unwrap().as_deref(), Some("2"));
}

#[test]
fn a_failed_interval_replace_leaves_the_store_as_it_was() {
    let s = linked_pages();
    let before = (entries(&s, "pages"), digest_of(&s, "content_chunks"));
    // The first row is fine (a deletion of page 9 by omission); the chunk of a page that does not
    // exist fails the call after it.
    let err = s
        .replace_interval(
            SEED,
            "content_chunks",
            1,
            None,
            None,
            &[chunk_row("50", "404", "0", "orphan")],
            &[dig(50)],
        )
        .unwrap_err();
    assert_eq!(err.code, crate::error::PAGE_NOT_FOUND);
    assert_eq!(digest_of(&s, "content_chunks"), before.1);
    assert_eq!(entries(&s, "pages"), before.0);
    assert!(read_page(&s, "companies/acme-example").is_some());
}

#[test]
fn every_dependent_column_a_delete_matches_on_is_in_the_dependents_identity() {
    for (parent, dependents) in super::DEPENDENTS {
        for (dependent, links) in *dependents {
            let spec = super::follow_spec(dependent).unwrap_or_else(|| panic!("{dependent}"));
            for (column, _) in *links {
                assert!(
                    spec.identity.contains(column),
                    "{dependent}.{column} (a child of {parent}) is not in its digest identity"
                );
            }
        }
    }
}

// ---- one round trip per relation -------------------------------------------------------------

fn chunk_symbol_row(id: &str, index: &str, symbol: &str) -> SeedRow {
    row(&[
        ("id", id),
        ("page_id", "7"),
        ("chunk_index", index),
        ("chunk_text", &format!("fn {symbol}() {{}}")),
        ("chunk_source", "compiled_truth"),
        ("symbol_name", symbol),
        ("model", "openai:text-embedding-3-large"),
    ])
}

fn edge_row(id: &str, to: Option<&str>, to_symbol: &str) -> SeedRow {
    let mut r = row(&[
        ("id", id),
        ("from_chunk_id", "41"),
        ("from_symbol_qualified", "a.run"),
        ("to_symbol_qualified", to_symbol),
        ("edge_type", "calls"),
        ("edge_metadata", r#"{"line": 3}"#),
        ("source_id", "default"),
        ("created_at", "2026-04-01 00:00:00.75+00"),
    ]);
    if let Some(to) = to {
        r.insert("to_chunk_id".into(), Some(to.into()));
    }
    r
}

/// One fixture row per relation (two pages, two chunks), in the order the seed imports them. Each
/// row imports on a store that holds the fixtures before it.
fn fixtures() -> Vec<(&'static str, Vec<SeedRow>)> {
    let mut timestamp_nullable = row(&[("token_name", "alice")]);
    timestamp_nullable.insert("requests".into(), Some("7".into()));
    vec![
        (
            "sources",
            vec![row(&[
                ("id", "wiki"),
                ("name", "Wiki"),
                ("local_path", "/brain/wiki"),
                ("config", r#"{"federated": false}"#),
                ("archived", "f"),
                ("incarnation", INCARNATION),
                ("created_at", "2025-12-31 23:59:59+00"),
            ])],
        ),
        ("config", vec![config_row("embedding_dimensions", "1536")]),
        (
            "pages",
            vec![
                page_row("7", "people/alice-example"),
                page_row("9", "companies/acme-example"),
            ],
        ),
        (
            "tags",
            vec![row(&[("id", "1"), ("page_id", "7"), ("tag", "yc")])],
        ),
        (
            "content_chunks",
            vec![
                chunk_symbol_row("41", "0", "run"),
                chunk_symbol_row("42", "1", "helper"),
            ],
        ),
        ("links", vec![link_row("31", "7", "9")]),
        (
            "timeline_entries",
            vec![row(&[
                ("id", "12"),
                ("page_id", "7"),
                ("date", "2026-05-06"),
                ("source", "meeting"),
                ("summary", "Raised a seed round"),
                ("detail", ""),
                ("event_page_id", "9"),
                ("created_at", "2026-05-06 10:00:00+00"),
                ("trust_tier", "unknown"),
            ])],
        ),
        (
            "slug_aliases",
            vec![row(&[
                ("id", "1"),
                ("source_id", "default"),
                ("alias_slug", "people/alice"),
                ("canonical_slug", "people/alice-example"),
                ("notes", "renamed"),
            ])],
        ),
        (
            "page_aliases",
            vec![row(&[
                ("id", "1"),
                ("source_id", "default"),
                ("alias_norm", "alice"),
                ("slug", "people/alice-example"),
                ("origin", "frontmatter"),
                ("case_sensitive", "f"),
            ])],
        ),
        (
            "facts",
            vec![row(&[
                ("id", "501"),
                ("source_id", "default"),
                ("entity_slug", "people/alice-example"),
                ("fact", "Alice founded acme"),
                ("kind", "fact"),
                ("visibility", "world"),
                ("notability", "high"),
                ("valid_from", "2026-01-01 00:00:00+00"),
                ("source", "meeting"),
                ("confidence", "0.9"),
                ("created_at", "2026-01-01 12:00:00+00"),
                ("trust_tier", "user_confirmed"),
                ("write_origin", r#"{"kind": "mcp"}"#),
                ("write_request_id", "req-1"),
            ])],
        ),
        (
            "takes",
            vec![row(&[
                ("id", "61"),
                ("page_id", "7"),
                ("row_num", "1"),
                ("claim", "Widgets win"),
                ("kind", "bet"),
                ("holder", "people/alice-example"),
                ("weight", "0.8"),
                ("since_date", "2026-01"),
                ("active", "t"),
                ("created_at", "2026-01-05 00:00:00+00"),
                ("updated_at", "2026-01-06 00:00:00+00"),
            ])],
        ),
        (
            "owner_only_marks",
            vec![row(&[("row_table", "pages"), ("row_id", "7")])],
        ),
        (
            "slug_rename_history",
            vec![row(&[
                ("source_id", "default"),
                ("old_slug", "people/al"),
                ("new_slug", "people/alice"),
            ])],
        ),
        (
            "fact_withdrawals",
            vec![row(&[
                ("source_id", "default"),
                ("visibility", "private"),
                ("subject", "*"),
                ("fact_hash", &sha256_hex("owes acme money")),
                ("withdrawn_at", "2026-03-04 05:06:07.123456+00"),
            ])],
        ),
        (
            "page_purges",
            vec![row(&[
                ("source_id", "default"),
                ("content_hash", "h1"),
                ("slug", "early"),
                ("request_id", "0a1b2c3d-0000-4000-8000-00000000000a"),
                ("purged_at", "1970-01-01 00:00:00+00"),
            ])],
        ),
        (
            "oauth_clients",
            vec![row(&[
                ("client_id", "c-agent"),
                ("client_name", "Agent One"),
                ("scope", "read agent"),
                ("budget_usd_per_day", "5.00"),
                ("client_secret_hash", "abc"),
                ("redirect_uris", "{https://example.test/cb}"),
                ("grant_types", "{client_credentials}"),
                ("federated_read", "{}"),
                ("bound_max_concurrent", "1"),
                ("grant_revision", "0"),
                ("private_pages", "none"),
                ("created_at", "2026-01-02 03:04:05+00"),
            ])],
        ),
        (
            "guest_sources",
            vec![row(&[
                ("source_id", "default"),
                ("writers", "{oauth_client:broker-a}"),
                ("trust_ceiling", "external_untrusted"),
                ("created_at", "2026-01-02 03:04:05+00"),
            ])],
        ),
        (
            "guest_marks",
            vec![row(&[
                ("page_id", "7"),
                ("source_id", "default"),
                ("slug_at_write", "people/alice-example"),
                ("audience_member", "alice-example"),
                ("group_slug", "team-a"),
                ("sender_label", "Agent One"),
                ("saved_at", "2026-01-02 03:04:05+00"),
                ("writer_kind", "oauth_client"),
                ("writer_id", "broker-a"),
                ("request_id", "00000000-0000-4000-8000-000000000001"),
                ("created_at", "2026-01-02 03:04:05+00"),
            ])],
        ),
        (
            "guest_promotions",
            vec![row(&[
                ("id", "5"),
                ("guest_page_id", "7"),
                ("target_source_id", "default"),
                ("target_slug", "people/alice-kept"),
                ("promoted_by_kind", "cli"),
                ("promoted_by_id", "local"),
                ("promoted_at", "2026-01-03 03:04:05+00"),
                ("request_id", "00000000-0000-4000-8000-000000000002"),
            ])],
        ),
        (
            "page_versions",
            vec![row(&[
                ("id", "31"),
                ("page_id", "7"),
                ("compiled_truth", "Alice v1"),
                ("frontmatter", r#"{"role": "founder"}"#),
                ("snapshot_at", "2026-02-01 10:00:00.25+00"),
                ("content_hash", "h1"),
                ("source_path", "people/alice.md"),
                ("knowledge_revision", REV),
                ("timeline", "- 2026-01-01: joined"),
                ("title", "Alice Example"),
                ("type", "person"),
                ("tags", r#"["b", "a"]"#),
                ("is_deleted", "f"),
                ("trust_tier", "user_confirmed"),
                ("write_origin", r#"{"kind": "cli"}"#),
                ("change_reason", "edited"),
                ("successor_pruned", "t"),
                ("body_storage", "inline"),
            ])],
        ),
        (
            "files",
            vec![row(&[
                ("id", "51"),
                ("source_id", "default"),
                ("page_id", "7"),
                ("page_slug", "people/alice-example"),
                ("filename", "a.png"),
                ("storage_path", "files/a.png"),
                ("mime_type", "image/png"),
                ("size_bytes", "2048"),
                ("content_hash", "sha"),
                ("metadata", r#"{"width": 10}"#),
                ("created_at", "2026-03-01 00:00:00.5+00"),
            ])],
        ),
        (
            "raw_data",
            vec![row(&[
                ("id", "5"),
                ("page_id", "7"),
                ("source", "crustdata"),
                ("data", r#"{"name": "Alice", "n": 1}"#),
                ("fetched_at", "2026-03-05 06:07:08.5+00"),
            ])],
        ),
        (
            "code_edges_chunk",
            vec![edge_row("11", Some("42"), "b.helper")],
        ),
        ("code_edges_symbol", vec![edge_row("21", None, "ext.log")]),
        (
            "open_loops",
            vec![row(&[
                ("id", "1"),
                ("source_id", "default"),
                ("dedup_key", "loop-1"),
                ("loop_type", "commitment_owed_by_me"),
                ("counterparty_slug", "people/alice-example"),
                ("counterparty_source_id", "default"),
                ("summary", "Send the deck"),
                ("evidence", r#"[{"msg": 1}]"#),
                ("page_slug", "people/alice-example"),
                ("due_at", "2026-06-01 00:00:00+00"),
                ("status", "done"),
                ("detector", "llm_extract"),
                ("confidence", "0.7"),
                ("fact_id", "501"),
                ("opened_at", "2026-05-01 08:00:00+00"),
                ("last_activity_at", "2026-05-02 09:00:00+00"),
                ("closed_at", "2026-05-03 10:00:00+00"),
                ("closed_by", "manual"),
                ("created_at", "2026-05-01 08:00:01+00"),
                ("updated_at", "2026-05-03 10:00:01+00"),
            ])],
        ),
        (
            "synthesis_evidence",
            vec![row(&[
                ("synthesis_page_id", "9"),
                ("take_page_id", "7"),
                ("take_row_num", "1"),
                ("citation_index", "2"),
                ("created_at", "2026-05-06 07:08:09.5+00"),
            ])],
        ),
        (
            "trust_proposals",
            vec![row(&[
                ("id", "81"),
                ("action", "forget"),
                ("source_id", "default"),
                ("target_table", "facts"),
                ("target_id", "5"),
                ("related_table", "facts"),
                ("related_id", "9"),
                ("before_state", r#"{"visibility": "world"}"#),
                ("after_state", r#"{"visibility": "private"}"#),
                ("proposer", "fence_projection"),
                ("proposer_principal_kind", "token"),
                ("proposer_principal_id", "tok-1"),
                ("write_request_id", REV),
                ("status", "pending"),
                ("created_at", "2026-07-01 00:00:00+00"),
                ("updated_at", "2026-07-02 00:00:00+00"),
            ])],
        ),
        (
            "wanted_links",
            vec![row(&[
                ("id", "101"),
                ("origin_page_id", "7"),
                ("source_id", "default"),
                ("producer", "body"),
                ("ref_kind", "name"),
                ("target_source_id", "default"),
                ("target_ref", "Bob Example"),
                ("link_type", "mentions"),
                ("context", "see [[x]]"),
                ("checked_at", "2026-08-02 00:00:00+00"),
                ("first_seen_at", "2026-08-01 00:00:00.5+00"),
            ])],
        ),
        (
            "page_facts_reconcile",
            vec![row(&[
                ("page_id", "9"),
                ("reconciled_revision", REV),
                ("reconciled_at", "2026-09-01 00:00:00+00"),
                ("outcome", "complete"),
                ("attempted_revision", REV),
                ("attempted_at", "2026-09-01 00:00:00.5+00"),
            ])],
        ),
        (
            "fact_relink_attempts",
            vec![row(&[
                ("source_id", "default"),
                ("fact_id", "501"),
                ("outcome", "linked"),
                ("reason", "because"),
                ("tier", "paid_reextract"),
                ("model", "m-1"),
                ("target_slug", "people/alice-example"),
                ("run_id", "run-1"),
                ("attempted_at", "2020-01-01 00:00:00+00"),
            ])],
        ),
        (
            "derived_generations",
            vec![row(&[
                ("id", "301"),
                ("source_id", "default"),
                ("kind", "fence"),
                ("owner_key", "page:people/alice-example"),
                ("generation", "4"),
                ("state", "live"),
                ("run_id", "run-1"),
                ("operation_id", "op-1"),
                ("input_pin", "pin"),
                ("completeness", "{}"),
                ("item_set_hash", "hash"),
                ("attempts", "0"),
                ("created_at", "2026-10-01 00:00:00.5+00"),
                ("updated_at", "2026-10-02 00:00:00+00"),
            ])],
        ),
        (
            "derived_generation_items",
            vec![row(&[
                ("generation_id", "301"),
                ("item_key", "fact:9"),
                ("identity_hash", "id-hash"),
                ("action", "kept"),
                ("pending", "f"),
            ])],
        ),
        (
            "mcp_spend_log",
            vec![row(&[
                ("id", "41"),
                ("client_id", "c-agent"),
                ("token_name", "tok"),
                ("operation", "image_query"),
                ("spend_cents", "12.5000"),
                ("provider", "openai"),
                ("model", "gpt-image"),
                ("created_at", "2026-05-01 10:00:00.5+00"),
            ])],
        ),
        (
            "mcp_spend_reservations",
            vec![row(&[
                ("reservation_id", R_LIVE),
                ("client_id", "c-agent"),
                ("estimated_cents", "10.0000"),
                ("model", "m"),
                ("provider", "p"),
                ("status", "pending"),
                ("created_at", "2026-05-01 10:00:00+00"),
                ("expires_at", "2999-01-01 00:00:00+00"),
                ("estimate_known", "t"),
            ])],
        ),
        (
            "decide_state",
            vec![row(&[
                ("key", "reranker_owner"),
                ("value", "alpha"),
                ("updated_at", "2026-03-01 10:00:00.5+00"),
            ])],
        ),
        (
            "decide_spend",
            vec![row(&[
                ("request_id", "req-a"),
                ("created_at", "2026-03-01 00:00:00+00"),
                ("source_id", "default"),
                ("slot", "conflict"),
                ("provider", "typesafe:anthropic"),
                ("model_resolved", "claude-x"),
                ("lane", "main"),
                ("remote", "t"),
                ("input_tokens", "100"),
                ("cost_usd", "0.25"),
                ("outcome", "kept"),
            ])],
        ),
        (
            "decide_calibrations",
            vec![row(&[
                ("id", "1"),
                ("slot", "conflict"),
                ("call_site", "sweep"),
                ("provider", "anthropic"),
                ("model_resolved", "claude-x"),
                ("threshold", "0.3"),
                ("min_keep", "2"),
                ("metric", "f1"),
                ("metric_value", "0.875"),
                ("n", "120"),
                ("calibrate_only", "f"),
                ("pack_shape", "default"),
                ("created_at", "2026-03-04 00:00:00+00"),
                ("qualification", "pass"),
                ("qualified_at", "2026-03-05 00:00:00+00"),
                ("action_precision_lb", "0.9"),
                ("policy_fingerprint", "fp1"),
                ("notes", "first run"),
            ])],
        ),
        (
            "decision_receipts",
            vec![row(&[
                ("id", "1"),
                ("decision_id", "d-1"),
                ("created_at", "2026-03-01 00:00:00+00"),
                ("source_id", "default"),
                ("slot", "conflict"),
                ("mode", "live"),
                ("provider", "anthropic"),
                ("answer_value", "0.75"),
                ("outcome", "kept"),
                ("call_site", "sweep"),
                ("lane", "main"),
                ("latency_ms", "120"),
                ("input_tokens", "30"),
                ("protected", "f"),
                ("remote", "t"),
            ])],
        ),
        (
            "decide_proposals",
            vec![row(&[
                ("id", "1"),
                ("created_at", "2026-03-01 08:00:00.5+00"),
                ("source_id", "default"),
                ("sweep_id", "sweep-1"),
                ("pair_index", "0"),
                ("new_fact_id", "501"),
                ("old_fact_id", "502"),
                ("direction", "new_supersedes_old"),
                ("p_supersede", "0.25"),
                ("threshold", "0.5"),
                ("proposal_floor", "0.1"),
                ("model_resolved", "claude-x"),
                ("status", "accepted"),
                ("decided_at", "2026-03-02 09:00:00+00"),
                ("before_state", "before"),
                ("after_state", "after"),
            ])],
        ),
        (
            "decide_sweep_deferred",
            vec![row(&[
                ("source_id", "default"),
                ("fact_id", "30"),
                ("slot", "conflict"),
                ("reason", "rate_limited"),
                ("attempts", "2"),
                ("next_attempt_at", "2026-03-01 00:00:00+00"),
                ("created_at", "2026-03-01 00:00:00+00"),
            ])],
        ),
        (
            "decide_review_proposals",
            vec![row(&[
                ("id", "11"),
                ("created_at", "2026-03-01 08:00:00+00"),
                ("kind", "withdraw"),
                ("source_id", "default"),
                ("sweep_id", "sweep-1"),
                ("a_ref", "fact:1"),
                ("b_ref", "*"),
                ("subject", "*"),
                ("visibility", "world"),
                ("p_action", "0.8"),
                ("status", "pending"),
                ("receipt", "r-1"),
            ])],
        ),
        (
            "decide_review_queue",
            vec![row(&[
                ("kind", "withdraw"),
                ("source_id", "default"),
                ("a_ref", "fact:1"),
                ("b_ref", "*"),
                ("evidence", "e"),
                ("reason", "queued"),
                ("attempts", "2"),
                ("next_attempt_at", "2026-03-01 00:00:00+00"),
                ("created_at", "2026-03-01 00:00:00+00"),
            ])],
        ),
        (
            "calibration_profiles",
            vec![row(&[
                ("id", "21"),
                ("source_id", "default"),
                ("holder", "people/alice-example"),
                ("wave_version", "v0.36.1.0"),
                ("generated_at", "2026-03-01 00:00:00+00"),
                ("published", "t"),
                ("total_resolved", "40"),
                ("brier", "0.3"),
                ("accuracy", "0.75"),
                ("grade_completion", "1"),
                ("domain_scorecards", r#"{"work": {"n": 4}}"#),
                ("pattern_statements", r#"{"tends to be early","a, b"}"#),
                ("voice_gate_passed", "t"),
                ("voice_gate_attempts", "2"),
                ("active_bias_tags", "{overconfident}"),
                ("model_id", "claude-x"),
            ])],
        ),
        (
            "dream_synthesis_completions",
            vec![row(&[
                ("source_id", "default"),
                ("idempotency_key", "dream:synth-v2:abc"),
                ("completed_at", "2026-03-01 00:00:00+00"),
            ])],
        ),
        (
            "wake_crons",
            vec![row(&[
                ("name", "nightly"),
                ("created_at", "2026-03-01 00:00:00.5+00"),
            ])],
        ),
        (
            "wake_cron_runs",
            vec![row(&[
                ("id", "5"),
                ("name", "nightly"),
                ("status", "ok"),
                ("finished_at", "2026-03-02 00:00:00+00"),
            ])],
        ),
        (
            "wake_forgets",
            vec![row(&[
                ("id", "3"),
                ("wake_user", USER),
                ("state", "done"),
                ("attempts", "2"),
                ("next_attempt_at", "2026-03-01 00:00:00+00"),
                ("last_error", "boom"),
                ("created_at", "2026-02-01 00:00:00+00"),
                ("updated_at", "2026-02-02 00:00:00+00"),
            ])],
        ),
        (
            "wake_terms_acceptances",
            vec![row(&[
                ("principal_key", "member:alice"),
                ("terms_version", "0123456789abcdef"),
                ("accepted_at", "2026-03-01 00:00:00+00"),
            ])],
        ),
        (
            "mcp_request_log_rollup",
            vec![{
                timestamp_nullable
                    .insert("last_used_at".into(), Some("2026-03-01 00:00:00+00".into()));
                timestamp_nullable
            }],
        ),
        (
            "chronicle_page_state",
            vec![row(&[
                ("source_id", "default"),
                ("page_id", "7"),
                ("content_hash", "abc123"),
                ("extractor_version", "2"),
                ("slug", "people/alice-example"),
                ("state", "extracted"),
                ("trigger", "auto"),
                ("attempts", "1"),
                ("event_slugs", "{events/a-example}"),
                ("event_hashes", "{h1}"),
                ("cost_attempts", "{1}"),
                ("decided_at", "2026-03-01 00:00:00+00"),
                ("updated_at", "2026-03-01 00:00:01+00"),
            ])],
        ),
    ]
}

const USER: &str = "0123456789abcdef0123456789abcdef";
const R_LIVE: &str = "01a1efa3-9ee6-701e-ada3-d202d5776740";

/// Every stored entry but the store's own bookkeeping (counters, the manifest, digest entries).
fn snapshot(s: &Store) -> Vec<(Vec<u8>, Vec<u8>)> {
    let read = s.read().unwrap();
    let mut out = Vec::new();
    crate::kv::KvRead::scan(&*read, &[], &[0xFF; 64], false, &mut |k, v| {
        // The sequences the store keeps for ids are not rows: `M…` and the jobs family's `m 00 …`.
        let sequence =
            k.first() == Some(&crate::keys::META) || k.starts_with(&[crate::keys::JOBS, 0]);
        if !sequence {
            out.push((k.to_vec(), v.to_vec()));
        }
        true
    })
    .unwrap();
    out
}

/// The entries `left` has and `right` lacks, printable and short.
fn only_in(left: &[(Vec<u8>, Vec<u8>)], right: &[(Vec<u8>, Vec<u8>)]) -> Vec<String> {
    left.iter()
        .filter(|entry| !right.contains(entry))
        .map(|(k, v)| {
            let line = format!(
                "{} = {}",
                String::from_utf8_lossy(k).escape_debug(),
                String::from_utf8_lossy(v).escape_debug()
            );
            line.chars().take(160).collect()
        })
        .collect()
}

/// Imports the rows of `relation` with digests, as the seed does.
fn import_with_digests(s: &Store, relation: &str, rows: &[SeedRow]) {
    let digests: Vec<DigestInput> = (0..rows.len() as u8).map(|n| dig(n + 1)).collect();
    s.import_relation_with_digests(SEED, relation, rows.to_vec(), &digests)
        .unwrap_or_else(|e| panic!("importing {relation}: {e:?}"));
}

#[test]
fn every_relation_has_a_fixture_in_import_order() {
    let named: Vec<&str> = fixtures().iter().map(|(name, _)| *name).collect();
    let planned: Vec<&str> = plan().relations.iter().map(|r| r.relation).collect();
    let mut sorted = (named.clone(), planned.clone());
    sorted.0.sort_unstable();
    sorted.1.sort_unstable();
    assert_eq!(sorted.0, sorted.1);
}

#[test]
fn deleting_a_relations_rows_leaves_the_store_as_it_was_before_they_were_imported() {
    let relations = plan().relations;
    let all = fixtures();
    for (n, (relation, rows)) in all.iter().enumerate() {
        let spec = relations.iter().find(|r| r.relation == *relation).unwrap();
        let s = store();
        for (earlier, earlier_rows) in &all[..n] {
            import_with_digests(&s, earlier, earlier_rows);
        }
        let before = snapshot(&s);
        import_with_digests(&s, relation, rows);
        assert_eq!(entries(&s, relation), rows.len() as u64, "{relation}");
        let keys: Vec<KeyInput> = rows
            .iter()
            .zip(1..)
            .map(|(row, sort)| KeyInput {
                sort: hex(&[sort]),
                key: spec
                    .key
                    .iter()
                    .map(|c| {
                        let value = row
                            .get(*c)
                            .unwrap_or_else(|| panic!("{relation} fixture lacks key column {c}"));
                        (c.to_string(), value.clone().unwrap_or_default())
                    })
                    .collect(),
            })
            .collect();
        let result = s.replace_relation_rows(SEED, relation, 1, &keys, &[], &[]);
        if !spec.removable {
            assert_eq!(result.unwrap_err().code, UNSUPPORTED, "{relation}");
            continue;
        }
        let result = result.unwrap_or_else(|e| panic!("deleting {relation}: {e:?}"));
        assert_eq!(result.deleted, rows.len() as u64, "{relation}");
        assert_eq!(entries(&s, relation), 0, "{relation}");
        let after = snapshot(&s);
        assert_eq!(
            only_in(&after, &before),
            Vec::<String>::new(),
            "{relation}: left behind"
        );
        assert_eq!(
            only_in(&before, &after),
            Vec::<String>::new(),
            "{relation}: lost"
        );
    }
}

#[test]
fn every_fixture_row_has_the_primary_key_columns_of_its_relation() {
    let relations = plan().relations;
    let mut missing = Vec::new();
    for (relation, rows) in fixtures() {
        let spec = relations.iter().find(|r| r.relation == relation).unwrap();
        for column in spec.key {
            if rows.iter().any(|row| !row.contains_key(*column)) {
                missing.push(format!("{relation}.{column}"));
            }
        }
    }
    assert!(missing.is_empty(), "{missing:?}");
}

// ---- relationEntries -------------------------------------------------------------------------

fn entry_sorts(entries: &[crate::seed::EntryInfo]) -> Vec<String> {
    entries.iter().map(|e| e.sort.clone()).collect()
}

#[test]
fn entries_come_in_sort_order_within_the_half_open_interval_and_stop_at_the_limit() {
    let s = store();
    // Imported out of order, with sort keys of different lengths: 01, 0100, 02, 0200ff.
    let sorts = ["0200ff", "01", "02", "0100"];
    let digests: Vec<DigestInput> = sorts
        .iter()
        .enumerate()
        .map(|(n, sort)| DigestInput {
            sort: (*sort).to_owned(),
            digest: hex(&[n as u8 + 1; 32]),
        })
        .collect();
    let rows: Vec<SeedRow> = (0..4).map(|n| config_row(&format!("k{n}"), "v")).collect();
    s.import_relation_with_digests(SEED, "config", rows, &digests)
        .unwrap();
    let list = |lo: Option<&str>, hi: Option<&str>, limit: u64| {
        s.relation_entries(SEED, "config", lo, hi, limit).unwrap()
    };
    let all = list(None, None, 5000);
    assert_eq!(entry_sorts(&all), ["01", "0100", "02", "0200ff"]);
    // Each entry carries its digest and generation 0.
    assert_eq!(all[1].digest, hex(&[4; 32]));
    assert_eq!(all[1].generation, 0);
    // The limit keeps the first entries in order.
    assert_eq!(entry_sorts(&list(None, None, 2)), ["01", "0100"]);
    assert_eq!(entry_sorts(&list(None, None, 1)), ["01"]);
    // lo is inclusive, hi exclusive.
    assert_eq!(entry_sorts(&list(Some("0100"), Some("02"), 10)), ["0100"]);
    assert_eq!(
        entry_sorts(&list(Some("0100"), Some("0200ff"), 10)),
        ["0100", "02"]
    );
    assert_eq!(entry_sorts(&list(Some("02"), None, 10)), ["02", "0200ff"]);
    assert_eq!(
        entry_sorts(&list(None, Some("01"), 10)),
        Vec::<String>::new()
    );
    assert!(list(Some("02"), Some("02"), 10).is_empty());
    assert!(list(Some("03"), Some("01"), 10).is_empty());
    // The interval digest is over the same entries.
    assert_eq!(digest_of(&s, "config").0, 4);
}

#[test]
fn entries_report_the_generation_of_the_call_that_wrote_them() {
    let s = seeded_config();
    s.replace_relation_rows(
        SEED,
        "config",
        7,
        &[key(2, &[("key", "b")])],
        &[config_row("b", "changed")],
        &[digv(2, 9)],
    )
    .unwrap();
    let all = s.relation_entries(SEED, "config", None, None, 10).unwrap();
    assert_eq!(all.iter().map(|e| e.generation).collect::<Vec<_>>(), [0, 7]);
    assert_eq!(all[1].digest, hex(&[9; 32]));
}

#[test]
fn entries_refuse_a_limit_outside_1_to_5000_a_bad_bound_a_foreign_seed_and_an_unknown_relation() {
    let s = seeded_config();
    for limit in [0, 5001, u64::MAX] {
        let err = s
            .relation_entries(SEED, "config", None, None, limit)
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT, "limit {limit}");
    }
    assert!(s.relation_entries(SEED, "config", None, None, 5000).is_ok());
    assert!(s.relation_entries(SEED, "config", None, None, 1).is_ok());
    for bad in ["0", "zz", "0A"] {
        let err = s
            .relation_entries(SEED, "config", Some(bad), None, 10)
            .unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT, "{bad}");
    }
    let err = s
        .relation_entries(SEED, "nope", None, None, 10)
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    let err = s
        .relation_entries("seed-2", "config", None, None, 10)
        .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    let err = store()
        .relation_entries(SEED, "config", None, None, 10)
        .unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
}

// ---- allocatorCheck --------------------------------------------------------------------------

/// The store's id counters and sequences: `M<name>` and the jobs family's `m 00 <name>`.
fn sequences(s: &Store) -> Vec<(Vec<u8>, Vec<u8>)> {
    let read = s.read().unwrap();
    let mut out = Vec::new();
    crate::kv::KvRead::scan(&*read, &[], &[0xFF; 64], false, &mut |k, v| {
        let counter =
            (k.first() == Some(&crate::keys::META) && !k.starts_with(b"Mshadow") && v.len() == 8)
                || k.starts_with(&[crate::keys::JOBS, 0]);
        if counter {
            out.push((k.to_vec(), v.to_vec()));
        }
        true
    })
    .unwrap();
    out
}

fn maxima(pairs: &[(&str, Option<&str>)]) -> std::collections::BTreeMap<String, Option<String>> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.map(str::to_owned)))
        .collect()
}

fn check_of(s: &Store, relation: &str, max: Option<&str>) -> crate::seed::AllocatorCheck {
    s.allocator_check(SEED, &maxima(&[(relation, max)]))
        .unwrap()
        .into_iter()
        .find(|c| c.relation == relation)
        .unwrap_or_else(|| panic!("{relation} is not checked"))
}

/// A fixture row with its id moved to `id`.
fn with_id(row: &SeedRow, id: u64) -> SeedRow {
    let mut moved = row.clone();
    moved.insert("id".into(), Some(id.to_string()));
    moved
}

#[test]
fn the_relations_the_check_covers_are_exactly_the_ones_whose_import_raises_a_counter() {
    let all = fixtures();
    let counted = super::allocators::counted_relations();
    for (n, (relation, rows)) in all.iter().enumerate() {
        let s = store();
        for (earlier, earlier_rows) in &all[..n] {
            import_with_digests(&s, earlier, earlier_rows);
        }
        let before = sequences(&s);
        import_with_digests(&s, relation, rows);
        // `decide_spend` numbers its time-index entries; it has no integer id the primary could reuse.
        let raised = sequences(&s) != before && *relation != "decide_spend";
        assert_eq!(
            raised,
            counted.contains(relation),
            "{relation}: the import {} a counter, the check {} it",
            if raised { "raises" } else { "leaves" },
            if counted.contains(relation) {
                "covers"
            } else {
                "omits"
            },
        );
        if !raised {
            continue;
        }
        // The counter the check reads is the one the import raised: above every fixture id, not above
        // a higher one.
        let top = rows
            .iter()
            .map(|r| {
                r.get("id")
                    .unwrap()
                    .clone()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
            })
            .max()
            .unwrap();
        let ok = check_of(&s, relation, Some(&top.to_string()));
        assert!(ok.ok, "{relation}: {ok:?}");
        assert!(ok.counter.parse::<u64>().unwrap() > top, "{relation}");
        let counter = ok.counter.clone();
        let not_ok = check_of(&s, relation, Some(&counter));
        assert!(!not_ok.ok, "{relation}: {not_ok:?}");
        assert_eq!(not_ok.primary_max.as_deref(), Some(counter.as_str()));
    }
}

#[test]
fn the_check_reports_the_next_id_as_text_and_passes_an_empty_table() {
    let s = linked_pages();
    let report = s.allocator_check(SEED, &maxima(&[])).unwrap();
    let pages = report.iter().find(|c| c.relation == "pages").unwrap();
    assert_eq!(pages.counter, "10");
    assert_eq!(pages.primary_max, None);
    assert!(pages.ok);
    // Reported in import order, only for relations that keep a counter: not tags or config.
    let names: Vec<&str> = report.iter().map(|c| c.relation.as_str()).collect();
    assert_eq!(&names[..3], ["pages", "content_chunks", "links"]);
    assert!(!names.contains(&"tags") && !names.contains(&"config"));
    // A counter nothing raised starts at 1.
    let untouched = report.iter().find(|c| c.relation == "facts").unwrap();
    assert_eq!(untouched.counter, "1");
    // At and above the counter is not ok; below is.
    assert!(!check_of(&s, "pages", Some("10")).ok);
    assert!(!check_of(&s, "pages", Some("11")).ok);
    assert!(check_of(&s, "pages", Some("9")).ok);
    // An explicit null is an empty table; a very large id does not overflow.
    assert!(check_of(&s, "pages", None).ok);
    assert!(!check_of(&s, "pages", Some("9223372036854775807")).ok);
}

#[test]
fn a_jobs_sequence_reports_the_next_id_not_the_last_one() {
    let s = store();
    let all = fixtures();
    for (relation, rows) in &all {
        import_with_digests(&s, relation, rows);
    }
    let spend_id = all
        .iter()
        .find(|(r, _)| *r == "mcp_spend_log")
        .map(|(_, rows)| rows[0].get("id").unwrap().clone().unwrap())
        .unwrap();
    let next = spend_id.parse::<u64>().unwrap() + 1;
    let c = check_of(&s, "mcp_spend_log", Some(&spend_id));
    assert_eq!(c.counter, next.to_string());
    assert!(c.ok);
    assert!(!check_of(&s, "mcp_spend_log", Some(&next.to_string())).ok);
    let fresh = seeded_config();
    assert_eq!(check_of(&fresh, "wake_forgets", None).counter, "1");
}

#[test]
fn the_check_refuses_an_unknown_relation_a_bad_id_a_foreign_seed_and_an_unseeded_store() {
    let s = seeded_config();
    for bad in [
        maxima(&[("nope", Some("1"))]),
        maxima(&[("pages", Some("abc"))]),
        maxima(&[("pages", Some("-1"))]),
        maxima(&[("pages", Some("1.5"))]),
        maxima(&[("pages", Some(""))]),
        maxima(&[("pages", Some("18446744073709551616"))]),
    ] {
        let err = s.allocator_check(SEED, &bad).unwrap_err();
        assert_eq!(err.code, INVALID_ARGUMENT, "{bad:?}");
    }
    let err = s.allocator_check("seed-2", &maxima(&[])).unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    let err = store().allocator_check(SEED, &maxima(&[])).unwrap_err();
    assert_eq!(err.code, INVALID_STATE);
    let err = s.allocator_check("", &maxima(&[])).unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    // A relation with no counter may be named: it is not reported.
    let report = s
        .allocator_check(SEED, &maxima(&[("tags", Some("5")), ("config", None)]))
        .unwrap();
    assert!(
        report
            .iter()
            .all(|c| c.relation != "tags" && c.relation != "config")
    );
}

#[test]
fn the_check_reads_only() {
    let s = linked_pages();
    let before = snapshot(&s);
    let counters = sequences(&s);
    s.allocator_check(SEED, &maxima(&[("pages", Some("3"))]))
        .unwrap();
    s.relation_entries(SEED, "pages", None, None, 10).unwrap();
    assert_eq!(snapshot(&s), before);
    assert_eq!(sequences(&s), counters);
}

#[test]
fn a_follow_upsert_of_a_row_above_the_counter_raises_the_counter_past_it() {
    let relations = plan().relations;
    let all = fixtures();
    let counted = super::allocators::counted_relations();
    assert!(!counted.is_empty());
    for relation in counted {
        let n = all.iter().position(|(r, _)| *r == relation).unwrap();
        let rows = &all[n].1;
        let spec = relations.iter().find(|r| r.relation == relation).unwrap();
        let fresh_world = || {
            let s = store();
            for (earlier, earlier_rows) in &all[..n] {
                import_with_digests(&s, earlier, earlier_rows);
            }
            s
        };
        let high = 5000 + n as u64;
        let moved: Vec<SeedRow> = rows.iter().map(|r| with_id(r, high)).collect();
        let moved = &moved[..1];
        let keys: Vec<KeyInput> = vec![KeyInput {
            sort: hex(&[1]),
            key: spec
                .key
                .iter()
                .map(|c| {
                    let value = moved[0].get(*c).unwrap().clone().unwrap_or_default();
                    (c.to_string(), value)
                })
                .collect(),
        }];
        // replaceRelationRows
        let s = fresh_world();
        let r = s
            .replace_relation_rows(SEED, relation, 1, &keys, moved, &[dig(1)])
            .unwrap_or_else(|e| panic!("{relation}: {e:?}"));
        assert_eq!(r.upserted + r.dropped, 1, "{relation}: {r:?}");
        let c = check_of(&s, relation, Some(&high.to_string()));
        assert!(
            c.ok,
            "replaceRelationRows left the {relation} counter at {}",
            c.counter
        );
        // replaceInterval
        let s = fresh_world();
        let r = s
            .replace_interval(SEED, relation, 1, None, None, moved, &[dig(1)])
            .unwrap_or_else(|e| panic!("{relation}: {e:?}"));
        assert_eq!(r.upserted + r.dropped, 1, "{relation}: {r:?}");
        let c = check_of(&s, relation, Some(&high.to_string()));
        assert!(
            c.ok,
            "replaceInterval left the {relation} counter at {}",
            c.counter
        );
    }
}

#[test]
fn a_chunk_the_store_drops_still_moves_the_counter_past_its_id() {
    let s = linked_pages();
    let mut retired = chunk_row("900", "7", "5", "An old chunk.");
    retired.insert("retired_generation".into(), Some("3".into()));
    let r = s
        .import_relation_with_digests(SEED, "content_chunks", vec![retired], &[dig(9)])
        .unwrap();
    assert_eq!(r.dropped, 1);
    assert!(check_of(&s, "content_chunks", Some("900")).ok);
    let mut segment = chunk_row("950", "7", "6", "A segment chunk.");
    segment.insert("occurrence_id".into(), Some("12".into()));
    let r = s
        .replace_relation_rows(
            SEED,
            "content_chunks",
            1,
            &[key(10, &[("id", "950")])],
            &[segment],
            &[dig(10)],
        )
        .unwrap();
    assert_eq!(r.dropped, 1);
    assert!(check_of(&s, "content_chunks", Some("950")).ok);
}
