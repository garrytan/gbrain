//! The fourteen fact reads and writes a `remember`, a proposal review, a page retire and a recall by id make
//! (`engine-sql/facts-trust.ts`, `engine-sql/facts-recall.ts`):
//!
//! - one-fact reads: `readFactEntitySlugById`, `readFactVisibility`, `readFactActivity`, `readReviewAcceptedMark`,
//!   `readPairFactRow`, `readSupersessionReplacement`;
//! - list reads: `listFactsToRetireFromPage`, `listFactProvenance`, `listFactRowsByIds`;
//! - the two reads of a save's guards: `readReplacementTarget` (the fact `replaces` names, with whether the withdrawal
//!   ledger covers it) and `readMemberPageWithdrawal` (the withdrawal a save onto a member page meets);
//! - the supersession writes: `linkSupersededFact`, `expireSupersededFact`, `restoreSupersededFact`.
//!
//! Every write goes through `write_fact`, so the trust stamp and the purge refusal apply as they do for `expireFact`,
//! and a `superseded_by` that names no fact refuses as `facts_superseded_by_fkey` does. `restoreSupersededFact` also
//! runs the withdrawal guard ([`preserve_withdrawal`]).
//! See rust/docs/store/facts.md, "Remember reads and supersession writes".

use super::forget::fact_number;
use super::generations::covers_fact;
use super::purge::withdrawal_covers;
use super::withdrawal_guard::preserve_withdrawal;
use super::{
    FactRecord, PrivacyPolicy, bigint, embedding, fact_fingerprint, foreign_key,
    hidden_by_private_provenance, like, opt_time, page_hidden, read_fact, source_rows,
    timestamptz_text, write_fact,
};
use crate::Store;
use crate::env::iso;
use crate::error::Result;
use crate::links::no_nul;
use crate::pages::read_page;
use crate::trust::fingerprint::fact_fingerprint_v1;
use crate::trust::withdrawals::withdrawal_time;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `{ id }`: the one id a read takes.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FactIdArgs {
    pub id: f64,
}

/// `{ id, sourceId }`: a read of one fact of a source.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcedFactArgs {
    pub id: f64,
    pub source_id: String,
}

/// `readReviewAcceptedMark(id, sourceId, mark)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptedMarkArgs {
    pub id: f64,
    pub source_id: String,
    pub mark: String,
}

/// `readPairFactRow(id, lock)`: the row lock changes nothing here, as every write is serialised.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairFactArgs {
    pub id: f64,
    #[serde(default)]
    pub lock: Option<bool>,
}

/// `readSupersessionReplacement(newId, oldId)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementPairArgs {
    pub new_id: f64,
    pub old_id: f64,
}

/// `linkSupersededFact(oldId, newId)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkArgs {
    pub old_id: f64,
    pub new_id: f64,
}

/// `listFactsToRetireFromPage(sourceId, session, slug, pattern)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetireArgs {
    pub source_id: String,
    pub session: String,
    pub slug: String,
    pub pattern: String,
}

/// `listFactRowsByIds(sourceIds, ids)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowsByIdsArgs {
    pub source_ids: Vec<String>,
    pub ids: Vec<f64>,
}

/// `expireSupersededFact({ oldId, sourceId, newId, until })`: `until` is an ISO instant or absent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpireSupersededFactArgs {
    pub old_id: f64,
    pub source_id: String,
    pub new_id: f64,
    #[serde(default)]
    pub until: Option<String>,
}

/// `restoreSupersededFact({ oldId, sourceId, expiredAt, validUntil, supersededBy, expectedSupersededBy })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreSupersededFactArgs {
    pub old_id: f64,
    pub source_id: String,
    #[serde(default)]
    pub expired_at: Option<String>,
    #[serde(default)]
    pub valid_until: Option<String>,
    #[serde(default)]
    pub superseded_by: Option<f64>,
    #[serde(default)]
    pub expected_superseded_by: Option<f64>,
}

/// `readReplacementTarget({ targetId, sourceId, excludePrivate, ownPage, lock })`: `exclude_private` is the remote
/// provenance floor the TypeScript member read off the caller (absent without `excludePrivate`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplacementTargetArgs {
    pub target_id: f64,
    pub source_id: String,
    #[serde(default)]
    pub exclude_private: Option<PrivacyPolicy>,
    #[serde(default)]
    pub own_page: Option<String>,
    #[serde(default)]
    pub lock: Option<bool>,
}

