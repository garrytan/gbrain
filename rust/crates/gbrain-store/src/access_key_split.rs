//! Format 7 to 8: the shared-skill token secret and the access member links stop sharing the key
//! prefix `x 0x04`.
//!
//! Store formats 7 and older kept two record kinds under `x 0x04`: the member links
//! (`access_member_links.rs`, keys `x 0x04 system 0x00 external_id`) and the shared-skill catalog's
//! token secret (`shared_skill_members.rs`, the one record whose key is exactly `x 0x04`). Every
//! link scan started on the secret's record and skipped it only because its key holds no NUL.
//! Format 8 keeps the links at `x 0x04` and moves the secret to `x 0x0d`; the open-time upgrade
//! (`upgrade_format` in lib.rs) does it here, in the upgrade's one transaction. The secret is one
//! record and a brain may hold thousands of links, so the secret is the kind that moves.
//!
//! A record is classified by its key and its value, and the two must agree:
//! - the token secret: the key exactly `x 0x04` and a JSON object of exactly `token_secret`, a string;
//! - a member link: key `x 0x04 system 0x00 external_id` with a system and an id the link checks
//!   accept (`access_member_links.rs`) and a JSON object of exactly `member_id` (a string) and
//!   `created_at_us` (an integer).
//!
//! A record that is neither, or whose key and value disagree, is refused: the caller turns the
//! error into `shadow_reseed_required` naming the key, and the transaction is dropped, so nothing
//! changes. A secret whose new key is already taken is refused the same way. A brain that never
//! read or minted its secret holds none under `x 0x04` and changes nothing but the number.

use crate::access_member_links::{LINK, valid_external_id, valid_system};
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvWrite, collect_prefix};
use crate::shared_skill_members::STATE;
use serde_json::Value;

/// The key as readable text, for an error message.
fn shown(key: &[u8]) -> String {
    String::from_utf8_lossy(key).escape_debug().to_string()
}

/// Whether the object has exactly the fields `names`.
fn has_exactly(object: &serde_json::Map<String, Value>, names: &[&str]) -> bool {
    object.len() == names.len() && names.iter().all(|k| object.contains_key(*k))
}

/// What a record under `x 0x04` is.
#[derive(Debug, PartialEq, Eq)]
enum Kind {
    TokenSecret,
    MemberLink,
}

/// The kind of the record at `key` holding `value`, or why it cannot be told.
fn classify(key: &[u8], value: &[u8]) -> Result<Kind> {
    let refuse = |why: &str| {
        StoreError::invalid(format!(
            "the record at key {} under the access member link prefix is {why}",
            shown(key)
        ))
    };
    let rest = key.get(2..).unwrap_or_default();
    let key_kind = if rest.is_empty() {
        Kind::TokenSecret
    } else {
        let mut parts = rest.splitn(2, |b| *b == 0);
        let system = std::str::from_utf8(parts.next().unwrap_or_default());
        let external_id = parts
            .next()
            .map(std::str::from_utf8)
            .and_then(std::result::Result::ok);
        match (system, external_id) {
            (Ok(s), Some(e)) if valid_system(s) && valid_external_id(e) => Kind::MemberLink,
            _ => {
                return Err(refuse(
                    "neither the token secret's key nor a member link key",
                ));
            }
        }
    };
    let json: Value = serde_json::from_slice(value).map_err(|_| refuse("not JSON"))?;
    let Some(object) = json.as_object() else {
        return Err(refuse("not a JSON object"));
    };
    let value_kind = if has_exactly(object, &["token_secret"]) && object["token_secret"].is_string()
    {
        Kind::TokenSecret
    } else if has_exactly(object, &["member_id", "created_at_us"])
        && object["member_id"].is_string()
        && object["created_at_us"].is_i64()
    {
        Kind::MemberLink
    } else {
        return Err(refuse(
            "neither a token secret value nor a member link value",
        ));
    };
    if key_kind != value_kind {
        return Err(refuse("a key of one kind holding a value of the other"));
    }
    Ok(key_kind)
}

