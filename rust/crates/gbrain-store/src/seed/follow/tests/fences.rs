//! Tests of the generation fence a delete leaves behind: a newer delete or a newer interval is not
//! undone by an older call, and what records them stays bounded.

use super::*;

/// How many keys the store keeps under `M <prefix>`.
fn meta_keys(s: &Store, prefix: &str) -> usize {
    let start = crate::keys::meta(prefix);
    let end = crate::kv::prefix_end(&start).unwrap();
    let read = s.read().unwrap();
    let mut n = 0;
    crate::kv::KvRead::scan(&*read, &start, &end, false, &mut |_, _| {
        n += 1;
        true
    })
    .unwrap();
    n
}

fn tombstones(s: &Store) -> usize {
    meta_keys(s, "shadow_tomb/")
}

fn fences(s: &Store) -> usize {
    meta_keys(s, "shadow_fence/")
}

/// Config key `name` as one call's upsert: sort `n`, digest byte `d`.
fn put(s: &Store, generation: u64, n: u8, name: &str, d: u8) -> crate::seed::FollowResult {
    s.replace_relation_rows(
        SEED,
        "config",
        generation,
        &[key(n, &[("key", name)])],
        &[config_row(name, "v")],
        &[digv(n, d)],
    )
    .unwrap()
}

fn drop_key(s: &Store, generation: u64, n: u8, name: &str) -> crate::seed::FollowResult {
    s.replace_relation_rows(
        SEED,
        "config",
        generation,
        &[key(n, &[("key", name)])],
        &[],
        &[],
    )
    .unwrap()
}

fn interval(
    s: &Store,
    generation: u64,
    lo: Option<&str>,
    hi: Option<&str>,
    rows: &[(u8, &str)],
) -> crate::seed::FollowResult {
    let digests: Vec<DigestInput> = rows.iter().map(|(n, _)| dig(*n)).collect();
    let rows: Vec<SeedRow> = rows.iter().map(|(_, name)| config_row(name, "v")).collect();
    s.replace_interval(SEED, "config", generation, lo, hi, &rows, &digests)
        .unwrap()
}

#[test]
fn an_older_upsert_does_not_bring_back_a_row_a_newer_delete_removed() {
    let s = seeded_config();
    let r = drop_key(&s, 9, 1, "a");
    assert_eq!((r.deleted, r.skipped_older), (1, 0));
    assert_eq!(s.get_config("a").unwrap(), None);
    let r = put(&s, 5, 1, "a", 21);
    assert_eq!((r.upserted, r.skipped_older), (0, 1));
    assert_eq!(s.get_config("a").unwrap(), None);
    assert_eq!(entries(&s, "config"), 1);
    // The same generation, or a newer one, applies and lifts the tombstone.
    assert_eq!(tombstones(&s), 1);
    assert_eq!(put(&s, 9, 1, "a", 22).upserted, 1);
    assert_eq!(s.get_config("a").unwrap().as_deref(), Some("v"));
    assert_eq!(tombstones(&s), 0);
}

#[test]
fn an_older_delete_does_not_lower_a_tombstone() {
    let s = seeded_config();
    drop_key(&s, 9, 1, "a");
    // A delete at generation 3 of a key already gone leaves the tombstone at 9.
    let r = drop_key(&s, 3, 1, "a");
    assert_eq!(r.skipped_older, 1);
    assert_eq!(put(&s, 5, 1, "a", 21).skipped_older, 1);
    assert_eq!(s.get_config("a").unwrap(), None);
    assert_eq!(tombstones(&s), 1);
}

#[test]
fn a_delete_of_a_key_the_store_never_held_still_fences_older_writes() {
    let s = seeded_config();
    let r = drop_key(&s, 9, 7, "never");
    assert_eq!((r.deleted, r.skipped_older), (0, 0));
    assert_eq!(put(&s, 5, 7, "never", 21).skipped_older, 1);
    assert_eq!(s.get_config("never").unwrap(), None);
}

#[test]
fn an_older_interval_does_not_bring_back_a_row_a_newer_delete_removed() {
    let s = seeded_config();
    drop_key(&s, 9, 1, "a");
    // The reconcile read the primary at generation 5, before the delete.
    let r = interval(&s, 5, None, None, &[(1, "a"), (2, "b")]);
    assert_eq!((r.upserted, r.skipped_older), (1, 1));
    assert_eq!(s.get_config("a").unwrap(), None);
    assert_eq!(entries(&s, "config"), 1);
    // A later pass that still lists `a` is newer than the delete and restores it.
    let r = interval(&s, 12, None, None, &[(1, "a"), (2, "b")]);
    assert_eq!((r.upserted, r.skipped_older), (2, 0));
    assert_eq!(s.get_config("a").unwrap().as_deref(), Some("v"));
}

#[test]
fn an_older_insert_does_not_bring_back_a_row_a_newer_interval_said_is_absent() {
    let s = seeded_config();
    // Generation 9 read [01, 05) and found nothing: `a` and `b` go.
    let r = interval(&s, 9, Some("01"), Some("05"), &[]);
    assert_eq!(r.deleted, 2);
    // An older follower write of a key inside the interval is skipped, also one the store never held.
    assert_eq!(put(&s, 5, 1, "a", 21).skipped_older, 1);
    assert_eq!(put(&s, 5, 3, "c", 23).skipped_older, 1);
    assert_eq!(s.get_config("a").unwrap(), None);
    assert_eq!(s.get_config("c").unwrap(), None);
    // Outside the interval, and at the interval's own generation, it applies.
    assert_eq!(put(&s, 5, 7, "z", 27).upserted, 1);
    assert_eq!(put(&s, 9, 3, "c", 23).upserted, 1);
    assert_eq!(s.get_config("c").unwrap().as_deref(), Some("v"));
    // `[lo, hi)` is half open: sort 05 is outside, sort 04 is inside.
    assert_eq!(put(&s, 5, 5, "e", 25).upserted, 1);
    assert_eq!(put(&s, 5, 4, "d", 24).skipped_older, 1);
}

