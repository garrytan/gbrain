//! The proactive brief's six reads (`cli_reads/brief_reads.rs`): the meeting pages, email alias
//! pages, world facts, edit page, timeline entry and page versions, under the privacy policy, the
//! trust floor, the byte ceiling and the version limit.

mod memory_env;

use gbrain_store::cli_reads::brief_reads::BriefEligibility;
use gbrain_store::facts::{InsertFactArgs, PrivacyPolicy};
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::timeline::{AddTimelineOptions, TimelineInput};
use memory_env::{Brain, brain};
use serde_json::{Value, json};

const DAY: i64 = 86_400_000_000;
/// T0 (2027-01-15T08:00:00Z) as ISO, and one day before and after it.
const AT_T0: &str = "2027-01-15T08:00:00.000Z";
const DAY_BEFORE: &str = "2027-01-14T08:00:00.000Z";
const DAY_AFTER: &str = "2027-01-16T08:00:00.000Z";

fn args<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn put(b: &Brain, source: &str, slug: &str, page: Value) {
    let input: PageInput = args(page);
    let opts: PutPageOptions = args(json!({ "sourceId": source }));
    b.put_page(slug, &input, &opts).unwrap();
}

fn hide_private() -> PrivacyPolicy {
    PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    }
}

fn floor() -> BriefEligibility {
    BriefEligibility {
        min_trust: Some("operator_curated".into()),
        suppress_flagged: true,
    }
}

fn open() -> BriefEligibility {
    BriefEligibility::default()
}

fn meeting(start: &str, private: bool) -> Value {
    let mut fm =
        json!({ "start": start, "attendees": ["alice@example.com"], "account": "a@example.com" });
    if private {
        fm["visibility"] = json!("private");
    }
    json!({ "type": "meeting", "title": "Sync", "compiled_truth": "notes", "frontmatter": fm })
}

