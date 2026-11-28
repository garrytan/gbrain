//! Entity and mention reads the CLI made through `executeRaw`: what the store answers with no
//! mention state, and the PGLite rules for sibling titles, retired pages and privacy labels.

mod common;

use common::{TempDir, open};
use gbrain_store::Store;
use gbrain_store::access_rules::AccessRuleRecord;
use gbrain_store::cli_reads::entities::{
    MentionDueQuery, MentionDueSinceQuery, MentionIndexRecount, MentionIndexStatusQuery,
    NameVariantCandidateQuery, SiblingCandidateQuery,
};
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::links::AddLinkOptions;
use gbrain_store::pages::{PageInput, PutPageOptions};
use gbrain_store::sources::SourceInput;
use serde_json::{Value, json};

fn put(store: &Store, source: &str, slug: &str, page: Value) {
    let input: PageInput = serde_json::from_value(page).unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": source})).unwrap();
    store.put_page(slug, &input, &opts).unwrap();
}

fn seeded(dir: &TempDir) -> Store {
    let store = open(dir);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            ..Default::default()
        })
        .unwrap();
    let page = |t: &str, title: &str, fm: Value| json!({"type": t, "title": title, "compiled_truth": "body", "frontmatter": fm});
    put(
        &store,
        "default",
        "people/ada",
        page("person", "Ada", json!({"identity": "ada-1"})),
    );
    put(
        &store,
        "default",
        "people/ada-2",
        page(
            "person",
            "Founder: ada",
            json!({"identity": {"b": 1, "a": [true]}}),
        ),
    );
    put(
        &store,
        "default",
        "people/ada-q",
        page("person", "Ada", json!({"quarantine": true})),
    );
    put(
        &store,
        "default",
        "companies/ada",
        page("company", "Ada", json!({})),
    );
    put(
        &store,
        "default",
        "people/old",
        page("person", "Old", json!({"status": "Redirect"})),
    );
    put(
        &store,
        "default",
        "people/merged",
        page("person", "M", json!({"merged_into": "people/ada"})),
    );
    put(
        &store,
        "default",
        "people/blank",
        page(
            "person",
            "B",
            json!({"merged_into": "  ", "canonical": true}),
        ),
    );
    put(
        &store,
        "default",
        "people/nc",
        page("person", "N", json!({"canonical": false})),
    );
    put(
        &store,
        "default",
        "people/aliases",
        page("person", "A", json!({"status": "aliases"})),
    );
    put(
        &store,
        "default",
        "notes/label",
        page("note", "L", json!({"access": "team-only"})),
    );
    put(
        &store,
        "default",
        "notes/readers",
        page("note", "R", json!({"access": "x", "readable_by": ["a"]})),
    );
    put(
        &store,
        "default",
        "notes/plain",
        page("note", "P", json!({})),
    );
    put(
        &store,
        "other",
        "people/ada",
        page("person", "Ada", json!({})),
    );
    store
        .soft_delete_page("people/nc", Some("default"))
        .unwrap();
    store
}

#[test]
fn with_no_pass_run_every_live_page_is_due() {
    let dir = TempDir::new("cli-mentions");
    let store = seeded(&dir);
    assert_eq!(store.read_mention_last_pass(None).unwrap(), None);
    assert_eq!(store.read_mention_last_pass(Some("default")).unwrap(), None);
    let due = |source: Option<&str>| {
        store
            .count_pages_due_for_mentions(&MentionDueQuery {
                source_id: source.map(String::from),
                mention_version: 7,
                aliases: None,
            })
            .unwrap()
    };
    assert_eq!(due(Some("default")), 11);
    assert_eq!(due(Some("other")), 1);
    assert_eq!(due(Some("ghost")), 0);
    assert_eq!(due(None), 12);
}

