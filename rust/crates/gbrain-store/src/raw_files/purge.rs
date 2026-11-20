//! The delete of a page purge's sweep in the file records (`deletePurgedPageFiles`, SQL in
//! src/core/engine-sql/page-purge-sweep.ts): the files attached to the page, and the detached ones that still name its slug
//! in the page's source (or in none), removed with their page index entries. The blobs are the caller's to delete after the
//! purge commits.

use super::{FILE, FileRecord, collect_values, file_page_key};
use crate::Store;
use crate::error::Result;
use crate::keys;
use crate::links::no_nul;

impl Store {
    /// `deletePurgedPageFiles(sourceId, slug, pageId)`: deletes the files with `page_id = pageId`, and those with no page whose
    /// `page_slug` is the slug and whose source is the page's; their storage paths, sorted bytewise. The store keeps files
    /// by path, so this reads every file record; a purge is rare.
    pub fn delete_purged_page_files(
        &self,
        source_id: &str,
        slug: &str,
        page_id: i64,
    ) -> Result<Vec<String>> {
        no_nul(
            "deletePurgedPageFiles",
            &[("sourceId", source_id), ("slug", slug)],
        )?;
        let page = u64::try_from(page_id).ok();
        self.write(|tx| {
            let files: Vec<(Vec<u8>, FileRecord)> = collect_values(&*tx, &[keys::RAW_FILES, FILE])?;
            let mut paths = Vec::new();
            for (key, file) in files {
                let attached = page.is_some() && file.page_id == page;
                let detached = file.page_id.is_none()
                    && file.page_slug.as_deref() == Some(slug)
                    && file.source_id == source_id;
                if !attached && !detached {
                    continue;
                }
                if let Some(page_id) = file.page_id {
                    tx.delete(&file_page_key(page_id, file.id))?;
                }
                tx.delete(&key)?;
                paths.push(file.storage_path);
            }
            paths.sort();
            Ok(paths)
        })
    }
}
