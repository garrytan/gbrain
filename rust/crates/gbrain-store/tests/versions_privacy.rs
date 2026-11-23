//! `getVersions` with `excludePrivate` (`VersionsOptions::exclude_private`): a caller's page policy
//! hides a live page it cannot read (no snapshot listed) and each snapshot it cannot read
//! (`facts::caller_version_hidden`), before `limit`. A snapshot that names readers is hidden from a
//! caller none of whose principals match; with the entity privacy part, a private or
//! `pinned_question` snapshot is hidden too, unless (for a private one) the caller's private-readable
//! grant covers the page's source.

mod common;

use common::TempDir;
use gbrain_store::facts::PrivacyPolicy;
use gbrain_store::pages::{PageInput, PutPageOptions, VersionsOptions};
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{OpenOptions, Store, SystemEnv};
use serde_json::{Value, json};
use std::sync::Arc;

fn brain(name: &str) -> (TempDir, Store) {
    let dir = TempDir::new(name);
    let kv = Arc::new(RedbKv::open_path(&dir.path().join("records.redb")).unwrap());
    let store = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    (dir, store)
}

/// Writes `slug` with `frontmatter` (plus the marker `n`), then snapshots it.
fn snapshot(store: &Store, slug: &str, n: u64, frontmatter: Value) {
    let mut fm = frontmatter.as_object().cloned().unwrap_or_default();
    fm.insert("n".into(), json!(n));
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": format!("body {n}"), "frontmatter": fm,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({"index": false})).unwrap();
    store.put_page(slug, &input, &options).unwrap();
    store.create_version(slug, None).unwrap();
}

/// The markers of the snapshots `get_versions` lists, newest first.
fn markers(
    store: &Store,
    slug: &str,
    policy: Option<PrivacyPolicy>,
    limit: Option<usize>,
) -> Vec<u64> {
    let options = VersionsOptions {
        limit,
        exclude_private: policy,
        ..VersionsOptions::default()
    };
    let mut seen = Vec::new();
    for row in store.get_versions(slug, &options).unwrap() {
        if let Some(n) = row["frontmatter"]["n"].as_u64()
            && !seen.contains(&n)
        {
            seen.push(n);
        }
    }
    seen
}

fn caller(identity: &[&str], entity_privacy: bool, grant: &[&str]) -> PrivacyPolicy {
    PrivacyPolicy {
        entity_privacy,
        identity: identity.iter().map(|s| s.to_string()).collect(),
        private_readable_sources: grant.iter().map(|s| s.to_string()).collect(),
        ..PrivacyPolicy::default()
    }
}

/// Snapshots 1..5 of one world page: world, readers bob only, private, pinned question, and
/// a world snapshot as the newest. The live page is the last write (world).
fn history(store: &Store) {
    snapshot(store, "notes/doc", 1, json!({"visibility": "world"}));
    snapshot(
        store,
        "notes/doc",
        2,
        json!({"readable_by": ["bob-example"]}),
    );
    snapshot(store, "notes/doc", 3, json!({"visibility": "private"}));
    snapshot(store, "notes/doc", 4, json!({"pinned_question": "why?"}));
    snapshot(store, "notes/doc", 5, json!({"visibility": "world"}));
}

#[test]
fn a_caller_sees_only_the_snapshots_its_policy_reads_before_the_limit() {
    let (_dir, store) = brain("versions-privacy-snapshots");
    history(&store);

    // No policy: every snapshot, newest first.
    assert_eq!(
        markers(&store, "notes/doc", None, None),
        vec![5, 4, 3, 2, 1]
    );

    // A caller who is not bob, judged by readers only: snapshot 2 is hidden.
    let alice = caller(&["member:alice-example"], false, &[]);
    assert_eq!(
        markers(&store, "notes/doc", Some(alice.clone()), None),
        vec![5, 4, 3, 1]
    );

    // bob reads his own snapshot.
    let bob = caller(&["member:bob-example"], false, &[]);
    assert_eq!(
        markers(&store, "notes/doc", Some(bob), None),
        vec![5, 4, 3, 2, 1]
    );

    // With the entity privacy part, the private and pinned-question snapshots are hidden too.
    let alice_private = caller(&["member:alice-example"], true, &[]);
    assert_eq!(
        markers(&store, "notes/doc", Some(alice_private.clone()), None),
        vec![5, 1]
    );

    // The filter runs before the limit: the two newest visible snapshots, not the two newest rows.
    assert_eq!(
        markers(&store, "notes/doc", Some(alice_private), Some(2)),
        vec![5, 1]
    );
    assert_eq!(
        markers(&store, "notes/doc", Some(alice), Some(2)),
        vec![5, 4]
    );
}

#[test]
fn a_private_readable_grant_opens_private_snapshots_but_never_a_pinned_question() {
    let (_dir, store) = brain("versions-privacy-grant");
    history(&store);
    let granted = caller(&["member:alice-example"], true, &["default"]);
    assert_eq!(
        markers(&store, "notes/doc", Some(granted), None),
        vec![5, 3, 1]
    );
    let other_grant = caller(&["member:alice-example"], true, &["elsewhere"]);
    assert_eq!(
        markers(&store, "notes/doc", Some(other_grant), None),
        vec![5, 1]
    );
}