#[test]
fn mention_coverage_reads_see_no_status_rows_before_a_pass_ran() {
    let dir = TempDir::new("cli-mention-coverage");
    let store = seeded(&dir);
    let status = |ids: &[&str]| {
        store
            .read_mention_index_status(&MentionIndexStatusQuery {
                source_ids: ids.iter().map(|s| s.to_string()).collect(),
            })
            .unwrap()
    };
    assert!(status(&["default", "other", "ghost"]).is_empty());
    assert!(status(&[]).is_empty());
    let since = |source: &str, since: &str| {
        store.count_mention_due_since(&MentionDueSinceQuery {
            source_id: source.into(),
            since: since.into(),
            mention_version: 0,
        })
    };
    assert_eq!(since("default", "-infinity").unwrap(), 11);
    assert_eq!(since("other", "-infinity").unwrap(), 1);
    assert_eq!(since("ghost", "-infinity").unwrap(), 0);
    assert_eq!(since("default", "2999-01-01T00:00:00.000Z").unwrap(), 0);
    assert_eq!(since("default", "1970-01-01T00:00:00.000Z").unwrap(), 11);
    assert_eq!(since("default", "infinity").unwrap(), 0);
    assert!(since("default", "yesterday").is_err());
    // The recount's compare-and-set finds no row, so nothing changes.
    store
        .recount_mention_index_status(&MentionIndexRecount {
            source_id: "default".into(),
            pending: 4,
            fingerprint: "h;v".into(),
            expected_fingerprint: None,
        })
        .unwrap();
    assert!(status(&["default"]).is_empty());
}

#[test]
fn sibling_candidates_match_the_title_or_its_suffix_by_slug() {
    let dir = TempDir::new("cli-siblings");
    let store = seeded(&dir);
    let read = |limit: u64, exclude_quarantined: bool| {
        store
            .read_identity_sibling_candidates(
                "default",
                &SiblingCandidateQuery {
                    types: vec!["person".into()],
                    subject: "ada".into(),
                    limit,
                    exclude_quarantined,
                    exclude_private: None,
                },
            )
            .unwrap()
    };
    let rows = read(10, false);
    let slugs: Vec<&str> = rows.iter().map(|r| r.slug.as_str()).collect();
    assert_eq!(slugs, ["people/ada", "people/ada-2", "people/ada-q"]);
    assert_eq!(rows[0].identity.as_deref(), Some("ada-1"));
    assert_eq!(
        rows[1].identity.as_deref(),
        Some(r#"{"a": [true], "b": 1}"#)
    );
    assert_eq!(rows[2].identity, None);
    assert_eq!(read(10, true).len(), 2);
    assert_eq!(read(1, false).len(), 1);
}

#[test]
fn sibling_candidates_skip_private_pages_under_the_policy() {
    let dir = TempDir::new("cli-siblings-private");
    let store = seeded(&dir);
    let page = |fm: Value| json!({"type": "person", "title": "Ada", "compiled_truth": "body", "frontmatter": fm});
    put(
        &store,
        "default",
        "people/ada-private",
        page(json!({"visibility": "private"})),
    );
    put(
        &store,
        "default",
        "people/ada-restricted",
        page(json!({"access": "restricted"})),
    );
    let read = |exclude_private: Option<PrivacyPolicy>| -> Vec<String> {
        store
            .read_identity_sibling_candidates(
                "default",
                &SiblingCandidateQuery {
                    types: vec!["person".into()],
                    subject: "ada".into(),
                    limit: 10,
                    exclude_quarantined: false,
                    exclude_private,
                },
            )
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect()
    };
    assert_eq!(read(None).len(), 5);
    let honored = read(Some(PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    }));
    assert_eq!(honored, ["people/ada", "people/ada-2", "people/ada-q"]);
    let visibility_only = read(Some(PrivacyPolicy {
        honor_aliases: false,
        entity_privacy: true,
        ..Default::default()
    }));
    assert!(visibility_only.contains(&"people/ada-restricted".to_string()));
    assert!(!visibility_only.contains(&"people/ada-private".to_string()));
}

