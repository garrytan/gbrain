//! The fact withdrawal ledger: the `fact_withdrawals` table (src/core/facts/withdrawal-schema.ts).
//!
//! A withdrawal says "this claim, at this visibility, about this subject, stays forgotten in this
//! source". It lives at `t 0x01 source \0 visibility \0 subject \0 fact_hash` with the JSON value
//! `{"withdrawn_at_us": <i64>}`; the key is the table's primary key. `subject` `*` covers every
//! subject. `fact_hash` is the claim's fingerprint ([`fact_fingerprint`]); rows from before v174
//! carry the v1 fingerprint ([`fact_fingerprint_v1`]), and every read matches both.
//!
//! Deleting a source removes its withdrawals (`ON DELETE CASCADE`, [`remove_source_rows`]). A slug
//! rename does not move them; the rename callers move them with `moveFactWithdrawalSubject`.

use super::fingerprint::{fact_fingerprint, fact_fingerprint_v1};
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::sources::require_source;
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The byte after `keys::TRUST` that marks a withdrawal.
const WITHDRAWAL: u8 = 0x01;

/// The two values of the table's `visibility` CHECK.
const VISIBILITIES: [&str; 2] = ["private", "world"];

/// What is stored for a withdrawal.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct WithdrawalRecord {
    withdrawn_at_us: i64,
}

/// One claim of `listFactWithdrawalDates`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WithdrawalClaim {
    pub row_num: i64,
    pub claim: String,
    pub visibility: String,
}

/// The earliest withdrawal of one claim row; `withdrawn_at` is ISO text.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WithdrawalDate {
    pub row_num: i64,
    pub withdrawn_at: String,
}

/// A withdrawal's key.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WithdrawalKey {
    pub visibility: String,
    pub fact_hash: String,
    pub subject: String,
}

fn key(parts: &[&str]) -> Vec<u8> {
    let mut key = keys::text(keys::TRUST, parts);
    key.insert(1, WITHDRAWAL);
    key
}

/// `t 0x01 source \0`: every withdrawal of a source.
fn source_prefix(source_id: &str) -> Vec<u8> {
    let mut prefix = key(&[source_id]);
    prefix.push(0);
    prefix
}

/// Splits a withdrawal key into visibility, subject and fact_hash.
fn split(key: &[u8], prefix_len: usize) -> Option<(String, String, String)> {
    let rest = std::str::from_utf8(key.get(prefix_len..)?).ok()?;
    let mut parts = rest.splitn(3, '\0');
    Some((
        parts.next()?.to_string(),
        parts.next()?.to_string(),
        parts.next()?.to_string(),
    ))
}

/// The table's CHECK: Postgres refuses any other visibility with a check violation.
fn check_visibility(op: &str, visibility: &str) -> Result<()> {
    if VISIBILITIES.contains(&visibility) {
        Ok(())
    } else {
        Err(StoreError::invalid(format!(
            "{op}: visibility must be private or world, not \"{visibility}\""
        )))
    }
}

fn at(read: &dyn KvRead, parts: &[&str]) -> Result<Option<i64>> {
    Ok(get_json::<WithdrawalRecord>(read, &key(parts))?.map(|r| r.withdrawn_at_us))
}

/// Every withdrawal of `source_id` at `visibility` whose fingerprint is `claim`'s fingerprint or
/// its v1 fingerprint, as its subject and the time it was made: the rows
/// `gbrain_preserve_fact_withdrawal` reads.
pub(crate) fn withdrawals_of(
    read: &dyn KvRead,
    source_id: &str,
    visibility: &str,
    claim: &str,
) -> Result<Vec<(String, i64)>> {
    let hashes = [fact_fingerprint(claim), fact_fingerprint_v1(claim)];
    let mut prefix = key(&[source_id, visibility]);
    prefix.push(0);
    let mut found = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, _| {
        if let Some(rest) = k
            .get(prefix.len()..)
            .and_then(|b| std::str::from_utf8(b).ok())
            && let Some((subject, hash)) = rest.rsplit_once('\0')
            && hashes.iter().any(|h| h == hash)
        {
            found.push((subject.to_string(), hash.to_string()));
        }
        true
    })?;
    let mut out = Vec::with_capacity(found.len());
    for (subject, hash) in found {
        if let Some(at) = at(read, &[source_id, visibility, &subject, &hash])? {
            out.push((subject, at));
        }
    }
    Ok(out)
}

