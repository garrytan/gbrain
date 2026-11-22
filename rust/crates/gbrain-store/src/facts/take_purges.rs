//! The take purge ledger: the `take_purges` table (src/core/facts/purge-schema.ts).
//!
//! A take purge tombstone says "this take claim, about this subject, was purged from this source
//! and may not be saved again". It lives at `F 0x10 source \0 subject \0 claim_hash \0` with the
//! JSON value [`TakePurgeRecord`]; the key is the table's primary key. `subject` `*` covers every
//! page of the source. `claim_hash` is the claim's fingerprint (`gbrain_fact_fingerprint`).
//!
//! Three things read it:
//!
//! - the take guard ([`refuse_purged_take`]), which every takes writer that inserts a row or sets
//!   its claim runs, as the `takes_refuse_purged` trigger (`gbrain_refuse_purged_take`) does;
//! - the import overlay's purge probe (`readSourcePurgeFlags`, [`has_take_purges`]) and its take
//!   match (`listPurgedTakeRows`, [`Store::list_purged_take_rows`]);
//! - the belief ledger's tombstone read (`readBeliefTombstones`, [`tombstoned_hashes`]).
//!
//! Deleting a source removes its tombstones (`ON DELETE CASCADE`, [`remove_source_rows`]).

use super::fact_fingerprint;
use crate::Store;
use crate::env::is_uuid;
use crate::error::{Result, StoreError};
use crate::keys;
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::links::no_nul;
use crate::pages::read_page_by_id;
use crate::sources::require_source;
use crate::{get_json, put_json};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The byte after `keys::FACT` that marks a take purge tombstone.
const TAKE_PURGE: u8 = 0x10;

const PURGED_TAKE_MESSAGE: &str =
    "purged_content: this take claim was purged from this source and cannot be saved again";

/// The columns of a tombstone besides its key. `purged_at_us` is the transaction's clock.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TakePurgeRecord {
    request_id: Option<String>,
    purged_at_us: i64,
}

/// One row of `listPurgedTakeRows`'s `takes` (`TakeClaimRow`): an incoming takes-fence row.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TakeClaimRow {
    pub row_num: i32,
    pub claim: String,
}

/// `insertTakePurge`'s argument (`TakePurgeInsert`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakePurgeInsert {
    pub source_id: String,
    pub subject: String,
    pub claim_hash: String,
    pub request_id: Option<String>,
}

fn key(parts: &[&str]) -> Vec<u8> {
    let mut key = vec![keys::FACT, TAKE_PURGE];
    for part in parts {
        key.extend_from_slice(part.as_bytes());
        key.push(0);
    }
    key
}

/// Whether the source has any take tombstone (`EXISTS (SELECT 1 FROM take_purges WHERE source_id = $1)`).
pub(crate) fn has_take_purges(read: &dyn KvRead, source_id: &str) -> Result<bool> {
    let mut found = false;
    scan_prefix(read, &key(&[source_id]), false, &mut |_, _| {
        found = true;
        false
    })?;
    Ok(found)
}

/// `SELECT claim_hash FROM take_purges WHERE source_id = $1 AND claim_hash = ANY($2)`: the hashes
/// among `hashes` that a tombstone of the source names, under any subject, each once.
pub(crate) fn tombstoned_hashes(
    read: &dyn KvRead,
    source_id: &str,
    hashes: &[String],
) -> Result<BTreeSet<String>> {
    let wanted: BTreeSet<&[u8]> = hashes.iter().map(|h| h.as_bytes()).collect();
    let mut found = BTreeSet::new();
    if wanted.is_empty() {
        return Ok(found);
    }
    let prefix = key(&[source_id]);
    scan_prefix(read, &prefix, false, &mut |k, _| {
        // The rest of the key is `subject \0 claim_hash \0`.
        if let Some(hash) = k[prefix.len()..].split(|b| *b == 0).nth(1)
            && wanted.contains(hash)
        {
            found.insert(String::from_utf8_lossy(hash).into_owned());
        }
        true
    })?;
    Ok(found)
}

/// `gbrain_refuse_purged_take`: the page `page_id` names gives the source and the subject (a
/// missing page, or a null page id or claim, refuses nothing); a tombstone of that source under
/// subject `*` or the page's slug that names the claim's fingerprint refuses the write. PGLite runs
/// it `BEFORE INSERT OR UPDATE OF claim, page_id`, so it comes before the NOT NULL, CHECK and
/// conflict checks of the row.
pub(crate) fn refuse_purged_take(
    read: &dyn KvRead,
    page_id: Option<i32>,
    claim: Option<&str>,
) -> Result<()> {
    let (Some(page_id), Some(claim)) = (page_id, claim) else {
        return Ok(());
    };
    let Ok(page_id) = u64::try_from(page_id) else {
        return Ok(());
    };
    let Some(page) = read_page_by_id(read, page_id)? else {
        return Ok(());
    };
    if !has_take_purges(read, &page.source_id)? {
        return Ok(());
    }
    let hash = fact_fingerprint(claim);
    for subject in ["*", page.slug.as_str()] {
        if read
            .get(&key(&[&page.source_id, subject, &hash]))?
            .is_some()
        {
            return Err(StoreError::new(
                super::purge_ledger::PURGED_CONTENT,
                PURGED_TAKE_MESSAGE,
            ));
        }
    }
    Ok(())
}