#[test]
fn exact_slug_splits_live_and_retired_pages() {
    let dir = TempDir::new("cli-exact");
    let store = seeded(&dir);
    let find = |slug: &str, retired: bool| {
        store
            .find_exact_slug("default", &[slug.to_string()], Some(retired))
            .unwrap()
    };
    assert_eq!(find("people/ada", false).as_deref(), Some("people/ada"));
    assert_eq!(find("people/ada", true), None);
    for retired in ["people/old", "people/merged"] {
        assert_eq!(find(retired, true).as_deref(), Some(retired));
        assert_eq!(find(retired, false), None);
    }
    for live in ["people/blank", "people/aliases"] {
        assert_eq!(find(live, false).as_deref(), Some(live));
    }
    assert_eq!(find("people/nc", false), None);
    assert_eq!(find("people/nc", true), None);
    assert_eq!(find("people/ghost", false), None);
    // Several slugs: the first live one in the given order, retired or not when no filter is set.
    let any = |slugs: &[&str]| {
        let slugs: Vec<String> = slugs.iter().map(|s| s.to_string()).collect();
        store.find_exact_slug("default", &slugs, None).unwrap()
    };
    assert_eq!(
        any(&["people/ghost", "people/old", "people/ada"]).as_deref(),
        Some("people/old")
    );
    assert_eq!(
        any(&["people/nc", "people/ada"]).as_deref(),
        Some("people/ada")
    );
    assert_eq!(any(&["people/ghost"]), None);
    assert_eq!(any(&[]), None);
}

#[test]
fn label_pages_carry_a_label_key_and_no_readers() {
    let dir = TempDir::new("cli-labels");
    let store = seeded(&dir);
    let scope = |v: Value| serde_json::from_value(v).unwrap();
    let rows = store
        .read_ignored_privacy_label_pages(
            "default",
            &scope(json!({"slugs": ["notes/label", "notes/readers", "notes/plain"]})),
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].frontmatter["access"], json!("team-only"));
    let since = store
        .read_ignored_privacy_label_pages(
            "default",
            &scope(json!({"since": "2000-01-01T00:00:00Z"})),
        )
        .unwrap();
    assert_eq!(since.len(), 1);
    let none = store
        .read_ignored_privacy_label_pages(
            "default",
            &scope(json!({"since": "2999-01-01T00:00:00Z"})),
        )
        .unwrap();
    assert!(none.is_empty());
    assert!(
        store
            .read_ignored_privacy_label_pages("default", &scope(json!({"since": "yesterday"})))
            .is_err()
    );
}

#[test]
fn label_pages_leave_out_a_page_a_folder_rule_covers() {
    let dir = TempDir::new("cli-labels-folder");
    let store = seeded(&dir);
    let label = |title: &str| json!({"type": "note", "title": title, "compiled_truth": "body", "frontmatter": {"access": "team-only"}});
    store.put_access_policy_state("default").unwrap();
    store
        .put_access_rule(AccessRuleRecord {
            source_id: "default".into(),
            rule_id: "r1".into(),
            prefix: "secret/".into(),
            readable_by: vec!["member:alice-example".into()],
            revision: 1,
            covers_derived: false,
            created_by: None,
        })
        .unwrap();
    put(&store, "default", "secret/label", label("covered"));
    // A rule on another source does not cover this source's page.
    put(&store, "other", "secret/label", label("other source"));
    let scope = |v: Value| serde_json::from_value(v).unwrap();
    let by_slug = store
        .read_ignored_privacy_label_pages(
            "default",
            &scope(json!({"slugs": ["notes/label", "secret/label"]})),
        )
        .unwrap();
    assert_eq!(
        by_slug.len(),
        1,
        "the page under secret/ is covered by a folder rule"
    );
    let since = store
        .read_ignored_privacy_label_pages(
            "default",
            &scope(json!({"since": "2000-01-01T00:00:00Z"})),
        )
        .unwrap();
    assert_eq!(since.len(), 1);
    let elsewhere = store
        .read_ignored_privacy_label_pages("other", &scope(json!({"slugs": ["secret/label"]})))
        .unwrap();
    assert_eq!(
        elsewhere.len(),
        1,
        "a source with no access state has no stamped pages"
    );
}

