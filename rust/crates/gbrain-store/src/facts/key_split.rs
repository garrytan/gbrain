//! Format 6 to 7: the take purge ledger and the loop mutes stop sharing the key prefix `F 0x10`.
//!
//! Store formats 6 and older kept two record kinds under `F 0x10`: the take purge tombstones
//! (`facts/take_purges.rs`) and the loop mutes (`facts/loops/mutes.rs`). Every read of one scanned
//! the other: a mute made the source report a take purge, and a take purge read as a corrupt mute.
//! Format 7 keeps the take purges at `F 0x10` and moves each mute to `F 0x11`; the open-time upgrade
//! (`upgrade_format` in lib.rs) does it here, in the upgrade's one transaction.
//!
//! A record is classified by its key and its value, and the two must agree:
//! - a take purge: key `F 0x10 source \0 subject \0 claim_hash \0` (three NULs after the prefix,
//!   the last one trailing) and a JSON object of exactly `purged_at_us` and, optionally,
//!   `request_id`;
//! - a loop mute: key `F 0x10 source \0 kind \0 value` (exactly two NULs; the value may be empty,
//!   so the key can end in the second NUL), `kind` `sender` or `thread`, and a JSON object of
//!   exactly `id` and `created_at_us`.
//!
//! A record that is neither, or whose key and value disagree, is refused: the caller turns the
//! error into `shadow_reseed_required` naming the key, and the transaction is dropped, so nothing
//! changes. A mute whose new key is already taken is refused the same way. A file system or
//! storage engine failure (`store_io`, `store_corrupt`) in any step is not a refusal: the caller
//! reports it with its own code (`carry_over_failure` in lib.rs), and nothing changes either.

use super::loops::mutes::SUPPRESSION;
use super::take_purges::TAKE_PURGE;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvWrite, collect_prefix};
use serde_json::Value;

/// What a record under `F 0x10` is.
#[derive(Debug, PartialEq, Eq)]
enum Kind {
    TakePurge,
    LoopMute,
}

/// The key as readable text, for an error message.
fn shown(key: &[u8]) -> String {
    String::from_utf8_lossy(key).escape_debug().to_string()
}

/// Whether the object's keys are all in `allowed` and every one of `required` is present.
fn has_fields(
    object: &serde_json::Map<String, Value>,
    required: &[&str],
    allowed: &[&str],
) -> bool {
    object.keys().all(|k| allowed.contains(&k.as_str()))
        && required.iter().all(|k| object.contains_key(*k))
}

/// The kind of the record at `key` holding `value`, or why it cannot be told.
fn classify(key: &[u8], value: &[u8]) -> Result<Kind> {
    let refuse = |why: &str| {
        StoreError::invalid(format!(
            "the record at key {} under the take purge and loop mute prefix is {why}",
            shown(key)
        ))
    };
    let rest = key.get(2..).unwrap_or_default();
    let nuls = rest.iter().filter(|b| **b == 0).count();
    let key_kind = match (nuls, rest.last()) {
        (3, Some(0)) => Kind::TakePurge,
        // A mute with an empty value ends in its second NUL (`F 0x10 source \0 kind \0`), which the
        // old writer accepts; a take purge key has three.
        (2, Some(_)) => Kind::LoopMute,
        _ => return Err(refuse("neither a take purge key nor a loop mute key")),
    };
    let json: Value = serde_json::from_slice(value).map_err(|_| refuse("not JSON"))?;
    let Some(object) = json.as_object() else {
        return Err(refuse("not a JSON object"));
    };
    let value_kind = if has_fields(object, &["purged_at_us"], &["purged_at_us", "request_id"])
        && object["purged_at_us"].is_i64()
    {
        Kind::TakePurge
    } else if has_fields(object, &["id", "created_at_us"], &["id", "created_at_us"])
        && object["id"].is_u64()
        && object["created_at_us"].is_i64()
    {
        Kind::LoopMute
    } else {
        return Err(refuse("neither a take purge value nor a loop mute value"));
    };
    if key_kind != value_kind {
        return Err(refuse("a key of one kind holding a value of the other"));
    }
    if key_kind == Kind::LoopMute {
        let mut parts = rest.split(|b| *b == 0);
        let kind = parts.nth(1).unwrap_or_default();
        if kind != b"sender" && kind != b"thread" {
            return Err(refuse("a loop mute whose kind is not sender or thread"));
        }
    }
    Ok(key_kind)
}

