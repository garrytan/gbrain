//! The reads a page write makes before admission (`src/core/persistence/page-mutations.ts`), as the members of
//! `src/core/engine-sql/page-mutation-reads.ts` run them (rust/docs/store/page-mutation-reads.md).
//!
//! Members: readStoredPageHead, readVersionSourcePath (`readSourceLocalPath` is `memory_mutation_reads.rs`). Each reads the records the source, page and
//! version families already keep; nothing here writes.

use crate::error::Result;
use crate::pages::{VersionRecord, read_page};
use crate::{Store, get_json, keys};
use serde_json::{Value, json};

impl Store {
    /// `readStoredPageHead(sourceId, slug)`: `{ type, trust_tier, title, frontmatter }` of the page at the slug in the
    /// source (`SELECT type, trust_tier, title, frontmatter FROM pages WHERE source_id = $1 AND slug = $2`), a
    /// soft-deleted page too; none for no such page. A record the store never stamped reads `trust_tier` as
    /// `unknown`, the column default.
    pub fn read_stored_page_head(&self, source_id: &str, slug: &str) -> Result<Option<Value>> {
        Ok(read_page(&*self.read()?, source_id, slug)?.map(|p| {
            json!({
                "type": p.page_type,
                "trust_tier": p.trust_tier.unwrap_or_else(|| "unknown".to_owned()),
                "title": p.title,
                "frontmatter": crate::jsonb::order_map(p.frontmatter),
            })
        }))
    }

    /// `readVersionSourcePath(versionId, pageId)`: the version's `source_path` when the version belongs to the page
    /// (`SELECT source_path FROM page_versions WHERE id=$1 AND page_id=$2`); none otherwise. A negative id matches
    /// nothing.
    pub fn read_version_source_path(
        &self,
        version_id: i64,
        page_id: i64,
    ) -> Result<Option<String>> {
        if version_id < 0 || page_id < 0 {
            return Ok(None);
        }
        let key = keys::version(page_id as u64, version_id as u64);
        let row: Option<VersionRecord> = get_json(&*self.read()?, &key)?;
        Ok(row
            .filter(|v| v.id == version_id as u64 && v.page_id == page_id as u64)
            .and_then(|v| v.source_path))
    }
}

#[cfg(test)]
mod tests {
    use crate::pages::{CreateVersionOptions, PageInput, PutPageOptions};
    use crate::sources::SourceInput;
    use serde_json::{Map, json};

    #[test]
    fn the_three_reads_answer_as_their_sql_does() {
        let store = crate::test_support::store();
        let source: SourceInput = serde_json::from_value(
            json!({ "id": "rooted", "name": "rooted", "local_path": "/srv/rooted" }),
        )
        .unwrap();
        store.upsert_source(&source).unwrap();
        assert_eq!(
            store.read_source_local_path("rooted").unwrap().as_deref(),
            Some("/srv/rooted")
        );
        assert_eq!(store.read_source_local_path("default").unwrap(), None);
        assert_eq!(store.read_source_local_path("missing").unwrap(), None);

        let mut frontmatter = Map::new();
        frontmatter.insert("mood".into(), json!("calm"));
        let input = PageInput {
            page_type: "note".into(),
            title: "Head".into(),
            compiled_truth: "body".into(),
            frontmatter: Some(frontmatter),
            source_path: Some("notes/head.md".into()),
            ..PageInput::default()
        };
        let page = store
            .put_page("notes/head", &input, &PutPageOptions::default())
            .unwrap();
        let page_id = page["id"].as_i64().unwrap();
        let head = store
            .read_stored_page_head("default", "notes/head")
            .unwrap()
            .unwrap();
        assert_eq!(
            (&head["type"], &head["title"], &head["frontmatter"]),
            (&json!("note"), &json!("Head"), &json!({ "mood": "calm" }))
        );
        assert!(head["trust_tier"].is_string());
        assert_eq!(
            store
                .read_stored_page_head("default", "notes/missing")
                .unwrap(),
            None
        );
        assert_eq!(
            store.read_stored_page_head("rooted", "notes/head").unwrap(),
            None
        );
        store.soft_delete_page("notes/head", None).unwrap();
        assert_eq!(
            store
                .read_stored_page_head("default", "notes/head")
                .unwrap(),
            Some(head)
        );

        store.restore_page("notes/head", None).unwrap();
        let version = store
            .create_version_opts("notes/head", &CreateVersionOptions::default())
            .unwrap();
        let version_id = version["id"].as_i64().unwrap();
        assert_eq!(
            store
                .read_version_source_path(version_id, page_id)
                .unwrap()
                .as_deref(),
            Some("notes/head.md")
        );
        assert_eq!(
            store
                .read_version_source_path(version_id, page_id + 1000)
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .read_version_source_path(version_id + 1000, page_id)
                .unwrap(),
            None
        );
        assert_eq!(store.read_version_source_path(-1, page_id).unwrap(), None);
    }
}