#[test]
fn live_page_frontmatter_reads_the_stored_page_or_none() {
    let dir = TempDir::new("cli-live-frontmatter");
    let store = seeded(&dir);
    let row = store
        .read_live_page_frontmatter("default", "notes/readers")
        .unwrap()
        .unwrap();
    assert_eq!(row.page_type, "note");
    assert_eq!(row.frontmatter["access"], json!("x"));
    assert_eq!(row.frontmatter["readable_by"], json!(["a"]));
    // Soft-deleted, missing, or in another source: no row.
    assert!(
        store
            .read_live_page_frontmatter("default", "people/nc")
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .read_live_page_frontmatter("default", "notes/ghost")
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .read_live_page_frontmatter("other", "notes/readers")
            .unwrap()
            .is_none()
    );
}

#[test]
fn entity_anchored_pages_name_or_link_the_entity_newest_first() {
    let dir = TempDir::new("cli-anchored");
    let store = open(&dir);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            ..Default::default()
        })
        .unwrap();
    let page = |t: &str, body: &str, fm: Value| json!({"type": t, "title": "T", "compiled_truth": body, "frontmatter": fm});
    put(
        &store,
        "default",
        "people/nova-example",
        json!({"type": "person", "title": "Nova Example", "compiled_truth": "Nova Example", "frontmatter": {}}),
    );
    put(
        &store,
        "default",
        "notes/title",
        page("note", "Met NOVA EXAMPLE today.", json!({})),
    );
    put(
        &store,
        "default",
        "notes/tail",
        page("note", "see nova-example.", json!({})),
    );
    put(
        &store,
        "default",
        "notes/longer",
        page("note", "Nova Examples met.", json!({})),
    );
    put(
        &store,
        "default",
        "notes/linked",
        page("note", "no name here", json!({})),
    );
    put(
        &store,
        "default",
        "notes/amends",
        page("note", "no name here", json!({})),
    );
    put(
        &store,
        "default",
        "notes/question",
        page("question", "Nova Example?", json!({})),
    );
    put(
        &store,
        "default",
        "notes/pinned",
        page("note", "Nova Example", json!({"pinned_question": "q"})),
    );
    put(
        &store,
        "default",
        "notes/gone",
        page("note", "Nova Example", json!({})),
    );
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    put(
        &store,
        "other",
        "notes/elsewhere",
        page("note", "Nova Example", json!({})),
    );
    let link = |from: &str, link_type: &str| {
        let options: AddLinkOptions =
            serde_json::from_value(json!({"linkType": link_type, "context": "c"})).unwrap();
        store
            .add_link(from, "people/nova-example", &options)
            .unwrap();
    };
    link("notes/linked", "works_at");
    link("notes/amends", "amends");
    let anchored = store
        .read_entity_anchored_pages("default", "people/nova-example")
        .unwrap();
    let entity = anchored.entity.unwrap();
    assert_eq!(entity.title, "Nova Example");
    let slugs: Vec<&str> = anchored.pages.iter().map(|p| p.slug.as_str()).collect();
    assert_eq!(slugs, ["notes/linked", "notes/tail", "notes/title"]);
    // No live entity page: only the slug tail names it, and no link counts.
    let missing = store
        .read_entity_anchored_pages("default", "people/missing")
        .unwrap();
    assert!(missing.entity.is_none() && missing.pages.is_empty());
    // Titles read each page id once; an id outside integer is refused.
    let gone = store.read_page_titles_by_id(&[entity.id as i64]).unwrap();
    assert_eq!(gone[0].title, "Nova Example");
    let ids: Vec<i64> = anchored.pages.iter().map(|p| p.id as i64).collect();
    let titles = store
        .read_page_titles_by_id(&[ids[0], ids[0], 0, 999_999])
        .unwrap();
    assert_eq!(titles.len(), 1);
    assert!(
        store
            .read_page_titles_by_id(&[i64::from(i32::MAX) + 1])
            .is_err()
    );
}