#[test]
fn a_live_page_the_caller_cannot_read_lists_no_snapshot() {
    let (_dir, store) = brain("versions-privacy-live");
    snapshot(&store, "notes/secret", 1, json!({"visibility": "world"}));
    snapshot(
        &store,
        "notes/secret",
        2,
        json!({"readable_by": ["bob-example"]}),
    );
    // The live page now names bob as its only reader: alice gets no snapshot, even the world one.
    let alice = caller(&["member:alice-example"], false, &[]);
    assert_eq!(
        markers(&store, "notes/secret", Some(alice), None),
        Vec::<u64>::new()
    );
    let bob = caller(&["member:bob-example"], false, &[]);
    assert_eq!(markers(&store, "notes/secret", Some(bob), None), vec![2, 1]);
}

/// Writes `slug` with `frontmatter` and `body`, then snapshots it with `reason`.
fn snapshot_with_reason(store: &Store, slug: &str, body: &str, frontmatter: Value, reason: &str) {
    write(store, slug, body, frontmatter);
    store.create_version_with(slug, None, Some(reason)).unwrap();
}

fn write(store: &Store, slug: &str, body: &str, frontmatter: Value) {
    let input: PageInput = serde_json::from_value(json!({
        "type": "note", "title": slug, "compiled_truth": body, "frontmatter": frontmatter,
    }))
    .unwrap();
    let options: PutPageOptions = serde_json::from_value(json!({"index": false})).unwrap();
    store.put_page(slug, &input, &options).unwrap();
}

/// The `replaced_because` of each snapshot `get_versions` lists, newest first.
fn reasons(store: &Store, slug: &str, policy: Option<PrivacyPolicy>) -> Vec<Value> {
    let options = VersionsOptions {
        exclude_private: policy,
        ..VersionsOptions::default()
    };
    store
        .get_versions(slug, &options)
        .unwrap()
        .iter()
        .map(|v| v["replaced_because"].clone())
        .collect()
}

/// GBRA-217 (`replacedBecauseSql`): under `excludePrivate` a snapshot's reason is shown only when the
/// next snapshot of the page (over every snapshot, never only the visible ones; the live page for
/// the newest) is world-visible and names no reader the caller does not meet. The successor's own
/// fields decide, whatever the caller's entity privacy part or private-readable grant.
#[test]
fn a_caller_never_reads_the_reason_a_hidden_successor_gave() {
    let (_dir, store) = brain("versions-privacy-successor-reason");
    let slug = "notes/why";
    snapshot_with_reason(&store, slug, "one", json!({"visibility": "world"}), "r1");
    snapshot_with_reason(&store, slug, "two", json!({"visibility": "world"}), "r2");
    snapshot_with_reason(
        &store,
        slug,
        "three",
        json!({"visibility": "private"}),
        "r3",
    );
    snapshot_with_reason(
        &store,
        slug,
        "four",
        json!({"readable_by": ["bob-example"]}),
        "r4",
    );
    write(&store, slug, "live", json!({"visibility": "world"}));

    // The trusted read: every stored reason.
    assert_eq!(
        reasons(&store, slug, None),
        [json!("r4"), json!("r3"), json!("r2"), json!("r1")]
    );
    // alice sees snapshots 2 and 1; snapshot 2's successor (3) is private.
    let alice = caller(&["member:alice-example"], true, &[]);
    assert_eq!(
        reasons(&store, slug, Some(alice)),
        [Value::Null, json!("r1")]
    );
    // bob also sees snapshot 4, whose successor is the world live page.
    let bob = caller(&["member:bob-example"], true, &[]);
    assert_eq!(
        reasons(&store, slug, Some(bob)),
        [json!("r4"), Value::Null, json!("r1")]
    );
    // Without the entity privacy part bob sees snapshot 3 too (its successor names him), and the
    // private successor still withholds snapshot 2's reason.
    let bob_open = caller(&["member:bob-example"], false, &[]);
    assert_eq!(
        reasons(&store, slug, Some(bob_open)),
        [json!("r4"), json!("r3"), Value::Null, json!("r1")]
    );
    // alice's private-readable grant opens snapshot 3, not its successor's readers, and never the
    // private successor of snapshot 2.
    let alice_granted = caller(&["member:alice-example"], true, &["default"]);
    assert_eq!(
        reasons(&store, slug, Some(alice_granted)),
        [Value::Null, Value::Null, json!("r1")]
    );
}

/// GBRA-217: a snapshot whose successor a prune deleted (`successor_pruned`) keeps its reason from
/// every `excludePrivate` reader, since the successor's visibility can no longer be checked.
#[test]
fn a_caller_never_reads_the_reason_of_a_snapshot_whose_successor_was_pruned() {
    let (_dir, store) = brain("versions-privacy-successor-pruned");
    let slug = "notes/grown";
    snapshot_with_reason(&store, slug, "Small.", json!({}), "grew");
    write(&store, slug, &"x".repeat(1024 * 1024 + 1), json!({}));
    for _ in 0..6 {
        store.create_version_with(slug, None, None).unwrap();
    }
    let trusted = reasons(&store, slug, None);
    assert_eq!(
        trusted.len(),
        6,
        "five large versions and the small one stay"
    );
    assert_eq!(trusted[5], json!("grew"));
    let anyone = caller(&[], true, &[]);
    let remote = reasons(&store, slug, Some(anyone));
    assert_eq!(remote.len(), 6);
    assert_eq!(remote[5], Value::Null);
}
