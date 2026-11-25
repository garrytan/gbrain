//! `relation_digest_stream` gives `relation_digest`'s answer for every interval, from one read.

use super::*;
use crate::keys;
use crate::seed::relation_digest_stream;

/// A store holding `n` config rows whose sort keys are two bytes, counting up.
fn many(n: u16) -> Store {
    let s = store();
    let rows: Vec<SeedRow> = (0..n)
        .map(|i| config_row(&format!("k{i:05}"), "v"))
        .collect();
    let digests: Vec<DigestInput> = (0..n)
        .map(|i| DigestInput {
            sort: hex(&i.to_be_bytes()),
            digest: hex(&[(i % 251) as u8; 32]),
        })
        .collect();
    s.import_relation_with_digests(SEED, "config", rows, &digests)
        .unwrap();
    s
}

fn bytes(text: Option<&str>) -> Option<Vec<u8>> {
    text.map(|t| {
        (0..t.len() / 2)
            .map(|i| u8::from_str_radix(&t[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    })
}

#[test]
fn the_stream_equals_the_collected_digest_for_empty_bounded_and_full_intervals() {
    let s = many(300);
    let read = s.read().unwrap();
    let intervals = [
        (None, None),
        (Some("0000"), None),
        (None, Some("0000")),
        (Some("0010"), Some("0100")),
        (Some("0100"), Some("0100")),
        (Some("0200"), Some("0100")),
        (Some("ffff"), None),
        (Some("00"), Some("01")),
    ];
    for (lo, hi) in intervals {
        let collected = s.relation_digest(SEED, "config", lo, hi).unwrap();
        let streamed =
            relation_digest_stream(&*read, "config", bytes(lo).as_deref(), bytes(hi).as_deref())
                .unwrap();
        assert_eq!(streamed, collected, "{lo:?}..{hi:?}");
    }
    assert_eq!(
        relation_digest_stream(&*read, "config", None, None)
            .unwrap()
            .rows,
        300
    );
}

#[test]
fn an_empty_relation_streams_to_the_digest_of_nothing() {
    let s = store();
    s.import_relation(SEED, "config", vec![]).unwrap();
    let streamed = relation_digest_stream(&*s.read().unwrap(), "config", None, None).unwrap();
    assert_eq!((streamed.rows, streamed.digest), (0, sha256_hex("")));
}

#[test]
fn a_damaged_entry_stops_the_stream_with_a_corrupt_store_error() {
    let s = seeded_config();
    s.write(|tx| {
        let mut key = keys::meta("shadow_digest/config/").to_vec();
        key.push(9);
        tx.put(&key, b"short")
    })
    .unwrap();
    let err = relation_digest_stream(&*s.read().unwrap(), "config", None, None).unwrap_err();
    assert_eq!(err.code, crate::error::STORE_CORRUPT);
    let collected = s.relation_digest(SEED, "config", None, None).unwrap_err();
    assert_eq!(collected.code, err.code);
}