#[test]
fn prefix_anchored_pages_read_the_newest_live_pages_under_a_literal_prefix() {
    let dir = TempDir::new("cli-prefix-anchored");
    let store = open(&dir);
    store
        .upsert_source(&SourceInput {
            id: "other".into(),
            ..Default::default()
        })
        .unwrap();
    let page = |t: &str, day: u32, fm: Value| {
        json!({"type": t, "title": "T", "compiled_truth": "body", "frontmatter": fm,
            "effective_date": format!("2026-03-{day:02}T00:00:00.000Z"), "effective_date_source": "date"})
    };
    for day in 1..=12 {
        put(
            &store,
            "default",
            &format!("projects/widget/n{day:02}"),
            page("note", day, json!({})),
        );
    }
    put(
        &store,
        "default",
        "projects/widget/q",
        page("question", 20, json!({})),
    );
    put(
        &store,
        "default",
        "projects/widget/s",
        page("synthesis", 20, json!({})),
    );
    put(
        &store,
        "default",
        "projects/widget/pinned",
        page("note", 21, json!({"pinned_question": "q"})),
    );
    put(
        &store,
        "default",
        "projects/widget/gone",
        page("note", 22, json!({})),
    );
    store
        .soft_delete_page("projects/widget/gone", Some("default"))
        .unwrap();
    put(
        &store,
        "default",
        "projects/widget_x/lit",
        page("note", 23, json!({})),
    );
    put(
        &store,
        "default",
        "projects/widgetzx/like",
        page("note", 24, json!({})),
    );
    put(
        &store,
        "other",
        "projects/widget/elsewhere",
        page("note", 25, json!({})),
    );
    let slugs = |prefix: &str| -> Vec<String> {
        store
            .read_prefix_anchored_pages("default", prefix)
            .unwrap()
            .into_iter()
            .map(|p| p.slug)
            .collect()
    };
    let widget: Vec<String> = (3..=12)
        .rev()
        .map(|d| format!("projects/widget/n{d:02}"))
        .collect();
    assert_eq!(slugs("projects/widget/"), widget);
    // `_` is literal, as the escaped LIKE pattern reads it.
    assert_eq!(slugs("projects/widget_"), ["projects/widget_x/lit"]);
    assert!(slugs("projects/none/").is_empty());
}

#[test]
fn page_chunker_version_and_image_seal_probe_read_one_page_record() {
    let dir = TempDir::new("cli-chunker-version");
    let store = open(&dir);
    put(
        &store,
        "default",
        "images/a.png",
        json!({"type": "image", "title": "A", "compiled_truth": "caption", "frontmatter": {}}),
    );
    let id = store.read_page_titles_by_id(&[1]).unwrap()[0].id as i64;
    let version = store.read_page_chunker_version(id).unwrap().unwrap();
    // A put page is not sealed past the fence, so the seal probe answers no row.
    assert!(version.chunker_version.unwrap_or(0) < 4);
    assert!(
        store
            .read_image_seal_probe("default", "images/a.png")
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .read_image_seal_probe("default", "images/none.png")
            .unwrap()
            .is_none()
    );
    assert!(store.read_page_chunker_version(999_999).unwrap().is_none());
    assert!(store.read_page_chunker_version(0).unwrap().is_none());
    assert!(
        store
            .read_page_chunker_version(i64::from(i32::MAX) + 1)
            .is_err()
    );
}

