//! The relational recall arm's page reads (`src/core/engine-sql/relational-reads.ts`): which resolved
//! seed pages the caller's read policy admits, and the title and bounded body prefix of each page the
//! walk reached, and the title seed that names a typed page.
//!
//! Members: readAdmittedPageRefs, readPageSynopses, readSeedTitleSlugs.
//!
//! Keys: this module adds none. It reads page and source records through `pages.rs` and
//! `sources.rs`, and judges each page by the parent's read scope (`passes_read_scope`).

use super::{PageReadScope, PageRef, passes_read_scope, sources_by_id};
use crate::Store;
use crate::cli_reads::pg_text::pg_lower;
use crate::cli_reads::reads::retired;
use crate::error::Result;
use crate::facts::OwnerOnlyCache;
use crate::pages::{PageRecord, all_pages, read_page};
use crate::trust::TrustPolicy;
use serde_json::{Value, json};

/// `ACTIVATION_SERVED_REVISION` of `src/core/search/safe-chunks.ts`.
const ACTIVATION_SERVED_REVISION: &str = "00000000-0000-0000-0000-000000000153";
/// `BOUNDED_PREFIX_BYTES` of `src/core/page-window/bounded-lead.ts`: SQL `left()` counts code points.
const SYNOPSIS_CHARS: usize = 64 * 1024;

/// `servedTextProjectionFilter`: the current projection, or the pre-activation marker.
fn served(page: &PageRecord) -> bool {
    match page.text_projection_revision.as_deref() {
        Some(rev) => rev == page.knowledge_revision || rev == ACTIVATION_SERVED_REVISION,
        None => false,
    }
}

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
        let mut owner_only = OwnerOnlyCache::default();
        let mut out = Vec::new();
        for r in refs {
            if let Some(page) = read_page(&*read, &r.source_id, &r.slug)?
                && passes_read_scope(&*read, &page, &scope, &trust, &sources, &mut owner_only)?
            {
                out.push(json!({ "source_id": page.source_id, "slug": page.slug }));
            }
        }
        Ok(out)
    }

    /// `readAdmittedPageDateFields(refs, scope)`: `{ source_id, slug, frontmatter, import_filename }` for each ref
    /// that names a live, unquarantined page of an unarchived source the scope admits (as `readAdmittedPageRefs`), in
    /// ref order; a ref listed twice answers twice. `frontmatter` is the stored object.
    pub fn read_admitted_page_date_fields(
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
        let mut owner_only = OwnerOnlyCache::default();
        let mut out = Vec::new();
        for r in refs {
            if let Some(page) = read_page(&*read, &r.source_id, &r.slug)?
                && passes_read_scope(&*read, &page, &scope, &trust, &sources, &mut owner_only)?
            {
                out.push(json!({
                    "source_id": page.source_id,
                    "slug": page.slug,
                    "frontmatter": Value::Object(page.frontmatter.clone()),
                    "import_filename": page.import_filename,
                }));
            }
        }
        Ok(out)
    }

    /// `readPageDateFieldsByIds(ids)`: `{ id, slug, frontmatter, import_filename }` for each id that names a page
    /// row (a soft-deleted page included: the SQL has no filter), in id order (the SQL sets none).
    pub fn read_page_date_fields_by_ids(&self, ids: &[f64]) -> Result<Vec<Value>> {
        let mut wanted = std::collections::BTreeSet::new();
        for id in ids {
            if id.is_finite() && id.fract() == 0.0 && *id >= 1.0 && *id <= f64::from(i32::MAX) {
                wanted.insert(*id as u64);
            }
        }
        let read = self.read()?;
        let mut out = Vec::new();
        for id in wanted {
            if let Some(page) = crate::pages::read_page_by_id(&*read, id)? {
                out.push(json!({
                    "id": page.id,
                    "slug": page.slug,
                    "frontmatter": Value::Object(page.frontmatter.clone()),
                    "import_filename": page.import_filename,
                }));
            }
        }
        Ok(out)
    }

    /// `readPageSynopses(refs, scope)`: `{ page_id, slug, source_id, title, type, synopsis }` for each
    /// ref that names a page the scope admits and the search visibility clause shows (live, a served
    /// text projection, an unarchived source, unquarantined, no `pinned_question` key, and the
    /// private-page filter when `scope.exclude_private`), in ref order; a ref listed twice answers
    /// twice. `synopsis` is the first 65536 code points of the body (`compiled_truth`, else the
    /// segmented body's lead), or null.
    pub fn read_page_synopses(
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
        let mut owner_only = OwnerOnlyCache::default();
        let mut out = Vec::new();
        for r in refs {
            let Some(page) = read_page(&*read, &r.source_id, &r.slug)? else {
                continue;
            };
            if !served(&page)
                || page.frontmatter.contains_key("pinned_question")
                || !passes_read_scope(&*read, &page, &scope, &trust, &sources, &mut owner_only)?
            {
                continue;
            }
            let body = match page.compiled_truth.as_deref() {
                Some(text) => Some(text.to_string()),
                None => crate::page_body::truth_lead(&*read, page.id)?,
            };
            let synopsis = body.map(|b| match b.char_indices().nth(SYNOPSIS_CHARS) {
                Some((at, _)) => b[..at].to_string(),
                None => b,
            });
            out.push(json!({
                "page_id": page.id,
                "slug": page.slug,
                "source_id": page.source_id,
                "title": page.title,
                "type": page.page_type,
                "synopsis": synopsis,
            }));
        }
        Ok(out)
    }

    /// `readSeedTitleSlugs(sourceId, types, title)`: at most two slugs of live pages of `source_id`
    /// whose type is one of `types`, whose lowered title equals the lowered `title`, and which are
    /// not retired (`retiredPageSql`). The SQL statement sets no order; this answers in page-key
    /// order.
    pub fn read_seed_title_slugs(
        &self,
        source_id: &str,
        types: &[String],
        title: &str,
    ) -> Result<Vec<String>> {
        if types.is_empty() {
            return Ok(Vec::new());
        }
        let read = self.read()?;
        let wanted = pg_lower(title);
        Ok(all_pages(&*read)?
            .into_iter()
            .filter(|p| {
                p.source_id == source_id
                    && p.deleted_at_us.is_none()
                    && types.contains(&p.page_type)
                    && pg_lower(&p.title) == wanted
                    && !retired(&p.frontmatter)
            })
            .take(2)
            .map(|p| p.slug)
            .collect())
    }
}
