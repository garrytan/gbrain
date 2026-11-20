//! Doctor facts, fence and trust reads served from the store (SQL in `src/core/engine-sql/doctor-facts-trust.ts`,
//! docs in `rust/docs/store/cli-reads-doctor-facts-trust.md`). Each read takes one snapshot.
//!
//! Text rules (rust/docs/store/cli-reads-ops.md, "Text semantics"): `LIKE` is the store's own (`facts.rs`, `\` escape),
//! and every order is bytewise, as PGLite's C.UTF-8 collation orders.

use crate::Store;
use crate::error::Result;
use crate::facts::like;
use crate::pages::all_pages;
use serde::Deserialize;

/// The arguments of `countConversationPipelinePages(types, slugPatterns)`.
#[derive(Debug, Clone, Deserialize)]
pub struct ConversationPipelineSpec {
    pub types: Vec<String>,
    pub slug_patterns: Vec<String>,
}

impl Store {
    /// `countConversationPipelinePages`: live pages of one of `types` whose slug matches none of the `LIKE` patterns.
    pub fn count_conversation_pipeline_pages(
        &self,
        spec: &ConversationPipelineSpec,
    ) -> Result<u64> {
        let read = self.read()?;
        let mut n = 0;
        for page in all_pages(&*read)? {
            if page.deleted_at_us.is_some() || !spec.types.contains(&page.page_type) {
                continue;
            }
            let mut rescued = false;
            for pattern in &spec.slug_patterns {
                rescued |= like(&page.slug, pattern, false)?;
            }
            n += u64::from(!rescued);
        }
        Ok(n)
    }
}