#[test]
fn text_mention_pages_read_live_pages_at_the_slugs_in_the_sources() {
    let dir = TempDir::new("cli-text-mentions");
    let store = open(&dir);
    for id in ["other", "third"] {
        store
            .upsert_source(&SourceInput {
                id: id.into(),
                ..Default::default()
            })
            .unwrap();
    }
    let page = |title: &str, date: Option<&str>| {
        json!({"type": "note", "title": title, "compiled_truth": "x", "frontmatter": {"quarantine": false},
            "effective_date": date, "effective_date_source": date.map(|_| "date")})
    };
    put(&store, "default", "notes/a", page("A", Some("2026-03-04")));
    put(&store, "other", "notes/a", page("A other", None));
    put(&store, "third", "notes/a", page("A third", None));
    put(&store, "default", "notes/gone", page("Gone", None));
    put(&store, "default", "notes/unasked", page("Unasked", None));
    store
        .soft_delete_page("notes/gone", Some("default"))
        .unwrap();
    let rows = store
        .read_text_mention_pages(
            &["default".into(), "other".into()],
            &["notes/a".into(), "notes/gone".into(), "notes/never".into()],
        )
        .unwrap();
    let got: Vec<(&str, &str, &str)> = rows
        .iter()
        .map(|r| (r.source_id.as_str(), r.slug.as_str(), r.title.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![("default", "notes/a", "A"), ("other", "notes/a", "A other")]
    );
    assert!(rows[0].date.starts_with("2026-03-04T00:00:00"));
    assert_eq!(rows[0].page_type, "note");
    assert_eq!(rows[0].frontmatter.get("quarantine"), Some(&json!(false)));
    assert!(
        store
            .read_text_mention_pages(&[], &["notes/a".into()])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn retirement_hop_reads_retirement_and_target() {
    let dir = TempDir::new("cli-hop");
    let store = seeded(&dir);
    let hop = |slug: &str| store.read_retirement_hop("default", slug, None).unwrap();
    let ada = hop("people/ada").unwrap();
    assert!(!ada.retired);
    assert_eq!(ada.target, None);
    assert_eq!(ada.page_type, "person");
    let merged = hop("people/merged").unwrap();
    assert!(merged.retired);
    assert_eq!(merged.target.as_deref(), Some("people/ada"));
    // Retired by status alone: no target to follow.
    let old = hop("people/old").unwrap();
    assert!(old.retired);
    assert_eq!(old.target, None);
    // A blank `merged_into` neither retires the page nor names a target.
    let blank = hop("people/blank").unwrap();
    assert!(!blank.retired);
    assert_eq!(blank.target, None);
    assert_eq!(hop("people/ghost"), None);
    assert_eq!(
        store
            .read_retirement_hop("no-such-source", "people/ada", None)
            .unwrap(),
        None
    );
}

#[test]
fn entity_card_rows_match_the_title_slugs_and_like_pattern() {
    use gbrain_store::cli_reads::entities::EntityCardMatch;
    let dir = TempDir::new("cli-card");
    let store = seeded(&dir);
    let page = |title: &str, body: &str| json!({"type": "person", "title": title, "compiled_truth": body, "frontmatter": {}});
    put(
        &store,
        "default",
        "people/under_score",
        page("Under", "Under body."),
    );
    put(&store, "default", "people/underxscore", page("ÉLAN", "x"));
    let long = "é".repeat(70_000);
    put(&store, "default", "people/long", page("Long", &long));
    let slugs = |m: EntityCardMatch| {
        let mut out: Vec<String> = store
            .read_entity_card_rows("default", &m, None)
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect();
        out.sort();
        out
    };
    // `_` is a LIKE wildcard; `lower(title)` folds É.
    assert_eq!(
        slugs(EntityCardMatch::Name {
            title_lc: "élan".into(),
            slugs: vec!["people/ada".into()],
            slug_like: "%/under_score".into(),
        }),
        vec!["people/ada", "people/under_score", "people/underxscore"]
    );
    assert_eq!(
        slugs(EntityCardMatch::Slugs {
            slugs: vec!["people/merged".into(), "people/missing".into()],
        }),
        vec!["people/merged"]
    );
    let rows = store
        .read_entity_card_rows(
            "default",
            &EntityCardMatch::Slugs {
                slugs: vec!["people/long".into()],
            },
            None,
        )
        .unwrap();
    let body = rows[0].compiled_truth.as_deref().unwrap();
    assert_eq!(body.chars().count(), 65_536);
    assert_eq!(rows[0].last_retrieved_at, None);
    // A recorded retrieval (`bumpPageRetrievals`) shows on the card row as an ISO time.
    let input: PageInput = serde_json::from_value(
        json!({"type": "person", "title": "Read", "compiled_truth": "Read."}),
    )
    .unwrap();
    let opts: PutPageOptions = serde_json::from_value(json!({"sourceId": "default"})).unwrap();
    let read = store.put_page("people/read", &input, &opts).unwrap();
    let id = read["id"].as_i64().unwrap();
    assert_eq!(store.bump_page_retrievals(&[id]).unwrap(), 1);
    let rows = store
        .read_entity_card_rows(
            "default",
            &EntityCardMatch::Slugs {
                slugs: vec!["people/read".into()],
            },
            None,
        )
        .unwrap();
    let at = rows[0].last_retrieved_at.as_deref().unwrap();
    assert!(at.ends_with('Z') && at.len() > 20, "{at}");
    assert!(
        store
            .read_entity_card_rows(
                "other",
                &EntityCardMatch::Slugs {
                    slugs: vec!["people/merged".into()],
                },
                None,
            )
            .unwrap()
            .is_empty()
    );
}

#[test]
fn slug_pattern_pages_are_live_unretired_and_capped() {
    let dir = TempDir::new("cli-slug-patterns");
    let store = seeded(&dir);
    let patterns = vec!["people/ada%".to_string(), "people/m%".to_string()];
    let slugs = |limit: u64| {
        store
            .list_unretired_pages_by_slug_pattern("default", &patterns, limit)
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect::<Vec<_>>()
    };
    assert_eq!(slugs(10), ["people/ada", "people/ada-2", "people/ada-q"]);
    assert_eq!(slugs(2), ["people/ada", "people/ada-2"]);
    assert_eq!(slugs(0), Vec::<String>::new());
}

#[test]
fn name_variant_candidates_rank_by_probe_hits_then_title_length() {
    let dir = TempDir::new("cli-name-variants");
    let store = seeded(&dir);
    let rows = store
        .list_name_variant_candidates(
            "default",
            &NameVariantCandidateQuery {
                types: vec!["company".into()],
                slug_patterns: vec!["people/%".into()],
                probes: vec!["%ADA%".into(), "%founder%".into()],
                limit: 10,
            },
        )
        .unwrap();
    let got: Vec<(&str, u64)> = rows
        .iter()
        .map(|r| (r.slug.as_str(), r.probe_hits))
        .collect();
    assert_eq!(
        got,
        [
            ("people/ada-2", 2),
            ("companies/ada", 1),
            ("people/ada", 1),
            ("people/ada-q", 1)
        ]
    );
    assert_eq!(rows[2].frontmatter.get("identity"), Some(&json!("ada-1")));
}

#[test]
fn inbound_linkers_count_each_linking_page_once() {
    let dir = TempDir::new("cli-inbound-linkers");
    let store = seeded(&dir);
    for (from, link_type) in [
        ("notes/plain", "mentions"),
        ("notes/plain", "cites"),
        ("notes/label", "cites"),
    ] {
        let opts = AddLinkOptions {
            link_type: Some(link_type.into()),
            link_source: Some("manual".into()),
            ..Default::default()
        };
        store.add_link(from, "people/ada", &opts).unwrap();
    }
    let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let rows = store
        .count_distinct_inbound_linkers(
            &ids(&["default", "default", "default", "other"]),
            &ids(&["people/ada", "people/ada", "people/old", "people/ada"]),
        )
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].source_id.as_str(), rows[0].slug.as_str(), rows[0].n),
        ("default", "people/ada", 2)
    );
    assert!(
        store
            .count_distinct_inbound_linkers(&[], &[])
            .unwrap()
            .is_empty()
    );
}