/// Adds to `out` the request id of every take tombstone purged after `since_us`, the `take_purges`
/// arm of `listRecentPurgeRequests` (`request_id IS NOT NULL AND purged_at > now() - make_interval(...)`).
pub(crate) fn recent_request_ids(
    read: &dyn KvRead,
    since_us: i64,
    out: &mut BTreeSet<String>,
) -> Result<()> {
    let mut failure = None;
    scan_prefix(read, &[keys::FACT, TAKE_PURGE], false, &mut |_, v| {
        match serde_json::from_slice::<TakePurgeRecord>(v) {
            Ok(r) => {
                if let (Some(request), true) = (r.request_id, r.purged_at_us > since_us) {
                    out.insert(request);
                }
            }
            Err(e) => failure = Some(StoreError::from(e)),
        }
        failure.is_none()
    })?;
    failure.map_or(Ok(()), Err)
}

/// Removes every take tombstone of a source, for the source delete.
pub(crate) fn remove_source_rows(tx: &mut dyn KvWrite, source_id: &str) -> Result<()> {
    let mut doomed = Vec::new();
    scan_prefix(tx, &key(&[source_id]), false, &mut |k, _| {
        doomed.push(k.to_vec());
        true
    })?;
    for k in doomed {
        tx.delete(&k)?;
    }
    Ok(())
}

impl Store {
    /// `listPurgedTakeRows`: the row numbers of `takes` whose claim fingerprint a tombstone of the
    /// source names, under subject `*` or `subject` (any subject when `None`), each once and in
    /// ascending order (the SQL has no set order).
    pub fn list_purged_take_rows(
        &self,
        source_id: &str,
        takes: &[TakeClaimRow],
        subject: Option<&str>,
    ) -> Result<Vec<i32>> {
        let op = "listPurgedTakeRows";
        no_nul(
            op,
            &[("sourceId", source_id), ("subject", subject.unwrap_or(""))],
        )?;
        for t in takes {
            no_nul(op, &[("claim", &t.claim)])?;
        }
        let read = self.read()?;
        let hashes: Vec<(i32, String)> = takes
            .iter()
            .map(|t| (t.row_num, fact_fingerprint(&t.claim)))
            .collect();
        let mut rows = BTreeSet::new();
        match subject {
            Some(subject) => {
                for (row_num, hash) in &hashes {
                    for who in ["*", subject] {
                        if read.get(&key(&[source_id, who, hash]))?.is_some() {
                            rows.insert(*row_num);
                            break;
                        }
                    }
                }
            }
            None => {
                let wanted: Vec<String> = hashes.iter().map(|(_, h)| h.clone()).collect();
                let found = tombstoned_hashes(&*read, source_id, &wanted)?;
                rows.extend(
                    hashes
                        .iter()
                        .filter(|(_, h)| found.contains(h))
                        .map(|(row_num, _)| *row_num),
                );
            }
        }
        Ok(rows.into_iter().collect())
    }

    /// `insertTakePurge`: stores the tombstone; false when the same key exists (`ON CONFLICT DO
    /// NOTHING`), which keeps its columns. A missing source fails as the foreign key does.
    pub fn insert_take_purge(&self, row: &TakePurgeInsert) -> Result<bool> {
        let op = "insertTakePurge";
        no_nul(
            op,
            &[
                ("sourceId", &row.source_id),
                ("subject", &row.subject),
                ("claimHash", &row.claim_hash),
            ],
        )?;
        let request_id = match &row.request_id {
            None => None,
            Some(text) if is_uuid(text) => Some(text.to_lowercase()),
            Some(_) => {
                return Err(StoreError::invalid(format!(
                    "{op}: requestId is not a UUID"
                )));
            }
        };
        let purged_at_us = self.env.now_micros();
        self.write(|tx| {
            require_source(tx, &row.source_id)?;
            let k = key(&[&row.source_id, &row.subject, &row.claim_hash]);
            if get_json::<TakePurgeRecord>(tx, &k)?.is_some() {
                return Ok(false);
            }
            put_json(
                tx,
                &k,
                &TakePurgeRecord {
                    request_id: request_id.clone(),
                    purged_at_us,
                },
            )?;
            Ok(true)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::SourceInput;
    use crate::test_support::store;

    fn tombstone(s: &Store, subject: &str, claim: &str) {
        s.insert_take_purge(&TakePurgeInsert {
            source_id: "default".into(),
            subject: subject.into(),
            claim_hash: fact_fingerprint(claim),
            request_id: None,
        })
        .unwrap();
    }

    #[test]
    fn purged_take_rows_match_subject_star_or_the_subject() {
        let s = store();
        s.upsert_source(&SourceInput {
            id: "default".into(),
            ..SourceInput::default()
        })
        .unwrap();
        tombstone(&s, "*", "Acme will win");
        tombstone(&s, "people/a", "Widgets sell out");
        tombstone(&s, "people/b", "Rates fall");
        let takes: Vec<TakeClaimRow> = [
            (4, "Rates fall"),
            (1, "  ACME will win. "),
            (2, "Widgets sell out"),
            (3, "Nobody purged this"),
            (1, "Widgets sell out"),
        ]
        .into_iter()
        .map(|(row_num, claim)| TakeClaimRow {
            row_num,
            claim: claim.into(),
        })
        .collect();
        let rows = |subject| s.list_purged_take_rows("default", &takes, subject).unwrap();
        assert_eq!(rows(Some("people/a")), vec![1, 2]);
        assert_eq!(rows(Some("people/b")), vec![1, 4]);
        assert_eq!(rows(None), vec![1, 2, 4]);
        assert!(
            s.list_purged_take_rows("default", &[], None)
                .unwrap()
                .is_empty()
        );
        let nul = s.list_purged_take_rows("default", &takes, Some("a\0b"));
        assert!(nul.is_err());
    }
}
