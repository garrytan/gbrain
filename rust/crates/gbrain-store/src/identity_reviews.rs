//! The duplicate finder's read and the owner's identity decisions: the `entity_identity_reviews`
//! table of the PGLite engine (migration v325) and the `entity_identities` rows a "same" decision
//! materializes (`engine-sql/entity-keys.ts`, `engine-sql/identity-decisions.ts`, callers in
//! `entities/duplicates.ts`, `entities/identity-decisions.ts` and `commands/dedupe.ts`).
//!
//! Members: listEntityKeyRows, listIdentityDecisions, listRestrictedIdentityMembers,
//! applyIdentityDecisions (rust/docs/store/entity_identities.md, "Identity decisions").
//!
//! Keys: `i 0x03 decision_id` -> [`ReviewRecord`] (JSON), one per decision, under the entity
//! identity tag. A review names its member pages by `(source_id, slug)`, not by page id, so a
//! page delete or rename leaves it alone, as the table has no foreign key.
//!
//! An apply runs in one `Store::write`, so the decision rows and the identity rows change together
//! or not at all, and applies run one at a time (the advisory lock of the SQL).

use crate::alias_fanout_reads::reject_nul;
use crate::cli_reads::entities::{is_collapsed, is_retired};
use crate::cli_reads::pg_text::timestamptz_text;
use crate::entity_identities::{
    IdentityRecord, all_records, group_key, group_pages, record, row_key,
};
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::identity_auto::{
    AutoPlan, KeyTokens, Members, generation, link_planned, page_matches_tokens, unlink_broken,
    unlink_covered,
};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, all_pages, read_page};
use crate::sources::read_source;
use crate::{Store, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

const REVIEW: u8 = 0x03;
const CONFIRM: &str = "dedupe:confirm";

/// A page named by `(source_id, slug)`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemberRef {
    pub source_id: String,
    pub slug: String,
}

/// One decision: the table's columns less `decision_id` (the key).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReviewRecord {
    verdict: String,
    members: Value,
    group_id: Option<String>,
    entity_id: Option<String>,
    canonical_source_id: Option<String>,
    canonical_slug: Option<String>,
    decided_by: String,
    decided_at_us: i64,
    origin: String,
    home_source_id: Option<String>,
    git_blob: Option<String>,
    /// On a "different" decision: each member's fingerprint when it was recorded; none when no
    /// fingerprint was kept (a record written before the column existed reads as none).
    #[serde(default)]
    evidence: Option<Vec<String>>,
}

impl ReviewRecord {
    /// The members as `(source_id, slug)`: the SQL reads `member->>'source_id'` and `->>'slug'`.
    fn member_refs(&self) -> Vec<(Option<String>, Option<String>)> {
        let text = |m: &Value, key: &str| m.get(key).and_then(Value::as_str).map(str::to_string);
        self.members
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|m| (text(m, "source_id"), text(m, "slug")))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn is_canonical(&self, page: &PageRecord) -> bool {
        self.canonical_source_id.as_deref() == Some(page.source_id.as_str())
            && self.canonical_slug.as_deref() == Some(page.slug.as_str())
    }
}

/// `listEntityKeyRows(opts)`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntityKeyRowsOpts {
    pub types: Vec<String>,
    pub keys: Vec<String>,
    pub after: Option<MemberRef>,
    pub limit: i64,
    /// Narrows the read to these pages.
    #[serde(default)]
    pub members: Option<Vec<MemberRef>>,
    /// Narrows the read to pages one of whose `fields` values reads as one of the token values.
    #[serde(default)]
    pub tokens: Option<KeyTokens>,
    /// Instead of the live unretired pages: the retired pages a dedupe collapse made (a
    /// `dedupe_collapse` record and a `merged_into` value that is not blank).
    #[serde(default)]
    pub collapsed: bool,
}

/// One decision of `applyIdentityDecisions({ upsert })`; `decided_at` null takes now.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionInput {
    pub decision_id: String,
    pub verdict: String,
    pub members: Value,
    pub group_id: Option<String>,
    pub entity_id: Option<String>,
    pub canonical: Option<MemberRef>,
    pub decided_by: String,
    pub decided_at: Option<String>,
    pub origin: String,
    pub home_source_id: Option<String>,
    pub git_blob: Option<String>,
    /// Stored when it is not empty, else none.
    #[serde(default)]
    pub evidence: Option<Vec<String>>,
}