#[test]
fn visible_name_variants_skip_private_pages_under_the_policy() {
    let dir = TempDir::new("cli-name-variants-private");
    let store = seeded(&dir);
    put(
        &store,
        "default",
        "people/ada-private",
        json!({"type": "person", "title": "Ada", "compiled_truth": "body", "frontmatter": {"visibility": "private"}}),
    );
    let world = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    let candidates = |policy: Option<&PrivacyPolicy>| -> Vec<String> {
        store
            .list_visible_name_variant_candidates(
                "default",
                &NameVariantCandidateQuery {
                    types: vec![],
                    slug_patterns: vec!["people/%".into()],
                    probes: vec!["%ada%".into()],
                    limit: 10,
                },
                policy,
            )
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect()
    };
    assert!(candidates(None).contains(&"people/ada-private".to_string()));
    assert!(!candidates(Some(&world)).contains(&"people/ada-private".to_string()));
    assert_eq!(candidates(Some(&world)).len() + 1, candidates(None).len());

    let wanted: Vec<String> = [
        "people/ada-private",
        "people/ada-2",
        "people/missing",
        "people/ada",
        "people/ada-2",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let pages = |policy: Option<&PrivacyPolicy>| -> Vec<String> {
        store
            .read_visible_variant_pages("default", &wanted, policy)
            .unwrap()
            .into_iter()
            .map(|r| r.slug)
            .collect()
    };
    assert_eq!(
        pages(None),
        [
            "people/ada-private",
            "people/ada-2",
            "people/ada",
            "people/ada-2"
        ]
    );
    assert_eq!(
        pages(Some(&world)),
        ["people/ada-2", "people/ada", "people/ada-2"]
    );
    let row = &store
        .read_visible_variant_pages("default", &["people/ada".to_string()], None)
        .unwrap()[0];
    assert_eq!(
        (row.title.as_str(), row.page_type.as_str()),
        ("Ada", "person")
    );
    assert_eq!(row.frontmatter.get("identity"), Some(&json!("ada-1")));
}

#[test]
fn name_variant_card_candidates_are_the_visible_candidates_as_card_rows() {
    let dir = TempDir::new("cli-name-variant-cards");
    let store = seeded(&dir);
    put(
        &store,
        "default",
        "people/ada-private",
        json!({"type": "person", "title": "Ada", "compiled_truth": "secret body", "frontmatter": {"visibility": "private"}}),
    );
    let world = PrivacyPolicy {
        honor_aliases: true,
        entity_privacy: true,
        ..Default::default()
    };
    let q = NameVariantCandidateQuery {
        types: vec!["company".into()],
        slug_patterns: vec!["people/%".into()],
        probes: vec!["%ADA%".into(), "%founder%".into()],
        limit: 10,
    };
    for policy in [None, Some(&world)] {
        let cards = store
            .list_name_variant_card_candidates("default", &q, policy)
            .unwrap();
        let plain = store
            .list_visible_name_variant_candidates("default", &q, policy)
            .unwrap();
        let got: Vec<(&str, u64)> = cards
            .iter()
            .map(|r| (r.card.slug.as_str(), r.probe_hits))
            .collect();
        let want: Vec<(&str, u64)> = plain
            .iter()
            .map(|r| (r.slug.as_str(), r.probe_hits))
            .collect();
        assert_eq!(got, want);
        assert_eq!(
            cards.iter().any(|r| r.card.slug == "people/ada-private"),
            policy.is_none()
        );
    }
    let cards = store
        .list_name_variant_card_candidates("default", &q, None)
        .unwrap();
    let ada = cards.iter().find(|r| r.card.slug == "people/ada").unwrap();
    assert_eq!(
        (ada.card.source_id.as_str(), ada.card.page_type.as_str()),
        ("default", "person")
    );
    assert_eq!(ada.card.frontmatter.get("identity"), Some(&json!("ada-1")));
    assert!(ada.card.compiled_truth.is_some());
    assert_eq!(ada.card.last_retrieved_at, None);
    let row = serde_json::to_value(ada).unwrap();
    assert_eq!(row["probe_hits"], json!(1));
    assert_eq!(row["slug"], json!("people/ada"));
    assert_eq!(row["type"], json!("person"));
}
