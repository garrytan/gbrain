//! The deletes of a page purge's sweep in the write gate (`deletePurgedPageHolds` and `deletePurgedPageGateReceipts`, SQL in
//! src/core/engine-sql/page-purge-sweep.ts): every hold of a slug in a source, and the receipts that name a page, its facts,
//! its takes or those holds; and `deletePurgedSlugHolds` (engine-sql/purge-slug-stores.ts), the same holds of several slugs
//! up to each page's deletion time, with the receipts of the holds it deleted. Neither table has a foreign key, so nothing
//! else removes them with the page.

use super::{
    HOLD, HOLD_DEDUPE, HoldRecord, ReceiptRecord, all_holds, all_receipts, by_id, delete_receipt,
    read_id, receipts_of, tagged,
};
use crate::error::{Result, StoreError};
use crate::kv::scan_prefix;
use crate::links::no_nul;
use crate::persistence::parse_timestamptz;
use crate::{Store, get_json, keys};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

/// One purged page of `deletePurgedSlugHolds`: its slug and, for a tombstone expiry, the instant it was soft deleted (ISO
/// text, microseconds kept). The page's id, which the SQL engines also take, binds a hold to a page there; the store's holds
/// are kept by slug alone, so it is not read.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgedSlugPage {
    pub slug: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

/// A page's `deletedAt` as microseconds: what `::timestamptz` makes of the text the callers send (Postgres `deleted_at::text`,
/// `2026-11-18 02:37:05.215+00`, or ISO with `Z` or an offset), microseconds kept. Text that is not a time is refused with
/// Postgres's own wording, before anything is deleted.
fn deleted_at_micros(text: &str) -> Result<i64> {
    parse_timestamptz(text, "deletedAt").map_err(|_| {
        StoreError::invalid(format!(
            "deletePurgedSlugHolds deletedAt: invalid input syntax for type timestamp with time zone: {text:?}"
        ))
    })
}