#[test]
fn meeting_pages_read_the_window_of_the_given_sources_under_the_policy_and_floor() {
    let b = brain("brief-meetings");
    b.upsert_source(&gbrain_store::sources::SourceInput {
        id: "other".into(),
        ..Default::default()
    })
    .unwrap();
    put(
        &b,
        "default",
        "meetings/in",
        meeting("2027-01-15T09:00:00Z", false),
    );
    put(
        &b,
        "default",
        "meetings/late",
        meeting("2027-02-01T09:00:00Z", false),
    );
    put(
        &b,
        "default",
        "meetings/private",
        meeting("2027-01-15T10:00:00Z", true),
    );
    put(
        &b,
        "other",
        "meetings/in",
        meeting("2027-01-15T09:00:00Z", false),
    );
    let one = vec!["default".to_string()];
    let window = ("2027-01-15T00:00:00Z", "2027-01-16T00:00:00Z");
    let mut slugs: Vec<String> = b
        .read_brief_meeting_pages(&one, window.0, window.1, None, &open())
        .unwrap()
        .into_iter()
        .map(|r| {
            assert_eq!(r.source_id, "default");
            assert_eq!(r.attendees, json!(["alice@example.com"]));
            assert_eq!(r.account.as_deref(), Some("a@example.com"));
            r.slug
        })
        .collect();
    slugs.sort();
    assert_eq!(slugs, ["meetings/in", "meetings/private"]);
    let hidden = b
        .read_brief_meeting_pages(&one, window.0, window.1, Some(&hide_private()), &open())
        .unwrap();
    assert_eq!(hidden.len(), 1);
    let both = vec!["default".to_string(), "other".to_string()];
    let both_rows = b
        .read_brief_meeting_pages(&both, window.0, window.1, Some(&hide_private()), &open())
        .unwrap();
    assert_eq!(both_rows.len(), 2);
    assert!(
        b.read_brief_meeting_pages(&[], window.0, window.1, None, &open())
            .unwrap()
            .is_empty()
    );
    assert!(
        b.read_brief_meeting_pages(&one, window.0, window.1, None, &floor())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn email_alias_pages_read_one_row_per_alias_row_under_the_policy_and_floor() {
    let b = brain("brief-aliases");
    let person = |title: &str, fm: Value| json!({ "type": "person", "title": title, "compiled_truth": "x", "frontmatter": fm });
    put(
        &b,
        "default",
        "people/bram-example",
        person("Bram Example", json!({})),
    );
    put(
        &b,
        "default",
        "people/hidden-example",
        person("Hidden Example", json!({ "visibility": "private" })),
    );
    b.set_page_aliases(
        "people/bram-example",
        "default",
        &["bram@example.com".into()],
    )
    .unwrap();
    b.set_page_aliases(
        "people/hidden-example",
        "default",
        &["hid@example.com".into()],
    )
    .unwrap();
    let emails = vec![
        "bram@example.com".to_string(),
        "bram@example.com".to_string(),
        "hid@example.com".to_string(),
        "none@example.com".to_string(),
    ];
    let rows = b
        .read_brief_email_alias_pages("default", &emails, None, &open())
        .unwrap();
    let got: Vec<(&str, &str, &str, &str)> = rows
        .iter()
        .map(|r| {
            (
                r.alias_norm.as_str(),
                r.slug.as_str(),
                r.title.as_str(),
                r.page_type.as_str(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            (
                "bram@example.com",
                "people/bram-example",
                "Bram Example",
                "person"
            ),
            (
                "hid@example.com",
                "people/hidden-example",
                "Hidden Example",
                "person"
            ),
        ]
    );
    let hidden = b
        .read_brief_email_alias_pages("default", &emails, Some(&hide_private()), &open())
        .unwrap();
    assert_eq!(hidden.len(), 1);
    assert!(
        b.read_brief_email_alias_pages("other", &emails, None, &open())
            .unwrap()
            .is_empty()
    );
    assert!(
        b.read_brief_email_alias_pages("default", &emails, None, &floor())
            .unwrap()
            .is_empty()
    );
}

fn fact(b: &Brain, text: &str, visibility: &str) -> u64 {
    let out = b
        .insert_fact(&args::<InsertFactArgs>(json!({
            "input": { "fact": text, "source": "s", "kind": "event", "visibility": visibility },
            "sourceId": "default",
        })))
        .unwrap();
    out["id"].as_u64().unwrap()
}

#[test]
fn world_facts_read_the_active_world_facts_among_the_ids_in_id_order() {
    let b = brain("brief-facts");
    let world = fact(&b, "world fact", "world");
    let private = fact(&b, "private fact", "private");
    let ids = vec![world, world, private, 9_999];
    let rows = b.read_brief_world_facts(&ids, None, &open()).unwrap();
    let got: Vec<(u64, &str)> = rows.iter().map(|r| (r.id, r.fact.as_str())).collect();
    assert_eq!(got, [(world, "world fact")]);
    assert_eq!(rows[0].trust_tier, "unknown");
    assert!(
        b.read_brief_world_facts(&ids, None, &floor())
            .unwrap()
            .is_empty()
    );
    assert!(
        b.read_brief_world_facts(&[], None, &open())
            .unwrap()
            .is_empty()
    );
}

fn body_page(b: &Brain, slug: &str, body: &str, fm: Value) {
    put(
        b,
        "default",
        slug,
        json!({ "type": "person", "title": slug, "compiled_truth": body, "frontmatter": fm }),
    );
}

#[test]
fn the_edit_page_bounds_the_body_by_bytes_under_the_policy_and_floor() {
    let b = brain("brief-edit");
    body_page(&b, "people/alice-example", "hello world body", json!({}));
    body_page(
        &b,
        "people/hidden-example",
        "secret",
        json!({ "visibility": "private" }),
    );
    let row = b
        .read_brief_edit_page("default", "people/alice-example", 65_536, None, &open())
        .unwrap()
        .unwrap();
    assert_eq!(row.compiled_truth.as_deref(), Some("hello world body"));
    assert_eq!(row.trust_tier, "unknown");
    let too_big = b
        .read_brief_edit_page("default", "people/alice-example", 10, None, &open())
        .unwrap()
        .unwrap();
    assert_eq!(too_big.compiled_truth, None);
    assert_eq!(too_big.id, row.id);
    let policy = hide_private();
    assert!(
        b.read_brief_edit_page(
            "default",
            "people/hidden-example",
            65_536,
            Some(&policy),
            &open()
        )
        .unwrap()
        .is_none()
    );
    let unpoliced = b
        .read_brief_edit_page("default", "people/hidden-example", 65_536, None, &open())
        .unwrap()
        .unwrap();
    assert_eq!(unpoliced.compiled_truth.as_deref(), Some("secret"));
    assert!(
        b.read_brief_edit_page("default", "people/alice-example", 65_536, None, &floor())
            .unwrap()
            .is_none()
    );
    assert!(
        b.read_brief_edit_page("default", "people/missing", 65_536, None, &open())
            .unwrap()
            .is_none()
    );
}

fn page_id(b: &Brain, slug: &str) -> u64 {
    b.read_brief_edit_page("default", slug, 0, None, &BriefEligibility::default())
        .unwrap()
        .unwrap()
        .id
}

#[test]
fn the_timeline_entry_is_the_newest_recorded_and_dated_since_under_the_floor() {
    let b = brain("brief-timeline");
    body_page(&b, "people/alice-example", "x", json!({}));
    let pid = page_id(&b, "people/alice-example");
    let add = |date: &str, summary: &str| {
        let entry = TimelineInput {
            date: Some(date.into()),
            summary: Some(summary.into()),
            ..TimelineInput::default()
        };
        b.add_timeline_entry(
            "people/alice-example",
            &entry,
            &AddTimelineOptions::default(),
        )
        .unwrap();
    };
    add("2027-01-10", "old date");
    b.clock.advance(1_000_000);
    add("2027-01-15", "today");
    let row = b
        .read_brief_timeline_entry(pid, AT_T0, None, &open())
        .unwrap()
        .unwrap();
    assert_eq!(row.summary, "today");
    assert_eq!(row.date, "2027-01-15");
    // The store clock renders microseconds; the member turns it into a Date.
    assert_eq!(row.created_at, "2027-01-15T08:00:01.000000Z");
    assert!(
        b.read_brief_timeline_entry(pid, DAY_AFTER, None, &open())
            .unwrap()
            .is_none()
    );
    assert!(
        b.read_brief_timeline_entry(pid, AT_T0, None, &floor())
            .unwrap()
            .is_none()
    );
    assert!(
        b.read_brief_timeline_entry(pid, "not a date", None, &open())
            .is_err()
    );
}

#[test]
fn page_versions_read_the_newest_since_by_id_bounded_by_bytes_and_limit() {
    let b = brain("brief-versions");
    body_page(&b, "people/alice-example", "first body", json!({}));
    let pid = page_id(&b, "people/alice-example");
    b.create_version("people/alice-example", Some("default"))
        .unwrap();
    b.clock.advance(DAY);
    body_page(&b, "people/alice-example", "second body", json!({}));
    b.create_version("people/alice-example", Some("default"))
        .unwrap();
    let rows = b
        .read_brief_page_versions(pid, DAY_BEFORE, 65_536, 5)
        .unwrap();
    let bodies: Vec<Option<&str>> = rows.iter().map(|r| r.compiled_truth.as_deref()).collect();
    assert_eq!(bodies, [Some("second body"), Some("first body")]);
    assert!(rows[0].id > rows[1].id);
    assert_eq!(rows[1].snapshot_at, "2027-01-15T08:00:00.000000Z");
    assert!(!rows[0].is_deleted);
    let limited = b
        .read_brief_page_versions(pid, DAY_BEFORE, 65_536, 1)
        .unwrap();
    assert_eq!(limited.len(), 1);
    assert_eq!(limited[0].id, rows[0].id);
    let too_big = b.read_brief_page_versions(pid, DAY_BEFORE, 5, 5).unwrap();
    assert!(too_big.iter().all(|r| r.compiled_truth.is_none()));
    let since_second = b
        .read_brief_page_versions(pid, "2027-01-15T09:00:00.000Z", 65_536, 5)
        .unwrap();
    assert_eq!(since_second.len(), 1);
    assert!(
        b.read_brief_page_versions(pid, "2027-01-17T09:00:00.000Z", 65_536, 5)
            .unwrap()
            .is_empty()
    );
}
