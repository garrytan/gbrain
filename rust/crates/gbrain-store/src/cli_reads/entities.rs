//! Entity and mention reads the CLI made through `executeRaw` (`src/core/engine-sql/entity-reads.ts`).
//!
//! The store keeps no mention-pass state (`mention_index_status`, `page_mention_state`): no source
//! has a pass time, and every live page is due, as on a PGLite brain where the pass never ran.
//! Frontmatter values are read as PostgreSQL's `->>` reads them (see [`arrow_text`]).

use crate::Store;
use crate::cli_reads::pg_text::pg_lower;
use crate::env::{iso, parse_iso};
use crate::error::{Result, StoreError};
use crate::facts::{PrivacyPolicy, like, page_hidden};
use crate::pages::{PageRecord, all_pages};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// The frontmatter keys whose values gbrain reads as privacy labels (`PRIVACY_LABEL_KEYS`).
const PRIVACY_LABEL_KEYS: &[&str] = &["access", "confidentiality"];
/// The frontmatter key that marks a quarantined page (`QUARANTINE_KEY`).
const QUARANTINE_KEY: &str = "quarantine";

/// `countPagesDueForMentions(q)`: only the scope matters, since every page is due.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionDueQuery {
    #[serde(default)]
    pub source_id: Option<String>,
}

/// `readIdentitySiblingCandidates(sourceId, q)`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiblingCandidateQuery {
    pub types: Vec<String>,
    pub subject: String,
    pub limit: u64,
    #[serde(default)]
    pub exclude_quarantined: bool,
    /// `excludePrivate`: the page policy (`facts/privacy.rs` `page_hidden`); null reads every page.
    #[serde(default)]
    pub exclude_private: Option<PrivacyPolicy>,
}

/// One sibling candidate: `identity` is the frontmatter value as `->>` reads it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SiblingCandidateRow {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub identity: Option<String>,
}

/// One retirement hop (`readRetirementHop`): the page, whether it is retired (`retiredPageSql`),
/// and its trimmed `superseded_by`, else `merged_into`, value as the redirect target.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RetirementHopRow {
    pub slug: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub retired: bool,
    pub target: Option<String>,
}

/// `readEntityCardRows` match: the name arm (`lower(title) = title_lc OR slug = ANY(slugs) OR slug
/// LIKE slug_like`) or the hydrate arm (`slug = ANY(slugs)`).
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum EntityCardMatch {
    Name {
        #[serde(rename = "titleLc")]
        title_lc: String,
        slugs: Vec<String>,
        #[serde(rename = "slugLike")]
        slug_like: String,
    },
    Slugs {
        slugs: Vec<String>,
    },
}

/// One entity-card candidate row (`readEntityCardRows`). `compiled_truth` is the bounded body
/// prefix, `left(coalesce(compiled_truth, truth_lead), 65536)`. `last_retrieved_at` is the page's
/// retrieval record (`page_ops/retrievals.rs`, written by bumpPageRetrievals), the `page_retrievals`
/// half of the SQL `GREATEST(...)`; the store keeps no legacy `pages.last_retrieved_at` column.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EntityCardRow {
    pub slug: String,
    pub source_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub frontmatter: Value,
    pub compiled_truth: Option<String>,
    pub updated_at: String,
    pub last_retrieved_at: Option<String>,
}

/// `left(coalesce(compiled_truth, truth_lead), BOUNDED_PREFIX_BYTES)`; `left()` counts code points.
const CARD_PREFIX_CHARS: usize = 64 * 1024;

/// `readIgnoredPrivacyLabelPages` scope: the run's own slugs, or pages updated since an ISO time.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum LabelScope {
    Slugs { slugs: Vec<String> },
    Since { since: String },
}

/// One labelled page: its type and frontmatter.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LabelPageRow {
    #[serde(rename = "type")]
    pub page_type: String,
    pub frontmatter: Map<String, Value>,
}

