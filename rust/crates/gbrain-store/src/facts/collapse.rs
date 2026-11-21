//! `pageCollapseFacts(ids, bodyIds)` (src/core/engine-sql/search-reads.ts): what hybrid search's
//! collapse stage (src/core/search/collapse.ts) reads of each candidate page. The BrainEngine
//! member sits in the facts capability class, so it is served from this family.
//!
//! The SQL, read clause by clause:
//!
//! - `target`: the first of `redirect_to`, `redirect` and `merged_into` that is not empty after
//!   `btrim`, then `superseded_by` when `lower(status)` names an alias or a redirect.
//! - `BODY` is `btrim(COALESCE(left(coalesce(compiled_truth, truth_lead), 65536), ''))`; a
//!   segmented page has no `compiled_truth`, so it reads the page's stored truth lead.
//! - `body_chars` is `length(BODY)`; `body` is `md5(BODY)` for an id in `bodyIds` whose body has
//!   at least 200 characters; `lead` is `left(BODY, 4000)` for an id in `bodyIds`.
//!
//! `left` and `length` count code points and `btrim` with no characters trims the space
//! (U+0020) only. Every page row answers: soft-deleted pages and every source, as the SQL has no
//! filter but the ids. Rows come back by id; the SQL has no `ORDER BY`.

use super::embedding::md5_hex;
use super::pg_lower_char;
use crate::Store;
use crate::error::Result;
use crate::pages::{PageRecord, read_page_by_id};
use crate::timeline_queries::jsonb_field_text;
use serde_json::{Value, json};
use std::collections::BTreeSet;

/// `left(coalesce(compiled_truth, truth_lead), BOUNDED_PREFIX_BYTES)` (page-window/bounded-lead.ts).
const BOUNDED_PREFIX_CHARS: usize = 64 * 1024;
/// `IDENTICAL_BODY_MIN_CHARS`.
const IDENTICAL_BODY_MIN_CHARS: usize = 200;
/// `OVERLAP_PREFIX_CHARS`.
const OVERLAP_PREFIX_CHARS: usize = 4000;
/// The redirect keys, in the `COALESCE` order.
const TARGET_KEYS: &[&str] = &["redirect_to", "redirect", "merged_into"];
/// The words `STATUS_REDIRECT` matches between non-letters.
const STATUS_WORDS: &[&str] = &["alias", "redirect", "redirected"];

/// `left(text, n)`: the first `n` code points.
fn left(text: &str, n: usize) -> &str {
    text.char_indices()
        .nth(n)
        .map_or(text, |(at, _)| &text[..at])
}

/// `btrim(text)`: no leading or trailing U+0020.
fn btrim(text: &str) -> &str {
    text.trim_matches(' ')
}

/// `NULLIF(btrim(frontmatter ->> key), '')`.
fn field(page: &PageRecord, key: &str) -> Option<String> {
    let text = page.frontmatter.get(key).and_then(jsonb_field_text)?;
    let trimmed = btrim(&text);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// `lower(COALESCE(frontmatter ->> 'status', '')) ~ '(^|[^a-z])(alias|redirect|redirected)([^a-z]|$)'`.
/// The letters are ASCII, so a byte test on the UTF-8 text is the code-point test.
fn status_redirects(page: &PageRecord) -> bool {
    let status: String = page
        .frontmatter
        .get("status")
        .and_then(jsonb_field_text)
        .unwrap_or_default()
        .chars()
        .map(pg_lower_char)
        .collect();
    let bytes = status.as_bytes();
    let letter = |at: usize| bytes.get(at).is_some_and(u8::is_ascii_lowercase);
    (0..bytes.len()).any(|at| {
        (at == 0 || !letter(at - 1))
            && STATUS_WORDS
                .iter()
                .any(|word| bytes[at..].starts_with(word.as_bytes()) && !letter(at + word.len()))
    })
}

/// The redirect target of the `target` column.
fn target(page: &PageRecord) -> Option<String> {
    TARGET_KEYS
        .iter()
        .find_map(|key| field(page, key))
        .or_else(|| {
            status_redirects(page)
                .then(|| field(page, "superseded_by"))
                .flatten()
        })
}

impl Store {
    /// `pageCollapseFacts(ids, bodyIds)`: one row per page whose id is in `ids`, by id, as
    /// `{ id, target, body_chars, body, lead }`. A missing id has no row.
    pub fn page_collapse_facts(&self, ids: &[i64], body_ids: &[i64]) -> Result<Vec<Value>> {
        let read = self.read()?;
        let ids: BTreeSet<u64> = ids
            .iter()
            .filter_map(|id| u64::try_from(*id).ok())
            .collect();
        let body_ids: BTreeSet<i64> = body_ids.iter().copied().collect();
        let mut out = Vec::new();
        for id in ids {
            let Some(page) = read_page_by_id(&*read, id)? else {
                continue;
            };
            // `coalesce(compiled_truth, truth_lead)`: a segmented page has no compiled_truth; its stored lead is the
            // same raw prefix.
            let lead_text = match page.compiled_truth.as_deref() {
                Some(text) => Some(text.to_string()),
                None => crate::page_body::truth_lead(&*read, page.id)?,
            };
            let body = btrim(left(
                lead_text.as_deref().unwrap_or(""),
                BOUNDED_PREFIX_CHARS,
            ));
            let chars = body.chars().count();
            let wanted = i64::try_from(id).is_ok_and(|id| body_ids.contains(&id));
            out.push(json!({
                "id": page.id,
                "target": target(&page),
                "body_chars": chars,
                "body": (wanted && chars >= IDENTICAL_BODY_MIN_CHARS).then(|| md5_hex(body)),
                "lead": wanted.then(|| left(body, OVERLAP_PREFIX_CHARS)),
            }));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn left_and_btrim_count_code_points_and_trim_spaces_only() {
        assert_eq!(left("héllo", 2), "hé");
        assert_eq!(left("ab", 5), "ab");
        assert_eq!(btrim("  a b \t "), "a b \t");
    }
}
