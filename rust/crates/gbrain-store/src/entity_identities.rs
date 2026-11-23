//! Entity identity groups: the `entity_identities` table of the PGLite engine (migration v137),
//! which groups member pages of different sources under one opaque `entity_id`
//! (`engine-sql/entity-identities.ts`, callers in `entity-identity.ts` and
//! `google/counterparty.ts`).
//!
//! Members: linkEntityIdentityRow, unlinkEntityIdentityRow, listEntityIdentityRows,
//! readEntityIdentityIdsForPages, readCanonicalTwin.
//!
//! Keys (every record starts with `keys::ENTITY_IDENTITY`, `i`):
//! - `i 0x01 <page id u64 BE>` -> [`IdentityRecord`] (JSON): the page's one membership. The
//!   table's unique key is `(source_id, page_id)`, and a page has one source, so the page id
//!   alone keys it.
//! - `i 0x02 entity_id \0 <page id u64 BE>` -> empty: the group index, one key per member.
//!
//! A group has at most one canonical member (the partial unique index on `entity_id WHERE
//! canonical`). A canonical link demotes the group's canonical member and writes the new one in
//! one `Store::write`, as the SQL runs the demote and the upsert in one transaction. The demote
//! scans the group's index keys rather than keeping a separate canonical key: groups are small
//! (manual links only), and one copy of the flag cannot disagree with itself.
//!
//! The record is keyed by page id, so a rename keeps it. A hard page delete drops it
//! (`remove_page_rows`, the `ON DELETE CASCADE` of `page_id`); a soft delete keeps it, and the
//! reads skip a soft-deleted member until it is restored. A source delete removes its pages
//! first, so no source hook is needed.
//!
//! Each read sorts in byte order, as PGLite's `C` collation does; a Postgres brain with a locale
//! collation can order punctuation and case differently (TODOS.md).

use crate::alias_fanout_reads::reject_nul;
use crate::env::iso;
use crate::error::Result;
use crate::facts::{PrivacyPolicy, page_hidden};
use crate::kv::{KvRead, KvWrite, scan_prefix};
use crate::pages::{PageRecord, read_page, read_page_by_id};
use crate::{Store, get_json, keys, put_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashSet};

const ROW: u8 = 0x01;
const GROUP: u8 = 0x02;

/// `confidence DOUBLE PRECISION` as Postgres keeps it: every f64, NaN and ±Infinity included. A finite value is a
/// JSON number (serde_json round-trips it exactly); NaN, Infinity and -Infinity, which JSON has no number for, are
/// the text Postgres prints for them. A record an older store wrote for a non-finite value holds JSON null (the value
/// is gone); it reads as NaN, so no stored row can break a listing.
mod float8 {
    use serde::{Deserialize, Deserializer, Serializer};
    use serde_json::Value;

    pub(super) fn text(v: f64) -> &'static str {
        if v.is_nan() {
            "NaN"
        } else if v > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
    }

    pub(super) fn to_json(v: f64) -> Value {
        if v.is_finite() {
            Value::from(v)
        } else {
            Value::from(text(v))
        }
    }

    pub(super) fn serialize<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
        if v.is_finite() {
            s.serialize_f64(*v)
        } else {
            s.serialize_str(text(*v))
        }
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Stored {
            Number(f64),
            Text(String),
            Null(()),
        }
        match Stored::deserialize(d)? {
            Stored::Number(v) => Ok(v),
            Stored::Text(t) => match t.as_str() {
                "NaN" => Ok(f64::NAN),
                "Infinity" => Ok(f64::INFINITY),
                "-Infinity" => Ok(f64::NEG_INFINITY),
                _ => Err(serde::de::Error::custom(format!(
                    "invalid input syntax for type double precision: \"{t}\""
                ))),
            },
            Stored::Null(()) => Ok(f64::NAN),
        }
    }
}

/// One page's membership: the table's columns less `id` and `page_id` (the key).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct IdentityRecord {
    pub(crate) entity_id: String,
    pub(crate) source_id: String,
    #[serde(with = "float8")]
    pub(crate) confidence: f64,
    pub(crate) established_by: String,
    pub(crate) established_at_us: i64,
    pub(crate) canonical: bool,
}

/// `linkEntityIdentityRow(input)`. `canonical`: true makes the page the group's canonical member,
/// false clears it, null keeps it when the page stays in the same group.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityLink {
    pub entity_id: String,
    pub slug: String,
    pub source_id: String,
    /// A JSON number, or `NaN`, `Infinity` or `-Infinity` as text (the shell sends a non-finite value that way).
    #[serde(with = "float8")]
    pub confidence: f64,
    pub established_by: String,
    pub canonical: Option<bool>,
}

