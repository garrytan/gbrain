//! The retrieval reflex's page reads and the proactive brief's entity-page read, which the CLI made
//! through `executeRaw` (`src/core/engine-sql/reflex-reads.ts`, docs/designs/RUST_REFLEX_READS.md).
//!
//! Each read filters on exactly the given sources (an empty list reads nothing, as `= ANY('{}')`
//! does) and on live pages, then applies the page policy when one is given. `lower()` is
//! [`pg_lower`] and `LIKE` is [`like`] with the `\` escape, as the entity card reads them.
use crate::Store;
use crate::cli_reads::entities::bounded_body_prefix;
use crate::cli_reads::pg_text::pg_lower;
use crate::error::Result;
use crate::facts::{PrivacyPolicy, like, page_hidden};
use crate::kv::KvRead;
use crate::pages::{PageRecord, all_pages};
use crate::trust::{TrustPolicy, TrustTier};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Which live pages `readReflexPages` returns (`ReflexPageMatch`).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ReflexPageMatch {
    /// `lower(title)` in `titlesLc`, a slug in `exactSlugs`, a slug LIKE one of `slugSuffixes`,
    /// or (with `surnamePatterns`) a person page whose `lower(title)` is LIKE one of them. By id.
    #[serde(rename_all = "camelCase")]
    Names {
        titles_lc: Vec<String>,
        exact_slugs: Vec<String>,
        slug_suffixes: Vec<String>,
        #[serde(default)]
        surname_patterns: Vec<String>,
    },
    /// A slug in `slugs`.
    Slugs { slugs: Vec<String> },
    /// `lower(title)` or the slug in `norms`.
    CjkExact { norms: Vec<String> },
    /// `lower(title)` in `titlesLc`.
    #[serde(rename_all = "camelCase")]
    Titles { titles_lc: Vec<String> },
}

/// One `readReflexLiveKeys` row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReflexLiveKey {
    pub slug: String,
    pub source_id: String,
}

/// One `readReflexPages` row: the page with its bounded body prefix as `compiled_truth`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReflexPageRow {
    pub slug: String,
    pub source_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub frontmatter: Value,
    pub compiled_truth: Option<String>,
}

/// One `readBriefEntityPages` row.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BriefEntityPageRow {
    pub slug: String,
    pub title: String,
    #[serde(rename = "type")]
    pub page_type: String,
}

/// `readBriefEntityPages` eligibility: `pageEligibleSql`'s trust floor and flagged-page filter.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct BriefEligibility {
    pub min_trust: Option<String>,
    pub suppress_flagged: bool,
}

/// The live pages of `source_ids` that the policy (when given) does not hide, in store scan order.
fn live_pages_in(
    read: &dyn KvRead,
    source_ids: &[String],
    policy: Option<&PrivacyPolicy>,
    mut wanted: impl FnMut(&PageRecord) -> Result<bool>,
) -> Result<Vec<PageRecord>> {
    let mut out = Vec::new();
    for p in all_pages(read)? {
        if p.deleted_at_us.is_some() || !source_ids.contains(&p.source_id) || !wanted(&p)? {
            continue;
        }
        if let Some(policy) = policy
            && page_hidden(read, &p, policy)?
        {
            continue;
        }
        out.push(p);
    }
    Ok(out)
}

/// Whether `text` is LIKE any of `patterns` (`LIKE ANY(array)`, case-sensitive).
fn like_any(text: &str, patterns: &[String]) -> Result<bool> {
    for pattern in patterns {
        if like(text, pattern, false)? {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Store {
    /// `readReflexLiveKeys(scope, slugs)`: the live pages of the sources at `slugs` that the policy
    /// (when given) does not hide, as (slug, source_id), in store scan order (the SQL sets none).
    pub fn read_reflex_live_keys(
        &self,
        source_ids: &[String],
        slugs: &[String],
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<ReflexLiveKey>> {
        let read = self.read()?;
        Ok(
            live_pages_in(&*read, source_ids, policy, |p| Ok(slugs.contains(&p.slug)))?
                .into_iter()
                .map(|p| ReflexLiveKey {
                    slug: p.slug,
                    source_id: p.source_id,
                })
                .collect(),
        )
    }

    /// `readReflexPages(scope, match)`: the live pages of the sources the match names that the
    /// policy (when given) does not hide, with the bounded body prefix. The `names` kind is in page
    /// id order (`ORDER BY p.id`); the others are in store scan order (the SQL sets none).
    pub fn read_reflex_pages(
        &self,
        source_ids: &[String],
        matcher: &ReflexPageMatch,
        policy: Option<&PrivacyPolicy>,
    ) -> Result<Vec<ReflexPageRow>> {
        let read = self.read()?;
        let mut pages = live_pages_in(&*read, source_ids, policy, |p| {
            Ok(match matcher {
                ReflexPageMatch::Names {
                    titles_lc,
                    exact_slugs,
                    slug_suffixes,
                    surname_patterns,
                } => {
                    let title_lc = pg_lower(&p.title);
                    titles_lc.contains(&title_lc)
                        || exact_slugs.contains(&p.slug)
                        || like_any(&p.slug, slug_suffixes)?
                        || (!surname_patterns.is_empty()
                            && p.page_type == "person"
                            && like_any(&title_lc, surname_patterns)?)
                }
                ReflexPageMatch::Slugs { slugs } => slugs.contains(&p.slug),
                ReflexPageMatch::CjkExact { norms } => {
                    norms.contains(&pg_lower(&p.title)) || norms.contains(&p.slug)
                }
                ReflexPageMatch::Titles { titles_lc } => titles_lc.contains(&pg_lower(&p.title)),
            })
        })?;
        if matches!(matcher, ReflexPageMatch::Names { .. }) {
            pages.sort_by_key(|p| p.id);
        }
        let mut out = Vec::with_capacity(pages.len());
        for p in pages {
            out.push(ReflexPageRow {
                compiled_truth: bounded_body_prefix(&*read, &p)?,
                frontmatter: Value::Object(p.frontmatter),
                slug: p.slug,
                source_id: p.source_id,
                title: p.title,
                page_type: p.page_type,
            });
        }
        Ok(out)
    }

    /// `readBriefEntityPages(sourceId, slugs, opts)`: the live pages of the source at `slugs` that
    /// the policy (when given) does not hide and the eligibility admits, in store scan order.
    pub fn read_brief_entity_pages(
        &self,
        source_id: &str,
        slugs: &[String],
        policy: Option<&PrivacyPolicy>,
        eligibility: &BriefEligibility,
    ) -> Result<Vec<BriefEntityPageRow>> {
        let trust = TrustPolicy::parse(
            eligibility.min_trust.as_deref(),
            eligibility.suppress_flagged,
        )?;
        let read = self.read()?;
        let sources = [source_id.to_string()];
        let mut out = Vec::new();
        for p in live_pages_in(&*read, &sources, policy, |p| Ok(slugs.contains(&p.slug)))? {
            let tier = TrustTier::stored(p.trust_tier.as_deref());
            if !trust.admits(&*read, "pages", p.id, tier)? {
                continue;
            }
            out.push(BriefEntityPageRow {
                slug: p.slug,
                title: p.title,
                page_type: p.page_type,
            });
        }
        Ok(out)
    }
}
