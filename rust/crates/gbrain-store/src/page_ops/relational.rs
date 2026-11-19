//! The relational recall arm's page reads (`src/core/engine-sql/relational-reads.ts`): which resolved
//! seed pages the caller's read policy admits.
//!
//! Member: readAdmittedPageRefs.
//!
//! Keys: this module adds none. It reads page and source records through `pages.rs` and
//! `sources.rs`, and judges each page by the parent's read scope (`passes_read_scope`).

use super::{PageReadScope, PageRef, passes_read_scope, sources_by_id};
use crate::Store;
use crate::error::Result;
use crate::pages::read_page;
use crate::trust::TrustPolicy;
use serde_json::{Value, json};

impl Store {
    /// `readAdmittedPageRefs(refs, scope)`: `{ source_id, slug }` for each ref that names a live,
    /// unquarantined page of an unarchived source which the scope admits, in ref order; a ref listed
    /// twice answers twice, as the SQL join on the ref list does. The live filter applies whatever
    /// `scope.live` says, as the SQL statement always sets it.
    pub fn read_admitted_page_refs(
        &self,
        refs: &[PageRef],
        scope: &PageReadScope,
    ) -> Result<Vec<Value>> {
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let sources = sources_by_id(&*read)?;
        let trust = TrustPolicy::parse(scope.min_trust.as_deref(), scope.suppress_flagged)?;
        let scope = PageReadScope {
            live: true,
            ..scope.clone()
        };
        let mut out = Vec::new();
        for r in refs {
            if let Some(page) = read_page(&*read, &r.source_id, &r.slug)?
                && passes_read_scope(&*read, &page, &scope, &trust, &sources)?
            {
                out.push(json!({ "source_id": page.source_id, "slug": page.slug }));
            }
        }
        Ok(out)
    }
}