/// `listEntityIdentityRows(filter)` after the shell dropped the empty filters (an empty text or
/// source list filters nothing, as the TypeScript `if` does).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct IdentityFilter {
    pub entity_id: Option<String>,
    pub slug: Option<String>,
    pub slug_source_id: Option<String>,
    pub allowed_sources: Option<Vec<String>>,
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`) for member and seed
    /// pages; null reads every page.
    pub exclude_private: Option<PrivacyPolicy>,
}

pub(crate) fn row_key(page_id: u64) -> Vec<u8> {
    let mut key = vec![keys::ENTITY_IDENTITY, ROW];
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

/// `i 0x02 entity_id \0`: the scan prefix of one group.
fn group_prefix(entity_id: &str) -> Vec<u8> {
    let mut key = vec![keys::ENTITY_IDENTITY, GROUP];
    key.extend_from_slice(entity_id.as_bytes());
    key.push(0);
    key
}

pub(crate) fn group_key(entity_id: &str, page_id: u64) -> Vec<u8> {
    let mut key = group_prefix(entity_id);
    key.extend_from_slice(&page_id.to_be_bytes());
    key
}

pub(crate) fn record(read: &dyn KvRead, page_id: u64) -> Result<Option<IdentityRecord>> {
    get_json(read, &row_key(page_id))
}

/// The page ids of one group, in page id order.
pub(crate) fn group_pages(read: &dyn KvRead, entity_id: &str) -> Result<Vec<u64>> {
    let prefix = group_prefix(entity_id);
    let mut out = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, _| {
        if let Ok(id) = <[u8; 8]>::try_from(&k[prefix.len()..]) {
            out.push(u64::from_be_bytes(id));
        }
        true
    })?;
    Ok(out)
}

/// Every membership, in page id order.
pub(crate) fn all_records(read: &dyn KvRead) -> Result<Vec<(u64, IdentityRecord)>> {
    let prefix = [keys::ENTITY_IDENTITY, ROW];
    let mut raw = Vec::new();
    scan_prefix(read, &prefix, false, &mut |k, v| {
        if let Ok(id) = <[u8; 8]>::try_from(&k[prefix.len()..]) {
            raw.push((u64::from_be_bytes(id), v.to_vec()));
        }
        true
    })?;
    raw.into_iter()
        .map(|(id, v)| Ok((id, serde_json::from_slice(&v)?)))
        .collect()
}

/// The live page with this id: the read joins `pages` with `deleted_at IS NULL`.
fn live_page(read: &dyn KvRead, page_id: u64) -> Result<Option<PageRecord>> {
    Ok(read_page_by_id(read, page_id)?.filter(|p| p.deleted_at_us.is_none()))
}

fn visible(read: &dyn KvRead, page: &PageRecord, policy: Option<&PrivacyPolicy>) -> Result<bool> {
    match policy {
        Some(policy) => Ok(!page_hidden(read, page, policy)?),
        None => Ok(true),
    }
}

/// Deletes the membership of a page that is deleted for good (`cascade::remove_page_rows`).
pub(crate) fn remove_page_rows(tx: &mut dyn KvWrite, page: &PageRecord) -> Result<()> {
    if let Some(rec) = record(tx, page.id)? {
        tx.delete(&group_key(&rec.entity_id, page.id))?;
        tx.delete(&row_key(page.id))?;
    }
    Ok(())
}

impl Store {
    /// `linkEntityIdentityRow`: links the live page at `(source_id, slug)` into the group, moving
    /// it from any other group. False, with nothing written, when there is no live page there
    /// (the shell throws the identity page-not-found error).
    pub fn link_entity_identity(&self, input: &IdentityLink) -> Result<bool> {
        reject_nul(
            "linkEntityIdentityRow",
            [
                input.entity_id.as_str(),
                input.slug.as_str(),
                input.source_id.as_str(),
                input.established_by.as_str(),
            ],
        )?;
        self.write(|tx| {
            let Some(page) =
                read_page(tx, &input.source_id, &input.slug)?.filter(|p| p.deleted_at_us.is_none())
            else {
                return Ok(false);
            };
            if input.canonical == Some(true) {
                for member in group_pages(tx, &input.entity_id)? {
                    if let Some(mut rec) = record(tx, member)?
                        && rec.canonical
                    {
                        rec.canonical = false;
                        put_json(tx, &row_key(member), &rec)?;
                    }
                }
            }
            let existing = record(tx, page.id)?;
            let canonical = match input.canonical {
                Some(c) => c,
                None => existing
                    .as_ref()
                    .is_some_and(|e| e.canonical && e.entity_id == input.entity_id),
            };
            if let Some(old) = &existing
                && old.entity_id != input.entity_id
            {
                tx.delete(&group_key(&old.entity_id, page.id))?;
            }
            let rec = IdentityRecord {
                entity_id: input.entity_id.clone(),
                source_id: input.source_id.clone(),
                confidence: input.confidence,
                established_by: input.established_by.clone(),
                established_at_us: self.env.now_micros(),
                canonical,
            };
            put_json(tx, &row_key(page.id), &rec)?;
            tx.put(&group_key(&input.entity_id, page.id), &[])?;
            Ok(true)
        })
    }

    /// `unlinkEntityIdentityRow`: removes the page at `(source_id, slug)`, live or soft-deleted,
    /// from the group `entity_id`. True when a membership was removed.
    pub fn unlink_entity_identity(
        &self,
        entity_id: &str,
        slug: &str,
        source_id: &str,
    ) -> Result<bool> {
        reject_nul("unlinkEntityIdentityRow", [entity_id, slug, source_id])?;
        self.write(|tx| {
            let Some(page) = read_page(tx, source_id, slug)? else {
                return Ok(false);
            };
            match record(tx, page.id)? {
                Some(rec) if rec.entity_id == entity_id && rec.source_id == source_id => {
                    tx.delete(&group_key(entity_id, page.id))?;
                    tx.delete(&row_key(page.id))?;
                    Ok(true)
                }
                _ => Ok(false),
            }
        })
    }

    /// `listEntityIdentityRows`: the live members the filter keeps, as `{ entity_id, source_id,
    /// slug, title, confidence, established_by, established_at, canonical }`, by entity id,
    /// canonical first, source, then slug.
    pub fn list_entity_identities(&self, filter: &IdentityFilter) -> Result<Vec<Value>> {
        const MEMBER: &str = "listEntityIdentityRows";
        let texts = [&filter.entity_id, &filter.slug, &filter.slug_source_id];
        reject_nul(MEMBER, texts.iter().filter_map(|t| t.as_deref()))?;
        let allowed: Option<HashSet<&str>> = filter
            .allowed_sources
            .as_ref()
            .map(|s| s.iter().map(String::as_str).collect());
        if let Some(sources) = &filter.allowed_sources {
            reject_nul(MEMBER, sources.iter().map(String::as_str))?;
        }
        let policy = filter.exclude_private.as_ref();
        let read = self.read()?;
        let records = all_records(&*read)?;
        let seeds: Option<HashSet<String>> = match &filter.slug {
            None => None,
            Some(slug) => {
                let mut groups = HashSet::new();
                for (page_id, rec) in &records {
                    if filter
                        .slug_source_id
                        .as_ref()
                        .is_some_and(|s| *s != rec.source_id)
                        || allowed
                            .as_ref()
                            .is_some_and(|a| !a.contains(rec.source_id.as_str()))
                    {
                        continue;
                    }
                    let Some(page) = live_page(&*read, *page_id)? else {
                        continue;
                    };
                    if page.slug == *slug
                        && page.source_id == rec.source_id
                        && visible(&*read, &page, policy)?
                    {
                        groups.insert(rec.entity_id.clone());
                    }
                }
                Some(groups)
            }
        };
        let mut rows = Vec::new();
        for (page_id, rec) in records {
            if filter
                .entity_id
                .as_ref()
                .is_some_and(|e| *e != rec.entity_id)
                || seeds.as_ref().is_some_and(|g| !g.contains(&rec.entity_id))
                || allowed
                    .as_ref()
                    .is_some_and(|a| !a.contains(rec.source_id.as_str()))
            {
                continue;
            }
            let Some(page) = live_page(&*read, page_id)? else {
                continue;
            };
            if page.source_id != rec.source_id || !visible(&*read, &page, policy)? {
                continue;
            }
            rows.push((rec, page));
        }
        rows.sort_by(|(a, pa), (b, pb)| {
            (
                a.entity_id.as_bytes(),
                !a.canonical,
                a.source_id.as_bytes(),
                pa.slug.as_bytes(),
            )
                .cmp(&(
                    b.entity_id.as_bytes(),
                    !b.canonical,
                    b.source_id.as_bytes(),
                    pb.slug.as_bytes(),
                ))
        });
        Ok(rows
            .into_iter()
            .map(|(rec, page)| {
                json!({
                    "entity_id": rec.entity_id,
                    "source_id": rec.source_id,
                    "slug": page.slug,
                    "title": page.title,
                    "confidence": float8::to_json(rec.confidence),
                    "established_by": rec.established_by,
                    "established_at": iso(rec.established_at_us),
                    "canonical": rec.canonical,
                })
            })
            .collect())
    }

    /// `readEntityIdentityIdsForPages`: `{ entity_id, source_id, slug }` of each live member whose
    /// source is one of `source_ids` and whose slug is one of `slugs` (the cross product), by
    /// source then slug.
    pub fn read_entity_identity_ids_for_pages(
        &self,
        source_ids: &[String],
        slugs: &[String],
    ) -> Result<Vec<Value>> {
        const MEMBER: &str = "readEntityIdentityIdsForPages";
        reject_nul(MEMBER, source_ids.iter().chain(slugs).map(String::as_str))?;
        if source_ids.is_empty() || slugs.is_empty() {
            return Ok(Vec::new());
        }
        let sources: BTreeSet<&str> = source_ids.iter().map(String::as_str).collect();
        let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        let read = self.read()?;
        let mut hits = Vec::new();
        for (page_id, rec) in all_records(&*read)? {
            if !sources.contains(rec.source_id.as_str()) {
                continue;
            }
            let Some(page) = live_page(&*read, page_id)? else {
                continue;
            };
            if page.source_id == rec.source_id && wanted.contains(page.slug.as_str()) {
                hits.push((rec.source_id, page.slug, rec.entity_id));
            }
        }
        hits.sort();
        Ok(hits
            .into_iter()
            .map(|(source_id, slug, entity_id)| {
                json!({"entity_id": entity_id, "source_id": source_id, "slug": slug})
            })
            .collect())
    }

    /// `readCanonicalTwin`: `{ slug, source_id }` of the live canonical members in another source
    /// of the group of the live page at `(source_id, slug)`, at most two, by source then slug.
    pub fn read_canonical_twin(&self, source_id: &str, slug: &str) -> Result<Vec<Value>> {
        reject_nul("readCanonicalTwin", [source_id, slug])?;
        let read = self.read()?;
        let Some(page) = read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(Vec::new());
        };
        let Some(me) = record(&*read, page.id)?.filter(|r| r.source_id == source_id) else {
            return Ok(Vec::new());
        };
        let mut twins = Vec::new();
        for member in group_pages(&*read, &me.entity_id)? {
            let Some(rec) = record(&*read, member)? else {
                continue;
            };
            if !rec.canonical || rec.source_id == source_id {
                continue;
            }
            if let Some(twin) = live_page(&*read, member)? {
                twins.push((rec.source_id, twin.slug));
            }
        }
        twins.sort();
        Ok(twins
            .into_iter()
            .take(2)
            .map(|(source_id, slug)| json!({"slug": slug, "source_id": source_id}))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::IdentityRecord;
    use serde_json::json;

    /// A record an older store wrote for a non-finite confidence (JSON null) still decodes, as NaN.
    #[test]
    fn a_record_with_a_null_confidence_decodes_as_nan() {
        let rec: IdentityRecord = serde_json::from_value(json!({ "entity_id": "g", "source_id": "default",
            "confidence": null, "established_by": "manual", "established_at_us": 0, "canonical": false }))
        .unwrap();
        assert!(rec.confidence.is_nan());
        for (stored, want) in [
            (json!("Infinity"), f64::INFINITY),
            (json!("-Infinity"), f64::NEG_INFINITY),
            (json!(0.5), 0.5),
        ] {
            let rec: IdentityRecord = serde_json::from_value(json!({ "entity_id": "g", "source_id": "default",
                "confidence": stored, "established_by": "manual", "established_at_us": 0, "canonical": false }))
            .unwrap();
            assert_eq!(rec.confidence, want);
            let back = serde_json::to_value(&rec).unwrap();
            assert_eq!(
                serde_json::from_value::<IdentityRecord>(back)
                    .unwrap()
                    .confidence,
                want
            );
        }
    }

    /// Every write runs in `Store::write` (one transaction, the bound one inside `transaction`).
    #[test]
    fn writes_never_open_their_own_transaction() {
        let src = include_str!("entity_identities.rs");
        let needle = ["begin", "_write"].concat();
        assert!(!src.contains(&needle));
    }
}
