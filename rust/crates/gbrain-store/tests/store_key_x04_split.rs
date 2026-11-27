//! Access member links and the shared-skill catalog's token secret are two record kinds. They
//! once shared the store key prefix `x 0x04` (links `x 0x04 system \0 external_id`, the secret
//! exactly `x 0x04`), so every link scan started on the secret's record and every read of the
//! secret sat next to the links. Each kind must read as if the other did not exist.
//!
//! On the store before the split no read returned the secret to a link caller: the link listing
//! skipped the record because its key holds no NUL, and a link key always holds one. These tests
//! pin that, and pin where the two kinds live, which is what the split changes.

use gbrain_store::access_members::AccessMemberInsert;
use gbrain_store::redb_kv::RedbKv;
use gbrain_store::{Kv, OpenOptions, Store, SystemEnv, keys};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

/// One record: its key and its value.
type Record = (Vec<u8>, Vec<u8>);

static NEXT: AtomicU32 = AtomicU32::new(0);

/// A store on a record file of its own, and a second handle on the same records to read keys.
struct Brain {
    store: Store,
    kv: Arc<dyn Kv>,
    dir: PathBuf,
}

impl Drop for Brain {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn brain(name: &str) -> Brain {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
        "{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let kv: Arc<dyn Kv> = Arc::new(RedbKv::open_path(&dir.join("records.redb")).unwrap());
    let store = Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default()).unwrap();
    Brain { store, kv, dir }
}

fn member(store: &Store, id: &str) {
    let spec: AccessMemberInsert = serde_json::from_value(json!({ "id": id })).unwrap();
    store.insert_access_member(&spec).unwrap();
}

/// Two members and three links: `qm` and `slack` are two systems of the same trusted kind.
fn with_links(name: &str) -> Brain {
    let b = brain(name);
    member(&b.store, "alice-example");
    member(&b.store, "bob-example");
    b.store
        .insert_access_member_link("qm", "U1", "alice-example")
        .unwrap();
    b.store
        .insert_access_member_link("qm", "U2", "bob-example")
        .unwrap();
    b.store
        .insert_access_member_link("slack", "U3", "alice-example")
        .unwrap();
    b
}

/// Every record of the file, in key order.
fn dump(kv: &Arc<dyn Kv>) -> Vec<Record> {
    let snapshot = kv.snapshot().unwrap();
    let mut out = Vec::new();
    gbrain_store::kv::scan_prefix(&*snapshot, &[], false, &mut |k, v| {
        out.push((k.to_vec(), v.to_vec()));
        true
    })
    .unwrap();
    out
}

/// The record that holds `secret`, and the records that are links, by their value fields.
fn secret_and_links(kv: &Arc<dyn Kv>, secret: &str) -> (Vec<Record>, Vec<Record>) {
    let (mut holders, mut links) = (Vec::new(), Vec::new());
    for (key, value) in dump(kv) {
        if key.first() != Some(&keys::ACCESS_MEMBERS) {
            continue;
        }
        let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(&value) else {
            continue;
        };
        let mut names: Vec<&str> = fields.keys().map(String::as_str).collect();
        names.sort();
        if fields.get("token_secret").and_then(Value::as_str) == Some(secret) {
            holders.push((key, value));
        } else if names == ["created_at_us", "member_id"] {
            links.push((key, value));
        }
    }
    (holders, links)
}