/// `readMemberPageWithdrawal({ sourceId, visibility, fact, entitySlug, page, ... })`: `policy` is the page policy of the
/// page's member (`readPolicyFragment('pp', identity, true, [])`), read off the caller by the TypeScript member.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemberWithdrawalArgs {
    pub source_id: String,
    pub visibility: String,
    pub fact: String,
    #[serde(default)]
    pub entity_slug: Option<String>,
    pub page: String,
    pub policy: PrivacyPolicy,
}

/// The facts of `ids` as a set: `id = ANY(ids)` answers a repeated id once, and an id below 1 names no row.
fn id_set(op: &str, ids: &[f64]) -> Result<BTreeSet<u64>> {
    let mut out = BTreeSet::new();
    for id in ids {
        if let Some(id) = fact_number(op, *id)? {
            out.insert(id);
        }
    }
    Ok(out)
}

/// A `superseded_by` value: it must name a fact (`facts_superseded_by_fkey`).
fn require_fact(tx: &dyn crate::kv::KvRead, id: i64) -> Result<u64> {
    if id >= 1 && read_fact(tx, id as u64)?.is_some() {
        Ok(id as u64)
    } else {
        Err(foreign_key("facts_superseded_by_fkey"))
    }
}

impl Store {
    /// `readFactEntitySlugById`: the fact's `entity_slug`, or `None` for no entity or no fact.
    pub fn read_fact_entity_slug_by_id(&self, args: &FactIdArgs) -> Result<Option<String>> {
        let Some(id) = fact_number("readFactEntitySlugById", args.id)? else {
            return Ok(None);
        };
        let read = self.read()?;
        Ok(read_fact(&*read, id)?.and_then(|f| f.entity_slug))
    }

    /// `readSupersessionReplacement`: the replacement's fence row, whether both facts sit on one page (`IS NOT DISTINCT
    /// FROM`, so two facts with no page do), both validity starts and the old end; `None` when either id is gone.
    pub fn read_supersession_replacement(
        &self,
        args: &ReplacementPairArgs,
    ) -> Result<Option<Value>> {
        const OP: &str = "readSupersessionReplacement";
        let new_id = fact_number(OP, args.new_id)?;
        let old_id = fact_number(OP, args.old_id)?;
        let read = self.read()?;
        let (Some(n), Some(o)) = (
            new_id
                .map(|id| read_fact(&*read, id))
                .transpose()?
                .flatten(),
            old_id
                .map(|id| read_fact(&*read, id))
                .transpose()?
                .flatten(),
        ) else {
            return Ok(None);
        };
        Ok(Some(json!({
            "row_num": n.row_num,
            "same_page": n.source_markdown_slug == o.source_markdown_slug,
            "valid_from": iso(n.valid_from_us),
            "old_from": iso(o.valid_from_us),
            "old_until": o.valid_until_us.map(iso),
        })))
    }