impl Store {
    /// `deletePurgedPageHolds(sourceId, slug)`: deletes every hold of the slug in the source, with its dedupe key; the ids as
    /// text in id order.
    pub fn delete_purged_page_holds(&self, source_id: &str, slug: &str) -> Result<Vec<String>> {
        no_nul(
            "deletePurgedPageHolds",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        self.write(|tx| {
            let mut holds: Vec<HoldRecord> = all_holds(&*tx)?
                .into_iter()
                .filter(|h| h.source_id == source_id && h.slug == slug)
                .collect();
            holds.sort_by_key(|h| h.id);
            for h in &holds {
                let version = h.detector_version.to_string();
                let index = tagged(
                    HOLD_DEDUPE,
                    &[&h.source_id, &h.slug, &h.fingerprint, &version],
                );
                if read_id(&*tx, &index)? == Some(h.id) {
                    tx.delete(&index)?;
                }
                tx.delete(&by_id(HOLD, h.id))?;
            }
            Ok(holds.into_iter().map(|h| h.id.to_string()).collect())
        })
    }

    /// `deletePurgedSlugHolds(sourceId, pages)`: deletes the holds of each page's slug in the source, with their dedupe keys,
    /// and the receipts of the holds deleted. A page with `deletedAt` loses only the holds last seen (the later of created and
    /// last seen) up to it, so a hold that arrived after the soft delete stays; one without loses every hold of the slug. A slug
    /// named by several pages loses the holds any of them covers. `{ write_gate_holds, write_gate_receipts }`.
    ///
    /// The store keeps a hold by source and slug alone (no bound page, no candidate pages, no recheck notes), so the SQL
    /// engines' rules for a hold bound to another page or marked with candidates have no rows here. Each slug's holds are read
    /// through the dedupe index by prefix, so the store is never loaded whole.
    pub fn delete_purged_slug_holds(
        &self,
        source_id: &str,
        pages: &[PurgedSlugPage],
    ) -> Result<Value> {
        let op = "deletePurgedSlugHolds";
        no_nul(op, &[("sourceId", source_id)])?;
        // The latest instant a slug's holds go up to; None is every hold of the slug.
        let mut cutoffs: BTreeMap<&str, Option<i64>> = BTreeMap::new();
        for page in pages {
            no_nul(op, &[("slugs", page.slug.as_str())])?;
            let upto = match &page.deleted_at {
                None => None,
                Some(text) => Some(deleted_at_micros(text)?),
            };
            cutoffs
                .entry(page.slug.as_str())
                .and_modify(|seen| {
                    *seen = match (*seen, upto) {
                        (Some(a), Some(b)) => Some(a.max(b)),
                        _ => None,
                    };
                })
                .or_insert(upto);
        }
        if cutoffs.is_empty() {
            return Ok(json!({ "write_gate_holds": 0, "write_gate_receipts": 0 }));
        }
        self.write(|tx| {
            let mut holds = 0u64;
            let mut receipts = 0u64;
            for (slug, cutoff) in &cutoffs {
                let mut prefix = tagged(HOLD_DEDUPE, &[source_id, slug]);
                prefix.push(0);
                let mut ids = Vec::new();
                let mut failure = None;
                scan_prefix(&*tx, &prefix, false, &mut |_, v| {
                    match keys::be8(v) {
                        Some(id) => ids.push(id),
                        None => {
                            failure = Some(StoreError::new(
                                crate::error::STORE_CORRUPT,
                                "bad write gate index entry",
                            ));
                        }
                    }
                    failure.is_none()
                })?;
                if let Some(e) = failure {
                    return Err(e);
                }
                for id in ids {
                    let Some(hold) = get_json::<HoldRecord>(&*tx, &by_id(HOLD, id))? else {
                        return Err(StoreError::new(
                            crate::error::STORE_CORRUPT,
                            "write gate hold index without its row",
                        ));
                    };
                    let last = hold.created_at_us.max(hold.last_seen_at_us);
                    if hold.source_id != source_id
                        || hold.slug != *slug
                        || cutoff.is_some_and(|upto| last > upto)
                    {
                        continue;
                    }
                    let version = hold.detector_version.to_string();
                    tx.delete(&tagged(
                        HOLD_DEDUPE,
                        &[&hold.source_id, &hold.slug, &hold.fingerprint, &version],
                    ))?;
                    tx.delete(&by_id(HOLD, id))?;
                    holds += 1;
                    for receipt in receipts_of(&*tx, "write_gate_holds", &id.to_string())? {
                        delete_receipt(tx, &receipt)?;
                        receipts += 1;
                    }
                }
            }
            Ok(json!({ "write_gate_holds": holds, "write_gate_receipts": receipts }))
        })
    }

    /// `deletePurgedPageGateReceipts(pageId, factIds, takeIds, holdIds)`: deletes the receipts that name the page, one of the
    /// facts or takes, or one of the holds (ids as text, matched as text); how many.
    pub fn delete_purged_page_gate_receipts(
        &self,
        page_id: i64,
        fact_ids: &[i64],
        take_ids: &[i64],
        hold_ids: &[String],
    ) -> Result<u64> {
        for id in hold_ids {
            no_nul("deletePurgedPageGateReceipts", &[("holdIds", id)])?;
        }
        let page = page_id.to_string();
        let facts: HashSet<String> = fact_ids.iter().map(i64::to_string).collect();
        let takes: HashSet<String> = take_ids.iter().map(i64::to_string).collect();
        let holds: HashSet<&str> = hold_ids.iter().map(String::as_str).collect();
        self.write(|tx| {
            let doomed: Vec<ReceiptRecord> = all_receipts(&*tx)?
                .into_iter()
                .filter(|r| match r.target_table.as_str() {
                    "pages" => r.target_id == page,
                    "facts" => facts.contains(&r.target_id),
                    "takes" => takes.contains(&r.target_id),
                    "write_gate_holds" => holds.contains(r.target_id.as_str()),
                    _ => false,
                })
                .collect();
            for r in &doomed {
                delete_receipt(tx, r)?;
            }
            Ok(doomed.len() as u64)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::deleted_at_micros;
    use crate::env::parse_iso;

    #[test]
    fn deleted_at_reads_the_forms_postgres_text_and_callers_give() {
        let us = parse_iso("2026-11-18T02:37:05.123456Z").unwrap();
        for text in [
            "2026-11-18T02:37:05.123456Z",
            "2026-11-18T02:37:05.123456+00:00",
            "2026-11-18 02:37:05.123456+00",
            "2026-11-18 08:07:05.123456+05:30",
            "2026-11-17 18:37:05.123456-08",
            "2026-11-17 18:37:05.123456-0800",
        ] {
            assert_eq!(deleted_at_micros(text).unwrap(), us, "{text}");
        }
        // Microseconds are kept: one microsecond later is a different instant.
        assert_eq!(
            deleted_at_micros("2026-11-18 02:37:05.123457+00").unwrap(),
            us + 1
        );
        for bad in ["", "not a time", "2026-11-18", "2026-02-30 00:00:00+00"] {
            let err = deleted_at_micros(bad).unwrap_err();
            assert_eq!(err.code, crate::error::INVALID_ARGUMENT, "{bad}");
            assert!(
                err.message
                    .contains("invalid input syntax for type timestamp with time zone")
            );
        }
    }
}