fn ids(rows: &Value) -> Vec<(String, String, String)> {
    rows.as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["member_id"].as_str().unwrap().to_owned(),
                r["system"].as_str().unwrap().to_owned(),
                r["external_id"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn triples(rows: &[(&str, &str, &str)]) -> Vec<(String, String, String)> {
    rows.iter()
        .map(|(m, s, e)| ((*m).into(), (*s).into(), (*e).into()))
        .collect()
}

#[test]
fn the_links_listing_does_not_see_parse_or_return_the_secret() {
    let b = with_links("x04-list");
    let secret = b.store.shared_skill_token_secret().unwrap();
    assert_eq!(secret.len(), 64);
    let all = b.store.list_access_member_links(None).unwrap();
    assert_eq!(
        ids(&all),
        triples(&[
            ("alice-example", "qm", "U1"),
            ("alice-example", "slack", "U3"),
            ("bob-example", "qm", "U2"),
        ])
    );
    assert!(!all.to_string().contains(&secret));
    for (member, expected) in [
        (
            "alice-example",
            triples(&[
                ("alice-example", "qm", "U1"),
                ("alice-example", "slack", "U3"),
            ]),
        ),
        ("bob-example", triples(&[("bob-example", "qm", "U2")])),
        ("nobody", vec![]),
    ] {
        let rows = b.store.list_access_member_links(Some(member)).unwrap();
        assert_eq!(ids(&rows), expected, "{member}");
        assert!(!rows.to_string().contains(&secret), "{member}");
    }
    // No point read of a link answers with the secret's record, whatever it is asked for.
    for (system, external_id) in [("", ""), ("", "U1"), ("qm", ""), ("qm", "token_secret")] {
        assert_eq!(
            b.store
                .read_access_member_link(system, external_id)
                .unwrap(),
            None,
            "{system:?} {external_id:?}"
        );
        assert_eq!(
            b.store.read_linked_member(system, external_id).unwrap(),
            None
        );
    }
}

#[test]
fn deleting_and_listing_links_never_touches_the_secret() {
    let b = with_links("x04-delete");
    let secret = b.store.shared_skill_token_secret().unwrap();
    let (before, _) = secret_and_links(&b.kv, &secret);
    assert_eq!(before.len(), 1);
    // A delete that names the secret's shape (no system, no id) removes nothing.
    b.store.delete_access_member_link("", "").unwrap();
    assert_eq!(
        b.store
            .list_access_member_links(None)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        3
    );
    for (system, external_id) in [("qm", "U1"), ("qm", "U2"), ("slack", "U3"), ("qm", "U1")] {
        b.store
            .delete_access_member_link(system, external_id)
            .unwrap();
    }
    assert_eq!(b.store.list_access_member_links(None).unwrap(), json!([]));
    assert_eq!(b.store.shared_skill_token_secret().unwrap(), secret);
    let (after, links) = secret_and_links(&b.kv, &secret);
    assert_eq!(after, before, "a link write changed the secret's record");
    assert!(links.is_empty());
}

#[test]
fn reading_the_secret_does_not_see_or_change_the_links() {
    let b = with_links("x04-secret");
    let secret = b.store.shared_skill_token_secret().unwrap();
    let (_, links_before) = secret_and_links(&b.kv, &secret);
    assert_eq!(links_before.len(), 3);
    for _ in 0..3 {
        assert_eq!(b.store.shared_skill_token_secret().unwrap(), secret);
    }
    let (holders, links_after) = secret_and_links(&b.kv, &secret);
    assert_eq!(holders.len(), 1);
    assert_eq!(links_after, links_before);
    assert_eq!(
        b.store
            .list_access_member_links(None)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn the_secret_and_the_links_live_under_different_key_prefixes() {
    let b = with_links("x04-layout");
    let secret = b.store.shared_skill_token_secret().unwrap();
    let (holders, links) = secret_and_links(&b.kv, &secret);
    assert_eq!(holders.len(), 1);
    assert_eq!(links.len(), 3);
    let secret_prefix = holders[0].0[..2].to_vec();
    let link_prefix = links[0].0[..2].to_vec();
    assert!(links.iter().all(|(k, _)| k[..2] == link_prefix[..]));
    assert_ne!(
        secret_prefix, link_prefix,
        "the token secret and the member links share the key prefix {secret_prefix:02x?}"
    );
    // Every record under each kind's prefix is that kind: a link scan reads links only, and the
    // secret's prefix holds the secret only.
    let under = |prefix: &[u8]| -> Vec<Vec<u8>> {
        dump(&b.kv)
            .into_iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .map(|(k, _)| k)
            .collect()
    };
    assert_eq!(
        under(&link_prefix),
        links.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>()
    );
    assert_eq!(
        under(&secret_prefix),
        holders.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>()
    );
}
