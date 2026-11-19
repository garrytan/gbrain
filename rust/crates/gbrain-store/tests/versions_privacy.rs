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