/// Moves the token secret from `x 0x04` to `x 0x0d`, and leaves the member links where they are.
/// Every record is classified before one is written.
pub(crate) fn split_token_secret_from_member_links(tx: &mut dyn KvWrite) -> Result<()> {
    let prefix = [keys::ACCESS_MEMBERS, LINK];
    let mut secrets = Vec::new();
    for (key, value) in collect_prefix(&*tx, &prefix, false, usize::MAX)? {
        if classify(&key, &value)? == Kind::TokenSecret {
            secrets.push((key, value));
        }
    }
    let new = vec![keys::ACCESS_MEMBERS, STATE];
    for (old, value) in secrets {
        if tx.get(&new)?.is_some() {
            return Err(StoreError::invalid(format!(
                "the token secret at key {} is stored at both x 0x04 and x 0x0d",
                shown(&old)
            )));
        }
        tx.delete(&old)?;
        tx.put(&new, &value)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::SHADOW_RESEED_REQUIRED;
    use crate::kv::{Kv, scan_prefix};
    use crate::test_support::mem_kv;
    use crate::{FORMAT_VERSION, OpenOptions, Store, StoredFormat, SystemEnv, get_json, put_json};
    use serde_json::json;
    use std::sync::Arc;

    const OLD_STATE_KEY: [u8; 2] = [keys::ACCESS_MEMBERS, LINK];
    const NEW_STATE_KEY: [u8; 2] = [keys::ACCESS_MEMBERS, STATE];

    fn open(kv: &Arc<dyn Kv>) -> crate::Result<Store> {
        Store::open_kv(kv.clone(), Arc::new(SystemEnv), OpenOptions::default())
    }

    /// Every record of the file, in key order.
    fn dump(kv: &Arc<dyn Kv>) -> Vec<(Vec<u8>, Vec<u8>)> {
        let snapshot = kv.snapshot().unwrap();
        let mut out = Vec::new();
        scan_prefix(&*snapshot, &[], false, &mut |k, v| {
            out.push((k.to_vec(), v.to_vec()));
            true
        })
        .unwrap();
        out
    }

    fn at(records: &[(Vec<u8>, Vec<u8>)], prefix: &[u8]) -> usize {
        records
            .iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .count()
    }

    fn member(store: &Store, id: &str) {
        store
            .insert_access_member(&serde_json::from_value(json!({ "id": id })).unwrap())
            .unwrap();
    }

    /// A brain as format `version` left it: two members, three links, the token secret at
    /// `x 0x04` (when `secret` is true), and the format record at `version`. Returns the secret.
    fn old_brain(version: u32, secret: bool) -> (Arc<dyn Kv>, Option<String>) {
        let kv = mem_kv();
        let store = open(&kv).unwrap();
        member(&store, "alice-example");
        member(&store, "bob-example");
        for (system, id, who) in [
            ("qm", "U1", "alice-example"),
            ("qm", "U2", "bob-example"),
            ("slack", "U3", "alice-example"),
        ] {
            store.insert_access_member_link(system, id, who).unwrap();
        }
        let minted = store.shared_skill_token_secret().unwrap();
        drop(store);
        let mut tx = kv.begin_write().unwrap();
        let record = tx.get(&NEW_STATE_KEY).unwrap().unwrap();
        tx.delete(&NEW_STATE_KEY).unwrap();
        if secret {
            tx.put(&OLD_STATE_KEY, &record).unwrap();
        }
        let mut stored: StoredFormat = get_json(&*tx, &keys::meta("format")).unwrap().unwrap();
        stored.format_version = version;
        put_json(&mut *tx, &keys::meta("format"), &stored).unwrap();
        tx.commit().unwrap();
        (kv, secret.then_some(minted))
    }

    fn put(kv: &Arc<dyn Kv>, key: &[u8], value: &[u8]) {
        let mut tx = kv.begin_write().unwrap();
        tx.put(key, value).unwrap();
        tx.commit().unwrap();
    }

    /// What the links answer: every link as (member, system, external id), one member's links,
    /// one point read and the linked member.
    fn answers(store: &Store) -> Value {
        let ids = |rows: Value| -> Vec<String> {
            rows.as_array()
                .unwrap()
                .iter()
                .map(|r| format!("{} {} {}", r["member_id"], r["system"], r["external_id"]))
                .collect()
        };
        json!({
            "links": ids(store.list_access_member_links(None).unwrap()),
            "alice": ids(store.list_access_member_links(Some("alice-example")).unwrap()),
            "read": store.read_access_member_link("qm", "U2").unwrap().unwrap()["member_id"],
            "linked": store.read_linked_member("slack", "U3").unwrap().unwrap()["id"],
        })
    }

    fn expected() -> Value {
        json!({
            "links": [
                "\"alice-example\" \"qm\" \"U1\"",
                "\"alice-example\" \"slack\" \"U3\"",
                "\"bob-example\" \"qm\" \"U2\"",
            ],
            "alice": ["\"alice-example\" \"qm\" \"U1\"", "\"alice-example\" \"slack\" \"U3\""],
            "read": "bob-example",
            "linked": "alice-example",
        })
    }

    /// Opens a format-7 brain on a record store whose write transactions fail with `code` on the
    /// token secret's records: the open reports that error as it is, says nothing about a re-seed,
    /// and changes nothing (the carry-over rule of `carry_over_failure`).
    fn open_format_7_on_failing_disk(code: &'static str) {
        let (inner, _) = old_brain(7, true);
        let before = dump(&inner);
        let kv: Arc<dyn Kv> = Arc::new(crate::test_support::FaultyKv {
            inner: inner.clone(),
            code,
            ops: &[
                crate::test_support::FaultOp::Scan,
                crate::test_support::FaultOp::Put,
            ],
            fail_on: |key| {
                key.starts_with(&[keys::ACCESS_MEMBERS, LINK])
                    || key.starts_with(&[keys::ACCESS_MEMBERS, STATE])
            },
        });
        let err = Store::open_kv(kv, Arc::new(SystemEnv), OpenOptions::default())
            .err()
            .expect("the open must fail");
        assert_eq!(err.code, code, "{}", err.message);
        assert!(
            !err.message.contains("Re-seed") && !err.message.contains("gbrain engine shadow"),
            "an I/O or storage error must not tell the person to re-seed: {}",
            err.message
        );
        assert_eq!(dump(&inner), before);
    }

    #[test]
    fn an_io_error_while_sorting_the_token_secret_is_reported_as_store_io_not_as_a_reseed() {
        open_format_7_on_failing_disk(crate::error::STORE_IO);
    }

    #[test]
    fn a_corrupt_record_store_while_sorting_the_token_secret_is_reported_as_store_corrupt() {
        open_format_7_on_failing_disk(crate::error::STORE_CORRUPT);
    }

    #[test]
    fn a_new_brain_keeps_its_token_secret_off_the_member_link_prefix() {
        let kv = mem_kv();
        let store = open(&kv).unwrap();
        member(&store, "alice-example");
        store
            .insert_access_member_link("qm", "U1", "alice-example")
            .unwrap();
        let secret = store.shared_skill_token_secret().unwrap();
        drop(store);
        let records = dump(&kv);
        assert_eq!(at(&records, &OLD_STATE_KEY), 1);
        assert_eq!(at(&records, &NEW_STATE_KEY), 1);
        let secret_record = records.iter().find(|(k, _)| k == &NEW_STATE_KEY).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&secret_record.1).unwrap(),
            json!({ "token_secret": secret })
        );
    }

    #[test]
    fn a_format_7_brain_with_both_kinds_opens_as_format_8_and_answers_both_reads() {
        let (kv, secret) = old_brain(7, true);
        let before = dump(&kv);
        assert_eq!(
            (at(&before, &OLD_STATE_KEY), at(&before, &NEW_STATE_KEY)),
            (4, 0)
        );
        let store = open(&kv).unwrap();
        assert_eq!(store.info().format_version, FORMAT_VERSION);
        assert_eq!(FORMAT_VERSION, 8);
        // The secret is the one it was, not a new one, and the three links are all there.
        assert_eq!(store.shared_skill_token_secret().unwrap(), secret.unwrap());
        assert_eq!(answers(&store), expected());
        drop(store);
        let after = dump(&kv);
        assert_eq!(
            (at(&after, &OLD_STATE_KEY), at(&after, &NEW_STATE_KEY)),
            (3, 1)
        );
        // Opening again changes nothing.
        drop(open(&kv).unwrap());
        assert_eq!(dump(&kv), after);
    }

    #[test]
    fn a_brain_older_than_format_7_converts_through_to_format_8() {
        for version in 1..=6 {
            let (kv, secret) = old_brain(version, true);
            let store = open(&kv).unwrap_or_else(|e| panic!("format {version}: {e:?}"));
            assert_eq!(
                store.info().format_version,
                FORMAT_VERSION,
                "format {version}"
            );
            assert_eq!(
                store.shared_skill_token_secret().unwrap(),
                secret.unwrap(),
                "format {version}"
            );
            assert_eq!(answers(&store), expected(), "format {version}");
            drop(store);
            let after = dump(&kv);
            assert_eq!(
                (at(&after, &OLD_STATE_KEY), at(&after, &NEW_STATE_KEY)),
                (3, 1),
                "format {version}"
            );
        }
    }

    #[test]
    fn a_format_7_brain_that_never_held_a_secret_changes_only_its_number() {
        let (kv, _) = old_brain(7, false);
        let store = open(&kv).unwrap();
        assert_eq!(store.info().format_version, FORMAT_VERSION);
        assert_eq!(at(&dump(&kv), &NEW_STATE_KEY), 0);
        // The first read mints one at the new key, and a link read still sees three links.
        let secret = store.shared_skill_token_secret().unwrap();
        assert_eq!(secret.len(), 64);
        assert_eq!(answers(&store), expected());
        drop(store);
        let after = dump(&kv);
        assert_eq!(
            (at(&after, &OLD_STATE_KEY), at(&after, &NEW_STATE_KEY)),
            (3, 1)
        );
    }

    /// Opening `kv` is refused with `shadow_reseed_required` naming `named`, and nothing changed.
    fn refused(kv: &Arc<dyn Kv>, named: &str) {
        let before = dump(kv);
        let Err(e) = open(kv) else {
            panic!("the brain opened");
        };
        assert_eq!(e.code, SHADOW_RESEED_REQUIRED, "{}", e.message);
        assert!(
            e.message.contains(named),
            "{} does not name {named}",
            e.message
        );
        assert!(e.message.contains("nothing was changed"), "{}", e.message);
        assert_eq!(dump(kv), before, "the refused brain was changed");
        let stored: StoredFormat = get_json(&*kv.snapshot().unwrap(), &keys::meta("format"))
            .unwrap()
            .unwrap();
        assert_eq!(stored.format_version, 7);
    }

    #[test]
    fn a_record_under_the_prefix_that_is_neither_kind_refuses_the_brain_and_changes_nothing() {
        let junk = |name: &str, key: &[u8], value: &[u8]| {
            let (kv, _) = old_brain(7, true);
            put(&kv, &[&OLD_STATE_KEY[..], key].concat(), value);
            refused(&kv, name);
        };
        // A key with no NUL that is not the secret's.
        junk("lonely", b"lonely", b"{}");
        // A system the link check would refuse.
        junk(
            "Bad\\0U9",
            b"Bad\0U9",
            br#"{"member_id":"alice-example","created_at_us":5}"#,
        );
        // An empty system, and an empty external id.
        junk(
            "\\0U9",
            b"\0U9",
            br#"{"member_id":"alice-example","created_at_us":5}"#,
        );
        junk(
            "qm\\0",
            b"qm\0",
            br#"{"member_id":"alice-example","created_at_us":5}"#,
        );
        // A link whose value is not JSON, and one with fields of neither kind.
        junk("qm\\0U9", b"qm\0U9", b"not json");
        junk("qm\\0U9", b"qm\0U9", br#"{"member_id":"a","extra":true}"#);
        // A link's key holding the secret's value, and the secret's key holding a link's.
        junk("qm\\0U9", b"qm\0U9", br#"{"token_secret":"ab"}"#);
        let (kv, _) = old_brain(7, true);
        put(
            &kv,
            &OLD_STATE_KEY,
            br#"{"member_id":"alice-example","created_at_us":5}"#,
        );
        refused(&kv, "x\\u{4}");
    }

    #[test]
    fn a_secret_stored_at_both_keys_refuses_the_brain() {
        let (kv, _) = old_brain(7, true);
        put(&kv, &NEW_STATE_KEY, br#"{"token_secret":"cd"}"#);
        refused(&kv, "x\\u{4}");
    }
}
