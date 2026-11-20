//! `type_page_reads.rs`: the schema-pack page reads that order by byte.

mod memory_env;

use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use gbrain_store::type_page_reads::{RetypeProbe, TypePageQuery};
use memory_env::{Brain, brain};

fn source(b: &Brain, id: &str) {
    b.upsert_source(&SourceInput {
        id: id.into(),
        name: Some(id.into()),
        ..SourceInput::default()
    })
    .unwrap();
}

fn page(b: &Brain, source_id: &str, slug: &str, page_type: &str, path: Option<&str>) {
    let input = PageInput {
        page_type: page_type.into(),
        title: slug.into(),
        compiled_truth: format!("{slug} body"),
        source_path: path.map(str::to_string),
        ..PageInput::default()
    };
    b.put_page(
        slug,
        &input,
        &PutPageOptions {
            source_id: Some(source_id.into()),
            ..PutPageOptions::default()
        },
    )
    .unwrap();
}

fn query(page_type: &str, source_id: Option<&str>, limit: i64) -> TypePageQuery {
    TypePageQuery {
        page_type: page_type.into(),
        source_id: source_id.map(str::to_string),
        limit,
    }
}

fn probe(from: &str, path: Option<&str>, slug: Option<&str>, source: Option<&str>) -> RetypeProbe {
    RetypeProbe {
        from_type: from.into(),
        path_filter: path.map(str::to_string),
        slug_filter: slug.map(str::to_string),
        source_id: source.map(str::to_string),
    }
}

fn slugs(rows: &[serde_json::Value]) -> Vec<&str> {
    rows.iter().map(|r| r["slug"].as_str().unwrap()).collect()
}

#[test]
fn type_page_bodies_list_by_slug_byte_then_id_and_follow_the_source() {
    let b = brain("type-page-reads-bodies");
    source(&b, "other");
    for slug in ["ab", "a/z", "a-z"] {
        page(&b, "default", slug, "person", None);
    }
    // The same slug in a second source: the id breaks the tie.
    page(&b, "other", "ab", "person", None);
    page(&b, "default", "skip", "note", None);
    page(&b, "default", "gone", "person", None);
    b.soft_delete_page("gone", None).unwrap();

    // en_US would list `ab, a/z, a-z`; bytes list `a-z, a/z, ab`.
    let all = b.list_type_page_bodies(&query("person", None, 10)).unwrap();
    assert_eq!(slugs(&all), vec!["a-z", "a/z", "ab", "ab"]);
    assert_eq!(all[0]["compiled_truth"], "a-z body");

    let scoped = b
        .list_type_page_bodies(&query("person", Some("default"), 10))
        .unwrap();
    assert_eq!(slugs(&scoped), vec!["a-z", "a/z", "ab"]);

    let cut = b.list_type_page_bodies(&query("person", None, 2)).unwrap();
    assert_eq!(slugs(&cut), vec!["a-z", "a/z"]);

    let source_only = b
        .list_source_type_page_bodies(&query("person", Some("other"), 10))
        .unwrap();
    assert_eq!(slugs(&source_only), vec!["ab"]);
    assert!(
        b.list_source_type_page_bodies(&query("person", None, 10))
            .is_err()
    );
}

#[test]
fn type_page_reads_refuse_nul_text_and_a_negative_limit() {
    let b = brain("type-page-reads-invalid");
    assert!(b.list_type_page_bodies(&query("a\0b", None, 1)).is_err());
    assert!(
        b.list_type_page_bodies(&query("person", Some("x\0"), 1))
            .is_err()
    );
    assert!(b.list_type_page_bodies(&query("person", None, -1)).is_err());
    assert!(
        b.count_retype_candidates(&probe("person", Some("a\0"), None, None))
            .is_err()
    );
    assert!(
        b.list_retype_sample_slugs(&probe("a\0", None, None, None))
            .is_err()
    );
}

#[test]
fn retype_probe_counts_and_samples_by_filter_in_byte_order() {
    let b = brain("type-page-reads-retype");
    source(&b, "other");
    for (i, slug) in [
        "ab", "a/z", "a-z", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9",
    ]
    .iter()
    .enumerate()
    {
        page(&b, "default", slug, "note", Some(&format!("people/{i}.md")));
    }
    page(&b, "other", "zz", "note", Some("misc/zz.md"));
    page(&b, "default", "typed", "person", Some("people/t.md"));
    page(&b, "default", "pathless", "note", None);

    let bare = probe("note", None, None, None);
    assert_eq!(b.count_retype_candidates(&bare).unwrap(), 14);
    let sample = b.list_retype_sample_slugs(&bare).unwrap();
    assert_eq!(sample.len(), 10);
    assert_eq!(&sample[..3], ["a-z", "a/z", "ab"]);

    let by_path = probe("note", Some("people/%"), None, None);
    assert_eq!(b.count_retype_candidates(&by_path).unwrap(), 12);
    let by_slug = probe("note", None, Some("a%"), None);
    assert_eq!(
        b.list_retype_sample_slugs(&by_slug).unwrap(),
        vec!["a-z", "a/z", "ab"]
    );
    let by_source = probe("note", None, None, Some("other"));
    assert_eq!(b.list_retype_sample_slugs(&by_source).unwrap(), vec!["zz"]);
    // An empty filter is no filter, as the caller's `if (filter)` reads it.
    let empty = probe("note", Some(""), Some(""), Some(""));
    assert_eq!(b.count_retype_candidates(&empty).unwrap(), 14);
}