/// Moves every loop mute from `F 0x10` to `F 0x11`, and leaves the take purges where they are.
/// Every record is classified before one is written, and a brain without a mute changes nothing.
pub(crate) fn split_take_purges_from_loop_mutes(tx: &mut dyn KvWrite) -> Result<()> {
    let prefix = [keys::FACT, TAKE_PURGE];
    let mut moves = Vec::new();
    for (key, value) in collect_prefix(&*tx, &prefix, false, usize::MAX)? {
        if classify(&key, &value)? == Kind::LoopMute {
            moves.push((key, value));
        }
    }
    for (old, value) in moves {
        let mut new = vec![keys::FACT, SUPPRESSION];
        new.extend_from_slice(&old[prefix.len()..]);
        if tx.get(&new)?.is_some() {
            return Err(StoreError::invalid(format!(
                "the loop mute at key {} is stored at both F 0x10 and F 0x11",
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
    use crate::FORMAT_VERSION;
    use crate::error::SHADOW_RESEED_REQUIRED;
    use crate::facts::take_purges::TakePurgeInsert;
    use crate::kv::{Kv, scan_prefix};
    use crate::sources::SourceInput;
    use crate::test_support::{FaultOp, FaultyKv, mem_kv};
    use crate::{OpenOptions, Store, StoredFormat, SystemEnv, get_json, put_json};
    use serde_json::json;
    use std::sync::Arc;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const REQUEST: &str = "6f9619ff-8b86-4d01-b42d-00cf4fc964aa";

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

    /// A brain as format `version` left it: one mute of each kind, a thread mute and two take
    /// purges, the mutes under `F 0x10` beside the purges, and the format record at `version`.
    fn old_brain(version: u32) -> Arc<dyn Kv> {
        let kv = mem_kv();
        let store = open(&kv).unwrap();
        store
            .upsert_source(&SourceInput {
                id: "g1".into(),
                ..SourceInput::default()
            })
            .unwrap();
        store
            .add_loop_suppression("g1", "sender", "alerts@bank-example.test")
            .unwrap();
        store.add_loop_suppression("g1", "thread", HASH).unwrap();
        for (subject, hash) in [("*", HASH), ("sender", "bbbb")] {
            store
                .insert_take_purge(&TakePurgeInsert {
                    source_id: "g1".into(),
                    subject: subject.into(),
                    claim_hash: hash.into(),
                    request_id: Some(REQUEST.into()),
                })
                .unwrap();
        }
        drop(store);
        let mut tx = kv.begin_write().unwrap();
        let new_prefix = [keys::FACT, SUPPRESSION];
        for (key, value) in collect_prefix(&*tx, &new_prefix, false, usize::MAX).unwrap() {
            tx.delete(&key).unwrap();
            let mut old = vec![keys::FACT, TAKE_PURGE];
            old.extend_from_slice(&key[2..]);
            tx.put(&old, &value).unwrap();
        }
        let mut stored: StoredFormat = get_json(&*tx, &keys::meta("format")).unwrap().unwrap();
        stored.format_version = version;
        put_json(&mut *tx, &keys::meta("format"), &stored).unwrap();
        tx.commit().unwrap();
        kv
    }

    fn put(kv: &Arc<dyn Kv>, key: &[u8], value: &[u8]) {
        let mut tx = kv.begin_write().unwrap();
        tx.put(key, value).unwrap();
        tx.commit().unwrap();
    }

    /// What the two kinds answer on source `g1`.
    fn answers(store: &Store) -> serde_json::Value {
        json!({
            "mutes": store.list_loop_suppressions("g1").unwrap(),
            "flags": store.read_source_purge_flags("g1").unwrap(),
            "recentRequests": store.list_recent_purge_requests(30, 100).unwrap(),
            "tombstones": store.read_belief_tombstones(&crate::trust::belief_events::TombstoneQuery {
                source_id: "g1".into(),
                fact_fps: vec![],
                take_fps: vec![HASH.into(), "bbbb".into(), "alerts@bank-example.test".into()],
            }).unwrap().fps,
        })
    }

    /// The tombstones the take purges answer.
    fn answers_of_purges(store: &Store) -> serde_json::Value {
        answers(store)["tombstones"].clone()
    }

    fn expected() -> serde_json::Value {
        json!({
            "mutes": [
                { "kind": "sender", "value": "alerts@bank-example.test" },
                { "kind": "thread", "value": HASH },
            ],
            "flags": [false, true],
            "recentRequests": [REQUEST],
            "tombstones": [HASH, "bbbb"],
        })
    }

    #[test]
    fn a_new_brain_keeps_its_loop_mutes_off_the_take_purge_prefix() {
        // A brain this build wrote keeps its mutes at 0x11 and none at 0x10.
        let kv2 = mem_kv();
        let store = open(&kv2).unwrap();
        store
            .upsert_source(&SourceInput {
                id: "g1".into(),
                ..SourceInput::default()
            })
            .unwrap();
        store.add_loop_suppression("g1", "sender", "x").unwrap();
        drop(store);
        let at = |kv: &Arc<dyn Kv>, tag: u8| {
            dump(kv)
                .into_iter()
                .filter(|(k, _)| k.starts_with(&[keys::FACT, tag]))
                .count()
        };
        assert_eq!((at(&kv2, SUPPRESSION), at(&kv2, TAKE_PURGE)), (1, 0));
    }

    #[test]
    fn a_format_6_brain_with_both_kinds_opens_as_format_7_and_answers_both_reads() {
        let kv = old_brain(6);
        let before = dump(&kv);
        let tags = |records: &[(Vec<u8>, Vec<u8>)], tag: u8| {
            records
                .iter()
                .filter(|(k, _)| k.starts_with(&[keys::FACT, tag]))
                .count()
        };
        assert_eq!(
            (tags(&before, TAKE_PURGE), tags(&before, SUPPRESSION)),
            (4, 0)
        );
        let store = open(&kv).unwrap();
        assert_eq!(store.info().format_version, FORMAT_VERSION);
        assert_eq!(answers(&store), expected());
        drop(store);
        let after = dump(&kv);
        assert_eq!(
            (tags(&after, TAKE_PURGE), tags(&after, SUPPRESSION)),
            (2, 2)
        );
        // Opening again changes nothing.
        let again = open(&kv).unwrap();
        assert_eq!(answers(&again), expected());
        drop(again);
        let stable: Vec<_> = dump(&kv);
        assert_eq!(stable, after);
    }

    #[test]
    fn a_brain_older_than_format_6_converts_through_to_format_7() {
        for version in 1..=5 {
            let kv = old_brain(version);
            let store = open(&kv).unwrap_or_else(|e| panic!("format {version}: {e:?}"));
            assert_eq!(
                store.info().format_version,
                FORMAT_VERSION,
                "format {version}"
            );
            assert_eq!(answers(&store), expected(), "format {version}");
        }
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
        assert_eq!(stored.format_version, 6);
    }

    /// Opens a format-6 brain on a record store whose write transactions fail with `code` on `ops`
    /// when `fail_on` accepts the key: the open reports that error as it is, says nothing about
    /// re-seeding, and changes nothing; then the same brain opens and converts once the disk works.
    fn open_on_failing_disk(
        code: &'static str,
        ops: &'static [FaultOp],
        fail_on: fn(&[u8]) -> bool,
    ) {
        let inner = old_brain(6);
        let before = dump(&inner);
        let kv: Arc<dyn Kv> = Arc::new(FaultyKv {
            inner: inner.clone(),
            code,
            ops,
            fail_on,
        });
        let Err(e) = open(&kv) else {
            panic!("the brain opened");
        };
        assert_eq!(e.code, code, "{ops:?}: {}", e.message);
        assert!(
            !e.message.contains("Re-seed") && !e.message.contains("gbrain engine shadow"),
            "an I/O or storage error must not tell the person to re-seed: {}",
            e.message
        );
        assert_eq!(dump(&inner), before, "the failed open changed the brain");
        let stored: StoredFormat = get_json(&*inner.snapshot().unwrap(), &keys::meta("format"))
            .unwrap()
            .unwrap();
        assert_eq!(stored.format_version, 6);
        // The disk works again: the brain converts and answers as it would have.
        let store = open(&inner).unwrap();
        assert_eq!(store.info().format_version, FORMAT_VERSION);
        assert_eq!(answers(&store), expected());
    }

    fn under_purge_prefix(key: &[u8]) -> bool {
        key.starts_with(&[keys::FACT, TAKE_PURGE])
    }

    fn under_mute_prefix(key: &[u8]) -> bool {
        key.starts_with(&[keys::FACT, SUPPRESSION])
    }

    #[test]
    fn an_io_error_reading_the_records_is_reported_as_store_io_not_as_a_reseed() {
        open_on_failing_disk(crate::error::STORE_IO, &[FaultOp::Scan], under_purge_prefix);
    }

    #[test]
    fn a_corrupt_record_store_while_reading_the_records_is_reported_as_store_corrupt() {
        open_on_failing_disk(
            crate::error::STORE_CORRUPT,
            &[FaultOp::Scan],
            under_purge_prefix,
        );
    }

    #[test]
    fn an_io_error_checking_the_new_key_is_reported_as_store_io_not_as_a_reseed() {
        open_on_failing_disk(crate::error::STORE_IO, &[FaultOp::Get], under_mute_prefix);
    }

    #[test]
    fn an_io_error_deleting_an_old_mute_is_reported_as_store_io_not_as_a_reseed() {
        open_on_failing_disk(
            crate::error::STORE_IO,
            &[FaultOp::Delete],
            under_purge_prefix,
        );
    }

    #[test]
    fn an_io_error_writing_a_moved_mute_is_reported_as_store_io_not_as_a_reseed() {
        open_on_failing_disk(crate::error::STORE_IO, &[FaultOp::Put], under_mute_prefix);
    }

    #[test]
    fn a_corrupt_record_store_while_writing_a_moved_mute_is_reported_as_store_corrupt() {
        open_on_failing_disk(
            crate::error::STORE_CORRUPT,
            &[FaultOp::Put],
            under_mute_prefix,
        );
    }

    /// The failure comes after the first mute was moved and before the second: the moves of
    /// the first are rolled back with the rest.
    #[test]
    fn a_failure_after_the_first_moved_mute_leaves_the_brain_as_it_was_and_a_reopen_converts_it() {
        open_on_failing_disk(crate::error::STORE_IO, &[FaultOp::Put], |key| {
            key.starts_with(&[keys::FACT, SUPPRESSION, b'g', b'1', 0, b't'])
        });
    }

    /// The old writer accepts an empty mute value (`addLoopSuppression('g1', 'sender', '')`),
    /// which is stored at `F 0x10 g1 \0 sender \0`: two separators, the last byte a NUL.
    #[test]
    fn a_format_6_brain_with_empty_valued_mutes_converts_and_keeps_them() {
        for version in [6, 5] {
            let kv = old_brain(version);
            let mute = br#"{"id":40,"created_at_us":5}"#;
            put(
                &kv,
                &[&[keys::FACT, TAKE_PURGE][..], b"g1\0sender\0"].concat(),
                mute,
            );
            put(
                &kv,
                &[&[keys::FACT, TAKE_PURGE][..], b"g1\0thread\0"].concat(),
                mute,
            );
            let store = open(&kv).unwrap_or_else(|e| panic!("format {version}: {e:?}"));
            assert_eq!(store.info().format_version, FORMAT_VERSION);
            let mutes = store.list_loop_suppressions("g1").unwrap();
            for (kind, value) in [("sender", ""), ("thread", "")] {
                assert!(
                    mutes.contains(&json!({ "kind": kind, "value": value })),
                    "format {version}: {mutes:?} lacks the empty {kind} mute"
                );
            }
            drop(store);
            let moved = dump(&kv)
                .into_iter()
                .filter(|(k, _)| k.starts_with(&[keys::FACT, SUPPRESSION]))
                .map(|(k, _)| k)
                .collect::<Vec<_>>();
            for kind in ["sender", "thread"] {
                let key = [
                    &[keys::FACT, SUPPRESSION][..],
                    b"g1\0",
                    kind.as_bytes(),
                    b"\0",
                ]
                .concat();
                assert!(moved.contains(&key), "format {version}: no {kind} key");
            }
            assert!(
                dump(&kv)
                    .iter()
                    .filter(|(k, _)| k.starts_with(&[keys::FACT, TAKE_PURGE]))
                    .all(|(k, _)| k[2..].iter().filter(|b| **b == 0).count() == 3),
                "a mute stayed under F 0x10"
            );
            // The two take purges still answer.
            assert_eq!(
                answers_of_purges(&open(&kv).unwrap()),
                expected()["tombstones"]
            );
        }
    }

    #[test]
    fn a_record_under_the_prefix_that_is_neither_kind_refuses_the_brain_and_changes_nothing() {
        let junk = |name: &str, key: &[u8], value: &[u8]| {
            let kv = old_brain(6);
            put(&kv, &[&[keys::FACT, TAKE_PURGE], key].concat(), value);
            refused(&kv, name);
        };
        // A key with the wrong number of parts.
        junk("lonely", b"lonely", b"{}");
        // A value that is no JSON object.
        junk("g1\\0sender\\0x\\0", b"g1\0sender\0x\0", b"not json");
        // A value with fields of neither kind.
        junk(
            "g1\\0sender\\0y",
            b"g1\0sender\0y",
            br#"{"id":1,"extra":true}"#,
        );
        // A mute's key holding a take purge's value, and the reverse.
        junk(
            "g1\\0sender\\0z",
            b"g1\0sender\0z",
            br#"{"request_id":null,"purged_at_us":5}"#,
        );
        junk(
            "g1\\0*\\0h\\0",
            b"g1\0*\0h\0",
            br#"{"id":1,"created_at_us":5}"#,
        );
        // A mute whose kind the table's CHECK would refuse.
        junk(
            "g1\\0domain\\0example.test",
            b"g1\0domain\0example.test",
            br#"{"id":9,"created_at_us":5}"#,
        );
    }

    #[test]
    fn a_mute_stored_at_both_prefixes_refuses_the_brain() {
        let kv = old_brain(6);
        let mute = [
            keys::FACT,
            SUPPRESSION,
            b'g',
            b'1',
            0,
            b's',
            b'e',
            b'n',
            b'd',
            b'e',
            b'r',
            0,
        ];
        let mut key = mute.to_vec();
        key.extend_from_slice(b"alerts@bank-example.test");
        put(&kv, &key, br#"{"id":1,"created_at_us":5}"#);
        refused(&kv, "alerts@bank-example.test");
    }
}