/// `applyIdentityDecisions(input)`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ApplyDecisions {
    pub upsert: Vec<DecisionInput>,
    pub remove: Vec<String>,
    pub expect_revision: Option<String>,
    /// The company sweep's plan (`identity_auto`); the result carries `auto` only when it is given.
    pub auto: Option<AutoPlan>,
}

fn review_key(decision_id: &str) -> Vec<u8> {
    let mut key = vec![keys::ENTITY_IDENTITY, REVIEW];
    key.extend_from_slice(decision_id.as_bytes());
    key
}

/// Every decision, in decision id (byte) order.
fn all_reviews(read: &dyn KvRead) -> Result<Vec<(String, ReviewRecord)>> {
    let prefix = [keys::ENTITY_IDENTITY, REVIEW];
    let mut raw = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, v| {
        raw.push((
            String::from_utf8_lossy(&k[prefix.len()..]).into_owned(),
            v.to_vec(),
        ));
        true
    })?;
    raw.into_iter()
        .map(|(id, v)| Ok((id, serde_json::from_slice(&v)?)))
        .collect()
}

/// `decisionsRevision`: every row's id, verdict, entity, origin and blob, in id order.
fn revision(reviews: &[(String, ReviewRecord)]) -> String {
    reviews
        .iter()
        .map(|(id, r)| {
            [
                id.as_str(),
                r.verdict.as_str(),
                r.entity_id.as_deref().unwrap_or(""),
                r.origin.as_str(),
                r.git_blob.as_deref().unwrap_or(""),
            ]
            .join(":")
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// The live page a member names (`LEFT JOIN pages p ... AND p.deleted_at IS NULL`).
fn live_member(
    read: &dyn KvRead,
    source_id: &Option<String>,
    slug: &Option<String>,
) -> Result<Option<PageRecord>> {
    let (Some(source_id), Some(slug)) = (source_id, slug) else {
        return Ok(None);
    };
    Ok(read_page(read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none()))
}

/// The membership of a page when it sits in its own source (`x.source_id = p.source_id`).
fn membership(read: &dyn KvRead, page: &PageRecord) -> Result<Option<IdentityRecord>> {
    Ok(record(read, page.id)?.filter(|r| r.source_id == page.source_id))
}

/// jsonb's key order: shorter keys first, then byte order.
fn jsonb_key_order(a: &String, b: &String) -> std::cmp::Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

impl Store {
    /// `listEntityKeyRows(opts)`: live, unretired pages of the types in sources that are not
    /// archived, with only the named frontmatter keys the page carries (a JSON null value counts),
    /// keyset-paged by `(source_id, slug)` in byte order.
    pub fn list_entity_key_rows(&self, opts: &EntityKeyRowsOpts) -> Result<Vec<Value>> {
        const MEMBER: &str = "listEntityKeyRows";
        reject_nul(
            MEMBER,
            opts.types.iter().chain(&opts.keys).map(String::as_str),
        )?;
        if let Some(after) = &opts.after {
            reject_nul(MEMBER, [after.source_id.as_str(), after.slug.as_str()])?;
        }
        if let Some(members) = &opts.members {
            reject_nul(
                MEMBER,
                members
                    .iter()
                    .flat_map(|m| [m.source_id.as_str(), m.slug.as_str()]),
            )?;
        }
        if let Some(tokens) = &opts.tokens {
            reject_nul(
                MEMBER,
                tokens
                    .values
                    .iter()
                    .chain(&tokens.fields)
                    .map(String::as_str),
            )?;
        }
        let named: Option<HashSet<(&str, &str)>> = opts.members.as_ref().map(|members| {
            members
                .iter()
                .map(|m| (m.source_id.as_str(), m.slug.as_str()))
                .collect()
        });
        if opts.limit < 0 {
            return Err(StoreError::invalid(format!(
                "{MEMBER}: LIMIT must not be negative"
            )));
        }
        let types: HashSet<&str> = opts.types.iter().map(String::as_str).collect();
        let mut wanted: Vec<String> = opts.keys.clone();
        wanted.sort_by(jsonb_key_order);
        wanted.dedup();
        let after = opts
            .after
            .as_ref()
            .map_or((String::new(), String::new()), |a| {
                (a.source_id.clone(), a.slug.clone())
            });
        let read = self.read()?;
        let mut archived: HashMap<String, bool> = HashMap::new();
        let mut rows = Vec::new();
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some()
                || !types.contains(page.page_type.as_str())
                || (page.source_id.as_str(), page.slug.as_str())
                    <= (after.0.as_str(), after.1.as_str())
                || (if opts.collapsed {
                    !is_collapsed(&page)
                } else {
                    is_retired(&page)
                })
                || named
                    .as_ref()
                    .is_some_and(|n| !n.contains(&(page.source_id.as_str(), page.slug.as_str())))
                || opts
                    .tokens
                    .as_ref()
                    .is_some_and(|t| !page_matches_tokens(&page, t))
            {
                continue;
            }
            let live_source = match archived.get(&page.source_id) {
                Some(live) => *live,
                None => {
                    let live = read_source(&*read, &page.source_id)?.is_some_and(|s| !s.archived);
                    archived.insert(page.source_id.clone(), live);
                    live
                }
            };
            if live_source {
                rows.push(page);
            }
        }
        rows.sort_by(|a, b| (&a.source_id, &a.slug).cmp(&(&b.source_id, &b.slug)));
        rows.truncate(usize::try_from(opts.limit).unwrap_or(usize::MAX));
        rows.into_iter()
            .map(|p| {
                let mut kept = Map::new();
                for key in &wanted {
                    if let Some(v) = p.frontmatter.get(key) {
                        kept.insert(key.clone(), v.clone());
                    }
                }
                let identity = membership(&*read, &p)?.map_or(Value::Null, |x| {
                    json!({ "entity_id": x.entity_id, "established_by": x.established_by })
                });
                Ok(json!({
                    "source_id": p.source_id, "slug": p.slug, "title": p.title, "type": p.page_type, "keys": kept,
                    "page_id": p.id, "generation": generation(&p), "created_at": iso(p.created_at_us), "identity": identity,
                }))
            })
            .collect()
    }

    /// `listIdentityDecisions()`: `{ decisions, pending, revision }`. Decisions come in decision id
    /// order with `decided_at` as `timestamptz::text`; pending names each member of a "same"
    /// decision whose page is missing, sits in no group (`unlinked`) or in another group, by
    /// decision id, source, then slug.
    pub fn list_identity_decisions(&self) -> Result<Value> {
        let read = self.read()?;
        let reviews = all_reviews(&*read)?;
        let mut pending = Vec::new();
        for (id, r) in &reviews {
            if r.verdict != "same" {
                continue;
            }
            for (source_id, slug) in r.member_refs() {
                let reason = match live_member(&*read, &source_id, &slug)? {
                    None => "page_missing",
                    Some(page) => match membership(&*read, &page)? {
                        None if r.entity_id.is_none() => continue,
                        None => "unlinked",
                        Some(x) if Some(&x.entity_id) == r.entity_id.as_ref() => continue,
                        Some(_) => "other_group",
                    },
                };
                pending.push((id.clone(), source_id, slug, reason));
            }
        }
        pending.sort_by(|a, b| (&a.0, &a.1, &a.2).cmp(&(&b.0, &b.1, &b.2)));
        let decisions: Vec<Value> = reviews
            .iter()
            .map(|(id, r)| {
                let canonical = match (&r.canonical_source_id, &r.canonical_slug) {
                    (Some(s), Some(g)) if !s.is_empty() && !g.is_empty() => {
                        json!({ "source_id": s, "slug": g })
                    }
                    _ => Value::Null,
                };
                json!({
                    "decision_id": id, "verdict": r.verdict, "members": r.members, "group_id": r.group_id,
                    "entity_id": r.entity_id, "canonical": canonical, "decided_by": r.decided_by,
                    "decided_at": timestamptz_text(r.decided_at_us), "origin": r.origin,
                    "home_source_id": r.home_source_id, "git_blob": r.git_blob, "evidence": r.evidence,
                })
            })
            .collect();
        let pending: Vec<Value> = pending
            .into_iter()
            .map(|(decision_id, source_id, slug, reason)| {
                json!({ "decision_id": decision_id, "source_id": source_id, "slug": slug, "reason": reason })
            })
            .collect();
        Ok(json!({ "decisions": decisions, "pending": pending, "revision": revision(&reviews) }))
    }

    /// `listRestrictedIdentityMembers(members)`: the members whose page (live or soft-deleted) the
    /// no-caller page policy hides, once per matching input pair, in input order.
    pub fn list_restricted_identity_members(
        &self,
        members: &[MemberRef],
        policy: &PrivacyPolicy,
    ) -> Result<Vec<Value>> {
        reject_nul(
            "listRestrictedIdentityMembers",
            members
                .iter()
                .flat_map(|m| [m.source_id.as_str(), m.slug.as_str()]),
        )?;
        let read = self.read()?;
        let mut out = Vec::new();
        for m in members {
            if let Some(page) = read_page(&*read, &m.source_id, &m.slug)?
                && page_hidden(&*read, &page, policy)?
            {
                out.push(json!({ "source_id": page.source_id, "slug": page.slug }));
            }
        }
        Ok(out)
    }

    /// `applyIdentityDecisions(input)`: `{ upserted, removed, linked, unlinked }`, or with `stale:
    /// true` and nothing written when `expect_revision` is not the revision of the rows now.
    pub fn apply_identity_decisions(&self, input: &ApplyDecisions) -> Result<Value> {
        const MEMBER: &str = "applyIdentityDecisions";
        reject_nul(MEMBER, input.remove.iter().map(String::as_str))?;
        let mut decided = Vec::with_capacity(input.upsert.len());
        for d in &input.upsert {
            let texts = [&d.group_id, &d.entity_id, &d.home_source_id, &d.git_blob];
            reject_nul(
                MEMBER,
                [
                    d.decision_id.as_str(),
                    d.verdict.as_str(),
                    d.decided_by.as_str(),
                    d.origin.as_str(),
                ]
                .into_iter()
                .chain(texts.iter().filter_map(|t| t.as_deref()))
                .chain(d.evidence.iter().flatten().map(String::as_str)),
            )?;
            if !matches!(d.verdict.as_str(), "same" | "different") {
                return Err(StoreError::invalid(format!(
                    "{MEMBER}: verdict must be same or different"
                )));
            }
            if !matches!(d.origin.as_str(), "database" | "git") {
                return Err(StoreError::invalid(format!(
                    "{MEMBER}: origin must be database or git"
                )));
            }
            let at = match &d.decided_at {
                None => None,
                Some(text) => Some(decided_at_micros(text).ok_or_else(|| {
                    StoreError::invalid(format!("{MEMBER}: decided_at is not a timestamp: {text}"))
                })?),
            };
            decided.push(at);
        }
        self.write(|tx| {
            if let Some(expect) = &input.expect_revision
                && revision(&all_reviews(tx)?) != *expect
            {
                return Ok(json!({ "upserted": 0, "removed": 0, "linked": 0, "unlinked": 0, "stale": true }));
            }
            let mut removed = 0;
            let gone: HashSet<&str> = input.remove.iter().map(String::as_str).collect();
            for id in gone {
                let key = review_key(id);
                if tx.get(&key)?.is_some() {
                    tx.delete(&key)?;
                    removed += 1;
                }
            }
            let now = self.env.now_micros();
            for (d, at) in input.upsert.iter().zip(&decided) {
                let rec = ReviewRecord {
                    verdict: d.verdict.clone(),
                    members: d.members.clone(),
                    group_id: d.group_id.clone(),
                    entity_id: d.entity_id.clone(),
                    canonical_source_id: d.canonical.as_ref().map(|c| c.source_id.clone()),
                    canonical_slug: d.canonical.as_ref().map(|c| c.slug.clone()),
                    decided_by: d.decided_by.clone(),
                    decided_at_us: at.unwrap_or(now),
                    origin: d.origin.clone(),
                    home_source_id: d.home_source_id.clone(),
                    git_blob: d.git_blob.clone(),
                    evidence: d.evidence.clone().filter(|e| !e.is_empty()),
                };
                put_json(tx, &review_key(&d.decision_id), &rec)?;
            }
            // The company sweep's automatic groups (identity_auto), before the confirmed rows.
            let auto = self.apply_auto(tx, input.auto.as_ref(), now)?;
            // The live member pages of every "same" decision with a group: (decision id, entity, page).
            let mut confirmed: Vec<(String, String, PageRecord, bool)> = Vec::new();
            for (id, r) in all_reviews(tx)? {
                let Some(entity) = r.entity_id.clone().filter(|_| r.verdict == "same") else {
                    continue;
                };
                for (source_id, slug) in r.member_refs() {
                    if let Some(page) = live_member(tx, &source_id, &slug)? {
                        let canonical = r.is_canonical(&page);
                        confirmed.push((id.clone(), entity.clone(), page, canonical));
                    }
                }
            }
            let backed: HashSet<(&str, u64)> =
                confirmed.iter().map(|(_, e, p, _)| (e.as_str(), p.id)).collect();
            let mut unlinked = 0;
            for (page_id, rec) in all_records(tx)? {
                if rec.established_by == CONFIRM && !backed.contains(&(rec.entity_id.as_str(), page_id)) {
                    tx.delete(&group_key(&rec.entity_id, page_id))?;
                    tx.delete(&row_key(page_id))?;
                    unlinked += 1;
                }
            }
            // Link each member page that sits in no group; per group, the first candidate (canonical
            // first, then decision id, source, page id) is canonical when it is the decision's
            // canonical member and the group had none.
            let mut candidates: BTreeMap<&str, Vec<&(String, String, PageRecord, bool)>> = BTreeMap::new();
            for c in &confirmed {
                if record(tx, c.2.id)?.is_none() {
                    candidates.entry(c.1.as_str()).or_default().push(c);
                }
            }
            let mut linked = 0;
            for (entity, mut rows) in candidates {
                rows.sort_by(|a, b| {
                    b.3.cmp(&a.3)
                        .then_with(|| a.0.cmp(&b.0))
                        .then_with(|| a.2.source_id.cmp(&b.2.source_id))
                        .then_with(|| a.2.id.cmp(&b.2.id))
                });
                let had_canonical = group_has_canonical(tx, entity)?;
                for (rn, (_, _, page, is_canonical)) in rows.into_iter().enumerate() {
                    if record(tx, page.id)?.is_some() {
                        continue;
                    }
                    let rec = IdentityRecord {
                        entity_id: entity.to_string(),
                        source_id: page.source_id.clone(),
                        confidence: 1.0,
                        established_by: CONFIRM.to_string(),
                        established_at_us: now,
                        canonical: *is_canonical && rn == 0 && !had_canonical,
                    };
                    put_json(tx, &row_key(page.id), &rec)?;
                    tx.put(&group_key(entity, page.id), &[])?;
                    linked += 1;
                }
            }
            // Mark the decision's canonical member canonical (first decision by id per group) when
            // its group still has none and the page sits in that group.
            let mut first: BTreeMap<&str, &PageRecord> = BTreeMap::new();
            let mut by_decision: Vec<&(String, String, PageRecord, bool)> =
                confirmed.iter().filter(|c| c.3).collect();
            by_decision.sort_by(|a, b| a.0.cmp(&b.0));
            for c in by_decision {
                first.entry(c.1.as_str()).or_insert(&c.2);
            }
            for (entity, page) in first {
                if group_has_canonical(tx, entity)? {
                    continue;
                }
                if let Some(mut rec) = record(tx, page.id)?
                    && rec.entity_id == entity
                    && rec.source_id == page.source_id
                {
                    rec.canonical = true;
                    put_json(tx, &row_key(page.id), &rec)?;
                }
            }
            let mut out = json!({ "upserted": input.upsert.len(), "removed": removed, "linked": linked, "unlinked": unlinked });
            if let Some((linked, unlinked, skipped)) = auto {
                out["auto"] = json!({ "linked": linked, "unlinked": unlinked, "skipped": skipped });
            }
            Ok(out)
        })
    }

    /// The automatic groups of one apply: removes those `unlink` names, those a decision now
    /// covers, writes the planned ones that still hold, then removes the broken ones. Returns
    /// (linked, unlinked, skipped) when the input carried a plan.
    fn apply_auto(
        &self,
        tx: &mut dyn KvWrite,
        plan: Option<&AutoPlan>,
        now: i64,
    ) -> Result<Option<(usize, usize, usize)>> {
        let (mut same, mut different): (Vec<Members>, Vec<Members>) = (Vec::new(), Vec::new());
        for (_, r) in all_reviews(tx)? {
            match r.verdict.as_str() {
                "same" => same.push(r.member_refs()),
                "different" => different.push(r.member_refs()),
                _ => {}
            }
        }
        let unlink = plan.map_or(&[][..], |p| p.unlink.as_slice());
        let mut unlinked = unlink_covered(tx, unlink, &same, &different)?;
        let (linked, skipped) = match plan {
            Some(p) if !p.link.is_empty() => link_planned(tx, &p.link, now)?,
            _ => (0, 0),
        };
        unlinked += unlink_broken(tx)?;
        Ok(plan.map(|_| (linked, unlinked, skipped)))
    }
}

fn group_has_canonical(read: &dyn KvRead, entity_id: &str) -> Result<bool> {
    for member in group_pages(read, entity_id)? {
        if record(read, member)?.is_some_and(|r| r.canonical) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A decision's `decided_at`: an ISO timestamp, or the text this store lists it as
/// (`timestamptz_text`, `2026-11-18 00:00:00.5+00`), which a caller that re-applies a listed
/// decision sends back, as Postgres accepts its own output.
fn decided_at_micros(text: &str) -> Option<i64> {
    if let Some(at) = parse_iso(text) {
        return Some(at);
    }
    // The listed text carries a zone (`+00`, or another offset such as `-01:30`); a time with none is refused.
    // The zone is looked for from byte 19 on as bytes, never as a `str` slice: byte 19 can fall inside a
    // non-ASCII character, and `+` and `-` are ASCII, so they never appear inside one.
    let t = text.trim();
    let zoned = t
        .as_bytes()
        .get(19..)
        .is_some_and(|rest| !rest.is_empty() && rest.iter().any(|b| matches!(b, b'+' | b'-')));
    if !zoned {
        return None;
    }
    crate::persistence::projection_queue::parse_timestamptz(t, "decided_at").ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revision_joins_rows_in_id_order() {
        let rec = |verdict: &str, entity: Option<&str>| ReviewRecord {
            verdict: verdict.into(),
            members: json!([]),
            group_id: None,
            entity_id: entity.map(str::to_string),
            canonical_source_id: None,
            canonical_slug: None,
            decided_by: "owner".into(),
            decided_at_us: 0,
            origin: "database".into(),
            home_source_id: None,
            git_blob: None,
            evidence: None,
        };
        let rows = vec![
            ("a".to_string(), rec("same", Some("e"))),
            ("b".to_string(), rec("different", None)),
        ];
        assert_eq!(revision(&rows), "a:same:e:database:,b:different::database:");
    }

    #[test]
    fn a_record_written_before_evidence_reads_none() {
        let old = json!({
            "verdict": "same", "members": [], "group_id": null, "entity_id": "e",
            "canonical_source_id": null, "canonical_slug": null, "decided_by": "owner",
            "decided_at_us": 0, "origin": "database", "home_source_id": null, "git_blob": null,
        });
        let rec: ReviewRecord = serde_json::from_value(old).unwrap();
        assert_eq!(rec.evidence, None);
    }

    #[test]
    fn decided_at_reads_the_listed_text_back() {
        let at = parse_iso("2026-11-18T00:00:00.500000Z").unwrap();
        assert_eq!(decided_at_micros("2026-11-18 00:00:00.5+00"), Some(at));
        assert_eq!(decided_at_micros("2026-11-18T00:00:00.500000Z"), Some(at));
        assert_eq!(
            decided_at_micros("2026-11-18 00:00:00+00"),
            parse_iso("2026-11-18T00:00:00.000000Z")
        );
        assert_eq!(decided_at_micros("2026-11-18 00:00:00"), None);
    }

    #[test]
    fn decided_at_refuses_non_ascii_text_without_panicking() {
        // Byte 19 falls inside a two- or three-byte character: the zone test must not slice there.
        for text in [
            "2026-11-18 00:00:0\u{e9}+00",
            "2026-11-18 00:00:00\u{e9}",
            "2026-11-18 00:00:\u{2160}+00",
            "\u{ff12}\u{ff10}\u{ff12}\u{ff16}-11-18 00:00:00+00",
            "2026-11-18 00:00:00+\u{ff10}0",
            "\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}",
        ] {
            assert_eq!(decided_at_micros(text), None, "{text:?}");
        }
    }

    #[test]
    fn jsonb_orders_shorter_keys_first() {
        let mut keys = vec!["emails".to_string(), "email".to_string(), "b".to_string()];
        keys.sort_by(jsonb_key_order);
        assert_eq!(keys, ["b", "email", "emails"]);
    }
}