impl Store {
    /// `readMentionLastPass(sourceId?)`: the last mention pass time. The store records no pass, so
    /// it is always `None`.
    pub fn read_mention_last_pass(&self, _source_id: Option<&str>) -> Result<Option<String>> {
        Ok(None)
    }

    /// `countPagesDueForMentions(q)`: the live pages in the scope (every page when `source_id` is
    /// `None`), all of them due because no page has mention state.
    pub fn count_pages_due_for_mentions(&self, q: &MentionDueQuery) -> Result<u64> {
        let read = self.read()?;
        let n = all_pages(&*read)?
            .iter()
            .filter(|p| p.deleted_at_us.is_none())
            .filter(|p| q.source_id.as_deref().is_none_or(|s| p.source_id == s))
            .count();
        Ok(n as u64)
    }

    /// `readIdentitySiblingCandidates(sourceId, q)`: live pages of the source whose type is one of
    /// `types` and whose lowercased title is `subject` or ends in `": " + subject`, by slug, at most
    /// `limit`. `exclude_quarantined` leaves out pages whose frontmatter has a `quarantine` key, and
    /// `exclude_private` the pages the page policy hides.
    pub fn read_identity_sibling_candidates(
        &self,
        source_id: &str,
        q: &SiblingCandidateQuery,
    ) -> Result<Vec<SiblingCandidateRow>> {
        let read = self.read()?;
        let suffix = format!(": {}", q.subject);
        let mut rows = Vec::new();
        for p in all_pages(&*read)? {
            let title = p.title.to_lowercase();
            if p.source_id != source_id
                || p.deleted_at_us.is_some()
                || !q.types.contains(&p.page_type)
                || (q.exclude_quarantined && p.frontmatter.contains_key(QUARANTINE_KEY))
                || !(title == q.subject || title.ends_with(&suffix))
            {
                continue;
            }
            if let Some(policy) = &q.exclude_private
                && page_hidden(&*read, &p, policy)?
            {
                continue;
            }
            rows.push(SiblingCandidateRow {
                identity: p.frontmatter.get("identity").and_then(arrow_text),
                slug: p.slug,
                title: p.title,
                page_type: p.page_type,
            });
        }
        rows.sort_by(|a, b| a.slug.cmp(&b.slug));
        rows.truncate(usize::try_from(q.limit).unwrap_or(usize::MAX));
        Ok(rows)
    }

    /// `findExactSlug(sourceId, slugs, { retired })`: the first of `slugs` at which a live page
    /// sits and is (`Some(true)`), is not (`Some(false)`) or is either (`None`) a retired page
    /// (`retiredPageSql`); `None` otherwise.
    pub fn find_exact_slug(
        &self,
        source_id: &str,
        slugs: &[String],
        retired: Option<bool>,
    ) -> Result<Option<String>> {
        let read = self.read()?;
        for slug in slugs {
            let page = crate::pages::read_page(&*read, source_id, slug)?;
            if let Some(p) = page.filter(|p| {
                p.deleted_at_us.is_none() && retired.is_none_or(|want| is_retired(p) == want)
            }) {
                return Ok(Some(p.slug));
            }
        }
        Ok(None)
    }

    /// `findExactBasenameCandidates(sourceId, slugs)`: at most two of `slugs` at which a live page
    /// sits, in slug byte order. Postgres reads them with `LIMIT 2` and no `ORDER BY`, so when more
    /// than two match, the two it returns can differ from these.
    pub fn find_exact_basename_candidates(
        &self,
        source_id: &str,
        slugs: &[String],
    ) -> Result<Vec<String>> {
        let wanted: BTreeSet<&String> = slugs.iter().collect();
        let read = self.read()?;
        let mut found = Vec::new();
        for slug in wanted {
            let page = crate::pages::read_page(&*read, source_id, slug)?;
            if let Some(p) = page.filter(|p| p.deleted_at_us.is_none()) {
                found.push(p.slug);
                if found.len() == 2 {
                    break;
                }
            }
        }
        Ok(found)
    }