#[test]
fn an_older_empty_or_smaller_interval_does_not_undo_a_newer_one() {
    let s = seeded_config();
    interval(&s, 9, None, None, &[]);
    assert_eq!(entries(&s, "config"), 0);
    // An older pass that lists rows is skipped row by row.
    let r = interval(&s, 5, None, None, &[(1, "a"), (2, "b")]);
    assert_eq!((r.upserted, r.skipped_older), (0, 2));
    assert_eq!(s.get_config("a").unwrap(), None);
    // A fence of 5 laid over the fence of 9 does not lower it.
    assert_eq!(put(&s, 6, 1, "a", 21).skipped_older, 1);
}

#[test]
fn an_interval_fence_is_a_maximum_over_the_overlapping_intervals() {
    let s = store();
    s.import_relation(SEED, "config", vec![]).unwrap();
    interval(&s, 5, Some("01"), Some("09"), &[]);
    interval(&s, 3, Some("04"), Some("0c"), &[]);
    interval(&s, 8, Some("06"), Some("07"), &[]);
    // Sort 05 sits under the fence of 5 only, 06 under 8, 0a under 3, 0c under none.
    assert_eq!(put(&s, 4, 5, "x", 1).skipped_older, 1);
    assert_eq!(put(&s, 6, 5, "x", 1).upserted, 1);
    assert_eq!(put(&s, 7, 6, "y", 2).skipped_older, 1);
    assert_eq!(put(&s, 8, 6, "y", 2).upserted, 1);
    assert_eq!(put(&s, 3, 0x0a, "z", 3).upserted, 1);
    assert_eq!(put(&s, 2, 0x0c, "v", 5).upserted, 1);
    assert_eq!(put(&s, 2, 0x0b, "u", 6).skipped_older, 1);
}

#[test]
fn passes_leave_one_fence_per_interval_and_no_tombstones() {
    let s = seeded_config();
    for generation in 1..=20u64 {
        // A follower delete, then reconcile passes over four adjacent intervals.
        drop_key(&s, generation, 1, "a");
        for (lo, hi) in [
            (None, Some("04")),
            (Some("04"), Some("08")),
            (Some("08"), Some("0c")),
            (Some("0c"), None),
        ] {
            interval(&s, generation + 1, lo, hi, &[]);
        }
        assert!(tombstones(&s) <= 1, "pass {generation}");
        assert!(fences(&s) <= 1, "pass {generation}: {} fences", fences(&s));
    }
    assert_eq!(tombstones(&s), 0);
}

#[test]
fn separate_intervals_keep_separate_fences_and_overlaps_replace_them() {
    let s = store();
    s.import_relation(SEED, "config", vec![]).unwrap();
    for generation in 1..=10u64 {
        interval(&s, generation, Some("01"), Some("04"), &[]);
        interval(&s, generation, Some("06"), Some("09"), &[]);
        assert!(fences(&s) <= 2);
    }
    assert_eq!(fences(&s), 2);
    // Adjacent intervals at one generation merge.
    interval(&s, 11, Some("04"), Some("06"), &[]);
    interval(&s, 11, Some("01"), Some("04"), &[]);
    interval(&s, 11, Some("06"), Some("09"), &[]);
    assert_eq!(fences(&s), 1);
}

#[test]
fn many_follower_deletes_wait_for_a_pass_that_covers_them() {
    let s = store();
    s.import_relation(SEED, "config", vec![]).unwrap();
    for n in 1..=30u8 {
        drop_key(&s, 4, n, &format!("k{n}"));
    }
    assert_eq!(tombstones(&s), 30);
    // A pass at a lower generation supersedes none of them.
    interval(&s, 3, None, None, &[]);
    assert_eq!(tombstones(&s), 30);
    // A pass over part of the sort range supersedes the tombstones inside it.
    interval(&s, 4, Some("01"), Some("0b"), &[]);
    assert_eq!(tombstones(&s), 20);
    interval(&s, 5, None, None, &[]);
    assert_eq!(tombstones(&s), 0);
    assert_eq!(fences(&s), 1);
}

#[test]
fn an_interval_digest_ignores_tombstones_and_fences() {
    let s = seeded_config();
    drop_key(&s, 9, 1, "a");
    interval(&s, 7, Some("05"), Some("0f"), &[]);
    assert!(tombstones(&s) + fences(&s) >= 2);
    // The same store without them: only `b`, at the same digest.
    let plain = store();
    plain
        .import_relation_with_digests(SEED, "config", vec![config_row("b", "2")], &[dig(2)])
        .unwrap();
    assert_eq!(digest_of(&s, "config"), digest_of(&plain, "config"));
    assert_eq!(digest_of(&s, "config").0, 1);
    let listed = s.relation_entries(SEED, "config", None, None, 100).unwrap();
    assert_eq!(listed.len(), 1);
}

#[test]
fn a_failed_call_leaves_no_tombstone_or_fence() {
    let s = seeded_config();
    // The second row is outside [lo, hi): refused before anything is written.
    let err = s
        .replace_interval(
            SEED,
            "config",
            9,
            Some("01"),
            Some("03"),
            &[config_row("z", "v")],
            &[dig(9)],
        )
        .unwrap_err();
    assert_eq!(err.code, INVALID_ARGUMENT);
    assert_eq!((tombstones(&s), fences(&s)), (0, 0));
}
