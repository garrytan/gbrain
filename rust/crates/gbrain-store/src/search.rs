//! `searchKeyword(query, opts)` on the addon: the keyword arm's statement
//! ([`Store::search_keyword_arm`], `keyword/arm.rs`) with `query` as both the match and the rank
//! query, over the live keyword index.
//!
//! Until store format 14 this was a separate BM25 search over its own word postings (`T`), which
//! every chunk write kept in step. Production keyword search never read it (the TypeScript
//! member calls `searchKeywordArm` and the other keyword members), so format 14 stops writing
//! those postings and its upgrade deletes them (`legacy_postings.rs`). The addon method stays, with
//! the arm's options and rows.

use crate::Store;
use crate::error::Result;
use serde_json::Value;

/// The options of `searchKeyword`: those of the keyword arm (`keyword::KeywordOptions`).
pub type SearchOptions = crate::keyword::KeywordOptions;

impl Store {
    /// `searchKeyword(query, opts)`: exactly what `searchKeywordArm(query, query, opts)` answers.
    pub fn search_keyword(&self, query: &str, options: &SearchOptions) -> Result<Vec<Value>> {
        self.search_keyword_arm(query, query, options)
    }
}
