//! The company sweep's side of the identity decisions (GST-3127): the token forms the duplicate
//! finder's read narrows by (`listEntityKeyRows({ tokens })`), the page generation an automatic
//! group pins, and the `'dedupe:auto'` identity rows `applyIdentityDecisions({ auto })` writes and
//! removes (`engine-sql/entity-keys.ts`, `engine-sql/identity-decisions.ts`, caller
//! `entities/company-auto-link.ts`).
//!
//! Generation: the store keeps no per-page `pages.generation` counter. A page's generation here is
//! the first 13 hex digits of its `knowledge_revision` (a UUID the store renews when the fields
//! the generation trigger watches change), so it stays equal while the page is unchanged and
//! differs after a change. It is an equality token only: unlike Postgres, it does not grow.

use crate::entity_identities::{
    IdentityRecord, all_records, group_key, group_pages, record, row_key,
};
use crate::error::Result;
use crate::kv::{KvRead, KvWrite};
use crate::pages::{PageRecord, read_page_by_id};
use crate::put_json;
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub(crate) const AUTO: &str = "dedupe:auto";

/// `tokens` of `listEntityKeyRows`: pages one of whose `fields` values reads as one of `values`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyTokens {
    pub values: Vec<String>,
    pub fields: Vec<String>,
}

/// One planned automatic group of `applyIdentityDecisions({ auto: { link } })`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutoLinkGroup {
    pub entity_id: String,
    #[serde(deserialize_with = "whole_number")]
    pub canonical_page_id: i64,
    pub members: Vec<AutoLinkMember>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutoLinkMember {
    pub source_id: String,
    #[serde(deserialize_with = "whole_number")]
    pub page_id: i64,
    #[serde(deserialize_with = "whole_number")]
    pub generation: i64,
}

/// A page id or generation: a JavaScript number arrives as a float when it is large, so a whole
/// float within the safe integer range reads as that integer.
fn whole_number<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<i64, D::Error> {
    let v = Value::deserialize(d)?;
    if let Some(n) = v.as_i64() {
        return Ok(n);
    }
    match v.as_f64() {
        Some(f) if f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0 => Ok(f as i64),
        _ => Err(serde::de::Error::custom(format!(
            "expected a whole number, found {v}"
        ))),
    }
}

/// `applyIdentityDecisions({ auto })`: groups to write, and automatic groups to remove first.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AutoPlan {
    pub link: Vec<AutoLinkGroup>,
    pub unlink: Vec<String>,
}

/// The page's generation token (module doc, "Generation").
pub(crate) fn generation(page: &PageRecord) -> i64 {
    let hex: String = page
        .knowledge_revision
        .chars()
        .filter(char::is_ascii_hexdigit)
        .take(13)
        .collect();
    i64::from_str_radix(&hex, 16).unwrap_or(0)
}

