//! The doctor page reads (`cli_reads/doctor_pages.rs`): the PGLite semantics of each.

use gbrain_store::env::uuid_from_bytes;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{Env, OpenOptions, Store};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

static NEXT: AtomicU32 = AtomicU32::new(0);

struct Clock(AtomicU64);

impl Env for Clock {
    fn now_micros(&self) -> i64 {
        1_800_000_000_000_000
    }
    fn new_uuid(&self) -> String {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        let mut bytes = [0u8; 16];
        bytes[8..].copy_from_slice(&n.to_be_bytes());
        uuid_from_bytes(bytes)
    }
}

fn brain(name: &str) -> Store {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "doctor-pages-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let kv = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    Store::open_kv(
        kv,
        Arc::new(Clock(AtomicU64::new(1))),
        OpenOptions::default(),
    )
    .unwrap()
}

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

/// Writes a page from the fields of `input` (a JSON object merged over type, title and body) and returns its id.
fn put(s: &Store, slug: &str, input: Value) -> i64 {
    let mut base = json!({ "type": "note", "title": slug, "compiled_truth": "body" });
    for (k, v) in input.as_object().unwrap() {
        base[k] = v.clone();
    }
    let input: PageInput = args(base);
    s.put_page(slug, &input, &PutPageOptions::default())
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn slugs(rows: &[Value], key: &str) -> Vec<String> {
    rows.iter()
        .map(|r| r[key].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn oversized_pages_count_bytes_skip_marked_and_deleted_pages_and_sort_largest_first() {
    let s = brain("oversized");
    assert!(s.list_oversized_pages(10).unwrap().is_empty());
    put(&s, "notes/small", json!({ "compiled_truth": "tiny" }));
    put(
        &s,
        "notes/ascii",
        json!({ "compiled_truth": "a".repeat(60), "timeline": "t".repeat(11) }),
    );
    put(
        &s,
        "notes/multibyte",
        json!({ "compiled_truth": "é".repeat(40) }),
    );
    put(
        &s,
        "notes/biggest",
        json!({ "compiled_truth": "😀".repeat(25), "timeline": "日本" }),
    );
    put(
        &s,
        "notes/skipped",
        json!({ "compiled_truth": "x".repeat(500), "frontmatter": { "embed_skip": null } }),
    );
    put(
        &s,
        "notes/deleted",
        json!({ "compiled_truth": "x".repeat(300) }),
    );
    s.soft_delete_page("notes/deleted", None).unwrap();
    let rows = s.list_oversized_pages(60).unwrap();
    let got: Vec<(String, i64)> = rows
        .iter()
        .map(|r| {
            (
                r["slug"].as_str().unwrap().to_owned(),
                r["bytes"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            ("notes/biggest".to_owned(), 106),
            ("notes/multibyte".to_owned(), 80),
            ("notes/ascii".to_owned(), 71)
        ]
    );

    for i in 0..105 {
        put(
            &s,
            &format!("bulk/p{i:03}"),
            json!({ "compiled_truth": "z".repeat(1000) }),
        );
    }
    assert_eq!(
        s.list_oversized_pages(900).unwrap().len(),
        101,
        "one row past the list limit"
    );
}

#[test]
fn scraper_junk_candidates_come_newest_first_with_character_heads() {
    let s = brain("junk");
    put(
        &s,
        "notes/one",
        json!({ "compiled_truth": "😀".repeat(2100), "timeline": "é".repeat(1100), "frontmatter": { "a": { "b": [1, 2] } } }),
    );
    put(&s, "notes/two", json!({}));
    put(&s, "notes/gone", json!({}));
    s.soft_delete_page("notes/gone", None).unwrap();
    // Every write lands at the same instant here, so the newest id comes first.
    let limited = s.list_scraper_junk_candidates(Some(2)).unwrap();
    assert_eq!(slugs(&limited, "slug"), vec!["notes/two", "notes/one"]);
    let all = s.list_scraper_junk_candidates(None).unwrap();
    assert_eq!(all.len(), 2);
    let one = all.iter().find(|r| r["slug"] == "notes/one").unwrap();
    assert_eq!(one["body_head"].as_str().unwrap().chars().count(), 2048);
    assert_eq!(one["tl_head"].as_str().unwrap().chars().count(), 1024);
    assert_eq!(one["frontmatter"], json!({ "a": { "b": [1, 2] } }));
    assert_eq!(one["segmented"], json!(false));
    assert_eq!(s.count_live_segmented_pages(false).unwrap(), 0);
}

#[test]
fn marked_pages_count_the_key_even_with_a_null_value() {
    let s = brain("marked");
    put(
        &s,
        "notes/q1",
        json!({ "frontmatter": { "quarantine": { "reason": "junk" } } }),
    );
    put(
        &s,
        "notes/q2",
        json!({ "frontmatter": { "quarantine": null, "content_flag": "markup" } }),
    );
    put(
        &s,
        "notes/q3",
        json!({ "frontmatter": { "quarantine": "x" } }),
    );
    s.soft_delete_page("notes/q3", None).unwrap();
    put(&s, "notes/plain", json!({ "frontmatter": { "other": 1 } }));
    assert_eq!(s.count_marked_pages("quarantine").unwrap(), 2);
    assert_eq!(s.count_marked_pages("content_flag").unwrap(), 1);
    let err = s.count_marked_pages("pinned").unwrap_err();
    assert!(err.to_string().contains("not a page marker"), "{err}");
}

#[test]
fn raw_provenance_gaps_exempt_traces_raw_data_and_extract_atoms_origins() {
    let s = brain("provenance");
    assert_eq!(
        s.read_raw_provenance_gaps().unwrap(),
        json!({ "count": 0, "slugs": [] })
    );
    put(
        &s,
        "syn/gap-dream",
        json!({ "frontmatter": { "dream_generated": true } }),
    );
    put(&s, "syn/gap-type", json!({ "type": "synthesis" }));
    put(
        &s,
        "syn/gap-atom",
        json!({ "type": "atom", "frontmatter": { "dream_generated": true, "extracted_by": "someone", "source_slug": "x" } }),
    );
    put(
        &s,
        "syn/ok-source",
        json!({ "frontmatter": { "dream_generated": true, "raw_source": "n.md" } }),
    );
    put(
        &s,
        "syn/ok-exempt",
        json!({ "frontmatter": { "dream_generated": true, "raw_trace_exempt": true } }),
    );
    put(
        &s,
        "syn/ok-atom",
        json!({ "type": "atom", "frontmatter": { "dream_generated": true, "extracted_by": "extract_atoms_v2", "source_path": "a.md" } }),
    );
    put(
        &s,
        "syn/not-atom-prefix",
        json!({ "type": "atom", "frontmatter": { "dream_generated": true, "extracted_by": "extractXatoms", "source_path": "a.md" } }),
    );
    put(&s, "syn/ok-raw-data", json!({ "type": "synthesis" }));
    s.put_raw_data(
        "syn/ok-raw-data",
        Some("trace"),
        Some(r#"{"text":"raw"}"#),
        None,
    )
    .unwrap();
    let gaps = s.read_raw_provenance_gaps().unwrap();
    assert_eq!(gaps["count"], 4);
    assert_eq!(
        gaps["slugs"],
        json!([
            "syn/gap-atom",
            "syn/gap-dream",
            "syn/gap-type",
            "syn/not-atom-prefix"
        ])
    );
}

#[test]
fn unverified_extractions_use_the_creation_time_cutoff_and_the_source() {
    let s = brain("unverified");
    let stub = json!({ "frontmatter": { "provenance": "auto-extracted", "status": "unverified" } });
    put(&s, "people/stub-a", stub.clone());
    put(
        &s,
        "people/verified",
        json!({ "frontmatter": { "provenance": "auto-extracted", "status": "verified" } }),
    );
    assert_eq!(
        s.count_unverified_extractions(7.0, None).unwrap(),
        0,
        "created now, inside the window"
    );
    assert_eq!(s.count_unverified_extractions(-1.0, None).unwrap(), 1);
    assert_eq!(
        s.count_unverified_extractions(-1.0, Some("default"))
            .unwrap(),
        1
    );
    assert_eq!(
        s.count_unverified_extractions(-1.0, Some("elsewhere"))
            .unwrap(),
        0
    );
}

#[test]
fn content_hash_duplicates_group_by_source_and_hash_shortest_slug_first() {
    let s = brain("hash");
    assert!(s.list_content_hash_duplicates().unwrap().is_empty());
    for slug in ["dup/zz", "dup/a-long-name", "dup/b"] {
        put(&s, slug, json!({ "content_hash": "hash-a" }));
    }
    put(&s, "dup/solo", json!({ "content_hash": "hash-solo" }));
    put(&s, "dup/g1", json!({ "content_hash": "hash-g" }));
    put(&s, "dup/g2", json!({ "content_hash": "hash-g" }));
    s.soft_delete_page("dup/g2", None).unwrap();
    let rows = s.list_content_hash_duplicates().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["content_hash"], "hash-a");
    assert_eq!(rows[0]["slugs"], "dup/b|dup/zz|dup/a-long-name");
}

#[test]
fn page_counts_cover_deleted_pages_only_where_the_sql_does() {
    let s = brain("counts");
    for slug in [
        "skills/a",
        "skills/b",
        "skills_x/c",
        "skillsXY/d",
        "100%/e",
        "100abc/f",
        "notes/gone",
    ] {
        put(&s, slug, json!({}));
    }
    s.soft_delete_page("notes/gone", None).unwrap();
    s.soft_delete_page("skills/b", None).unwrap();
    assert_eq!(s.count_page_rows().unwrap(), 7);
    assert_eq!(s.count_live_pages().unwrap(), 5);
    assert_eq!(s.count_pages_by_slug_prefix("skills/").unwrap(), 2);
    // The prefix is literal: the TypeScript side escapes `%`, `_` and `\` for the SQL, so none is a wildcard here.
    assert_eq!(s.count_pages_by_slug_prefix("skills_").unwrap(), 1);
    assert_eq!(s.count_pages_by_slug_prefix("100%").unwrap(), 1);
    assert_eq!(s.count_pages_by_slug_prefix("skills\\").unwrap(), 0);
    assert_eq!(s.count_pages_by_slug_prefix("zzz").unwrap(), 0);
}

#[test]
fn oldest_page_and_trust_tiers_read_every_page_row() {
    let s = brain("oldest");
    assert_eq!(s.read_oldest_page_created_at().unwrap(), None);
    assert!(s.count_page_trust_tiers().unwrap().is_empty());
    put(&s, "tier/a", json!({}));
    put(&s, "tier/b", json!({}));
    s.soft_delete_page("tier/b", None).unwrap();
    let oldest = s.read_oldest_page_created_at().unwrap().unwrap();
    assert!(oldest.starts_with("2027-01-15"), "{oldest}");
    assert_eq!(
        s.count_page_trust_tiers().unwrap(),
        vec![json!({ "tier": "unknown", "n": 2 })]
    );
}

#[test]
fn mention_links_count_each_live_page_once() {
    let s = brain("mentions");
    for slug in ["m/a", "m/b", "m/c", "m/d", "m/t1", "m/t2"] {
        put(&s, slug, json!({}));
    }
    let mention: AddLinkOptions = args(json!({ "linkType": "mentions", "linkSource": "mentions" }));
    s.add_link("m/a", "m/t1", &mention).unwrap();
    s.add_link("m/a", "m/t2", &mention).unwrap();
    s.add_link("m/b", "m/t1", &mention).unwrap();
    s.add_link("m/d", "m/t1", &mention).unwrap();
    s.soft_delete_page("m/d", None).unwrap();
    let other: AddLinkOptions = args(json!({ "linkType": "references", "linkSource": "markdown" }));
    s.add_link("m/c", "m/t1", &other).unwrap();
    assert_eq!(s.count_pages_with_mention_links().unwrap(), 2);
}

#[test]
fn image_coverage_has_no_image_vectors_to_count() {
    let s = brain("image");
    assert_eq!(
        s.read_image_page_coverage().unwrap(),
        json!({ "image_pages": 0, "without_image_vector": 0, "null_source_path": 0 })
    );
    put(
        &s,
        "img/a",
        json!({ "page_kind": "image", "source_path": "a.png" }),
    );
    put(&s, "img/b", json!({ "page_kind": "image" }));
    put(
        &s,
        "img/c",
        json!({ "page_kind": "image", "source_path": "c.png" }),
    );
    s.soft_delete_page("img/c", None).unwrap();
    put(
        &s,
        "img/text",
        json!({ "page_kind": "markdown", "source_path": "t.md" }),
    );
    assert_eq!(
        s.read_image_page_coverage().unwrap(),
        json!({ "image_pages": 2, "without_image_vector": 2, "null_source_path": 1 })
    );
}

#[test]
fn facts_bodies_are_cut_by_characters_in_source_and_slug_order() {
    let s = brain("facts");
    put(
        &s,
        "facts/b",
        json!({ "type": "facts", "compiled_truth": "- [preference] Tea\n" }),
    );
    put(
        &s,
        "facts/a",
        json!({ "type": "facts", "compiled_truth": "é".repeat(65_540) }),
    );
    put(&s, "facts/gone", json!({ "type": "facts" }));
    s.soft_delete_page("facts/gone", None).unwrap();
    put(&s, "notes/not-facts", json!({}));
    let rows = s.list_facts_page_bodies().unwrap();
    assert_eq!(slugs(&rows, "slug"), vec!["facts/a", "facts/b"]);
    assert_eq!(rows[0]["body"].as_str().unwrap().chars().count(), 65_536);
    assert_eq!(rows[0]["segmented"], false);
}

#[test]
fn bracket_paths_match_brackets_and_the_control_class_of_the_server() {
    let s = brain("bracket");
    let paths = [
        ("p/open", "dir/[draft].md", true),
        ("p/close", "dir/a].md", true),
        ("p/tab", "dir/a\tb.md", true),
        ("p/del", "dir/a\u{7f}b.md", true),
        ("p/c1", "dir/a\u{85}b.md", true),
        ("p/c1-end", "dir/a\u{9f}b.md", true),
        // Not in [[:cntrl:]] on PGLite or the test Postgres.
        ("p/nbsp", "dir/a\u{a0}b.md", false),
        ("p/ls", "dir/a\u{2028}b.md", false),
        ("p/fffa", "dir/a\u{fffa}b.md", false),
        ("p/plain", "dir/plain.md", false),
    ];
    for (slug, path, _) in paths {
        put(&s, slug, json!({ "source_path": path }));
    }
    put(&s, "p/no-path", json!({}));
    put(&s, "p/gone", json!({ "source_path": "dir/[gone].md" }));
    s.soft_delete_page("p/gone", None).unwrap();
    let mut want: Vec<&str> = paths.iter().filter(|p| p.2).map(|p| p.0).collect();
    want.sort();
    let rows = s.list_bracket_path_pages().unwrap();
    let mut got = slugs(&rows, "slug");
    got.sort();
    assert_eq!(got, want);
}

#[test]
fn slug_path_candidates_follow_the_pattern_in_id_order_for_live_unarchived_pages() {
    let s = brain("slugpath");
    assert!(s.list_slug_path_candidates(None).unwrap().is_empty());
    for slug in [
        "ok/clean-slug",
        "bad/plus+sign",
        "bad/under_score",
        "bad/dbl--dash",
        "bad/-lead",
        "bad/trail-",
        "bad/a-/b",
        "bad//slash",
        "bad/space here",
        "bad/é",
        "ok/dots.and-dash_x",
    ] {
        put(&s, slug, json!({ "source_path": format!("{slug}.md") }));
    }
    put(&s, "bad/no-path", json!({}));
    put(&s, "bad/blank-path", json!({ "source_path": "   " }));
    put(&s, "bad/gone+x", json!({ "source_path": "g.md" }));
    s.soft_delete_page("bad/gone+x", None).unwrap();
    let want = vec![
        "bad/plus+sign",
        "bad/dbl--dash",
        "bad/-lead",
        "bad/trail-",
        "bad/a-/b",
        "bad//slash",
        "bad/space here",
        "bad/é",
    ];
    assert_eq!(
        slugs(&s.list_slug_path_candidates(None).unwrap(), "slug"),
        want
    );
    assert_eq!(
        slugs(
            &s.list_slug_path_candidates(Some(vec!["default".into()]))
                .unwrap(),
            "slug"
        ),
        want
    );
    assert!(
        s.list_slug_path_candidates(Some(vec![]))
            .unwrap()
            .is_empty()
    );
    assert!(
        s.list_slug_path_candidates(Some(vec!["elsewhere".into()]))
            .unwrap()
            .is_empty()
    );
}
