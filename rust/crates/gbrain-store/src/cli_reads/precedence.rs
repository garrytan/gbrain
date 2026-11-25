//! Source precedence (agent-platform C3), the class of source a row came from, as
//! `src/core/eligibility/precedence.ts` `precedenceSql` decides it in SQL. A label only: it never
//! raises a trust tier. `readPageTrustRows` and the fact rows of `readRowTrustRows` carry it.
//!
//! The class is, in order:
//! 1. `external` for a row in a guest source;
//! 2. `approved` for a row on a page that states rules (`type: rule`) or allowed claims
//!    (`type: facts`, `claims: allowed`), unless the page cannot approve itself (it is
//!    `external_untrusted`, or `agent_written` by a channel that is not `cli:`) or its source is set
//!    to `record` or `external`;
//! 3. the source's own `config.precedence` when it names a class;
//! 4. `chat` for the `conversations` and `conversations-owner` sources and the `meetings` and
//!    `google` kinds;
//! 5. `curated` for everything else.
//!
//! A fact's page is the live page at its `source_markdown_slug` in its source (`LEFT JOIN pages rp
//! ON rp.source_id = r.source_id AND rp.slug = r.source_markdown_slug AND rp.deleted_at IS NULL`).

use crate::error::Result;
use crate::kv::KvRead;
use crate::pages::{PageRecord, read_page};
use crate::sources::{SourceRecord, read_source};
use crate::trust::TrustTier;
use serde_json::Value;

use super::import::config_says_guest;

const CLASSES: [&str; 6] = ["record", "approved", "curated", "doc", "chat", "external"];
const CHAT_SOURCE_IDS: [&str; 2] = ["conversations", "conversations-owner"];
const CHAT_SOURCE_KINDS: [&str; 2] = ["meetings", "google"];

/// `config->>'key'`: a string as itself, any other JSON value as its text, a missing key or JSON
/// null as none.
fn config_text(config: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    match config.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    }
}

/// `approvedPageSql`: a page that states rules or allowed claims.
fn approved_page(page: &PageRecord) -> bool {
    page.page_type == "rule"
        || (page.page_type == "facts"
            && match page.frontmatter.get("claims") {
                Some(Value::String(s)) => s == "allowed",
                _ => false,
            })
}

/// `selfApprovalBlockedSql`: a page whose own front matter cannot approve it.
fn self_approval_blocked(page: &PageRecord) -> bool {
    let tier = TrustTier::stored(page.trust_tier.as_deref());
    match tier.as_str() {
        "external_untrusted" => true,
        "agent_written" => {
            let channel = match page.write_origin.as_ref().and_then(|o| o.get("channel")) {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
            };
            !channel.starts_with("cli:")
        }
        _ => false,
    }
}

/// The class of a row in `source_id`, on `page` (the page it came from, if any).
pub(crate) fn precedence_of(
    source: Option<&SourceRecord>,
    source_id: &str,
    page: Option<&PageRecord>,
) -> &'static str {
    let guest = source.is_some_and(|s| config_says_guest(&s.config));
    let set = source.and_then(|s| config_text(&s.config, "precedence"));
    if guest {
        return "external";
    }
    if let Some(page) = page
        && approved_page(page)
        && !self_approval_blocked(page)
        && !matches!(set.as_deref(), Some("record" | "external"))
    {
        return "approved";
    }
    if let Some(class) = set.as_deref().and_then(|s| CLASSES.iter().find(|c| **c == s)) {
        return class;
    }
    let kind = source.and_then(|s| config_text(&s.config, "kind"));
    if CHAT_SOURCE_IDS.contains(&source_id)
        || kind
            .as_deref()
            .is_some_and(|k| CHAT_SOURCE_KINDS.contains(&k))
    {
        return "chat";
    }
    "curated"
}

/// The class of a page's own row: its source, and itself as the page.
pub(crate) fn page_precedence(read: &dyn KvRead, page: &PageRecord) -> Result<&'static str> {
    let source = read_source(read, &page.source_id)?;
    Ok(precedence_of(source.as_ref(), &page.source_id, Some(page)))
}

/// The class of a fact: its source, and the live page at its `source_markdown_slug` as the page.
pub(crate) fn fact_precedence(
    read: &dyn KvRead,
    source_id: &str,
    source_markdown_slug: Option<&str>,
) -> Result<&'static str> {
    let source = read_source(read, source_id)?;
    let page = match source_markdown_slug {
        Some(slug) => read_page(read, source_id, slug)?.filter(|p| p.deleted_at_us.is_none()),
        None => None,
    };
    Ok(precedence_of(source.as_ref(), source_id, page.as_ref()))
}