    /// `readRetirementHop(sourceId, slug, privacy)`: the live page at `slug` in the source with its
    /// retirement and redirect target, or `None` when no live page sits there or `policy` hides it
    /// (`page_hidden`). `None` policy reads every page.
    pub fn read_retirement_hop(
        &self,
        source_id: &str,
        slug: &str,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Option<RetirementHopRow>> {
        let read = self.read()?;
        let Some(p) =
            crate::pages::read_page(&*read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none())
        else {
            return Ok(None);
        };
        if let Some(policy) = policy
            && page_hidden(&*read, &p, policy)?
        {
            return Ok(None);
        }
        // `NULLIF(btrim(x), '')`: btrim trims spaces only.
        let target = |key: &str| {
            p.frontmatter
                .get(key)
                .and_then(arrow_text)
                .map(|v| v.trim_matches(' ').to_string())
                .filter(|v| !v.is_empty())
        };
        Ok(Some(RetirementHopRow {
            retired: is_retired(&p),
            target: target("superseded_by").or_else(|| target("merged_into")),
            slug: p.slug.clone(),
            page_type: p.page_type.clone(),
        }))
    }

    /// `readEntityCardRows(sourceId, match, policy)`: the live pages of the source the match names,
    /// with the bounded body prefix, that the page policy (when given) does not hide. No order.
    pub fn read_entity_card_rows(
        &self,
        source_id: &str,
        matcher: &EntityCardMatch,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<EntityCardRow>> {
        let read = self.read()?;
        let mut out = Vec::new();
        for p in all_pages(&*read)? {
            if p.source_id != source_id || p.deleted_at_us.is_some() {
                continue;
            }
            let hit = match matcher {
                EntityCardMatch::Name {
                    title_lc,
                    slugs,
                    slug_like,
                } => {
                    pg_lower(&p.title) == *title_lc
                        || slugs.contains(&p.slug)
                        || like(&p.slug, slug_like, false)?
                }
                EntityCardMatch::Slugs { slugs } => slugs.contains(&p.slug),
            };
            if !hit {
                continue;
            }
            if let Some(policy) = policy
                && page_hidden(&*read, &p, policy)?
            {
                continue;
            }
            let body = match p.compiled_truth.as_deref() {
                Some(text) => Some(text.to_string()),
                None => crate::page_body::truth_lead(&*read, p.id)?,
            };
            out.push(EntityCardRow {
                compiled_truth: body.map(|b| {
                    b.char_indices()
                        .nth(CARD_PREFIX_CHARS)
                        .map_or(b.clone(), |(at, _)| b[..at].to_string())
                }),
                updated_at: iso(p.updated_at_us),
                last_retrieved_at: crate::page_ops::retrievals::last_retrieved_us(&*read, p.id)?
                    .map(iso),
                frontmatter: Value::Object(p.frontmatter.clone()),
                slug: p.slug,
                source_id: p.source_id,
                title: p.title,
                page_type: p.page_type,
            });
        }
        Ok(out)
    }

    /// `readIgnoredPrivacyLabelPages(sourceId, scope)`: the live pages of the source in the scope
    /// that carry a privacy label key and no `readable_by`. The caller applies the label rule
    /// (`ignoredPrivacyLabels`) and the limit.
    pub fn read_ignored_privacy_label_pages(
        &self,
        source_id: &str,
        scope: &LabelScope,
    ) -> Result<Vec<LabelPageRow>> {
        let in_scope: Box<dyn Fn(&PageRecord) -> bool> = match scope {
            LabelScope::Slugs { slugs } => {
                let set: BTreeSet<String> = slugs.iter().cloned().collect();
                Box::new(move |p| set.contains(&p.slug))
            }
            LabelScope::Since { since } => {
                let since_us = parse_iso(since).ok_or_else(|| {
                    StoreError::invalid(format!(
                        "invalid input syntax for type timestamp with time zone: \"{since}\""
                    ))
                })?;
                Box::new(move |p| p.updated_at_us >= since_us)
            }
        };
        let read = self.read()?;
        Ok(all_pages(&*read)?
            .into_iter()
            .filter(|p| p.source_id == source_id && p.deleted_at_us.is_none() && in_scope(p))
            .filter(|p| !p.frontmatter.contains_key("readable_by"))
            .filter(|p| {
                PRIVACY_LABEL_KEYS
                    .iter()
                    .any(|k| p.frontmatter.contains_key(*k))
            })
            .map(|p| LabelPageRow {
                page_type: p.page_type,
                frontmatter: p.frontmatter,
            })
            .collect())
    }
}

/// `retiredPageSql`: `canonical` is false or no, `superseded_by` or `merged_into` names a page, or
/// `status` contains the word alias, redirect or redirected.
pub(crate) fn is_retired(p: &PageRecord) -> bool {
    let text = |key: &str| {
        p.frontmatter
            .get(key)
            .and_then(arrow_text)
            .unwrap_or_default()
    };
    let canonical = text("canonical").to_lowercase();
    canonical == "false"
        || canonical == "no"
        || !text("superseded_by").trim_matches(' ').is_empty()
        || !text("merged_into").trim_matches(' ').is_empty()
        || has_retired_status_word(&text("status").to_lowercase())
}

/// The regex `(^|[^a-z])(alias|redirect|redirected)([^a-z]|$)` on lowercased text.
fn has_retired_status_word(status: &str) -> bool {
    let bytes = status.as_bytes();
    let not_letter = |i: Option<&u8>| i.is_none_or(|b| !b.is_ascii_lowercase());
    ["alias", "redirect", "redirected"].iter().any(|word| {
        status.match_indices(word).any(|(at, _)| {
            let before = if at == 0 { None } else { bytes.get(at - 1) };
            not_letter(before) && not_letter(bytes.get(at + word.len()))
        })
    })
}

/// A frontmatter value as PostgreSQL's `->>` returns it: a string as is, JSON null as SQL NULL,
/// and anything else as its jsonb text.
pub(crate) fn arrow_text(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(jsonb_text(other)),
    }
}

/// The jsonb output form: `", "` and `": "` separators, object keys shorter first, then by bytes.
fn jsonb_text(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            format!(
                "[{}]",
                items.iter().map(jsonb_text).collect::<Vec<_>>().join(", ")
            )
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| {
                a.len()
                    .cmp(&b.len())
                    .then_with(|| a.as_bytes().cmp(b.as_bytes()))
            });
            let fields = keys
                .iter()
                .map(|k| format!("{}: {}", Value::String((*k).clone()), jsonb_text(&map[*k])));
            format!("{{{}}}", fields.collect::<Vec<_>>().join(", "))
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_words_need_word_boundaries() {
        assert!(has_retired_status_word("alias"));
        assert!(has_retired_status_word("old-redirect"));
        assert!(has_retired_status_word("redirected to x"));
        assert!(has_retired_status_word("an alias2"));
        assert!(!has_retired_status_word("aliases"));
        assert!(!has_retired_status_word("redirector"));
        assert!(!has_retired_status_word("active"));
    }

    #[test]
    fn arrow_text_reads_as_postgres() {
        assert_eq!(arrow_text(&json!(null)), None);
        assert_eq!(arrow_text(&json!("x")).as_deref(), Some("x"));
        assert_eq!(arrow_text(&json!(false)).as_deref(), Some("false"));
        assert_eq!(arrow_text(&json!(12)).as_deref(), Some("12"));
        assert_eq!(
            arrow_text(&json!({"bb": [1, "a"], "a": null})).as_deref(),
            Some(r#"{"a": null, "bb": [1, "a"]}"#)
        );
    }
}
