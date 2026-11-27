//! The stored-spelling scan of a scalar slug read (`src/core/engine-sql/slug-spellings.ts`, called from
//! `chooseSpelling` in src/core/ops/slug-params.ts): the stored slugs whose spelling key is the key of the slug a caller
//! asked for. Pages of every state count (deleted pages included) and no privacy rule applies: the caller checks each
//! slug with its own scope and privacy gate.

use std::collections::BTreeSet;

use unicode_normalization::UnicodeNormalization;

use crate::Store;
use crate::error::Result;
use crate::link_slug_reads::source_pages;
use crate::pages::all_pages;

/// The most slugs one call answers (the SQL's `LIMIT 200`).
pub const STORED_SPELLINGS_PAGE: usize = 200;

/// The spelling key of a stored slug, as the SQL computes it (`SPELLING_KEY_SQL`): U+0130 becomes `i` and a combining
/// dot, U+212A becomes `k`, ASCII capitals are lowered (no locale), the text is composed to NFC, and every character
/// that is not `a-z` or `0-9` is removed.
pub fn spelling_key(slug: &str) -> String {
    let mut lowered = String::with_capacity(slug.len());
    for c in slug.chars() {
        match c {
            '\u{130}' => lowered.push_str("i\u{307}"),
            '\u{212A}' => lowered.push('k'),
            c => lowered.push(c.to_ascii_lowercase()),
        }
    }
    lowered
        .nfc()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

impl Store {
    /// `readStoredSlugSpellings(key, { sourceId, sourceIds }, after)`: the distinct stored slugs whose spelling key is
    /// `key` and that sort after `after` by bytes, in byte order, at most STORED_SPELLINGS_PAGE. The scope is
    /// `source_ids` when given (an empty list matches nothing), else `source_id`, else every source.
    pub fn read_stored_slug_spellings(
        &self,
        key: &str,
        source_id: Option<&str>,
        source_ids: Option<&[String]>,
        after: &str,
    ) -> Result<Vec<String>> {
        let read = self.read()?;
        let mut pages = Vec::new();
        match (source_ids, source_id) {
            (Some(ids), _) => {
                for id in ids.iter().collect::<BTreeSet<_>>() {
                    pages.extend(source_pages(&*read, id)?);
                }
            }
            (None, Some(id)) => pages = source_pages(&*read, id)?,
            (None, None) => pages = all_pages(&*read)?,
        }
        let found: BTreeSet<String> = pages
            .into_iter()
            .map(|page| page.slug)
            .filter(|slug| slug.as_str() > after && spelling_key(slug) == key)
            .collect();
        Ok(found.into_iter().take(STORED_SPELLINGS_PAGE).collect())
    }
}