/// The texts one frontmatter value reads as (`jsonb_array_elements_text` over an array, the
/// string, or a number's text); nulls and other kinds read as nothing.
fn value_texts(v: &Value) -> Vec<String> {
    let one = |v: &Value| match v {
        Value::String(s) => Some(s.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    };
    match v {
        Value::Array(items) => items.iter().filter_map(one).collect(),
        Value::String(s) => vec![s.clone()],
        Value::Number(n) => vec![n.to_string()],
        _ => Vec::new(),
    }
}

/// The text before the first of `stops`.
fn cut(text: &str, stops: &[char]) -> String {
    text.split(|c| stops.contains(&c))
        .next()
        .unwrap_or("")
        .to_string()
}

/// `regexp_replace(raw, '^[a-z][a-z0-9+.-]*://(www[.])?', '')`.
fn strip_scheme(raw: &str) -> &str {
    let bytes = raw.as_bytes();
    if !bytes.first().is_some_and(u8::is_ascii_lowercase) {
        return raw;
    }
    let mut i = 1;
    while i < bytes.len()
        && (bytes[i].is_ascii_lowercase()
            || bytes[i].is_ascii_digit()
            || matches!(bytes[i], b'+' | b'.' | b'-'))
    {
        i += 1;
    }
    let Some(rest) = raw[i..].strip_prefix("://") else {
        return raw;
    };
    rest.strip_prefix("www.").unwrap_or(rest)
}

/// The text after the first `marker` in `text`, cut at `/ ? #` and a space; none without it.
fn after(text: &str, marker: &str) -> Option<String> {
    let at = text.find(marker)?;
    Some(cut(&text[at + marker.len()..], &['/', '?', '#', ' ']))
}

/// Every form one value reads as: the lowered, space-trimmed value, without leading `@`, its
/// host, the name after `/company/`, `/in/` or `/pub/`, and the login after `github.com/`.
pub(crate) fn token_forms(value: &str) -> Vec<String> {
    let raw = value.trim_matches(' ').to_lowercase();
    let slashed = format!("/{raw}");
    let mut forms = vec![
        raw.clone(),
        raw.trim_start_matches('@').to_string(),
        cut(strip_scheme(&raw), &['/', '?', '#', ':']),
    ];
    forms.extend(after(&slashed, "/company/"));
    forms.extend(after(&slashed, "/in/"));
    forms.extend(after(&slashed, "/pub/"));
    forms.extend(after(&raw, "github.com/"));
    forms
}

/// True when one of the page's `fields` values reads as one of the tokens.
pub(crate) fn page_matches_tokens(page: &PageRecord, tokens: &KeyTokens) -> bool {
    let wanted: HashSet<&str> = tokens.values.iter().map(String::as_str).collect();
    tokens.fields.iter().any(|field| {
        page.frontmatter.get(field).is_some_and(|v| {
            value_texts(v).iter().any(|text| {
                token_forms(text)
                    .iter()
                    .any(|f| wanted.contains(f.as_str()))
            })
        })
    })
}

/// The `'dedupe:auto'` rows by entity: (page id, record).
fn auto_groups(read: &dyn KvRead) -> Result<BTreeMap<String, Vec<(u64, IdentityRecord)>>> {
    let mut out: BTreeMap<String, Vec<(u64, IdentityRecord)>> = BTreeMap::new();
    for (page_id, rec) in all_records(read)? {
        if rec.established_by == AUTO {
            out.entry(rec.entity_id.clone())
                .or_default()
                .push((page_id, rec));
        }
    }
    Ok(out)
}

/// Deletes every `'dedupe:auto'` row of the entities; the number of entities that lost a row.
fn drop_auto(tx: &mut dyn KvWrite, entities: &BTreeSet<String>) -> Result<usize> {
    let mut gone = 0;
    for (entity, rows) in auto_groups(tx)? {
        if !entities.contains(&entity) {
            continue;
        }
        for (page_id, _) in &rows {
            tx.delete(&group_key(&entity, *page_id))?;
            tx.delete(&row_key(*page_id))?;
        }
        gone += 1;
    }
    Ok(gone)
}

/// A decision's members as `(source_id, slug)`.
pub(crate) type Members = Vec<(Option<String>, Option<String>)>;

fn names(members: &Members, page: &PageRecord) -> bool {
    members.iter().any(|(s, g)| {
        s.as_deref() == Some(page.source_id.as_str()) && g.as_deref() == Some(page.slug.as_str())
    })
}

/// The pages of the ids that still exist, soft-deleted ones included (`JOIN pages p ON p.id = ...`).
fn pages_of(read: &dyn KvRead, ids: impl IntoIterator<Item = u64>) -> Result<Vec<PageRecord>> {
    let mut out = Vec::new();
    for id in ids {
        out.extend(read_page_by_id(read, id)?);
    }
    Ok(out)
}

/// The automatic groups a "same" decision covers, or that hold two members of one "different" decision.
fn covered_groups(
    read: &dyn KvRead,
    same: &[Members],
    different: &[Members],
) -> Result<BTreeSet<String>> {
    let mut covered = BTreeSet::new();
    for (entity, rows) in auto_groups(read)? {
        let auto_pages = pages_of(read, rows.iter().map(|(id, _)| *id))?;
        if auto_pages.iter().any(|p| same.iter().any(|m| names(m, p))) {
            covered.insert(entity);
            continue;
        }
        let all_pages = pages_of(read, group_pages(read, &entity)?)?;
        let split = auto_pages.iter().any(|a| {
            all_pages
                .iter()
                .any(|b| b.id != a.id && different.iter().any(|m| names(m, a) && names(m, b)))
        });
        if split {
            covered.insert(entity);
        }
    }
    Ok(covered)
}

/// Removes the automatic groups `unlink` names; then those a "same" decision covers (a member's
/// confirm takes over) or that hold two members of one "different" decision. Returns the number of
/// entities removed.
pub(crate) fn unlink_covered(
    tx: &mut dyn KvWrite,
    unlink: &[String],
    same: &[Members],
    different: &[Members],
) -> Result<usize> {
    let named: BTreeSet<String> = unlink.iter().cloned().collect();
    let mut removed = if named.is_empty() {
        0
    } else {
        drop_auto(tx, &named)?
    };
    let covered = covered_groups(tx, same, different)?;
    removed += drop_auto(tx, &covered)?;
    Ok(removed)
}

/// Writes each planned group whose members all still exist live, in their source, at the
/// generation the sweep read, and sit in no other group. Returns (linked, skipped).
pub(crate) fn link_planned(
    tx: &mut dyn KvWrite,
    plan: &[AutoLinkGroup],
    now: i64,
) -> Result<(usize, usize)> {
    let mut by_entity: BTreeMap<&str, Vec<(&AutoLinkMember, i64)>> = BTreeMap::new();
    for g in plan {
        let rows = by_entity.entry(g.entity_id.as_str()).or_default();
        rows.extend(g.members.iter().map(|m| (m, g.canonical_page_id)));
    }
    let planned = by_entity.len();
    let mut ok = Vec::new();
    for (entity, members) in &by_entity {
        let mut fine = true;
        for (m, _) in members {
            let page = u64::try_from(m.page_id)
                .ok()
                .map(|id| read_page_by_id(tx, id))
                .transpose()?
                .flatten();
            let live = page.is_some_and(|p| {
                p.source_id == m.source_id
                    && p.deleted_at_us.is_none()
                    && generation(&p) == m.generation
            });
            let elsewhere = match u64::try_from(m.page_id) {
                Ok(id) => record(tx, id)?
                    .is_some_and(|x| x.source_id == m.source_id && x.entity_id != *entity),
                Err(_) => false,
            };
            if !live || elsewhere {
                fine = false;
                break;
            }
        }
        if fine {
            ok.push(*entity);
        }
    }
    let mut linked = 0;
    for entity in &ok {
        let mut wrote = false;
        for (m, canonical_page_id) in &by_entity[entity] {
            let id = u64::try_from(m.page_id).unwrap_or_default();
            if record(tx, id)?.is_some() {
                continue;
            }
            let rec = IdentityRecord {
                entity_id: entity.to_string(),
                source_id: m.source_id.clone(),
                confidence: 1.0,
                established_by: AUTO.to_string(),
                established_at_us: now,
                canonical: m.page_id == *canonical_page_id,
            };
            put_json(tx, &row_key(id), &rec)?;
            tx.put(&group_key(entity, id), &[])?;
            wrote = true;
        }
        if wrote {
            linked += 1;
        }
    }
    Ok((linked, planned - ok.len()))
}

/// Removes the automatic groups left with fewer than two rows, no canonical row, or a member whose
/// page is gone or deleted. Returns the number of entities removed.
pub(crate) fn unlink_broken(tx: &mut dyn KvWrite) -> Result<usize> {
    let mut broken = BTreeSet::new();
    for (entity, rows) in auto_groups(tx)? {
        let mut bad = rows.len() < 2 || !rows.iter().any(|(_, r)| r.canonical);
        for (id, _) in &rows {
            if !read_page_by_id(tx, *id)?.is_some_and(|p| p.deleted_at_us.is_none()) {
                bad = true;
            }
        }
        if bad {
            broken.insert(entity);
        }
    }
    drop_auto(tx, &broken)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_forms_read_hosts_profiles_and_logins() {
        let forms = |v: &str| token_forms(v);
        assert!(
            forms(" HTTPS://www.Acme-Example.com/about?x=1 ")
                .contains(&"acme-example.com".to_string())
        );
        assert!(
            forms("https://www.linkedin.com/company/widget-co/").contains(&"widget-co".to_string())
        );
        assert!(
            forms("linkedin.com/in/alice-example?trk=1").contains(&"alice-example".to_string())
        );
        assert!(forms("https://github.com/a-founder/repo").contains(&"a-founder".to_string()));
        assert!(forms("@handle").contains(&"handle".to_string()));
        assert!(forms("acme.io:8080/x").contains(&"acme.io".to_string()));
        // No marker, no form: a plain name reads only as itself, its @-less self and its "host".
        assert_eq!(forms("acme"), vec!["acme", "acme", "acme"]);
    }

    #[test]
    fn strip_scheme_needs_a_scheme_and_drops_one_www() {
        assert_eq!(strip_scheme("https://www.a.com"), "a.com");
        assert_eq!(strip_scheme("git+ssh://a.com"), "a.com");
        assert_eq!(strip_scheme("www.a.com"), "www.a.com");
        assert_eq!(strip_scheme("1http://a.com"), "1http://a.com");
    }

    #[test]
    fn value_texts_read_arrays_strings_and_numbers() {
        assert_eq!(
            value_texts(&serde_json::json!(["a", 2, null])),
            vec!["a", "2"]
        );
        assert_eq!(value_texts(&serde_json::json!("a")), vec!["a"]);
        assert_eq!(value_texts(&serde_json::json!(7)), vec!["7"]);
        assert!(value_texts(&serde_json::json!({ "a": 1 })).is_empty());
        assert!(value_texts(&serde_json::json!(true)).is_empty());
    }
}