    /// `linkSupersededFact`: sets `superseded_by` on the old fact. An old id that names nothing updates nothing; a new id
    /// that names no fact refuses once a row would change.
    pub fn link_superseded_fact(&self, args: &LinkArgs) -> Result<()> {
        const OP: &str = "linkSupersededFact";
        let old_id = fact_number(OP, args.old_id)?;
        let new_id = bigint(OP, "newId", args.new_id)?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = old_id.map(|id| read_fact(tx, id)).transpose()?.flatten() else {
                return Ok(());
            };
            let mut new = old.clone();
            new.superseded_by = Some(require_fact(tx, new_id)?);
            write_fact(tx, trust, Some(&old), &new)
        })
    }

    /// `listFactsToRetireFromPage`: the source's unexpired facts extracted under `session`, or whose context is `slug`
    /// or matches the LIKE `pattern`, in id order.
    pub fn list_facts_to_retire_from_page(&self, args: &RetireArgs) -> Result<Vec<Value>> {
        const OP: &str = "listFactsToRetireFromPage";
        no_nul(
            OP,
            &[
                ("sourceId", &args.source_id),
                ("session", &args.session),
                ("slug", &args.slug),
                ("pattern", &args.pattern),
            ],
        )?;
        let read = self.read()?;
        let mut rows = Vec::new();
        for f in source_rows(&*read, &args.source_id)? {
            if f.expired_at_us.is_some() {
                continue;
            }
            let hit = f.source_session.as_deref() == Some(args.session.as_str())
                || f.context.as_deref() == Some(args.slug.as_str())
                || match f.context.as_deref() {
                    Some(context) => like(context, &args.pattern, false)?,
                    None => false,
                };
            if hit {
                rows.push(f);
            }
        }
        rows.sort_by_key(|f| f.id);
        Ok(rows
            .into_iter()
            .map(|f| {
                json!({
                    "id": f.id,
                    "row_num": f.row_num,
                    "source_markdown_slug": f.source_markdown_slug,
                    "entity_slug": f.entity_slug,
                })
            })
            .collect())
    }

    /// `listFactRowsByIds`: the whole rows of these ids within these sources, in id order.
    pub fn list_fact_rows_by_ids(&self, args: &RowsByIdsArgs) -> Result<Vec<Value>> {
        const OP: &str = "listFactRowsByIds";
        let ids = id_set(OP, &args.ids)?;
        let read = self.read()?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(f) =
                read_fact(&*read, id)?.filter(|f| args.source_ids.contains(&f.source_id))
            {
                out.push(f.to_json(false, false));
            }
        }
        Ok(out)
    }

    /// `readFactVisibility`: `{ visibility }` of a fact of the source, or `None`.
    pub fn read_fact_visibility(&self, args: &SourcedFactArgs) -> Result<Option<Value>> {
        let Some(f) = self.sourced_fact("readFactVisibility", args)? else {
            return Ok(None);
        };
        Ok(Some(json!({ "visibility": f.visibility })))
    }

    /// `readFactActivity`: whether the source's fact is active now, and the md5 of its text, or `None`.
    pub fn read_fact_activity(&self, args: &SourcedFactArgs) -> Result<Option<Value>> {
        let now = self.env.now_micros();
        let Some(f) = self.sourced_fact("readFactActivity", args)? else {
            return Ok(None);
        };
        Ok(Some(json!({
            "active": f.active(now),
            "text_hash": embedding::md5_hex(&f.fact),
        })))
    }

    /// `readReviewAcceptedMark`: `{ id }` when the source's fact is expired and its context carries `mark`.
    pub fn read_review_accepted_mark(&self, args: &AcceptedMarkArgs) -> Result<Option<Value>> {
        const OP: &str = "readReviewAcceptedMark";
        no_nul(OP, &[("mark", &args.mark)])?;
        let sourced = SourcedFactArgs {
            id: args.id,
            source_id: args.source_id.clone(),
        };
        let Some(f) = self.sourced_fact(OP, &sourced)? else {
            return Ok(None);
        };
        let marked = f.context.as_deref().unwrap_or("").contains(&args.mark);
        Ok((f.expired_at_us.is_some() && marked).then(|| json!({ "id": f.id })))
    }

    /// `readPairFactRow`: one fact of a supersede pair by id (any source).
    pub fn read_pair_fact_row(&self, args: &PairFactArgs) -> Result<Option<Value>> {
        let Some(id) = fact_number("readPairFactRow", args.id)? else {
            return Ok(None);
        };
        let read = self.read()?;
        Ok(read_fact(&*read, id)?.map(|f| {
            json!({
                "id": f.id,
                "source_id": f.source_id,
                "entity_slug": f.entity_slug,
                "visibility": f.visibility,
                "fact": f.fact,
                "expired_at": f.expired_at_us.map(iso),
                "valid_from": iso(f.valid_from_us),
                "valid_until": f.valid_until_us.map(iso),
                "superseded_by": f.superseded_by,
                "row_num": f.row_num,
                "source_markdown_slug": f.source_markdown_slug,
            })
        }))
    }

    /// `expireSupersededFact`: ends and expires the source's unexpired old fact and links it to the new one; the row
    /// count. `valid_until` = `until`, else `GREATEST(valid_from, LEAST(COALESCE(valid_until, now), now))`.
    pub fn expire_superseded_fact(&self, args: &ExpireSupersededFactArgs) -> Result<u64> {
        const OP: &str = "expireSupersededFact";
        no_nul(OP, &[("sourceId", &args.source_id)])?;
        let old_id = fact_number(OP, args.old_id)?;
        let new_id = bigint(OP, "newId", args.new_id)?;
        let until = opt_time(OP, "until", &args.until)?;
        let now = self.env.now_micros();
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = old_id.map(|id| read_fact(tx, id)).transpose()?.flatten() else {
                return Ok(0);
            };
            if old.source_id != args.source_id || old.expired_at_us.is_some() {
                return Ok(0);
            }
            let mut new = old.clone();
            new.superseded_by = Some(require_fact(tx, new_id)?);
            new.valid_until_us = Some(until.unwrap_or_else(|| {
                old.valid_from_us
                    .max(old.valid_until_us.unwrap_or(now).min(now))
            }));
            new.expired_at_us = Some(now);
            write_fact(tx, trust, Some(&old), &new)?;
            Ok(1)
        })
    }

    /// `restoreSupersededFact`: puts the source's old fact back as it was, only while it still points at
    /// `expectedSupersededBy` (`IS NOT DISTINCT FROM`); the row count. The withdrawal guard runs (`expired_at` is in
    /// the `SET` list): a row restored active that a withdrawal of its claim reaches comes back expired.
    pub fn restore_superseded_fact(&self, args: &RestoreSupersededFactArgs) -> Result<u64> {
        const OP: &str = "restoreSupersededFact";
        no_nul(OP, &[("sourceId", &args.source_id)])?;
        let old_id = fact_number(OP, args.old_id)?;
        let expired_at = opt_time(OP, "expiredAt", &args.expired_at)?;
        let valid_until = opt_time(OP, "validUntil", &args.valid_until)?;
        let superseded_by = args
            .superseded_by
            .map(|v| bigint(OP, "supersededBy", v))
            .transpose()?;
        let expected = args
            .expected_superseded_by
            .map(|v| bigint(OP, "expectedSupersededBy", v))
            .transpose()?;
        let trust = &self.write_trust()?;
        self.write(|tx| {
            let Some(old) = old_id.map(|id| read_fact(tx, id)).transpose()?.flatten() else {
                return Ok(0);
            };
            let current = old.superseded_by.and_then(|v| i64::try_from(v).ok());
            if old.source_id != args.source_id || current != expected {
                return Ok(0);
            }
            let mut new = old.clone();
            new.expired_at_us = expired_at;
            new.valid_until_us = valid_until;
            new.superseded_by = superseded_by.map(|v| require_fact(tx, v)).transpose()?;
            preserve_withdrawal(&*tx, &mut new)?;
            write_fact(tx, trust, Some(&old), &new)?;
            Ok(1)
        })
    }

    /// `readReplacementTarget`: the whole row of fact `targetId` of the source with `withdrawn` (a ledger row of the
    /// source and visibility with the fact's current or v1 fingerprint that `withdrawalCoversFactSql` reaches), or `None`
    /// for a fact that is gone, in another source or, under `excludePrivate`, hidden by the remote floor: a row of
    /// `ownPage` stays.
    pub fn read_replacement_target(&self, args: &ReplacementTargetArgs) -> Result<Option<Value>> {
        const OP: &str = "readReplacementTarget";
        no_nul(OP, &[("sourceId", &args.source_id)])?;
        let Some(id) = fact_number(OP, args.target_id)? else {
            return Ok(None);
        };
        let read = self.read()?;
        let Some(f) = read_fact(&*read, id)?.filter(|f| f.source_id == args.source_id) else {
            return Ok(None);
        };
        if let Some(policy) = &args.exclude_private {
            let own = args.own_page.is_some() && f.source_markdown_slug == args.own_page;
            if !own && hidden_by_private_provenance(&*read, &f, policy)? {
                return Ok(None);
            }
        }
        let hashes = [fact_fingerprint(&f.fact), fact_fingerprint_v1(&f.fact)];
        let mut withdrawn = false;
        for key in self.list_fact_withdrawal_keys(&f.source_id, i64::MAX)? {
            if key.visibility == f.visibility
                && hashes.contains(&key.fact_hash)
                && covers_fact(&*read, &f, &key.subject)?
            {
                withdrawn = true;
                break;
            }
        }
        let mut row = f.to_json(false, false);
        if let Value::Object(map) = &mut row {
            // The SQL read `f.*`, so the row carries the columns `rowToFact` leaves out.
            map.insert("row_num".into(), json!(f.row_num));
            map.insert("source_markdown_slug".into(), json!(f.source_markdown_slug));
            map.insert("event_type".into(), json!(f.event_type));
            map.insert("dimension".into(), json!(f.dimension));
            map.insert("value".into(), json!(f.value));
            map.insert("value_hash".into(), json!(f.value_hash));
            map.insert("dim_status".into(), json!(f.dim_status));
            map.insert("withdrawn".into(), json!(withdrawn));
        }
        Ok(Some(row))
    }

    /// `readMemberPageWithdrawal` (GST-2346): the withdrawal a save onto member page `page` meets, or `None`. A ledger row
    /// of the source and visibility under the claim's current or v1 fingerprint counts when its subject is the page, or
    /// when it is `*` or the claim's entity and withdrew a row the page's member reads: an expired row of the same
    /// visibility and fingerprint that the withdrawal reaches, on the page itself or (world rows only) on pages the
    /// policy lets the member read. The most specific subject comes first, then the newest.
    pub fn read_member_page_withdrawal(
        &self,
        args: &MemberWithdrawalArgs,
    ) -> Result<Option<Value>> {
        const OP: &str = "readMemberPageWithdrawal";
        no_nul(
            OP,
            &[
                ("sourceId", &args.source_id),
                ("visibility", &args.visibility),
                ("page", &args.page),
            ],
        )?;
        let read = self.read()?;
        let hashes = [
            fact_fingerprint(&args.fact),
            fact_fingerprint_v1(&args.fact),
        ];
        let mut subjects = vec![args.page.clone()];
        for s in std::iter::once("*").chain(args.entity_slug.as_deref()) {
            if !subjects.iter().any(|t| t == s) {
                subjects.push(s.to_string());
            }
        }
        // The rows the withdrawal may have withdrawn: expired, this visibility, the claim's text.
        let readable = |f: &FactRecord| -> Result<bool> {
            if f.source_markdown_slug.as_deref() == Some(args.page.as_str()) {
                return Ok(true);
            }
            if f.visibility != "world" {
                return Ok(false);
            }
            for slug in [f.source_markdown_slug.as_deref(), f.entity_slug.as_deref()]
                .into_iter()
                .flatten()
            {
                if let Some(page) = read_page(&*read, &f.source_id, slug)?
                    && page_hidden(&*read, &page, &args.policy)?
                {
                    return Ok(false);
                }
            }
            Ok(true)
        };
        let mut candidates: Vec<(String, i64)> = Vec::new();
        let mut backing: Option<Vec<FactRecord>> = None;
        for subject in &subjects {
            for hash in &hashes {
                let Some(at) =
                    withdrawal_time(&*read, &args.source_id, &args.visibility, subject, hash)?
                else {
                    continue;
                };
                let counts = if *subject == args.page {
                    true
                } else {
                    if backing.is_none() {
                        backing = Some(
                            source_rows(&*read, &args.source_id)?
                                .into_iter()
                                .filter(|f| {
                                    f.visibility == args.visibility
                                        && f.expired_at_us.is_some()
                                        && fact_fingerprint(&f.fact) == hashes[0]
                                })
                                .collect(),
                        );
                    }
                    let mut found = false;
                    for f in backing.iter().flatten() {
                        if withdrawal_covers(&*read, f, subject)? && readable(f)? {
                            found = true;
                            break;
                        }
                    }
                    found
                };
                if counts {
                    candidates.push((subject.clone(), at));
                }
            }
        }
        candidates.sort_by_key(|a| std::cmp::Reverse(((a.0 != "*") as u8, a.1)));
        Ok(candidates.into_iter().next().map(|(subject, at)| {
            json!({
                "subject": subject,
                "visibility": args.visibility,
                "withdrawn_at": timestamptz_text(at),
            })
        }))
    }

    /// The fact `args.id` when it is in `args.source_id`.
    fn sourced_fact(&self, op: &str, args: &SourcedFactArgs) -> Result<Option<FactRecord>> {
        no_nul(op, &[("sourceId", &args.source_id)])?;
        let Some(id) = fact_number(op, args.id)? else {
            return Ok(None);
        };
        let read = self.read()?;
        Ok(read_fact(&*read, id)?.filter(|f| f.source_id == args.source_id))
    }
}