/// `EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = $source AND w.visibility =
/// $visibility AND w.fact_hash IN (gbrain_fact_fingerprint(claim), gbrain_fact_fingerprint_v1(claim))
/// AND (w.subject = '*' OR w.subject = entity))`: a NULL entity matches only `*`.
pub(crate) fn withdrawn_claim(
    read: &dyn KvRead,
    source_id: &str,
    visibility: &str,
    claim: &str,
    entity: Option<&str>,
) -> Result<bool> {
    for hash in [fact_fingerprint(claim), fact_fingerprint_v1(claim)] {
        for who in std::iter::once("*").chain(entity) {
            if at(read, &[source_id, visibility, who, &hash])?.is_some() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// The withdrawals a page snapshot carries (`snapshot.withdrawals` of `readPageSnapshot`,
/// src/core/page-state/snapshot.ts): the source's withdrawals whose subject is `*` or the page's
/// slug, one per (visibility, fact_hash) at the earliest time, ordered by visibility then
/// fact_hash, as `{ visibility, fact_hash, withdrawn_at }`. The overlay of a segmented page's lead
/// reads these to strike a claim a person withdrew. (`fact_purges` rows, which the SQL snapshot
/// also lists, have no ledger here.)
pub(crate) fn page_withdrawals(
    read: &dyn KvRead,
    source_id: &str,
    slug: &str,
) -> Result<Vec<serde_json::Value>> {
    let prefix = source_prefix(source_id);
    let mut rows: Vec<(String, String, String)> = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, _| {
        if let Some((visibility, subject, hash)) = split(k, prefix.len())
            && (subject == "*" || subject == slug)
        {
            rows.push((visibility, hash, subject));
        }
        true
    })?;
    let mut earliest: BTreeMap<(String, String), i64> = BTreeMap::new();
    for (visibility, hash, subject) in rows {
        if let Some(when) = at(read, &[source_id, &visibility, &subject, &hash])? {
            let slot = earliest.entry((visibility, hash)).or_insert(when);
            *slot = (*slot).min(when);
        }
    }
    Ok(earliest
        .into_iter()
        .map(|((visibility, fact_hash), when)| {
            serde_json::json!({
                "visibility": visibility,
                "fact_hash": fact_hash,
                "withdrawn_at": iso(when),
            })
        })
        .collect())
}

/// Removes every withdrawal of a source, for the source delete.
/// Whether a withdrawal of `source_id` covers the page `slug`: its subject is `*` or the slug (the
/// `withdrawn` column of `listCorePageRows`, src/core/engine-sql/trust-tier-reads.ts).
pub(crate) fn covers_page(read: &dyn KvRead, source_id: &str, slug: &str) -> Result<bool> {
    let prefix = source_prefix(source_id);
    let mut found = false;
    scan_prefix(read, &prefix, false, &mut |k, _| {
        found = split(k, prefix.len()).is_some_and(|(_, s, _)| s == "*" || s == slug);
        !found
    })?;
    Ok(found)
}

pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut doomed = Vec::new();
    scan_prefix(tx, &source_prefix(source_id), false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    for k in doomed {
        tx.delete(&k)?;
    }
    Ok(())
}

impl Store {
    /// `hasCoveringFactWithdrawal`: whether a withdrawal at `visibility` with fingerprint
    /// `fact_hash` or the v1 fingerprint of `claim`, and subject `*` or `subject`, exists.
    pub fn has_covering_fact_withdrawal(
        &self,
        source_id: &str,
        visibility: &str,
        fact_hash: &str,
        claim: &str,
        subject: &str,
    ) -> Result<bool> {
        let op = "hasCoveringFactWithdrawal";
        no_nul(
            op,
            &[
                ("sourceId", source_id),
                ("visibility", visibility),
                ("factHash", fact_hash),
                ("claim", claim),
                ("subject", subject),
            ],
        )?;
        let read = self.read()?;
        let v1 = fact_fingerprint_v1(claim);
        for hash in [fact_hash, v1.as_str()] {
            for who in ["*", subject] {
                if at(&*read, &[source_id, visibility, who, hash])?.is_some() {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// `insertFactWithdrawal`: records the withdrawal of `claim` (by its fingerprint) for
    /// `subject` at `withdrawn_at` (ISO) or now. False when the row already exists; the existing
    /// row keeps its time.
    pub fn insert_fact_withdrawal(
        &self,
        source_id: &str,
        visibility: &str,
        claim: &str,
        subject: &str,
        withdrawn_at: Option<&str>,
    ) -> Result<bool> {
        let op = "insertFactWithdrawal";
        no_nul(
            op,
            &[
                ("sourceId", source_id),
                ("visibility", visibility),
                ("claim", claim),
                ("subject", subject),
            ],
        )?;
        check_visibility(op, visibility)?;
        let withdrawn_at_us = match withdrawn_at {
            None => self.env.now_micros(),
            Some(text) => parse_iso(text).ok_or_else(|| {
                StoreError::invalid(format!(
                    "{op}: withdrawnAt must be an ISO time, not \"{text}\""
                ))
            })?,
        };
        let hash = fact_fingerprint(claim);
        self.write(|tx| {
            require_source(tx, source_id)?;
            let k = key(&[source_id, visibility, subject, &hash]);
            if tx.get(&k)?.is_some() {
                return Ok(false);
            }
            put_json(tx, &k, &WithdrawalRecord { withdrawn_at_us })?;
            Ok(true)
        })
    }

    /// `listFactWithdrawalDates`: per claim row with a matching withdrawal (same visibility, its
    /// fingerprint or v1 fingerprint, subject `*` or `subject`, any subject when `None`), the
    /// earliest withdrawal time. Sorted by row number.
    pub fn list_fact_withdrawal_dates(
        &self,
        source_id: &str,
        claims: &[WithdrawalClaim],
        subject: Option<&str>,
    ) -> Result<Vec<WithdrawalDate>> {
        let op = "listFactWithdrawalDates";
        no_nul(
            op,
            &[("sourceId", source_id), ("subject", subject.unwrap_or(""))],
        )?;
        for c in claims {
            no_nul(op, &[("claim", &c.claim), ("visibility", &c.visibility)])?;
        }
        let read = self.read()?;
        let mut earliest: BTreeMap<i64, i64> = BTreeMap::new();
        for c in claims {
            let hashes = [fact_fingerprint(&c.claim), fact_fingerprint_v1(&c.claim)];
            let mut seen: Vec<i64> = Vec::new();
            match subject {
                Some(subject) => {
                    for hash in &hashes {
                        for who in ["*", subject] {
                            if let Some(us) = at(&*read, &[source_id, &c.visibility, who, hash])? {
                                seen.push(us);
                            }
                        }
                    }
                }
                None => {
                    let mut prefix = key(&[source_id, &c.visibility]);
                    prefix.push(0);
                    let len = prefix.len();
                    let mut failed = None;
                    scan_prefix(&*read, &prefix, false, &mut |k, v| {
                        let Some(hash) = k.get(len..).and_then(|rest| {
                            rest.iter().position(|b| *b == 0).map(|i| &rest[i + 1..])
                        }) else {
                            return true;
                        };
                        if hashes.iter().any(|h| h.as_bytes() == hash) {
                            match serde_json::from_slice::<WithdrawalRecord>(v) {
                                Ok(r) => seen.push(r.withdrawn_at_us),
                                Err(e) => {
                                    failed = Some(e);
                                    return false;
                                }
                            }
                        }
                        true
                    })?;
                    if let Some(e) = failed {
                        return Err(StoreError::invalid(format!("{op}: corrupt record: {e}")));
                    }
                }
            }
            if let Some(min) = seen.into_iter().min() {
                let slot = earliest.entry(c.row_num).or_insert(min);
                *slot = (*slot).min(min);
            }
        }
        Ok(earliest
            .into_iter()
            .map(|(row_num, us)| WithdrawalDate {
                row_num,
                withdrawn_at: iso(us),
            })
            .collect())
    }

    /// `moveFactWithdrawalSubject`: moves the source's withdrawals of subject `old_slug` to
    /// `new_slug`. A withdrawal `new_slug` already has keeps its time. Same slugs: no change.
    pub fn move_fact_withdrawal_subject(
        &self,
        source_id: &str,
        old_slug: &str,
        new_slug: &str,
    ) -> Result<()> {
        no_nul(
            "moveFactWithdrawalSubject",
            &[
                ("sourceId", source_id),
                ("oldSlug", old_slug),
                ("newSlug", new_slug),
            ],
        )?;
        if old_slug == new_slug {
            return Ok(());
        }
        self.write(|tx| move_subject_in(tx, source_id, old_slug, new_slug))
    }

    /// `hasFactWithdrawalForSubject`: whether any withdrawal of the source has this subject.
    pub fn has_fact_withdrawal_for_subject(&self, source_id: &str, subject: &str) -> Result<bool> {
        no_nul(
            "hasFactWithdrawalForSubject",
            &[("sourceId", source_id), ("subject", subject)],
        )?;
        let read = self.read()?;
        let prefix = source_prefix(source_id);
        let mut found = false;
        scan_prefix(&*read, &prefix, false, &mut |k, _| {
            found = split(k, prefix.len()).is_some_and(|(_, s, _)| s == subject);
            !found
        })?;
        Ok(found)
    }

    /// `listFactWithdrawalKeys`: the source's withdrawal keys ordered by visibility, fact_hash and
    /// subject (byte order), at most `limit`. A negative limit refuses, as Postgres does.
    pub fn list_fact_withdrawal_keys(
        &self,
        source_id: &str,
        limit: i64,
    ) -> Result<Vec<WithdrawalKey>> {
        let op = "listFactWithdrawalKeys";
        no_nul(op, &[("sourceId", source_id)])?;
        if limit < 0 {
            return Err(StoreError::invalid(format!(
                "{op}: LIMIT must not be negative"
            )));
        }
        let read = self.read()?;
        let prefix = source_prefix(source_id);
        let mut rows = Vec::new();
        scan_prefix(&*read, &prefix, false, &mut |k, _| {
            if let Some((visibility, subject, fact_hash)) = split(k, prefix.len()) {
                rows.push(WithdrawalKey {
                    visibility,
                    fact_hash,
                    subject,
                });
            }
            true
        })?;
        rows.sort_by(|a, b| {
            (
                a.visibility.as_bytes(),
                a.fact_hash.as_bytes(),
                a.subject.as_bytes(),
            )
                .cmp(&(
                    b.visibility.as_bytes(),
                    b.fact_hash.as_bytes(),
                    b.subject.as_bytes(),
                ))
        });
        rows.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        Ok(rows)
    }
}

/// Moves `source_id`'s withdrawals of subject `old_slug` to `new_slug` inside `tx`: a withdrawal `new_slug` already has
/// keeps its time (`MOVE_WITHDRAWAL_SUBJECT_SQL`). A page rename runs it with the fact rows (`facts::rename_slug_rows`),
/// so a claim withdrawn about the old slug stays withdrawn about the new one.
pub(crate) fn move_subject_in(
    tx: &mut dyn KvWrite,
    source_id: &str,
    old_slug: &str,
    new_slug: &str,
) -> Result<()> {
    if old_slug == new_slug {
        return Ok(());
    }
    let prefix = source_prefix(source_id);
    let mut moved = Vec::new();
    scan_prefix(tx, &prefix, false, &mut |k, v| {
        if let Some((visibility, subject, hash)) = split(k, prefix.len())
            && subject == old_slug
        {
            moved.push((k.to_vec(), visibility, hash, v.to_vec()));
        }
        true
    })?;
    for (old_key, visibility, hash, value) in moved {
        tx.delete(&old_key)?;
        let new_key = key(&[source_id, &visibility, new_slug, &hash]);
        if tx.get(&new_key)?.is_none() {
            tx.put(&new_key, &value)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::SourceInput;
    use crate::test_support::store;

    const AT: &str = "2026-03-01T10:00:00.000000Z";

    fn source(s: &Store, id: &str) {
        s.upsert_source(&SourceInput {
            id: id.into(),
            ..SourceInput::default()
        })
        .unwrap();
    }

    #[test]
    fn fingerprints_match_the_sql_functions() {
        // sha256("acme raised 5m") and sha256("  acme raised: 5m. ") lowered and collapsed.
        assert_eq!(
            fact_fingerprint("  Acme RAISED:\t5M. "),
            fact_fingerprint("acme raised 5m")
        );
        assert_ne!(
            fact_fingerprint_v1("Acme raised: 5M"),
            fact_fingerprint_v1("acme raised 5m")
        );
        assert_eq!(
            fact_fingerprint_v1("  Acme\t\nRaised "),
            fact_fingerprint_v1("acme raised ")
        );
        assert_eq!(
            fact_fingerprint_v1("x"),
            "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
        );
    }

    #[test]
    fn insert_then_cover() {
        let s = store();
        assert!(
            s.insert_fact_withdrawal("default", "private", "Acme raised 5M.", "acme", Some(AT))
                .unwrap()
        );
        assert!(
            !s.insert_fact_withdrawal("default", "private", "acme raised 5m", "acme", None)
                .unwrap()
        );
        let hash = fact_fingerprint("acme raised 5m");
        assert!(
            s.has_covering_fact_withdrawal("default", "private", &hash, "", "acme")
                .unwrap()
        );
        assert!(
            !s.has_covering_fact_withdrawal("default", "world", &hash, "", "acme")
                .unwrap()
        );
        assert!(
            !s.has_covering_fact_withdrawal("default", "private", &hash, "", "other")
                .unwrap()
        );
        // A subject-wide withdrawal covers every subject.
        s.insert_fact_withdrawal("default", "world", "c", "*", None)
            .unwrap();
        assert!(
            s.has_covering_fact_withdrawal("default", "world", &fact_fingerprint("c"), "", "zed")
                .unwrap()
        );
        // The v1 fingerprint of the claim also matches.
        let k = key(&[
            "default",
            "private",
            "bob",
            &fact_fingerprint_v1("Old Claim"),
        ]);
        s.write(|tx| put_json(tx, &k, &WithdrawalRecord { withdrawn_at_us: 1 }))
            .unwrap();
        assert!(
            s.has_covering_fact_withdrawal("default", "private", "nope", "Old Claim", "bob")
                .unwrap()
        );
    }

    #[test]
    fn insert_refuses_bad_input() {
        let s = store();
        let e = s
            .insert_fact_withdrawal("default", "public", "c", "*", None)
            .unwrap_err();
        assert_eq!(e.code, crate::error::INVALID_ARGUMENT);
        let e = s
            .insert_fact_withdrawal("missing", "world", "c", "*", None)
            .unwrap_err();
        assert_eq!(e.code, crate::error::SOURCE_NOT_FOUND);
        let e = s
            .insert_fact_withdrawal("default", "world", "c", "*", Some("soon"))
            .unwrap_err();
        assert_eq!(e.code, crate::error::INVALID_ARGUMENT);
        let e = s
            .insert_fact_withdrawal("default", "world", "c\0", "*", None)
            .unwrap_err();
        assert_eq!(e.code, crate::error::INVALID_ARGUMENT);
    }

    #[test]
    fn dates_take_the_earliest_match() {
        let s = store();
        s.insert_fact_withdrawal("default", "private", "a", "*", Some("2026-03-02T00:00:00Z"))
            .unwrap();
        s.insert_fact_withdrawal("default", "private", "a", "x", Some("2026-03-01T00:00:00Z"))
            .unwrap();
        s.insert_fact_withdrawal("default", "private", "b", "y", Some("2026-03-03T00:00:00Z"))
            .unwrap();
        let claims = vec![
            WithdrawalClaim {
                row_num: 2,
                claim: "B".into(),
                visibility: "private".into(),
            },
            WithdrawalClaim {
                row_num: 1,
                claim: "A".into(),
                visibility: "private".into(),
            },
            WithdrawalClaim {
                row_num: 3,
                claim: "a".into(),
                visibility: "world".into(),
            },
        ];
        let rows = s
            .list_fact_withdrawal_dates("default", &claims, None)
            .unwrap();
        assert_eq!(
            rows,
            vec![
                WithdrawalDate {
                    row_num: 1,
                    withdrawn_at: "2026-03-01T00:00:00.000000Z".into()
                },
                WithdrawalDate {
                    row_num: 2,
                    withdrawn_at: "2026-03-03T00:00:00.000000Z".into()
                },
            ]
        );
        let rows = s
            .list_fact_withdrawal_dates("default", &claims, Some("z"))
            .unwrap();
        assert_eq!(
            rows,
            vec![WithdrawalDate {
                row_num: 1,
                withdrawn_at: "2026-03-02T00:00:00.000000Z".into()
            }]
        );
        let rows = s
            .list_fact_withdrawal_dates("default", &claims, Some("x"))
            .unwrap();
        assert_eq!(rows[0].withdrawn_at, "2026-03-01T00:00:00.000000Z");
        assert!(
            s.list_fact_withdrawal_dates("default", &[], None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn move_keeps_the_target_row() {
        let s = store();
        source(&s, "other");
        s.insert_fact_withdrawal(
            "default",
            "private",
            "a",
            "old",
            Some("2026-03-01T00:00:00Z"),
        )
        .unwrap();
        s.insert_fact_withdrawal(
            "default",
            "private",
            "b",
            "old",
            Some("2026-03-01T00:00:00Z"),
        )
        .unwrap();
        s.insert_fact_withdrawal(
            "default",
            "private",
            "b",
            "new",
            Some("2026-03-05T00:00:00Z"),
        )
        .unwrap();
        s.insert_fact_withdrawal("other", "private", "a", "old", None)
            .unwrap();
        s.move_fact_withdrawal_subject("default", "old", "old")
            .unwrap();
        assert!(s.has_fact_withdrawal_for_subject("default", "old").unwrap());
        s.move_fact_withdrawal_subject("default", "old", "new")
            .unwrap();
        assert!(!s.has_fact_withdrawal_for_subject("default", "old").unwrap());
        assert!(s.has_fact_withdrawal_for_subject("other", "old").unwrap());
        let claims = vec![WithdrawalClaim {
            row_num: 1,
            claim: "b".into(),
            visibility: "private".into(),
        }];
        let rows = s
            .list_fact_withdrawal_dates("default", &claims, Some("new"))
            .unwrap();
        assert_eq!(rows[0].withdrawn_at, "2026-03-05T00:00:00.000000Z");
        assert_eq!(s.list_fact_withdrawal_keys("default", 10).unwrap().len(), 2);
    }

    #[test]
    fn keys_sort_by_visibility_hash_subject() {
        let s = store();
        for (vis, claim, subject) in [
            ("world", "a", "b"),
            ("private", "a", "z"),
            ("private", "a", "a"),
            ("private", "b", "*"),
        ] {
            s.insert_fact_withdrawal("default", vis, claim, subject, None)
                .unwrap();
        }
        let rows = s.list_fact_withdrawal_keys("default", 10).unwrap();
        let mut want: Vec<(String, String, String)> = rows
            .iter()
            .map(|r| (r.visibility.clone(), r.fact_hash.clone(), r.subject.clone()))
            .collect();
        want.sort();
        let got: Vec<(String, String, String)> = rows
            .iter()
            .map(|r| (r.visibility.clone(), r.fact_hash.clone(), r.subject.clone()))
            .collect();
        assert_eq!(got, want);
        assert_eq!(rows[0].visibility, "private");
        assert_eq!(rows[3].visibility, "world");
        assert_eq!(s.list_fact_withdrawal_keys("default", 2).unwrap().len(), 2);
        assert!(
            s.list_fact_withdrawal_keys("default", 0)
                .unwrap()
                .is_empty()
        );
        assert!(s.list_fact_withdrawal_keys("default", -1).is_err());
    }

    #[test]
    fn source_delete_removes_rows() {
        let s = store();
        source(&s, "other");
        s.insert_fact_withdrawal("default", "private", "a", "x", None)
            .unwrap();
        s.insert_fact_withdrawal("other", "private", "a", "x", None)
            .unwrap();
        s.write(|tx| crate::cascade::remove_source_rows(tx, "default"))
            .unwrap();
        assert!(!s.has_fact_withdrawal_for_subject("default", "x").unwrap());
        assert!(s.has_fact_withdrawal_for_subject("other", "x").unwrap());
    }
}
