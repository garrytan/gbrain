//! The page-write reads that belong to no other family: a source's state as a write reads it, and
//! the live pages that can be endpoints of a page's links. PGLite and Postgres run the SQL in
//! `src/core/engine-sql/write-misc.ts`; these answer the same questions from the store's records.
//!
//! What the store does not keep, and what the TypeScript members answer for it, is in
//! rust/docs/store/write_misc.md (shared skillpacks, chronicle state, access members and memory
//! proposals have no records here).
//!
//! Keys: none of its own. It reads the source and page records.

use crate::Store;
use crate::error::Result;
use crate::pages::read_page;
use crate::sources::{all_sources, read_source};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeSet;

/// A source as a write reads it (`SourceStateRow` of `src/core/engine-sql/write-misc.ts`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SourceStateRow {
    pub incarnation: String,
    pub archived: bool,
    pub local_path: Option<String>,
    pub config: Map<String, Value>,
}

/// One live page that can be a link endpoint (`LinkEndpointPageRow`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LinkEndpointPageRow {
    pub slug: String,
    pub source_id: String,
    #[serde(rename = "type")]
    pub page_type: String,
    pub knowledge_revision: String,
}

impl Store {
    /// The source's incarnation, archived flag, local path and config, or `None` for an unknown id.
    /// The SQL engines can hold the row FOR SHARE; the store runs one write transaction at a time,
    /// so no lock is needed and the TypeScript member drops the option.
    pub fn read_source_state(&self, source_id: &str) -> Result<Option<SourceStateRow>> {
        let read = self.read()?;
        Ok(read_source(&*read, source_id)?.map(|r| SourceStateRow {
            incarnation: r.incarnation,
            archived: r.archived,
            local_path: r.local_path,
            config: r.config,
        }))
    }

    /// The live pages of `source_id` whose slug is in `slugs`, then the live pages of every other
    /// source whose slug is a ref: a slug in `cross_source_slugs`, or one `source_id` lacks.
    /// Own pages come first, by slug; the rest by source, then slug.
    pub fn list_link_endpoint_pages(
        &self,
        source_id: &str,
        slugs: &[String],
        cross_source_slugs: &[String],
    ) -> Result<Vec<LinkEndpointPageRow>> {
        let read = self.read()?;
        let wanted: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
        let cross: BTreeSet<&str> = cross_source_slugs.iter().map(String::as_str).collect();
        let mut out = Vec::new();
        let mut own = BTreeSet::new();
        for slug in &wanted {
            if let Some(page) = read_page(&*read, source_id, slug)?
                && page.deleted_at_us.is_none()
            {
                own.insert(*slug);
                out.push(endpoint(
                    page.slug,
                    page.source_id,
                    page.page_type,
                    page.knowledge_revision,
                ));
            }
        }
        let refs: Vec<&str> = wanted
            .iter()
            .copied()
            .filter(|slug| cross.contains(slug) || !own.contains(slug))
            .collect();
        if refs.is_empty() {
            return Ok(out);
        }
        for source in all_sources(&*read)? {
            if source.id == source_id {
                continue;
            }
            for slug in &refs {
                if let Some(page) = read_page(&*read, &source.id, slug)?
                    && page.deleted_at_us.is_none()
                {
                    out.push(endpoint(
                        page.slug,
                        page.source_id,
                        page.page_type,
                        page.knowledge_revision,
                    ));
                }
            }
        }
        Ok(out)
    }
}

fn endpoint(
    slug: String,
    source_id: String,
    page_type: String,
    knowledge_revision: String,
) -> LinkEndpointPageRow {
    LinkEndpointPageRow {
        slug,
        source_id,
        page_type,
        knowledge_revision,
    }
}
